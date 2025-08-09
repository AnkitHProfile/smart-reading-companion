console.log("content.js loaded");

/* Tailwind (best-effort) */
if (!document.getElementById('tailwind-cdn')) {
  const tailwind = document.createElement('link');
  tailwind.id = 'tailwind-cdn';
  tailwind.rel = 'stylesheet';
  tailwind.href = 'https://cdn.jsdelivr.net/npm/tailwindcss@2.2.19/dist/tailwind.min.css';
  document.head.appendChild(tailwind);
}

/* FAB */
let tldrBtn = document.getElementById('__src_tldr_btn__');
if (!tldrBtn) {
  tldrBtn = document.createElement('button');
  tldrBtn.id = '__src_tldr_btn__';
  tldrBtn.className = 'src-fab';
  tldrBtn.style.zIndex = '2147483647';
  tldrBtn.title = 'Summarize this article';
  tldrBtn.innerHTML = `<span class="dot" aria-hidden="true"></span> TL;DR`;
  document.body.appendChild(tldrBtn);
}

/* ---------------- helpers ---------------- */

function isNoiseParagraph(text) {
  const t = text.toLowerCase();
  return (
    t.includes("i am a bot") ||
    t.includes("performed automatically") ||
    t.includes("contact the moderators") ||
    t.includes("shortstories is a place for") ||
    (t.includes("rules") && t.includes("report") && t.includes("moderators"))
  );
}

function collectText(container) {
  if (!container) return "";
  const parts = [];
  container.querySelectorAll("p, li, h2, h3, h4, blockquote, pre").forEach(el => {
    const s = (el.innerText || "").trim();
    if (s && !isNoiseParagraph(s)) parts.push(s);
  });
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* Attempt to click `Read more / Show more` expanders */
function expandCollapsers() {
  const labels = [
    "read more","show more","continue reading","expand","see more",
    "read full","open full","load more"
  ];
  const nodes = Array.from(document.querySelectorAll("button, a, summary"));
  nodes.forEach(n => {
    const t = (n.innerText || n.getAttribute("aria-label") || "").trim().toLowerCase();
    if (t && labels.some(lbl => t.includes(lbl))) {
      try { n.click(); } catch(_) {}
    }
  });
}

/* Select the largest plausible text block on the page */
function largestTextBlock() {
  const candidates = new Set();

  // generic big containers
  [
    "article","main","[role='main']","#content",".content",".post",".entry",
    ".article",".story",".text",".chapter",".readable",".page-content",".rich-text"
  ].forEach(sel => document.querySelectorAll(sel).forEach(el => candidates.add(el)));

  // walk body children too (helps on story sites)
  Array.from(document.body.querySelectorAll("div, section")).forEach(el => {
    if (el.childElementCount >= 2) candidates.add(el);
  });

  let bestEl = null, bestLen = 0, bestText = "";
  candidates.forEach(el => {
    const t = collectText(el);
    const len = t.replace(/\s+/g," ").length;
    if (len > bestLen) { bestLen = len; bestText = t; bestEl = el; }
  });

  return { element: bestEl, text: bestText, length: bestLen };
}

/* Reddit extractor (kept) */
function extractReddit() {
  let title = document.querySelector('h1')?.innerText?.trim()
           || document.title.replace(/ : reddit.*$/i, "").trim();
  let text = "";

  const postContent = document.querySelector('[data-test-id="post-content"]')
                   || document.querySelector('[data-click-id="text"]');
  if (postContent) text = collectText(postContent);

  if (!text && customElements && document.querySelector("shreddit-post")) {
    try {
      const root = document.querySelector("shreddit-post")?.shadowRoot;
      const rich = root?.querySelector('[slot="text-body"], [data-click-id="text"]');
      if (rich) text = collectText(rich);
      if (!title) title = root?.querySelector("h1")?.innerText?.trim() || title;
    } catch {}
  }

  if (!text) {
    const md = document.querySelector(".usertext-body .md");
    if (md) text = collectText(md);
    if (!title) {
      const oldTitle = document.querySelector("a.title");
      if (oldTitle) title = oldTitle.innerText.trim();
    }
  }

  if (!text) {
    const main = document.querySelector('main, [role="main"]');
    text = collectText(main);
  }
  return { title: title || document.title, text };
}

/* Main extractor */
async function extractArticleText() {
  await new Promise(r => setTimeout(r, 300));
  expandCollapsers(); // try to open hidden content

  const host = location.hostname;
  let title = "";
  let text = "";

  // 1) Site-specific: Reddit
  if (host.endsWith("reddit.com")) {
    const r = extractReddit();
    title = r.title; text = r.text;
  }

  // 2) Largest-text-block heuristic (captures full stories on many sites)
  if (!text || text.replace(/\s+/g, " ").length < 800) {
    const { text: bigText } = largestTextBlock();
    if (bigText && bigText.length > (text?.length || 0)) text = bigText;
  }

  // 3) Readability fallback (sometimes still best)
  if (!text || text.replace(/\s+/g, " ").length < 400) {
    try {
      const clone = document.cloneNode(true);
      const article = new Readability(clone).parse();
      if (article?.textContent) {
        title = (article.title || title || document.title || "").trim();
        const t = (article.textContent || "").trim();
        if (t.length > text.length) text = t;
      }
    } catch {}
  }

  if (!title) title = document.title;
  if (!text) throw new Error("Could not extract article content on this page.");

  text = text.replace(/\u00A0/g, " ").replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text };
}

/* Backend call (request a 10% summary) */
async function summarizeText(text) {
  const resp = await fetch("http://127.0.0.1:8000/summarize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ratio: 0.10, level: "ratio" })
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Backend error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  if (!data.summary) throw new Error("Backend returned no summary field.");
  return data.summary;
}

/* Overlay UI */
function showOverlay(title, summary) {
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
  header.innerHTML = `<div>Summary — ${escapeHtml(title)}</div>`;

  const closeBtn = document.createElement('button');
  closeBtn.className = 'src-btn';
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
      await navigator.clipboard.writeText(summary);
      copyBtn.textContent = 'Copied';
      setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
    } catch { alert('Copy failed. Please select and copy manually.'); }
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

/* Click */
tldrBtn.onclick = async () => {
  const original = tldrBtn.textContent;
  tldrBtn.textContent = 'Summarizing…';
  tldrBtn.disabled = true;

  try {
    const { title, text } = await extractArticleText();
    if ((text || "").length < 80) throw new Error("Extracted text is too short to summarize.");
    const summary = await summarizeText(text);
    showOverlay(title, summary);
  } catch (err) {
    console.error('[SRC] Error:', err);
    showOverlay('Summary Error', String(err.message || err));
  } finally {
    tldrBtn.textContent = original;
    tldrBtn.disabled = false;
  }
};