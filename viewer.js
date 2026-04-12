// Shadowcore Studyink — Optimized PDF Viewer
// Virtual rendering with PDF.js — only visible pages rendered.
// 1-finger draw, 2-finger scroll on touch devices.

import * as pdfjsLib from './pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

// ── URL helpers ──────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
function safeDecode(v = '') { try { return decodeURIComponent(v); } catch { return v; } }
function resolveFileUrl(rawUrl, depth = 0) {
  if (!rawUrl || depth > 4) return rawUrl || '';
  const c = safeDecode(rawUrl.trim());
  try {
    const p = new URL(c);
    for (const k of ['pdf','url','file','src','document','download','attachment']) {
      const n = p.searchParams.get(k);
      if (n) return resolveFileUrl(n, depth + 1);
    }
  } catch { return c; }
  return c;
}
function getFileName(url) {
  if (!url) return 'Document';
  try { return safeDecode(new URL(url).pathname.split('/').pop() || 'Document'); }
  catch { return safeDecode(url.split('/').pop() || 'Document'); }
}

const rawFileUrl = params.get('url') || '';
const fileUrl    = resolveFileUrl(rawFileUrl);
const fileName   = getFileName(fileUrl);

// ── DOM ──────────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const scrollArea    = $('scroll-area');
const sidebar       = $('sidebar');
const statusOverlay = $('status-overlay');
const statusCard    = $('status-card');
const statusTitle   = $('status-title');
const statusDesc    = $('status-desc');
const loadProgress  = $('load-progress');
const drawCanvas    = $('draw-canvas');
const drawCtx       = drawCanvas.getContext('2d');

// ── State ────────────────────────────────────────────────────────────────────
let pdfDoc       = null;
let numPages     = 0;
let scale        = 1.2;
let currentPage  = 1;
let sidebarOpen  = true;
let scrollLock   = false;
const renderTasks  = new Map();
const pageCanvases = new Map();
const pageWrappers = new Map();
const thumbCanvases = new Map();

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// ── Status ───────────────────────────────────────────────────────────────────
function showStatus(title, desc, isError = false) {
  statusOverlay.classList.remove('hidden');
  statusCard.classList.toggle('error', isError);
  statusTitle.textContent = title;
  statusDesc.textContent = desc;
  $('status-spinner').style.display = isError ? 'none' : '';
}
function hideStatus() { statusOverlay.classList.add('hidden'); }

function setProgress(pct) {
  loadProgress.style.width = pct + '%';
  if (pct >= 100) setTimeout(() => { loadProgress.style.width = '0'; }, 700);
}

// ── Zoom ──────────────────────────────────────────────────────────────────────
function updateZoomLabel() {
  $('zoom-label').textContent = Math.round(scale * 100) + '%';
}

const ZOOM_STEPS = [0.3,0.5,0.67,0.75,0.9,1.0,1.1,1.25,1.5,1.75,2.0,2.5,3.0,4.0,5.0];

async function applyZoom(newScale) {
  scale = Math.max(0.3, Math.min(5, newScale));
  updateZoomLabel();
  for (const [, task] of renderTasks) { try { task.cancel(); } catch {} }
  renderTasks.clear();
  pageCanvases.clear();
  visiblePages.clear();
  await buildPageList();
  buildSidebar();
  setupObserver();
}

async function fitToWidth() {
  const page = await pdfDoc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  page.cleanup();
  applyZoom((scrollArea.clientWidth - 48) / vp.width);
}

// ── Build page list ───────────────────────────────────────────────────────────
async function buildPageList() {
  scrollArea.innerHTML = '';
  pageCanvases.clear();
  pageWrappers.clear();

  const fp = await pdfDoc.getPage(1);
  const vp0 = fp.getViewport({ scale });
  fp.cleanup();

  for (let i = 1; i <= numPages; i++) {
    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.dataset.page = i;
    wrapper.style.width  = vp0.width  + 'px';
    wrapper.style.height = vp0.height + 'px';

    const ph = document.createElement('div');
    ph.className = 'page-ph';
    ph.style.width  = vp0.width  + 'px';
    ph.style.height = vp0.height + 'px';
    wrapper.appendChild(ph);

    scrollArea.appendChild(wrapper);
    pageWrappers.set(i, wrapper);
  }
}

