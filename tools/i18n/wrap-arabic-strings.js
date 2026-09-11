'use strict';
// Wraps every render-time Arabic string in public/app.js with T(...) so the
// language toggle can swap it. AST-driven (acorn) rather than regex so that
// comparisons, object keys, filter sentinels and other non-display strings
// are left strictly alone.
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'public', 'app.js');
const code = fs.readFileSync(SRC, 'utf8');
const ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script', locations: true });
const ARABIC_RE = /[؀-ۿݐ-ݿ]/;
const TRANSLATIONS = JSON.parse(fs.readFileSync(path.join(__dirname, 'dictionary.json'), 'utf8'));

function walk(node, visitors, ancestors) {
  if (!node || typeof node.type !== 'string') return;
  const fn = visitors[node.type];
  if (fn) fn(node, ancestors);
  const nextAncestors = ancestors.concat([node]);
  for (const key in node) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end' || key === 'type') continue;
    const val = node[key];
    if (Array.isArray(val)) { for (const item of val) if (item && typeof item.type === 'string') walk(item, visitors, nextAncestors); }
    else if (val && typeof val.type === 'string') walk(val, visitors, nextAncestors);
  }
}

// The dictionary objects themselves are the translation source — never wrap
// anything inside them.
const dictRanges = [];
walk(ast, {
  VariableDeclarator(node) {
    if (node.id && (node.id.name === 'I18N_DICT' || node.id.name === 'I18N_STRINGS') && node.init) {
      dictRanges.push([node.init.start, node.init.end]);
    }
  }
}, []);
function insideDict(pos) { return dictRanges.some(r => pos >= r[0] && pos <= r[1]); }

const RISKY_KEY_NAMES = new Set(['value','id','key','status','role','type','action','code','level','kind','op','field','name','className','dept','department','severity','val','reason','filter','filterVal','sortKey']);
const SAFE_CALLEE_NAMES = new Set(['showToast','confirm','alert','showWlMsg','prompt']);
const FILTER_NAME_RE = /filter/i;
const SAFE_ASSIGN_TARGETS = new Set(['textContent','innerHTML','placeholder','title','innerText','html']);
const FUNCTION_TYPES = new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
function insideAnyFunction(ancestors) { return ancestors.some(a => FUNCTION_TYPES.has(a.type)); }

// Already hand-wrapped as T('...') — leave alone, wrapping again would make
// T(T('x')) and lose the Arabic key on the second lookup.
function alreadyWrapped(node, ancestors) {
  const parent = ancestors[ancestors.length - 1];
  return !!(parent && parent.type === 'CallExpression' && parent.callee &&
            parent.callee.type === 'Identifier' && parent.callee.name === 'T' &&
            parent.arguments.length === 1 && parent.arguments[0] === node);
}

const allLiterals = [];
const moduleLevelSkipped = [];
walk(ast, {
  Literal(node, ancestors) {
    if (typeof node.value !== 'string' || !ARABIC_RE.test(node.value)) return;
    if (insideDict(node.start)) return;
    if (alreadyWrapped(node, ancestors)) return;
    if (!insideAnyFunction(ancestors)) {
      // Evaluated once at load — wrapping here would freeze the value at the
      // language active on first paint. These are translated at the point
      // where they are rendered instead.
      moduleLevelSkipped.push({ line: node.loc.start.line, value: node.value });
      return;
    }
    allLiterals.push({ node, ancestors: ancestors.slice() });
  }
}, []);

function localDecision(node, ancestors) {
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return { verdict: 'review', reason: 'no_parent' };
  if (parent.type === 'BinaryExpression' && ['===','!==','==','!='].includes(parent.operator)) return { verdict: 'exclude', reason: 'comparison', sentinel: true };
  if (parent.type === 'SwitchCase') return { verdict: 'exclude', reason: 'switchcase', sentinel: true };
  if (parent.type === 'Property') {
    const keyName = parent.key && (parent.key.name || parent.key.value);
    if (parent.key === node) return { verdict: 'exclude', reason: 'object_key' };
    if (parent.computed) return { verdict: 'exclude', reason: 'computed_key', sentinel: true };
    if (RISKY_KEY_NAMES.has(keyName)) return { verdict: 'exclude', reason: 'risky_prop:' + keyName, sentinel: true };
    return { verdict: 'include', reason: 'prop:' + keyName };
  }
  if (parent.type === 'CallExpression') {
    const calleeName = parent.callee && (parent.callee.name || (parent.callee.property && parent.callee.property.name));
    if (SAFE_CALLEE_NAMES.has(calleeName)) return { verdict: 'include', reason: 'call:' + calleeName };
    if (calleeName === 'includes' || calleeName === 'startsWith' || calleeName === 'endsWith') return { verdict: 'exclude', reason: 'string_match_call', sentinel: true };
    if (calleeName === 'join') return { verdict: 'exclude', reason: 'join_separator' };
    if (calleeName === 'push' || calleeName === 'book_append_sheet') return { verdict: 'include', reason: 'call:' + calleeName };
    return { verdict: 'include', reason: 'call_other:' + calleeName };
  }
  if (parent.type === 'ArrayExpression') return { verdict: 'include', reason: 'array_elem' };
  if (parent.type === 'AssignmentExpression') {
    const leftName = parent.left && (parent.left.property ? parent.left.property.name : parent.left.name);
    if (SAFE_ASSIGN_TARGETS.has(leftName)) return { verdict: 'include', reason: 'assign:' + leftName };
    if (leftName && FILTER_NAME_RE.test(leftName)) return { verdict: 'exclude', reason: 'filter_assign:' + leftName, sentinel: true };
    return { verdict: 'include', reason: 'assign_other:' + leftName };
  }
  if (parent.type === 'MemberExpression' && parent.computed) return { verdict: 'exclude', reason: 'member_computed', sentinel: true };
  if (parent.type === 'VariableDeclarator') {
    const varName = parent.id && parent.id.name;
    if (varName && FILTER_NAME_RE.test(varName)) return { verdict: 'exclude', reason: 'filter_var:' + varName, sentinel: true };
    return { verdict: 'include', reason: 'vardecl:' + varName };
  }
  if (parent.type === 'TemplateLiteral') return { verdict: 'include', reason: 'template_expr' };
  if (parent.type === 'ConditionalExpression') return { verdict: 'include', reason: 'conditional' };
  if (parent.type === 'ReturnStatement') return { verdict: 'include', reason: 'return' };
  if (parent.type === 'LogicalExpression') return { verdict: 'include', reason: 'logical' };
  if (parent.type === 'NewExpression') return { verdict: 'include', reason: 'new_expr' };
  if (parent.type === 'BinaryExpression') return { verdict: 'include', reason: 'string_concat' };
  return { verdict: 'review', reason: 'other:' + parent.type };
}

