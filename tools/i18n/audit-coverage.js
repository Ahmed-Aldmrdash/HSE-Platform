'use strict';
// Reports every Arabic string in public/app.js that is NOT routed through T(),
// so leftover untranslated UI text is visible rather than silently shipping.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..', '..');
const code = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script', locations: true });
const AR = /[؀-ۿݐ-ݿ]/;

function walk(node, visitors, ancestors) {
  if (!node || typeof node.type !== 'string') return;
  const fn = visitors[node.type];
  if (fn) fn(node, ancestors);
  const next = ancestors.concat([node]);
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'type') continue;
    const val = node[key];
    if (Array.isArray(val)) { for (const it of val) if (it && typeof it.type === 'string') walk(it, visitors, next); }
    else if (val && typeof val.type === 'string') walk(val, visitors, next);
  }
}

const dictRanges = [];
walk(ast, {
  VariableDeclarator(n) {
    if (n.id && ['I18N_DICT', 'I18N_STRINGS'].includes(n.id.name) && n.init) dictRanges.push([n.init.start, n.init.end]);
  }
}, []);
const inDict = p => dictRanges.some(r => p >= r[0] && p <= r[1]);

const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const wrapped = (node, anc) => {
  const p = anc[anc.length - 1];
  return !!(p && p.type === 'CallExpression' && p.callee && p.callee.name === 'T' &&
            p.arguments.length === 1 && p.arguments[0] === node);
};

const out = { moduleLevel: [], literals: [], templateRuns: [] };
walk(ast, {
  Literal(node, anc) {
    if (typeof node.value !== 'string' || !AR.test(node.value)) return;
    if (inDict(node.start) || wrapped(node, anc)) return;
    const p = anc[anc.length - 1];
    const ctx = p ? p.type + (p.type === 'Property' ? ':' + (p.key && (p.key.name || p.key.value)) : '') : '?';
    const rec = { line: node.loc.start.line, value: node.value, ctx };
    if (!anc.some(a => FN.has(a.type))) out.moduleLevel.push(rec); else out.literals.push(rec);
  },
  TemplateElement(node, anc) {
    if (!AR.test(node.value.raw)) return;
    if (inDict(node.start)) return;
    out.templateRuns.push({ line: node.loc.start.line, text: node.value.raw.trim().slice(0, 80) });
  }
}, []);

console.log('unwrapped module-level literals :', out.moduleLevel.length);
console.log('unwrapped in-function literals  :', out.literals.length);
console.log('unwrapped template-literal runs :', out.templateRuns.length);
fs.writeFileSync(path.join(__dirname, 'audit_report.json'), JSON.stringify(out, null, 2), 'utf8');

const byCtx = {};
out.literals.forEach(r => { byCtx[r.ctx] = (byCtx[r.ctx] || 0) + 1; });
console.log('\nin-function leftovers by context:');
Object.entries(byCtx).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ', k, v));
console.log('\ntemplate-run leftovers (first 25):');
out.templateRuns.slice(0, 25).forEach(r => console.log('   line', r.line, JSON.stringify(r.text)));
