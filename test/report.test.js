const test = require("node:test");
const assert = require("node:assert/strict");
const { collectReport, validDate, exportMarkdown, exportCsv, exportHtml, renderReport, filename, rowKey, weekRange, createBaseline, parseBaselineHtml } = require("../public/reports");

const today = new Date(2026, 9, 27, 14, 30);
const options = { systemId: "s1", projectId: "p1" };
function fixture(stages = [], issues = []) {
  return { revision: 12, user: { displayName: "报告人" }, users: [
    { id: "u1", displayName: "张三", active: true }, { id: "old", displayName: "老成员", deletedAt: "2025-01-01" }, { id: "off", displayName: "停用成员", active: false }
  ], state: { systems: [{ id: "s1", name: "系统一", projects: [{ id: "p1", name: "项目一", requirements: [{ id: "r1", title: "需求一", stages }], issues }] },
    { id: "s2", name: "另一系统", projects: [{ id: "p2", name: "另一项目", requirements: [], issues: [{ id: "private", status: "open" }] }] }] } };
}
const stage = (id, extra = {}) => ({ id, title: id, status: "进行中", start: "2026-10-01", end: "2026-10-30", owner: "外部人员", ...extra });
const issue = (id, extra = {}) => ({ id, title: id, stageId: "a", status: "open", priority: "medium", assigneeUserId: "u1", dueDate: "2026-10-30", ...extra });
const report = (data, extra = {}) => collectReport(data, { ...options, ...extra }, today);

test("empty system and project export without inventing a completion percentage", () => {
  const data = fixture();
  const result = report(data);
  assert.equal(result.metrics.completion, "—");
  assert.equal(result.metrics.issues, 0);
  assert.deepEqual(result.todos, []);
  assert.match(exportMarkdown(result), /暂无事项/);
  assert.match(exportCsv(result), /revision/);
  assert.match(exportCsv(result), /系统一/);
  data.state.systems[0].projects = [];
  assert.equal(report(data, { projectId: "", scope: "system" }).metrics.stages, 0);
});

test("raw stage states stay mutually exclusive and derive only planned overdue risk", () => {
  const states = ["未开始", "进行中", "已完成", "超期未完成", "暂停"];
  const data = fixture(states.map((status, index) => stage(String(index), { status, end: "2026-10-26" })));
  const before = JSON.stringify(data);
  const result = report(data);
  assert.deepEqual(Object.values(result.metrics.stageStates), [1, 1, 1, 1, 1]);
  assert.equal(result.metrics.completion, "20%");
  assert.equal(result.metrics.overdueStages, 4);
  assert.equal(result.stages[4].status, "暂停");
  assert.deepEqual(result.stages[4].tags, ["计划超期", "暂停"]);
  assert.equal(JSON.stringify(data), before);
});

test("open issue Todos suppress stage reminders; derived issue flags are never counted", () => {
  const result = report(fixture([stage("a", { issueOpen: true, issues: "legacy text" }), stage("b"), stage("c", { status: "已完成" })], [issue("one"), issue("two"), issue("one")]));
  assert.equal(result.metrics.issues, 2);
  assert.equal(result.todos.length, 3);
  assert.deepEqual(result.todos.filter(row => row.kind === "stage").map(row => row.id), ["b"]);
  assert.equal(result.warnings.length, 1);
});

test("closed issues are only completion entries, and reopening replaces the stage reminder", () => {
  const data = fixture([stage("a")], [issue("done", { status: "closed", closedAt: "2026-10-26T05:00:00Z", closedByUserId: "u1" })]);
  let result = report(data, { mode: "todo" });
  assert.equal(result.todos[0].kind, "stage");
  assert.equal(result.completed.length, 1);
  assert.doesNotMatch(exportCsv(result), /"done"/);
  assert.match(exportCsv(report(data, { includeCompleted: true })), /"done"/);
  data.state.systems[0].projects[0].issues[0].status = "in_progress";
  result = report(data);
  assert.equal(result.todos.length, 1);
  assert.equal(result.todos[0].kind, "issue");
  assert.equal(result.completed.length, 0);
});

