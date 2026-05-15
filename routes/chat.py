"""
routes.py — FastAPI routes with full RAG (Pinecone) support
"""
import json
import os
import re as _re
import uuid
from fastapi import APIRouter, HTTPException, Request, UploadFile, File
from fastapi.responses import HTMLResponse
from models import ChatResponse
from services.gemini_api import (
    call_gemini_api,
    extract_table_from_html,
    extract_chart_data,
    generate_viz_explanation
)
from fastapi.templating import Jinja2Templates

router    = APIRouter()
templates = Jinja2Templates(directory="templates")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

CURRENT_PDF_TEXT = ""


# ── User helpers ──────────────────────────────────────────────────────────────

def _user_file(user_id: str) -> str:
    safe = _re.sub(r"[^a-zA-Z0-9_\-]", "_", user_id)
    return os.path.join(DATA_DIR, f"chats_{safe}.json")

def _get_user_id(request: Request) -> str:
    uid = request.headers.get("x-user-id", "").strip()
    return uid if uid else "anonymous"

def load_chats(user_id: str = "anonymous") -> list:
    path = _user_file(user_id)
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []

def save_chats(chats: list, user_id: str = "anonymous"):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(_user_file(user_id), "w", encoding="utf-8") as f:
        json.dump(chats, f, indent=2, ensure_ascii=False)

def _clean_json(raw: str) -> list:
    clean = _re.sub(r"<[^>]+>", "", raw).strip()
    clean = _re.sub(r"^```json\s*|^```\s*|\s*```$", "", clean).strip()
    parsed = json.loads(clean)
    if not isinstance(parsed, list): raise ValueError("not a list")
    return parsed


# ── RAG helper ────────────────────────────────────────────────────────────────

def _get_rag_context(message: str, user_id: str) -> str:
    """
    Query Pinecone for relevant chunks and build context string.
    Returns empty string if RAG unavailable or no relevant results.
    """
    try:
        from services.rag_service import query_knowledge, build_rag_context, pinecone_available
        if not pinecone_available():
            return ""
        matches = query_knowledge(message, user_id, top_k=3, min_score=0.70)
        return build_rag_context(matches) if matches else ""
    except Exception as e:
        print(f"[RAG] Context retrieval failed: {e}")
        return ""


# ── Chat endpoint ─────────────────────────────────────────────────────────────

def process_chat_request(data: dict, user_id: str = "anonymous"):
    global CURRENT_PDF_TEXT
    message              = data.get("message", "").strip()
    pdf_text             = data.get("pdf_text", "")
    use_pdf              = data.get("use_pdf", False)
    conversation_history = data.get("conversation_history", [])
    topic_lock           = data.get("topic_lock") or None
    use_rag              = data.get("use_rag", True)   # frontend can disable

    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    if pdf_text:
        CURRENT_PDF_TEXT = pdf_text

    # PDF mode: use uploaded PDF text + RAG from Pinecone for best answer
    if use_pdf:
        active_pdf = pdf_text or CURRENT_PDF_TEXT
        rag_context = ""

        # Also pull relevant chunks from Pinecone (previously indexed PDFs)
        if use_rag and user_id != "anonymous":
            rag_context = _get_rag_context(message, user_id)

        if active_pdf:
            # Combine: direct PDF text (current upload) + Pinecone context (past uploads)
            pdf_section = f"PDF Content:\n{active_pdf[:4000]}"
            rag_section = f"\n\n{rag_context}" if rag_context else ""
            final_prompt = (
                "You are a helpful assistant. Answer the question using the PDF content below.\n"
                "Be concise and accurate. If the answer is not in the content, say so.\n\n"
                f"{pdf_section}{rag_section}\n\nQuestion: {message}\n\nAnswer:"
            )
            reply = call_gemini_api(final_prompt, [], None, "")
        else:
            reply = call_gemini_api(
                f"The user asked: {message}\n\nNo PDF uploaded yet. Ask user to upload a PDF first.",
                [], None, ""
            )
        return ChatResponse(reply=reply)

    # Normal mode: check Pinecone for relevant context
    rag_context = ""
    if use_rag and user_id != "anonymous":
        rag_context = _get_rag_context(message, user_id)

    reply = call_gemini_api(message, conversation_history, topic_lock, rag_context)
    return ChatResponse(reply=reply)


@router.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: Request):
    try:
        data    = await request.json()
        user_id = _get_user_id(request)
        return process_chat_request(data, user_id)
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Visualization endpoints ───────────────────────────────────────────────────

