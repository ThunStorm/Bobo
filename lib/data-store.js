const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 2;

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return new Date().toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeId(value) {
  const id = String(value || "");
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid id: ${id}`);
  return id;
}

function createDataStore(rootDir) {
  const dataDir = path.resolve(rootDir);
  const metaFile = path.join(dataDir, "meta.json");
  const systemsFile = path.join(dataDir, "systems.json");
  const usersFile = path.join(dataDir, "users.json");
  const projectsDir = path.join(dataDir, "projects");
  const backupsDir = path.join(dataDir, "backups");
  const legacyFile = path.join(dataDir, "projects.json");

  function readJson(file, fallback) {
    if (!fs.existsSync(file)) return clone(fallback);
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  }

  function atomicWriteJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  }

  const projectDir = (projectId) => path.join(projectsDir, safeId(projectId));
  const projectFile = (projectId) => path.join(projectDir(projectId), "project.json");
  const issuesFile = (projectId) => path.join(projectDir(projectId), "issues.json");

  function ensureUsersFile() {
    if (!fs.existsSync(usersFile)) atomicWriteJson(usersFile, { users: [] });
  }

  function makeIssueFromLegacy(stage, projectId) {
    const description = String(stage.issues || "").trim();
    if (!stage.issueOpen && !description) return null;
    const timestamp = now();
    return {
      id: uid("issue"),
      projectId,
      stageId: stage.id,
      title: description.split(/\r?\n/)[0] || `待处理：${stage.title}`,
      description,
      status: stage.issueOpen ? "open" : "closed",
      assigneeUserId: "",
      createdByUserId: "",
      createdAt: timestamp,
      updatedByUserId: "",
      updatedAt: timestamp,
      closedByUserId: "",
      closedAt: "",
      legacyClosureUnknown: !stage.issueOpen,
      version: 1
    };
  }

  function cleanStage(stage) {
    const result = { ...stage };
    delete result.issueOpen;
    delete result.issues;
    result.version = Number(result.version || 1);
    return result;
  }

  function cleanProject(project, systemId) {
    return {
      id: project.id,
      systemId,
      name: project.name,
      version: Number(project.version || 1),
      milestones: clone(project.milestones || []),
      dateMarkers: clone(project.dateMarkers || []),
      requirements: (project.requirements || []).map((requirement) => ({
        id: requirement.id,
        title: requirement.title,
        version: Number(requirement.version || 1),
        stages: (requirement.stages || []).map(cleanStage)
      }))
    };
  }

  function migrateLegacy() {
    const legacy = readJson(legacyFile, { systems: [] });
    const sourceSystems = Array.isArray(legacy.systems)
      ? legacy.systems
      : [{ id: "system-a", name: "系统A", projects: legacy.projects || [], dateMarkers: [] }];
    const systems = [];

    fs.mkdirSync(backupsDir, { recursive: true });
    const backupName = `projects.pre-v2.${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    fs.copyFileSync(legacyFile, path.join(backupsDir, backupName));

    for (const system of sourceSystems) {
      const projectIds = [];
      for (const rawProject of system.projects || []) {
        const project = cleanProject(rawProject, system.id);
        const issues = [];
        for (const requirement of rawProject.requirements || []) {
          for (const stage of requirement.stages || []) {
            const issue = makeIssueFromLegacy(stage, project.id);
            if (issue) issues.push(issue);
          }
        }
        atomicWriteJson(projectFile(project.id), project);
        atomicWriteJson(issuesFile(project.id), { projectId: project.id, issues });
        projectIds.push(project.id);
      }
      systems.push({
        id: system.id,
        name: system.name,
        version: Number(system.version || 1),
        dateMarkers: clone(system.dateMarkers || []),
        projectIds
      });
    }

    atomicWriteJson(systemsFile, { schemaVersion: SCHEMA_VERSION, systems });
    atomicWriteJson(metaFile, { schemaVersion: SCHEMA_VERSION, revision: 1, updatedAt: now() });
    fs.renameSync(legacyFile, `${legacyFile}.migrated`);
  }

  function ensureLayout() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(projectsDir, { recursive: true });
    ensureUsersFile();
    if (!fs.existsSync(metaFile) || !fs.existsSync(systemsFile)) {
      if (fs.existsSync(legacyFile)) migrateLegacy();
      else {
        atomicWriteJson(metaFile, { schemaVersion: SCHEMA_VERSION, revision: 1, updatedAt: now() });
        atomicWriteJson(systemsFile, {
          schemaVersion: SCHEMA_VERSION,
          systems: [
            { id: "system-a", name: "系统A", version: 1, dateMarkers: [], projectIds: [] },
            { id: "system-b", name: "系统B", version: 1, dateMarkers: [], projectIds: [] }
          ]
        });
      }
    }
  }

  function getMeta() {
    ensureLayout();
    return readJson(metaFile, { schemaVersion: SCHEMA_VERSION, revision: 1, updatedAt: now() });
  }

  function touch() {
    const meta = getMeta();
    meta.revision = Number(meta.revision || 0) + 1;
    meta.updatedAt = now();
    atomicWriteJson(metaFile, meta);
    return meta;
  }

  function readProject(projectId) {
    return readJson(projectFile(projectId), null);
  }

  function readIssues(projectId) {
    return readJson(issuesFile(projectId), { projectId, issues: [] });
  }

  function composeState() {
    ensureLayout();
    const systemsDoc = readJson(systemsFile, { systems: [] });
    const systems = systemsDoc.systems.map((system) => {
      const projects = system.projectIds.map((projectId) => {
        const project = readProject(projectId);
        if (!project) return null;
        const issueDoc = readIssues(projectId);
        const issues = issueDoc.issues || [];
        const hydrated = clone(project);
        hydrated.expanded = true;
        hydrated.issues = issues;
        for (const requirement of hydrated.requirements || []) {
          requirement.expanded = true;
          for (const stage of requirement.stages || []) {
            const stageIssues = issues.filter((issue) => issue.stageId === stage.id);
            stage.issueOpen = stageIssues.some((issue) => issue.status !== "closed");
            stage.issues = stageIssues
              .filter((issue) => issue.status !== "closed")
              .map((issue) => issue.description || issue.title)
              .filter(Boolean)
              .join("\n");
          }
        }
        return hydrated;
      }).filter(Boolean);
      return { ...clone(system), projects };
    });
    return {
      selectedSystemId: systems[0]?.id || "",
      selectedProjectId: systems[0]?.projects[0]?.id || "",
      systems
    };
  }

  function collectIds(state) {
    const ids = { systems: new Set(), projects: new Set(), requirements: new Set(), stages: new Set() };
    for (const system of state.systems || []) {
      ids.systems.add(system.id);
      for (const project of system.projects || []) {
        ids.projects.add(project.id);
        for (const requirement of project.requirements || []) {
          ids.requirements.add(requirement.id);
          for (const stage of requirement.stages || []) ids.stages.add(stage.id);
        }
      }
    }
    return ids;
  }

  function hasDeletion(current, next) {
    const before = collectIds(current);
    const after = collectIds(next);
    return Object.keys(before).some((kind) => [...before[kind]].some((id) => !after[kind].has(id)));
  }

  function validateState(state) {
    if (!state || !Array.isArray(state.systems)) throw new Error("Invalid state: systems must be an array");
    for (const system of state.systems) {
      safeId(system.id);
      if (!Array.isArray(system.projects)) throw new Error("Invalid state: projects must be an array");
      for (const project of system.projects) {
        safeId(project.id);
        if (!Array.isArray(project.requirements)) throw new Error("Invalid state: requirements must be an array");
      }
    }
  }

  function seedFutureIssues(project, issueDoc, actorUserId) {
    const stageIds = new Set();
    for (const requirement of project.requirements || []) {
      for (const stage of requirement.stages || []) {
        stageIds.add(stage.id);
        const existing = issueDoc.issues.some((issue) => issue.stageId === stage.id);
        if (!existing && stage.issueOpen) {
          const timestamp = now();
          issueDoc.issues.push({
            id: uid("issue"),
            projectId: project.id,
            stageId: stage.id,
            title: `待处理：${stage.title}`,
            description: "",
            status: "open",
            assigneeUserId: "",
            createdByUserId: actorUserId || "",
            createdAt: timestamp,
            updatedByUserId: actorUserId || "",
            updatedAt: timestamp,
            closedByUserId: "",
            closedAt: "",
            legacyClosureUnknown: false,
            version: 1
          });
        }
      }
    }
    issueDoc.issues = issueDoc.issues.filter((issue) => stageIds.has(issue.stageId));
  }

  function saveState(nextState, expectedRevision, actorUserId = "") {
    ensureLayout();
    validateState(nextState);
    const meta = getMeta();
    if (expectedRevision != null && Number(expectedRevision) !== Number(meta.revision)) {
      const error = new Error("数据已被其他用户更新，请刷新后重试");
      error.code = "REVISION_CONFLICT";
      error.revision = meta.revision;
      throw error;
    }

    const previousSystems = readJson(systemsFile, { systems: [] });
    const previousProjectIds = new Set(previousSystems.systems.flatMap((system) => system.projectIds || []));
    const nextProjectIds = new Set();
    const systems = [];

    for (const system of nextState.systems) {
      const projectIds = [];
      for (const rawProject of system.projects || []) {
        nextProjectIds.add(rawProject.id);
        projectIds.push(rawProject.id);
        const existingIssues = readIssues(rawProject.id);
        if (Array.isArray(rawProject.issues)) existingIssues.issues = clone(rawProject.issues);
        seedFutureIssues(rawProject, existingIssues, actorUserId);
        atomicWriteJson(projectFile(rawProject.id), cleanProject(rawProject, system.id));
        atomicWriteJson(issuesFile(rawProject.id), existingIssues);
      }
      systems.push({
        id: system.id,
        name: system.name,
        version: Number(system.version || 1),
        dateMarkers: clone(system.dateMarkers || []),
        projectIds
      });
    }

    for (const projectId of previousProjectIds) {
      if (!nextProjectIds.has(projectId)) fs.rmSync(projectDir(projectId), { recursive: true, force: true });
    }
    atomicWriteJson(systemsFile, { schemaVersion: SCHEMA_VERSION, systems });
    return touch();
  }

  function findProject(projectId) {
    const project = readProject(projectId);
    if (!project) {
      const error = new Error("项目不存在");
      error.code = "NOT_FOUND";
      throw error;
    }
    return project;
  }

  function createIssue(projectId, input, userId) {
    const project = findProject(projectId);
    const stage = project.requirements.flatMap((item) => item.stages || []).find((item) => item.id === input.stageId);
    if (!stage) throw new Error("阶段不存在");
    const timestamp = now();
    const issue = {
      id: uid("issue"),
      projectId,
      stageId: stage.id,
      title: String(input.title || "").trim() || `待处理：${stage.title}`,
      description: String(input.description || "").trim(),
      status: ["open", "in_progress", "closed"].includes(input.status) ? input.status : "open",
      assigneeUserId: String(input.assigneeUserId || ""),
      createdByUserId: userId,
      createdAt: timestamp,
      updatedByUserId: userId,
      updatedAt: timestamp,
      closedByUserId: "",
      closedAt: "",
      legacyClosureUnknown: false,
      version: 1
    };
    if (issue.status === "closed") {
      issue.closedByUserId = userId;
      issue.closedAt = timestamp;
    }
    const doc = readIssues(projectId);
    doc.issues.push(issue);
    atomicWriteJson(issuesFile(projectId), doc);
    const meta = touch();
    return { issue, revision: meta.revision };
  }

  function updateIssue(projectId, issueId, input, userId) {
    findProject(projectId);
    const doc = readIssues(projectId);
    const issue = doc.issues.find((item) => item.id === issueId);
    if (!issue) {
      const error = new Error("问题不存在");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (input.version != null && Number(input.version) !== Number(issue.version)) {
      const error = new Error("问题已被其他用户更新");
      error.code = "VERSION_CONFLICT";
      error.entity = issue;
      throw error;
    }
    if (input.title != null) issue.title = String(input.title).trim() || issue.title;
    if (input.description != null) issue.description = String(input.description).trim();
    if (input.assigneeUserId != null) issue.assigneeUserId = String(input.assigneeUserId || "");
    if (["open", "in_progress"].includes(input.status)) {
      issue.status = input.status;
      issue.closedByUserId = "";
      issue.closedAt = "";
      issue.legacyClosureUnknown = false;
    }
    issue.updatedByUserId = userId;
    issue.updatedAt = now();
    issue.version = Number(issue.version || 1) + 1;
    atomicWriteJson(issuesFile(projectId), doc);
    const meta = touch();
    return { issue, revision: meta.revision };
  }

  function setIssueClosed(projectId, issueId, closed, userId, version) {
    const doc = readIssues(projectId);
    const issue = doc.issues.find((item) => item.id === issueId);
    if (!issue) {
      const error = new Error("问题不存在");
      error.code = "NOT_FOUND";
      throw error;
    }
    if (version != null && Number(version) !== Number(issue.version)) {
      const error = new Error("问题已被其他用户更新");
      error.code = "VERSION_CONFLICT";
      error.entity = issue;
      throw error;
    }
    issue.status = closed ? "closed" : "open";
    issue.closedByUserId = closed ? userId : "";
    issue.closedAt = closed ? now() : "";
    issue.legacyClosureUnknown = false;
    issue.updatedByUserId = userId;
    issue.updatedAt = now();
    issue.version = Number(issue.version || 1) + 1;
    atomicWriteJson(issuesFile(projectId), doc);
    const meta = touch();
    return { issue, revision: meta.revision };
  }

  function deleteIssue(projectId, issueId) {
    const doc = readIssues(projectId);
    const before = doc.issues.length;
    doc.issues = doc.issues.filter((item) => item.id !== issueId);
    if (doc.issues.length === before) {
      const error = new Error("问题不存在");
      error.code = "NOT_FOUND";
      throw error;
    }
    atomicWriteJson(issuesFile(projectId), doc);
    return touch();
  }

  ensureLayout();
  return {
    dataDir,
    usersFile,
    readJson,
    atomicWriteJson,
    getMeta,
    touch,
    composeState,
    saveState,
    hasDeletion,
    createIssue,
    updateIssue,
    setIssueClosed,
    deleteIssue,
    readIssues
  };
}

module.exports = { createDataStore, SCHEMA_VERSION };
