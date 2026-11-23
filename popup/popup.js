const main = document.getElementById('main');
const hostEl = document.getElementById('host');

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}

function money(n, sym) {
  sym = sym || '$';
  const v = Math.abs(n).toFixed(2);
  return /^[A-Z]/.test(sym) ? `${v} ${sym}` : `${sym}${v}`;
}

function curSym(code) {
  return { USD: '$', CAD: 'C$', AUD: 'A$', EUR: '€', GBP: '£', JPY: '¥', INR: '₹' }[code] || (code ? code : '$');
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 48) return `${hr} h ago`;
  return `${Math.round(hr / 24)} days ago`;
}

function bg(msg) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : r || { ok: false, error: 'no response' }))
  );
}
function tabMsg(tabId, msg) {
  return new Promise((resolve) =>
    chrome.tabs.sendMessage(tabId, msg, (r) => resolve(chrome.runtime.lastError ? null : r))
  );
}

function resultRow(r, sym) {
  let right;
  if (r.status === 'saved') right = h('span', { class: 'good' }, `−${money(r.saved, sym)}`);
  else if (r.status === 'rejected') right = h('span', { class: 'src bad' }, r.message ? `Rejected: ${r.message.slice(0, 90)}` : 'Rejected');
  else if (r.status === 'error') right = h('span', { class: 'src bad' }, r.message || 'Error');
  else right = h('span', { class: 'src' }, 'No change');
  return h('li', {}, h('code', {}, r.code), right);
}

function sparkline(points) {
  const W = 300, H = 48, P = 4;
  const ps = points.map((p) => p.p);
  const min = Math.min(...ps), max = Math.max(...ps);
  const span = max - min || 1;
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const xy = points.map((p) => [P + ((p.t - t0) / (t1 - t0 || 1)) * (W - 2 * P), H - P - ((p.p - min) / span) * (H - 2 * P)]);
  if (xy.length === 1) xy.push([W - P, xy[0][1]]);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'spark');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Price from ${min.toFixed(2)} to ${max.toFixed(2)} over ${points.length} visits`);
  const path = document.createElementNS(ns, 'polyline');
  path.setAttribute('points', xy.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'var(--accent)');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function compareLinks(p) {
  const q = encodeURIComponent((p.gtin || [p.brand, p.name].filter(Boolean).join(' ')).slice(0, 120));
  const qn = encodeURIComponent([p.brand, p.name].filter(Boolean).join(' ').slice(0, 120));
  const sites = [
    ['Google Shopping', `https://www.google.com/search?tbm=shop&q=${q}`],
    ['Amazon', `https://www.amazon.com/s?k=${qn}`],
    ['Walmart', `https://www.walmart.com/search?q=${qn}`],
    ['Target', `https://www.target.com/s?searchTerm=${qn}`],
    ['eBay', `https://www.ebay.com/sch/i.html?_nkw=${qn}`]
  ];
  return h('div', { class: 'links' }, sites.map(([name, url]) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, name)));
}

function histText(hst) {
  if (!hst) return 'not tried yet';
  const base = `worked ${hst.wins} of ${hst.tries}`;
  return hst.lastWorked ? `${base}, last ${ago(hst.lastWorked)}` : base;
}

