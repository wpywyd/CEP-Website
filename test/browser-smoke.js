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
  await editor.locator('button[type="submit"]').click();
  await student.getByText('Draft saved.').waitFor();
  await student.locator('#submit-project').click();
  await student.locator('#team-dashboard').waitFor({ state: 'visible' });
  await student.locator('#current-project').getByText('submitted', { exact: true }).waitFor();

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
  await teacher.locator('#review-form [name="feedback"]').fill('Ready to publish.');
  await teacher.locator('#review-form button[value="approve"]').click();
  await teacher.getByText('The review queue is clear.').waitFor();

  const publicPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  inspect(publicPage);
  await publicPage.goto(origin);
  await publicPage.locator('#public-projects').getByText('Ocean Rescue').waitFor();
  await publicPage.locator('[data-project]').first().click();
  await publicPage.locator('#project-dialog').waitFor({ state: 'visible' });
  assert.equal(
    await publicPage.locator('#project-detail').getByText('Pixel Pioneers').isVisible(),
    true
  );

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
