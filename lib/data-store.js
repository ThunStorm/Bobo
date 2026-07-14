const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 2;
const ISSUE_PRIORITIES = ["low", "medium", "high", "urgent"];

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function localDateString(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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

  function normalizeIssue(issue, projectId) {
    const priority = ISSUE_PRIORITIES.includes(issue.priority) ? issue.priority : "medium";
    return {
      ...clone(issue),
      projectId,
      priority,
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(issue.dueDate || "")) ? issue.dueDate : "",
      comments: Array.isArray(issue.comments) ? clone(issue.comments) : []
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

    atomicWriteJson(systemsFile, { schemaVersion: SCHEMA_VERSION, version: 1, systems });
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
          version: 1,
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
    const doc = readJson(issuesFile(projectId), { projectId, issues: [] });
    return { ...doc, projectId, issues: (doc.issues || []).map((issue) => normalizeIssue(issue, projectId)) };
  }

  function composeState() {
    ensureLayout();
    const systemsDoc = readJson(systemsFile, { version: 1, systems: [] });
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
      return { ...clone(system), version: Number(system.version || 1), projects };
    });
    return {
      selectedSystemId: systems[0]?.id || "",
      selectedProjectId: systems[0]?.projects[0]?.id || "",
      systems,
      systemsVersion: Number(systemsDoc.version || 1)
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

  function notFound(message) {
    const error = new Error(message);
    error.code = "NOT_FOUND";
    return error;
  }

  function versionConflict(entity, versionField = "version") {
    const error = new Error("数据已被其他用户更新，请刷新后重试");
    error.code = "VERSION_CONFLICT";
    error.entity = clone(entity);
    error.versionField = versionField;
    return error;
  }

  function assertVersion(entity, expectedVersion, versionField = "version") {
    if (expectedVersion == null || Number(expectedVersion) !== Number(entity.version || 1)) {
      throw versionConflict(entity, versionField);
    }
  }

  function readSystems() {
    const doc = readJson(systemsFile, { schemaVersion: SCHEMA_VERSION, version: 1, systems: [] });
    return {
      ...doc,
      version: Number(doc.version || 1),
      systems: (doc.systems || []).map((system) => ({
        ...system,
        version: Number(system.version || 1),
        projectIds: [...(system.projectIds || [])]
      }))
    };
  }

  function findSystemRecord(systemId, systemsDoc = readSystems()) {
    const system = systemsDoc.systems.find((item) => item.id === systemId);
    if (!system) throw notFound("系统不存在");
    return { systemsDoc, system };
  }

  function findProjectRecord(projectId, systemsDoc = readSystems()) {
    const project = readProject(projectId);
    if (!project) throw notFound("项目不存在");
    const system = systemsDoc.systems.find((item) => item.projectIds.includes(projectId));
    if (!system) throw notFound("项目所属系统不存在");
    return { systemsDoc, system, project };
  }

  function findRequirementRecord(projectId, requirementId) {
    const result = findProjectRecord(projectId);
    const requirement = result.project.requirements.find((item) => item.id === requirementId);
    if (!requirement) throw notFound("需求不存在");
    return { ...result, requirement };
  }

  function findStageRecord(projectId, requirementId, stageId) {
    const result = findRequirementRecord(projectId, requirementId);
    const stage = result.requirement.stages.find((item) => item.id === stageId);
    if (!stage) throw notFound("阶段不存在");
    return { ...result, stage };
  }

  function writeProject(project, systemId) {
    atomicWriteJson(projectFile(project.id), cleanProject(project, systemId));
  }

  function writeSystems(systemsDoc) {
    atomicWriteJson(systemsFile, {
      schemaVersion: SCHEMA_VERSION,
      version: Number(systemsDoc.version || 1),
      systems: systemsDoc.systems
    });
  }

  function projectIssues(projectId, project, actorUserId) {
    const issueDoc = readIssues(projectId);
    seedFutureIssues(project, issueDoc, actorUserId);
    atomicWriteJson(issuesFile(projectId), issueDoc);
    return issueDoc;
  }

  function seedFutureIssues(project, issueDoc, actorUserId) {
    const stageIds = new Set();
    for (const requirement of project.requirements || []) {
      for (const stage of requirement.stages || []) {
        stageIds.add(stage.id);
        const existing = issueDoc.issues.some((issue) => issue.stageId === stage.id);
        const futureStage = String(stage.start || "") > localDateString();
        if (!existing && (stage.issueOpen || futureStage)) {
          const timestamp = now();
          issueDoc.issues.push({
            id: uid("issue"),
            projectId: project.id,
            stageId: stage.id,
            title: `待处理：${stage.title}`,
            description: "",
            status: "open",
            priority: "medium",
            dueDate: "",
            comments: [],
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
    atomicWriteJson(systemsFile, {
      schemaVersion: SCHEMA_VERSION,
      version: Number(previousSystems.version || 1) + 1,
      systems
    });
    return touch();
  }

  function listSystems() {
    ensureLayout();
    const state = composeState();
    return { systems: state.systems, systemsVersion: state.systemsVersion, revision: getMeta().revision };
  }

  function createSystem(input) {
    const systemsDoc = readSystems();
    if (input.systemsVersion != null && Number(input.systemsVersion) !== Number(systemsDoc.version)) {
      throw versionConflict({ id: "systems", version: systemsDoc.version }, "systemsVersion");
    }
    const system = {
      id: uid("system"),
      name: String(input.name || "新系统").trim() || "新系统",
      version: 1,
      dateMarkers: [],
      projectIds: []
    };
    systemsDoc.systems.push(system);
    systemsDoc.version += 1;
    writeSystems(systemsDoc);
    const meta = touch();
    return { system, systemsVersion: systemsDoc.version, revision: meta.revision };
  }

  function updateSystem(systemId, input, expectedVersion) {
    const systemsDoc = readSystems();
    const { system } = findSystemRecord(systemId, systemsDoc);
    assertVersion(system, expectedVersion);
    if (input.name != null) system.name = String(input.name).trim() || system.name;
    if (input.dateMarkers != null) system.dateMarkers = clone(input.dateMarkers || []);
    system.version += 1;
    writeSystems(systemsDoc);
    const meta = touch();
    return { system, systemsVersion: systemsDoc.version, revision: meta.revision };
  }

  function deleteSystem(systemId, expectedVersion) {
    const systemsDoc = readSystems();
    const { system } = findSystemRecord(systemId, systemsDoc);
    if (systemsDoc.systems.length <= 1) throw new Error("至少需要保留一个系统");
    if (system.projectIds.length) throw new Error("请先清空系统下的项目");
    assertVersion(system, expectedVersion);
    systemsDoc.systems = systemsDoc.systems.filter((item) => item.id !== systemId);
    systemsDoc.version += 1;
    writeSystems(systemsDoc);
    const meta = touch();
    return { deletedId: systemId, systemsVersion: systemsDoc.version, revision: meta.revision };
  }

  function createProject(systemId, input, expectedSystemVersion) {
    const systemsDoc = readSystems();
    const { system } = findSystemRecord(systemId, systemsDoc);
    assertVersion(system, expectedSystemVersion, "systemVersion");
    const project = {
      id: uid("project"),
      systemId,
      name: String(input.name || "新项目").trim() || "新项目",
      version: 1,
      milestones: clone(input.milestones || []),
      dateMarkers: clone(input.dateMarkers || []),
      requirements: []
    };
    system.projectIds.push(project.id);
    system.version += 1;
    writeProject(project, systemId);
    atomicWriteJson(issuesFile(project.id), { projectId: project.id, issues: [] });
    writeSystems(systemsDoc);
    const meta = touch();
    return { project: clone(project), system, revision: meta.revision };
  }

  function updateProject(projectId, input, expectedVersion) {
    const result = findProjectRecord(projectId);
    assertVersion(result.project, expectedVersion);
    if (input.name != null) result.project.name = String(input.name).trim() || result.project.name;
    if (input.milestones != null) result.project.milestones = clone(input.milestones || []);
    if (input.dateMarkers != null) result.project.dateMarkers = clone(input.dateMarkers || []);
    result.project.version += 1;
    writeProject(result.project, result.system.id);
    projectIssues(projectId, result.project, input.actorUserId || "");
    const meta = touch();
    return { project: clone(result.project), revision: meta.revision };
  }

  function deleteProject(projectId, expectedSystemVersion, expectedProjectVersion) {
    const result = findProjectRecord(projectId);
    assertVersion(result.system, expectedSystemVersion, "systemVersion");
    assertVersion(result.project, expectedProjectVersion);
    result.system.projectIds = result.system.projectIds.filter((id) => id !== projectId);
    result.system.version += 1;
    writeSystems(result.systemsDoc);
    fs.rmSync(projectDir(projectId), { recursive: true, force: true });
    const meta = touch();
    return { deletedId: projectId, revision: meta.revision };
  }

  function createRequirement(projectId, input) {
    const result = findProjectRecord(projectId);
    assertVersion(result.project, input.projectVersion, "projectVersion");
    const requirement = {
      id: uid("req"),
      title: String(input.title || "新需求").trim() || "新需求",
      version: 1,
      stages: (input.stages || []).map((stage) => createStageRecord(stage))
    };
    result.project.requirements.push(requirement);
    result.project.version += 1;
    writeProject(result.project, result.system.id);
    const issueDoc = projectIssues(projectId, result.project, input.actorUserId || "");
    const meta = touch();
    return { requirement: clone(requirement), project: clone(result.project), issues: issueDoc.issues, revision: meta.revision };
  }

  function updateRequirement(projectId, requirementId, input) {
    const result = findRequirementRecord(projectId, requirementId);
    assertVersion(result.requirement, input.version);
    if (input.title != null) result.requirement.title = String(input.title).trim() || result.requirement.title;
    if (Array.isArray(input.stageIds)) {
      const stages = new Map(result.requirement.stages.map((stage) => [stage.id, stage]));
      if (input.stageIds.length !== stages.size
        || new Set(input.stageIds).size !== stages.size
        || input.stageIds.some((id) => !stages.has(id))) {
        throw new Error("阶段顺序无效");
      }
      result.requirement.stages = input.stageIds.map((id) => stages.get(id));
    }
    result.requirement.version += 1;
    writeProject(result.project, result.system.id);
    projectIssues(projectId, result.project, input.actorUserId || "");
    const meta = touch();
    return { requirement: clone(result.requirement), revision: meta.revision };
  }

  function createStageRecord(input) {
    return {
      id: uid("stage"),
      type: String(input.type || "需求澄清"),
      title: String(input.title || input.type || "新阶段"),
      start: String(input.start || localDateString()),
      end: String(input.end || input.start || localDateString()),
      owner: String(input.owner || ""),
      hours: Number(input.hours || 0),
      status: String(input.status || "未开始"),
      notes: String(input.notes || ""),
      version: 1
    };
  }

  function createStage(projectId, requirementId, input) {
    const result = findRequirementRecord(projectId, requirementId);
    assertVersion(result.requirement, input.requirementVersion, "requirementVersion");
    const stage = createStageRecord(input);
    result.requirement.stages.push(stage);
    result.requirement.version += 1;
    writeProject(result.project, result.system.id);
    const issueDoc = projectIssues(projectId, result.project, input.actorUserId || "");
    const meta = touch();
    return { stage: clone(stage), requirement: clone(result.requirement), issues: issueDoc.issues, revision: meta.revision };
  }

  function updateStage(projectId, requirementId, stageId, input) {
    const result = findStageRecord(projectId, requirementId, stageId);
    assertVersion(result.stage, input.version);
    for (const field of ["type", "title", "start", "end", "owner", "status", "notes"]) {
      if (input[field] != null) result.stage[field] = String(input[field]);
    }
    if (input.hours != null) result.stage.hours = Number(input.hours || 0);
    result.stage.version += 1;
    writeProject(result.project, result.system.id);
    const issueDoc = projectIssues(projectId, result.project, input.actorUserId || "");
    const meta = touch();
    return { stage: clone(result.stage), issues: issueDoc.issues, revision: meta.revision };
  }

  function deleteRequirement(projectId, requirementId, expectedProjectVersion, expectedRequirementVersion) {
    const result = findRequirementRecord(projectId, requirementId);
    assertVersion(result.project, expectedProjectVersion, "projectVersion");
    assertVersion(result.requirement, expectedRequirementVersion, "requirementVersion");
    result.project.requirements = result.project.requirements.filter((item) => item.id !== requirementId);
    result.project.version += 1;
    writeProject(result.project, result.system.id);
    const issueDoc = projectIssues(projectId, result.project, "");
    const meta = touch();
    return { deletedId: requirementId, issues: issueDoc.issues, revision: meta.revision };
  }

  function deleteStage(projectId, requirementId, stageId, expectedRequirementVersion, expectedStageVersion) {
    const result = findStageRecord(projectId, requirementId, stageId);
    assertVersion(result.requirement, expectedRequirementVersion, "requirementVersion");
    assertVersion(result.stage, expectedStageVersion);
    result.requirement.stages = result.requirement.stages.filter((item) => item.id !== stageId);
    result.requirement.version += 1;
    writeProject(result.project, result.system.id);
    const issueDoc = projectIssues(projectId, result.project, "");
    const meta = touch();
    return { deletedId: stageId, issues: issueDoc.issues, revision: meta.revision };
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
      priority: ISSUE_PRIORITIES.includes(input.priority) ? input.priority : "medium",
      dueDate: /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate || "")) ? input.dueDate : "",
      comments: [],
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
    if (Number(input.version) !== Number(issue.version)) {
      const error = new Error("问题已被其他用户更新");
      error.code = "VERSION_CONFLICT";
      error.entity = issue;
      throw error;
    }
    if (input.title != null) issue.title = String(input.title).trim() || issue.title;
    if (input.description != null) issue.description = String(input.description).trim();
    if (input.assigneeUserId != null) issue.assigneeUserId = String(input.assigneeUserId || "");
    if (input.priority != null && ISSUE_PRIORITIES.includes(input.priority)) issue.priority = input.priority;
    if (input.dueDate != null) issue.dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(input.dueDate || "")) ? input.dueDate : "";
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
    if (Number(version) !== Number(issue.version)) {
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

  function addIssueComment(projectId, issueId, body, userId, version) {
    const doc = readIssues(projectId);
    const issue = doc.issues.find((item) => item.id === issueId);
    if (!issue) throw notFound("问题不存在");
    if (Number(version) !== Number(issue.version)) throw versionConflict(issue);
    const text = String(body || "").trim();
    if (!text) throw new Error("评论不能为空");
    issue.comments.push({
      id: uid("comment"),
      body: text,
      authorUserId: userId,
      createdAt: now()
    });
    issue.updatedByUserId = userId;
    issue.updatedAt = now();
    issue.version = Number(issue.version || 1) + 1;
    atomicWriteJson(issuesFile(projectId), doc);
    const meta = touch();
    return { issue, revision: meta.revision };
  }

  function deleteIssue(projectId, issueId, version) {
    const doc = readIssues(projectId);
    const issue = doc.issues.find((item) => item.id === issueId);
    if (!issue) throw notFound("问题不存在");
    if (Number(version) !== Number(issue.version)) throw versionConflict(issue);
    doc.issues = doc.issues.filter((item) => item.id !== issueId);
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
    addIssueComment,
    listSystems,
    createSystem,
    updateSystem,
    deleteSystem,
    createProject,
    updateProject,
    deleteProject,
    createRequirement,
    updateRequirement,
    deleteRequirement,
    createStage,
    updateStage,
    deleteStage,
    deleteIssue,
    readIssues
  };
}

module.exports = { createDataStore, SCHEMA_VERSION };
