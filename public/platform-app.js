const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
const state = {
  showcase: null,
  student: null,
  staff: null,
  selectedVote: null,
  review: null,
  coverImage: ''
};

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
function message(target, value = '', error = false) {
  const node = typeof target === 'string' ? $(target) : target;
  if (!node) return;
  node.textContent = value;
  node.classList.toggle('error', error);
}
async function submit(form, task) {
  const note = $('.form-message', form);
  const buttons = $$('button', form);
  buttons.forEach((button) => (button.disabled = true));
  message(note);
  try {
    await task();
  } catch (error) {
    message(note, error.message, true);
  } finally {
    buttons.forEach((button) => (button.disabled = false));
  }
}
const initials = (name) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
const coverStyle = (cover) =>
  cover ? `style="background-image:url('${cover.replace(/'/g, '%27')}')"` : '';
const coverClass = (cover, extra = '') => `${extra} ${cover ? 'cover' : 'no-cover'}`;

function projectCard(project, ballot = false) {
  const content = `<div class="project-image ${coverClass(project.coverImage)}" ${coverStyle(project.coverImage)}></div><div class="card-body"><span class="category">${escapeHtml(project.category || 'Project')}</span><h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(project.teamName)}</p><small>${escapeHtml(project.schoolName)}</small>${ballot ? '<span class="select-label">Select this project</span>' : ''}</div>`;
  return ballot
    ? `<label class="ballot-card"><input type="radio" name="projectId" value="${project.id}" />${content}</label>`
    : `<button class="project-card" data-project="${project.id}">${content}</button>`;
}

