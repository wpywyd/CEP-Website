import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { SECONDARY_SCHOOLS } from './school-directory.js';

export const STATUSES = [
  'Not started',
  'In progress',
  'Ready to review',
  'Changes requested',
  'Approved',
  'Published'
];
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordMatches(password, encoded) {
  const [salt, digest] = encoded.split(':');
  const expected = Buffer.from(digest, 'hex');
  const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function validateNewPassword(password) {
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 128 ||
    !/\p{L}/u.test(password) ||
    !/\p{N}/u.test(password)
  ) {
    throw new Error(
      'Use 8–128 characters with at least one letter and one number. Symbols are optional.'
    );
  }
  return password;
}
export function openStore(filename) {
  process.umask(0o077);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schools (id TEXT PRIMARY KEY, name TEXT NOT NULL, short_name TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS teachers (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, school_id TEXT REFERENCES schools(id));
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id), team_name TEXT NOT NULL,
      game_title TEXT NOT NULL, learning_topic TEXT NOT NULL, description TEXT NOT NULL,
      makecode_url TEXT NOT NULL, status TEXT NOT NULL, progress INTEGER NOT NULL,
      current_session INTEGER NOT NULL, trainer_feedback TEXT NOT NULL, updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS projects_school ON projects(school_id);
    CREATE TABLE IF NOT EXISTS classes (
      id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id), name TEXT NOT NULL, name_key TEXT NOT NULL,
      UNIQUE(school_id, name_key)
    );
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      school_id TEXT NOT NULL REFERENCES schools(id), class_id TEXT NOT NULL REFERENCES classes(id),
      full_name TEXT NOT NULL, name_key TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(school_id, class_id, name_key)
    );
    CREATE TABLE IF NOT EXISTS student_sessions (
      token_hash TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voting_rounds (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, is_open INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_round ON voting_rounds(is_open) WHERE is_open=1;
    CREATE TABLE IF NOT EXISTS student_votes (
      student_id TEXT NOT NULL REFERENCES students(id), round_id TEXT NOT NULL REFERENCES voting_rounds(id),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT, created_at TEXT NOT NULL,
      PRIMARY KEY(student_id, round_id)
    );
    CREATE INDEX IF NOT EXISTS student_votes_project ON student_votes(project_id, round_id);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id), name TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES students(id), join_code_hash TEXT NOT NULL UNIQUE,
      is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL REFERENCES students(id), joined_at TEXT NOT NULL,
      PRIMARY KEY(team_id, student_id)
    );
    CREATE TABLE IF NOT EXISTS showcase_projects (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL UNIQUE REFERENCES teams(id), school_id TEXT NOT NULL REFERENCES schools(id),
      category_id TEXT REFERENCES categories(id), year INTEGER NOT NULL, is_featured INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0, published_revision_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS project_revisions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES showcase_projects(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, learning_story TEXT NOT NULL,
      project_url TEXT NOT NULL, cover_image TEXT NOT NULL, tags_json TEXT NOT NULL,
      state TEXT NOT NULL, feedback TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, submitted_at TEXT,
      reviewed_at TEXT, reviewed_by TEXT REFERENCES teachers(id), UNIQUE(project_id, version)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, message TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS round_projects (
      round_id TEXT NOT NULL REFERENCES voting_rounds(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES showcase_projects(id), PRIMARY KEY(round_id, project_id)
    );
    CREATE TABLE IF NOT EXISTS round_schools (
      round_id TEXT NOT NULL REFERENCES voting_rounds(id) ON DELETE CASCADE,
      school_id TEXT NOT NULL REFERENCES schools(id), PRIMARY KEY(round_id, school_id)
    );
    CREATE TABLE IF NOT EXISTS platform_votes (
      student_id TEXT NOT NULL REFERENCES students(id), round_id TEXT NOT NULL REFERENCES voting_rounds(id),
      project_id TEXT NOT NULL REFERENCES showcase_projects(id), created_at TEXT NOT NULL,
      PRIMARY KEY(student_id, round_id)
    );
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL,
      target_type TEXT NOT NULL, target_id TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const ensureColumn = (table, column, definition) => {
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('${table}') WHERE name=?`).get(column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  ensureColumn('students', 'is_disabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('teachers', 'is_disabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('teachers', 'full_name', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('team_members', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn('voting_rounds', 'status', "TEXT NOT NULL DEFAULT 'open'");
  ensureColumn('voting_rounds', 'opens_at', 'TEXT');
  ensureColumn('voting_rounds', 'closes_at', 'TEXT');
  ensureColumn('voting_rounds', 'ballot_locked', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('voting_rounds', 'is_deleted', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('project_revisions', 'video_file', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('project_revisions', 'video_mime', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('project_revisions', 'video_name', "TEXT NOT NULL DEFAULT ''");
  db.exec('DROP INDEX IF EXISTS one_active_team_per_student');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS one_active_team_per_student ON team_members(student_id) WHERE is_active=1'
  );
  if (!db.prepare("SELECT 1 FROM pragma_table_info('schools') WHERE name='is_active'").get()) {
    db.exec('ALTER TABLE schools ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1');
  }
  db.prepare(
    "UPDATE schools SET is_active=0 WHERE id GLOB 'school-[1-9]' AND name GLOB 'School [1-9]'"
  ).run();
  const seed = db.prepare(
    'INSERT INTO schools (id, name, short_name, is_active) VALUES (?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET name=excluded.name, short_name=excluded.short_name, is_active=1'
  );
  for (const school of SECONDARY_SCHOOLS) seed.run(school.id, school.name, school.shortName);
  const category = db.prepare(
    'INSERT OR IGNORE INTO categories (id, name, sort_order) VALUES (?, ?, ?)'
  );
  ['Sustainability', 'Science', 'Wellbeing', 'Education', 'Community', 'Creativity'].forEach(
    (name, index) => category.run(`category-${index + 1}`, name, index)
  );
  db.prepare(
    "INSERT OR IGNORE INTO voting_rounds (id, name, is_open, created_at) VALUES ('round-1', 'Student Choice Award', 1, ?)"
  ).run(new Date().toISOString());
  return db;
}
export function provisionTeacher(db, username, password, schoolId = null) {
  if (!/^[a-z0-9._-]{3,64}$/.test(username))
    throw new Error(
      'Username must be 3–64 lowercase letters, numbers, dots, underscores or hyphens.'
    );
  validateNewPassword(password);
  if (schoolId && !db.prepare('SELECT id FROM schools WHERE id=? AND is_active=1').get(schoolId))
    throw new Error('Unknown or inactive school.');
  const existing = db.prepare('SELECT id FROM teachers WHERE username=?').get(username);
  const id = existing?.id || randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO teachers (id, username, password_hash, school_id) VALUES (?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, school_id=excluded.school_id, is_disabled=0`
  ).run(id, username, passwordHash(password), schoolId);
  db.prepare('DELETE FROM sessions WHERE teacher_id=?').run(id);
  return id;
}

// The original spelling is retained for teachers; only the duplicate key is folded.
export const normaliseIdentity = (value) =>
  value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
export const displayName = (value) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
