import './extract.js';

const STORE_TTL = 12 * 60 * 60 * 1000;
const ROBOTS_TTL = 24 * 60 * 60 * 1000;
const MIN_GAP_PER_HOST = 2000;
const MAX_FETCHES_PER_HOUR = 40;
const PROMO_PATHS = ['/', '/pages/promotions', '/promotions', '/offers'];
const UA_TOKEN = 'dealfinder';

const ROBOTS_FAIL_TTL = 10 * 60 * 1000;

export function hostKey(host) {
  return String(host || '').toLowerCase().replace(/^www\./, '');
}

async function get(key, fallback) {
  const r = await chrome.storage.local.get(key);
  return r[key] ?? fallback;
}
async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// The open list also lives in the public repo so it can update without a release.
// A plain GET of one static file: no query string, no cookies or referrer. GitHub sees the IP address like any download.
const LIST_URL = 'https://raw.githubusercontent.com/Aaronlb912/deal-finder/main/data/codes.json';
const LIST_TTL = 24 * 60 * 60 * 1000;
const LIST_FAIL_TTL = 60 * 60 * 1000;
const LIST_MAX_BYTES = 1000000;

// Keep only well-formed entries, so a bad remote file can't inject junk.
export function cleanList(data) {
  if (!data || data.version !== 1 || typeof data.stores !== 'object' || Array.isArray(data.stores)) return null;
  const stores = {};
  let n = 0;
  for (const [host, list] of Object.entries(data.stores)) {
    if (!/^[a-z0-9.-]{3,100}$/.test(host) || !Array.isArray(list)) continue;
    const ok = list
      .filter((c) => c && /^[A-Z0-9_-]{4,40}$/.test(String(c.code || '')))
      .slice(0, 30)
      .map((c) => ({ code: c.code, note: String(c.note || '').slice(0, 200), checked: String(c.checked || '').slice(0, 10) }));
    if (ok.length) { stores[host] = ok; n += ok.length; }
    if (n > 20000) break;
  }
  return { version: 1, stores };
}

let bundled = null;
async function loadBundled() {
  if (!bundled) {
    try {
      bundled = cleanList(await (await fetch(chrome.runtime.getURL('data/codes.json'))).json()) || { stores: {} };
    } catch {
      bundled = { stores: {} };
    }
  }
  return bundled;
}

let remoteLoad = null;
async function remoteList() {
  const cached = await get('remoteList', null);
  if (cached && Date.now() - cached.at < (cached.failed ? LIST_FAIL_TTL : LIST_TTL)) return cached.data;
  if (!remoteLoad) {
    remoteLoad = (async () => {
      let data = null;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(LIST_URL, { credentials: 'omit', cache: 'no-cache', referrerPolicy: 'no-referrer', signal: ctrl.signal }).finally(() => clearTimeout(timer));
        if (res.ok) {
          const text = await res.text();
          if (text.length <= LIST_MAX_BYTES) data = cleanList(JSON.parse(text));
        }
      } catch {}
      // on failure keep the last good copy and try again in an hour
      await set('remoteList', data ? { at: Date.now(), data } : { at: Date.now(), failed: true, data: cached?.data || null });
      return data || cached?.data || null;
    })().finally(() => (remoteLoad = null));
  }
  return remoteLoad;
}

