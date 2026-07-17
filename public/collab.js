(() => {
  const dom = {
    authTitle: document.querySelector("#authTitle"),
    authDescription: document.querySelector("#authDescription"),
    authSubmit: document.querySelector("#authSubmit"),
    authError: document.querySelector("#authError"),
    displayNameField: document.querySelector("#displayNameField"),
    authDisplayName: document.querySelector("#authDisplayName"),
    authUsername: document.querySelector("#authUsername"),
    authPassword: document.querySelector("#authPassword"),
    appShell: document.querySelector("#appShell"),
    accountBtn: document.querySelector("#accountBtn"),
    accountMenu: document.querySelector("#accountMenu"),
    accountName: document.querySelector("#accountName"),
    accountInitial: document.querySelector("#accountInitial"),
    manageUsersBtn: document.querySelector("#manageUsersBtn"),
    changeAvatarBtn: document.querySelector("#changeAvatarBtn"),
    changePasswordBtn: document.querySelector("#changePasswordBtn"),
    logoutBtn: document.querySelector("#logoutBtn"),
    shutdownBtn: document.querySelector("#shutdownBtn"),
    syncNotice: document.querySelector("#syncNotice"),
    editorDialog: document.querySelector("#editorDialog"),
    editorTabs: document.querySelector("#editorTabs"),
    editorDetailsPanel: document.querySelector("#editorDetailsPanel"),
    editorIssuesPanel: document.querySelector("#editorIssuesPanel"),
    editorActions: document.querySelector(".editor-actions"),
    issueCount: document.querySelector("#issueCount"),
    issueList: document.querySelector("#issueList"),
    issueForm: document.querySelector("#issueForm"),
    issueEmpty: document.querySelector("#issueEmpty"),
    addIssueBtn: document.querySelector("#addIssueBtn"),
    deleteIssueBtn: document.querySelector("#deleteIssueBtn"),
    issueId: document.querySelector("#issueId"),
    issueVersion: document.querySelector("#issueVersion"),
    issueTitle: document.querySelector("#issueTitle"),
    issueDescription: document.querySelector("#issueDescription"),
    issueStatus: document.querySelector("#issueStatus"),
    issuePriority: document.querySelector("#issuePriority"),
    issueDueDate: document.querySelector("#issueDueDate"),
    issueFilterStatus: document.querySelector("#issueFilterStatus"),
    issueFilterPriority: document.querySelector("#issueFilterPriority"),
    issueFilterAssignee: document.querySelector("#issueFilterAssignee"),
    issueFilterOverdue: document.querySelector("#issueFilterOverdue"),
    issueAssignee: document.querySelector("#issueAssignee"),
    issueAudit: document.querySelector("#issueAudit"),
    issueCommentList: document.querySelector("#issueCommentList"),
    issueCommentInput: document.querySelector("#issueCommentInput"),
    addCommentBtn: document.querySelector("#addCommentBtn"),
    issueStateBadge: document.querySelector("#issueStateBadge"),
    issueCloseBtn: document.querySelector("#issueCloseBtn"),
    saveIssueBtn: document.querySelector("#saveIssueBtn"),
    closeUsersDialogBtn: document.querySelector("#closeUsersDialogBtn"),
    usersDialog: document.querySelector("#usersDialog"),
    conflictDialog: document.querySelector("#conflictDialog"),
    conflictDraft: document.querySelector("#conflictDraft"),
    conflictServer: document.querySelector("#conflictServer"),
    usersList: document.querySelector("#usersList"),
    userForm: document.querySelector("#userForm"),
    userFormTitle: document.querySelector("#userFormTitle"),
    managedUserId: document.querySelector("#managedUserId"),
    managedUsername: document.querySelector("#managedUsername"),
    managedDisplayName: document.querySelector("#managedDisplayName"),
    managedAvatar: document.querySelector("#managedAvatar"),
    managedRole: document.querySelector("#managedRole"),
    managedPassword: document.querySelector("#managedPassword"),
    managedPasswordField: document.querySelector("#managedPasswordField"),
    managedSystemsField: document.querySelector("#managedSystemsField"),
    managedSystems: document.querySelector("#managedSystems"),
    managedActive: document.querySelector("#managedActive"),
    managedActiveField: document.querySelector("#managedActiveField"),
    userFormError: document.querySelector("#userFormError"),
    newUserBtn: document.querySelector("#newUserBtn"),
    deleteManagedUserBtn: document.querySelector("#deleteManagedUserBtn"),
    deleteEditorBtn: document.querySelector("#deleteEditorBtn")
  };

  let currentUser = null;
  let users = [];
  let revision = 0;
  let stageContext = null;
  let onStateChanged = null;
  let onExternalChange = null;
  let pollTimer = 0;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && typeof options.body !== "string") {
      headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    const response = await fetch(url, { ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `请求失败（${response.status}）`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function showApp() {
    dom.appShell.hidden = false;
    dom.accountName.textContent = currentUser.displayName;
    dom.accountInitial.textContent = currentUser.avatarText;
    dom.manageUsersBtn.hidden = currentUser.role !== "admin";
    dom.changePasswordBtn.hidden = currentUser.role !== "admin";
    dom.shutdownBtn.hidden = currentUser.role !== "admin";
    dom.deleteEditorBtn.hidden = currentUser.role !== "admin";
  }

  async function loadBootstrap() {
    try {
      const payload = await api("/api/bootstrap");
      currentUser = payload.user;
      users = payload.users || [];
      revision = Number(payload.revision || 0);
      hydratePreferences(payload.state);
      showApp();
      window.scrollTo(0, 0);
      return payload;
    } catch (error) {
      if (error.status === 401) {
        location.replace("/login.html");
        return new Promise(() => {});
      }
      throw error;
    }
  }

  function preferenceKey() {
    return `bobo.preferences.${currentUser?.id || "anonymous"}`;
  }

  function hydratePreferences(nextState) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(preferenceKey()) || "{}"); } catch {}
    if (saved.selectedSystemId && nextState.systems.some((item) => item.id === saved.selectedSystemId)) {
      nextState.selectedSystemId = saved.selectedSystemId;
    }
    const activeSystem = nextState.systems.find((item) => item.id === nextState.selectedSystemId) || nextState.systems[0];
    if (saved.selectedProjectId && activeSystem?.projects.some((item) => item.id === saved.selectedProjectId)) {
      nextState.selectedProjectId = saved.selectedProjectId;
    }
    for (const system of nextState.systems) {
      for (const project of system.projects || []) {
        project.expanded = saved.expanded?.[project.id] ?? true;
        for (const requirement of project.requirements || []) {
          requirement.expanded = saved.expanded?.[requirement.id] ?? true;
        }
      }
    }
  }

  function savePreferences(state, view) {
    if (!currentUser || !state) return;
    const expanded = {};
    for (const system of state.systems || []) {
      for (const project of system.projects || []) {
        expanded[project.id] = project.expanded !== false;
        for (const requirement of project.requirements || []) expanded[requirement.id] = requirement.expanded !== false;
      }
    }
    localStorage.setItem(preferenceKey(), JSON.stringify({
      selectedSystemId: state.selectedSystemId,
      selectedProjectId: state.selectedProjectId,
      expanded,
      view: view || {}
    }));
  }

  async function saveState(state) {
    savePreferences(state);
    const payload = await api("/api/state", {
      method: "PUT",
      body: { state, revision }
    });
    revision = Number(payload.revision || revision);
    if (payload.state) {
      const selectedSystemId = state.selectedSystemId;
      const selectedProjectId = state.selectedProjectId;
      state.systems = payload.state.systems;
      state.systemsVersion = payload.state.systemsVersion;
      state.selectedSystemId = selectedSystemId;
      state.selectedProjectId = selectedProjectId;
      hydratePreferences(state);
    }
    return payload;
  }

  async function saveResource(state, url, options = {}) {
    const payload = await api(url, options);
    revision = Number(payload.revision || revision);
    if (payload.state && state) {
      const selectedSystemId = state.selectedSystemId;
      const selectedProjectId = state.selectedProjectId;
      state.systems = payload.state.systems;
      state.systemsVersion = payload.state.systemsVersion;
      state.selectedSystemId = selectedSystemId;
      state.selectedProjectId = selectedProjectId;
      hydratePreferences(state);
    }
    return payload;
  }

  function formatConflictValue(value) {
    return JSON.stringify(value || {}, null, 2);
  }

  function resolveConflict(error, draft) {
    if (!dom.conflictDialog || !error?.payload?.entity) return Promise.resolve("cancel");
    dom.conflictDraft.textContent = formatConflictValue(draft);
    dom.conflictServer.textContent = formatConflictValue(error.payload.entity);
    dom.conflictDialog.showModal();
    return new Promise((resolve) => {
      dom.conflictDialog.addEventListener("close", () => resolve(dom.conflictDialog.returnValue || "cancel"), { once: true });
    });
  }

  function isAdmin() {
    return currentUser?.role === "admin";
  }

  function userById(id) {
    return users.find((item) => item.id === id) || null;
  }

  function userName(id, empty = "未分配") {
    if (!id) return empty;
    const user = userById(id);
    if (!user) return "历史用户";
    return `${user.displayName}${user.deletedAt ? "（已删除）" : user.active ? "" : "（已停用）"}`;
  }

  function formatTime(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(new Date(value));
  }

  function localDateString(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function stageIssues() {
    if (!stageContext) return [];
    return (stageContext.project.issues || []).filter((issue) => issue.stageId === stageContext.stage.id);
  }

  function updateStageDerived() {
    if (!stageContext) return;
    const openIssues = stageIssues().filter((issue) => issue.status !== "closed");
    stageContext.stage.issueOpen = openIssues.length > 0;
    stageContext.stage.issues = openIssues.map((issue) => issue.description || issue.title).filter(Boolean).join("\n");
    dom.issueCount.textContent = String(openIssues.length);
  }

  function statusLabel(status) {
    return status === "closed" ? "已关闭" : status === "in_progress" ? "处理中" : "待处理";
  }

  function renderAssignees(selectedId) {
    const systemId = stageContext?.project?.systemId;
    const assignable = users.filter((item) => item.active && !item.deletedAt && (item.role === "admin" || item.systemIds?.includes(systemId)));
    const choices = [{ id: "", displayName: "未分配", active: true }, ...assignable];
    const selected = userById(selectedId);
    if (selected && (!selected.active || selected.deletedAt || !choices.some((item) => item.id === selected.id))) choices.push(selected);
    dom.issueAssignee.innerHTML = choices.map((user) =>
      `<option value="${escapeHtml(user.id)}" ${user.id === selectedId ? "selected" : ""}>${escapeHtml(user.id ? userName(user.id) : user.displayName)}</option>`
    ).join("");
  }

  function renderIssueFilters() {
    const previousAssignee = dom.issueFilterAssignee.value || "all";
    const systemId = stageContext?.project?.systemId;
    const relevantUsers = users.filter((user) => user.role === "admin" || user.systemIds?.includes(systemId) || stageIssues().some((issue) => issue.assigneeUserId === user.id));
    dom.issueFilterAssignee.innerHTML = `<option value="all">全部负责人</option>${relevantUsers.map((user) =>
      `<option value="${escapeHtml(user.id)}">${escapeHtml(userName(user.id))}</option>`
    ).join("")}`;
    dom.issueFilterAssignee.value = relevantUsers.some((user) => user.id === previousAssignee) ? previousAssignee : "all";
  }

  function renderIssueList(selectedId = dom.issueId.value) {
    updateStageDerived();
    const today = localDateString();
    const statusFilter = dom.issueFilterStatus?.value || "all";
    const priorityFilter = dom.issueFilterPriority?.value || "all";
    const assigneeFilter = dom.issueFilterAssignee?.value || "all";
    const overdueOnly = Boolean(dom.issueFilterOverdue?.checked);
    const issues = stageIssues().filter((issue) => {
      if (statusFilter !== "all" && issue.status !== statusFilter) return false;
      if (priorityFilter !== "all" && issue.priority !== priorityFilter) return false;
      if (assigneeFilter !== "all" && issue.assigneeUserId !== assigneeFilter) return false;
      if (overdueOnly && (issue.status === "closed" || !issue.dueDate || issue.dueDate >= today)) return false;
      return true;
    }).sort((a, b) => {
      if (a.status === "closed" && b.status !== "closed") return 1;
      if (a.status !== "closed" && b.status === "closed") return -1;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
    dom.issueList.innerHTML = issues.length ? issues.map((issue) => `
      <button type="button" class="issue-row ${issue.id === selectedId ? "selected" : ""}" data-issue-id="${escapeHtml(issue.id)}">
        <span class="issue-row-dot ${issue.status}"></span>
        <span class="issue-row-main"><strong>${escapeHtml(issue.title)}</strong><small>${escapeHtml(userName(issue.assigneeUserId))}</small></span>
        <span class="issue-row-status">${statusLabel(issue.status)}</span>
      </button>
    `).join("") : '<div class="issue-list-empty">当前阶段还没有问题。</div>';
    dom.issueList.querySelectorAll("[data-issue-id]").forEach((button) => {
      button.addEventListener("click", () => selectIssue(button.dataset.issueId));
    });
  }

  function selectIssue(issueId) {
    const issue = stageIssues().find((item) => item.id === issueId);
    if (!issue) return;
    dom.issueEmpty.hidden = true;
    dom.issueForm.hidden = false;
    dom.issueId.value = issue.id;
    dom.issueVersion.value = String(issue.version || 1);
    dom.issueTitle.value = issue.title;
    dom.issueDescription.value = issue.description || "";
    dom.issueStatus.value = issue.status === "in_progress" ? "in_progress" : "open";
    dom.issuePriority.value = issue.priority || "medium";
    dom.issueDueDate.value = issue.dueDate || "";
    dom.issueStatus.disabled = issue.status === "closed";
    renderAssignees(issue.assigneeUserId || "");
    dom.issueStateBadge.textContent = statusLabel(issue.status);
    dom.issueStateBadge.className = `issue-state-badge ${issue.status}`;
    dom.issueCloseBtn.textContent = issue.status === "closed" ? "重新打开" : "关闭问题";
    dom.deleteIssueBtn.hidden = !isAdmin();
    const audit = [
      `创建：${userName(issue.createdByUserId, "历史数据")} · ${formatTime(issue.createdAt)}`,
      `更新：${userName(issue.updatedByUserId, "历史数据")} · ${formatTime(issue.updatedAt)}`
    ];
    if (issue.status === "closed") {
      audit.push(issue.legacyClosureUnknown
        ? "关闭：历史数据，关闭信息未知"
        : `关闭：${userName(issue.closedByUserId, "未知用户")} · ${formatTime(issue.closedAt)}`);
    }
    dom.issueAudit.innerHTML = audit.map((line) => `<span>${escapeHtml(line)}</span>`).join("");
    renderComments(issue);
    renderIssueList(issue.id);
  }

  function renderComments(issue) {
    const comments = issue?.comments || [];
    dom.issueCommentList.innerHTML = comments.length ? comments.map((comment) => `
      <article class="issue-comment">
        <div><strong>${escapeHtml(userName(comment.authorUserId, "历史数据"))}</strong><time>${escapeHtml(formatTime(comment.createdAt))}</time></div>
        <p>${escapeHtml(comment.body)}</p>
      </article>
    `).join("") : '<p class="issue-comments-empty">暂无评论</p>';
  }

  function newIssue() {
    dom.issueEmpty.hidden = true;
    dom.issueForm.hidden = false;
    dom.issueId.value = "";
    dom.issueVersion.value = "0";
    dom.issueTitle.value = `待处理：${stageContext.stage.title}`;
    dom.issueDescription.value = "";
    dom.issueStatus.value = "open";
    dom.issuePriority.value = "medium";
    dom.issueDueDate.value = "";
    dom.issueStatus.disabled = false;
    renderAssignees("");
    dom.issueStateBadge.textContent = "新问题";
    dom.issueStateBadge.className = "issue-state-badge open";
    dom.issueAudit.innerHTML = "";
    dom.issueCloseBtn.textContent = "关闭问题";
    dom.issueCloseBtn.disabled = true;
    dom.deleteIssueBtn.hidden = true;
    renderComments({ comments: [] });
    renderIssueList("");
    dom.issueTitle.focus();
    dom.issueTitle.select();
  }

  async function mutateIssue(url, options, allowRetry = true) {
    let payload;
    try {
      const requestOptions = {
        ...options,
        body: options.body && typeof options.body === "object" ? { ...options.body } : options.body
      };
      payload = await api(url, requestOptions);
    } catch (error) {
      if (allowRetry && error.payload?.code === "VERSION_CONFLICT") {
        const choice = await resolveConflict(error, options.body);
        const issue = error.payload.entity;
        if (choice === "server" && issue) {
          revision = Number(error.payload.revision || revision);
          const index = stageContext.project.issues.findIndex((item) => item.id === issue.id);
          if (index >= 0) stageContext.project.issues[index] = issue;
          selectIssue(issue.id);
          onStateChanged?.();
          return null;
        }
        if (choice === "retry" && issue) {
          const retryOptions = { ...options, body: { ...(options.body || {}), version: issue.version } };
          return mutateIssue(url, retryOptions, false);
        }
      }
      throw error;
    }
    revision = Number(payload.revision || revision);
    const issues = stageContext.project.issues ||= [];
    if (payload.issue) {
      const index = issues.findIndex((item) => item.id === payload.issue.id);
      if (index >= 0) issues[index] = payload.issue;
      else issues.push(payload.issue);
      updateStageDerived();
      selectIssue(payload.issue.id);
      onStateChanged?.();
    }
    return payload;
  }

  dom.saveIssueBtn.addEventListener("click", async () => {
    try {
      const issueId = dom.issueId.value;
      const body = {
        stageId: stageContext.stage.id,
        title: dom.issueTitle.value,
        description: dom.issueDescription.value,
        status: dom.issueStatus.value,
        priority: dom.issuePriority.value,
        dueDate: dom.issueDueDate.value,
        assigneeUserId: dom.issueAssignee.value,
        version: Number(dom.issueVersion.value || 0)
      };
      if (issueId) {
        await mutateIssue(`/api/projects/${encodeURIComponent(stageContext.project.id)}/issues/${encodeURIComponent(issueId)}`, {
          method: "PATCH", body
        });
      } else {
        await mutateIssue(`/api/projects/${encodeURIComponent(stageContext.project.id)}/issues`, {
          method: "POST", body
        });
      }
      dom.issueCloseBtn.disabled = false;
    } catch (error) {
      alert(error.message);
    }
  });

  dom.issueCloseBtn.addEventListener("click", async () => {
    const issue = stageIssues().find((item) => item.id === dom.issueId.value);
    if (!issue) return;
    const action = issue.status === "closed" ? "reopen" : "close";
    try {
      await mutateIssue(`/api/projects/${encodeURIComponent(stageContext.project.id)}/issues/${encodeURIComponent(issue.id)}/${action}`, {
        method: "POST", body: { version: issue.version }
      });
    } catch (error) {
      alert(error.message);
    }
  });

  dom.deleteIssueBtn.addEventListener("click", async () => {
    const issue = stageIssues().find((item) => item.id === dom.issueId.value);
    if (!issue || !confirm(`确定删除问题“${issue.title}”吗？此操作无法撤销。`)) return;
    try {
      const url = `/api/projects/${encodeURIComponent(stageContext.project.id)}/issues/${encodeURIComponent(issue.id)}`;
      let payload;
      try {
        payload = await api(url, { method: "DELETE", body: { version: issue.version } });
      } catch (error) {
        if (error.payload?.code !== "VERSION_CONFLICT" || !error.payload.entity) throw error;
        const choice = await resolveConflict(error, { action: "delete", issue });
        if (choice === "server") {
          revision = Number(error.payload.revision || revision);
          const index = stageContext.project.issues.findIndex((item) => item.id === issue.id);
          if (index >= 0) stageContext.project.issues[index] = error.payload.entity;
          selectIssue(issue.id);
          onStateChanged?.();
          return;
        }
        if (choice !== "retry") return;
        payload = await api(url, { method: "DELETE", body: { version: error.payload.entity.version } });
      }
      revision = Number(payload.revision || revision);
      stageContext.project.issues = stageContext.project.issues.filter((item) => item.id !== issue.id);
      dom.issueForm.hidden = true;
      dom.issueEmpty.hidden = false;
      dom.issueId.value = "";
      updateStageDerived();
      renderIssueList();
      onStateChanged?.();
    } catch (error) {
      alert(error.message);
    }
  });

  dom.addIssueBtn.addEventListener("click", newIssue);

  dom.addCommentBtn.addEventListener("click", async () => {
    const issue = stageIssues().find((item) => item.id === dom.issueId.value);
    const body = dom.issueCommentInput.value.trim();
    if (!issue || !body) return;
    try {
      await mutateIssue(`/api/projects/${encodeURIComponent(stageContext.project.id)}/issues/${encodeURIComponent(issue.id)}/comments`, {
        method: "POST", body: { version: issue.version, body }
      });
      dom.issueCommentInput.value = "";
    } catch (error) {
      alert(error.message);
    }
  });

  [dom.issueFilterStatus, dom.issueFilterPriority, dom.issueFilterAssignee, dom.issueFilterOverdue]
    .filter(Boolean)
    .forEach((control) => control.addEventListener("change", () => renderIssueList()));

  function switchEditorTab(name) {
    dom.editorTabs.querySelectorAll(".editor-tab").forEach((button) => {
      button.classList.toggle("active", button.dataset.editorTab === name);
    });
    dom.editorDetailsPanel.hidden = name !== "details";
    dom.editorIssuesPanel.hidden = name !== "issues";
    dom.editorActions.hidden = name === "issues";
  }

  dom.editorTabs.querySelectorAll(".editor-tab").forEach((button) => {
    button.addEventListener("click", () => switchEditorTab(button.dataset.editorTab));
  });

  function openStageIssues(project, requirement, stage) {
    stageContext = { project, requirement, stage };
    dom.editorTabs.hidden = false;
    switchEditorTab("details");
    dom.issueForm.hidden = true;
    dom.issueEmpty.hidden = false;
    renderIssueFilters();
    updateStageDerived();
    renderIssueList();
  }

  function resetEditor(kind) {
    if (kind !== "stage") stageContext = null;
    dom.editorTabs.hidden = kind !== "stage";
    switchEditorTab("details");
    dom.deleteEditorBtn.hidden = !isAdmin();
  }

  function managedSystemIds() {
    return [...dom.managedSystems.querySelectorAll("input:checked")].map((input) => input.value);
  }

  function renderManagedSystems(selectedIds = []) {
    const selected = new Set(selectedIds);
    dom.managedSystems.innerHTML = (state.systems || []).map((system) => `
      <label><input type="checkbox" value="${escapeHtml(system.id)}" ${selected.has(system.id) ? "checked" : ""}>${escapeHtml(system.name)}</label>
    `).join("");
  }

  function updateRoleFields() {
    const admin = dom.managedRole.value === "admin";
    dom.managedPasswordField.hidden = !admin;
    dom.managedSystemsField.hidden = admin;
    dom.managedPassword.required = admin && !dom.managedUserId.value;
  }

  function resetUserForm() {
    dom.userForm.reset();
    dom.managedUserId.value = "";
    dom.managedUsername.disabled = false;
    dom.managedRole.value = "member";
    dom.managedActive.checked = true;
    dom.managedActiveField.hidden = true;
    dom.managedAvatar.value = "";
    dom.userFormTitle.textContent = "新增账户";
    dom.deleteManagedUserBtn.hidden = true;
    renderManagedSystems((state.systems || []).map((system) => system.id));
    updateRoleFields();
    dom.userFormError.hidden = true;
  }

  function fillUserForm(user) {
    if (!user) return;
    dom.managedUserId.value = user.id;
    dom.managedUsername.value = user.username;
    dom.managedUsername.disabled = true;
    dom.managedDisplayName.value = user.displayName;
    dom.managedAvatar.value = user.avatarText;
    dom.managedRole.value = user.role;
    dom.managedPassword.value = "";
    dom.managedActive.checked = user.active;
    dom.managedActiveField.hidden = false;
    dom.userFormTitle.textContent = `编辑 / ${user.displayName}`;
    dom.deleteManagedUserBtn.hidden = user.id === currentUser.id;
    renderManagedSystems(user.systemIds || []);
    updateRoleFields();
    dom.userFormError.hidden = true;
  }

  function systemSummary(user) {
    if (user.role === "admin") return "全部系统";
    const names = (state.systems || []).filter((system) => user.systemIds?.includes(system.id)).map((system) => system.name);
    return names.join("、") || "未关联系统";
  }

  function renderUsers() {
    const visibleUsers = users.filter((user) => !user.deletedAt);
    dom.usersList.innerHTML = visibleUsers.map((user) => `
      <button type="button" class="user-row" data-user-id="${escapeHtml(user.id)}">
        <span class="account-initial">${escapeHtml(user.avatarText)}</span>
        <span><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)} · ${escapeHtml(systemSummary(user))}</small></span>
        <span class="user-role">${user.role === "admin" ? "管理员" : "成员"}${user.active ? "" : " · 已停用"}</span>
      </button>
    `).join("");
    dom.usersList.querySelectorAll("[data-user-id]").forEach((button) => {
      button.addEventListener("click", () => fillUserForm(userById(button.dataset.userId)));
    });
  }

  dom.userForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    dom.userFormError.hidden = true;
    try {
      const id = dom.managedUserId.value;
      const body = {
        username: dom.managedUsername.value,
        displayName: dom.managedDisplayName.value,
        avatarText: dom.managedAvatar.value,
        role: dom.managedRole.value,
        password: dom.managedPassword.value,
        systemIds: managedSystemIds(),
        active: dom.managedActive.checked
      };
      const payload = await api(id ? `/api/users/${encodeURIComponent(id)}` : "/api/users", {
        method: id ? "PATCH" : "POST", body
      });
      const index = users.findIndex((item) => item.id === payload.user.id);
      if (index >= 0) users[index] = payload.user;
      else users.push(payload.user);
      revision = Number(payload.revision || revision);
      renderUsers();
      fillUserForm(payload.user);
    } catch (error) {
      dom.userFormError.textContent = error.message;
      dom.userFormError.hidden = false;
    }
  });

  dom.managedRole.addEventListener("change", updateRoleFields);
  dom.managedDisplayName.addEventListener("input", () => {
    if (!dom.managedAvatar.value) dom.managedAvatar.value = Array.from(dom.managedDisplayName.value.trim())[0] || "";
  });
  dom.deleteManagedUserBtn.addEventListener("click", async () => {
    const user = userById(dom.managedUserId.value);
    if (!user || !confirm(`确定删除账户「${user.displayName}」吗？历史问题和评论中的身份将继续保留。`)) return;
    try {
      const payload = await api(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      const index = users.findIndex((item) => item.id === payload.user.id);
      if (index >= 0) users[index] = payload.user;
      revision = Number(payload.revision || revision);
      renderUsers();
      resetUserForm();
    } catch (error) {
      dom.userFormError.textContent = error.message;
      dom.userFormError.hidden = false;
    }
  });

  dom.newUserBtn.addEventListener("click", resetUserForm);
  dom.closeUsersDialogBtn.addEventListener("click", () => dom.usersDialog.close());
  dom.manageUsersBtn.addEventListener("click", async () => {
    dom.accountMenu.hidden = true;
    try {
      const payload = await api("/api/users");
      users = payload.users || users;
      renderUsers();
      resetUserForm();
      dom.usersDialog.showModal();
    } catch (error) {
      alert(error.message);
    }
  });
  dom.changeAvatarBtn.addEventListener("click", async () => {
    dom.accountMenu.hidden = true;
    const avatarText = prompt("输入一个头像字", currentUser.avatarText);
    if (avatarText == null || avatarText === currentUser.avatarText) return;
    try {
      const payload = await api("/api/users/me/avatar", { method: "PATCH", body: { avatarText } });
      currentUser = payload.user;
      const index = users.findIndex((item) => item.id === currentUser.id);
      if (index >= 0) users[index] = currentUser;
      dom.accountInitial.textContent = currentUser.avatarText;
      revision = Number(payload.revision || revision);
    } catch (error) {
      alert(error.message);
    }
  });

  dom.changePasswordBtn.addEventListener("click", async () => {
    dom.accountMenu.hidden = true;
    const currentPassword = prompt("请输入当前密码");
    if (currentPassword == null) return;
    const nextPassword = prompt("请输入新密码（至少 4 位）");
    if (nextPassword == null) return;
    try {
      await api("/api/auth/password", { method: "POST", body: { currentPassword, nextPassword } });
      alert("密码已修改，请重新登录。");
      location.replace("/login.html");
    } catch (error) {
      alert(error.message);
    }
  });

  dom.logoutBtn.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.replace("/login.html");
  });

  dom.accountBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    dom.accountMenu.hidden = !dom.accountMenu.hidden;
    dom.accountBtn.setAttribute("aria-expanded", String(!dom.accountMenu.hidden));
  });

  document.addEventListener("click", (event) => {
    if (!dom.accountMenu.contains(event.target) && event.target !== dom.accountBtn) {
      dom.accountMenu.hidden = true;
      dom.accountBtn.setAttribute("aria-expanded", "false");
    }
  });

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = window.setInterval(async () => {
      if (!currentUser) return;
      try {
        const meta = await api("/api/revision");
        if (Number(meta.revision) === revision) return;
        if (dom.editorDialog.open || dom.usersDialog.open) {
          dom.syncNotice.hidden = false;
          dom.syncNotice.textContent = "有其他用户更新了数据，关闭弹窗后刷新";
          return;
        }
        revision = Number(meta.revision);
        dom.syncNotice.hidden = true;
        await onExternalChange?.();
      } catch (error) {
        if (error.status === 401) location.replace("/login.html");
      }
    }, 5000);
  }

  function configure(callbacks = {}) {
    onStateChanged = callbacks.onStateChanged || null;
    onExternalChange = callbacks.onExternalChange || null;
    startPolling();
  }

  window.addEventListener("beforeunload", () => {
    try {
      if (typeof state !== "undefined" && typeof view !== "undefined") savePreferences(state, view);
    } catch {}
  });

  window.BoboCollab = {
    loadBootstrap,
    saveState,
    saveResource,
    resolveConflict,
    savePreferences,
    configure,
    openStageIssues,
    resetEditor,
    isAdmin,
    getCurrentUser: () => currentUser,
    getUsers: () => users,
    getRevision: () => revision
  };
})();