async function loadShowcase() {
  state.showcase = await api('/api/v2/showcase');
  const { projects, schools, categories, round } = state.showcase;
  $('#public-school').innerHTML =
    '<option value="">All schools</option>' +
    schools.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
  $('#public-category').innerHTML =
    '<option value="">All categories</option>' +
    categories
      .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`)
      .join('');
  const years = [...new Set(projects.map((project) => project.year))].sort((a, b) => b - a);
  $('#public-year').innerHTML =
    '<option value="">All years</option>' +
    years.map((year) => `<option>${year}</option>`).join('');
  if (round) {
    $('#round-strip').hidden = false;
    $('#round-title').textContent = `${round.name} is live`;
    $('#round-total').textContent = `${round.totalVotes} students have voted`;
  }
  const featured = projects.find((project) => project.isFeatured) || projects[0];
  $('#featured-project').innerHTML = featured
    ? `<div class="game-scene ${coverClass(featured.coverImage)}" ${coverStyle(featured.coverImage)}></div><div class="featured-info"><span class="category">${escapeHtml(featured.category)}</span><h2>${escapeHtml(featured.title)}</h2><p>${escapeHtml(featured.teamName)} · ${escapeHtml(featured.schoolName)}</p><span class="play-link">View project ↗</span></div>`
    : '<div class="featured-info"><span class="category">COMING SOON</span><h2>Student work will appear here.</h2><p>Approved team projects become part of the year-round showcase.</p></div>';
  if (featured) $('#featured-project').dataset.project = featured.id;
  renderPublicProjects();
}
function renderPublicProjects() {
  const query = $('#public-search').value.trim().toLowerCase(),
    school = $('#public-school').value,
    category = $('#public-category').value,
    year = $('#public-year').value;
  const projects = state.showcase.projects.filter(
    (project) =>
      (!school || project.schoolId === school) &&
      (!category || project.categoryId === category) &&
      (!year || String(project.year) === year) &&
      `${project.title} ${project.teamName} ${project.schoolName} ${project.tags.join(' ')}`
        .toLowerCase()
        .includes(query)
  );
  $('#project-count').textContent = `${projects.length} project${projects.length === 1 ? '' : 's'}`;
  $('#public-projects').innerHTML = projects.length
    ? projects.map((project) => projectCard(project)).join('')
    : '<div class="empty-projects">No published projects match these filters.</div>';
}
async function openProject(projectId) {
  try {
    const project = await api(`/api/v2/showcase/${projectId}`);
    $('#project-detail').innerHTML =
      `<div class="modal-image ${coverClass(project.coverImage)}" ${coverStyle(project.coverImage)}></div><div class="modal-copy"><span class="category">${escapeHtml(project.category)}</span><h2>${escapeHtml(project.title)}</h2><p class="meta">${escapeHtml(project.teamName)} · ${escapeHtml(project.schoolName)} · ${project.year}</p><p>${escapeHtml(project.description)}</p><h3>What we learned</h3><p>${escapeHtml(project.learningStory)}</p><div class="tag-row">${project.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}</div>${project.projectUrl ? `<a class="primary" href="${escapeHtml(project.projectUrl)}" target="_blank" rel="noopener noreferrer">Open project ↗</a>` : ''}</div>`;
    $('#project-dialog').showModal();
  } catch (error) {
    message('#public-message', error.message, true);
  }
}

function showAuth(name) {
  $$('.auth-form').forEach((form) => (form.hidden = form.id !== `${name}-form`));
  $$('[data-auth]').forEach((button) =>
    button.classList.toggle('active', button.dataset.auth === name)
  );
}
async function populateRegistration() {
  const data = await api('/api/registration');
  const options =
    '<option value="">Choose your school</option>' +
    data.schools
      .map((school) => `<option value="${school.id}">${escapeHtml(school.name)}</option>`)
      .join('');
  $('#student-register-form [name=schoolId]').innerHTML = options;
  $('#teacher-create [name=schoolId]').innerHTML =
    '<option value="">Programme administrator</option>' +
    options.replace('<option value="">Choose your school</option>', '');
}
function openSignin(mode = 'student-login') {
  showAuth(mode);
  $('#signin-dialog').showModal();
}

function showDashboardLink(destination, label) {
  const entry = $('#open-signin');
  entry.dataset.destination = destination;
  entry.innerHTML = `${label} <span>→</span>`;
  entry.setAttribute('aria-label', `Return to ${label.toLowerCase()}`);
}

async function restoreSignedInSession() {
  const [staffSession, studentSession] = await Promise.allSettled([
    api('/api/v2/teacher/dashboard'),
    api('/api/v2/student/home')
  ]);
  for (const session of [staffSession, studentSession]) {
    if (session.status === 'rejected' && session.reason.status !== 401) throw session.reason;
  }
  if (staffSession.status === 'fulfilled') {
    state.staff = staffSession.value;
    const isAdmin = !state.staff.user.schoolId;
    showDashboardLink(
      isAdmin ? '/admin' : '/teacher',
      isAdmin ? 'Admin dashboard' : 'Teacher dashboard'
    );
    return true;
  }
  if (studentSession.status === 'fulfilled') {
    state.student = studentSession.value;
    showDashboardLink('/student', 'Dashboard');
    return true;
  }
  return false;
}

function setWorkspace(type) {
  document.body.classList.toggle('workspace-mode', Boolean(type));
  $('#public-header').hidden = Boolean(type);
  $('#public-view').hidden = Boolean(type);
  $('#student-shell').hidden = type !== 'student';
  $('#student-shell').classList.toggle('active', type === 'student');
  $('#staff-shell').hidden = type !== 'staff';
  $('#staff-shell').classList.toggle('active', type === 'staff');
  $('#vote-view').hidden = type !== 'vote';
  $('#results-view').hidden = type !== 'results';
}
function showStudentPanel(name) {
  $$('[id^=student-][id$=-panel]').forEach(
    (panel) => (panel.hidden = panel.id !== `student-${name}-panel`)
  );
  $$('[data-student-panel]').forEach((button) =>
    button.classList.toggle('active', button.dataset.studentPanel === name)
  );
}
function showStaffPanel(name) {
  $$('[id^=staff-][id$=-panel]').forEach(
    (panel) => (panel.hidden = panel.id !== `staff-${name}-panel`)
  );
  $$('[data-staff-panel]').forEach((button) =>
    button.classList.toggle('active', button.dataset.staffPanel === name)
  );
  if (name === 'students') loadStaffStudents();
  if (name === 'admin') loadAdmin();
}

async function loadStudent() {
  try {
    state.student = await api('/api/v2/student/home');
  } catch (error) {
    if (error.status === 401) {
      openSignin('student-login');
      return false;
    }
    throw error;
  }
  setWorkspace('student');
  showStudentPanel('home');
  const { user, team, notifications } = state.student;
  $('#student-name').textContent = user.fullName;
  $('#student-initials').textContent = initials(user.fullName);
  $('#student-greeting').textContent = `Welcome, ${user.fullName.split(' ')[0]}.`;
  const unread = notifications.filter((item) => !item.isRead).length;
  $('#notification-count').hidden = !unread;
  $('#notification-count').textContent = unread;
  $('#no-team').hidden = Boolean(team);
  $('#team-dashboard').hidden = !team;
  if (team) renderTeam(team);
  renderNotifications(notifications);
  fillProjectEditor(team?.project);
  return true;
}
function renderTeam(team) {
  const project = team.project;
  $('#current-project').innerHTML = project
    ? `<div class="project-banner ${coverClass(project.coverImage)}" ${coverStyle(project.coverImage)}><span class="status-pill">${escapeHtml(project.state.replaceAll('_', ' '))}</span></div><div class="current-content"><span class="eyebrow">YOUR TEAM PROJECT</span><h2>${escapeHtml(project.title || 'Untitled project')}</h2><p>${escapeHtml(team.teamName)} · ${team.members.length} member${team.members.length === 1 ? '' : 's'}</p>${project.feedback ? `<div class="feedback-preview"><span>✎</span><div><strong>Teacher feedback</strong><p>${escapeHtml(project.feedback)}</p></div></div>` : ''}<button class="primary" data-student-panel="project">${project.state === 'submitted' ? 'View submission' : 'Continue editing'} →</button>${team.ownerId === state.student.user.id ? '<button class="link-button" id="archive-project">Archive project and team</button>' : ''}</div>`
    : `<div class="current-content"><span class="eyebrow">YOUR TEAM</span><h2>${escapeHtml(team.teamName)}</h2><p>Your team is ready. Create the project draft together.</p><button class="primary" data-student-panel="project">Create project →</button></div>`;
  $('#member-list').innerHTML = team.members
    .map(
      (member) =>
        `<div class="member"><span>${initials(member.fullName)}</span><div><strong>${escapeHtml(member.fullName)}</strong><small>${escapeHtml(member.className)}${member.isOwner ? ' · Owner' : ''}</small></div>${team.ownerId === state.student.user.id && !member.isOwner ? `<button data-transfer-owner="${member.id}" title="Transfer ownership">Owner</button><button data-remove-member="${member.id}" title="Remove member">×</button>` : ''}</div>`
    )
    .join('');
}
function renderNotifications(items) {
  $('#notification-list').innerHTML = items.length
    ? items
        .map(
          (item) =>
            `<div class="notification"><span class="note-icon ${item.kind.includes('published') ? 'teal-bg' : 'coral-bg'}">${item.kind.includes('published') ? '✓' : '✎'}</span><div><strong>${escapeHtml(item.message)}</strong><p>${new Date(item.createdAt).toLocaleString()}</p></div>${item.isRead ? '' : '<i></i>'}</div>`
        )
        .join('')
    : '';
}
function fillProjectEditor(project) {
  const form = $('#project-editor-form');
  form.reset();
  state.coverImage = project?.coverImage || '';
  $('#cover-preview').style.backgroundImage = state.coverImage ? `url('${state.coverImage}')` : '';
  $('#cover-preview').classList.toggle('has-image', Boolean(state.coverImage));
  form.elements.categoryId.innerHTML =
    '<option value="">Choose category</option>' +
    state.student.categories
      .map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`)
      .join('');
  form.elements.year.value = project?.year || new Date().getFullYear();
  for (const name of ['title', 'description', 'learningStory', 'projectUrl'])
    form.elements[name].value = project?.[name] || '';
  form.elements.categoryId.value = project?.categoryId || '';
  form.elements.tags.value = project ? JSON.parse(project.tagsJson || '[]').join(', ') : '';
  $('#project-state').textContent = (project?.state || 'draft').replaceAll('_', ' ');
  $('#project-feedback').hidden = !project?.feedback;
  $('#project-feedback').textContent = project?.feedback
    ? `Teacher feedback: ${project.feedback}`
    : '';
  const locked = project?.state === 'submitted';
  $$('input,select,textarea,button[type=submit]', form).forEach(
    (field) => (field.disabled = locked)
  );
  $('#submit-project').disabled = locked || !project;
}
async function imageData(file) {
  if (!file) return state.coverImage;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5_000_000)
    throw new Error('Choose a JPG, PNG, or WebP image up to 5 MB.');
  let image;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error('The selected image could not be read. Try another JPG, PNG, or WebP file.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d');
  const scale = Math.max(canvas.width / image.width, canvas.height / image.height);
  const width = image.width * scale,
    height = image.height * scale;
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  image.close();
  return canvas.toDataURL('image/webp', 0.86);
}

