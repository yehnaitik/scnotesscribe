// Shadowcore Studyink — Optimized PDF Viewer + AI Chat
// Virtual rendering · 1-finger draw · 2-finger scroll · Ask AI with crop

import * as pdfjsLib from './pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

// ── URL helpers ──────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
function safeDecode(v=''){try{return decodeURIComponent(v)}catch{return v}}
function resolveFileUrl(u,d=0){
  if(!u||d>4)return u||'';
  const c=safeDecode(u.trim());
  try{const p=new URL(c);for(const k of['pdf','url','file','src','document','download','attachment']){const n=p.searchParams.get(k);if(n)return resolveFileUrl(n,d+1)}}catch{return c}
  return c;
}
function getFileName(url){
  if(!url)return'Document';
  try{return safeDecode(new URL(url).pathname.split('/').pop()||'Document')}
  catch{return safeDecode(url.split('/').pop()||'Document')}
}

const rawFileUrl = params.get('url')||'';
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
const aiPanel       = $('ai-panel');
const aiMessages    = $('ai-messages');
const aiInput       = $('ai-input');
const aiSend        = $('ai-send');
const aiResizer     = $('ai-resizer');
const cropRect      = $('crop-rect');
const cropBanner    = $('crop-banner');

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
const thumbCanvases= new Map();

// ── Toast ────────────────────────────────────────────────────────────────────
function toast(msg){
  const t=$('toast');t.textContent=msg;t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2200);
}

// ── Status ───────────────────────────────────────────────────────────────────
function showStatus(title,desc,isError=false){
  statusOverlay.classList.remove('hidden');statusCard.classList.toggle('error',isError);
  statusTitle.textContent=title;statusDesc.textContent=desc;
  $('status-spinner').style.display=isError?'none':'';
}
function hideStatus(){statusOverlay.classList.add('hidden');}
function setProgress(pct){
  loadProgress.style.width=pct+'%';
  if(pct>=100)setTimeout(()=>{loadProgress.style.width='0';},700);
}

// ── Zoom ──────────────────────────────────────────────────────────────────────
function updateZoomLabel(){$('zoom-label').textContent=Math.round(scale*100)+'%';}
const ZOOM_STEPS=[0.3,0.5,0.67,0.75,0.9,1.0,1.1,1.25,1.5,1.75,2.0,2.5,3.0,4.0,5.0];

async function applyZoom(newScale){
  scale=Math.max(0.3,Math.min(5,newScale));updateZoomLabel();
  for(const[,task]of renderTasks){try{task.cancel()}catch{}}
  renderTasks.clear();pageCanvases.clear();visiblePages.clear();
  await buildPageList();buildSidebar();setupObserver();
}

async function fitToWidth(){
  const page=await pdfDoc.getPage(1);const vp=page.getViewport({scale:1});
  page.cleanup();applyZoom((scrollArea.clientWidth-48)/vp.width);
}

// ── Build page list ───────────────────────────────────────────────────────────
async function buildPageList(){
  scrollArea.innerHTML='';pageCanvases.clear();pageWrappers.clear();
  const fp=await pdfDoc.getPage(1);const vp0=fp.getViewport({scale});fp.cleanup();
  for(let i=1;i<=numPages;i++){
    const w=document.createElement('div');
    w.className='page-wrapper';w.dataset.page=i;
    w.style.width=vp0.width+'px';w.style.height=vp0.height+'px';
    const ph=document.createElement('div');ph.className='page-ph';
    ph.style.width=vp0.width+'px';ph.style.height=vp0.height+'px';
    w.appendChild(ph);scrollArea.appendChild(w);pageWrappers.set(i,w);
  }
}

// ── Virtual rendering ─────────────────────────────────────────────────────────
let observer=null;
const visiblePages=new Set();

function setupObserver(){
  if(observer)observer.disconnect();
  observer=new IntersectionObserver(onPageVisibility,{root:scrollArea,rootMargin:'400px 0px',threshold:0.01});
  for(const[,w]of pageWrappers)observer.observe(w);
}

function onPageVisibility(entries){
  for(const entry of entries){
    const page=Number(entry.target.dataset.page);
    if(entry.isIntersecting){
      visiblePages.add(page);renderPage(page);
      if(page>1)renderPage(page-1);if(page<numPages)renderPage(page+1);
    }else{
      visiblePages.delete(page);
      const minV=visiblePages.size?Math.min(...visiblePages):page;
      const maxV=visiblePages.size?Math.max(...visiblePages):page;
      if(page<minV-3||page>maxV+3){cancelRender(page);unloadPage(page);}
    }
  }
}

function cancelRender(n){const t=renderTasks.get(n);if(t){try{t.cancel()}catch{}renderTasks.delete(n);}}

function unloadPage(n){
  const w=pageWrappers.get(n);if(!w)return;
  const c=pageCanvases.get(n);if(c){c.remove();pageCanvases.delete(n);}
  if(!w.querySelector('.page-ph')){
    const ph=document.createElement('div');ph.className='page-ph';
    ph.style.width=w.style.width;ph.style.height=w.style.height;w.appendChild(ph);
  }
}

async function renderPage(n){
  if(renderTasks.has(n)||pageCanvases.has(n)||!pdfDoc)return;
  try{
    const page=await pdfDoc.getPage(n);
    const viewport=page.getViewport({scale});
    const w=pageWrappers.get(n);if(!w){page.cleanup();return;}
    w.style.width=viewport.width+'px';w.style.height=viewport.height+'px';
    const canvas=document.createElement('canvas');canvas.className='page-canvas';
    const dpr=window.devicePixelRatio||1;
    canvas.width=viewport.width*dpr;canvas.height=viewport.height*dpr;
    canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';
    canvas.style.opacity='0';
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);
    pageCanvases.set(n,canvas);w.innerHTML='';w.appendChild(canvas);
    const task=page.render({canvasContext:ctx,viewport});
    renderTasks.set(n,task);await task.promise;renderTasks.delete(n);
    canvas.style.transition='opacity .15s';requestAnimationFrame(()=>{canvas.style.opacity='1';});
    page.cleanup();if(sidebarOpen)renderThumb(n);
  }catch(err){
    if(err?.name!=='RenderingCancelledException')console.warn('[SC] Page',n,err);
    renderTasks.delete(n);
  }
}