@router.post("/extract_viz")
async def extract_viz(request: Request):
    try:
        data         = await request.json()
        viz_type     = data.get("viz_type", "table")
        html_content = data.get("html_content", "")
        chat_text    = data.get("chat_text", "").strip()

        if viz_type == "table":
            result = extract_table_from_html(html_content, chat_text)
        else:
            result = extract_chart_data(chat_text) if chat_text else {
                "labels":["A","B","C","D"],"values":[30,60,45,75],
                "xLabel":"Category","yLabel":"Value",
                "headers":["Category","Value"],"rows":[["A","30"],["B","60"],["C","45"],["D","75"]]
            }

        # Include explanation in same response (no extra API call)
        result["explanation"] = generate_viz_explanation(
            viz_type, data.get("chart_type","bar"),
            result.get("labels",[]), result.get("values",[]),
            result.get("xLabel","Category"), result.get("yLabel","Value"),
            result.get("headers",["Category","Value"]), result.get("rows",[])
        )
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Chat CRUD ─────────────────────────────────────────────────────────────────

@router.get("/chats")
def get_chats(request: Request):
    uid = _get_user_id(request)
    return [
        {"id":c.get("id"),"title":c.get("title"),"is_pinned":c.get("is_pinned"),
         "is_shared":c.get("is_shared"),"topic":c.get("topic"),"original_index":c.get("original_index")}
        for c in load_chats(uid)
    ]

@router.get("/chat/{chat_id}")
def get_chat(chat_id: int, request: Request):
    uid = _get_user_id(request)
    for c in load_chats(uid):
        if c.get("id") == chat_id: return c
    raise HTTPException(status_code=404, detail="Chat not found")

@router.post("/save_chat")
async def save_chat(request: Request):
    try:
        data    = await request.json()
        uid     = _get_user_id(request)
        chats   = load_chats(uid)
        chat_id = data.get("id")
        title   = data.get("title","").strip() or f"Chat {len(chats)+1}"
        pdfs    = data.get("pdfs",[])
        topic   = data.get("topic") or None

        formatted = []
        for msg in data.get("messages",[]):
            fm = {"role":msg.get("role","bot"),"content":msg.get("text") or msg.get("content") or ""}
            for f in ["pdfs","msgId","selected_view","chart_type","extracted_data","viz_explanation"]:
                if msg.get(f) is not None: fm[f] = msg[f]
            formatted.append(fm)

        found = False
        if chat_id is not None:
            for chat in chats:
                if chat.get("id") == chat_id:
                    chat.update({"title":title,"messages":formatted,"pdfs":pdfs,"topic":topic}); found=True; break
        else:
            for chat in chats:
                if chat["title"] == title:
                    chat.update({"messages":formatted,"pdfs":pdfs,"topic":topic}); chat_id=chat.get("id"); found=True; break

        if not found:
            chat_id = max((c.get("id",0) for c in chats), default=0) + 1
            chats.append({"id":chat_id,"user_id":uid,"title":title,"messages":formatted,"pdfs":pdfs,
                          "topic":topic,"is_shared":False,"is_pinned":False,"share_id":None,"original_index":len(chats)})

        save_chats(chats, uid)
        return {"status":"saved","id":chat_id,"title":title}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.patch("/chat/{chat_id}")
async def patch_chat(chat_id: int, request: Request):
    try:
        data  = await request.json()
        uid   = _get_user_id(request)
        chats = load_chats(uid)
        for c in chats:
            if c.get("id") == chat_id:
                if "title" in data:
                    nt = data["title"].strip()
                    if nt:
                        if any(x.get("title")==nt and x.get("id")!=chat_id for x in chats):
                            raise HTTPException(status_code=400, detail="Title already exists")
                        c["title"] = nt
                if "is_pinned" in data:
                    if data["is_pinned"] and not c.get("is_pinned") and "original_index" not in c:
                        c["original_index"] = next((i for i,x in enumerate(chats) if x.get("id")==chat_id),0)
                    c["is_pinned"] = data["is_pinned"]
                save_chats(chats, uid)
                return {"status":"updated","chat":c}
        raise HTTPException(status_code=404, detail="Chat not found")
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.delete("/chat/{chat_id}")
async def delete_chat(chat_id: int, request: Request):
    uid   = _get_user_id(request)
    chats = load_chats(uid)
    before = len(chats)
    chats  = [c for c in chats if c.get("id") != chat_id]
    if len(chats) == before: raise HTTPException(status_code=404, detail="Chat not found")
    save_chats(chats, uid)
    return {"status":"deleted"}