async function loadStaff() {
  try {
    state.staff = await api('/api/v2/teacher/dashboard');
  } catch (error) {
    if (error.status === 401) {
      openSignin('staff-login');
      return false;
    }
    throw error;
  }
  setWorkspace('staff');
  showStaffPanel('reviews');
  const { user, reviews } = state.staff;
  $('#staff-name').textContent = user.username;
  $('#staff-initials').textContent = initials(user.username);
  $('#staff-school').textContent = user.schoolId ? 'School teacher' : 'Programme admin';
  $('#admin-nav').hidden = Boolean(user.schoolId);
  $('#review-count').textContent = reviews.length;
  $('#review-count').hidden = !reviews.length;
  $('#review-list').innerHTML = reviews.length
    ? reviews
        .map(
          (review) =>
            `<button data-review="${review.revisionId}"><div class="mini-image scene-code"><span>{ }</span></div><div><strong>${escapeHtml(review.title)}</strong><p>${escapeHtml(review.teamName)} · ${escapeHtml(review.schoolName)}</p></div></button>`
        )
        .join('')
    : '<p class="empty-copy">The review queue is clear.</p>';
  return true;
}
async function openReview(revisionId) {
  const revision = await api(`/api/v2/teacher/reviews/${revisionId}`);
  state.review = revision;
  $('#review-preview').classList.remove('empty-copy');
  $('#review-preview').innerHTML =
    `<div class="review-cover ${coverClass(revision.cover_image)}" ${coverStyle(revision.cover_image)}></div><h2>${escapeHtml(revision.title)}</h2><p class="meta">${escapeHtml(revision.teamName)} · ${revision.members.length} students</p><p>${escapeHtml(revision.description)}</p><a class="secondary" href="${escapeHtml(revision.project_url)}" target="_blank" rel="noopener noreferrer">Open project ↗</a><h3>Learning story</h3><p>${escapeHtml(revision.learning_story)}</p>`;
  $('#review-form').hidden = false;
  $('#review-form').elements.feedback.value = revision.feedback || '';
}
async function loadStaffStudents() {
  try {
    const { students } = await api('/api/v2/teacher/students');
    $('#staff-student-list').innerHTML = students
      .map(
        (student) =>
          `<article class="student-record"><span class="note-icon teal-bg">${initials(student.fullName)}</span><div><h3>${escapeHtml(student.fullName)}</h3><p>${escapeHtml(student.className)} · ${escapeHtml(student.username)}${student.teamName ? ` · ${escapeHtml(student.teamName)}` : ''}</p></div><button class="secondary" data-edit-student="${student.id}" data-name="${escapeHtml(student.fullName)}" data-class="${escapeHtml(student.className)}">Edit details</button><button class="secondary" data-reset-student="${student.id}">Reset password</button><button class="secondary" data-disable-student="${student.id}" data-disabled="${student.isDisabled}">${student.isDisabled ? 'Enable' : 'Disable'}</button></article>`
      )
      .join('');
  } catch (error) {
    message('#workspace-message', error.message, true);
  }
}
async function loadAdmin() {
  const [dashboard, categories] = await Promise.all([
    api('/api/v2/admin/dashboard'),
    api('/api/v2/admin/categories')
  ]);
  $('#admin-stats').innerHTML =
    `<article><span class="stat-icon coral-bg">◇</span><div><small>ACTIVE ROUND</small><strong>${escapeHtml(dashboard.activeRound?.name || 'None')}</strong></div></article><article><span class="stat-icon teal-bg">▣</span><div><small>PUBLISHED</small><strong>${dashboard.published}</strong></div></article><article><span class="stat-icon yellow-bg">♙</span><div><small>ACTIVE STUDENTS</small><strong>${dashboard.students}</strong></div></article>`;
  $('#category-list').innerHTML = categories.categories
    .map(
      (category) =>
        `<div class="management-row"><div>${escapeHtml(category.name)}</div><button data-toggle-category="${category.id}" data-active="${category.isActive}">${category.isActive ? 'Archive' : 'Restore'}</button></div>`
    )
    .join('');
  await populateRegistration();
  if (!state.showcase) await loadShowcase();
  $('#round-projects').innerHTML = state.showcase.projects
    .map(
      (project) =>
        `<label><input type="checkbox" name="projectIds" value="${project.id}" />${escapeHtml(project.title)} · ${escapeHtml(project.schoolName)}</label>`
    )
    .join('');
  $('#featured-form [name=projectId]').innerHTML =
    '<option value="">Choose a published project</option>' +
    state.showcase.projects
      .map(
        (project) =>
          `<option value="${project.id}" ${project.isFeatured ? 'selected' : ''}>${escapeHtml(project.title)} · ${escapeHtml(project.schoolName)}</option>`
      )
      .join('');
  $('#teacher-list').innerHTML = dashboard.teachers
    .map(
      (item) =>
        `<div class="management-row"><div><strong>${escapeHtml(item.username)}</strong><small>${escapeHtml(item.schoolName || 'Programme administrator')}</small></div><button data-admin-teacher="${item.id}" data-disabled="${item.isDisabled}">${item.isDisabled ? 'Enable' : 'Disable'}</button><button data-reset-teacher="${item.id}">Reset</button></div>`
    )
    .join('');
  $('#school-list').innerHTML = dashboard.schoolList
    .map(
      (item) =>
        `<div class="management-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.shortName)} · ${item.isActive ? 'Active' : 'Disabled'}</small></div><button data-edit-school="${item.id}" data-name="${escapeHtml(item.name)}" data-short="${escapeHtml(item.shortName)}">Edit</button><button data-toggle-school="${item.id}" data-active="${item.isActive}">${item.isActive ? 'Disable' : 'Enable'}</button></div>`
    )
    .join('');
  $('#round-list').innerHTML = dashboard.rounds
    .map(
      (item) =>
        `<div class="management-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.status)}</small></div>${item.status === 'open' ? `<button data-close-voting="${item.id}">Close</button>` : ''}</div>`
    )
    .join('');
  $('#audit-list').innerHTML = dashboard.audits
    .map(
      (item) =>
        `<div class="management-row"><div><strong>${escapeHtml(item.action)}</strong><small>${escapeHtml(item.actor_type)} · ${new Date(item.created_at).toLocaleString()}</small></div></div>`
    )
    .join('');
}

