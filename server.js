const path = require("path");
require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStorePkg = require("connect-mongo");
const MongoStore = MongoStorePkg.default || MongoStorePkg.MongoStore;
console.log(MongoStore);
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/nexus";

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, unique: true, index: true },
    password_hash: { type: String, required: true },
    role: { type: String, required: true, default: "employee" },
    status: { type: String, required: true, default: "pending" },
    created: { type: String, required: true },
    tasks: { type: Array, default: [] },
    notifications: { type: Array, default: [] }
  },
  { versionKey: false }
);

const stateSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, default: "global" },
    collab: {
      tasks: { type: Array, default: [] },
      chat: { type: Array, default: [] },
      activity: { type: Array, default: [] },
      announcements: { type: Array, default: [] }
    }
  },
  { versionKey: false }
);

const User = mongoose.model("User", userSchema);
const AppState = mongoose.model("AppState", stateSchema);

function normalizeRole(role) {
  if (role === "user" || role === "moderator") return "employee";
  return role;
}

function docToUser(doc) {
  return {
    id: doc.id,
    username: doc.username,
    email: doc.email,
    role: normalizeRole(doc.role),
    status: doc.status,
    created: doc.created,
    tasks: doc.tasks || [],
    notifications: doc.notifications || []
  };
}

async function ensureSeedData() {
  const admin = await User.findOne({ id: "nexus-admin-root" }).lean();
  if (!admin) {
    await User.create({
      id: "nexus-admin-root",
      username: "admin",
      email: "admin@nexus.io",
      password_hash: await bcrypt.hash("admin2077", 10),
      role: "admin",
      status: "active",
      created: new Date().toISOString(),
      tasks: [],
      notifications: []
    });
  }
  const state = await AppState.findOne({ id: "global" }).lean();
  if (!state) {
    await AppState.create({
      id: "global",
      collab: { tasks: [], chat: [], activity: [], announcements: [] }
    });
  }
}

app.use(express.json({ limit: "5mb" }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(
  session({
    secret: process.env.SESSION_SECRET || "nexus-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: MONGO_URI,
      collectionName: "sessions",
      ttl: 60 * 60 * 24 * 7
    }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7
    }
  })
);

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

async function loadState() {
  const userDocs = await User.find({}).sort({ created: 1 });
  const stateDoc = await AppState.findOne({ id: "global" });
  return {
    users: userDocs.map(docToUser),
    collab: stateDoc?.collab || { tasks: [], chat: [], activity: [], announcements: [] }
  };
}

async function saveState(input) {
  const incomingUsers = Array.isArray(input.users) ? input.users : [];
  const incomingIds = new Set(incomingUsers.map((u) => u.id));

  const existing = await User.find({});
  const existingById = new Map(existing.map((u) => [u.id, u]));

  for (const u of incomingUsers) {
    const existingDoc = existingById.get(u.id);
    const payload = {
      id: u.id,
      username: u.username,
      email: u.email,
      role: normalizeRole(u.role || "employee"),
      status: u.status || "pending",
      created: u.created || new Date().toISOString(),
      tasks: u.tasks || [],
      notifications: u.notifications || []
    };
    if (existingDoc) {
      await User.updateOne({ id: u.id }, { $set: payload });
    } else {
      await User.create({
        ...payload,
        password_hash: await bcrypt.hash("changeme123", 10)
      });
    }
  }

  for (const u of existing) {
    if (u.id !== "nexus-admin-root" && !incomingIds.has(u.id)) {
      await User.deleteOne({ id: u.id });
    }
  }

  await AppState.updateOne(
    { id: "global" },
    {
      $set: {
        collab: {
          tasks: input.collab?.tasks || [],
          chat: input.collab?.chat || [],
          activity: input.collab?.activity || [],
          announcements: input.collab?.announcements || []
        }
      }
    },
    { upsert: true }
  );
}

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
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const u = String(username).trim();
  const e = String(email).trim();
  if (await User.findOne({ username: u })) return res.status(409).json({ error: "Username already taken" });
  if (await User.findOne({ email: e })) return res.status(409).json({ error: "Email already taken" });

  const id = "u-" + Date.now();
  await User.create({
    id,
    username: u,
    email: e,
    password_hash: await bcrypt.hash(password, 10),
    role: "employee",
    status: "pending",
    created: new Date().toISOString(),
    tasks: [],
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
  const user = await User.findOne({ id: req.authUser.id });
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    return res.status(400).json({ error: "Wrong current password" });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  user.password_hash = await bcrypt.hash(newPassword, 10);
  await user.save();
  res.json({ ok: true });
});

app.get("/api/state", requireAuth, async (req, res) => {
  res.json(await loadState());
});

app.put("/api/state", requireAuth, async (req, res) => {
  const state = req.body || {};
  if (!Array.isArray(state.users) || typeof state.collab !== "object" || state.collab === null) {
    return res.status(400).json({ error: "Invalid state payload" });
  }
  await saveState(state);
  res.json({ ok: true });
});

app.use(express.static(__dirname));
app.get("/{*any}", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

async function start() {
  await mongoose.connect(MONGO_URI);
  await ensureSeedData();
  app.listen(PORT, () => {
    console.log(`NEXUS server running on http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

