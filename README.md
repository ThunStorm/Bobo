# Bobo

Bobo 是一个运行在 Windows 和可信局域网内的轻量甘特图项目管理工具。业务结构为“系统 -> 项目 -> 需求 -> 阶段”，阶段下可以维护问题、负责人、优先级、截止日期和追加式评论。

## 技术边界

本项目刻意保持简单：

- 前端仅使用原生 HTML、CSS 和 JavaScript。
- 服务端仅使用 Node.js 内置模块。
- 不使用第三方运行时依赖、前端框架、数据库或构建步骤。
- 数据保存在本机 JSON 文件中，适合可信内网小团队，不面向公网部署。

后续开发不得在未形成明确架构决策、同步更新 README 与 `docs/HANDOFF.md` 的情况下引入框架、数据库、包管理依赖或构建工具。

## 启动

需要 Windows 和 Node.js 18 或更高版本。

```powershell
npm start
```

只启动服务、不自动打开浏览器：

```powershell
npm run start:no-open
```

默认地址为 [http://localhost:4177/](http://localhost:4177/)。服务默认监听局域网网卡，并在终端输出可访问地址；需要在 Windows 防火墙中允许 Node.js 的专用网络访问。

## 账户与权限

首次访问时创建首位管理员。账户保存在运行时文件 `data/users.json`，密码使用 Node.js `scrypt` 哈希保存，该文件已被 Git 忽略。

- 管理员：管理账户，新增和编辑业务内容，删除系统、项目、需求、阶段和问题，在本机关闭服务。
- 成员：查看、新增和编辑业务内容，创建、分配、更新、关闭或重新打开问题；不能执行结构性删除。
- 账户只能停用，不能物理删除，以保留问题负责人、评论作者和关闭记录。
- 会话使用局域网 HTTP Cookie，服务重启或会话过期后需要重新登录。

## 数据结构

```text
data/
├─ meta.json                       # schema 版本和全局 revision
├─ systems.json                    # 系统、系统日期标记、项目顺序和系统版本
├─ users.json                      # 运行时账户，Git 已忽略
├─ users.example.json              # 无凭据示例
└─ projects/
   └─ <project-id>/
      ├─ project.json              # 项目、需求、阶段、标记及实体版本
      └─ issues.json               # 问题、评论及问题版本
```

选中项目、折叠状态、日期范围和栏位宽度等纯界面状态按账户保存到浏览器 `localStorage`，不会改变共享业务数据。

旧版 `data/projects.json` 会在首次启动时自动迁移。原文件先备份到 `data/backups/`，再改名为 `projects.json.migrated`；备份、迁移文件和账户文件均不参与 Git。

## 问题与阶段

双击甘特阶段条可以打开阶段详情与待处理问题页签。未来日期的新阶段会由服务端自动创建一条未分配的“待处理：阶段名称”问题。

每条问题包含：

- 标题、描述和状态：待处理、处理中、已关闭。
- 优先级：低、中、高、紧急；默认中等。
- 可选截止日期；筛选器可以只显示已逾期且仍开放的问题。
- 单一负责人；停用账户仍以“已停用”标识保留在历史问题中。
- 创建、更新、关闭和重新打开的操作者与时间。
- 追加式评论，记录作者和时间；评论一经提交不支持编辑或删除。

问题列表的状态、优先级、负责人和逾期筛选只作用于当前阶段，不改变共享数据。阶段行红点表示存在未关闭问题，绿点表示当前没有未关闭问题。

## 多人协作与冲突

- `data/meta.json` 的全局 `revision` 用于每 5 秒轮询是否存在外部更新。
- 系统、项目、需求、阶段和问题各自带 `version`，资源接口按实体版本阻止覆盖同一实体的并发修改。
- 兼容接口 `PUT /api/state` 继续使用全局 revision，主要作为顶部“保存”按钮的手动兜底。
- 发生实体版本冲突时，前端保留当前草稿，并显示服务器版本；用户可以加载服务器版本或基于最新版本重试本地草稿。
- 编辑弹窗打开时发现外部更新，只提示而不覆盖当前输入。

## 资源接口

登录后可使用以下资源接口。系统、项目、需求和阶段写操作返回当前规范化 `state`，前端据此同步实体版本；问题写操作返回更新后的 `issue` 和全局 `revision`。

```text
GET, POST                 /api/systems
GET, PATCH, DELETE        /api/systems/:systemId
GET, POST                 /api/systems/:systemId/projects
GET, PATCH, DELETE        /api/projects/:projectId
POST                      /api/projects/:projectId/requirements
PATCH, DELETE             /api/projects/:projectId/requirements/:requirementId
POST                      /api/projects/:projectId/requirements/:requirementId/stages
PATCH, DELETE             /api/projects/:projectId/requirements/:requirementId/stages/:stageId
POST                      /api/projects/:projectId/issues
PATCH, DELETE             /api/projects/:projectId/issues/:issueId
POST                      /api/projects/:projectId/issues/:issueId/comments
```

结构性删除和问题删除需要管理员权限。删除项目、需求或阶段时，对应的下级数据与阶段问题由服务端级联清理。

## 开发与验证

```powershell
node --test
node --check server.js
node --check lib/data-store.js
node --check public/app.js
node --check public/collab.js
git diff --check
```

浏览器验收应使用独立的 `BOBO_DATA_DIR` 和临时端口，避免修改真实运行数据。至少覆盖：管理员初始化、创建成员、资源新增/编辑、成员结构删除被拒绝、问题分配/筛选/评论/关闭/重新打开、停用历史负责人显示、并发冲突选择。

## 开发约定

完成较大功能、模块、重大缺陷或业务逻辑修复后：

1. 更新 README 和交接文档，说明数据、权限、接口和未完成验证。
2. 运行与变更风险匹配的检查和测试。
3. 提交到 Git，commit message 清楚描述本次业务变化。
4. 不提交 `data/users.json`、备份目录、迁移文件、临时测试目录或本机运行时数据变化。

## TODO

- 在右上角增加统一删除入口，并规划系统、项目、需求、阶段、问题等实体的全局删除逻辑与权限提示。
- 可信内网之外的部署需要另行规划 HTTPS、细粒度项目权限、审计导出和安全加固。