async function loadBallot() {
  setWorkspace('vote');
  try {
    const data = await api('/api/v2/ballot');
    if (!data.round) {
      $('#vote-round-name').textContent = 'No voting round is open';
      $('#ballot-grid').innerHTML = '';
      $('.sticky-vote').hidden = true;
      return;
    }
    $('#vote-round-name').textContent = data.round.name;
    if (data.vote) {
      $('#ballot-grid').innerHTML =
        '<div class="empty-projects">Thank you. Your final vote has been recorded.</div>';
      $('.sticky-vote').hidden = true;
      return;
    }
    $('#ballot-grid').innerHTML =
      data.projects.map((project) => projectCard(project, true)).join('') ||
      '<div class="empty-projects">No eligible projects are available on your ballot.</div>';
    $('.sticky-vote').hidden = false;
    state.ballot = data;
  } catch (error) {
    if (error.status === 401) openSignin('student-login');
    else message('#ballot-message', error.message, true);
  }
}
function loadResults() {
  setWorkspace('results');
  const round = state.showcase.round;
  $('#results-title').textContent = round?.name || 'No active round';
  $('#results-total').textContent = round?.totalVotes || 0;
  const ranked = [...state.showcase.projects].sort(
    (a, b) => b.votes - a.votes || a.title.localeCompare(b.title)
  );
  let rank = 0,
    lastVotes = null;
  $('#leaderboard').innerHTML =
    ranked
      .map((project, index) => {
        if (project.votes !== lastVotes) rank = index + 1;
        lastVotes = project.votes;
        return `<article class="${rank === 1 ? 'winner' : ''}"><span class="rank">${rank}</span><div class="leader-image ${coverClass(project.coverImage)}" ${coverStyle(project.coverImage)}></div><div><span class="category">${escapeHtml(project.category)}</span><h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(project.teamName)} · ${escapeHtml(project.schoolName)}</p></div><strong>${project.votes}<small> votes</small></strong></article>`;
      })
      .join('') ||
    '<div class="empty-projects">Results will appear when published projects receive votes.</div>';
}