test("completed stages with open issues are flagged without inventing completion dates", () => {
  const result = report(fixture([stage("a", { status: "已完成" })], [issue("one")]), { mode: "handoff" });
  assert.match(result.stages[0].tags.join(), /已完成但有开放问题/);
  assert.equal(result.metrics.completion, "100%");
  assert.equal(result.todos.length, 1);
  assert.equal(result.completed[0].completion, "已标记完成（完成日期未知）");
  assert.match(exportMarkdown(result), /已标记完成（完成日期未知）/);
  assert.doesNotMatch(renderReport(result), /项目真实完成率/);
});

test("strict local calendar dates reject overflow and distinguish today from overdue", () => {
  for (const value of ["", "2026-02-29", "2026-02-30", "2026-13-01", "2026-1-01", "bad"]) assert.equal(validDate(value), false, value);
  assert.equal(validDate("2024-02-29"), true);
  const result = report(fixture([stage("a")], [issue("yesterday", { dueDate: "2026-10-26" }), issue("today", { dueDate: "2026-10-27" }), issue("bad", { dueDate: "2026-02-30" }), issue("empty", { dueDate: "" }), issue("closed", { dueDate: "2026-10-01", status: "closed" })]));
  assert.equal(result.metrics.overdueIssues, 1);
  assert.equal(result.undated.length, 2);
  assert.equal(result.upcoming.filter(row => row.kind === "issue").length, 1);
  assert.equal(result.todos.find(row => row.id === "today").overdue, false);
});

test("a missing issue due date is never inferred from stage end", () => {
  const result = report(fixture([stage("a", { end: "2026-10-01" })], [issue("one", { dueDate: "" })]));
  assert.equal(result.metrics.overdueStages, 1);
  assert.equal(result.metrics.overdueIssues, 0);
  assert.equal(result.todos[0].due, "");
  assert.equal(result.todos[0].dateSource, "问题截止日");
});

test("Todos sort by overdue, urgent/high, date, name and ID deterministically", () => {
  const items = [issue("none", { dueDate: "" }), issue("next", { dueDate: "2026-10-31" }), issue("today", { dueDate: "2026-10-27" }), issue("high", { priority: "high" }), issue("urgent", { priority: "urgent", dueDate: "" }), issue("overdue", { dueDate: "2026-10-26", priority: "low" })];
  const first = report(fixture([stage("a")], items));
  const second = report(fixture([stage("a")], [...items].reverse()));
  assert.deepEqual(first.todos.map(row => row.id), ["overdue", "urgent", "high", "today", "next", "none"]);
  assert.deepEqual(first.todos, second.todos);
});

test("owners preserve historical identities and free-text stage owners", () => {
  const result = report(fixture([stage("a"), stage("b", { owner: "u1" }), stage("c", { owner: "" })], [issue("old", { assigneeUserId: "old" }), issue("off", { assigneeUserId: "off" }), issue("unknown", { assigneeUserId: "gone" }), issue("empty", { assigneeUserId: "" })]));
  assert.equal(result.issues[0].owner, "老成员（已删除）");
  assert.equal(result.issues[1].owner, "停用成员（已停用）");
  assert.match(result.issues[2].owner, /历史身份未知/);
  assert.equal(result.metrics.unassignedIssues, 1);
  assert.equal(result.stages[1].owner, "u1");
  assert.equal(result.stages[2].owner, "未分配");
});

test("scope is selected strictly from the authorized bootstrap and never defaults across systems", () => {
  const data = fixture([stage("a")], [issue("one")]);
  assert.equal(report(data).metrics.issues, 1);
  assert.doesNotMatch(exportCsv(report(data)), /private|另一系统/);
  assert.throws(() => report(data, { systemId: "missing" }), /无权访问/);
  assert.throws(() => report(data, { projectId: "p2" }), /无权访问/);
  data.state.systems[0].projects.push({ id: "p3", name: "同系统项目", requirements: [], issues: [issue("extra")] });
  assert.equal(report(data, { scope: "system" }).metrics.issues, 2);
});

