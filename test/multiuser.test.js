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

test("future stage creates an open unassigned issue", () => {
  const dir = tempDir("future-issue");
  try {
    const store = createDataStore(dir);
    const meta = store.getMeta();
    store.saveState(sampleState(), meta.revision, "user-admin");
    const state = store.composeState();
    const project = state.systems[0].projects[0];
    assert.equal(project.issues.length, 1);
    assert.equal(project.issues[0].title, "待处理：未来开发");
    assert.equal(project.issues[0].status, "open");
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
    const member = auth.createUser({ username: "member", displayName: "成员", password: "secret2", role: "member" });
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
    const issue = store.composeState().systems[0].projects[0].issues[0];
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
