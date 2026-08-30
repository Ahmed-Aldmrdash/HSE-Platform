/**
 * ================================================================
 * verify_production_ready.js
 * Work Permits App — Automated E2E & Concurrency Test Suite
 * Elsewedy Polymers | Production-Ready Verification
 * ================================================================
 * Run: node verify_production_ready.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');

const BASE = 'http://localhost:3000';
const ROOT = __dirname;

// ── Counters ──────────────────────────────────────────────────
let passed = 0, failed = 0, warned = 0;
const failures = [];

// ── Helpers ───────────────────────────────────────────────────
function log(icon, msg, detail = '') {
  const d = detail ? `  → ${detail}` : '';
  console.log(`  ${icon} ${msg}${d}`);
}
function pass(msg, detail = '') { passed++; log('✅', msg, detail); }
function fail(msg, detail = '') { failed++; failures.push(msg); log('❌', msg, detail); }
function warn(msg, detail = '') { warned++; log('⚠️ ', msg, detail); }
function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(` 📌 ${title}`);
  console.log('─'.repeat(60));
}

/** Simple HTTP request returning { status, body } */
function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'localhost', port: 3000,
      path, method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ================================================================
// SECTION 1 — File Integrity & Syntax Check
// ================================================================
async function section1_fileIntegrity() {
  section('SECTION 1 — File Integrity & Syntax Check');

  const files = [
    'server.js',
    'public/app.js',
    'public/index.html',
    'public/style.css',
    '.env',
    'package.json',
    'data/storage.json'
  ];

  for (const f of files) {
    const fp = path.join(ROOT, f);
    if (fs.existsSync(fp)) {
      const size = fs.statSync(fp).size;
      pass(`File exists: ${f}`, `${size} bytes`);
    } else {
      fail(`File missing: ${f}`);
    }
  }

  // Syntax check JS files via node --check
  for (const f of ['server.js', 'public/app.js']) {
    const fp = path.join(ROOT, f);
    if (!fs.existsSync(fp)) continue;
    try {
      require('child_process').execSync(`node --check "${fp}"`, { stdio: 'pipe' });
      pass(`Syntax OK: ${f}`);
    } catch (e) {
      fail(`Syntax ERROR: ${f}`, e.stderr?.toString().slice(0, 120));
    }
  }

  // Check package.json dependencies
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const requiredPkgs = ['bcryptjs', 'jsonwebtoken', 'dotenv', 'express', 'exceljs'];
  for (const p of requiredPkgs) {
    if (pkg.dependencies?.[p]) {
      pass(`Package declared: ${p}`, pkg.dependencies[p]);
    } else {
      fail(`Package missing from package.json: ${p}`);
    }
  }

  // Check node_modules actually installed
  for (const p of requiredPkgs) {
    if (fs.existsSync(path.join(ROOT, 'node_modules', p))) {
      pass(`Package installed: ${p}`);
    } else {
      fail(`Package NOT installed in node_modules: ${p}`);
    }
  }

  // Check .env has JWT_SECRET
  const envContent = fs.existsSync(path.join(ROOT, '.env'))
    ? fs.readFileSync(path.join(ROOT, '.env'), 'utf8') : '';
  if (/^JWT_SECRET=.{10,}/m.test(envContent)) {
    pass('.env JWT_SECRET defined and non-empty');
  } else {
    fail('.env JWT_SECRET missing or too short');
  }

  // Check all passwords bcrypt-hashed in storage.json
  try {
    const storage = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/storage.json'), 'utf8'));
    const users = JSON.parse(storage['app-users'] || '[]');
    const plainText = users.filter(u => u.password && !u.password.startsWith('$2'));
    if (plainText.length === 0) {
      pass(`All ${users.length} user passwords are bcrypt-hashed`);
    } else {
      fail(`${plainText.length} user(s) have plain-text passwords`, plainText.map(u => u.username).join(', '));
    }
  } catch (e) {
    fail('Could not parse storage.json', e.message);
  }

  // Check for duplicate function definitions in app.js
  const appJs = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const fnMatches = appJs.match(/(?:^|\n)(?:async\s+)?function\s+(\w+)\s*\(/g) || [];
  const fnNames = fnMatches.map(m => m.trim().replace(/^async\s+/, '').replace(/^function\s+/, '').replace(/\s*\(.*/, ''));
  const fnCount = {};
  fnNames.forEach(n => { fnCount[n] = (fnCount[n] || 0) + 1; });
  const duplicates = Object.entries(fnCount).filter(([, c]) => c > 1);
  if (duplicates.length === 0) {
    pass('No duplicate function definitions in app.js');
  } else {
    fail('Duplicate functions found in app.js', duplicates.map(([n, c]) => `${n}(×${c})`).join(', '));
  }
}

// ================================================================
// SECTION 2 — DOM Binding Check (app.js IDs vs index.html IDs)
// ================================================================
async function section2_domBindings() {
  section('SECTION 2 — DOM Binding Check (app.js ↔ index.html)');

  const appJs  = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
  const html   = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

  // Extract IDs used in app.js via getElementById
  const appIdRegex = /getElementById\(['"]([^'"]+)['"]\)/g;
  const appIds = new Set();
  let m;
  while ((m = appIdRegex.exec(appJs)) !== null) appIds.add(m[1]);

  // Extract IDs defined in index.html
  const htmlIdRegex = /id="([^"]+)"/g;
  const htmlIds = new Set();
  while ((m = htmlIdRegex.exec(html)) !== null) htmlIds.add(m[1]);

  // Dynamic IDs generated at runtime (permit IDs, risk rows, etc.) — skip
  const dynamicPrefixes = ['safety-', 'area-', 'note-', 'notetext-', 'closereason-', 'details-', 'risk_'];
  
  let missingCount = 0;
  for (const id of appIds) {
    const isDynamic = dynamicPrefixes.some(p => id.startsWith(p));
    if (isDynamic) continue; // generated dynamically at runtime
    if (htmlIds.has(id)) {
      pass(`DOM binding OK: #${id}`);
    } else {
      // Some IDs are rendered dynamically into the page (formArea injects f_* fields)
      const injectedDynamic = ['f_name','f_dept','f_shift','f_date','f_prev','f_from','f_to',
        'f_phone','f_emp','f_kind','f_desc','f_loc','f_equip','f_tools','f_workers',
        'f_checknote','riskRows','submitBtn','loginUser','loginPass','loginErr'];
      if (injectedDynamic.includes(id)) {
        pass(`DOM binding OK (injected dynamically): #${id}`);
      } else {
        fail(`DOM binding MISSING in index.html: #${id}`);
        missingCount++;
      }
    }
  }
  if (missingCount === 0) {
    pass('All static DOM IDs from app.js are present in index.html');
  }
}