# ── Share endpoints ───────────────────────────────────────────────────────────

@router.post("/share/{chat_id}")
async def share_chat(chat_id: int, request: Request):
    uid = _get_user_id(request); chats = load_chats(uid)
    for c in chats:
        if c.get("id") == chat_id:
            if not c.get("share_id"): c["share_id"] = uuid.uuid4().hex
            c["is_shared"] = True; save_chats(chats,uid)
            return {"status":"success","is_shared":True,"share_id":c["share_id"]}
    raise HTTPException(status_code=404, detail="Chat not found")

@router.post("/unshare/{chat_id}")
async def unshare_chat(chat_id: int, request: Request):
    uid = _get_user_id(request); chats = load_chats(uid)
    for c in chats:
        if c.get("id") == chat_id:
            c["is_shared"] = False; save_chats(chats,uid)
            return {"status":"success","is_shared":False}
    raise HTTPException(status_code=404, detail="Chat not found")

@router.get("/shared/{share_id}", response_class=HTMLResponse)
async def get_shared_html(request: Request, share_id: str):
    return templates.TemplateResponse(request, "index.html", {})

@router.get("/api/shared/{share_id}")
async def get_shared_data(share_id: str):
    if not os.path.exists(DATA_DIR):
        raise HTTPException(status_code=404)
    for fname in os.listdir(DATA_DIR):
        if not (fname.startswith("chats_") and fname.endswith(".json")): continue
        try:
            with open(os.path.join(DATA_DIR,fname),"r",encoding="utf-8") as f:
                uc = json.load(f)
            for c in (uc if isinstance(uc,list) else []):
                if c.get("share_id")==share_id and c.get("is_shared"): return c
        except Exception: continue
    raise HTTPException(status_code=404, detail="Shared chat not found")

@router.post("/shared/chat/{share_id}", response_model=ChatResponse)
async def shared_chat_endpoint(request: Request, share_id: str):
    valid = False
    if os.path.exists(DATA_DIR):
        for fname in os.listdir(DATA_DIR):
            if not (fname.startswith("chats_") and fname.endswith(".json")): continue
            try:
                with open(os.path.join(DATA_DIR,fname),"r",encoding="utf-8") as f:
                    uc = json.load(f)
                if any(c.get("share_id")==share_id and c.get("is_shared") for c in (uc if isinstance(uc,list) else [])):
                    valid=True; break
            except Exception: continue
    if not valid: raise HTTPException(status_code=404)
    try:
        return process_chat_request(await request.json(), "anonymous")
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Utility endpoints ─────────────────────────────────────────────────────────

@router.post("/generate_title")
async def generate_title(request: Request):
    try:
        data    = await request.json()
        message = data.get("message","")
        if not message.strip(): return {"title":"New Chat"}
        raw   = call_gemini_api(
            f"Give a 3-5 word chat title for: {message}\nOutput ONLY the title — no punctuation, no quotes.",
            [], None, ""
        )
        title = _re.sub(r"<[^>]+>","",raw).strip().strip(".,:-\"'")[:50]
        return {"title": title or "New Chat"}
    except Exception:
        return {"title":"New Chat"}

@router.get("/me")
async def get_me(request: Request):
    uid = _get_user_id(request)
    return {"user_id":uid,"is_anonymous":uid=="anonymous"}


@router.get("/rag/status")
async def rag_status(request: Request):
    """
    Debug endpoint — verifies the full RAG pipeline is working.
    Visit /rag/status after login to confirm Pinecone + embedding are connected.
    """
    uid = _get_user_id(request)
    result = {
        "user_id":          uid,
        "pinecone_key_set": False,
        "gemini_key_set":   False,
        "pinecone_connected": False,
        "embedding_works":  False,
        "index_stats":      {},
        "errors":           []
    }
    try:
        import os
        result["pinecone_key_set"] = bool(os.getenv("PINECONE_API_KEY",""))
        result["gemini_key_set"]   = bool(os.getenv("GEMINI_API_KEY",""))

        from services.rag_service import _get_index, _embed, pinecone_available
        if not pinecone_available():
            result["errors"].append("PINECONE_API_KEY not set")
            return result

        # Test Pinecone connection
        try:
            index = _get_index()
            stats = index.describe_index_stats()
            result["pinecone_connected"] = True
            result["index_stats"] = {
                "total_vectors": stats.total_vector_count,
                "dimension":     stats.dimension,
                "namespaces":    {k: v.vector_count for k,v in stats.namespaces.items()}
            }
        except Exception as e:
            result["errors"].append(f"Pinecone connection failed: {e}")

        # Test embedding
        try:
            vec = _embed("test connection")
            result["embedding_works"] = True
            result["embedding_dim"]   = len(vec)
        except Exception as e:
            result["errors"].append(f"Embedding failed: {e}")

    except Exception as e:
        result["errors"].append(str(e))

    return result


