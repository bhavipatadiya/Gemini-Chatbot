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
FILE_PATH  = os.path.join(BASE_DIR, "data", "chats.json")
SHARE_PATH = os.path.join(BASE_DIR, "data", "shared_chats.json")

CURRENT_PDF_TEXT = ""


def load_chats():
    if not os.path.exists(FILE_PATH):
        return []
    try:
        with open(FILE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def save_chats(chats):
    os.makedirs(os.path.dirname(FILE_PATH), exist_ok=True)
    with open(FILE_PATH, "w", encoding="utf-8") as f:
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
def get_chats():
    chats = load_chats()
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
def get_chat(chat_id: int):
    chats = load_chats()
    for c in chats:
        if c.get("id") == chat_id:
            return c
    raise HTTPException(status_code=404, detail="Chat not found")


@router.post("/save_chat")
async def save_chat(request: Request):
    try:
        data    = await request.json()
        chats   = load_chats()
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
            chats.append({"id":chat_id,"title":title,"messages":formatted,"pdfs":pdfs,"topic":topic,
                          "is_shared":False,"is_pinned":False,"share_id":None,"original_index":len(chats)})

        save_chats(chats)
        return {"status":"saved","id":chat_id,"title":title}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/chat/{chat_id}")
async def patch_chat(chat_id: int, request: Request):
    try:
        data  = await request.json()
        chats = load_chats()
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
                save_chats(chats)
                return {"status":"updated","chat":c}
        raise HTTPException(status_code=404, detail="Chat not found")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/chat/{chat_id}")
async def delete_chat(chat_id: int):
    chats = load_chats()
    before = len(chats)
    chats  = [c for c in chats if c.get("id") != chat_id]
    if len(chats) == before:
        raise HTTPException(status_code=404, detail="Chat not found")
    save_chats(chats); return {"status":"deleted"}

@router.post("/share/{chat_id}")
async def share_chat(chat_id: int):
    chats = load_chats()
    for c in chats:
        if c.get("id") == chat_id:
            if not c.get("share_id"): c["share_id"] = uuid.uuid4().hex
            c["is_shared"] = True; save_chats(chats)
            return {"status":"success","is_shared":True,"share_id":c["share_id"]}
    raise HTTPException(status_code=404, detail="Chat not found")

@router.post("/unshare/{chat_id}")
async def unshare_chat(chat_id: int):
    chats = load_chats()
    for c in chats:
        if c.get("id") == chat_id:
            c["is_shared"] = False; save_chats(chats)
            return {"status":"success","is_shared":False}
    raise HTTPException(status_code=404, detail="Chat not found")

@router.get("/shared/{share_id}", response_class=HTMLResponse)
async def get_shared_html(request: Request, share_id: str):
    return templates.TemplateResponse(request, "index.html", {})

@router.get("/api/shared/{share_id}")
async def get_shared_data(share_id: str):
    chats = load_chats()
    for c in chats:
        if c.get("share_id") == share_id and c.get("is_shared"): return c
    raise HTTPException(status_code=404, detail="Shared chat not found")

@router.post("/shared/chat/{share_id}", response_model=ChatResponse)
async def shared_chat_endpoint(request: Request, share_id: str):
    chats = load_chats()
    if not any(c.get("share_id")==share_id and c.get("is_shared") for c in chats):
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

        if new_chat and not query:
            chats = load_chats()
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
                    "Based on this user's past questions, generate 3 short follow-up "
                    "questions they are likely to ask next. Each 6-10 words. "
                    "Relevant to their interests, varied.\n\n"
                    f"Past questions:\n{sample}\n\n"
                    "Return ONLY a JSON array, no markdown:\n"
                    '["question 1","question 2","question 3"]'
                )
            else:
                return {"suggestions": []}

        elif not query and context:
            prompt = (
                f'The first message in this chat was: "{context[:300]}"\n\n'
                "Generate 3 short follow-up questions the user might ask next, "
                "directly related to this topic. Each 5-10 words. Varied, specific. "
                "Return ONLY a JSON array, no markdown:\n"
                '["question 1","question 2","question 3"]'
            )

        elif not query:
            return {"suggestions": []}

        else:
            words = query.split()
            if len(words) == 1:
                prompt = (
                    f'User typed the word: "{query}"\n'
                    f'Generate 3 questions/phrases that START with "{query}". '
                    "Each 5-10 words. Cover different topics. Varied, no repetition. "
                    "Return ONLY a JSON array, no markdown:\n"
                    '["completion 1","completion 2","completion 3"]'
                )
            else:
                prompt = (
                    f'User is typing: "{query}"\n'
                    f'Generate 3 natural completions that continue EXACTLY from "{query}". '
                    "Each must start with the exact typed text. "
                    "5-12 words total. Specific, varied. "
                    "Return ONLY a JSON array, no markdown:\n"
                    '["completion 1","completion 2","completion 3"]'
                )

        raw    = call_gemini_api(prompt)
        result = [s.strip() for s in _clean_json(raw) if isinstance(s,str)]

        if query:
            prefixed = [s for s in result if s.lower().startswith(query.lower())]
            result   = prefixed if len(prefixed) >= 2 else result

        return {"suggestions": result[:3]}

    except Exception:
        return {"suggestions": []}

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