document.addEventListener('click', async (event) => {
  const project = event.target.closest('[data-project]');
  if (project) openProject(project.dataset.project);
  const studentPanel = event.target.closest('[data-student-panel]');
  if (studentPanel) showStudentPanel(studentPanel.dataset.studentPanel);
  const staffPanel = event.target.closest('[data-staff-panel]');
  if (staffPanel) showStaffPanel(staffPanel.dataset.staffPanel);
  const review = event.target.closest('[data-review]');
  if (review) openReview(review.dataset.review);
  const close = event.target.closest('[data-close]');
  if (close) close.closest('dialog').close();
  const reset = event.target.closest('[data-reset-student]');
  if (reset) {
    const password = prompt(
      'Enter a new password with at least 8 characters, one letter and one number:'
    );
    if (password)
      try {
        await api(`/api/students/${reset.dataset.resetStudent}/password`, 'PUT', { password });
        alert('Password reset.');
      } catch (error) {
        alert(error.message);
      }
  }
  const disable = event.target.closest('[data-disable-student]');
  if (disable)
    try {
      await api(`/api/v2/teacher/students/${disable.dataset.disableStudent}`, 'PATCH', {
        disabled: disable.dataset.disabled !== '1'
      });
      await loadStaffStudents();
    } catch (error) {
      alert(error.message);
    }
  const editStudent = event.target.closest('[data-edit-student]');
  if (editStudent) {
    const fullName = prompt('Student full name:', editStudent.dataset.name);
    const className = fullName && prompt('Class:', editStudent.dataset.class);
    if (fullName && className)
      try {
        await api(`/api/v2/teacher/students/${editStudent.dataset.editStudent}`, 'PATCH', {
          fullName,
          className
        });
        await loadStaffStudents();
      } catch (error) {
        alert(error.message);
      }
  }
  const removeMember = event.target.closest('[data-remove-member]');
  if (removeMember && confirm('Remove this student from the active team?')) {
    await api(`/api/v2/teams/members/${removeMember.dataset.removeMember}`, 'DELETE', {});
    await loadStudent();
  }
  const transferOwner = event.target.closest('[data-transfer-owner]');
  if (transferOwner && confirm('Transfer team ownership to this student?')) {
    await api(`/api/v2/teams/members/${transferOwner.dataset.transferOwner}`, 'PUT', {});
    await loadStudent();
  }
  if (
    event.target.closest('#archive-project') &&
    confirm('Archive this project and team? The history and votes will be preserved.')
  ) {
    await api('/api/v2/project/archive', 'POST', {});
    await loadStudent();
  }
  const adminTeacher = event.target.closest('[data-admin-teacher]');
  if (adminTeacher) {
    await api(`/api/v2/admin/teachers/${adminTeacher.dataset.adminTeacher}`, 'PATCH', {
      disabled: adminTeacher.dataset.disabled !== '1'
    });
    await loadAdmin();
  }
  const resetTeacher = event.target.closest('[data-reset-teacher]');
  if (resetTeacher) {
    const password = prompt('New teacher password:');
    if (password) {
      await api(`/api/v2/admin/teachers/${resetTeacher.dataset.resetTeacher}`, 'PATCH', {
        password
      });
      alert('Teacher password reset.');
    }
  }
  const toggleCategory = event.target.closest('[data-toggle-category]');
  if (toggleCategory) {
    await api(`/api/v2/admin/categories/${toggleCategory.dataset.toggleCategory}`, 'PATCH', {
      isActive: toggleCategory.dataset.active !== '1'
    });
    await loadAdmin();
  }
  const editSchool = event.target.closest('[data-edit-school]');
  if (editSchool) {
    const name = prompt('School name:', editSchool.dataset.name);
    const shortName = name && prompt('Short name (up to 8 characters):', editSchool.dataset.short);
    if (
      name &&
      shortName &&
      confirm(`Save the school name as “${name}”? This change will be audited.`)
    ) {
      await api(`/api/v2/admin/schools/${editSchool.dataset.editSchool}`, 'PATCH', {
        name,
        shortName
      });
      await loadAdmin();
    }
  }
  const toggleSchool = event.target.closest('[data-toggle-school]');
  if (toggleSchool && confirm('Change this school’s active status? This action will be audited.')) {
    await api(`/api/v2/admin/schools/${toggleSchool.dataset.toggleSchool}`, 'PATCH', {
      isActive: toggleSchool.dataset.active !== '1'
    });
    await loadAdmin();
  }
  const closeVoting = event.target.closest('[data-close-voting]');
  if (closeVoting && confirm('Close this voting round? No more votes can be submitted.')) {
    await api(`/api/v2/admin/rounds/${closeVoting.dataset.closeVoting}/close`, 'POST', {});
    await loadShowcase();
    await loadAdmin();
  }
});
$('#open-signin').addEventListener('click', () => {
  const destination = $('#open-signin').dataset.destination;
  if (destination) {
    location.href = destination;
    return;
  }
  openSignin();
});
$$('[data-auth]').forEach((button) =>
  button.addEventListener('click', () => showAuth(button.dataset.auth))
);
$('#student-login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submit(event.currentTarget, async () => {
    await api('/api/students/login', 'POST', Object.fromEntries(new FormData(event.currentTarget)));
    $('#signin-dialog').close();
    history.pushState({}, '', '/student');
    await loadStudent();
  });
});
$('#student-register-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submit(event.currentTarget, async () => {
    const input = Object.fromEntries(new FormData(event.currentTarget));
    if (input.password !== input.confirmPassword) throw new Error('Passwords do not match.');
    input.fullNameConfirmed = true;
    delete input.confirmPassword;
    await api('/api/students/register', 'POST', input);
    $('#signin-dialog').close();
    history.pushState({}, '', '/student');
    await loadStudent();
  });
});
$('#staff-login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submit(event.currentTarget, async () => {
    await api('/api/login', 'POST', Object.fromEntries(new FormData(event.currentTarget)));
    $('#signin-dialog').close();
    await loadStaff();
    const isAdmin = !state.staff.user.schoolId;
    history.pushState({}, '', isAdmin ? '/admin' : '/teacher');
    if (isAdmin) showStaffPanel('admin');
  });
});
$('#student-signout').addEventListener('click', async () => {
  await api('/api/students/logout', 'POST', {});
  location.href = '/';
});
$('#staff-signout').addEventListener('click', async () => {
  await api('/api/logout', 'POST', {});
  location.href = '/';
});
$('#create-team').addEventListener('submit', (event) => {
  event.preventDefault();
  submit(event.currentTarget, async () => {
    const result = await api(
      '/api/v2/teams',
      'POST',
      Object.fromEntries(new FormData(event.currentTarget))
    );
    alert(`Team created. Share this private code with teammates: ${result.joinCode}`);
    await loadStudent();
  });
});
$('#join-team').addEventListener('submit', (event) => {
  event.preventDefault();
  submit(event.currentTarget, async () => {
    await api('/api/v2/teams/join', 'POST', Object.fromEntries(new FormData(event.currentTarget)));
    await loadStudent();
  });
});
$('#refresh-code').addEventListener('click', async () => {
  try {
    const result = await api('/api/v2/teams/code', 'POST', {});
    $('#join-code').textContent = result.joinCode;
  } catch (error) {
    $('#join-code').textContent = error.message;
  }
});
$('#project-editor-form [name=cover]').addEventListener('change', async (event) => {
  try {
    state.coverImage = await imageData(event.target.files[0]);
    $('#cover-preview').style.backgroundImage = `url('${state.coverImage}')`;
    $('#cover-preview').classList.add('has-image');
  } catch (error) {
    message('#project-message', error.message, true);
  }
});
$('#project-editor-form').addEventListener('submit', (event) => {
  event.preventDefault();
  clearTimeout(autosaveTimer);
  const form = event.currentTarget;
  submit(form, async () => {
    if (form.elements.cover.files[0]) {
      state.coverImage = await imageData(form.elements.cover.files[0]);
    }
    const values = Object.fromEntries(new FormData(form));
    const result = await api('/api/v2/project/draft', 'PUT', {
      ...values,
      year: Number(values.year),
      tags: values.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      coverImage: state.coverImage
    });
    message('#project-message', 'Draft saved.');
    $('#save-status').textContent = 'Saved just now';
    state.student.team.project = result.project;
    fillProjectEditor(result.project);
  });
});
let autosaveTimer;
for (const eventName of ['input', 'change'])
  $('#project-editor-form').addEventListener(eventName, () => {
    clearTimeout(autosaveTimer);
    const form = $('#project-editor-form');
    if (!form.elements.title.value.trim() || !form.elements.categoryId.value) return;
    $('#save-status').textContent = 'Saving…';
    autosaveTimer = setTimeout(
      () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
      1200
    );
  });