async function globalSections(currentKey) {
  const { savings = [], watches = {} } = await chrome.storage.local.get(['savings', 'watches']);
  const out = [];
  const sav = h('section', {}, h('h2', {}, 'Your savings'));
  if (!savings.length) {
    sav.append(h('p', { class: 'muted', style: 'margin:0' }, 'Nothing saved yet. When a code lowers your total at checkout, it shows up here.'));
  } else {
    const bySym = {};
    for (const x of savings) bySym[x.symbol] = (bySym[x.symbol] || 0) + x.saved;
    const totals = Object.entries(bySym).map(([sym, n]) => money(n, sym)).join(' + ');
    sav.append(
      h('p', { style: 'margin:0 0 6px' }, h('span', { class: 'good', style: 'font-size:18px' }, totals), ` saved across ${savings.length} checkout${savings.length === 1 ? '' : 's'}`),
      h('ul', {}, savings.slice(0, 5).map((x) => h('li', {}, h('span', {}, x.host, ' ', h('code', {}, x.code)), h('span', { class: 'src' }, `${money(x.saved, x.symbol)}, ${ago(x.at)}`)))),
      h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Counts codes Deal Finder left applied. It cannot see whether you placed the order.')
    );
  }
  out.push(sav);
  const list = Object.values(watches).sort((a, b) => b.addedAt - a.addedAt);
  const drop = h('section', {}, h('h2', {}, `Droplist (${list.length})`));
  if (!list.length) {
    drop.append(h('p', { class: 'muted', style: 'margin:0' }, 'Watch a product from its page and set a target price. You get a Chrome notification when it drops.'));
  } else {
    drop.append(h('ul', {}, list.map((w) => {
      const sym = curSym(w.currency);
      const hit = w.lastPrice && w.lastPrice <= w.target;
      return h('li', { title: w.checkError ? 'Last check: ' + w.checkError : '' },
        h('a', { href: w.url, target: '_blank', rel: 'noopener noreferrer', class: 'clip', style: w.key === currentKey ? 'font-weight:600' : '' }, w.name || w.url),
        h('span', { class: 'chip' },
          h('span', { class: hit ? 'good' : 'src' }, `${w.lastPrice ? money(w.lastPrice, sym) : '?'} / ${money(w.target, sym)}`),
          h('button', { 'aria-label': 'Stop watching ' + (w.name || ''), onclick: async () => { await bg({ type: 'removeWatch', key: w.key }); render(); } }, '×')));
    })));
    drop.append(h('p', { class: 'muted', style: 'margin:6px 0 0' }, 'Now / target. Checked every 6 hours where the store allows it, and whenever you visit. Amazon items update only when you visit.'));
  }
  out.push(drop);
  return out;
}

