const path = require("path");
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo").default || require("connect-mongo");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/nexus";

/* ═══════════════════════════════════════════════════════════
   ALLOWED ORIGINS  –  edit to match your deployed domains
═══════════════════════════════════════════════════════════ */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((s) => s.trim());

/* ═══════════════════════════════════════════════════════════
   VALIDATION HELPERS
═══════════════════════════════════════════════════════════ */
const USERNAME_RE = /^[a-zA-Z0-9_\-]{1,64}$/;
const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const VALID_TASK_STATUSES = new Set(["todo", "in_progress", "done"]);
const VALID_PRIORITIES    = new Set(["low", "medium", "high"]);
const VALID_ROLES         = new Set(["employee", "team_lead", "manager", "admin"]);
const VALID_STATUSES      = new Set(["pending", "active", "rejected", "banned"]);

/* ═══════════════════════════════════════════════════════════
   SCHEMAS
═══════════════════════════════════════════════════════════ */

// ── Personal task (stored inside User.tasks[]) ─────────────
// Fields: id, text, done, cat, pri, due, created
// All fields used in renderUserTasks / addTaskToUser.

const userSchema = new mongoose.Schema(
  {
    id:            { type: String, required: true, unique: true, index: true },
    username:      { type: String, required: true, unique: true, index: true },
    email:         { type: String, required: true, unique: true, index: true },
    password_hash: { type: String, required: true },
    role:          { type: String, required: true, default: "employee", enum: [...VALID_ROLES] },
    status:        { type: String, required: true, default: "pending",  enum: [...VALID_STATUSES] },
    created:       { type: String, required: true },

    // ── Personal tasks (My Missions panel) ──────────────────
    tasks: {
      type: [
        {
          id:      { type: String, required: true },   // FIX: always a string (was float)
          text:    { type: String, required: true },
          done:    { type: Boolean, default: false },
          cat:     { type: String, default: "general", enum: ["general","work","personal","health","urgent"] },
          pri:     { type: String, default: "medium",  enum: ["low","medium","high"] },
          due:     { type: String, default: "" },       // ISO date string or ""
          created: { type: String, required: true }
        }
      ],
      default: []
    },

    // ── In-app notifications ─────────────────────────────────
    notifications: {
      type: [
        {
          id:    { type: String, required: true },      // FIX: always a string
          icon:  { type: String, default: "📌" },
          title: { type: String, required: true },
          msg:   { type: String, required: true },
          read:  { type: Boolean, default: false },
          time:  { type: String, required: true }       // ISO timestamp
        }
      ],
      default: []
    }
  },
  { versionKey: false }
);

// ── Global collaboration state ────────────────────────────
// Everything that appears in the Workspace, Manager, Team lead,
// and Employee panels lives here as subdocuments.

const teamSchema = new mongoose.Schema(
  {
    id:         { type: String, required: true },
    name:       { type: String, required: true },
    department: { type: String, default: "" },
    managerId:  { type: String, default: null },        // userId of assigned manager
    created:    { type: String, required: true }
  },
  { _id: false }
);

const teamRoleSchema = new mongoose.Schema(
  {
    id:          { type: String, required: true },
    teamId:      { type: String, required: true },
    name:        { type: String, required: true },
    permissions: { type: [String], default: [] }        // e.g. ["chat","view_tasks","comment_tasks"]
  },
  { _id: false }
);

const teamMembershipSchema = new mongoose.Schema(
  {
    id:         { type: String, required: true },       // composite: `${teamId}:${userId}`
    teamId:     { type: String, required: true },
    userId:     { type: String, required: true },
    teamRoleId: { type: String, required: true },
    created:    { type: String, required: true }
  },
  { _id: false }
);

// ── Task comment sub-document ────────────────────────────
const taskCommentSchema = new mongoose.Schema(
  {
    id:      { type: String, required: true },
    userId:  { type: String, required: true },
    html:    { type: String, default: "" },             // sanitized HTML
    created: { type: String, required: true }
  },
  { _id: false }
);

// ── Manager note sub-document ────────────────────────────
const managerNoteSchema = new mongoose.Schema(
  {
    id:      { type: String, required: true },
    userId:  { type: String, required: true },
    text:    { type: String, default: "" },
    created: { type: String, required: true }
  },
  { _id: false }
);

