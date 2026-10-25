import { queryMany, codeDirect, splitInputs, PROXY_HINT, normKey } from './lookup.js';

const $ = (id) => document.getElementById(id);
const qEl = $('q');
const goEl = $('go');
const statusEl = $('status');
const resultsEl = $('results');
const recentEl = $('recentList');
const dotEl = $('netdot');
const localStateEl = $('localState');

const RECENT_KEY = 'recent';
const LIB_ROOT_KEY = 'libRoot';
const DEFAULT_LIB_ROOT = '';   // 首次使用让用户在「⚙ 设置」里指定
let libRoot = DEFAULT_LIB_ROOT;
const MAX_RECENT = 12;

// ---------------------------------------------------------------- 本机影片索引
// tools/scan_local_index.py 扫 H:\H\女优 生成的 local-index.json，随扩展包一起加载
let LOCAL = null;
let localState = 'idle'; // idle | loading | ready | missing

async function loadLocalIndex() {
  if (localState === 'loading' || localState === 'ready') return;
  localState = 'loading';
  try {
    const r = await fetch(chrome.runtime.getURL('local-index.json'), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    if (!d || !d.items) throw new Error('索引格式不对');
    LOCAL = d;
    localState = 'ready';
  } catch (e) {
    LOCAL = null;
    localState = 'missing';
  }
  renderLocalState();
}

function renderLocalState() {
  if (!localStateEl) return;
  if (localState === 'ready') {
    const t = String(LOCAL.generatedAt || '').replace('T', ' ').slice(0, 16);
    localStateEl.textContent = `本机索引：${LOCAL.count} 部 · ${t} 更新`;
    localStateEl.title = '索引目录：' + (LOCAL.root || '?') + '\n扫描目录：' + libRoot;
  } else if (localState === 'missing') {
    localStateEl.textContent = '本机索引：未建档（跑 tools/scan_local_index.py 生成）';
  } else {
    localStateEl.textContent = '本机影片索引：读取中…';
  }
}

function humanSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = Number(n);
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (i <= 1 ? Math.round(x) + u[i] : x.toFixed(1) + u[i]);
}

/** 番号在本机索引里吗？（两边都去掉前导零再比） */
function localHit(o) {
  if (!LOCAL) return null;
  const cands = (o.codes && o.codes.length) ? o.codes.slice() : (o.code ? [o.code] : []);
  const keys = [];
  for (const c of cands) {
    const k = normKey(c);
    if (k && !keys.includes(k)) keys.push(k);
  }
  for (const k of keys) {
    const it = LOCAL.items[k];
    if (it) return Object.assign({ key: k }, it);
  }
  return null;
}

const RELEVANT_HOST = /(^|\.)(t\.co|twitter\.com|x\.com|dmm\.co\.jp|fanza\.co\.jp|javbus\.com|njavtv\.com|missav\.ws|javdb\.com)$/i;

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function setDot(state, title) {
  dotEl.className = 'dot' + (state ? ' ' + state : '');
  if (title) dotEl.title = title;
}

function looksLikeQuery(s) {
  const t = String(s || '').trim();
  if (!t) return false;
  if (/^https?:\/\//i.test(t)) return true;
  if (codeDirect(t)) return true;
  return /\b[A-Za-z]{2,7}-\d{2,6}\b/.test(t);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

async function copyText(text, btn, label) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = label || '已复制';
    btn.classList.add('done');
    setTimeout(() => {
      btn.textContent = old;
      btn.classList.remove('done');
    }, 1200);
  } catch (e) {
    btn.textContent = '复制失败';
  }
}

function summaryOf(o) {
  const names = (o.actresses && o.actresses.length) ? o.actresses.join('、') : '未取到女演员';
  const hit = localHit(o);
  return (o.code || '未识别') + '  ' + names + (hit ? '  [已下载]' : '');
}

