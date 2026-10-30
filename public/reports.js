(function () {
  "use strict";
  const STAGES = ["未开始", "进行中", "已完成", "超期未完成", "暂停"];
  const ISSUES = { open: "待处理", in_progress: "处理中", closed: "已关闭" };
  const PRIORITIES = { urgent: "紧急", high: "高", medium: "中", low: "低" };
  const MODES = { overview: "状态概览", handoff: "工作交接", todo: "Todo 清单" };
  const MANUAL_FIELDS = ["manualTodos", "manualRisks"];
  function manualText(value) { const result = text(value); if (result.length > 10000) throw new Error("人工补充每节最多 10000 字符"); return result; }
  const SORTS = { priority: "风险与截止日优先", new: "本次新增在前", created: "记录创建时间较新优先" };
  const list = value => Array.isArray(value) ? value.filter(item => item && typeof item === "object") : [];
  const text = value => value == null ? "" : String(value);
  const escape = value => text(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const rowKey = row => JSON.stringify([row.kind, row.systemId || row.system, row.projectId || row.project, row.id]);
  const isChecked = (report, row) => row.completed || (report.checkedIds || []).includes(rowKey(row));
  const fingerprint = row => JSON.stringify([row.title, row.rawStatus, row.priorityKey, row.owner, row.start, row.due, row.requirement, row.stage, row.notes]);

  function weekRange(date = new Date(), offset = 0) {
    const start = new Date(date);
    start.setDate(start.getDate() - (start.getDay() + 6) % 7 + offset * 7);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    return { start: localDate(start), end: localDate(end) };
  }

  function reportPeriod(options, mode) {
    const start = mode === "overview" ? "" : text(options.dateStart);
    const end = mode === "overview" ? "" : text(options.dateEnd);
    if ((start || end) && (!validDate(start) || !validDate(end) || start > end)) throw new Error("请填写有效的开始、结束日期，且开始日期不晚于结束日期。");
    return { start, end, includeUndated: Boolean(start && options.includeUndated), includeCarryover: Boolean(start && options.includeCarryover) };
  }

  function matchesPeriod(row, period) {
    if (!period.start) return true;
    if (!row.due) return period.includeUndated;
    if (period.includeCarryover && !row.completed && row.due < period.start) return true;
    if (row.kind === "stage" && row.start && row.start <= row.due) return row.start <= period.end && row.due >= period.start;
    return row.due >= period.start && row.due <= period.end;
  }

  function validateBaseline(value) {
    if (!value || value.format !== "bobo-todo-baseline" || value.version !== 1 || !["todo", "handoff"].includes(value.mode)
      || !value.scope || typeof value.scope.systemId !== "string" || !value.scope.systemId || typeof value.scope.projectId !== "string"
      || !value.period || typeof value.period.start !== "string" || typeof value.period.end !== "string"
      || typeof value.period.includeUndated !== "boolean" || typeof value.period.includeCarryover !== "boolean"
      || typeof value.asOf !== "string" || !Number.isFinite(Date.parse(value.asOf))
      || !((typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0) || (typeof value.revision === "string" && value.revision.length < 65))
      || !Array.isArray(value.todos) || value.todos.length > 10000) throw new Error("文件不是可比较的待办报告，请导入本功能导出的 Todo 或工作交接 HTML。");
    reportPeriod({ dateStart: value.period.start, dateEnd: value.period.end }, "todo");
    if (!value.period.start && (value.period.includeUndated || value.period.includeCarryover)) throw new Error("基准日期条件无效，请选择原始导出的 HTML。");
    const keys = new Set();
    for (const item of value.todos) {
      let key;
      try { key = JSON.parse(item.key); } catch { throw new Error("基准文件中的事项标识无效。"); }
      if (!Array.isArray(key) || key.length !== 4 || !["stage", "issue"].includes(key[0]) || key.some(part => typeof part !== "string" || !part || part.length > 500)
        || key[1] !== value.scope.systemId || (value.scope.projectId && key[2] !== value.scope.projectId)
        || typeof item.fingerprint !== "string" || item.fingerprint.length > 50000 || keys.has(item.key)) throw new Error("基准文件中的事项标识重复或不属于报告范围。");
      keys.add(item.key);
    }
    return value;
  }

  function createBaseline(report) {
    if (report.mode === "overview") return null;
    return { format: "bobo-todo-baseline", version: 1, mode: report.mode, asOf: report.generatedIso, revision: report.revision,
      scope: report.scopeIds, period: report.period, todos: report.todos.map(row => ({ key: rowKey(row), fingerprint: fingerprint(row) })) };
  }

  function parseBaselineHtml(source) {
    if (typeof source !== "string" || source.length > 2 * 1024 * 1024) throw new Error("基准 HTML 过大（最多 2 MiB）或内容无效。");
    const matches = [...source.matchAll(/<template id="bobo-report-baseline">([\s\S]*?)<\/template>/g)];
    if (matches.length !== 1) throw new Error("该 HTML 不含可比较的待办基准。请先导出新版 Todo/工作交接 HTML，供下次比较。");
    const decoded = matches[0][1].replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[name]));
    let value;
    try { value = JSON.parse(decoded); } catch { throw new Error("基准数据损坏，请重新选择原始导出 HTML。"); }
    return validateBaseline(value);
  }

  function periodDescription(report) {
    if (report.mode === "overview") return "当前快照的阶段性汇报（不还原历史状态）";
    const period = report.period;
    return `${period.start ? `${period.start} 至 ${period.end}（含首尾）` : "全部日期"}；问题按截止日，阶段按计划区间相交；无有效截止日期${period.includeUndated || !period.start ? "纳入" : "排除"}，期前遗留未完成${period.includeCarryover ? "纳入" : "不额外纳入"}`;
  }

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text(value))) return false;
    const date = new Date(`${value}T12:00:00`);
    return !Number.isNaN(date.getTime()) && localDate(date) === value;
  }

  function localDate(date) {
    return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function timestamp(date) {
    const offset = -date.getTimezoneOffset();
    return `${localDate(date)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")} UTC${offset < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  }

  function compareTodos(a, b) {
    const rank = value => value === "urgent" ? 0 : value === "high" ? 1 : 2;
    return Number(b.overdue) - Number(a.overdue) || rank(a.priorityKey) - rank(b.priorityKey)
      || (a.due || "9999-99-99").localeCompare(b.due || "9999-99-99")
      || a.title.localeCompare(b.title, "zh-CN") || a.id.localeCompare(b.id)
      || `${a.system}/${a.project}/${a.requirement}/${a.kind}`.localeCompare(`${b.system}/${b.project}/${b.requirement}/${b.kind}`);
  }

  function collectReport(snapshot, options = {}, date = new Date()) {
    const systems = list(snapshot?.state?.systems);
    const system = systems.find(item => item.id === options.systemId);
    if (!system) throw new Error("当前系统已不存在或无权访问，请关闭报表并重新选择系统。");
    const projectScope = options.scope !== "system" && Boolean(options.projectId);
    const projects = projectScope ? list(system.projects).filter(item => item.id === options.projectId) : list(system.projects);
    if (projectScope && !projects.length) throw new Error("当前项目已不存在或无权访问，请关闭报表并重新选择项目。");
    const mode = Object.hasOwn(MODES, options.mode) ? options.mode : "overview";
    const today = localDate(date);
    const nextWeek = new Date(date); nextWeek.setDate(nextWeek.getDate() + 7);
    const until = localDate(nextWeek);
    const users = new Map(list(snapshot.users).map(user => [user.id, user]));
    const warnings = [];
    const stages = [], issues = [];
    const seenIssues = new Set(), seenStages = new Set();
    const warn = message => warnings.push(message);
    function owner(id) {
      if (!id) return "未分配";
      const user = users.get(id);
      if (!user) return `历史身份未知（${text(id)}）`;
      return `${text(user.displayName || user.username || id)}${user.deletedAt ? "（已删除）" : user.active === false ? "（已停用）" : ""}`;
    }
    function row(source, kind, context) {
      const completed = kind === "issue" ? source.status === "closed" : source.status === "已完成";
      const rawDue = text(kind === "issue" ? source.dueDate : source.end);
      const due = validDate(rawDue) ? rawDue : "";
      const known = kind === "issue" ? Object.hasOwn(ISSUES, source.status) : STAGES.includes(source.status);
      const title = text(source.title || source.type || "未命名事项");
      const tags = [];
      const overdue = !completed && Boolean(due) && due < today;
      if (overdue) tags.push(kind === "issue" ? "问题逾期" : "计划超期");
      if (!known) { tags.push("未知状态·待核对"); warn(`${title}：未知状态 ${text(source.status) || "空"}`); }
      if (rawDue && !due) { tags.push("日期无效·待核对"); warn(`${title}：无效截止日期 ${rawDue}`); }
      if (kind === "stage" && source.start && !validDate(source.start)) warn(`${title}：无效开始日期 ${text(source.start)}`);
      if (kind === "stage" && validDate(source.start) && due && source.start > due) { tags.push("日期倒置·待核对"); warn(`${title}：计划开始晚于结束`); }
      if (!completed && kind === "issue" && ["urgent", "high"].includes(source.priority)) tags.push(`${PRIORITIES[source.priority]}优先级`);
      if (!completed && !(kind === "issue" ? source.assigneeUserId : text(source.owner).trim())) tags.push("未分配");
      if (kind === "stage" && source.status === "暂停") tags.push("暂停");
      const priority = kind === "issue" && Object.hasOwn(PRIORITIES, source.priority) ? PRIORITIES[source.priority] : "未设置";
      if (kind === "issue" && source.priority && !Object.hasOwn(PRIORITIES, source.priority)) { tags.push("未知优先级·待核对"); warn(`${title}：未知优先级 ${text(source.priority)}`); }
      let completion = "";
      if (completed) {
        const closed = new Date(source.closedAt);
        completion = kind === "stage" ? "已标记完成（完成日期未知）"
          : source.closedAt && !Number.isNaN(closed.getTime()) && !source.legacyClosureUnknown
            ? `关闭于 ${timestamp(closed)}；关闭人：${source.closedByUserId ? owner(source.closedByUserId) : "历史记录未知"}`
            : "关闭时间及操作者：历史记录未知";
      }
      return { ...context, kind, type: kind === "issue" ? "问题" : completed ? "阶段" : "阶段提醒", id: text(source.id), title,
        stageId: kind === "stage" ? source.id : source.stageId, start: kind === "stage" && validDate(source.start) ? source.start : "",
        createdAt: kind === "issue" && source.createdAt && Number.isFinite(Date.parse(source.createdAt)) ? source.createdAt : "",
        notes: kind === "stage" ? text(source.notes) : "",
        status: known ? (kind === "issue" ? ISSUES[source.status] : source.status) : `未知（${text(source.status) || "空"}）`,
        rawStatus: source.status, priorityKey: kind === "issue" ? source.priority : "", priority,
        owner: kind === "issue" ? owner(source.assigneeUserId) : text(source.owner).trim() || "未分配",
        due, dateSource: kind === "issue" ? "问题截止日" : "阶段计划结束日", tags, overdue, completed, completion,
        assigned: kind === "issue" ? Boolean(source.assigneeUserId) : Boolean(text(source.owner).trim()) };
    }
    for (const project of projects) {
      const stageMap = new Map();
      const context = { system: text(system.name), project: text(project.name), systemId: system.id, projectId: project.id };
      for (const requirement of list(project.requirements)) {
        for (const stage of list(requirement.stages)) {
          if (!stage.id || seenStages.has(stage.id)) { warn(`阶段 ID 缺失或重复：${text(stage.id)}，已跳过`); continue; }
          seenStages.add(stage.id);
          const item = row(stage, "stage", { ...context, requirement: text(requirement.title), stage: text(stage.title || stage.type) });
          item.openIssueCount = 0;
          stageMap.set(stage.id, item); stages.push(item);
        }
      }
      for (const issue of list(project.issues)) {
        if (!issue.id || seenIssues.has(issue.id)) { warn(`问题 ID 缺失或重复：${text(issue.id)}，已跳过`); continue; }
        seenIssues.add(issue.id);
        const stage = stageMap.get(issue.stageId);
        const item = row(issue, "issue", { ...context, requirement: stage?.requirement || "归属未知", stage: stage?.stage || "阶段不存在" });
        if (!stage) { item.tags.push("归属待核对"); warn(`${item.title}：找不到阶段 ${text(issue.stageId)}`); }
        else if (!item.completed) stage.openIssueCount++;
        issues.push(item);
      }
    }
    for (const stage of stages) {
      if (stage.completed && stage.openIssueCount) stage.tags.push("已完成但有开放问题·待核对");
    }
    const parentStages = new Map(stages.map(item => [JSON.stringify([item.projectId, item.stageId]), item]));
    for (const item of issues.filter(row => !row.completed)) {
      const parent = parentStages.get(JSON.stringify([item.projectId, item.stageId]));
      if (parent?.completed) item.tags.push("所属阶段已完成·问题未关闭待核对");
      if (parent?.rawStatus === "暂停") item.tags.push("所属阶段暂停");
    }
    const period = reportPeriod(options, mode);
    const fullTodos = [...issues.filter(item => !item.completed), ...stages.filter(item => !item.completed && !item.openIssueCount)];
    const selectedStages = stages.filter(item => matchesPeriod(item, period));
    const selectedIssues = issues.filter(item => matchesPeriod(item, period));
    const openIssues = selectedIssues.filter(item => !item.completed);
    const todos = fullTodos.filter(item => matchesPeriod(item, period));
    for (const item of [...selectedStages, ...selectedIssues]) {
      if (period.start && item.kind === "stage" && item.due && (!item.start || item.start > item.due)) item.tags.push("区间不完整·按结束日筛选");
      if (period.start && !item.due) item.tags.push("手动纳入无日期事项");
      else if (period.includeCarryover && !item.completed && item.due < period.start) item.tags.push("期前遗留未完成");
    }
    const completed = [...selectedStages, ...selectedIssues].filter(item => item.completed).sort(compareTodos);
    const active = [...selectedStages.filter(item => !item.completed), ...openIssues];
    const scopeIds = { systemId: system.id, projectId: projectScope ? projects[0].id : "" };
    const baseline = mode !== "overview" && options.baseline ? validateBaseline(options.baseline) : null;
    const changes = { new: 0, changed: 0, existing: 0, absent: 0 };
    if (baseline) {
      if (baseline.scope.systemId !== scopeIds.systemId || baseline.scope.projectId !== scopeIds.projectId || Object.keys(period).some(key => baseline.period[key] !== period[key])) throw new Error("比较基准与当前范围或日期筛选不一致，请导入同范围、同周期的 HTML。");
      if (Date.parse(baseline.asOf) > date.getTime()) throw new Error("基准生成时间晚于当前快照，请先刷新数据。");
      const previous = new Map(baseline.todos.map(item => [item.key, item.fingerprint]));
      for (const item of todos) {
        item.change = !previous.has(rowKey(item)) ? "new" : previous.get(rowKey(item)) !== fingerprint(item) ? "changed" : "existing";
        item.changeLabel = { new: "新增纳入", changed: "内容变更", existing: "上次已有" }[item.change];
        changes[item.change]++;
      }
      const current = new Set(todos.map(rowKey));
      changes.absent = baseline.todos.filter(item => !current.has(item.key)).length;
    }
    const sort = mode === "overview" ? "priority" : Object.hasOwn(SORTS, options.sort) ? options.sort : "priority";
    if (sort === "new" && !baseline) throw new Error("请先导入上次 HTML，再按本次新增排序。");
    todos.sort((a, b) => (sort === "new" ? Number(b.change === "new") - Number(a.change === "new")
      : sort === "created" ? (b.createdAt ? Date.parse(b.createdAt) : -Infinity) - (a.createdAt ? Date.parse(a.createdAt) : -Infinity) : 0) || compareTodos(a, b));
    const visibleStages = selectedStages, visibleIssues = selectedIssues;
    const metrics = {
      stages: visibleStages.length, stageStates: Object.fromEntries(STAGES.map(status => [status, visibleStages.filter(item => item.rawStatus === status).length])),
      unknownStages: visibleStages.filter(item => !STAGES.includes(item.rawStatus)).length,
      completion: visibleStages.length ? `${Math.round(visibleStages.filter(item => item.completed).length / visibleStages.length * 100)}%` : "—",
      issues: visibleIssues.length, issueStates: Object.fromEntries(Object.keys(ISSUES).map(status => [status, visibleIssues.filter(item => item.rawStatus === status).length])),
      unknownIssues: visibleIssues.filter(item => !Object.hasOwn(ISSUES, item.rawStatus)).length,
      openIssues: openIssues.length, overdueIssues: openIssues.filter(item => item.overdue).length,
      overdueStages: visibleStages.filter(item => item.overdue).length,
      highIssues: openIssues.filter(item => ["urgent", "high"].includes(item.priorityKey)).length,
      unassignedIssues: openIssues.filter(item => !item.assigned).length
    };
    return { mode, title: `${MODES[mode]}报告`, scope: `${system.name} / ${projectScope ? text(projects[0].name) : "当前系统全部项目"}`,
      generatedAt: timestamp(date), generatedIso: date.toISOString(), localDate: today, revision: snapshot.revision ?? "未知", author: text(snapshot.user?.displayName || snapshot.user?.username || "未知"),
      period, sort, scopeIds, baseline: baseline ? { asOf: baseline.asOf, revision: baseline.revision } : null, changes,
      excluded: { undated: period.start && !period.includeUndated ? fullTodos.filter(item => !item.due).length : 0, total: fullTodos.length - todos.length },
      includeCompleted: Boolean(options.includeCompleted ?? mode === "handoff"), note: mode === "handoff" ? text(options.note) : "",
      manualTodos: mode === "overview" ? "" : manualText(options.manualTodos),
      manualRisks: mode === "todo" ? "" : manualText(options.manualRisks),
      checkedIds: Array.isArray(options.checkedIds) ? options.checkedIds.filter(id => typeof id === "string") : [],
      metrics, stages: selectedStages, issues: selectedIssues, openIssues, todos, completed,
      risks: (mode === "overview" ? [...selectedStages, ...selectedIssues] : todos).filter(item => item.tags.length).sort(compareTodos),
      upcoming: active.filter(item => item.due >= today && item.due <= until).sort(compareTodos),
      undated: active.filter(item => !item.due).sort(compareTodos),
      warnings: mode === "overview" ? warnings : warnings.length ? [`当前系统/项目数据有 ${warnings.length} 处待核对项；本清单仅列出符合日期筛选的事项，未设有效截止日期的排除数量单独提示。`] : [] };
  }

  function summary(report) {
    const m = report.metrics;
    if (report.mode !== "overview") return [
      `本次待办 ${report.todos.length}：问题 ${report.todos.filter(row => row.kind === "issue").length}，阶段提醒 ${report.todos.filter(row => row.kind === "stage").length}；按当前计划日期筛选，不代表历史完成记录。`,
      `未纳入待办 ${report.excluded.total}，其中无有效截止日期排除 ${report.excluded.undated}；期前遗留与无日期事项仅在勾选相应选项后额外纳入。`,
      report.baseline ? `对比 ${report.baseline.asOf}（revision ${report.baseline.revision}）：新增纳入 ${report.changes.new}，内容变更 ${report.changes.changed}，上次已有 ${report.changes.existing}；上次清单本次未出现 ${report.changes.absent}（可能完成、移期或移出范围，不代表已删除）。` : "尚未导入比较基准，不标注新增；计划开始日期不作为新增时间。",
      report.sort === "created" ? "创建时间仅使用问题的记录时间；阶段未记录创建时间，排在有时间的事项之后。历史迁移记录的时间可能是迁移时间，不能据此确认实际新建。" : ""
    ].filter(Boolean);
    return [
      `阶段 ${m.stages}：${STAGES.map(status => `${status} ${m.stageStates[status]}`).join("，")}${m.unknownStages ? `，未知状态 ${m.unknownStages}` : ""}；已完成阶段占比 ${m.completion}（不是项目真实完成率）。`,
      `问题 ${m.issues}：待处理 ${m.issueStates.open}，处理中 ${m.issueStates.in_progress}，已关闭 ${m.issueStates.closed}${m.unknownIssues ? `，未知状态 ${m.unknownIssues}` : ""}；未关闭 ${m.openIssues}。`,
      `风险：逾期问题 ${m.overdueIssues}，计划超期阶段 ${m.overdueStages}，紧急/高优先级开放问题 ${m.highIssues}，未分配开放问题 ${m.unassignedIssues}。`
    ];
  }

  function sections(report) {
    const completed = { title: "已完成事项", rows: report.completed, checklist: true };
    const todos = { title: "下一步 Todo", rows: report.todos, checklist: true, manualField: "manualTodos" };
    const risks = { title: "需要注意的风险", rows: report.risks, manualField: "manualRisks" };
    if (report.mode === "handoff") return [
      { ...todos, title: "交接待办" }, risks, ...(report.includeCompleted ? [completed] : [])
    ];
    if (report.mode === "todo") return [todos, ...(report.includeCompleted ? [completed] : [])];
    return [{ title: "阶段进展", rows: report.stages }, risks, { title: "未来 7 天到期（含今天）", rows: report.upcoming }, { title: "未设有效截止日期", rows: report.undated },
      ...(report.includeCompleted ? [completed] : [])];
  }

  const location = row => `${row.system} / ${row.project} / ${row.requirement} / ${row.stage}`;
  const cells = (row, mode) => [mode === "overview" && row.kind === "stage" ? "阶段" : row.type, location(row), row.title, row.status, row.priority, row.owner, row.start, row.due || "未设置", row.dateSource, row.tags.join("；") || "—", row.id, row.completion, row.changeLabel || "未比较", row.notes];
  const columns = ["类型", "归属", "事项", "状态", "优先级", "负责人", "计划开始", "截止日期", "日期来源", "风险标签", "原始 ID", "完成记录", "本次变化", "阶段备注"];
  function markdownCell(value) {
    return text(value).replace(/\\/g, "\\\\").replace(/[|`*_\[\]<>#]/g, char => `\\${char}`).replace(/\r\n|[\r\n\u2028\u2029]/g, " / ");
  }
  function exportMarkdown(report) {
    const md = markdownCell;
    const lines = [`# ${report.title}`, "", `- 范围：${md(report.scope)}`, `- 生成时间：${report.generatedAt}`, `- 统计日：${report.localDate}`,
      `- 数据版本：revision ${md(report.revision)}`, `- 报告人：${md(report.author)}`, `- 附完成清单：${report.includeCompleted ? "是" : "否"}`,
      `- 日期与口径：${md(periodDescription(report))}`, `- 排序：${SORTS[report.sort]}`, `- 比较基准：${report.baseline ? `${md(report.baseline.asOf)} / revision ${md(report.baseline.revision)}` : "未导入"}`,
      "", "本报告使用已持久化业务快照，不包含未保存的系统编辑；人工补充单独标注，不计入快照统计。", "完成勾选仅记录导出清单的办理标记，不改变原始业务状态或快照统计。", "", `## ${report.mode === "overview" ? "当前状态摘要" : "本次清单摘要"}`, "", ...summary(report).map(line => `- ${line}`)];
    if (report.warnings.length) lines.push("", "## 数据待核对", "", ...report.warnings.map(line => `- ${md(line)}`));
    for (const section of sections(report)) {
      lines.push("", `## ${section.title}`, "");
      const manual = text(report[section.manualField]);
      if (!section.rows.length && !manual.trim()) lines.push("暂无事项。");
      if (section.checklist) {
        for (const row of section.rows) lines.push(`- [${isChecked(report, row) ? "x" : " "}] **${md(row.title)}** · ${md(row.type)}${row.changeLabel ? ` · 【${row.changeLabel}】` : ""}`,
          `  - 归属：${md(location(row))}；原始 ID：${md(row.id)}`,
          `  - 原始状态：${md(row.status)}；优先级：${md(row.priority)}；负责人：${md(row.owner)}；${row.kind === "stage" ? `计划开始：${md(row.start || "未设置")}；` : ""}截止：${md(row.due || "未设置")}（${md(row.dateSource)}）`,
          `  - 风险：${md(row.tags.join("；") || "—")}${row.completion ? `；完成记录：${md(row.completion)}` : ""}`, ...(row.notes ? [`  - 阶段备注：${md(row.notes)}`] : []), "");
      } else if (section.rows.length) lines.push(`| ${columns.join(" | ")} |`, `| ${columns.map(() => "---").join(" | ")} |`, ...section.rows.map(row => `| ${cells(row, report.mode).map(md).join(" | ")} |`));
      if (manual.trim()) lines.push("", "### 人工补充（不计入快照统计）", "", ...manual.split(/\r?\n/).map(line => `> ${md(line)}`));
    }
    if (report.mode === "handoff") lines.push("", "## 交接说明（人工填写）", "", ...text(report.note || "未补充").split(/\r?\n/).map(line => `> ${md(line)}`));
    return lines.join("\n") + "\n";
  }

  function csvCell(value) {
    let cell = text(value);
    if (/^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(cell) || /^[\t\r\n]/.test(cell)) cell = `'${cell}`;
    return `"${cell.replace(/"/g, '""')}"`;
  }
  function exportCsv(report) {
    const headers = ["类型", "系统", "项目", "需求", "阶段", "事项", "状态", "优先级", "负责人", "截止日期", "日期来源", "是否逾期", "风险标签", "原始ID",
      "完成记录", "完成勾选", "勾选来源", "本次变化", "记录创建时间", "计划开始", "阶段备注", "报告类型", "范围", "生成时间", "统计日", "revision", "报告人", "附完成清单", "交接说明（人工填写）", "阶段总数", "已完成阶段占比", "问题总数", "未关闭问题数", "日期与口径", "排序", "比较基准", "本次待办数", "新增纳入数", "内容变更数", "无日期排除数", "人工补充待办", "人工补充风险"];
    const rows = report.mode === "overview" ? [...report.stages, ...report.issues] : [...report.todos, ...(report.includeCompleted ? report.completed : [])];
    const meta = [report.title, report.scope, report.generatedAt, report.localDate, report.revision, report.author, report.includeCompleted ? "是" : "否", report.note || "未补充", report.metrics.stages, report.metrics.completion, report.metrics.issues, report.metrics.openIssues,
      periodDescription(report), SORTS[report.sort], report.baseline ? `${report.baseline.asOf} / revision ${report.baseline.revision}` : "未导入", report.todos.length, report.baseline ? report.changes.new : "未比较", report.baseline ? report.changes.changed : "未比较", report.excluded.undated, report.manualTodos || "", report.manualRisks || ""];
    const values = rows.map(row => [report.mode === "overview" && row.kind === "stage" ? "阶段" : row.type, row.system, row.project, row.requirement, row.stage, row.title, row.status, row.priority, row.owner, row.due || "未设置", row.dateSource,
      row.overdue ? "是" : "否", row.tags.join("；"), row.id, row.completion, isChecked(report, row) ? "☑" : "☐", row.completed ? "原始完成状态" : isChecked(report, row) ? "临时办理标记" : "未勾选", row.changeLabel || "未比较", row.createdAt || "未记录", row.start, row.notes, ...meta]);
    if (!values.length) values.push([...Array(21).fill(""), ...meta]);
    return "\uFEFF" + [headers, ...values].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  function renderReport(report, { editable = false } = {}) {
    const e = escape;
    const m = report.metrics;
    function tableRow(row, checklist) {
      const checked = isChecked(report, row);
      const checkbox = checklist ? `<td class="report-check-cell"><label class="report-check"><input type="checkbox" data-check-key="${e(rowKey(row))}" aria-label="${row.completed ? "原始已完成" : "标记办理完成"}：${e(row.title)}"${checked ? " checked" : ""}${row.completed ? " disabled" : ""}><span class="report-box" aria-hidden="true"></span></label></td>` : "";
      return `<tr class="${checklist && checked ? "report-checked" : ""}">${checkbox}<td class="report-task" data-label="事项 / 归属">${row.changeLabel ? `<span class="report-change${row.change === "new" ? " is-new" : ""}">${e(row.changeLabel)}</span>` : ""}<strong>${e(row.title)}</strong><small>${e(report.mode === "overview" && row.kind === "stage" ? "阶段" : row.type)} · ${e(location(row))}</small>${row.notes ? `<small>备注：${e(row.notes)}</small>` : ""}<small class="report-id">ID: ${e(row.id)}</small></td><td data-label="原始状态 / 优先级"><span class="report-badge${row.completed ? " is-complete" : row.overdue ? " is-overdue" : ""}">${e(row.status)}</span><small>${e(row.priority)}</small></td><td data-label="负责人">${e(row.owner)}</td><td data-label="截止日期"><span class="report-date">${e(row.due || "未设置")}</span>${row.kind === "stage" ? `<small>开始 ${e(row.start || "未设置")}</small>` : ""}<small>${e(row.dateSource)}</small>${report.sort === "created" ? `<small>记录创建：${row.createdAt ? e(timestamp(new Date(row.createdAt))) : "未记录"}</small>` : ""}</td><td data-label="风险 / 完成记录">${row.tags.map(tag => `<span class="report-risk-tag">${e(tag)}</span>`).join("") || "—"}<small>${e(row.completion)}</small></td></tr>`;
    }
    const sectionsHtml = sections(report).map((section, index) => {
      const field = section.manualField, manual = text(report[field]);
      const manualArea = field ? `${editable ? `<label class="report-manual-editor"><span>人工补充${field === "manualTodos" ? "待办" : "风险"}<small>随报告导出，不计入快照统计；人工文字不写回业务数据</small></span><textarea data-manual-field="${field}" aria-label="人工补充${field === "manualTodos" ? "待办" : "风险"}" rows="3" maxlength="10000" placeholder="${section.rows.length ? "可在此补充或修改额外内容" : "暂无快照事项，可在此直接填写"}">${e(manual)}</textarea></label>` : ""}<div class="report-manual-display" data-manual-output="${field}"${manual.trim() ? "" : " hidden"}><strong>人工补充</strong><p class="report-manual-text">${e(manual)}</p></div>` : "";
      return `<section class="report-section${field && editable ? " report-manual-section" : ""}"><div class="report-section-head"><span class="report-section-index">${String(index + 2).padStart(2, "0")}</span><h3>${section.title}</h3><span class="report-count">${field ? "快照 " : ""}${section.rows.length} 项</span></div>${section.checklist ? '<p class="report-muted report-check-hint">完成框用于本清单的办理标记；原始状态与快照统计保持不变。</p>' : ""}${section.rows.length
        ? `<table class="${section.checklist ? "report-checklist" : ""}"><thead><tr>${section.checklist ? '<th class="report-check-cell" scope="col">勾选</th>' : ""}<th class="report-task" scope="col">事项 / 归属</th><th scope="col">原始状态 / 优先级</th><th scope="col">负责人</th><th scope="col">截止日期</th><th scope="col">风险 / 完成记录</th></tr></thead><tbody>${section.rows.map(row => tableRow(row, section.checklist)).join("")}</tbody></table>`
        : `<p class="report-empty"${field ? ` data-manual-empty="${field}"` : ""}${manual.trim() ? " hidden" : ""}>暂无事项。</p>`}${manualArea}</section>`;
    }).join("");
    const tiles = report.mode === "overview" ? [["阶段总数", m.stages, "按保存的原始状态计数"], ["已完成阶段占比", m.completion, "阶段数量占比"], ["未关闭问题", m.openIssues, `全部问题 ${m.issues} 项`], ["逾期问题", m.overdueIssues, "今天到期不算逾期"]]
      : [["本次待办", report.todos.length, "按所选日期口径筛选"], ["新增纳入", report.baseline ? report.changes.new : "—", report.baseline ? "相对上次清单" : "导入上次 HTML 后比较"], ["紧急 / 高优先级", report.todos.filter(row => ["urgent", "high"].includes(row.priorityKey)).length, "仅统计本次待办"], ["未分配", report.todos.filter(row => !row.assigned).length, "待明确负责人"]];
    return `<header class="report-cover"><div class="report-brand"><strong>Bobo</strong><span>${report.mode === "overview" ? "阶段性进展汇报" : report.mode === "handoff" ? "周期待办交接" : "周期执行清单"}</span><span class="report-revision">REV ${e(report.revision)}</span></div><h2>${e(report.title)}</h2><p class="report-scope">${e(report.scope)}</p><dl class="report-meta"><div><dt>生成时间</dt><dd>${e(report.generatedAt)}</dd></div><div><dt>报告人</dt><dd>${e(report.author)}</dd></div><div><dt>统计日</dt><dd>${e(report.localDate)}</dd></div><div><dt>附完成清单</dt><dd>${report.includeCompleted ? "是" : "否"}</dd></div><div class="report-meta-wide"><dt>日期口径</dt><dd>${e(periodDescription(report))}</dd></div>${report.mode !== "overview" ? `<div class="report-meta-wide"><dt>排序/基准</dt><dd>${SORTS[report.sort]} · ${report.baseline ? `${e(report.baseline.asOf)} / revision ${e(report.baseline.revision)}` : "未导入比较基准"}</dd></div>` : ""}</dl></header>
      <p class="report-snapshot-note">已持久化业务快照，不含未保存的系统编辑；人工补充和勾选仅用于本报告，不改变快照统计或业务数据。</p>
      <section class="report-section"><div class="report-section-head"><span class="report-section-index">01</span><h3>${report.mode === "overview" ? "当前状态摘要" : "本次清单摘要"}</h3></div><div class="report-stats">${tiles.map(([label, value, detail]) => `<div><span>${label}</span><strong>${e(value)}</strong><small>${e(detail)}</small></div>`).join("")}</div><div class="report-summary-lines">${summary(report).map(line => `<p>${e(line)}</p>`).join("")}</div>${report.mode === "overview" ? `<div class="report-progress" role="img" aria-label="已完成阶段占比 ${e(m.completion)}"><span style="width:${m.completion === "—" ? "0%" : m.completion}"></span></div>` : ""}</section>
      ${report.warnings.length ? `<section class="report-warning"><h3>数据待核对</h3><ul>${report.warnings.map(warning => `<li>${e(warning)}</li>`).join("")}</ul></section>` : ""}${sectionsHtml}
      ${report.mode === "handoff" ? `<section class="report-section report-note-section"><div class="report-section-head"><h3>交接说明 <small>人工填写</small></h3></div><p class="report-note-text">${e(report.note || "未补充")}</p></section>` : ""}<footer class="report-footer"><span>${e(MODES[report.mode])}</span><span>revision ${e(report.revision)} · ${e(report.localDate)}</span></footer>`;
  }

  function syncManualOutput(input, container) {
    const field = input.dataset.manualField;
    const output = container.querySelector(`[data-manual-output="${field}"]`);
    if (output) { output.querySelector(".report-manual-text").textContent = input.value; output.hidden = !input.value.trim(); }
    const empty = container.querySelector(`[data-manual-empty="${field}"]`);
    if (empty) empty.hidden = Boolean(input.value.trim());
  }

  // Shared by the in-app preview, offline HTML and browser PDF printing.
  const REPORT_STYLES = `
/* finesse · component: report · register=product · tokens: inherited Bobo palette */
.report-document, .report-export {
  --report-bg: var(--bg, #f7f8fa); --report-paper: var(--panel, #ffffff);
  --report-ink: var(--ink, #1d2433); --report-muted: var(--muted, #667085);
  --report-line: var(--line, #d9dee8); --report-soft: var(--soft-line, #edf0f5);
  --report-accent: var(--accent, #b4232d); --report-strong: var(--accent-strong, #841923);
  --report-green: var(--green, #2f8f5b); --report-red: var(--dark-red, #8f1f1f);
  --report-selected: var(--select-bg, #fff0f1); --report-shadow: rgba(100, 24, 34, .08);
  --report-font: "Segoe UI", "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
  color: var(--report-ink); font-family: var(--report-font); font-size: 13px; line-height: 1.65;
}
.report-document { box-sizing: border-box; padding: 24px; border: 1px solid var(--report-line); border-radius: 6px; background: var(--report-paper); overflow-wrap: anywhere; }
.report-document * { box-sizing: border-box; }
.report-document h2 { margin: 18px 0 4px; font-size: 25px; line-height: 1.3; letter-spacing: -.5px; }
.report-document h3 { margin: 0; font-size: 15px; line-height: 1.5; }
.report-document p { margin: 8px 0; }
.report-brand { display: flex; align-items: baseline; gap: 10px; padding-bottom: 12px; border-bottom: 2px solid var(--report-accent); color: var(--report-muted); font-size: 11px; }
.report-brand strong { color: var(--report-accent); font-size: 18px; letter-spacing: -.6px; }
.report-revision { margin-left: auto; font-variant-numeric: tabular-nums; letter-spacing: 1px; }
.report-scope { color: var(--report-muted); font-size: 14px; }
.report-meta { display: grid; grid-template-columns: 2fr 1fr; gap: 10px 20px; margin: 18px 0; font-size: 12px; }
.report-meta div { display: flex; gap: 12px; }
.report-meta .report-meta-wide { grid-column: 1 / -1; }
.report-meta dt { min-width: 60px; color: var(--report-muted); }
.report-meta dd { margin: 0; }
.report-snapshot-note { padding: 10px 12px; background: var(--report-bg); color: var(--report-muted); font-size: 11px; }
.report-section { margin-top: 28px; }
.report-manual-editor { display: grid; gap: 8px; margin-top: 12px; color: var(--report-ink); font-size: 12px; }
.report-manual-editor span { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
.report-manual-editor small { color: var(--report-muted); font-weight: 400; }
.report-manual-editor textarea { width: 100%; min-height: 100px; padding: 10px 12px; border: 1px solid var(--report-line); border-radius: 5px; color: var(--report-ink); background: var(--report-paper); font: inherit; line-height: 1.6; resize: vertical; }
.report-manual-editor textarea:focus-visible { outline: 2px solid var(--report-accent); outline-offset: 2px; }
.report-manual-display { margin-top: 12px; padding: 10px 12px; border-left: 2px solid var(--report-line); background: var(--report-bg); }
.report-manual-display strong { color: var(--report-muted); font-size: 11px; }
.report-manual-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.report-manual-editor ~ .report-manual-display, .report-manual-section > .report-empty { display: none; }
.report-document [hidden] { display: none !important; }
.report-section-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; }
.report-section-index { color: var(--report-accent); font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
.report-count { margin-left: auto; color: var(--report-muted); font-size: 11px; }
.report-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--report-line); border-bottom: 1px solid var(--report-line); }
.report-stats > div { padding: 14px 14px 14px 0; }
.report-stats > div + div { border-left: 1px solid var(--report-soft); padding-left: 14px; }
.report-stats span, .report-stats small { display: block; color: var(--report-muted); font-size: 11px; }
.report-stats strong { display: block; margin: 4px 0; font-size: 28px; font-weight: 650; line-height: 1.2; font-variant-numeric: tabular-nums; }
.report-summary-lines { margin: 12px 0; font-size: 12px; }
.report-progress { height: 5px; max-width: 320px; margin: 14px 0; border-radius: 3px; background: var(--report-soft); overflow: hidden; }
.report-progress span { display: block; height: 100%; background: var(--report-green); }
.report-document table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 12px; }
.report-document th, .report-document td { padding: 10px 8px; border: 0; border-bottom: 1px solid var(--report-line); text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.report-document th { border-top: 1px solid var(--report-line); background: var(--report-bg); color: var(--report-muted); font-size: 10px; font-weight: 600; }
.report-document tbody tr:nth-child(even) { background: var(--report-bg); }
.report-document .report-task { width: 34%; }
.report-document td strong { font-weight: 600; }
.report-document td small { display: block; margin-top: 5px; color: var(--report-muted); font-size: 10px; line-height: 1.5; }
.report-document .report-id { font-size: 9px; }
.report-document .report-check-cell { width: 42px; padding-left: 0; padding-right: 0; text-align: center; }
.report-check { display: inline-flex; position: relative; min-width: 38px; min-height: 38px; justify-content: center; align-items: center; cursor: pointer; }
.report-check input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.report-box { display: grid; width: 17px; height: 17px; place-items: center; border: 1.5px solid var(--report-muted); border-radius: 3px; background: var(--report-paper); }
.report-check input:checked + .report-box { border-color: var(--report-green); color: var(--report-green); }
.report-check input:checked + .report-box::after { content: "✓"; font: 700 14px/1 var(--report-font); }
.report-check input:focus-visible + .report-box { outline: 2px solid var(--report-accent); outline-offset: 4px; }
.report-check:active .report-box { background: var(--report-selected); }
.report-check:has(input:disabled) { cursor: not-allowed; opacity: .5; }
.report-checked .report-task > strong { text-decoration: line-through; text-decoration-color: var(--report-green); }
.report-badge { display: inline-block; padding: 2px 5px; border: 1px solid var(--report-line); border-radius: 3px; font-size: 10px; white-space: normal; }
.report-badge.is-complete { color: var(--report-green); }
.report-badge.is-overdue { color: var(--report-red); }
.report-change { display: inline-block; margin: 0 6px 6px 0; padding: 1px 5px; border: 1px solid var(--report-line); border-radius: 3px; color: var(--report-muted); font-size: 10px; }
.report-change.is-new { color: var(--report-accent); border-color: var(--report-accent); background: var(--report-selected); }
.report-risk-tag { display: block; margin-bottom: 4px; font-size: 10px; color: var(--report-muted); }
.report-date { font-variant-numeric: tabular-nums; }
.report-empty { padding: 16px; border: 1px dashed var(--report-line); color: var(--report-muted); text-align: center; }
.report-muted, .report-check-hint { color: var(--report-muted); font-size: 11px; }
.report-warning { margin-top: 20px; padding: 14px; border: 1px solid var(--report-line); border-radius: 4px; background: var(--report-bg); }
.report-warning ul { margin-bottom: 0; padding-left: 20px; }
.report-note-section { padding: 16px; background: var(--report-bg); border: 1px solid var(--report-line); border-radius: 4px; }
.report-note-section h3 small { color: var(--report-muted); font-size: 11px; font-weight: 400; }
.report-note-text { white-space: pre-wrap; }
.report-footer { display: flex; justify-content: space-between; gap: 12px; margin-top: 30px; padding-top: 12px; border-top: 1px solid var(--report-line); color: var(--report-muted); font-size: 10px; }
.report-export { margin: 0; padding: 0; min-width: 0; background: var(--report-bg); }
.report-export .report-document { width: min(980px, calc(100% - 32px)); margin: 24px auto; padding: 40px; box-shadow: 0 8px 32px var(--report-shadow); }
.report-export-tools { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; width: min(980px, calc(100% - 32px)); margin: 20px auto 0; }
.report-export-tools p { flex-basis: 100%; margin: 0; color: var(--report-muted); font-size: 12px; }
.report-export button { min-height: 44px; border: 1px solid var(--report-line); border-radius: 5px; padding: 0 16px; color: var(--report-ink); background: var(--report-paper); font: inherit; white-space: nowrap; cursor: pointer; }
.report-export button[data-action="pdf"] { border-color: var(--report-accent); color: var(--report-accent); }
.report-export button[data-action="save"] { min-width: 150px; }
.report-export button:focus-visible { outline: 2px solid var(--report-accent); outline-offset: 3px; }
.report-export button:active { background: var(--report-selected); }
.report-export button:disabled { opacity: .5; cursor: not-allowed; }
.report-export button[aria-busy="true"] { min-width: 150px; cursor: progress; }
.report-export-tools [data-state="error"] { color: var(--report-red); }
.report-export-tools [data-state="success"] { color: var(--report-green); }
@media (hover: hover) {
  .report-check:hover .report-box { border-color: var(--report-accent); }
  .report-export button:hover { border-color: var(--report-accent); background: var(--report-selected); }
}
@media screen and (max-width: 640px) {
  .report-document { padding: 14px; }
  .report-document h2 { font-size: 22px; }
  .report-meta { grid-template-columns: 1fr; gap: 8px; }
  .report-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .report-stats > div:nth-child(3) { border-left: 0; padding-left: 0; }
  .report-stats > div:nth-child(n+3) { border-top: 1px solid var(--report-soft); }
  .report-document table, .report-document tbody { display: block; }
  .report-document thead { display: none; }
  .report-document tr { display: grid; position: relative; grid-template-columns: 1fr 1fr; gap: 12px; padding: 16px 8px; border-bottom: 1px solid var(--report-line); }
  .report-document .report-checklist tr { padding-left: 42px; }
  .report-document td { display: block; padding: 0; border: 0; min-width: 0; }
  .report-document td::before { display: block; margin-bottom: 3px; content: attr(data-label); color: var(--report-muted); font-size: 10px; }
  .report-document .report-task { width: auto; grid-column: 1 / -1; }
  .report-document .report-task::before { display: none; }
  .report-document .report-check-cell { position: absolute; top: 8px; left: 0; width: 38px; }
  .report-document td:last-child { grid-column: 1 / -1; }
  .report-check { min-width: 44px; min-height: 44px; }
  .report-export .report-document { margin: 16px auto; padding: 18px; }
  .report-footer { flex-wrap: wrap; }
}
@media print {
  @page { size: A4 portrait; margin: 14mm; }
  .report-export { background: var(--report-paper); }
  .report-export-tools, .report-manual-editor { display: none !important; }
  .report-manual-display:not([hidden]), .report-manual-section > .report-empty:not([hidden]) { display: block; }
  .report-export .report-document, .report-document { width: auto; max-width: none; margin: 0; padding: 0; border: 0; box-shadow: none; border-radius: 0; font-size: 9pt; }
  .report-brand, .report-stats { break-inside: avoid; }
  .report-document h2, .report-section-head { break-after: avoid; }
  .report-section { margin-top: 18px; }
  .report-document table { font-size: 8pt; }
  .report-document thead { display: table-header-group; }
  .report-document tr { break-inside: avoid; }
  .report-document th, .report-document td { padding: 7px 5px; }
  .report-document .report-check-cell { width: 25px; }
  .report-check { min-width: 22px; min-height: 22px; }
  .report-check:has(input:disabled) { opacity: 1; }
  .report-box { border-color: var(--report-ink); }
  .report-check input:checked + .report-box { color: var(--report-ink); border-color: var(--report-ink); }
  .report-document td small { font-size: 7pt; }
  .report-cover, .report-note-section { break-inside: avoid-page; }
}
`;

  // This function is serialized into each offline HTML; it has no app dependencies.
  function offlineControls(syncManualOutput) {
    const status = document.getElementById("exportStatus");
    document.addEventListener("input", event => {
      if (!event.target.matches("textarea[data-manual-field]")) return;
      syncManualOutput(event.target, document);
      status.textContent = "人工补充已更新；点击“保存报告副本”保留。快照统计保持不变。";
      status.dataset.state = "success";
    });
    document.addEventListener("change", event => {
      const input = event.target;
      if (!input.matches("input[data-check-key]") || input.disabled) return;
      document.querySelectorAll("input[data-check-key]").forEach(other => {
        if (other.dataset.checkKey === input.dataset.checkKey) {
          other.checked = input.checked;
          other.closest("tr").classList.toggle("report-checked", input.checked);
        }
      });
      status.textContent = "勾选已更新；点击“保存报告副本”保留。原始状态和快照统计保持不变。";
      status.dataset.state = "success";
    });
    document.querySelector('[data-action="pdf"]').addEventListener("click", () => {
      try { window.print(); } catch { status.textContent = "无法打开打印窗口，请使用浏览器菜单打印并选择另存为 PDF。"; status.dataset.state = "error"; }
    });
    document.querySelector('[data-action="save"]').addEventListener("click", event => {
      const button = event.currentTarget;
      button.disabled = true; button.setAttribute("aria-busy", "true");
      try {
        const copy = document.documentElement.cloneNode(true);
        const originals = document.querySelectorAll("input[data-check-key]");
        copy.querySelectorAll("input[data-check-key]").forEach((input, index) => input.toggleAttribute("checked", originals[index].checked));
        copy.querySelectorAll("textarea[data-manual-field]").forEach((textarea, index) => {
          textarea.textContent = document.querySelectorAll("textarea[data-manual-field]")[index].value;
        });
        const savedButton = copy.querySelector('[data-action="save"]');
        savedButton.disabled = false; savedButton.removeAttribute("aria-busy");
        copy.querySelector("#exportStatus").textContent = "已保留此副本的人工补充和勾选，可继续编辑并保存。原始状态和快照统计保持不变。";
        copy.querySelector("#exportStatus").dataset.state = "success";
        const url = URL.createObjectURL(new Blob(["<!doctype html>\n" + copy.outerHTML], { type: "text/html;charset=utf-8" }));
        const link = document.createElement("a");
        link.href = url; link.download = document.body.dataset.filename.replace(/\.html$/i, "-已编辑.html");
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = "已生成报告副本，请打开下载文件继续使用。"; status.dataset.state = "success";
      } catch { status.textContent = "保存失败，请检查浏览器下载权限后重试。"; status.dataset.state = "error"; }
      finally { button.disabled = false; button.removeAttribute("aria-busy"); }
    });
  }

  function exportHtml(report) {
    const baseline = createBaseline(report);
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; connect-src 'none'">
<title>${escape(report.title)} · ${escape(report.scope)}</title><style>${REPORT_STYLES}</style></head>
<body class="report-export" data-filename="${escape(filename(report, "html"))}">${baseline ? `<template id="bobo-report-baseline">${escape(JSON.stringify(baseline))}</template>` : ""}<nav class="report-export-tools" aria-label="离线报告操作"><button type="button" data-action="save">保存报告副本</button><button type="button" data-action="pdf">导出 PDF</button><p id="exportStatus" role="status" aria-live="polite">可离线补充文字、勾选并保存副本；PDF 请在打印窗口选择“另存为 PDF”，方框可打印后手写勾选。${baseline ? "此文件也可作为下次清单的比较基准。" : ""}</p></nav><main class="report-document">${renderReport(report, { editable: true })}</main><noscript>可使用浏览器菜单打印；保存报告副本按钮需要启用 JavaScript。</noscript><script>(${offlineControls.toString()})(${syncManualOutput.toString()});</script></body></html>`;
  }

  function filename(report, extension) {
    return `${report.scope}-${MODES[report.mode]}-${report.period.start ? `${report.period.start}_${report.period.end}-` : ""}${report.localDate}-r${text(report.revision)}`.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 150) + `.${extension}`;
  }
  const api = { collectReport, compareTodos, validDate, exportMarkdown, exportCsv, exportHtml, renderReport, filename, rowKey, weekRange, createBaseline, parseBaselineHtml };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window === "undefined") return;
  const stylesheet = document.createElement("style");
  stylesheet.textContent = REPORT_STYLES;
  document.head.append(stylesheet);
  const $ = id => document.getElementById(id);
  const dialog = $("reportsDialog");
  let snapshot = null, report = null, selection = {}, generated = null, controller = null, requestId = 0;
  let baseline = null, periodInitialized = false, fileReadId = 0;
  let printTitle = null;
  const checkedIds = new Set();
  const manualDraft = { manualTodos: "", manualRisks: "" };
  const exports = [$("reportMarkdownBtn"), $("reportCsvBtn"), $("reportHtmlBtn"), $("reportPrintBtn")];
  const controls = [$("reportMode"), $("reportScope"), $("reportCompleted"), $("refreshReportBtn"), ...$("reportPeriodControls").querySelectorAll("input,button,select")];
  function updateComparisonControls() {
    const option = $("reportSort").querySelector('option[value="new"]');
    option.disabled = !baseline;
    option.textContent = baseline ? "本次新增在前" : "新增在前（需基准）";
    $("reportClearBaselineBtn").disabled = !baseline;
  }
  function clearComparison(message = "未导入比较基准；先导出本次 HTML，下次导入即可比较。") {
    fileReadId++; baseline = null;
    if ($("reportSort").value === "new") $("reportSort").value = "priority";
    $("reportBaselineStatus").textContent = message;
    updateComparisonControls();
  }
  function updateMode() {
    const mode = $("reportMode").value;
    $("reportPeriodControls").hidden = mode === "overview";
    $("reportNoteField").hidden = mode !== "handoff";
    $("reportPurpose").textContent = mode === "overview" ? "状态概览：汇报当前所选系统/项目的阶段进展、问题和风险，不生成历史状态。"
      : mode === "handoff" ? "工作交接：交出所选周期内需要继续办理的事项，附临时说明；默认只交接未完成项。问题按截止日、阶段按计划区间相交筛选，精确到日。"
        : "Todo 清单：安排本周、下周或自定义周期的待办；可导入上次 HTML，标出新增纳入与内容变更。问题按截止日、阶段按计划区间相交筛选，精确到日。";
    if (mode !== "overview" && !periodInitialized) {
      const range = weekRange();
      $("reportDateStart").value = range.start; $("reportDateEnd").value = range.end;
      periodInitialized = true;
    }
  }
  function rebuild() {
    if (!snapshot) return;
    try {
      report = collectReport(snapshot, { ...selection, ...manualDraft, scope: $("reportScope").value, mode: $("reportMode").value, includeCompleted: $("reportCompleted").checked, note: $("reportNote").value, checkedIds: [...checkedIds],
        dateStart: $("reportDateStart").value, dateEnd: $("reportDateEnd").value, includeUndated: $("reportIncludeUndated").checked,
        includeCarryover: $("reportIncludeCarryover").checked, sort: $("reportSort").value, baseline }, generated);
      $("reportPreview").innerHTML = renderReport(report, { editable: true });
      $("reportMessage").textContent = "快照已生成。切换模式与下载共用此快照；人工补充在刷新时保留、关闭报表时清空；临时勾选在刷新或关闭时清空。";
      exports.forEach(button => button.disabled = false);
    } catch (error) {
      report = null;
      $("reportPreview").replaceChildren();
      $("reportMessage").textContent = error.message;
      exports.forEach(button => button.disabled = true);
    }
  }
  async function refresh() {
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    const id = ++requestId;
    fileReadId++;
    checkedIds.clear();
    snapshot = report = null;
    exports.forEach(button => button.disabled = true);
    controls.forEach(control => control.disabled = true);
    $("reportPreview").replaceChildren();
    $("reportPreview").setAttribute("aria-busy", "true");
    $("reportMessage").textContent = "正在读取最新数据快照…";
    const timeout = setTimeout(() => requestController.abort(), 15000);
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store", signal: requestController.signal });
      if (!response.ok) throw new Error(response.status === 401 ? "登录已失效，请关闭报表并重新登录。" : `读取失败（HTTP ${response.status}），请重试。`);
      const payload = await response.json();
      if (id !== requestId || !dialog.open) return;
      snapshot = payload; generated = new Date();
      $("reportMessage").textContent = "快照已生成。切换模式与下载共用此快照；人工补充在刷新时保留、关闭报表时清空；临时勾选在刷新或关闭时清空。";
      rebuild();
    } catch (error) {
      if (id === requestId && dialog.open) $("reportMessage").textContent = error.name === "AbortError" ? "读取超时，请检查网络并重试。" : error.name === "TypeError" ? "读取失败，请检查网络连接后重试。" : error.message || "读取失败，请检查网络。";
    } finally {
      clearTimeout(timeout);
      if (id === requestId) {
        controls.forEach(control => control.disabled = false);
        updateComparisonControls();
        $("reportScope").options[0].disabled = !selection.projectId;
        $("reportPreview").setAttribute("aria-busy", "false");
      }
    }
  }
  function download(content, type, extension) {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url; link.download = filename(report, extension);
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("reportMode").addEventListener("change", () => {
    fileReadId++;
    $("reportCompleted").checked = false;
    updateMode();
    rebuild();
  });
  function criteriaChanged() {
    clearComparison("日期或范围已改变，请重新导入同范围、同周期的 HTML。可先导出本次文件作为新基准。");
    rebuild();
  }
  $("reportScope").addEventListener("change", criteriaChanged);
  ["reportDateStart", "reportDateEnd", "reportIncludeUndated", "reportIncludeCarryover"].forEach(id => $(id).addEventListener("change", criteriaChanged));
  $("reportSort").addEventListener("change", rebuild);
  document.querySelectorAll("[data-report-period]").forEach(button => button.addEventListener("click", () => {
    const choice = button.dataset.reportPeriod;
    const range = choice === "all" ? { start: "", end: "" } : weekRange(new Date(), choice === "next" ? 1 : 0);
    $("reportDateStart").value = range.start; $("reportDateEnd").value = range.end;
    criteriaChanged();
  }));
  $("reportImportBaselineBtn").addEventListener("click", () => $("reportBaselineFile").click());
  $("reportClearBaselineBtn").addEventListener("click", () => { clearComparison(); rebuild(); });
  $("reportBaselineFile").addEventListener("change", async () => {
    const file = $("reportBaselineFile").files[0];
    if (!file) return;
    clearComparison("正在读取基准文件…");
    rebuild();
    const id = fileReadId;
    try {
      if (!snapshot || !generated) throw new Error("请先刷新数据，再导入比较基准。");
      if (file.size > 2 * 1024 * 1024) throw new Error("基准 HTML 最多 2 MiB，请选择较小的原始导出文件。");
      const parsed = parseBaselineHtml(await file.text());
      if (id !== fileReadId || !dialog.open) return;
      const projectId = $("reportScope").value === "system" ? "" : selection.projectId || "";
      if (parsed.scope.systemId !== selection.systemId || parsed.scope.projectId !== projectId) throw new Error("文件范围不匹配，请选择当前系统/项目导出的 HTML。");
      if (Date.parse(parsed.asOf) > generated.getTime()) throw new Error("基准比当前快照新，请先刷新数据后再导入。");
      baseline = parsed;
      $("reportDateStart").value = parsed.period.start; $("reportDateEnd").value = parsed.period.end;
      $("reportIncludeUndated").checked = parsed.period.includeUndated; $("reportIncludeCarryover").checked = parsed.period.includeCarryover;
      $("reportSort").value = "new";
      $("reportBaselineStatus").textContent = `已导入 ${file.name} · ${parsed.asOf} · revision ${parsed.revision}。已恢复基准日期条件；“新增纳入”不等于新建。`;
      updateComparisonControls(); rebuild();
    } catch (error) {
      if (id === fileReadId && dialog.open) { clearComparison(error.message); rebuild(); }
    } finally { $("reportBaselineFile").value = ""; }
  });
  $("reportCompleted").addEventListener("change", rebuild);
  $("reportNote").addEventListener("input", rebuild);
  $("reportPreview").addEventListener("input", event => {
    const input = event.target;
    if (!report || !input.matches("textarea[data-manual-field]") || !MANUAL_FIELDS.includes(input.dataset.manualField)) return;
    manualDraft[input.dataset.manualField] = input.value;
    report[input.dataset.manualField] = input.value;
    syncManualOutput(input, $("reportPreview"));
  });
  $("reportPreview").addEventListener("change", event => {
    if (!report || !event.target.matches("input[data-check-key]") || event.target.disabled) return;
    const input = event.target;
    if (input.checked) checkedIds.add(input.dataset.checkKey);
    else checkedIds.delete(input.dataset.checkKey);
    input.closest("tr").classList.toggle("report-checked", input.checked);
    report.checkedIds = [...checkedIds];
  });
  $("refreshReportBtn").addEventListener("click", refresh);
  $("closeReportsBtn").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    ++requestId; controller?.abort(); snapshot = report = null;
    clearComparison();
    checkedIds.clear();
    MANUAL_FIELDS.forEach(field => { manualDraft[field] = ""; });
    $("reportNote").value = ""; $("reportPreview").replaceChildren();
    finishPrint();
  });
  $("reportMarkdownBtn").addEventListener("click", () => report && download(exportMarkdown(report), "text/markdown;charset=utf-8", "md"));
  $("reportCsvBtn").addEventListener("click", () => report && download(exportCsv(report), "text/csv;charset=utf-8", "csv"));
  $("reportHtmlBtn").addEventListener("click", () => report && download(exportHtml(report), "text/html;charset=utf-8", "html"));
  function beginPrint() {
    if (!report || !dialog.open) return;
    document.body.classList.add("report-print");
    if (printTitle === null) printTitle = document.title;
    document.title = filename(report, "pdf").replace(/\.pdf$/, "");
  }
  function finishPrint() {
    document.body.classList.remove("report-print");
    if (printTitle !== null) document.title = printTitle;
    printTitle = null;
  }
  $("reportPrintBtn").addEventListener("click", () => {
    if (!report) return;
    beginPrint();
    $("reportMessage").textContent = "请在打印窗口选择“另存为 PDF”。完成框将按当前勾选状态输出，也可打印后手写勾选。";
    try { window.print(); } catch (error) {
      finishPrint();
      $("reportMessage").textContent = `无法打开打印窗口：${error.message}`;
    }
  });
  window.addEventListener("beforeprint", beginPrint);
  window.addEventListener("afterprint", finishPrint);
  window.BoboReports = { open(context) {
    if (dialog.open || document.querySelector("dialog[open]")) return;
    selection = { ...context };
    MANUAL_FIELDS.forEach(field => { manualDraft[field] = ""; });
    periodInitialized = false; clearComparison();
    $("reportMode").value = "overview"; $("reportScope").value = context.projectId ? "project" : "system";
    $("reportScope").options[0].disabled = !context.projectId;
    $("reportCompleted").checked = false; $("reportNoteField").hidden = true;
    $("reportDateStart").value = ""; $("reportDateEnd").value = "";
    $("reportIncludeUndated").checked = false; $("reportIncludeCarryover").checked = false;
    $("reportSort").value = "priority"; updateMode();
    $("reportNote").value = ""; dialog.showModal(); refresh();
  } };
})();
