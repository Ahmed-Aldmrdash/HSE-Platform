'use strict';
// Arabic strings that server.js sends to the browser end up on screen without
// passing through the AST wrapper, so they need dictionary entries of their own.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..', '..');
const code = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script', locations: true });
const AR = /[؀-ۿݐ-ݿ]/;
const dict = JSON.parse(fs.readFileSync(path.join(__dirname, 'dictionary.json'), 'utf8'));

const found = new Map();
(function walk(n, anc) {
  if (!n || typeof n.type !== 'string') return;
  if (n.type === 'Literal' && typeof n.value === 'string' && AR.test(n.value)) {
    const p = anc[anc.length - 1];
    const ctx = p ? p.type + (p.type === 'Property' ? ':' + (p.key && (p.key.name || p.key.value)) : '') : '?';
    if (!found.has(n.value)) found.set(n.value, { line: n.loc.start.line, ctx });
  }
  if (n.type === 'TemplateElement' && AR.test(n.value.raw)) {
    const t = n.value.raw.trim();
    if (t && !found.has(t)) found.set(t, { line: n.loc.start.line, ctx: 'Template' });
  }
  const next = anc.concat([n]);
  for (const k in n) {
    if (['loc', 'start', 'end', 'type'].includes(k)) continue;
    const v = n[k];
    if (Array.isArray(v)) v.forEach(x => x && typeof x.type === 'string' && walk(x, next));
    else if (v && typeof v.type === 'string') walk(v, next);
  }
})(ast, []);

const all = [...found.entries()];
const missing = all.filter(([v]) => !(v in dict));
console.log('arabic strings in server.js:', all.length, '| already in dict:', all.length - missing.length, '| missing:', missing.length);
fs.writeFileSync(path.join(__dirname, 'server_missing.json'), JSON.stringify(missing.map(([v, m]) => ({ value: v, ...m })), null, 2), 'utf8');
const byCtx = {};
missing.forEach(([, m]) => { byCtx[m.ctx] = (byCtx[m.ctx] || 0) + 1; });
console.log('\nmissing by context:');
Object.entries(byCtx).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ', k, v));
