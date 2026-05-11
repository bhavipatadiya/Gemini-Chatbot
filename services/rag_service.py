"""
rag_service.py — Pinecone RAG operations
Handles: embedding, upserting, querying, deleting
"""
import os
import re
import json
import time
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

PINECONE_API_KEY    = os.getenv("pcsk_47R4aZ_LvxuqJncb76obnhuYJS9QLHbqYSgXcJY3yHvtXLExh632cBRXB716C6prqhTShk", "")
PINECONE_INDEX_NAME = os.getenv("chatbot-rag", "chatbot-rag")

# ── Lazy init: only connect when actually needed ──────────────────────────────
_pc_index = None

def _get_index():
    """Return Pinecone index, initializing once on first call."""
    global _pc_index
    if _pc_index is not None:
        return _pc_index
    if not PINECONE_API_KEY:
        raise RuntimeError("PINECONE_API_KEY not set in environment.")
    try:
        from pinecone import Pinecone
        pc = Pinecone(api_key=PINECONE_API_KEY)
        _pc_index = pc.Index(PINECONE_INDEX_NAME)
        return _pc_index
    except ImportError:
        raise RuntimeError("pinecone-client not installed. Run: pip install pinecone-client==3.2.2")


# ── Embedding via Gemini ──────────────────────────────────────────────────────
import google.generativeai as genai
from dotenv import load_dotenv
load_dotenv()
genai.configure(api_key=os.getenv("GEMINI_API_KEY", ""))

def _embed(text: str) -> list[float]:
    """
    Generate a 768-dim embedding using Gemini's embedding model.
    Retries up to 3 times on rate-limit errors.
    """
    clean = re.sub(r"\s+", " ", text).strip()[:8000]  # Gemini limit
    for attempt in range(3):
        try:
            result = genai.embed_content(
                model="models/embedding-001",
                content=clean,
                task_type="retrieval_document"
            )
            return result["embedding"]
        except Exception as e:
            if "429" in str(e) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            raise e


def _embed_query(text: str) -> list[float]:
    """Embed a user query (different task_type for better retrieval)."""
    clean = re.sub(r"\s+", " ", text).strip()[:2000]
    for attempt in range(3):
        try:
            result = genai.embed_content(
                model="models/embedding-001",
                content=clean,
                task_type="retrieval_query"
            )
            return result["embedding"]
        except Exception as e:
            if "429" in str(e) and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            raise e


# ── Text chunking ─────────────────────────────────────────────────────────────
def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list[str]:
    """
    Split text into overlapping chunks for better retrieval.
    - chunk_size: characters per chunk
    - overlap: shared characters between adjacent chunks
    """
    text   = re.sub(r"\s+", " ", text).strip()
    chunks = []
    start  = 0
    while start < len(text):
        end   = start + chunk_size
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = end - overlap
        if start >= len(text):
            break
    return chunks


# ── Pinecone operations ───────────────────────────────────────────────────────

def upsert_document(
    doc_id:   str,
    text:     str,
    filename: str,
    user_id:  str,
    metadata: dict = None
) -> dict:
    """
    Chunk a document, embed each chunk, upsert all to Pinecone.
    Returns { "chunks": N, "doc_id": doc_id }
    """
    index  = _get_index()
    chunks = chunk_text(text)
    if not chunks:
        return {"chunks": 0, "doc_id": doc_id}

    vectors = []
    for i, chunk in enumerate(chunks):
        try:
            embedding = _embed(chunk)
        except Exception:
            continue  # skip chunks that fail to embed

        chunk_id = f"{user_id}_{doc_id}_chunk{i}"
        vectors.append({
            "id": chunk_id,
            "values": embedding,
            "metadata": {
                "doc_id":   doc_id,
                "filename": filename,
                "user_id":  user_id,
                "chunk_idx": i,
                "text":     chunk[:1000],   # store truncated text for retrieval
                **(metadata or {})
            }
        })

    if vectors:
        # Upsert in batches of 100
        for batch_start in range(0, len(vectors), 100):
            batch = vectors[batch_start:batch_start+100]
            index.upsert(vectors=batch, namespace=user_id)

    return {"chunks": len(vectors), "doc_id": doc_id}


def query_knowledge(
    question:   str,
    user_id:    str,
    top_k:      int = 3,
    min_score:  float = 0.70
) -> list[dict]:
    """
    Query Pinecone for the most relevant chunks for a question.
    Returns list of { text, score, filename, doc_id }
    Only returns results with score >= min_score.
    """
    try:
        index     = _get_index()
        embedding = _embed_query(question)
        results   = index.query(
            vector=embedding,
            top_k=top_k,
            namespace=user_id,
            include_metadata=True
        )
        matches = []
        for match in results.get("matches", []):
            score = match.get("score", 0)
            if score >= min_score:
                meta = match.get("metadata", {})
                matches.append({
                    "text":     meta.get("text", ""),
                    "score":    round(score, 3),
                    "filename": meta.get("filename", "Unknown"),
                    "doc_id":   meta.get("doc_id", ""),
                    "chunk_idx": meta.get("chunk_idx", 0)
                })
        return matches
    except Exception as e:
        print(f"[RAG] Query error: {e}")
        return []


def delete_document(doc_id: str, user_id: str) -> bool:
    """
    Delete all chunks belonging to a document from Pinecone.
    Uses prefix filtering on vector IDs.
    """
    try:
        index  = _get_index()
        prefix = f"{user_id}_{doc_id}_"
        # List all vector IDs with this prefix in the user's namespace
        result = index.list(prefix=prefix, namespace=user_id)
        ids    = list(result)
        if ids:
            index.delete(ids=ids, namespace=user_id)
        return True
    except Exception as e:
        print(f"[RAG] Delete error: {e}")
        return False


def list_documents(user_id: str) -> list[dict]:
    """
    List all unique documents stored for a user in Pinecone.
    Returns list of { doc_id, filename, chunk_count }
    """
    try:
        index   = _get_index()
        result  = index.list(namespace=user_id)
        ids     = list(result)
        # Group by doc_id
        docs = {}
        for vid in ids:
            # ID format: {user_id}_{doc_id}_chunk{i}
            parts = vid.split("_")
            if len(parts) >= 3:
                doc_id = parts[1]
                docs[doc_id] = docs.get(doc_id, {"doc_id": doc_id, "chunk_count": 0})
                docs[doc_id]["chunk_count"] += 1
        # Get filename from a sample fetch
        for doc_id in list(docs.keys())[:20]:  # limit to avoid too many requests
            sample_id = f"{user_id}_{doc_id}_chunk0"
            try:
                fetch_result = index.fetch(ids=[sample_id], namespace=user_id)
                vectors = fetch_result.get("vectors", {})
                if sample_id in vectors:
                    meta = vectors[sample_id].get("metadata", {})
                    docs[doc_id]["filename"] = meta.get("filename", doc_id)
            except Exception:
                docs[doc_id]["filename"] = doc_id

        return list(docs.values())
    except Exception as e:
        print(f"[RAG] List error: {e}")
        return []


def pinecone_available() -> bool:
    """Check if Pinecone is configured (API key present)."""
    return bool(PINECONE_API_KEY)


def build_rag_context(matches: list[dict]) -> str:
    """
    Format retrieved chunks into a clean context block for the LLM.
    """
    if not matches:
        return ""
    parts = ["## Relevant Knowledge Base Context (use this to answer):"]
    for i, m in enumerate(matches, 1):
        parts.append(f"\n[Source {i}: {m['filename']} — relevance {m['score']}]")
        parts.append(m["text"])
    parts.append("\n## End of Context\n")
    return "\n".join(parts)