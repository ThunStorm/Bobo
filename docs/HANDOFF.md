# Bobo 多用户与数据拆分交接记录

更新日期：2026-07-14
分支：dev
仓库：git@github.com:ThunStorm/Bobo.git

## 当前状态

本轮已经把 Bobo 从单一 `data/projects.json` 迁移到多文件 JSON 结构，并接入局域网多用户登录、账户权限、问题分配与关闭审计。项目仍保持零前端框架、零数据库的 Node.js 本地文件方案，适合可信内网小团队使用。

新的运行数据布局如下：

```text
data/
├─ meta.json
├─ systems.json
├─ users.example.json
└─ projects/
   └─ <project-id>/
      ├─ project.json
      └─ issues.json
```

运行时账户文件为 `data/users.json`，已加入 `.gitignore`，不会提交。旧版 `data/projects.json` 在首次启动新版服务时会被备份到 `data/backups/`，并改名为 `data/projects.json.migrated`，这两个路径也已忽略。

## 已完成内容

- 数据拆分：系统索引、项目详情、项目问题、账户示例分别独立存储。
- 兼容迁移：旧数据启动时自动迁移，迁移后实体数量已核对：2 个系统、3 个项目、5 个需求、28 个阶段。
- 账户系统：支持首次管理员初始化、登录、退出、修改密码、管理员创建/编辑成员、启用/停用、最后管理员保护。
- 权限控制：成员可以查看和处理问题；结构性删除通过服务端限制为管理员。
- 问题系统：阶段弹窗新增“待处理问题”页签，支持标题、描述、状态、负责人、创建/更新/关闭审计。
- 问题状态：阶段红点/绿点由该阶段是否存在未关闭问题派生，不再依赖旧的 `issueOpen` 布尔字段。
- 新建未来阶段：服务端保存时会自动生成开放问题 `待处理：<阶段名称>`。
- 多人协作：前端每 5 秒检查 revision；无编辑弹窗时自动刷新，有编辑弹窗时提示外部更新。
- 文档：README 已更新数据目录、启动、账户、权限、迁移、备份和内网访问说明。

## 验证记录

已通过：

```text
node --check server.js
node --check public/app.js
node --check public/collab.js
node --check lib/data-store.js
node --check lib/auth.js
npm test
node --test: 4 passed
```

`npm test` 在普通沙箱下曾因 Windows 用户目录 npm 缓存权限报 `EPERM`，使用提升权限重跑后通过。该失败与代码逻辑无关。

`git diff --check` 通过，仅有 Windows 环境下 LF/CRLF 提示。

## 当前已知问题与风险

1. Codex 内置浏览器端到端验收未完整完成。
   - 服务已在 `http://localhost:4177/` 启动过，并确认 `/api/auth/status` 返回不再需要初始化。
   - 由于任务中断，尚未完成浏览器内的管理员登录、成员切换、问题分配、关闭/重新打开的完整截图验收。

2. 当前本机运行态已有管理员账号 `admin01`。
   - 密码不在仓库中，也不应写入文档。
   - 曾尝试通过脚本重置测试密码，但两次都在调用错误的方法前失败，没有完成写入。
   - 接手时如果不知道密码，可删除本机 `data/users.json` 重新初始化管理员，或用 `lib/auth.js` 的 `updateUser` 正确重置。

3. 资源级接口第一版重点覆盖问题 API。
   - 系统、项目、需求、阶段仍主要通过兼容的 `/api/state` 保存整份业务状态。
   - 服务端已经用 revision 和删除权限检查降低多人覆盖风险，但还不是每类实体都拥有完整 REST 资源接口。

4. 并发冲突 UX 仍偏轻量。
   - 服务端支持 revision/version 冲突。
   - 前端当前主要表现为保存失败提示和外部更新提示，尚未做字段级合并或冲突对比界面。

5. 账户安全按“可信内网”设计。
   - 密码使用 scrypt 哈希，不保存明文。
   - 没有 HTTPS、项目级权限、验证码、审计日志导出或外网防护。

6. 迁移后的 `data/projects.json` 会从 Git 中删除。
   - 这是预期行为，仓库改为提交拆分后的 `data/meta.json`、`data/systems.json` 和 `data/projects/**`。
   - `data/users.json`、`data/backups/`、`data/projects.json.migrated` 不提交。

## 接手建议

1. 先运行：

```powershell
npm test
node --check server.js
node --check public/app.js
node --check public/collab.js
```

2. 启动服务：

```powershell
node server.js --no-open
```

3. 打开：

```text
http://localhost:4177/
```

4. 如果没有可用管理员密码，处理方式二选一：

```powershell
Remove-Item -LiteralPath data/users.json
node server.js --no-open
```

然后重新在浏览器中初始化管理员。只在本机运行态这样操作，不要提交 `data/users.json`。

5. 建议补充的下一轮工作：

- 为系统、项目、需求、阶段补齐真正的资源级 API，逐步减少 `/api/state` 整体保存。
- 完成浏览器自动化或人工截图验收，覆盖管理员和成员两种角色。
- 给问题增加优先级、评论、截止时间和筛选视图。
- 给账号管理页增加更明确的停用历史负责人展示。
- 增加结构性删除的 HTTP 层测试。

## 推送范围

本次应提交的主要文件：

- `lib/data-store.js`
- `lib/auth.js`
- `server.js`
- `public/collab.js`
- `public/app.js`
- `public/index.html`
- `public/styles.css`
- `test/multiuser.test.js`
- `README.md`
- `docs/HANDOFF.md`
- `package.json`
- `.gitignore`
- `data/meta.json`
- `data/systems.json`
- `data/projects/**`
- `data/users.example.json`

不要提交：

- `data/users.json`
- `data/backups/**`
- `data/projects.json.migrated`
- `.tmp-*` 或测试运行目录
