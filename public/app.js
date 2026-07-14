const DEFAULT_STAGE_TYPES = ["需求澄清", "工作量及商务", "功能开发", "技术测试", "业务测试"];
let STAGE_TYPES = [...DEFAULT_STAGE_TYPES];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const els = {
  gantt: document.querySelector("#gantt"),
  projectList: document.querySelector("#projectList"),
  workspace: document.querySelector("#workspace"),
  sideResizeHandle: document.querySelector("#sideResizeHandle"),
  projectSectionHead: document.querySelector("#projectSectionHead"),
  addProjectBtn: document.querySelector("#addProjectBtn"),
  addProjectSideBtn: document.querySelector("#addProjectSideBtn"),
  addMilestoneBtn: document.querySelector("#addMilestoneBtn"),
  addDateMarkerBtn: document.querySelector("#addDateMarkerBtn"),
  markerList: document.querySelector("#markerList"),
  systemPicker: document.querySelector("#systemPicker"),
  saveBtn: document.querySelector("#saveBtn"),
  shutdownBtn: document.querySelector("#shutdownBtn"),
  fitDatesBtn: document.querySelector("#fitDatesBtn"),
  viewStart: document.querySelector("#viewStart"),
  viewEnd: document.querySelector("#viewEnd"),
  tooltip: document.querySelector("#tooltip"),
  dialog: document.querySelector("#editorDialog"),
  editorForm: document.querySelector("#editorForm"),
  editorTitle: document.querySelector("#editorTitle"),
  editorGrid: document.querySelector(".editor-grid"),
  editTitleLabel: document.querySelector("#editTitleLabel"),
  editTitle: document.querySelector("#editTitle"),
  editType: document.querySelector("#editType"),
  editStart: document.querySelector("#editStart"),
  editEnd: document.querySelector("#editEnd"),
  editOwner: document.querySelector("#editOwner"),
  editHours: document.querySelector("#editHours"),
  editStatus: document.querySelector("#editStatus"),
  editIssueOpen: document.querySelector("#editIssueOpen"),
  editIssues: document.querySelector("#editIssues"),
  editNotes: document.querySelector("#editNotes"),
  saveEditorBtn: document.querySelector("#saveEditorBtn"),
  deleteEditorBtn: document.querySelector("#deleteEditorBtn")
};

let state = { selectedSystemId: "system-a", selectedProjectId: "", systems: [] };
let view = { start: "", end: "" };
let editing = null;
let systemMenuOpen = false;
let openSystemActionsId = "";
let editingStageNameId = "";
let editingProjectNameId = "";
let editingRequirementNameId = "";
let draggedStage = null;
let saveFlashTimer = 0;
let shouldScrollSelection = false;

const MARKER_COLORS = {
  purple: "紫色",
  blue: "蓝色",
  green: "绿色",
  orange: "橙色",
  red: "红色"
};

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function defaultSystems(projects = []) {
  return [
    { id: "system-a", name: "系统A", projects, dateMarkers: [] },
    { id: "system-b", name: "系统B", projects: [], dateMarkers: [] }
  ];
}

function parseDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value, days) {
  const date = typeof value === "string" ? parseDate(value) : new Date(value);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

function daysBetween(start, end) {
  return Math.round((parseDate(end) - parseDate(start)) / MS_PER_DAY);
}

function isWeekend(value) {
  const day = parseDate(value).getDay();
  return day === 0 || day === 6;
}

function addWorkdays(value, workdaysToAdd) {
  let date = value;
  let added = 0;
  while (added < workdaysToAdd) {
    date = addDays(date, 1);
    if (!isWeekend(date)) added += 1;
  }
  return date;
}

function twoWorkdayEnd(start) {
  return isWeekend(start) ? addWorkdays(start, 2) : addWorkdays(start, 1);
}

function clampStageDates(stage) {
  if (stage.end < stage.start) stage.end = stage.start;
}

function getActiveSystem() {
  let system = state.systems.find((item) => item.id === state.selectedSystemId);
  if (!system) {
    system = state.systems[0];
    state.selectedSystemId = system?.id || "system-a";
  }
  return system;
}

function getActiveProjects() {
  return getActiveSystem()?.projects || [];
}

function getSelectedProject() {
  return getActiveProjects().find((project) => project.id === state.selectedProjectId) || null;
}

function ensureSelectedProject() {
  const projects = getActiveProjects();
  if (!projects.some((project) => project.id === state.selectedProjectId)) {
    state.selectedProjectId = projects[0]?.id || "";
  }
}

function nextSystemName() {
  const index = state.systems.length;
  if (index < 26) return `系统${String.fromCharCode(65 + index)}`;
  return `新系统${index + 1}`;
}

function normalizeMarker(marker) {
  marker.id ||= uid("marker");
  marker.date ||= formatDate(new Date());
  marker.label ||= "投产日";
  marker.type ||= marker.label.includes("投产") ? "production" : "custom";
  marker.color ||= marker.type === "production" ? "purple" : "blue";
  marker.notes ||= "";
}

function normalizeProject(project) {
  project.id ||= uid("project");
  project.name ||= "未命名项目";
  project.version = Number(project.version || 1);
  project.expanded ??= true;
  project.milestones ||= [];
  project.dateMarkers ||= [];
  project.requirements ||= [];
  for (const marker of project.dateMarkers) normalizeMarker(marker);
  for (const requirement of project.requirements) {
    requirement.id ||= uid("req");
    requirement.title ||= "未命名需求";
    requirement.version = Number(requirement.version || 1);
    requirement.expanded ??= true;
    requirement.stages ||= [];
    for (const stage of requirement.stages) {
      stage.id ||= uid("stage");
      stage.version = Number(stage.version || 1);
      stage.type ||= STAGE_TYPES[0];
      stage.title ||= stage.type;
      stage.start ||= formatDate(new Date());
      stage.end ||= stage.start;
      stage.status ||= "未开始";
      stage.hours = Number(stage.hours || 0);
      stage.issueOpen = Boolean(stage.issueOpen);
      clampStageDates(stage);
    }
  }
}

function normalizeState() {
  if (Array.isArray(state.projects)) {
    state = {
      selectedSystemId: "system-a",
      selectedProjectId: state.projects[0]?.id || "",
      systems: defaultSystems(state.projects)
    };
  }

  if (!Array.isArray(state.systems) || !state.systems.length) {
    state.systems = defaultSystems();
  }

  for (const [index, system] of state.systems.entries()) {
    system.id ||= uid("system");
    system.name ||= `系统${String.fromCharCode(65 + index)}`;
    system.version = Number(system.version || 1);
    system.projects ||= [];
    system.dateMarkers ||= [];
    for (const marker of system.dateMarkers) normalizeMarker(marker);
    for (const project of system.projects) normalizeProject(project);
  }
  state.systemsVersion = Number(state.systemsVersion || 1);

  if (!state.systems.some((system) => system.id === state.selectedSystemId)) {
    state.selectedSystemId = state.systems[0].id;
  }
  ensureSelectedProject();
}

async function loadState() {
  const payload = await BoboCollab.loadBootstrap();
  state = payload.state;
  normalizeState();
  fitDates();
  render();
}

async function loadStageConfig() {
  try {
    const res = await fetch("/config/stage-types.json", { cache: "no-store" });
    if (!res.ok) throw new Error("Stage type config not found");
    const stageTypes = await res.json();
    if (!Array.isArray(stageTypes)) throw new Error("Stage type config must be an array");
    const normalized = stageTypes.map((type) => String(type || "").trim()).filter(Boolean);
    STAGE_TYPES = normalized.length ? [...new Set(normalized)] : [...DEFAULT_STAGE_TYPES];
  } catch (error) {
    console.warn(error.message);
    STAGE_TYPES = [...DEFAULT_STAGE_TYPES];
  }
}

async function saveState() {
  normalizeState();
  await BoboCollab.saveState(state);
}

function flashSaveStatus(text = "已自动保存") {
  if (!els.saveBtn) return;
  window.clearTimeout(saveFlashTimer);
  els.saveBtn.textContent = text;
  saveFlashTimer = window.setTimeout(() => { els.saveBtn.textContent = "保存"; }, 1200);
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function applySavedLayout() {
  const sideWidth = Number(localStorage.getItem("bobo.sideWidth"));
  const labelWidth = Number(localStorage.getItem("bobo.labelWidth"));
  if (sideWidth) document.documentElement.style.setProperty("--side-width", `${clampNumber(sideWidth, 220, 460)}px`);
  if (labelWidth) document.documentElement.style.setProperty("--label-width", `${clampNumber(labelWidth, 220, 520)}px`);
}

function startSideResize(event) {
  event.preventDefault();
  const startX = event.clientX;
  const current = Number(getComputedStyle(document.documentElement).getPropertyValue("--side-width").replace("px", "")) || 278;
  const move = (moveEvent) => {
    const width = clampNumber(current + moveEvent.clientX - startX, 220, 460);
    document.documentElement.style.setProperty("--side-width", `${width}px`);
  };
  const up = () => {
    const width = Number(getComputedStyle(document.documentElement).getPropertyValue("--side-width").replace("px", "")) || 278;
    localStorage.setItem("bobo.sideWidth", String(width));
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function startLabelResize(event) {
  event.preventDefault();
  event.stopPropagation();
  const startX = event.clientX;
  const current = Number(getComputedStyle(document.documentElement).getPropertyValue("--label-width").replace("px", "")) || 290;
  const move = (moveEvent) => {
    const width = clampNumber(current + moveEvent.clientX - startX, 220, 520);
    document.documentElement.style.setProperty("--label-width", `${width}px`);
  };
  const up = () => {
    const width = Number(getComputedStyle(document.documentElement).getPropertyValue("--label-width").replace("px", "")) || 290;
    localStorage.setItem("bobo.labelWidth", String(width));
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

async function commitState({ rerender = true, refit = false } = {}) {
  try {
    normalizeState();
    if (refit) fitDates();
    await saveState();
    flashSaveStatus();
    if (rerender) render();
    return true;
  } catch (error) {
    alert(error.message);
    return false;
  }
}

async function commitResource(url, body, { refit = false, rerender = true, allowRetry = true } = {}) {
  try {
    normalizeState();
    if (refit) fitDates();
    const payload = await BoboCollab.saveResource(state, url, { method: "POST", body });
    flashSaveStatus();
    if (rerender) render();
    return payload;
  } catch (error) {
    if (allowRetry && error.payload?.code === "VERSION_CONFLICT") {
      const choice = await BoboCollab.resolveConflict(error, body);
      if (choice === "server") {
        await loadState();
        reopenEditingFromState();
        return null;
      }
      if (choice === "retry") {
        const retryBody = { ...body };
        const versionKey = error.payload.versionField || "version";
        if (versionKey && error.payload.entity?.version != null) retryBody[versionKey] = error.payload.entity.version;
        return commitResource(url, retryBody, { refit, rerender, allowRetry: false });
      }
    }
    alert(error.message);
    return false;
  }
}

async function patchResource(url, body, options = {}) {
  try {
    normalizeState();
    if (options.refit) fitDates();
    const payload = await BoboCollab.saveResource(state, url, { method: "PATCH", body });
    flashSaveStatus();
    if (options.rerender !== false) render();
    return payload;
  } catch (error) {
    if (options.allowRetry !== false && error.payload?.code === "VERSION_CONFLICT") {
      const choice = await BoboCollab.resolveConflict(error, body);
      if (choice === "server") {
        await loadState();
        reopenEditingFromState();
        return null;
      }
      if (choice === "retry") {
        const retryBody = { ...body };
        const versionKey = error.payload.versionField || "version";
        if (versionKey && error.payload.entity?.version != null) retryBody[versionKey] = error.payload.entity.version;
        return patchResource(url, retryBody, { ...options, allowRetry: false });
      }
    }
    alert(error.message);
    return false;
  }
}

async function deleteResource(url, body, options = {}) {
  try {
    const payload = await BoboCollab.saveResource(state, url, { method: "DELETE", body });
    flashSaveStatus();
    if (options.refit) fitDates();
    if (options.rerender !== false) render();
    return payload;
  } catch (error) {
    if (options.allowRetry !== false && error.payload?.code === "VERSION_CONFLICT") {
      const choice = await BoboCollab.resolveConflict(error, body);
      if (choice === "server") {
        await loadState();
        reopenEditingFromState();
        return null;
      }
      if (choice === "retry") {
        const retryBody = { ...body };
        const versionKey = error.payload.versionField || "version";
        if (versionKey && error.payload.entity?.version != null) retryBody[versionKey] = error.payload.entity.version;
        return deleteResource(url, retryBody, { ...options, allowRetry: false });
      }
    }
    alert(error.message);
    return false;
  }
}

function getAllStages() {
  return getActiveProjects().flatMap((project) =>
    project.requirements.flatMap((requirement) =>
      requirement.stages.map((stage) => ({ project, requirement, stage }))
    )
  );
}

function getDateRange() {
  const dates = [];
  for (const { stage } of getAllStages()) dates.push(stage.start, stage.end);
  for (const marker of collectDateMarkers()) dates.push(marker.date);
  if (!dates.length) {
    const today = formatDate(new Date());
    return { start: addDays(today, -3), end: addDays(today, 21) };
  }
  dates.sort();
  return { start: addDays(dates[0], -2), end: addDays(dates[dates.length - 1], 4) };
}

function fitDates() {
  const range = getDateRange();
  view.start = range.start;
  view.end = range.end;
  els.viewStart.value = view.start;
  els.viewEnd.value = view.end;
}

function datesInView() {
  const days = [];
  const count = daysBetween(view.start, view.end);
  for (let index = 0; index <= count; index += 1) days.push(addDays(view.start, index));
  return days;
}

function collectDateMarkers() {
  const markers = [];
  const system = getActiveSystem();
  for (const marker of system.dateMarkers || []) {
    markers.push({ ...marker, scope: "系统", sourceName: system.name });
  }
  for (const project of getActiveProjects()) {
    for (const marker of project.dateMarkers || []) {
      markers.push({ ...marker, scope: "项目", sourceName: project.name, projectId: project.id });
    }
    for (const milestone of project.milestones || []) {
      markers.push({
        id: milestone.id,
        date: milestone.date,
        label: milestone.label,
        type: "milestone",
        color: "red",
        notes: "",
        scope: "节点",
        sourceName: project.name,
        projectId: project.id
      });
    }
  }
  return markers;
}

function markerMap() {
  const map = new Map();
  for (const marker of collectDateMarkers()) {
    const items = map.get(marker.date) || [];
    items.push(marker);
    map.set(marker.date, items);
  }
  return map;
}

function render() {
  ensureSelectedProject();
  els.gantt.innerHTML = "";
  els.projectList.innerHTML = "";
  renderSystemPicker();
  renderProjectList();
  renderMarkerList();
  BoboCollab.savePreferences(state, view);
  const days = datesInView();
  els.gantt.style.setProperty("--day-count", String(days.length));
  const projects = getActiveProjects();
  if (!projects.length) {
    els.gantt.innerHTML = '<div class="empty">当前系统暂无项目，点击左侧“+”开始。</div>';
    return;
  }
  const markers = markerMap();
  els.gantt.append(renderHeader(days, markers));
  for (const project of projects) {
    els.gantt.append(renderProjectRow(project));
    if (!project.expanded) continue;
    for (const requirement of project.requirements) {
      els.gantt.append(renderRequirementRow(project, requirement));
      if (!requirement.expanded) continue;
      for (const stage of requirement.stages) {
        els.gantt.append(renderStageRow(project, requirement, stage));
      }
    }
  }
  if (shouldScrollSelection) {
    scrollSelectionIntoView();
    shouldScrollSelection = false;
  }
}

function renderSystemPicker() {
  if (!els.systemPicker) return;
  const activeSystem = getActiveSystem();
  els.systemPicker.innerHTML = "";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "system-trigger";
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", String(systemMenuOpen));
  trigger.innerHTML = `<span>${escapeHtml(activeSystem.name)}</span><span aria-hidden="true">▾</span>`;
  trigger.addEventListener("click", (event) => {
    event.stopPropagation();
    systemMenuOpen = !systemMenuOpen;
    openSystemActionsId = "";
    renderSystemPicker();
  });
  els.systemPicker.append(trigger);

  if (!systemMenuOpen) return;

  const menu = document.createElement("div");
  menu.className = "system-menu";
  menu.setAttribute("role", "menu");

  for (const system of state.systems) {
    const row = document.createElement("div");
    row.className = "system-option";
    if (system.id === state.selectedSystemId) row.classList.add("active");

    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "system-name-button";
    selectButton.textContent = system.name;
    selectButton.addEventListener("click", () => selectSystem(system.id));

    const moreButton = document.createElement("button");
    moreButton.type = "button";
    moreButton.className = "system-icon-button";
    moreButton.title = "系统操作";
    moreButton.setAttribute("aria-label", `${system.name}操作`);
    moreButton.textContent = "⋯";
    moreButton.addEventListener("click", (event) => {
      event.stopPropagation();
      openSystemActionsId = openSystemActionsId === system.id ? "" : system.id;
      renderSystemPicker();
    });

    row.append(selectButton, moreButton);

    if (openSystemActionsId === system.id) {
      const actions = document.createElement("div");
      actions.className = "system-action-popover";
      const rename = document.createElement("button");
      rename.type = "button";
      rename.textContent = "重命名";
      rename.addEventListener("click", () => renameSystem(system));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "删除系统";
      remove.addEventListener("click", () => deleteSystem(system));
      actions.append(rename, remove);
      row.append(actions);
    }

    menu.append(row);
  }

  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "system-add-button";
  addButton.textContent = "+ 新增系统";
  addButton.addEventListener("click", addSystem);
  menu.append(addButton);

  els.systemPicker.append(menu);
}

async function selectSystem(systemId) {
  state.selectedSystemId = systemId;
  ensureSelectedProject();
  systemMenuOpen = false;
  openSystemActionsId = "";
  fitDates();
  BoboCollab.savePreferences(state, view);
  render();
}

async function addSystem() {
  const systemName = nextSystemName();
  systemMenuOpen = false;
  openSystemActionsId = "";
  const payload = await commitResource("/api/systems", { name: systemName, systemsVersion: state.systemsVersion }, { refit: true });
  if (payload?.state && payload.system) {
    state.selectedSystemId = payload.system.id;
    state.selectedProjectId = "";
    BoboCollab.savePreferences(state, view);
    render();
  }
}

async function renameSystem(system) {
  const name = prompt("系统名称", system.name);
  if (!name || !name.trim()) return;
  systemMenuOpen = false;
  openSystemActionsId = "";
  await patchResource(`/api/systems/${encodeURIComponent(system.id)}`, { name: name.trim(), version: system.version });
}

async function deleteSystem(system) {
  if (state.systems.length <= 1) {
    alert("至少需要保留一个系统。");
    return;
  }
  if ((system.projects || []).length > 0) {
    alert("请先清空或迁移该系统下的数据，再删除系统。");
    return;
  }
  const confirmed = confirm(`确定删除「${system.name}」吗？`);
  if (!confirmed) return;
  systemMenuOpen = false;
  openSystemActionsId = "";
  const payload = await deleteResource(`/api/systems/${encodeURIComponent(system.id)}`, { version: system.version }, { refit: true });
  if (payload?.state && state.selectedSystemId === system.id) {
    state.selectedSystemId = state.systems[0]?.id || "";
    ensureSelectedProject();
    BoboCollab.savePreferences(state, view);
    render();
  }
}

function renderHeader(days, markers) {
  const row = rowEl("header");
  const headerLabel = labelEl("日期");
  const labelResize = document.createElement("button");
  labelResize.type = "button";
  labelResize.className = "label-resize-handle";
  labelResize.title = "调整任务菜单宽度";
  labelResize.setAttribute("aria-label", "调整任务菜单宽度");
  labelResize.addEventListener("pointerdown", startLabelResize);
  headerLabel.append(labelResize);
  row.append(headerLabel);
  for (const day of days) {
    const date = parseDate(day);
    const cell = document.createElement("div");
    cell.className = "day-cell";
    if ([0, 6].includes(date.getDay())) cell.classList.add("weekend");
    if (day === formatDate(new Date())) cell.classList.add("today");
    if (markers.has(day)) {
      const dayMarkers = markers.get(day);
      cell.classList.add("marked");
      const primaryColor = dayMarkers.find((marker) => marker.color && marker.color !== "red")?.color || dayMarkers[0].color;
      if (primaryColor) cell.classList.add(`marker-${primaryColor}`);
      if (dayMarkers.some((marker) => marker.color === "red")) cell.classList.add("milestone");
      cell.title = dayMarkers.map((marker) => {
        const note = marker.notes ? `\n备注：${marker.notes}` : "";
        return `${marker.scope}：${marker.sourceName} / ${marker.label}${note}`;
      }).join("\n");
      const dot = document.createElement("span");
      dot.className = "date-marker-dot";
      dot.setAttribute("aria-hidden", "true");
      cell.append(dot);
    }
    const text = document.createElement("span");
    text.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
    cell.append(text);
    row.append(cell);
  }
  return row;
}

function rowEl(extraClass) {
  const row = document.createElement("div");
  row.className = `gantt-row ${extraClass || ""}`.trim();
  return row;
}

function labelEl(title, indent = "", meta = "") {
  const cell = document.createElement("div");
  cell.className = "label-cell";
  if (indent) {
    const spacer = document.createElement("span");
    spacer.textContent = indent;
    spacer.setAttribute("aria-hidden", "true");
    cell.append(spacer);
  }
  const titleEl = document.createElement("span");
  titleEl.className = "row-title";
  titleEl.textContent = title;
  cell.append(titleEl);
  if (meta) {
    const metaEl = document.createElement("span");
    metaEl.className = "row-meta";
    metaEl.textContent = meta;
    cell.append(metaEl);
  }
  return cell;
}

function iconButton(label, text, onClick, extraClass = "") {
  const button = document.createElement("button");
  button.className = `icon-button ${extraClass}`.trim();
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.textContent = text;
  button.addEventListener("click", onClick);
  return button;
}

function toggleButton(expanded, onClick) {
  const button = document.createElement("button");
  button.className = `toggle ${expanded ? "expanded" : "collapsed"}`;
  button.type = "button";
  button.textContent = expanded ? "▾" : "▸";
  button.addEventListener("click", async (event) => {
    event.stopPropagation();
    await onClick(event);
  });
  return button;
}

function gridFill(onDblClick) {
  const grid = document.createElement("div");
  grid.className = "row-grid";
  if (onDblClick) grid.addEventListener("dblclick", onDblClick);
  return grid;
}

function getDateFromGridEvent(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  const offset = Math.max(0, event.clientX - rect.left);
  const dayIndex = Math.min(daysBetween(view.start, view.end), Math.floor(offset / Number(getComputedStyle(document.documentElement).getPropertyValue("--day-width").replace("px", ""))));
  return addDays(view.start, dayIndex);
}

function renderProjectRow(project) {
  const selected = project.id === state.selectedProjectId;
  const row = rowEl(`group-row ${project.expanded ? "expanded" : ""} ${selected ? "selected" : ""}`);
  const label = labelEl(project.name, "", `${project.requirements.length} 需求`);
  label.prepend(toggleButton(project.expanded, async () => {
    project.expanded = !project.expanded;
    state.selectedProjectId = project.id;
    BoboCollab.savePreferences(state, view);
    render();
  }));
  label.append(
    iconButton("编辑项目", "✎", (event) => {
      event.stopPropagation();
      openProjectEditor(project);
    }),
    iconButton("新增需求", "+", async (event) => {
      event.stopPropagation();
      await addRequirement(project);
    })
  );
  label.addEventListener("click", async (event) => {
    if (event.target.closest("button, input, textarea, select")) return;
    await selectProject(project);
  });
  row.append(label, gridFill());
  return row;
}

function renderRequirementRow(project, requirement) {
  const row = rowEl(`requirement-row ${requirement.expanded ? "expanded" : ""} ${project.id === state.selectedProjectId ? "selected-context" : ""}`);
  const label = document.createElement("div");
  label.className = "label-cell requirement-label";
  const title = document.createElement("input");
  title.className = "requirement-name-input";
  title.value = requirement.title;
  title.disabled = editingRequirementNameId !== requirement.id;
  title.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") await saveInlineRequirementName(requirement, title);
    if (event.key === "Escape") {
      editingRequirementNameId = "";
      render();
    }
  });
  label.prepend(toggleButton(requirement.expanded, async () => {
    requirement.expanded = !requirement.expanded;
    state.selectedProjectId = project.id;
    BoboCollab.savePreferences(state, view);
    render();
  }));
  label.append(
    title,
    iconButton("编辑需求", "✎", (event) => {
      event.stopPropagation();
      openRequirementEditor(project, requirement);
    }),
    iconButton("新增实施阶段", "+", async (event) => {
      event.stopPropagation();
      await addStageToRequirement(requirement);
    })
  );
  row.dataset.requirementId = requirement.id;
  row.append(label, gridFill());
  return row;
}

function renderStageRow(project, requirement, stage) {
  const row = rowEl("stage-row");
  row.dataset.stageId = stage.id;
  const label = document.createElement("div");
  label.className = "label-cell stage-label";

  const drag = document.createElement("button");
  drag.type = "button";
  drag.className = "drag-handle";
  drag.draggable = true;
  drag.title = "拖动排序";
  drag.setAttribute("aria-label", "拖动排序");
  drag.textContent = "≡";
  drag.addEventListener("dragstart", (event) => {
    draggedStage = { requirement, stage };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", stage.id);
    }
  });
  drag.addEventListener("dragend", () => {
    draggedStage = null;
    clearStageDropIndicators();
  });

  const title = document.createElement("input");
  title.className = "stage-name-input";
  title.value = stage.type;
  title.disabled = editingStageNameId !== stage.id;
  title.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") await saveInlineStageName(stage, title);
    if (event.key === "Escape") {
      editingStageNameId = "";
      render();
    }
  });

  const edit = iconButton(editingStageNameId === stage.id ? "保存阶段名称" : "编辑阶段名称", editingStageNameId === stage.id ? "✓" : "✎", async (event) => {
    event.stopPropagation();
    if (editingStageNameId === stage.id) {
      await saveInlineStageName(stage, title);
    } else {
      editingStageNameId = stage.id;
      render();
      document.querySelector(`[data-stage-id="${stage.id}"] .stage-name-input`)?.focus();
    }
  });

  label.append(drag, title, edit);
  row.append(label);

  row.addEventListener("dragover", (event) => handleStageDragOver(event, requirement, stage, row));
  row.addEventListener("dragleave", (event) => {
    if (!row.contains(event.relatedTarget)) clearStageDropIndicators();
  });
  row.addEventListener("drop", async (event) => handleStageDrop(event, requirement, stage, row));

  const grid = gridFill(async (event) => {
    if (draggedStage || event.target.closest(".stage-bar")) return;
    const date = getDateFromGridEvent(event);
    await createStageFromGrid(project, requirement, date);
  });

  const viewEndOffset = daysBetween(view.start, view.end);
  const stageStart = daysBetween(view.start, stage.start);
  const stageEnd = daysBetween(view.start, stage.end);
  const start = Math.max(0, stageStart);
  const end = Math.min(viewEndOffset, stageEnd);
  if (end >= 0 && start <= viewEndOffset) {
    const bar = document.createElement("div");
    const visualState = getStageVisualState(stage);
    bar.className = `stage-bar ${stage.issueOpen ? "issue" : ""}`;
    bar.dataset.status = stage.status;
    bar.dataset.visualState = visualState;
    bar.style.gridColumn = `${start + 1} / ${end + 2}`;
    const issueState = stage.issueOpen ? "open" : "resolved";
    const issueLabel = stage.issueOpen ? "存在未解决问题" : "问题已全部解决";
    bar.innerHTML = `<span class="stage-issue-dot ${issueState}" role="img" aria-label="${issueLabel}" title="${issueLabel}"></span><span class="stage-bar-title">${escapeHtml(stage.title)}</span>`;
    bar.addEventListener("mouseenter", (event) => showTooltip(event, project, requirement, stage));
    bar.addEventListener("mousemove", moveTooltip);
    bar.addEventListener("mouseleave", hideTooltip);
    bar.addEventListener("dblclick", () => openStageEditor(project, requirement, stage));
    grid.append(bar);
  }
  row.append(grid);
  return row;
}

async function saveInlineStageName(stage, input) {
  const value = input.value.trim();
  if (!value) return;
  const project = getActiveProjects().find((item) => item.requirements.some((requirement) => requirement.stages.includes(stage)));
  const requirement = project?.requirements.find((item) => item.stages.includes(stage));
  if (!project || !requirement) return;
  const title = !stage.title || STAGE_TYPES.includes(stage.title) ? value : stage.title;
  const payload = await patchResource(`/api/projects/${encodeURIComponent(project.id)}/requirements/${encodeURIComponent(requirement.id)}/stages/${encodeURIComponent(stage.id)}`, {
    type: value,
    title,
    version: stage.version
  });
  if (payload) {
    editingStageNameId = "";
    render();
  }
}

async function saveInlineRequirementName(requirement, input) {
  const value = input.value.trim();
  if (!value) return;
  const project = getActiveProjects().find((item) => item.requirements.includes(requirement));
  if (!project) return;
  const payload = await patchResource(`/api/projects/${encodeURIComponent(project.id)}/requirements/${encodeURIComponent(requirement.id)}`, {
    title: value,
    version: requirement.version
  });
  if (payload) {
    editingRequirementNameId = "";
    render();
  }
}

function clearStageDropIndicators() {
  document.querySelectorAll(".stage-row.drag-over, .stage-row.drag-before, .stage-row.drag-after").forEach((item) => {
    item.classList.remove("drag-over", "drag-before", "drag-after");
  });
}

function getStageDropPlacement(row, event) {
  const rect = row.getBoundingClientRect();
  return event.clientY < rect.top + rect.height / 2 ? "before" : "after";
}

function canDropStage(requirement, stage) {
  return draggedStage && draggedStage.requirement === requirement && draggedStage.stage !== stage;
}

function handleStageDragOver(event, requirement, stage, row) {
  if (!canDropStage(requirement, stage)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const placement = getStageDropPlacement(row, event);
  clearStageDropIndicators();
  row.classList.add("drag-over", placement === "before" ? "drag-before" : "drag-after");
}

async function handleStageDrop(event, requirement, stage, row) {
  if (!canDropStage(requirement, stage)) return;
  event.preventDefault();
  const placement = getStageDropPlacement(row, event);
  clearStageDropIndicators();
  const sourceStage = draggedStage.stage;
  draggedStage = null;
  await moveStage(requirement, sourceStage, stage, placement);
}

async function moveStage(requirement, sourceStage, targetStage, placement = "before") {
  const stages = [...requirement.stages];
  const from = stages.findIndex((stage) => stage.id === sourceStage.id);
  if (from < 0 || sourceStage.id === targetStage.id) return;
  const [item] = stages.splice(from, 1);
  let to = stages.findIndex((stage) => stage.id === targetStage.id);
  if (to < 0) {
    return;
  }
  if (placement === "after") to += 1;
  stages.splice(to, 0, item);
  const project = getActiveProjects().find((item) => item.requirements.includes(requirement));
  if (!project) return;
  await patchResource(`/api/projects/${encodeURIComponent(project.id)}/requirements/${encodeURIComponent(requirement.id)}`, {
    stageIds: stages.map((item) => item.id),
    version: requirement.version
  });
}

function renderProjectList() {
  for (const project of getActiveProjects()) {
    const selected = project.id === state.selectedProjectId;
    const item = document.createElement("div");
    item.tabIndex = 0;
    item.setAttribute("role", "button");
    item.dataset.projectId = project.id;
    item.className = `project-chip ${selected ? "selected" : ""}`;
    item.addEventListener("click", () => selectProject(project));
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectProject(project);
    });

    const text = document.createElement("div");
    text.className = "project-chip-text";
    const nameInput = document.createElement("input");
    nameInput.className = "project-name-input";
    nameInput.value = project.name;
    nameInput.disabled = editingProjectNameId !== project.id;
    nameInput.addEventListener("click", (event) => {
      if (editingProjectNameId === project.id) event.stopPropagation();
    });
    nameInput.addEventListener("keydown", async (event) => {
      if (event.key === "Enter") await saveInlineProjectName(project, nameInput);
      if (event.key === "Escape") {
        editingProjectNameId = "";
        render();
      }
    });
    const meta = document.createElement("span");
    meta.textContent = `${project.requirements.length} 个需求，${(project.milestones || []).length + (project.dateMarkers || []).length} 个标记`;
    text.append(nameInput, meta);

    const actions = document.createElement("div");
    actions.className = "mini-actions";
    actions.append(
      iconButton("编辑项目", "✎", (event) => {
        event.stopPropagation();
        openProjectEditor(project);
      })
    );
    item.append(text, actions);
    els.projectList.append(item);
  }
}

