// Stand-in for the extension's background worker, so content.js can run from a bookmark on a phone.
// Everything stays in this store's localStorage. The only requests are to this store and the shared list.
// The build assigns the returned object to a local `chrome`, so the store's own window.chrome is untouched.
(() => {
  let shown = false;
  const notice = (force) => {
    if ((window.__dealFinderFound || shown) && !force) return;
    shown = true;
    const n = document.createElement('div');
    n.setAttribute('role', 'status');
    n.textContent = 'Deal Finder: no promo code box on this page yet. Open your cart or checkout and tap the bookmark again.';
    n.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:2147483647;background:#14532d;color:#fff;font:15px/1.4 system-ui,sans-serif;padding:14px 16px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.25)';
    n.onclick = () => n.remove();
    document.documentElement.append(n);
    setTimeout(() => n.remove(), 7000);
  };
  // Tapped again on the same page: bring the card back (content.js stops itself on a second run).
  if (window.__dealFinder) {
    if (!window.__dealFinderShow?.()) notice(true);
    return null;
  }

  const P = 'dealfinder:';
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(P + k)); return v ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
  const host = location.host.toLowerCase().replace(/^www\./, '');
  const LIST_URL = 'https://raw.githubusercontent.com/Aaronlb912/deal-finder/main/data/codes.json';
  const PATHS = ['/', '/pages/promotions', '/promotions', '/offers'];
  const SKIP = /(^|\.)(amazon|walmart|target)\.[a-z.]+$/;
  const timeout = () => (AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined);

  // Keeps only this store's codes, so the store's own storage doesn't fill up as the list grows.
  let listFailed = false;
  async function sharedList() {
    const c = read('list', null);
    if (c && Date.now() - c.at < (c.failed ? 3600000 : 86400000)) { listFailed = !!c.failed; return c.codes; }
    try {
      const res = await fetch(LIST_URL, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: timeout() });
      if (!res.ok) throw new Error();
      const data = globalThis.DF_cleanList(JSON.parse((await res.text()).slice(0, 1000000)));
      if (!data) throw new Error();
      const codes = data.stores?.[host] || [];
      write('list', { at: Date.now(), codes });
      listFailed = false;
      return codes;
    } catch {
      write('list', { at: Date.now(), failed: true, codes: c?.codes || [] });
      listFailed = true;
      return c?.codes || []; // keep the last good copy
    }
  }

  // Same robots.txt rules as src/background.js (parseRobots, robotsAllows).
  function parseRobots(txt) {
    const groups = [];
    let cur = null;
    let lastWasAgent = false;
    for (const raw of txt.split(/\r?\n/)) {
      const m = raw.replace(/#.*/, '').trim().match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
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
    const mine = groups.find((g) => g.agents.includes('dealfinder'));
    return mine ? mine.rules : groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
  }
  function robotsAllows(rules, path) {
    let best = null;
    for (const r of rules) {
      if (!r.path) continue;
      const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (re.test(path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
    }
    return !best || best.allow;
  }
  async function robotsRules() {
    try {
      const res = await fetch('/robots.txt', { credentials: 'omit', signal: timeout() });
      if (res.status === 404 || res.status === 410) return [];
      if (!res.ok) return null;
      return parseRobots(await res.text());
    } catch { return null; }
  }

  async function storeCodes() {
    const hit = read('store:' + host, null);
    if (hit && Date.now() - hit.at < 12 * 3600000) return hit;
    const rules = await robotsRules();
    if (!rules) return { codes: [], errors: ["couldn't read this store's robots.txt"] };
    const found = new Map();
    let loaded = 0;
    for (const p of PATHS) {
      if (!robotsAllows(rules, p)) continue;
      try {
        const res = await fetch(p, { credentials: 'omit', signal: timeout() });
        const url = new URL(res.url);
        // a redirect can land on a path robots.txt disallows
        if (!res.ok || url.origin !== location.origin || !robotsAllows(rules, url.pathname) || !/text\/html/i.test(res.headers.get('content-type') || '')) continue;
        const html = (await res.text()).slice(0, 1500000);
        loaded++;
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script,style').forEach((n) => n.remove());
        for (const c of globalThis.DF_extractCodes(doc.body?.textContent || '', html)) if (!found.has(c.code)) found.set(c.code, c);
      } catch { /* one page failing is fine */ }
    }
    const out = { at: Date.now(), codes: [...found.values()], errors: [] };
    if (loaded) write('store:' + host, out); // don't remember "no codes" when nothing loaded
    return out;
  }

  async function collectCodes({ pageCodes = [], skipStore }) {
    const out = new Map();
    const add = (code, source, context, checked) => {
      code = String(code).trim().toUpperCase();
      if (!code || code.length > 40) return;
      const e = out.get(code);
      if (e) { if (!e.sources.includes(source)) e.sources.push(source); if (checked && !e.checked) e.checked = checked; }
      else out.set(code, { code, sources: [source], context: context || '', checked: checked || '' });
    };
    for (const w of read('wins', [])) add(w.code, 'worked before');
    for (const c of pageCodes) add(c.code, 'this page', c.context);
    for (const c of await sharedList()) add(c.code, 'open list', c.note, c.checked);
    let storeErrors = listFailed ? ["Couldn't load the shared code list."] : [];
    if (!skipStore && !SKIP.test(host)) {
      const r = await storeCodes();
      storeErrors = storeErrors.concat(r.errors);
      for (const c of r.codes) add(c.code, 'store site', c.context);
    }
    const hist = read('history', {});
    const score = (c) => (c.hist ? c.hist.wins * 10 - (c.hist.tries - c.hist.wins) : 0);
    const codes = [...out.values()].map((c) => ({ ...c, hist: hist[c.code] || null })).sort((a, b) => score(b) - score(a));
    return { host, codes, storeErrors };
  }

  function saveRun({ run }) {
    const hist = read('history', {});
    for (const r of run.results || []) {
      const e = (hist[r.code] = hist[r.code] || { tries: 0, wins: 0, lastTried: 0, lastWorked: 0, bestSaved: 0 });
      e.tries++;
      e.lastTried = run.at;
      if (r.status === 'saved') { e.wins++; e.lastWorked = run.at; e.bestSaved = Math.max(e.bestSaved, r.saved); }
      e.lastMessage = r.message || '';
    }
    write('history', hist);
    if (run.best && run.best.saved > 0) write('wins', [{ code: run.best.code, saved: run.best.saved, at: Date.now() }, ...read('wins', []).filter((w) => w.code !== run.best.code)].slice(0, 10));
  }

  // Tapped somewhere with no promo box: say so instead of doing nothing.
  // content.js sets __dealFinderFound as soon as it sees a checkout, before any slow lookup.
  // Checked again after content.js gives up waiting on a pending run (6s).
  setTimeout(notice, 4000);
  setTimeout(notice, 6500);

  const handlers = { collectCodes, saveRun, recordPrice: () => null };
  return {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        const fn = handlers[msg?.type];
        if (!fn) return cb({ ok: false, error: 'Not available in the phone version.' });
        Promise.resolve(fn(msg)).then((data) => cb({ ok: true, data }), (e) => cb({ ok: false, error: e.message || String(e) }));
      },
      onMessage: { addListener() {} }
    },
    storage: { local: { get: async () => ({}), set: async () => {} } }
  };
})();
