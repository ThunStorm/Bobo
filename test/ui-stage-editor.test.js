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
