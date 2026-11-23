// Stand-in for the extension's background worker, so content.js can run from a bookmark on a phone.
// Everything stays in this store's localStorage. The only requests are to this store and the shared list.
(() => {
  if (window.__dealFinder) {
    const old = document.getElementById('deal-finder-root');
    if (old) { old.style.display = ''; return; }
  }
  const P = 'dealfinder:';
  const read = (k, d) => { try { const v = JSON.parse(localStorage.getItem(P + k)); return v ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(P + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };
  const host = location.host.toLowerCase().replace(/^www\./, '');
  const LIST_URL = 'https://raw.githubusercontent.com/Aaronlb912/deal-finder/main/data/codes.json';
  const PATHS = ['/', '/pages/promotions', '/promotions', '/offers'];
  const SKIP = /(^|\.)(amazon|walmart|target)\.[a-z.]+$/;

  async function sharedList() {
    const c = read('list', null);
    if (c && Date.now() - c.at < (c.failed ? 3600000 : 86400000)) return c.data;
    try {
      const res = await fetch(LIST_URL, { credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!res.ok) throw new Error();
      const data = globalThis.DF_cleanList(JSON.parse((await res.text()).slice(0, 1000000)));
      if (!data) throw new Error();
      write('list', { at: Date.now(), data });
      return data;
    } catch {
      write('list', { at: Date.now(), failed: true, data: c?.data || null });
      return c?.data || null; // keep the last good copy
    }
  }

  // Simple robots.txt check for the * group: longest matching rule wins.
  async function robotsRules() {
    try {
      const res = await fetch('/robots.txt', { credentials: 'omit' });
      if (res.status === 404) return [];
      if (!res.ok) return null;
      const rules = [];
      let mine = false;
      for (const raw of (await res.text()).split(/\r?\n/)) {
        const m = raw.replace(/#.*/, '').trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
        if (!m) continue;
        const f = m[1].toLowerCase();
        if (f === 'user-agent') mine = m[2].trim() === '*';
        else if (mine && (f === 'allow' || f === 'disallow') && m[2].trim()) rules.push({ allow: f === 'allow', path: m[2].trim() });
      }
      return rules;
    } catch { return null; }
  }
  const allowed = (rules, p) => {
    let best = null;
    for (const r of rules) {
      const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (re.test(p) && (!best || r.path.length > best.path.length)) best = r;
    }
    return !best || best.allow;
  };

  async function storeCodes() {
    const hit = read('store:' + host, null);
    if (hit && Date.now() - hit.at < 12 * 3600000) return hit;
    const rules = await robotsRules();
    if (!rules) return { codes: [], errors: ["couldn't read this store's robots.txt"] };
    const found = new Map();
    for (const p of PATHS) {
      if (!allowed(rules, p)) continue;
      try {
        const res = await fetch(p, { credentials: 'omit' });
        if (!res.ok || new URL(res.url).origin !== location.origin || !/text\/html/i.test(res.headers.get('content-type') || '')) continue;
        const html = (await res.text()).slice(0, 1500000);
        const doc = new DOMParser().parseFromString(html, 'text/html');
        doc.querySelectorAll('script,style').forEach((n) => n.remove());
        for (const c of globalThis.DF_extractCodes(doc.body?.textContent || '', html)) if (!found.has(c.code)) found.set(c.code, c);
      } catch { /* one page failing is fine */ }
    }
    const out = { at: Date.now(), codes: [...found.values()], errors: [] };
    write('store:' + host, out);
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
    const list = await sharedList();
    for (const c of list?.stores?.[host] || []) add(c.code, 'open list', c.note, c.checked);
    let storeErrors = [];
    if (!skipStore && !SKIP.test(host)) {
      const r = await storeCodes();
      storeErrors = r.errors;
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

  const handlers = { collectCodes, saveRun, recordPrice: () => null };
  globalThis.chrome = {
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

  // Tapped somewhere with no promo box: say so instead of doing nothing.
  setTimeout(() => {
    if (document.getElementById('deal-finder-root')) return;
    const n = document.createElement('div');
    n.setAttribute('role', 'status');
    n.textContent = 'Deal Finder: no promo code box on this page yet. Open your cart or checkout and tap the bookmark again.';
    n.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;background:#14532d;color:#fff;font:15px/1.4 system-ui,sans-serif;padding:14px 16px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.25)';
    n.onclick = () => n.remove();
    document.documentElement.append(n);
    setTimeout(() => n.remove(), 7000);
  }, 4000);
})();
