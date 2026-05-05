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

BASE_DIR   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR   = os.path.join(BASE_DIR, "data")

# Ensure data directory exists on startup (important for Render cold starts)
os.makedirs(DATA_DIR, exist_ok=True)

CURRENT_PDF_TEXT = ""


def _user_file(user_id: str) -> str:
    """Each user gets their own chats JSON file: data/chats_{user_id}.json"""
    safe = _re.sub(r"[^a-zA-Z0-9_\-]", "_", user_id)
    return os.path.join(DATA_DIR, f"chats_{safe}.json")


def _get_user_id(request: Request) -> str:
    """
    Get the logged-in user's ID from the x-user-id header.
    The frontend sends this directly from Auth0's user.sub field.
    Falls back to 'anonymous' if not present (e.g. shared chat views).
    """
    uid = request.headers.get("x-user-id", "").strip()
    return uid if uid else "anonymous"

def load_chats(user_id: str = "anonymous"):
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
    """Strip HTML tags + markdown fences, then parse JSON list."""
    clean = _re.sub(r"<[^>]+>", "", raw).strip()
    clean = _re.sub(r"^```json\s*", "", clean)
    clean = _re.sub(r"^```\s*",     "", clean)
    clean = _re.sub(r"\s*```$",     "", clean).strip()
    parsed = json.loads(clean)
    if not isinstance(parsed, list):
        raise ValueError("not a list")
    return parsed

def process_chat_request(data: dict):
    global CURRENT_PDF_TEXT
    message              = data.get("message", "").strip()
    pdf_text             = data.get("pdf_text", "")
    use_pdf              = data.get("use_pdf", False)
    conversation_history = data.get("conversation_history", [])

    topic_lock = data.get("topic_lock") or None

    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    if pdf_text:
        CURRENT_PDF_TEXT = pdf_text

    final_prompt = message

    if use_pdf:
        active_pdf = pdf_text or CURRENT_PDF_TEXT
        if active_pdf:
            truncated            = active_pdf[:6000]
            final_prompt         = (
                "You are a helpful assistant. Answer using the PDF below.\n"
                "Be concise. If not in PDF, say so.\n\n"
                f"PDF:\n{truncated}\n\nQuestion: {message}\n\nAnswer:"
            )
            conversation_history = []
            topic_lock           = None
        else:
            final_prompt         = (
                f"The user asked: {message}\n\n"
                "No PDF uploaded yet. Ask user to upload a PDF first."
            )
            conversation_history = []
            topic_lock           = None

    reply = call_gemini_api(final_prompt, conversation_history, topic_lock)
    return ChatResponse(reply=reply)

@router.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: Request):
    try:
        data = await request.json()
        return process_chat_request(data)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

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
            if not chat_text:
                result = {"labels":["A","B","C","D"],"values":[30,60,45,75],
                        "xLabel":"Category","yLabel":"Value",
                        "headers":["Category","Value"],"rows":[["A","30"],["B","60"],["C","45"],["D","75"]]}
            else:
                result = extract_chart_data(chat_text)
        
        explanation = generate_viz_explanation(
            viz_type, data.get("chart_type", "bar"),
            result.get("labels", []), result.get("values", []),
            result.get("xLabel", "Category"), result.get("yLabel", "Value"),
            result.get("headers", ["Category", "Value"]), result.get("rows", [])
        )
        result["explanation"] = explanation
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/explain_viz")
async def explain_viz(request: Request):
    try:
        data = await request.json()
        html = generate_viz_explanation(
            data.get("viz_type","chart"), data.get("chart_type","bar"),
            data.get("labels",[]), data.get("values",[]),
            data.get("xLabel","Category"), data.get("yLabel","Value"),
            data.get("headers",["Category","Value"]), data.get("rows",[])
        )
        return {"explanation": html}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/chats")
def get_chats(request: Request):
    uid = _get_user_id(request)
    chats = load_chats(uid)
    summary = []
    for c in chats:
        summary.append({
            "id": c.get("id"),
            "title": c.get("title"),
            "is_pinned": c.get("is_pinned"),
            "is_shared": c.get("is_shared"),
            "topic": c.get("topic"),
            "original_index": c.get("original_index")
        })
    return summary


@router.get("/chat/{chat_id}")
def get_chat(chat_id: int, request: Request):
    uid = _get_user_id(request)
    chats = load_chats(uid)
    for c in chats:
        if c.get("id") == chat_id:
            return c
    raise HTTPException(status_code=404, detail="Chat not found")


