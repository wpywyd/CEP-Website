import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.js';
import { provisionTeacher } from '../store.js';
import { SECONDARY_SCHOOLS } from '../school-directory.js';

const PASSWORD = 'Long test password 42!';
const SCHOOL_1 = 'sg-admiralty-secondary-school';
const SCHOOL_2 = 'sg-ahmad-ibrahim-secondary-school';
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cep-test-'));
  const database = join(dir, 'portal.sqlite');
  let app = createApp({ database, secureCookies: false });
  async function listen() {
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  }
  await listen();
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  provisionTeacher(app.db, 'admin', PASSWORD);
  provisionTeacher(app.db, 'teacher1', PASSWORD, SCHOOL_1);
  provisionTeacher(app.db, 'teacher2', PASSWORD, SCHOOL_2);
  const f = {
    dir,
    get db() {
      return app.db;
    },
    async request(path, method = 'GET', data, cookie = '', extra = {}) {
      const origin = `http://127.0.0.1:${app.server.address().port}`;
      const r = await fetch(origin + path, {
        method,
        headers: {
          Origin: origin,
          'X-CEP-Request': '1',
          ...(data ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...extra
        },
        ...(data ? { body: JSON.stringify(data) } : {})
      });
      return {
        status: r.status,
        data: await r.json(),
        cookie: r.headers.get('set-cookie')?.split(';')[0],
        headers: r.headers
      };
    },
    async login(username = 'admin') {
      const r = await this.request('/api/login', 'POST', { username, password: PASSWORD });
      assert.equal(r.status, 200);
      return r.cookie;
    },
    async class(schoolId = SCHOOL_1, name = 'Secondary 1A') {
      const r = await this.request('/api/classes', 'POST', { schoolId, name }, this.admin);
      assert.equal(r.status, 201);
      return r.data;
    },
    async project(schoolId = SCHOOL_1, title = 'Learning Game', status = 'Published') {
      const r = await this.request(
        '/api/projects',
        'POST',
        {
          schoolId,
          gameTitle: title,
          teamName: 'Team A',
          learningTopic: 'Math',
          description: 'Learn by playing.',
          makecodeUrl: 'https://arcade.makecode.com/',
          status,
          progress: 100,
          currentSession: 8,
          trainerFeedback: 'PRIVATE FEEDBACK'
        },
        this.admin
      );
      assert.equal(r.status, 201);
      return r.data;
    },
    async register(overrides = {}) {
      return this.request('/api/students/register', 'POST', {
        schoolId: SCHOOL_1,
        classId: this.class1.id,
        fullName: 'Alex Tan',
        username: 'alex.tan',
        password: PASSWORD,
        fullNameConfirmed: true,
        ...overrides
      });
    },
    async restart() {
      await new Promise((resolve) => app.server.close(resolve));
      app.db.close();
      app = createApp({ database, secureCookies: false });
      await listen();
    }
  };
  f.admin = await f.login();
  f.class1 = await f.class();
  return f;
}

test('registration stores a private full name and salted password, not plaintext', async (t) => {
  const f = await fixture(t);
  const r = await f.register({ fullName: '  Alex   Tan  ' });
  assert.equal(r.status, 201);
  assert.match(r.headers.get('set-cookie'), /HttpOnly/);
  assert.match(r.headers.get('set-cookie'), /SameSite=Strict/);
  const stored = f.db.prepare('SELECT * FROM students').get();
  assert.equal(stored.full_name, 'Alex Tan');
  assert.equal(stored.name_key, 'alex tan');
  assert.notEqual(stored.password_hash, PASSWORD);
  assert.equal(
    f.db
      .prepare('SELECT token_hash FROM student_sessions')
      .get()
      .token_hash.includes(r.cookie.split('=')[1]),
    false
  );
  const publicData = await f.request('/api/showcase');
  assert.equal(JSON.stringify(publicData.data).includes('Alex Tan'), false);
  assert.equal((await f.request('/api/students')).status, 401);
  assert.equal((await f.request('/api/backup', 'GET', null, r.cookie)).status, 404);
});