// ── Thumbnails ────────────────────────────────────────────────────────────────
async function renderThumb(n){
  if(thumbCanvases.has(n))return;
  const item=sidebar.querySelector(`[data-page="${n}"]`);if(!item)return;
  const ph=item.querySelector('.thumb-ph');if(!ph)return;
  try{
    const page=await pdfDoc.getPage(n);const vp=page.getViewport({scale:0.17});
    const canvas=document.createElement('canvas');canvas.className='thumb-canvas';
    canvas.width=vp.width;canvas.height=vp.height;
    canvas.style.width=Math.round(vp.width)+'px';canvas.style.height=Math.round(vp.height)+'px';
    await page.render({canvasContext:canvas.getContext('2d'),viewport:vp}).promise;
    thumbCanvases.set(n,canvas);ph.replaceWith(canvas);page.cleanup();
  }catch{}
}

function buildSidebar(){
  sidebar.innerHTML='';thumbCanvases.clear();
  for(let i=1;i<=numPages;i++){
    const item=document.createElement('div');item.className='thumb-item'+(i===1?' active':'');item.dataset.page=i;
    const ph=document.createElement('div');ph.className='thumb-ph';ph.style.cssText='width:90px;height:125px';
    const num=document.createElement('div');num.className='thumb-num';num.textContent=i;
    item.appendChild(ph);item.appendChild(num);item.addEventListener('click',()=>scrollToPage(i));sidebar.appendChild(item);
  }
  const obs=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting)renderThumb(Number(e.target.dataset.page));},{root:sidebar,rootMargin:'200px 0px',threshold:0.01});
  sidebar.querySelectorAll('.thumb-item').forEach(el=>obs.observe(el));
}

function setActiveThumb(n){
  sidebar.querySelectorAll('.thumb-item').forEach(el=>el.classList.toggle('active',Number(el.dataset.page)===n));
  sidebar.querySelector(`[data-page="${n}"]`)?.scrollIntoView({block:'nearest',behavior:'smooth'});
}

// ── Scroll tracking ───────────────────────────────────────────────────────────
function trackCurrentPage(){
  if(scrollLock)return;
  const areaTop=scrollArea.getBoundingClientRect().top;let closest=1,closestDist=Infinity;
  for(const[page,w]of pageWrappers){const dist=Math.abs(w.getBoundingClientRect().top-areaTop);if(dist<closestDist){closestDist=dist;closest=page;}}
  if(closest!==currentPage){currentPage=closest;$('page-input').value=currentPage;setActiveThumb(currentPage);}
}

function scrollToPage(page){
  const w=pageWrappers.get(page);if(!w)return;
  scrollLock=true;currentPage=page;$('page-input').value=page;setActiveThumb(page);
  w.scrollIntoView({behavior:'smooth',block:'start'});setTimeout(()=>{scrollLock=false;},900);
}

// ── Load PDF ──────────────────────────────────────────────────────────────────
async function loadPdf(){
  showStatus('Fetching PDF…','Shadowcore is loading your document directly — no external viewer needed.');setProgress(10);
  let arrayBuffer;
  try{
    const resp=await fetch(fileUrl,{credentials:'include',cache:'no-store'});
    if(!resp.ok)throw new Error(`HTTP ${resp.status}`);
    arrayBuffer=await resp.arrayBuffer();
    const sig=new Uint8Array(arrayBuffer.slice(0,4));
    const ok=sig[0]===0x25&&sig[1]===0x50&&sig[2]===0x44&&sig[3]===0x46;
    const ct=resp.headers.get('content-type')||'';
    if(!ok&&!/application\/pdf/i.test(ct))throw new Error('Server returned a protected page instead of a PDF.');
  }catch(err){showStatus('Could not fetch PDF',err.message,true);return;}

  setProgress(40);showStatus('Rendering…','Setting up the optimized canvas renderer.');
  try{
    const task=pdfjsLib.getDocument({data:arrayBuffer});
    task.onProgress=({loaded,total})=>{if(total)setProgress(40+(loaded/total)*30);};
    pdfDoc=await task.promise;numPages=pdfDoc.numPages;setProgress(80);
  }catch(err){showStatus('Render error',err.message,true);return;}

  const fp=await pdfDoc.getPage(1);const vp0=fp.getViewport({scale:1});fp.cleanup();
  scale=Math.max(0.5,Math.min(3,(scrollArea.clientWidth-48)/vp0.width));updateZoomLabel();
  $('page-input').value=1;$('page-total').textContent='/ '+numPages;
  $('info-name').textContent=fileName;$('info-pages').textContent=numPages;$('info-url').textContent=fileUrl;
  document.title='Shadowcore — '+fileName;

  await buildPageList();buildSidebar();setupObserver();setProgress(100);hideStatus();
  scrollArea.addEventListener('scroll',trackCurrentPage,{passive:true});
}

// ── Toolbar controls ──────────────────────────────────────────────────────────
$('btn-prev').onclick=()=>scrollToPage(Math.max(1,currentPage-1));
$('btn-next').onclick=()=>scrollToPage(Math.min(numPages,currentPage+1));
$('page-input').addEventListener('keydown',e=>{
  if(e.key==='Enter'){const p=parseInt($('page-input').value,10);if(p>=1&&p<=numPages)scrollToPage(p);$('page-input').blur();}
});
$('btn-zoomin').onclick=()=>{const n=ZOOM_STEPS.find(z=>z>scale+0.01);applyZoom(n??scale*1.2);};
$('btn-zoomout').onclick=()=>{const n=[...ZOOM_STEPS].reverse().find(z=>z<scale-0.01);applyZoom(n??scale*0.8);};
$('btn-fit').onclick=fitToWidth;

scrollArea.addEventListener('wheel',e=>{if(e.ctrlKey||e.metaKey){e.preventDefault();applyZoom(scale*(e.deltaY<0?1.1:0.9));}},{passive:false});

document.addEventListener('keydown',e=>{
  if(!pdfDoc)return;const isInput=document.activeElement?.tagName==='INPUT'||document.activeElement?.tagName==='TEXTAREA';
  if(isInput&&!(e.ctrlKey||e.metaKey))return;
  if(e.key==='Escape'){if(cropMode){cancelCrop();}return;}
  if(e.key==='ArrowRight'||e.key==='ArrowDown'||e.key==='PageDown'){e.preventDefault();scrollToPage(Math.min(numPages,currentPage+1));}
  else if(e.key==='ArrowLeft'||e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();scrollToPage(Math.max(1,currentPage-1));}
  else if(e.key==='Home'){e.preventDefault();scrollToPage(1);}
  else if(e.key==='End'){e.preventDefault();scrollToPage(numPages);}
  else if((e.ctrlKey||e.metaKey)&&(e.key==='='||e.key==='+')){e.preventDefault();$('btn-zoomin').click();}
  else if((e.ctrlKey||e.metaKey)&&e.key==='-'){e.preventDefault();$('btn-zoomout').click();}
  else if((e.ctrlKey||e.metaKey)&&e.key==='0'){e.preventDefault();fitToWidth();}
  else if(!isInput&&e.key==='f')$('btn-fullscreen').click();
});