test("unknown states, orphan issues and invalid dates stay visible as data needing review", () => {
  const result = report(fixture([stage("a", { status: "mystery", end: "bad" })], [issue("unknown", { status: "mystery", priority: "__proto__", stageId: "gone" }), issue("legacy", { status: "closed", legacyClosureUnknown: true })]));
  assert.equal(result.metrics.unknownStages, 1);
  assert.equal(result.metrics.unknownIssues, 1);
  assert.equal(result.metrics.completion, "0%");
  assert.equal(result.metrics.openIssues, 1);
  assert.equal(result.todos.length, 2);
  assert.match(result.issues[0].tags.join(), /归属待核对/);
  assert.match(result.completed[0].completion, /历史记录未知/);
  assert.ok(result.warnings.length >= 4);
});

test("handoff defaults and all formats use the same metadata, options and manual note", () => {
  const result = report(fixture([stage("a", { status: "已完成" })]), { mode: "handoff", note: "交给李四\n资料待补充" });
  assert.equal(result.includeCompleted, true);
  for (const output of [exportCsv(result), exportMarkdown(result), renderReport(result), exportHtml(result)]) {
    assert.ok(output.includes(result.generatedAt));
    assert.ok(output.includes(result.scope));
    assert.ok(output.includes("交给李四"));
    assert.ok(output.includes("人工填写"));
  }
  assert.match(exportMarkdown(report(fixture(), { mode: "handoff" })), /未补充/);
  assert.equal(report(fixture(), { mode: "todo" }).includeCompleted, false);
});

test("exported checklists distinguish local checks from original completion without changing metrics", () => {
  const data = fixture([stage("a"), stage("done-stage", { status: "已完成" })], [issue("todo"), issue("done-issue", { status: "closed" })]);
  const before = JSON.stringify(data);
  const initial = report(data, { mode: "todo", includeCompleted: true });
  assert.match(exportMarkdown(initial), /- \[ \] \*\*todo\*\*/);
  assert.match(exportMarkdown(initial), /- \[x\] \*\*done-stage\*\*/);
  assert.match(exportMarkdown(initial), /- \[x\] \*\*done-issue\*\*/);
  assert.match(exportCsv(initial), /"☐","未勾选"/);
  assert.match(exportCsv(initial), /"☑","原始完成状态"/);
  const marked = report(data, { mode: "todo", includeCompleted: true, checkedIds: [rowKey(initial.todos[0])] });
  assert.match(exportMarkdown(marked), /- \[x\] \*\*todo\*\*/);
  assert.match(exportCsv(marked), /"☑","临时办理标记"/);
  assert.match(renderReport(marked), /aria-label="标记办理完成：todo" checked>/);
  assert.match(renderReport(marked), /aria-label="原始已完成：done-issue" checked disabled>/);
  assert.deepEqual(marked.metrics, initial.metrics);
  assert.equal(marked.todos[0].status, "待处理");
  assert.equal(JSON.stringify(data), before);
});

test("standalone HTML embeds all styles and controls without loading external resources", () => {
  const result = report(fixture([stage("a")], [issue("todo")]), { mode: "todo" });
  const html = exportHtml(result);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /<style>[\s\S]*@media print/);
  assert.match(html, /data-action="save">保存报告副本/);
  assert.match(html, /data-action="pdf">导出 PDF/);
  assert.match(html, /input\.toggleAttribute\("checked", originals\[index\]\.checked\)/);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=/i);
  assert.doesNotMatch(html, /fetch\(/);
  assert.match(exportHtml(report(fixture())), /暂无事项/);
});

test("offline HTML escapes hostile titles, notes, attributes and script terminators", () => {
  const data = fixture([stage("a")], [issue('id"><img src=x>', { title: '</script><script>alert("bad")</script>' })]);
  data.state.systems[0].name = '</title><img src=x onerror=alert(1)>';
  const result = report(data, { mode: "handoff", note: '</script><img src=x onerror=alert(1)>' });
  const html = exportHtml(result);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.match(html, /&lt;\/script&gt;/);
  assert.match(html, /&quot;/);
});

