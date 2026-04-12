// Shadowcore Studyink — Handwritten Notes Generator
// Generates realistic handwritten note images from study content using AI.

const SUPABASE_URL = 'https://tdupyzkkiewllidhmsae.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRkdXB5emtraWV3bGxpZGhtc2FlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5ODE2MDgsImV4cCI6MjA5MTU1NzYwOH0.nflOHExe1Srwk7Id_FNPbgPh77RMdido42zv42cJm3w';
const CHARS_PER_PAGE = 700;

// DOM refs
const $ = id => document.getElementById(id);
const notesInput     = $('notes-input');
const charCount      = $('char-count');
const genBtn         = $('gen-btn');
const detectBtn      = $('detect-btn');
const inputSection   = $('input-section');
const progressSection = $('progress-section');
const errorSection   = $('error-section');
const notesSection   = $('notes-section');
const progTitle      = $('prog-title');
const progDesc       = $('prog-desc');
const progFill       = $('prog-fill');

let pages = [];
let currentPage = 0;
let lastText = '';
let lastStyle = 'neat';
let lastPaper = 'lined';

// ── Text input ────────────────────────────────────────────────────────────────
notesInput.addEventListener('input', () => {
  const len = Math.min(notesInput.value.length, 5000);
  notesInput.value = notesInput.value.substring(0, 5000);
  charCount.textContent = `${len} / 5000`;
  genBtn.disabled = len < 10;
});

$('style-select').addEventListener('change', e => { lastStyle = e.target.value; });
$('paper-select').addEventListener('change', e => { lastPaper = e.target.value; });

// ── Detect from page ─────────────────────────────────────────────────────────
detectBtn.addEventListener('click', () => {
  detectBtn.textContent = 'Detecting…';
  detectBtn.disabled = true;

  if (typeof chrome !== 'undefined' && chrome.tabs) {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs[0]) { detectBtn.textContent = '✗ No active tab'; detectBtn.disabled = false; return; }
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: () => {
          // Try selected text first
          const sel = window.getSelection()?.toString().trim();
          if (sel && sel.length > 20) return sel;
          // Try learning platform content areas
          const selectors = [
            '.notes-content', '.lesson-content', '.entry-content',
            '.post-content', '.article-content', '.chapter-content',
            'article', 'main', '[role="main"]',
            '.content-body', '.page-content', '.study-material',
            '#content', '.markdown-body', '.prose'
          ];
          for (const s of selectors) {
            const el = document.querySelector(s);
            if (el && el.innerText.trim().length > 50) return el.innerText.trim();
          }
          // Fallback: headings + paragraphs
          const els = [...document.querySelectorAll('h1,h2,h3,h4,p,li,td')];
          return els.map(e => e.innerText.trim()).filter(Boolean).join('\n').substring(0, 5000);
        }
      }, results => {
        detectBtn.textContent = 'Detect from Page';
        detectBtn.disabled = false;
        if (chrome.runtime.lastError || !results?.[0]) {
          showError('Could not access the page. Try selecting text manually first.');
          return;
        }
        const text = (results[0].result || '').substring(0, 5000).trim();
        if (text.length < 20) {
          showTempMsg(detectBtn, '⚠ No content found', 2000);
          return;
        }
        notesInput.value = text;
        charCount.textContent = `${text.length} / 5000`;
        genBtn.disabled = false;
        showTempMsg(detectBtn, `✓ Detected ${text.length} chars`, 2000);
      });
    });
  } else {
    // Check storage (opened from popup)
    chrome.storage?.local.get('ntkNotesText', data => {
      detectBtn.textContent = 'Detect from Page';
      detectBtn.disabled = false;
      if (data?.ntkNotesText?.trim()?.length > 10) {
        notesInput.value = data.ntkNotesText.substring(0, 5000);
        charCount.textContent = `${notesInput.value.length} / 5000`;
        genBtn.disabled = false;
        chrome.storage.local.remove('ntkNotesText');
        showTempMsg(detectBtn, `✓ Loaded ${notesInput.value.length} chars`, 2000);
      } else {
        showTempMsg(detectBtn, '⚠ Nothing detected', 2000);
      }
    });
  }
});

function showTempMsg(el, msg, ms) {
  const orig = el.textContent;
  el.textContent = msg;
  el.disabled = true;
  setTimeout(() => { el.textContent = orig; el.disabled = false; }, ms);
}

// ── Generate ──────────────────────────────────────────────────────────────────
genBtn.addEventListener('click', () => {
  const text = notesInput.value.trim();
  if (text.length < 10) return;
  lastText  = text;
  lastStyle = $('style-select').value;
  lastPaper = $('paper-select').value;
  generateNotes(text, lastStyle, lastPaper);
});

function chunkText(text, chunkSize = CHARS_PER_PAGE) {
  const words = text.split(/\s+/);
  const chunks = [];
  let chunk = '';
  for (const w of words) {
    if (chunk && (chunk + ' ' + w).length > chunkSize) {
      chunks.push(chunk.trim());
      chunk = w;
    } else {
      chunk += (chunk ? ' ' : '') + w;
    }
  }
  if (chunk.trim()) chunks.push(chunk.trim());
  return chunks;
}