// ── Team task (workspace board) ──────────────────────────
// Used by: wsCreateTeamTaskWithFiles, renderManagerBoard,
//          renderAssigneeInbox, renderLeadPipeline, openTeamTaskModal
const teamTaskSchema = new mongoose.Schema(
  {
    id:              { type: String, required: true },
    teamId:          { type: String, required: true },
    title:           { type: String, required: true },
    descriptionHtml: { type: String, default: "" },     // sanitized rich-text
    deadline:        { type: String, default: "" },     // ISO date string or ""
    priority:        { type: String, default: "medium", enum: ["low","medium","high"] },
    status:          { type: String, default: "todo",   enum: ["todo","in_progress","done"] },
    assignees:       { type: [String], default: [] },   // array of userId strings
    taggedUserIds:   { type: [String], default: [] },   // mentioned users
    attachments:     { type: [String], default: [] },   // reserved for future file URLs
    comments:        { type: [taskCommentSchema], default: [] },
    managerNotes:    { type: [managerNoteSchema], default: [] },
    createdBy:       { type: String, required: true },  // userId
    created:         { type: String, required: true }
  },
  { _id: false }
);

// ── Team chat message ────────────────────────────────────
// Used by: wsSendTeamChat, wsSendDm, renderChatPanel
const teamChatSchema = new mongoose.Schema(
  {
    id:          { type: String, required: true },
    teamId:      { type: String, required: true },
    channelType: { type: String, default: "group", enum: ["group", "dm"] },
    fromUserId:  { type: String, required: true },
    toUserId:    { type: String, default: null },       // only set for dm channelType
    text:        { type: String, required: true },
    created:     { type: String, required: true }
  },
  { _id: false }
);

// ── Activity log entry ────────────────────────────────────
// Used by: logActivity, renderActivityPanel
const activitySchema = new mongoose.Schema(
  {
    id:   { type: String, required: true },
    type: { type: String, required: true },             // e.g. "task_created", "member_added"
    msg:  { type: String, required: true },
    time: { type: String, required: true }
  },
  { _id: false }
);

// ── Announcement ──────────────────────────────────────────
// Used by: wsPostAnnouncement, renderAnnouncementsPanel
const announcementSchema = new mongoose.Schema(
  {
    id:      { type: String, required: true },
    title:   { type: String, default: "Broadcast" },
    msg:     { type: String, required: true },
    userId:  { type: String, required: true },          // author userId
    created: { type: String, required: true }
  },
  { _id: false }
);

// ── Root AppState document ────────────────────────────────
const stateSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, default: "global" },

    collab: {
      // Legacy flat arrays kept for migration compatibility
      tasks: { type: Array, default: [] },
      chat:  { type: Array, default: [] },

      // Typed sub-document arrays (the ones the UI actually reads/writes)
      teams:           { type: [teamSchema],           default: [] },
      teamRoles:       { type: [teamRoleSchema],       default: [] },
      teamMemberships: { type: [teamMembershipSchema], default: [] },
      teamTasks:       { type: [teamTaskSchema],       default: [] },
      teamChats:       { type: [teamChatSchema],       default: [] },
      activity:        { type: [activitySchema],       default: [] },
      announcements:   { type: [announcementSchema],   default: [] }
    }
  },
  { versionKey: false }
);

const User     = mongoose.model("User",     userSchema);
const AppState = mongoose.model("AppState", stateSchema);

/* ═══════════════════════════════════════════════════════════
   ROLE HELPERS
═══════════════════════════════════════════════════════════ */
function normalizeRole(role) {
  if (role === "user" || role === "moderator") return "employee";
  return role;
}

/* ═══════════════════════════════════════════════════════════
   EMPTY COLLAB FACTORY
═══════════════════════════════════════════════════════════ */
function createEmptyCollab() {
  return {
    tasks:           [],
    chat:            [],
    teams:           [],
    teamRoles:       [],
    teamMemberships: [],
    teamTasks:       [],
    teamChats:       [],
    activity:        [],
    announcements:   []
  };
}

