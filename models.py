from pydantic import BaseModel
from typing import Optional

class ChatRequest(BaseModel):
    message: str

class ChatResponse(BaseModel):
    reply: str
    table: Optional[dict] = None
    chart: Optional[dict] = None
    selected_view: Optional[str] = None
    chart_type: Optional[str] = None