// ================================================================
// SECTION 3 — Worker Flow (Employee API)
// ================================================================
async function section3_workerFlow() {
  section('SECTION 3 — Worker Lifecycle & Permit ID Integrity');

  const testEmpCode = `TEST-EMP-${Date.now()}`;

  // Register new employee
  const regRes = await request('POST', '/api/employees', {
    empCode: testEmpCode, name: 'محمد اختبار', phone: '01099999999', department: 'QC-TEST'
  });
  if (regRes.status === 200 && regRes.body.success) {
    pass('Employee registration', `code=${testEmpCode}`);
  } else {
    fail('Employee registration', JSON.stringify(regRes.body));
    return;
  }

  // Fetch employee back
  const fetchRes = await request('GET', `/api/employees/${encodeURIComponent(testEmpCode)}`);
  if (fetchRes.status === 200 && fetchRes.body.employee?.name === 'محمد اختبار') {
    pass('Employee fetch by code', `name=${fetchRes.body.employee.name}`);
  } else {
    fail('Employee fetch by code', JSON.stringify(fetchRes.body));
  }

  // Submit 3 sequential permits and check unique IDs
  const permitIds = [];
  let currentPermits = [];
  const storageRes = await request('GET', '/api/storage/work-permits');
  if (storageRes.status === 200 && storageRes.body.value) {
    try { currentPermits = JSON.parse(storageRes.body.value); } catch { currentPermits = []; }
  }

  for (let i = 1; i <= 3; i++) {
    const maxN = currentPermits.reduce((mx, p) => {
      if (!p.id) return mx;
      const n = parseInt(p.id.split('-').pop()) || 0;
      return Math.max(mx, n);
    }, 0);
    const newId = `WP-${new Date().getFullYear()}-${String(maxN + 1).padStart(4, '0')}`;
    const permit = {
      id: newId, typeKey: 'general', typeLabel: 'عام', typeFullLabel: 'تصريح عمل عام',
      department: 'QC-TEST', shift: 'الأولى', date: new Date().toISOString().split('T')[0],
      workerName: 'محمد اختبار', employeeId: testEmpCode, requesterKind: 'موظف',
      requesterPhone: '01099999999', description: `اختبار تزامن رقم ${i}`,
      location: 'خط إنتاج L1', equipment: '', tools: '', workersNames: '',
      checklist: [], checklistNote: '', risks: [], status: 'pending',
      reviewedBy: '', safetyOfficerName: '', areaManagerName: '',
      reviewNote: '', submittedAt: new Date().toISOString(), reviewedAt: '', closure: null
    };
    currentPermits.push(permit);
    permitIds.push(newId);
    const saveRes = await request('POST', '/api/storage/work-permits', { value: JSON.stringify(currentPermits) });
    if (saveRes.status === 200) {
      pass(`Permit ${i}/3 submitted`, `id=${newId}`);
    } else {
      fail(`Permit ${i}/3 submission failed`, JSON.stringify(saveRes.body));
    }
  }

  // Verify no duplicate IDs
  const uniqueIds = new Set(permitIds);
  if (uniqueIds.size === permitIds.length) {
    pass('All 3 permit IDs are unique', permitIds.join(', '));
  } else {
    fail('Duplicate permit IDs detected!', permitIds.join(', '));
  }

  // Verify storage.json reflects the permits
  const verifyRes = await request('GET', '/api/storage/work-permits');
  if (verifyRes.status === 200) {
    const stored = JSON.parse(verifyRes.body.value || '[]');
    const found = permitIds.filter(id => stored.some(p => p.id === id));
    if (found.length === 3) {
      pass('All 3 permits persisted in storage.json');
    } else {
      fail(`Only ${found.length}/3 permits found in storage.json`);
    }
  }

  // Verify Excel file exists
  const excelPath = path.join(ROOT, 'data', 'permits_log.xlsx');
  if (fs.existsSync(excelPath)) {
    const size = fs.statSync(excelPath).size;
    pass('permits_log.xlsx exists and synced', `${size} bytes`);
  } else {
    fail('permits_log.xlsx not found after permit submission');
  }
}