function renderMarkerList() {
  if (!els.markerList) return;
  els.markerList.innerHTML = "";
  const system = getActiveSystem();
  const selectedProject = getSelectedProject();
  const visibleMarkers = [
    ...(system.dateMarkers || []).map((marker) => ({ marker, owner: system, scope: "系统", sourceName: system.name })),
    ...((selectedProject?.dateMarkers || []).map((marker) => ({ marker, owner: selectedProject, scope: "项目", sourceName: selectedProject.name })))
  ];

  if (!visibleMarkers.length) {
    const empty = document.createElement("div");
    empty.className = "marker-empty";
    empty.textContent = "暂无日期标记";
    els.markerList.append(empty);
    return;
  }

  for (const item of visibleMarkers) {
    const row = document.createElement("div");
    row.className = `marker-item marker-${item.marker.color || "blue"}`;
    const text = document.createElement("span");
    text.title = item.marker.notes || "";
    text.textContent = `${item.marker.date} ${item.marker.label} · ${MARKER_COLORS[item.marker.color] || "默认"} · ${item.scope}`;
    const remove = iconButton("删除日期标记", "×", async () => deleteDateMarker(item.owner, item.marker), "danger-icon");
    row.append(text, remove);
    els.markerList.append(row);
  }
}

async function selectProject(project) {
  state.selectedProjectId = project.id;
  project.expanded = true;
  shouldScrollSelection = true;
  fitDates();
  BoboCollab.savePreferences(state, view);
  render();
}