/* ═══════════════════════════════════════════════════════════
   MIGRATION  –  legacy flat-array → team-scoped shape
═══════════════════════════════════════════════════════════ */
function migrateLegacyCollab(collab, users) {
  const base = { ...createEmptyCollab(), ...(collab || {}) };

  // If teams already exist, skip migration
  if (base.teams.length || base.teamTasks.length || base.teamChats.length) return base;

  const firstManager = users.find((u) => normalizeRole(u.role) === "manager");
  const teamId = "team-general";

  base.teams = [
    {
      id: teamId,
      name: "General Team",
      department: "",
      managerId: firstManager ? firstManager.id : null,
      created: new Date().toISOString()
    }
  ];

  base.teamRoles = [
    { id: "tr-manager", teamId, name: "Manager",
      permissions: ["manage_members", "manage_roles", "manage_tasks", "chat"] },
    { id: "tr-member",  teamId, name: "Member",
      permissions: ["chat", "view_tasks", "comment_tasks"] }
  ];

  base.teamMemberships = firstManager
    ? [{ id: `${teamId}:${firstManager.id}`, teamId,
         userId: firstManager.id, teamRoleId: "tr-manager",
         created: new Date().toISOString() }]
    : [];

  base.teamTasks = Array.isArray(base.tasks)
    ? base.tasks.map((t) => ({ ...t, teamId: t.teamId || teamId }))
    : [];

  base.teamChats = Array.isArray(base.chat)
    ? base.chat.map((m) => ({
        ...m,
        teamId: m.teamId || teamId,
        channelType: m.channelType || "group"
      }))
    : [];

  return base;
}

/* ═══════════════════════════════════════════════════════════
   DOCUMENT → PLAIN OBJECT
═══════════════════════════════════════════════════════════ */
function docToUser(doc) {
  return {
    id:            doc.id,
    username:      doc.username,
    email:         doc.email,
    role:          normalizeRole(doc.role),
    status:        doc.status,
    created:       doc.created,
    tasks:         doc.tasks         || [],
    notifications: doc.notifications || []
  };
}

/* ═══════════════════════════════════════════════════════════
   SEED DATA
═══════════════════════════════════════════════════════════ */
async function ensureSeedData() {
  const admin = await User.findOne({ id: "nexus-admin-root" }).lean();
  if (!admin) {
    await User.create({
      id:            "nexus-admin-root",
      username:      "admin",
      email:         "admin@nexus.io",
      password_hash: await bcrypt.hash("admin2077", 10),
      role:          "admin",
      status:        "active",
      created:       new Date().toISOString(),
      tasks:         [],
      notifications: []
    });
  }

  const state = await AppState.findOne({ id: "global" }).lean();
  if (!state) {
    await AppState.create({ id: "global", collab: createEmptyCollab() });
  }
}

/* ═══════════════════════════════════════════════════════════
   MIDDLEWARE
═══════════════════════════════════════════════════════════ */
app.use(express.json({ limit: "5mb" }));

// ── CORS  (strict origin whitelist) ──────────────────────
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ── Sessions ─────────────────────────────────────────────
app.use(
  session({
    secret:            process.env.SESSION_SECRET || "nexus-dev-secret-change-me",
    resave:            false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl:       MONGO_URI,
      collectionName: "sessions",
      ttl:            60 * 60 * 24 * 7
    }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      // Use explicit env var so staging can enable secure cookies independently of NODE_ENV
      secure:   process.env.COOKIE_SECURE === "true",
      maxAge:   1000 * 60 * 60 * 24 * 7
    }
  })
);

/* ═══════════════════════════════════════════════════════════
   AUTH GUARD
═══════════════════════════════════════════════════════════ */
async function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Not authenticated" });
  const user = await User.findOne({ id: req.session.userId });
  if (!user) {
    req.session.destroy(() => {});
    return res.status(401).json({ error: "Invalid session" });
  }
  req.authUser = docToUser(user);
  next();
}

/* ═══════════════════════════════════════════════════════════
   STATE LOADING
═══════════════════════════════════════════════════════════ */
async function loadState() {
  const userDocs = await User.find({}).sort({ created: 1 }).lean();
  const stateDoc = await AppState.findOne({ id: "global" }).lean();
  const users    = userDocs.map(docToUser);

  console.log(`[NEXUS:loadState] raw DB teams (${(stateDoc?.collab?.teams||[]).length}):`, JSON.stringify((stateDoc?.collab?.teams||[]).map(t=>({id:t.id,name:t.name}))));

  const collab   = migrateLegacyCollab(stateDoc?.collab || createEmptyCollab(), users);

  console.log(`[NEXUS:loadState] after migrateLegacyCollab teams (${(collab?.teams||[]).length}):`, JSON.stringify((collab?.teams||[]).map(t=>({id:t.id,name:t.name}))));

  return { users, collab };
}