async function render() {
  // ?tab=<id> lets the test script render the popup for a given tab
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (!/^https?:/.test(url)) {
    hostEl.textContent = 'Not a store page';
    main.replaceChildren(
      h('section', {},
        h('p', { style: 'margin:0 0 6px' }, 'Open a store to get started.'),
        h('p', { class: 'muted', style: 'margin:0' }, 'On a cart or checkout page, Deal Finder tries coupon codes for you. On a product page, it tracks the price.')
      ),
      ...(await globalSections(null))
    );
    return;
  }
  const info = await tabMsg(tab.id, { type: 'pageInfo' });
  const host = new URL(url).host.replace(/^www\./, '');
  hostEl.textContent = host;
  if (!info) {
    main.replaceChildren(
      h('section', {},
        h('p', { style: 'margin:0 0 6px' }, 'Deal Finder is not running on this tab yet.'),
        h('p', { class: 'muted', style: 'margin:0 0 10px' }, 'Reload the page so it can look for a promo box and prices.'),
        h('button', { class: 'btn ghost', onclick: () => { chrome.tabs.reload(tab.id); window.close(); } }, 'Reload page')
      ),
      ...(await globalSections(null))
    );
    return;
  }

  const store = await chrome.storage.local.get(['lastRun', 'userCodes', 'prices', 'watches']);
  const lastRun = info.lastRun || store.lastRun?.[host];
  const userCodes = store.userCodes?.[host] || [];
  const sections = [];

  // Coupons
  const coupon = h('section', {}, h('h2', {}, 'Coupons'));
  const status = h('p', { class: 'err', role: 'alert', hidden: '' });
  const showErr = (m) => { status.textContent = m; status.hidden = !m; };
  if (info.running) {
    coupon.append(h('p', { style: 'margin:0' }, 'Trying codes on the page now…'));
  } else if (info.hasCouponBox) {
    const n = info.codes.length;
    coupon.append(
      h('p', { style: 'margin:0 0 8px' }, n ? `${n} code${n === 1 ? '' : 's'} found for this store.` : 'Promo box found. No codes found for this store yet.'),
      h('button', {
        class: 'btn',
        onclick: async (e) => {
          e.target.disabled = true;
          showErr('');
          const r = await tabMsg(tab.id, { type: 'tryCodes' });
          if (r && r.ok) window.close();
          else { showErr(r?.error || 'Could not reach the page. Reload it and try again.'); e.target.disabled = false; }
        }
      }, 'Try codes on this page')
    );
  } else {
    coupon.append(h('p', { class: 'muted', style: 'margin:0' }, 'No promo code box on this page. Codes are tried on the cart or checkout page.'));
  }
  if (info.codes.length) {
    coupon.append(h('ul', { style: 'margin-top:10px' }, info.codes.map((c) => h('li', { title: c.context || '' }, h('code', {}, c.code), h('span', { class: 'src' }, c.sources.join(', '), h('br'), h('span', { class: c.hist && c.hist.wins ? 'good' : '' }, histText(c.hist)))))));
  }
  for (const e of (info.storeErrors || []).slice(0, 1)) coupon.append(h('p', { class: 'muted', style: 'margin:8px 0 0' }, `Store lookup: ${e}`));
  coupon.append(status);
  sections.push(coupon);

  // Last result
  if (lastRun && lastRun.results) {
    const sym = lastRun.symbol;
    const res = h('section', {}, h('h2', {}, `Last try, ${ago(lastRun.at)}`));
    if (lastRun.best) {
      res.append(h('div', { class: 'best' }, h('code', {}, lastRun.best.code), ' saved ', h('span', { class: 'good' }, money(lastRun.best.saved, sym)), lastRun.baseline ? h('span', { class: 'muted' }, ` off ${money(lastRun.baseline, sym)}`) : null));
    } else if (!lastRun.error) {
      res.append(h('p', { style: 'margin:0 0 8px' }, lastRun.results.length === 1 ? 'That code did not lower the total.' : `None of the ${lastRun.results.length} codes lowered the total.`));
    }
    if (lastRun.error) res.append(h('p', { class: 'err' }, lastRun.error));
    if (lastRun.results.length) res.append(h('ul', {}, [...lastRun.results].sort((a, b) => (b.saved || 0) - (a.saved || 0)).map((r) => resultRow(r, sym))));
    sections.push(res);
  }

  // Your codes
  const mine = h('section', {}, h('h2', {}, 'Your codes for this store'));
  const list = h('div', { class: 'links', style: 'margin:0 0 4px' });
  const drawMine = (codes) => {
    list.replaceChildren(...codes.map((c) => h('span', { class: 'chip links' }, h('code', {}, c), h('button', {
      'aria-label': `Remove ${c}`,
      onclick: async () => { const r = await bg({ type: 'removeUserCode', host, code: c }); if (r.ok) drawMine(r.data); }
    }, '×'))));
    if (!codes.length) list.replaceChildren(h('span', { class: 'muted' }, 'Add a code from an email or receipt. It gets tried at checkout here.'));
  };
  drawMine(userCodes);
  const input = h('input', { placeholder: 'Add a code', 'aria-label': 'Coupon code', maxlength: '40', autocomplete: 'off', spellcheck: 'false' });
  const addErr = h('p', { class: 'err', role: 'alert', hidden: '' });
  const add = async () => {
    const r = await bg({ type: 'addUserCode', host, code: input.value });
    if (r.ok) { input.value = ''; addErr.hidden = true; drawMine(r.data); }
    else { addErr.textContent = r.error; addErr.hidden = false; }
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
  mine.append(list, h('div', { class: 'row' }, input, h('button', { class: 'btn', onclick: add }, 'Add')), addErr);
  sections.push(mine);

  // Price
  if (info.product) {
    const p = info.product;
    const rec = store.prices?.[p.key];
    const sym = curSym(p.currency);
    const price = h('section', {}, h('h2', {}, 'Price'));
    price.append(h('p', { style: 'margin:0', title: p.name }, p.name.length > 70 ? p.name.slice(0, 68) + '…' : p.name));
    const pts = rec?.points || [{ t: Date.now(), p: p.price }];
    const ps = pts.map((x) => x.p);
    const low = Math.min(...ps), high = Math.max(...ps);
    price.append(
      h('div', { class: 'stats' },
        h('div', { class: 'stat' }, h('b', {}, money(p.price, sym)), h('span', {}, 'Now')),
        h('div', { class: 'stat' }, h('b', { class: p.price <= low ? 'good' : '' }, money(low, sym)), h('span', {}, 'Lowest seen')),
        h('div', { class: 'stat' }, h('b', {}, money(high, sym)), h('span', {}, 'Highest seen'))
      )
    );
    if (pts.length > 1) price.append(sparkline(pts), h('p', { class: 'muted', style: 'margin:4px 0 0' }, `${pts.length} prices since ${new Date(pts[0].t).toLocaleDateString()}. Recorded on this computer when you visit.`));
    else price.append(h('p', { class: 'muted', style: 'margin:0' }, 'First visit. History builds each time you come back.'));
    const watch = store.watches?.[p.key];
    const wErr = h('p', { class: 'err', role: 'alert', hidden: '' });
    const tInput = h('input', { type: 'number', min: '0.01', step: '0.01', 'aria-label': 'Target price', value: (watch ? watch.target : Math.floor(p.price * 90) / 100).toFixed(2), style: 'text-transform:none' });
    price.append(
      h('h2', { style: 'margin-top:12px' }, watch ? 'Watching this item' : 'Watch for a price drop'),
      h('div', { class: 'row' }, h('span', { class: 'muted', style: 'align-self:center' }, 'Tell me at'), tInput,
        h('button', { class: 'btn', onclick: async () => {
          const r = await bg({ type: 'addWatch', key: p.key, url: p.url, name: p.name, target: tInput.value, currency: p.currency, price: p.price });
          if (r.ok) render(); else { wErr.textContent = r.error; wErr.hidden = false; }
        } }, watch ? 'Update' : 'Watch')),
      wErr
    );
    if (info.amazonOffers) {
      const box = h('div');
      const drawOffers = (offers, note) => {
        if (!offers.length) { box.replaceChildren(h('p', { class: 'muted', style: 'margin:0' }, note || 'No offers found on this page.')); return; }
        const best = offers[0];
        box.replaceChildren(
          h('div', { class: 'best' }, 'Cheapest: ', h('b', {}, money(best.total, sym)), ` from ${best.seller}`, best.prime ? h('span', { class: 'good' }, ' Prime') : null,
            best.shipping === null ? h('div', { class: 'muted' }, 'Shipping not shown here. It may cost extra.') : null),
          h('ul', {}, offers.slice(0, 8).map((o) => h('li', {},
            h('span', { class: 'clip' }, o.seller, h('span', { class: 'muted' }, ' ' + o.condition)),
            h('span', { class: 'src' }, h('b', {}, money(o.total, sym)), h('br'), o.shipping === 0 ? 'free shipping' : o.shipping ? `incl. ${money(o.shipping, sym)} shipping` : 'shipping unknown', o.prime ? ', Prime' : '')))),
          note ? h('p', { class: 'muted', style: 'margin:6px 0 0' }, note) : null
        );
      };
      drawOffers(info.amazonOffers);
      price.append(h('h2', { style: 'margin-top:12px' }, 'Amazon sellers'), box,
        h('button', { class: 'btn ghost', style: 'margin-top:8px', onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true; b.textContent = 'Loading sellers…';
          const r = await tabMsg(tab.id, { type: 'amazonOffers' });
          b.disabled = false; b.textContent = 'Compare all sellers';
          if (r && r.ok) drawOffers(r.offers, r.note); else box.append(h('p', { class: 'err', role: 'alert' }, r?.error || 'Could not read sellers. Reload the page.'));
        } }, 'Compare all sellers'));
    }
    price.append(h('h2', { style: 'margin-top:12px' }, 'Check other stores'), compareLinks(p));
    sections.push(price);
  }

  sections.push(...(await globalSections(info.product?.key)));
  main.replaceChildren(...sections);
}

render().catch((e) => {
  main.replaceChildren(h('p', { class: 'pad err', role: 'alert' }, `Something went wrong: ${e.message}`));
});
