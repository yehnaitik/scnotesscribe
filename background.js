chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openViewer') {
    const url = msg.url;
    const viewerUrl = chrome.runtime.getURL('viewer.html') + '?url=' + encodeURIComponent(url);
    chrome.tabs.create({ url: viewerUrl });
  }
});
