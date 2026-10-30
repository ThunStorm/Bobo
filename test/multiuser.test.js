const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createDataStore } = require("../lib/data-store");
const { createAuth } = require("../lib/auth");

function tempDir(name) {
  const dir = path.join(__dirname, `.tmp-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function sampleState() {
  return {
    selectedSystemId: "system-a",
    selectedProjectId: "project-a",
    systems: [{
      id: "system-a",
      name: "系统A",
      dateMarkers: [],
      projects: [{
        id: "project-a",
        name: "项目 A",
        milestones: [],
        dateMarkers: [],
        requirements: [{
          id: "req-a",
          title: "需求 A",
          stages: [{
            id: "stage-a",
            type: "开发",
            title: "未来开发",
            start: "2099-01-01",
            end: "2099-01-02",
            owner: "",
            hours: 2,
            status: "未开始",
            issueOpen: true,
            issues: "",
            notes: ""
          }]
        }],
        issues: []
      }]
    }]
  };
}

test("legacy state migrates to project folders and preserves issue text", () => {
  const dir = tempDir("migration");
  try {
    const legacy = sampleState();
    legacy.systems[0].projects[0].requirements[0].stages[0].issues = "确认接口范围";
    fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify(legacy), "utf8");

    const store = createDataStore(dir);
    const state = store.composeState();
    assert.equal(state.systems[0].projects.length, 1);
    assert.ok(fs.existsSync(path.join(dir, "projects", "project-a", "project.json")));
    assert.ok(fs.existsSync(path.join(dir, "backups")));
    assert.equal(state.systems[0].projects[0].issues[0].description, "确认接口范围");
    assert.equal(state.systems[0].projects[0].issues[0].status, "open");
  } finally {
    cleanup(dir);
  }
});

test("future stages and stale derived flags never create issues during state saves", () => {
  const dir = tempDir("future-issue");
  try {
    const store = createDataStore(dir);
    const meta = store.getMeta();
    store.saveState(sampleState(), meta.revision, "user-admin");
    const state = store.composeState();
    const project = state.systems[0].projects[0];
    assert.equal(project.issues.length, 0);
    assert.equal(project.requirements[0].stages[0].issueOpen, false);
  } finally {
    cleanup(dir);
  }
});

test("accounts are hashed and the final administrator stays protected", () => {
  const dir = tempDir("auth");
  try {
    const store = createDataStore(dir);
    const auth = createAuth(store);
    const admin = auth.setup({ username: "admin", displayName: "管理员", password: "secret1" });
    const doc = store.readJson(store.usersFile, { users: [] });
    assert.notEqual(doc.users[0].passwordHash, "secret1");
    assert.ok(doc.users[0].salt);
    assert.equal(auth.login("ADMIN", "secret1").user.id, admin.id);
    assert.throws(() => auth.updateUser(admin.id, { active: false }, admin.id), /最后一名管理员/);
    const member = auth.createUser({ username: "member", displayName: "成员", role: "member", systemIds: store.composeState().systems.map((system) => system.id) });
    assert.equal(member.role, "member");
  } finally {
    cleanup(dir);
  }
});

test("issue close stamps the server-side user and version conflicts are detected", () => {
  const dir = tempDir("issue-close");
  try {
    const store = createDataStore(dir);
    const meta = store.getMeta();
    store.saveState(sampleState(), meta.revision, "user-admin");
    const issue = store.createIssue("project-a", { stageId: "stage-a", title: "手工问题" }, "user-admin").issue;
    const closed = store.setIssueClosed("project-a", issue.id, true, "user-member", issue.version);
    assert.equal(closed.issue.status, "closed");
    assert.equal(closed.issue.closedByUserId, "user-member");
    assert.ok(closed.issue.closedAt);
    assert.throws(
      () => store.setIssueClosed("project-a", issue.id, false, "user-member", issue.version),
      (error) => error.code === "VERSION_CONFLICT"
    );
  } finally {
    cleanup(dir);
  }
});

test("legacy members migrate to passwordless system-scoped accounts", () => {
  const dir = tempDir("user-migration");
  try {
    const store = createDataStore(dir);
    const auth = createAuth(store);
    auth.setup({ username: "admin", displayName: "管理员", password: "1234" });
    const doc = store.readJson(store.usersFile, { users: [] });
    doc.schemaVersion = 1;
    doc.users.push({
      id: "user-legacy",
      username: "legacy",
      displayName: "旧成员",
      role: "member",
      active: true,
      salt: "legacy-salt",
      passwordHash: "legacy-hash",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    store.atomicWriteJson(store.usersFile, doc);

    const migrated = auth.listUsers().find((user) => user.id === "user-legacy");
    assert.equal(migrated.avatarText, "旧");
    assert.deepEqual(migrated.systemIds, store.composeState().systems.map((system) => system.id));
    assert.equal(auth.selectUser(migrated.id).user.id, migrated.id);
    const persisted = store.readJson(store.usersFile, { users: [] }).users.find((user) => user.id === migrated.id);
    assert.equal(Object.hasOwn(persisted, "passwordHash"), false);
  } finally {
    cleanup(dir);
  }
});

test("four-character admin passwords and logical deletion protections are enforced", () => {
  const dir = tempDir("admin-rules");
  try {
    const store = createDataStore(dir);
    const auth = createAuth(store);
    assert.throws(() => auth.setup({ username: "admin", displayName: "管理员", password: "123" }), /至少需要 4 位/);
    const admin = auth.setup({ username: "admin", displayName: "管理员", password: "1234" });
    const second = auth.createUser({ username: "admin2", displayName: "副管理员", role: "admin", password: "5678" });
    assert.equal(auth.selectUser(second.id, "5678").user.role, "admin");
    assert.throws(() => auth.deleteUser(admin.id, admin.id), /不能删除当前登录账户/);
    const deleted = auth.deleteUser(second.id, admin.id);
    assert.ok(deleted.deletedAt);
    assert.equal(auth.loginChoices().some((user) => user.id === second.id), false);
  } finally {
    cleanup(dir);
  }
});