/* NEXUS workspace: team-scoped tasks, chat, activity, announcements */

function teamStateEnsure() {
  APP_STATE.collab = migrateCollabShape(APP_STATE.collab || createEmptyCollab());
}

function getTeamPrefs() {
  APP_STATE.teamPrefs = APP_STATE.teamPrefs || {};
  return APP_STATE.teamPrefs;
}

function setCurrentTeamId(id) {
  const u = currentUser();
  if (!u) return;
  const prefs = getTeamPrefs();
  prefs[u.id] = id || null;
  APP_STATE.teamPrefs = prefs;
}

function currentTeamId() {
  const u = currentUser();
  if (!u) return null;
  const memberships = userTeamMemberships(u.id).map(m => m.teamId);
  if (!memberships.length) return null;
  const pref = getTeamPrefs()[u.id];
  if (pref && memberships.includes(pref)) return pref;
  setCurrentTeamId(memberships[0]);
  return memberships[0];
}

const Collab = {
  get tasks() {
    teamStateEnsure();
    const tid = currentTeamId();
    return (APP_STATE.collab.teamTasks || []).filter(t => t.teamId === tid);
  },
  set tasks(v) {
    teamStateEnsure();
    const tid = currentTeamId();
    const rest = (APP_STATE.collab.teamTasks || []).filter(t => t.teamId !== tid);
    APP_STATE.collab.teamTasks = rest.concat((Array.isArray(v) ? v : []).map(t => ({ ...t, teamId: tid })));
    APP_STATE.collab.tasks = APP_STATE.collab.teamTasks;
    if (APP_STATE.hydrated) syncStateSoon();
  },
  get chat() {
    teamStateEnsure();
    const tid = currentTeamId();
    return (APP_STATE.collab.teamChats || []).filter(c => c.teamId === tid && (c.channelType || 'group') === 'group');
  },
  set chat(v) {
    teamStateEnsure();
    const tid = currentTeamId();
    const rest = (APP_STATE.collab.teamChats || []).filter(c => !(c.teamId === tid && (c.channelType || 'group') === 'group'));
    APP_STATE.collab.teamChats = rest.concat((Array.isArray(v) ? v : []).map(c => ({ ...c, teamId: tid, channelType: 'group' })));
    APP_STATE.collab.chat = APP_STATE.collab.teamChats;
    if (APP_STATE.hydrated) syncStateSoon();
  },
  get activity() { return (APP_STATE.collab && APP_STATE.collab.activity) || []; },
  set activity(v) {
    APP_STATE.collab.activity = Array.isArray(v) ? v : [];
    if (APP_STATE.hydrated) syncStateSoon();
  },
  get announcements() { return (APP_STATE.collab && APP_STATE.collab.announcements) || []; },
  set announcements(v) {
    APP_STATE.collab.announcements = Array.isArray(v) ? v : [];
    if (APP_STATE.hydrated) syncStateSoon();
  }
};

function teams() {
  teamStateEnsure();
  return APP_STATE.collab.teams || [];
}
function teamRoles() {
  teamStateEnsure();
  return APP_STATE.collab.teamRoles || [];
}
function teamMemberships() {
  teamStateEnsure();
  return APP_STATE.collab.teamMemberships || [];
}
function userTeamMemberships(userId) {
  return teamMemberships().filter(m => m.userId === userId);
}
function canAccessTeam(teamId, userId) {
  const u = getUser(userId);
  if (!u || u.status !== 'active') return false;
  if (normalizeRole(u.role) === 'admin') return true;
  return userTeamMemberships(userId).some(m => m.teamId === teamId);
}
function teamById(id) {
  return teams().find(t => t.id === id);
}
function userTeamRole(teamId, userId) {
  const m = teamMemberships().find(x => x.teamId === teamId && x.userId === userId);
  if (!m) return null;
  return teamRoles().find(r => r.id === m.teamRoleId) || null;
}
function isTeamManager(teamId, userId) {
  const t = teamById(teamId);
  return !!t && t.managerId === userId;
}
function canManageTeam(teamId, userId) {
  const u = getUser(userId);
  if (!u) return false;
  if (normalizeRole(u.role) === 'admin') return true;
  return isTeamManager(teamId, userId);
}