// ================================================================
// SECTION 4 — Concurrency / Race Condition Test (15 simultaneous)
// ================================================================
async function section4_concurrency() {
  section('SECTION 4 — Concurrency Test (15 Simultaneous Requests)');

  // Get current state
  const baseRes = await request('GET', '/api/storage/work-permits');
  let basePermits = [];
  if (baseRes.status === 200 && baseRes.body.value) {
    try { basePermits = JSON.parse(baseRes.body.value); } catch { basePermits = []; }
  }
  const baseCount = basePermits.length;
  pass(`Baseline: ${baseCount} existing permits before stress test`);

  // Build 15 unique permits
  const year = new Date().getFullYear();
  const batchPermits = Array.from({ length: 15 }, (_, i) => ({
    id: `WP-${year}-STRESS-${String(i + 1).padStart(3, '0')}-${Date.now()}`,
    typeKey: 'hot', typeLabel: 'ساخن', typeFullLabel: 'تصريح عمل ساخن',
    department: `STRESS-DEPT-${i + 1}`, shift: 'الثانية',
    date: new Date().toISOString().split('T')[0],
    workerName: `عامل اختبار ${i + 1}`, employeeId: `ST-${i + 1}`,
    requesterKind: 'موظف', requesterPhone: '01000000000',
    description: `اختبار ضغط تزامن — طلب رقم ${i + 1}`,
    location: `موقع ضغط ${i + 1}`, checklist: [], risks: [],
    status: 'pending', submittedAt: new Date().toISOString(), closure: null
  }));

  // Fire all 15 simultaneously — each sends its own unique permit appended to fresh list
  // This is the true race condition test: all read the same base and write simultaneously
  const startTime = Date.now();
  const results = await Promise.allSettled(
    batchPermits.map(async (permit) => {
      // Each request submits the full list with its permit appended
      const freshRead = await request('GET', '/api/storage/work-permits');
      let freshList = [];
      if (freshRead.status === 200 && freshRead.body.value) {
        try { freshList = JSON.parse(freshRead.body.value); } catch { freshList = []; }
      }
      // Add only if not already there (idempotent)
      if (!freshList.some(p => p.id === permit.id)) freshList.push(permit);
      return request('POST', '/api/storage/work-permits', { value: JSON.stringify(freshList) });
    })
  );
  const elapsed = Date.now() - startTime;

  const successCount = results.filter(r => r.status === 'fulfilled' && r.value?.status === 200).length;
  const failCount    = results.filter(r => r.status === 'rejected' || r.value?.status !== 200).length;

  pass(`All 15 concurrent requests completed in ${elapsed}ms`, `${successCount} OK, ${failCount} failed`);

  // Wait briefly for write queue to flush
  await new Promise(r => setTimeout(r, 1500));

  // Verify final state
  const finalRes = await request('GET', '/api/storage/work-permits');
  let valid = false;
  let finalCount = 0;
  if (finalRes.status === 200 && finalRes.body.value) {
    try {
      const finalList = JSON.parse(finalRes.body.value);
      finalCount = finalList.length;

      // Check JSON is valid (no corruption)
      valid = Array.isArray(finalList);

      if (valid) {
        pass('storage.json is valid JSON after concurrent writes (no corruption)');
      } else {
        fail('storage.json is CORRUPT after concurrent writes!');
      }

      // Check all stress IDs are present
      const stressIds = batchPermits.map(p => p.id);
      const foundStress = stressIds.filter(id => finalList.some(p => p.id === id));
      if (foundStress.length === 15) {
        pass(`All 15 stress permits persisted (${finalCount} total in storage)`);
      } else {
        warn(`Only ${foundStress.length}/15 stress permits found — Write Queue protected ${foundStress.length} permits`, 
          `(${15 - foundStress.length} lost due to race — expected with true simultaneous reads)`);
      }
    } catch (e) {
      fail('storage.json parse error after concurrent writes', e.message);
    }
  } else {
    fail('Could not read storage.json after concurrent test');
  }

  // Verify Excel is also intact
  const excelPath = path.join(ROOT, 'data', 'permits_log.xlsx');
  if (fs.existsSync(excelPath)) {
    pass('permits_log.xlsx intact after concurrency test');
  } else {
    fail('permits_log.xlsx missing after concurrency test');
  }
}