$('btn-fullscreen').onclick=()=>{if(!document.fullscreenElement)document.documentElement.requestFullscreen();else document.exitFullscreen();};
$('btn-sidebar').onclick=()=>{
  sidebarOpen=!sidebarOpen;sidebar.classList.toggle('hidden',!sidebarOpen);$('btn-sidebar').classList.toggle('active',sidebarOpen);
};
$('btn-open-original').onclick=()=>window.open(fileUrl,'_blank','noopener');
$('btn-retry').onclick=loadPdf;
$('btn-download').onclick=async()=>{
  try{const resp=await fetch(fileUrl,{credentials:'include'});const blob=await resp.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=fileName;a.click();URL.revokeObjectURL(url);toast('Download started!');}
  catch{window.open(fileUrl,'_blank','noopener');}
};
$('btn-info').onclick=()=>{$('panel-info').classList.toggle('open');$('panel-draw').classList.remove('open');};
$('close-info').onclick=()=>$('panel-info').classList.remove('open');

// ═══════════════════════════════════════════════════
//   DRAWING — pen · marker · highlighter · laser · emoji · eraser
// ═══════════════════════════════════════════════════
let drawMode=null; // 'pen'|'marker'|'highlight'|'laser'|'emoji'|'eraser'
let drawColor='#ef4444',drawSize=3,drawOpacity=1,isEraser=false;
let selectedEmoji='⭐',emojiSize=40;

// ── Canvas positioning ────────────────────────────────────────────────────────
function syncDrawCanvas(){
  const saRect=scrollArea.getBoundingClientRect();
  const parentRect=drawCanvas.parentElement.getBoundingClientRect();
  drawCanvas.style.position='absolute';
  drawCanvas.style.top=(saRect.top-parentRect.top)+'px';
  drawCanvas.style.left=(saRect.left-parentRect.left)+'px';
  const sw=scrollArea.scrollWidth,sh=scrollArea.scrollHeight;
  drawCanvas.style.width=sw+'px';drawCanvas.style.height=sh+'px';
  if(drawCanvas.width!==sw||drawCanvas.height!==sh){
    // Preserve existing drawings when resizing
    let saved=null;
    try{if(drawCanvas.width>0&&drawCanvas.height>0)saved=drawCtx.getImageData(0,0,drawCanvas.width,drawCanvas.height);}catch{}
    drawCanvas.width=sw;drawCanvas.height=sh;
    if(saved)try{drawCtx.putImageData(saved,0,0);}catch{}
  }
}

// ── Tool panel helpers ────────────────────────────────────────────────────────
const DRAW_TOOL_IDS=['btn-pen','btn-marker','btn-highlight','btn-laser','btn-emoji-tool','btn-eraser'];
const TOOL_TITLES={pen:'Pen',marker:'Marker',highlight:'Highlighter',laser:'Laser Pointer',emoji:'Emoji Stamp',eraser:'Eraser'};

function setDrawPanelForMode(mode){
  $('panel-draw-title').textContent=TOOL_TITLES[mode]||'Drawing Tools';
  const isLaser=mode==='laser';const isEmoji=mode==='emoji';const isEraser2=mode==='eraser';
  $('draw-color-section').style.display=(isLaser||isEmoji)?'none':'';
  $('draw-size-section').style.display=(isLaser||isEmoji)?'none':'';
  $('draw-opacity-section').style.display=(isLaser||isEmoji||isEraser2)?'none':'';
  $('emoji-section').style.display=isEmoji?'':'none';
  $('laser-section').style.display=isLaser?'':'none';
}

function enableDraw(mode){
  drawMode=mode;isEraser=mode==='eraser';
  syncDrawCanvas();drawCanvas.classList.add('active');drawCanvas.classList.remove('crop-mode');
  DRAW_TOOL_IDS.forEach(id=>$(id)?.classList.remove('active'));
  const btnMap={pen:'btn-pen',marker:'btn-marker',highlight:'btn-highlight',laser:'btn-laser',emoji:'btn-emoji-tool',eraser:'btn-eraser'};
  if(btnMap[mode])$(btnMap[mode]).classList.add('active');
  if(mode==='highlight'){drawOpacity=0.35;drawSize=22;$('brush-size').value=22;$('size-val').textContent=22;$('brush-opacity').value=35;$('opacity-val').textContent=35;}
  else if(mode==='marker'){drawOpacity=1;drawSize=10;$('brush-size').value=10;$('size-val').textContent=10;}
  else if(mode==='pen'){drawOpacity=1;drawSize=3;$('brush-size').value=3;$('size-val').textContent=3;}
  setDrawPanelForMode(mode);
  $('panel-draw').classList.add('open');
  if(mode==='laser')stopLaserFade();
}

function disableDraw(){
  if(drawMode==='laser')stopLaserFade();
  drawMode=null;drawCanvas.classList.remove('active','crop-mode');
  DRAW_TOOL_IDS.forEach(id=>$(id)?.classList.remove('active'));
  $('panel-draw').classList.remove('open');
}

DRAW_TOOL_IDS.forEach(id=>{
  const el=$(id);if(!el)return;
  const mode=id.replace('btn-','').replace('-tool','');
  el.onclick=()=>drawMode===mode?disableDraw():enableDraw(mode);
});
$('btn-clear').onclick=()=>{drawCtx.clearRect(0,0,drawCanvas.width,drawCanvas.height);toast('Canvas cleared');};
$('close-draw').onclick=disableDraw;
$('brush-size').oninput=e=>{drawSize=+e.target.value;$('size-val').textContent=drawSize;};
$('brush-opacity').oninput=e=>{drawOpacity=+e.target.value/100;$('opacity-val').textContent=e.target.value;};
$('emoji-size').oninput=e=>{emojiSize=+e.target.value;$('emoji-size-val').textContent=emojiSize;};
document.querySelectorAll('.color-swatch').forEach(s=>{
  s.onclick=()=>{document.querySelectorAll('.color-swatch').forEach(x=>x.classList.remove('active'));s.classList.add('active');drawColor=s.dataset.color;};
});

