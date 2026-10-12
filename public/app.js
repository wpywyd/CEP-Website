'use strict';
const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
let showcase = { schools: [], projects: [] };
let management = null;
let registration = { schools: [] };
let voter = null;
let editing = null;
let resetStudent = null;
let teacherTab = 'manage';
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
async function api(path, method = 'GET', value) {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'X-CEP-Request': '1',
      ...(value !== undefined ? { 'Content-Type': 'application/json' } : {})
    },
    ...(value !== undefined ? { body: JSON.stringify(value) } : {})
  });
  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data.error || 'Request failed.');
  return data;
}
function message(id, text = '', error = false) {
  $(id).textContent = text;
  $(id).classList.toggle('error', error);
}
async function busy(form, task, messageId) {
  const buttons = [...form.querySelectorAll('button[type="submit"]')];
  buttons.forEach((b) => (b.disabled = true));
  message(messageId);
  try {
    await task();
  } catch (error) {
    message(messageId, error.message, true);
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}
const options = (items, selected = '') =>
  items
    .map(
      (item) =>
        `<option value="${escape(item.id)}" ${item.id === selected ? 'selected' : ''}>${escape(item.name)}</option>`
    )
    .join('');
const schoolName = (id) =>
  showcase.schools.find((s) => s.id === id)?.name ||
  management?.schools.find((s) => s.id === id)?.name ||
  'School';
function stats(id, values) {
  $(id).innerHTML = values
    .map(
      ([count, label]) =>
        `<div class="stat"><strong>${escape(count)}</strong><span>${escape(label)}</span></div>`
    )
    .join('');
}
async function refreshShowcase() {
  try {
    showcase = await api('/api/showcase');
    const selected = $('public-school').value;
    $('public-school').innerHTML =
      '<option value="">All schools</option>' + options(showcase.schools, selected);
    stats('public-stats', [
      [showcase.schools.length, 'Participating schools'],
      [showcase.projects.length, 'Published projects'],
      [showcase.projects.reduce((n, p) => n + p.votes, 0), 'Votes on published projects']
    ]);
    message(
      'public-message',
      showcase.round
        ? `${showcase.round.name} · Voting ${showcase.round.isOpen ? 'open' : 'closed'}`
        : ''
    );
    renderShowcase();
  } catch (error) {
    message('public-message', `Could not load projects. ${error.message}`, true);
  }
}
function renderShowcase() {
  const query = $('public-search').value.trim().toLowerCase();
  const school = $('public-school').value;
  const sorted = [...showcase.projects].sort(
    (a, b) => b.votes - a.votes || a.gameTitle.localeCompare(b.gameTitle)
  );
  const rank = new Map();
  let previous = null;
  let currentRank = 0;
  sorted.forEach((p, i) => {
    if (p.votes !== previous) currentRank = i + 1;
    rank.set(p.id, currentRank);
    previous = p.votes;
  });
  let projects = sorted.filter(
    (p) =>
      (!school || p.schoolId === school) &&
      `${p.gameTitle} ${p.teamName} ${p.learningTopic} ${schoolName(p.schoolId)}`
        .toLowerCase()
        .includes(query)
  );
  if ($('public-sort').value === 'title')
    projects.sort((a, b) => a.gameTitle.localeCompare(b.gameTitle));
  if ($('public-sort').value === 'newest')
    projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('public-projects').innerHTML = projects.length
    ? projects
        .map(
          (p) =>
            `<article class="project-card"><div class="card-art"><span class="rank">#${rank.get(p.id)}</span><img src="/artwork.svg" alt="" loading="lazy"></div><div class="card-body"><span class="tag">${escape(p.learningTopic)}</span><h3>${escape(p.gameTitle)}</h3><p>${escape(schoolName(p.schoolId))} · ${escape(p.teamName)}</p><p>${escape(p.description || 'Explore this student-created MakeCode game.')}</p><div class="card-footer"><strong>${p.votes} ${p.votes === 1 ? 'vote' : 'votes'}</strong><button class="button secondary" data-details="${p.id}">View project</button></div></div></article>`
        )
        .join('')
    : `<div class="empty">${showcase.projects.length ? 'No projects match your search.' : 'The showcase is getting ready. Published student projects will appear here.'}</div>`;
}
function details(id) {
  const p = showcase.projects.find((p) => p.id === id);
  if (!p) return;
  $('detail-title').textContent = p.gameTitle;
  $('detail-content').innerHTML =
    `<p><span class="tag">${escape(p.learningTopic)}</span></p><p>${escape(schoolName(p.schoolId))} · ${escape(p.teamName)}</p><p>${escape(p.description)}</p><p>${p.votes} votes this round</p>${p.makecodeUrl ? `<a class="button primary" href="${escape(p.makecodeUrl)}" target="_blank" rel="noopener noreferrer">Play MakeCode game ↗</a>` : '<p>The team has not added a game link yet.</p>'}<a class="button secondary" id="detail-vote" href="#vote">Go to student voting</a>`;
  $('detail-vote').addEventListener('click', () => $('details').close());
  $('details').showModal();
}
async function loadRegistration() {
  registration = await api('/api/registration');
  const selected = $('register-school').value;
  $('register-school').innerHTML =
    '<option value="">Choose your school</option>' + options(registration.schools, selected);
}
function showStudentAuth(register = false) {
  $('student-auth').hidden = false;
  $('student-workspace').hidden = true;
  $('register-form').hidden = !register;
  $('student-login').hidden = register;
  $('show-register').className = `button ${register ? 'primary' : 'secondary'}`;
  $('show-student-login').className = `button ${register ? 'secondary' : 'primary'}`;
}
async function loadVoter() {
  try {
    voter = await api('/api/voter');
    renderBallot();
  } catch (error) {
    voter = null;
    showStudentAuth();
    if (error.status !== 401) message('student-login-message', error.message, true);
  }
}
function renderBallot() {
  $('student-auth').hidden = true;
  $('student-workspace').hidden = false;
  $('student-account').textContent = `Signed in as ${voter.user.fullName} (${voter.user.username})`;
  $('round-title').textContent = voter.round.name;
  const canVote = voter.round.isOpen && !voter.vote && voter.choices.length;
  $('ballot-status').textContent = voter.vote
    ? `Thank you! Your final vote was recorded for ${voter.vote.gameTitle}. You cannot vote again in this round.`
    : !voter.round.isOpen
      ? 'Voting is closed for this round.'
      : !voter.choices.length
        ? 'No published projects are available yet. Please check back later.'
        : 'Choose carefully. You may vote once in this round and your choice cannot be changed.';
  $('ballot-choices').innerHTML = canVote
    ? voter.choices
        .map(
          (p) =>
            `<label class="ballot-option"><input type="radio" name="projectId" value="${p.id}" required><span><strong>${escape(p.gameTitle)}</strong><small>${escape(schoolName(p.schoolId))} · ${escape(p.learningTopic)}</small></span></label>`
        )
        .join('')
    : '';
  $('final-confirmation').hidden = !canVote;
  $('final-confirmation').querySelector('input').required = Boolean(canVote);
  $('final-confirmation').querySelector('input').checked = false;
  $('save-vote').hidden = !canVote;
}
async function loadManagement() {
  try {
    management = await api('/api/manage');
    $('login-form').hidden = true;
    $('workspace').hidden = false;
    $('account-label').textContent =
      `${management.user.username} · ${management.user.schoolId ? schoolName(management.user.schoolId) : 'Programme administrator'}`;
    stats('teacher-stats', [
      [management.projects.length, 'Project records'],
      [management.projects.filter((p) => p.status === 'Published').length, 'Published projects'],
      [management.projects.reduce((n, p) => n + p.votes, 0), 'Votes this round']
    ]);
    const selected = $('manage-status').value;
    $('manage-status').innerHTML =
      '<option value="">All statuses</option>' +
      management.statuses
        .map((s) => `<option ${s === selected ? 'selected' : ''}>${escape(s)}</option>`)
        .join('');
    renderRecords();
    await showTab(teacherTab);
  } catch (error) {
    if (error.status === 401) {
      management = null;
      $('login-form').hidden = false;
      $('workspace').hidden = true;
    } else message('workspace-message', error.message, true);
  }
}
function renderRecords() {
  const query = $('manage-search').value.trim().toLowerCase();
  const status = $('manage-status').value;
  const projects = management.projects.filter(
    (p) =>
      (!status || p.status === status) &&
      `${p.gameTitle} ${p.teamName}`.toLowerCase().includes(query)
  );
  $('manage-projects').innerHTML = projects.length
    ? projects
        .map(
          (p) =>
            `<article class="record"><div><span class="tag">${escape(p.status)}</span><h3>${escape(p.gameTitle)}</h3><p>${escape(schoolName(p.schoolId))} · ${escape(p.teamName)}</p><p>Session ${p.currentSession}/8 · ${p.progress}% complete · ${p.votes} votes</p></div><div class="record-actions"><button class="button secondary" data-edit="${p.id}">Edit</button><button class="button danger" data-delete="${p.id}">Delete</button></div></article>`
        )
        .join('')
    : '<div class="empty">No project records. Add your first project to get started.</div>';
}
function renderProjectSchoolChoices() {
  const input = $('project-school-search');
  const query = input.value.trim().toLocaleLowerCase('en-SG');
  const schools = (management?.schools || [])
    .filter(
      (school) =>
        school.isActive !== 0 && (!query || school.name.toLocaleLowerCase('en-SG').includes(query))
    )
    .slice(0, 50);
  const results = $('project-school-results');
  results.innerHTML = schools.length
    ? schools
        .map(
          (school) =>
            `<button type="button" class="combobox-option" role="option" data-school-choice="${escape(school.id)}">${escape(school.name)}</button>`
        )
        .join('')
    : '<div class="combobox-empty">No school name contains that text.</div>';
  results.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function chooseProjectSchool(id) {
  const school = management?.schools.find((item) => item.id === id && item.isActive !== 0);
  if (!school) return;
  const form = $('project-form');
  form.elements.schoolId.value = school.id;
  $('project-school-search').value = school.name;
  $('project-school-results').hidden = true;
  $('project-school-search').setAttribute('aria-expanded', 'false');
}

function openEditor(id = null) {
  editing = id ? management.projects.find((p) => p.id === id) : null;
  const form = $('project-form');
  form.reset();
  $('editor-title').textContent = editing ? 'Edit project' : 'Add a project';
  form.elements.schoolId.value = editing?.schoolId || '';
  $('project-school-search').value = editing ? schoolName(editing.schoolId) : '';
  $('project-school-search').disabled = Boolean(editing);
  $('project-school-results').hidden = true;
  $('project-school-search').setAttribute('aria-expanded', 'false');
  form.elements.status.innerHTML = management.statuses
    .map((s) => `<option>${escape(s)}</option>`)
    .join('');
  if (editing)
    for (const field of [
      'schoolId',
      'teamName',
      'gameTitle',
      'learningTopic',
      'description',
      'makecodeUrl',
      'status',
      'currentSession',
      'progress',
      'trainerFeedback'
    ])
      form.elements[field].value = editing[field];
  message('editor-message');
  $('editor').showModal();
}
async function showTab(tab) {
  teacherTab = tab;
  for (const name of ['manage', 'students']) $(`${name}-panel`).hidden = tab !== name;
  document
    .querySelectorAll('[data-tab]')
    .forEach((b) => (b.className = `button ${b.dataset.tab === tab ? 'primary' : 'secondary'}`));
  if (tab === 'students') await loadStudents();
}
async function loadStudents() {
  const { students } = await api('/api/students');
  $('students-list').innerHTML = students.length
    ? students
        .map(
          (s) =>
            `<article class="record"><div><h3>${escape(s.fullName)}</h3><p>${escape(schoolName(s.schoolId))} · ${escape(s.className)}</p><p>Username: ${escape(s.username)}</p></div><button class="button secondary" data-reset="${s.id}" data-name="${escape(s.fullName)}">Reset password</button></article>`
        )
        .join('')
    : '<div class="empty">No students have registered yet.</div>';
  $('round-controls').hidden = Boolean(management.user.schoolId);
  if (!management.user.schoolId) {
    const round = await api('/api/round');
    $('teacher-round-status').textContent =
      `${round.name} · Voting ${round.isOpen ? 'open' : 'closed'}`;
    $('close-round').hidden = !round.isOpen;
    $('new-round').hidden = Boolean(round.isOpen);
  }
}
async function navigate() {
  const hash = location.hash.slice(1);
  const isTeacherPage = location.pathname === '/teacher' || location.pathname === '/teacher/';
  const route = isTeacherPage ? 'teacher' : hash === 'vote' ? 'vote' : 'showcase';
  for (const name of ['showcase', 'vote', 'teacher']) $(name).hidden = name !== route;
  document
    .querySelectorAll('nav a')
    .forEach((a) =>
      a.getAttribute('href') === (route === 'vote' ? '/#vote' : '/')
        ? a.setAttribute('aria-current', 'page')
        : a.removeAttribute('aria-current')
    );
  if (route === 'vote') {
    try {
      await loadRegistration();
      await loadVoter();
    } catch (error) {
      message('student-login-message', error.message, true);
    }
  }
  if (route === 'teacher') await loadManagement();
  if (hash === 'projects') $('projects').scrollIntoView();
}
$('refresh-showcase').addEventListener('click', refreshShowcase);
for (const id of ['public-search', 'public-school', 'public-sort'])
  $(id).addEventListener('input', renderShowcase);
$('public-projects').addEventListener('click', (e) => {
  const button = e.target.closest('[data-details]');
  if (button) details(button.dataset.details);
});
$('close-details').addEventListener('click', () => $('details').close());
$('show-register').addEventListener('click', () => showStudentAuth(true));
$('show-student-login').addEventListener('click', () => showStudentAuth(false));
$('register-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(
    e.currentTarget,
    async () => {
      const form = $('register-form');
      const input = Object.fromEntries(new FormData(form));
      if (input.password !== input.confirmPassword) throw new Error('Passwords do not match.');
      delete input.confirmPassword;
      input.fullNameConfirmed = form.elements.fullNameConfirmed.checked;
      await api('/api/students/register', 'POST', input);
      form.reset();
      await loadVoter();
    },
    'register-message'
  );
});
$('student-login').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(
    e.currentTarget,
    async () => {
      await api(
        '/api/students/login',
        'POST',
        Object.fromEntries(new FormData($('student-login')))
      );
      $('student-login').reset();
      message('vote-message');
      await loadVoter();
    },
    'student-login-message'
  );
});
$('student-logout').addEventListener('click', async () => {
  try {
    await api('/api/students/logout', 'POST', {});
    voter = null;
    $('ballot-form').reset();
    $('ballot-choices').replaceChildren();
    $('student-account').textContent = '';
    message('vote-message');
    showStudentAuth();
  } catch (error) {
    message('vote-message', error.message, true);
  }
});
$('ballot-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(
    e.currentTarget,
    async () => {
      const projectId = new FormData($('ballot-form')).get('projectId');
      try {
        const result = await api('/api/vote', 'POST', { projectId, roundId: voter.round.id });
        message('vote-message', `Your final vote for ${result.gameTitle} has been recorded.`);
      } catch (error) {
        if (error.status === 409) await loadVoter();
        throw error;
      }
      await loadVoter();
      await refreshShowcase();
    },
    'vote-message'
  );
});
$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(
    e.currentTarget,
    async () => {
      await api('/api/login', 'POST', Object.fromEntries(new FormData($('login-form'))));
      $('login-form').reset();
      await loadManagement();
    },
    'login-message'
  );
});
$('logout').addEventListener('click', async () => {
  try {
    await api('/api/logout', 'POST', {});
    management = null;
    $('workspace').hidden = true;
    $('login-form').hidden = false;
    $('students-list').replaceChildren();
  } catch (error) {
    message('workspace-message', error.message, true);
  }
});
$('manage-search').addEventListener('input', renderRecords);
$('manage-status').addEventListener('change', renderRecords);
$('new-project').addEventListener('click', () => openEditor());
$('close-editor').addEventListener('click', () => $('editor').close());
$('project-school-search').addEventListener('input', () => {
  $('project-form').elements.schoolId.value = '';
  renderProjectSchoolChoices();
});
$('project-school-search').addEventListener('focus', renderProjectSchoolChoices);
$('project-school-search').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    $('project-school-results').hidden = true;
    event.currentTarget.setAttribute('aria-expanded', 'false');
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    $('project-school-results').querySelector('.combobox-option')?.focus();
  }
});
$('project-school-results').addEventListener('click', (event) => {
  const option = event.target.closest('[data-school-choice]');
  if (option) chooseProjectSchool(option.dataset.schoolChoice);
});
$('project-school-results').addEventListener('keydown', (event) => {
  if (!event.target.matches('.combobox-option')) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const choices = [...$('project-school-results').querySelectorAll('.combobox-option')];
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    choices[(choices.indexOf(event.target) + offset + choices.length) % choices.length]?.focus();
  }
  if (event.key === 'Escape') $('project-school-search').focus();
});
$('manage-projects').addEventListener('click', async (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return openEditor(edit.dataset.edit);
  const remove = e.target.closest('[data-delete]');
  if (!remove) return;
  const p = management.projects.find((p) => p.id === remove.dataset.delete);
  if (
    !confirm(
      `Delete ${p.gameTitle}? This cannot be undone. Projects with votes must be unpublished instead.`
    )
  )
    return;
  try {
    await api(`/api/projects/${p.id}`, 'DELETE', { revision: p.revision });
    await loadManagement();
    await refreshShowcase();
  } catch (error) {
    message('workspace-message', error.message, true);
  }
});
$('project-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(
    e.currentTarget,
    async () => {
      const form = $('project-form');
      const input = Object.fromEntries(new FormData(form));
      if (!form.elements.schoolId.value)
        throw new Error('Choose a school from the matching search results.');
      input.schoolId = form.elements.schoolId.value;
      input.progress = Number(input.progress);
      input.currentSession = Number(input.currentSession);
      delete input.privacy;
      if (editing) input.revision = editing.revision;
      await api(
        editing ? `/api/projects/${editing.id}` : '/api/projects',
        editing ? 'PUT' : 'POST',
        input
      );
      $('editor').close();
      await loadManagement();
      await refreshShowcase();
    },
    'editor-message'
  );
});
for (const button of document.querySelectorAll('[data-tab]'))
  button.addEventListener('click', async () => {
    try {
      await showTab(button.dataset.tab);
    } catch (error) {
      message('workspace-message', error.message, true);
    }
  });
