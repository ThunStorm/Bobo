const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

test("stage editor has one validation-free close control and owner suggestions", () => {
  const editor = html.slice(html.indexOf('<dialog id="editorDialog"'), html.indexOf('<dialog id="usersDialog"'));
  assert.match(editor, /id="closeEditorBtn"[^>]+type="button"/);
  assert.doesNotMatch(editor, /value="cancel"/);
  assert.match(editor, /id="editOwner"[^>]+list="editOwnerOptions"/);
  assert.match(editor, /<datalist id="editOwnerOptions"><\/datalist>/);
});

test("new and edited custom stages persist their title as the type", () => {
  assert.match(app, /const CUSTOM_STAGE_TYPE = "__custom__"/);
  assert.match(app, /nextType = selectedType === CUSTOM_STAGE_TYPE \? value : selectedType/);
  assert.match(app, /createStage\("新阶段", "新阶段"/);
  assert.match(app, /createStage\("新任务", "新任务"/);
  assert.match(app, /isCustomStageType\(value\) \? value/);
});

test("new requirements submit five editable default stages and dates without requesting automatic issues", async () => {
  const vm = require("node:vm");
  const start = app.indexOf("async function addRequirement(project) {");
  const end = app.indexOf("\nasync function deleteRequirement(", start);
  const types = ["需求澄清", "工作量及商务", "功能开发", "技术测试", "业务测试"];
  let submitted;
  const context = vm.createContext({
    STAGE_TYPES: types,
    prompt: () => "新需求",
    formatDate: () => "2026-11-02",
    addDays: (date, offset) => new Date(Date.parse(date + "T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10),
    commitResource: async (url, body) => { submitted = JSON.parse(JSON.stringify({ url, body })); return null; }
  });
  vm.runInContext(app.slice(start, end), context);
  await context.addRequirement({ id: "p", name: "项目", version: 3 });
  assert.equal(submitted.url, "/api/projects/p/requirements");
  assert.equal(submitted.body.projectVersion, 3);
  assert.equal(submitted.body.title, "新需求");
  assert.deepEqual(submitted.body.stages.map(stage => stage.type), types);
  assert.deepEqual(submitted.body.stages.map(stage => [stage.start, stage.end]), [
    ["2026-11-02", "2026-11-03"], ["2026-11-04", "2026-11-05"], ["2026-11-06", "2026-11-07"], ["2026-11-08", "2026-11-09"], ["2026-11-10", "2026-11-11"]
  ]);
  assert.ok(submitted.body.stages.every(stage => stage.title === stage.type && stage.status === "未开始" && !stage.issueOpen));
});