async function bundledCodes(host, cachedOnly) {
  const local = (await loadBundled()).stores[host] || [];
  let remote = [];
  try {
    // the quick first pass must not wait on the network
    const list = cachedOnly ? (await get('remoteList', null))?.data : await remoteList();
    remote = list?.stores?.[host] || [];
  } catch {}
  const seen = new Set();
  return [...remote, ...local].filter((c) => !seen.has(c.code) && seen.add(c.code));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Rate state lives in storage.session so a restarted service worker can't reset the limits.
let rateLock = Promise.resolve();
async function reserveSlot(host) {
  const prev = rateLock;
  let release;
  rateLock = new Promise((r) => (release = r));
  await prev;
  try {
    const { rate = { hourly: [], lastHit: {} } } = await chrome.storage.session.get('rate');
    const now = Date.now();
    rate.hourly = rate.hourly.filter((t) => now - t < 3600000);
    if (rate.hourly.length >= MAX_FETCHES_PER_HOUR) throw new Error('rate limit reached, try again later');
    const at = Math.max(now, (rate.lastHit[host] || 0) + MIN_GAP_PER_HOST);
    rate.lastHit[host] = at; // set before sleeping so parallel callers queue behind it
    rate.hourly.push(at);
    await chrome.storage.session.set({ rate });
    return at - now;
  } finally {
    release();
  }
}

async function politeFetch(url) {
  const wait = await reserveSlot(new URL(url).host);
  if (wait > 0) await sleep(wait);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    // credentials omitted: we never send the shopper's cookies along with these lookups
    return await fetch(url, { credentials: 'omit', redirect: 'follow', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function parseRobots(txt) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const val = m[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (field === 'allow' || field === 'disallow')) cur.rules.push({ allow: field === 'allow', path: val });
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => a === UA_TOKEN));
  const star = groups.filter((g) => g.agents.includes('*'));
  return mine ? mine.rules : star.flatMap((g) => g.rules);
}

export function robotsAllows(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!r.path) continue; // empty Disallow means allow all
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

async function robotsFor(origin) {
  const cache = await get('robots', {});
  const hit = cache[origin];
  if (hit && Date.now() - hit.at < (hit.failed ? ROBOTS_FAIL_TTL : ROBOTS_TTL)) return hit.rules;
  let rules = [];
  let failed = false;
  try {
    const res = await politeFetch(origin + '/robots.txt');
    if (res.status === 401 || res.status === 403 || res.status >= 500) { rules = [{ allow: false, path: '/' }]; failed = res.status >= 500; }
    else if (res.ok) rules = parseRobots(await res.text());
  } catch (e) {
    if (/rate limit/.test(e.message)) throw e; // not an answer from the store, so don't cache it
    rules = [{ allow: false, path: '/' }]; // unknown: stay off, and ask again soon
    failed = true;
  }
  cache[origin] = { at: Date.now(), rules, failed };
  for (const k of Object.keys(cache)) if (Date.now() - cache[k].at > ROBOTS_TTL) delete cache[k];
  await set('robots', cache);
  return rules;
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/\s+/g, ' ');
}

// A redirect to another site must pass that site's robots.txt too.
async function redirectAllowed(origin, res) {
  const u = new URL(res.url || origin);
  if (u.origin === origin) return true;
  if (NO_BACKGROUND_CHECK.test(u.host)) return false;
  return robotsAllows(await robotsFor(u.origin), u.pathname);
}

async function storePageCodes(origin, force) {
  const host = hostKey(new URL(origin).host);
  const cache = await get('storeCache', {});
  const hit = cache[host];
  if (!force && hit && Date.now() - hit.at < STORE_TTL) return { codes: hit.codes, errors: hit.errors || [], cached: true };
  const rules = await robotsFor(origin);
  const codes = new Map();
  const errors = [];
  let checked = 0;
  for (const path of PROMO_PATHS) {
    if (!robotsAllows(rules, path)) continue;
    try {
      const res = await politeFetch(origin + path);
      checked++;
      if (!res.ok || !(await redirectAllowed(origin, res))) continue;
      if (!/text\/html/i.test(res.headers.get('content-type') || '')) continue;
      const html = (await res.text()).slice(0, 1500000);
      for (const c of globalThis.DF_extractCodes(htmlToText(html), html)) {
        if (!codes.has(c.code)) codes.set(c.code, { ...c, where: path });
      }
    } catch (e) {
      errors.push(`${path}: ${e.message || 'request failed'}`);
      if (/rate limit/.test(e.message)) break;
    }
  }
  if (!checked && !errors.length) errors.push("this store's robots.txt does not allow reading its pages");
  const list = [...codes.values()];
  cache[host] = { at: Date.now(), codes: list, errors };
  const hosts = Object.keys(cache);
  if (hosts.length > 300) for (const h of hosts.sort((a, b) => cache[a].at - cache[b].at).slice(0, hosts.length - 300)) delete cache[h];
  await set('storeCache', cache);
  return { codes: list, errors, cached: false };
}

// Never fetched in the background: their terms forbid automated access.
const NO_BACKGROUND_CHECK = /(^|\.)(amazon|walmart|target)\.[a-z.]+$/;