@router.post("/save_chat")
async def save_chat(request: Request):
    try:
        data    = await request.json()
        uid     = _get_user_id(request)
        chats   = load_chats(uid)
        chat_id = data.get("id")
        title   = data.get("title", "").strip() or f"Chat {len(chats)+1}"
        pdfs    = data.get("pdfs", [])
        topic   = data.get("topic") or None

        formatted = []
        for msg in data.get("messages", []):
            fm = {"role": msg.get("role","bot"), "content": msg.get("text") or msg.get("content") or ""}
            for f in ["pdfs","msgId","selected_view","chart_type","extracted_data","viz_explanation",
                      "vizType","chartType","chartData","tableHTML","vizText"]:
                if msg.get(f) is not None: fm[f] = msg[f]
            formatted.append(fm)

        found = False
        if chat_id is not None:
            for chat in chats:
                if chat.get("id") == chat_id:
                    chat.update({"title":title,"messages":formatted,"pdfs":pdfs,"topic":topic})
                    found = True; break
        else:
            for chat in chats:
                if chat["title"] == title:
                    chat.update({"messages":formatted,"pdfs":pdfs,"topic":topic})
                    chat_id = chat.get("id"); found = True; break

        if not found:
            chat_id = max((c.get("id",0) for c in chats), default=0) + 1
            chats.append({"id":chat_id,"user_id":uid,"title":title,"messages":formatted,"pdfs":pdfs,"topic":topic,
                          "is_shared":False,"is_pinned":False,"share_id":None,"original_index":len(chats)})

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
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/chat/{chat_id}")
async def delete_chat(chat_id: int, request: Request):
    uid   = _get_user_id(request)
    chats = load_chats(uid)
    before = len(chats)
    chats  = [c for c in chats if c.get("id") != chat_id]
    if len(chats) == before:
        raise HTTPException(status_code=404, detail="Chat not found")
    save_chats(chats, uid)
    return {"status":"deleted"}

@router.post("/share/{chat_id}")
async def share_chat(chat_id: int, request: Request):
    uid   = _get_user_id(request)
    chats = load_chats(uid)
    for c in chats:
        if c.get("id") == chat_id:
            if not c.get("share_id"): c["share_id"] = uuid.uuid4().hex
            c["is_shared"] = True; save_chats(chats, uid)
            return {"status":"success","is_shared":True,"share_id":c["share_id"]}
    raise HTTPException(status_code=404, detail="Chat not found")

@router.post("/unshare/{chat_id}")
async def unshare_chat(chat_id: int, request: Request):
    uid   = _get_user_id(request)
    chats = load_chats(uid)
    for c in chats:
        if c.get("id") == chat_id:
            c["is_shared"] = False; save_chats(chats, uid)
            return {"status":"success","is_shared":False}
    raise HTTPException(status_code=404, detail="Chat not found")

@router.get("/shared/{share_id}", response_class=HTMLResponse)
async def get_shared_html(request: Request, share_id: str):
    return templates.TemplateResponse(request, "index.html", {})

@router.get("/api/shared/{share_id}")
async def get_shared_data(share_id: str):
    # Shared chat endpoint needs to search all users if not using a central DB
    if not os.path.exists(DATA_DIR):
        raise HTTPException(status_code=404, detail="Shared chat not found")
    for fname in os.listdir(DATA_DIR):
        if not fname.startswith("chats_") or not fname.endswith(".json"): continue
        try:
            with open(os.path.join(DATA_DIR, fname), "r", encoding="utf-8") as f:
                user_chats = json.load(f)
            for c in (user_chats if isinstance(user_chats, list) else []):
                if c.get("share_id") == share_id and c.get("is_shared"): return c
        except Exception: continue
    raise HTTPException(status_code=404, detail="Shared chat not found")

@router.post("/shared/chat/{share_id}", response_model=ChatResponse)
async def shared_chat_endpoint(request: Request, share_id: str):
    valid = False
    if os.path.exists(DATA_DIR):
        for fname in os.listdir(DATA_DIR):
            if not fname.startswith("chats_") or not fname.endswith(".json"): continue
            try:
                with open(os.path.join(DATA_DIR, fname), "r", encoding="utf-8") as f:
                    user_chats = json.load(f)
                if any(c.get("share_id")==share_id and c.get("is_shared") for c in (user_chats if isinstance(user_chats, list) else [])):
                    valid = True; break
            except Exception: continue
    if not valid:
        raise HTTPException(status_code=404, detail="Invalid or inactive share ID")
    try:
        return process_chat_request(await request.json())
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/generate_title")
async def generate_title(request: Request):
    try:
        data    = await request.json()
        message = data.get("message","")
        if not message.strip(): return {"title":"New Chat"}
        raw   = call_gemini_api(f"Give a 3-5 word chat title for: {message}\nOutput ONLY the title — no punctuation, no quotes.")
        title = _re.sub(r"<[^>]+>","",raw).strip().strip(".,:-\"'")[:50]
        return {"title": title or "New Chat"}
    except Exception:
        return {"title": "New Chat"}


@router.get("/me")
async def get_me(request: Request):
    """Debug endpoint — returns the resolved user_id so you can verify isolation."""
    uid = _get_user_id(request)
    return {"user_id": uid, "is_anonymous": uid == "anonymous"}

