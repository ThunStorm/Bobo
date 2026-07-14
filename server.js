const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createDataStore } = require("./lib/data-store");
const { createAuth } = require("./lib/auth");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const dataDir = process.env.BOBO_DATA_DIR ? path.resolve(process.env.BOBO_DATA_DIR) : path.join(rootDir, "data");
const port = Number(process.env.PORT || 4177);
const host = process.env.HOST || "0.0.0.0";
const shouldOpen = !process.argv.includes("--no-open");
const store = createDataStore(dataDir);
const auth = createAuth(store);

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

function statusForError(error) {
  if (error.code === "AUTH_FAILED") return 401;
  if (error.code === "FORBIDDEN") return 403;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "ALREADY_SETUP" || error.code === "REVISION_CONFLICT" || error.code === "VERSION_CONFLICT") return 409;
  return 400;
}

function publicBootstrap(user) {
  return {
    user,
    users: auth.listUsers(),
    state: store.composeState(),
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

  if (url.pathname === "/api/auth/setup" && req.method === "POST") {
    const input = await readBody(req);
    const user = auth.setup(input);
    const session = auth.login(user.username, input.password);
    sendJson(res, 201, { user }, { "Set-Cookie": auth.cookieHeader(session.token) });
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

  if (url.pathname === "/api/auth/password" && req.method === "POST") {
    const input = await readBody(req);
    auth.changePassword(user.id, input.currentPassword, input.nextPassword);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": auth.clearCookieHeader() });
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
    sendJson(res, 200, store.composeState());
    return true;
  }

  if (url.pathname === "/api/state" && req.method === "PUT") {
    const input = await readBody(req);
    const nextState = input.state || input;
    const expectedRevision = input.state ? input.revision : null;
    if (user.role !== "admin" && store.hasDeletion(store.composeState(), nextState)) {
      sendJson(res, 403, { error: "删除项目、需求或阶段仅限管理员" });
      return true;
    }
    const meta = store.saveState(nextState, expectedRevision, user.id);
    sendJson(res, 200, { ok: true, revision: meta.revision, state: store.composeState() });
    return true;
  }

  if (url.pathname === "/api/users" && req.method === "GET") {
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

  const issueMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/issues(?:\/([^/]+))?(?:\/(close|reopen))?$/);
  if (issueMatch) {
    const projectId = decodeURIComponent(issueMatch[1]);
    const issueId = issueMatch[2] ? decodeURIComponent(issueMatch[2]) : "";
    const action = issueMatch[3] || "";
    const input = ["POST", "PATCH"].includes(req.method) ? await readBody(req) : {};

    if (!issueId && req.method === "POST") {
      auth.assertAssignee(input.assigneeUserId);
      sendJson(res, 201, store.createIssue(projectId, input, user.id));
      return true;
    }
    if (issueId && !action && req.method === "PATCH") {
      auth.assertAssignee(input.assigneeUserId);
      sendJson(res, 200, store.updateIssue(projectId, issueId, input, user.id));
      return true;
    }
    if (issueId && action && req.method === "POST") {
      sendJson(res, 200, store.setIssueClosed(projectId, issueId, action === "close", user.id, input.version));
      return true;
    }
    if (issueId && !action && req.method === "DELETE") {
      assertAdmin(user);
      sendJson(res, 200, { ok: true, revision: store.deleteIssue(projectId, issueId).revision });
      return true;
    }
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
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
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
      revision: error.revision,
      entity: error.entity
    });
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    const localUrl = `http://localhost:${port}`;
    console.log(`Bobo is already running on port ${port}.`);
    console.log(`Opening existing app at ${localUrl}`);
    if (shouldOpen) openBrowser(localUrl);
    process.exit(0);
  }
  console.error(`Bobo failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  const localUrl = `http://localhost:${port}`;
  printStartupUrls(localUrl);
  if (shouldOpen) openBrowser(localUrl);
});
