import json
import os
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

router = APIRouter()

BASE_DIR       = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILE_PATH      = os.path.join(BASE_DIR, "data", "chats.json")
SHARE_PATH     = os.path.join(BASE_DIR, "data", "shared_chats.json")

CURRENT_PDF_TEXT = ""


def load_chats():
    if not os.path.exists(FILE_PATH):
        return []
    try:
        with open(FILE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except:
        return []


def save_chats(chats):
    os.makedirs(os.path.dirname(FILE_PATH), exist_ok=True)
    with open(FILE_PATH, "w", encoding="utf-8") as f:
        json.dump(chats, f, indent=2, ensure_ascii=False)


def load_shared():
    if not os.path.exists(SHARE_PATH):
        return {}
    try:
        with open(SHARE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except:
        return {}


def save_shared(data: dict):
    os.makedirs(os.path.dirname(SHARE_PATH), exist_ok=True)
    with open(SHARE_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)



@router.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: Request):
    global CURRENT_PDF_TEXT
    try:
        data                 = await request.json()
        message              = data.get("message", "").strip()
        pdf_text             = data.get("pdf_text", "")
        use_pdf              = data.get("use_pdf", False)
        conversation_history = data.get("conversation_history", [])
        topic_lock           = data.get("topic_lock", None)

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
                return {
                    "labels":  ["A","B","C","D"],
                    "values":  [30,60,45,75],
                    "xLabel":  "Category",
                    "yLabel":  "Value",
                    "headers": ["Category","Value"],
                    "rows":    [["A","30"],["B","60"],["C","45"],["D","75"]]
                }
            result = extract_chart_data(chat_text)
        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/explain_viz")
async def explain_viz(request: Request):
    try:
        data       = await request.json()
        viz_type   = data.get("viz_type",   "chart")
        chart_type = data.get("chart_type", "bar")
        labels     = data.get("labels",  [])
        values     = data.get("values",  [])
        xLabel     = data.get("xLabel",  "Category")
        yLabel     = data.get("yLabel",  "Value")
        headers    = data.get("headers", ["Category","Value"])
        rows       = data.get("rows",    [])

        html = generate_viz_explanation(
            viz_type, chart_type, labels, values, xLabel, yLabel, headers, rows
        )
        return {"explanation": html}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



@router.get("/chats")
def get_chats():
    return load_chats()



@router.post("/save_chat")
async def save_chat(request: Request):
    try:
        data     = await request.json()
        chats    = load_chats()
        title    = data.get("title", "").strip()
        messages = data.get("messages", [])
        pdfs     = data.get("pdfs", [])

        if not title:
            title = f"Chat {len(chats) + 1}"

        formatted = []
        for msg in messages:
            fm = {
                "role":    msg.get("role", "bot"),
                "content": msg.get("text") or msg.get("content") or ""
            }
            for field in [
                "pdfs", "msgId", "selected_view", "chart_type",
                "extracted_data", "viz_explanation",
                "vizType", "chartType", "chartData", "tableHTML", "vizText"
            ]:
                if msg.get(field) is not None:
                    fm[field] = msg[field]
            formatted.append(fm)

        found = False
        for chat in chats:
            if chat["title"] == title:
                chat["messages"] = formatted
                chat["pdfs"]     = pdfs
                chat["topic"]    = data.get("topic", None)
                found            = True
                break

        if not found:
            chats.append({
                "id":       len(chats) + 1,
                "title":    title,
                "messages": formatted,
                "pdfs":     pdfs,
                "topic":    data.get("topic", None)
            })

        save_chats(chats)
        return {"status": "saved"}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/share_chat")
async def share_chat(request: Request):
    try:
        data  = await request.json()
        title = data.get("title", "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Title required")

        chats = load_chats()
        chat  = next((c for c in chats if c["title"] == title), None)
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")

        shared = load_shared()

        
        for token, entry in shared.items():
            if entry.get("title") == title:
                return {"token": token}

        
        token = str(uuid.uuid4()).replace("-", "")[:16]
        
        shared_title = chat["title"]
        first_user_msg = next((m for m in chat.get("messages", []) if m.get("role") == "user"), None)
        msg_text = first_user_msg.get("content", "") if first_user_msg else ""
        if msg_text:
            try:
                from services.gemini_api import call_gemini_api
                prompt = (
                    f"Give a 3-5 word chat title for: {msg_text}\n"
                    "Output ONLY the title — no punctuation, no quotes."
                )
                raw = call_gemini_api(prompt)
                import re
                gen_title = re.sub(r"<[^>]+>", "", raw).strip().strip(".,:-\"'")[:50]
                if gen_title:
                    shared_title = gen_title
            except Exception:
                pass

        shared[token] = {
            "title":    shared_title,
            "messages": chat["messages"],
            "topic":    chat.get("topic")
        }
        save_shared(shared)
        return {"token": token}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



@router.get("/shared_list")
def get_shared_list():
    shared = load_shared()
    result = []
    for token, entry in shared.items():
        result.append({
            "token": token,
            "title": entry.get("title", "Shared Chat"),
            "topic": entry.get("topic")
        })
    return result


@router.get("/shared/{token}")
def get_shared_chat(token: str):
    shared = load_shared()
    entry = shared.get(token)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared chat not found or expired.")
    return entry


@router.post("/chat/shared/{token}", response_model=ChatResponse)
async def chat_shared_endpoint(token: str, request: Request):
    global CURRENT_PDF_TEXT
    shared = load_shared()
    entry = shared.get(token)
    if not entry:
        raise HTTPException(status_code=404, detail="Shared chat not found or expired.")
        
    try:
        data                 = await request.json()
        message              = data.get("message", "").strip()
        pdf_text             = data.get("pdf_text", "")
        use_pdf              = data.get("use_pdf", False)
        conversation_history = data.get("conversation_history", [])
        topic_lock           = entry.get("topic") or data.get("topic_lock", None)

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

        from services.gemini_api import call_gemini_api
        reply = call_gemini_api(final_prompt, conversation_history, topic_lock)
        return ChatResponse(reply=reply)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/update_chat")
async def update_chat(request: Request):
    try:
        data      = await request.json()
        old_title = data.get("old_title", "").strip()
        new_title = data.get("new_title", "").strip()
        if not old_title or not new_title:
            raise HTTPException(status_code=400, detail="Both titles required")

        chats = load_chats()
        for c in chats:
            if c["title"] == new_title and c["title"] != old_title:
                raise HTTPException(status_code=400, detail="Title already exists")

        found = False
        for c in chats:
            if c["title"] == old_title:
                c["title"] = new_title; found = True; break

        if not found:
            raise HTTPException(status_code=404, detail="Chat not found")

        save_chats(chats)
        return {"status": "updated", "new_title": new_title}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))



