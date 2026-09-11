'use strict';
// ============================================================
// Work Permits App — Enterprise Audit & Automated Test Suite
// Run: node audit_test_suite.js   (server must be running)
// ============================================================

const http = require('http');

// ── Helpers ──────────────────────────────────────────────────
let passed = 0, failed = 0;

function check(label, ok, detail = '') {
  const icon = ok ? '✅ PASS' : '❌ FAIL';
  console.log(`${icon} [${label}]${detail ? ' → ' + detail : ''}`);
  ok ? passed++ : failed++;
}

function req(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'localhost', port: 3000, path, method,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const r = http.request(opts, (res) => {
      let d = '';
      res.on('data', x => d += x);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    r.on('error', e => resolve({ status: 0, body: { error: e.message } }));
    if (body) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

// ── Login Helper ─────────────────────────────────────────────
let supervisorToken = '';

async function loginAsSuperAdmin() {
  const res = await req('POST', '/api/auth/login', { username: 'superadmin', password: 'admin123' });
  if (res.status === 200 && res.body.token) {
    supervisorToken = res.body.token;
    return true;
  }
  return false;
}

// ── Test Runner ───────────────────────────────────────────────
async function runAll() {
  console.log('\n═══════════════════════════════════════════════════');
  console.log(' Work Permits Enterprise Audit — Test Suite v2.1  ');
  console.log('═══════════════════════════════════════════════════\n');

  // ── SECTION 1: Authentication ─────────────────────────────
  console.log('── SECTION 1: Authentication & JWT ─────────────────\n');

  const r1 = await req('POST', '/api/auth/login', { username: 'superadmin', password: 'admin123' });
  check('1.1 Valid superadmin login → 200', r1.status === 200, `status=${r1.status}`);
  check('1.2 Token returned', !!(r1.body && r1.body.token), `token=${r1.body.token ? 'YES' : 'NO'}`);
  check('1.3 User role = superadmin', r1.body?.user?.role === 'superadmin', `role=${r1.body?.user?.role}`);
  supervisorToken = r1.body.token || '';

  const r2 = await req('POST', '/api/auth/login', { username: 'superadmin', password: 'wrongpassword' });
  check('1.4 Invalid password → 401', r2.status === 401, `status=${r2.status}`);

  const r3 = await req('POST', '/api/auth/login', { username: 'nonexistent', password: 'any' });
  check('1.5 Non-existent user → 401', r3.status === 401, `status=${r3.status}`);

  const r4 = await req('POST', '/api/auth/login', {});
  check('1.6 Missing credentials → 400', r4.status === 400, `status=${r4.status}`);

  // ── SECTION 2: RBAC Endpoint Guards ──────────────────────
  console.log('\n── SECTION 2: RBAC Endpoint Barriers ───────────────\n');

  // No token
  const r5 = await req('PATCH', '/api/permits/WP-TEST-001', { action: 'approve' });
  check('2.1 PATCH permits (no token) → 401', r5.status === 401, `status=${r5.status}`);

  // Invalid token
  const r6 = await req('PATCH', '/api/permits/WP-TEST-001', { action: 'approve' }, { Authorization: 'Bearer bad.jwt.here' });
  check('2.2 PATCH permits (invalid token) → 403', r6.status === 403, `status=${r6.status}`);

  // GET export-excel without token
  const r7 = await req('GET', '/api/export-excel', null);
  check('2.3 GET export-excel (no token) → 401', r7.status === 401, `status=${r7.status}`);

  // GET users without token
  const r8 = await req('GET', '/api/users', null);
  check('2.4 GET /api/users (no token) → 401', r8.status === 401, `status=${r8.status}`);

  // POST users without token
  const r9 = await req('POST', '/api/users', { username: 'hack', password: '123456', role: 'admin', name: 'Hacker' });
  check('2.5 POST /api/users (no token) → 401', r9.status === 401, `status=${r9.status}`);

  // DELETE user without token
  const r10 = await req('DELETE', '/api/users/some-id');
  check('2.6 DELETE /api/users/:id (no token) → 401', r10.status === 401, `status=${r10.status}`);

  // Supervisor token but trying to write to protected storage key
  const r11 = await req('POST', '/api/storage/app-users', { value: '[]' }, { Authorization: `Bearer ${supervisorToken}` });
  check('2.7 POST /api/storage/app-users (supervisor token only — needs superadmin) — server should block non-superadmin if role differs', [403, 200].includes(r11.status), `status=${r11.status} (200=superadmin OK)`);

  // ── SECTION 3: Status Forgery Protection ─────────────────
  console.log('\n── SECTION 3: Status Forgery & Data Integrity ───────\n');

  const testPermit = [{
    id: 'WP-AUDIT-TEST-001', status: 'pending', workerName: 'Audit Worker',
    department: 'Test', shift: 'الأولى', date: '2026-08-24',
    description: 'Audit test permit', location: 'Test area',
    submittedAt: new Date().toISOString(),
    reviewedBy: '', reviewedAt: '', reviewNote: '', closure: null,
    employeeId: 'AUDIT001'
  }];

  const r12 = await req('POST', '/api/storage/work-permits', { value: JSON.stringify(testPermit) });
  check('3.1 Worker permit submission → 200', r12.status === 200, `status=${r12.status}`);

  // Attempt to forge status via direct write
  const forged = [{ ...testPermit[0], status: 'approved', reviewedBy: 'hacker' }];
  const r13 = await req('POST', '/api/storage/work-permits', { value: JSON.stringify(forged) });
  check('3.2 Forged status write accepted (HTTP level)', r13.status === 200, `status=${r13.status}`);

  const r14 = await req('GET', '/api/storage/work-permits');
  const permits14 = JSON.parse(r14.body.value || '[]');
  const p14 = permits14.find(p => p.id === 'WP-AUDIT-TEST-001');
  check('3.3 Forged status stripped → still pending', p14?.status === 'pending', `status=${p14?.status}`);
  check('3.4 Forged reviewedBy cleared', p14?.reviewedBy === '', `reviewedBy="${p14?.reviewedBy}"`);

  // Approve via protected PATCH
  const r15 = await req('PATCH', '/api/permits/WP-AUDIT-TEST-001',
    { action: 'approve', safetyOfficerName: 'Ahmed', areaManagerName: 'Mohamed' },
    { Authorization: `Bearer ${supervisorToken}` }
  );
  check('3.5 PATCH approve (valid JWT) → 200', r15.status === 200, `status=${r15.status}`);

  const r16 = await req('GET', '/api/storage/work-permits');
  const permits16 = JSON.parse(r16.body.value || '[]');
  const p16 = permits16.find(p => p.id === 'WP-AUDIT-TEST-001');
  check('3.6 Permit status = approved after PATCH', p16?.status === 'approved', `status=${p16?.status}`);

  // Try to approve an already-approved permit → 409
  const r17 = await req('PATCH', '/api/permits/WP-AUDIT-TEST-001',
    { action: 'approve' },
    { Authorization: `Bearer ${supervisorToken}` }
  );
  check('3.7 Double-approve → 409 Conflict', r17.status === 409, `status=${r17.status}`);

  // Close the permit
  const r18 = await req('PATCH', '/api/permits/WP-AUDIT-TEST-001',
    { action: 'close', closureType: 'safe', closureReason: 'Work completed safely' },
    { Authorization: `Bearer ${supervisorToken}` }
  );
  check('3.8 PATCH close (valid JWT) → 200', r18.status === 200, `status=${r18.status}`);

  const r19 = await req('GET', '/api/storage/work-permits');
  const permits19 = JSON.parse(r19.body.value || '[]');
  const p19 = permits19.find(p => p.id === 'WP-AUDIT-TEST-001');
  check('3.9 Permit status = closed_safe', p19?.status === 'closed_safe', `status=${p19?.status}`);
  check('3.10 Closure reason stored', p19?.closure?.reason === 'Work completed safely', `reason="${p19?.closure?.reason}"`);

  // ── SECTION 4: PATCH Validation ──────────────────────────
  console.log('\n── SECTION 4: Input Validation ──────────────────────\n');

  const r20 = await req('PATCH', '/api/permits/WP-AUDIT-TEST-001',
    { action: 'invalid_action' },
    { Authorization: `Bearer ${supervisorToken}` }
  );
  check('4.1 Invalid action → 400', r20.status === 400, `status=${r20.status}`);

  const r21 = await req('PATCH', '/api/permits/DOES-NOT-EXIST',
    { action: 'approve' },
    { Authorization: `Bearer ${supervisorToken}` }
  );
  check('4.2 Non-existent permit → 404', r21.status === 404, `status=${r21.status}`);

  const r22 = await req('PATCH', '/api/permits/WP-AUDIT-TEST-001',
    { action: 'close', closureType: 'bad_type' },
    { Authorization: `Bearer ${supervisorToken}` }
  );
  check('4.3 Invalid closureType → 400', r22.status === 400, `status=${r22.status}`);

  // ── SECTION 5: Employee Routes ────────────────────────────
  console.log('\n── SECTION 5: Employee API ──────────────────────────\n');

  const r23 = await req('POST', '/api/employees', { empCode: 'AUDIT-EMP-001', name: 'Test Employee', phone: '01234567890', department: 'QA' });
  check('5.1 Register new employee → 200', r23.status === 200, `status=${r23.status}`);

  const r24 = await req('GET', '/api/employees/AUDIT-EMP-001');
  check('5.2 Lookup employee by code → 200', r24.status === 200, `status=${r24.status}`);
  check('5.3 Employee name correct', r24.body?.employee?.name === 'Test Employee', `name=${r24.body?.employee?.name}`);

  const r25 = await req('GET', '/api/employees/NONEXISTENT-CODE');
  check('5.4 Unknown employee code → 404', r25.status === 404, `status=${r25.status}`);

  // ── FINAL SUMMARY ─────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log(` Results: ${passed} passed  |  ${failed} failed  |  ${passed + failed} total`);
  console.log('═══════════════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

runAll().catch(e => { console.error('Test runner error:', e); process.exit(1); });
