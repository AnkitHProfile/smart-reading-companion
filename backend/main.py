# backend/main.py
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from pathlib import Path
from typing import Optional, List, Tuple
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

import os
import re
import time
import unicodedata
import requests

# -----------------------------------------------------------
# Load .env sitting next to this file
# -----------------------------------------------------------
ENV_PATH = Path(__file__).parent / ".env"
load_dotenv(dotenv_path=ENV_PATH)

HF_TOKEN = os.environ.get("HF_TOKEN")                           # optional if you only use local
HF_MODEL = os.environ.get("HF_MODEL", "facebook/bart-large-cnn")
LOCAL_MODEL = os.environ.get("LOCAL_MODEL", "sshleifer/distilbart-cnn-12-6")
BACKEND_MODE = os.environ.get("SUMMARIZER_BACKEND", "auto").lower()  # auto | hf | local
REQUEST_TIMEOUT = int(os.environ.get("REQUEST_TIMEOUT", "60"))
MAX_WORKERS = int(os.environ.get("MAX_WORKERS", "4"))           # parallel chunk summarization
MAX_INPUT_CHARS = int(os.environ.get("MAX_INPUT_CHARS", "60000"))  # hard cap to protect latency

app = FastAPI(title="Smart Reading Companion API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # tighten in prod if you host this
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------- Sanitizers ----------------------------
_WS_RE   = re.compile(r"\s+")
_CITE_RE = re.compile(r"\[\d{1,3}\]")        # [12] style
_URL_RE  = re.compile(r"https?://\S+")
_CTRL_RE = re.compile(r"[\u0000-\u001F]")

def _sanitize_text(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = _CTRL_RE.sub(" ", s)
    s = _CITE_RE.sub("", s)
    s = _URL_RE.sub("", s)
    s = s.replace("\u2014", "-").replace("\u00A0", " ")
    s = _WS_RE.sub(" ", s).strip()
    # cap extremely long input to keep latency predictable
    if len(s) > MAX_INPUT_CHARS:
        s = s[:MAX_INPUT_CHARS]
    return s

def _word_count(s: str) -> int:
    return len([w for w in s.split(" ") if w])

# ---------------------------- Sentence-aware chunking ----------------------------
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])")

@dataclass
class ChunkingPlan:
    chunk_chars: int
    overlap: int

def _pack_sentences(text: str, plan: ChunkingPlan) -> List[str]:
    """
    Split by sentence boundaries and pack sentences into ~chunk_chars windows.
    Adds small overlap (by characters) to preserve coherence.
    """
    if not text:
        return []

    sents = _SENT_SPLIT_RE.split(text)
    chunks: List[str] = []
    cur = []

    cur_len = 0
    for sent in sents:
        slen = len(sent)
        if cur_len + slen > plan.chunk_chars and cur:
            chunks.append(" ".join(cur).strip())
            # overlap from the tail
            tail = []
            tail_len = 0
            for s in reversed(cur):
                if tail_len + len(s) >= plan.overlap:
                    break
                tail.append(s)
                tail_len += len(s)
            cur = list(reversed(tail))
            cur_len = sum(len(s) for s in cur)

        cur.append(sent)
        cur_len += slen

    if cur:
        chunks.append(" ".join(cur).strip())
    return chunks

# ---------------------------- Length control ----------------------------
def _target_token_band(total_words: int, ratio: float) -> Tuple[int, int]:
    """
    Map desired ratio of original (by words) to a safe token band for BART-like models.
    Heuristic: tokens ≈ 1.35 * words for English BPE; clamp to [48, 256].
    """
    ratio = max(0.05, min(float(ratio), 0.30))  # allow 5%..30%
    target_words = max(50, int(round(total_words * ratio)))  # never too tiny
    target_tokens = int(round(target_words * 1.35))
    min_tok = max(48, int(target_tokens * 0.9))
    max_tok = min(256, max(int(target_tokens * 1.1), min_tok + 12))
    return (min_tok, max_tok)

def _band_for_intermediate() -> Tuple[int, int]:
    """Loose band for per-chunk summaries in the first pass (coverage first)."""
    return (80, 140)

# ---------------------------- Backends ----------------------------
class BaseSummarizer:
    def summarize_once(self, text: str, max_len: int, min_len: int, do_sample: bool) -> str:
        raise NotImplementedError