async function collectCodes({ origin, pageCodes = [], force = false, skipStore = false }) {
  const host = hostKey(new URL(origin).host);
  const out = new Map();
  const add = (code, source, context, checked) => {
    code = String(code).trim().toUpperCase();
    if (!code || code.length > 40) return;
    const existing = out.get(code);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
    } else out.set(code, { code, sources: [source], context: context || '', checked: checked || '' });
    if (checked && existing && !existing.checked) existing.checked = checked;
  };
  const wins = (await get('wins', {}))[host] || [];
  const user = (await get('userCodes', {}))[host] || [];
  for (const w of wins) add(w.code, 'worked before');
  for (const c of user) add(c, 'added by you');
  for (const c of pageCodes) add(c.code, 'this page', c.context);
  for (const c of await bundledCodes(host, skipStore)) add(c.code, 'open list', c.note, c.checked);
  let storeErrors = [];
  if (NO_BACKGROUND_CHECK.test(host)) skipStore = true;
  if (!skipStore) try {
    const r = await storePageCodes(origin, force);
    storeErrors = r.errors;
    for (const c of r.codes) add(c.code, 'store site', c.context);
  } catch (e) {
    storeErrors = [e.message || 'store lookup failed'];
  }
  const hist = (await get('codeHistory', {}))[host] || {};
  const codes = [...out.values()].map((c) => ({ ...c, hist: hist[c.code] || null }));
  // codes with a track record of working go first, so the best one is usually found early
  const stale = (c) => c.sources.length === 1 && c.sources[0] === 'open list' && c.checked && Date.now() - Date.parse(c.checked) > 30 * 86400000;
  const score = (c) => (c.hist ? c.hist.wins * 10 - (c.hist.tries - c.hist.wins) + (c.hist.lastWorked ? 1 : 0) : 0) - (stale(c) ? 5 : 0);
  codes.sort((a, b) => score(b) - score(a));
  return { host, codes, storeErrors };
}

async function saveRun({ host, run }) {
  host = hostKey(host);
  const runs = await get('lastRun', {});
  runs[host] = run;
  await set('lastRun', runs);
  // per-code track record, shown as "worked 2 of 3 times, last worked ..." on the store page
  const hist = await get('codeHistory', {});
  const h = (hist[host] = hist[host] || {});
  for (const r of run.results || []) {
    const e = (h[r.code] = h[r.code] || { tries: 0, wins: 0, lastTried: 0, lastWorked: 0, bestSaved: 0 });
    e.tries++;
    e.lastTried = run.at;
    if (r.status === 'saved') {
      e.wins++;
      e.lastWorked = run.at;
      e.bestSaved = Math.max(e.bestSaved, r.saved);
    }
    e.lastMessage = r.message || '';
  }
  if (Object.keys(hist).length > 500) delete hist[Object.keys(hist)[0]];
  await set('codeHistory', hist);
  if (run.best && run.bestApplied) {
    const savings = await get('savings', []);
    // re-running on the same cart is the same saving, not a new one
    const dup = savings.some((x) => x.host === host && x.code === run.best.code && x.baseline === run.baseline && run.at - x.at < 86400000);
    if (!dup) {
      savings.unshift({ host, code: run.best.code, saved: run.best.saved, baseline: run.baseline, symbol: run.symbol || '$', at: run.at });
      await set('savings', savings.slice(0, 1000));
    }
  }
  if (run.best && run.best.saved > 0) {
    const wins = await get('wins', {});
    const list = (wins[host] || []).filter((w) => w.code !== run.best.code);
    list.unshift({ code: run.best.code, saved: run.best.saved, at: Date.now() });
    wins[host] = list.slice(0, 10);
    await set('wins', wins);
  }
}

async function addUserCode({ host, code }) {
  host = hostKey(host);
  code = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) throw new Error('Codes use letters, numbers, dashes or underscores (2 to 40 characters).');
  const all = await get('userCodes', {});
  const list = all[host] || [];
  if (!list.includes(code)) list.push(code);
  if (list.length > 50) list.shift();
  all[host] = list;
  await set('userCodes', all);
  return list;
}

async function removeUserCode({ host, code }) {
  host = hostKey(host);
  const all = await get('userCodes', {});
  all[host] = (all[host] || []).filter((c) => c !== code);
  await set('userCodes', all);
  return all[host];
}

async function recordPrice({ key, name, url, price, currency }) {
  if (!(price > 0) || !key) return null;
  const prices = await get('prices', {});
  const item = prices[key] || { name, url, currency, points: [] };
  item.name = name || item.name;
  item.url = url;
  item.currency = currency || item.currency;
  const last = item.points[item.points.length - 1];
  const now = Date.now();
  // one point per 6 hours unless the price moved
  if (!last || last.p !== price || now - last.t > 6 * 3600000) item.points.push({ t: now, p: price });
  if (item.points.length > 200) item.points = item.points.slice(-200);
  item.seen = now;
  prices[key] = item;
  const keys = Object.keys(prices);
  if (keys.length > 500) for (const k of keys.sort((a, b) => prices[a].seen - prices[b].seen).slice(0, keys.length - 500)) delete prices[k];
  await set('prices', prices);
  await checkWatch(key, price, item.currency);
  return item;
}

