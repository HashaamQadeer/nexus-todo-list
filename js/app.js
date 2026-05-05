/* ══════════════════════════════════════════════
   DATA LAYER
══════════════════════════════════════════════ */
const ADMIN_ID = 'nexus-admin-root';
const APP_STATE = {
  users: [],
  sessionUserId: null,
  collab: { tasks: [], chat: [], activity: [], announcements: [] },
  hydrated: false
};

const DB = {
  get users() { return APP_STATE.users; },
  set users(v) { APP_STATE.users = Array.isArray(v) ? v : []; if (APP_STATE.hydrated) syncStateSoon(); },
  get session() { return APP_STATE.sessionUserId; },
  set session(v) { APP_STATE.sessionUserId = v || null; }
};

let syncTimer = null;
let syncing = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

function syncStateSoon() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { pushStateToServer(); }, 220);
}

async function pushStateToServer() {
  if (!APP_STATE.hydrated || syncing || !DB.session) return;
  syncing = true;
  try {
    await api('/api/state', {
      method: 'PUT',
      body: { users: DB.users, collab: APP_STATE.collab }
    });
  } catch (err) {
    console.warn('state sync failed:', err.message);
  } finally {
    syncing = false;
  }
}

async function hydrateFromServer() {
  const ses = await api('/api/auth/session');
  DB.session = ses.user ? ses.user.id : null;
  if (!DB.session) {
    DB.users = [];
    APP_STATE.collab = { tasks: [], chat: [], activity: [], announcements: [] };
    APP_STATE.hydrated = true;
    return;
  }
  const state = await api('/api/state');
  DB.users = state.users || [];
  APP_STATE.collab = state.collab || { tasks: [], chat: [], activity: [], announcements: [] };
  APP_STATE.hydrated = true;
  migrateUsersAndCollab();
}

function migrateUsersAndCollab() {
  let users = DB.users;
  let changed = false;
  users.forEach(u => {
    if (u.role === 'user' || u.role === 'moderator') {
      u.role = 'employee';
      changed = true;
    }
  });
  if (changed) DB.users = users;
  if (!APP_STATE.collab || typeof APP_STATE.collab !== 'object') {
    APP_STATE.collab = { tasks: [], chat: [], activity: [], announcements: [] };
    changed = true;
  }
  APP_STATE.collab.tasks = APP_STATE.collab.tasks || [];
  APP_STATE.collab.chat = APP_STATE.collab.chat || [];
  APP_STATE.collab.activity = APP_STATE.collab.activity || [];
  APP_STATE.collab.announcements = APP_STATE.collab.announcements || [];
  if (changed && APP_STATE.hydrated) syncStateSoon();
}

function routeRole(r) {
  if (r === 'user' || r === 'moderator') return 'employee';
  return r;
}

function getUser(id)   { return DB.users.find(u => u.id === id); }
function saveUsers(arr){ DB.users = arr; }
function currentUser() { return getUser(DB.session); }

function updateUser(id, changes) {
  let users = DB.users;
  const i = users.findIndex(u => u.id === id);
  if (i >= 0) { users[i] = {...users[i], ...changes}; DB.users = users; }
}

function pushNotif(userId, notif) {
  let users = DB.users;
  const i = users.findIndex(u => u.id === userId);
  if (i < 0) return;
  users[i].notifications = users[i].notifications || [];
  users[i].notifications.unshift({
    id: Date.now() + Math.random(),
    ...notif,
    read: false,
    time: new Date().toISOString()
  });
  DB.users = users;
}

function markAllNotifsRead(userId) {
  let users = DB.users;
  const i = users.findIndex(u => u.id === userId);
  if (i < 0) return;
  users[i].notifications = (users[i].notifications||[]).map(n => ({...n,read:true}));
  DB.users = users;
}

function unreadCount(userId) {
  const u = getUser(userId);
  if (!u) return 0;
  return (u.notifications||[]).filter(n=>!n.read).length;
}

/* Task helpers */
function addTaskToUser(userId, task) {
  let users = DB.users;
  const i = users.findIndex(u => u.id === userId);
  if (i < 0) return;
  users[i].tasks = users[i].tasks || [];
  users[i].tasks.unshift({id: Date.now()+Math.random(), ...task, created: new Date().toISOString()});
  DB.users = users;
}
function updateTask(userId, taskId, changes) {
  let users = DB.users;
  const ui = users.findIndex(u => u.id === userId);
  if (ui < 0) return;
  const ti = users[ui].tasks.findIndex(t => t.id === taskId);
  if (ti < 0) return;
  users[ui].tasks[ti] = {...users[ui].tasks[ti], ...changes};
  DB.users = users;
}
function deleteTask(userId, taskId) {
  let users = DB.users;
  const ui = users.findIndex(u => u.id === userId);
  if (ui < 0) return;
  users[ui].tasks = users[ui].tasks.filter(t => t.id !== taskId);
  DB.users = users;
}
function isOverdue(t) {
  if (!t.due || t.done) return false;
  return new Date(t.due) < new Date(new Date().toDateString());
}

/* ══════════════════════════════════════════════
   ROUTING
══════════════════════════════════════════════ */
let currentView = '';
let currentTab  = '';
let editingTask = { userId: null, taskId: null };
let notifTargetId = null;
let taskFilter = 'all';
let taskSearch = '';

function navigate(view, tab='') {
  currentView = view;
  currentTab  = tab || defaultTab(view);
  render();
}

function defaultTab(view) {
  if (view === 'admin') return 'overview';
  if (view === 'user') return 'tasks';
  if (view === 'manager') return 'board';
  if (view === 'teamlead' || view === 'employee') return 'inbox';
  return '';
}

function boot() {
  const u = currentUser();
  if (!u) { navigate('login'); return; }
  if (u.status === 'pending')  { navigate('pending'); return; }
  if (u.status === 'rejected') { navigate('rejected'); return; }
  if (u.status === 'banned')   { navigate('banned'); return; }
  const role = routeRole(u.role);
  if (role === 'admin') { navigate('admin','overview'); return; }
  if (role === 'manager') { navigate('manager', defaultTab('manager')); return; }
  if (role === 'team_lead') { navigate('teamlead', defaultTab('teamlead')); return; }
  if (role === 'employee') { navigate('employee', defaultTab('employee')); return; }
  navigate('user','tasks');
}

