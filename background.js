chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openViewer') {
    const url = msg.url;
    const viewerUrl = chrome.runtime.getURL('viewer.html') + '?url=' + encodeURIComponent(url);
    chrome.tabs.create({ url: viewerUrl });
  }
  if (msg.action === 'getUpdateStatus') {
    chrome.storage.local.get(['sc_update_available','sc_last_sha'], res => {
      sendResponse({ updateAvailable: !!res.sc_update_available, sha: res.sc_last_sha });
    });
    return true;
  }
});

const CURRENT_VERSION = '2.0.0';
const GITHUB_API = 'https://api.github.com/repos/yehnaitik/scnotesscribe/commits/main';

async function checkForUpdates() {
  try {
    const r = await fetch(GITHUB_API, { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    const sha = data.sha?.substring(0, 7) || '';
    const msg = data.commit?.message || '';
    const stored = await chrome.storage.local.get(['sc_installed_sha']);
    const installedSha = stored.sc_installed_sha;
    if (!installedSha) {
      await chrome.storage.local.set({ sc_installed_sha: sha });
      return;
    }
    if (sha !== installedSha) {
      await chrome.storage.local.set({ sc_update_available: true, sc_last_sha: sha, sc_update_msg: msg });
      chrome.action.setBadgeText({ text: '↑' });
      chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
    }
  } catch {}
}

chrome.runtime.onInstalled.addListener(() => {
  checkForUpdates();
  chrome.alarms.create('sc-update-check', { periodInMinutes: 180 });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'sc-update-check') checkForUpdates();
});

checkForUpdates();
