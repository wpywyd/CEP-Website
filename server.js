import { createServer } from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, mkdir, rename, unlink, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createPlatform } from './platform.js';
import {
  openStore,
  hash,
  passwordHash,
  passwordMatches,
  validateNewPassword,
  STATUSES,
  normaliseIdentity,
  displayName
} from './store.js';

const root = dirname(fileURLToPath(import.meta.url));
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new HttpError(status, message);
};
const text = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()))
    fail(400, 'Invalid or missing text field.');
  return value.trim();
};
function projectInput(body) {
  const url = text(body.makecodeUrl ?? '', 500);
  if (url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      fail(400, 'Enter a valid MakeCode link.');
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'arcade.makecode.com' ||
      parsed.username ||
      parsed.password ||
      parsed.port
    )
      fail(400, 'Use an HTTPS arcade.makecode.com link.');
  }
  if (!STATUSES.includes(body.status)) fail(400, 'Unknown project status.');
  if (
    !Number.isInteger(body.progress) ||
    body.progress < 0 ||
    body.progress > 100 ||
    !Number.isInteger(body.currentSession) ||
    body.currentSession < 1 ||
    body.currentSession > 8
  )
    fail(400, 'Invalid progress or session.');
  return {
    schoolId: text(body.schoolId, 80, true),
    teamName: text(body.teamName, 80, true),
    gameTitle: text(body.gameTitle, 120, true),
    learningTopic: text(body.learningTopic, 100, true),
    description: text(body.description ?? '', 600),
    makecodeUrl: url,
    status: body.status,
    progress: body.progress,
    currentSession: body.currentSession,
    trainerFeedback: text(body.trainerFeedback ?? '', 500)
  };
}
const projectSelect = `SELECT p.id, p.school_id AS schoolId, p.team_name AS teamName, p.game_title AS gameTitle,
 p.learning_topic AS learningTopic, p.description, p.makecode_url AS makecodeUrl, p.status, p.progress,
 p.current_session AS currentSession, p.trainer_feedback AS trainerFeedback, p.updated_at AS updatedAt, p.revision,
 (SELECT count(*) FROM student_votes v JOIN voting_rounds r ON r.id=v.round_id WHERE v.project_id=p.id AND r.id=(SELECT id FROM voting_rounds ORDER BY is_open DESC, created_at DESC, rowid DESC LIMIT 1)) AS votes FROM projects p`;