/* ═══════════════════════════════════════════════════════════
   NORMALISE COLLAB BEFORE PERSIST
   – admin: full write
   – manager: only their own team scopes
   – others: collab ignored (only users array matters, and even
     that is admin-only — enforced in saveState)
═══════════════════════════════════════════════════════════ */
function normalizeCollabForPersist(collab, authUser, currentCollab) {
  const actorRole    = normalizeRole(authUser.role);

  console.log(`[NEXUS:normalizeCollabForPersist] actor=${authUser.id} role=${actorRole}`);
  console.log(`[NEXUS:normalizeCollabForPersist] incoming collab.teams (${(collab?.teams||[]).length}):`, JSON.stringify((collab?.teams||[]).map(t=>({id:t.id,name:t.name}))));
  console.log(`[NEXUS:normalizeCollabForPersist] currentCollab.teams  (${(currentCollab?.teams||[]).length}):`, JSON.stringify((currentCollab?.teams||[]).map(t=>({id:t.id,name:t.name}))));

  const next         = migrateLegacyCollab(collab, []);
  const current      = migrateLegacyCollab(currentCollab, []);

  console.log(`[NEXUS:normalizeCollabForPersist] after migrateLegacyCollab → next.teams (${next.teams.length}):`, JSON.stringify(next.teams.map(t=>({id:t.id,name:t.name}))));

  // Enforce server-side caps to prevent the 16 MB doc limit
  if (Array.isArray(next.teamChats)   && next.teamChats.length   > 500)  next.teamChats   = next.teamChats.slice(-500);
  if (Array.isArray(next.activity)    && next.activity.length    > 200)  next.activity    = next.activity.slice(0, 200);
  if (Array.isArray(next.announcements) && next.announcements.length > 200) next.announcements = next.announcements.slice(0, 200);

  // Validate task statuses and priorities coming from clients
  if (Array.isArray(next.teamTasks)) {
    next.teamTasks = next.teamTasks.map((t) => ({
      ...t,
      status:   VALID_TASK_STATUSES.has(t.status)   ? t.status   : "todo",
      priority: VALID_PRIORITIES.has(t.priority)    ? t.priority : "medium"
    }));
  }

  if (actorRole === "admin") {
    console.log(`[NEXUS:normalizeCollabForPersist] admin path before creating out object. next.teams length: ${(next.teams || []).length}`, JSON.stringify((next.teams || []).map(t=>({id:t.id,name:t.name}))));
    const out    = { ...createEmptyCollab(), ...next };
    out.tasks    = Array.isArray(out.teamTasks) ? out.teamTasks : [];
    out.chat     = Array.isArray(out.teamChats) ? out.teamChats : [];
    console.log(`[NEXUS:normalizeCollabForPersist] admin path → returning out.teams (${(out.teams || []).length}):`, JSON.stringify((out.teams || []).map(t=>({id:t.id,name:t.name}))));
    return out;
  }

  // Non-admin: only allow writes to teams where this user is the manager
  const currentTeams      = Array.isArray(current.teams) ? current.teams : [];
  const nextTeams         = Array.isArray(next.teams)    ? next.teams    : [];
  const nextTeamsById     = new Map(nextTeams.map((t) => [t.id, t]));
  const managedTeamIds    = new Set(
    currentTeams.filter((t) => t.managerId === authUser.id).map((t) => t.id)
  );

  const mergedTeams = currentTeams.map((t) => {
    if (!managedTeamIds.has(t.id)) return t;
    const incoming = nextTeamsById.get(t.id);
    if (!incoming) return t;
    return { ...t, name: incoming.name || t.name, department: incoming.department || "" };
  });

  const keepOrManaged = (arrCurrent, arrNext, key = "teamId") => {
    const c = Array.isArray(arrCurrent) ? arrCurrent : [];
    const n = Array.isArray(arrNext)    ? arrNext    : [];
    return c
      .filter((x) => !managedTeamIds.has(x[key]))
      .concat(n.filter((x) => managedTeamIds.has(x[key])));
  };

  const out = {
    ...createEmptyCollab(),
    ...current,
    activity:      Array.isArray(next.activity)      ? next.activity      : current.activity      || [],
    announcements: Array.isArray(next.announcements) ? next.announcements : current.announcements || [],
    teams:           mergedTeams,
    teamRoles:       keepOrManaged(current.teamRoles,       next.teamRoles),
    teamMemberships: keepOrManaged(current.teamMemberships, next.teamMemberships),
    teamTasks:       keepOrManaged(current.teamTasks,       next.teamTasks),
    teamChats:       keepOrManaged(current.teamChats,       next.teamChats)
  };
  out.tasks = out.teamTasks;
  out.chat  = out.teamChats;
  return out;
}