function getStageVisualState(stage, today = formatDate(new Date())) {
  if (stage.status === "超期未完成") return "overdue";
  if (stage.status === "暂停") return "paused";
  if (stage.status === "已完成") return "completed";
  if (stage.end < today) return "historical";
  if (stage.start > today) return "upcoming";
  return "current";
}

function getStageVisualLabel(visualState) {
  return {
    current: "当前进行区间",
    upcoming: "未开始",
    historical: "历史任务",
    overdue: "超期未完成",
    paused: "暂停",
    completed: "已完成"
  }[visualState] || "未开始";
}

function scrollSelectionIntoView() {
  const panel = document.querySelector(".gantt-panel");
  const target = document.querySelector(".gantt-row.group-row.selected");
  if (!panel || !target) return;

  const panelRect = panel.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const headerHeight = document.querySelector(".gantt-row.header")?.getBoundingClientRect().height || 0;
  panel.scrollTop += targetRect.top - panelRect.top - headerHeight;
}

function showTooltip(event, project, requirement, stage) {
  const visualState = getStageVisualState(stage);
  els.tooltip.hidden = false;
  els.tooltip.innerHTML = `
    <strong>${escapeHtml(stage.title)}</strong>
    <div>${escapeHtml(project.name)} / ${escapeHtml(requirement.title)}</div>
    <div>${stage.start} 至 ${stage.end}</div>
    <div>负责人：${escapeHtml(stage.owner || "未分配")} · 工时：${Number(stage.hours || 0)}</div>
    <div>状态：${escapeHtml(stage.status)} · 视觉：${escapeHtml(getStageVisualLabel(visualState))} · 问题：${stage.issueOpen ? "未关闭" : "已关闭"}</div>
    ${stage.issues ? `<div>问题说明：${escapeHtml(stage.issues)}</div>` : ""}
  `;
  moveTooltip(event);
}

