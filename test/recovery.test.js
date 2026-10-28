import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.js';
import { provisionTeacher } from '../store.js';

test('password recovery hides account existence and limits staff to authorized resets', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cep-recovery-'));
  const { server, db } = createApp({ database: join(dir, 'portal.sqlite'), secureCookies: false });
  const password = 'OriginalPass42';
  const schoolId = 'sg-admiralty-secondary-school';
  provisionTeacher(db, 'teacher.one', password, schoolId);
  provisionTeacher(db, 'teacher.two', password, 'sg-ahmad-ibrahim-secondary-school');
  provisionTeacher(db, 'administrator', password);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function call(path, method = 'GET', data, cookie = '') {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        'X-CEP-Request': '1',
        Cookie: cookie,
        ...(data ? { 'Content-Type': 'application/json' } : {})
      },
      ...(data ? { body: JSON.stringify(data) } : {})
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0]
    };
  }
  const login = async (username) =>
    (await call('/api/login', 'POST', { username, password })).cookie;
  const teacher = await login('teacher.one');
  const outsider = await login('teacher.two');
  const admin = await login('administrator');
  const pupil = await call('/api/students/register', 'POST', {
    schoolId,
    className: '1A',
    fullName: 'Alex Tan',
    username: 'alex.tan',
    password,
    fullNameConfirmed: true
  });
  const known = await call('/api/v2/password-help', 'POST', { username: 'alex.tan' });
  const unknown = await call('/api/v2/password-help', 'POST', { username: 'unknown.user' });
  assert.equal(known.status, unknown.status);
  assert.deepEqual(known.data, unknown.data);
  await call('/api/v2/password-help', 'POST', { username: 'alex.tan' });
  assert.equal((await call('/api/v2/teacher/password-requests')).status, 401);
  assert.equal(
    (await call('/api/v2/teacher/password-requests', 'GET', undefined, outsider)).data.requests
      .length,
    0
  );
  const requests = (await call('/api/v2/teacher/password-requests', 'GET', undefined, teacher)).data
    .requests;
  assert.equal(requests.length, 1);
  const resetPath = `/api/v2/teacher/password-requests/${requests[0].id}`;
  assert.equal((await call(resetPath, 'DELETE', {}, outsider)).status, 403);
  assert.equal((await call(resetPath, 'DELETE', {}, teacher)).status, 200);
  assert.equal(
    (await call('/api/v2/teacher/password-requests', 'GET', undefined, teacher)).data.requests
      .length,
    0
  );
  assert.equal((await call('/api/v2/student/home', 'GET', undefined, pupil.cookie)).status, 200);
  await call('/api/v2/password-help', 'POST', { username: 'alex.tan' });
  assert.equal(
    (await call(resetPath, 'POST', { password: 'NewPassword42' }, outsider)).status,
    403
  );
  assert.equal((await call(resetPath, 'POST', { password: 'short' }, teacher)).status, 400);
  assert.equal((await call(resetPath, 'POST', { password: 'NewPassword42' }, teacher)).status, 200);
  assert.equal((await call('/api/v2/student/home', 'GET', undefined, pupil.cookie)).status, 401);
  assert.equal(
    (await call('/api/signin', 'POST', { username: 'alex.tan', password: 'NewPassword42' })).status,
    200
  );
  await call('/api/v2/password-help', 'POST', { username: 'teacher.two' });
  const staffRequest = (await call('/api/v2/teacher/password-requests', 'GET', undefined, admin))
    .data.requests[0];
  const staffReset = `/api/v2/teacher/password-requests/${staffRequest.id}`;
  assert.equal((await call(staffReset, 'POST', { password: 'NewTeacher42' }, teacher)).status, 403);
  assert.equal((await call(staffReset, 'POST', { password: 'NewTeacher42' }, admin)).status, 200);
  assert.equal(
    (await call('/api/signin', 'POST', { username: 'teacher.two', password: 'NewTeacher42' })).data
      .role,
    'teacher'
  );
});
