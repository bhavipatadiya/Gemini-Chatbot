from fastapi import FastAPI, Request
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles

from routes.chat import router as chat_router

app = FastAPI(title="Gemini Chat API")

app.include_router(chat_router)

templates = Jinja2Templates(directory="templates")

app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def home(request: Request):
    return templates.TemplateResponse(request, "index.html", {})


@app.get("/callback")
async def callback(request: Request):
    return templates.TemplateResponse(request, "index.html", {})
