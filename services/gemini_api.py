import os
import json
import re
import time
import markdown
import requests as _requests
from dotenv import load_dotenv
from html.parser import HTMLParser

load_dotenv()

API_KEY = os.getenv("GEMINI_API_KEY", "")
if not API_KEY:
    raise RuntimeError("GEMINI_API_KEY environment variable is not set.")

# Direct REST API — no SDK, no model name mangling, no version conflicts
# Both models confirmed available on this API key via list_models
_MODELS = [
    "gemini-2.0-flash-lite",   # fastest free-tier, primary
    "gemini-2.0-flash",        # fallback if lite is rate-limited
    "gemma-4-26b-a4b-it",      # Gemma fallback
]
_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


# ── Main chat function ────────────────────────────────────────────────────────

def call_gemini_api(
    message:              str,
    conversation_history: list = None,
    topic_lock:           str  = None,
    rag_context:          str  = ""
) -> str:
    try:
        context_block = ""
        if conversation_history:
            lines = []
            for turn in conversation_history[-10:]:
                role    = "User" if turn["role"] == "user" else "Assistant"
                content = _strip_html(turn.get("content", "")).strip()
                if "This chat is locked to the topic" in content:
                    continue
                if content:
                    lines.append(f"{role}: {content}")
            if lines:
                context_block = (
                    "## Conversation so far (for context — do NOT repeat it):\n"
                    + "\n".join(lines)
                    + "\n\n"
                )

        topic_block = ""
        if topic_lock:
            topic_block = f"""## ⚠ TOPIC LOCK — HIGHEST PRIORITY INSTRUCTION:
This entire chat session is locked strictly to the topic: "{topic_lock}"

You MUST follow these rules without exception:
1. ONLY answer questions that are directly and clearly related to "{topic_lock}".
2. If the user asks about ANYTHING outside "{topic_lock}" — even slightly —
   do NOT answer it. Instead reply with this exact message (nothing else):
   "This chat is locked to the topic '{topic_lock}'. I can only help with
    questions related to {topic_lock}. Please ask something about {topic_lock}."
3. Maintain full conversation context and history within "{topic_lock}".
4. Even if the user rephrases or insists, stay strictly within "{topic_lock}".
5. Basic greetings (Hi, Hello) and "thank you" are always allowed.
6. This topic lock rule OVERRIDES all other instructions below.

"""

        rag_block = ""
        if rag_context and rag_context.strip():
            rag_block = rag_context + "\n"

        prompt = f"""You are a helpful and intelligent AI assistant with memory of the conversation.

{topic_block}{rag_block}{context_block}## Current Question:
{message}

STRICT RESPONSE RULES — follow exactly:

1. CONTEXT AWARENESS:
   - Always read the conversation history before answering.
   - If user writes "its types", "explain it" WITHOUT a subject → the subject is
     the topic discussed in previous turns. NEVER introduce an unrelated topic.

2. ALL ANSWERS — ALWAYS PLAIN TEXT FORMAT:
   - NEVER produce markdown tables in your response text.
   - Even for comparison/difference questions, answer in plain text paragraphs
     and bullet points.
   - Tables only appear when user explicitly clicks the Visualize button.

3. SHORT / SIMPLE QUESTIONS (define, what is, meaning):
   - 1–3 sentences. No bullets, no headings.

4. DETAILED / EXPLANATION QUESTIONS (explain, describe, elaborate, how does, in detail):
   - Start with ONE short introductory paragraph (2–3 sentences).
   - Then numbered headings: "1. Heading Name"
   - Under each heading: 2–4 bullet points ("  - bullet text")
   - Each bullet: 1 sentence max.

5. COMPARISON / DIFFERENCE QUESTIONS (difference between, compare, vs):
   - Answer in plain text paragraphs + bullet points.
   - Explain each item briefly, then list differences as bullets.
   - Do NOT use a table.

6. TYPES / LIST QUESTIONS:
   - One intro sentence, then numbered list with **Bold Name**: description.

7. DATA / STATISTICS QUESTIONS (prices, rates, values, trends over time):
   - Give a clear text answer with actual data points mentioned.
   - Include specific numbers when known.

8. CODE QUESTIONS:
   - Brief explanation, then code block with correct language label.

9. GREETINGS / THANKS:
   - Short natural reply only.

10. GENERAL RULES:
    - Do NOT start with "Hi", "Hello", "Sure", "Of course", "Great question".
    - Do NOT use emojis.
    - Do NOT repeat the question.
    - Do NOT produce markdown tables.
    - Keep responses clean, direct, and human-like.
"""
        return _call_with_retry(prompt, as_html=True)

    except Exception as e:
        raise Exception(f"Gemini Error: {str(e)}")


# ── Table extraction ──────────────────────────────────────────────────────────

