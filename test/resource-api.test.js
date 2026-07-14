const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bobo-${name}-`));
  return dir;
}

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function startServer() {
  const dataDir = tempDir("api");
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "server.js"), "--no-open"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, BOBO_DATA_DIR: dataDir, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes("Bobo is running at")) {
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== null) reject(new Error(`test server exited with ${code}: ${output}`));
    });
    setTimeout(() => reject(new Error(`test server did not start: ${output}`)), 5000).unref();
  });
  return {
    child,
    dataDir,
    base: `http://127.0.0.1:${port}`
  };
}

async function stopServer(context) {
  context.child.kill();
  fs.rmSync(context.dataDir, { recursive: true, force: true });
}

function cookieFrom(response) {
  const value = response.headers.get("set-cookie") || "";
  return value.split(";", 1)[0];
}

async function request(context, pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  if (options.cookie) headers.Cookie = options.cookie;
  const response = await fetch(`${context.base}${pathname}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  return { response, payload };
}

async function setupUsers(context) {
  const setup = await request(context, "/api/auth/setup", {
    method: "POST",
    body: { username: "admin", displayName: "管理员", password: "secret123" }
  });
  assert.equal(setup.response.status, 201);
  const adminCookie = cookieFrom(setup.response);
  const member = await request(context, "/api/users", {
    method: "POST",
    cookie: adminCookie,
    body: { username: "member", displayName: "成员", password: "secret123", role: "member" }
  });
  assert.equal(member.response.status, 201);
  const login = await request(context, "/api/auth/login", {
    method: "POST",
    body: { username: "member", password: "secret123" }
  });
  assert.equal(login.response.status, 200);
  return { adminCookie, memberCookie: cookieFrom(login.response), member: member.payload.user };
}

test("resource APIs create, edit, and version-check nested entities", async () => {
  const context = await startServer();
  try {
    const { adminCookie } = await setupUsers(context);
    const systems = await request(context, "/api/systems", { cookie: adminCookie });
    assert.equal(systems.response.status, 200);
    const system = systems.payload.systems[0];

    const createdProject = await request(context, `/api/systems/${system.id}/projects`, {
      method: "POST",
      cookie: adminCookie,
      body: { name: "资源项目", systemVersion: system.version }
    });
    assert.equal(createdProject.response.status, 201);
    const project = createdProject.payload.project;

    const renamedProject = await request(context, `/api/projects/${project.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { name: "资源项目已改名", version: project.version }
    });
    assert.equal(renamedProject.response.status, 200);
    assert.equal(renamedProject.payload.project.name, "资源项目已改名");

    const createdRequirement = await request(context, `/api/projects/${project.id}/requirements`, {
      method: "POST",
      cookie: adminCookie,
      body: { title: "资源需求", projectVersion: renamedProject.payload.project.version }
    });
    assert.equal(createdRequirement.response.status, 201);
    const requirement = createdRequirement.payload.requirement;

    const createdStage = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}/stages`, {
      method: "POST",
      cookie: adminCookie,
      body: {
        type: "自定义阶段",
        title: "自定义阶段",
        start: "2099-01-01",
        end: "2099-01-02",
        requirementVersion: requirement.version
      }
    });
    assert.equal(createdStage.response.status, 201);
    assert.equal(createdStage.payload.stage.type, "自定义阶段");

    const secondStage = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}/stages`, {
      method: "POST",
      cookie: adminCookie,
      body: {
        type: "技术测试",
        title: "技术测试",
        start: "2099-01-03",
        end: "2099-01-04",
        requirementVersion: createdStage.payload.requirement.version
      }
    });
    assert.equal(secondStage.response.status, 201);

    const duplicateStageOrder = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: {
        stageIds: [createdStage.payload.stage.id, createdStage.payload.stage.id],
        version: secondStage.payload.requirement.version
      }
    });
    assert.equal(duplicateStageOrder.response.status, 400);

    const staleUpdate = await request(context, `/api/projects/${project.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { name: "过期修改", version: project.version }
    });
    assert.equal(staleUpdate.response.status, 409);
    assert.equal(staleUpdate.payload.code, "VERSION_CONFLICT");
    assert.equal(staleUpdate.payload.entity.name, "资源项目已改名");
  } finally {
    await stopServer(context);
  }
});

test("issues support priority, due dates, append-only comments, and role-protected deletion", async () => {
  const context = await startServer();
  try {
    const { adminCookie, memberCookie, member } = await setupUsers(context);
    const systems = await request(context, "/api/systems", { cookie: adminCookie });
    const system = systems.payload.systems[0];
    const projectResponse = await request(context, `/api/systems/${system.id}/projects`, {
      method: "POST",
      cookie: adminCookie,
      body: { name: "问题项目", systemVersion: system.version }
    });
    const project = projectResponse.payload.project;
    const requirementResponse = await request(context, `/api/projects/${project.id}/requirements`, {
      method: "POST",
      cookie: adminCookie,
      body: { title: "问题需求", projectVersion: project.version }
    });
    const requirement = requirementResponse.payload.requirement;
    const stageResponse = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}/stages`, {
      method: "POST",
      cookie: adminCookie,
      body: {
        type: "需求澄清",
        title: "未来阶段",
        start: "2099-01-01",
        end: "2099-01-02",
        requirementVersion: requirement.version
      }
    });
    const stage = stageResponse.payload.stage;
    const projectWithIssue = await request(context, `/api/projects/${project.id}`, { cookie: adminCookie });
    const issue = projectWithIssue.payload.project.issues.find((item) => item.stageId === stage.id);
    assert.ok(issue, "future stage should seed an issue on the server");

    const updatedIssue = await request(context, `/api/projects/${project.id}/issues/${issue.id}`, {
      method: "PATCH",
      cookie: memberCookie,
      body: {
        version: issue.version,
        priority: "urgent",
        dueDate: "2026-07-01",
        assigneeUserId: member.id
      }
    });
    assert.equal(updatedIssue.response.status, 200);
    assert.equal(updatedIssue.payload.issue.priority, "urgent");
    assert.equal(updatedIssue.payload.issue.dueDate, "2026-07-01");

    const comment = await request(context, `/api/projects/${project.id}/issues/${issue.id}/comments`, {
      method: "POST",
      cookie: memberCookie,
      body: { version: updatedIssue.payload.issue.version, body: "请优先处理" }
    });
    assert.equal(comment.response.status, 201);
    assert.equal(comment.payload.issue.comments[0].authorUserId, member.id);
    assert.equal(comment.payload.issue.comments[0].body, "请优先处理");

    const missingVersionUpdate = await request(context, `/api/projects/${project.id}/issues/${issue.id}`, {
      method: "PATCH",
      cookie: memberCookie,
      body: { priority: "low" }
    });
    assert.equal(missingVersionUpdate.response.status, 409);

    const memberBootstrap = await request(context, "/api/bootstrap", { cookie: memberCookie });
    const submittedState = memberBootstrap.payload.state;
    const submittedIssue = submittedState.systems
      .flatMap((item) => item.projects || [])
      .find((item) => item.id === project.id)
      .issues.find((item) => item.id === issue.id);
    submittedIssue.comments = [];
    const compatibilitySave = await request(context, "/api/state", {
      method: "PUT",
      cookie: memberCookie,
      body: { state: submittedState, revision: memberBootstrap.payload.revision }
    });
    assert.equal(compatibilitySave.response.status, 200);
    const preservedIssue = compatibilitySave.payload.state.systems
      .flatMap((item) => item.projects || [])
      .find((item) => item.id === project.id)
      .issues.find((item) => item.id === issue.id);
    assert.equal(preservedIssue.comments.length, 1);

    const missingVersionDelete = await request(context, `/api/projects/${project.id}/issues/${issue.id}`, {
      method: "DELETE",
      cookie: adminCookie,
      body: {}
    });
    assert.equal(missingVersionDelete.response.status, 409);

    const memberDelete = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}/stages/${stage.id}`, {
      method: "DELETE",
      cookie: memberCookie,
      body: { requirementVersion: stageResponse.payload.requirement.version, version: stage.version }
    });
    assert.equal(memberDelete.response.status, 403);

    const adminDelete = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}/stages/${stage.id}`, {
      method: "DELETE",
      cookie: adminCookie,
      body: { requirementVersion: stageResponse.payload.requirement.version, version: stage.version }
    });
    assert.equal(adminDelete.response.status, 200);
    assert.equal(adminDelete.payload.deletedId, stage.id);
  } finally {
    await stopServer(context);
  }
});
