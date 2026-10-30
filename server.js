const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createDataStore } = require("./lib/data-store");
const { createAuth } = require("./lib/auth");
const { acquireDataLock } = require("./lib/data-lock");
const { sourceFingerprint, runtimeDiagnostics } = require("./lib/diagnostics");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const runtimeStarted = { at: new Date().toISOString(), source: sourceFingerprint(rootDir) };
const dataDir = process.env.BOBO_DATA_DIR ? path.resolve(process.env.BOBO_DATA_DIR) : path.join(rootDir, "data");
const port = Number(process.env.PORT || 4177);
const host = process.env.HOST || "0.0.0.0";
const shouldOpen = !process.argv.includes("--no-open");
const releaseDataLock = acquireDataLock(dataDir);
process.once("exit", releaseDataLock);
const store = createDataStore(dataDir);
const auth = createAuth(store);
try { store.cleanupAttachments(); } catch (error) { console.error(`附件启动清理失败：${error.message}`); }

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value, null, 2), {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4 * 1024 * 1024) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("请求内容不是有效 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function readAttachmentBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let oversized = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 50 * 1024 * 1024) {
        if (!oversized) { const error = new Error('单个附件最大 50 MiB'); error.code = 'PAYLOAD_TOO_LARGE'; reject(error); }
        oversized = true; chunks.length = 0;
      } else if (!oversized) chunks.push(chunk);
    });
    req.on('end', () => { if (!oversized) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('附件上传已中断')));
  });
}

function isLocalRequest(req) {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function assertAdmin(user) {
  if (user.role !== "admin") {
    const error = new Error("此操作仅限管理员");
    error.code = "FORBIDDEN";
    throw error;
  }
}

function notFound(message) {
  const error = new Error(message);
  error.code = "NOT_FOUND";
  return error;
}

function statusForError(error) {
  if (error.code === "PAYLOAD_TOO_LARGE") return 413;
  if (error.code === "AUTH_FAILED") return 401;
  if (error.code === "FORBIDDEN") return 403;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "ALREADY_SETUP" || error.code === "REVISION_CONFLICT" || error.code === "VERSION_CONFLICT") return 409;
  return 400;
}

function assertSystemAccess(user, systemId) {
  if (!auth.canAccessSystem(user, systemId)) {
    const error = new Error("无权访问该系统");
    error.code = "FORBIDDEN";
    throw error;
  }
}

function projectContext(user, projectId, state = store.composeState()) {
  for (const system of state.systems) {
    const project = (system.projects || []).find((item) => item.id === projectId);
    if (project) {
      assertSystemAccess(user, system.id);
      return { state, system, project };
    }
  }
  throw notFound("项目不存在");
}

function stateForUser(user, state = store.composeState()) {
  if (user.role === "admin") return state;
  const systems = state.systems.filter((system) => auth.canAccessSystem(user, system.id));
  return {
    ...state,
    systems,
    selectedSystemId: systems[0]?.id || "",
    selectedProjectId: systems[0]?.projects?.[0]?.id || ""
  };
}

function mergeScopedState(user, submitted) {
  if (user.role === "admin") return submitted;
  const current = store.composeState();
  const allowed = new Set(user.systemIds || []);
  if ((submitted.systems || []).some((system) => !allowed.has(system.id))) {
    const error = new Error("提交内容包含无权访问的系统");
    error.code = "FORBIDDEN";
    throw error;
  }
  const currentScoped = stateForUser(user, current);
  if (store.hasDeletion(currentScoped, submitted)) {
    const error = new Error("删除项目、需求或阶段仅限管理员");
    error.code = "FORBIDDEN";
    throw error;
  }
  const submittedById = new Map((submitted.systems || []).map((system) => [system.id, system]));
  return {
    ...submitted,
    systems: current.systems.map((system) => allowed.has(system.id) ? (submittedById.get(system.id) || system) : system)
  };
}

function resourcePayload(user, payload) {
  return { ...payload, state: stateForUser(user) };
}

function publicBootstrap(user) {
  return {
    user,
    users: auth.listUsers(),
    state: stateForUser(user),
    revision: store.getMeta().revision
  };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const rawPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    send(res, 403, "Forbidden", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }
    const type = contentTypes[path.extname(filePath)] || "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  });
}

