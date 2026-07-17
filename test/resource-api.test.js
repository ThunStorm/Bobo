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
  const systems = await request(context, "/api/systems", { cookie: adminCookie });
  const member = await request(context, "/api/users", {
    method: "POST",
    cookie: adminCookie,
    body: {
      username: "member",
      displayName: "成员",
      role: "member",
      systemIds: systems.payload.systems.map((system) => system.id)
    }
  });
  assert.equal(member.response.status, 201);
  const login = await request(context, "/api/auth/select", {
    method: "POST",
    body: { userId: member.payload.user.id }
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

test("authentication, issue lifecycle, account deactivation, and cascading deletion work end to end", async () => {
  const context = await startServer();
  try {
    const firstSetup = await request(context, "/api/auth/setup", {
      method: "POST",
      body: { username: "Admin", displayName: "首位管理员", password: "secret123" }
    });
    assert.equal(firstSetup.response.status, 201);
    const adminCookie = cookieFrom(firstSetup.response);

    const repeatedSetup = await request(context, "/api/auth/setup", {
      method: "POST",
      body: { username: "another", displayName: "重复初始化", password: "secret123" }
    });
    assert.equal(repeatedSetup.response.status, 409);

    const badLogin = await request(context, "/api/auth/login", {
      method: "POST",
      body: { username: "ADMIN", password: "wrong-password" }
    });
    assert.equal(badLogin.response.status, 401);

    const initialSystems = await request(context, "/api/systems", { cookie: adminCookie });
    const memberResponse = await request(context, "/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: {
        username: "member2",
        displayName: "协作成员",
        role: "member",
        systemIds: initialSystems.payload.systems.map((system) => system.id)
      }
    });
    assert.equal(memberResponse.response.status, 201);
    const member = memberResponse.payload.user;
    const memberLogin = await request(context, "/api/auth/select", {
      method: "POST",
      body: { userId: member.id }
    });
    assert.equal(memberLogin.response.status, 200);
    const memberCookie = cookieFrom(memberLogin.response);

    const systems = await request(context, "/api/systems", { cookie: adminCookie });
    const system = systems.payload.systems[0];
    const projectResponse = await request(context, `/api/systems/${system.id}/projects`, {
      method: "POST",
      cookie: adminCookie,
      body: { name: "级联测试项目", systemVersion: system.version }
    });
    const project = projectResponse.payload.project;
    const requirementResponse = await request(context, `/api/projects/${project.id}/requirements`, {
      method: "POST",
      cookie: adminCookie,
      body: { title: "级联测试需求", projectVersion: project.version }
    });
    const requirement = requirementResponse.payload.requirement;
    const stageResponse = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}/stages`, {
      method: "POST",
      cookie: adminCookie,
      body: {
        type: "开发",
        title: "级联测试阶段",
        start: "2099-01-01",
        end: "2099-01-02",
        requirementVersion: requirement.version
      }
    });
    const stage = stageResponse.payload.stage;
    const projectWithIssue = await request(context, `/api/projects/${project.id}`, { cookie: adminCookie });
    const issue = projectWithIssue.payload.project.issues.find((item) => item.stageId === stage.id);
    assert.ok(issue);

    const memberDelete = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}/stages/${stage.id}`, {
      method: "DELETE",
      cookie: memberCookie,
      body: { requirementVersion: stageResponse.payload.requirement.version, version: stage.version }
    });
    assert.equal(memberDelete.response.status, 403);

    const closed = await request(context, `/api/projects/${project.id}/issues/${issue.id}/close`, {
      method: "POST",
      cookie: memberCookie,
      body: { version: issue.version }
    });
    assert.equal(closed.response.status, 200);
    assert.equal(closed.payload.issue.closedByUserId, member.id);
    const reopened = await request(context, `/api/projects/${project.id}/issues/${issue.id}/reopen`, {
      method: "POST",
      cookie: adminCookie,
      body: { version: closed.payload.issue.version }
    });
    assert.equal(reopened.response.status, 200);
    assert.equal(reopened.payload.issue.status, "open");
    assert.equal(reopened.payload.issue.closedByUserId, "");
    assert.equal(reopened.payload.issue.closedAt, "");

    const deletedStage = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}/stages/${stage.id}`, {
      method: "DELETE",
      cookie: adminCookie,
      body: { requirementVersion: stageResponse.payload.requirement.version, version: stage.version }
    });
    assert.equal(deletedStage.response.status, 200);
    const afterStageDelete = await request(context, `/api/projects/${project.id}`, { cookie: adminCookie });
    assert.equal(afterStageDelete.payload.project.issues.some((item) => item.id === issue.id), false);

    const deletedRequirement = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}`, {
      method: "DELETE",
      cookie: adminCookie,
      body: {
        projectVersion: afterStageDelete.payload.project.version,
        version: afterStageDelete.payload.project.requirements.find((item) => item.id === requirement.id).version
      }
    });
    assert.equal(deletedRequirement.response.status, 200);
    const afterRequirementDelete = await request(context, `/api/projects/${project.id}`, { cookie: adminCookie });
    assert.equal(afterRequirementDelete.payload.project.requirements.some((item) => item.id === requirement.id), false);

    const afterSystemUpdate = await request(context, `/api/systems/${system.id}`, { cookie: adminCookie });
    const deletedProject = await request(context, `/api/projects/${project.id}`, {
      method: "DELETE",
      cookie: adminCookie,
      body: { systemVersion: afterSystemUpdate.payload.system.version, version: afterRequirementDelete.payload.project.version }
    });
    assert.equal(deletedProject.response.status, 200);
    const missingProject = await request(context, `/api/projects/${project.id}`, { cookie: adminCookie });
    assert.equal(missingProject.response.status, 404);

    const disabled = await request(context, `/api/users/${member.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { active: false }
    });
    assert.equal(disabled.response.status, 200);
    const disabledBootstrap = await request(context, "/api/bootstrap", { cookie: memberCookie });
    assert.equal(disabledBootstrap.response.status, 401);
  } finally {
    await stopServer(context);
  }
});

test("avatar login enforces system access and preserves deleted user history", async () => {
  const context = await startServer();
  try {
    const setup = await request(context, "/api/auth/setup", {
      method: "POST",
      body: { username: "owner", displayName: "负责人", password: "1234" }
    });
    assert.equal(setup.response.status, 201);
    const adminCookie = cookieFrom(setup.response);

    const choices = await request(context, "/api/auth/choices");
    assert.equal(choices.response.status, 200);
    assert.equal(choices.payload.systems.length, 2);
    assert.ok(choices.payload.systems.every((system) => Object.keys(system).sort().join(",") === "id,name"));
    assert.equal(choices.payload.users.length, 1);
    assert.equal(choices.payload.users[0].avatarText, "负");
    assert.equal(choices.payload.users[0].requiresPassword, true);
    assert.deepEqual(choices.payload.users[0].systemIds, []);
    assert.equal(Object.hasOwn(choices.payload.users[0], "username"), false);

    const systemsResponse = await request(context, "/api/systems", { cookie: adminCookie });
    const [systemA, systemB] = systemsResponse.payload.systems;
    const memberAResponse = await request(context, "/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "member-a", displayName: "甲成员", avatarText: "甲", role: "member", systemIds: [systemA.id] }
    });
    assert.equal(memberAResponse.response.status, 201);
    const memberA = memberAResponse.payload.user;
    const memberBResponse = await request(context, "/api/users", {
      method: "POST",
      cookie: adminCookie,
      body: { username: "member-b", displayName: "乙成员", avatarText: "乙", role: "member", systemIds: [systemB.id] }
    });
    assert.equal(memberBResponse.response.status, 201);
    const memberB = memberBResponse.payload.user;

    const groupedChoices = await request(context, "/api/auth/choices");
    assert.deepEqual(groupedChoices.payload.users.find((user) => user.id === memberA.id).systemIds, [systemA.id]);
    assert.deepEqual(groupedChoices.payload.users.find((user) => user.id === memberB.id).systemIds, [systemB.id]);

    const memberLogin = await request(context, "/api/auth/select", {
      method: "POST",
      body: { userId: memberA.id }
    });
    assert.equal(memberLogin.response.status, 200);
    const memberCookie = cookieFrom(memberLogin.response);
    const memberBootstrap = await request(context, "/api/bootstrap", { cookie: memberCookie });
    assert.deepEqual(memberBootstrap.payload.state.systems.map((system) => system.id), [systemA.id]);

    const forbiddenSystem = await request(context, `/api/systems/${systemB.id}`, { cookie: memberCookie });
    assert.equal(forbiddenSystem.response.status, 403);
    const forbiddenCreateSystem = await request(context, "/api/systems", {
      method: "POST",
      cookie: memberCookie,
      body: { name: "无权新建", systemsVersion: memberBootstrap.payload.state.systemsVersion }
    });
    assert.equal(forbiddenCreateSystem.response.status, 403);

    memberBootstrap.payload.state.systems[0].name = "成员保存后的系统";
    const scopedSave = await request(context, "/api/state", {
      method: "PUT",
      cookie: memberCookie,
      body: { state: memberBootstrap.payload.state, revision: memberBootstrap.payload.revision }
    });
    assert.equal(scopedSave.response.status, 200);
    const adminState = await request(context, "/api/state", { cookie: adminCookie });
    assert.equal(adminState.payload.systems.length, 2);
    assert.ok(adminState.payload.systems.some((system) => system.id === systemB.id));

    const refreshedSystems = await request(context, "/api/systems", { cookie: adminCookie });
    const refreshedA = refreshedSystems.payload.systems.find((system) => system.id === systemA.id);
    const projectResponse = await request(context, `/api/systems/${systemA.id}/projects`, {
      method: "POST",
      cookie: adminCookie,
      body: { name: "权限项目", systemVersion: refreshedA.version }
    });
    const project = projectResponse.payload.project;
    const requirementResponse = await request(context, `/api/projects/${project.id}/requirements`, {
      method: "POST",
      cookie: adminCookie,
      body: { title: "权限需求", projectVersion: project.version }
    });
    const requirement = requirementResponse.payload.requirement;
    const stageResponse = await request(context, `/api/projects/${project.id}/requirements/${requirement.id}/stages`, {
      method: "POST",
      cookie: adminCookie,
      body: {
        title: "权限阶段",
        type: "开发",
        start: "2099-01-01",
        end: "2099-01-02",
        requirementVersion: requirement.version
      }
    });
    const projectWithIssue = await request(context, `/api/projects/${project.id}`, { cookie: adminCookie });
    const issue = projectWithIssue.payload.project.issues.find((item) => item.stageId === stageResponse.payload.stage.id);

    const crossSystemAssignee = await request(context, `/api/projects/${project.id}/issues/${issue.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { version: issue.version, assigneeUserId: memberB.id }
    });
    assert.equal(crossSystemAssignee.response.status, 400);
    const validAssignee = await request(context, `/api/projects/${project.id}/issues/${issue.id}`, {
      method: "PATCH",
      cookie: adminCookie,
      body: { version: issue.version, assigneeUserId: memberA.id }
    });
    assert.equal(validAssignee.response.status, 200);

    const avatarChange = await request(context, "/api/users/me/avatar", {
      method: "PATCH",
      cookie: memberCookie,
      body: { avatarText: "新" }
    });
    assert.equal(avatarChange.response.status, 200);
    assert.equal(avatarChange.payload.user.avatarText, "新");

    const deleted = await request(context, `/api/users/${memberA.id}`, {
      method: "DELETE",
      cookie: adminCookie
    });
    assert.equal(deleted.response.status, 200);
    assert.ok(deleted.payload.user.deletedAt);
    const expiredSession = await request(context, "/api/bootstrap", { cookie: memberCookie });
    assert.equal(expiredSession.response.status, 401);
    const choicesAfterDelete = await request(context, "/api/auth/choices");
    assert.equal(choicesAfterDelete.payload.users.some((user) => user.id === memberA.id), false);
    const historyBootstrap = await request(context, "/api/bootstrap", { cookie: adminCookie });
    const historicalUser = historyBootstrap.payload.users.find((user) => user.id === memberA.id);
    assert.ok(historicalUser.deletedAt);
    const historicalIssue = historyBootstrap.payload.state.systems
      .flatMap((system) => system.projects || [])
      .find((item) => item.id === project.id)
      .issues.find((item) => item.id === issue.id);
    assert.equal(historicalIssue.assigneeUserId, memberA.id);
  } finally {
    await stopServer(context);
  }
});