class HFSummarizer(BaseSummarizer):
    def __init__(self, token: Optional[str], model: str):
        if not token:
            raise RuntimeError("HF_TOKEN is required for Hugging Face backend")
        self.headers = {"Authorization": f"Bearer {token}"}
        self.url = f"https://api-inference.huggingface.co/models/{model}"

    @staticmethod
    def _bound_lengths(max_len: int, min_len: int) -> Tuple[int, int]:
        max_len = max(48, min(int(max_len), 256))
        min_len = max(24, min(int(min_len), max_len - 12))
        return max_len, min_len

    def _post_with_retries(self, payload: dict, retries: int = 2) -> requests.Response:
        delay = 1.0
        for attempt in range(retries + 1):
            try:
                r = requests.post(self.url, headers=self.headers, json=payload, timeout=REQUEST_TIMEOUT)
                # 5xx or 429 -> retry
                if r.status_code >= 500 or r.status_code == 429:
                    raise requests.exceptions.HTTPError(f"status {r.status_code}: {r.text}")
                return r
            except requests.exceptions.RequestException:
                if attempt == retries:
                    raise
                time.sleep(delay)
                delay *= 2
        # should not reach
        raise requests.exceptions.RequestException("exhausted retries")

    def summarize_once(self, text: str, max_len: int, min_len: int, do_sample: bool) -> str:
        max_len, min_len = self._bound_lengths(max_len, min_len)
        payload = {
            "inputs": text,
            "parameters": {
                "max_length": max_len,
                "min_length": min_len,
                "do_sample": bool(do_sample),
                "num_beams": 4,             # better factuality than sampling
                "no_repeat_ngram_size": 3,
                "length_penalty": 1.0,
            },
        }
        try:
            r = self._post_with_retries(payload)
        except requests.exceptions.RequestException as e:
            raise HTTPException(status_code=502, detail=f"Hugging Face request failed: {e}")

        if r.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Hugging Face error {r.status_code}: {r.text}")

        try:
            data = r.json()
            return data[0]["summary_text"]
        except Exception:
            raise HTTPException(status_code=500, detail=f"Unexpected HF response: {r.text}")

class LocalSummarizer(BaseSummarizer):
    def __init__(self, model_name: str):
        try:
            from transformers import pipeline  # noqa: F401
        except Exception as e:
            raise RuntimeError(
                "Local backend requires 'transformers' (and torch). Install:\n"
                "  pip install 'transformers>=4.41,<5' torch\n"
                f"(Reason: {e})"
            )
        from transformers import pipeline
        # CPU-friendly; set device_map='auto' if you have a GPU
        self.pipe = pipeline("summarization", model=model_name, tokenizer=model_name)

    @staticmethod
    def _bound_lengths(max_len: int, min_len: int) -> Tuple[int, int]:
        max_len = max(48, min(int(max_len), 256))
        min_len = max(24, min(int(min_len), max_len - 12))
        return max_len, min_len

    def summarize_once(self, text: str, max_len: int, min_len: int, do_sample: bool) -> str:
        max_len, min_len = self._bound_lengths(max_len, min_len)
        try:
            out = self.pipe(
                text,
                max_length=max_len,
                min_length=min_len,
                num_beams=4,
                do_sample=bool(do_sample),
                truncation=True,
            )
            return out[0]["summary_text"]
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Local summarizer failed: {e}")

# Singletons
_LOCAL_INSTANCE: Optional[LocalSummarizer] = None
_HF_INSTANCE: Optional[HFSummarizer] = None

def _get_local() -> LocalSummarizer:
    global _LOCAL_INSTANCE
    if _LOCAL_INSTANCE is None:
        _LOCAL_INSTANCE = LocalSummarizer(LOCAL_MODEL)
    return _LOCAL_INSTANCE

def _get_hf() -> HFSummarizer:
    global _HF_INSTANCE
    if _HF_INSTANCE is None:
        _HF_INSTANCE = HFSummarizer(HF_TOKEN, HF_MODEL)
    return _HF_INSTANCE

