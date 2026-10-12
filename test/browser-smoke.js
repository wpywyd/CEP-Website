import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server.js';
import { provisionTeacher } from '../store.js';

const dir = mkdtempSync(join(tmpdir(), 'cep-browser-'));
const { server, db } = createApp({ database: join(dir, 'portal.sqlite'), secureCookies: false });
const password = 'Browser test password 42!';
const schoolId = 'sg-admiralty-secondary-school';
provisionTeacher(db, 'admin', password);
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
  const responses = [];
  function inspect(page) {
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('response', (r) => {
      if (r.status() >= 500) responses.push(`${r.status()} ${r.url()}`);
    });
  }
  const publicPage = await browser.newPage();
  inspect(publicPage);
  await publicPage.goto(origin);
  assert.equal(await publicPage.locator('nav a[href*="teacher"]').count(), 0);
  await publicPage.goto(`${origin}/#teacher`);
  assert.equal(await publicPage.locator('#showcase').isVisible(), true);
  assert.equal(await publicPage.locator('#teacher').isVisible(), false);

  const teacher = await browser.newPage();
  inspect(teacher);
  const teacherResponse = await teacher.goto(`${origin}/teacher`);
  assert.equal(teacherResponse.headers()['x-robots-tag'], 'noindex, nofollow');
  assert.equal(await teacher.locator('#login-form').isVisible(), true);
  assert.equal(await teacher.locator('#workspace').isVisible(), false);
  await teacher.locator('#login-form [name="username"]').fill('admin');
  await teacher.locator('#login-form [name="password"]').fill(password);
  await teacher.locator('#login-form button[type="submit"]').click();
  await teacher.locator('#workspace').waitFor({ state: 'visible' });
  await teacher.locator('[data-tab="schools"]').click();
  await teacher.locator('#class-school').selectOption(schoolId);
  await teacher.locator('#class-form [name="name"]').fill('Secondary 1A');
  await teacher.locator('#class-form button[type="submit"]').click();
  await teacher
    .locator('#classes-list')
    .getByText('Admiralty Secondary School · Secondary 1A')
    .waitFor();
  await teacher.locator('[data-tab="manage"]').click();
  await teacher.locator('#new-project').click();
  await teacher.locator('#project-school-search').fill('be');
  const matches = await teacher
    .locator('#project-school-results .combobox-option')
    .allTextContents();
  assert.ok(matches.includes('Beatty Secondary School'));
  assert.ok(matches.every((name) => name.toLowerCase().includes('be')));
  await teacher.locator('#project-school-search').fill('Be');
  assert.deepEqual(
    await teacher.locator('#project-school-results .combobox-option').allTextContents(),
    matches
  );
  await teacher.locator('#project-school-search').fill('girls');
  const wordMatches = await teacher
    .locator('#project-school-results .combobox-option')
    .allTextContents();
  assert.ok(wordMatches.includes("Crescent Girls' School"));
  assert.ok(wordMatches.every((name) => name.toLowerCase().includes('girls')));
  await teacher.locator('#project-school-search').fill('ad');
  await teacher.getByRole('option', { name: 'Admiralty Secondary School' }).click();
  await teacher.locator('#project-form [name="teamName"]').fill('Team Alpha');
  await teacher.locator('#project-form [name="gameTitle"]').fill('Learning Adventure');
  await teacher.locator('#project-form [name="learningTopic"]').fill('Science');
  await teacher
    .locator('#project-form [name="description"]')
    .fill('Discover science through a student-created game.');
  await teacher.locator('#project-form [name="makecodeUrl"]').fill('https://arcade.makecode.com/');
  await teacher.locator('#project-form [name="status"]').selectOption('Published');
  await teacher.locator('#project-form [name="privacy"]').check();
  await teacher.locator('#project-form button[type="submit"]').click();
  await teacher.locator('#editor').waitFor({ state: 'hidden' });
  await teacher.locator('#manage-projects h3').getByText('Learning Adventure').waitFor();
  const studentContext = await browser.newContext();
  const student = await studentContext.newPage();
  inspect(student);
  await student.goto(`${origin}/#vote`);
  await student.locator('#show-register').click();
  await student.locator('#register-school').selectOption(schoolId);
  await student.locator('#register-class').selectOption({ label: 'Secondary 1A' });
  await student.locator('#register-form [name="fullName"]').fill('Alex Tan');
  await student.locator('#register-form [name="username"]').fill('alex.tan');
  await student.locator('#register-form [name="password"]').fill(password);
  await student.locator('#register-form [name="confirmPassword"]').fill(password);
  await student.locator('#register-form [name="fullNameConfirmed"]').check();
  await student.locator('#register-form button[type="submit"]').click();
  await student.locator('#student-workspace').waitFor({ state: 'visible' });
  await student.locator('#ballot-choices input').check();
  await student.locator('#final-confirmation input').check();
  await student.locator('#save-vote').click();
  await student.getByText('Thank you! Your final vote was recorded', { exact: false }).waitFor();
  assert.equal(await student.locator('#save-vote').isVisible(), false);
  await student.reload();
  try {
    await student
      .getByText('Thank you! Your final vote was recorded', { exact: false })
      .waitFor({ timeout: 5000 });
  } catch (error) {
    console.error(
      'Reload diagnostic:',
      student.url(),
      await student.locator('body').innerText(),
      errors
    );
    throw error;
  }
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  inspect(other);
  await other.goto(`${origin}/#vote`);
  await other.locator('#show-register').click();
  await other.locator('#register-school').selectOption(schoolId);
  await other.locator('#register-class').selectOption({ label: 'Secondary 1A' });
  await other.locator('#register-form [name="fullName"]').fill(' ALEX  TAN ');
  await other.locator('#register-form [name="username"]').fill('another.username');
  await other.locator('#register-form [name="password"]').fill(password);
  await other.locator('#register-form [name="confirmPassword"]').fill(password);
  await other.locator('#register-form [name="fullNameConfirmed"]').check();
  await other.locator('#register-form button[type="submit"]').click();
  await other
    .locator('#register-message')
    .getByText('An account is already registered', { exact: false })
    .waitFor();
  await other.locator('#show-student-login').click();
  await other.locator('#student-login [name="username"]').fill('alex.tan');
  await other.locator('#student-login [name="password"]').fill(password);
  await other.locator('#student-login button[type="submit"]').click();
  await other.getByText('Thank you! Your final vote was recorded', { exact: false }).waitFor();
  await teacher.locator('[data-tab="students"]').click();
  await teacher.locator('#students-list h3').getByText('Alex Tan').waitFor();
  await teacher.locator('[data-reset]').click();
  await teacher
    .locator('#reset-password-form [name="password"]')
    .fill('Reset browser password 42!');
  await teacher
    .locator('#reset-password-form [name="confirmPassword"]')
    .fill('Reset browser password 42!');
  await teacher.locator('#reset-password-form button[type="submit"]').click();
  await teacher.locator('#password-dialog').waitFor({ state: 'hidden' });
  await other.reload();
  await other.locator('#student-login').waitFor({ state: 'visible' });
  await other.locator('#student-login [name="username"]').fill('alex.tan');
  await other.locator('#student-login [name="password"]').fill('Reset browser password 42!');
  await other.locator('#student-login button[type="submit"]').click();
  await other.getByText('Thank you! Your final vote was recorded', { exact: false }).waitFor();
  await other.locator('#student-logout').click();
  await other.locator('#student-login').waitFor({ state: 'visible' });
  assert.equal(await other.locator('#student-account').textContent(), '');
  await other.goto(origin);
  await other.locator('#public-projects h3').getByText('Learning Adventure').waitFor();
  assert.equal(await other.locator('#public-projects strong').first().textContent(), '1 vote');
  assert.equal((await other.locator('body').innerText()).includes('Alex Tan'), false);
  await other.screenshot({ path: '/tmp/cep-online-desktop.png', fullPage: true });
  await other.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true
  );
  await other.screenshot({ path: '/tmp/cep-online-mobile.png', fullPage: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(responses, []);
  console.log(
    'PASS: teacher login, class setup, publishing, student registration, final vote, reload, duplicate rejection, second-device login, password recovery, privacy, and mobile layout.'
  );
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
