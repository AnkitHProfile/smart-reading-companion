console.log("content.js loaded");

/* Optional Tailwind CDN (best effort) */
if (!document.getElementById('tailwind-cdn')) {
  try {
    const tailwind = document.createElement('link');
    tailwind.id = 'tailwind-cdn';
    tailwind.rel = 'stylesheet';
    tailwind.href = 'https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css';
    document.head.appendChild(tailwind);
  } catch (_) {}
}

const OVERLAY_ID = '__src_overlay__';
const HOST_ID = 'src-tldr-root';
let tldrHost = null;
let tldrButton = null;

/* ------- Readability extraction ------- */
async function extractArticleText() {
  await new Promise(r => setTimeout(r, 400));
  const clone = document.cloneNode(true);
  const article = new Readability(clone).parse();
  if (!article || !article.textContent) {
    throw new Error("Could not extract article content on this page.");
  }
  return { title: article.title || document.title, text: article.textContent.trim() };
}

/* ------- Backend call (now with 'level') ------- */
async function summarizeText(text, level = "detailed") {
  const resp = await fetch("http://127.0.0.1:8000/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, level })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Backend error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  if (!data.summary) throw new Error("Backend returned no summary field.");
  return data.summary;
}

/* ------- Overlay UI ------- */
function showOverlay(title, summaryOrError) {
  if (tldrHost) tldrHost.style.display = 'none';

  const old = document.getElementById(OVERLAY_ID);
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'src-overlay';

  const card = document.createElement('div');
  card.className = 'src-card';

  const header = document.createElement('div');
  header.className = 'src-card-header';
  header.innerHTML = `<div>Summary — ${escapeHtml(title)}</div>`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'src-btn';
  closeBtn.textContent = 'Close';
  closeBtn.onclick = () => {
    overlay.remove();
    if (tldrHost) tldrHost.style.display = '';
  };

  const body = document.createElement('div');
  body.className = 'src-card-body';
  body.textContent = summaryOrError; // pre-wrap in CSS keeps structure

  const footer = document.createElement('div');
  footer.className = 'src-card-footer';

  const copyBtn = document.createElement('button');
  copyBtn.className = 'src-btn';
  copyBtn.textContent = 'Copy';
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(summaryOrError);
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    } catch {
      alert('Copy failed. Please select and copy manually.');
    }
  };

  const okBtn = document.createElement('button');
  okBtn.className = 'src-btn primary';
  okBtn.textContent = 'Done';
  okBtn.onclick = () => {
    overlay.remove();
    if (tldrHost) tldrHost.style.display = '';
  };

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

/* ------- Shadow DOM floating button (with auto-relocate) ------- */
(function injectTldrButton() {
  if (document.getElementById(HOST_ID)) return;

  tldrHost = document.createElement('div');
  tldrHost.id = HOST_ID;
  tldrHost.style.position = 'fixed';
  tldrHost.style.right = '16px';
  tldrHost.style.bottom = '16px';
  tldrHost.style.zIndex = '2147483647';
  tldrHost.style.pointerEvents = 'none';
  tldrHost.style.isolation = 'isolate';
  document.documentElement.appendChild(tldrHost);

  const shadow = tldrHost.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .btn {
      all: initial; pointer-events: auto;
      display: inline-flex; align-items: center; justify-content: center;
      width: 64px; height: 64px; border-radius: 9999px;
      background: #6366f1; color: #fff; font-weight: 700;
      font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      box-shadow: 0 10px 25px rgba(0,0,0,.25);
      cursor: pointer; user-select: none; border: none; outline: none;
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .btn:hover { transform: translateY(-1px); box-shadow: 0 14px 28px rgba(0,0,0,.28); }
    .btn:active { transform: translateY(0); box-shadow: 0 8px 20px rgba(0,0,0,.22); }
    .label { font-size: 12px; letter-spacing: .5px; }
  `;
  shadow.appendChild(style);

  tldrButton = document.createElement('button');
  tldrButton.className = 'btn';
  tldrButton.setAttribute('aria-label', 'Summarize this page');
  tldrButton.innerHTML = `<span class="label">TL;DR</span>`;
  shadow.appendChild(tldrButton);

  tldrButton.addEventListener('click', async () => {
    const original = tldrButton.textContent;
    tldrButton.textContent = '…';
    tldrButton.disabled = true;
    try {
      const { title, text } = await extractArticleText();
      if (text.length < 80) throw new Error("Extracted text is too short to summarize.");
      // Ask the backend for the more detailed flavor
      const summary = await summarizeText(text, "detailed");
      showOverlay(title, summary);
    } catch (err) {
      console.error('[SRC] Error:', err);
      showOverlay('Summary Error', String(err.message || err));
    } finally {
      tldrButton.textContent = original;
      tldrButton.disabled = false;
    }
  });

  const corners = [
    { right: 16,  bottom: 16,  left: null, top: null },
    { left: 16,   bottom: 16,  right: null, top: null },
    { right: 16,  top: 16,     left: null, bottom: null },
    { left: 16,   top: 16,     right: null, bottom: null }
  ];
  function applyCorner(c) {
    tldrHost.style.right  = c.right  != null ? `${c.right}px`  : 'auto';
    tldrHost.style.left   = c.left   != null ? `${c.left}px`   : 'auto';
    tldrHost.style.bottom = c.bottom != null ? `${c.bottom}px` : 'auto';
    tldrHost.style.top    = c.top    != null ? `${c.top}px`    : 'auto';
  }
  function centerPoint(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function isClickable(hostEl) {
    const { x, y } = centerPoint(hostEl);
    const target = document.elementFromPoint(x, y);
    return target === hostEl || hostEl.contains(target);
  }
  function ensureVisible() {
    for (const c of corners) {
      applyCorner(c);
      if (isClickable(tldrHost)) return;
    }
    let offset = 100;
    for (let i = 0; i < 5; i++) {
      tldrHost.style.right = '16px';
      tldrHost.style.left = 'auto';
      tldrHost.style.bottom = `${16 + offset}px`;
      tldrHost.style.top = 'auto';
      if (isClickable(tldrHost)) return;
      offset += 100;
    }
  }
  ensureVisible();
  window.addEventListener('scroll', ensureVisible, { passive: true });
  window.addEventListener('resize', ensureVisible);
  const mo = new MutationObserver(() => ensureVisible());
  if (document.body) mo.observe(document.body, { childList: true, subtree: true, attributes: true });

  // Drag to reposition
  let dragging = false, sx = 0, sy = 0, startRight = 0, startBottom = 0;
  tldrButton.addEventListener('mousedown', (e) => {
    dragging = true; sx = e.clientX; sy = e.clientY;
    startRight = parseInt(tldrHost.style.right === 'auto' ? '16' : tldrHost.style.right);
    startBottom = parseInt(tldrHost.style.bottom === 'auto' ? '16' : tldrHost.style.bottom);
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', onUp, { once: true });
  });
  function onDrag(e) {
    if (!dragging) return;
    tldrHost.style.right = `${Math.max(0, startRight + (sx - e.clientX))}px`;
    tldrHost.style.bottom = `${Math.max(0, startBottom + (sy - e.clientY))}px`;
  }
  function onUp() {
    dragging = false;
    document.removeEventListener('mousemove', onDrag);
    ensureVisible();
  }
})();