// ── Emoji picker ──────────────────────────────────────────────────────────────
const EMOJIS=['⭐','❤️','🔥','✅','❌','❓','💡','📌','🎯','✏️','📝','👍','👎','😊','😂','🤔','😮','💯','⚡','🏆'];
(function buildEmojiPicker(){
  const picker=$('emoji-picker');if(!picker)return;
  EMOJIS.forEach(em=>{
    const btn=document.createElement('button');
    btn.textContent=em;
    btn.style.cssText='font-size:20px;background:#141428;border:2px solid transparent;border-radius:6px;cursor:pointer;padding:2px;';
    btn.title=em;
    btn.onclick=()=>{
      selectedEmoji=em;
      picker.querySelectorAll('button').forEach(b=>b.style.borderColor='transparent');
      btn.style.borderColor='#6366f1';
    };
    if(em===selectedEmoji)btn.style.borderColor='#6366f1';
    picker.appendChild(btn);
  });
})();

// ── Laser pointer (overlay canvas, no persistence) ───────────────────────────
const laserCanvas=document.createElement('canvas');
laserCanvas.style.cssText='position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9990;';
document.body.appendChild(laserCanvas);
const laserCtx=laserCanvas.getContext('2d');
function resizeLaser(){laserCanvas.width=window.innerWidth;laserCanvas.height=window.innerHeight;}
resizeLaser();window.addEventListener('resize',resizeLaser);
let laserTrail=[],laserFadeTimer=null,laserAnimId=null;
function laserFrame(){
  laserCtx.clearRect(0,0,laserCanvas.width,laserCanvas.height);
  const now=Date.now();
  laserTrail=laserTrail.filter(p=>now-p.t<700);
  for(let i=1;i<laserTrail.length;i++){
    const a=1-(now-laserTrail[i].t)/700;
    laserCtx.beginPath();laserCtx.moveTo(laserTrail[i-1].x,laserTrail[i-1].y);laserCtx.lineTo(laserTrail[i].x,laserTrail[i].y);
    laserCtx.strokeStyle=`rgba(255,40,40,${a*0.9})`;laserCtx.lineWidth=3;laserCtx.lineCap='round';
    laserCtx.shadowColor='rgba(255,80,80,0.8)';laserCtx.shadowBlur=10;laserCtx.stroke();
  }
  if(laserTrail.length){
    const p=laserTrail[laserTrail.length-1];const a=1-(now-p.t)/700;
    laserCtx.beginPath();laserCtx.arc(p.x,p.y,7,0,Math.PI*2);
    laserCtx.fillStyle=`rgba(255,40,40,${a})`;laserCtx.shadowColor='rgba(255,80,80,1)';laserCtx.shadowBlur=20;laserCtx.fill();
  }
  if(laserTrail.length)laserAnimId=requestAnimationFrame(laserFrame);
  else{laserAnimId=null;laserCtx.clearRect(0,0,laserCanvas.width,laserCanvas.height);}
}
function addLaserPoint(x,y){
  laserTrail.push({x,y,t:Date.now()});
  clearTimeout(laserFadeTimer);laserFadeTimer=setTimeout(()=>{laserTrail=[];},800);
  if(!laserAnimId)laserAnimId=requestAnimationFrame(laserFrame);
}
function stopLaserFade(){laserTrail=[];clearTimeout(laserFadeTimer);laserCtx.clearRect(0,0,laserCanvas.width,laserCanvas.height);if(laserAnimId){cancelAnimationFrame(laserAnimId);laserAnimId=null;}}

// ── Coordinate helper ─────────────────────────────────────────────────────────
function getCanvasPos(clientX,clientY){
  const r=scrollArea.getBoundingClientRect();
  return{x:clientX-r.left+scrollArea.scrollLeft,y:clientY-r.top+scrollArea.scrollTop};
}

// ── Core stroke engine ────────────────────────────────────────────────────────
let isPointerDrawing=false,lastDX=0,lastDY=0;

function strokeBegin(clientX,clientY){
  if(cropMode||!drawMode)return false;
  if(drawMode==='laser'){addLaserPoint(clientX,clientY);return true;}
  if(drawMode==='emoji'){
    const{x,y}=getCanvasPos(clientX,clientY);
    drawCtx.save();drawCtx.font=`${emojiSize}px serif`;drawCtx.textAlign='center';drawCtx.textBaseline='middle';
    drawCtx.globalAlpha=1;drawCtx.globalCompositeOperation='source-over';
    drawCtx.shadowColor='transparent';drawCtx.shadowBlur=0;
    drawCtx.fillText(selectedEmoji,x,y);drawCtx.restore();
    return true;
  }
  const{x,y}=getCanvasPos(clientX,clientY);lastDX=x;lastDY=y;
  if(isEraser){
    drawCtx.globalCompositeOperation='destination-out';drawCtx.strokeStyle='rgba(0,0,0,1)';
    drawCtx.globalAlpha=1;drawCtx.lineWidth=drawSize*5;drawCtx.lineCap='round';drawCtx.lineJoin='round';drawCtx.setLineDash([]);
  } else if(drawMode==='highlight'){
    drawCtx.globalCompositeOperation='source-over';drawCtx.strokeStyle=drawColor;drawCtx.globalAlpha=drawOpacity;
    drawCtx.lineWidth=drawSize;drawCtx.lineCap='square';drawCtx.lineJoin='round';drawCtx.setLineDash([]);
  } else if(drawMode==='marker'){
    drawCtx.globalCompositeOperation='source-over';drawCtx.strokeStyle=drawColor;drawCtx.globalAlpha=drawOpacity;
    drawCtx.lineWidth=drawSize;drawCtx.lineCap='square';drawCtx.lineJoin='round';drawCtx.setLineDash([]);
  } else {
    drawCtx.globalCompositeOperation='source-over';drawCtx.strokeStyle=drawColor;drawCtx.globalAlpha=drawOpacity;
    drawCtx.lineWidth=drawSize;drawCtx.lineCap='round';drawCtx.lineJoin='round';drawCtx.setLineDash([]);
  }
  drawCtx.beginPath();drawCtx.moveTo(x,y);
  return true;
}

function strokeMove(clientX,clientY){
  if(!isPointerDrawing||!drawMode||cropMode)return;
  if(drawMode==='laser'){addLaserPoint(clientX,clientY);return;}
  if(drawMode==='emoji')return;
  const{x,y}=getCanvasPos(clientX,clientY);
  const midX=(lastDX+x)/2,midY=(lastDY+y)/2;
  drawCtx.quadraticCurveTo(lastDX,lastDY,midX,midY);
  drawCtx.stroke();
  drawCtx.beginPath();drawCtx.moveTo(midX,midY);
  lastDX=x;lastDY=y;
}

function strokeEnd(){
  if(!isPointerDrawing)return;
  isPointerDrawing=false;
  if(drawMode==='laser'||drawMode==='emoji')return;
  drawCtx.lineTo(lastDX+0.1,lastDY+0.1);drawCtx.stroke();
  drawCtx.globalAlpha=1;drawCtx.globalCompositeOperation='source-over';drawCtx.setLineDash([]);
}

