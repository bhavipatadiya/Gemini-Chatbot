import os
import re
import time
import hashlib
import requests as _requests
from dotenv import load_dotenv

load_dotenv()

PINECONE_API_KEY    = os.getenv("PINECONE_API_KEY", "")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "chatbot-rag")
PINECONE_INDEX_HOST = os.getenv("PINECONE_INDEX_HOST", "")
GEMINI_API_KEY      = os.getenv("GEMINI_API_KEY", "")

_EMBED_MODEL = "gemini-embedding-001"
_EMBED_URL   = f"https://generativelanguage.googleapis.com/v1beta/models/{_EMBED_MODEL}:embedContent"
EMBED_DIM    = 3072

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
        if PINECONE_INDEX_HOST:
            _pc_index = pc.Index(host=PINECONE_INDEX_HOST)
        else:
            _pc_index = pc.Index(PINECONE_INDEX_NAME)
        print(f"[RAG] Pinecone connected: {PINECONE_INDEX_NAME}")
        print(_pc_index.describe_index_stats())
        return _pc_index
    except ImportError:
        raise RuntimeError("pinecone not installed. Run: pip install pinecone")

def _embed(text: str, task_type: str = "RETRIEVAL_DOCUMENT") -> list:
    """
    Generate 3072-dim embedding using gemini-embedding-001 via REST.
    Raises on failure so caller knows exactly what went wrong.
    """
    clean = re.sub(r"\s+", " ", text).strip()[:8000]
    for attempt in range(4):   
        try:
            resp = _requests.post(
                _EMBED_URL,
                headers={"Content-Type": "application/json"},
                params={"key": GEMINI_API_KEY},
                json={
                    "model":   f"models/{_EMBED_MODEL}",
                    "content": {"parts": [{"text": clean}]},
                    "taskType": task_type
                },
                timeout=25
            )
            if resp.status_code == 429:
                wait = 5 * (attempt + 1)   
                print(f"[RAG] Embed rate-limited, waiting {wait}s (attempt {attempt+1})")
                time.sleep(wait)
                continue
            if not resp.ok:
                raise RuntimeError(f"Embedding API {resp.status_code}: {resp.text[:200]}")
            values = resp.json().get("embedding", {}).get("values", [])
            if not values:
                raise RuntimeError("Empty embedding returned")
            return values
        except RuntimeError:
            raise
        except Exception as e:
            if attempt < 3:
                time.sleep(3)
                continue
            raise RuntimeError(f"Embedding failed: {e}")
        
def _embed_query(text: str) -> list:
    return _embed(text, task_type="RETRIEVAL_QUERY")

def chunk_text(text: str, chunk_size: int = 275, overlap: int = 30) -> list:
    """
    Split text into chunks of 250-300 words with overlap.
    chunk_size: words per chunk (275 = midpoint of 250-300 range)
    overlap: shared words between adjacent chunks for context continuity
    """
    text  = re.sub(r"\s+", " ", text).strip()
    words = text.split()
    if not words:
        return []
    chunks = []
    start  = 0
    while start < len(words):
        chunk = " ".join(words[start:start + chunk_size]).strip()
        if len(chunk) > 50:
            chunks.append(chunk)
        start += chunk_size - overlap
        if start >= len(words):
            break
    return chunks