async function initApp() {
  try {
    await hydrateFromServer();
  } catch (err) {
    console.error('Failed to initialize from server:', err);
    toast('Server unavailable', 'err');
    DB.session = null;
    DB.users = [];
    APP_STATE.collab = { tasks: [], chat: [], activity: [], announcements: [] };
    APP_STATE.hydrated = true;
  }
  boot();
}

/* ══════════════════════════════════════════════
   RENDER ENGINE
══════════════════════════════════════════════ */
function render() {
  const app = document.getElementById('app');
  if      (currentView==='login')    app.innerHTML = renderLogin();
  else if (currentView==='signup')   app.innerHTML = renderSignup();
  else if (currentView==='pending')  app.innerHTML = renderPending();
  else if (currentView==='rejected') app.innerHTML = renderRejected();
  else if (currentView==='banned')   app.innerHTML = renderBanned();
  else if (currentView==='admin')    app.innerHTML = renderAdminShell();
  else if (currentView==='user')     app.innerHTML = renderUserShell();
  else if (currentView==='manager')  app.innerHTML = typeof renderWorkspaceShell === 'function' ? renderWorkspaceShell('manager') : '';
  else if (currentView==='teamlead') app.innerHTML = typeof renderWorkspaceShell === 'function' ? renderWorkspaceShell('teamlead') : '';
  else if (currentView==='employee') app.innerHTML = typeof renderWorkspaceShell === 'function' ? renderWorkspaceShell('employee') : '';
  updateNotifBadges();
}

/* ══════════════════════════════════════════════
   AUTH VIEWS
══════════════════════════════════════════════ */
function renderLogin() { return `
<div class="auth-page">
  <div class="auth-logo">
    <span class="tag">▸ NEXUS COMMAND SYSTEM ◂</span>
    <h1>NEXUS</h1>
    <p class="sub">Authenticate to Continue</p>
  </div>
  <div class="auth-card">
    <h2>⬡ Operator Login</h2>
    <div class="auth-error" id="login-err"></div>
    <div class="form-group">
      <label>Username</label>
      <input type="text" id="l-user" placeholder="Enter username…" onkeydown="if(event.key==='Enter')doLogin()"/>
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="l-pass" placeholder="Enter password…" onkeydown="if(event.key==='Enter')doLogin()"/>
    </div>
    <button class="btn btn-primary" style="margin-top:8px" onclick="doLogin()">ACCESS SYSTEM</button>
    <div class="auth-link">New operator? <a onclick="navigate('signup')">Request Access</a></div>
  </div>
</div>`; }

function renderSignup() { return `
<div class="auth-page">
  <div class="auth-logo">
    <span class="tag">▸ NEXUS COMMAND SYSTEM ◂</span>
    <h1>NEXUS</h1>
    <p class="sub">Request System Access</p>
  </div>
  <div class="auth-card">
    <h2>⬡ New Agent Registration</h2>
    <div class="auth-error" id="su-err"></div>
    <div class="auth-success" id="su-ok"></div>
    <div class="form-group">
      <label>Username</label>
      <input type="text" id="su-user" placeholder="Choose a callsign…"/>
    </div>
    <div class="form-group">
      <label>Email</label>
      <input type="email" id="su-email" placeholder="agent@nexus.io"/>
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="su-pass" placeholder="Min 6 characters…"/>
    </div>
    <button class="btn btn-primary" style="margin-top:8px" onclick="doSignup()">SUBMIT REQUEST</button>
    <div class="auth-link">Already registered? <a onclick="navigate('login')">Login here</a></div>
  </div>
</div>`; }

function renderPending() { return `
<div class="auth-page">
  <div class="auth-logo"><h1>NEXUS</h1></div>
  <div class="auth-card" style="text-align:center">
    <div style="font-size:48px;margin-bottom:16px;animation:float-idle2 3s ease-in-out infinite">⏳</div>
    <h2 style="justify-content:center">Awaiting Clearance</h2>
    <p style="color:var(--text2);font-size:14px;line-height:1.6;margin:16px 0">Your access request has been submitted. An administrator will review your application shortly.</p>
    <div style="background:rgba(255,214,10,.06);border:1px solid rgba(255,214,10,.2);border-radius:8px;padding:12px;margin:16px 0">
      <span style="font-family:'Orbitron',sans-serif;font-size:9px;letter-spacing:2px;color:var(--yellow)">STATUS: PENDING APPROVAL</span>
    </div>
    <button class="btn-sm btn-outline" onclick="doLogout()" style="margin-top:8px">LOGOUT</button>
  </div>
</div>`; }

function renderRejected() { return `
<div class="auth-page">
  <div class="auth-logo"><h1>NEXUS</h1></div>
  <div class="auth-card" style="text-align:center">
    <div style="font-size:48px;margin-bottom:16px">🚫</div>
    <h2 style="justify-content:center">Access Denied</h2>
    <p style="color:var(--text2);font-size:14px;line-height:1.6;margin:16px 0">Your access request was rejected by the administrator.</p>
    <button class="btn-sm btn-outline" onclick="doLogout()" style="margin-top:8px">LOGOUT</button>
  </div>
</div>`; }

function renderBanned() { return `
<div class="auth-page">
  <div class="auth-logo"><h1>NEXUS</h1></div>
  <div class="auth-card" style="text-align:center">
    <div style="font-size:48px;margin-bottom:16px">⛔</div>
    <h2 style="justify-content:center">Account Suspended</h2>
    <p style="color:var(--text2);font-size:14px;line-height:1.6;margin:16px 0">Your account has been suspended. Contact an administrator.</p>
    <button class="btn-sm btn-outline" onclick="doLogout()" style="margin-top:8px">LOGOUT</button>
  </div>
</div>`; }