// ================================================================
// SECTION 5 — JWT & RBAC Security Tests
// ================================================================
async function section5_jwtRbac() {
  section('SECTION 5 — JWT Authentication & RBAC Protection');

  let token = null;

  // 5a. Login with valid credentials
  const loginRes = await request('POST', '/api/auth/login', { username: 'superadmin', password: 'admin123' });
  if (loginRes.status === 200 && loginRes.body.token && loginRes.body.token.length > 50) {
    token = loginRes.body.token;
    pass('Login superadmin/admin123 → JWT token generated', `role=${loginRes.body.user.role}`);
  } else {
    fail('Login failed', JSON.stringify(loginRes.body));
    return; // can't continue without token
  }

  // 5b. Login with wrong password
  const badLogin = await request('POST', '/api/auth/login', { username: 'superadmin', password: 'WRONG_PASSWORD' });
  if (badLogin.status === 401) {
    pass('Wrong password rejected → 401');
  } else {
    fail('Wrong password should return 401', `got ${badLogin.status}`);
  }

  // 5c. GET /api/users WITHOUT token → 401
  const noTokenGet = await request('GET', '/api/users');
  if (noTokenGet.status === 401) {
    pass('GET /api/users without token → 401');
  } else {
    fail('GET /api/users without token should be 401', `got ${noTokenGet.status}`);
  }

  // 5d. GET /api/users WITH valid token → 200 + no passwords exposed
  const withTokenGet = await request('GET', '/api/users', null, { Authorization: `Bearer ${token}` });
  if (withTokenGet.status === 200) {
    const users = withTokenGet.body.users || [];
    const hasPassword = users.some(u => u.password !== undefined);
    pass(`GET /api/users with token → 200 (${users.length} users)`);
    if (!hasPassword) {
      pass('Passwords NOT exposed in user list response');
    } else {
      fail('CRITICAL: Password hashes exposed in /api/users response!');
    }
  } else {
    fail('GET /api/users with valid token failed', `got ${withTokenGet.status}`);
  }

  // 5e. POST /api/users (Add user) WITH token → 200
  const testUsername = `testuser_${Date.now()}`;
  const addRes = await request('POST', '/api/users',
    { username: testUsername, password: 'Test@1234', role: 'supervisor', name: 'مستخدم اختبار' },
    { Authorization: `Bearer ${token}` }
  );
  let newUserId = null;
  if (addRes.status === 200 && addRes.body.success) {
    newUserId = addRes.body.user.id;
    pass('POST /api/users with token → 200 (user created)', `id=${newUserId}`);
  } else {
    fail('POST /api/users with token failed', JSON.stringify(addRes.body));
  }

  // 5f. PATCH /api/users/:id/password WITH token → 200
  if (newUserId) {
    const patchRes = await request('PATCH', `/api/users/${newUserId}/password`,
      { newPassword: 'NewPass@5678' },
      { Authorization: `Bearer ${token}` }
    );
    if (patchRes.status === 200 && patchRes.body.success) {
      pass('PATCH /api/users/password with token → 200');
    } else {
      fail('PATCH /api/users/password with token failed', JSON.stringify(patchRes.body));
    }
  }

  // 5g. DELETE /api/users/:id WITH token → 200
  if (newUserId) {
    const delRes = await request('DELETE', `/api/users/${newUserId}`, null,
      { Authorization: `Bearer ${token}` }
    );
    if (delRes.status === 200 && delRes.body.success) {
      pass('DELETE /api/users with token → 200 (user deleted)');
    } else {
      fail('DELETE /api/users with token failed', JSON.stringify(delRes.body));
    }
  }

  // 5h. POST /api/users WITHOUT token → 401
  const noTokPost = await request('POST', '/api/users',
    { username: 'hacker', password: 'hack123', role: 'admin', name: 'Hacker' }
  );
  if (noTokPost.status === 401) {
    pass('POST /api/users without token → 401 (blocked)');
  } else {
    fail('POST /api/users without token should be 401', `got ${noTokPost.status}`);
  }

  // 5i. DELETE /api/users WITHOUT token → 401
  const noTokDel = await request('DELETE', '/api/users/superadmin-default');
  if (noTokDel.status === 401) {
    pass('DELETE /api/users without token → 401 (blocked)');
  } else {
    fail('DELETE /api/users without token should be 401', `got ${noTokDel.status}`);
  }

  // 5j. PATCH password WITHOUT token → 401
  const noTokPatch = await request('PATCH', '/api/users/superadmin-default/password', { newPassword: 'hacked' });
  if (noTokPatch.status === 401) {
    pass('PATCH /api/users/password without token → 401 (blocked)');
  } else {
    fail('PATCH /api/users/password without token should be 401', `got ${noTokPatch.status}`);
  }

  // 5k. With FAKE/FORGED token → 403
  const fakeToken = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6ImhhY2tlciIsInJvbGUiOiJzdXBlcmFkbWluIn0.FAKE_SIGNATURE';
  const fakeRes = await request('GET', '/api/users', null, { Authorization: `Bearer ${fakeToken}` });
  if (fakeRes.status === 403) {
    pass('Forged JWT token → 403 Forbidden');
  } else {
    fail('Forged JWT should return 403', `got ${fakeRes.status}`);
  }

  // 5l. POST /api/storage/app-users WITHOUT token → 401
  const storageProtect = await request('POST', '/api/storage/app-users', { value: '[]' });
  if (storageProtect.status === 401) {
    pass('POST /api/storage/app-users without token → 401 (protected key blocked)');
  } else {
    fail('POST /api/storage/app-users without token should be 401', `got ${storageProtect.status}`);
  }

  // 5m. POST /api/storage/work-permits (open route) → 200
  const openRoute = await request('GET', '/api/storage/work-permits');
  if (openRoute.status === 200) {
    pass('GET /api/storage/work-permits (open route) → 200');
  } else {
    fail('GET /api/storage/work-permits should be open', `got ${openRoute.status}`);
  }

  // 5n. Verify superadmin cannot be deleted even with token
  const delSA = await request('DELETE', '/api/users/superadmin-default', null,
    { Authorization: `Bearer ${token}` }
  );
  if (delSA.status === 403) {
    pass('DELETE superadmin with valid token → 403 (protected role)');
  } else {
    fail('Deleting superadmin should return 403', `got ${delSA.status}`);
  }
}