@router.post("/suggest")
async def suggest(request: Request):
    """
    3 modes:
      new_chat=true, query=""  → history-based starter questions
      query="", context=...   → continue-chat follow-ups from first user msg
      query="word(s)"         → fast word-by-word completions
    """
    try:
        data     = await request.json()
        query    = data.get("query","").strip()
        new_chat = data.get("new_chat", False)
        context  = data.get("context","").strip()
        uid      = _get_user_id(request)

        if new_chat and not query:
            chats = load_chats(uid)
            past  = []
            for chat in chats[-20:]:
                for msg in chat.get("messages",[]):
                    c = (msg.get("content") or "").strip()
                    if msg.get("role")=="user" and c and c != "[PDF uploaded]" and len(c) > 5:
                        past.append(c)
            past = past[-15:]

            if past:
                sample = "\n".join(f"- {m[:120]}" for m in past)
                prompt = (
                    "Based on this user's past questions, generate 6 short follow-up "
                    "questions they are likely to ask next. Each 6-10 words. "
                    "Relevant to their interests, varied, completely UNIQUE.\n\n"
                    f"Past questions:\n{sample}\n\n"
                    "Return ONLY a JSON array, no markdown:\n"
                    '["question 1","question 2","question 3","question 4","question 5","question 6"]'
                )
            else:
                prompt = "" # Will trigger fallback below

        elif not query and context:
            prompt = (
                f'The first message in this chat was: "{context[:300]}"\n\n'
                "Generate 6 short follow-up questions the user might ask next, "
                "directly related to this topic. Each 5-10 words. Varied, specific, completely UNIQUE. "
                "Return ONLY a JSON array, no markdown:\n"
                '["question 1","question 2","question 3","question 4","question 5","question 6"]'
            )

        elif not query:
            return {"suggestions": []}

        else:
            words = query.split()
            if len(words) == 1:
                prompt = (
                    f'User typed the word: "{query}"\n'
                    f'Generate 6 questions/phrases that START with "{query}". '
                    "Each 5-10 words. Cover different topics. Varied, no repetition, completely UNIQUE. "
                    "Return ONLY a JSON array, no markdown:\n"
                    '["completion 1","completion 2","completion 3","completion 4","completion 5","completion 6"]'
                )
            else:
                prompt = (
                    f'User is typing: "{query}"\n'
                    f'Generate 6 natural completions that continue EXACTLY from "{query}". '
                    "Each must start with the exact typed text. "
                    "5-12 words total. Specific, varied, completely UNIQUE. "
                    "Return ONLY a JSON array, no markdown:\n"
                    '["completion 1","completion 2","completion 3","completion 4","completion 5","completion 6"]'
                )

        if prompt:
            raw    = call_gemini_api(prompt)
            result = [s.strip() for s in _clean_json(raw) if isinstance(s,str)]
        else:
            result = []

        if query:
            prefixed = [s for s in result if s.lower().startswith(query.lower())]
            result   = prefixed if len(prefixed) >= 2 else result

        # Ensure EXACTLY 3 unique suggestions
        unique_result = []
        seen = set()
        for r in result:
            low = r.lower().strip()
            if low not in seen:
                seen.add(low)
                unique_result.append(r)
                if len(unique_result) == 3:
                    break

        # Fallback defaults ONLY for new_chat or empty results
        if (new_chat and not query) or len(unique_result) < 3:
            import random
            all_defaults = [
                "What can you help me with today?",
                "Can you explain a complex topic simply?",
                "How do I get started with coding?",
                "What are the best practices for software architecture?",
                "Help me brainstorm some new ideas.",
                "Explain the difference between AI and machine learning.",
                "What is the best way to learn a new programming language?",
                "Can you summarize a topic for me?",
                "What are some productivity tips for developers?",
                "How does the internet actually work?",
            ]
            random.shuffle(all_defaults)
            for d in all_defaults:
                if d.lower() not in seen:
                    seen.add(d.lower())
                    unique_result.append(d)
                    if len(unique_result) == 3:
                        break

        return {"suggestions": unique_result}

    except Exception:
        import random
        _fb = [
            "What can you help me with today?",
            "Can you explain a complex topic simply?",
            "How do I get started with coding?",
            "What are the best practices for software architecture?",
            "Help me brainstorm some new ideas.",
            "Explain the difference between AI and machine learning.",
            "What is the best way to learn a new programming language?",
        ]
        random.shuffle(_fb)
        return {"suggestions": _fb[:3]}

@router.post("/upload_pdf")
async def upload_pdf(file: UploadFile = File(...)):
    global CURRENT_PDF_TEXT
    try:
        if not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Only PDF files allowed")
        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="File is empty")
        if len(contents) > 10*1024*1024:
            raise HTTPException(status_code=400, detail="PDF too large (max 10MB)")
        try:
            import fitz
        except ImportError:
            raise HTTPException(status_code=500, detail="PyMuPDF not installed. Run: pip install pymupdf")
        doc        = fitz.open(stream=contents, filetype="pdf")
        page_count = doc.page_count
        text       = "".join(f"\n--- Page {n+1} ---\n{doc[n].get_text()}" for n in range(page_count))
        doc.close()
        text = text.strip()
        if not text:
            raise HTTPException(status_code=400, detail="PDF has no readable text (may be image-only).")
        text = text[:12000]; CURRENT_PDF_TEXT = text
        return {"filename":file.filename,"content":text,"pages":page_count}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process PDF: {e}")
