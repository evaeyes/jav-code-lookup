/**
 * lookup.js — 共享核心：短链展开 / 番号提取 / 多源女演员查询
 * 被 popup.js 和 sw.js 共用（ESM 模块）。
 *
 * 与 scripts/jav_lookup.py 同一套规则；关键点：
 *  - t.co 现在返回的是 200 + JS 中间页（location.replace），不是 301，必须解析响应体
 *  - FANZA / DMM 有地域封锁，但番号在跳转 URL 的 lurl=...id=xxxxx 里，照样能抠出来
 *  - ⚠️ DMM 的 id 允许「数字前缀」：id=1start00430 → 番号 START-430（见 codeCandidates）
 */

const REQ_TIMEOUT = 15000;

export const PROXY_HINT =
  '提示：Chrome 用的是「系统代理」，这些站点（t.co / javbus / njavtv / missav）直连不通。' +
  '先在代理软件里打开系统代理（本机是 127.0.0.1:10808）再试。';

// 别把 URL 里的域名/协议当成番号前缀
const BAD_PREFIX = new Set(['WWW', 'COM', 'NET', 'HTTP', 'HTTPS', 'HTML', 'PHP', 'JSON', 'AGE', 'EN', 'JP']);
// 演员字段里的噪声
const NOISE_NAMES = new Set(['ranking', 'actress', 'actresses', 'star', 'index', '-', '']);

// 番号前缀：允许最多 3 位数字前缀 —— 200GANA / 300MIUM / 1START 这类
// 字母段 2~7 位，数字段 1~6 位
const P = '[0-9]{0,3}[A-Za-z]{2,7}';
const RE_ID = new RegExp('[?&/](?:id|cid|content_id|product_id|movie_id)=([A-Za-z0-9_]{2,26})', 'g');
const RE_PATH = new RegExp('/([0-9]{0,3})([A-Za-z]{2,7})[-_]?([0-9]{2,6})(?:[-_/?#]|$)', 'g');
const RE_DASH = new RegExp('\\b([0-9]{0,3}[A-Za-z]{2,7})-([0-9]{2,6})\\b', 'g');
const RE_DASH_STRICT = /\b([A-Za-z]{2,7})-(\d{2,6})\b/;

function stripSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