// ── Mouse events ──────────────────────────────────────────────────────────────
drawCanvas.addEventListener('mousedown',e=>{if(e.button!==0)return;isPointerDrawing=strokeBegin(e.clientX,e.clientY);});
drawCanvas.addEventListener('mousemove',e=>{
  if(drawMode==='laser'&&!cropMode)addLaserPoint(e.clientX,e.clientY);
  strokeMove(e.clientX,e.clientY);
});
['mouseup','mouseleave'].forEach(ev=>drawCanvas.addEventListener(ev,e=>{
  if(drawMode==='laser')stopLaserFade();
  strokeEnd();
}));

// ── Touch: 1-finger draw · 2-finger scroll/zoom ───────────────────────────────
let touchDrawing=false,lastTouchDist=0,lastTouchMidX=0,lastTouchMidY=0;

drawCanvas.addEventListener('touchstart',e=>{
  if(cropMode)return;
  if(e.touches.length===1&&drawMode){
    e.preventDefault();touchDrawing=true;
    isPointerDrawing=strokeBegin(e.touches[0].clientX,e.touches[0].clientY);
  } else if(e.touches.length>=2){
    e.preventDefault();touchDrawing=false;strokeEnd();
    const t1=e.touches[0],t2=e.touches[1];
    lastTouchDist=Math.hypot(t1.clientX-t2.clientX,t1.clientY-t2.clientY);
    lastTouchMidX=(t1.clientX+t2.clientX)/2;lastTouchMidY=(t1.clientY+t2.clientY)/2;
  }
},{passive:false});

drawCanvas.addEventListener('touchmove',e=>{
  if(e.touches.length===1&&touchDrawing&&drawMode&&!cropMode){
    e.preventDefault();strokeMove(e.touches[0].clientX,e.touches[0].clientY);
  } else if(e.touches.length>=2){
    e.preventDefault();
    const t1=e.touches[0],t2=e.touches[1];
    const dist=Math.hypot(t1.clientX-t2.clientX,t1.clientY-t2.clientY);
    const midX=(t1.clientX+t2.clientX)/2,midY=(t1.clientY+t2.clientY)/2;
    if(lastTouchDist>0){
      const delta=dist/lastTouchDist;
      if(Math.abs(delta-1)>0.03){applyZoom(scale*delta);}
      else{scrollArea.scrollLeft+=lastTouchMidX-midX;scrollArea.scrollTop+=lastTouchMidY-midY;}
    }
    lastTouchDist=dist;lastTouchMidX=midX;lastTouchMidY=midY;
  }
},{passive:false});

['touchend','touchcancel'].forEach(ev=>drawCanvas.addEventListener(ev,()=>{
  touchDrawing=false;if(drawMode==='laser')stopLaserFade();strokeEnd();
}));

scrollArea.addEventListener('touchstart',e=>{
  if(e.touches.length===2){
    const t1=e.touches[0],t2=e.touches[1];
    lastTouchDist=Math.hypot(t1.clientX-t2.clientX,t1.clientY-t2.clientY);
    lastTouchMidX=(t1.clientX+t2.clientX)/2;lastTouchMidY=(t1.clientY+t2.clientY)/2;
  }
},{passive:true});
scrollArea.addEventListener('touchmove',e=>{
  if(e.touches.length===2){
    const t1=e.touches[0],t2=e.touches[1];
    const dist=Math.hypot(t1.clientX-t2.clientX,t1.clientY-t2.clientY);
    const midX=(t1.clientX+t2.clientX)/2,midY=(t1.clientY+t2.clientY)/2;
    if(lastTouchDist>0){
      const delta=dist/lastTouchDist;
      if(Math.abs(delta-1)>0.03)applyZoom(scale*delta);
    }
    lastTouchDist=dist;lastTouchMidX=midX;lastTouchMidY=midY;
  }
},{passive:true});
window.addEventListener('resize',()=>{resizeLaser();if(drawMode)syncDrawCanvas();});

// ═══════════════════════════════════════════════════
//   CROP SELECTION (Ask AI)
// ═══════════════════════════════════════════════════
let cropMode=false;
let cropStart={x:0,y:0},cropEnd={x:0,y:0};
let cropDataUrl=null,cropText='';
let cropActive=false;

function enterCropMode(){
  cropMode=true;cropActive=false;
  disableDraw();
  syncDrawCanvas();
  drawCanvas.classList.add('active','crop-mode');
  $('btn-ask-ai').classList.add('active');
  cropBanner.classList.add('show');
  cropRect.classList.remove('show');
}

function cancelCrop(){
  cropMode=false;cropActive=false;
  drawCanvas.classList.remove('active','crop-mode');
  $('btn-ask-ai').classList.remove('active');
  cropBanner.classList.remove('show');
  cropRect.classList.remove('show');
}

// Crop mouse events
drawCanvas.addEventListener('mousedown',e=>{
  if(!cropMode)return;
  cropActive=true;
  cropStart={x:e.clientX,y:e.clientY};
  cropEnd={x:e.clientX,y:e.clientY};
  updateCropRect();
});
document.addEventListener('mousemove',e=>{
  if(!cropMode||!cropActive)return;
  cropEnd={x:e.clientX,y:e.clientY};
  updateCropRect();
});
document.addEventListener('mouseup',async e=>{
  if(!cropMode||!cropActive)return;
  cropEnd={x:e.clientX,y:e.clientY};
  cropActive=false;
  const w=Math.abs(cropEnd.x-cropStart.x),h=Math.abs(cropEnd.y-cropStart.y);
  if(w<20||h<20){cancelCrop();toast('Selection too small');return;}
  await finalizeCrop();
});

function updateCropRect(){
  const x=Math.min(cropStart.x,cropEnd.x);const y=Math.min(cropStart.y,cropEnd.y);
  const w=Math.abs(cropEnd.x-cropStart.x);const h=Math.abs(cropEnd.y-cropStart.y);
  cropRect.style.left=x+'px';cropRect.style.top=y+'px';
  cropRect.style.width=w+'px';cropRect.style.height=h+'px';
  cropRect.classList.add('show');
}