test('registration and management expose the Singapore secondary-school directory without legacy placeholders', async (t) => {
  const f = await fixture(t);
  const registration = await f.request('/api/registration');
  assert.equal(registration.status, 200);
  assert.equal(registration.data.schools.length, SECONDARY_SCHOOLS.length);
  assert.deepEqual(
    registration.data.schools.map((school) => school.name),
    [...SECONDARY_SCHOOLS].map((school) => school.name).sort()
  );
  assert.equal(
    registration.data.schools.some((school) => /^School [1-9]$/.test(school.name)),
    false
  );
  assert.ok(registration.data.schools.some((school) => school.name === 'Beatty Secondary School'));
  const management = await f.request('/api/manage', 'GET', null, f.admin);
  assert.equal(
    management.data.schools.filter((school) => school.isActive).length,
    SECONDARY_SCHOOLS.length
  );
});

test('normalised school + class + name is unique, including concurrent registrations', async (t) => {
  const f = await fixture(t);
  const attempts = await Promise.all([
    f.register(),
    f.register({ fullName: ' ALEX  TAN ', username: 'another.user' })
  ]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 409]);
  const unicode = await f.register({ fullName: 'Ａｌｅｘ Ｔａｎ', username: 'unicode.user' });
  assert.equal(unicode.status, 409);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM students').get().count, 1);
  const class2 = await f.class(SCHOOL_1, 'Secondary 1B');
  assert.equal((await f.register({ classId: class2.id, username: 'other.class' })).status, 201);
  const otherSchool = await f.class(SCHOOL_2, 'Secondary 1A');
  assert.equal(
    (await f.register({ schoolId: SCHOOL_2, classId: otherSchool.id, username: 'other.school' }))
      .status,
    201
  );
});

test('registration validates school/class, full-name confirmation, username and password', async (t) => {
  const f = await fixture(t);
  const other = await f.class(SCHOOL_2);
  for (const overrides of [
    { classId: other.id },
    { fullName: 'Student123' },
    { fullName: '<script>' },
    { fullNameConfirmed: false },
    { username: 'a' },
    { password: 'short' },
    { password: 'abcdefgh' },
    { password: '12345678' },
    { classId: 'invented' }
  ]) {
    assert.equal((await f.register(overrides)).status, 400);
  }
  assert.equal((await f.register({ fullName: '李小明', username: 'student.li' })).status, 201);
  assert.equal((await f.register({ fullName: 'Madonna', username: 'student.one' })).status, 201);
  assert.equal(
    (await f.register({ fullName: 'Sam Lee', username: 'student.standard', password: 'Abcdefg1' }))
      .status,
    201
  );
  assert.equal((await f.request('/api/registration')).data.classes.length, 2);
});

test('a vote is final across devices and concurrent requests; new rounds permit one new vote', async (t) => {
  const f = await fixture(t);
  const a = await f.project();
  const b = await f.project(SCHOOL_2, 'Second Game');
  const registered = await f.register();
  const cookie = registered.cookie;
  const info = await f.request('/api/voter', 'GET', null, cookie);
  const roundId = info.data.round.id;
  const votes = await Promise.all([
    f.request('/api/vote', 'POST', { projectId: a.id, roundId }, cookie),
    f.request('/api/vote', 'POST', { projectId: b.id, roundId }, cookie)
  ]);
  assert.deepEqual(votes.map((r) => r.status).sort(), [201, 409]);
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM student_votes').get().count, 1);
  const newDevice = await f.request('/api/students/login', 'POST', {
    username: 'alex.tan',
    password: PASSWORD
  });
  assert.equal(newDevice.status, 200);
  const saved = (await f.request('/api/voter', 'GET', null, newDevice.cookie)).data.vote;
  assert.ok(saved);
  assert.equal(
    (await f.request('/api/vote', 'POST', { projectId: b.id, roundId }, newDevice.cookie)).status,
    409
  );
  assert.equal(
    (await f.request('/api/showcase')).data.projects.reduce((n, p) => n + p.votes, 0),
    1
  );
  assert.equal(
    (await f.request('/api/round', 'POST', { name: 'Next round' }, f.admin)).status,
    409
  );
  assert.equal((await f.request('/api/round/close', 'POST', {}, f.admin)).status, 200);
  const closed = await f.request('/api/voter', 'GET', null, cookie);
  assert.equal(closed.data.round.isOpen, 0);
  const next = await f.request('/api/round', 'POST', { name: 'Next round' }, f.admin);
  assert.equal(next.status, 201);
  assert.equal(
    (await f.request('/api/vote', 'POST', { projectId: a.id, roundId }, cookie)).status,
    409
  );
  assert.equal(
    (await f.request('/api/vote', 'POST', { projectId: a.id, roundId: next.data.id }, cookie))
      .status,
    201
  );
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM student_votes').get().count, 2);
});