async function fetchT(url, ms = REQ_TIMEOUT) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, {
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function unesc(s) {
  return String(s == null ? '' : s)
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function jsTarget(body) {
  if (!body) return null;
  const pats = [
    /location\.replace\(\s*["']([^"']+)["']/i,
    /location\.href\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+http-equiv=["']?refresh["']?[^>]+url=([^"'>\s;]+)/i,
  ];
  for (const p of pats) {
    const m = body.match(p);
    if (m) {
      const t = unesc(m[1]);
      if (/^https?:/i.test(t)) return t;
    }
  }
  return null;
}

function titleOf(body, stripRe) {
  const m = String(body || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  let t = unesc(m[1]).replace(/\s+/g, ' ').trim();
  if (stripRe) t = t.replace(stripRe, '').trim();
  return t || null;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return String(s);
  }
}

function netHint(e) {
  const n = (e && e.name) || '';
  const m = (e && e.message) || String(e || '');
  if (n === 'AbortError') return '超时（15 秒没响应）';
  if (/Failed to fetch|NetworkError|Load failed|ERR_/i.test(m)) return '网络被拒/域名不可达';
  return m;
}

// ---------------------------------------------------------------- 番号

/** 前缀 + 数字 → 规范番号。保留前缀里的数字（200GANA），数字段至少 3 位 */
export function canon(prefix, num) {
  if (!prefix || !num) return null;
  let n = String(num).replace(/^0+/, '') || '0';
  if (n.length < 3) n = n.padStart(3, '0');
  return String(prefix).toUpperCase() + '-' + n;
}

/**
 * 从一个「前缀 + 数字」拆出所有可能的番号写法。
 *   digits='' letters='prpm' num='00002' → [PRPM-002]
 *   digits='1' letters='start' num='00430' → [START-430, 1START-430]   ← 1 前缀多半是 DMM 的编号花样
 *   digits='200' letters='gana' num='1234' → [200GANA-1234]            ← 200/300/259 是厂牌名的一部分
 */
export function codeCandidates(digits, letters, num) {
  digits = digits || '';
  const bare = canon(letters, num);
  const full = digits ? canon(digits + letters, num) : null;
  const out = [];
  if (!full) return bare ? [bare] : [];
  if (digits === '1') {
    out.push(bare);                       // START-430 优先
    if (full !== bare) out.push(full);    // 再试 1START-430
  } else {
    out.push(full);                       // 200GANA-1234 优先
    if (bare !== full) out.push(bare);
  }
  return [...new Set(out.filter(Boolean))];
}

function okPrefix(code) {
  if (!code) return false;
  const head = code.split('-')[0];
  return !BAD_PREFIX.has(head) && /[A-Za-z]/.test(head);
}

/** 查询时应该尝试的写法：PRPM-002 / PRPM-00002 … */
export function codeVariants(code) {
  const m = String(code || '').match(new RegExp('^(' + P + ')-(\\d{2,6})$'));
  if (!m) return [];
  const p = m[1].toUpperCase();
  const n = m[2];
  const out = [p + '-' + n];
  for (const w of [3, 5, 6]) {
    const v = p + '-' + n.padStart(w, '0');
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** 从 URL 里抠番号候选（按可能性排序）。DMM: ?id=1start00430；通用: /start-430 */
/**
 * DMM content id → 番号候选（id 有好几种词形）
 *   prpm00002        → PRPM-002
 *   1start00430      → START-430      （数字前缀，优先去掉）
 *   h_1100hzgd00286  → HZGD-286       （h_ 后面那串数字是「片商编号」，不属于番号）
 */
export function codesFromId(raw) {
  let v = String(raw || '').trim();
  const isH = v.slice(0, 2).toLowerCase() === 'h_';
  if (isH) v = v.slice(2);
  const m = v.match(/^([0-9]{0,6})([A-Za-z]{2,7})([0-9]{1,7})$/);
  if (!m) return [];
  const digits = isH ? '' : m[1];
  return codeCandidates(digits, m[2], m[3]).filter(okPrefix);
}

/** URL 里 id=/cid= 的原始值；解析不出番号时用来报错，别去正文瞎猜 */
export function rawIdOf(url) {
  const u = safeDecode(String(url || ''));
  RE_ID.lastIndex = 0;
  const m = RE_ID.exec(u);
  return m ? m[1] : null;
}

export function codesFromUrl(url) {
  const u = safeDecode(String(url || ''));
  let m;
  RE_ID.lastIndex = 0;
  while ((m = RE_ID.exec(u))) {
    const cs = codesFromId(m[1]);
    if (cs.length) return cs;
  }
  RE_PATH.lastIndex = 0;
  while ((m = RE_PATH.exec(u))) {
    const cs = codeCandidates(m[1], m[2], m[3]).filter(okPrefix);
    if (cs.length) return cs;
  }
  const m2 = u.match(RE_DASH);
  if (m2) {
    const id = m2[0].match(/^([0-9]{0,3})([A-Za-z]{2,7})-([0-9]{2,6})$/);
    if (id) return codeCandidates(id[1], id[2], id[3]).filter(okPrefix);
  }
  return [];
}

/** 兼容：只要第一个候选 */
export function codeFromUrl(url) {
  const cs = codesFromUrl(url);
  return cs.length ? cs[0] : null;
}

/**
 * 本机索引的查询 key：PREFIX-<整数>（两边都去前导零）
 *   ABF-045 -> ABF-45 ；FC2-1391490 -> FC2-1391490
 * 必须与 tools/scan_local_index.py 的 norm_key 保持一致，否则「已下载」标不出来。
 */
export function normKey(code) {
  const m = String(code || '').match(/^([0-9]{0,3}[A-Za-z0-9]{2,7})-([0-9]{1,7})$/);
  if (!m) return null;
  const p = m[1].toUpperCase();
  if ((p.match(/[A-Za-z]/g) || []).length < 2) return null;
  return p + '-' + String(parseInt(m[2], 10));
}

/** 在页面正文里找出现次数最多的番号 */
export function codesFromText(text) {
  const s = String(text || '');
  const counts = new Map();
  let m;
  RE_DASH.lastIndex = 0;
  while ((m = RE_DASH.exec(s))) {
    const id = m[0].match(/^([0-9]{0,3})([A-Za-z]{2,7})-([0-9]{2,6})$/);
    if (!id) continue;
    // 正文里写的通常就是给人看的番号，带数字前缀的优先保留原样
    const cs = codeCandidates(id[1], id[2], id[3]).filter(okPrefix);
    if (cs.length) counts.set(cs[0], (counts.get(cs[0]) || 0) + 1);
  }
  if (!counts.size) return [];
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map((kv) => kv[0]);
}

export function codeFromText(text) {
  const cs = codesFromText(text);
  return cs.length ? cs[0] : null;
}

/** 用户直接输入的番号 */
export function codesDirect(s) {
  const t = String(s || '').trim();
  let m = t.match(new RegExp('^([0-9]{0,3})([A-Za-z]{2,7})[-_ ]?([0-9]{2,6})$'));
  if (!m) return [];
  return codeCandidates(m[1], m[2], m[3]).filter(okPrefix);
}

export function codeDirect(s) {
  const cs = codesDirect(s);
  return cs.length ? cs[0] : null;
}

// ---------------------------------------------------------------- 展开短链

/** 展开短链 / JS 跳转 */
export async function resolveShort(url, log = () => {}) {
  const chain = [];
  let cur = url;
  for (let i = 0; i < 8; i++) {
    chain.push(cur);
    let r;
    try {
      r = await fetchT(cur);
    } catch (e) {
      throw new Error('打不开 ' + cur + '：' + netHint(e));
    }
    const finalUrl = r.url || cur;
    if (stripSlash(finalUrl) !== stripSlash(cur)) {
      cur = finalUrl;
      continue;
    }
    let body = '';
    try {
      body = await r.text();
    } catch (e) {
      body = '';
    }
    const nxt = jsTarget(body);
    if (nxt && stripSlash(nxt) !== stripSlash(cur)) {
      if (log) log('JS 跳转 → ' + nxt);
      cur = nxt;
      continue;
    }
    break;
  }
  if (chain[chain.length - 1] !== cur) chain.push(cur);
  return { final: cur, chain };
}

// ---------------------------------------------------------------- 数据源

async function srcJavbus(code) {
  const url = 'https://www.javbus.com/' + code;
  const r = await fetchT(url);
  if (!r.ok) return null;
  const body = await r.text();
  if (!body.includes('star-name')) return null;
  let stars = [...body.matchAll(/class="star-name"[^>]*>\s*<a[^>]*?title="([^"]+)"/g)].map((m) => m[1]);
  if (!stars.length) {
    stars = [...body.matchAll(/class="star-name"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
  }
  return {
    source: 'javbus',
    url,
    title: titleOf(body, /\s*-\s*JavBus\s*$/i),
    actresses: stars.map((s) => unesc(s).trim()).filter(Boolean),
  };
}

async function srcNjv(code) {
  const url = 'https://njavtv.com/' + code.toLowerCase();
  const r = await fetchT(url);
  if (!r.ok) return null;
  const body = await r.text();
  const t = titleOf(body);
  if (!t || !t.toUpperCase().includes(code.split('-')[0].toUpperCase())) return null;
  let stars = [...body.matchAll(/\/(?:dm\d+\/)?actresses\/([^"\/?#]+)/g)]
    .map((m) => safeDecode(m[1]).replace(/-/g, ' ').trim())
    .filter((s) => !NOISE_NAMES.has(s.toLowerCase()));
  stars = [...new Set(stars)];
  return { source: 'njavtv', url, title: t, actresses: stars };
}

async function srcMissav(code) {
  const url = 'https://missav.ws/' + code.toLowerCase();
  const r = await fetchT(url);
  if (!r.ok) return null;
  const body = await r.text();
  const t = titleOf(body);
  if (!t) return null;
  let stars = [...body.matchAll(/\/(?:actress|actresses|dm\d+\/actresses)\/([^"\/?#]+)/g)]
    .map((m) => safeDecode(m[1]).replace(/-/g, ' ').trim())
    .filter((s) => !NOISE_NAMES.has(s.toLowerCase()) && !/^\d+$/.test(s));
  stars = [...new Set(stars)];
  return { source: 'missav', url, title: t, actresses: stars };
}

const SOURCES = [srcJavbus, srcNjv, srcMissav];

/** 按写法变体轮流问各数据源，拿到演员就走。返回 { results, netFails, lastErr } */
export async function lookupCode(code, log = () => {}) {
  const results = [];
  let netFails = 0;
  let lastErr = '';
  for (const variant of codeVariants(code)) {
    for (const fn of SOURCES) {
      let r = null;
      try {
        r = await fn(variant);
      } catch (e) {
        netFails++;
        lastErr = netHint(e);
        r = null;
      }
      if (r) {
        r.codeTried = variant;
        if (log) log('[命中] ' + r.source + ' ' + variant + ' → ' + (r.actresses || []).join('、'));
        results.push(r);
      }
    }
    if (results.some((r) => r.actresses && r.actresses.length)) break;
  }
  return { results, netFails, lastErr };
}

// ---------------------------------------------------------------- 主流程

/** 一条输入走完全流程 */
export async function query(raw, log = () => {}) {
  const input = String(raw || '').trim();
  const out = {
    input,
    resolved: input,
    hops: [],
    codes: [],
    code: null,
    actresses: [],
    title: null,
    sources: [],
    error: null,
  };
  try {
    if (/^https?:\/\//i.test(input)) {
      const { final, chain } = await resolveShort(input, log);
      out.resolved = final;
      out.hops = chain;
    }
    let codes = codesFromUrl(out.resolved);
    const rawId = rawIdOf(out.resolved);
    if (rawId) out.dmmId = rawId;
    if (!codes.length && !rawId && /^https?:\/\//i.test(out.resolved)) {
      // 只有「不是 DMM 内容页」才去抓正文：有 id= 却解析不出时，正文里翻到的
      // 多半是页面上推荐的无关番号（比如 age_check 页的榜单）
      try {
        const r = await fetchT(out.resolved, 15000);
        codes = codesFromText(await r.text());
      } catch (e) {
        out.netError = netHint(e);
      }
    }
    if (!codes.length) codes = codesFromText(input);
    if (!codes.length) codes = codesDirect(input);
    out.codes = codes;
    out.code = codes[0] || null;
    if (!codes.length) {
      if (out.netError) out.error = '打不开 ' + out.resolved + '：' + out.netError;
      else if (rawId) out.error = '识别不出番号：DMM id = ' + rawId + '（这个词形还没支持，请反馈）';
      else if (!/^https?:\/\//i.test(input)) out.error = '「' + input + '」既不是链接也不像番号（例：MIDA-984、miad 984）';
      else out.error = '这个页面里找不到番号（URL 和正文都没匹配上）';
      return out;
    }

    // 有多个候选写法（如 1START-430 / START-430）时，逐个问到有演员为止
    let netFails = 0;
    let lastErr = '';
    let anyResults = [];
    for (const c of codes) {
      const r = await lookupCode(c, log);
      netFails += r.netFails;
      lastErr = r.lastErr || lastErr;
      if (r.results.length) {
        anyResults = anyResults.concat(r.results);
        if (r.results.some((x) => x.actresses && x.actresses.length)) {
          out.code = c;
          break;
        }
      }
    }
    out.sources = anyResults;
    const hit = anyResults.find((r) => r.actresses && r.actresses.length);
    if (hit) {
      out.actresses = hit.actresses;
      out.title = hit.title;
    } else if (anyResults.length) {
      out.title = anyResults[0].title;
    } else if (netFails) {
      out.error = '番号识别到了（' + codes.join(' / ') + '），但数据源全都连不上：' + lastErr;
    }
    return out;
  } catch (e) {
    out.error = (e && e.message) || String(e);
    return out;
  }
}

/** 多条输入（按行 / 逗号 / 空格拆） */
export function splitInputs(text) {
  const out = [];
  for (const raw of String(text || '').split(/[\n,;、]+/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;

    // 1) 网址：整行当成一个
    if (/^https?:\/\//i.test(line)) { out.push(line); continue; }

    // 2) 「字母 + 空格/点/下划线 + 数字」本来就是同一个番号：miad 984 / miad.984 / MIDA_984 / miad 984.mkv
    const m = line.match(/^([0-9]{0,3}[A-Za-z]{2,7})[ _.\-]+([0-9]{2,7})([^0-9].*)?$/);
    if (m && !/[0-9]/.test(m[3] || '')) {
      out.push(m[1] + '-' + m[2]);
      continue;
    }

    // 3) 其它：按空格拆（一行里确实有多个番号/链接）
    for (const t of line.split(' ')) if (t) out.push(t);
  }
  return out;
}

export async function queryMany(text, onOne, log = () => {}) {
  const items = splitInputs(text);
  const outs = [];
  for (const it of items) {
    const o = await query(it, log);
    outs.push(o);
    if (onOne) onOne(o, outs.length, items.length);
  }
  return outs;
}