async function finalizeCrop(){
  cropBanner.classList.remove('show');cropRect.classList.remove('show');
  const x=Math.min(cropStart.x,cropEnd.x);const y=Math.min(cropStart.y,cropEnd.y);
  const w=Math.abs(cropEnd.x-cropStart.x);const h=Math.abs(cropEnd.y-cropStart.y);

  // Screenshot the selected area from the PDF canvases
  const offscreen=document.createElement('canvas');
  const dpr=window.devicePixelRatio||1;
  offscreen.width=w*dpr;offscreen.height=h*dpr;
  const ctx=offscreen.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,w*dpr,h*dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);

  for(const[,wrapper]of pageWrappers){
    const canvas=pageCanvases.get(Number(wrapper.dataset.page));if(!canvas)continue;
    const wRect=wrapper.getBoundingClientRect();
    const sx=x-wRect.left;const sy=y-wRect.top;
    const sw=w;const sh=h;
    if(sx+sw<0||sy+sh<0||sx>wRect.width||sy>wRect.height)continue;
    const clipX=Math.max(0,sx);const clipY=Math.max(0,sy);
    const clipW=Math.min(sw,wRect.width-clipX);const clipH=Math.min(sh,wRect.height-clipY);
    if(clipW<=0||clipH<=0)continue;
    const srcX=Math.max(0,sx)*(canvas.width/wRect.width);
    const srcY=Math.max(0,sy)*(canvas.height/wRect.height);
    const srcW=clipW*(canvas.width/wRect.width);
    const srcH=clipH*(canvas.height/wRect.height);
    const dstX=Math.max(0,-sx);const dstY=Math.max(0,-sy);
    try{ctx.drawImage(canvas,srcX,srcY,srcW,srcH,dstX,dstY,clipW,clipH);}catch{}
  }

  cropDataUrl=offscreen.toDataURL('image/png');

  // Extract text from the region via PDF.js text layer
  cropText=await extractTextFromRegion(x,y,w,h);

  cancelCrop();
  openAiPanel();
  // Pre-fill input with a question prompt
  if(cropText.trim()){
    aiInput.value='Explain this: ';
  } else {
    aiInput.value='What is shown in the selected area? ';
  }
  aiInput.focus();
  // Show the crop image as a pending attachment
  showCropPreview(cropDataUrl);
  autoResizeInput();
}

function showCropPreview(dataUrl){
  const existing=$('pending-crop');if(existing)existing.remove();
  const div=document.createElement('div');div.id='pending-crop';div.style.cssText='margin:4px 0 8px;display:flex;align-items:center;gap:8px;';
  const img=document.createElement('img');img.src=dataUrl;img.style.cssText='height:60px;border-radius:6px;border:1px solid #4338ca;opacity:.9;';
  const rm=document.createElement('button');rm.textContent='✕';rm.style.cssText='background:#1e1e3a;border:none;color:#a0a8cc;border-radius:4px;padding:2px 7px;cursor:pointer;font-size:12px;';
  rm.onclick=()=>{div.remove();cropDataUrl=null;cropText='';};
  div.appendChild(img);div.appendChild(rm);
  $('ai-input-wrap').insertBefore(div,$('ai-input-wrap').firstChild);
}

async function extractTextFromRegion(screenX,screenY,w,h){
  if(!pdfDoc)return'';
  const texts=[];
  for(const[pageNum,wrapper]of pageWrappers){
    const wRect=wrapper.getBoundingClientRect();
    if(screenX+w<wRect.left||screenX>wRect.right||screenY+h<wRect.top||screenY>wRect.bottom)continue;
    try{
      const page=await pdfDoc.getPage(pageNum);
      const vp=page.getViewport({scale});
      const tc=await page.getTextContent();
      const relX=(screenX-wRect.left)/wRect.width*vp.width;
      const relY=(screenY-wRect.top)/wRect.height*vp.height;
      const relW=w/wRect.width*vp.width;
      const relH=h/wRect.height*vp.height;
      for(const item of tc.items){
        const[a,,,,tx,ty]=item.transform;
        const fw=item.width*a;const fh=item.height||12;
        const ix=tx;const iy=vp.height-ty-fh;
        if(ix+fw>=relX&&ix<=relX+relW&&iy+fh>=relY&&iy<=relY+relH){
          texts.push(item.str);
        }
      }
      page.cleanup();
    }catch{}
  }
  return texts.join(' ').trim();
}

// ═══════════════════════════════════════════════════
//   AI PANEL
// ═══════════════════════════════════════════════════
let aiOpen=false;
let aiPanelWidth=380;
const STORAGE_KEY='sc_ai_chat';
let chatHistory=[]; // {role:'user'|'assistant', parts:[{text}]}
const FREE_AI_ENDPOINT='https://text.pollinations.ai/openai';
let aiFullscreen=false;

function openAiPanel(){
  if(!aiOpen){
    aiOpen=true;aiPanel.classList.add('open');
    aiPanel.style.width=aiPanelWidth+'px';
    $('ai-width-slider').value=aiPanelWidth;
    $('btn-ask-ai').classList.add('active');
    loadChatHistory();
    checkApiKey();
  }
}

function closeAiPanel(){
  aiOpen=false;aiPanel.classList.remove('open');aiPanel.style.width='0';
  $('btn-ask-ai').classList.remove('active');aiFullscreen=false;
}

$('btn-ask-ai').onclick=()=>{
  if(aiOpen){closeAiPanel();}else{openAiPanel();}
};
$('ai-close').onclick=closeAiPanel;
$('btn-notes').onclick=()=>{ chrome.tabs.create({url:chrome.runtime.getURL('notes.html')}); };

// Width slider
$('ai-width-slider').oninput=e=>{
  aiPanelWidth=+e.target.value;
  aiPanel.style.width=aiPanelWidth+'px';
  aiFullscreen=false;
};

// Fullscreen toggle
$('ai-fullscreen-btn').onclick=()=>{
  aiFullscreen=!aiFullscreen;
  if(aiFullscreen){
    const total=document.querySelector('.layout').clientWidth;
    aiPanel.style.width=(total-8)+'px';
    $('ai-width-slider').value=Math.min(900,total-8);
  } else {
    aiPanel.style.width=aiPanelWidth+'px';
    $('ai-width-slider').value=aiPanelWidth;
  }
};

// Drag resizer
let resizerDragging=false,resizerStartX=0,resizerStartW=0;
aiResizer.addEventListener('mousedown',e=>{
  resizerDragging=true;resizerStartX=e.clientX;resizerStartW=aiOpen?aiPanelWidth:0;
  aiResizer.classList.add('dragging');e.preventDefault();
});
document.addEventListener('mousemove',e=>{
  if(!resizerDragging)return;
  const delta=resizerStartX-e.clientX;
  const newW=Math.max(0,Math.min(900,resizerStartW+delta));
  if(newW<50){if(aiOpen)closeAiPanel();}
  else{if(!aiOpen)openAiPanel();aiPanelWidth=newW;aiPanel.style.width=newW+'px';$('ai-width-slider').value=Math.min(900,newW);}
});
document.addEventListener('mouseup',()=>{resizerDragging=false;aiResizer.classList.remove('dragging');});