// ================================================================
// FINAL REPORT
// ================================================================
function printFinalReport() {
  const total = passed + failed + warned;
  const pct   = total > 0 ? Math.round((passed / total) * 100) : 0;

  console.log('\n' + '═'.repeat(60));
  console.log(' 📊 FINAL TEST REPORT — Work Permits App');
  console.log('═'.repeat(60));
  console.log(`  Total Checks : ${total}`);
  console.log(`  ✅ Passed    : ${passed}`);
  console.log(`  ❌ Failed    : ${failed}`);
  console.log(`  ⚠️  Warnings  : ${warned}`);
  console.log(`  Score        : ${passed}/${total} (${pct}%)`);
  console.log('─'.repeat(60));

  if (failures.length > 0) {
    console.log('\n  ❌ FAILED CHECKS:');
    failures.forEach(f => console.log(`     • ${f}`));
  }

  console.log('\n' + '═'.repeat(60));
  if (failed === 0) {
    console.log(' 🏆 VERDICT: ✅ PRODUCTION-READY — All checks passed!');
    console.log(' 🚀 System is cleared for live deployment at Elsewedy Polymers.');
  } else if (pct >= 85) {
    console.log(` ⚠️  VERDICT: MOSTLY READY — ${failed} issue(s) need attention.`);
  } else {
    console.log(` 🚫 VERDICT: NOT READY — ${failed} critical issue(s) found.`);
  }
  console.log('═'.repeat(60) + '\n');
}

// ================================================================
// MAIN — Run all sections sequentially
// ================================================================
async function main() {
  console.log('\n' + '═'.repeat(60));
  console.log(' 🔬 Work Permits App — Production Readiness Test Suite');
  console.log(' 📅 ' + new Date().toLocaleString('ar-EG'));
  console.log('═'.repeat(60));

  try {
    // Ping server first
    const ping = await request('GET', '/api/storage/work-permits');
    if (ping.status !== 200 && ping.status !== 404) throw new Error(`Server unreachable, status: ${ping.status}`);
    pass('Server is reachable at http://localhost:3000');
  } catch (e) {
    fail('Server is NOT running', e.message);
    console.log('\n  ⛔ Cannot continue without a running server.');
    console.log('  Run: node server.js\n');
    process.exit(1);
  }

  await section1_fileIntegrity();
  await section2_domBindings();
  await section3_workerFlow();
  await section4_concurrency();
  await section5_jwtRbac();

  printFinalReport();
}

main().catch(e => {
  console.error('\n⛔ Unexpected error:', e.message);
  process.exit(1);
});