// A value used anywhere as a comparison/filter sentinel is a data value, not a
// label — never translate it, even at sites that look like display.
const sentinelValues = new Set();
for (const { node, ancestors } of allLiterals) {
  const d = localDecision(node, ancestors);
  if (d.sentinel) sentinelValues.add(node.value);
}

const ops = [];
let includedCount = 0, excludedCount = 0;
const reviewList = [];

for (const { node, ancestors } of allLiterals) {
  const parent = ancestors[ancestors.length - 1];
  const d = localDecision(node, ancestors);
  let verdict = d.verdict;
  const isLabelProp = parent && parent.type === 'Property' && !parent.computed && parent.value === node &&
    ['label','fullLabel','sectionTitle','text','title','message','msg'].includes(parent.key && (parent.key.name || parent.key.value));
  if (verdict !== 'exclude' && sentinelValues.has(node.value) && !isLabelProp) verdict = 'exclude';

  if (verdict === 'include') {
    if (!(node.value in TRANSLATIONS)) { reviewList.push({ line: node.loc.start.line, value: node.value, reason: 'NO_TRANSLATION' }); continue; }
    ops.push({ start: node.start, end: node.end, replacement: `T(${node.raw})` });
    includedCount++;
  } else if (verdict === 'exclude') {
    excludedCount++;
  } else {
    reviewList.push({ line: node.loc.start.line, value: node.value, reason: d.reason });
  }
}

// ---- Arabic runs inside template literals ----
const BOUNDARY_RE = /[<>"`$}{]/;
function findRuns(raw) {
  const runs = [];
  let i = 0;
  while (i < raw.length) {
    if (BOUNDARY_RE.test(raw[i])) { i++; continue; }
    let j = i;
    while (j < raw.length && !BOUNDARY_RE.test(raw[j])) j++;
    const segment = raw.slice(i, j);
    if (ARABIC_RE.test(segment)) {
      const leadWs = segment.match(/^\s*/)[0].length;
      const trailWs = segment.match(/\s*$/)[0].length;
      const trimmed = segment.slice(leadWs, segment.length - trailWs);
      if (trimmed) runs.push({ localStart: i + leadWs, localEnd: j - trailWs, text: trimmed });
    }
    i = j;
  }
  return runs;
}

let chunkRunOps = 0; const chunkRunMissing = []; let chunkModuleLevelSkipped = 0;
walk(ast, {
  TemplateElement(node, ancestors) {
    if (!ARABIC_RE.test(node.value.raw)) return;
    if (insideDict(node.start)) return;
    if (!insideAnyFunction(ancestors)) { chunkModuleLevelSkipped++; return; }
    for (const r of findRuns(node.value.raw)) {
      if (!(r.text in TRANSLATIONS)) { chunkRunMissing.push({ line: node.loc.start.line, text: r.text }); continue; }
      ops.push({ start: node.start + r.localStart, end: node.start + r.localEnd, replacement: '${T(' + JSON.stringify(r.text) + ')}' });
      chunkRunOps++;
    }
  }
}, []);

console.log('literal ops:', includedCount, '| excluded:', excludedCount, '| review:', reviewList.length);
console.log('module-level literals skipped (translated at render site):', moduleLevelSkipped.length);
console.log('template-run ops:', chunkRunOps, '| missing translations:', chunkRunMissing.length, '| module-level template chunks:', chunkModuleLevelSkipped);
fs.writeFileSync(path.join(__dirname, 'module_level_skipped.json'), JSON.stringify(moduleLevelSkipped, null, 2), 'utf8');
fs.writeFileSync(path.join(__dirname, 'review_needed.json'), JSON.stringify(reviewList, null, 2), 'utf8');
fs.writeFileSync(path.join(__dirname, 'chunk_missing.json'), JSON.stringify(chunkRunMissing, null, 2), 'utf8');

ops.sort((a, b) => a.start - b.start);
for (let k = 1; k < ops.length; k++) {
  if (ops[k].start < ops[k - 1].end) { console.error('OVERLAP', ops[k - 1], ops[k]); process.exit(1); }
}
let result = code;
for (let k = ops.length - 1; k >= 0; k--) {
  result = result.slice(0, ops[k].start) + ops[k].replacement + result.slice(ops[k].end);
}

const outPath = process.argv[2] === '--in-place' ? SRC : path.join(__dirname, 'app.i18n.js');
fs.writeFileSync(outPath, result, 'utf8');
console.log('total ops applied:', ops.length, '->', outPath);