$('#submit-project').addEventListener('click', async () => {
  try {
    await api('/api/v2/project/submit', 'POST', {});
    await loadStudent();
    showStudentPanel('home');
  } catch (error) {
    message('#project-message', error.message, true);
  }
});
$('#mark-read').addEventListener('click', async () => {
  await api('/api/v2/notifications/read', 'POST', {});
  await loadStudent();
  showStudentPanel('notifications');
});
$('#review-form').addEventListener('submit', (event) => {
  event.preventDefault();
  submit(event.currentTarget, async () => {
    const decision = event.submitter.value;
    await api(`/api/v2/teacher/reviews/${state.review.id}`, 'POST', {
      decision,
      feedback: event.currentTarget.elements.feedback.value
    });
    await loadStaff();
  });
});
$('#teacher-create').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  submit(form, async () => {
    await api('/api/v2/admin/teachers', 'POST', Object.fromEntries(new FormData(form)));
    form.reset();
    message($('.form-message', form), 'Teacher account created.');
    await loadAdmin();
  });
});
$('#category-create').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  submit(form, async () => {
    await api('/api/v2/admin/categories', 'POST', Object.fromEntries(new FormData(form)));
    form.reset();
    await loadAdmin();
  });
});
$('#round-create').addEventListener('submit', (event) => {
  event.preventDefault();
  const element = event.currentTarget;
  submit(element, async () => {
    const form = new FormData(element);
    const result = await api('/api/v2/admin/rounds', 'POST', {
      name: form.get('name'),
      projectIds: form.getAll('projectIds'),
      schoolIds: []
    });
    await api(`/api/v2/admin/rounds/${result.id}/open`, 'POST', {});
    message($('.form-message', element), 'Voting round created and opened.');
    await loadAdmin();
  });
});
$('#featured-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  submit(form, async () => {
    await api('/api/v2/admin/featured', 'PUT', Object.fromEntries(new FormData(form)));
    await loadShowcase();
    message($('.form-message', form), 'Homepage feature updated.');
  });
});
$('#ballot-grid').addEventListener('change', (event) => {
  if (event.target.name !== 'projectId') return;
  state.selectedVote = event.target.value;
  const project = state.ballot.projects.find((item) => item.id === state.selectedVote);
  $('#selection-text').innerHTML = `Selected: <strong>${escapeHtml(project.title)}</strong>`;
  $('#review-vote').disabled = false;
});
$('#review-vote').addEventListener('click', () => {
  const project = state.ballot.projects.find((item) => item.id === state.selectedVote);
  $('#confirm-title').textContent = project.title;
  $('#vote-dialog').showModal();
});
$('#confirm-vote').addEventListener('click', async () => {
  try {
    await api('/api/v2/vote', 'POST', {
      roundId: state.ballot.round.id,
      projectId: state.selectedVote
    });
    $('#vote-dialog').close();
    await loadShowcase();
    await loadBallot();
  } catch (error) {
    message('#vote-dialog .form-message', error.message, true);
  }
});
for (const id of ['public-search', 'public-school', 'public-category', 'public-year'])
  $(`#${id}`).addEventListener('input', renderPublicProjects);

const path = location.pathname.replace(/\/$/, '') || '/';
await populateRegistration();
await loadShowcase();
if (!['/student', '/teacher', '/admin'].includes(path)) await restoreSignedInSession();
if (path === '/student') await loadStudent();
else if (path === '/teacher' || path === '/admin') {
  if ((await loadStaff()) && path === '/admin' && !state.staff.user.schoolId)
    showStaffPanel('admin');
} else if (path === '/vote') await loadBallot();
else if (path === '/results') loadResults();