export function createApp({
  database = resolve(process.env.DATA_DIR || 'data', 'portal.sqlite'),
  secureCookies = process.env.NODE_ENV === 'production',
  publicOrigin = process.env.PUBLIC_ORIGIN || ''
} = {}) {
  if (secureCookies && !/^https:\/\/[^/]+$/.test(publicOrigin))
    throw new Error(
      'Production requires PUBLIC_ORIGIN as your HTTPS site origin, without a trailing slash.'
    );
  const db = openStore(database);
  const dummyHash = passwordHash(randomBytes(24).toString('hex'));
  function limit(key, maximum, windowMs) {
    const now = Date.now();
    db.prepare('DELETE FROM rate_limits WHERE expires < ?').run(now);
    db.prepare(
      `INSERT INTO rate_limits VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count=count+1`
    ).run(key, now + windowMs);
    const row = db.prepare('SELECT count FROM rate_limits WHERE key=?').get(key);
    if (row.count > maximum) fail(429, 'Too many attempts. Please try again later.');
  }
  function teacherSession(req) {
    const token = /(?:^|;\s*)cep_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!token) return null;
    return db
      .prepare(
        `SELECT t.id, t.username, t.full_name AS fullName, t.school_id AS schoolId, school.name AS schoolName FROM sessions s JOIN teachers t ON t.id=s.teacher_id LEFT JOIN schools school ON school.id=t.school_id WHERE s.token_hash=? AND s.expires>? AND t.is_disabled=0`
      )
      .get(hash(token), Date.now());
  }
  function teacher(req) {
    const user = teacherSession(req);
    if (!user) fail(401, 'Your session expired. Please sign in again.');
    return user;
  }
  function canManage(user, schoolId) {
    if (user.schoolId && user.schoolId !== schoolId)
      fail(403, 'This school is outside your account access.');
  }
  function getProject(id) {
    const p = db.prepare(`${projectSelect} WHERE p.id=?`).get(id);
    if (!p) fail(404, 'Project not found.');
    return p;
  }
  function studentSession(req) {
    const token = /(?:^|;\s*)cep_student=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!token) return null;
    return db
      .prepare(
        `SELECT u.id, u.username, u.school_id AS schoolId, school.name AS schoolName, u.class_id AS classId, c.name AS className, u.full_name AS fullName FROM student_sessions s JOIN students u ON u.id=s.student_id JOIN schools school ON school.id=u.school_id JOIN classes c ON c.id=u.class_id WHERE s.token_hash=? AND s.expires>? AND u.is_disabled=0`
      )
      .get(hash(token), Date.now());
  }
  function student(req) {
    const user = studentSession(req);
    if (!user) fail(401, 'Your session expired. Please sign in again.');
    return user;
  }
  function renderPlatformPage(content, req) {
    const staff = teacherSession(req);
    const signedInStudent = studentSession(req);
    const account = staff
      ? {
          destination: staff.schoolId ? '/teacher' : '/admin',
          label: staff.schoolId ? 'Teacher dashboard' : 'Admin dashboard'
        }
      : signedInStudent
        ? { destination: '/student', label: 'Dashboard' }
        : { destination: '', label: 'Sign in' };
    return content
      .toString()
      .replace('{{ACCOUNT_DESTINATION}}', account.destination)
      .replace('{{ACCOUNT_LABEL}}', account.label);
  }
  const videoDirectory = resolve(dirname(database), 'project-videos');
  async function uploadProjectVideo(req, res) {
    const user = student(req);
    const revision = db
      .prepare(
        `SELECT r.id, r.state, r.video_file AS videoFile
         FROM project_revisions r
         JOIN showcase_projects p ON p.id=r.project_id
         JOIN teams t ON t.id=p.team_id
         JOIN team_members m ON m.team_id=t.id
         WHERE m.student_id=? AND m.is_active=1 AND t.is_active=1 AND p.is_archived=0
         ORDER BY r.version DESC LIMIT 1`
      )
      .get(user.id);
    if (!revision || !['draft', 'changes_requested'].includes(revision.state))
      fail(409, 'Save an editable project draft before uploading a video.');
    const types = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
    const mime = req.headers['content-type']?.split(';')[0].trim();
    const extension = types[mime];
    if (!extension) fail(415, 'Upload an MP4 or WebM video.');
    const maximum = 50_000_000;
    const declaredSize = Number(req.headers['content-length']);
    if (Number.isFinite(declaredSize) && declaredSize > maximum)
      fail(413, 'Project videos must be no larger than 50 MB.');
    await mkdir(videoDirectory, { recursive: true });
    const videoFile = `${randomBytes(16).toString('hex')}.${extension}`;
    const temporaryFile = resolve(videoDirectory, `${videoFile}.uploading`);
    const destination = resolve(videoDirectory, videoFile);
    let size = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        callback(
          size > maximum
            ? new HttpError(413, 'Project videos must be no larger than 50 MB.')
            : null,
          chunk
        );
      }
    });
    try {
      await pipeline(req, limiter, createWriteStream(temporaryFile, { flags: 'wx' }));
      if (!size) fail(400, 'Choose a video to upload.');
      await rename(temporaryFile, destination);
      db.prepare(
        'UPDATE project_revisions SET video_file=?, video_mime=?, video_name=? WHERE id=?'
      ).run(videoFile, mime, `Project demo.${extension}`, revision.id);
      if (
        revision.videoFile &&
        /^[a-f0-9]{32}\.(?:mp4|webm)$/.test(revision.videoFile) &&
        !db.prepare('SELECT 1 FROM project_revisions WHERE video_file=?').get(revision.videoFile)
      )
        await unlink(resolve(videoDirectory, revision.videoFile)).catch(() => {});
    } catch (error) {
      await unlink(temporaryFile).catch(() => {});
      await unlink(destination).catch(() => {});
      throw error;
    }
    return json(res, 200, {
      ok: true,
      videoUrl: `/media/project-video/${revision.id}`
    });
  }
  async function serveProjectVideo(req, res, revisionId) {
    const revision = db
      .prepare(
        `SELECT r.state, r.video_file AS videoFile, r.video_mime AS videoMime,
          p.school_id AS schoolId, p.team_id AS teamId,
          p.published_revision_id AS publishedRevisionId, p.is_archived AS isArchived
         FROM project_revisions r JOIN showcase_projects p ON p.id=r.project_id WHERE r.id=?`
      )
      .get(revisionId);
    if (!revision?.videoFile || !/^[a-f0-9]{32}\.(?:mp4|webm)$/.test(revision.videoFile))
      fail(404, 'Project video not found.');
    const staff = teacherSession(req);
    const signedInStudent = studentSession(req);
    const studentTeam = signedInStudent
      ? db
          .prepare('SELECT 1 FROM team_members WHERE student_id=? AND team_id=? AND is_active=1')
          .get(signedInStudent.id, revision.teamId)
      : null;
    const isPublic =
      !revision.isArchived &&
      revision.publishedRevisionId &&
      revision.publishedRevisionId === revisionId;
    const canReview =
      staff &&
      ['submitted', 'published', 'changes_requested'].includes(revision.state) &&
      (!staff.schoolId || staff.schoolId === revision.schoolId);
    if (!isPublic && !canReview && !studentTeam) fail(404, 'Project video not found.');
    const filePath = resolve(videoDirectory, revision.videoFile);
    const file = await stat(filePath).catch(() => null);
    if (!file?.isFile()) fail(404, 'Project video not found.');
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    let start = 0;
    let end = file.size - 1;
    let status = 200;
    if (range) {
      start = range[1] ? Number(range[1]) : Math.max(0, file.size - Number(range[2]));
      end = range[2] && range[1] ? Math.min(Number(range[2]), file.size - 1) : end;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= file.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${file.size}` });
        return res.end();
      }
      status = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${file.size}`);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', revision.videoMime);
    res.setHeader('Content-Length', end - start + 1);
    res.writeHead(status);
    if (req.method === 'HEAD') return res.end();
    createReadStream(filePath, { start, end }).pipe(res);
  }
  function studentCookie(res, token, expires = 28800) {
    res.setHeader(
      'Set-Cookie',
      `cep_student=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${expires}${secureCookies ? '; Secure' : ''}`
    );
  }
  function startStudentSession(res, id) {
    db.prepare('DELETE FROM student_sessions WHERE expires < ?').run(Date.now());
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO student_sessions VALUES (?, ?, ?)').run(
      hash(token),
      id,
      Date.now() + 8 * 60 * 60_000
    );
    studentCookie(res, token);
  }
  const latestRound = () =>
    db
      .prepare(
        'SELECT id, name, is_open AS isOpen FROM voting_rounds ORDER BY is_open DESC, created_at DESC, rowid DESC LIMIT 1'
      )
      .get();
  function passwordValue(value, isNew = true) {
    if (typeof value !== 'string' || !value.length || value.length > 256)
      fail(400, 'Enter a valid password.');
    if (isNew) {
      try {
        validateNewPassword(value);
      } catch (error) {
        fail(400, error.message);
      }
    }
    return value;
  }
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  async function body(req, maximum = 32_768) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maximum) fail(413, 'Request too large.');
      chunks.push(chunk);
    }
    if (!req.headers['content-type']?.startsWith('application/json'))
      fail(415, 'Send JSON content.');
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString());
      if (!value || typeof value !== 'object' || Array.isArray(value))
        fail(400, 'Invalid JSON object.');
      return value;
    } catch {
      fail(400, 'Invalid JSON object.');
    }
  }
  const platform = createPlatform({ db, fail, text, body, json, teacher, student, canManage });
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
    );
    res.setHeader('Cache-Control', 'no-store');
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const videoRoute = /^\/media\/project-video\/([a-f0-9]{32})$/.exec(path);
      if (videoRoute) {
        if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Method not allowed.');
        await serveProjectVideo(req, res, videoRoute[1]);
        return;
      }
      if (!path.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') fail(405, 'Method not allowed.');
        const files = {
          '/': ['platform.html', 'text/html'],
          '/student': ['platform.html', 'text/html'],
          '/student/': ['platform.html', 'text/html'],
          '/vote': ['platform.html', 'text/html'],
          '/vote/': ['platform.html', 'text/html'],
          '/results': ['platform.html', 'text/html'],
          '/results/': ['platform.html', 'text/html'],
          '/teacher': ['platform.html', 'text/html'],
          '/teacher/': ['platform.html', 'text/html'],
          '/admin': ['platform.html', 'text/html'],
          '/admin/': ['platform.html', 'text/html'],
          '/legacy': ['index.html', 'text/html'],
          '/prototype': ['prototype.html', 'text/html'],
          '/prototype/': ['prototype.html', 'text/html'],
          '/prototype.css': ['prototype.css', 'text/css'],
          '/prototype.js': ['prototype.js', 'text/javascript'],
          '/platform.css': ['platform.css', 'text/css'],
          '/platform-app.js': ['platform-app.js', 'text/javascript'],
          '/app.js': ['app.js', 'text/javascript'],
          '/style.css': ['style.css', 'text/css'],
          '/school-search.css': ['school-search.css', 'text/css'],
          '/artwork.svg': ['artwork.svg', 'image/svg+xml']
        };
        const file = files[path];
        if (!file) fail(404, 'Page not found.');
        let content = await readFile(resolve(root, 'public', file[0]));
        if (file[0] === 'platform.html') content = renderPlatformPage(content, req);
        if (
          path === '/teacher' ||
          path === '/teacher/' ||
          path === '/prototype' ||
          path === '/prototype/'
        ) {
          res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        }
        res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8` });
        res.end(req.method === 'HEAD' ? undefined : content);
        return;
      }
      const mutating = !['GET', 'HEAD'].includes(req.method);
      if (mutating) {
        const expected = publicOrigin || `http://${req.headers.host}`;
        if (req.headers.origin !== expected) fail(403, 'Request origin rejected.');
        if (req.headers['x-cep-request'] !== '1') fail(403, 'Missing request protection header.');
      }
      const ip = req.socket.remoteAddress; // Deliberately do not trust arbitrary forwarding headers.
      if (path === '/api/v2/project/video' && req.method === 'PUT')
        return await uploadProjectVideo(req, res);
      if (path.startsWith('/api/v2/')) return await platform.handle(req, res, path);
      if (path === '/api/health' && req.method === 'GET') {
        db.prepare('SELECT 1').get();
        return json(res, 200, { ok: true });
      }
      if (path === '/api/showcase' && req.method === 'GET') {
        const projects = db
          .prepare(`${projectSelect} WHERE p.status='Published' ORDER BY votes DESC, p.game_title`)
          .all()
          .map(({ trainerFeedback, revision, ...p }) => p);
        return json(res, 200, {
          schools: db
            .prepare(
              'SELECT id, name, short_name AS shortName FROM schools WHERE is_active=1 OR id IN (SELECT school_id FROM projects) ORDER BY name'
            )
            .all(),
          projects,
          round: latestRound()
        });
      }
      if (path === '/api/login' && req.method === 'POST') {
        limit(`login:${ip}`, 20, 15 * 60_000);
        const input = await body(req);
        const username = text(input.username, 64, true).toLowerCase();
        const password = passwordValue(input.password, false);
        const user = db.prepare('SELECT * FROM teachers WHERE username=?').get(username);
        const valid = passwordMatches(password, user?.password_hash || dummyHash);
        if (!user || user.is_disabled || !valid) fail(401, 'Username or password is incorrect.');
        db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
        const token = randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
          hash(token),
          user.id,
          Date.now() + 8 * 60 * 60_000
        );
        res.setHeader(
          'Set-Cookie',
          `cep_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookies ? '; Secure' : ''}`
        );
        return json(res, 200, { username: user.username, schoolId: user.school_id });
      }
      if (path === '/api/logout' && req.method === 'POST') {
        const token = /(?:^|;\s*)cep_session=([a-f0-9]{64})(?:;|$)/.exec(
          req.headers.cookie || ''
        )?.[1];
        if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
        res.setHeader(
          'Set-Cookie',
          `cep_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}`
        );
        return json(res, 200, { ok: true });
      }
      if (path === '/api/me' && req.method === 'GET') return json(res, 200, teacher(req));
      if (path === '/api/manage' && req.method === 'GET') {
        const user = teacher(req);
        const projects = db
          .prepare(
            `${projectSelect}${user.schoolId ? ' WHERE p.school_id=?' : ''} ORDER BY p.updated_at DESC`
          )
          .all(...(user.schoolId ? [user.schoolId] : []));
        return json(res, 200, {
          user,
          statuses: STATUSES,
          schools: db
            .prepare(
              `SELECT id, name, short_name AS shortName, is_active AS isActive FROM schools${user.schoolId ? ' WHERE id=?' : ' WHERE is_active=1 OR id IN (SELECT school_id FROM projects)'} ORDER BY name`
            )
            .all(...(user.schoolId ? [user.schoolId] : [])),
          projects
        });
      }
      if (path === '/api/projects' && req.method === 'POST') {
        const user = teacher(req);
        const p = projectInput(await body(req));
        canManage(user, p.schoolId);
        if (!db.prepare('SELECT id FROM schools WHERE id=? AND is_active=1').get(p.schoolId))
          fail(400, 'Unknown or inactive school.');
        const id = randomBytes(16).toString('hex');
        db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(
          id,
          p.schoolId,
          p.teamName,
          p.gameTitle,
          p.learningTopic,
          p.description,
          p.makecodeUrl,
          p.status,
          p.progress,
          p.currentSession,
          p.trainerFeedback,
          new Date().toISOString()
        );
        return json(res, 201, getProject(id));
      }
      const projectRoute = /^\/api\/projects\/([a-f0-9]{32})$/.exec(path);
      if (projectRoute && ['PUT', 'DELETE'].includes(req.method)) {
        const user = teacher(req);
        const existing = getProject(projectRoute[1]);
        canManage(user, existing.schoolId);
        const input = await body(req);
        if (input.revision !== existing.revision)
          fail(409, 'Another teacher changed this project. Refresh and try again.');
        if (req.method === 'DELETE') {
          if (db.prepare('SELECT 1 FROM student_votes WHERE project_id=?').get(existing.id))
            fail(409, 'A project with recorded votes cannot be deleted. Unpublish it instead.');
          db.prepare('DELETE FROM projects WHERE id=?').run(existing.id);
          return json(res, 200, { ok: true });
        }
        const p = projectInput(input);
        canManage(user, p.schoolId);
        if (p.schoolId !== existing.schoolId)
          fail(400, 'A project cannot be moved to another school.');
        db.prepare(
          'UPDATE projects SET team_name=?, game_title=?, learning_topic=?, description=?, makecode_url=?, status=?, progress=?, current_session=?, trainer_feedback=?, updated_at=?, revision=revision+1 WHERE id=?'
        ).run(
          p.teamName,
          p.gameTitle,
          p.learningTopic,
          p.description,
          p.makecodeUrl,
          p.status,
          p.progress,
          p.currentSession,
          p.trainerFeedback,
          new Date().toISOString(),
          existing.id
        );
        return json(res, 200, getProject(existing.id));
      }
      const schoolRoute = /^\/api\/schools\/(sg-[a-z0-9-]+|school-[1-9])$/.exec(path);
      if (schoolRoute && req.method === 'PUT') {
        const user = teacher(req);
        canManage(user, schoolRoute[1]);
        const input = await body(req);
        db.prepare('UPDATE schools SET name=?, short_name=? WHERE id=?').run(
          text(input.name, 120, true),
          text(input.shortName, 8, true),
          schoolRoute[1]
        );
        return json(res, 200, { ok: true });
      }
      if (path === '/api/registration' && req.method === 'GET') {
        return json(res, 200, {
          schools: db
            .prepare(
              'SELECT id, name, short_name AS shortName FROM schools WHERE is_active=1 ORDER BY name'
            )
            .all()
        });
      }
      if (path === '/api/students/register' && req.method === 'POST') {
        limit(`register:${ip}`, 120, 60 * 60_000);
        const input = await body(req);
        const schoolId = text(input.schoolId, 80, true);
        if (!db.prepare('SELECT id FROM schools WHERE id=? AND is_active=1').get(schoolId))
          fail(400, 'Select a valid school.');
        const className = displayName(text(input.className, 80, true));
        const classKey = normaliseIdentity(className);
        db.prepare(
          'INSERT OR IGNORE INTO classes (id, school_id, name, name_key) VALUES (?, ?, ?, ?)'
        ).run(randomBytes(16).toString('hex'), schoolId, className, classKey);
        const classId = db
          .prepare('SELECT id FROM classes WHERE school_id=? AND name_key=?')
          .get(schoolId, classKey).id;
        const fullName = displayName(text(input.fullName, 120, true));
        if (!/^[\p{L}\p{M} .’'\-]+$/u.test(fullName) || !/\p{L}/u.test(fullName))
          fail(
            400,
            'Enter your full name as recorded by your school, using letters and name punctuation.'
          );
        if (input.fullNameConfirmed !== true)
          fail(400, 'Confirm that you entered your full name as recorded by your school.');
        const username = text(input.username, 64, true).toLowerCase();
        if (!/^[a-z0-9._-]{3,64}$/.test(username))
          fail(400, 'Username must be 3–64 letters, numbers, dots, underscores or hyphens.');
        const password = passwordValue(input.password);
        const nameKey = normaliseIdentity(fullName);
        const duplicate = () =>
          db
            .prepare('SELECT id FROM students WHERE school_id=? AND class_id=? AND name_key=?')
            .get(schoolId, classId, nameKey);
        if (duplicate())
          fail(
            409,
            'An account is already registered with these school, class and full-name details. Sign in or contact your teacher.'
          );
        if (
          db.prepare('SELECT id FROM students WHERE username=?').get(username) ||
          db.prepare('SELECT id FROM teachers WHERE username=?').get(username)
        )
          fail(409, 'That username is already taken. Choose another username.');
        const id = randomBytes(16).toString('hex');
        try {
          db.prepare(
            'INSERT INTO students (id, username, password_hash, school_id, class_id, full_name, name_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
          ).run(
            id,
            username,
            passwordHash(password),
            schoolId,
            classId,
            fullName,
            nameKey,
            new Date().toISOString()
          );
        } catch (error) {
          if (duplicate())
            fail(
              409,
              'An account is already registered with these school, class and full-name details. Contact your teacher.'
            );
          if (db.prepare('SELECT id FROM students WHERE username=?').get(username))
            fail(409, 'That username is already taken.');
          throw error;
        }
        startStudentSession(res, id);
        return json(res, 201, { username, fullName, schoolId, className });
      }
      if (path === '/api/signin' && req.method === 'POST') {
        const input = await body(req);
        const username = text(input.username, 64, true).toLowerCase();
        const password = passwordValue(input.password, false);
        limit(`signin:${ip}`, 300, 15 * 60_000);
        limit(`signin-account:${hash(username)}`, 15, 15 * 60_000);
        const staff = db.prepare('SELECT * FROM teachers WHERE username=?').get(username);
        const pupil = db.prepare('SELECT * FROM students WHERE username=?').get(username);
        const staffMatch = passwordMatches(password, staff?.password_hash || dummyHash);
        const studentMatch = passwordMatches(password, pupil?.password_hash || dummyHash);
        if (staffMatch && !staff.is_disabled) {
          const token = randomBytes(32).toString('hex');
          db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(
            hash(token),
            staff.id,
            Date.now() + 8 * 60 * 60_000
          );
          res.setHeader('Set-Cookie', [
            `cep_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookies ? '; Secure' : ''}`,
            `cep_student=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}`
          ]);
          return json(res, 200, { role: staff.school_id ? 'teacher' : 'admin' });
        }
        if (studentMatch && !pupil.is_disabled) {
          startStudentSession(res, pupil.id);
          res.setHeader('Set-Cookie', [
            res.getHeader('Set-Cookie'),
            `cep_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookies ? '; Secure' : ''}`
          ]);
          return json(res, 200, { role: 'student' });
        }
        fail(401, 'Incorrect username or password.');
      }
      if (path === '/api/students/login' && req.method === 'POST') {
        const input = await body(req);
        const username = text(input.username, 64, true).toLowerCase();
        limit(`student-login:${ip}`, 300, 15 * 60_000);
        limit(`student-account:${hash(username)}`, 15, 15 * 60_000);
        const user = db.prepare('SELECT * FROM students WHERE username=?').get(username);
        const valid = passwordMatches(
          passwordValue(input.password, false),
          user?.password_hash || dummyHash
        );
        if (!user || user.is_disabled || !valid) fail(401, 'Username or password is incorrect.');
        startStudentSession(res, user.id);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/students/logout' && req.method === 'POST') {
        const token = /(?:^|;\s*)cep_student=([a-f0-9]{64})(?:;|$)/.exec(
          req.headers.cookie || ''
        )?.[1];
        if (token) db.prepare('DELETE FROM student_sessions WHERE token_hash=?').run(hash(token));
        studentCookie(res, '', 0);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/voter' && req.method === 'GET') {
        const user = student(req);
        const round = latestRound();
        const vote =
          db
            .prepare(
              'SELECT v.project_id AS projectId, p.game_title AS gameTitle, v.created_at AS createdAt FROM student_votes v JOIN projects p ON p.id=v.project_id WHERE v.student_id=? AND v.round_id=?'
            )
            .get(user.id, round.id) || null;
        const choices = db
          .prepare(`${projectSelect} WHERE p.status='Published' ORDER BY p.game_title`)
          .all()
          .map((p) => ({
            id: p.id,
            gameTitle: p.gameTitle,
            schoolId: p.schoolId,
            learningTopic: p.learningTopic
          }));
        return json(res, 200, { user, round, vote, choices });
      }
      if (path === '/api/vote' && req.method === 'POST') {
        const user = student(req);
        const input = await body(req);
        const round = latestRound();
        if (input.roundId !== round.id)
          fail(409, 'The voting round changed. Refresh before voting.');
        if (!round.isOpen) fail(409, 'Voting is closed for this round.');
        if (
          db
            .prepare('SELECT 1 FROM student_votes WHERE student_id=? AND round_id=?')
            .get(user.id, round.id)
        )
          fail(409, 'You have already voted in this round. Your vote is final.');
        const p = getProject(text(input.projectId, 32, true));
        if (p.status !== 'Published') fail(400, 'This project is no longer published.');
        try {
          db.prepare('INSERT INTO student_votes VALUES (?, ?, ?, ?)').run(
            user.id,
            round.id,
            p.id,
            new Date().toISOString()
          );
        } catch (error) {
          if (
            db
              .prepare('SELECT 1 FROM student_votes WHERE student_id=? AND round_id=?')
              .get(user.id, round.id)
          )
            fail(409, 'You have already voted in this round. Your vote is final.');
          throw error;
        }
        return json(res, 201, { ok: true, gameTitle: p.gameTitle });
      }
      if (path === '/api/classes' && req.method === 'GET') {
        const user = teacher(req);
        return json(res, 200, {
          classes: db
            .prepare(
              `SELECT id, school_id AS schoolId, name FROM classes${user.schoolId ? ' WHERE school_id=?' : ''} ORDER BY name`
            )
            .all(...(user.schoolId ? [user.schoolId] : []))
        });
      }
      if (path === '/api/classes' && req.method === 'POST') {
        const user = teacher(req);
        const input = await body(req);
        const schoolId = text(input.schoolId, 80, true);
        canManage(user, schoolId);
        if (!db.prepare('SELECT id FROM schools WHERE id=? AND is_active=1').get(schoolId))
          fail(400, 'Unknown or inactive school.');
        const name = displayName(text(input.name, 80, true));
        const key = normaliseIdentity(name);
        if (
          db.prepare('SELECT id FROM classes WHERE school_id=? AND name_key=?').get(schoolId, key)
        )
          fail(409, 'That class already exists in this school.');
        const id = randomBytes(16).toString('hex');
        db.prepare('INSERT INTO classes VALUES (?, ?, ?, ?)').run(id, schoolId, name, key);
        return json(res, 201, { id, schoolId, name });
      }
      if (path === '/api/students' && req.method === 'GET') {
        const user = teacher(req);
        return json(res, 200, {
          students: db
            .prepare(
              `SELECT s.id, s.username, s.full_name AS fullName, s.school_id AS schoolId, c.name AS className, s.created_at AS createdAt FROM students s JOIN classes c ON c.id=s.class_id${user.schoolId ? ' WHERE s.school_id=?' : ''} ORDER BY c.name, s.full_name`
            )
            .all(...(user.schoolId ? [user.schoolId] : []))
        });
      }
      const resetRoute = /^\/api\/students\/([a-f0-9]{32})\/password$/.exec(path);
      if (resetRoute && req.method === 'PUT') {
        const user = teacher(req);
        const s = db
          .prepare('SELECT school_id AS schoolId FROM students WHERE id=?')
          .get(resetRoute[1]);
        if (!s) fail(404, 'Student account not found.');
        canManage(user, s.schoolId);
        const input = await body(req);
        db.prepare('UPDATE students SET password_hash=? WHERE id=?').run(
          passwordHash(passwordValue(input.password)),
          resetRoute[1]
        );
        db.prepare('DELETE FROM student_sessions WHERE student_id=?').run(resetRoute[1]);
        return json(res, 200, { ok: true });
      }
      if (path === '/api/round' && req.method === 'GET') {
        teacher(req);
        return json(res, 200, latestRound());
      }
      if (path === '/api/round/close' && req.method === 'POST') {
        const user = teacher(req);
        if (user.schoolId) fail(403, 'Only the programme administrator can close voting.');
        db.prepare('UPDATE voting_rounds SET is_open=0 WHERE is_open=1').run();
        return json(res, 200, latestRound());
      }
      if (path === '/api/round' && req.method === 'POST') {
        const user = teacher(req);
        if (user.schoolId) fail(403, 'Only the programme administrator can start a voting round.');
        if (db.prepare('SELECT id FROM voting_rounds WHERE is_open=1').get())
          fail(409, 'Close the current voting round first.');
        const name = text((await body(req)).name, 120, true);
        const id = randomBytes(16).toString('hex');
        db.prepare(
          'INSERT INTO voting_rounds (id, name, is_open, created_at) VALUES (?, ?, 1, ?)'
        ).run(id, name, new Date().toISOString());
        return json(res, 201, latestRound());
      }
      if (path === '/api/import' && req.method === 'POST') {
        const user = teacher(req);
        const input = await body(req, 2_000_000);
        if (!Array.isArray(input.projects) || input.projects.length > 2000)
          fail(400, 'Upload a project backup with at most 2,000 records.');
        const prepared = input.projects.map((raw) => ({
          originalId: text(raw.id, 120, true),
          ...projectInput(raw)
        }));
        for (const p of prepared) {
          canManage(user, p.schoolId);
          if (!db.prepare('SELECT id FROM schools WHERE id=? AND is_active=1').get(p.schoolId))
            fail(400, 'Unknown or inactive school in backup.');
        }
        let imported = 0;
        let skipped = 0;
        db.exec(
          'CREATE TABLE IF NOT EXISTS import_ids (original_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE)'
        );
        db.exec('BEGIN');
        try {
          for (const p of prepared) {
            if (
              db.prepare('SELECT 1 FROM import_ids WHERE original_id=?').get(p.originalId) ||
              db.prepare('SELECT 1 FROM projects WHERE id=?').get(p.originalId)
            ) {
              skipped++;
              continue;
            }
            const id = randomBytes(16).toString('hex');
            db.prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(
              id,
              p.schoolId,
              p.teamName,
              p.gameTitle,
              p.learningTopic,
              p.description,
              p.makecodeUrl,
              p.status,
              p.progress,
              p.currentSession,
              p.trainerFeedback,
              new Date().toISOString()
            );
            db.prepare('INSERT INTO import_ids VALUES (?, ?)').run(p.originalId, id);
            imported++;
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        return json(res, 200, { imported, skipped });
      }
      fail(404, 'Endpoint not found.');
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Request failed:', error);
      if (!res.headersSent)
        json(res, error.status || 500, {
          error:
            error instanceof HttpError
              ? error.message
              : 'The server could not complete the request.'
        });
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  return { server, db };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, db } = createApp();
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`CEP online platform listening on ${host}:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () =>
      server.close(() => {
        db.close();
        process.exit(0);
      })
    );
}