def extract_table_from_html(html_content: str, chat_text: str) -> dict:
    try:
        class TableParser(HTMLParser):
            def __init__(self):
                super().__init__()
                self.in_table = self.in_row = self.in_cell = self.is_header = False
                self.current_cell = ""
                self.current_row  = []
                self.headers      = []
                self.rows         = []

            def handle_starttag(self, tag, attrs):
                if tag == "table":                   self.in_table = True
                elif tag == "tr" and self.in_table:  self.in_row = True; self.current_row = []
                elif tag == "th" and self.in_row:    self.in_cell = True; self.is_header = True;  self.current_cell = ""
                elif tag == "td" and self.in_row:    self.in_cell = True; self.is_header = False; self.current_cell = ""

            def handle_endtag(self, tag):
                if tag in ("th", "td") and self.in_cell:
                    self.in_cell = False
                    cell = self.current_cell.strip()
                    if self.is_header: self.headers.append(cell)
                    else:              self.current_row.append(cell)
                elif tag == "tr" and self.in_row:
                    self.in_row = False
                    if self.current_row: self.rows.append(self.current_row[:])
                elif tag == "table":
                    self.in_table = False

            def handle_data(self, data):
                if self.in_cell: self.current_cell += data

        parser = TableParser()
        parser.feed(html_content)

        if parser.headers and parser.rows:
            labels = [r[0] for r in parser.rows if r]
            values = []
            for r in parser.rows:
                found = False
                for cell in r[1:]:
                    clean = re.sub(r"[^0-9.\-]", "", str(cell))
                    try:
                        values.append(float(clean)); found = True; break
                    except Exception:
                        continue
                if not found:
                    values.append(float(len(values) + 1) * 10)
            return {
                "headers": parser.headers, "rows": parser.rows,
                "labels":  labels,         "values": values,
                "xLabel":  parser.headers[0] if parser.headers else "Category",
                "yLabel":  parser.headers[1] if len(parser.headers) > 1 else "Value",
                "source":  "html_table"
            }

        plain = _strip_html(html_content)
        return _ask_gemini_for_table(plain or chat_text)

    except Exception:
        return _ask_gemini_for_table(chat_text)


def _ask_gemini_for_table(text: str) -> dict:
    try:
        prompt = f"""You are a data structuring assistant.
Convert the following text into a clean structured table.

TEXT:
{text[:3000]}

Return ONLY a raw JSON object (no markdown, no code blocks):
{{
  "headers": ["Column1", "Column2", "Column3"],
  "rows": [
    ["row1col1", "row1col2", "row1col3"],
    ["row2col1", "row2col2", "row2col3"]
  ],
  "labels": ["row1col1", "row2col1"],
  "values": [10, 20],
  "xLabel": "Column1",
  "yLabel": "Column2"
}}

Rules:
- headers = meaningful column names from the content
- rows = actual data rows (at least 2, max 10)
- For comparison text: headers = ["Feature", "Item A", "Item B", ...]
  rows = [["feature name", "value for A", "value for B"], ...]
- labels = first column of each row
- values = best numeric representation of each row (for chart use)
- Never return empty arrays
"""
        raw = _call_with_retry(prompt, as_html=False).strip()
        raw = re.sub(r"^```json\s*|^```\s*|\s*```$", "", raw).strip()
        data    = json.loads(raw)
        headers = data.get("headers", [])
        rows    = data.get("rows",    [])
        labels  = data.get("labels",  [r[0] for r in rows if r])
        values  = []
        for v in data.get("values", []):
            try:    values.append(float(str(v).replace(",", "")))
            except: values.append(0.0)
        if not headers or not rows:
            raise ValueError("Empty table from Gemini")
        return {
            "headers": headers, "rows": rows, "labels": labels, "values": values,
            "xLabel":  headers[0] if headers else "Category",
            "yLabel":  headers[1] if len(headers) > 1 else "Value",
            "source":  "gemini_generated"
        }
    except Exception:
        return {
            "headers": ["Item", "Value"],
            "rows":    [["A","40"],["B","70"],["C","55"],["D","85"]],
            "labels":  ["A","B","C","D"], "values": [40.0, 70.0, 55.0, 85.0],
            "xLabel":  "Item", "yLabel": "Value", "source": "fallback"
        }


# ── Chart data extraction ─────────────────────────────────────────────────────

def extract_chart_data(chat_text: str) -> dict:
    try:
        prompt = f"""You are a data extraction assistant.
Extract numeric/comparative data from this chat text for a chart.

TEXT:
{chat_text[:3000]}

Return ONLY raw JSON (no markdown):
{{
  "labels":  ["label1", "label2"],
  "values":  [10, 20],
  "xLabel":  "Category",
  "yLabel":  "Value",
  "headers": ["Category", "Value"],
  "rows":    [["label1","10"],["label2","20"]]
}}

Rules:
- labels = string names (items being compared or measured)
- values = numeric values (use representative numbers if not explicit)
- Always at least 3 items
- For time-series data (years): labels = years, values = data points
"""
        raw = _call_with_retry(prompt, as_html=False).strip()
        raw = re.sub(r"^```json\s*|^```\s*|\s*```$", "", raw).strip()
        data   = json.loads(raw)
        labels = data.get("labels", [])
        values = []
        for v in data.get("values", []):
            try:    values.append(float(str(v).replace(",", "")))
            except: values.append(0.0)
        min_len = min(len(labels), len(values))
        if min_len < 2:
            labels = ["A","B","C","D"]; values = [40.0,70.0,55.0,85.0]; min_len = 4
        labels = labels[:min_len]; values = values[:min_len]
        return {
            "labels":  labels, "values": values,
            "xLabel":  data.get("xLabel", "Category"),
            "yLabel":  data.get("yLabel", "Value"),
            "headers": data.get("headers", ["Category", "Value"]),
            "rows":    data.get("rows", [[str(l),str(v)] for l,v in zip(labels,values)])
        }
    except Exception:
        return {
            "labels":  ["A","B","C","D"], "values": [40.0,70.0,55.0,85.0],
            "xLabel":  "Category", "yLabel": "Value",
            "headers": ["Category","Value"],
            "rows":    [["A","40"],["B","70"],["C","55"],["D","85"]]
        }