$('refresh-students').addEventListener('click', async () => {
  try {
    await loadStudents();
  } catch (error) {
    message('workspace-message', error.message, true);
  }
});
$('students-list').addEventListener('click', (e) => {
  const button = e.target.closest('[data-reset]');
  if (!button) return;
  resetStudent = button.dataset.reset;
  $('reset-student-label').textContent = button.dataset.name;
  $('reset-password-form').reset();
  message('reset-message');
  $('password-dialog').showModal();
});
$('close-password').addEventListener('click', () => $('password-dialog').close());
$('reset-password-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(
    e.currentTarget,
    async () => {
      const form = $('reset-password-form');
      if (form.elements.password.value !== form.elements.confirmPassword.value)
        throw new Error('Passwords do not match.');
      await api(`/api/students/${resetStudent}/password`, 'PUT', {
        password: form.elements.password.value
      });
      form.reset();
      $('password-dialog').close();
      message(
        'workspace-message',
        'Student password reset. Existing student sessions were revoked.'
      );
    },
    'reset-message'
  );
});
$('close-round').addEventListener('click', async () => {
  if (
    !confirm(
      'Close voting for all schools? Students will no longer be able to submit votes in this round.'
    )
  )
    return;
  try {
    await api('/api/round/close', 'POST', {});
    await loadStudents();
    await refreshShowcase();
  } catch (error) {
    message('round-message', error.message, true);
  }
});
$('new-round').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(
    e.currentTarget,
    async () => {
      if (
        !confirm(
          'Start a new round? All students can vote once again. Previous votes remain stored; public totals will show the new round.'
        )
      )
        return;
      await api('/api/round', 'POST', Object.fromEntries(new FormData($('new-round'))));
      $('new-round').reset();
      await loadStudents();
      await refreshShowcase();
    },
    'round-message'
  );
});
window.addEventListener('hashchange', navigate);
window.addEventListener('pageshow', (e) => {
  if (e.persisted) navigate();
});
await refreshShowcase();
await navigate();