// ── Virtual rendering ─────────────────────────────────────────────────────────
let observer = null;
const visiblePages = new Set();

function setupObserver() {
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(onPageVisibility, {
    root: scrollArea,
    rootMargin: '400px 0px',
    threshold: 0.01,
  });
  for (const [, wrapper] of pageWrappers) observer.observe(wrapper);
}

function onPageVisibility(entries) {
  for (const entry of entries) {
    const page = Number(entry.target.dataset.page);
    if (entry.isIntersecting) {
      visiblePages.add(page);
      renderPage(page);
      if (page > 1) renderPage(page - 1);
      if (page < numPages) renderPage(page + 1);
    } else {
      visiblePages.delete(page);
      const minV = visiblePages.size ? Math.min(...visiblePages) : page;
      const maxV = visiblePages.size ? Math.max(...visiblePages) : page;
      if (page < minV - 3 || page > maxV + 3) {
        cancelRender(page);
        unloadPage(page);
      }
    }
  }
}

function cancelRender(n) {
  const t = renderTasks.get(n);
  if (t) { try { t.cancel(); } catch {} renderTasks.delete(n); }
}

function unloadPage(n) {
  const wrapper = pageWrappers.get(n);
  if (!wrapper) return;
  const canvas = pageCanvases.get(n);
  if (canvas) { canvas.remove(); pageCanvases.delete(n); }
  if (!wrapper.querySelector('.page-ph')) {
    const ph = document.createElement('div');
    ph.className = 'page-ph';
    ph.style.width  = wrapper.style.width;
    ph.style.height = wrapper.style.height;
    wrapper.appendChild(ph);
  }
}

async function renderPage(n) {
  if (renderTasks.has(n) || pageCanvases.has(n)) return;
  if (!pdfDoc) return;
  try {
    const page = await pdfDoc.getPage(n);
    const viewport = page.getViewport({ scale });
    const wrapper = pageWrappers.get(n);
    if (!wrapper) { page.cleanup(); return; }

    wrapper.style.width  = viewport.width  + 'px';
    wrapper.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.className = 'page-canvas';
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = viewport.width  * dpr;
    canvas.height = viewport.height * dpr;
    canvas.style.width  = viewport.width  + 'px';
    canvas.style.height = viewport.height + 'px';
    canvas.style.opacity = '0';

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    pageCanvases.set(n, canvas);
    wrapper.innerHTML = '';
    wrapper.appendChild(canvas);

    const task = page.render({ canvasContext: ctx, viewport });
    renderTasks.set(n, task);
    await task.promise;
    renderTasks.delete(n);

    canvas.style.transition = 'opacity .15s';
    requestAnimationFrame(() => { canvas.style.opacity = '1'; });

    page.cleanup();
    if (sidebarOpen) renderThumb(n);
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.warn('[SC] Page', n, err);
    renderTasks.delete(n);
  }
}

// ── Thumbnails ────────────────────────────────────────────────────────────────
async function renderThumb(n) {
  if (thumbCanvases.has(n)) return;
  const item = sidebar.querySelector(`[data-page="${n}"]`);
  if (!item) return;
  const ph = item.querySelector('.thumb-ph');
  if (!ph) return;
  try {
    const page = await pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: 0.17 });
    const canvas = document.createElement('canvas');
    canvas.className = 'thumb-canvas';
    canvas.width  = vp.width;
    canvas.height = vp.height;
    canvas.style.width  = Math.round(vp.width)  + 'px';
    canvas.style.height = Math.round(vp.height) + 'px';
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    thumbCanvases.set(n, canvas);
    ph.replaceWith(canvas);
    page.cleanup();
  } catch {}
}

