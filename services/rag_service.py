"""
rag_service.py — Pinecone RAG operations
Handles: embedding (via REST), upserting, querying, deleting
"""
import os
import re
import time
import requests as _requests
from dotenv import load_dotenv

load_dotenv()

# ── Config ────────────────────────────────────────────────────────────────────
PINECONE_API_KEY    = os.getenv("PINECONE_API_KEY", "")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "chatbot-rag")
PINECONE_INDEX_HOST = os.getenv("PINECONE_INDEX_HOST", "")   # from Pinecone dashboard → Connect
GEMINI_API_KEY      = os.getenv("GEMINI_API_KEY", "")

# Embedding REST endpoint
_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent"

# ── Lazy Pinecone init ────────────────────────────────────────────────────────
_pc_index = None

def _get_index():
    global _pc_index
    if _pc_index is not None:
        return _pc_index
    if not PINECONE_API_KEY:
        raise RuntimeError("PINECONE_API_KEY not set in environment.")
    try:
        from pinecone import Pinecone
        pc = Pinecone(api_key=PINECONE_API_KEY)
        # Use host directly if set — avoids SSL lookup on local machines
        if PINECONE_INDEX_HOST:
            _pc_index = pc.Index(host=PINECONE_INDEX_HOST)
        else:
            _pc_index = pc.Index(PINECONE_INDEX_NAME)
        return _pc_index
    except ImportError:
        raise RuntimeError("pinecone not installed. Run: pip install pinecone")


# ── Embedding via REST (no deprecated SDK) ────────────────────────────────────

def _embed(text: str, task_type: str = "retrieval_document") -> list:
    """Generate embedding using Gemini text-embedding-004 via direct REST."""
    clean = re.sub(r"\s+", " ", text).strip()[:8000]
    for attempt in range(3):
        try:
            resp = _requests.post(
                _EMBED_URL,
                headers={"Content-Type": "application/json"},
                params={"key": GEMINI_API_KEY},
                json={
                    "model": "models/text-embedding-004",
                    "content": {"parts": [{"text": clean}]},
                    "taskType": task_type.upper().replace("-", "_")
                },
                timeout=20
            )
            if resp.status_code == 429 and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            resp.raise_for_status()
            return resp.json()["embedding"]["values"]
        except Exception as e:
            if attempt < 2:
                time.sleep(2 ** attempt)
                continue
            raise e


def _embed_query(text: str) -> list:
    return _embed(text, task_type="retrieval_query")


# ── Text chunking ─────────────────────────────────────────────────────────────

def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list:
    text   = re.sub(r"\s+", " ", text).strip()
    chunks = []
    start  = 0
    while start < len(text):
        chunk = text[start:start + chunk_size].strip()
        if chunk:
            chunks.append(chunk)
        start += chunk_size - overlap
        if start >= len(text):
            break
    return chunks


# ── Pinecone operations ───────────────────────────────────────────────────────

def upsert_document(doc_id: str, text: str, filename: str,
                    user_id: str, metadata: dict = None) -> dict:
    """Chunk, embed and upsert a document to Pinecone."""
    index  = _get_index()
    chunks = chunk_text(text)
    if not chunks:
        return {"chunks": 0, "doc_id": doc_id}

    vectors = []
    for i, chunk in enumerate(chunks):
        try:
            embedding = _embed(chunk)
        except Exception:
            continue
        vectors.append({
            "id":     f"{user_id}_{doc_id}_chunk{i}",
            "values": embedding,
            "metadata": {
                "doc_id":    doc_id,
                "filename":  filename,
                "user_id":   user_id,
                "chunk_idx": i,
                "text":      chunk[:1000],
                **(metadata or {})
            }
        })

    for batch_start in range(0, len(vectors), 100):
        index.upsert(vectors=vectors[batch_start:batch_start+100], namespace=user_id)

    return {"chunks": len(vectors), "doc_id": doc_id}


def query_knowledge(question: str, user_id: str,
                    top_k: int = 3, min_score: float = 0.70) -> list:
    """Query Pinecone for relevant chunks."""
    try:
        index     = _get_index()
        embedding = _embed_query(question)
        results   = index.query(
            vector=embedding, top_k=top_k,
            namespace=user_id, include_metadata=True
        )
        matches = []
        for match in results.get("matches", []):
            score = match.get("score", 0)
            if score >= min_score:
                meta = match.get("metadata", {})
                matches.append({
                    "text":      meta.get("text", ""),
                    "score":     round(score, 3),
                    "filename":  meta.get("filename", "Unknown"),
                    "doc_id":    meta.get("doc_id", ""),
                    "chunk_idx": meta.get("chunk_idx", 0)
                })
        return matches
    except Exception as e:
        print(f"[RAG] Query error: {e}")
        return []


def delete_document(doc_id: str, user_id: str) -> bool:
    """Delete all chunks of a document from Pinecone."""
    try:
        index  = _get_index()
        prefix = f"{user_id}_{doc_id}_"
        ids    = list(index.list(prefix=prefix, namespace=user_id))
        if ids:
            index.delete(ids=ids, namespace=user_id)
        return True
    except Exception as e:
        print(f"[RAG] Delete error: {e}")
        return False


def list_documents(user_id: str) -> list:
    """List all unique documents stored for a user."""
    try:
        index = _get_index()
        ids   = list(index.list(namespace=user_id))
        docs  = {}
        for vid in ids:
            parts = vid.split("_")
            if len(parts) >= 3:
                doc_id = parts[1]
                docs.setdefault(doc_id, {"doc_id": doc_id, "chunk_count": 0, "filename": doc_id})
                docs[doc_id]["chunk_count"] += 1
        # Fetch filename from first chunk of each doc
        for doc_id in list(docs.keys())[:20]:
            try:
                sample_id    = f"{user_id}_{doc_id}_chunk0"
                fetch_result = index.fetch(ids=[sample_id], namespace=user_id)
                vectors      = fetch_result.get("vectors", {})
                if sample_id in vectors:
                    meta = vectors[sample_id].get("metadata", {})
                    docs[doc_id]["filename"] = meta.get("filename", doc_id)
            except Exception:
                pass
        return list(docs.values())
    except Exception as e:
        print(f"[RAG] List error: {e}")
        return []


def pinecone_available() -> bool:
    """True if Pinecone API key is configured."""
    return bool(PINECONE_API_KEY)


def build_rag_context(matches: list) -> str:
    """Format retrieved chunks into a context block for the LLM."""
    if not matches:
        return ""
    parts = ["## Relevant Knowledge Base Context (use this to answer):"]
    for i, m in enumerate(matches, 1):
        parts.append(f"\n[Source {i}: {m['filename']} — relevance {m['score']}]")
        parts.append(m["text"])
    parts.append("\n## End of Context\n")
    return "\n".join(parts)