function renderCard(o) {
  const card = el('div', 'card');

  const line = el('div', 'code-line');
  line.appendChild(el('span', 'code' + (o.code ? '' : ' none'), o.code || '未能识别番号'));
  const copyBtn = el('button', 'mini', '复制');
  copyBtn.addEventListener('click', () => copyText(summaryOf(o), copyBtn));
  line.appendChild(copyBtn);
  card.appendChild(line);

  // 本机是否已有（建档索引）
  const hit = localHit(o);
  if (hit) {
    const row = el('div', 'localrow');
    const badge = el('span', 'localyes', '✓ 已下载');
    badge.title = (hit.files || []).map((f) => f.p).join('\n');
    row.appendChild(badge);
    row.appendChild(el('span', 'localmeta',
      [hit.actress, hit.n > 1 ? hit.n + ' 个文件' : '', humanSize(hit.size)].filter(Boolean).join(' · ')));
    card.appendChild(row);
  } else if (LOCAL && o.code) {
    const row = el('div', 'localrow');
    row.appendChild(el('span', 'localno', '本机没有'));
    if (localState === 'ready') row.appendChild(el('span', 'localmeta', '共 ' + LOCAL.count + ' 部在库'));
    card.appendChild(row);
  }

  const aw = el('div', 'actresses');
  if (o.actresses && o.actresses.length) {
    for (const a of o.actresses) aw.appendChild(el('span', 'chip', a));
  } else {
    aw.appendChild(el('span', 'noname', o.error ? '查询失败' : (o.code ? '未取到女演员' : '换一个链接或直接输入番号试试')));
  }
  card.appendChild(aw);

  if (o.error) {
    const errBox = el('div', 'errline');
    errBox.appendChild(el('span', null, o.error));
    const dbg = el('button', 'mini dbg', '复制诊断');
    dbg.addEventListener('click', () => copyText(JSON.stringify({
      input: o.input,
      resolved: o.resolved,
      hops: o.hops,
      codes: o.codes,
      error: o.error,
      sources: (o.sources || []).map((s) => s.source + ':' + ((s.actresses || []).length)),
    }, null, 2), dbg, '已复制'));
    errBox.appendChild(dbg);
    card.appendChild(errBox);
  }
  if (o.title) card.appendChild(el('div', 'title', o.title));

  if (o.resolved && o.resolved !== o.input) {
    card.appendChild(el('div', 'resolved', '解析 → ' + o.resolved));
  }

  const srcs = el('div', 'srcs');
  for (const s of (o.sources || [])) {
    if (!s.url) continue;
    const a = el('a', null, s.source);
    a.href = s.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    srcs.appendChild(a);
  }
  if (srcs.childNodes.length) card.appendChild(srcs);

  return card;
}

function remember(o) {
  if (!o.code) return;
  chrome.storage.local.get(RECENT_KEY, (d) => {
    const list = (d[RECENT_KEY] || []).filter((x) => x.code !== o.code);
    list.unshift({ code: o.code, actresses: o.actresses || [], ts: Date.now() });
    chrome.storage.local.set({ [RECENT_KEY]: list.slice(0, MAX_RECENT) }, renderRecent);
  });
}

function renderRecent() {
  chrome.storage.local.get(RECENT_KEY, (d) => {
    const list = d[RECENT_KEY] || [];
    recentEl.replaceChildren();
    if (!list.length) {
      recentEl.appendChild(el('div', 'recent-item', '还没有记录'));
      return;
    }
    for (const item of list) {
      const b = el('button', 'recent-item');
      b.appendChild(el('span', 'c', item.code));
      b.appendChild(el('span', 'a', (item.actresses || []).join('、') || '—'));
      const k = normKey(item.code);
      if (LOCAL && k && LOCAL.items[k]) {
        const tk = el('span', 'tick', '✓');
        tk.title = '本机已下载';
        b.appendChild(tk);
      }
      b.addEventListener('click', () => {
        qEl.value = item.code;
        run();
      });
      recentEl.appendChild(b);
    }
  });
}

let running = false;
let lastQuery = '';

async function run() {
  const text = qEl.value.trim();
  if (!text) {
    setStatus('先粘贴一个 t.co 短链或番号。');
    qEl.focus();
    return;
  }
  lastQuery = text;
  if (running) return;
  running = true;
  goEl.disabled = true;
  await loadLocalIndex();
  resultsEl.replaceChildren();
  setDot('busy', '查询中');
  setStatus('开始查询…');

  const items = splitInputs(text);
  const outs = [];
  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const prefix = items.length > 1 ? `[${i + 1}/${items.length}] ` : '';
      setStatus(prefix + '正在解析 ' + it);
      const one = await queryMany(it, null, (msg) => setStatus(prefix + msg)).then((r) => r[0]);
      outs.push(one);
      resultsEl.appendChild(renderCard(one));
      if (one.code) remember(one);
    }
    const okCount = outs.filter((o) => o.code && o.actresses.length).length;
    const codeCount = outs.filter((o) => o.code).length;
    const netBad = outs.filter((o) => o.error && /打不开|连不上|网络|超时/.test(o.error)).length;
    if (!outs.length) {
      setStatus('没有可查询的内容。');
    } else if (okCount) {
      setStatus(`完成：${okCount} 条拿到女演员${codeCount > okCount ? `，${codeCount - okCount} 条只有番号` : ''}`);
      setDot('', '就绪');
    } else if (codeCount) {
      setStatus('识别到番号但没取到女演员，可以点结果里的数据源手动确认。', 'err');
      setDot('bad', '部分失败');
    } else if (netBad) {
      setStatus('网络不通，查询没发出去。\n' + PROXY_HINT, 'err');
      setDot('bad', '网络不通');
    } else {
      setStatus('没能识别出番号，换个链接或直接输入番号试试。', 'err');
      setDot('bad', '失败');
    }
    const last = outs[outs.length - 1];
    if (last && last.code) chrome.action.setBadgeText({ text: last.code.slice(0, 12) });
  } catch (e) {
    setStatus('出错：' + ((e && e.message) || e), 'err');
    setDot('bad', '出错');
  } finally {
    running = false;
    goEl.disabled = false;
  }
}