test('anonymous votes, unpublished projects, foreign origins and old code routes are rejected', async (t) => {
  const f = await fixture(t);
  const draft = await f.project(SCHOOL_1, 'Draft', 'In progress');
  const student = await f.register();
  assert.equal(
    (await f.request('/api/vote', 'POST', { projectId: draft.id, roundId: 'round-1' })).status,
    401
  );
  assert.equal(
    (
      await f.request(
        '/api/vote',
        'POST',
        { projectId: draft.id, roundId: 'round-1' },
        student.cookie
      )
    ).status,
    400
  );
  assert.equal(
    (
      await f.request('/api/students/register', 'POST', {}, '', {
        Origin: 'https://foreign.example'
      })
    ).status,
    403
  );
  assert.equal(
    (await f.request('/api/vote', 'POST', {}, student.cookie, { 'X-CEP-Request': '' })).status,
    403
  );
  assert.equal((await f.request('/api/codes', 'POST', {}, f.admin)).status, 404);
  assert.equal((await f.request('/api/showcase')).data.projects.length, 0);
});

test('teacher school permissions protect student data, projects, classes and password resets', async (t) => {
  const f = await fixture(t);
  const r = await f.register();
  const id = f.db.prepare('SELECT id FROM students').get().id;
  const teacher1 = await f.login('teacher1');
  const teacher2 = await f.login('teacher2');
  assert.equal((await f.request('/api/students', 'GET', null, teacher1)).data.students.length, 1);
  assert.equal((await f.request('/api/students', 'GET', null, teacher2)).data.students.length, 0);
  assert.equal((await f.request('/api/students', 'GET', null, r.cookie)).status, 401);
  assert.equal(
    (
      await f.request(
        `/api/students/${id}/password`,
        'PUT',
        { password: 'Different password 1!' },
        teacher2
      )
    ).status,
    403
  );
  assert.equal(
    (
      await f.request(
        '/api/classes',
        'POST',
        { schoolId: SCHOOL_1, name: 'Secondary 1C' },
        teacher2
      )
    ).status,
    403
  );
  assert.equal((await f.request('/api/round/close', 'POST', {}, teacher1)).status, 403);
  const p = await f.project();
  assert.equal(
    (await f.request(`/api/projects/${p.id}`, 'DELETE', { revision: p.revision }, teacher2)).status,
    403
  );
  const publicProject = (await f.request('/api/showcase')).data.projects[0];
  assert.equal('trainerFeedback' in publicProject, false);
  const newPassword = 'Different password 1!';
  assert.equal(
    (await f.request(`/api/students/${id}/password`, 'PUT', { password: newPassword }, teacher1))
      .status,
    200
  );
  assert.equal((await f.request('/api/voter', 'GET', null, r.cookie)).status, 401);
  assert.equal(
    (await f.request('/api/students/login', 'POST', { username: 'alex.tan', password: PASSWORD }))
      .status,
    401
  );
  assert.equal(
    (
      await f.request('/api/students/login', 'POST', {
        username: 'alex.tan',
        password: newPassword
      })
    ).status,
    200
  );
});

test('records, identity checks, sessions and final votes survive a server restart', async (t) => {
  const f = await fixture(t);
  const p = await f.project();
  const r = await f.register();
  assert.equal(
    (await f.request('/api/vote', 'POST', { projectId: p.id, roundId: 'round-1' }, r.cookie))
      .status,
    201
  );
  await f.restart();
  assert.equal((await f.request('/api/voter', 'GET', null, r.cookie)).data.vote.projectId, p.id);
  assert.equal((await f.register({ username: 'duplicate.after.restart' })).status, 409);
  assert.equal(
    (await f.request('/api/vote', 'POST', { projectId: p.id, roundId: 'round-1' }, r.cookie))
      .status,
    409
  );
  assert.equal((await f.request('/api/showcase')).data.projects[0].votes, 1);
  const closed = await f.request('/api/round/close', 'POST', {}, f.admin);
  assert.equal(closed.status, 200);
  await f.restart();
  assert.equal((await f.request('/api/voter', 'GET', null, r.cookie)).data.round.isOpen, 0);
});