function buildSidebar() {
  sidebar.innerHTML = '';
  thumbCanvases.clear();
  for (let i = 1; i <= numPages; i++) {
    const item = document.createElement('div');
    item.className = 'thumb-item' + (i === 1 ? ' active' : '');
    item.dataset.page = i;

    const ph = document.createElement('div');
    ph.className = 'thumb-ph';
    ph.style.cssText = 'width:90px;height:125px';

    const num = document.createElement('div');
    num.className = 'thumb-num';
    num.textContent = i;

    item.appendChild(ph);
    item.appendChild(num);
    item.addEventListener('click', () => scrollToPage(i));
    sidebar.appendChild(item);
  }

  const obs = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) renderThumb(Number(e.target.dataset.page));
  }, { root: sidebar, rootMargin: '200px 0px', threshold: 0.01 });
  sidebar.querySelectorAll('.thumb-item').forEach(el => obs.observe(el));
}

function setActiveThumb(n) {
  sidebar.querySelectorAll('.thumb-item').forEach(el =>
    el.classList.toggle('active', Number(el.dataset.page) === n)
  );
  sidebar.querySelector(`[data-page="${n}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Scroll tracking ───────────────────────────────────────────────────────────
function trackCurrentPage() {
  if (scrollLock) return;
  const areaTop = scrollArea.getBoundingClientRect().top;
  let closest = 1, closestDist = Infinity;
  for (const [page, wrapper] of pageWrappers) {
    const dist = Math.abs(wrapper.getBoundingClientRect().top - areaTop);
    if (dist < closestDist) { closestDist = dist; closest = page; }
  }
  if (closest !== currentPage) {
    currentPage = closest;
    $('page-input').value = currentPage;
    setActiveThumb(currentPage);
  }
}

function scrollToPage(page) {
  const wrapper = pageWrappers.get(page);
  if (!wrapper) return;
  scrollLock = true;
  currentPage = page;
  $('page-input').value = page;
  setActiveThumb(page);
  wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => { scrollLock = false; }, 900);
}

// ── Load PDF ──────────────────────────────────────────────────────────────────
async function loadPdf() {
  showStatus('Fetching PDF…', 'Shadowcore is loading your document directly — no external viewer needed.');
  setProgress(10);
  let arrayBuffer;
  try {
    const resp = await fetch(fileUrl, { credentials: 'include', cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    arrayBuffer = await resp.arrayBuffer();
    const sig = new Uint8Array(arrayBuffer.slice(0, 4));
    const ok = sig[0]===0x25&&sig[1]===0x50&&sig[2]===0x44&&sig[3]===0x46;
    const ct = resp.headers.get('content-type') || '';
    if (!ok && !/application\/pdf/i.test(ct)) throw new Error('Server returned a protected page instead of a PDF.');
  } catch (err) {
    showStatus('Could not fetch PDF', err.message, true);
    return;
  }
  setProgress(40);
  showStatus('Rendering…', 'Setting up the optimized canvas renderer.');
  try {
    const task = pdfjsLib.getDocument({ data: arrayBuffer });
    task.onProgress = ({ loaded, total }) => { if (total) setProgress(40 + (loaded/total)*30); };
    pdfDoc = await task.promise;
    numPages = pdfDoc.numPages;
    setProgress(80);
  } catch (err) {
    showStatus('Render error', err.message, true);
    return;
  }

  const fp = await pdfDoc.getPage(1);
  const vp0 = fp.getViewport({ scale: 1 });
  fp.cleanup();
  scale = Math.max(0.5, Math.min(3, (scrollArea.clientWidth - 48) / vp0.width));
  updateZoomLabel();

  $('page-input').value = 1;
  $('page-total').textContent = '/ ' + numPages;
  $('info-name').textContent = fileName;
  $('info-pages').textContent = numPages;
  $('info-url').textContent = fileUrl;
  document.title = 'Shadowcore — ' + fileName;

  await buildPageList();
  buildSidebar();
  setupObserver();
  setProgress(100);
  hideStatus();
  scrollArea.addEventListener('scroll', trackCurrentPage, { passive: true });
}

// ── Controls ──────────────────────────────────────────────────────────────────
$('btn-prev').onclick = () => scrollToPage(Math.max(1, currentPage - 1));
$('btn-next').onclick = () => scrollToPage(Math.min(numPages, currentPage + 1));
$('page-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const p = parseInt($('page-input').value, 10);
    if (p >= 1 && p <= numPages) scrollToPage(p);
    $('page-input').blur();
  }
});

$('btn-zoomin').onclick  = () => { const n = ZOOM_STEPS.find(z => z > scale + 0.01); applyZoom(n ?? scale * 1.2); };
$('btn-zoomout').onclick = () => { const n = [...ZOOM_STEPS].reverse().find(z => z < scale - 0.01); applyZoom(n ?? scale * 0.8); };
$('btn-fit').onclick = fitToWidth;

scrollArea.addEventListener('wheel', e => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); applyZoom(scale * (e.deltaY < 0 ? 1.1 : 0.9)); }
}, { passive: false });

document.addEventListener('keydown', e => {
  if (!pdfDoc) return;
  const isInput = document.activeElement?.tagName === 'INPUT';
  if (isInput && !(e.ctrlKey || e.metaKey)) return;
  if (e.key==='ArrowRight'||e.key==='ArrowDown'||e.key==='PageDown') { e.preventDefault(); scrollToPage(Math.min(numPages, currentPage+1)); }
  else if (e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp') { e.preventDefault(); scrollToPage(Math.max(1, currentPage-1)); }
  else if (e.key==='Home') { e.preventDefault(); scrollToPage(1); }
  else if (e.key==='End')  { e.preventDefault(); scrollToPage(numPages); }
  else if ((e.ctrlKey||e.metaKey)&&(e.key==='='||e.key==='+')) { e.preventDefault(); $('btn-zoomin').click(); }
  else if ((e.ctrlKey||e.metaKey)&&e.key==='-')  { e.preventDefault(); $('btn-zoomout').click(); }
  else if ((e.ctrlKey||e.metaKey)&&e.key==='0')  { e.preventDefault(); fitToWidth(); }
  else if (!isInput&&e.key==='f') $('btn-fullscreen').click();
});

$('btn-fullscreen').onclick = () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  else document.exitFullscreen();
};
$('btn-sidebar').onclick = () => {
  sidebarOpen = !sidebarOpen;
  sidebar.classList.toggle('hidden', !sidebarOpen);
  $('btn-sidebar').classList.toggle('active', sidebarOpen);
};
$('btn-open-original').onclick = () => window.open(fileUrl, '_blank', 'noopener');
$('btn-retry').onclick = loadPdf;

$('btn-download').onclick = async () => {
  try {
    const resp = await fetch(fileUrl, { credentials: 'include' });
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
    toast('Download started!');
  } catch { window.open(fileUrl, '_blank', 'noopener'); }
};

$('btn-info').onclick = () => { $('panel-info').classList.toggle('open'); $('panel-draw').classList.remove('open'); };
$('close-info').onclick = () => $('panel-info').classList.remove('open');

// ── Drawing — 1 finger draw, 2 finger scroll ─────────────────────────────────
let drawMode  = null;
let drawColor = '#ef4444';
let drawSize  = 3;
let drawOpacity = 1;
let isEraser  = false;
let brushType = 'pen';

// Sync draw canvas to scroll area dimensions
function syncDrawCanvas() {
  const area = scrollArea;
  drawCanvas.width  = area.scrollWidth;
  drawCanvas.height = area.scrollHeight;
  drawCanvas.style.width  = area.scrollWidth  + 'px';
  drawCanvas.style.height = area.scrollHeight + 'px';
  // Position absolutely inside viewer-main, offset by scroll
  drawCanvas.style.position = 'absolute';
  drawCanvas.style.top = '52px'; // below toolbar
  drawCanvas.style.left = sidebarOpen ? '130px' : '0';
}

function enableDraw(mode) {
  drawMode = mode;
  isEraser = mode === 'eraser';
  syncDrawCanvas();
  drawCanvas.classList.add('active');
  ['btn-draw','btn-highlight','btn-eraser'].forEach(id => $(id)?.classList.remove('active'));
  if (mode==='draw')      { $('btn-draw').classList.add('active'); $('panel-draw').classList.add('open'); }
  if (mode==='highlight') { $('btn-highlight').classList.add('active'); $('panel-draw').classList.add('open'); drawOpacity=0.3; drawSize=18; }
  if (mode==='eraser')    { $('btn-eraser').classList.add('active'); }
}

function disableDraw() {
  drawMode = null;
  drawCanvas.classList.remove('active');
  ['btn-draw','btn-highlight','btn-eraser'].forEach(id => $(id)?.classList.remove('active'));
  $('panel-draw').classList.remove('open');
}

$('btn-draw').onclick     = () => drawMode==='draw'      ? disableDraw() : (drawOpacity=1, drawSize=3, enableDraw('draw'));
$('btn-highlight').onclick = () => drawMode==='highlight' ? disableDraw() : enableDraw('highlight');
$('btn-eraser').onclick   = () => drawMode==='eraser'    ? disableDraw() : enableDraw('eraser');
$('btn-clear').onclick    = () => { drawCtx.clearRect(0,0,drawCanvas.width,drawCanvas.height); toast('Canvas cleared'); };
$('close-draw').onclick   = disableDraw;

$('brush-size').oninput    = e => { drawSize = +e.target.value; $('size-val').textContent = drawSize; };
$('brush-opacity').oninput = e => { drawOpacity = +e.target.value / 100; $('opacity-val').textContent = e.target.value; };

document.querySelectorAll('.color-swatch').forEach(s => {
  s.onclick = () => { document.querySelectorAll('.color-swatch').forEach(x=>x.classList.remove('active')); s.classList.add('active'); drawColor=s.dataset.color; };
});
document.querySelectorAll('.brush-btn').forEach(b => {
  b.onclick = () => { document.querySelectorAll('.brush-btn').forEach(x=>x.classList.remove('active')); b.classList.add('active'); brushType=b.dataset.brush; };
});

// Apply brush style based on type
function applyBrushStyle() {
  drawCtx.lineJoin = 'round';
  switch (brushType) {
    case 'pen':
      drawCtx.lineCap = 'round';
      drawCtx.setLineDash([]);
      break;
    case 'marker':
      drawCtx.lineCap = 'square';
      drawCtx.setLineDash([]);
      break;
    case 'pencil':
      drawCtx.lineCap = 'round';
      drawCtx.setLineDash([2, 1]);
      break;
    case 'calligraphy':
      drawCtx.lineCap = 'butt';
      drawCtx.setLineDash([]);
      break;
  }
}

// ── Mouse drawing ─────────────────────────────────────────────────────────────
let isDrawingMouse = false;

function getScrollOffset() {
  return { x: scrollArea.scrollLeft, y: scrollArea.scrollTop };
}

drawCanvas.addEventListener('mousedown', e => {
  if (!drawMode) return;
  isDrawingMouse = true;
  const { x, y } = getScrollOffset();
  drawCtx.beginPath();
  drawCtx.moveTo(e.clientX - drawCanvas.getBoundingClientRect().left + x, e.clientY - drawCanvas.getBoundingClientRect().top + y);
});

drawCanvas.addEventListener('mousemove', e => {
  if (!isDrawingMouse || !drawMode) return;
  const rect = drawCanvas.getBoundingClientRect();
  const { x, y } = getScrollOffset();
  const cx = e.clientX - rect.left + x;
  const cy = e.clientY - rect.top  + y;
  drawCtx.lineWidth = isEraser ? drawSize * 4 : drawSize;
  applyBrushStyle();
  if (isEraser) {
    drawCtx.globalCompositeOperation = 'destination-out';
    drawCtx.strokeStyle = 'rgba(0,0,0,1)';
    drawCtx.globalAlpha = 1;
  } else {
    drawCtx.globalCompositeOperation = 'source-over';
    drawCtx.strokeStyle = drawColor;
    drawCtx.globalAlpha = drawOpacity;
  }
  drawCtx.lineTo(cx, cy);
  drawCtx.stroke();
});

['mouseup','mouseleave'].forEach(ev => drawCanvas.addEventListener(ev, () => {
  isDrawingMouse = false;
  drawCtx.globalAlpha = 1;
  drawCtx.globalCompositeOperation = 'source-over';
  drawCtx.setLineDash([]);
}));

// ── Touch: 1 finger = draw, 2 fingers = scroll ───────────────────────────────
let touchDrawing = false;
let lastTouchDist = 0;

drawCanvas.addEventListener('touchstart', e => {
  if (e.touches.length === 1 && drawMode) {
    // 1 finger — draw
    e.preventDefault();
    touchDrawing = true;
    const rect = drawCanvas.getBoundingClientRect();
    const { x, y } = getScrollOffset();
    const t = e.touches[0];
    drawCtx.beginPath();
    drawCtx.moveTo(t.clientX - rect.left + x, t.clientY - rect.top + y);
  } else if (e.touches.length === 2) {
    // 2 fingers — scroll / pinch zoom
    e.preventDefault();
    touchDrawing = false;
    lastTouchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, { passive: false });

drawCanvas.addEventListener('touchmove', e => {
  if (e.touches.length === 1 && touchDrawing && drawMode) {
    e.preventDefault();
    const rect = drawCanvas.getBoundingClientRect();
    const { x, y } = getScrollOffset();
    const t = e.touches[0];
    const cx = t.clientX - rect.left + x;
    const cy = t.clientY - rect.top  + y;
    drawCtx.lineWidth = isEraser ? drawSize * 4 : drawSize;
    applyBrushStyle();
    if (isEraser) {
      drawCtx.globalCompositeOperation = 'destination-out';
      drawCtx.strokeStyle = 'rgba(0,0,0,1)';
      drawCtx.globalAlpha = 1;
    } else {
      drawCtx.globalCompositeOperation = 'source-over';
      drawCtx.strokeStyle = drawColor;
      drawCtx.globalAlpha = drawOpacity;
    }
    drawCtx.lineTo(cx, cy);
    drawCtx.stroke();
  } else if (e.touches.length === 2) {
    e.preventDefault();
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (lastTouchDist > 0) {
      const delta = dist / lastTouchDist;
      if (Math.abs(delta - 1) > 0.01) applyZoom(scale * delta);
    }
    lastTouchDist = dist;
  }
}, { passive: false });

// Scroll with 2 fingers on scroll area (when draw not active)
scrollArea.addEventListener('touchstart', e => {
  if (e.touches.length === 2) {
    lastTouchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  }
}, { passive: true });

scrollArea.addEventListener('touchmove', e => {
  if (e.touches.length === 2) {
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    if (lastTouchDist > 0) {
      const delta = dist / lastTouchDist;
      if (Math.abs(delta - 1) > 0.01) applyZoom(scale * delta);
    }
    lastTouchDist = dist;
  }
}, { passive: true });

['touchend','touchcancel'].forEach(ev => drawCanvas.addEventListener(ev, () => {
  touchDrawing = false;
  drawCtx.globalAlpha = 1;
  drawCtx.globalCompositeOperation = 'source-over';
  drawCtx.setLineDash([]);
}));

window.addEventListener('resize', () => { if (drawMode) syncDrawCanvas(); });

// ── Start ─────────────────────────────────────────────────────────────────────
loadPdf();
