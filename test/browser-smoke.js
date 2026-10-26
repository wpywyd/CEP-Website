import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.js';
import { provisionTeacher } from '../store.js';

const dir = mkdtempSync(join(tmpdir(), 'showcase-browser-'));
const { server, db } = createApp({ database: join(dir, 'portal.sqlite'), secureCookies: false });
const password = 'Browser password 42';
const schoolId = 'sg-admiralty-secondary-school';
provisionTeacher(db, 'school.teacher', password, schoolId);
provisionTeacher(db, 'programme.admin', password, null);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox']
  });
  const errors = [];
  const badResponses = [];
  const inspect = (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('response', (response) => {
      if (response.status() >= 500) badResponses.push(`${response.status()} ${response.url()}`);
    });
  };

  const student = await browser.newPage();
  inspect(student);
  await student.goto(origin);
  await student.locator('#open-signin').click();
  await student.locator('[data-auth="student-register"]').click();
  await student.locator('#student-register-form [name="schoolId"]').selectOption(schoolId);
  await student.locator('#student-register-form [name="className"]').fill('Secondary 1A');
  await student.locator('#student-register-form [name="fullName"]').fill('Alex Tan');
  await student.locator('#student-register-form [name="username"]').fill('alex.tan');
  await student.locator('#student-register-form [name="password"]').fill(password);
  await student.locator('#student-register-form [name="confirmPassword"]').fill(password);
  await student.locator('#student-register-form [name="fullNameConfirmed"]').check();
  await student.locator('#student-register-form button[type="submit"]').click();
  await student.locator('#no-team').waitFor({ state: 'visible' });
  await student.locator('#create-team [name="name"]').fill('Pixel Pioneers');
  student.once('dialog', (dialog) => dialog.accept());
  await student.locator('#create-team button').click();
  await student.locator('#team-dashboard').waitFor({ state: 'visible' });
  await student.locator('[data-student-panel="project"]').first().click();
  const dashboardBack = student.locator('#student-project-panel .back');
  assert.match(await dashboardBack.innerText(), /←\s+Back to dashboard/);
  assert.equal(
    await dashboardBack.evaluate((element) => getComputedStyle(element).borderStyle),
    'solid'
  );
  const votingBack = student.locator('#vote-view .back');
  assert.match(await votingBack.innerText(), /←\s+Back to dashboard/);
  assert.equal(
    await votingBack.evaluate((element) => getComputedStyle(element).borderStyle),
    'solid'
  );
  const editor = student.locator('#project-editor-form');
  await editor.locator('[name="title"]').fill('Ocean Rescue');
  await editor.locator('[name="categoryId"]').selectOption({ index: 1 });
  await editor.locator('[name="description"]').fill('Clean the ocean and rescue sea animals.');
  await editor
    .locator('[name="learningStory"]')
    .fill('We learned how recycling choices affect ocean habitats through game design.');
  await editor.locator('[name="projectUrl"]').fill('https://arcade.makecode.com/12345');
  await editor.locator('[name="tags"]').fill('ocean, recycling');
  await editor.locator('[name="cover"]').setInputFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64'
    )
  });
  await editor.locator('[name="video"]').setInputFiles({
    name: 'demo.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.from('project-demo-video')
  });
  await editor.locator('button[type="submit"]').click();
  await student.getByText('Draft saved.').waitFor();
  await student.locator('#submit-project').click();
  await student.locator('#team-dashboard').waitFor({ state: 'visible' });
  await student.locator('#current-project').getByText('submitted', { exact: true }).waitFor();
  assert.equal(
    await student
      .locator('#current-project .project-banner img')
      .evaluate((image) => image.complete && image.naturalWidth > 0),
    true
  );
  await student.locator('[data-student-panel="project"]').first().click();
  assert.equal(await student.locator('#submit-project').innerText(), 'Edit submission');
  await student.locator('#submit-project').click();
  await student.waitForFunction(
    () => !document.querySelector('#project-editor-form [name="title"]').disabled
  );
  assert.equal(await student.locator('#project-editor-form [name="title"]').isEnabled(), true);
  await student.getByText('Submission unlocked. Make your changes and submit it again.').waitFor();
  await student.locator('#submit-project').click();
  await student.locator('#team-dashboard').waitFor({ state: 'visible' });
  await student.locator('#current-project').getByText('submitted', { exact: true }).waitFor();
  assert.equal(
    await student.locator('.project-actions').evaluate((element) => getComputedStyle(element).gap),
    '16px 24px'
  );

  const [studentHomeResponse] = await Promise.all([
    student.waitForResponse(
      (response) =>
        response.url() === `${origin}/` && response.request().resourceType() === 'document'
    ),
    student.locator('#student-shell .app-brand').click()
  ]);
  assert.match(await studentHomeResponse.text(), /data-destination="\/student"[\s\S]*Dashboard/);
  await student.waitForURL(origin + '/');
  await student.locator('#open-signin', { hasText: 'Dashboard' }).waitFor();
  assert.equal(await student.locator('#open-signin').innerText(), 'Dashboard →');
  await student.locator('#open-signin').click();
  await student.waitForURL(origin + '/student');
  await student.locator('#team-dashboard').waitFor({ state: 'visible' });

  const teacherContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  inspect(teacher);
  const teacherResponse = await teacher.goto(`${origin}/teacher`);
  assert.equal(teacherResponse.headers()['x-robots-tag'], 'noindex, nofollow');
  await teacher.locator('#staff-login-form [name="username"]').fill('school.teacher');
  await teacher.locator('#staff-login-form [name="password"]').fill(password);
  await teacher.locator('#staff-login-form button[type="submit"]').click();
  await teacher.locator('[data-review]').click();
  await teacher.locator('#review-form').waitFor({ state: 'visible' });
  await teacher.waitForFunction(() => {
    const image = document.querySelector('#review-preview .project-cover-image');
    return image?.complete && image.naturalWidth > 0;
  });
  const reviewVideo = teacher.locator('#review-preview video');
  await reviewVideo.waitFor({ state: 'visible' });
  assert.equal(
    (
      await teacher.context().request.get(origin + (await reviewVideo.getAttribute('src')))
    ).status(),
    200
  );
  await teacher.locator('#review-form [name="feedback"]').fill('Ready to publish.');
  await teacher.locator('#review-form button[value="approve"]').click();
  await teacher.getByText('The review queue is clear.').waitFor();

  const [teacherHomeResponse] = await Promise.all([
    teacher.waitForResponse(
      (response) =>
        response.url() === `${origin}/` && response.request().resourceType() === 'document'
    ),
    teacher.locator('#staff-shell .app-brand').click()
  ]);
  assert.match(
    await teacherHomeResponse.text(),
    /data-destination="\/teacher"[\s\S]*Teacher dashboard/
  );
  await teacher.waitForURL(origin + '/');
  await teacher.locator('#open-signin', { hasText: 'Teacher dashboard' }).waitFor();
  assert.equal(await teacher.locator('#open-signin').innerText(), 'Teacher dashboard →');
  await teacher.locator('#open-signin').click();
  await teacher.waitForURL(origin + '/teacher');
  await teacher.locator('#staff-shell').waitFor({ state: 'visible' });

  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  inspect(admin);
  await admin.goto(`${origin}/admin`);
  await admin.locator('#staff-login-form [name="username"]').fill('programme.admin');
  await admin.locator('#staff-login-form [name="password"]').fill(password);
  await admin.locator('#staff-login-form button[type="submit"]').click();
  await admin.locator('#admin-stats').waitFor({ state: 'visible' });
  const [adminHomeResponse] = await Promise.all([
    admin.waitForResponse(
      (response) =>
        response.url() === `${origin}/` && response.request().resourceType() === 'document'
    ),
    admin.locator('#staff-shell .app-brand').click()
  ]);
  assert.match(await adminHomeResponse.text(), /data-destination="\/admin"[\s\S]*Admin dashboard/);
  await admin.waitForURL(origin + '/');
  await admin.locator('#open-signin', { hasText: 'Admin dashboard' }).waitFor();
  assert.equal(await admin.locator('#open-signin').innerText(), 'Admin dashboard →');
  await admin.locator('#open-signin').click();
  await admin.waitForURL(origin + '/admin');
  await admin.locator('#admin-stats').waitFor({ state: 'visible' });

  const publicPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  inspect(publicPage);
  await publicPage.goto(origin);
  await publicPage.locator('#public-projects').getByText('Ocean Rescue').waitFor();
  await publicPage.locator('[data-project]').first().click();
  await publicPage.locator('#project-dialog').waitFor({ state: 'visible' });
  const publicVideo = publicPage.locator('#project-detail video');
  await publicVideo.waitFor({ state: 'visible' });
  assert.equal(
    (
      await publicPage.context().request.get(origin + (await publicVideo.getAttribute('src')))
    ).status(),
    200
  );
  assert.equal(
    await publicPage.locator('#project-detail').getByText('Pixel Pioneers').isVisible(),
    true
  );

  db.prepare('INSERT INTO round_projects VALUES (?, ?)').run(
    'round-1',
    db.prepare('SELECT id FROM showcase_projects LIMIT 1').get().id
  );
  const voter = await publicPage.context().request.post(`${origin}/api/students/register`, {
    headers: { Origin: origin, 'X-CEP-Request': '1' },
    data: {
      schoolId,
      className: '2B',
      fullName: 'Jamie Lee',
      username: 'jamie.lee',
      password,
      fullNameConfirmed: true
    }
  });
  assert.equal(voter.status(), 201);
  await publicPage.goto(`${origin}/vote`);
  await publicPage.locator('.ballot-card input').check();
  await publicPage.getByRole('button', { name: 'View details', exact: true }).click();
  await publicPage.locator('#project-dialog').waitFor({ state: 'visible' });
  assert.equal(await publicPage.locator('#project-detail h2').innerText(), 'Ocean Rescue');
  await publicPage.locator('#project-dialog [data-close]').click();
  assert.equal(await publicPage.locator('.ballot-card input').isChecked(), true);

  assert.deepEqual(errors, []);
  assert.deepEqual(badResponses, []);
  console.log(
    'PASS: redesigned registration, team creation, project editing, submission, teacher approval, public publishing, privacy headers, and mobile layout.'
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