function saveTeams(nextTeams) {
  APP_STATE.collab.teams = nextTeams;
  if (APP_STATE.hydrated) syncStateSoon();
}
function saveTeamRoles(next) {
  APP_STATE.collab.teamRoles = next;
  if (APP_STATE.hydrated) syncStateSoon();
}
function saveTeamMemberships(next) {
  APP_STATE.collab.teamMemberships = next;
  if (APP_STATE.hydrated) syncStateSoon();
}
function saveTeamChats(next) {
  APP_STATE.collab.teamChats = next;
  APP_STATE.collab.chat = next;
  if (APP_STATE.hydrated) syncStateSoon();
}

function logActivity(entry) {
  const list = Collab.activity;
  list.unshift({ id: Date.now() + Math.random(), time: new Date().toISOString(), ...entry });
  Collab.activity = list.slice(0, 200);
}

function assignableUsers(teamId) {
  const members = teamMemberships().filter(m => m.teamId === teamId).map(m => m.userId);
  return DB.users.filter(u => members.includes(u.id) && u.status === 'active');
}

function canSeeTeamTask(task, userId) {
  const u = getUser(userId);
  if (!u || !canAccessTeam(task.teamId, userId)) return false;
  const role = normalizeRole(u.role);
  if (role === 'admin') return true;
  if (isTeamManager(task.teamId, userId)) return true;
  const assignees = task.assignees || [];
  return assignees.includes(userId);
}
function canCommentTask(task, userId) {
  if (!canSeeTeamTask(task, userId)) return false;
  return isTeamManager(task.teamId, userId) || (task.assignees || []).includes(userId);
}
function canEditTeamTaskMeta(task, userId) {
  return canManageTeam(task.teamId, userId);
}

function getTeamTask(id) {
  return (APP_STATE.collab.teamTasks || []).find(t => t.id === id);
}
function saveTeamTasks(arr) {
  const tid = currentTeamId();
  const rest = (APP_STATE.collab.teamTasks || []).filter(t => t.teamId !== tid);
  APP_STATE.collab.teamTasks = rest.concat(arr.map(t => ({ ...t, teamId: tid })));
  APP_STATE.collab.tasks = APP_STATE.collab.teamTasks;
  if (APP_STATE.hydrated) syncStateSoon();
}
function teamDeadlineOverdue(task) {
  if (!task.deadline || task.status === 'done') return false;
  return new Date(task.deadline) < new Date(new Date().toDateString());
}

