const STAGE_TYPES = ["需求澄清", "工作量评估", "功能N-开发", "技术测试", "业务测试"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const els = {
  gantt: document.querySelector("#gantt"),
  projectList: document.querySelector("#projectList"),
  addProjectBtn: document.querySelector("#addProjectBtn"),
  addMilestoneBtn: document.querySelector("#addMilestoneBtn"),
  saveBtn: document.querySelector("#saveBtn"),
  fitDatesBtn: document.querySelector("#fitDatesBtn"),
  viewStart: document.querySelector("#viewStart"),
  viewEnd: document.querySelector("#viewEnd"),
  tooltip: document.querySelector("#tooltip"),
  dialog: document.querySelector("#editorDialog"),
  editorTitle: document.querySelector("#editorTitle"),
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
  saveStageBtn: document.querySelector("#saveStageBtn"),
  deleteStageBtn: document.querySelector("#deleteStageBtn")
};

let state = { projects: [] };
let view = { start: "", end: "" };
let editing = null;

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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

function clampStageDates(stage) {
  if (stage.end < stage.start) stage.end = stage.start;
}

function getAllStages() {
  return state.projects.flatMap((project) =>
    project.requirements.flatMap((requirement) =>
      requirement.stages.map((stage) => ({ project, requirement, stage }))
    )
  );
}

function getDateRange() {
  const dates = [];
  for (const { stage } of getAllStages()) dates.push(stage.start, stage.end);
  for (const project of state.projects) {
    for (const milestone of project.milestones || []) dates.push(milestone.date);
  }
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

async function loadState() {
  const res = await fetch("/api/state");
  state = await res.json();
  normalizeState();
  fitDates();
  render();
}

function normalizeState() {
  state.projects ||= [];
  for (const project of state.projects) {
    project.expanded ??= true;
    project.milestones ||= [];
    project.requirements ||= [];
    for (const requirement of project.requirements) {
      requirement.expanded ??= true;
      requirement.stages ||= [];
      for (const stage of requirement.stages) {
        stage.status ||= "未开始";
        stage.hours = Number(stage.hours || 0);
        stage.issueOpen = Boolean(stage.issueOpen);
        clampStageDates(stage);
      }
    }
  }
}

async function saveState() {
  normalizeState();
  const res = await fetch("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state)
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "保存失败" }));
    throw new Error(error.error || "保存失败");
  }
}

function datesInView() {
  const days = [];
  const count = daysBetween(view.start, view.end);
  for (let index = 0; index <= count; index += 1) days.push(addDays(view.start, index));
  return days;
}

function milestoneMap() {
  const map = new Map();
  for (const project of state.projects) {
    for (const milestone of project.milestones || []) {
      const items = map.get(milestone.date) || [];
      items.push(`${project.name}: ${milestone.label}`);
      map.set(milestone.date, items);
    }
  }
  return map;
}

function render() {
  els.gantt.innerHTML = "";
  els.projectList.innerHTML = "";
  renderProjectList();
  const days = datesInView();
  els.gantt.style.setProperty("--day-count", String(days.length));
  if (!state.projects.length) {
    els.gantt.innerHTML = '<div class="empty">暂无项目，点击“+ 项目”开始。</div>';
    return;
  }
  const milestones = milestoneMap();
  els.gantt.append(renderHeader(days, milestones));
  for (const project of state.projects) {
    els.gantt.append(renderProjectRow(project));
    if (!project.expanded) continue;
    for (const requirement of project.requirements) {
      els.gantt.append(renderRequirementRow(project, requirement));
      if (!requirement.expanded) continue;
      for (const stage of requirement.stages) els.gantt.append(renderStageRow(project, requirement, stage));
    }
  }
}

