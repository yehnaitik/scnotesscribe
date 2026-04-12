const fileList = document.getElementById('file-list');
const rescanBtn = document.getElementById('rescan');
const notesBtn = document.getElementById('generate-notes');

function getFileType(url) {
  const u = url.toLowerCase();
  if (u.includes('.pdf') || u.includes('pdf')) return 'pdf';
  if (u.match(/\.(docx?|rtf|odt|txt)(\?|$)/)) return 'doc';
  if (u.match(/\.(png|jpe?g|gif|bmp|svg|webp)(\?|$)/)) return 'img';
  if (u.match(/\.(xlsx?|csv|pptx?|zip|rar)(\?|$)/)) return 'other';
  return null;
}

function getFileName(url) {
  try {
    const path = new URL(url).pathname;
    const name = path.split('/').pop();
    return decodeURIComponent(name || url).substring(0, 60);
  } catch { return url.substring(0, 60); }
}

function getIconLabel(type) {
  const map = { pdf: 'PDF', doc: 'DOC', img: 'IMG', other: 'FILE' };
  return map[type] || 'FILE';
}

function renderFiles(files) {
  if (!files.length) {
    fileList.innerHTML = '<div class="empty"><div class="icon">📂</div><p>No files detected on this page.</p></div>';
    return;
  }
  fileList.innerHTML = files.map(f => `
    <div class="file-item" data-url="${f.url}">
      <div class="file-icon ${f.type}">${getIconLabel(f.type)}</div>
      <div class="file-info">
        <div class="file-name">${f.name}</div>
        <div class="file-type">${f.type.toUpperCase()} file</div>
      </div>
      <span class="open-arrow">›</span>
    </div>
  `).join('');

  fileList.querySelectorAll('.file-item').forEach(el => {
    el.addEventListener('click', () => {
      const url = el.dataset.url;
      chrome.runtime.sendMessage({ action: 'openViewer', url });
    });
  });
}

function scan() {
  fileList.innerHTML = '<div class="empty"><div class="icon">🔍</div><p>Scanning…</p></div>';
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;

    const tabUrl = tabs[0].url || '';
    const directFiles = [];
    if (/\.pdf(\?|$)/i.test(tabUrl) || tabUrl.includes('pdf')) {
      directFiles.push({ url: tabUrl, name: getFileName(tabUrl), type: 'pdf' });
    }

    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const links = [...document.querySelectorAll('a[href], embed[src], iframe[src], object[data]')];
        const urls = new Set();
        links.forEach(el => {
          const href = el.href || el.src || el.dataset?.url || el.getAttribute('data') || '';
          if (href && href.startsWith('http')) urls.add(href);
        });
        return [...urls];
      }
    }, (results) => {
      if (chrome.runtime.lastError || !results || !results[0]) {
        renderFiles(directFiles);
        return;
      }
      const allUrls = results[0].result || [];
      const files = [...directFiles];
      const seen = new Set(directFiles.map(f => f.url));
      allUrls.forEach(url => {
        if (seen.has(url)) return;
        const type = getFileType(url);
        if (type) {
          seen.add(url);
          files.push({ url, name: getFileName(url), type });
        }
      });
      renderFiles(files);
    });
  });
}

// Generate Handwritten Notes
notesBtn.addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) { chrome.tabs.create({ url: chrome.runtime.getURL('notes.html') }); return; }
    chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        const sel = window.getSelection()?.toString().trim();
        if (sel && sel.length > 10) return sel;
        const main = document.querySelector(
          'main, article, [role="main"], .content, .post-content, .entry-content, .lesson-content, .note-content, .notes-content'
        );
        if (main) return main.innerText.trim();
        return document.body.innerText.trim();
      }
    }, (results) => {
      const text = (results?.[0]?.result || '').substring(0, 5000);
      chrome.storage.local.set({ ntkNotesText: text }, () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('notes.html') });
      });
    });
  });
});

rescanBtn.addEventListener('click', scan);
scan();
