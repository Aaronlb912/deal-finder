(() => {
  if (window.__dealFinder) return;
  window.__dealFinder = true;

  const HOST = location.host.toLowerCase().replace(/^www\./, '');
  const RUN_KEY = 'run:' + HOST;
  const RUN_STALE_MS = 3 * 60 * 1000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'no response' });
        });
      } catch (e) {
        resolve({ ok: false, error: 'Extension was reloaded. Refresh this page.' });
      }
    });
  }

  // ---------- money ----------
  const MONEY_RE = /(?:([$€£¥₹]|USD|CAD|AUD|EUR|GBP|US\$|C\$|A\$)\s?)(\d{1,3}(?:[,.\s ]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d{1,3}(?:[.\s ]\d{3})*(?:,\d{2})|\d+(?:[.,]\d{2}))\s?(€|£|USD|EUR|GBP|CAD)/g;

  function toNumber(s) {
    s = s.replace(/[\s ]/g, '');
    if (/,\d{1,2}$/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }

  function moneyIn(text) {
    const out = [];
    MONEY_RE.lastIndex = 0;
    let m;
    while ((m = MONEY_RE.exec(text))) {
      const n = toNumber(m[2] || m[3]);
      if (n !== null) out.push({ value: n, symbol: m[1] || m[4] });
    }
    return out;
  }

  let currencySymbol = '$';
  function fmt(n) {
    const v = Math.abs(n).toFixed(2);
    return /^[A-Z]/.test(currencySymbol) ? `${v} ${currencySymbol}` : `${currencySymbol}${v}`;
  }

  // ---------- visibility ----------
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity || '1') > 0.05;
  }

  function labelText(el) {
    let t = [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('autocomplete'), el.className]
      .filter(Boolean)
      .join(' ');
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) t += ' ' + lab.textContent;
    }
    const wrap = el.closest('label');
    if (wrap) t += ' ' + wrap.textContent;
    const by = el.getAttribute('aria-labelledby');
    if (by) for (const id of by.split(/\s+/)) t += ' ' + (document.getElementById(id)?.textContent || '');
    return t;
  }

  const COUPON_RE = /(promo|coupon|discount|voucher|reduction|offer.?code|promotion)/i;
  const NOT_COUPON_RE = /(e-?mail|zip|postal|search|card.?number|cc-|cvv|cvc|newsletter|phone|address|city|password|quantity|qty)/i;

  const STORE_INPUTS = [
    'input[name="reductions"]', // Shopify checkout
    'input[name="discount"]',
    '#coupon_code', // WooCommerce, Magento
    'input[name="coupon_code"]',
    '#couponcode', // BigCommerce
    'input[name="couponcode"]',
    'input[name="checkout[reduction_code]"]'
  ];

  function findCouponInput(includeHidden) {
    const seen = new Set();
    const pick = [];
    for (const sel of STORE_INPUTS) document.querySelectorAll(sel).forEach((el) => seen.has(el) || (seen.add(el), pick.push(el)));
    for (const el of document.querySelectorAll('input:not([type]),input[type="text"],input[type="search"]')) {
      if (seen.has(el)) continue;
      const t = labelText(el);
      if (COUPON_RE.test(t) && !NOT_COUPON_RE.test(t.replace(/gift.?card/gi, ''))) pick.push(el);
    }
    const vis = pick.filter(visible);
    if (vis.length) return vis[0];
    return includeHidden ? pick[0] || null : null;
  }

  function findCouponToggle() {
    const els = document.querySelectorAll('button,a,summary,[role="button"],[aria-expanded]');
    for (const el of els) {
      const t = (el.textContent || '').trim();
      if (t.length < 60 && /(have a|add|enter|apply|use).{0,20}(promo|coupon|discount|voucher) ?code|gift card or discount code/i.test(t) && visible(el)) return el;
    }
    return null;
  }

  function nearbyButton(input) {
    const BTN = /^(apply|redeem|submit|add|use|go|ok|✓|apply code|apply coupon|apply discount)$/i;
    let node = input.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const btns = [...node.querySelectorAll('button,input[type="submit"],[role="button"]')].filter((b) => b !== input);
      const hit = btns.find((b) => BTN.test((b.textContent || b.value || '').trim()) || /apply/i.test(b.getAttribute('aria-label') || ''));
      if (hit) return hit;
    }
    return null;
  }

  function setValue(input, value) {
    input.focus();
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- totals ----------
  const TOTAL_SELECTORS = [
    '.order-total .woocommerce-Price-amount',
    '.wc-block-components-totals-footer-item .wc-block-components-totals-item__value',
    '.grand.totals .price',
    '.cart-total-grandTotal .cart-priceItem-value',
    '[data-test="cart-price-value"]',
    '.payment-due__price',
    '[data-checkout-payment-due-target]'
  ];

  function rowAmount(labelEl) {
    let node = labelEl;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const text = node.innerText || '';
      if (text.length > 300) break;
      const amounts = moneyIn(text);
      if (amounts.length) return amounts[amounts.length - 1];
    }
    return null;
  }

  function readTotal() {
    for (const sel of TOTAL_SELECTORS) {
      const els = [...document.querySelectorAll(sel)].filter(visible);
      const el = els[els.length - 1];
      if (el) {
        const a = moneyIn(el.innerText || el.textContent || '');
        if (a.length) return { ...a[a.length - 1], kind: 'total' };
      }
    }
    let total = null;
    let subtotal = null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue.trim();
      if (!t || t.length > 40) continue;
      const el = n.parentElement;
      if (!el || el.closest('#deal-finder-root') || !visible(el)) continue;
      if (/^(order |estimated |grand |cart |your )?total( due| price| \(.*\))?:?$/i.test(t)) {
        const a = rowAmount(el);
        if (a) total = a; // keep the last one on the page: summaries usually end with the total
      } else if (!subtotal && /^(sub-?total|items? subtotal)( \(.*\))?:?$/i.test(t)) {
        const a = rowAmount(el);
        if (a) subtotal = a;
      }
    }
    if (total) return { ...total, kind: 'total' };
    if (subtotal) return { ...subtotal, kind: 'subtotal' };
    return null;
  }

  // ---------- applied-code removal and error text ----------
  function findRemoveButton(code) {
    // Only ever remove the code we are working with, never a discount the shopper applied.
    if (!code) return null;
    const hasCode = (el) => {
      for (let n = el, d = 0; n && d < 4; n = n.parentElement, d++) {
        const t = `${n.getAttribute?.('aria-label') || ''} ${n.getAttribute?.('data-coupon') || ''} ${n.innerText || ''}`.toUpperCase();
        if (new RegExp('(^|[^A-Z0-9_-])' + code.replace(/[^A-Z0-9_-]/g, '') + '($|[^A-Z0-9_-])').test(t)) return true;
        if (t.length > 200) break;
      }
      return false;
    };
    for (const direct of document.querySelectorAll(
      'a.woocommerce-remove-coupon, .wc-block-components-chip__remove, #discount-coupon-form button.cancel, button[aria-label*="Remove discount" i], button[aria-label*="Remove coupon" i], button[aria-label*="Remove promo" i]'
    )) if (visible(direct) && hasCode(direct)) return direct;
    const word = new RegExp('(^|[^A-Z0-9_-])' + code.replace(/[^A-Z0-9_-]/g, '') + '($|[^A-Z0-9_-])');
    const LINE_ITEM = '[class*="line-item" i],[class*="lineitem" i],[class*="cart-item" i],[class*="cart_item" i],tr.cart_item,[data-cart-item],[class*="product-item" i]';
    const cands = document.querySelectorAll('button,a,[role="button"]');
    for (const el of cands) {
      if (!visible(el) || el.closest('#deal-finder-root') || el.closest(LINE_ITEM)) continue;
      const label = `${el.getAttribute('aria-label') || ''} ${el.title || ''} ${(el.textContent || '').trim()}`;
      if (!/remove|delete|×|✕/i.test(label) || /item|product|cart|bag/i.test(label)) continue;
      const named = word.test(label.toUpperCase());
      if (named && /discount|coupon|promo|code|reduction/i.test(label)) return el;
      // the chip that shows the applied code: a small box holding the code and this button, and no price
      for (let node = el.parentElement, d = 0; node && d < 3; node = node.parentElement, d++) {
        const t = (node.innerText || '').toUpperCase();
        if (t.length > 60) break;
        if (word.test(t) && !/\d[.,]\d\d/.test(t)) return el;
      }
    }
    return null;
  }

  function errorNear(input) {
    if (!input) return '';
    let node = input.parentElement;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
      const errs = node.querySelectorAll('[role="alert"],[aria-live],.error,.errors,[class*="error" i],[class*="invalid" i],[id*="error" i]');
      for (const e of errs) {
        const t = (e.innerText || '').trim();
        if (t && t.length < 200 && visible(e) && /(invalid|not valid|isn't valid|expired|not applicable|cannot|can't|unable|doesn't|does not|not eligible|minimum|enter a valid|not found|isn’t|couldn|cannot be applied|requirements|not met|only applies|not available)/i.test(t)) return t.split('\n')[0];
      }
    }
    const woo = document.querySelector('.woocommerce-error, .woocommerce-NoticeGroup .woocommerce-error, .message-error');
    if (woo && visible(woo)) return woo.innerText.trim().split('\n')[0].slice(0, 160);
    return '';
  }

  async function waitFor(check, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = check();
      if (v) return v;
      await sleep(250);
    }
    return null;
  }

  // ---------- run state (survives full page reloads on stores that submit forms) ----------
  // sessionStorage is per tab, so a run never leaks into another tab on the same store
  async function loadRun() {
    let run = null;
    try { run = JSON.parse(sessionStorage.getItem(RUN_KEY) || 'null'); } catch { run = null; }
    if (run && Date.now() - run.updated > RUN_STALE_MS) {
      sessionStorage.removeItem(RUN_KEY);
      return null;
    }
    return run;
  }
  async function saveRunState(run) {
    run.updated = Date.now();
    try { sessionStorage.setItem(RUN_KEY, JSON.stringify(run)); } catch { /* storage full or blocked */ }
  }
  async function clearRun() {
    sessionStorage.removeItem(RUN_KEY);
  }

  // ---------- panel ----------
  const MAX_CODES = 15;
  const DISMISS_MS = 7 * 24 * 3600000;
  let panel = null;
  let codes = [];
  let storeErrors = [];
  let lastRun = null;
  let running = false;
  let stopRequested = false;
  let dismissed = false;

  async function loadDismissed() {
    const { dismissed: d = {} } = await chrome.storage.local.get('dismissed');
    dismissed = !!d[HOST] && Date.now() - d[HOST] < DISMISS_MS;
  }
  async function saveDismissed(on) {
    const { dismissed: d = {} } = await chrome.storage.local.get('dismissed');
    if (on) d[HOST] = Date.now();
    else delete d[HOST];
    for (const k of Object.keys(d)) if (Date.now() - d[k] > DISMISS_MS) delete d[k];
    await chrome.storage.local.set({ dismissed: d });
  }

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }

  const CSS_TEXT = `
    :host { all: initial; }
    .card { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; width: 300px; max-width: calc(100vw - 32px);
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg);
      border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden; }
    .card { --bg:#fff; --fg:#1b1d21; --muted:#5f6670; --line:#e3e5e8; --accent:#0f7a4a; --accent-fg:#fff; --bad:#b42318; --soft:#f3f6f4; }
    @media (prefers-color-scheme: dark) { .card { --bg:#1d2024; --fg:#eef0f2; --muted:#a3aab3; --line:#353a40; --accent:#3ccf8e; --accent-fg:#0b1f15; --bad:#ff8a80; --soft:#262a2f; } }
    .head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--line); }
    .logo { width:18px; height:18px; border-radius:5px; background:var(--accent); color:var(--accent-fg); font-weight:700; font-size:12px; display:grid; place-items:center; }
    .title { font-weight:600; flex:1; }
    .x { all:unset; cursor:pointer; color:var(--muted); padding:2px 6px; border-radius:6px; font-size:16px; line-height:1; }
    .x:hover, .x:focus-visible { background:var(--soft); outline:2px solid var(--accent); }
    .body { padding:12px; }
    .lead { margin:0 0 10px; }
    .muted { color:var(--muted); font-size:12px; }
    .btn { all:unset; box-sizing:border-box; display:block; width:100%; text-align:center; cursor:pointer; padding:9px 12px; border-radius:8px;
      background:var(--accent); color:var(--accent-fg); font-weight:600; }
    .btn.ghost { background:transparent; color:var(--fg); border:1px solid var(--line); font-weight:500; margin-top:8px; }
    .btn:focus-visible { outline:2px solid var(--fg); outline-offset:2px; }
    .bar { height:4px; background:var(--soft); border-radius:4px; overflow:hidden; margin:8px 0; }
    .bar > i { display:block; height:100%; background:var(--accent); width:0; transition: width .3s ease; }
    .reduce .bar > i { transition:none; }
    ul { list-style:none; margin:8px 0 0; padding:0; max-height:180px; overflow:auto; }
    li { display:flex; justify-content:space-between; gap:8px; padding:5px 0; border-top:1px solid var(--line); font-size:13px; }
    li:first-child { border-top:0; }
    code { font: 600 12px ui-monospace, SFMono-Regular, Consolas, monospace; }
    .good { color:var(--accent); font-weight:600; }
    .bad { color:var(--bad); }
    .note { font-size:12px; color:var(--muted); text-align:right; max-width:65%; }
    .err { color:var(--bad); font-size:12px; margin:8px 0 0; }
    .best { background:var(--soft); border-radius:8px; padding:8px 10px; margin-bottom:8px; }
    .sr { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  `;

  function ensurePanel() {
    if (panel) return panel;
    const host = document.createElement('div');
    host.id = 'deal-finder-root';
    const root = host.attachShadow({ mode: 'open' });
    root.append(el('style', {}, CSS_TEXT));
    const card = el('div', { class: 'card' + (reduceMotion ? ' reduce' : ''), role: 'region', 'aria-label': 'Deal Finder coupons' });
    // one live region that stays in place, so screen readers hear each update
    const live = el('div', { class: 'sr', 'aria-live': 'polite', role: 'status' });
    const content = el('div');
    card.append(live, content);
    root.append(card);
    document.documentElement.append(host);
    panel = { host, card, content, live };
    return panel;
  }

  function announce(text) {
    if (panel) panel.live.textContent = text;
  }

  function header() {
    return el(
      'div',
      { class: 'head' },
      el('div', { class: 'logo', 'aria-hidden': 'true' }, '%'),
      el('div', { class: 'title' }, 'Deal Finder'),
      el('button', {
        class: 'x',
        'aria-label': running ? 'Stop' : 'Hide on this store for a week',
        title: running ? 'Stop' : 'Hide on this store for a week',
        onclick: () => {
          if (running) { stopRequested = true; return; }
          dismissed = true;
          saveDismissed(true);
          panel?.host.remove();
          panel = null;
        }
      }, '×')
    );
  }

  function resultRow(r) {
    let right;
    if (r.status === 'saved') right = el('span', { class: 'good' }, `−${fmt(r.saved)}`);
    else if (r.status === 'rejected') right = el('span', { class: 'note bad' }, r.message ? `Rejected: ${r.message.slice(0, 90)}` : 'Rejected');
    else if (r.status === 'error') right = el('span', { class: 'note bad' }, r.message || 'Error');
    else right = el('span', { class: 'note' }, r.message || 'No change');
    return el('li', {}, el('code', {}, r.code), right);
  }

  function render(view) {
    if (dismissed && !running && view.kind !== 'done') return;
    const { content } = ensurePanel();
    content.replaceChildren(header());
    const body = el('div', { class: 'body' });
    content.append(body);

    if (view.kind === 'ready') {
      if (!codes.length) {
        body.append(
          el('p', { class: 'lead' }, view.loading ? 'Looking for codes…' : 'No codes found for this store yet.'),
          view.loading ? null : el('p', { class: 'muted' }, 'Got one by email? Open Deal Finder from the toolbar and add it. It will be tried here.')
        );
      } else {
        const n = Math.min(codes.length, MAX_CODES);
        body.append(
          el('p', { class: 'lead' }, `${codes.length} code${codes.length === 1 ? '' : 's'} for ${HOST}${view.loading ? ', still looking…' : '.'}`),
          el('button', { class: 'btn', onclick: () => startRun() }, n === 1 ? 'Try 1 code' : `Try ${n} codes`),
          el('p', { class: 'muted', style: 'margin:8px 0 0' }, codes.length > MAX_CODES ? `Tries the ${MAX_CODES} most likely first. The best one stays applied.` : 'Tried one at a time. The best one stays applied.')
        );
      }
      for (const e of storeErrors.slice(0, 1)) body.append(el('p', { class: 'muted' }, `Store lookup: ${e}`));
      announce(view.loading ? 'Looking for codes' : `${codes.length} codes found`);
    } else if (view.kind === 'running') {
      const pct = Math.round((view.i / view.n) * 100);
      body.append(
        el('p', { class: 'lead' }, `Trying ${view.code} (${view.i + 1} of ${view.n})`),
        el('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Codes tried', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('i', { style: `width:${pct}%` })),
        el('ul', {}, view.results.map(resultRow)),
        el('button', { class: 'btn ghost', onclick: (e) => { stopRequested = true; e.currentTarget.textContent = 'Stopping…'; } }, 'Stop')
      );
      announce(`Trying code ${view.i + 1} of ${view.n}`);
    } else if (view.kind === 'done') {
      const run = view.run;
      let summary;
      if (run.best) {
        summary = `${run.best.code} saved ${fmt(run.best.saved)}. ${run.bestApplied ? 'Applied to your order.' : 'Could not re-apply it. Enter it yourself.'}`;
        body.append(
          el('div', { class: 'best' },
            el('div', {}, el('code', {}, run.best.code), ` saved `, el('span', { class: 'good' }, fmt(run.best.saved))),
            el('div', { class: 'muted' }, run.bestApplied ? 'Applied to your order.' : 'Could not re-apply it. Enter it yourself.')
          )
        );
      } else if (!run.error) {
        summary = run.results.length === 1 ? 'That code did not lower the total here.' : `None of the ${run.results.length} codes lowered the total here.`;
        body.append(el('p', { class: 'lead' }, summary));
      }
      if (run.stopped) body.append(el('p', { class: 'muted' }, `Stopped after ${run.results.length} of ${run.codes ? run.codes.length : run.results.length}.`));
      if (run.error) body.append(el('p', { class: 'err', role: 'alert' }, run.error));
      if (run.results.length) body.append(el('ul', {}, [...run.results].sort((a, b) => (b.saved || 0) - (a.saved || 0)).map(resultRow)));
      body.append(el('p', { class: 'muted', style: 'margin:8px 0 0' }, `Measured on the ${run.totalKind || 'total'} shown on this page.`));
      announce(summary || run.error || 'Done');
    }
  }

  // ---------- the runner ----------
  async function revealInput() {
    let input = findCouponInput(false);
    if (input) return input;
    const toggle = findCouponToggle();
    if (toggle) {
      toggle.click();
      input = await waitFor(() => findCouponInput(false), 3000);
    }
    return input;
  }

  // Shipping and tax often load after the page: wait until the total holds still for 1s.
  async function stableTotal(ms = 6000) {
    const end = Date.now() + ms;
    let last = readTotal();
    let since = Date.now();
    while (Date.now() < end) {
      await sleep(250);
      const t = readTotal();
      if (!t) { last = null; continue; }
      if (last && Math.abs(t.value - last.value) < 0.01) {
        if (Date.now() - since >= 1000) return t;
      } else since = Date.now();
      last = t;
    }
    return last;
  }

  async function startRun() {
    if (running || !codes.length) return;
    running = true;
    stopRequested = false;
    dismissed = false;
    const run = { codes: codes.slice(0, MAX_CODES).map((c) => c.code), i: 0, results: [], phase: 'trying', started: Date.now() };
    render({ kind: 'running', code: run.codes[0], i: 0, n: run.codes.length, results: [] });
    try {
      const input = await revealInput();
      if (!input) throw new Error("Couldn't find the promo code box on this page.");
      // a code we are about to try is already applied: take it off so every code is measured from the same total
      for (const c of run.codes) {
        const stale = findRemoveButton(c);
        if (!stale) continue;
        const before = readTotal();
        stale.click();
        await waitFor(() => { const t = readTotal(); return t && before && t.value !== before.value; }, 6000);
      }
      const t = await stableTotal();
      if (!t) throw new Error("Couldn't read the order total on this page, so savings can't be measured.");
      currencySymbol = t.symbol || currencySymbol;
      run.baseline = t.value;
      run.totalKind = t.kind;
      run.symbol = currencySymbol;
      await saveRunState(run);
      await continueRun(run);
    } catch (e) {
      run.error = e.message;
      await finish(run);
    }
  }

  async function measure(run, code) {
    const before = run.baseline;
    const prevErr = run.prevErr || '';
    // a message only counts if it is new since we pressed Apply, or names this code
    const freshErr = () => {
      const e = errorNear(findCouponInput(true));
      return e && (e !== prevErr || e.toUpperCase().includes(code)) ? e : '';
    };
    const changed = await waitFor(() => {
      const t = readTotal();
      if (t && Math.abs(t.value - before) > 0.009) return { t };
      const err = freshErr();
      return err ? { err } : null;
    }, 8000);
    const t = await stableTotal(2500);
    if (t && before - t.value > 0.009) return { code, status: 'saved', saved: +(before - t.value).toFixed(2), total: t.value };
    const err = (changed && changed.err) || freshErr();
    if (err) return { code, status: 'rejected', message: err };
    if (t && t.value - before > 0.009) return { code, status: 'none', message: 'Total went up' };
    return { code, status: 'none' };
  }

  async function removeCode(run, code) {
    const btn = findRemoveButton(code);
    if (!btn) return false;
    run.phase = 'removing';
    await saveRunState(run);
    btn.click();
    const back = await waitFor(() => {
      const t = readTotal();
      return t && Math.abs(t.value - run.baseline) < 0.01;
    }, 8000);
    run.phase = 'trying';
    await saveRunState(run);
    return !!back;
  }

  // Returns '' on success or an error message. Never submits a form that holds other fields.
  async function submitCode(run, code) {
    const input = await revealInput();
    if (!input) return 'Promo box disappeared';
    setValue(input, '');
    setValue(input, code);
    let btn = nearbyButton(input);
    if (btn && btn.disabled) await waitFor(() => !btn.disabled, 1500);
    run.prevErr = errorNear(input);
    run.pending = code;
    await saveRunState(run);
    if (btn && !btn.disabled) {
      btn.click();
      return '';
    }
    const form = input.form;
    const soleField = form && [...form.querySelectorAll('input,select,textarea')].filter((x) => x.type !== 'hidden' && x !== input).length === 0;
    if (soleField) {
      form.requestSubmit();
      return '';
    }
    run.pending = null;
    await saveRunState(run);
    return "Couldn't find the Apply button";
  }

  async function continueRun(run) {
    running = true;
    currencySymbol = run.symbol || currencySymbol;
    while (run.phase === 'trying' || run.phase === 'removing') {
      if (run.phase === 'removing') {
        // page reloaded mid-removal: check we are back at baseline
        const t = await stableTotal(5000);
        if (!t || Math.abs(t.value - run.baseline) > 0.01) {
          run.error = 'The store kept a code applied, so the remaining codes were not tried.';
          break;
        }
        run.phase = 'trying';
      }
      if (run.pending) {
        const r = await measure(run, run.pending);
        run.results.push(r);
        run.pending = null;
        run.i++;
        await saveRunState(run);
        if (r.status !== 'saved' && findRemoveButton(r.code)) {
          // applied without lowering the total (free shipping, say): take it off so it can't block the next codes
          await removeCode(run, r.code);
        }
        if (r.status === 'saved') {
          const ok = await removeCode(run, r.code);
          if (!ok) {
            const best = bestOf(run);
            run.error = best && best.code === r.code ? null : 'The store kept a code applied, so the remaining codes were not tried.';
            run.keptApplied = r.code;
            break;
          }
        }
        continue;
      }
      if (stopRequested) { run.stopped = true; break; }
      if (run.i >= run.codes.length) break;
      // every code must start from the same total, or its savings would be wrong
      const now = await stableTotal(3000);
      if (!now || Math.abs(now.value - run.baseline) > 0.01) {
        run.error = 'The order total changed during the run, so the remaining codes were not tried.';
        break;
      }
      const code = run.codes[run.i];
      render({ kind: 'running', code, i: run.i, n: run.codes.length, results: run.results });
      const err = await submitCode(run, code);
      if (err) {
        run.results.push({ code, status: 'error', message: err });
        run.i++;
        if (/Apply button|disappeared/.test(err)) { run.error = err + ', so the remaining codes were not tried.'; break; }
      }
    }
    await applyBest(run);
  }

  function bestOf(run) {
    return run.results.filter((r) => r.status === 'saved').sort((a, b) => b.saved - a.saved)[0] || null;
  }

  async function applyBest(run) {
    run.best = bestOf(run);
    if (run.best) {
      if (run.keptApplied === run.best.code) run.bestApplied = true;
      else {
        run.phase = 'applying';
        run.pending = null;
        await saveRunState(run);
        await submitCode({ ...run, phase: 'applying' }, run.best.code);
        const t = await waitFor(() => {
          const x = readTotal();
          return x && Math.abs(x.value - (run.baseline - run.best.saved)) < 0.01 ? x : null;
        }, 8000);
        run.bestApplied = !!t;
      }
    }
    await finish(run);
  }

  async function finish(run) {
    run.phase = 'done';
    run.finished = Date.now();
    running = false;
    stopRequested = false;
    await clearRun();
    const clean = {
      at: run.finished,
      baseline: run.baseline ?? null,
      totalKind: run.totalKind || null,
      symbol: run.symbol || currencySymbol,
      results: run.results,
      codes: run.codes,
      stopped: !!run.stopped,
      best: run.best || null,
      bestApplied: !!run.bestApplied,
      error: run.error || null
    };
    lastRun = clean;
    await send({ type: 'saveRun', host: HOST, run: clean });
    render({ kind: 'done', run: clean });
  }


  // ---------- product price tracking ----------
  const IS_AMAZON = /(^|\.)amazon\.[a-z.]+$/.test(HOST);

  function amazonAsin() {
    const m = location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/);
    return m ? m[1] : document.querySelector('input#ASIN, input[name="ASIN"]')?.value || null;
  }

  function textMoney(el) {
    if (!el) return null;
    const a = moneyIn(el.textContent || '');
    return a.length ? a[0] : null;
  }

  function amazonProduct() {
    const asin = amazonAsin();
    if (!asin) return null;
    const priceEl = document.querySelector(
      '#corePrice_feature_div .a-offscreen, #corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen, #corePriceDisplay_desktop_feature_div .a-offscreen, .apexPriceToPay .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, #price_inside_buybox'
    );
    const m = textMoney(priceEl);
    if (!m) return null;
    const sym = { $: 'USD', '£': 'GBP', '€': 'EUR', C$: 'CAD' }[m.symbol] || 'USD';
    return {
      name: (document.querySelector('#productTitle')?.textContent || document.title).trim().slice(0, 200),
      price: m.value,
      currency: sym,
      gtin: '',
      brand: (document.querySelector('#bylineInfo')?.textContent || '').replace(/^(visit the|brand:)\s*/i, '').replace(/\s*store$/i, '').trim(),
      key: `${HOST}/dp/${asin}`,
      url: `${location.origin}/dp/${asin}`,
      asin
    };
  }

  // Reads one Amazon offer block: item price + delivery cost + Prime + seller.
  function parseOffer(block, isBuyBox) {
    const price = textMoney(block.querySelector('.a-price .a-offscreen, .apexPriceToPay .a-offscreen'));
    if (!price) return null;
    const text = (block.innerText || '').replace(/\s+/g, ' ');
    let shipping = null;
    const deliv = block.querySelector('[data-csa-c-delivery-price]');
    const dp = deliv?.getAttribute('data-csa-c-delivery-price') || '';
    if (/free/i.test(dp)) shipping = 0;
    else if (dp) shipping = moneyIn(dp)[0]?.value ?? null;
    if (shipping === null) {
      const s = text.match(/(?:\+\s*)?([$£€]\s?\d+(?:[.,]\d{2})?)\s*(?:delivery|shipping)/i);
      if (s) shipping = moneyIn(s[1])[0]?.value ?? null;
      else if (/free (?:delivery|shipping)|FREE (?:Returns|delivery)/i.test(text)) shipping = 0;
    }
    const prime = !!block.querySelector('i.a-icon-prime, .aod-prime-badge, [aria-label*="Prime" i]') || /\bprime\b/i.test(dp);
    let seller = '';
    const soldBy = block.querySelector('#aod-offer-soldBy a, #aod-offer-soldBy .a-col-right .a-size-small, #sellerProfileTriggerId, #merchantInfoFeature_feature_div .offer-display-feature-text-message, #merchant-info a');
    if (soldBy) seller = soldBy.textContent.trim();
    if (!seller && isBuyBox && /sold by amazon/i.test(text)) seller = 'Amazon.com';
    const cond = (block.querySelector('#aod-offer-heading')?.textContent || 'New').trim().replace(/\s+/g, ' ');
    return {
      seller: seller.slice(0, 60) || (isBuyBox ? 'Featured offer' : 'Seller'),
      price: price.value,
      shipping,
      total: +(price.value + (shipping || 0)).toFixed(2),
      prime,
      condition: cond.slice(0, 40),
      buyBox: !!isBuyBox
    };
  }

  function amazonOffersFromPage() {
    const out = [];
    const box = document.querySelector('#buybox, #desktop_buybox, #qualifiedBuybox');
    if (box) {
      const o = parseOffer(box, true);
      if (o) out.push(o);
    }
    for (const b of document.querySelectorAll('#aod-pinned-offer, #aod-offer-list #aod-offer, #aod-offer-list .aod-information-block')) {
      const o = parseOffer(b, false);
      if (o && !out.some((x) => x.seller === o.seller && x.total === o.total && x.condition === o.condition)) out.push(o);
    }
    return out.sort((a, b) => a.total - b.total || Number(b.prime) - Number(a.prime));
  }

  async function amazonLoadAllOffers() {
    if (!document.querySelector('#aod-offer-list')) {
      const link = document.querySelector('#buybox-see-all-buying-choices a, a[href*="aod=1"], #aod-ingress-link, [data-action="show-all-offers-display"] a, #olpLinkWidget_feature_div a');
      if (!link) return { offers: amazonOffersFromPage(), note: 'This item has one seller.' };
      link.click();
      await waitFor(() => document.querySelector('#aod-offer-list #aod-offer, #aod-pinned-offer'), 8000);
      await sleep(800);
    }
    return { offers: amazonOffersFromPage(), note: '' };
  }

  function findProduct() {
    if (IS_AMAZON) return amazonProduct();
    const blocks = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { blocks.push(JSON.parse(s.textContent)); } catch { /* skip bad JSON-LD */ }
    }
    let p = globalThis.DF_productFromLd(blocks);
    if (!p) {
      const og = document.querySelector('meta[property="product:price:amount"],meta[property="og:price:amount"]');
      const price = og ? globalThis.DF_num(og.content) : 0;
      if (price > 0) {
        const cur = document.querySelector('meta[property="product:price:currency"],meta[property="og:price:currency"]');
        p = { name: '', price, currency: cur?.content || '', gtin: '', brand: '' };
      }
    }
    if (!p) return null;
    p.name = p.name || (document.querySelector('meta[property="og:title"]')?.content || document.title).slice(0, 200);
    p.key = HOST + location.pathname.replace(/\/$/, '');
    p.url = location.origin + location.pathname;
    return p;
  }

  let product = null;
  async function trackProduct() {
    product = findProduct();
    if (!product) return;
    await send({ type: 'recordPrice', key: product.key, name: product.name, url: product.url, price: product.price, currency: product.currency });
  }


  // ---------- startup ----------
  let lookedUp = false;
  async function lookup(force, skipStore = false) {
    const text = (document.body?.innerText || '').slice(0, 200000);
    const pageCodes = globalThis.DF_extractCodes(text, document.documentElement.innerHTML.slice(0, 1500000));
    let res = await send({ type: 'collectCodes', origin: location.origin, pageCodes, force: !!force, skipStore });
    // the worker can restart mid-lookup or a redirect can swap the page; one retry hits the cache
    if (!res.ok && /channel closed|Receiving end/i.test(res.error || '')) res = await send({ type: 'collectCodes', origin: location.origin, pageCodes, force: false, skipStore });
    if (res.ok) {
      codes = res.data.codes;
      storeErrors = res.data.storeErrors || [];
    } else {
      storeErrors = [res.error];
    }
    return res;
  }

  async function onCheckoutFound() {
    if (lookedUp) return;
    lookedUp = true;
    await loadDismissed();
    // local codes show at once; store-page codes join when that slower lookup finishes
    await lookup(false, true);
    if (!running) render({ kind: 'ready', loading: true });
    await lookup(false);
    if (!running) render({ kind: 'ready' });
  }

  // A promo box alone is not enough (newsletter and gift card boxes look alike): also need a total or a cart URL.
  function looksLikeCheckout() {
    if (!(findCouponInput(false) || findCouponToggle())) return false;
    return /cart|checkout|basket|bag/i.test(location.pathname) || !!readTotal();
  }

  async function boot() {
    trackProduct();
    const pending = await loadRun();
    // resume only on a page that still has a promo box, so a run never continues on the wrong page
    if (pending && pending.phase !== 'done' && (await waitFor(() => findCouponInput(true) || findCouponToggle(), 6000))) {
      lookedUp = true;
      await waitFor(() => readTotal(), 6000);
      if (pending.phase === 'applying') {
        await applyBest(pending);
      } else {
        await continueRun(pending);
      }
      return;
    }
    if (pending) await clearRun();
    if (looksLikeCheckout()) return onCheckoutFound();
    // single-page checkouts render late: watch for a promo box for up to 30s
    const started = Date.now();
    let timer = null;
    const obs = new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (looksLikeCheckout()) {
          obs.disconnect();
          onCheckoutFound();
        } else if (Date.now() - started > 30000) obs.disconnect();
      }, 700);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 31000);
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg?.type === 'pageInfo') {
      reply({
        host: HOST,
        origin: location.origin,
        hasCouponBox: !!(findCouponInput(false) || findCouponToggle()),
        running,
        codes,
        storeErrors,
        product,
        amazonOffers: IS_AMAZON && product ? amazonOffersFromPage() : null,
        lastRun
      });
      return false;
    }
    if (msg?.type === 'amazonOffers') {
      if (!IS_AMAZON) return reply({ ok: false, error: 'Not an Amazon page.' });
      amazonLoadAllOffers().then((r) => reply({ ok: true, ...r })).catch((e) => reply({ ok: false, error: e.message }));
      return true;
    }
    if (msg?.type === 'tryCodes') {
      (async () => {
        if (!findCouponInput(true) && !findCouponToggle()) return reply({ ok: false, error: 'No promo code box on this page. Go to the cart or checkout page.' });
        dismissed = false;
        saveDismissed(false);
        await lookup(false);
        lookedUp = true;
        if (!codes.length) {
          render({ kind: 'ready' });
          return reply({ ok: false, error: 'No codes found for this store yet. Add one below.' });
        }
        reply({ ok: true });
        startRun();
      })();
      return true;
    }
    return false;
  });

  boot();
})();