// ── AI setup — no key needed, free via Pollinations ──────────────────────────
function checkApiKey(){ showChatScreen(); }
function showChatScreen(){ renderMessages(); }

$('ai-settings-btn').onclick=()=>{
  chatHistory=[];
  chrome.storage.local.remove([STORAGE_KEY]);
  renderMessages();
  toast('Chat cleared');
};

// ── Chat history ──────────────────────────────────────────────────────────────
function saveChatHistory(){
  const toSave=chatHistory.slice(-30); // keep last 30 turns
  chrome.storage.local.set({[STORAGE_KEY]:JSON.stringify(toSave)});
}
function loadChatHistory(){
  chrome.storage.local.get([STORAGE_KEY],data=>{
    try{chatHistory=JSON.parse(data[STORAGE_KEY]||'[]');}catch{chatHistory=[];}
    renderMessages();
  });
}

$('ai-clear-chat').onclick=()=>{
  chatHistory=[];saveChatHistory();renderMessages();toast('Chat cleared');
};

// ── Render all messages ───────────────────────────────────────────────────────
function renderMessages(){
  aiMessages.innerHTML='';
  if(!chatHistory.length){
    aiMessages.innerHTML=`
    <div class="ai-empty">
      <div class="ai-empty-icon">✨</div>
      <h3>Ask Studyink AI</h3>
      <p>Ask anything about this PDF. Select a specific region with <strong>Crop & Ask</strong>, or ask about the whole page.</p>
      <div class="hint">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/></svg>
        Tap "Crop & Ask" or "This Page" to get started
      </div>
    </div>`;
    return;
  }
  for(const msg of chatHistory){
    const isUser=msg.role==='user';
    const text=msg.parts[0]?.text||'';
    const imgUrl=msg.parts[0]?.cropImage||null;
    const div=document.createElement('div');div.className='msg '+(isUser?'user':'ai');
    const meta=document.createElement('div');meta.className='msg-meta';
    const avatar=document.createElement('div');avatar.className='msg-avatar';avatar.textContent=isUser?'Y':'AI';
    const time=document.createElement('span');time.textContent=isUser?'You':'Studyink AI';
    if(isUser){meta.appendChild(time);meta.appendChild(avatar);}else{meta.appendChild(avatar);meta.appendChild(time);}
    div.appendChild(meta);
    if(imgUrl&&isUser){
      const wrap=document.createElement('div');wrap.className='msg-crop';
      const img=document.createElement('img');img.src=imgUrl;img.alt='Selection';
      wrap.appendChild(img);div.appendChild(wrap);
    }
    const bubble=document.createElement('div');bubble.className='msg-bubble';
    bubble.innerHTML=isUser?escHtml(text):renderMarkdown(text);
    div.appendChild(bubble);
    aiMessages.appendChild(div);
  }
  aiMessages.scrollTop=aiMessages.scrollHeight;
}

function appendMessage(role,text,imgUrl=null){
  const entry={role,parts:[{text,cropImage:imgUrl}]};chatHistory.push(entry);saveChatHistory();
  if(aiMessages.querySelector('.ai-empty'))aiMessages.innerHTML='';
  const isUser=role==='user';
  const div=document.createElement('div');div.className='msg '+(isUser?'user':'ai');
  const meta=document.createElement('div');meta.className='msg-meta';
  const avatar=document.createElement('div');avatar.className='msg-avatar';avatar.textContent=isUser?'Y':'AI';
  const time=document.createElement('span');time.textContent=isUser?'You':'Studyink AI';
  if(isUser){meta.appendChild(time);meta.appendChild(avatar);}else{meta.appendChild(avatar);meta.appendChild(time);}
  div.appendChild(meta);
  if(imgUrl&&isUser){const wrap=document.createElement('div');wrap.className='msg-crop';const img=document.createElement('img');img.src=imgUrl;img.alt='Selection';wrap.appendChild(img);div.appendChild(wrap);}
  const bubble=document.createElement('div');bubble.className='msg-bubble';
  bubble.innerHTML=isUser?escHtml(text):renderMarkdown(text);
  div.appendChild(bubble);
  aiMessages.appendChild(div);
  aiMessages.scrollTop=aiMessages.scrollHeight;
  return bubble;
}

function showThinking(){
  const div=document.createElement('div');div.className='msg ai';div.id='ai-thinking-msg';
  const thinking=document.createElement('div');thinking.className='ai-thinking';
  thinking.innerHTML='<div class="dots"><span></span><span></span><span></span></div><span>Thinking…</span>';
  div.appendChild(thinking);aiMessages.appendChild(div);aiMessages.scrollTop=aiMessages.scrollHeight;
}
function removeThinking(){const t=$('ai-thinking-msg');if(t)t.remove();}

