const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const dataDir = path.join(rootDir, "data");
const dataFile = path.join(dataDir, "projects.json");
const port = Number(process.env.PORT || 4177);
const host = process.env.HOST || "0.0.0.0";
const shouldOpen = !process.argv.includes("--no-open");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value, null, 2), {
    "Content-Type": "application/json; charset=utf-8"
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
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function ensureDataFile() {
  fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dataFile)) {
    fs.writeFileSync(dataFile, JSON.stringify({ projects: [] }, null, 2));
  }
}

function saveState(state) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmpFile = `${dataFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2));
  fs.renameSync(tmpFile, dataFile);
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

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "Not found", { "Content-Type": "text/plain; charset=utf-8" });
      return;
    }

    const type = contentTypes[path.extname(filePath)] || "application/octet-stream";
    send(res, 200, data, { "Content-Type": type });
  });
}

async function route(req, res) {
  if (req.url === "/api/state" && req.method === "GET") {
    ensureDataFile();
    const state = JSON.parse(fs.readFileSync(dataFile, "utf8"));
    sendJson(res, 200, state);
    return;
  }

  if (req.url === "/api/state" && req.method === "PUT") {
    try {
      const state = JSON.parse(await readBody(req));
      if (!state || !Array.isArray(state.projects)) {
        sendJson(res, 400, { error: "Invalid state: projects must be an array" });
        return;
      }
      saveState(state);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

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
      if (entry.family === "IPv4" && !entry.internal) {
        urls.push(`http://${entry.address}:${port}`);
      }
    }
  }
  return urls;
}

function printStartupUrls(localUrl) {
  console.log(`Bobo is running at ${localUrl}`);
  const lanUrls = getLanUrls();
  if (lanUrls.length) {
    console.log("LAN access:");
    for (const url of lanUrls) {
      console.log(`  ${url}`);
    }
  }
}

ensureDataFile();

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    sendJson(res, 500, { error: error.message });
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    const localUrl = `http://localhost:${port}`;
    console.log(`Bobo is already running on port ${port}.`);
    console.log(`Opening existing app at ${localUrl}`);
    if (shouldOpen) {
      openBrowser(localUrl);
    }
    process.exit(0);
  }

  console.error(`Bobo failed to start: ${error.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  const localUrl = `http://localhost:${port}`;
  printStartupUrls(localUrl);
  if (shouldOpen) {
    openBrowser(localUrl);
  }
});