/* ═══════════════════════════════════════════════════════════
   STATE SAVING
═══════════════════════════════════════════════════════════ */
async function saveState(input, authUser) {
  const actorRole   = normalizeRole(authUser.role);
  const canEditUsers = actorRole === "admin";

  // ── User mutations (admin only) ───────────────────────────
  if (canEditUsers) {
    const incomingUsers  = Array.isArray(input.users) ? input.users : [];
    const incomingIds    = new Set(incomingUsers.map((u) => u.id));
    const existing       = await User.find({}).lean();
    const existingById   = new Map(existing.map((u) => [u.id, u]));

    for (const u of incomingUsers) {
      const role   = normalizeRole(u.role   || "employee");
      const status = u.status || "pending";

      // Validate role and status values coming from the client
      if (!VALID_ROLES.has(role))    continue;
      if (!VALID_STATUSES.has(status)) continue;

      const payload = {
        id:            u.id,
        username:      String(u.username || "").slice(0, 64),
        email:         String(u.email    || "").slice(0, 256),
        role,
        status,
        created:       u.created || new Date().toISOString(),
        tasks:         Array.isArray(u.tasks)         ? u.tasks         : [],
        notifications: Array.isArray(u.notifications) ? u.notifications : []
      };

      if (existingById.has(u.id)) {
        await User.updateOne({ id: u.id }, { $set: payload });
      } else {
        await User.create({
          ...payload,
          password_hash: await bcrypt.hash("changeme123", 10)
        });
      }
    }

    // Remove users that were deleted by admin (never remove the root admin)
    for (const u of existing) {
      if (u.id !== "nexus-admin-root" && !incomingIds.has(u.id)) {
        await User.deleteOne({ id: u.id });
      }
    }
  }

  // ── Collab state (all roles, scoped by normalizeCollabForPersist) ──
  const stateDoc       = await AppState.findOne({ id: "global" }).lean();
  console.log(`[NEXUS:saveState] incoming input.collab.teams length:`, (input.collab?.teams || []).length);
  const persistedCollab = normalizeCollabForPersist(
    input.collab,
    authUser,
    stateDoc?.collab || createEmptyCollab()
  );

  console.log(`[NEXUS:saveState] persistedCollab.teams BEFORE $set (${(persistedCollab.teams||[]).length}):`, JSON.stringify((persistedCollab.teams||[]).map(t=>({id:t.id,name:t.name}))));

  await AppState.updateOne(
    { id: "global" },
    { $set: { collab: persistedCollab } },
    { upsert: true }
  );

  // Verify what actually landed in the DB
  const verify = await AppState.findOne({ id: "global" }).lean();
  console.log(`[NEXUS:saveState] DB teams AFTER $set (${(verify?.collab?.teams||[]).length}):`, JSON.stringify((verify?.collab?.teams||[]).map(t=>({id:t.id,name:t.name}))));
}

/* ═══════════════════════════════════════════════════════════
   AUTH ROUTES
═══════════════════════════════════════════════════════════ */
app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }
  const user = await User.findOne({ username: String(username).trim() });
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  req.session.userId = user.id;
  res.json({ ok: true, user: docToUser(user) });
});

