from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import os
import re
import unicodedata
import requests
from typing import Optional, List

# Load .env file from the current directory
load_dotenv()

HF_TOKEN = os.environ.get("HF_TOKEN")
if not HF_TOKEN:
    raise RuntimeError("HF_TOKEN is not set. Add it to backend/.env")

HF_MODEL = "facebook/bart-large-cnn"
HF_URL = f"https://api-inference.huggingface.co/models/{HF_MODEL}"
HF_HEADERS = {"Authorization": f"Bearer {HF_TOKEN}"}

app = FastAPI(title="Smart Reading Companion API")

# Allow requests from the extension (during development allow all origins)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SummarizeRequest(BaseModel):
    text: str
    # "concise" keeps the old behavior; "detailed" aims to keep most important details
    level: Optional[str] = "detailed"
    max_length: Optional[int] = None
    min_length: Optional[int] = None
    do_sample: Optional[bool] = False

@app.get("/")
def read_root():
    return {"message": "Smart Reading Companion API is running", "docs": "/docs"}

# ---------- Helpers ----------

_WS_RE = re.compile(r"\s+")
_CITE_RE = re.compile(r"\[\d{1,3}\]")         # Wikipedia-style [12]
_URL_RE = re.compile(r"https?://\S+")         # long URLs
_CTRL_RE = re.compile(r"[\u0000-\u001F]")     # control chars

def _sanitize_text(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = _CTRL_RE.sub(" ", s)
    s = _CITE_RE.sub("", s)
    s = _URL_RE.sub("", s)
    s = s.replace("\u2014", "-").replace("\u00A0", " ")
    s = _WS_RE.sub(" ", s).strip()
    return s

def _hf_summarize_once(
    text: str,
    max_len: int,
    min_len: int,
    do_sample: bool = False,
) -> str:
    # Guard rails for params (BART is comfortable in this band)
    max_len = max(48, min(int(max_len), 256))
    min_len = max(24, min(int(min_len), max_len - 12))

    payload = {
        "inputs": text,
        "parameters": {
            "max_length": max_len,
            "min_length": min_len,
            "do_sample": bool(do_sample),
            "no_repeat_ngram_size": 3,
            "length_penalty": 1.0,
        },
    }
    try:
        r = requests.post(HF_URL, headers=HF_HEADERS, json=payload, timeout=60)
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Hugging Face request failed: {e}")

    if r.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Hugging Face error {r.status_code}: {r.text}")

    try:
        data = r.json()
        return data[0]["summary_text"]
    except Exception:
        raise HTTPException(status_code=500, detail=f"Unexpected HF response: {r.text}")

def _split_chunks(s: str, chunk_chars: int, overlap: int) -> List[str]:
    chunks: List[str] = []
    n = len(s)
    if n == 0:
        return chunks
    i = 0
    while i < n:
        j = min(i + chunk_chars, n)
        chunks.append(s[i:j])
        if j == n:
            break
        i = max(0, j - overlap)
    return chunks

# ---------- Endpoint ----------

@app.post("/summarize")
def summarize(req: SummarizeRequest):
    raw = (req.text or "")
    text = _sanitize_text(raw)
    if len(text) < 80:
        raise HTTPException(status_code=400, detail="Text is too short to summarize.")

    level = (req.level or "detailed").lower().strip()

    if level == "detailed":
        # Smaller chunks, keep more detail per chunk, and DO NOT compress again.
        chunks = _split_chunks(text, chunk_chars=900, overlap=120)
        max_len = req.max_length or 220
        min_len = req.min_length or 110
        parts: List[str] = []
        for ch in chunks:
            parts.append(_hf_summarize_once(ch, max_len=max_len, min_len=min_len, do_sample=bool(req.do_sample)))
        # Join with paragraph breaks to preserve structure
        summary = "\n\n".join(parts)
        return {"summary": summary}

    # Concise mode: larger chunks + a second pass compression
    chunks = _split_chunks(text, chunk_chars=1200, overlap=100)
    if not chunks:
        raise HTTPException(status_code=400, detail="Empty text after preprocessing.")

    per_chunk = []
    for ch in chunks:
        per_chunk.append(
            _hf_summarize_once(
                ch,
                max_len=req.max_length or 180,
                min_len=req.min_length or 60,
                do_sample=bool(req.do_sample),
            )
        )

    if len(per_chunk) > 1:
        combined = " ".join(per_chunk)
        final = _hf_summarize_once(
            combined,
            max_len=req.max_length or 180,
            min_len=req.min_length or 60,
            do_sample=bool(req.do_sample),
        )
        return {"summary": final}

    return {"summary": per_chunk[0]}