/* ══════════════════════════════════════════════
   ADMIN DASHBOARD
══════════════════════════════════════════════ */
function renderAdminShell() {
  const u = currentUser();
  const tabs = [
    {id:'overview', icon:'◈', label:'Overview'},
    {id:'users',    icon:'⬡', label:'Agents'},
    {id:'tasks',    icon:'▸', label:'All Missions'},
    {id:'workspace',icon:'◇', label:'Workspace'},
    {id:'notifs',   icon:'📡', label:'Notifications'},
  ];
  const unread = unreadCount(ADMIN_ID);
  const pendingCount = DB.users.filter(u=>u.status==='pending').length;

  const sidebarItems = tabs.map(t => {
    const badge = t.id==='users' && pendingCount ? `<span class="nav-badge">${pendingCount}</span>` : '';
    const nbadge= t.id==='notifs' && unread      ? `<span class="nav-badge">${unread}</span>` : '';
    return `<div class="nav-item ${currentTab===t.id?'active':''}" onclick="navigate('admin','${t.id}')">
      <span class="nav-icon">${t.icon}</span>${t.label}${badge}${nbadge}
    </div>`;
  }).join('');

  let tabContent = '';
  if      (currentTab==='overview') tabContent = renderAdminOverview();
  else if (currentTab==='users')    tabContent = renderAdminUsers();
  else if (currentTab==='tasks')    tabContent = renderAdminTasks();
  else if (currentTab==='workspace') tabContent = renderAdminWorkspace();
  else if (currentTab==='notifs')   tabContent = renderAdminNotifs();

  return `
<div class="dashboard">
  <aside class="sidebar">
    <div class="sidebar-logo">
      <span class="logo-tag">NEXUS COMMAND</span>
      <div class="logo-name">NEXUS</div>
      <div class="logo-role">Admin Control</div>
    </div>
    <nav class="sidebar-nav">
      <div class="nav-section-label">CONTROL PANELS</div>
      ${sidebarItems}
    </nav>
    <div class="sidebar-footer">
      <div class="user-chip">
        <div class="user-avatar">A</div>
        <div class="user-info">
          <div class="user-name">${u.username}</div>
          <div class="user-role">ADMIN</div>
        </div>
      </div>
    </div>
  </aside>
  <div class="main-content">
    <div class="topbar">
      <div class="topbar-title">NEXUS / <span>${currentTab.toUpperCase()}</span></div>
      <div class="notif-btn" onclick="navigate('admin','notifs')">
        📡${unread?`<span class="notif-count">${unread}</span>`:''}
      </div>
      <button class="logout-btn" onclick="doLogout()">LOGOUT</button>
    </div>
    <div class="page-content" id="tab-content">
      ${tabContent}
    </div>
  </div>
</div>`; }

function renderAdminOverview() {
  const users  = DB.users.filter(u=>u.id!==ADMIN_ID);
  const active = users.filter(u=>u.status==='active').length;
  const pending= users.filter(u=>u.status==='pending').length;
  const banned = users.filter(u=>u.status==='banned').length;
  const allTasks = users.flatMap(u=>u.tasks||[]);
  const done   = allTasks.filter(t=>t.done).length;
  const overdue= allTasks.filter(isOverdue).length;
  const teamN  = typeof Collab !== 'undefined' ? Collab.tasks.length : 0;

  const recentUsers = [...users].sort((a,b)=>new Date(b.created)-new Date(a.created)).slice(0,5);
  const pct = allTasks.length ? Math.round((done/allTasks.length)*100) : 0;

  return `
<div class="stats-grid">
  <div class="stat-card sc-cyan">  <div class="sc-icon">⬡</div><div class="sc-val">${users.length}</div><div class="sc-label">Total Agents</div></div>
  <div class="stat-card sc-green"> <div class="sc-icon">✓</div><div class="sc-val">${active}</div><div class="sc-label">Active</div></div>
  <div class="stat-card sc-yellow"><div class="sc-icon">⏳</div><div class="sc-val">${pending}</div><div class="sc-label">Pending</div></div>
  <div class="stat-card sc-red">   <div class="sc-icon">⛔</div><div class="sc-val">${banned}</div><div class="sc-label">Suspended</div></div>
  <div class="stat-card sc-purple"><div class="sc-icon">▸</div><div class="sc-val">${allTasks.length}</div><div class="sc-label">Personal Missions</div></div>
  <div class="stat-card sc-orange"><div class="sc-icon">⚠</div><div class="sc-val">${overdue}</div><div class="sc-label">Overdue</div></div>
  <div class="stat-card sc-cyan" style="grid-column:span 2"><div class="sc-icon">◇</div><div class="sc-val">${teamN}</div><div class="sc-label">Shared team tasks</div></div>
</div>

<div class="panel">
  <div class="panel-head"><h3>Global Mission Progress</h3><span style="font-family:'Orbitron',sans-serif;font-size:10px;color:var(--cyan)">${pct}%</span></div>
  <div class="panel-body">
    <div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div>
    <div style="font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:2px;color:var(--text2);margin-top:8px">${done} / ${allTasks.length} MISSIONS COMPLETE</div>
  </div>
</div>

<div class="panel">
  <div class="panel-head"><h3>Recent Agents</h3><button class="btn-sm btn-info" onclick="navigate('admin','users')">VIEW ALL</button></div>
  <div class="panel-body no-pad">
    ${recentUsers.length ? `
    <table class="data-table">
      <thead><tr><th>Agent</th><th>Email</th><th>Role</th><th>Status</th><th>Missions</th><th>Actions</th></tr></thead>
      <tbody>${recentUsers.map(u=>userRow(u)).join('')}</tbody>
    </table>` : `<div class="empty-state"><div class="empty-icon">⬡</div><p>No agents registered</p></div>`}
  </div>
</div>`; }