@router.post("/delete_chat")
async def delete_chat(request: Request):
    try:
        data  = await request.json()
        title = data.get("title", "").strip()
        if not title:
            raise HTTPException(status_code=400, detail="Title required")

        chats  = load_chats()
        before = len(chats)
        chats  = [c for c in chats if c["title"] != title]
        if len(chats) == before:
            raise HTTPException(status_code=404, detail="Chat not found")

        for i, c in enumerate(chats):
            c["id"] = i + 1

        save_chats(chats)
        return {"status": "deleted"}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate_title")
async def generate_title(request: Request):
    try:
        data    = await request.json()
        message = data.get("message", "")
        if not message.strip():
            return {"title": "New Chat"}
        prompt = (
            f"Give a 3-5 word chat title for: {message}\n"
            "Output ONLY the title — no punctuation, no quotes."
        )
        raw   = call_gemini_api(prompt)
        import re
        title = re.sub(r"<[^>]+>", "", raw).strip().strip(".,:-\"'")[:50]
        return {"title": title or "New Chat"}
    except:
        return {"title": "New Chat"}


@router.post("/upload_pdf")
async def upload_pdf(file: UploadFile = File(...)):
    global CURRENT_PDF_TEXT
    try:
        if not file.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail="Only PDF files allowed")

        contents = await file.read()
        if not contents:
            raise HTTPException(status_code=400, detail="File is empty")
        if len(contents) > 10 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="PDF too large (max 10MB)")

        try:
            import fitz
        except ImportError:
            raise HTTPException(status_code=500,
                detail="PyMuPDF not installed. Run: pip install pymupdf")

        doc        = fitz.open(stream=contents, filetype="pdf")
        page_count = doc.page_count
        text       = ""
        for n in range(page_count):
            text += f"\n--- Page {n+1} ---\n{doc[n].get_text()}"
        doc.close()

        text = text.strip()
        if not text:
            raise HTTPException(status_code=400,
                detail="PDF has no readable text (may be image-only).")

        text             = text[:12000]
        CURRENT_PDF_TEXT = text
        return {"filename": file.filename, "content": text, "pages": page_count}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to process PDF: {e}")