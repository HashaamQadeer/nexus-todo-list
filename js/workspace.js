/* NEXUS workspace: team tasks, chat, activity, announcements — requires globals from app.js */

const Collab = {
  get tasks() { return JSON.parse(localStorage.getItem('nx2_team_tasks') || '[]'); },
  set tasks(v) { localStorage.setItem('nx2_team_tasks', JSON.stringify(v)); },
  get chat() { return JSON.parse(localStorage.getItem('nx2_team_chat') || '[]'); },
  set chat(v) { localStorage.setItem('nx2_team_chat', JSON.stringify(v)); },
  get activity() { return JSON.parse(localStorage.getItem('nx2_activity') || '[]'); },
  set activity(v) { localStorage.setItem('nx2_activity', JSON.stringify(v)); },
  get announcements() { return JSON.parse(localStorage.getItem('nx2_announcements') || '[]'); },
  set announcements(v) { localStorage.setItem('nx2_announcements', JSON.stringify(v)); }
};

function normalizeRole(role) {
  if (role === 'user' || role === 'moderator') return 'employee';
  return role;
}

function sanitizeRichHtml(html) {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  d.querySelectorAll('*').forEach(el => {
    const tag = el.tagName.toLowerCase();
    const allowed = ['b', 'i', 'u', 'strong', 'em', 'br', 'p', 'ul', 'ol', 'li', 'span', 'a', 'div'];
    if (!allowed.includes(tag)) {
      el.replaceWith(...el.childNodes);
      return;
    }
    [...el.attributes].forEach(a => {
      if (tag === 'a' && a.name === 'href') {
        const v = a.value.trim();
        if (!/^https?:\/\//i.test(v)) el.removeAttribute('href');
      } else el.removeAttribute(a.name);
    });
  });
  d.querySelectorAll('script,iframe,object,embed').forEach(el => el.remove());
  return d.innerHTML;
}

function logActivity(entry) {
  const list = Collab.activity;
  list.unshift({
    id: Date.now() + Math.random(),
    time: new Date().toISOString(),
    ...entry
  });
  Collab.activity = list.slice(0, 200);
}

function assignableUsers() {
  return DB.users.filter(
    u => u.id !== ADMIN_ID && u.status === 'active' && (u.role === 'employee' || u.role === 'team_lead')
  );
}

function canSeeTeamTask(task, userId) {
  const u = getUser(userId);
  if (!u || u.status !== 'active') return false;
  const role = normalizeRole(u.role);
  if (role === 'admin') return true;
  const assignees = task.assignees || [];
  const tagged = task.taggedUserIds || [];
  if (assignees.includes(userId) || tagged.includes(userId)) return true;
  if (role === 'manager' && task.createdBy === userId) return true;
  return false;
}

function canEditTeamTaskMeta(task, userId) {
  const u = getUser(userId);
  if (!u) return false;
  if (normalizeRole(u.role) === 'admin') return true;
  return normalizeRole(u.role) === 'manager' && task.createdBy === userId;
}

function getTeamTask(id) {
  return Collab.tasks.find(t => t.id === id);
}

function saveTeamTasks(arr) {
  Collab.tasks = arr;
}

function teamDeadlineOverdue(task) {
  if (!task.deadline || task.status === 'done') return false;
  return new Date(task.deadline) < new Date(new Date().toDateString());
}

function parseMentions(html) {
  const d = document.createElement('div');
  d.innerHTML = html;
  const text = d.textContent || '';
  const names = [];
  const re = /@([\w.-]+)/g;
  let m;
  while ((m = re.exec(text))) names.push(m[1].toLowerCase());
  return [...new Set(names)];
}

function notifyMentionedUsers(html, contextTitle, fromUserId) {
  const from = getUser(fromUserId);
  const names = parseMentions(html);
  names.forEach(n => {
    const u = DB.users.find(x => x.username.toLowerCase() === n);
    if (u && u.id !== fromUserId) {
      pushNotif(u.id, {
        icon: '✦',
        title: 'You were mentioned',
        msg: `${from ? from.username : 'Someone'} mentioned you in: ${contextTitle}`
      });
    }
  });
}

let openTeamTaskId = null;

function openTeamTaskModal(taskId) {
  const task = getTeamTask(taskId);
  const u = currentUser();
  if (!task || !u || !canSeeTeamTask(task, u.id)) {
    toast('Access denied', 'err');
    return;
  }
  openTeamTaskId = taskId;
  const body = document.getElementById('team-task-body');
  if (!body) return;
  const names = id =>
    (id || [])
      .map(uid => getUser(uid))
      .filter(Boolean)
      .map(x => x.username)
      .join(', ');
  const isManagerView = canEditTeamTaskMeta(task, u.id);
  const canComment = canSeeTeamTask(task, u.id);
  const comments = (task.comments || [])
    .slice()
    .sort((a, b) => new Date(a.created) - new Date(b.created));
  const notes = task.managerNotes || [];

  body.innerHTML = `
    <div class="team-task-detail">
      <div class="tt-head">
        <h2 class="tt-title">${escHtml(task.title)}</h2>
        <div class="tt-meta-row">
          <span class="badge badge-${task.priority || 'medium'}">${(task.priority || 'medium').toUpperCase()}</span>
          <span class="badge-owner">By @${escHtml((getUser(task.createdBy) || {}).username || 'unknown')}</span>
          ${task.deadline ? `<span class="badge-due ${teamDeadlineOverdue(task) ? 'overdue' : ''}">${teamDeadlineOverdue(task) ? '⚠ ' : ''}${escHtml(task.deadline)}</span>` : ''}
          <span class="badge-cat">${escHtml(task.status || 'todo')}</span>
        </div>
        <div class="tt-assignees"><strong>Assignees:</strong> ${escHtml(names(task.assignees)) || '—'}</div>
        ${(task.taggedUserIds || []).length ? `<div class="tt-tags"><strong>Tagged:</strong> ${escHtml(names(task.taggedUserIds))}</div>` : ''}
      </div>
      <div class="tt-desc panel-inner">
        <div class="section-head">Description</div>
        <div class="wysiwyg-read">${task.descriptionHtml || '<p class="text-muted">No description</p>'}</div>
      </div>
      <div class="tt-attachments panel-inner">
        <div class="section-head">Attachments</div>
        ${(task.attachments || []).length ? (task.attachments || []).map(a => `
          <div class="attach-row">
            <a href="${escHtml(a.dataUrl)}" download="${escHtml(a.name)}" class="text-cyan">${escHtml(a.name)}</a>
            <span class="text-muted">${escHtml(a.mime || '')}</span>
          </div>`).join('') : '<p class="text-muted">No files</p>'}
        ${isManagerView ? `
        <div class="mt-12">
          <input type="file" id="tt-add-file" class="input-field" multiple onchange="wsAddAttachmentToOpenTask(event)"/>
        </div>` : ''}
      </div>
      ${isManagerView ? `
      <div class="tt-status panel-inner">
        <label class="text-muted font-mono" style="font-size:9px;letter-spacing:2px">WORKFLOW STATUS</label>
        <select class="input-field mt-8" style="max-width:220px" onchange="wsSetTeamTaskStatus('${task.id}',this.value)">
          ${['todo', 'in_progress', 'review', 'done'].map(s => `<option value="${s}" ${(task.status || 'todo') === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
        </select>
      </div>` : `
      <div class="tt-status panel-inner">
        <label class="text-muted font-mono" style="font-size:9px;letter-spacing:2px">UPDATE YOUR STATUS</label>
        <select class="input-field mt-8" style="max-width:220px" onchange="wsAssigneeSetStatus('${task.id}',this.value)">
          ${['todo', 'in_progress', 'review', 'done'].map(s => `<option value="${s}" ${(task.status || 'todo') === s ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
        </select>
      </div>`}
      <div class="tt-comments panel-inner">
        <div class="section-head">Discussion</div>
        <div class="comment-thread">${comments.map(c => {
    const author = getUser(c.userId);
    return `<div class="comment-bubble">
            <div class="comment-meta">${escHtml(author ? author.username : '?')} · ${fmtDateFull(c.created)}</div>
            <div class="wysiwyg-read">${c.html || escHtml(c.textPlain || '')}</div>
          </div>`;
  }).join('')}</div>
        ${canComment ? `
        <div class="wysiwyg-toolbar" id="cmt-toolbar">
          <button type="button" class="tb-btn" onclick="wsExec('bold')"><b>B</b></button>
          <button type="button" class="tb-btn" onclick="wsExec('italic')"><i>I</i></button>
          <button type="button" class="tb-btn" onclick="wsExec('underline')"><u>U</u></button>
          <button type="button" class="tb-btn" onclick="wsExec('insertUnorderedList')">•</button>
        </div>
        <div id="cmt-editor" class="wysiwyg-editor input-field" contenteditable="true" data-placeholder="Comment… use @username to mention"></div>
        <button class="btn-sm btn-info mt-8" onclick="wsPostComment('${task.id}')">POST COMMENT</button>` : ''}
      </div>
      ${isManagerView ? `
      <div class="tt-notes panel-inner">
        <div class="section-head">Manager notes <span class="text-muted" style="font-weight:400">(private to managers & creator)</span></div>
        <div class="comment-thread">${notes.map(n => {
    const author = getUser(n.userId);
    return `<div class="comment-bubble note-bubble">
            <div class="comment-meta">${escHtml(author ? author.username : '?')} · ${fmtDateFull(n.created)}</div>
            <div class="wysiwyg-read">${n.html || ''}</div>
          </div>`;
  }).join('')}</div>
        <div class="wysiwyg-toolbar">
          <button type="button" class="tb-btn" onclick="wsExecNote('bold')"><b>B</b></button>
          <button type="button" class="tb-btn" onclick="wsExecNote('italic')"><i>I</i></button>
          <button type="button" class="tb-btn" onclick="wsExecNote('underline')"><u>U</u></button>
        </div>
        <div id="note-editor" class="wysiwyg-editor input-field" contenteditable="true" data-placeholder="Private note…"></div>
        <button class="btn-sm btn-purple mt-8" onclick="wsPostManagerNote('${task.id}')">ADD NOTE</button>
      </div>` : ''}
      ${isManagerView ? `<button class="btn-sm btn-delete mt-16" onclick="wsDeleteTeamTask('${task.id}')">DELETE TASK</button>` : ''}
    </div>`;
  openModal('team-task-modal');
}

function wsExec(cmd) {
  const el = document.getElementById('cmt-editor');
  if (el) {
    el.focus();
    document.execCommand(cmd, false, null);
  }
}
function wsExecNote(cmd) {
  const el = document.getElementById('note-editor');
  if (el) {
    el.focus();
    document.execCommand(cmd, false, null);
  }
}

function wsPostComment(taskId) {
  const ed = document.getElementById('cmt-editor');
  if (!ed) return;
  const raw = ed.innerHTML.trim();
  const plain = ed.textContent.trim();
  if (!plain) return;
  const html = sanitizeRichHtml(raw);
  const u = currentUser();
  const task = getTeamTask(taskId);
  if (!task || !canSeeTeamTask(task, u.id)) return;
  const c = {
    id: Date.now() + Math.random(),
    userId: u.id,
    html,
    textPlain: plain,
    created: new Date().toISOString()
  };
  const arr = Collab.tasks;
  const i = arr.findIndex(t => t.id === taskId);
  if (i < 0) return;
  arr[i].comments = arr[i].comments || [];
  arr[i].comments.push(c);
  saveTeamTasks(arr);
  logActivity({ type: 'comment', userId: u.id, msg: `${u.username} commented on "${task.title}"`, taskId });
  notifyMentionedUsers(html, task.title, u.id);
  (task.assignees || []).concat(task.taggedUserIds || []).forEach(uid => {
    if (uid !== u.id) {
      pushNotif(uid, { icon: '💬', title: 'New comment', msg: `${u.username} on: ${task.title}` });
    }
  });
  toast('Comment posted');
  openTeamTaskModal(taskId);
}

function wsPostManagerNote(taskId) {
  const ed = document.getElementById('note-editor');
  if (!ed) return;
  const raw = ed.innerHTML.trim();
  if (!ed.textContent.trim()) return;
  const html = sanitizeRichHtml(raw);
  const u = currentUser();
  const task = getTeamTask(taskId);
  if (!task || !canEditTeamTaskMeta(task, u.id)) return;
  const arr = Collab.tasks;
  const i = arr.findIndex(t => t.id === taskId);
  if (i < 0) return;
  arr[i].managerNotes = arr[i].managerNotes || [];
  arr[i].managerNotes.push({
    id: Date.now() + Math.random(),
    userId: u.id,
    html,
    created: new Date().toISOString()
  });
  saveTeamTasks(arr);
  logActivity({ type: 'note', userId: u.id, msg: `${u.username} added a manager note on "${task.title}"`, taskId });
  toast('Note saved');
  openTeamTaskModal(taskId);
}

function wsSetTeamTaskStatus(taskId, status) {
  const u = currentUser();
  const task = getTeamTask(taskId);
  if (!task || !canEditTeamTaskMeta(task, u.id)) return;
  const arr = Collab.tasks;
  const i = arr.findIndex(t => t.id === taskId);
  if (i < 0) return;
  arr[i].status = status;
  saveTeamTasks(arr);
  logActivity({ type: 'status', userId: u.id, msg: `Status → ${status} on "${task.title}"`, taskId });
  (task.assignees || []).forEach(uid => {
    if (uid !== u.id) {
      pushNotif(uid, { icon: '◈', title: 'Task updated', msg: `"${task.title}" is now: ${status}` });
    }
  });
  toast('Status updated');
  openTeamTaskModal(taskId);
}

function wsAssigneeSetStatus(taskId, status) {
  const u = currentUser();
  const task = getTeamTask(taskId);
  if (!task || !canSeeTeamTask(task, u.id)) return;
  const arr = Collab.tasks;
  const i = arr.findIndex(t => t.id === taskId);
  if (i < 0) return;
  arr[i].status = status;
  saveTeamTasks(arr);
  const mgr = getUser(task.createdBy);
  if (mgr && mgr.id !== u.id) {
    pushNotif(mgr.id, { icon: '◈', title: 'Assignee progress', msg: `${u.username} set "${task.title}" to ${status}` });
  }
  logActivity({ type: 'status', userId: u.id, msg: `${u.username} → ${status} on "${task.title}"`, taskId });
  toast('Status saved');
  openTeamTaskModal(taskId);
}

function wsDeleteTeamTask(taskId) {
  if (!confirm('Delete this task for everyone?')) return;
  const u = currentUser();
  const task = getTeamTask(taskId);
  if (!task || !canEditTeamTaskMeta(task, u.id)) return;
  saveTeamTasks(Collab.tasks.filter(t => t.id !== taskId));
  closeModal('team-task-modal');
  logActivity({ type: 'delete', userId: u.id, msg: `Deleted task "${task.title}"` });
  toast('Task deleted');
  navigate(currentView, currentTab);
}

function wsAddAttachmentToOpenTask(ev) {
  const files = ev.target.files;
  if (!files || !files.length || !openTeamTaskId) return;
  const task = getTeamTask(openTeamTaskId);
  const u = currentUser();
  if (!task || !canEditTeamTaskMeta(task, u.id)) return;
  const maxBytes = 400 * 1024;
  let arr = Collab.tasks;
  const ti = arr.findIndex(t => t.id === openTeamTaskId);
  if (ti < 0) return;
  arr[ti].attachments = arr[ti].attachments || [];
  let n = 0;
  const readOne = file => {
    if (file.size > maxBytes) {
      toast(`Skipped ${file.name} (max 400KB)`, 'err');
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      arr[ti].attachments.push({
        id: Date.now() + Math.random(),
        name: file.name,
        mime: file.type,
        dataUrl: fr.result
      });
      n++;
      if (n === files.length) {
        saveTeamTasks(arr);
        logActivity({ type: 'file', userId: u.id, msg: `Attached files to "${task.title}"` });
        toast('Attachments added');
        openTeamTaskModal(openTeamTaskId);
      }
    };
    fr.readAsDataURL(file);
  };
  [...files].forEach(readOne);
  ev.target.value = '';
}

function wsPostChat() {
  const inp = document.getElementById('chat-input');
  if (!inp) return;
  const raw = inp.value.trim();
  if (!raw) return;
  const u = currentUser();
  const list = Collab.chat;
  list.push({
    id: Date.now() + Math.random(),
    userId: u.id,
    text: raw,
    time: new Date().toISOString()
  });
  Collab.chat = list.slice(-300);
  notifyMentionedUsers('<p>' + escHtml(raw) + '</p>', 'Team chat', u.id);
  logActivity({ type: 'chat', userId: u.id, msg: `${u.username} in #general` });
  inp.value = '';
  navigate(currentView, 'chat');
}

function wsPostAnnouncement() {
  const u = currentUser();
  const role = normalizeRole(u.role);
  if (role !== 'manager' && role !== 'admin') {
    toast('Not allowed', 'err');
    return;
  }
  const title = (document.getElementById('an-title') || {}).value.trim();
  const body = (document.getElementById('an-body') || {}).value.trim();
  if (!title || !body) {
    toast('Title and body required', 'err');
    return;
  }
  const list = Collab.announcements;
  list.unshift({
    id: Date.now() + Math.random(),
    userId: u.id,
    title,
    body,
    time: new Date().toISOString()
  });
  Collab.announcements = list.slice(0, 50);
  DB.users.forEach(x => {
    if (x.id !== u.id && x.status === 'active' && x.id !== ADMIN_ID && x.role !== 'admin') {
      pushNotif(x.id, { icon: '📣', title: 'Announcement', msg: title });
    }
  });
  logActivity({ type: 'announce', userId: u.id, msg: `Announcement: ${title}` });
  toast('Broadcast sent');
  navigate(currentView, 'announce');
}

function renderChatPanel() {
  const rows = Collab.chat.slice(-80);
  return `
<div class="panel chat-panel">
  <div class="panel-head"><h3>#general — Team chat</h3></div>
  <div class="panel-body chat-scroll" id="chat-scroll">${rows.length ? rows.map(m => {
    const author = getUser(m.userId);
    return `<div class="chat-line"><span class="chat-user">${escHtml(author ? author.username : '?')}</span><span class="chat-time">${fmtDateFull(m.time)}</span><div class="chat-text">${escHtml(m.text)}</div></div>`;
  }).join('') : '<p class="text-muted">No messages yet. Say hello!</p>'}</div>
  <div class="chat-compose">
    <input class="input-field grow" type="text" id="chat-input" placeholder="Message… @mention someone" onkeydown="if(event.key==='Enter')wsPostChat()"/>
    <button class="btn-sm btn-info" onclick="wsPostChat()">SEND</button>
  </div>
</div>`;
}

function renderActivityPanel() {
  const rows = Collab.activity.slice(0, 40);
  return `
<div class="panel">
  <div class="panel-head"><h3>Activity feed</h3></div>
  <div class="panel-body">${rows.length ? `<div class="activity-list">${rows.map(a => `<div class="activity-row"><span class="act-time">${fmtDateFull(a.time)}</span><div>${escHtml(a.msg || '')}</div></div>`).join('')}</div>` : '<p class="text-muted">No activity yet.</p>'}</div>
</div>`;
}

function renderAnnouncementsPanel(canPost) {
  const rows = Collab.announcements;
  return `
${canPost ? `
<div class="panel">
  <div class="panel-head"><h3>Post announcement</h3></div>
  <div class="panel-body">
    <input class="input-field w-full mb-16" type="text" id="an-title" placeholder="Headline…"/>
    <textarea class="input-field w-full" id="an-body" rows="3" placeholder="Message to all active members…"></textarea>
    <button class="btn-sm btn-info mt-8" onclick="wsPostAnnouncement()">PUBLISH</button>
  </div>
</div>` : ''}
<div class="panel">
  <div class="panel-head"><h3>Announcements</h3></div>
  <div class="panel-body">${rows.length ? rows.map(a => {
    const author = getUser(a.userId);
    return `<div class="announce-card"><div class="announce-title">${escHtml(a.title)}</div><div class="announce-meta">${escHtml(author ? author.username : '?')} · ${fmtDateFull(a.time)}</div><div class="announce-body">${escHtml(a.body)}</div></div>`;
  }).join('') : '<p class="text-muted">No announcements.</p>'}</div>
</div>`;
}

function renderManagerAssignForm() {
  const people = assignableUsers();
  const chk = (name, cls) =>
    people
      .map(
        p => `
    <label class="chk-label"><input type="checkbox" class="${cls}" value="${p.id}"/> ${escHtml(p.username)} <span class="text-muted">(${p.role})</span></label>`
      )
      .join('');
  return `
<div class="panel">
  <div class="panel-head"><h3>Assign team task</h3></div>
  <div class="panel-body">
    <label class="text-muted font-mono" style="font-size:9px;letter-spacing:2px">TITLE</label>
    <input class="input-field w-full mb-16" type="text" id="wt-title" placeholder="Objective…"/>
    <label class="text-muted font-mono" style="font-size:9px;letter-spacing:2px">DESCRIPTION (WYSIWYG)</label>
    <div class="wysiwyg-toolbar mb-8">
      <button type="button" class="tb-btn" onclick="wsExecDesc('bold')"><b>B</b></button>
      <button type="button" class="tb-btn" onclick="wsExecDesc('italic')"><i>I</i></button>
      <button type="button" class="tb-btn" onclick="wsExecDesc('underline')"><u>U</u></button>
      <button type="button" class="tb-btn" onclick="wsExecDesc('insertUnorderedList')">•</button>
    </div>
    <div id="wt-desc" class="wysiwyg-editor input-field" contenteditable="true" data-placeholder="Details, links, checklist…"></div>
    <div class="form-inline mt-16">
      <div>
        <label class="text-muted font-mono" style="font-size:9px;letter-spacing:2px">DEADLINE</label>
        <input type="date" class="input-field" id="wt-deadline"/>
      </div>
      <div>
        <label class="text-muted font-mono" style="font-size:9px;letter-spacing:2px">PRIORITY</label>
        <select class="input-field" id="wt-priority">
          <option value="low">Low</option>
          <option value="medium" selected>Medium</option>
          <option value="high">High</option>
        </select>
      </div>
    </div>
    <div class="mt-16">
      <div class="section-head">Assignees <span class="text-muted">(one task, many people)</span></div>
      <div class="chk-grid">${people.length ? chk('a', 'wt-assign') : '<p class="text-muted">No employees or team leads yet.</p>'}</div>
    </div>
    <div class="mt-16">
      <div class="section-head">Tagged / CC <span class="text-muted">(visibility + notify)</span></div>
      <div class="chk-grid">${people.length ? chk('t', 'wt-tag') : ''}</div>
    </div>
    <div class="mt-16">
      <label class="text-muted font-mono" style="font-size:9px;letter-spacing:2px">ATTACHMENTS</label>
      <input type="file" class="input-field" id="wt-files" multiple onchange="wsStageFilesCreate(event)"/>
      <p class="text-muted" style="font-size:12px;margin-top:6px">Max 400KB per file (demo storage limit).</p>
      <div id="wt-files-list" class="text-muted" style="font-size:13px"></div>
    </div>
    <button class="btn-sm btn-info mt-16" onclick="wsCreateTeamTaskWithFiles()">CREATE & ASSIGN</button>
  </div>
</div>`;
}

let wtStagedFiles = [];

function wsExecDesc(cmd) {
  const el = document.getElementById('wt-desc');
  if (el) {
    el.focus();
    document.execCommand(cmd, false, null);
  }
}

function wsStageFilesCreate(ev) {
  wtStagedFiles = [...(ev.target.files || [])];
  const el = document.getElementById('wt-files-list');
  if (el) el.textContent = wtStagedFiles.map(f => f.name).join(', ') || '';
}

function wsCreateTeamTaskWithFiles() {
  const u = currentUser();
  if (!u || normalizeRole(u.role) !== 'manager') return;
  const title = (document.getElementById('wt-title') || {}).value.trim();
  const ed = document.getElementById('wt-desc');
  const deadline = (document.getElementById('wt-deadline') || {}).value;
  const priority = (document.getElementById('wt-priority') || {}).value || 'medium';
  if (!title) {
    toast('Title required', 'err');
    return;
  }
  const assignees = [...document.querySelectorAll('.wt-assign:checked')].map(x => x.value);
  const tagged = [...document.querySelectorAll('.wt-tag:checked')].map(x => x.value);
  if (!assignees.length) {
    toast('Select at least one assignee', 'err');
    return;
  }
  const maxBytes = 400 * 1024;
  const task = {
    id: 'wt-' + Date.now(),
    title,
    descriptionHtml: sanitizeRichHtml(ed ? ed.innerHTML : ''),
    deadline: deadline || '',
    priority,
    status: 'todo',
    assignees,
    taggedUserIds: tagged,
    attachments: [],
    comments: [],
    managerNotes: [],
    createdBy: u.id,
    created: new Date().toISOString()
  };
  const finish = () => {
    const arr = Collab.tasks;
    arr.unshift(task);
    saveTeamTasks(arr);
    logActivity({ type: 'task', userId: u.id, msg: `${u.username} created "${title}"` });
    assignees.concat(tagged).forEach(uid => {
      if (uid !== u.id) {
        pushNotif(uid, { icon: '▸', title: 'New assignment', msg: `You were assigned/tagged on: ${title}` });
      }
    });
    wtStagedFiles = [];
    toast('Task assigned');
    navigate('manager', 'board');
  };
  if (!wtStagedFiles.length) {
    finish();
    return;
  }
  let pending = wtStagedFiles.length;
  wtStagedFiles.forEach(file => {
    if (file.size > maxBytes) {
      toast(`Skipped ${file.name} (max 400KB)`, 'err');
      pending--;
      if (pending <= 0) finish();
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      task.attachments.push({
        id: Date.now() + Math.random(),
        name: file.name,
        mime: file.type,
        dataUrl: fr.result
      });
      pending--;
      if (pending <= 0) finish();
    };
    fr.readAsDataURL(file);
  });
}

function renderManagerBoard(u) {
  const mine = Collab.tasks.filter(t => t.createdBy === u.id);
  return `
<div class="panel">
  <div class="panel-head"><h3>Tasks you assigned (${mine.length})</h3></div>
  <div class="panel-body">${!mine.length ? '<div class="empty-state"><p>No team tasks yet.</p></div>' : `<div class="task-list-wrap">${mine.map(t => renderTeamTaskRow(t, true)).join('')}</div>`}</div>
</div>`;
}

function renderTeamTaskRow(t, openable) {
  const overdue = teamDeadlineOverdue(t);
  const names = (t.assignees || [])
    .map(id => getUser(id))
    .filter(Boolean)
    .map(x => x.username)
    .join(', ');
  const click = openable ? `onclick="openTeamTaskModal('${t.id}')"` : '';
  return `
<div class="task-item team-task-row p-${t.priority || 'medium'}" ${click} style="cursor:pointer">
  <div class="task-body" style="flex:1">
    <div class="task-text">${escHtml(t.title)}</div>
    <div class="task-meta">
      <span class="badge-pri ${t.priority || 'medium'}">${(t.priority || 'medium').toUpperCase()}</span>
      <span class="badge-owner">${escHtml(names) || '—'}</span>
      ${t.deadline ? `<span class="badge-due ${overdue ? 'overdue' : ''}">${overdue ? '⚠ ' : ''}${escHtml(t.deadline)}</span>` : ''}
      <span class="badge-cat">${escHtml(t.status || 'todo')}</span>
    </div>
  </div>
</div>`;
}

function renderAssigneeInbox(u) {
  const list = Collab.tasks.filter(t => canSeeTeamTask(t, u.id) && (t.assignees || []).includes(u.id));
  const tagged = Collab.tasks.filter(
    t => canSeeTeamTask(t, u.id) && !(t.assignees || []).includes(u.id) && (t.taggedUserIds || []).includes(u.id)
  );
  return `
<div class="panel">
  <div class="panel-head"><h3>Assigned to you (${list.length})</h3></div>
  <div class="panel-body">${!list.length ? '<p class="text-muted">No assignments.</p>' : `<div class="task-list-wrap">${list.map(t => renderTeamTaskRow(t, true)).join('')}</div>`}</div>
</div>
<div class="panel">
  <div class="panel-head"><h3>Tagged / CC (${tagged.length})</h3></div>
  <div class="panel-body">${!tagged.length ? '<p class="text-muted">Nothing tagged for you.</p>' : `<div class="task-list-wrap">${tagged.map(t => renderTeamTaskRow(t, true)).join('')}</div>`}</div>
</div>`;
}

function renderLeadPipeline() {
  const u = currentUser();
  const list = Collab.tasks.filter(t => canSeeTeamTask(t, u.id)).sort((a, b) => {
    const da = a.deadline ? new Date(a.deadline) : new Date('9999');
    const db = b.deadline ? new Date(b.deadline) : new Date('9999');
    return da - db;
  });
  return `
<div class="panel">
  <div class="panel-head"><h3>All visible work (${list.length})</h3><span class="text-muted" style="font-size:12px">Tasks you’re on or tagged in</span></div>
  <div class="panel-body">${!list.length ? '<p class="text-muted">No shared tasks.</p>' : `<div class="task-list-wrap">${list.map(t => renderTeamTaskRow(t, true)).join('')}</div>`}</div>
</div>`;
}

function workspaceShellConfig(view) {
  const u = currentUser();
  const unread = unreadCount(u.id);
  const initials = u.username.slice(0, 2).toUpperCase();
  const roleLabel = normalizeRole(u.role).replace('_', ' ').toUpperCase();

  if (view === 'manager') {
    const tabs = [
      { id: 'assign', icon: '+', label: 'Assign' },
      { id: 'board', icon: '▸', label: 'My board' },
      { id: 'personal', icon: '⬡', label: 'Personal' },
      { id: 'chat', icon: '💬', label: 'Chat' },
      { id: 'activity', icon: '◈', label: 'Activity' },
      { id: 'announce', icon: '📣', label: 'Broadcast' },
      { id: 'notifs', icon: '📡', label: 'Notifications' },
      { id: 'profile', icon: '⬡', label: 'Profile' }
    ];
    return { tabs, unread, initials, roleLabel, brand: 'MANAGER OPS' };
  }
  if (view === 'teamlead') {
    const tabs = [
      { id: 'inbox', icon: '▸', label: 'My work' },
      { id: 'pipeline', icon: '◈', label: 'Pipeline' },
      { id: 'personal', icon: '⬡', label: 'Personal' },
      { id: 'chat', icon: '💬', label: 'Chat' },
      { id: 'activity', icon: '◈', label: 'Activity' },
      { id: 'announce', icon: '📣', label: 'News' },
      { id: 'notifs', icon: '📡', label: 'Notifications' },
      { id: 'profile', icon: '⬡', label: 'Profile' }
    ];
    return { tabs, unread, initials, roleLabel, brand: 'TEAM LEAD' };
  }
  const tabs = [
    { id: 'inbox', icon: '▸', label: 'My work' },
    { id: 'chat', icon: '💬', label: 'Chat' },
    { id: 'activity', icon: '◈', label: 'Activity' },
    { id: 'announce', icon: '📣', label: 'News' },
    { id: 'notifs', icon: '📡', label: 'Notifications' },
    { id: 'profile', icon: '⬡', label: 'Profile' }
  ];
  return { tabs, unread, initials, roleLabel, brand: 'EMPLOYEE' };
}

function renderWorkspaceShell(view) {
  const u = currentUser();
  const cfg = workspaceShellConfig(view);
  const sidebarItems = cfg.tabs
    .map(t => {
      const nb = t.id === 'notifs' && cfg.unread ? `<span class="nav-badge">${cfg.unread}</span>` : '';
      return `<div class="nav-item ${currentTab === t.id ? 'active' : ''}" onclick="navigate('${view}','${t.id}')">
      <span class="nav-icon">${t.icon}</span>${t.label}${nb}
    </div>`;
    })
    .join('');

  let tabContent = '';
  if (view === 'manager') {
    if (currentTab === 'assign') tabContent = renderManagerAssignForm();
    else if (currentTab === 'board') tabContent = renderManagerBoard(u);
    else if (currentTab === 'personal') tabContent = renderUserTasks(u);
    else if (currentTab === 'chat') tabContent = renderChatPanel();
    else if (currentTab === 'activity') tabContent = renderActivityPanel();
    else if (currentTab === 'announce') tabContent = renderAnnouncementsPanel(true);
    else if (currentTab === 'notifs') tabContent = renderUserNotifs(u);
    else if (currentTab === 'profile') tabContent = renderUserProfile(u);
  } else if (view === 'teamlead') {
    if (currentTab === 'inbox') tabContent = renderAssigneeInbox(u);
    else if (currentTab === 'pipeline') tabContent = renderLeadPipeline();
    else if (currentTab === 'personal') tabContent = renderUserTasks(u);
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

  return `
<div class="dashboard">
  <aside class="sidebar">
    <div class="sidebar-logo">
      <span class="logo-tag">NEXUS WORKSPACE</span>
      <div class="logo-name">NEXUS</div>
      <div class="logo-role">${cfg.brand}</div>
    </div>
    <nav class="sidebar-nav">
      <div class="nav-section-label">WORK</div>
      ${sidebarItems}
    </nav>
    <div class="sidebar-footer">
      <div class="user-chip">
        <div class="user-avatar">${cfg.initials}</div>
        <div class="user-info">
          <div class="user-name">${escHtml(u.username)}</div>
          <div class="user-role">${cfg.roleLabel}</div>
        </div>
      </div>
    </div>
  </aside>
  <div class="main-content">
    <div class="topbar">
      <div class="topbar-title">NEXUS / <span>${currentTab.toUpperCase()}</span></div>
      <div class="notif-btn" onclick="navigate('${view}','notifs')">
        📡${cfg.unread ? `<span class="notif-count">${cfg.unread}</span>` : ''}
      </div>
      <button class="logout-btn" onclick="doLogout()">LOGOUT</button>
    </div>
    <div class="page-content">
      ${tabContent}
    </div>
  </div>
</div>`;
}

if (typeof boot === 'function') boot();