function shutdownServer() {
  console.log("Bobo shutdown requested.");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

async function routeApi(req, res, url) {
  if (url.pathname === "/api/auth/status" && req.method === "GET") {
    sendJson(res, 200, { needsSetup: auth.needsSetup() });
    return true;
  }

  if (url.pathname === "/api/auth/choices" && req.method === "GET") {
    const systems = store.composeState().systems.map(({ id, name }) => ({ id, name }));
    sendJson(res, 200, { needsSetup: auth.needsSetup(), systems, users: auth.loginChoices() });
    return true;
  }

  if (url.pathname === "/api/auth/setup" && req.method === "POST") {
    const input = await readBody(req);
    const user = auth.setup(input);
    const session = auth.login(user.username, input.password);
    sendJson(res, 201, { user }, { "Set-Cookie": auth.cookieHeader(session.token) });
    return true;
  }

  if (url.pathname === "/api/auth/select" && req.method === "POST") {
    const input = await readBody(req);
    const session = auth.selectUser(input.userId, input.password);
    sendJson(res, 200, { user: session.user }, { "Set-Cookie": auth.cookieHeader(session.token) });
    return true;
  }

  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const input = await readBody(req);
    const session = auth.login(input.username, input.password);
    sendJson(res, 200, { user: session.user }, { "Set-Cookie": auth.cookieHeader(session.token) });
    return true;
  }

  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    auth.destroySession(req);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookieHeader() });
    return true;
  }

  const user = auth.getUser(req);
  if (!user) {
    sendJson(res, 401, { error: "请先登录", needsSetup: auth.needsSetup() });
    return true;
  }

  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    sendJson(res, 200, { user });
    return true;
  }

  if (url.pathname === "/api/users/me/avatar" && req.method === "PATCH") {
    const input = await readBody(req);
    const updated = auth.changeAvatar(user.id, input.avatarText);
    sendJson(res, 200, { user: updated, revision: store.getMeta().revision });
    return true;
  }

  if (url.pathname === "/api/auth/password" && req.method === "POST") {
    const input = await readBody(req);
    auth.changePassword(user.id, input.currentPassword, input.nextPassword);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookieHeader() });
    return true;
  }

  if (url.pathname === "/api/admin/diagnostics" && req.method === "GET") {
    assertAdmin(user);
    sendJson(res, 200, runtimeDiagnostics(rootDir, dataDir, runtimeStarted));
    return true;
  }

  if (url.pathname === "/api/bootstrap" && req.method === "GET") {
    sendJson(res, 200, publicBootstrap(user));
    return true;
  }

  if (url.pathname === "/api/revision" && req.method === "GET") {
    sendJson(res, 200, store.getMeta());
    return true;
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    sendJson(res, 200, stateForUser(user));
    return true;
  }

  if (url.pathname === "/api/state" && req.method === "PUT") {
    const input = await readBody(req);
    const submittedState = input.state || input;
    const expectedRevision = input.state ? input.revision : null;
    const nextState = mergeScopedState(user, submittedState);
    const meta = store.saveState(nextState, expectedRevision, user.id);
    sendJson(res, 200, { ok: true, revision: meta.revision, state: stateForUser(user) });
    return true;
  }

  if (url.pathname === "/api/systems" && req.method === "GET") {
    const visible = stateForUser(user);
    sendJson(res, 200, { systems: visible.systems, systemsVersion: visible.systemsVersion, revision: store.getMeta().revision });
    return true;
  }

  if (url.pathname === "/api/systems" && req.method === "POST") {
    assertAdmin(user);
    sendJson(res, 201, resourcePayload(user, store.createSystem(await readBody(req))));
    return true;
  }

  const systemMatch = url.pathname.match(/^\/api\/systems\/([^/]+)$/);
  if (systemMatch) {
    const systemId = decodeURIComponent(systemMatch[1]);
    const state = store.composeState();
    const system = state.systems.find((item) => item.id === systemId);
    if (!system) throw notFound("系统不存在");
    assertSystemAccess(user, systemId);
    if (req.method === "GET") {
      sendJson(res, 200, { system, revision: store.getMeta().revision, state: stateForUser(user, state) });
      return true;
    }
    if (req.method === "PATCH") {
      const input = await readBody(req);
      sendJson(res, 200, resourcePayload(user, store.updateSystem(systemId, input, input.version)));
      return true;
    }
    if (req.method === "DELETE") {
      assertAdmin(user);
      const input = await readBody(req);
      auth.assertSystemRemovalSafe(systemId);
      const payload = store.deleteSystem(systemId, input.version);
      auth.removeSystem(systemId);
      sendJson(res, 200, resourcePayload(user, payload));
      return true;
    }
  }

  const systemProjectsMatch = url.pathname.match(/^\/api\/systems\/([^/]+)\/projects$/);
  if (systemProjectsMatch) {
    const systemId = decodeURIComponent(systemProjectsMatch[1]);
    const state = store.composeState();
    const system = state.systems.find((item) => item.id === systemId);
    if (!system) throw notFound("系统不存在");
    assertSystemAccess(user, systemId);
    if (req.method === "GET") {
      sendJson(res, 200, { projects: system.projects, revision: store.getMeta().revision, state: stateForUser(user, state) });
      return true;
    }
    if (req.method === "POST") {
      const input = await readBody(req);
      sendJson(res, 201, resourcePayload(user, store.createProject(systemId, input, input.systemVersion)));
      return true;
    }
  }

  const projectMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectId = decodeURIComponent(projectMatch[1]);
    const { state, project } = projectContext(user, projectId);
    if (req.method === "GET") {
      sendJson(res, 200, { project, revision: store.getMeta().revision, state: stateForUser(user, state) });
      return true;
    }
    if (req.method === "PATCH") {
      const input = await readBody(req);
      input.actorUserId = user.id;
      sendJson(res, 200, resourcePayload(user, store.updateProject(projectId, input, input.version)));
      return true;
    }
    if (req.method === "DELETE") {
      assertAdmin(user);
      const input = await readBody(req);
      sendJson(res, 200, resourcePayload(user, store.deleteProject(projectId, input.systemVersion, input.version)));
      return true;
    }
  }

  const requirementCollectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/requirements$/);
  if (requirementCollectionMatch && req.method === "POST") {
    const projectId = decodeURIComponent(requirementCollectionMatch[1]);
    projectContext(user, projectId);
    const input = await readBody(req);
    input.actorUserId = user.id;
    sendJson(res, 201, resourcePayload(user, store.createRequirement(projectId, input)));
    return true;
  }

  const requirementMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/requirements\/([^/]+)$/);
  if (requirementMatch) {
    const projectId = decodeURIComponent(requirementMatch[1]);
    const requirementId = decodeURIComponent(requirementMatch[2]);
    projectContext(user, projectId);
    if (req.method === "PATCH") {
      const input = await readBody(req);
      input.actorUserId = user.id;
      sendJson(res, 200, resourcePayload(user, store.updateRequirement(projectId, requirementId, input)));
      return true;
    }
    if (req.method === "DELETE") {
      assertAdmin(user);
      const input = await readBody(req);
      sendJson(res, 200, resourcePayload(user, store.deleteRequirement(projectId, requirementId, input.projectVersion, input.version)));
      return true;
    }
  }

  const stageCollectionMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/requirements\/([^/]+)\/stages$/);
  if (stageCollectionMatch && req.method === "POST") {
    const projectId = decodeURIComponent(stageCollectionMatch[1]);
    const requirementId = decodeURIComponent(stageCollectionMatch[2]);
    projectContext(user, projectId);
    const input = await readBody(req);
    input.actorUserId = user.id;
    sendJson(res, 201, resourcePayload(user, store.createStage(projectId, requirementId, input)));
    return true;
  }

  const attachmentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/requirements\/([^/]+)\/stages\/([^/]+)\/attachments(?:\/([^/]+))?$/);
  if (attachmentMatch) {
    const [projectId, requirementId, stageId, attachmentId] = attachmentMatch.slice(1).map(value => value == null ? null : decodeURIComponent(value));
    projectContext(user, projectId);
    if (!attachmentId && req.method === 'GET') {
      sendJson(res, 200, store.listAttachments(projectId, requirementId, stageId)); return true;
    }
    if (!attachmentId && req.method === 'POST') {
      // Check existence and access before receiving the body, then check again after it arrives.
      store.listAttachments(projectId, requirementId, stageId);
      const buffer = await readAttachmentBody(req);
      projectContext(user, projectId);
      sendJson(res, 201, resourcePayload(user, store.addAttachment(projectId, requirementId, stageId, { filename: decodeURIComponent(req.headers['x-file-name'] || ''), version: req.headers['x-stage-version'] }, buffer, user.id))); return true;
    }
    if (attachmentId && req.method === 'GET') {
      const { record, file } = store.getAttachment(projectId, requirementId, stageId, attachmentId);
      const buffer = fs.readFileSync(file);
      send(res, 200, buffer, { 'Content-Type': 'application/octet-stream', 'Content-Length': buffer.length, 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(record.filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`, 'X-Content-Type-Options': 'nosniff' }); return true;
    }
  }

  const stageMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/requirements\/([^/]+)\/stages\/([^/]+)$/);
  if (stageMatch) {
    const projectId = decodeURIComponent(stageMatch[1]);
    const requirementId = decodeURIComponent(stageMatch[2]);
    projectContext(user, projectId);
    const stageId = decodeURIComponent(stageMatch[3]);
    if (req.method === "PATCH") {
      const input = await readBody(req);
      input.actorUserId = user.id;
      sendJson(res, 200, resourcePayload(user, store.updateStage(projectId, requirementId, stageId, input)));
      return true;
    }
    if (req.method === "DELETE") {
      assertAdmin(user);
      const input = await readBody(req);
      sendJson(res, 200, resourcePayload(user, store.deleteStage(projectId, requirementId, stageId, input.requirementVersion, input.version)));
      return true;
    }
  }

  if (url.pathname === "/api/users" && req.method === "GET") {
    assertAdmin(user);
    sendJson(res, 200, { users: auth.listUsers() });
    return true;
  }

  if (url.pathname === "/api/users" && req.method === "POST") {
    assertAdmin(user);
    const created = auth.createUser(await readBody(req));
    sendJson(res, 201, { user: created, revision: store.getMeta().revision });
    return true;
  }

  const userMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
  if (userMatch && req.method === "PATCH") {
    assertAdmin(user);
    const updated = auth.updateUser(decodeURIComponent(userMatch[1]), await readBody(req), user.id);
    sendJson(res, 200, { user: updated, revision: store.getMeta().revision });
    return true;
  }
  if (userMatch && req.method === "DELETE") {
    assertAdmin(user);
    const deleted = auth.deleteUser(decodeURIComponent(userMatch[1]), user.id);
    sendJson(res, 200, { user: deleted, revision: store.getMeta().revision });
    return true;
  }

  const issueMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/issues(?:\/([^/]+))?(?:\/(close|reopen))?$/);
  if (issueMatch) {
    const projectId = decodeURIComponent(issueMatch[1]);
    const issueId = issueMatch[2] ? decodeURIComponent(issueMatch[2]) : "";
    const action = issueMatch[3] || "";
    const { system } = projectContext(user, projectId);
    const input = ["POST", "PATCH", "DELETE"].includes(req.method) ? await readBody(req) : {};

    if (!issueId && req.method === "POST") {
      auth.assertAssignee(input.assigneeUserId, system.id);
      sendJson(res, 201, store.createIssue(projectId, input, user.id));
      return true;
    }
    if (issueId && !action && req.method === "PATCH") {
      auth.assertAssignee(input.assigneeUserId, system.id);
      sendJson(res, 200, store.updateIssue(projectId, issueId, input, user.id));
      return true;
    }
    if (issueId && action && req.method === "POST") {
      sendJson(res, 200, store.setIssueClosed(projectId, issueId, action === "close", user.id, input.version));
      return true;
    }
    if (issueId && !action && req.method === "DELETE") {
      assertAdmin(user);
      sendJson(res, 200, { ok: true, revision: store.deleteIssue(projectId, issueId, input.version).revision });
      return true;
    }
  }

  const commentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/issues\/([^/]+)\/comments$/);
  if (commentMatch && req.method === "POST") {
    const projectId = decodeURIComponent(commentMatch[1]);
    const issueId = decodeURIComponent(commentMatch[2]);
    projectContext(user, projectId);
    const input = await readBody(req);
    sendJson(res, 201, store.addIssueComment(projectId, issueId, input.body, user.id, input.version));
    return true;
  }

  if (url.pathname === "/api/shutdown" && req.method === "POST") {
    assertAdmin(user);
    if (!isLocalRequest(req)) {
      sendJson(res, 403, { error: "只能在运行 Bobo 的电脑上关闭服务" });
      return true;
    }
    sendJson(res, 200, { ok: true, message: "Bobo is shutting down" });
    setTimeout(shutdownServer, 100).unref();
    return true;
  }

  sendJson(res, 404, { error: "API endpoint not found" });
  return true;
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) return routeApi(req, res, url);
  serveStatic(req, res);
}

function openBrowser(url) {
  let child;
  if (process.platform === "win32") {
    child = spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
  } else if (process.platform === "darwin") {
    child = spawn("open", [url], { detached: true, stdio: "ignore" });
  }
  if (child) {
    const warn = () => console.warn(`无法自动打开浏览器，请手动访问 ${url}`);
    child.on("error", warn);
    child.on("exit", (code) => { if (code !== null && code !== 0) warn(); });
    child.unref();
  }
}

function getLanUrls() {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}

function printStartupUrls(localUrl) {
  console.log(`Bobo is running at ${localUrl}`);
  const lanUrls = getLanUrls();
  if (lanUrls.length) {
    console.log("LAN access:");
    for (const url of lanUrls) console.log(`  ${url}`);
  }
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error(error);
    sendJson(res, statusForError(error), {
      error: error.message,
      code: error.code,
      revision: error.revision || store.getMeta().revision,
      entity: error.entity,
      versionField: error.versionField
    });
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`端口 ${port} 已被占用，Bobo 未启动。请关闭原服务或设置其他 PORT 后重试。`);
    process.exit(1);
  }
  console.error(`Bobo failed to start: ${error.message}`);
  process.exit(1);
});

process.once("SIGINT", shutdownServer);
process.once("SIGTERM", shutdownServer);

server.listen(port, host, () => {
  const localUrl = `http://localhost:${port}`;
  printStartupUrls(localUrl);
  console.log(`Bobo source: ${runtimeStarted.source.id} | PID: ${process.pid} | data: ${dataDir}`);
  if (shouldOpen) openBrowser(localUrl);
});
