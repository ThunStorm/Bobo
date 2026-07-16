const crypto = require("node:crypto");

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const USERS_SCHEMA_VERSION = 2;

function avatarFrom(value) {
  return Array.from(String(value || "").trim())[0]?.toUpperCase() || "U";
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarText: user.avatarText,
    systemIds: [...(user.systemIds || [])],
    role: user.role,
    active: user.active,
    deletedAt: user.deletedAt || "",
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
  return { salt, passwordHash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function verifyPassword(password, user) {
  if (!user.salt || !user.passwordHash) return false;
  const actual = crypto.scryptSync(password, user.salt, 64);
  const expected = Buffer.from(user.passwordHash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createAuth(store) {
  const sessions = new Map();

  const currentSystemIds = () => store.composeState().systems.map((system) => system.id);
  const normalizeUsername = (value) => String(value || "").trim().toLocaleLowerCase("en-US");

  function validateIdentity(input) {
    const username = normalizeUsername(input.username);
    const displayName = String(input.displayName || input.username || "").trim();
    if (!/^[^\s]{2,32}$/.test(username)) throw new Error("用户名须为 2-32 个非空白字符");
    if (!displayName || displayName.length > 40) throw new Error("显示名须为 1-40 个字符");
    return { username, displayName };
  }

  function validatePassword(password) {
    const value = String(password || "");
    if (value.length < 4) throw new Error("管理员密码至少需要 4 位");
    return value;
  }

  function validateAvatar(value, fallback) {
    const avatar = String(value || "").trim() || avatarFrom(fallback);
    if (Array.from(avatar).length !== 1) throw new Error("头像须为一个字符");
    return avatar;
  }

  function validateSystemIds(value) {
    const available = new Set(currentSystemIds());
    const ids = [...new Set((Array.isArray(value) ? value : []).map(String))];
    if (!ids.length) throw new Error("普通账号至少需要关联一个系统");
    if (ids.some((id) => !available.has(id))) throw new Error("账户关联了不存在的系统");
    return ids;
  }

  function loadDoc() {
    const doc = store.readJson(store.usersFile, { schemaVersion: USERS_SCHEMA_VERSION, version: 1, users: [] });
    const allSystemIds = currentSystemIds();
    let changed = Number(doc.schemaVersion || 0) !== USERS_SCHEMA_VERSION || !Number(doc.version);
    doc.schemaVersion = USERS_SCHEMA_VERSION;
    doc.version = Number(doc.version || 1);
    doc.users = (doc.users || []).map((source) => {
      const role = source.role === "admin" ? "admin" : "member";
      const rawAvatar = String(source.avatarText || "").trim();
      const normalized = {
        ...source,
        username: normalizeUsername(source.username),
        displayName: String(source.displayName || source.username || "用户").trim(),
        avatarText: Array.from(rawAvatar).length === 1 ? rawAvatar : avatarFrom(source.displayName || source.username),
        systemIds: role === "admin"
          ? []
          : (Array.isArray(source.systemIds) ? source.systemIds.filter((id) => allSystemIds.includes(id)) : [...allSystemIds]),
        role,
        active: source.active !== false,
        deletedAt: String(source.deletedAt || "")
      };
      if (role === "member") {
        delete normalized.salt;
        delete normalized.passwordHash;
      }
      if (JSON.stringify(normalized) !== JSON.stringify(source)) changed = true;
      return normalized;
    });
    if (changed) store.atomicWriteJson(store.usersFile, doc);
    return doc;
  }

  function saveDoc(doc) {
    doc.schemaVersion = USERS_SCHEMA_VERSION;
    doc.version = Number(doc.version || 1) + 1;
    store.atomicWriteJson(store.usersFile, doc);
    store.touch();
  }

  const activeAdmins = (doc = loadDoc()) => doc.users.filter((user) => user.role === "admin" && user.active && !user.deletedAt);
  const needsSetup = () => activeAdmins().length === 0;

  function setup(input) {
    const doc = loadDoc();
    if (activeAdmins(doc).length) {
      const error = new Error("系统已经存在有效管理员");
      error.code = "ALREADY_SETUP";
      throw error;
    }
    const identity = validateIdentity(input);
    if (doc.users.some((user) => normalizeUsername(user.username) === identity.username && !user.deletedAt)) throw new Error("用户名已存在");
    const timestamp = new Date().toISOString();
    const user = {
      id: `user-${crypto.randomUUID()}`,
      ...identity,
      avatarText: validateAvatar(input.avatarText, identity.displayName),
      systemIds: [],
      role: "admin",
      active: true,
      deletedAt: "",
      ...hashPassword(validatePassword(input.password)),
      createdAt: timestamp,
      updatedAt: timestamp
    };
    doc.users.push(user);
    saveDoc(doc);
    return publicUser(user);
  }

  function createSession(user) {
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
    return { token, user: publicUser(user) };
  }

  function invalidateUserSessions(userId) {
    for (const [token, session] of sessions) {
      if (session.userId === userId) sessions.delete(token);
    }
  }

  function selectUser(userId, password = "") {
    const user = loadDoc().users.find((item) => item.id === String(userId || ""));
    if (!user || !user.active || user.deletedAt) {
      const error = new Error("账户不存在或已停用");
      error.code = "AUTH_FAILED";
      throw error;
    }
    if (user.role === "admin" && !verifyPassword(String(password || ""), user)) {
      const error = new Error("管理员密码错误");
      error.code = "AUTH_FAILED";
      throw error;
    }
    return createSession(user);
  }

  function login(username, password) {
    const normalized = normalizeUsername(username);
    const user = loadDoc().users.find((item) => normalizeUsername(item.username) === normalized);
    if (!user || user.role !== "admin" || !user.active || user.deletedAt || !verifyPassword(String(password || ""), user)) {
      const error = new Error("用户名或密码错误");
      error.code = "AUTH_FAILED";
      throw error;
    }
    return createSession(user);
  }

  function loginChoices() {
    return loadDoc().users.filter((user) => user.active && !user.deletedAt).map((user) => ({
      id: user.id,
      displayName: user.displayName,
      avatarText: user.avatarText,
      requiresPassword: user.role === "admin"
    }));
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
      sessions.delete(token);
      return null;
    }
    const user = loadDoc().users.find((item) => item.id === session.userId);
    if (!user || !user.active || user.deletedAt) {
      sessions.delete(token);
      return null;
    }
    return publicUser(user);
  }

  const listUsers = () => loadDoc().users.map(publicUser);
  const findUser = (userId) => loadDoc().users.find((item) => item.id === userId) || null;
  const canAccessSystem = (user, systemId) => Boolean(user && (user.role === "admin" || (user.systemIds || []).includes(systemId)));

  function assertAssignee(userId, systemId) {
    if (!userId) return;
    const user = findUser(userId);
    if (!user || !user.active || user.deletedAt || !canAccessSystem(publicUser(user), systemId)) {
      throw new Error("负责人账户不存在、已停用或未关联当前系统");
    }
  }

  function createUser(input) {
    const doc = loadDoc();
    const identity = validateIdentity(input);
    if (doc.users.some((user) => normalizeUsername(user.username) === identity.username && !user.deletedAt)) throw new Error("用户名已存在");
    const role = input.role === "admin" ? "admin" : "member";
    const timestamp = new Date().toISOString();
    const user = {
      id: `user-${crypto.randomUUID()}`,
      ...identity,
      avatarText: validateAvatar(input.avatarText, identity.displayName),
      systemIds: role === "admin" ? [] : validateSystemIds(input.systemIds),
      role,
      active: true,
      deletedAt: "",
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (role === "admin") Object.assign(user, hashPassword(validatePassword(input.password)));
    doc.users.push(user);
    saveDoc(doc);
    return publicUser(user);
  }

  function updateUser(userId, input, actorUserId) {
    const doc = loadDoc();
    const user = doc.users.find((item) => item.id === userId && !item.deletedAt);
    if (!user) {
      const error = new Error("账户不存在");
      error.code = "NOT_FOUND";
      throw error;
    }
    const previousRole = user.role;
    const nextRole = input.role === "admin" || input.role === "member" ? input.role : user.role;
    const nextActive = typeof input.active === "boolean" ? input.active : user.active;
    if (previousRole === "admin" && user.active && (nextRole !== "admin" || !nextActive) && activeAdmins(doc).length <= 1) {
      throw new Error("不能停用或降级最后一名管理员");
    }
    if (user.id === actorUserId && !nextActive) throw new Error("不能停用当前登录账户");
    if (input.displayName != null) {
      const displayName = String(input.displayName).trim();
      if (!displayName || displayName.length > 40) throw new Error("显示名须为 1-40 个字符");
      user.displayName = displayName;
    }
    if (input.avatarText != null) user.avatarText = validateAvatar(input.avatarText, user.displayName);
    user.role = nextRole;
    user.active = nextActive;
    if (nextRole === "admin") {
      user.systemIds = [];
      if (previousRole !== "admin" || !user.passwordHash) Object.assign(user, hashPassword(validatePassword(input.password)));
      else if (String(input.password || "")) Object.assign(user, hashPassword(validatePassword(input.password)));
    } else {
      user.systemIds = validateSystemIds(input.systemIds ?? user.systemIds);
      delete user.salt;
      delete user.passwordHash;
    }
    user.updatedAt = new Date().toISOString();
    saveDoc(doc);
    if (!user.active) invalidateUserSessions(user.id);
    return publicUser(user);
  }

  function deleteUser(userId, actorUserId) {
    const doc = loadDoc();
    const user = doc.users.find((item) => item.id === userId && !item.deletedAt);
    if (!user) {
      const error = new Error("账户不存在");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (user.id === actorUserId) throw new Error("不能删除当前登录账户");
    if (user.role === "admin" && user.active && activeAdmins(doc).length <= 1) throw new Error("不能删除最后一名管理员");
    user.active = false;
    user.deletedAt = new Date().toISOString();
    user.systemIds = [];
    user.updatedAt = user.deletedAt;
    saveDoc(doc);
    invalidateUserSessions(user.id);
    return publicUser(user);
  }

  function changeAvatar(userId, avatarText) {
    const doc = loadDoc();
    const user = doc.users.find((item) => item.id === userId && !item.deletedAt);
    if (!user) throw new Error("账户不存在");
    user.avatarText = validateAvatar(avatarText, user.displayName);
    user.updatedAt = new Date().toISOString();
    saveDoc(doc);
    return publicUser(user);
  }

  function changePassword(userId, currentPassword, nextPassword) {
    const doc = loadDoc();
    const user = doc.users.find((item) => item.id === userId);
    if (!user || user.role !== "admin" || !verifyPassword(String(currentPassword || ""), user)) throw new Error("当前密码错误");
    Object.assign(user, hashPassword(validatePassword(nextPassword)));
    user.updatedAt = new Date().toISOString();
    saveDoc(doc);
    invalidateUserSessions(userId);
  }

  function assertSystemRemovalSafe(systemId) {
    const blocking = loadDoc().users.filter((user) => user.role === "member" && user.active && !user.deletedAt && user.systemIds?.includes(systemId) && user.systemIds.length === 1);
    if (blocking.length) throw new Error(`请先为以下账户分配其他系统：${blocking.map((user) => user.displayName).join("、")}`);
  }

  function removeSystem(systemId) {
    const doc = loadDoc();
    let changed = false;
    for (const user of doc.users) {
      const next = (user.systemIds || []).filter((id) => id !== systemId);
      if (next.length !== (user.systemIds || []).length) {
        user.systemIds = next;
        user.updatedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) saveDoc(doc);
  }

  const cookieHeader = (token) => `bobo_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
  const clearCookieHeader = () => "bobo_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";

  return {
    needsSetup, setup, login, selectUser, loginChoices, destroySession, getUser, listUsers, findUser,
    canAccessSystem, assertAssignee, createUser, updateUser, deleteUser, changeAvatar, changePassword,
    assertSystemRemovalSafe, removeSystem, cookieHeader, clearCookieHeader, publicUser
  };
}

module.exports = { createAuth, hashPassword, verifyPassword, SESSION_TTL_MS, USERS_SCHEMA_VERSION };