app.post("/api/auth/signup", async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: "All fields required" });
  }

  const u = String(username).trim();
  const e = String(email).trim().toLowerCase();

  // ── Input validation ──────────────────────────────────────
  if (!USERNAME_RE.test(u)) {
    return res.status(400).json({ error: "Username must be 1–64 alphanumeric/underscore/dash characters" });
  }
  if (!EMAIL_RE.test(e)) {
    return res.status(400).json({ error: "Invalid email address" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  if (String(password).length > 128) {
    return res.status(400).json({ error: "Password too long" });
  }

  if (await User.findOne({ username: u })) return res.status(409).json({ error: "Username already taken" });
  if (await User.findOne({ email: e }))    return res.status(409).json({ error: "Email already taken" });

  const id = "u-" + Date.now();
  await User.create({
    id,
    username:      u,
    email:         e,
    password_hash: await bcrypt.hash(password, 10),
    role:          "employee",
    status:        "pending",
    created:       new Date().toISOString(),
    tasks:         [],
    notifications: []
  });

  req.session.userId = id;
  res.json({ ok: true, userId: id });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/auth/session", async (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = await User.findOne({ id: req.session.userId });
  if (!user) return res.json({ user: null });
  res.json({ user: docToUser(user) });
});

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Both passwords are required" });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  if (String(newPassword).length > 128) {
    return res.status(400).json({ error: "Password too long" });
  }
  const user = await User.findOne({ id: req.authUser.id });
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(400).json({ error: "Wrong current password" });
  }
  user.password_hash = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   STATE ROUTES
═══════════════════════════════════════════════════════════ */
app.get("/api/state", requireAuth, async (req, res) => {
  res.json(await loadState());
});

app.put("/api/state", requireAuth, async (req, res) => {
  const state = req.body || {};
  if (typeof state.collab !== "object" || state.collab === null) {
    return res.status(400).json({ error: "Invalid state payload" });
  }
  // users field is optional (non-admins omit it)
  if (state.users !== undefined && !Array.isArray(state.users)) {
    return res.status(400).json({ error: "Invalid users payload" });
  }
  try {
    await saveState(state, req.authUser);
    res.json({ ok: true });
  } catch (err) {
    console.error("Error in PUT /api/state:", err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

/* ═══════════════════════════════════════════════════════════
   TASK STATUS ROUTE
   Handles wsAssigneeSetStatus / wsSetTeamTaskStatus calls that
   previously only updated client state but never actually
   persisted the status change to the DB reliably.
   The client still sends full state via PUT /api/state on debounce,
   but this dedicated endpoint lets you add optimistic DB writes
   in the future without refactoring the client.
═══════════════════════════════════════════════════════════ */
app.patch("/api/task/:taskId/status", requireAuth, async (req, res) => {
  const { taskId } = req.params;
  const { status, teamId } = req.body || {};

  if (!VALID_TASK_STATUSES.has(status)) {
    return res.status(400).json({ error: "Invalid status value" });
  }

  const stateDoc = await AppState.findOne({ id: "global" }).lean();
  if (!stateDoc) return res.status(404).json({ error: "State not found" });

  const collab    = stateDoc.collab || createEmptyCollab();
  const taskIndex = (collab.teamTasks || []).findIndex((t) => t.id === taskId);
  if (taskIndex < 0) return res.status(404).json({ error: "Task not found" });

  const task    = collab.teamTasks[taskIndex];
  const actorId = req.authUser.id;
  const role    = normalizeRole(req.authUser.role);

  // Permission: admin, or manager of this team, or an assignee
  const isManager  = (collab.teams || []).some((t) => t.id === task.teamId && t.managerId === actorId);
  const isAssignee = (task.assignees || []).includes(actorId);

  if (role !== "admin" && !isManager && !isAssignee) {
    return res.status(403).json({ error: "Not authorised to update this task" });
  }

  await AppState.updateOne(
    { id: "global", "collab.teamTasks.id": taskId },
    { $set: { "collab.teamTasks.$.status": status } }
  );

  res.json({ ok: true });
});

/* ═══════════════════════════════════════════════════════════
   STATIC FILES
═══════════════════════════════════════════════════════════ */
app.use(express.static(__dirname));
app.get("/{*any}", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ═══════════════════════════════════════════════════════════
   STARTUP
═══════════════════════════════════════════════════════════ */
async function start() {
  try {
    await mongoose.connect(MONGO_URI, {
      connectTimeoutMS:        10_000,
      serverSelectionTimeoutMS: 10_000
    });
    console.log("MongoDB connected:", MONGO_URI);
  } catch (err) {
    console.error("MongoDB initial connection failed:", err.message);
    process.exit(1);
  }

  // ── Post-startup connection event listeners ───────────────
  mongoose.connection.on("error", (err) => {
    console.error("MongoDB connection error:", err.message);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("MongoDB disconnected — attempting reconnect…");
  });

  mongoose.connection.on("reconnected", () => {
    console.log("MongoDB reconnected.");
  });

  await ensureSeedData();

  app.listen(PORT, () => {
    console.log(`NEXUS server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});