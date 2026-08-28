import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '20s', target: 30 },
    { duration: '1m',  target: 80 },
    { duration: '20s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000'],
    http_req_failed: ['rate<0.02'],
  },
};

const BASE_URL = 'https://elsewedy-polymers-work-permits.up.railway.app';

export default function () {
  const jar = http.cookieJar();

  // 1. فحص الصفحة الرئيسية
  const resHome = http.get(BASE_URL, { jar });
  check(resHome, {
    'Home Loaded (200)': (r) => r.status === 200,
  });

  // 2. فحص تسجيل الدخول
  const loginPayload = JSON.stringify({ code: '1' });
  const loginParams = {
    headers: { 'Content-Type': 'application/json' },
    jar,
  };
  const resLogin = http.post(`${BASE_URL}/login`, loginPayload, loginParams);
  check(resLogin, {
    'Login Success': (r) => r.status === 200 || r.status === 304,
  });

  // 3. فحص مسارات البيانات
  const resEmp = http.get(`${BASE_URL}/employees`, { jar });
  check(resEmp, {
    'Employees OK': (r) => r.status === 200 || r.status === 304,
  });

  const resHazards = http.get(`${BASE_URL}/hazards`, { jar });
  check(resHazards, {
    'Hazards OK': (r) => r.status === 200 || r.status === 304,
  });

  sleep(0.5);
}