# Choose backend
def init_summarizer() -> BaseSummarizer:
    if BACKEND_MODE == "hf":
        return _get_hf()
    if BACKEND_MODE == "local":
        return _get_local()
    # auto: prefer HF, fall back to local
    try:
        return _get_hf()
    except Exception:
        return _get_local()

SUMMARIZER: BaseSummarizer
try:
    SUMMARIZER = init_summarizer()
except Exception as e:
    raise RuntimeError(f"Failed to initialize summarizer backend ({BACKEND_MODE}): {e}")

# ---------------------------- Schemas ----------------------------
class SummarizeRequest(BaseModel):
    text: str
    ratio: Optional[float] = 0.10         # ~10% of original
    level: Optional[str] = "ratio"        # "ratio" | "concise" (legacy)
    max_length: Optional[int] = None      # kept for compatibility (ignored in ratio mode)
    min_length: Optional[int] = None
    do_sample: Optional[bool] = False

# ---------------------------- Routes ----------------------------
@app.get("/")
def read_root():
    return {
        "message": "Smart Reading Companion API is running",
        "docs": "/docs",
        "backend": BACKEND_MODE,
        "model": HF_MODEL if isinstance(SUMMARIZER, HFSummarizer) else LOCAL_MODEL,
    }

@app.get("/whoami")
def whoami():
    if not isinstance(SUMMARIZER, HFSummarizer):
        return {"backend": "local", "status": "ok"}
    try:
        r = requests.get("https://huggingface.co/api/whoami-v2",
                         headers=_get_hf().headers, timeout=15)
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text
        return {"backend": "hf", "status": r.status_code, "body": body}
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"whoami call failed: {e}")

@app.get("/health")
def health():
    return {"ok": True}

# Core helpers
def _summarize_band(text: str, band: Tuple[int, int], do_sample: bool) -> str:
    min_tok, max_tok = band
    return SUMMARIZER.summarize_once(
        text,
        max_len=max_tok,
        min_len=min_tok,
        do_sample=do_sample
    )

def _summarize_chunks_parallel(chunks: List[str], band: Tuple[int, int], do_sample: bool) -> List[str]:
    """Summarize chunks in parallel to speed up long pages."""
    results: List[str] = [""] * len(chunks)
    with ThreadPoolExecutor(max_workers=min(MAX_WORKERS, len(chunks))) as ex:
        futures = {ex.submit(_summarize_band, ch, band, do_sample): idx for idx, ch in enumerate(chunks)}
        for fut in as_completed(futures):
            idx = futures[fut]
            results[idx] = fut.result()
    return results

# ---------------------------- Endpoint ----------------------------
@app.post("/summarize")
def summarize(req: SummarizeRequest):
    raw = (req.text or "")
    text = _sanitize_text(raw)
    total_words = _word_count(text)
    if total_words < 40:
        raise HTTPException(status_code=400, detail="Text is too short to summarize.")

    level = (req.level or "ratio").lower().strip()
    ratio = float(req.ratio if req.ratio is not None else 0.10)

    # Compute final target band once; we always enforce it at the end.
    final_min, final_max = _target_token_band(total_words, ratio)

    # VERY LONG pieces: sentence-aware first pass on big chunks in parallel, then final pass.
    if len(text) > 4500:
        plan = ChunkingPlan(chunk_chars=2200, overlap=150)
        chunks = _pack_sentences(text, plan)
        inter_band = _band_for_intermediate()
        parts = _summarize_chunks_parallel(chunks, inter_band, bool(req.do_sample))
        combined = " ".join(parts)
        final = _summarize_band(combined, (final_min, final_max), bool(req.do_sample))
        return {"summary": final}

    # Short/medium: single pass directly to target band
    if level == "ratio":
        final = _summarize_band(text, (final_min, final_max), bool(req.do_sample))
        return {"summary": final}

    # Legacy 'concise' path (still enforces final pass)
    plan = ChunkingPlan(chunk_chars=1400, overlap=120)
    chunks = _pack_sentences(text, plan)
    inter_band = _band_for_intermediate()
    per_chunk = _summarize_chunks_parallel(chunks, inter_band, bool(req.do_sample))
    combined = " ".join(per_chunk) if len(per_chunk) > 1 else per_chunk[0]
    final = _summarize_band(combined, (final_min, final_max), bool(req.do_sample))
    return {"summary": final}