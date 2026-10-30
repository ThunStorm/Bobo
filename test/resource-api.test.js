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

async function startServer(existingDataDir) {
  const dataDir = existingDataDir || tempDir("api");
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
    assert.equal(projectWithIssue.payload.project.issues.length, 0, "future stage must not seed an issue");
    const createdIssue = await request(context, `/api/projects/${project.id}/issues`, { method: "POST", cookie: memberCookie, body: { stageId: stage.id, title: "手工创建待处理" } });
    assert.equal(createdIssue.response.status, 201);
    const issue = createdIssue.payload.issue;

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
    assert.equal(projectWithIssue.payload.project.issues.length, 0);
    const manualIssue = await request(context, `/api/projects/${project.id}/issues`, { method: "POST", cookie: adminCookie, body: { stageId: stage.id, title: "手工问题" } });
    const issue = manualIssue.payload.issue;
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
    assert.equal(projectWithIssue.payload.project.issues.length, 0);
    const manualIssue = await request(context, `/api/projects/${project.id}/issues`, { method: "POST", cookie: adminCookie, body: { stageId: stageResponse.payload.stage.id, title: "手工权限问题" } });
    const issue = manualIssue.payload.issue;

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
test("recurrence persists, edits with versions, rejects invalid rules atomically and enforces system access", async () => {
  const context = await startServer();
  try {
    const { adminCookie } = await setupUsers(context);
    const call = (url, method, body) => request(context, url, { method, body, cookie: adminCookie });
    let system = (await call('/api/systems','GET')).payload.systems[0];
    const rule = { unit:'week', interval:1, weekdays:[2], until:'2026-12-31' };
    const marker = { id:'meeting', date:'2026-11-01', label:'项目会', recurrence:rule };
    const marked = await call(`/api/systems/${system.id}`,'PATCH',{version:system.version,dateMarkers:[marker]});
    assert.equal(marked.response.status,200);
    assert.deepEqual(marked.payload.system.dateMarkers[0].recurrence,rule);
    const stale = await call(`/api/systems/${system.id}`,'PATCH',{version:system.version,dateMarkers:[]});
    assert.equal(stale.response.status,409);
    system = marked.payload.system;
    const shortened = await call(`/api/systems/${system.id}`,'PATCH',{version:system.version,dateMarkers:[{...marker,recurrence:{...rule,until:'2026-11-30'}}]});
    assert.equal(shortened.payload.system.dateMarkers.length,1);
    assert.equal(shortened.payload.system.dateMarkers[0].id,'meeting');
    system = shortened.payload.system;
    const project = (await call(`/api/systems/${system.id}/projects`,'POST',{name:'周期项目',systemVersion:system.version})).payload.project;
    const req = (await call(`/api/projects/${project.id}/requirements`,'POST',{title:'周期工作',projectVersion:project.version})).payload.requirement;
    const url = `/api/projects/${project.id}/requirements/${req.id}/stages`;
    const made = await call(url,'POST',{title:'双周巡检',type:'双周巡检',start:'2026-11-03',end:'2026-11-04',recurrence:{...rule,interval:2},requirementVersion:req.version});
    assert.equal(made.response.status,201);
    const stage = made.payload.stage;
    assert.equal(stage.recurrence.interval,2);
    const rev = (await call('/api/bootstrap','GET')).payload.revision;
    const invalid = await call(`${url}/${stage.id}`,'PATCH',{version:stage.version, title:'不应保存',recurrence:{...rule,interval:0}});
    assert.equal(invalid.response.status,400);
    const bootstrap = (await call('/api/bootstrap','GET')).payload;
    assert.equal(bootstrap.revision,rev);
    const updated = await call(`${url}/${stage.id}`,'PATCH',{version:stage.version,recurrence:{unit:'month',interval:1,until:'2026-12-31'}});
    assert.equal(updated.response.status,200);
    assert.equal((await call(`${url}/${stage.id}`,'PATCH',{version:stage.version,recurrence:null})).response.status,409);
    const clear = await call(`${url}/${stage.id}`,'PATCH',{version:updated.payload.stage.version,recurrence:null});
    assert.equal(clear.payload.stage.recurrence,null);
    const unauthorized = await call('/api/users','POST',{username:'limited',displayName:'受限',role:'member',systemIds:[(await call('/api/systems','GET')).payload.systems[1].id]});
    const login = await request(context,'/api/auth/select',{method:'POST',body:{userId:unauthorized.payload.user.id}});
    assert.equal((await request(context,`${url}/${stage.id}`,{method:'PATCH',cookie:cookieFrom(login.response),body:{version:clear.payload.stage.version,recurrence:rule}})).response.status,403);
    const state = (await call('/api/bootstrap','GET')).payload.state;
    const revision = (await call('/api/bootstrap','GET')).payload.revision;
    state.systems[0].dateMarkers[0].recurrence.interval = 0;
    assert.equal((await call('/api/state','PUT',{state,revision})).response.status,400);
    assert.equal((await call('/api/bootstrap','GET')).payload.revision,revision);
  } finally { await stopServer(context); }
});

test('attachments accept binary formats with scoped downloads, versioned notices and startup retention logs', async () => {
  let context=await startServer();
  try {
    const {adminCookie}=await setupUsers(context);
    const call=(url,method='GET',body)=>request(context,url,{method,body,cookie:adminCookie});
    const system=(await call('/api/systems')).payload.systems[0];
    const project=(await call(`/api/systems/${system.id}/projects`,'POST',{name:'附件',systemVersion:system.version})).payload.project;
    const req=(await call(`/api/projects/${project.id}/requirements`,'POST',{title:'通知',projectVersion:project.version})).payload.requirement;
    const stage=(await call(`/api/projects/${project.id}/requirements/${req.id}/stages`,'POST',{title:'项目会',type:'自定义',start:'2026-11-01',end:'2026-11-01',requirementVersion:req.version})).payload.stage;
    const stageUrl=`/api/projects/${project.id}/requirements/${req.id}/stages/${stage.id}`,url=stageUrl+'/attachments';
    assert.equal((await request(context,url)).response.status,401);
    const notice=await call(stageUrl,'PATCH',{notificationText:'通知：请参加项目会\n<script>alert(1)</script>',version:stage.version});
    assert.equal(notice.response.status,200);assert.match(notice.payload.stage.notificationText,/通知/);
    assert.equal((await call(stageUrl,'PATCH',{notificationText:'冲突',version:stage.version})).response.status,409);
    const bytes=Buffer.from([0,1,2,255,13,10]);
    const upload=(filename,version=notice.payload.stage.version,body=bytes,cookie=adminCookie)=>fetch(context.base+url,{method:'POST',headers:{Cookie:cookie,'X-File-Name':encodeURIComponent(filename),'X-Stage-Version':String(version),'Content-Type':'application/octet-stream'},body});
    assert.equal((await upload('陈旧.txt',stage.version)).status,409);
    assert.equal((await upload('../escape.txt')).status,400);
    assert.equal((await upload('bad\nname.txt')).status,400);
    const first=await upload('通知.任意格式');assert.equal(first.status,201);const record=(await first.json()).attachment;
    const second=await upload('通知.任意格式');assert.equal(second.status,201);assert.notEqual((await second.json()).attachment.id,record.id);
    const list=await call(url);assert.equal(list.payload.attachments.length,2);assert.equal(list.payload.attachments[0].uploadedByUserId,notice.payload.state ? (await call('/api/bootstrap')).payload.user.id : '');
    const download=await fetch(context.base+url+'/'+record.id,{headers:{Cookie:adminCookie}});
    assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.equal(download.headers.get('x-content-type-options'),'nosniff');
    const limited=(await call('/api/users','POST',{username:'attachment-limited',displayName:'隔离成员',role:'member',systemIds:[(await call('/api/systems')).payload.systems[1].id]})).payload.user;
    const login=await request(context,'/api/auth/select',{method:'POST',body:{userId:limited.id}}),cookie=cookieFrom(login.response);
    assert.equal((await request(context,url,{cookie})).response.status,403);
    assert.equal((await fetch(context.base+url+'/'+record.id,{headers:{Cookie:cookie}})).status,403);
    assert.equal((await upload('无权限.txt',notice.payload.stage.version,bytes,cookie)).status,403);
    assert.equal((await upload('超限.dat',notice.payload.stage.version,Buffer.alloc(50*1024*1024+1))).status,413);
    assert.equal((await call(url)).payload.attachments.length,2);
    const metaFile=path.join(context.dataDir,'attachments',record.id+'.json');
    const metadata=JSON.parse(fs.readFileSync(metaFile,'utf8'));metadata.uploadedAt='2020-01-01T00:00:00.000Z';fs.writeFileSync(metaFile,JSON.stringify(metadata));
    const exit=new Promise(r=>context.child.once('exit',r));context.child.kill();await exit;
    context=await startServer(context.dataDir);
    assert.equal(fs.existsSync(path.join(context.dataDir,'attachments',record.id+'.blob')),false);
    const logs=fs.readFileSync(path.join(context.dataDir,'logs','attachment-deletions.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(logs.map(item=>item.action),['delete_started','deleted']);assert.equal(logs[1].filename,'通知.任意格式');
  } finally {await stopServer(context);}
});

test('requirement completion and project ordering persist with permission and conflict checks', async () => {
  const context=await startServer();
  try {
    const {adminCookie,memberCookie}=await setupUsers(context);
    const call=(url,method='GET',body,cookie=adminCookie)=>request(context,url,{method,body,cookie});
    const system=(await call('/api/systems')).payload.systems[0];
    let project=(await call(`/api/systems/${system.id}/projects`,'POST',{name:'排序项目',systemVersion:system.version})).payload.project;
    const requirements=[];
    for (const title of ['需求一','需求二','需求三']) {
      const result=await call(`/api/projects/${project.id}/requirements`,'POST',{title,projectVersion:project.version,stages:[{title:'保留阶段',start:'2099-01-01',end:'2099-01-02',status:'进行中'}]});
      project=result.payload.project;requirements.push(result.payload.requirement);
    }
    const projectUrl=`/api/projects/${project.id}`;
    const reqUrl=`${projectUrl}/requirements/${requirements[0].id}`;
    await call(`/api/projects/${project.id}/issues`,'POST',{stageId:requirements[0].stages[0].id,title:'完成需求也保留的开放问题'});
    const issuesBefore=(await call('/api/bootstrap')).payload.state.systems[0].projects[0].issues;
    const completed=await call(reqUrl,'PATCH',{completed:true,version:requirements[0].version},memberCookie);
    assert.equal(completed.response.status,200);assert.equal(completed.payload.requirement.completed,true);
    assert.equal(completed.payload.requirement.stages[0].status,'进行中');
    assert.deepEqual(completed.payload.state.systems[0].projects[0].issues,issuesBefore);
    assert.equal((await call(reqUrl,'PATCH',{completed:false,version:requirements[0].version})).response.status,409);
    project=completed.payload.state.systems[0].projects[0];assert.equal(project.requirements.at(-1).id,requirements[0].id);
    assert.equal((await call(projectUrl,'PATCH',{version:project.version-1,requirementIds:requirements.map(item=>item.id)})).response.status,409);
    const sorted=await call(projectUrl,'PATCH',{version:project.version,requirementIds:[requirements[0].id,requirements[2].id,requirements[1].id]},memberCookie);
    assert.equal(sorted.response.status,200);assert.deepEqual(sorted.payload.project.requirements.map(item=>item.id),[requirements[2].id,requirements[1].id,requirements[0].id]);
    const rev=sorted.payload.revision;
    for (const ids of [[requirements[0].id],[requirements[0].id,requirements[0].id,requirements[1].id],['foreign',requirements[1].id,requirements[2].id],null]) {
      assert.equal((await call(projectUrl,'PATCH',{version:sorted.payload.project.version,requirementIds:ids})).response.status,400);
    }
    assert.equal((await call('/api/bootstrap')).payload.revision,rev);
    assert.equal((await call(reqUrl,'PATCH',{completed:'false',version:completed.payload.requirement.version})).response.status,400);
    const current=(await call('/api/bootstrap')).payload;
    const allIds=current.state.systems[0].projects[0].requirements.map(item=>item.id);
    await call('/api/state','PUT',{state:current.state,revision:current.revision});
    const reopened=(await call('/api/bootstrap')).payload.state.systems[0].projects[0];
    assert.deepEqual(reopened.requirements.map(item=>item.id),allIds);assert.equal(reopened.requirements.at(-1).completed,true);
    const restored=await call(reqUrl,'PATCH',{completed:false,version:completed.payload.requirement.version});assert.equal(restored.response.status,200);assert.equal(restored.payload.requirement.completed,false);
    const limited=(await call('/api/users','POST',{username:'order-limited',displayName:'隔离',role:'member',systemIds:[(await call('/api/systems')).payload.systems[1].id]})).payload.user;
    const login=await request(context,'/api/auth/select',{method:'POST',body:{userId:limited.id}});
    assert.equal((await call(reqUrl,'PATCH',{version:restored.payload.requirement.version,completed:true},cookieFrom(login.response))).response.status,403);
    assert.equal((await call(projectUrl,'PATCH',{version:reopened.version,requirementIds:allIds},cookieFrom(login.response))).response.status,403);
  } finally {await stopServer(context);}
});

test('deleted future-stage issues never return after project, stage, requirement and compatibility saves or restart',async()=>{
  let context=await startServer();try{
    const {adminCookie}=await setupUsers(context);
    const call=(url,method='GET',body)=>request(context,url,{method,body,cookie:adminCookie});
    const system=(await call('/api/systems')).payload.systems[0];const project=(await call(`/api/systems/${system.id}/projects`,'POST',{name:'不重建问题',systemVersion:system.version})).payload.project;
    const req=(await call(`/api/projects/${project.id}/requirements`,'POST',{title:'空白需求',projectVersion:project.version})).payload.requirement;assert.equal(req.stages.length,0);
    const stageUrl=`/api/projects/${project.id}/requirements/${req.id}/stages`;
    const made=await call(stageUrl,'POST',{type:'自定义',title:'未来工作',start:'2099-01-01',end:'2099-01-02',issueOpen:true,requirementVersion:req.version});const stage=made.payload.stage;
    assert.equal(made.payload.issues.length,0);const manual=(await call(`/api/projects/${project.id}/issues`,'POST',{stageId:stage.id,title:'手工待处理'})).payload.issue;
    assert.equal((await call(`/api/projects/${project.id}/issues/${manual.id}`,'DELETE',{version:manual.version})).response.status,200);
    const state=(await call('/api/bootstrap')).payload;const p=state.state.systems[0].projects[0],r=p.requirements[0];
    assert.equal((await call(`/api/projects/${p.id}`,'PATCH',{name:'项目改名',version:p.version})).response.status,200);
    assert.equal((await call(stageUrl+'/'+stage.id,'PATCH',{notes:'后续编辑',version:stage.version})).response.status,200);
    assert.equal((await call(`/api/projects/${p.id}/requirements/${r.id}`,'PATCH',{title:'需求改名',version:r.version})).response.status,200);
    const newest=(await call('/api/bootstrap')).payload;newest.state.systems[0].projects[0].requirements[0].stages[0].issueOpen=true;
    assert.equal((await call('/api/state','PUT',{state:newest.state,revision:newest.revision})).response.status,200);assert.equal((await call('/api/bootstrap')).payload.state.systems[0].projects[0].issues.length,0);
    const exited=new Promise(resolve=>context.child.once('exit',resolve));context.child.kill();await exited;context=await startServer(context.dataDir);
    const login=await request(context,'/api/auth/login',{method:'POST',body:{username:'admin',password:'secret123'}});const after=(await request(context,'/api/bootstrap',{cookie:cookieFrom(login.response)})).payload;
    assert.equal(after.state.systems[0].projects[0].issues.length,0);assert.equal(after.state.systems[0].projects[0].requirements[0].stages[0].issueOpen,false);
  }finally{await stopServer(context);}
});

test('admin diagnostics expose runtime and code fingerprints but no credential or issue bodies',async()=>{
  const context=await startServer();try{
    const {adminCookie,memberCookie}=await setupUsers(context);
    assert.equal((await request(context,'/api/admin/diagnostics')).response.status,401);assert.equal((await request(context,'/api/admin/diagnostics',{cookie:memberCookie})).response.status,403);
    const result=await request(context,'/api/admin/diagnostics',{cookie:adminCookie});assert.equal(result.response.status,200);assert.equal(result.payload.runtime.restartNeeded,false);assert.equal(result.payload.data.directory,context.dataDir);assert.equal(result.payload.source.features.automaticRequirementStages,true);assert.equal(result.payload.source.features.automaticIssueSeeding,false);
    assert.equal(result.payload.runtime.sourceAtStartup,result.payload.runtime.sourceOnDisk);assert.ok(result.payload.runtime.pid>0);assert.doesNotMatch(JSON.stringify(result.payload),/passwordHash|secret123|cookie|salt/i);
  }finally{await stopServer(context);}
});
