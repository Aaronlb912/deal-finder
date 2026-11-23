// Builds the phone bookmark from the extension's own code: node scripts/build-bookmark.mjs
// Writes docs/bookmark.js (readable) and puts the bookmark link into docs/index.html.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// `chrome` stays local to the bookmark so the store's own window.chrome is never replaced.
const code = ['const DF_PHONE = true;\nconst chrome =\n' + src('scripts/bookmark-shim.js'), src('src/extract.js'), src('src/content.js')].join('\n;\n');
fs.writeFileSync(path.join(ROOT, 'docs/bookmark.js'), code);

// Drop whole-line comments and indentation only. Anything smarter needs a minifier dependency.
const small = code.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');
// Escape only what a URL can't hold as-is; full encoding makes the bookmark much longer.
const href = 'javascript:' + ('(()=>{' + small + '\n})();void 0').replace(/%/g, '%25').replace(/\n/g, '%0A');

const page = path.join(ROOT, 'docs/index.html');
const html = src('docs/index.html');
let replaced = false;
const out = html.replace(/<textarea id="code"[^>]*>[\s\S]*?<\/textarea>/, (m) => { replaced = true; return m.replace(/>[\s\S]*?<\/textarea>$/, () => '>' + href.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</textarea>'); });
if (!replaced) throw new Error('textarea#code not found in docs/index.html');
fs.writeFileSync(page, out);
console.log(`bookmark: ${(href.length / 1024).toFixed(1)} KB`);
