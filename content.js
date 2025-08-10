console.log("content.js loaded");

let tldrBtn = null;

/* Respect the toggle in chrome.storage.sync */
let SRC_ENABLED = true;
chrome.storage?.sync?.get({ enabled: true }, ({ enabled }) => {
  SRC_ENABLED = !!enabled;
  if (SRC_ENABLED) ensureFab();
});
chrome.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'sync' && changes.enabled) {
    SRC_ENABLED = !!changes.enabled.newValue;
    if (SRC_ENABLED) {
      ensureFab();
    } else {
      removeFab();
    }
  }
});

/* Create TL;DR button (only when enabled) */
function ensureFab() {
  if (tldrBtn && document.body.contains(tldrBtn)) return;

  tldrBtn = document.createElement('button');
  tldrBtn.id = '__src_tldr_btn__';
  tldrBtn.className = 'src-fab';
  tldrBtn.style.zIndex = '2147483647';
  tldrBtn.title = 'Summarize this article';
  tldrBtn.innerHTML = `<span class="dot" aria-hidden="true"></span> TL;DR`;
  tldrBtn.addEventListener('click', onTldrClick);
  document.body.appendChild(tldrBtn);
}

function removeFab() {
  if (tldrBtn) {
    tldrBtn.removeEventListener('click', onTldrClick);
    tldrBtn.remove();
    tldrBtn = null;
  }
  const overlay = document.getElementById('__src_overlay__');
  if (overlay) overlay.remove();
}

/* ---------- Extraction ---------- */
function extractSimple() {
  let title = document.title;
  let text = "";

  try {
    const clone = document.cloneNode(true);
    const article = new Readability(clone).parse();
    if (article?.title) title = article.title;
    if (article?.textContent) text = article.textContent.trim();
  } catch {}

  if (!text) {
    const main = document.querySelector('article, main, [role="main"]') || document.body;
    text = (main.innerText || "").trim();
  }
  return { title, text };
}

/* ---------- Backend ---------- */
const SUMMARY_RATIO = 0.30;

async function summarizeText(text) {
  const resp = await fetch("http://127.0.0.1:8000/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ratio: SUMMARY_RATIO })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Backend error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.summary || "";
}

/* ---------- UI ---------- */
function showOverlay(title, summary, isError = false) {
  const old = document.getElementById('__src_overlay__');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = '__src_overlay__';
  overlay.className = 'src-overlay';
  overlay.style.zIndex = "2147483647";

  const card = document.createElement('div');
  card.className = 'src-card';

  const header = document.createElement('div');
  header.className = 'src-card-header';
  header.innerHTML = `<div class="src-card-header-title">Summary — ${escapeHtml(title)}</div>`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'src-btn src-close';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => overlay.remove();

  const body = document.createElement('div');
  body.className = 'src-card-body';
  body.textContent = summary;

  const footer = document.createElement('div');
  footer.className = 'src-card-footer';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'src-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(String(summary));
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    } catch {
      alert('Copy failed. Please select and copy manually.');
    }
  };

  const okBtn = document.createElement('button');
  okBtn.className = 'src-btn primary';
  okBtn.textContent = 'Done';
  okBtn.onclick = () => overlay.remove();

  footer.append(copyBtn, okBtn);
  header.appendChild(closeBtn);
  card.append(header, body, footer);
  overlay.appendChild(card);
  document.body.appendChild(overlay);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/* ---------- Events ---------- */
async function onTldrClick() {
  const original = tldrBtn.textContent;
  tldrBtn.textContent = 'Summarizing…';
  tldrBtn.disabled = true;

  try {
    const { title, text } = extractSimple();
    if ((text || "").length < 80) throw new Error("Extracted text is too short to summarize.");
    const summary = await summarizeText(text);
    showOverlay(title, summary);
  } catch (err) {
    console.error('[SRC] Error:', err);
    showOverlay('Summary Error', String(err.message || err), true);
  } finally {
    tldrBtn.textContent = original;
    tldrBtn.disabled = false;
  }
}