test("local check keys distinguish stage and issue IDs and do not leak across scopes", () => {
  const data = fixture([stage("a"), stage("same")], [issue("same")]);
  const first = report(data);
  const stageRow = first.todos.find(row => row.kind === "stage");
  const issueRow = first.todos.find(row => row.kind === "issue");
  assert.notEqual(rowKey(stageRow), rowKey(issueRow));
  const marked = report(data, { mode: "todo", checkedIds: [rowKey(stageRow)] });
  assert.match(exportMarkdown(marked), /- \[x\] \*\*same\*\* · 阶段提醒/);
  assert.match(exportMarkdown(marked), /- \[ \] \*\*same\*\* · 问题/);
  assert.deepEqual(report(data).checkedIds, []);
});

test("weekly shortcuts use local Monday-Sunday ranges across years", () => {
  assert.deepEqual(weekRange(new Date(2026, 11, 31)), { start: "2026-12-28", end: "2027-01-03" });
  assert.deepEqual(weekRange(new Date(2027, 0, 3), 1), { start: "2027-01-04", end: "2027-01-10" });
});

test("periods include issue deadline endpoints and overlapping stage plans but exclude undated tasks", () => {
  const data = fixture([stage("a"), stage("overlap", { start: "2026-10-01", end: "2026-11-05" }), stage("later", { start: "2026-11-02", end: "2026-11-04" }), stage("undated", { end: "bad" })], [
    issue("first", { dueDate: "2026-10-26" }), issue("last", { dueDate: "2026-11-01" }), issue("before", { dueDate: "2026-10-25" }), issue("after", { dueDate: "2026-11-02" }), issue("none", { dueDate: "" })
  ]);
  const result = report(data, { mode: "todo", dateStart: "2026-10-26", dateEnd: "2026-11-01" });
  assert.deepEqual(result.todos.map(row => row.id).sort(), ["first", "last", "overlap"]);
  assert.equal(result.excluded.undated, 2);
  assert.equal(result.excluded.total, 5);
  assert.equal(result.metrics.issues, 2);
  for (const output of [exportCsv(result), exportMarkdown(result), renderReport(result), exportHtml(result)]) {
    assert.ok(output.includes("2026-10-26")); assert.ok(output.includes("2026-11-01"));
    assert.ok(!output.includes('ID: after'));
  }
  assert.match(filename(result, "html"), /2026-10-26_2026-11-01/);
});

test("undated and prior-period unfinished work are explicit opt-ins and never rewrite overdue status", () => {
  const data = fixture([stage("a")], [issue("none", { dueDate: "" }), issue("prior", { dueDate: "2026-10-30" }), issue("prior-closed", { dueDate: "2026-10-30", status: "closed" })]);
  const result = report(data, { mode: "todo", dateStart: "2026-11-02", dateEnd: "2026-11-08", includeUndated: true, includeCarryover: true });
  assert.deepEqual(result.todos.map(row => row.id).sort(), ["none", "prior"]);
  assert.ok(result.todos.find(row => row.id === "none").tags.includes("手动纳入无日期事项"));
  const prior = result.todos.find(row => row.id === "prior");
  assert.ok(prior.tags.includes("期前遗留未完成"));
  assert.equal(prior.overdue, false);
  assert.equal(result.completed.length, 0);
});