# ── RAG / Knowledge Base endpoints ───────────────────────────────────────────

@router.post("/upload_knowledge")
async def upload_knowledge(request: Request, file: UploadFile = File(...)):
    """
    Upload a PDF to the knowledge base (Pinecone).
    This is DIFFERENT from /upload_pdf (which is for single-chat context).
    These documents persist in Pinecone and enhance ALL future conversations.
    """
    uid = _get_user_id(request)
    try:
        from services.rag_service import upsert_document, pinecone_available
        if not pinecone_available():
            raise HTTPException(status_code=503, detail="Pinecone not configured. Add PINECONE_API_KEY to .env")

        if not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Only PDF files allowed")
        contents = await file.read()
        if not contents: raise HTTPException(status_code=400, detail="File is empty")
        if len(contents) > 10*1024*1024: raise HTTPException(status_code=400, detail="PDF too large (max 10MB)")

        try:
            import fitz
        except ImportError:
            raise HTTPException(status_code=500, detail="PyMuPDF not installed.")

        doc        = fitz.open(stream=contents, filetype="pdf")
        page_count = doc.page_count
        text       = "".join(f"\n--- Page {n+1} ---\n{doc[n].get_text()}" for n in range(page_count))
        doc.close()
        text = text.strip()
        if not text: raise HTTPException(status_code=400, detail="PDF has no readable text.")

        doc_id = uuid.uuid4().hex[:12]
        result = upsert_document(
            doc_id   = doc_id,
            text     = text[:50000],   # generous limit for knowledge base
            filename = file.filename,
            user_id  = uid
        )
        return {
            "status":   "indexed",
            "filename": file.filename,
            "doc_id":   doc_id,
            "chunks":   result["chunks"],
            "pages":    page_count
        }
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Knowledge upload failed: {e}")


@router.get("/knowledge")
async def list_knowledge(request: Request):
    """List all documents in the user's knowledge base."""
    uid = _get_user_id(request)
    try:
        from services.rag_service import list_documents, pinecone_available
        if not pinecone_available():
            return {"documents":[], "pinecone_enabled":False}
        docs = list_documents(uid)
        return {"documents":docs,"pinecone_enabled":True}
    except Exception as e:
        return {"documents":[],"error":str(e),"pinecone_enabled":False}


