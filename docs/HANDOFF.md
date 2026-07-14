# Bobo 开发交接记录

更新日期：2026-07-14  
分支：`dev`  
仓库：`git@github.com:ThunStorm/Bobo.git`

## 当前架构

Bobo 是可信局域网内使用的本地 Node.js 应用，数据按系统、项目和问题拆分为 JSON 文件。多人协作采用“全局 revision 轮询 + 实体 version 写入校验”。

必须保留的架构边界：

- 原生 HTML、CSS、JavaScript 前端。
- Node.js 内置模块服务端。
- 无第三方运行时依赖、无前端框架、无数据库、无构建步骤。
- 不应仅为简化单个功能而引入 npm 包。确需改变上述边界时，先形成架构决策，并同时更新 README 与本文件。

运行数据：

```text
data/
├─ meta.json
├─ systems.json
├─ users.json              # 运行时账户，禁止提交
├─ users.example.json
└─ projects/
   └─ <project-id>/
      ├─ project.json
      └─ issues.json
```

## 本轮实现

### 资源 API

系统、项目、需求和阶段已从整份 `/api/state` 保存迁移到资源级写接口：

```text
GET, POST                 /api/systems
GET, PATCH, DELETE        /api/systems/:systemId
GET, POST                 /api/systems/:systemId/projects
GET, PATCH, DELETE        /api/projects/:projectId
POST                      /api/projects/:projectId/requirements
PATCH, DELETE             /api/projects/:projectId/requirements/:requirementId
POST                      /api/projects/:projectId/requirements/:requirementId/stages
PATCH, DELETE             /api/projects/:projectId/requirements/:requirementId/stages/:stageId
POST                      /api/projects/:projectId/issues/:issueId/comments
```

系统、项目、需求和阶段写接口返回服务端规范化后的完整 `state`，前端使用该状态更新实体版本。问题写接口返回更新后的 `issue` 与全局 `revision`。系统、项目、需求、阶段和问题均采用实体 `version`；`meta.json` 的全局 `revision` 只负责轮询和兼容 `/api/state`。

父子结构写入使用对应版本字段：`systemsVersion`、`systemVersion`、`projectVersion`、`requirementVersion`、`version`。冲突响应包含 `versionField` 和服务器实体，避免删除等操作同时携带父子版本时重试错字段。

### 问题增强

- 优先级：`low`、`medium`、`high`、`urgent`，旧数据默认 `medium`。
- 可选截止日期 `dueDate`。
- 评论保存在问题 `comments` 数组中，字段包含作者、正文和创建时间。
- 评论只允许追加，不提供编辑或删除接口。
- 当前阶段问题列表支持状态、优先级、负责人和逾期筛选。
- 停用用户继续显示在历史负责人和评论作者中，并带“已停用”标识。
- 未来阶段继续由服务端自动创建未分配开放问题。

### 冲突体验

资源写入收到 `VERSION_CONFLICT` 后，界面保留本地草稿并显示服务器实体。用户可选择加载服务器版本，或将本地草稿基于服务器最新实体版本重试一次。问题编辑沿用同一策略。

### 权限与删除

- 管理员可以删除系统、项目、需求、阶段和问题。
- 成员可以新增和编辑结构、处理问题，但结构性删除返回 `403`。
- 删除项目会删除项目目录；删除需求或阶段会同步清理失去对应阶段的问题。
- 系统仍只允许在为空时删除，并且至少保留一个系统。

### 兼容性

- 顶部“保存”仍调用 `PUT /api/state`，作为手动兜底，并使用全局 revision 防覆盖。
- 兼容保存只写结构数据，不接受客户端覆盖 `issues`；问题、评论和审计字段只能通过问题资源接口修改。
- 手动保存会保留并递增 `systems.json` 根版本，避免后续资源写入使用过期系统索引版本。
- 旧问题缺少优先级、截止日期或评论时会在读取阶段规范化，不需要一次性破坏性迁移。

## 本轮自动化覆盖

新增 `test/resource-api.test.js`，覆盖：

- 系统读取，以及项目、需求、阶段的资源新增与修改。
- 实体版本冲突返回 `409 VERSION_CONFLICT`。
- 未来阶段自动生成问题。
- 问题优先级、截止日期、负责人和追加评论。
- 成员删除阶段被拒绝、管理员删除成功。
- 重复阶段 ID 排序被拒绝，避免阶段和问题被意外清理。
- 问题写入/删除缺少版本时被拒绝。
- 兼容 `/api/state` 保存不能覆盖或删除已有评论。

## 尚未执行的验证

按本轮用户指示，浏览器端到端验收和最终测试在提交前暂时跳过。后续 agent 必须在发布或合并前补做以下步骤，并把结果追加到本文件：

1. 使用独立目录和端口启动服务，例如设置 `BOBO_DATA_DIR` 和 `PORT=4198`，不得使用真实 `data/users.json`。
2. 在浏览器初始化临时管理员，创建一个成员账户。
3. 管理员创建系统/项目/需求/阶段，刷新后确认实体和顺序保持。
4. 成员登录后新增和编辑结构，确认删除项目/需求/阶段返回权限提示。
5. 在阶段问题页填写优先级、截止日期、负责人和评论，验证状态/优先级/负责人/逾期筛选。
6. 关闭并重新打开问题，确认操作者和时间由服务端记录。
7. 管理员停用历史负责人，确认旧问题和评论仍显示该用户并标注“已停用”。
8. 用两个会话同时编辑同一实体，确认冲突对话框保留本地草稿，并分别验证“加载服务器版本”和“保留草稿并重试”。
9. 管理员删除阶段、需求和项目，确认下级实体和对应问题已级联清理。
10. 完成后停止隔离服务并删除临时数据目录。

还需运行：

```powershell
node --test
node --check server.js
node --check lib/data-store.js
node --check public/app.js
node --check public/collab.js
git diff --check
```

本轮浏览器验收曾连接 `http://localhost:4198/`，完成临时管理员和成员创建，并打开阶段详情；随后按用户指示停止。该隔离实例中通过 PowerShell 预置中文数据时出现终端编码导致的 `?` 名称，因此不能作为最终 UI 验收记录，应重新使用浏览器表单或 UTF-8 请求体完成上述流程。

## 已知风险

- 当前安全模型仅适用于可信局域网：没有 HTTPS、验证码、外网防护、项目级权限或审计日志导出。
- JSON 文件写入为单机模型，不适合多进程共享目录或高并发场景。
- 冲突处理是实体级整体比较和重试，不提供字段级合并。
- 项目新增等少数流程仍使用浏览器原生 `prompt`，自动化验收时需要显式处理 JavaScript 对话框。
- `/api/state` 仅为兼容和手动兜底，新功能应优先使用资源 API，避免重新扩大整份状态写入范围。

## Git 与运行数据

可以提交代码、文档和测试；禁止提交：

- `data/users.json`
- `data/backups/**`
- `data/projects.json.migrated`
- 隔离测试目录、日志、缓存和临时账号
- 仅因本机运行产生、与功能无关的业务数据变化

较大功能、模块、重大缺陷或逻辑修复完成后，应更新 README 和本文件，运行验证，并使用描述业务变化的 commit message 提交。

## 后续 TODO

- 完成本文件“尚未执行的验证”全部步骤。
- 在右上角增加统一删除入口，并规划系统、项目、需求、阶段、问题的全局删除逻辑、级联关系、权限和二次确认。
- 评估是否将仍使用原生 `prompt` 的新增/改名流程迁移为可访问、可自动化的应用内对话框。
- 若需要突破可信内网使用范围，先设计 HTTPS、细粒度权限和审计方案。