function renderHeader(days, milestones) {
  const row = rowEl("header");
  row.append(labelEl("日期"));
  for (const day of days) {
    const date = parseDate(day);
    const cell = document.createElement("div");
    cell.className = "day-cell";
    if ([0, 6].includes(date.getDay())) cell.classList.add("weekend");
    if (day === formatDate(new Date())) cell.classList.add("today");
    if (milestones.has(day)) {
      cell.classList.add("milestone");
      cell.title = milestones.get(day).join("\n");
    }
    cell.textContent = `${date.getMonth() + 1}/${date.getDate()}`;
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

function toggleButton(expanded, onClick) {
  const button = document.createElement("button");
  button.className = "toggle";
  button.type = "button";
  button.textContent = expanded ? "v" : ">";
  button.addEventListener("click", onClick);
  return button;
}

function gridFill() {
  const grid = document.createElement("div");
  grid.className = "row-grid";
  return grid;
}

function renderProjectRow(project) {
  const row = rowEl("group-row");
  const label = labelEl(project.name, "", `${project.requirements.length} 需求`);
  label.prepend(toggleButton(project.expanded, () => { project.expanded = !project.expanded; render(); }));
  row.append(label, gridFill());
  return row;
}

function renderRequirementRow(project, requirement) {
  const row = rowEl("requirement-row");
  const label = labelEl(requirement.title, "  ", `${requirement.stages.length} 阶段`);
  label.prepend(toggleButton(requirement.expanded, () => { requirement.expanded = !requirement.expanded; render(); }));
  const addStage = document.createElement("button");
  addStage.type = "button";
  addStage.title = "添加阶段";
  addStage.textContent = "+";
  addStage.className = "icon-button";
  addStage.addEventListener("click", () => addStageToRequirement(requirement));
  label.append(addStage);
  row.append(label, gridFill());
  return row;
}

function renderStageRow(project, requirement, stage) {
  const row = rowEl();
  row.append(labelEl(stage.type, "    ", stage.owner || ""));
  const grid = gridFill();
  const viewEndOffset = daysBetween(view.start, view.end);
  const stageStart = daysBetween(view.start, stage.start);
  const stageEnd = daysBetween(view.start, stage.end);
  const start = Math.max(0, stageStart);
  const end = Math.min(viewEndOffset, stageEnd);
  if (end >= 0 && start <= viewEndOffset) {
    const bar = document.createElement("div");
    bar.className = `stage-bar ${stage.issueOpen ? "issue" : ""}`;
    bar.dataset.status = stage.status;
    bar.style.gridColumn = `${start + 1} / ${end + 2}`;
    bar.innerHTML = `<span>${escapeHtml(stage.title)}</span>`;
    bar.addEventListener("mouseenter", (event) => showTooltip(event, project, requirement, stage));
    bar.addEventListener("mousemove", moveTooltip);
    bar.addEventListener("mouseleave", hideTooltip);
    bar.addEventListener("dblclick", () => openStageEditor(project, requirement, stage));
    grid.append(bar);
  }
  row.append(grid);
  return row;
}

function renderProjectList() {
  for (const project of state.projects) {
    const item = document.createElement("div");
    item.className = "project-chip";
    const text = document.createElement("div");
    text.innerHTML = `<strong>${escapeHtml(project.name)}</strong><span>${project.requirements.length} 个需求，${(project.milestones || []).length} 个节点</span>`;
    const actions = document.createElement("div");
    actions.className = "mini-actions";
    const addReq = document.createElement("button");
    addReq.type = "button";
    addReq.title = "添加需求";
    addReq.textContent = "+";
    addReq.addEventListener("click", () => addRequirement(project));
    actions.append(addReq);
    item.append(text, actions);
    els.projectList.append(item);
  }
}

function showTooltip(event, project, requirement, stage) {
  els.tooltip.hidden = false;
  els.tooltip.innerHTML = `
    <strong>${escapeHtml(stage.title)}</strong>
    <div>${escapeHtml(project.name)} / ${escapeHtml(requirement.title)}</div>
    <div>${stage.start} 至 ${stage.end}</div>
    <div>负责人：${escapeHtml(stage.owner || "未分配")} · 工时：${Number(stage.hours || 0)}</div>
    <div>状态：${escapeHtml(stage.status)} · 问题：${stage.issueOpen ? "未关闭" : "已关闭"}</div>
    ${stage.issues ? `<div>问题说明：${escapeHtml(stage.issues)}</div>` : ""}
  `;
  moveTooltip(event);
}

function moveTooltip(event) {
  els.tooltip.style.left = `${event.clientX + 14}px`;
  els.tooltip.style.top = `${event.clientY + 14}px`;
}

function hideTooltip() { els.tooltip.hidden = true; }

function openStageEditor(project, requirement, stage) {
  editing = { project, requirement, stage };
  els.editorTitle.textContent = `${requirement.title} / ${stage.type}`;
  els.editTitle.value = stage.title || "";
  els.editType.value = stage.type || STAGE_TYPES[0];
  els.editStart.value = stage.start;
  els.editEnd.value = stage.end;
  els.editOwner.value = stage.owner || "";
  els.editHours.value = String(stage.hours || 0);
  els.editStatus.value = stage.status || "未开始";
  els.editIssueOpen.checked = Boolean(stage.issueOpen);
  els.editIssues.value = stage.issues || "";
  els.editNotes.value = stage.notes || "";
  els.dialog.showModal();
}

function saveStageEditor() {
  if (!editing) return;
  const stage = editing.stage;
  stage.title = els.editTitle.value.trim() || stage.type;
  stage.type = els.editType.value;
  stage.start = els.editStart.value;
  stage.end = els.editEnd.value;
  stage.owner = els.editOwner.value.trim();
  stage.hours = Number(els.editHours.value || 0);
  stage.status = els.editStatus.value;
  stage.issueOpen = els.editIssueOpen.checked;
  stage.issues = els.editIssues.value.trim();
  stage.notes = els.editNotes.value.trim();
  clampStageDates(stage);
  els.dialog.close();
  render();
}

function deleteStage() {
  if (!editing) return;
  const stages = editing.requirement.stages;
  const index = stages.findIndex((stage) => stage.id === editing.stage.id);
  if (index >= 0) stages.splice(index, 1);
  editing = null;
  els.dialog.close();
  render();
}

function addProject() {
  const name = prompt("项目名称");
  if (!name) return;
  state.projects.push({ id: uid("project"), name: name.trim(), expanded: true, milestones: [], requirements: [] });
  render();
}

function addRequirement(project) {
  const title = prompt(`为「${project.name}」添加需求`);
  if (!title) return;
  const today = formatDate(new Date());
  project.expanded = true;
  project.requirements.push({
    id: uid("req"),
    title: title.trim(),
    expanded: true,
    stages: STAGE_TYPES.map((type, index) => ({
      id: uid("stage"),
      type,
      title: type,
      start: addDays(today, index * 2),
      end: addDays(today, index * 2 + 1),
      owner: "",
      hours: 0,
      status: "未开始",
      issueOpen: false,
      issues: "",
      notes: ""
    }))
  });
  fitDates();
  render();
}

function addStageToRequirement(requirement) {
  const today = formatDate(new Date());
  requirement.expanded = true;
  const stage = {
    id: uid("stage"),
    type: STAGE_TYPES[0],
    title: "新阶段",
    start: today,
    end: addDays(today, 2),
    owner: "",
    hours: 0,
    status: "未开始",
    issueOpen: false,
    issues: "",
    notes: ""
  };
  requirement.stages.push(stage);
  fitDates();
  render();
  const project = state.projects.find((item) => item.requirements.includes(requirement));
  openStageEditor(project, requirement, stage);
}

function addMilestone() {
  if (!state.projects.length) {
    alert("请先添加项目。");
    return;
  }
  const projectName = prompt(`节点所属项目名称（默认：${state.projects[0].name}）`);
  const project = state.projects.find((item) => item.name === projectName) || state.projects[0];
  const label = prompt("节点名称");
  if (!label) return;
  const date = prompt("节点日期（YYYY-MM-DD）", formatDate(new Date()));
  if (!date || Number.isNaN(parseDate(date).getTime())) return;
  project.milestones ||= [];
  project.milestones.push({ id: uid("milestone"), label: label.trim(), date });
  fitDates();
  render();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

for (const type of STAGE_TYPES) {
  const option = document.createElement("option");
  option.textContent = type;
  els.editType.append(option);
}

els.addProjectBtn.addEventListener("click", addProject);
els.addMilestoneBtn.addEventListener("click", addMilestone);
els.fitDatesBtn.addEventListener("click", () => { fitDates(); render(); });
els.viewStart.addEventListener("change", () => { view.start = els.viewStart.value; render(); });
els.viewEnd.addEventListener("change", () => { view.end = els.viewEnd.value; render(); });
els.saveBtn.addEventListener("click", async () => {
  try {
    await saveState();
    els.saveBtn.textContent = "已保存";
    setTimeout(() => { els.saveBtn.textContent = "保存"; }, 1200);
  } catch (error) {
    alert(error.message);
  }
});
els.saveStageBtn.addEventListener("click", saveStageEditor);
els.deleteStageBtn.addEventListener("click", deleteStage);

loadState().catch((error) => {
  els.gantt.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
});