def upsert_document(doc_id: str, text: str, filename: str,
                    user_id: str, metadata: dict = None) -> dict:
    """
    Chunk, embed and upsert a document to Pinecone.
    Uses user_id as namespace for per-user isolation.
    Raises on failure — caller must handle errors.
    """
    print("\n[RAG DEBUG] Starting upload...")
    namespace = user_id
    print(f"[RAG DEBUG] Namespace: {namespace}")
    print(f"[RAG DEBUG] Filename: {filename}")

    try:
        index = _get_index()
    except Exception as e:
        print(f"[RAG DEBUG] Failed to get index: {e}")
        raise

    try:
        stats = index.describe_index_stats()
        namespaces = stats.get('namespaces', {}) if isinstance(stats, dict) else getattr(stats, 'namespaces', {})
        if hasattr(namespaces, 'get') and namespace in namespaces:
            ns_stats = namespaces.get(namespace)
        else:
            ns_stats = getattr(namespaces, namespace, None) if hasattr(namespaces, namespace) else (namespaces[namespace] if namespace in namespaces else None)
        
        if ns_stats:
            existing_count = getattr(ns_stats, 'vector_count', ns_stats.get('vector_count', 0) if isinstance(ns_stats, dict) else 0)
        else:
            existing_count = 0
        print(f"[RAG DEBUG] Existing vector count: {existing_count}")
    except Exception as e:
        print(f"[RAG DEBUG] Error fetching existing stats: {e}")
        existing_count = "unknown"

    chunks = chunk_text(text)
    print(f"[RAG DEBUG] Total chunks created: {len(chunks)}")
    if not chunks:
        print(f"[RAG DEBUG] Aborting: No chunks generated for '{filename}'")
        return {"chunks": 0, "doc_id": doc_id, "namespace": namespace}

    vectors = []
    import uuid
    import time
    
    timestamp = int(time.time())
    
    for i, chunk in enumerate(chunks):
        try:
            embedding = _embed(chunk)
            unique_id = f"{namespace}_{doc_id}_{i}_{timestamp}_{uuid.uuid4().hex}"
            vectors.append({
                "id": unique_id,
                "values": embedding,
                "metadata": {
                    "doc_id":    doc_id,
                    "filename":  filename,
                    "user_id":   namespace,
                    "chunk_idx": i,
                    "text":      chunk,
                    "timestamp": timestamp,
                    **(metadata or {})
                }
            })
            if (i + 1) % 10 == 0:
                time.sleep(1)
        except Exception as e:
            print(f"[RAG DEBUG] Exception generating embedding for chunk {i}: {e}")

    print(f"[RAG DEBUG] Embeddings generated: {len(vectors)}")
    print(f"[RAG DEBUG] Total vectors prepared: {len(vectors)}")
    if not vectors:
        print(f"[RAG DEBUG] Aborting: All {len(chunks)} chunks failed to embed. Check GEMINI_API_KEY.")
        raise RuntimeError("Embedding failure")

    if len(vectors) > 0:
        print(f"[RAG DEBUG] First 5 vector IDs: {[v['id'] for v in vectors[:5]]}")

    print(f"[RAG DEBUG] Namespace used: {namespace}")
    print(f"[RAG DEBUG] Upsert batch size: 100")
    try:
        for batch_start in range(0, len(vectors), 100):
            batch = vectors[batch_start:batch_start + 100]
            response = index.upsert(vectors=batch, namespace=namespace)
            print(f"[RAG DEBUG] Batch upsert response: {response}")
    except Exception as e:
        import traceback
        print(f"[RAG DEBUG] Upsert exception: {e}")
        traceback.print_exc()
        raise

    print(f"[RAG DEBUG] Upsert response: success")
    
    # Delay to allow Pinecone indexing to refresh
    time.sleep(2)
    
    try:
        stats_after = index.describe_index_stats()
        namespaces_after = stats_after.get('namespaces', {}) if isinstance(stats_after, dict) else getattr(stats_after, 'namespaces', {})
        
        if hasattr(namespaces_after, 'get') and namespace in namespaces_after:
            ns_stats_after = namespaces_after.get(namespace)
        else:
            ns_stats_after = getattr(namespaces_after, namespace, None) if hasattr(namespaces_after, namespace) else (namespaces_after[namespace] if namespace in namespaces_after else None)
            
        if ns_stats_after:
            updated_count = getattr(ns_stats_after, 'vector_count', ns_stats_after.get('vector_count', 0) if isinstance(ns_stats_after, dict) else 0)
        else:
            updated_count = 0
            
        print(f"[RAG DEBUG] Updated vector count: {updated_count}")
        print(f"[RAG DEBUG] Final vector count: {updated_count}")
    except Exception as e:
        print(f"[RAG DEBUG] Error fetching updated stats: {e}")

    return {"chunks": len(vectors), "doc_id": doc_id, "namespace": namespace}


def query_knowledge(question: str, user_id: str,
                    top_k: int = 3, min_score: float = 0.65) -> list:
    """Query Pinecone for relevant chunks."""
    namespace = user_id
    print(f"[RAG DEBUG] Query namespace: {namespace}")
    try:
        index     = _get_index()
        embedding = _embed_query(question)
        results   = index.query(
            vector=embedding, top_k=top_k,
            namespace=namespace, include_metadata=True
        )
        matches = []
        retrieved_filenames = []
        for match in results.get("matches", []):
            score = match.get("score", 0)
            if score >= min_score:
                meta = match.get("metadata", {})
                filename = meta.get("filename", "Unknown")
                matches.append({
                    "text":      meta.get("text", ""),
                    "score":     round(score, 3),
                    "filename":  filename,
                    "doc_id":    meta.get("doc_id", ""),
                    "chunk_idx": meta.get("chunk_idx", 0)
                })
                retrieved_filenames.append(f"{filename} (score: {round(score, 3)})")
        
        print(f"[RAG DEBUG] Retrieved filenames: {', '.join(retrieved_filenames)}")
        print(f"[RAG DEBUG] Total matches returned: {len(matches)}")
        print(f"[RAG] Query returned {len(matches)} matches (namespace: {namespace})")
        return matches
    except Exception as e:
        print(f"[RAG DEBUG] Query error: {e}")
        return []


def delete_document(doc_id: str, user_id: str) -> bool:
    """Delete all chunks of a document from Pinecone."""
    namespace = user_id
    try:
        index  = _get_index()
        prefix = f"{namespace}_{doc_id}_"
        ids    = list(index.list(prefix=prefix, namespace=namespace))
        if ids:
            index.delete(ids=ids, namespace=namespace)
        return True
    except Exception as e:
        print(f"[RAG] Delete error: {e}")
        return False


def list_documents(user_id: str) -> list:
    """List all unique documents stored for a user."""
    namespace = user_id
    try:
        index = _get_index()
        ids   = list(index.list(namespace=namespace))
        docs  = {}
        for vid in ids:
            parts = vid.split("_")
            if len(parts) >= 3:
                doc_id = parts[1]
                docs.setdefault(doc_id, {"doc_id": doc_id, "chunk_count": 0, "filename": doc_id})
                docs[doc_id]["chunk_count"] += 1
        for doc_id in list(docs.keys())[:20]:
            try:
                sample_id    = f"{namespace}_{doc_id}_0"
                fetch_result = index.fetch(ids=[sample_id], namespace=namespace)
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