// ── Markdown + KaTeX renderer ─────────────────────────────────────────────────
function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function renderMarkdown(text){
  let s=text;

  // Block math $$...$$
  s=s.replace(/\$\$([\s\S]+?)\$\$/g,(_,m)=>`<div class="math-block">${escHtml(m.trim())}</div>`);
  // Inline math $...$
  s=s.replace(/\$([^\n\$]+?)\$/g,(_,m)=>`<span class="math-inline">${escHtml(m)}</span>`);

  // Code blocks
  s=s.replace(/```(\w*)\n?([\s\S]+?)```/g,(_,lang,code)=>`<pre><code class="lang-${lang}">${escHtml(code.trim())}</code></pre>`);

  // Headings
  s=s.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  s=s.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  s=s.replace(/^# (.+)$/gm,'<h1>$1</h1>');

  // Horizontal rule
  s=s.replace(/^(---|\*\*\*|___)$/gm,'<hr>');

  // Blockquote
  s=s.replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>');

  // Bold + italic
  s=s.replace(/\*\*\*(.+?)\*\*\*/g,'<strong><em>$1</em></strong>');
  s=s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/__(.+?)__/g,'<strong>$1</strong>');
  s=s.replace(/\*([^*\n]+?)\*/g,'<em>$1</em>');
  s=s.replace(/_([^_\n]+?)_/g,'<em>$1</em>');

  // Inline code
  s=s.replace(/`([^`]+)`/g,'<code>$1</code>');

  // Bullet lists
  s=s.replace(/^[\*\-\+] (.+)$/gm,'<li>$1</li>');
  s=s.replace(/(<li>[\s\S]+?<\/li>)/g,'<ul>$1</ul>');
  s=s.replace(/<\/ul>\s*<ul>/g,'');

  // Numbered lists
  s=s.replace(/^\d+\. (.+)$/gm,'<li>$1</li>');

  // Line breaks → paragraphs (but not inside pre/h*/ul/blockquote)
  const lines=s.split('\n');
  const out=[];let inPre=false,buf=[];
  for(const line of lines){
    if(line.startsWith('<pre'))inPre=true;
    if(inPre){out.push(line);if(line.includes('</pre>'))inPre=false;continue;}
    if(line.match(/^<(h[1-6]|ul|ol|hr|blockquote|div|pre|li)/)||line.match(/<\/(h[1-6]|ul|ol|blockquote|div|pre)>/)){
      if(buf.length){out.push('<p>'+buf.join(' ')+'</p>');buf=[];}out.push(line);
    } else if(line.trim()===''){
      if(buf.length){out.push('<p>'+buf.join(' ')+'</p>');buf=[];}
    } else {buf.push(line);}
  }
  if(buf.length)out.push('<p>'+buf.join(' ')+'</p>');
  return out.join('\n');
}

// ── HuggingFace free vision: describe a cropped image ────────────────────────
async function describeImageFree(dataUrl){
  try{
    const base64=dataUrl.split(',')[1];
    const binary=atob(base64);const arr=new Uint8Array(binary.length);
    for(let i=0;i<binary.length;i++)arr[i]=binary.charCodeAt(i);
    const resp=await fetch('https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-large',{
      method:'POST',headers:{'Content-Type':'application/octet-stream'},body:arr.buffer
    });
    if(!resp.ok)return null;
    const result=await resp.json();
    if(Array.isArray(result)&&result[0]?.generated_text)return result[0].generated_text;
    return null;
  }catch{return null;}
}

// ── Send message to AI (free via Pollinations — no key needed) ───────────────
async function sendToAI(userText){
  const localCrop=cropDataUrl;const localCropText=cropText;
  cropDataUrl=null;cropText='';const pending=$('pending-crop');if(pending)pending.remove();

  // Build context from current page
  let pageContext='';
  try{
    const page=await pdfDoc.getPage(currentPage);
    const tc=await page.getTextContent();
    pageContext=tc.items.map(i=>i.str).join(' ').trim().substring(0,2000);
    page.cleanup();
  }catch{}

  // If crop but no text (image-based PDF), try HuggingFace vision
  let imageDesc='';
  if(localCrop&&!localCropText.trim()){
    toast('Analyzing image…');
    imageDesc=await describeImageFree(localCrop)||'';
  }

  let fullPrompt=userText;
  if(localCropText){
    fullPrompt=`Selected region text:\n"${localCropText}"\n\nQuestion: ${userText}`;
  } else if(imageDesc){
    fullPrompt=`The selected region appears to show: "${imageDesc}"\n\nQuestion: ${userText}`;
  }

  // Build conversation summary for memory (last 8 turns)
  const prevHistory=chatHistory.slice(-16);
  const conversationLines=prevHistory.map(m=>`${m.role==='user'?'Student':'AI'}: ${(m.parts[0]?.text||'').substring(0,300)}`).join('\n');
  const hasHistory=prevHistory.length>0;

  const systemMsg={
    role:'system',
    content:`You are Studyink AI, a brilliant academic tutor embedded in Shadowcore Studyink PDF viewer.

PDF: "${fileName}" — Page ${currentPage} of ${numPages}
Page content: ${pageContext?`"${pageContext}"`:' (image-only page — no extractable text)'}
${localCropText||imageDesc?`\nSelected region: ${localCropText||imageDesc}`:''}
${hasHistory?`\nConversation so far:\n${conversationLines}\n`:''}

Rules:
- Remember everything said above in this conversation and refer back to it naturally
- Use markdown: **bold**, ## headers, bullet lists, numbered steps
- Wrap ALL math in $...$ inline or $$...$$ block
- Use code blocks for code
- Be thorough, clear, and reference the PDF content
- If the page is image-only (no text), still help using any context given`
  };

  appendMessage('user',userText,localCrop);
  showThinking();aiSend.disabled=true;

  // Build OpenAI messages from chat history (last 16 turns for memory)
  const historyForApi=chatHistory.slice(0,-1).slice(-16).map(m=>({
    role: m.role==='model'?'assistant':m.role,
    content: m.parts[0].text||''
  }));

  try{
    const resp=await fetch(FREE_AI_ENDPOINT,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'openai',
        messages:[
          systemMsg,
          ...historyForApi,
          {role:'user',content:fullPrompt}
        ],
        temperature:0.7,
        max_tokens:2048,
        seed:42
      })
    });

    const data=await resp.json();
    removeThinking();aiSend.disabled=false;

    if(data.error){
      appendMessage('model',`⚠️ AI error: ${data.error.message||'Something went wrong. Please try again.'}`);
      return;
    }

    const aiText=data.choices?.[0]?.message?.content||'No response received.';
    appendMessage('model',aiText);
  }catch(err){
    removeThinking();aiSend.disabled=false;
    appendMessage('model',`⚠️ Network error: ${err.message}. Check your connection and try again.`);
  }
}

// ── Input UI ──────────────────────────────────────────────────────────────────
function autoResizeInput(){
  aiInput.style.height='auto';aiInput.style.height=Math.min(120,aiInput.scrollHeight)+'px';
  $('ai-char-count').textContent=aiInput.value.length?`${aiInput.value.length} chars`:'';
}

aiInput.addEventListener('input',autoResizeInput);
aiInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();handleSend();}
});
aiSend.onclick=handleSend;

function handleSend(){
  const text=aiInput.value.trim();if(!text)return;
  aiInput.value='';autoResizeInput();
  openAiPanel();
  sendToAI(text);
}

// Crop & Ask chip
$('btn-crop-ai').onclick=()=>{
  if(!pdfDoc){toast('Load a PDF first');return;}
  openAiPanel();
  enterCropMode();
};

// Ask AI button (toolbar) — toggles the panel open/close
// (Use the Crop & Ask chip to draw a selection)

// This Page chip - extract full page text
$('btn-page-ai').onclick=async()=>{
  if(!pdfDoc){toast('Load a PDF first');return;}
  openAiPanel();
  try{
    const page=await pdfDoc.getPage(currentPage);
    const tc=await page.getTextContent();
    const text=tc.items.map(i=>i.str).join(' ').trim().substring(0,3000);
    page.cleanup();
    if(!text){toast('No extractable text on this page');return;}
    aiInput.value=`Explain page ${currentPage}: `;aiInput.focus();
    cropText=text;autoResizeInput();
    toast(`Page ${currentPage} text loaded`);
  }catch{toast('Could not extract text');}
};

// ── Start ─────────────────────────────────────────────────────────────────────
loadPdf();