function moveTooltip(event) {
  els.tooltip.style.left = `${event.clientX + 14}px`;
  els.tooltip.style.top = `${event.clientY + 14}px`;
}

function hideTooltip() {
  els.tooltip.hidden = true;
}

function setEditorMode(kind) {
  const stageMode = kind === "stage";
  BoboCollab.resetEditor(kind);
  els.editorGrid?.classList.toggle("compact", !stageMode);
  els.editTitleLabel.textContent = kind === "project" ? "项目名称" : kind === "requirement" ? "需求名称" : "标题";

  for (const control of [els.editType, els.editStart, els.editEnd, els.editOwner, els.editHours, els.editStatus, els.editIssueOpen, els.editIssues, els.editNotes]) {
    control.disabled = !stageMode;
  }
}

function openProjectEditor(project) {
  editing = { kind: "project", project };
  state.selectedProjectId = project.id;
  setEditorMode("project");
  els.editorTitle.textContent = `编辑项目 / ${project.name}`;
  els.editTitle.value = project.name || "";
  els.dialog.showModal();
  els.editTitle.focus();
  els.editTitle.select();
}

function openRequirementEditor(project, requirement) {
  editing = { kind: "requirement", project, requirement };
  state.selectedProjectId = project.id;
  setEditorMode("requirement");
  els.editorTitle.textContent = `编辑需求 / ${requirement.title}`;
  els.editTitle.value = requirement.title || "";
  els.dialog.showModal();
  els.editTitle.focus();
  els.editTitle.select();
}

