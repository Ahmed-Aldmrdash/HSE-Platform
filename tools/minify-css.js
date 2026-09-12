// tools/minify-css.js — تصغير public/style.css → public/style.min.css
// بنستخدم مكتبة clean-css مباشرة بدل سطر الأوامر (clean-css-cli) لأن الـ CLI
// بيعتمد على حزمة glob اللي بتختفي أحيانًا من node_modules فيقع البيلد كله.
// الاستخدام: node tools/minify-css.js [input.css] [output.min.css]
'use strict';

const fs = require('fs');
const path = require('path');
const CleanCSS = require('clean-css');

const root = path.join(__dirname, '..');
const input = process.argv[2] || path.join(root, 'public', 'style.css');
const output = process.argv[3] || path.join(root, 'public', 'style.min.css');

const source = fs.readFileSync(input, 'utf8');
const result = new CleanCSS({ level: 1, returnPromise: false }).minify(source);

if (result.errors && result.errors.length) {
  console.error('❌ CSS minify errors:');
  result.errors.forEach(e => console.error('   ', e));
  process.exit(1);
}
if (result.warnings && result.warnings.length) {
  result.warnings.slice(0, 5).forEach(w => console.warn('⚠️ ', w));
}
fs.writeFileSync(output, result.styles, 'utf8');
const kb = n => `${Math.round(n / 102.4) / 10} KB`;
console.log(`✅ ${path.basename(output)} — ${kb(source.length)} → ${kb(result.styles.length)}`);