test('optimistic project edits prevent overwrites and voted projects cannot be deleted', async (t) => {
  const f = await fixture(t);
  const p = await f.project();
  const r = await f.register();
  const update = await f.request(
    `/api/projects/${p.id}`,
    'PUT',
    { ...p, gameTitle: 'Updated game' },
    f.admin
  );
  assert.equal(update.status, 200);
  assert.equal((await f.request(`/api/projects/${p.id}`, 'PUT', p, f.admin)).status, 409);
  assert.equal(
    (await f.request('/api/vote', 'POST', { projectId: p.id, roundId: 'round-1' }, r.cookie))
      .status,
    201
  );
  assert.equal(
    (
      await f.request(
        `/api/projects/${p.id}`,
        'DELETE',
        { revision: update.data.revision },
        f.admin
      )
    ).status,
    409
  );
  const unpublish = await f.request(
    `/api/projects/${p.id}`,
    'PUT',
    { ...update.data, status: 'Approved' },
    f.admin
  );
  assert.equal(unpublish.status, 200);
  assert.equal((await f.request('/api/showcase')).data.projects.length, 0);
  assert.equal(
    (await f.request('/api/voter', 'GET', null, r.cookie)).data.vote.gameTitle,
    'Updated game'
  );
});

test('offline imports are transactional, school-scoped and repeatable', async (t) => {
  const f = await fixture(t);
  const p = await f.project();
  const input = { projects: [{ ...p, id: 'offline-record', gameTitle: 'Imported game' }] };
  const first = await f.request('/api/import', 'POST', input, f.admin);
  assert.deepEqual(first.data, { imported: 1, skipped: 0 });
  assert.deepEqual((await f.request('/api/import', 'POST', input, f.admin)).data, {
    imported: 0,
    skipped: 1
  });
  const teacher2 = await f.login('teacher2');
  assert.equal((await f.request('/api/import', 'POST', input, teacher2)).status, 403);
  assert.equal(
    (
      await f.request(
        '/api/import',
        'POST',
        {
          projects: [
            { ...p, id: 'new' },
            { ...p, id: 'invalid', progress: 999 }
          ]
        },
        f.admin
      )
    ).status,
    400
  );
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM projects').get().count, 2);
});

test('production requires an HTTPS origin and uses secure cookies', async (t) => {
  assert.throws(
    () => createApp({ database: ':memory:', secureCookies: true, publicOrigin: '' }),
    /HTTPS/
  );
  const app = createApp({
    database: ':memory:',
    secureCookies: true,
    publicOrigin: 'https://showcase.example'
  });
  provisionTeacher(app.db, 'admin', PASSWORD);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => app.server.close(resolve));
    app.db.close();
  });
  const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/login`, {
    method: 'POST',
    headers: {
      Origin: 'https://showcase.example',
      'X-CEP-Request': '1',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ username: 'admin', password: PASSWORD })
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Secure/);
  assert.match(response.headers.get('strict-transport-security'), /max-age/);
});

test('online backups preserve students, credentials and final votes without overwriting files', async (t) => {
  const f = await fixture(t);
  const p = await f.project();
  const r = await f.register();
  assert.equal(
    (await f.request('/api/vote', 'POST', { projectId: p.id, roundId: 'round-1' }, r.cookie))
      .status,
    201
  );
  const target = join(f.dir, 'backup.sqlite');
  const output = execFileSync(process.execPath, ['backup.js', target], {
    env: { ...process.env, DATA_DIR: f.dir },
    encoding: 'utf8'
  });
  assert.match(output, /Complete database backup saved/);
  const snapshot = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM students').get().n, 1);
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM student_votes').get().n, 1);
    assert.equal(snapshot.prepare('SELECT count(*) AS n FROM teachers').get().n, 3);
    assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    snapshot.close();
  }
  assert.throws(
    () =>
      execFileSync(process.execPath, ['backup.js', target], {
        env: { ...process.env, DATA_DIR: f.dir },
        stdio: 'pipe'
      }),
    /Command failed/
  );
});