function openStageEditor(project, requirement, stage) {
  editing = { kind: "stage", project, requirement, stage };
  state.selectedProjectId = project.id;
  setEditorMode("stage");
  els.editorTitle.textContent = `${requirement.title} / ${stage.type}`;
  els.editTitle.value = stage.title || "";
  renderStageTypeOptions(stage);
  els.editStart.value = stage.start;
  els.editEnd.value = stage.end;
  els.editOwner.value = stage.owner || "";
  els.editHours.value = String(stage.hours || 0);
  els.editStatus.value = stage.status || "未开始";
  els.editIssueOpen.checked = Boolean(stage.issueOpen);
  els.editIssues.value = stage.issues || "";
  els.editNotes.value = stage.notes || "";
  BoboCollab.openStageIssues(project, requirement, stage);
  els.dialog.showModal();
  els.editTitle.focus();
}

function reopenEditingFromState() {
  if (!editing) return;
  const previous = {
    kind: editing.kind,
    projectId: editing.project?.id,
    requirementId: editing.requirement?.id,
    stageId: editing.stage?.id
  };
  const project = state.systems.flatMap((system) => system.projects || [])
    .find((item) => item.id === previous.projectId);
  const requirement = project?.requirements.find((item) => item.id === previous.requirementId);
  const stage = requirement?.stages.find((item) => item.id === previous.stageId);

  if (els.dialog.open) els.dialog.close();
  editing = null;
  if (!project) return;
  if (previous.kind === "project") openProjectEditor(project);
  else if (previous.kind === "requirement" && requirement) openRequirementEditor(project, requirement);
  else if (previous.kind === "stage" && requirement && stage) openStageEditor(project, requirement, stage);
}

