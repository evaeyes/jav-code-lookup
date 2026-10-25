/**
 * sw.js — service worker：右键菜单入口
 *  选中文字 / 右键链接 / 右键页面 → “查番号” → 打开 popup 自动查询
 *  旧版 Chrome 打不开 popup 时，退化成系统通知直接出结果
 */
import { query, normKey } from './lookup.js';

const MENU_ID = 'jav-code-lookup';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '查番号 / 女演员',
      contexts: ['link', 'selection', 'page'],
    });
  });
});

function pickText(info) {
  if (info.linkUrl && /^https?:/i.test(info.linkUrl)) return info.linkUrl;
  const sel = (info.selectionText || '').trim();
  if (sel) return sel;
  if (info.pageUrl && /^https?:/i.test(info.pageUrl)) return info.pageUrl;
  return '';
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 2,
    });
  } catch (e) {
    /* 通知不可用就算了 */
  }
}

/** 本机建档索引里有没有这个番号 */
async function localTag(code) {
  const k = normKey(code);
  if (!k) return '';
  try {
    const r = await fetch(chrome.runtime.getURL('local-index.json'), { cache: 'no-store' });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.items && d.items[k]) ? ' · ✅ 本机已下载' : '';
  } catch (e) {
    return '';
  }
}


// ---------------------------------------------------------------- 刷新本机库（Native Messaging）
const NATIVE_HOST = 'com.hermes.javindex';

function runNativeScan(root) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      reject(new Error('本机服务连不上：' + ((e && e.message) || e)));
      return;
    }
    let done = false;
    port.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'start') {
        chrome.storage.local.set({ scanState: { state: 'running', files: 0, items: 0, startedAt } });
      } else if (msg.type === 'progress') {
        chrome.storage.local.set({ scanState: { state: 'running', files: msg.files || 0, videos: msg.videos || 0, items: msg.items || 0, elapsed: msg.elapsed || 0, startedAt } });
      } else if (msg.type === 'done') {
        done = true;
        chrome.storage.local.set({ scanState: { state: 'done', count: msg.count, generatedAt: msg.generatedAt, seconds: msg.seconds, finishedAt: Date.now() } });
        try { port.disconnect(); } catch (e) { /* ignore */ }
        resolve(msg);
      } else if (msg.type === 'error') {
        done = true;
        chrome.storage.local.set({ scanState: { state: 'error', message: msg.message } });
        try { port.disconnect(); } catch (e) { /* ignore */ }
        reject(new Error(msg.message));
      }
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (done) return;
      const m = (err && err.message) || '本机服务意外断开（宿主还没装好？先跑 tools\\setup_native_host.py）';
      chrome.storage.local.set({ scanState: { state: 'error', message: m } });
      reject(new Error(m));
    });
    port.postMessage({ cmd: 'scan', root: msg && msg.root ? msg.root : undefined });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.cmd !== 'rescan') return undefined;
  runNativeScan(msg.root)
    .then((r) => sendResponse({ ok: true, result: r }))
    .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID) return;
  const text = pickText(info);
  if (!text) return;

  // 优先把活交给 popup（有界面、能复制、能看历史）
  try {
    await chrome.storage.local.set({ pendingQuery: text, pendingAt: Date.now() });
    if (chrome.action.openPopup) {
      await chrome.action.openPopup();
      return;
    }
  } catch (e) {
    /* 打不开 popup，继续走通知 */
  }

  await notify('查出中…', text.slice(0, 80));
  const o = await query(text);
  if (o.code) {
    chrome.action.setBadgeText({ text: o.code.slice(0, 12) });
    await chrome.notifications.clear('');
    await notify(
      o.code + (o.actresses.length ? '  ' + o.actresses.join('、') : '  （未取到女演员）') +
        (await localTag(o.code)),
      (o.title || '').slice(0, 160) || '来自 右键菜单'
    );
  } else {
    await notify('没能识别番号', (o.error || '换个链接或直接输入番号试试').slice(0, 160));
  }
});