// ---------------------------------------------------------------- 预填

async function activeTabUrl() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return (tab && tab.url) || '';
  } catch (e) {
    return '';
  }
}

function hostRelevant(url) {
  try {
    return RELEVANT_HOST.test(new URL(url).hostname);
  } catch (e) {
    return false;
  }
}

async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch (e) {
    return '';
  }
}

async function boot() {
  $('ver').textContent = 'v' + chrome.runtime.getManifest().version;
  renderRecent();
  // 本机影片索引：读完再补一次历史列表的「已下载」勾
  await loadLocalIndex();
  renderRecent();
  // 自定义目录：用户设置 > 代码默认值 > 现有索引里记录的目录
  const st = await chrome.storage.local.get(LIB_ROOT_KEY);
  libRoot = String((st && st[LIB_ROOT_KEY]) || '').trim() || DEFAULT_LIB_ROOT || (LOCAL && LOCAL.root) || '';
  $('libRoot').value = libRoot;

  // 1) 右键菜单点过来的查询
  const d = await chrome.storage.local.get(['pendingQuery', 'pendingAt']);
  if (d.pendingQuery && Date.now() - (d.pendingAt || 0) < 120000) {
    await chrome.storage.local.remove(['pendingQuery', 'pendingAt']);
    qEl.value = d.pendingQuery;
    setStatus('来自右键菜单，开始查询…');
    run();
    return;
  }

  // 2) 当前标签页就是 t.co / 推特 / FANZA 时自动带过来
  const url = await activeTabUrl();
  if (hostRelevant(url)) {
    qEl.value = url;
    setStatus('已带入当前标签页的链接');
    run();
    return;
  }

  // 3) 剪贴板里有链接/番号就预填（不自动查，避免误触发网络请求）
  const clip = (await readClipboard()).trim();
  if (clip && clip.length < 300 && looksLikeQuery(clip)) {
    qEl.value = clip;
    setStatus('已从剪贴板预填，回车或点查询');
  }
  qEl.focus();
}

// ---------------------------------------------------------------- 事件

goEl.addEventListener('click', run);

qEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    run();
  }
});

$('fromTab').addEventListener('click', async () => {
  const url = await activeTabUrl();
  if (url && /^https?:/i.test(url)) {
    qEl.value = url;
    run();
  } else {
    setStatus('当前标签页不是普通网页。');
  }
});

$('fromClip').addEventListener('click', async () => {
  const t = (await readClipboard()).trim();
  if (t) {
    qEl.value = t;
    run();
  } else {
    setStatus('剪贴板是空的，或没有剪贴板权限。');
  }
});

$('clear').addEventListener('click', () => {
  chrome.storage.local.set({ [RECENT_KEY]: [] }, renderRecent);
});


// ---------------------------------------------------------------- 刷新本机库
$('rescan').addEventListener('click', rescanLocal);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.scanState) return;
  const s = changes.scanState.newValue;
  if (!s || s.state !== 'running') return;
  localStateEl.textContent = `刷新中：已扫 ${s.files || 0} 个文件 · 入库 ${s.items || 0} 部`;
});


/** popup 里直连本机服务（SW 不在时的兜底） */
function nativeScanInPopup(root) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = chrome.runtime.connectNative('com.hermes.javindex');
    } catch (e) {
      reject(new Error('本机服务连不上：' + ((e && e.message) || e)));
      return;
    }
    let done = false;
    port.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'start') {
        localStateEl.textContent = '刷新中：开始扫描…';
      } else if (msg.type === 'progress') {
        localStateEl.textContent = `刷新中：已扫 ${msg.files || 0} 个文件 · 入库 ${msg.items || 0} 部`;
      } else if (msg.type === 'done') {
        done = true;
        try { port.disconnect(); } catch (e) { /* ignore */ }
        resolve(msg);
      } else if (msg.type === 'error') {
        done = true;
        try { port.disconnect(); } catch (e) { /* ignore */ }
        reject(new Error(msg.message));
      }
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (done) return;
      reject(new Error((err && err.message) || '本机服务断开'));
    });
    port.postMessage({ cmd: 'scan', root: root || undefined });
  });
}