async function saveEditor() {
  if (!editing) return;
  const value = els.editTitle.value.trim();
  if (!value && editing.kind !== "stage") {
    alert("名称不能为空");
    return;
  }

  let payload = null;
  if (editing.kind === "project") {
    payload = await patchResource(`/api/projects/${encodeURIComponent(editing.project.id)}`, {
      name: value,
      version: editing.project.version
    }, { refit: true, rerender: false });
    state.selectedProjectId = editing.project.id;
  } else if (editing.kind === "requirement") {
    payload = await patchResource(`/api/projects/${encodeURIComponent(editing.project.id)}/requirements/${encodeURIComponent(editing.requirement.id)}`, {
      title: value,
      version: editing.requirement.version
    }, { refit: true, rerender: false });
    state.selectedProjectId = editing.project.id;
  } else if (editing.kind === "stage") {
    const stage = editing.stage;
    const nextType = els.editType.value;
    const start = els.editStart.value;
    const end = els.editEnd.value < start ? start : els.editEnd.value;
    payload = await patchResource(`/api/projects/${encodeURIComponent(editing.project.id)}/requirements/${encodeURIComponent(editing.requirement.id)}/stages/${encodeURIComponent(stage.id)}`, {
      title: value || nextType,
      type: nextType,
      start,
      end,
      owner: els.editOwner.value.trim(),
      hours: Number(els.editHours.value || 0),
      status: els.editStatus.value,
      notes: els.editNotes.value.trim(),
      version: stage.version
    }, { refit: true, rerender: false });
    state.selectedProjectId = editing.project.id;
  }

  if (!payload) return;

  editing = null;
  els.dialog.close();
  render();
}

function renderStageTypeOptions(currentStage) {
  const defaultSet = new Set(STAGE_TYPES);
  const seen = new Set();
  const options = [];
  const currentType = String(currentStage?.type || STAGE_TYPES[0] || "").trim();

  const addOption = (type) => {
    const value = String(type || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    options.push(value);
  };

  STAGE_TYPES.forEach(addOption);
  addOption(currentType);

  els.editType.replaceChildren();
  for (const type of options) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = type;
    if (!defaultSet.has(type)) option.dataset.custom = "true";
    els.editType.append(option);
  }

  els.editType.value = currentType;
}

async function deleteEditor() {
  if (!editing) return;

  if (editing.kind === "project") {
    const project = editing.project;
    const markerCount = (project.milestones || []).length + (project.dateMarkers || []).length;
    const confirmed = confirm(`确定删除项目「${project.name}」及其 ${project.requirements.length} 个需求、全部阶段和 ${markerCount} 个标记吗？`);
    if (!confirmed) return;
    const system = getActiveSystem();
    const payload = await deleteResource(`/api/projects/${encodeURIComponent(project.id)}`, {
      systemVersion: system.version,
      version: project.version
    }, { refit: true, rerender: false });
    if (!payload) return;
    state.selectedProjectId = getActiveProjects()[0]?.id || "";
  } else if (editing.kind === "requirement") {
    const { project, requirement } = editing;
    const confirmed = confirm(`确定删除需求「${requirement.title}」及其全部阶段吗？`);
    if (!confirmed) return;
    const payload = await deleteResource(`/api/projects/${encodeURIComponent(project.id)}/requirements/${encodeURIComponent(requirement.id)}`, {
      projectVersion: project.version,
      version: requirement.version
    }, { refit: true, rerender: false });
    if (!payload) return;
    state.selectedProjectId = project.id;
  } else if (editing.kind === "stage") {
    const { requirement, stage } = editing;
    const confirmed = confirm(`确定删除阶段「${stage.title || stage.type}」吗？`);
    if (!confirmed) return;
    const payload = await deleteResource(`/api/projects/${encodeURIComponent(editing.project.id)}/requirements/${encodeURIComponent(requirement.id)}/stages/${encodeURIComponent(stage.id)}`, {
      requirementVersion: requirement.version,
      version: stage.version
    }, { refit: true, rerender: false });
    if (!payload) return;
  }

  editing = null;
  els.dialog.close();
  BoboCollab.savePreferences(state, view);
  render();
}
async function addProject() {
  const name = prompt("项目名称");
  if (!name || !name.trim()) return;
  const system = getActiveSystem();
  const payload = await commitResource(`/api/systems/${encodeURIComponent(system.id)}/projects`, {
    name: name.trim(),
    systemVersion: system.version
  }, { refit: true });
  if (payload?.project) {
    state.selectedProjectId = payload.project.id;
    BoboCollab.savePreferences(state, view);
    render();
  }
}

async function saveInlineProjectName(project, input) {
  const value = input.value.trim();
  if (!value) return;
  const payload = await patchResource(`/api/projects/${encodeURIComponent(project.id)}`, { name: value, version: project.version });
  if (payload) {
    editingProjectNameId = "";
    state.selectedProjectId = project.id;
    render();
  }
}

async function addRequirement(project) {
  const title = prompt(`为「${project.name}」添加需求`);
  if (!title || !title.trim()) return;
  const today = formatDate(new Date());
  const payload = await commitResource(`/api/projects/${encodeURIComponent(project.id)}/requirements`, {
    title: title.trim(),
    projectVersion: project.version,
    stages: STAGE_TYPES.map((type, index) => ({
      type,
      title: type,
      start: addDays(today, index * 2),
      end: addDays(today, index * 2 + 1),
      owner: "",
      hours: 0,
      status: "未开始",
      notes: ""
    }))
  }, { refit: true });
  if (payload?.project) {
    state.selectedProjectId = project.id;
    BoboCollab.savePreferences(state, view);
    render();
  }
}

async function deleteRequirement(project, requirement) {
  const confirmed = confirm(`确定删除需求「${requirement.title}」及其全部阶段吗？`);
  if (!confirmed) return;
  const payload = await deleteResource(`/api/projects/${encodeURIComponent(project.id)}/requirements/${encodeURIComponent(requirement.id)}`, {
    projectVersion: project.version,
    version: requirement.version
  }, { refit: true });
  if (payload) {
    state.selectedProjectId = project.id;
    BoboCollab.savePreferences(state, view);
    render();
  }
}

async function addStageToRequirement(requirement) {
  const today = formatDate(new Date());
  const stage = createStage("新阶段", STAGE_TYPES[0], today, addDays(today, 2));
  const project = getActiveProjects().find((item) => item.requirements.includes(requirement));
  if (!project) return;
  const payload = await commitResource(`/api/projects/${encodeURIComponent(project.id)}/requirements/${encodeURIComponent(requirement.id)}/stages`, {
    ...stage,
    requirementVersion: requirement.version
  }, { refit: true });
  if (payload?.stage) {
    const currentProject = getActiveProjects().find((item) => item.id === project.id);
    const currentRequirement = currentProject?.requirements.find((item) => item.id === requirement.id);
    const currentStage = currentRequirement?.stages.find((item) => item.id === payload.stage.id);
    if (currentProject && currentRequirement && currentStage) openStageEditor(currentProject, currentRequirement, currentStage);
  }
}