function escHtml(s) {
  return String(s || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function sanitizeRichHtml(html) {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  d.querySelectorAll('script,iframe,object,embed').forEach(el => el.remove());
  return d.innerHTML;
}

let openTeamTaskId = null;
function openTeamTaskModal(taskId) {
  const task = getTeamTask(taskId);
  const u = currentUser();
  if (!task || !u || !canSeeTeamTask(task, u.id)) return toast('Access denied', 'err');
  openTeamTaskId = taskId;
  const body = document.getElementById('team-task-body');
  if (!body) return;
  const comments = (task.comments || []).slice().sort((a, b) => new Date(a.created) - new Date(b.created));
  body.innerHTML = `
    <div class="team-task-detail">
      <div class="tt-head">
        <h2 class="tt-title">${escHtml(task.title)}</h2>
        <div class="tt-meta-row">
          <span class="badge badge-${task.priority || 'medium'}">${(task.priority || 'medium').toUpperCase()}</span>
          <span class="badge-owner">Team: ${escHtml((teamById(task.teamId) || {}).name || 'Unknown')}</span>
          ${task.deadline ? `<span class="badge-due ${teamDeadlineOverdue(task) ? 'overdue' : ''}">${escHtml(task.deadline)}</span>` : ''}
          <span class="badge-cat">${escHtml(task.status || 'todo')}</span>
        </div>
      </div>
      <div class="tt-desc panel-inner"><div class="section-head">Description</div><div class="wysiwyg-read">${task.descriptionHtml || '<p class="text-muted">No description</p>'}</div></div>
      <div class="tt-comments panel-inner">
        <div class="section-head">Task Discussion</div>
        <div class="text-muted" style="font-size:12px;margin-bottom:8px">Visible to assignees and team manager only.</div>
        <div class="comment-thread">${comments.map(c => `<div class="comment-bubble"><div class="comment-meta">${escHtml((getUser(c.userId) || {}).username || '?')} · ${fmtDateFull(c.created)}</div><div class="wysiwyg-read">${c.html || ''}</div></div>`).join('')}</div>
        ${canCommentTask(task, u.id) ? `<div id="cmt-editor" class="wysiwyg-editor input-field" contenteditable="true" data-placeholder="Ask a question or post an update"></div><button class="btn-sm btn-info mt-8" onclick="wsPostComment('${task.id}')">POST</button>` : ''}
      </div>
      ${canEditTeamTaskMeta(task, u.id) ? `<button class="btn-sm btn-delete mt-16" onclick="wsDeleteTeamTask('${task.id}')">DELETE TASK</button>` : ''}
    </div>`;
  openModal('team-task-modal');
}
function wsPostComment(taskId) {
  const ed = document.getElementById('cmt-editor');
  if (!ed) return;
  const plain = (ed.textContent || '').trim();
  if (!plain) return;
  const u = currentUser();
  const task = getTeamTask(taskId);
  if (!task || !canCommentTask(task, u.id)) return;
  const arr = APP_STATE.collab.teamTasks || [];
  const i = arr.findIndex(t => t.id === taskId);
  if (i < 0) return;
  arr[i].comments = arr[i].comments || [];
  arr[i].comments.push({ id: Date.now() + Math.random(), userId: u.id, html: sanitizeRichHtml(ed.innerHTML), created: new Date().toISOString() });
  APP_STATE.collab.teamTasks = arr;
  APP_STATE.collab.tasks = arr;
  syncStateSoon();
  openTeamTaskModal(taskId);
}
function wsDeleteTeamTask(taskId) {
  const u = currentUser();
  const task = getTeamTask(taskId);
  if (!task || !canEditTeamTaskMeta(task, u.id)) return;
  APP_STATE.collab.teamTasks = (APP_STATE.collab.teamTasks || []).filter(t => t.id !== taskId);
  APP_STATE.collab.tasks = APP_STATE.collab.teamTasks;
  syncStateSoon();
  closeModal('team-task-modal');
  navigate(currentView, currentTab);
}
function wsSetTeamTaskStatus(taskId, status) {
  const u = currentUser();
  const arr = APP_STATE.collab.teamTasks || [];
  const i = arr.findIndex(t => t.id === taskId);
  if (i < 0 || !canEditTeamTaskMeta(arr[i], u.id)) return;
  arr[i].status = status;
  APP_STATE.collab.teamTasks = arr;
  APP_STATE.collab.tasks = arr;
  syncStateSoon();
}
function wsAssigneeSetStatus(taskId, status) {
  const u = currentUser();
  const arr = APP_STATE.collab.teamTasks || [];
  const i = arr.findIndex(t => t.id === taskId);
  if (i < 0 || !canSeeTeamTask(arr[i], u.id)) return;
  arr[i].status = status;
  APP_STATE.collab.teamTasks = arr;
  APP_STATE.collab.tasks = arr;
  syncStateSoon();
}
function wsAddAttachmentToOpenTask() {}

function renderTeamTaskRow(t, openable) {
  const click = openable ? `onclick="openTeamTaskModal('${t.id}')"` : '';
  const assignees = (t.assignees || []).map(id => (getUser(id) || {}).username).filter(Boolean).join(', ');
  return `<div class="task-item team-task-row p-${t.priority || 'medium'}" ${click} style="cursor:pointer"><div class="task-body" style="flex:1"><div class="task-text">${escHtml(t.title)}</div><div class="task-meta"><span class="badge-owner">${escHtml(assignees) || '—'}</span><span class="badge-cat">${escHtml(t.status || 'todo')}</span></div></div></div>`;
}

let wtStagedFiles = [];
function wsStageFilesCreate() {}
function wsCreateTeamTaskWithFiles() {
  const u = currentUser();
  const tid = currentTeamId();
  if (!u || !tid || !canManageTeam(tid, u.id)) return;
  const title = ((document.getElementById('wt-title') || {}).value || '').trim();
  if (!title) return toast('Title required', 'err');
  const assignees = [...document.querySelectorAll('.wt-assign:checked')].map(x => x.value);
  if (!assignees.length) return toast('Select at least one assignee', 'err');
  const task = {
    id: 'wt-' + Date.now(),
    teamId: tid,
    title,
    descriptionHtml: sanitizeRichHtml(((document.getElementById('wt-desc') || {}).innerHTML || '').trim()),
    deadline: ((document.getElementById('wt-deadline') || {}).value || ''),
    priority: ((document.getElementById('wt-priority') || {}).value || 'medium'),
    status: 'todo',
    assignees,
    taggedUserIds: [],
    attachments: [],
    comments: [],
    managerNotes: [],
    createdBy: u.id,
    created: new Date().toISOString()
  };
  const arr = APP_STATE.collab.teamTasks || [];
  arr.unshift(task);
  APP_STATE.collab.teamTasks = arr;
  APP_STATE.collab.tasks = arr;
  syncStateSoon();
  navigate('manager', 'board');
}

function renderTeamSwitcher() {
  const u = currentUser();
  const myTeams = teams().filter(t => canAccessTeam(t.id, u.id));
  const cur = currentTeamId();
  return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><label class="text-muted" style="font-size:11px;letter-spacing:1px">TEAM</label><select class="input-field" style="max-width:260px" onchange="wsSelectTeam(this.value)">${myTeams.map(t => `<option value="${t.id}" ${cur === t.id ? 'selected' : ''}>${escHtml(t.name)}</option>`).join('')}</select></div>`;
}
function wsSelectTeam(teamId) {
  setCurrentTeamId(teamId);
  navigate(currentView, currentTab);
}

function renderManagerAssignForm() {
  const u = currentUser();
  const tid = currentTeamId();
  const people = assignableUsers(tid).filter(x => x.id !== u.id);
  if (!canManageTeam(tid, u.id)) return `<div class="panel"><div class="panel-body"><p class="text-muted">Only the team manager can assign tasks in this team.</p></div></div>`;
  return `${renderTeamSwitcher()}<div class="panel"><div class="panel-head"><h3>Create Team Task</h3></div><div class="panel-body"><input type="text" class="input-field" id="wt-title" placeholder="Task title"/><div id="wt-desc" class="wysiwyg-editor input-field mt-8" contenteditable="true" data-placeholder="Details..."></div><div class="mt-8"><input type="date" class="input-field" id="wt-deadline"/></div><div class="mt-8"><select class="input-field" id="wt-priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select></div><div class="mt-16"><div class="section-head">Assignees</div>${people.map(p => `<label style="display:block"><input type="checkbox" class="wt-assign" value="${p.id}"/> ${escHtml(p.username)}</label>`).join('')}</div><button class="btn-sm btn-info mt-16" onclick="wsCreateTeamTaskWithFiles()">CREATE</button></div></div>`;
}
function renderManagerBoard(u) {
  const tid = currentTeamId();
  const mine = (APP_STATE.collab.teamTasks || []).filter(t => t.teamId === tid && t.createdBy === u.id);
  return `${renderTeamSwitcher()}<div class="panel"><div class="panel-head"><h3>Tasks you assigned (${mine.length})</h3></div><div class="panel-body">${mine.length ? `<div class="task-list-wrap">${mine.map(t => renderTeamTaskRow(t, true)).join('')}</div>` : '<p class="text-muted">No tasks.</p>'}</div></div>`;
}
function renderAssigneeInbox(u) {
  const tid = currentTeamId();
  const list = (APP_STATE.collab.teamTasks || []).filter(t => t.teamId === tid && (t.assignees || []).includes(u.id));
  return `${renderTeamSwitcher()}<div class="panel"><div class="panel-head"><h3>Assigned to you (${list.length})</h3></div><div class="panel-body">${list.length ? `<div class="task-list-wrap">${list.map(t => renderTeamTaskRow(t, true)).join('')}</div>` : '<p class="text-muted">No assignments.</p>'}</div></div>`;
}
function renderLeadPipeline() {
  const u = currentUser();
  const tid = currentTeamId();
  const list = (APP_STATE.collab.teamTasks || []).filter(t => t.teamId === tid && canSeeTeamTask(t, u.id));
  return `${renderTeamSwitcher()}<div class="panel"><div class="panel-head"><h3>Visible work (${list.length})</h3></div><div class="panel-body">${list.length ? `<div class="task-list-wrap">${list.map(t => renderTeamTaskRow(t, true)).join('')}</div>` : '<p class="text-muted">No visible tasks.</p>'}</div></div>`;
}

let activeDmPeer = null;
function wsOpenDm(peerId) { activeDmPeer = peerId; navigate(currentView, 'chat'); }
function renderChatPanel() {
  const u = currentUser();
  const tid = currentTeamId();
  const all = (APP_STATE.collab.teamChats || []).filter(c => c.teamId === tid);
  const group = all.filter(c => (c.channelType || 'group') === 'group').slice(-40);
  const members = assignableUsers(tid).filter(x => x.id !== u.id);
  const dm = activeDmPeer ? all.filter(c => c.channelType === 'dm' && ((c.fromUserId === u.id && c.toUserId === activeDmPeer) || (c.fromUserId === activeDmPeer && c.toUserId === u.id))).slice(-40) : [];
  return `${renderTeamSwitcher()}<div class="panel chat-panel"><div class="panel-head"><h3>Team Group Chat</h3></div><div class="panel-body"><div class="chat-thread">${group.map(m => `<div class="chat-msg"><b>${escHtml((getUser(m.fromUserId)||{}).username||'Unknown')}:</b> ${escHtml(m.text || '')}</div>`).join('')}</div><div class="form-inline mt-8"><input class="input-field" id="chat-input" placeholder="Message group..."/><button class="btn-sm btn-info" onclick="wsSendTeamChat()">SEND</button></div></div></div><div class="panel"><div class="panel-head"><h3>Direct Messages</h3></div><div class="panel-body"><div style="display:flex;gap:8px;flex-wrap:wrap">${members.map(m => `<button class="btn-sm btn-outline" onclick="wsOpenDm('${m.id}')">${escHtml(m.username)}</button>`).join('')}</div>${activeDmPeer ? `<div class="mt-12">${dm.map(m => `<div class="chat-msg">${m.fromUserId === u.id ? 'You' : escHtml((getUser(m.fromUserId)||{}).username||'Unknown')}: ${escHtml(m.text||'')}</div>`).join('')}</div><div class="form-inline mt-8"><input class="input-field" id="chat-dm-input" placeholder="Message ${(getUser(activeDmPeer)||{}).username || ''}..."/><button class="btn-sm btn-purple" onclick="wsSendDm()">SEND DM</button></div>` : '<p class="text-muted mt-8">Select a member to open DM.</p>'}</div></div>`;
}
function wsSendTeamChat() {
  const input = document.getElementById('chat-input');
  const raw = (input ? input.value : '').trim();
  if (!raw) return;
  const u = currentUser();
  const tid = currentTeamId();
  if (!canAccessTeam(tid, u.id)) return;
  const list = APP_STATE.collab.teamChats || [];
  list.push({ id: Date.now() + Math.random(), teamId: tid, channelType: 'group', fromUserId: u.id, text: raw, created: new Date().toISOString() });
  saveTeamChats(list.slice(-500));
  input.value = '';
  navigate(currentView, 'chat');
}
function wsSendDm() {
  const input = document.getElementById('chat-dm-input');
  const raw = (input ? input.value : '').trim();
  const u = currentUser();
  const tid = currentTeamId();
  if (!raw || !activeDmPeer || !canAccessTeam(tid, u.id)) return;
  const list = APP_STATE.collab.teamChats || [];
  list.push({ id: Date.now() + Math.random(), teamId: tid, channelType: 'dm', fromUserId: u.id, toUserId: activeDmPeer, text: raw, created: new Date().toISOString() });
  saveTeamChats(list.slice(-500));
  input.value = '';
  navigate(currentView, 'chat');
}

function renderActivityPanel() {
  const items = Collab.activity.slice(0, 50);
  return `<div class="panel"><div class="panel-head"><h3>Activity</h3></div><div class="panel-body">${items.length ? items.map(a => `<div class="notif-item"><div class="notif-body"><div class="notif-title">${escHtml(a.type || 'event')}</div><div class="notif-msg">${escHtml(a.msg || '')}</div><div class="notif-time">${fmtDateFull(a.time)}</div></div></div>`).join('') : '<p class="text-muted">No activity yet.</p>'}</div></div>`;
}
function renderAnnouncementsPanel(canPost) {
  const rows = Collab.announcements.slice(0, 50);
  return `<div class="panel"><div class="panel-head"><h3>Announcements</h3></div><div class="panel-body">${canPost ? `<div class="form-inline"><input class="input-field" id="ann-input" placeholder="Announcement..."/><button class="btn-sm btn-info" onclick="wsPostAnnouncement()">POST</button></div>` : ''}<div class="mt-12">${rows.length ? rows.map(a => `<div class="notif-item"><div class="notif-body"><div class="notif-title">${escHtml(a.title || 'Update')}</div><div class="notif-msg">${escHtml(a.msg || '')}</div><div class="notif-time">${fmtDateFull(a.created)}</div></div></div>`).join('') : '<p class="text-muted">No announcements.</p>'}</div></div></div>`;
}
function wsPostAnnouncement() {
  const u = currentUser();
  if (!u || !['admin', 'manager'].includes(normalizeRole(u.role))) return;
  const input = document.getElementById('ann-input');
  const raw = (input ? input.value : '').trim();
  if (!raw) return;
  const list = Collab.announcements;
  list.unshift({ id: Date.now() + Math.random(), title: 'Broadcast', msg: raw, created: new Date().toISOString(), userId: u.id });
  Collab.announcements = list.slice(0, 200);
  input.value = '';
  navigate(currentView, currentTab);
}

function renderManagerTeamPanel() {
  const u = currentUser();
  const tid = currentTeamId();
  if (!tid) return `<div class="panel"><div class="panel-body"><p class="text-muted">No team assigned.</p></div></div>`;
  if (!isTeamManager(tid, u.id)) return `<div class="panel"><div class="panel-body"><p class="text-muted">Only the team manager can manage access and roles.</p></div></div>`;
  const members = teamMemberships().filter(m => m.teamId === tid);
  const roles = teamRoles().filter(r => r.teamId === tid);
  const memberRows = members.map(m => {
    const uu = getUser(m.userId);
    if (!uu) return '';
    return `<tr><td>${escHtml(uu.username)}</td><td>${escHtml(uu.email)}</td><td><select class="role-select" onchange="wsSetMemberRole('${m.id}',this.value)">${roles.map(r => `<option value="${r.id}" ${m.teamRoleId === r.id ? 'selected' : ''}>${escHtml(r.name)}</option>`).join('')}</select></td></tr>`;
  }).join('');
  return `${renderTeamSwitcher()}<div class="panel"><div class="panel-head"><h3>Team Roles & Access</h3></div><div class="panel-body"><div class="form-inline"><input class="input-field" id="team-role-name" placeholder="New role name"/><button class="btn-sm btn-info" onclick="wsCreateTeamRole()">CREATE ROLE</button></div><div class="mt-12"><table class="data-table"><thead><tr><th>Member</th><th>Email</th><th>Team Role</th></tr></thead><tbody>${memberRows || '<tr><td colspan="3">No members</td></tr>'}</tbody></table></div><div class="mt-12"><div class="form-inline"><select id="team-add-user" class="input-field">${DB.users.filter(x => x.status === 'active' && x.id !== ADMIN_ID && !members.some(m => m.userId === x.id)).map(x => `<option value="${x.id}">${escHtml(x.username)}</option>`).join('')}</select><select id="team-add-role" class="input-field">${roles.map(r => `<option value="${r.id}">${escHtml(r.name)}</option>`).join('')}</select><button class="btn-sm btn-purple" onclick="wsAddMemberToTeam()">ADD MEMBER</button></div></div></div></div>`;
}
function wsCreateTeamRole() {
  const u = currentUser();
  const tid = currentTeamId();
  if (!isTeamManager(tid, u.id)) return;
  const input = document.getElementById('team-role-name');
  const name = (input ? input.value : '').trim();
  if (!name) return;
  const list = teamRoles();
  list.push({ id: `tr-${Date.now()}`, teamId: tid, name, permissions: ['chat', 'view_tasks', 'comment_tasks'] });
  saveTeamRoles(list);
  input.value = '';
  navigate('manager', 'team');
}
function wsSetMemberRole(membershipId, roleId) {
  const u = currentUser();
  const list = teamMemberships();
  const i = list.findIndex(m => m.id === membershipId);
  if (i < 0 || !isTeamManager(list[i].teamId, u.id)) return;
  list[i].teamRoleId = roleId;
  saveTeamMemberships(list);
}
function wsAddMemberToTeam() {
  const u = currentUser();
  const tid = currentTeamId();
  if (!isTeamManager(tid, u.id)) return;
  const uid = (document.getElementById('team-add-user') || {}).value;
  const roleId = (document.getElementById('team-add-role') || {}).value;
  if (!uid || !roleId) return;
  const list = teamMemberships();
  if (list.some(m => m.teamId === tid && m.userId === uid)) return;
  list.push({ id: `${tid}:${uid}:${Date.now()}`, teamId: tid, userId: uid, teamRoleId: roleId, created: new Date().toISOString() });
  saveTeamMemberships(list);
  navigate('manager', 'team');
}

function renderAdminTeamsHub() {
  const u = currentUser();
  if (!u || normalizeRole(u.role) !== 'admin') return '';
  const rows = teams().map(t => `<tr><td>${escHtml(t.name)}</td><td>${escHtml(t.department || '—')}</td><td>${escHtml((getUser(t.managerId) || {}).username || 'Unassigned')}</td><td><select class="role-select" onchange="wsSetTeamManager('${t.id}',this.value)"><option value="">Unassigned</option>${DB.users.filter(x => normalizeRole(x.role) === 'manager' && x.status === 'active').map(m => `<option value="${m.id}" ${t.managerId === m.id ? 'selected' : ''}>${escHtml(m.username)}</option>`).join('')}</select></td></tr>`).join('');
  return `<div class="panel"><div class="panel-head"><h3>Teams</h3></div><div class="panel-body"><div class="form-inline"><input id="new-team-name" class="input-field" placeholder="Team name"/><input id="new-team-dept" class="input-field" placeholder="Department (optional)"/><select id="new-team-manager" class="input-field"><option value="">Select manager</option>${DB.users.filter(x => normalizeRole(x.role) === 'manager' && x.status === 'active').map(m => `<option value="${m.id}">${escHtml(m.username)}</option>`).join('')}</select><button class="btn-sm btn-info" onclick="wsCreateTeam()">CREATE TEAM</button></div><div class="mt-12"><table class="data-table"><thead><tr><th>Team</th><th>Department</th><th>Owner</th><th>Set Manager</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No teams</td></tr>'}</tbody></table></div></div></div>`;
}
function wsCreateTeam() {
  const name = ((document.getElementById('new-team-name') || {}).value || '').trim();
  const dept = ((document.getElementById('new-team-dept') || {}).value || '').trim();
  const managerId = ((document.getElementById('new-team-manager') || {}).value || '') || null;
  if (!name) return toast('Team name required', 'err');
  const teamId = `team-${Date.now()}`;
  const ts = teams();
  ts.push({ id: teamId, name, department: dept, managerId, created: new Date().toISOString() });
  saveTeams(ts);
  const roles = teamRoles();
  roles.push({ id: `tr-${teamId}-manager`, teamId, name: 'Manager', permissions: ['manage_members', 'manage_roles', 'manage_tasks', 'chat'] });
  roles.push({ id: `tr-${teamId}-member`, teamId, name: 'Member', permissions: ['chat', 'view_tasks', 'comment_tasks'] });
  saveTeamRoles(roles);
  const mem = teamMemberships();
  DB.users.filter(u => u.status === 'active' && u.id !== ADMIN_ID).forEach(u => {
    if (!mem.some(m => m.teamId === teamId && m.userId === u.id)) {
      mem.push({ id: `${teamId}:${u.id}`, teamId, userId: u.id, teamRoleId: u.id === managerId ? `tr-${teamId}-manager` : `tr-${teamId}-member`, created: new Date().toISOString() });
    }
  });
  saveTeamMemberships(mem);
  navigate('admin', 'teams');
}
function wsSetTeamManager(teamId, managerId) {
  const ts = teams();
  const i = ts.findIndex(t => t.id === teamId);
  if (i < 0) return;
  ts[i].managerId = managerId || null;
  saveTeams(ts);
}

function workspaceShellConfig(view) {
  const u = currentUser();
  const unread = unreadCount(u.id);
  const initials = u.username.slice(0, 2).toUpperCase();
  const roleLabel = normalizeRole(u.role).replace('_', ' ').toUpperCase();
  if (view === 'manager') {
    return {
      tabs: [
        { id: 'assign', icon: '+', label: 'Assign' },
        { id: 'board', icon: '▸', label: 'My board' },
        { id: 'team', icon: '⚑', label: 'Team access' },
        { id: 'chat', icon: '💬', label: 'Chat' },
        { id: 'activity', icon: '◈', label: 'Activity' },
        { id: 'announce', icon: '📣', label: 'Broadcast' },
        { id: 'notifs', icon: '📡', label: 'Notifications' },
        { id: 'profile', icon: '⬡', label: 'Profile' }
      ],
      unread, initials, roleLabel, brand: 'MANAGER OPS'
    };
  }
  if (view === 'teamlead') {
    return { tabs: [{ id: 'inbox', icon: '▸', label: 'My work' }, { id: 'pipeline', icon: '◈', label: 'Pipeline' }, { id: 'chat', icon: '💬', label: 'Chat' }, { id: 'activity', icon: '◈', label: 'Activity' }, { id: 'announce', icon: '📣', label: 'News' }, { id: 'notifs', icon: '📡', label: 'Notifications' }, { id: 'profile', icon: '⬡', label: 'Profile' }], unread, initials, roleLabel, brand: 'TEAM LEAD' };
  }
  return { tabs: [{ id: 'inbox', icon: '▸', label: 'My work' }, { id: 'chat', icon: '💬', label: 'Chat' }, { id: 'activity', icon: '◈', label: 'Activity' }, { id: 'announce', icon: '📣', label: 'News' }, { id: 'notifs', icon: '📡', label: 'Notifications' }, { id: 'profile', icon: '⬡', label: 'Profile' }], unread, initials, roleLabel, brand: 'EMPLOYEE' };
}

function renderWorkspaceShell(view) {
  const u = currentUser();
  const cfg = workspaceShellConfig(view);
  const sidebarItems = cfg.tabs.map(t => {
    const nb = t.id === 'notifs' && cfg.unread ? `<span class="nav-badge">${cfg.unread}</span>` : '';
    return `<div class="nav-item ${currentTab === t.id ? 'active' : ''}" onclick="navigate('${view}','${t.id}')"><span class="nav-icon">${t.icon}</span>${t.label}${nb}</div>`;
  }).join('');
  let tabContent = '';
  if (view === 'manager') {
    if (currentTab === 'assign') tabContent = renderManagerAssignForm();
    else if (currentTab === 'board') tabContent = renderManagerBoard(u);
    else if (currentTab === 'team') tabContent = renderManagerTeamPanel();
    else if (currentTab === 'chat') tabContent = renderChatPanel();
    else if (currentTab === 'activity') tabContent = renderActivityPanel();
    else if (currentTab === 'announce') tabContent = renderAnnouncementsPanel(true);
    else if (currentTab === 'notifs') tabContent = renderUserNotifs(u);
    else if (currentTab === 'profile') tabContent = renderUserProfile(u);
  } else if (view === 'teamlead') {
    if (currentTab === 'inbox') tabContent = renderAssigneeInbox(u);
    else if (currentTab === 'pipeline') tabContent = renderLeadPipeline();
    else if (currentTab === 'chat') tabContent = renderChatPanel();
    else if (currentTab === 'activity') tabContent = renderActivityPanel();
    else if (currentTab === 'announce') tabContent = renderAnnouncementsPanel(false);
    else if (currentTab === 'notifs') tabContent = renderUserNotifs(u);
    else if (currentTab === 'profile') tabContent = renderUserProfile(u);
  } else {
    if (currentTab === 'inbox') tabContent = renderAssigneeInbox(u);
    else if (currentTab === 'chat') tabContent = renderChatPanel();
    else if (currentTab === 'activity') tabContent = renderActivityPanel();
    else if (currentTab === 'announce') tabContent = renderAnnouncementsPanel(false);
    else if (currentTab === 'notifs') tabContent = renderUserNotifs(u);
    else if (currentTab === 'profile') tabContent = renderUserProfile(u);
  }
  return `<div class="dashboard"><aside class="sidebar"><div class="sidebar-logo"><span class="logo-tag">NEXUS WORKSPACE</span><div class="logo-name">NEXUS</div><div class="logo-role">${cfg.brand}</div></div><nav class="sidebar-nav"><div class="nav-section-label">WORK</div>${sidebarItems}</nav><div class="sidebar-footer"><div class="user-chip"><div class="user-avatar">${cfg.initials}</div><div class="user-info"><div class="user-name">${escHtml(u.username)}</div><div class="user-role">${cfg.roleLabel}</div></div></div></div></aside><div class="main-content"><div class="topbar"><div class="topbar-title">NEXUS / <span>${currentTab.toUpperCase()}</span></div><div class="notif-btn" onclick="navigate('${view}','notifs')">📡${cfg.unread ? `<span class="notif-count">${cfg.unread}</span>` : ''}</div><button class="logout-btn" onclick="doLogout()">LOGOUT</button></div><div class="page-content">${tabContent}</div></div></div>`;
}

if (!window.__NEXUS_BOOTSTRAPPED__ && typeof initApp === 'function') {
  window.__NEXUS_BOOTSTRAPPED__ = true;
  initApp();
}
