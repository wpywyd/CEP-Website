import { randomBytes } from 'node:crypto';
import {
  hash,
  normaliseIdentity,
  displayName,
  passwordHash,
  passwordMatches,
  validateNewPassword
} from './store.js';

const id = () => randomBytes(16).toString('hex');
const now = () => new Date().toISOString();
const code = () => randomBytes(5).toString('base64url').slice(0, 7).toUpperCase();

export function createPlatform({ db, fail, text, body, json, teacher, student, canManage }) {
  const audit = (actorType, actorId, action, targetType, targetId, details = {}) =>
    db
      .prepare('INSERT INTO audit_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id(), actorType, actorId, action, targetType, targetId, JSON.stringify(details), now());

  const activeRound = () =>
    db
      .prepare(
        `SELECT id, name, status, opens_at AS opensAt, closes_at AS closesAt
       FROM voting_rounds WHERE status='open' ORDER BY created_at DESC, rowid DESC LIMIT 1`
      )
      .get();

  const projectQuery = `
    SELECT p.id, p.school_id AS schoolId, p.category_id AS categoryId, p.year,
      p.is_featured AS isFeatured, p.is_archived AS isArchived, p.team_id AS teamId,
      t.name AS teamName, s.name AS schoolName, c.name AS category,
      r.id AS revisionId, r.version, r.title, r.description, r.learning_story AS learningStory,
      r.project_url AS projectUrl, r.cover_image AS coverImage, r.tags_json AS tagsJson,
      CASE WHEN r.video_file<>'' THEN '/media/project-video/' || r.id ELSE '' END AS videoUrl,
      r.state, r.feedback, r.submitted_at AS submittedAt, r.reviewed_at AS reviewedAt,
      (SELECT count(*) FROM platform_votes v WHERE v.project_id=p.id AND v.round_id=(SELECT id FROM voting_rounds WHERE status='open' ORDER BY created_at DESC LIMIT 1)) AS votes
    FROM showcase_projects p
    JOIN teams t ON t.id=p.team_id JOIN schools s ON s.id=p.school_id
    LEFT JOIN categories c ON c.id=p.category_id JOIN project_revisions r ON r.id=p.published_revision_id`;

  const parseProject = (row) => row && { ...row, tags: JSON.parse(row.tagsJson || '[]') };
  const publishedProject = (projectId) => {
    const row = db.prepare(`${projectQuery} WHERE p.id=? AND p.is_archived=0`).get(projectId);
    if (!row) fail(404, 'Published project not found.');
    return parseProject(row);
  };

  function membership(user) {
    return db
      .prepare(
        `SELECT t.id AS teamId, t.name AS teamName, t.owner_id AS ownerId, t.school_id AS schoolId
       FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.student_id=? AND m.is_active=1 AND t.is_active=1`
      )
      .get(user.id);
  }

  function teamProject(teamId) {
    return db
      .prepare(
        `SELECT p.id, p.school_id AS schoolId, p.category_id AS categoryId, p.year,
        p.is_featured AS isFeatured, p.is_archived AS isArchived, p.published_revision_id AS publishedRevisionId,
        r.id AS revisionId, r.version, r.title, r.description, r.learning_story AS learningStory,
        r.project_url AS projectUrl, r.cover_image AS coverImage, r.tags_json AS tagsJson,
        r.video_file AS videoFile, r.video_mime AS videoMime, r.video_name AS videoName,
        CASE WHEN r.video_file<>'' THEN '/media/project-video/' || r.id ELSE '' END AS videoUrl,
        r.state, r.feedback, r.submitted_at AS submittedAt, r.reviewed_at AS reviewedAt
       FROM showcase_projects p LEFT JOIN project_revisions r ON r.id=(
         SELECT id FROM project_revisions WHERE project_id=p.id ORDER BY version DESC LIMIT 1
       ) WHERE p.team_id=? AND p.is_archived=0`
      )
      .get(teamId);
  }

  const teamMembers = (teamId) =>
    db
      .prepare(
        `SELECT s.id, s.username, s.full_name AS fullName, c.name AS className,
      CASE WHEN t.owner_id=s.id THEN 1 ELSE 0 END AS isOwner
     FROM team_members m JOIN students s ON s.id=m.student_id JOIN classes c ON c.id=s.class_id
     JOIN teams t ON t.id=m.team_id WHERE m.team_id=? AND m.is_active=1 ORDER BY isOwner DESC, s.full_name`
      )
      .all(teamId);

  const notifyTeam = (teamId, kind, message) => {
    const insert = db.prepare('INSERT INTO notifications VALUES (?, ?, ?, ?, 0, ?)');
    for (const member of teamMembers(teamId)) insert.run(id(), member.id, kind, message, now());
  };

  function projectInput(input) {
    const projectUrl = text(input.projectUrl || '', 500);
    if (projectUrl) {
      let parsed;
      try {
        parsed = new URL(projectUrl);
      } catch {
        fail(400, 'Enter a valid secure project link.');
      }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
        fail(400, 'Project links must use HTTPS.');
    }
    const categoryId = text(input.categoryId, 64, true);
    if (!db.prepare('SELECT 1 FROM categories WHERE id=? AND is_active=1').get(categoryId))
      fail(400, 'Choose an active category.');
    const tags = Array.isArray(input.tags)
      ? input.tags.slice(0, 8).map((tag) => text(tag, 30, true))
      : [];
    const coverImage = text(input.coverImage || '', 7_000_000);
    if (coverImage && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(coverImage))
      fail(400, 'Upload a JPG, PNG, or WebP cover image.');
    if (coverImage && Buffer.byteLength(coverImage.split(',')[1], 'base64') > 5_000_000)
      fail(413, 'Cover images must be no larger than 5 MB.');
    if (!Number.isInteger(input.year) || input.year < 2020 || input.year > 2100)
      fail(400, 'Choose a valid project year.');
    return {
      title: text(input.title, 120, true),
      description: text(input.description || '', 600),
      learningStory: text(input.learningStory || '', 1200),
      projectUrl,
      categoryId,
      tags,
      coverImage,
      year: input.year
    };
  }

  function requireAdmin(user) {
    if (user.schoolId) fail(403, 'Programme administrator access is required.');
  }

  async function handle(req, res, path) {
    if (!path.startsWith('/api/v2/')) return false;

    if (path === '/api/v2/showcase' && req.method === 'GET') {
      const projects = db
        .prepare(
          `${projectQuery} WHERE p.is_archived=0 ORDER BY p.is_featured DESC, r.reviewed_at DESC`
        )
        .all()
        .map(parseProject);
      const round = activeRound();
      return json(res, 200, {
        projects,
        categories: db
          .prepare('SELECT id, name FROM categories WHERE is_active=1 ORDER BY sort_order, name')
          .all(),
        schools: db.prepare('SELECT id, name FROM schools WHERE is_active=1 ORDER BY name').all(),
        round: round
          ? {
              ...round,
              totalVotes: db
                .prepare('SELECT count(*) AS n FROM platform_votes WHERE round_id=?')
                .get(round.id).n
            }
          : null
      });
    }
    const publicProjectRoute = /^\/api\/v2\/showcase\/([a-f0-9]{32})$/.exec(path);
    if (publicProjectRoute && req.method === 'GET')
      return json(res, 200, publishedProject(publicProjectRoute[1]));

    if (
      ['/api/v2/student/account', '/api/v2/teacher/account'].includes(path) &&
      req.method === 'PATCH'
    ) {
      const isStudent = path === '/api/v2/student/account';
      const user = isStudent ? student(req) : teacher(req);
      const table = isStudent ? 'students' : 'teachers';
      const existing = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(user.id);
      const input = await body(req);
      const fullName = displayName(text(input.fullName, 120, true));
      if (isStudent && input.schoolId !== undefined && input.schoolId !== user.schoolId)
        fail(403, 'Students cannot change their school.');
      const schoolId =
        isStudent || !user.schoolId ? user.schoolId : text(input.schoolId, 100, true);
      if (schoolId && !db.prepare('SELECT 1 FROM schools WHERE id=? AND is_active=1').get(schoolId))
        fail(400, 'Choose an active school.');
      let newHash = existing.password_hash;
      if (input.newPassword) {
        if (
          typeof input.currentPassword !== 'string' ||
          !passwordMatches(input.currentPassword, existing.password_hash)
        )
          fail(400, 'Current password is incorrect.');
        try {
          validateNewPassword(input.newPassword);
        } catch (error) {
          fail(400, error.message);
        }
        newHash = passwordHash(input.newPassword);
      }
      db.exec('BEGIN');
      try {
        if (isStudent) {
          const className = displayName(text(input.className, 80, true));
          const classKey = normaliseIdentity(className);
          db.prepare('INSERT OR IGNORE INTO classes VALUES (?, ?, ?, ?)').run(
            id(),
            schoolId,
            className,
            classKey
          );
          const classId = db
            .prepare('SELECT id FROM classes WHERE school_id=? AND name_key=?')
            .get(schoolId, classKey).id;
          if (
            db
              .prepare(
                'SELECT 1 FROM students WHERE school_id=? AND class_id=? AND name_key=? AND id<>?'
              )
              .get(schoolId, classId, normaliseIdentity(fullName), user.id)
          )
            fail(409, 'A student with this full name already exists in your school and class.');
          db.prepare(
            'UPDATE students SET full_name=?, name_key=?, class_id=?, password_hash=? WHERE id=?'
          ).run(fullName, normaliseIdentity(fullName), classId, newHash, user.id);
        } else {
          db.prepare(
            'UPDATE teachers SET full_name=?, school_id=?, password_hash=? WHERE id=?'
          ).run(fullName, schoolId, newHash, user.id);
        }
        if (input.newPassword || schoolId !== user.schoolId) {
          const cookieName = isStudent ? 'cep_student' : 'cep_session';
          const token = new RegExp(`(?:^|;\\s*)${cookieName}=([a-f0-9]{64})(?:;|$)`).exec(
            req.headers.cookie || ''
          )?.[1];
          db.prepare(
            `DELETE FROM ${isStudent ? 'student_sessions' : 'sessions'} WHERE ${isStudent ? 'student_id' : 'teacher_id'}=? AND token_hash<>?`
          ).run(user.id, hash(token));
        }
        audit(
          isStudent ? 'student' : 'teacher',
          user.id,
          'account.update',
          isStudent ? 'student' : 'teacher',
          user.id
        );
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/password-help' && req.method === 'POST') {
      const input = await body(req);
      const username = text(input.username, 64, true).toLowerCase();
      for (const [role, table] of [
        ['student', 'students'],
        ['teacher', 'teachers']
      ]) {
        const account = db
          .prepare(`SELECT id FROM ${table} WHERE username=? AND is_disabled=0`)
          .get(username);
        if (account)
          db.prepare(
            'INSERT INTO password_requests VALUES (?, ?, ?, ?, NULL) ON CONFLICT(account_type, account_id) DO UPDATE SET created_at=CASE WHEN resolved_at IS NOT NULL THEN excluded.created_at ELSE created_at END, resolved_at=NULL'
          ).run(id(), role, account.id, now());
      }
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/teacher/password-requests' && req.method === 'GET') {
      const user = teacher(req);
      const requests = db
        .prepare(
          `SELECT r.id, r.account_type AS accountType, r.created_at AS createdAt,
          s.full_name AS fullName, s.username, school.name AS schoolName
         FROM password_requests r JOIN students s ON s.id=r.account_id
         JOIN schools school ON school.id=s.school_id
         WHERE r.account_type='student' AND r.resolved_at IS NULL${user.schoolId ? ' AND s.school_id=?' : ''}`
        )
        .all(...(user.schoolId ? [user.schoolId] : []));
      if (!user.schoolId)
        requests.push(
          ...db
            .prepare(
              `SELECT r.id, r.account_type AS accountType, r.created_at AS createdAt,
          t.full_name AS fullName, t.username, school.name AS schoolName
         FROM password_requests r JOIN teachers t ON t.id=r.account_id
         LEFT JOIN schools school ON school.id=t.school_id
         WHERE r.account_type='teacher' AND r.resolved_at IS NULL`
            )
            .all()
        );
      return json(res, 200, { requests });
    }
    const recoveryRoute = /^\/api\/v2\/teacher\/password-requests\/([a-f0-9]{32})$/.exec(path);
    if (recoveryRoute && req.method === 'POST') {
      const user = teacher(req);
      const request = db
        .prepare('SELECT * FROM password_requests WHERE id=? AND resolved_at IS NULL')
        .get(recoveryRoute[1]);
      if (!request) fail(404, 'Reset request not found.');
      const isStudent = request.account_type === 'student';
      const table = isStudent ? 'students' : 'teachers';
      const account = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(request.account_id);
      if (!account) fail(404, 'Account not found.');
      if (isStudent) canManage(user, account.school_id);
      else requireAdmin(user);
      const input = await body(req);
      try {
        validateNewPassword(input.password);
      } catch (error) {
        fail(400, error.message);
      }
      db.exec('BEGIN');
      try {
        db.prepare(`UPDATE ${table} SET password_hash=? WHERE id=?`).run(
          passwordHash(input.password),
          account.id
        );
        db.prepare(
          `DELETE FROM ${isStudent ? 'student_sessions' : 'sessions'} WHERE ${isStudent ? 'student_id' : 'teacher_id'}=?`
        ).run(account.id);
        db.prepare('UPDATE password_requests SET resolved_at=? WHERE id=?').run(now(), request.id);
        audit('teacher', user.id, 'account.password.reset', request.account_type, account.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/student/home' && req.method === 'GET') {
      const user = student(req);
      const team = membership(user);
      return json(res, 200, {
        user,
        team: team
          ? { ...team, members: teamMembers(team.teamId), project: teamProject(team.teamId) }
          : null,
        categories: db
          .prepare('SELECT id, name FROM categories WHERE is_active=1 ORDER BY sort_order, name')
          .all(),
        notifications: db
          .prepare(
            'SELECT id, kind, message, is_read AS isRead, created_at AS createdAt FROM notifications WHERE student_id=? ORDER BY created_at DESC LIMIT 30'
          )
          .all(user.id)
      });
    }
    if (path === '/api/v2/notifications/read' && req.method === 'POST') {
      const user = student(req);
      db.prepare('UPDATE notifications SET is_read=1 WHERE student_id=?').run(user.id);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/teams' && req.method === 'POST') {
      const user = student(req);
      if (membership(user)) fail(409, 'You already belong to an active team.');
      const input = await body(req);
      const teamId = id();
      const joinCode = code();
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO teams VALUES (?, ?, ?, ?, ?, 1, ?)').run(
          teamId,
          user.schoolId,
          text(input.name, 80, true),
          user.id,
          hash(joinCode),
          now()
        );
        db.prepare(
          'INSERT INTO team_members (team_id, student_id, joined_at, is_active) VALUES (?, ?, ?, 1)'
        ).run(teamId, user.id, now());
        audit('student', user.id, 'team.create', 'team', teamId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return json(res, 201, { teamId, joinCode });
    }
    if (path === '/api/v2/teams/join' && req.method === 'POST') {
      const user = student(req);
      if (membership(user)) fail(409, 'You already belong to an active team.');
      const input = await body(req);
      const team = db
        .prepare('SELECT * FROM teams WHERE join_code_hash=? AND is_active=1')
        .get(hash(text(input.code, 20, true).toUpperCase()));
      if (!team || team.school_id !== user.schoolId)
        fail(404, 'That team code is invalid for your school.');
      if (db.prepare('SELECT count(*) AS n FROM team_members WHERE team_id=?').get(team.id).n >= 5)
        fail(409, 'This team already has five members.');
      db.prepare(
        'INSERT INTO team_members (team_id, student_id, joined_at, is_active) VALUES (?, ?, ?, 1)'
      ).run(team.id, user.id, now());
      audit('student', user.id, 'team.join', 'team', team.id);
      return json(res, 201, { teamId: team.id });
    }
    if (path === '/api/v2/teams/code' && req.method === 'POST') {
      const user = student(req);
      const team = membership(user);
      if (!team || team.ownerId !== user.id) fail(403, 'Only the team owner can refresh the code.');
      const joinCode = code();
      db.prepare('UPDATE teams SET join_code_hash=? WHERE id=?').run(hash(joinCode), team.teamId);
      audit('student', user.id, 'team.code.refresh', 'team', team.teamId);
      return json(res, 200, { joinCode });
    }
    const memberRoute = /^\/api\/v2\/teams\/members\/([a-f0-9]{32})$/.exec(path);
    if (memberRoute && ['PUT', 'DELETE'].includes(req.method)) {
      const user = student(req);
      const team = membership(user);
      if (!team || team.ownerId !== user.id) fail(403, 'Only the team owner can manage members.');
      if (
        !db
          .prepare('SELECT 1 FROM team_members WHERE team_id=? AND student_id=?')
          .get(team.teamId, memberRoute[1])
      )
        fail(404, 'Team member not found.');
      if (req.method === 'DELETE') {
        if (memberRoute[1] === user.id) fail(400, 'Transfer ownership before leaving.');
        db.prepare('UPDATE team_members SET is_active=0 WHERE team_id=? AND student_id=?').run(
          team.teamId,
          memberRoute[1]
        );
      } else {
        db.prepare('UPDATE teams SET owner_id=? WHERE id=?').run(memberRoute[1], team.teamId);
      }
      audit(
        'student',
        user.id,
        req.method === 'DELETE' ? 'team.member.remove' : 'team.owner.transfer',
        'team',
        team.teamId,
        { studentId: memberRoute[1] }
      );
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/project/draft' && req.method === 'PUT') {
      const user = student(req);
      const team = membership(user);
      if (!team) fail(409, 'Create or join a team first.');
      const input = projectInput(await body(req, 7_500_000));
      let project = teamProject(team.teamId);
      db.exec('BEGIN');
      try {
        if (!project) {
          const projectId = id(),
            revisionId = id();
          db.prepare('INSERT INTO showcase_projects VALUES (?, ?, ?, ?, ?, 0, 0, NULL, ?, ?)').run(
            projectId,
            team.teamId,
            user.schoolId,
            input.categoryId,
            input.year,
            now(),
            now()
          );
          db.prepare(
            "INSERT INTO project_revisions (id, project_id, version, title, description, learning_story, project_url, cover_image, tags_json, state, feedback, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'draft', '', ?)"
          ).run(
            revisionId,
            projectId,
            input.title,
            input.description,
            input.learningStory,
            input.projectUrl,
            input.coverImage,
            JSON.stringify(input.tags),
            now()
          );
        } else {
          if (['submitted', 'published'].includes(project.state)) {
            if (project.state === 'submitted')
              fail(409, 'This revision is locked while awaiting review.');
            const revisionId = id();
            db.prepare(
              "INSERT INTO project_revisions (id, project_id, version, title, description, learning_story, project_url, cover_image, tags_json, video_file, video_mime, video_name, state, feedback, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', '', ?)"
            ).run(
              revisionId,
              project.id,
              project.version + 1,
              input.title,
              input.description,
              input.learningStory,
              input.projectUrl,
              input.coverImage || project.coverImage,
              JSON.stringify(input.tags),
              project.videoFile || '',
              project.videoMime || '',
              project.videoName || '',
              now()
            );
          } else {
            db.prepare(
              `UPDATE project_revisions SET title=?, description=?, learning_story=?, project_url=?, cover_image=?, tags_json=?, state='draft', feedback='' WHERE id=?`
            ).run(
              input.title,
              input.description,
              input.learningStory,
              input.projectUrl,
              input.coverImage || project.coverImage,
              JSON.stringify(input.tags),
              project.revisionId
            );
          }
          db.prepare(
            'UPDATE showcase_projects SET category_id=?, year=?, updated_at=? WHERE id=?'
          ).run(input.categoryId, input.year, now(), project.id);
        }
        audit('student', user.id, 'project.save', 'team', team.teamId);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return json(res, 200, { project: teamProject(team.teamId) });
    }
    if (path === '/api/v2/project/submit' && req.method === 'POST') {
      const user = student(req);
      const team = membership(user);
      if (!team) fail(409, 'No active team.');
      const project = teamProject(team.teamId);
      if (!project || !['draft', 'changes_requested'].includes(project.state))
        fail(409, 'This project is not ready to submit.');
      if (
        !project.title ||
        !project.description ||
        !project.learningStory ||
        !project.projectUrl ||
        !project.coverImage ||
        !project.videoUrl ||
        !JSON.parse(project.tagsJson || '[]').length
      )
        fail(400, 'Complete every project section before submitting.');
      db.prepare("UPDATE project_revisions SET state='submitted', submitted_at=? WHERE id=?").run(
        now(),
        project.revisionId
      );
      audit('student', user.id, 'project.submit', 'project', project.id);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/project/withdraw' && req.method === 'POST') {
      const user = student(req);
      const team = membership(user);
      if (!team) fail(409, 'No active team.');
      const project = teamProject(team.teamId);
      if (!project || project.state !== 'submitted')
        fail(409, 'Only a submission awaiting review can be edited.');
      const changed = db
        .prepare(
          "UPDATE project_revisions SET state='draft', submitted_at=NULL WHERE id=? AND state='submitted'"
        )
        .run(project.revisionId).changes;
      if (!changed) fail(409, 'This submission has already been reviewed.');
      audit('student', user.id, 'project.withdraw', 'project', project.id);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/project/archive' && req.method === 'POST') {
      const user = student(req);
      const team = membership(user);
      if (!team || team.ownerId !== user.id)
        fail(403, 'Only the team owner can archive the project.');
      const project = teamProject(team.teamId);
      if (!project) fail(404, 'No active project to archive.');
      db.exec('BEGIN');
      try {
        db.prepare('UPDATE showcase_projects SET is_archived=1, updated_at=? WHERE id=?').run(
          now(),
          project.id
        );
        db.prepare('UPDATE teams SET is_active=0 WHERE id=?').run(team.teamId);
        db.prepare('UPDATE team_members SET is_active=0 WHERE team_id=?').run(team.teamId);
        audit('student', user.id, 'project.archive', 'project', project.id);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return json(res, 200, { ok: true });
    }

    if (path === '/api/v2/ballot' && req.method === 'GET') {
      const user = student(req);
      const round = activeRound();
      if (!round) return json(res, 200, { round: null, projects: [], vote: null });
      const allowed =
        db.prepare('SELECT count(*) AS n FROM round_schools WHERE round_id=?').get(round.id).n ===
          0 ||
        db
          .prepare('SELECT 1 FROM round_schools WHERE round_id=? AND school_id=?')
          .get(round.id, user.schoolId);
      if (!allowed) fail(403, 'Your school is not included in this voting round.');
      const ownTeam = membership(user)?.teamId || '';
      const projects = db
        .prepare(
          `${projectQuery} JOIN round_projects rp ON rp.project_id=p.id WHERE rp.round_id=? AND p.team_id<>? AND p.is_archived=0 ORDER BY r.title`
        )
        .all(round.id, ownTeam)
        .map(parseProject);
      const vote =
        db
          .prepare(
            'SELECT project_id AS projectId, created_at AS createdAt FROM platform_votes WHERE student_id=? AND round_id=?'
          )
          .get(user.id, round.id) || null;
      return json(res, 200, { round, projects, vote });
    }
    if (path === '/api/v2/vote' && req.method === 'POST') {
      const user = student(req);
      const input = await body(req);
      const round = activeRound();
      if (!round || input.roundId !== round.id)
        fail(409, 'The voting round changed. Refresh the ballot.');
      if (
        db
          .prepare('SELECT 1 FROM platform_votes WHERE student_id=? AND round_id=?')
          .get(user.id, round.id)
      )
        fail(409, 'Your vote in this round is already final.');
      const projectId = text(input.projectId, 32, true);
      if (
        !db
          .prepare('SELECT 1 FROM round_projects WHERE round_id=? AND project_id=?')
          .get(round.id, projectId)
      )
        fail(400, 'This project is not on the ballot.');
      if (
        membership(user)?.teamId ===
        db.prepare('SELECT team_id AS teamId FROM showcase_projects WHERE id=?').get(projectId)
          ?.teamId
      )
        fail(403, 'You cannot vote for your own team.');
      db.prepare('INSERT INTO platform_votes VALUES (?, ?, ?, ?)').run(
        user.id,
        round.id,
        projectId,
        now()
      );
      audit('student', user.id, 'vote.cast', 'round', round.id, { projectId });
      return json(res, 201, { ok: true });
    }

    if (path === '/api/v2/teacher/dashboard' && req.method === 'GET') {
      const user = teacher(req);
      const where = user.schoolId ? ' AND p.school_id=?' : '';
      const args = user.schoolId ? [user.schoolId] : [];
      const reviews = db
        .prepare(
          `SELECT p.id AS projectId, r.id AS revisionId, r.title, r.state, r.submitted_at AS submittedAt, t.name AS teamName, s.name AS schoolName FROM project_revisions r JOIN showcase_projects p ON p.id=r.project_id JOIN teams t ON t.id=p.team_id JOIN schools s ON s.id=p.school_id WHERE r.state='submitted'${where} ORDER BY r.submitted_at`
        )
        .all(...args);
      return json(res, 200, {
        user,
        reviews,
        published: db
          .prepare(
            `SELECT count(*) AS n FROM showcase_projects p WHERE p.published_revision_id IS NOT NULL AND p.is_archived=0${where}`
          )
          .get(...args).n,
        students: db
          .prepare(`SELECT count(*) AS n FROM students${user.schoolId ? ' WHERE school_id=?' : ''}`)
          .get(...args).n
      });
    }
    const reviewRoute = /^\/api\/v2\/teacher\/reviews\/([a-f0-9]{32})$/.exec(path);
    if (reviewRoute && req.method === 'GET') {
      const user = teacher(req);
      const revision = db
        .prepare(
          `SELECT r.*, p.school_id AS schoolId, p.id AS projectId, p.team_id AS teamId, t.name AS teamName FROM project_revisions r JOIN showcase_projects p ON p.id=r.project_id JOIN teams t ON t.id=p.team_id WHERE r.id=?`
        )
        .get(reviewRoute[1]);
      if (!revision) fail(404, 'Review not found.');
      canManage(user, revision.schoolId);
      return json(res, 200, { ...revision, members: teamMembers(revision.teamId) });
    }
    if (reviewRoute && req.method === 'POST') {
      const user = teacher(req);
      const revision = db
        .prepare(
          `SELECT r.*, p.school_id AS schoolId, p.id AS projectId, p.team_id AS teamId FROM project_revisions r JOIN showcase_projects p ON p.id=r.project_id WHERE r.id=?`
        )
        .get(reviewRoute[1]);
      if (!revision || revision.state !== 'submitted')
        fail(409, 'This revision is no longer awaiting review.');
      canManage(user, revision.schoolId);
      const input = await body(req);
      const decision = text(input.decision, 30, true);
      const feedback = text(input.feedback || '', 1000);
      if (!['approve', 'changes', 'remove'].includes(decision))
        fail(400, 'Choose a valid review decision.');
      if (decision === 'remove') {
        db.prepare(
          "UPDATE project_revisions SET state='draft', submitted_at=NULL WHERE id=? AND state='submitted'"
        ).run(revision.id);
        notifyTeam(
          revision.teamId,
          'review.removed',
          'Your teacher removed your submission from the review queue. It is now a draft that you can edit and resubmit.'
        );
        audit('teacher', user.id, 'review.remove', 'revision', revision.id);
        return json(res, 200, { ok: true });
      }
      const state = decision === 'approve' ? 'published' : 'changes_requested';
      db.prepare(
        'UPDATE project_revisions SET state=?, feedback=?, reviewed_at=?, reviewed_by=? WHERE id=?'
      ).run(state, feedback, now(), user.id, revision.id);
      if (decision === 'approve')
        db.prepare(
          'UPDATE showcase_projects SET published_revision_id=?, updated_at=? WHERE id=?'
        ).run(revision.id, now(), revision.projectId);
      notifyTeam(
        revision.teamId,
        `review.${state}`,
        decision === 'approve'
          ? 'Your project was approved and published.'
          : `Your teacher requested changes: ${feedback}`
      );
      audit('teacher', user.id, `review.${decision}`, 'revision', revision.id);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/teacher/students' && req.method === 'GET') {
      const user = teacher(req);
      return json(res, 200, {
        students: db
          .prepare(
            `SELECT s.id, s.username, s.full_name AS fullName, s.school_id AS schoolId, s.is_disabled AS isDisabled, c.name AS className, t.name AS teamName FROM students s JOIN classes c ON c.id=s.class_id LEFT JOIN team_members m ON m.student_id=s.id AND m.is_active=1 LEFT JOIN teams t ON t.id=m.team_id${user.schoolId ? ' WHERE s.school_id=?' : ''} ORDER BY s.full_name`
          )
          .all(...(user.schoolId ? [user.schoolId] : []))
      });
    }
    const studentManage = /^\/api\/v2\/teacher\/students\/([a-f0-9]{32})$/.exec(path);
    if (studentManage && req.method === 'PATCH') {
      const user = teacher(req);
      const target = db.prepare('SELECT * FROM students WHERE id=?').get(studentManage[1]);
      if (!target) fail(404, 'Student not found.');
      canManage(user, target.school_id);
      const input = await body(req);
      const updates = [];
      if (typeof input.disabled === 'boolean') {
        db.prepare('UPDATE students SET is_disabled=? WHERE id=?').run(
          input.disabled ? 1 : 0,
          target.id
        );
        if (input.disabled)
          db.prepare('DELETE FROM student_sessions WHERE student_id=?').run(target.id);
        updates.push('disabled');
      }
      if (input.fullName || input.className || input.schoolId) {
        const schoolId = input.schoolId ? text(input.schoolId, 100, true) : target.school_id;
        if (user.schoolId && schoolId !== target.school_id)
          fail(403, 'Only programme administrators can change a student’s school.');
        if (!db.prepare('SELECT 1 FROM schools WHERE id=? AND is_active=1').get(schoolId))
          fail(400, 'Choose an active school.');
        if (schoolId !== target.school_id && membership({ id: target.id }))
          fail(
            409,
            'Remove this student from their team or archive their team before changing schools.'
          );
        const fullName = input.fullName
          ? displayName(text(input.fullName, 120, true))
          : target.full_name;
        const className = input.className
          ? displayName(text(input.className, 80, true))
          : db.prepare('SELECT name FROM classes WHERE id=?').get(target.class_id).name;
        const classKey = normaliseIdentity(className);
        db.prepare('INSERT OR IGNORE INTO classes VALUES (?, ?, ?, ?)').run(
          id(),
          schoolId,
          className,
          classKey
        );
        const classId = db
          .prepare('SELECT id FROM classes WHERE school_id=? AND name_key=?')
          .get(schoolId, classKey).id;
        if (
          db
            .prepare(
              'SELECT 1 FROM students WHERE school_id=? AND class_id=? AND name_key=? AND id<>?'
            )
            .get(schoolId, classId, normaliseIdentity(fullName), target.id)
        )
          fail(409, 'A student with this full name already exists in that school and class.');
        db.prepare(
          'UPDATE students SET full_name=?, name_key=?, class_id=?, school_id=? WHERE id=?'
        ).run(fullName, normaliseIdentity(fullName), classId, schoolId, target.id);
        if (schoolId !== target.school_id) {
          db.prepare('DELETE FROM student_sessions WHERE student_id=?').run(target.id);
          updates.push('school');
        }
        updates.push('identity');
      }
      audit('teacher', user.id, 'student.update', 'student', target.id, { updates });
      return json(res, 200, { ok: true });
    }

    if (path === '/api/v2/admin/dashboard' && req.method === 'GET') {
      const user = teacher(req);
      requireAdmin(user);
      return json(res, 200, {
        activeRound: activeRound(),
        schools: db.prepare('SELECT count(*) AS n FROM schools WHERE is_active=1').get().n,
        students: db.prepare('SELECT count(*) AS n FROM students WHERE is_disabled=0').get().n,
        published: db
          .prepare(
            'SELECT count(*) AS n FROM showcase_projects WHERE published_revision_id IS NOT NULL AND is_archived=0'
          )
          .get().n,
        schoolList: db
          .prepare(
            'SELECT id, name, short_name AS shortName, is_active AS isActive FROM schools ORDER BY name'
          )
          .all(),
        teachers: db
          .prepare(
            'SELECT t.id, t.username, t.full_name AS fullName, t.school_id AS schoolId, t.is_disabled AS isDisabled, s.name AS schoolName FROM teachers t LEFT JOIN schools s ON s.id=t.school_id ORDER BY t.username'
          )
          .all(),
        rounds: db
          .prepare(
            'SELECT id, name, status, opens_at AS opensAt, closes_at AS closesAt FROM voting_rounds WHERE is_deleted=0 ORDER BY created_at DESC'
          )
          .all(),
        audits: db.prepare('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT 20').all()
      });
    }
    if (path === '/api/v2/admin/categories' && req.method === 'GET') {
      const user = teacher(req);
      requireAdmin(user);
      return json(res, 200, {
        categories: db
          .prepare(
            'SELECT id, name, is_active AS isActive, sort_order AS sortOrder FROM categories ORDER BY sort_order, name'
          )
          .all()
      });
    }
    if (path === '/api/v2/admin/categories' && req.method === 'POST') {
      const user = teacher(req);
      requireAdmin(user);
      const input = await body(req);
      const categoryId = id();
      db.prepare('INSERT INTO categories VALUES (?, ?, 1, ?)').run(
        categoryId,
        text(input.name, 80, true),
        Number(input.sortOrder) || 0
      );
      audit('teacher', user.id, 'category.create', 'category', categoryId);
      return json(res, 201, { id: categoryId });
    }
    const categoryRoute = /^\/api\/v2\/admin\/categories\/([a-z0-9-]+)$/.exec(path);
    if (categoryRoute && req.method === 'PATCH') {
      const user = teacher(req);
      requireAdmin(user);
      const input = await body(req);
      const existing = db.prepare('SELECT * FROM categories WHERE id=?').get(categoryRoute[1]);
      if (!existing) fail(404, 'Category not found.');
      db.prepare('UPDATE categories SET name=?, is_active=?, sort_order=? WHERE id=?').run(
        input.name ? text(input.name, 80, true) : existing.name,
        typeof input.isActive === 'boolean' ? Number(input.isActive) : existing.is_active,
        Number.isInteger(input.sortOrder) ? input.sortOrder : existing.sort_order,
        existing.id
      );
      audit('teacher', user.id, 'category.update', 'category', existing.id);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/admin/teachers' && req.method === 'POST') {
      const user = teacher(req);
      requireAdmin(user);
      const input = await body(req);
      const username = text(input.username, 64, true).toLowerCase();
      if (
        db.prepare('SELECT 1 FROM students WHERE username=?').get(username) ||
        db.prepare('SELECT 1 FROM teachers WHERE username=?').get(username)
      )
        fail(409, 'That username is already taken. Choose another username.');
      if (!/^[a-z0-9._-]{3,64}$/.test(username))
        fail(400, 'Username must be 3–64 letters, numbers, dots, underscores or hyphens.');
      try {
        validateNewPassword(input.password);
      } catch (error) {
        fail(400, error.message);
      }
      const schoolId = input.schoolId ? text(input.schoolId, 80, true) : null;
      if (schoolId && !db.prepare('SELECT 1 FROM schools WHERE id=? AND is_active=1').get(schoolId))
        fail(400, 'Choose an active school.');
      const teacherId = id();
      db.prepare(
        'INSERT INTO teachers (id,username,password_hash,school_id,full_name,is_disabled) VALUES (?,?,?,?,?,0)'
      ).run(
        teacherId,
        username,
        passwordHash(input.password),
        schoolId,
        displayName(text(input.fullName, 120, true))
      );
      audit('teacher', user.id, 'teacher.create', 'teacher', teacherId, { schoolId });
      return json(res, 201, { id: teacherId });
    }
    const teacherRoute = /^\/api\/v2\/admin\/teachers\/([a-f0-9]{32})$/.exec(path);
    if (teacherRoute && req.method === 'PATCH') {
      const user = teacher(req);
      requireAdmin(user);
      const input = await body(req);
      if (teacherRoute[1] === user.id && input.disabled === true)
        fail(400, 'You cannot disable your own account.');
      const existing = db.prepare('SELECT * FROM teachers WHERE id=?').get(teacherRoute[1]);
      if (!existing) fail(404, 'Teacher not found.');
      if (input.fullName !== undefined)
        db.prepare('UPDATE teachers SET full_name=? WHERE id=?').run(
          displayName(text(input.fullName, 120, true)),
          existing.id
        );
      if (typeof input.disabled === 'boolean') {
        db.prepare('UPDATE teachers SET is_disabled=? WHERE id=?').run(
          Number(input.disabled),
          existing.id
        );
        if (input.disabled) db.prepare('DELETE FROM sessions WHERE teacher_id=?').run(existing.id);
      }
      if (input.password) {
        try {
          validateNewPassword(input.password);
        } catch (error) {
          fail(400, error.message);
        }
        db.prepare('UPDATE teachers SET password_hash=? WHERE id=?').run(
          passwordHash(input.password),
          existing.id
        );
        db.prepare('DELETE FROM sessions WHERE teacher_id=?').run(existing.id);
      }
      audit('teacher', user.id, 'teacher.update', 'teacher', existing.id);
      return json(res, 200, { ok: true });
    }
    const schoolAdminRoute = /^\/api\/v2\/admin\/schools\/([a-z0-9-]+)$/.exec(path);
    if (schoolAdminRoute && req.method === 'PATCH') {
      const user = teacher(req);
      requireAdmin(user);
      const input = await body(req);
      const existing = db.prepare('SELECT * FROM schools WHERE id=?').get(schoolAdminRoute[1]);
      if (!existing) fail(404, 'School not found.');
      db.prepare('UPDATE schools SET name=?, short_name=?, is_active=? WHERE id=?').run(
        input.name ? text(input.name, 120, true) : existing.name,
        input.shortName ? text(input.shortName, 8, true) : existing.short_name,
        typeof input.isActive === 'boolean' ? Number(input.isActive) : existing.is_active,
        existing.id
      );
      audit('teacher', user.id, 'school.update', 'school', existing.id, input);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/admin/featured' && req.method === 'PUT') {
      const user = teacher(req);
      requireAdmin(user);
      const input = await body(req);
      const projectId = text(input.projectId, 32, true);
      if (
        !db
          .prepare(
            'SELECT 1 FROM showcase_projects WHERE id=? AND published_revision_id IS NOT NULL'
          )
          .get(projectId)
      )
        fail(400, 'Choose a published project.');
      db.prepare('UPDATE showcase_projects SET is_featured=CASE WHEN id=? THEN 1 ELSE 0 END').run(
        projectId
      );
      audit('teacher', user.id, 'featured.set', 'project', projectId);
      return json(res, 200, { ok: true });
    }
    if (path === '/api/v2/admin/rounds' && req.method === 'POST') {
      const user = teacher(req);
      requireAdmin(user);
      const input = await body(req);
      const roundId = id();
      db.prepare(
        "INSERT INTO voting_rounds (id,name,is_open,created_at,status,opens_at,closes_at,ballot_locked) VALUES (?,?,0,?,'draft',?,?,0)"
      ).run(
        roundId,
        text(input.name, 120, true),
        now(),
        input.opensAt || null,
        input.closesAt || null
      );
      for (const projectId of input.projectIds || []) {
        if (
          !db
            .prepare(
              'SELECT 1 FROM showcase_projects WHERE id=? AND published_revision_id IS NOT NULL'
            )
            .get(projectId)
        )
          fail(400, 'A selected project is not published.');
        db.prepare('INSERT INTO round_projects VALUES (?,?)').run(roundId, projectId);
      }
      for (const schoolId of input.schoolIds || [])
        db.prepare('INSERT INTO round_schools VALUES (?,?)').run(roundId, schoolId);
      audit('teacher', user.id, 'round.create', 'round', roundId);
      return json(res, 201, { id: roundId });
    }
    const deleteRound = /^\/api\/v2\/admin\/rounds\/([a-z0-9-]{1,64})$/.exec(path);
    if (deleteRound && req.method === 'DELETE') {
      const user = teacher(req);
      requireAdmin(user);
      const round = db
        .prepare('SELECT * FROM voting_rounds WHERE id=? AND is_deleted=0')
        .get(deleteRound[1]);
      if (!round) fail(404, 'Round not found.');
      if (round.status === 'open') fail(409, 'Close this voting round before deleting it.');
      db.prepare('UPDATE voting_rounds SET is_deleted=1 WHERE id=?').run(round.id);
      audit('teacher', user.id, 'round.delete', 'round', round.id, { name: round.name });
      return json(res, 200, { ok: true });
    }
    const roundAction = /^\/api\/v2\/admin\/rounds\/([a-z0-9-]{1,64})\/(open|close)$/.exec(path);
    if (roundAction && req.method === 'POST') {
      const user = teacher(req);
      requireAdmin(user);
      const round = db
        .prepare('SELECT * FROM voting_rounds WHERE id=? AND is_deleted=0')
        .get(roundAction[1]);
      if (!round) fail(404, 'Round not found.');
      if (roundAction[2] === 'open') {
        if (
          db.prepare('SELECT count(*) AS n FROM round_projects WHERE round_id=?').get(round.id)
            .n === 0
        )
          fail(409, 'Add at least one project before opening the round.');
        db.prepare("UPDATE voting_rounds SET status='closed',is_open=0 WHERE status='open'").run();
        db.prepare(
          "UPDATE voting_rounds SET status='open',is_open=1,ballot_locked=1,opens_at=coalesce(opens_at,?) WHERE id=?"
        ).run(now(), round.id);
      } else
        db.prepare(
          "UPDATE voting_rounds SET status='closed',is_open=0,closes_at=coalesce(closes_at,?) WHERE id=?"
        ).run(now(), round.id);
      audit('teacher', user.id, `round.${roundAction[2]}`, 'round', round.id);
      return json(res, 200, { ok: true });
    }

    fail(404, 'New platform endpoint not found.');
  }
  return { handle };
}
