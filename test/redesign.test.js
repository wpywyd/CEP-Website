import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.js';
import { provisionTeacher } from '../store.js';

test('redesigned team, review, selected ballot and final vote workflow', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'showcase-redesign-'));
  const { server, db } = createApp({ database: join(dir, 'portal.sqlite'), secureCookies: false });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const password = 'Testing password 42';
  const schoolId = 'sg-admiralty-secondary-school';
  provisionTeacher(db, 'coordinator', password);
  provisionTeacher(db, 'school.teacher', password, schoolId);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(path, method = 'GET', data, cookie = '') {
    const response = await fetch(origin + path, {
      method,
      headers: {
        Origin: origin,
        'X-CEP-Request': '1',
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {})
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {})
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0]
    };
  }
  async function register(name, username) {
    const response = await request('/api/students/register', 'POST', {
      schoolId,
      className: 'Secondary 1A',
      fullName: name,
      username,
      password,
      fullNameConfirmed: true
    });
    assert.equal(response.status, 201);
    return response.cookie;
  }
  async function loginTeacher(username) {
    const response = await request('/api/login', 'POST', { username, password });
    assert.equal(response.status, 200);
    return response.cookie;
  }
  async function uploadVideo(cookie) {
    const response = await fetch(origin + '/api/v2/project/video', {
      method: 'PUT',
      headers: {
        Origin: origin,
        'X-CEP-Request': '1',
        'Content-Type': 'video/mp4',
        Cookie: cookie
      },
      body: Buffer.from('project-demo-video')
    });
    return { status: response.status, data: await response.json() };
  }
  async function createAndSubmit(cookie, teamName, title) {
    const team = await request('/api/v2/teams', 'POST', { name: teamName }, cookie);
    assert.equal(team.status, 201);
    const categoryId = db.prepare('SELECT id FROM categories ORDER BY sort_order LIMIT 1').get().id;
    const saved = await request(
      '/api/v2/project/draft',
      'PUT',
      {
        title,
        description: 'A complete student project description.',
        learningStory: 'We learned how choices affect systems through playtesting.',
        projectUrl: 'https://arcade.makecode.com/12345',
        coverImage: 'data:image/png;base64,iVBORw0KGgo=',
        tags: ['learning'],
        categoryId,
        year: 2026
      },
      cookie
    );
    assert.equal(saved.status, 200);
    assert.equal((await request('/api/v2/project/submit', 'POST', {}, cookie)).status, 400);
    assert.equal((await uploadVideo(cookie)).status, 200);
    assert.equal((await request('/api/v2/project/submit', 'POST', {}, cookie)).status, 200);
    assert.equal((await request('/api/v2/project/withdraw', 'POST', {}, cookie)).status, 200);
    assert.equal(
      (await request('/api/v2/student/home', 'GET', undefined, cookie)).data.team.project.state,
      'draft'
    );
    assert.equal((await request('/api/v2/project/submit', 'POST', {}, cookie)).status, 200);
    return saved.data.project.id;
  }
  const first = await register('Alex Tan', 'alex.tan');
  const second = await register('Jamie Lee', 'jamie.lee');
  const firstProject = await createAndSubmit(first, 'Pixel Pioneers', 'Ocean Rescue');
  const secondProject = await createAndSubmit(second, 'Orbit Crew', 'Gravity Quest');
  const teacher = await loginTeacher('school.teacher');
  const dashboard = await request('/api/v2/teacher/dashboard', 'GET', undefined, teacher);
  assert.equal(dashboard.data.reviews.length, 2);
  for (const review of dashboard.data.reviews) {
    assert.equal(
      (
        await request(
          `/api/v2/teacher/reviews/${review.revisionId}`,
          'POST',
          { decision: 'approve', feedback: 'Ready to publish.' },
          teacher
        )
      ).status,
      200
    );
  }
  const admin = await loginTeacher('coordinator');
  const round = await request(
    '/api/v2/admin/rounds',
    'POST',
    { name: 'Future Makers 2026', projectIds: [firstProject, secondProject], schoolIds: [] },
    admin
  );
  assert.equal(round.status, 201);
  assert.equal(
    (await request(`/api/v2/admin/rounds/${round.data.id}/open`, 'POST', {}, admin)).status,
    200
  );
  const ballot = await request('/api/v2/ballot', 'GET', undefined, first);
  assert.deepEqual(
    ballot.data.projects.map((project) => project.id),
    [secondProject]
  );
  assert.equal(
    (
      await request(
        '/api/v2/vote',
        'POST',
        { roundId: round.data.id, projectId: secondProject },
        first
      )
    ).status,
    201
  );
  assert.equal(
    (
      await request(
        '/api/v2/vote',
        'POST',
        { roundId: round.data.id, projectId: secondProject },
        first
      )
    ).status,
    409
  );
  const showcase = await request('/api/v2/showcase');
  assert.equal(showcase.data.projects.length, 2);
  assert.equal(showcase.data.round.totalVotes, 1);
});