function renderAdminUsers() {
  const users = DB.users.filter(u=>u.id!==ADMIN_ID);
  const pending = users.filter(u=>u.status==='pending');
  const rest    = users.filter(u=>u.status!=='pending');

  return `
${pending.length ? `
<div class="panel">
  <div class="panel-head" style="border-bottom:1px solid rgba(255,214,10,.15)">
    <h3 style="color:var(--yellow)">⏳ Pending Approval <span style="font-family:'Orbitron',sans-serif;font-size:9px;background:rgba(255,214,10,.12);border:1px solid rgba(255,214,10,.3);border-radius:3px;padding:2px 8px;color:var(--yellow)">${pending.length}</span></h3>
  </div>
  <div class="panel-body no-pad">
    <table class="data-table">
      <thead><tr><th>Agent</th><th>Email</th><th>Registered</th><th>Actions</th></tr></thead>
      <tbody>${pending.map(u=>`
        <tr class="entering">
          <td><span style="color:var(--cyan);font-weight:700">${u.username}</span></td>
          <td style="color:var(--text2)">${u.email}</td>
          <td style="font-family:'Orbitron',sans-serif;font-size:9px;color:var(--text2)">${fmtDate(u.created)}</td>
          <td><div style="display:flex;gap:6px">
            <button class="btn-sm btn-approve"  onclick="approveUser('${u.id}')">APPROVE</button>
            <button class="btn-sm btn-reject"   onclick="rejectUser('${u.id}')">REJECT</button>
            <button class="btn-sm btn-delete"   onclick="deleteUser('${u.id}')">DELETE</button>
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table>
  </div>
</div>` : ''}

<div class="panel">
  <div class="panel-head"><h3>All Agents</h3>
    <input class="input-field" type="text" placeholder="Search agents…" oninput="filterAgents(this.value)" style="padding:6px 12px;font-size:13px" id="agent-search"/>
  </div>
  <div class="panel-body no-pad" id="agents-table">
    ${renderAgentsTable(rest)}
  </div>
</div>`; }

function renderAgentsTable(users) {
  if (!users.length) return `<div class="empty-state"><div class="empty-icon">⬡</div><p>No agents found</p></div>`;
  return `<table class="data-table">
    <thead><tr><th>Agent</th><th>Email</th><th>Role</th><th>Status</th><th>Missions</th><th>Joined</th><th>Actions</th></tr></thead>
    <tbody>${users.map(u=>userRow(u)).join('')}</tbody>
  </table>`; }

function userRow(u) {
  const taskCount = (u.tasks||[]).length;
  const done = (u.tasks||[]).filter(t=>t.done).length;
  return `<tr class="entering" id="urow-${u.id}">
    <td><span style="color:var(--cyan);font-weight:700">${u.username}</span></td>
    <td style="color:var(--text2);font-size:13px">${u.email}</td>
    <td>
      <select class="role-select" onchange="changeRole('${u.id}',this.value)">
        <option value="employee"   ${u.role==='employee'||u.role==='user'?'selected':''}>Employee</option>
        <option value="team_lead"  ${u.role==='team_lead'?'selected':''}>Team lead</option>
        <option value="manager"    ${u.role==='manager'?'selected':''}>Manager</option>
        <option value="admin"      ${u.role==='admin'?'selected':''}>Admin</option>
      </select>
    </td>
    <td><span class="badge badge-${u.status}">${u.status.toUpperCase()}</span></td>
    <td>
      <span style="color:var(--cyan);font-family:'Orbitron',sans-serif;font-size:11px">${done}/${taskCount}</span>
      <div class="prog-bar" style="width:80px;margin-top:4px"><div class="prog-fill" style="width:${taskCount?Math.round(done/taskCount*100):0}%"></div></div>
    </td>
    <td style="font-family:'Orbitron',sans-serif;font-size:9px;color:var(--text2)">${fmtDate(u.created)}</td>
    <td><div style="display:flex;gap:5px;flex-wrap:wrap">
      <button class="btn-sm btn-info"   onclick="viewUserTasks('${u.id}')">MISSIONS</button>
      <button class="btn-sm btn-purple" onclick="openNotifModal('${u.id}')">MSG</button>
      ${u.status==='active' ? `<button class="btn-sm btn-reject" onclick="banUser('${u.id}')">BAN</button>` : ''}
      ${u.status==='banned' ? `<button class="btn-sm btn-approve" onclick="approveUser('${u.id}')">UNBAN</button>` : ''}
      ${u.status==='pending'? `<button class="btn-sm btn-approve" onclick="approveUser('${u.id}')">APPROVE</button>` : ''}
      <button class="btn-sm btn-delete" onclick="deleteUser('${u.id}')">DEL</button>
    </div></td>
  </tr>`; }

function renderAdminWorkspace() {
  const tasks = typeof Collab !== 'undefined' ? Collab.tasks : [];
  return `
<div class="panel">
  <div class="panel-head"><h3>Team tasks (${tasks.length})</h3></div>
  <div class="panel-body">${!tasks.length ? '<p class="text-muted">No shared tasks.</p>' : `<div class="task-list-wrap">${tasks.map(t => (typeof renderTeamTaskRow === 'function' ? renderTeamTaskRow(t, true) : '')).join('')}</div>`}</div>
</div>
${typeof renderAnnouncementsPanel === 'function' ? renderAnnouncementsPanel(true) : ''}
${typeof renderActivityPanel === 'function' ? renderActivityPanel() : ''}`;
}

function renderAdminTasks() {
  const users = DB.users.filter(u=>u.id!==ADMIN_ID && u.status==='active');
  const allTasks = users.flatMap(u=>(u.tasks||[]).map(t=>({...t,_owner:u.username,_uid:u.id})));
  allTasks.sort((a,b)=>{if(a.done!==b.done)return a.done?1:-1; const po={high:0,medium:1,low:2}; return (po[a.pri]||1)-(po[b.pri]||1);});

  const catLabels = {general:'⬡ General',work:'⬡ Work',personal:'⬡ Personal',health:'⬡ Health',urgent:'⬡ Urgent'};
  return `
<div class="panel">
  <div class="panel-head">
    <h3>All Agent Missions <span style="font-family:'Orbitron',sans-serif;font-size:9px;background:rgba(0,245,255,.08);border:1px solid rgba(0,245,255,.15);border-radius:3px;padding:2px 8px">${allTasks.length}</span></h3>
  </div>
  <div class="panel-body">
    ${!allTasks.length
      ? `<div class="empty-state"><div class="empty-icon">▸</div><p>No missions recorded</p></div>`
      : `<div class="task-list-wrap">${allTasks.map(t=>`
        <div class="task-item p-${t.pri||'medium'}">
          <div class="task-check ${t.done?'checked':''}">${t.done?'✓':''}</div>
          <div class="task-body">
            <div class="task-text ${t.done?'done':''}">${escHtml(t.text)}</div>
            <div class="task-meta">
              <span class="badge-owner">@${t._owner}</span>
              <span class="badge-cat">${catLabels[t.cat]||t.cat||'general'}</span>
              <span class="badge-pri ${t.pri||'medium'}">${(t.pri||'medium').toUpperCase()}</span>
              ${t.due?`<span class="badge-due ${isOverdue(t)?'overdue':''}">${isOverdue(t)?'⚠ ':''}${t.due}</span>`:''}
            </div>
          </div>
        </div>`).join('')}</div>`}
  </div>
</div>`; }

function renderAdminNotifs() {
  markAllNotifsRead(ADMIN_ID);
  updateNotifBadges();
  const notifs = (getUser(ADMIN_ID)?.notifications||[]);
  return `
<div class="panel">
  <div class="panel-head">
    <h3>📡 Admin Notifications</h3>
    ${notifs.length?`<button class="btn-sm btn-delete" onclick="clearAdminNotifs()">CLEAR ALL</button>`:''}
  </div>
  <div class="panel-body">
    ${!notifs.length
      ? `<div class="empty-state"><div class="empty-icon">📡</div><p>No transmissions</p></div>`
      : `<div class="notif-list">${notifs.map(n=>`
        <div class="notif-item ${n.read?'':'unread'}">
          <div class="notif-icon">${n.icon||'📌'}</div>
          <div class="notif-body">
            <div class="notif-title">${n.title}</div>
            <div class="notif-msg">${n.msg}</div>
            <div class="notif-time">${fmtDateFull(n.time)}</div>
          </div>
        </div>`).join('')}</div>`}
  </div>
</div>`; }

/* ══════════════════════════════════════════════
   USER DASHBOARD
══════════════════════════════════════════════ */
function renderUserShell() {
  const u = currentUser();
  const unread = unreadCount(u.id);
  const tabs = [
    {id:'tasks',  icon:'▸', label:'My Missions'},
    {id:'notifs', icon:'📡', label:'Notifications'},
    {id:'profile',icon:'⬡', label:'Profile'},
  ];
  const sidebarItems = tabs.map(t=>{
    const nb = t.id==='notifs' && unread ? `<span class="nav-badge">${unread}</span>` : '';
    return `<div class="nav-item ${currentTab===t.id?'active':''}" onclick="navigate('user','${t.id}')">
      <span class="nav-icon">${t.icon}</span>${t.label}${nb}
    </div>`;
  }).join('');
  const initials = u.username.slice(0,2).toUpperCase();

  let tabContent='';
  if      (currentTab==='tasks')  tabContent = renderUserTasks(u);
  else if (currentTab==='notifs') tabContent = renderUserNotifs(u);
  else if (currentTab==='profile')tabContent = renderUserProfile(u);

  return `
<div class="dashboard">
  <aside class="sidebar">
    <div class="sidebar-logo">
      <span class="logo-tag">NEXUS AGENT</span>
      <div class="logo-name">NEXUS</div>
      <div class="logo-role">${u.role.toUpperCase()} PORTAL</div>
    </div>
    <nav class="sidebar-nav">
      <div class="nav-section-label">AGENT PANELS</div>
      ${sidebarItems}
    </nav>
    <div class="sidebar-footer">
      <div class="user-chip">
        <div class="user-avatar">${initials}</div>
        <div class="user-info">
          <div class="user-name">${u.username}</div>
          <div class="user-role">${u.role.toUpperCase()}</div>
        </div>
      </div>
    </div>
  </aside>
  <div class="main-content">
    <div class="topbar">
      <div class="topbar-title">NEXUS / <span>${currentTab.toUpperCase()}</span></div>
      <div class="notif-btn" onclick="navigate('user','notifs')">
        📡${unread?`<span class="notif-count">${unread}</span>`:''}
      </div>
      <button class="logout-btn" onclick="doLogout()">LOGOUT</button>
    </div>
    <div class="page-content">
      ${tabContent}
    </div>
  </div>
</div>`; }

function renderUserTasks(u) {
  const catLabels = {general:'⬡ General',work:'⬡ Work',personal:'⬡ Personal',health:'⬡ Health',urgent:'⬡ Urgent'};
  const tasks = u.tasks||[];
  const done=tasks.filter(t=>t.done).length;
  const overdue=tasks.filter(isOverdue).length;
  const pct=tasks.length?Math.round(done/tasks.length*100):0;

  let filtered = tasks.filter(t=>{
    if(taskFilter==='active'&&t.done) return false;
    if(taskFilter==='done'&&!t.done)  return false;
    if(taskFilter==='high'&&t.pri!=='high') return false;
    if(taskSearch&&!t.text.toLowerCase().includes(taskSearch.toLowerCase())) return false;
    return true;
  });
  filtered.sort((a,b)=>{if(a.done!==b.done)return a.done?1:-1;const po={high:0,medium:1,low:2};return(po[a.pri]||1)-(po[b.pri]||1);});

  return `
<div class="stats-grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
  <div class="stat-card sc-cyan" ><div class="sc-icon">▸</div><div class="sc-val">${tasks.length}</div><div class="sc-label">Total</div></div>
  <div class="stat-card sc-green"><div class="sc-icon">✓</div><div class="sc-val">${done}</div><div class="sc-label">Done</div></div>
  <div class="stat-card sc-red"  ><div class="sc-icon">◈</div><div class="sc-val">${tasks.length-done}</div><div class="sc-label">Active</div></div>
  <div class="stat-card sc-yellow"><div class="sc-icon">⚠</div><div class="sc-val">${overdue}</div><div class="sc-label">Overdue</div></div>
</div>

<div class="panel">
  <div class="panel-head"><h3>Mission Progress</h3><span style="font-family:'Orbitron',sans-serif;font-size:10px;color:var(--cyan)">${pct}%</span></div>
  <div class="panel-body"><div class="prog-bar"><div class="prog-fill" style="width:${pct}%"></div></div></div>
</div>

<div class="panel">
  <div class="panel-head"><h3>Add Mission</h3></div>
  <div class="panel-body">
    <div class="form-inline">
      <input class="input-field grow" type="text" id="new-task-text" placeholder="Enter mission objective…" onkeydown="if(event.key==='Enter')addUserTask()"/>
      <select class="input-field" id="new-task-cat">
        <option value="general">⬡ General</option>
        <option value="work">⬡ Work</option>
        <option value="personal">⬡ Personal</option>
        <option value="health">⬡ Health</option>
        <option value="urgent">⬡ Urgent</option>
      </select>
      <select class="input-field" id="new-task-pri">
        <option value="medium">◈ Medium</option>
        <option value="high">◈ High</option>
        <option value="low">◈ Low</option>
      </select>
      <input type="date" class="input-field" id="new-task-due"/>
      <button class="btn-sm btn-info" onclick="addUserTask()">+ ADD</button>
    </div>
  </div>
</div>

<div class="panel">
  <div class="panel-head">
    <h3>Missions <span style="font-family:'Orbitron',sans-serif;font-size:8px;background:rgba(0,245,255,.08);border:1px solid rgba(0,245,255,.15);border-radius:3px;padding:2px 8px">${filtered.length}</span></h3>
    <button class="btn-sm btn-delete" onclick="clearDoneTasks()">⌫ CLEAR DONE</button>
  </div>
  <div class="panel-body">
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
      ${['all','active','done','high'].map(f=>`<button class="tab-btn ${taskFilter===f?'active':''}" onclick="setTaskFilter('${f}')">${f.toUpperCase()}</button>`).join('')}
      <input class="input-field" type="text" placeholder="Search…" value="${taskSearch}" oninput="taskSearch=this.value;navigate('user','tasks')" style="margin-left:auto;padding:6px 12px;font-size:13px;width:160px"/>
    </div>
    ${!filtered.length
      ? `<div class="empty-state"><div class="empty-icon">▸</div><p>No missions found</p></div>`
      : `<div class="task-list-wrap">${filtered.map((t,i)=>`
        <div class="task-item p-${t.pri||'medium'}" style="animation-delay:${i*.06}s">
          <div class="task-check ${t.done?'checked':''}" onclick="toggleUserTask(${t.id})">${t.done?'✓':''}</div>
          <div class="task-body">
            <div class="task-text ${t.done?'done':''}">${escHtml(t.text)}</div>
            <div class="task-meta">
              <span class="badge-cat">${catLabels[t.cat]||t.cat}</span>
              <span class="badge-pri ${t.pri||'medium'}">${(t.pri||'medium').toUpperCase()}</span>
              ${t.due?`<span class="badge-due ${isOverdue(t)?'overdue':''}">${isOverdue(t)?'⚠ ':''}${t.due}</span>`:''}
            </div>
          </div>
          <div class="task-actions">
            <button class="act-btn edit" onclick="openEditTask('${u.id}',${t.id})">✎</button>
            <button class="act-btn del"  onclick="removeUserTask(${t.id})">✕</button>
          </div>
        </div>`).join('')}</div>`}
  </div>
</div>`; }

function renderUserNotifs(u) {
  markAllNotifsRead(u.id);
  updateNotifBadges();
  const notifs = u.notifications||[];
  return `
<div class="panel">
  <div class="panel-head">
    <h3>📡 Transmissions</h3>
    ${notifs.length?`<button class="btn-sm btn-delete" onclick="clearUserNotifs()">CLEAR ALL</button>`:''}
  </div>
  <div class="panel-body">
    ${!notifs.length
      ? `<div class="empty-state"><div class="empty-icon">📡</div><p>No transmissions received</p></div>`
      : `<div class="notif-list">${notifs.map(n=>`
        <div class="notif-item">
          <div class="notif-icon">${n.icon||'📌'}</div>
          <div class="notif-body">
            <div class="notif-title">${n.title}</div>
            <div class="notif-msg">${n.msg}</div>
            <div class="notif-time">${fmtDateFull(n.time)}</div>
          </div>
        </div>`).join('')}</div>`}
  </div>
</div>`; }

function renderUserProfile(u) {
  return `
<div class="panel">
  <div class="panel-head"><h3>⬡ Agent Profile</h3></div>
  <div class="panel-body">
    <div style="display:flex;align-items:center;gap:20px;margin-bottom:24px">
      <div style="width:64px;height:64px;border-radius:12px;background:linear-gradient(135deg,var(--purple),var(--cyan));display:flex;align-items:center;justify-content:center;font-family:'Orbitron',sans-serif;font-size:22px;font-weight:700;color:white">${u.username.slice(0,2).toUpperCase()}</div>
      <div>
        <div style="font-family:'Orbitron',sans-serif;font-size:18px;font-weight:700;color:var(--cyan)">${u.username}</div>
        <div style="color:var(--text2);margin-top:2px">${u.email}</div>
        <div style="margin-top:6px"><span class="badge badge-${u.role}">${u.role.toUpperCase()}</span> <span class="badge badge-${u.status}">${u.status.toUpperCase()}</span></div>
      </div>
    </div>
    <hr class="divider"/>
    <div class="section-head">Change Password</div>
    <div class="form-inline" style="flex-direction:column;align-items:stretch;max-width:360px;gap:12px">
      <div>
        <label style="font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:2px;color:var(--text2);display:block;margin-bottom:6px">CURRENT PASSWORD</label>
        <input class="input-field w-full" type="password" id="pw-cur" placeholder="Current password…"/>
      </div>
      <div>
        <label style="font-family:'Orbitron',sans-serif;font-size:8px;letter-spacing:2px;color:var(--text2);display:block;margin-bottom:6px">NEW PASSWORD</label>
        <input class="input-field w-full" type="password" id="pw-new" placeholder="New password…"/>
      </div>
      <button class="btn-sm btn-info" onclick="changePassword()" style="width:fit-content">UPDATE PASSWORD</button>
    </div>
  </div>
</div>`; }

/* ══════════════════════════════════════════════
   ACTIONS
══════════════════════════════════════════════ */
async function doLogin() {
  const username = document.getElementById('l-user').value.trim();
  const password = document.getElementById('l-pass').value;
  try {
    await api('/api/auth/login', { method: 'POST', body: { username, password } });
    await hydrateFromServer();
    boot();
  } catch (err) {
    showErr('login-err', err.message || 'Invalid username or password');
  }
}

async function doSignup() {
  const username = document.getElementById('su-user').value.trim();
  const email    = document.getElementById('su-email').value.trim();
  const password = document.getElementById('su-pass').value;
  if (!username||!email||!password) { showErr('su-err','All fields required'); return; }
  if (password.length < 6) { showErr('su-err','Password must be at least 6 characters'); return; }
  try {
    await api('/api/auth/signup', { method: 'POST', body: { username, email, password } });
    await hydrateFromServer();
    pushNotif(ADMIN_ID, {
      icon:'🆕', title:'New Agent Request',
      msg:`${username} (${email}) has requested system access.`
    });
    showSuccess('su-ok','Request submitted! Awaiting admin approval…');
    setTimeout(()=>boot(), 1200);
  } catch (err) {
    showErr('su-err', err.message || 'Signup failed');
  }
}

async function doLogout() {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  DB.session = null;
  DB.users = [];
  APP_STATE.collab = { tasks: [], chat: [], activity: [], announcements: [] };
  navigate('login');
}

function approveUser(id) {
  updateUser(id, {status:'active'});
  const u = getUser(id);
  pushNotif(id, { icon:'✅', title:'Access Granted', msg:'Your request has been approved. Welcome to NEXUS.' });
  pushNotif(ADMIN_ID, { icon:'✅', title:'Agent Approved', msg:`You approved ${u.username}'s access request.` });
  toast('AGENT APPROVED'); navigate('admin', currentTab);
}

function rejectUser(id) {
  const u = getUser(id);
  updateUser(id, {status:'rejected'});
  pushNotif(id, { icon:'🚫', title:'Access Denied', msg:'Your access request was rejected by the administrator.' });
  pushNotif(ADMIN_ID, { icon:'🚫', title:'Agent Rejected', msg:`You rejected ${u.username}'s access request.` });
  toast('AGENT REJECTED'); navigate('admin', currentTab);
}

function banUser(id) {
  const u = getUser(id);
  updateUser(id, {status:'banned'});
  pushNotif(id, { icon:'⛔', title:'Account Suspended', msg:'Your account has been suspended by an administrator.' });
  pushNotif(ADMIN_ID, { icon:'⛔', title:'Agent Suspended', msg:`You suspended ${u.username}'s account.` });
  toast('AGENT SUSPENDED'); navigate('admin', currentTab);
}

function deleteUser(id) {
  let users = DB.users;
  users = users.filter(u=>u.id!==id);
  DB.users = users;
  if (typeof Collab !== 'undefined' && Collab.tasks) {
    const next = Collab.tasks.map(t => ({
      ...t,
      assignees: (t.assignees || []).filter(x => x !== id),
      taggedUserIds: (t.taggedUserIds || []).filter(x => x !== id)
    }));
    Collab.tasks = next;
  }
  pushNotif(ADMIN_ID, { icon:'🗑', title:'Agent Removed', msg:`An agent was removed from the system.` });
  toast('AGENT DELETED'); navigate('admin', currentTab);
}

function changeRole(id, role) {
  const u = getUser(id);
  updateUser(id, {role});
  pushNotif(id, { icon:'⬡', title:'Role Updated', msg:`Your system role has been changed to: ${role.toUpperCase()}.` });
  pushNotif(ADMIN_ID, { icon:'⬡', title:'Role Changed', msg:`${u.username}'s role updated to ${role.toUpperCase()}.` });
  toast('ROLE UPDATED');
  updateNotifBadges();
}

function filterAgents(q) {
  const users = DB.users.filter(u=>u.id!==ADMIN_ID && u.status!=='pending');
  const filtered = q ? users.filter(u=>u.username.toLowerCase().includes(q.toLowerCase())||u.email.toLowerCase().includes(q.toLowerCase())) : users;
  const el = document.getElementById('agents-table');
  if (el) el.innerHTML = renderAgentsTable(filtered);
}

function viewUserTasks(uid) {
  const u = getUser(uid);
  if (!u) return;
  const tasks = u.tasks||[];
  const catLabels = {general:'⬡ General',work:'⬡ Work',personal:'⬡ Personal',health:'⬡ Health',urgent:'⬡ Urgent'};
  document.getElementById('utm-title').textContent = `⬡ ${u.username}'s Missions (${tasks.length})`;
  document.getElementById('utm-body').innerHTML = !tasks.length
    ? `<div class="empty-state"><div class="empty-icon">▸</div><p>No missions assigned</p></div>`
    : `<div class="task-list-wrap" style="max-height:60vh;overflow-y:auto">${tasks.map(t=>`
      <div class="task-item p-${t.pri||'medium'}">
        <div class="task-check ${t.done?'checked':''}">${t.done?'✓':''}</div>
        <div class="task-body">
          <div class="task-text ${t.done?'done':''}">${escHtml(t.text)}</div>
          <div class="task-meta">
            <span class="badge-cat">${catLabels[t.cat]||'general'}</span>
            <span class="badge-pri ${t.pri||'medium'}">${(t.pri||'medium').toUpperCase()}</span>
            ${t.due?`<span class="badge-due ${isOverdue(t)?'overdue':''}">${isOverdue(t)?'⚠ ':''}${t.due}</span>`:''}
          </div>
        </div>
      </div>`).join('')}</div>`;
  openModal('user-tasks-modal');
}

function openNotifModal(uid) {
  const u = getUser(uid);
  notifTargetId = uid;
  document.getElementById('nm-to').value = u.username;
  document.getElementById('nm-subject').value = '';
  document.getElementById('nm-body').value = '';
  openModal('notif-modal');
}

function sendDirectNotif() {
  const subject = document.getElementById('nm-subject').value.trim();
  const body    = document.getElementById('nm-body').value.trim();
  if (!subject||!body) { toast('Fill all fields','err'); return; }
  pushNotif(notifTargetId, { icon:'📡', title:`[ADMIN] ${subject}`, msg:body });
  closeModal('notif-modal');
  toast('MESSAGE TRANSMITTED');
}

function clearAdminNotifs() {
  updateUser(ADMIN_ID, {notifications:[]});
  navigate('admin','notifs');
}

/* User task actions */
function addUserTask() {
  const u = currentUser();
  const text = document.getElementById('new-task-text').value.trim();
  if (!text) return;
  addTaskToUser(u.id, {
    text,
    done:false,
    cat:  document.getElementById('new-task-cat').value,
    pri:  document.getElementById('new-task-pri').value,
    due:  document.getElementById('new-task-due').value,
  });
  toast('MISSION LOGGED');
  navigate('user','tasks');
}

function toggleUserTask(taskId) {
  const u = currentUser();
  const task = (u.tasks||[]).find(t=>t.id===taskId);
  if (!task) return;
  updateTask(u.id, taskId, {done:!task.done});
  navigate('user','tasks');
}

function removeUserTask(taskId) {
  const u = currentUser();
  deleteTask(u.id, taskId);
  toast('MISSION DELETED');
  navigate('user','tasks');
}

function clearDoneTasks() {
  const u = currentUser();
  let users = DB.users;
  const i = users.findIndex(x=>x.id===u.id);
  if (i<0) return;
  users[i].tasks = (users[i].tasks||[]).filter(t=>!t.done);
  DB.users = users;
  toast('COMPLETED MISSIONS CLEARED');
  navigate('user','tasks');
}

function openEditTask(uid, taskId) {
  const u = getUser(uid);
  const t = (u.tasks||[]).find(t=>t.id===taskId);
  if (!t) return;
  editingTask = {userId:uid, taskId};
  document.getElementById('et-text').value = t.text;
  document.getElementById('et-cat').value  = t.cat||'general';
  document.getElementById('et-pri').value  = t.pri||'medium';
  document.getElementById('et-due').value  = t.due||'';
  openModal('edit-modal');
}

function saveTaskEdit() {
  const text = document.getElementById('et-text').value.trim();
  if (!text) return;
  updateTask(editingTask.userId, editingTask.taskId, {
    text,
    cat: document.getElementById('et-cat').value,
    pri: document.getElementById('et-pri').value,
    due: document.getElementById('et-due').value,
  });
  closeModal('edit-modal');
  toast('MISSION UPDATED');
  navigate('user','tasks');
}

function setTaskFilter(f) { taskFilter=f; navigate('user','tasks'); }

function clearUserNotifs() {
  const u = currentUser();
  updateUser(u.id, {notifications:[]});
  navigate('user','notifs');
}

async function changePassword() {
  const cur = document.getElementById('pw-cur').value;
  const nw  = document.getElementById('pw-new').value;
  if (nw.length < 6) { toast('Min 6 characters','err'); return; }
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: { currentPassword: cur, newPassword: nw }
    });
    toast('PASSWORD UPDATED');
  } catch (err) {
    toast(err.message || 'Unable to change password', 'err');
  }
}

