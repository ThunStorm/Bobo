const crypto = require("node:crypto");

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return {
    salt,
    passwordHash: crypto.scryptSync(password, salt, 64).toString("hex")
  };
}

function verifyPassword(password, user) {
  if (!user.salt || !user.passwordHash) return false;
  const actual = crypto.scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.passwordHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createAuth(store) {
  const sessions = new Map();

  function loadDoc() {
    return store.readJson(store.usersFile, { users: [] });
  }

  function saveDoc(doc) {
    store.atomicWriteJson(store.usersFile, doc);
    store.touch();
  }

  function normalizeUsername(value) {
    return String(value || "").trim().toLocaleLowerCase("en-US");
  }

  function validateCredentials(input) {
    const username = normalizeUsername(input.username);
    const displayName = String(input.displayName || input.username || "").trim();
    const password = String(input.password || "");
    if (!/^[^\s]{2,32}$/.test(username)) throw new Error("用户名须为 2-32 个非空白字符");
    if (!displayName || displayName.length > 40) throw new Error("显示名须为 1-40 个字符");
    if (password.length < 6) throw new Error("密码至少需要 6 位");
    return { username, displayName, password };
  }

  function needsSetup() {
    return loadDoc().users.length === 0;
  }

  function setup(input) {
    const doc = loadDoc();
    if (doc.users.length) {
      const error = new Error("系统已经完成初始化");
      error.code = "ALREADY_SETUP";
      throw error;
    }
    const credentials = validateCredentials(input);
    const password = hashPassword(credentials.password);
    const timestamp = new Date().toISOString();
    const user = {
      id: `user-${crypto.randomUUID()}`,
      username: credentials.username,
      displayName: credentials.displayName,
      role: "admin",
      active: true,
      ...password,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    doc.users.push(user);
    saveDoc(doc);
    return publicUser(user);
  }

  function login(username, password) {
    const doc = loadDoc();
    const normalized = normalizeUsername(username);
    const user = doc.users.find((item) => normalizeUsername(item.username) === normalized);
    if (!user || !user.active || !verifyPassword(String(password || ""), user)) {
      const error = new Error("用户名或密码错误");
      error.code = "AUTH_FAILED";
      throw error;
    }
    return createSession(user);
  }

  function createSession(user) {
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
    return { token, user: publicUser(user) };
  }

  function destroySession(req) {
    const token = parseCookies(req).bobo_session;
    if (token) sessions.delete(token);
  }

  function getUser(req) {
    const token = parseCookies(req).bobo_session;
    if (!token) return null;
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      return null;
    }
    const user = loadDoc().users.find((item) => item.id === session.userId);
    if (!user || !user.active) {
      sessions.delete(token);
      return null;
    }
    return publicUser(user);
  }

  function listUsers() {
    return loadDoc().users.map(publicUser);
  }

  function findUser(userId) {
    return loadDoc().users.find((item) => item.id === userId) || null;
  }

  function assertAssignee(userId) {
    if (!userId) return;
    const user = findUser(userId);
    if (!user || !user.active) throw new Error("负责人账户不存在或已停用");
  }

  function createUser(input) {
    const doc = loadDoc();
    const credentials = validateCredentials(input);
    if (doc.users.some((item) => normalizeUsername(item.username) === credentials.username)) {
      throw new Error("用户名已存在");
    }
    const timestamp = new Date().toISOString();
    const user = {
      id: `user-${crypto.randomUUID()}`,
      username: credentials.username,
      displayName: credentials.displayName,
      role: input.role === "admin" ? "admin" : "member",
      active: true,
      ...hashPassword(credentials.password),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    doc.users.push(user);
    saveDoc(doc);
    return publicUser(user);
  }

  function updateUser(userId, input, actorUserId) {
    const doc = loadDoc();
    const user = doc.users.find((item) => item.id === userId);
    if (!user) {
      const error = new Error("账户不存在");
      error.code = "NOT_FOUND";
      throw error;
    }

    const nextRole = input.role === "admin" || input.role === "member" ? input.role : user.role;
    const nextActive = typeof input.active === "boolean" ? input.active : user.active;
    const removesAdmin = user.role === "admin" && user.active && (nextRole !== "admin" || !nextActive);
    if (removesAdmin) {
      const activeAdmins = doc.users.filter((item) => item.role === "admin" && item.active);
      if (activeAdmins.length <= 1) throw new Error("不能停用或降级最后一名管理员");
    }
    if (user.id === actorUserId && !nextActive) throw new Error("不能停用当前登录账户");

    if (input.displayName != null) {
      const displayName = String(input.displayName).trim();
      if (!displayName || displayName.length > 40) throw new Error("显示名须为 1-40 个字符");
      user.displayName = displayName;
    }
    user.role = nextRole;
    user.active = nextActive;
    if (input.password != null && String(input.password).length) {
      if (String(input.password).length < 6) throw new Error("密码至少需要 6 位");
      Object.assign(user, hashPassword(String(input.password)));
    }
    user.updatedAt = new Date().toISOString();
    saveDoc(doc);
    return publicUser(user);
  }

  function changePassword(userId, currentPassword, nextPassword) {
    const doc = loadDoc();
    const user = doc.users.find((item) => item.id === userId);
    if (!user || !verifyPassword(String(currentPassword || ""), user)) throw new Error("当前密码错误");
    if (String(nextPassword || "").length < 6) throw new Error("新密码至少需要 6 位");
    Object.assign(user, hashPassword(String(nextPassword)));
    user.updatedAt = new Date().toISOString();
    saveDoc(doc);
    for (const [token, session] of sessions) {
      if (session.userId === userId) sessions.delete(token);
    }
  }

  function cookieHeader(token) {
    return `bobo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
  }

  function clearCookieHeader() {
    return "bobo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
  }

  return {
    needsSetup,
    setup,
    login,
    destroySession,
    getUser,
    listUsers,
    assertAssignee,
    createUser,
    updateUser,
    changePassword,
    cookieHeader,
    clearCookieHeader,
    publicUser
  };
}

module.exports = { createAuth, hashPassword, verifyPassword, SESSION_TTL_MS };