function createStage(title, type, start, end) {
  return {
    id: uid("stage"),
    type,
    title,
    start,
    end,
    owner: "",
    hours: 0,
    status: "未开始",
    issueOpen: start > formatDate(new Date()),
    issues: "",
    notes: ""
  };
}

async function createStageFromGrid(project, requirement, start) {
  const stage = createStage("新任务", STAGE_TYPES[0], start, twoWorkdayEnd(start));
  const payload = await commitResource(`/api/projects/${encodeURIComponent(project.id)}/requirements/${encodeURIComponent(requirement.id)}/stages`, {
    ...stage,
    requirementVersion: requirement.version
  }, { refit: true });
  if (payload?.stage) {
    state.selectedProjectId = project.id;
    const currentProject = getActiveProjects().find((item) => item.id === project.id);
    const currentRequirement = currentProject?.requirements.find((item) => item.id === requirement.id);
    const currentStage = currentRequirement?.stages.find((item) => item.id === payload.stage.id);
    if (currentProject && currentRequirement && currentStage) openStageEditor(currentProject, currentRequirement, currentStage);
  }
}

async function addDateMarker() {
  const project = getSelectedProject();
  const scope = prompt(project ? "标记范围：输入 1 为系统级，输入 2 为当前项目级" : "当前未选择项目，只能新增系统级标记。输入 1 继续", "1");
  if (!scope) return;
  const isProjectScope = scope.trim() === "2" && project;
  const date = prompt("标记日期（YYYY-MM-DD）", formatDate(new Date()));
  if (!date || Number.isNaN(parseDate(date).getTime())) return;
  const label = prompt("标记名称", "投产日");
  if (!label || !label.trim()) return;
  const colorInput = prompt("标记颜色：紫色/蓝色/绿色/橙色/红色，可留空使用默认颜色", "");
  const color = resolveMarkerColor(colorInput, label);
  const notes = prompt("备注（可留空）", "") || "";
  const type = label.includes("投产") ? "production" : "custom";
  const marker = {
    id: uid("marker"),
    date,
    label: label.trim(),
    type,
    color,
    notes: notes.trim()
  };
  const owner = isProjectScope ? project : getActiveSystem();
  const nextMarkers = [...(owner.dateMarkers || []), marker];
  const url = isProjectScope
    ? `/api/projects/${encodeURIComponent(project.id)}`
    : `/api/systems/${encodeURIComponent(owner.id)}`;
  const payload = await patchResource(url, {
    dateMarkers: nextMarkers,
    version: owner.version
  }, { refit: true });
  if (payload) {
    state.selectedProjectId = isProjectScope ? project.id : state.selectedProjectId;
    BoboCollab.savePreferences(state, view);
  }
}

function resolveMarkerColor(input, label) {
  const value = (input || "").trim().toLowerCase();
  const colorMap = {
    "紫": "purple",
    "紫色": "purple",
    purple: "purple",
    "蓝": "blue",
    "蓝色": "blue",
    blue: "blue",
    "绿": "green",
    "绿色": "green",
    green: "green",
    "橙": "orange",
    "橙色": "orange",
    orange: "orange",
    "红": "red",
    "红色": "red",
    red: "red"
  };
  if (colorMap[value]) return colorMap[value];
  return label.includes("投产") ? "purple" : "blue";
}

async function deleteDateMarker(owner, marker) {
  const confirmed = confirm(`确定删除日期标记「${marker.label}」吗？`);
  if (!confirmed) return;
  const url = owner.projects ? `/api/systems/${encodeURIComponent(owner.id)}` : `/api/projects/${encodeURIComponent(owner.id)}`;
  await patchResource(url, {
    dateMarkers: (owner.dateMarkers || []).filter((item) => item.id !== marker.id),
    version: owner.version
  }, { refit: true });
}

async function shutdownServer() {
  const confirmed = confirm("确定要关闭 Bobo 服务吗？\n关闭后需要重新运行 run.bat 才能打开。");
  if (!confirmed) return;

  try {
    const res = await fetch("/api/shutdown", { method: "POST" });
    if (res.status === 403) {
      alert("为了避免局域网误关服务，请在服务所在电脑上打开 localhost 后再关闭，或直接运行 stop.bat。");
      return;
    }
    if (!res.ok) throw new Error("Shutdown request failed");
    document.body.innerHTML = '<div class="shutdown-screen"><h1>Bobo 已关闭</h1><p>需要再次使用时，请重新运行 run.bat。</p></div>';
  } catch (error) {
    alert(`关闭失败: ${error.message}`);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

els.editType.addEventListener("change", () => {
  if (editing?.kind !== "stage") return;
  const nextType = els.editType.value;
  els.editorTitle.textContent = `${editing.requirement.title} / ${nextType}`;
});

els.addProjectBtn?.addEventListener("click", addProject);
els.addProjectSideBtn?.addEventListener("click", addProject);
els.addMilestoneBtn?.addEventListener("click", addDateMarker);
els.addDateMarkerBtn?.addEventListener("click", addDateMarker);
els.sideResizeHandle?.addEventListener("pointerdown", startSideResize);
els.fitDatesBtn.addEventListener("click", () => { fitDates(); render(); });
els.viewStart.addEventListener("change", () => { view.start = els.viewStart.value; render(); });
els.viewEnd.addEventListener("change", () => { view.end = els.viewEnd.value; render(); });
els.saveBtn.addEventListener("click", async () => {
  try {
    await saveState();
    flashSaveStatus("已保存");
  } catch (error) {
    alert(error.message);
  }
});
els.shutdownBtn?.addEventListener("click", shutdownServer);
els.editorForm.addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  saveEditor();
});
els.dialog.addEventListener("close", () => {
  editing = null;
});
els.saveEditorBtn.addEventListener("click", saveEditor);
els.deleteEditorBtn.addEventListener("click", deleteEditor);
document.addEventListener("click", (event) => {
  if (!systemMenuOpen || els.systemPicker?.contains(event.target)) return;
  systemMenuOpen = false;
  openSystemActionsId = "";
  renderSystemPicker();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !systemMenuOpen) return;
  systemMenuOpen = false;
  openSystemActionsId = "";
  renderSystemPicker();
});

applySavedLayout();

async function init() {
  await loadStageConfig();
  await loadState();
  BoboCollab.configure({
    onStateChanged: () => render(),
    onExternalChange: async () => loadState()
  });
}

init().catch((error) => {
  els.gantt.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
});