async function generateNotes(text, style, paper) {
  inputSection.style.display = 'none';
  notesSection.classList.remove('show');
  errorSection.classList.remove('show');
  progressSection.classList.add('show');

  const chunks = chunkText(text);
  pages = [];

  for (let i = 0; i < chunks.length; i++) {
    progTitle.textContent = `Writing page ${i + 1} of ${chunks.length}…`;
    progDesc.textContent  = `AI is converting your notes to handwriting. Style: ${style}, Paper: ${paper}.`;
    progFill.style.width  = `${(i / chunks.length) * 100}%`;

    try {
      const imageUrl = await generatePageImage(chunks[i], i, chunks.length, style, paper);
      pages.push(imageUrl);
    } catch (err) {
      progressSection.classList.remove('show');
      showError(`Page ${i + 1} failed: ${err.message}`);
      return;
    }
  }

  progFill.style.width = '100%';
  progressSection.classList.remove('show');

  if (pages.length > 0) {
    buildNotesUI();
    $('download-all').style.display = '';
  }
}

async function generatePageImage(text, pageIdx, totalPages, style, paper) {
  const styleMap = {
    neat:      'neat, clean, well-organized handwriting',
    casual:    'casual, relaxed everyday handwriting with natural imperfections',
    student:   'typical student handwriting with underlining and arrows',
    cursive:   'flowing cursive handwriting script',
    technical: 'technical printed handwriting with diagrams and bullet points',
  };
  const paperMap = {
    lined:  'blue-lined notebook paper, white background',
    plain:  'plain white paper',
    grid:   'graph paper with light grid lines',
    yellow: 'yellow legal notepad paper with lines',
  };

  const prompt = `Realistic photograph of handwritten study notes on ${paperMap[paper] || 'lined paper'}. 
The notes contain this text: "${text.substring(0, 400)}".
Writing style: ${styleMap[style] || 'neat handwriting'}.
The handwriting is ${style === 'cursive' ? 'flowing cursive' : 'printed'}, dark blue or black ink pen.
Notes include key terms underlined, important points starred or circled.
Realistic paper texture, natural lighting, slightly angled photo. No computer text, only handwriting.`;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-notes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify({
      text,
      pageIndex: pageIdx,
      totalPages,
      style,
      paper,
      prompt,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error);
  if (!data.imageUrl) throw new Error('No image returned from AI');
  return data.imageUrl;
}

// ── Notes UI ──────────────────────────────────────────────────────────────────
function buildNotesUI() {
  notesSection.classList.add('show');
  currentPage = 0;
  showPage(0);
  buildThumbs();
}

function showPage(idx) {
  currentPage = idx;
  const imgWrap = $('img-wrap');
  imgWrap.innerHTML = '<div class="img-loading">Loading…</div>';
  const img = document.createElement('img');
  img.onload  = () => { imgWrap.innerHTML = ''; imgWrap.appendChild(img); };
  img.onerror = () => { imgWrap.innerHTML = '<div class="img-loading" style="color:#ef4444">Failed to load image</div>'; };
  img.src = pages[idx];
  img.alt = `Handwritten notes page ${idx + 1}`;
  $('page-ind').textContent = `${idx + 1} / ${pages.length}`;
  $('page-lbl').textContent = `Page ${idx + 1}`;
  $('prev-btn').disabled = idx === 0;
  $('next-btn').disabled = idx >= pages.length - 1;
  $('thumbs').querySelectorAll('.thumb-btn').forEach((b, i) => b.classList.toggle('active', i === idx));
}

function buildThumbs() {
  const thumbs = $('thumbs');
  thumbs.innerHTML = pages.map((p, i) =>
    `<button class="thumb-btn ${i === 0 ? 'active' : ''}"><img src="${p}" alt="Page ${i+1}" loading="lazy"></button>`
  ).join('');
  thumbs.querySelectorAll('.thumb-btn').forEach((b, i) => b.addEventListener('click', () => showPage(i)));
}

$('prev-btn')?.addEventListener('click', () => showPage(Math.max(0, currentPage - 1)));
$('next-btn')?.addEventListener('click', () => showPage(Math.min(pages.length - 1, currentPage + 1)));

$('dl-page')?.addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = pages[currentPage];
  a.download = `shadowcore-notes-page-${currentPage + 1}.png`;
  a.click();
});

$('download-all')?.addEventListener('click', () => {
  pages.forEach((p, i) => {
    const a = document.createElement('a');
    a.href = p;
    a.download = `shadowcore-notes-page-${i + 1}.png`;
    a.click();
  });
});

// ── Error ─────────────────────────────────────────────────────────────────────
function showError(msg) {
  errorSection.classList.add('show');
  $('error-msg').textContent = msg;
}

$('retry-btn')?.addEventListener('click', () => {
  errorSection.classList.remove('show');
  if (lastText) generateNotes(lastText, lastStyle, lastPaper);
  else { inputSection.style.display = ''; }
});

// ── Auto-load from storage if opened from popup ───────────────────────────────
if (typeof chrome !== 'undefined' && chrome.storage) {
  chrome.storage.local.get('ntkNotesText', data => {
    if (data?.ntkNotesText?.trim()?.length > 10) {
      chrome.storage.local.remove('ntkNotesText');
      notesInput.value = data.ntkNotesText.substring(0, 5000);
      charCount.textContent = `${notesInput.value.length} / 5000`;
      genBtn.disabled = false;
    }
  });
}
