chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

const FLOW_HOST_KEYWORDS = [
  'labs.google',
  'googleusercontent',
  'googlevideo',
  'gstatic'
];

let currentDownloadSubfolder = '';

// Queue tên file — mỗi lần download pop 1 tên ra dùng
// Nếu queue rỗng → giữ tên gốc
let fileNameQueue = [];

function sanitizePathSegment(input) {
  return String(input || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

function sanitizeSubfolderPath(input) {
  const normalized = String(input || '').replace(/\\+/g, '/');
  const segments = normalized
    .split('/')
    .map(segment => sanitizePathSegment(segment))
    .filter(Boolean);
  return segments.join('/');
}

function sanitizeFileName(input) {
  return String(input || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '-')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

function shouldHandleDownload(url, referrer) {
  const haystack = `${url || ''} ${referrer || ''}`.toLowerCase();
  return FLOW_HOST_KEYWORDS.some(keyword => haystack.includes(keyword));
}

async function loadFolderFromStorage() {
  try {
    const data = await chrome.storage.local.get(['veo_download_subfolder']);
    currentDownloadSubfolder = sanitizeSubfolderPath(data?.veo_download_subfolder || '');
  } catch (error) {
    currentDownloadSubfolder = '';
  }
}

loadFolderFromStorage();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.action) return;

  if (request.action === 'SET_DOWNLOAD_SUBFOLDER') {
    const cleanFolder = sanitizeSubfolderPath(request.folder || '');
    currentDownloadSubfolder = cleanFolder;
    chrome.storage.local.set({ veo_download_subfolder: cleanFolder }).catch(() => { });
    sendResponse?.({ ok: true, folder: cleanFolder });
    return;
  }

  // content.js gọi action này 1 lần per prompt, truyền mảng tên cho tất cả output
  // VD: outputCount=2 → gửi ['01_cho-va-meo.mp4', '01_cho-va-meo.mp4']
  if (request.action === 'SET_NEXT_DOWNLOAD_NAMES') {
    const names = Array.isArray(request.fileNames)
      ? request.fileNames.map(n => sanitizeFileName(n)).filter(Boolean)
      : [];
    // Nối vào queue (không xóa queue cũ để tránh mất tên của batch trước chưa download xong)
    fileNameQueue.push(...names);
    sendResponse?.({ ok: true, queued: fileNameQueue.length });
    return;
  }

  // Xóa queue khi bắt đầu batch mới (gọi từ runAutomation lúc _downloadDone.clear())
  if (request.action === 'CLEAR_FILENAME_QUEUE') {
    fileNameQueue = [];
    sendResponse?.({ ok: true });
    return;
  }

  if (request.action === 'TRUSTED_CLICK_AT') {
    const tabId = request.tabId || sender?.tab?.id;
    const x = Number(request.x);
    const y = Number(request.y);

    if (!tabId || !Number.isFinite(x) || !Number.isFinite(y)) {
      sendResponse?.({ ok: false, error: 'Invalid click payload' });
      return;
    }

    const target = { tabId };

    const doClick = async () => {
      try {
        await chrome.debugger.attach(target, '1.3');
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          button: 'left',
          clickCount: 1,
          x,
          y
        });
        await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          button: 'left',
          clickCount: 1,
          x,
          y
        });
        await chrome.debugger.detach(target);
        sendResponse?.({ ok: true });
      } catch (error) {
        try { await chrome.debugger.detach(target); } catch (e) { }
        sendResponse?.({ ok: false, error: String(error?.message || error) });
      }
    };

    doClick();
    return true;
  }
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const isFlowDownload = shouldHandleDownload(item?.url, item?.referrer);

  if (!isFlowDownload) {
    suggest();
    return;
  }

  const currentName = item?.filename || '';
  const origFileNameOnly = currentName.split('\\').pop().split('/').pop() || `download-${item.id}`;
  const extMatch = origFileNameOnly.match(/\.([^.]+)$/);
  const ext = extMatch ? extMatch[1] : '';

  // Lấy tên tiếp theo từ queue
  let finalFileName;
  if (fileNameQueue.length > 0) {
    const pending = fileNameQueue.shift(); // pop từ đầu queue
    finalFileName = pending.endsWith('.' + ext)
      ? pending
      : pending.replace(/\.[^.]+$/, '') + (ext ? '.' + ext : '');
  } else {
    // Queue rỗng → giữ tên gốc
    finalFileName = origFileNameOnly;
  }

  const suggestedPath = currentDownloadSubfolder
    ? `${currentDownloadSubfolder}/${finalFileName}`
    : finalFileName;

  suggest({ filename: suggestedPath, conflictAction: 'uniquify' });
});