// ---------- Droplist ----------
// Stores whose terms forbid automated access: watched there, checked only when you visit.


async function addWatch({ key, url, name, target, currency, price }) {
  target = Number(target);
  if (!(target > 0)) throw new Error('Enter a target price above 0.');
  const watches = await get('watches', {});
  if (!watches[key] && Object.keys(watches).length >= 100) throw new Error('Droplist is full (100 items). Remove one first.');
  watches[key] = { ...(watches[key] || {}), key, url, name, target, currency, lastPrice: price || null, lastChecked: Date.now(), addedAt: watches[key]?.addedAt || Date.now() };
  await set('watches', watches);
  await ensureAlarm();
  if (price > 0) await checkWatch(key, price, currency);
  return (await get('watches', {}))[key];
}

async function removeWatch({ key }) {
  const watches = await get('watches', {});
  const removed = watches[key] || null;
  delete watches[key];
  await set('watches', watches);
  return removed;
}

// Undo: put back exactly what was removed, still capped at 100.
async function restoreWatch({ watch }) {
  if (!watch || typeof watch.key !== 'string' || !(Number(watch.target) > 0)) throw new Error('Nothing to restore.');
  const watches = await get('watches', {});
  if (!watches[watch.key] && Object.keys(watches).length >= 100) throw new Error('Droplist is full (100 items).');
  watches[watch.key] = watch;
  await set('watches', watches);
  return true;
}

async function checkWatch(key, price, currency) {
  const watches = await get('watches', {});
  const w = watches[key];
  if (!w) return;
  w.lastPrice = price;
  w.lastChecked = Date.now();
  w.checkError = '';
  if (price <= w.target && w.notifiedPrice !== price) {
    w.notifiedPrice = price;
    const sym = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$', AUD: 'A$' }[currency || w.currency] || '$';
    chrome.notifications.create('watch:' + key, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/128.png'),
      title: 'Price drop: ' + (w.name || 'watched item').slice(0, 60),
      message: `Now ${sym}${price.toFixed(2)}. Your target was ${sym}${w.target.toFixed(2)}.`,
      priority: 1
    });
  }
  if (price > w.target) w.notifiedPrice = null;
  await set('watches', watches);
}

async function checkAllWatches() {
  const watches = await get('watches', {});
  // oldest check first, so a long list can't starve its tail
  for (const w of Object.values(watches).sort((a, b) => (a.lastChecked || 0) - (b.lastChecked || 0))) {
    let host;
    try { host = new URL(w.url).host; } catch { continue; }
    if (NO_BACKGROUND_CHECK.test(host)) continue;
    if (Date.now() - (w.lastChecked || 0) < 5 * 3600000) continue;
    try {
      const origin = new URL(w.url).origin;
      const rules = await robotsFor(origin);
      if (!robotsAllows(rules, new URL(w.url).pathname)) throw new Error('store does not allow automated checks');
      const res = await politeFetch(w.url);
      if (!res.ok) throw new Error('store returned ' + res.status);
      if (!(await redirectAllowed(origin, res))) throw new Error('redirected to a site that does not allow automated checks');
      const p = globalThis.DF_productFromHtml((await res.text()).slice(0, 3000000));
      if (!p) throw new Error('no price found on the page');
      await recordPrice({ key: w.key, name: w.name, url: w.url, price: p.price, currency: p.currency || w.currency });
    } catch (e) {
      if (/rate limit/.test(e.message)) break; // try the rest next round
      const all = await get('watches', {});
      if (all[w.key]) {
        all[w.key].checkError = e.message;
        all[w.key].lastChecked = Date.now();
        await set('watches', all);
      }
    }
  }
}

async function ensureAlarm() {
  if (!(await chrome.alarms.get('droplist'))) chrome.alarms.create('droplist', { periodInMinutes: 360, delayInMinutes: 1 });
}

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'droplist' && !(await get('paused', false))) checkAllWatches();
});
chrome.notifications.onClicked.addListener((id) => {
  if (!id.startsWith('watch:')) return;
  get('watches', {}).then((w) => {
    const item = w[id.slice(6)];
    if (item) chrome.tabs.create({ url: item.url });
    chrome.notifications.clear(id);
  });
});
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);

const handlers = { collectCodes, saveRun, addUserCode, removeUserCode, recordPrice, addWatch, removeWatch, restoreWatch, checkAllWatches: () => checkAllWatches().then(() => true) };

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  fn(msg)
    .then((data) => reply({ ok: true, data }))
    .catch((e) => reply({ ok: false, error: e.message || String(e) }));
  return true;
});
