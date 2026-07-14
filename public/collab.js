(() => {
  const dom = {
    authScreen: document.querySelector("#authScreen"),
    authForm: document.querySelector("#authForm"),
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
    issueAssignee: document.querySelector("#issueAssignee"),
    issueAudit: document.querySelector("#issueAudit"),
    issueStateBadge: document.querySelector("#issueStateBadge"),
    issueCloseBtn: document.querySelector("#issueCloseBtn"),
    saveIssueBtn: document.querySelector("#saveIssueBtn"),
    closeUsersDialogBtn: document.querySelector("#closeUsersDialogBtn"),
    usersDialog: document.querySelector("#usersDialog"),
    usersList: document.querySelector("#usersList"),
    userForm: document.querySelector("#userForm"),
    userFormTitle: document.querySelector("#userFormTitle"),
    managedUserId: document.querySelector("#managedUserId"),
    managedUsername: document.querySelector("#managedUsername"),
    managedDisplayName: document.querySelector("#managedDisplayName"),
    managedRole: document.querySelector("#managedRole"),
    managedPassword: document.querySelector("#managedPassword"),
    managedActive: document.querySelector("#managedActive"),
    managedActiveField: document.querySelector("#managedActiveField"),
    userFormError: document.querySelector("#userFormError"),
    newUserBtn: document.querySelector("#newUserBtn"),
    deleteEditorBtn: document.querySelector("#deleteEditorBtn")
  };

  let currentUser = null;
  let users = [];
  let revision = 0;
  let needsSetup = false;
  let authWaiter = null;
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

  function showAuth(setup) {
    needsSetup = Boolean(setup);
    document.body.classList.add("auth-pending");
    dom.appShell.hidden = true;
    dom.authScreen.hidden = false;
    dom.displayNameField.hidden = !needsSetup;
    dom.authTitle.textContent = needsSetup ? "创建首位管理员" : "登录 Bobo";
    dom.authDescription.textContent = needsSetup
      ? "设置局域网工作区的管理员账户。完成后可继续创建团队成员。"
      : "使用团队账户继续。";
    dom.authSubmit.textContent = needsSetup ? "创建并进入" : "登录";
    dom.authPassword.autocomplete = needsSetup ? "new-password" : "current-password";
    dom.authError.hidden = true;
    dom.authUsername.focus();
    return new Promise((resolve) => { authWaiter = resolve; });
  }

  function showApp() {
    document.body.classList.remove("auth-pending");
    dom.authScreen.hidden = true;
    dom.appShell.hidden = false;
    dom.accountName.textContent = currentUser.displayName;
    dom.accountInitial.textContent = currentUser.displayName.slice(0, 1).toUpperCase();
    dom.manageUsersBtn.hidden = currentUser.role !== "admin";
    dom.shutdownBtn.hidden = currentUser.role !== "admin";
    dom.deleteEditorBtn.hidden = currentUser.role !== "admin";
  }

  dom.authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    dom.authError.hidden = true;
    dom.authSubmit.disabled = true;
    try {
      const body = {
        username: dom.authUsername.value,
        password: dom.authPassword.value,
        displayName: dom.authDisplayName.value
      };
      const endpoint = needsSetup ? "/api/auth/setup" : "/api/auth/login";
      await api(endpoint, { method: "POST", body });
      dom.authPassword.value = "";
      authWaiter?.();
      authWaiter = null;
    } catch (error) {
      dom.authError.textContent = error.message;
      dom.authError.hidden = false;
    } finally {
      dom.authSubmit.disabled = false;
    }
  });

  async function loadBootstrap() {
    while (true) {
      try {
        const payload = await api("/api/bootstrap");
        currentUser = payload.user;
        users = payload.users || [];
        revision = Number(payload.revision || 0);
        hydratePreferences(payload.state);
        showApp();
        return payload;
      } catch (error) {
        if (error.status !== 401) throw error;
        await showAuth(error.payload?.needsSetup);
      }
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
      state.selectedSystemId = selectedSystemId;
      state.selectedProjectId = selectedProjectId;
      hydratePreferences(state);
    }
    return payload;
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
    return `${user.displayName}${user.active ? "" : "（已停用）"}`;
  }

  function formatTime(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
    }).format(new Date(value));
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
    const choices = [{ id: "", displayName: "未分配", active: true }, ...users.filter((item) => item.active)];
    const selected = userById(selectedId);
    if (selected && !selected.active) choices.push(selected);
    dom.issueAssignee.innerHTML = choices.map((user) =>
      `<option value="${escapeHtml(user.id)}" ${user.id === selectedId ? "selected" : ""}>${escapeHtml(user.id ? userName(user.id) : user.displayName)}</option>`
    ).join("");
  }

  function renderIssueList(selectedId = dom.issueId.value) {
    updateStageDerived();
    const issues = stageIssues().sort((a, b) => {
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
    renderIssueList(issue.id);
  }

  function newIssue() {
    dom.issueEmpty.hidden = true;
    dom.issueForm.hidden = false;
    dom.issueId.value = "";
    dom.issueVersion.value = "0";
    dom.issueTitle.value = `待处理：${stageContext.stage.title}`;
    dom.issueDescription.value = "";
    dom.issueStatus.value = "open";
    dom.issueStatus.disabled = false;
    renderAssignees("");
    dom.issueStateBadge.textContent = "新问题";
    dom.issueStateBadge.className = "issue-state-badge open";
    dom.issueAudit.innerHTML = "";
    dom.issueCloseBtn.textContent = "关闭问题";
    dom.issueCloseBtn.disabled = true;
    dom.deleteIssueBtn.hidden = true;
    renderIssueList("");
    dom.issueTitle.focus();
    dom.issueTitle.select();
  }

  async function mutateIssue(url, options) {
    const payload = await api(url, options);
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
      const payload = await api(`/api/projects/${encodeURIComponent(stageContext.project.id)}/issues/${encodeURIComponent(issue.id)}`, { method: "DELETE" });
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
    updateStageDerived();
    renderIssueList();
  }

  function resetEditor(kind) {
    if (kind !== "stage") stageContext = null;
    dom.editorTabs.hidden = kind !== "stage";
    switchEditorTab("details");
    dom.deleteEditorBtn.hidden = !isAdmin();
  }

  function resetUserForm() {
    dom.userForm.reset();
    dom.managedUserId.value = "";
    dom.managedUsername.disabled = false;
    dom.managedActive.checked = true;
    dom.managedActiveField.hidden = true;
    dom.userFormTitle.textContent = "新增账户";
    dom.userFormError.hidden = true;
  }

  function fillUserForm(user) {
    dom.managedUserId.value = user.id;
    dom.managedUsername.value = user.username;
    dom.managedUsername.disabled = true;
    dom.managedDisplayName.value = user.displayName;
    dom.managedRole.value = user.role;
    dom.managedPassword.value = "";
    dom.managedActive.checked = user.active;
    dom.managedActiveField.hidden = false;
    dom.userFormTitle.textContent = `编辑 / ${user.displayName}`;
    dom.userFormError.hidden = true;
  }

  function renderUsers() {
    dom.usersList.innerHTML = users.map((user) => `
      <button type="button" class="user-row" data-user-id="${escapeHtml(user.id)}">
        <span class="account-initial">${escapeHtml(user.displayName.slice(0, 1).toUpperCase())}</span>
        <span><strong>${escapeHtml(user.displayName)}</strong><small>@${escapeHtml(user.username)}</small></span>
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
        role: dom.managedRole.value,
        password: dom.managedPassword.value,
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

  dom.newUserBtn.addEventListener("click", resetUserForm);
  dom.closeUsersDialogBtn.addEventListener("click", () => dom.usersDialog.close());
  dom.manageUsersBtn.addEventListener("click", () => {
    dom.accountMenu.hidden = true;
    renderUsers();
    resetUserForm();
    dom.usersDialog.showModal();
  });

  dom.changePasswordBtn.addEventListener("click", async () => {
    dom.accountMenu.hidden = true;
    const currentPassword = prompt("请输入当前密码");
    if (currentPassword == null) return;
    const nextPassword = prompt("请输入新密码（至少 6 位）");
    if (nextPassword == null) return;
    try {
      await api("/api/auth/password", { method: "POST", body: { currentPassword, nextPassword } });
      alert("密码已修改，请重新登录。");
      location.reload();
    } catch (error) {
      alert(error.message);
    }
  });

  dom.logoutBtn.addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.reload();
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
        if (error.status === 401) location.reload();
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