test("invalid or partial periods fail clearly, and overview remains a full snapshot", () => {
  for (const extra of [{ dateStart: "2026-11-02", dateEnd: "" }, { dateStart: "2026-11-02", dateEnd: "2026-11-01" }, { dateStart: "2026-02-30", dateEnd: "2026-03-01" }]) assert.throws(() => report(fixture(), { mode: "todo", ...extra }), /有效/);
  const result = report(fixture([stage("a", { notes: "阶段已完成接口联调" })], [issue("one")]), { dateStart: "2027-01-01", dateEnd: "2027-01-07" });
  assert.equal(result.metrics.issues, 1);
  assert.equal(result.period.start, "");
  assert.match(renderReport(result), /阶段性进展汇报/);
  assert.match(renderReport(result), /阶段已完成接口联调/);
  assert.doesNotMatch(exportMarkdown(result), /## 下一步 Todo/);
  assert.equal(createBaseline(result), null);
  const completeOverview = report(fixture([stage("a", { status: "已完成" })]));
  assert.match(exportMarkdown(completeOverview), /\| a \| 已完成 \|/);
  assert.match(exportCsv(completeOverview), /"a","已完成"/);
});

test("comparing the same period labels newly included, changed and existing work and sorts new first", () => {
  const data = fixture([stage("a"), stage("reminder")], [issue("existing"), issue("changed"), issue("gone")]);
  const settings = { mode: "todo", dateStart: "2026-10-26", dateEnd: "2026-11-01" };
  const previous = report(data, settings);
  const baseline = parseBaselineHtml(exportHtml(previous));
  data.state.systems[0].projects[0].issues = [issue("existing"), issue("changed", { title: "内容已调整" }), issue("new", { priority: "low" })];
  const current = report(data, { ...settings, baseline, sort: "new" });
  assert.equal(current.todos[0].id, "new");
  assert.equal(current.todos[0].changeLabel, "新增纳入");
  assert.deepEqual(current.changes, { new: 1, changed: 1, existing: 2, absent: 1 });
  for (const output of [exportMarkdown(current), exportCsv(current), renderReport(current), exportHtml(current)]) assert.match(output, /新增纳入/);
  assert.match(exportMarkdown(current), /不代表已删除/);
  assert.throws(() => report(data, { ...settings, sort: "new" }), /先导入/);
});

test("baseline comparison uses stable IDs across renames, ignores manual checks, and distinguishes newly generated reminders", () => {
  const data = fixture([stage("a")], [issue("one")]);
  const settings = { mode: "todo" };
  const before = report(data, settings);
  const baseline = createBaseline(report(data, { ...settings, checkedIds: [rowKey(before.todos[0])] }));
  data.state.systems[0].name = "重命名系统"; data.state.systems[0].projects[0].name = "重命名项目";
  assert.equal(report(data, { ...settings, baseline }).changes.existing, 1);
  data.state.systems[0].projects[0].issues[0].status = "closed";
  const after = report(data, { ...settings, baseline });
  assert.equal(after.todos[0].kind, "stage");
  assert.equal(after.todos[0].change, "new");
  assert.equal(after.changes.absent, 1);
});

test("baseline rejects scope, period, future timestamps, duplicate keys and legacy HTML", () => {
  const data = fixture([stage("a")], [issue("one")]);
  const baseline = createBaseline(report(data, { mode: "todo" }));
  assert.throws(() => report(data, { mode: "todo", scope: "system", baseline }), /范围或日期/);
  assert.throws(() => report(data, { mode: "todo", dateStart: "2026-10-26", dateEnd: "2026-11-01", baseline }), /范围或日期/);
  assert.throws(() => report(data, { mode: "todo", baseline: { ...baseline, asOf: "2099-01-01T00:00:00Z" } }), /晚于/);
  const corrupt = structuredClone(baseline); corrupt.todos.push(corrupt.todos[0]);
  const encoded = JSON.stringify(corrupt).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  assert.throws(() => parseBaselineHtml(`<template id="bobo-report-baseline">${encoded}</template>`), /重复/);
  assert.throws(() => parseBaselineHtml('<html><script>alert(1)</script></html>'), /不含可比较/);
});

test("baseline metadata cannot inject HTML and parses only its inert template", () => {
  const data = fixture([stage("a")], [issue("one", { title: '</template><img src=x> &quot;' })]);
  const first = report(data, { mode: "todo" });
  const html = exportHtml(first);
  assert.doesNotMatch(html, /<img/);
  const baseline = parseBaselineHtml(html);
  assert.equal(baseline.todos[0].fingerprint, createBaseline(first).todos[0].fingerprint);
  assert.equal(report(data, { mode: "todo", baseline }).changes.existing, 1);
});

test("record creation ordering is explicit and leaves stages without timestamps last", () => {
  const data = fixture([stage("a"), stage("reminder")], [issue("old", { createdAt: "2026-10-01T10:00:00Z" }), issue("new", { createdAt: "2026-10-27T01:00:00Z" })]);
  const current = report(data, { mode: "todo", sort: "created" });
  assert.deepEqual(current.todos.map(row => row.id), ["new", "old", "reminder"]);
  assert.match(exportMarkdown(current), /未记录创建时间/);
  assert.equal(current.todos[0].changeLabel, undefined);
});

test("period filtering preserves full-stage deduplication and carries relevant parent risks", () => {
  const settings = { mode: "handoff", dateStart: "2026-10-26", dateEnd: "2026-11-01" };
  const outside = report(fixture([stage("a")], [issue("later", { dueDate: "2026-11-15" })]), settings);
  assert.equal(outside.todos.length, 0);
  const paused = report(fixture([stage("a", { status: "暂停" })], [issue("one")]), settings);
  assert.ok(paused.todos[0].tags.includes("所属阶段暂停"));
  const complete = report(fixture([stage("a", { status: "已完成" })], [issue("one")]), settings);
  assert.ok(complete.todos[0].tags.includes("所属阶段已完成·问题未关闭待核对"));
});

test("phase note changes are visible in all exports and marked changed against a baseline", () => {
  const data = fixture([stage("a", { notes: "初版安排" })]);
  const baseline = createBaseline(report(data, { mode: "todo" }));
  data.state.systems[0].projects[0].requirements[0].stages[0].notes = "补充验收资料位置";
  const changed = report(data, { mode: "todo", baseline });
  assert.equal(changed.changes.changed, 1);
  for (const output of [exportCsv(changed), exportMarkdown(changed), renderReport(changed), exportHtml(changed)]) assert.match(output, /补充验收资料位置/);
});

test("CSV quotes multiline data and blocks formula prefixes after whitespace and controls", () => {
  for (const title of ["=1+1", "+SUM(A1)", "-1", "@x", " \t=HYPERLINK(\"bad\")", "\u0001@x", "\uFEFF=1", "\u200B=1", "\u200E@x", "\tplain"]) {
    const csv = exportCsv(report(fixture([stage("a")], [issue("one", { title })])));
    assert.equal(csv.charCodeAt(0), 0xfeff);
    assert.ok(csv.includes(`"'${title.replace(/"/g, '""')}"`), JSON.stringify(title));
    assert.ok(csv.includes("\r\n"));
  }
  const csv = exportCsv(report(fixture([stage("a")], [issue("one", { title: '中文,引号"\n第二行' })])));
  assert.ok(csv.includes('"中文,引号""\n第二行"'));
});

test("Markdown and HTML escape user text and filenames cannot contain path separators", () => {
  const title = '<img src=x onerror=alert(1)>|\\*`\n# injected';
  const result = report(fixture([stage("a")], [issue("one", { title })]));
  const html = renderReport(result);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  const md = exportMarkdown(result);
  assert.ok(md.includes("\\|\\\\\\*\\` / \\# injected"));
  assert.doesNotMatch(filename(result, "csv"), /[<>:"/\\|?*]/);
  assert.match(filename(result, "csv"), /\.csv$/);
});

test("report branding appears only once at the top and titles stay focused on the report", () => {
  for (const mode of ['overview', 'handoff', 'todo']) {
    const result = report(fixture(), { mode });
    assert.doesNotMatch(result.title, /Bobo/);
    const html = renderReport(result);
    assert.equal((html.match(/Bobo/g) || []).length, 1);
    assert.match(html, /report-brand"><strong>Bobo<\/strong>/);
    assert.doesNotMatch(html, /<footer[^>]*>[\s\S]*Bobo/);
    assert.doesNotMatch(exportMarkdown(result).split('\n')[0], /Bobo/);
  }
});

test("manual Todos and risks export on empty reports without changing metrics, business data or baseline", () => {
  const data = fixture();
  const before = JSON.stringify(data);
  const initial = report(data, { mode: 'handoff', includeCompleted: false });
  const result = report(data, { mode: 'handoff', includeCompleted: false, manualTodos: '联系接收人\n补交会议记录', manualRisks: '接口时间待确认' });
  assert.deepEqual(result.metrics, initial.metrics);
  assert.deepEqual(result.todos, []);
  assert.deepEqual(result.risks, []);
  assert.deepEqual(createBaseline(result), createBaseline(initial));
  assert.equal(JSON.stringify(data), before);
  for (const output of [renderReport(result), exportMarkdown(result), exportCsv(result), exportHtml(result)]) {
    assert.match(output, /联系接收人/);
    assert.match(output, /补交会议记录/);
    assert.match(output, /接口时间待确认/);
    assert.match(output, /人工补充/);
  }
  assert.equal((renderReport(result).match(/data-manual-empty="manual(?:Todos|Risks)" hidden/g) || []).length, 2);
  assert.doesNotMatch(exportMarkdown(result), /暂无事项/);
  assert.match(exportMarkdown(result), /> 联系接收人\n> 补交会议记录/);
  assert.match(exportHtml(result), /textarea data-manual-field="manualTodos"/);
  assert.match(renderReport(result, { editable: true }), /aria-label="人工补充风险"/);
});

test("manual supplements stay separate from automatic rows and do not appear in unrelated sections", () => {
  const data = fixture([stage('a')], [issue('i')]);
  const base = report(data, { mode: 'handoff' });
  const result = report(data, { mode: 'handoff', manualTodos: '人工待办', manualRisks: '人工风险', baseline: createBaseline(base) });
  assert.equal(result.changes.new, 0);
  assert.equal(result.changes.existing, base.todos.length);
  assert.deepEqual(result.todos.map(rowKey), base.todos.map(rowKey));
  assert.doesNotMatch(exportMarkdown(report(data, { mode: 'overview', manualTodos: '不该出现', manualRisks: '概览风险' })), /不该出现/);
  assert.doesNotMatch(exportMarkdown(report(data, { mode: 'todo', manualTodos: '待办补充', manualRisks: '不该出现' })), /不该出现/);
  assert.match(exportMarkdown(result), /\*\*i\*\*/);
});

test("manual text escapes HTML/textarea terminators, preserves CSV cells and rejects overlong input", () => {
  const manualTodos = '=SUM(1,2)\n</textarea><script>alert(1)</script> "quoted"';
  const manualRisks = '@risk';
  const result = report(fixture(), { mode: 'handoff', manualTodos, manualRisks });
  const html = exportHtml(result);
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.doesNotMatch(html, /<script>alert|<img/);
  assert.match(html, /&lt;\/textarea&gt;/);
  const csv = exportCsv(result);
  assert.match(csv, /人工补充待办/);
  assert.match(csv, /"'=SUM\(1,2\)\n/);
  assert.match(csv, /"'@risk"/);
  assert.match(csv, /""quoted""/);
  const cells = [...csv.slice(1).matchAll(/"((?:[^"]|"")*)"(?:,|\r\n|$)/g)].map(match => match[1].replace(/""/g, '"'));
  assert.equal(cells.length % 2, 0);
  const width = cells.length / 2;
  assert.equal(cells[cells.indexOf('人工补充待办') + width], "'" + manualTodos);
  assert.equal(cells[cells.indexOf('人工补充风险') + width], "'" + manualRisks);
  assert.throws(() => report(fixture(), { mode: 'handoff', manualTodos: 'x'.repeat(10001) }), /10000/);
  assert.throws(() => report(fixture(), { mode: 'handoff', manualRisks: 'x'.repeat(10001) }), /10000/);
});