/* ══════════════════════════════════════════════
   MODAL HELPERS
══════════════════════════════════════════════ */
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id){ document.getElementById(id).classList.remove('open'); }

/* ══════════════════════════════════════════════
   TOAST
══════════════════════════════════════════════ */
let toastTimer;
function toast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type==='err' ? 'err show' : 'show';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.className='',2200);
}

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */
function showErr(id,msg) {
  const el=document.getElementById(id);
  if(el){el.textContent=msg;el.style.display='block';}
}
function showSuccess(id,msg) {
  const el=document.getElementById(id);
  if(el){el.textContent=msg;el.style.display='block';}
}
function fmtDate(iso) {
  if(!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
function fmtDateFull(iso) {
  if(!iso) return '—';
  return new Date(iso).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
function escHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function updateNotifBadges() {
  const u = currentUser();
  if (!u) return;
  const cnt = unreadCount(u.id);
  document.querySelectorAll('.notif-count').forEach(el=>{ el.textContent=cnt; el.style.display=cnt?'flex':'none'; });
  // Nav badges in sidebar
  document.querySelectorAll('.nav-badge').forEach(el => el.remove());
  if (u.role === 'admin') {
    const pending = DB.users.filter(x=>x.status==='pending').length;
    document.querySelectorAll('.nav-item').forEach(el => {
      const txt = el.textContent.trim();
      if (txt.includes('Agents') && pending) el.insertAdjacentHTML('beforeend',`<span class="nav-badge">${pending}</span>`);
      if (txt.includes('Notifications') && cnt) el.insertAdjacentHTML('beforeend',`<span class="nav-badge">${cnt}</span>`);
    });
  } else {
    document.querySelectorAll('.nav-item').forEach(el => {
      const txt = el.textContent.trim();
      if (txt.includes('Notifications') && cnt) el.insertAdjacentHTML('beforeend',`<span class="nav-badge">${cnt}</span>`);
    });
  }
}

/* ══════════════════════════════════════════════
   STARFIELD
══════════════════════════════════════════════ */
(function(){
  const c=document.getElementById('star-canvas');
  const ctx=c.getContext('2d');
  let W,H,stars=[];
  function resize(){W=c.width=innerWidth;H=c.height=innerHeight;}
  window.addEventListener('resize',resize); resize();
  for(let i=0;i<180;i++) stars.push({x:Math.random()*W,y:Math.random()*H,r:Math.random()*1.1+.2,a:Math.random(),spd:.0004+Math.random()*.0005,drift:(Math.random()-.5)*.04});
  function draw(){
    ctx.clearRect(0,0,W,H);
    stars.forEach(s=>{
      s.a+=s.spd; s.x+=s.drift;
      if(s.x<0)s.x=W; if(s.x>W)s.x=0;
      const al=.3+.7*Math.abs(Math.sin(s.a));
      ctx.beginPath(); ctx.arc(s.x,s.y,s.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(0,245,255,${al})`; ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  draw();
})();

/* ══════════════════════════════════════════════
   CUSTOM CURSOR
══════════════════════════════════════════════ */
(function(){
  const dot=document.getElementById('c-dot');
  const ring=document.getElementById('c-ring');
  let rx=0,ry=0,mx=0,my=0;
  document.addEventListener('mousemove',e=>{mx=e.clientX;my=e.clientY;dot.style.left=mx+'px';dot.style.top=my+'px';});
  function anim(){rx+=(mx-rx)*.12;ry+=(my-ry)*.12;ring.style.left=rx+'px';ring.style.top=ry+'px';requestAnimationFrame(anim);}
  anim();
  document.addEventListener('mousedown',()=>{ring.style.width='20px';ring.style.height='20px';});
  document.addEventListener('mouseup',()=>{ring.style.width='32px';ring.style.height='32px';});
  document.addEventListener('mouseover',e=>{
    if(e.target.matches('button,a,input,select,textarea,.nav-item,.task-item,.task-check,.act-btn,.notif-btn,.team-task-row')){
      ring.style.width='44px';ring.style.height='44px';ring.style.borderColor='var(--purple)';
    }
  });
  document.addEventListener('mouseout',e=>{
    if(e.target.matches('button,a,input,select,textarea,.nav-item,.task-item,.task-check,.act-btn,.notif-btn,.team-task-row')){
      ring.style.width='32px';ring.style.height='32px';ring.style.borderColor='var(--cyan)';
    }
  });
})();

/* ══════════════════════════════════════════════
   CLOSE MODALS ON OVERLAY CLICK
══════════════════════════════════════════════ */
document.querySelectorAll('.modal-overlay').forEach(el=>{
  el.addEventListener('click',e=>{ if(e.target===el) el.classList.remove('open'); });
});

/* ══════════════════════════════════════════════
   BOOT — runs from workspace.js after collaborators load
══════════════════════════════════════════════ */
