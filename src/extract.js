// "1.299,00" and "1,299.00" both mean 1299; a lone comma with 2 digits after is a decimal.
function DF_num(v) {
  let t = String(v ?? '').replace(/[^0-9.,]/g, '');
  const lastDot = t.lastIndexOf('.'), lastComma = t.lastIndexOf(',');
  if (lastComma > lastDot && /,\d{1,2}$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, '');
  return parseFloat(t);
}
globalThis.DF_num = DF_num;
// Shared by content.js (classic script) and background.js (module import for side effect).
(() => {
  const STOP = new Set([
    'CODE', 'CODES', 'HERE', 'BELOW', 'ABOVE', 'CHECKOUT', 'THE', 'FOR', 'AND', 'YOUR', 'APPLIED', 'REQUIRED',
    'NEEDED', 'NONE', 'ENTER', 'EMAIL', 'APPLY', 'INVALID', 'VALID', 'EXPIRED', 'TODAY', 'ONLY', 'NOW', 'FREE',
    'SHIPPING', 'OFF', 'SALE', 'SHOP', 'ORDER', 'ORDERS', 'WITH', 'FROM', 'THIS', 'THAT', 'WILL', 'CART', 'NEW',
    'COPY', 'COPIED', 'SAVE', 'DISCOUNT', 'COUPON', 'PROMO', 'GIFT', 'CARD', 'SIGN', 'SIGNUP', 'NEWSLETTER',
    'USD', 'CAD', 'EUR', 'GBP', 'AUD', 'FAQ', 'HTTP', 'HTTPS', 'WWW', 'SMS', 'TEXT', 'NOT', 'ALL', 'ANY', 'USE',
    'REQUIRED.', 'EXCLUSIONS', 'APPLY.', 'DETAILS', 'TERMS', 'AUTOMATIC', 'AUTOMATICALLY', 'NEEDED.'
  ]);

  const PATTERNS = [
    /\b(?:use|enter|apply|with|redeem)\s+(?:the\s+)?(?:promo(?:tion)?\s+|coupon\s+|discount\s+|offer\s+)?code\s*[:\-]?\s*["'“‘]?([A-Za-z0-9][A-Za-z0-9_-]{2,23})/gi,
    /\b(?:promo(?:tion)?|coupon|discount|offer|voucher)\s*code\s*[:\-]?\s*["'“‘]?([A-Za-z0-9][A-Za-z0-9_-]{2,23})/gi,
    /\bcode\s*[:]\s*["'“‘]?([A-Za-z0-9][A-Za-z0-9_-]{2,23})/gi
  ];

  function looksLikeCode(raw) {
    if (!raw) return false;
    const c = raw.replace(/[-_]+$/, '');
    if (c.length < 3 || c.length > 24) return false;
    if (c !== c.toUpperCase()) return false; // stores print codes in caps; lowercase is usually prose
    if (!/[A-Z]/.test(c)) return false;
    if (/^\d+$/.test(c)) return false;
    if (STOP.has(c)) return false;
    return true;
  }

  // Returns [{code, context}] from plain text and optional HTML (for Shopify /discount/CODE links).
  function extractCodes(text, html) {
    const found = new Map();
    const add = (code, context) => {
      code = code.replace(/[-_]+$/, '');
      if (!looksLikeCode(code) || found.has(code)) return;
      found.set(code, { code, context: (context || '').replace(/\s+/g, ' ').trim().slice(0, 120) });
    };
    const t = (text || '').slice(0, 400000);
    for (const re of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) add(m[1], t.slice(Math.max(0, m.index - 50), m.index + m[0].length + 50));
    }
    if (html) {
      const re = /\/discount\/([A-Za-z0-9%_-]{3,40})(?=["'?&#/])/g;
      let m;
      while ((m = re.exec(html))) {
        try { add(decodeURIComponent(m[1]).toUpperCase(), 'Store discount link'); } catch { /* bad escape */ }
      }
    }
    return [...found.values()];
  }

  // Finds {name, price, currency, gtin, brand} in parsed schema.org JSON-LD blocks.
  function productFromLd(blocks) {
    const nodes = [];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach(walk);
      const type = [].concat(o['@type'] || []).map(String);
      if (type.some((t) => /^(Product|ProductGroup)$/i.test(t))) nodes.push(o);
      if (o['@graph']) walk(o['@graph']);
    };
    blocks.forEach(walk);
    for (const p of nodes) {
      let offers = [].concat(p.offers || (p.hasVariant ? [].concat(p.hasVariant).flatMap((v) => [].concat(v.offers || [])) : []));
      offers = offers.flatMap((o) => (o && o['@type'] === 'AggregateOffer' ? [{ price: o.lowPrice ?? o.price, priceCurrency: o.priceCurrency }] : [o]));
      const o = offers.find((x) => x && (x.price || x.lowPrice));
      if (!o) continue;
      const price = DF_num(o.price ?? o.lowPrice);
      if (!(price > 0)) continue;
      return {
        name: String(p.name || '').slice(0, 200),
        price,
        currency: o.priceCurrency || '',
        gtin: p.gtin13 || p.gtin12 || p.gtin || p.gtin14 || p.gtin8 || '',
        brand: typeof p.brand === 'object' ? p.brand?.name || '' : p.brand || ''
      };
    }
    return null;
  }

  // Product from raw HTML (used by the Droplist checker, which has no DOM).
  function productFromHtml(html) {
    const blocks = [];
    const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      try { blocks.push(JSON.parse(m[1].trim())); } catch { /* skip bad JSON-LD */ }
    }
    const p = productFromLd(blocks);
    if (p) return p;
    const og = html.match(/<meta[^>]+property=["'](?:product|og):price:amount["'][^>]+content=["']([\d.,]+)["']/i);
    if (og) {
      const cur = html.match(/<meta[^>]+property=["'](?:product|og):price:currency["'][^>]+content=["']([A-Z]{3})["']/i);
      return { name: '', price: DF_num(og[1]), currency: cur ? cur[1] : '', gtin: '', brand: '' };
    }
    return null;
  }

  globalThis.DF_productFromLd = productFromLd;
  globalThis.DF_productFromHtml = productFromHtml;
  globalThis.DF_extractCodes = extractCodes;
  globalThis.DF_looksLikeCode = looksLikeCode;
})();

// Keep only well-formed entries, so a bad remote file can't inject junk.
function DF_cleanList(data) {
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
globalThis.DF_cleanList = DF_cleanList;