async function rescanLocal() {
  const btn = $('rescan');
  if (btn.disabled) return;
  if (!libRoot) {
    $('settings').hidden = false;
    $('libRoot').focus();
    localStateEl.textContent = '还没设置本机影片目录';
    setStatus('先在「⚙ 设置」里填你的影片目录（形如 D:\\JAV库），保存后再刷新。', 'err');
    return;
  }
  btn.disabled = true;
  localStateEl.textContent = '刷新中：正在扫描本机影片目录…';
  setStatus('正在刷新本机库（扫描本机影片目录，约 40 秒）…');
  setDot('busy', '刷新中');
  try {
    let result;
    try {
      const r = await chrome.runtime.sendMessage({ cmd: 'rescan', root: libRoot });
      if (!r || !r.ok) throw new Error((r && r.error) || '本机服务没有响应');
      result = r.result;
    } catch (e) {
      // 背景 service worker 没接上（例如刚重载过扩展）→ 直接在 popup 里连
      result = await nativeScanInPopup(libRoot);
    }
    localState = 'idle';
    LOCAL = null;
    await loadLocalIndex();
    renderRecent();
    setStatus(`本机库已刷新：${result.count} 部 · 用时 ${result.seconds}s · ${String(result.generatedAt || '').replace('T', ' ')}` + (result.root ? `\n目录：${result.root}` : ''));
    setDot('', '就绪');
    if (lastQuery && resultsEl.querySelector('.card')) {
      qEl.value = lastQuery;
      await run();
    }
  } catch (e) {
    const m = (e && e.message) || String(e);
    localStateEl.textContent = '刷新失败：' + m;
    let hint = '';
    if (/目录不存在|路径/.test(m)) hint = '\n→ 检查「⚙ 设置」里的目录路径是否存在、能不能访问。';
    else if (/连不上|没有响应|断开|Receiving|host/i.test(m)) hint = '\n→ 本机服务没装好，先跑一次：python tools\\setup_native_host.py';
    else hint = '\n→ 点「网络自检」看看是不是网络问题。';
    setStatus('刷新本机库失败：' + m + hint, 'err');
    setDot('bad', '刷新失败');
  } finally {
    btn.disabled = false;
  }
}


// 网络自检：一眼分清「网络不通」还是「输入不对」
async function netCheck() {
  const targets = [
    ['javbus', 'https://www.javbus.com/'],
    ['t.co', 'https://t.co/'],
    ['njavtv', 'https://njavtv.com/'],
  ];
  setStatus('网络自检中…');
  setDot('busy', '自检中');
  const lines = [];
  let good = 0;
  for (const [name, url] of targets) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, { cache: 'no-store', credentials: 'omit', redirect: 'follow' });
      const ms = Date.now() - t0;
      lines.push(`${name}: 通 (HTTP ${r.status}, ${ms}ms)`);
      good++;
    } catch (e) {
      lines.push(`${name}: 不通 (${(e && e.name) || e}: ${(e && e.message) || ''}, ${Date.now() - t0}ms)`);
    }
  }
  const head = good === targets.length
    ? '网络自检：全部能连上（查不出结果就是番号/解析问题，不是代理）'
    : '网络自检：有站点连不上（这才是代理问题）';
  setStatus(head + '\n' + lines.join('\n'), good === targets.length ? '' : 'err');
  setDot(good === targets.length ? '' : 'bad', good === targets.length ? '就绪' : '网络有问题');
}

$('netcheck').addEventListener('click', netCheck);


// ---------------------------------------------------------------- 设置（自定义本机库目录）
$('settingsBtn').addEventListener('click', () => {
  const p = $('settings');
  p.hidden = !p.hidden;
  if (!p.hidden) {
    $('libRoot').value = libRoot;
    $('libRoot').focus();
    $('libRoot').select();
  }
});

$('saveRoot').addEventListener('click', async () => {
  const v = $('libRoot').value.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
  if (!v) { $('setStatus').textContent = '目录不能为空'; return; }
  if (!/^[A-Za-z]:[\\/]|^\\\\/.test(v)) {
    $('setStatus').textContent = '请填 Windows 绝对路径，例如 H:\\H\\女优';
    return;
  }
  libRoot = v;
  await chrome.storage.local.set({ [LIB_ROOT_KEY]: v });
  $('setStatus').textContent = '已保存：' + v + ' — 点「⟳ 刷新本机库」按新目录重建索引';
});

$('resetRoot').addEventListener('click', async () => {
  libRoot = DEFAULT_LIB_ROOT;
  $('libRoot').value = libRoot;
  await chrome.storage.local.set({ [LIB_ROOT_KEY]: libRoot });
  $('setStatus').textContent = '已恢复默认：' + libRoot;
});

boot();