@router.delete("/knowledge/{doc_id}")
async def delete_knowledge(doc_id: str, request: Request):
    """Delete a document from the user's knowledge base."""
    uid = _get_user_id(request)
    try:
        from services.rag_service import delete_document, pinecone_available
        if not pinecone_available():
            raise HTTPException(status_code=503, detail="Pinecone not configured.")
        ok = delete_document(doc_id, uid)
        return {"status":"deleted" if ok else "not_found"}
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/suggest")
async def suggest(request: Request):
    """Smart suggestions: new-chat (history-based), continue-chat, or word completions."""
    import random
    _DEFAULTS = [
        "What can you help me with today?",
        "Can you explain a complex topic simply?",
        "How do I get started with coding?",
        "What are best practices for software architecture?",
        "Help me brainstorm some new ideas.",
        "Explain the difference between AI and machine learning.",
        "What is the best way to learn a new programming language?",
        "Can you summarize a topic for me?",
        "What are some productivity tips for developers?",
        "How does the internet actually work?",
    ]
    try:
        data     = await request.json()
        query    = data.get("query","").strip()
        new_chat = data.get("new_chat", False)
        context  = data.get("context","").strip()
        uid      = _get_user_id(request)

        if new_chat and not query:
            chats = load_chats(uid)
            past  = [
                msg.get("content","").strip()
                for chat in chats[-20:]
                for msg in chat.get("messages",[])
                if msg.get("role")=="user" and len(msg.get("content","").strip()) > 5
                   and msg.get("content") != "[PDF uploaded]"
            ][-15:]

            if past:
                sample = "\n".join(f"- {m[:120]}" for m in past)
                prompt = (
                    f"Based on these past questions:\n{sample}\n\n"
                    "Generate 3 short varied follow-up questions (6-10 words each).\n"
                    'Return ONLY JSON array: ["q1","q2","q3"]'
                )
                try:
                    raw    = call_gemini_api(prompt, [], None, "")
                    result = [s.strip() for s in _clean_json(_re.sub(r"<[^>]+>","",raw)) if isinstance(s,str)]
                    if len(result) >= 3:
                        return {"suggestions": result[:3]}
                except Exception: pass

            # Fallback to random defaults for new users
            random.shuffle(_DEFAULTS)
            return {"suggestions": _DEFAULTS[:3]}

        elif not query and context:
            prompt = (
                f'Chat context: "{context[:300]}"\n'
                "Generate 3 short follow-up questions (5-10 words) directly related to this topic.\n"
                'Return ONLY JSON array: ["q1","q2","q3"]'
            )
            try:
                raw    = call_gemini_api(prompt, [], None, "")
                result = [s.strip() for s in _clean_json(_re.sub(r"<[^>]+>","",raw)) if isinstance(s,str)]
                if result: return {"suggestions": result[:3]}
            except Exception: pass
            return {"suggestions": []}

        elif not query:
            return {"suggestions": []}

        else:
            words = query.split()
            if len(words) == 1:
                prompt = (
                    f'User typed: "{query}"\n'
                    f'Generate 3 completions starting with "{query}" (5-10 words each).\n'
                    'Return ONLY JSON array: ["c1","c2","c3"]'
                )
            else:
                prompt = (
                    f'User typing: "{query}"\n'
                    f'Generate 3 natural completions continuing exactly from "{query}" (5-12 words total).\n'
                    'Return ONLY JSON array: ["c1","c2","c3"]'
                )
            try:
                raw    = call_gemini_api(prompt, [], None, "")
                result = [s.strip() for s in _clean_json(_re.sub(r"<[^>]+>","",raw)) if isinstance(s,str)]
                if query:
                    prefixed = [s for s in result if s.lower().startswith(query.lower())]
                    result   = prefixed if len(prefixed) >= 2 else result
                if result: return {"suggestions": result[:3]}
            except Exception: pass
            return {"suggestions": []}

    except Exception:
        import random
        random.shuffle(_DEFAULTS)
        return {"suggestions": _DEFAULTS[:3]}


@router.post("/upload_pdf")
async def upload_pdf(request: Request, file: UploadFile = File(...)):
    """
    Upload PDF for chat context.
    - Extracts text and returns it for immediate in-chat use (existing behaviour)
    - Also indexes the full text to Pinecone in the background so future
      questions about this PDF are answered via RAG (persistent, per-user)
    """
    global CURRENT_PDF_TEXT
    uid = _get_user_id(request)
    try:
        if not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Only PDF files allowed")
        contents = await file.read()
        if not contents: raise HTTPException(status_code=400, detail="File is empty")
        if len(contents) > 10*1024*1024: raise HTTPException(status_code=400, detail="PDF too large (max 10MB)")

        try:
            import fitz
        except ImportError:
            raise HTTPException(status_code=500, detail="PyMuPDF not installed. Run: pip install pymupdf")

        doc        = fitz.open(stream=contents, filetype="pdf")
        page_count = doc.page_count
        full_text  = "".join(f"\n--- Page {n+1} ---\n{doc[n].get_text()}" for n in range(page_count))
        doc.close()
        full_text = full_text.strip()
        if not full_text:
            raise HTTPException(status_code=400, detail="PDF has no readable text.")

        # Store truncated version for immediate in-chat use (existing behaviour)
        chat_text        = full_text[:12000]
        CURRENT_PDF_TEXT = chat_text

        # Index full text to Pinecone in background (non-blocking)
        # so the user gets an instant response and RAG works for future questions
        try:
            from services.rag_service import upsert_document, pinecone_available
            if pinecone_available():
                import threading, uuid as _uuid
                _doc_id   = _uuid.uuid4().hex[:12]
                _filename = file.filename
                _text     = full_text[:50000]
                _uid      = uid   # capture for thread closure

                def _index_bg():
                    try:
                        result = upsert_document(
                            doc_id   = _doc_id,
                            text     = _text,
                            filename = _filename,
                            user_id  = _uid
                        )
                        print(f"[RAG] ✓ Indexed '{_filename}': {result['chunks']} chunks → namespace '{result.get('namespace','?')}'")
                    except Exception as e:
                        print(f"[RAG] ✗ Index failed for '{_filename}': {e}")

                threading.Thread(target=_index_bg, daemon=True).start()
        except Exception as e:
            print(f"[RAG] Index setup error: {e}")

        return {"filename": file.filename, "content": chat_text, "pages": page_count}
    except HTTPException: raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process PDF: {e}")