# ── Visualization explanation ─────────────────────────────────────────────────

def generate_viz_explanation(viz_type: str, chart_type: str,
                              labels: list, values: list,
                              xLabel: str, yLabel: str,
                              headers: list, rows: list) -> str:
    try:
        if viz_type == "table":
            data_desc = f"Table headers: {headers}\nRows (first 5): {rows[:5]}"
            task      = ("Explain what this table shows. Describe key comparisons, "
                         "patterns, or insights from the data.")
        else:
            type_name = chart_type or "bar"
            pairs     = ", ".join(f"{l}={v}" for l, v in zip(labels[:8], values[:8]))
            data_desc = (f"{type_name.capitalize()} chart. "
                         f"X-axis: {xLabel}, Y-axis: {yLabel}. Data: {pairs}")
            task      = (f"Explain what this {type_name} chart shows. "
                         "Describe key trends, highest/lowest values, and meaning.")

        prompt = f"""You are explaining a data visualization.

Data: {data_desc}
Task: {task}

Return ONLY valid HTML in this exact format (no extra text outside HTML):
<p>Short intro sentence (1-2 lines max).</p>
<ol>
  <li><strong>Key Insight Title</strong>
    <ul>
      <li>Specific observation from the data</li>
      <li>Another detail or implication</li>
    </ul>
  </li>
  <li><strong>Another Insight Title</strong>
    <ul>
      <li>Key point here</li>
      <li>Supporting detail</li>
    </ul>
  </li>
</ol>

Rules:
- 2 to 4 numbered items
- Each item has 2 bullets
- Be specific about actual values/items from the data
- No markdown, no code fences, just HTML
"""
        result = _call_with_retry(prompt, as_html=False).strip()
        result = re.sub(r"^```html?\s*|\s*```$", "", result).strip()
        return result if result.startswith("<") else f"<p>{result}</p>"

    except Exception:
        return "<p>Could not generate explanation for this visualization.</p>"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _strip_html(html: str) -> str:
    return re.sub(r"<[^>]+>", " ", html).strip()


def _call_with_retry(prompt: str, as_html: bool = True) -> str:
    """
    Try each model in _MODELS in order.
    On 429 (rate limit): wait with exponential backoff and retry same model.
    On 404 (model not found): immediately try next model.
    """
    last_err = None

    for model_name in _MODELS:
        url        = _API_BASE.format(model=model_name)
        max_tries  = 3
        base_delay = 5   # start at 5s for rate limit — longer than before

        for attempt in range(max_tries):
            try:
                resp = _requests.post(
                    url,
                    headers={"Content-Type": "application/json"},
                    params={"key": API_KEY},
                    json={
                        "contents": [{"parts": [{"text": prompt}]}],
                        "generationConfig": {
                            "temperature": 0.7,
                            "maxOutputTokens": 2048
                        }
                    },
                    timeout=60
                )

                # 429 rate limit — wait and retry same model
                if resp.status_code == 429:
                    if attempt < max_tries - 1:
                        wait = base_delay * (2 ** attempt)   # 5s, 10s, 20s
                        time.sleep(wait)
                        continue
                    else:
                        last_err = f"429 rate limit on {model_name}"
                        break   # try next model

                # 404 model not found — skip to next model immediately
                if resp.status_code == 404:
                    last_err = f"404 model not found: {model_name}"
                    break

                resp.raise_for_status()

                data = resp.json()
                text = (
                    data.get("candidates", [{}])[0]
                        .get("content", {})
                        .get("parts", [{}])[0]
                        .get("text", "")
                )
                if not text:
                    raise Exception(f"Empty response from {model_name}")

                if as_html:
                    return markdown.markdown(text, extensions=["extra", "nl2br", "codehilite"])
                return text

            except _requests.exceptions.HTTPError:
                raise   # already handled above via status code checks
            except Exception as e:
                err = str(e)
                if ("503" in err or "502" in err) and attempt < max_tries - 1:
                    time.sleep(base_delay * (2 ** attempt))
                    continue
                last_err = err
                break   # try next model

    raise Exception(f"Gemini Error: All models failed. Last error: {last_err}")
