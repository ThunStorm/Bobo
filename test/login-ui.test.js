const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const loginHtml = fs.readFileSync(path.join(root, "public", "login.html"), "utf8");
const indexHtml = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
const loginJs = fs.readFileSync(path.join(root, "public", "login.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "public", "styles.css"), "utf8");

test("login choices are grouped by system with a compact native disclosure", () => {
  assert.match(loginJs, /<details class="login-group"/);
  assert.match(loginJs, /user\.systemIds\?\.includes\(system\.id\)/);
  assert.match(loginJs, /name: "管理员"/);
  assert.match(styles, /\.login-group summary/);
});

test("product copy and theme use restrained red without recoloring gantt bars", () => {
  assert.match(loginHtml, /轻量项目管理系统/);
  assert.match(indexHtml, /轻量项目管理系统/);
  assert.match(styles, /--accent: #b4232d/);
  assert.match(styles, /--stage-gray: #98a2b3/);
  assert.match(styles, /--blue: #2f6fed/);
  assert.match(styles, /--green: #2f8f5b/);
});
