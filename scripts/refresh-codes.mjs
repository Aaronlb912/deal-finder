// Daily refresh of data/codes.json, run by .github/workflows/refresh-codes.yml.
// Reads only each store's own homepage and promo pages, only where robots.txt allows,
// one request every 2 seconds per store. No aggregator sites, no affiliate links.
// Exits without writing if nothing changed or the result fails validation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIST = path.join(ROOT, 'data/codes.json');
const SOURCES = path.join(ROOT, 'data/sources.json');
const UA = 'dealfinder (+https://github.com/Aaronlb912/deal-finder)';
const PATHS = ['/', '/pages/promotions', '/promotions', '/offers'];
const KEEP_DAYS = 14; // a code not seen on the store's site for this long is dropped
const today = new Date().toISOString().slice(0, 10);

await import(path.join(ROOT, 'src/extract.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
const { DF_extractCodes, DF_cleanList, DF_validCode } = globalThis;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    return await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// Longest-match robots.txt rules for our agent, else for *. Any failure means stay off.
async function robotsRules(origin) {
  let txt;
  try {
    const res = await get(origin + '/robots.txt');
    if (res.status === 404 || res.status === 410) return [];
    if (!res.ok) return null;
    txt = await res.text();
  } catch {
    return null;
  }
  const groups = [];
  let cur = null;
  let lastAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const val = m[2].trim();
    if (field === 'user-agent') {
      if (!lastAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastAgent = true;
    } else {
      lastAgent = false;
      if (cur && field === 'crawl-delay') cur.delay = Math.min(60, parseFloat(val) || 0);
      if (cur && (field === 'allow' || field === 'disallow') && (val || field === 'allow')) cur.rules.push({ allow: field === 'allow', path: val });
    }
  }
  const mine = groups.find((g) => g.agents.includes('dealfinder'));
  const use = mine ? [mine] : groups.filter((g) => g.agents.includes('*'));
  const rules = use.flatMap((g) => g.rules);
  rules.delay = Math.max(0, ...use.map((g) => g.delay || 0));
  return rules;
}

function allowed(rules, p) {
  let best = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(p) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}

const htmlToText = (html) =>
  html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/\s+/g, ' ');

async function codesFor(host) {
  const origin = 'https://' + host;
  const rules = await robotsRules(origin);
  if (!rules) return { error: 'robots.txt unreachable, skipped' };
  const found = new Map();
  const loaded = new Set(); // paths that returned a real page this run
  for (const p of PATHS) {
    if (!allowed(rules, p)) continue;
    await sleep(Math.max(2000, rules.delay * 1000));
    try {
      const res = await get(origin + p);
      if (!res.ok || !/text\/html/i.test(res.headers.get('content-type') || '')) continue;
      const final = new URL(res.url);
      if (final.hostname.replace(/^www\./, '') !== host) continue; // redirected off the store
      if (!allowed(rules, final.pathname + final.search)) continue; // redirected somewhere robots.txt disallows
      const html = (await res.text()).slice(0, 1500000);
      if (html.length < 5000 || /cf-chl|captcha|Access Denied/i.test(html.slice(0, 20000))) continue; // bot wall, not a real page
      loaded.add(p);
      for (const c of DF_extractCodes(htmlToText(html), html)) if (!found.has(c.code)) found.set(c.code, { ...c, where: p });
    } catch {}
  }
  return { codes: [...found.values()], loaded };
}

const old = JSON.parse(fs.readFileSync(LIST, 'utf8'));
const { stores: hosts } = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
// month changes monthly, so the repo gets a commit and GitHub keeps the schedule enabled
const next = { version: 1, about: old.about, month: today.slice(0, 7), stores: {} };
const log = [];

for (const host of hosts) {
  const prev = old.stores[host] || [];
  const r = await codesFor(host);
  const byCode = new Map(prev.map((c) => [c.code, c]));
  if (r.codes) {
    for (const c of r.codes) {
      // same rule as DF_cleanList, per code, so one odd code can't stop the whole refresh
      if (!DF_validCode(c.code)) { log.push(`${host}: skipped ${JSON.stringify(c.code)}`); continue; }
      const where = c.where === '/' ? 'homepage' : c.where;
      const tail = `Seen on ${host} ${where}.`; // kept whole: the next run reads the page back from it
      byCode.set(c.code, { code: c.code, note: `${(c.context || '').replace(/\s+/g, ' ').trim().slice(0, 199 - tail.length)} ${tail}`.trim(), checked: today });
    }
  }
  // A code whose page loaded today but no longer shows it is dropped. If its page failed, keep it for KEEP_DAYS.
  const pageOf = (c) => { const w = (c.note.match(/Seen on \S+ (\S+)\.$/) || [])[1]; return w === 'homepage' ? '/' : w; };
  const keep = [...byCode.values()]
    .filter((c) => c.checked === today || (!r.loaded?.has(pageOf(c)) && (Date.parse(today) - Date.parse(c.checked || '1970-01-01')) / 86400000 <= KEEP_DAYS))
    .slice(0, 30);
  if (keep.length) next.stores[host] = keep;
  log.push(`${host}: ${r.error || `${r.codes.length} seen`}, ${keep.length} kept`);
}

const clean = DF_cleanList(next);
const total = clean ? Object.values(clean.stores).flat().length : 0;
console.log(log.join('\n'));
if (!clean || total !== Object.values(next.stores).flat().length) {
  console.error('validation failed, not writing');
  process.exit(1);
}
const out = JSON.stringify({ version: 1, about: next.about, month: next.month, stores: clean.stores }, null, 2) + '\n';
if (out === fs.readFileSync(LIST, 'utf8')) {
  console.log('no change');
} else {
  fs.writeFileSync(LIST, out);
  console.log(`wrote ${total} codes`);
}
process.exit(0);
