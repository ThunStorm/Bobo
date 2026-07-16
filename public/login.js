(() => {
  const dom = {
    title: document.querySelector("#loginTitle"),
    description: document.querySelector("#loginDescription"),
    setupForm: document.querySelector("#setupForm"),
    setupUsername: document.querySelector("#setupUsername"),
    setupDisplayName: document.querySelector("#setupDisplayName"),
    setupPassword: document.querySelector("#setupPassword"),
    setupError: document.querySelector("#setupError"),
    chooser: document.querySelector("#chooser"),
    users: document.querySelector("#loginUsers"),
    adminForm: document.querySelector("#adminLoginForm"),
    adminAvatar: document.querySelector("#adminLoginAvatar"),
    adminName: document.querySelector("#adminLoginName"),
    adminPassword: document.querySelector("#adminLoginPassword"),
    loginError: document.querySelector("#loginError"),
    cancelAdmin: document.querySelector("#cancelAdminLogin")
  };
  let selectedAdmin = null;

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
      throw error;
    }
    return payload;
  }

  function enterWorkspace() {
    window.scrollTo(0, 0);
    location.replace("/");
  }

  async function selectUser(user, password = "") {
    await api("/api/auth/select", { method: "POST", body: { userId: user.id, password } });
    enterWorkspace();
  }

  function renderChoices(users) {
    dom.users.innerHTML = users.map((user) => `
      <button class="login-user" type="button" data-user-id="${user.id}">
        <span class="login-avatar">${escapeHtml(user.avatarText)}</span>
        <span class="login-user-name">${escapeHtml(user.displayName)}</span>
        <span class="login-user-kind">${user.requiresPassword ? "管理员 · 需密码" : "点击进入"}</span>
      </button>
    `).join("");
    dom.users.querySelectorAll("[data-user-id]").forEach((button) => {
      button.addEventListener("click", async () => {
        const user = users.find((item) => item.id === button.dataset.userId);
        if (!user) return;
        dom.loginError.hidden = true;
        if (user.requiresPassword) {
          selectedAdmin = user;
          dom.users.hidden = true;
          dom.adminForm.hidden = false;
          dom.adminAvatar.textContent = user.avatarText;
          dom.adminName.textContent = user.displayName;
          dom.adminPassword.value = "";
          dom.adminPassword.focus();
          return;
        }
        button.disabled = true;
        try { await selectUser(user); }
        catch (error) {
          button.disabled = false;
          dom.loginError.textContent = error.message;
          dom.loginError.hidden = false;
        }
      });
    });
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  dom.setupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    dom.setupError.hidden = true;
    const submit = dom.setupForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      await api("/api/auth/setup", {
        method: "POST",
        body: {
          username: dom.setupUsername.value,
          displayName: dom.setupDisplayName.value,
          password: dom.setupPassword.value
        }
      });
      enterWorkspace();
    } catch (error) {
      dom.setupError.textContent = error.message;
      dom.setupError.hidden = false;
      submit.disabled = false;
    }
  });

  dom.adminForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!selectedAdmin) return;
    dom.loginError.hidden = true;
    const submit = dom.adminForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try { await selectUser(selectedAdmin, dom.adminPassword.value); }
    catch (error) {
      dom.loginError.textContent = error.message;
      dom.loginError.hidden = false;
      submit.disabled = false;
      dom.adminPassword.select();
    }
  });

  dom.cancelAdmin.addEventListener("click", () => {
    selectedAdmin = null;
    dom.adminForm.hidden = true;
    dom.users.hidden = false;
    dom.loginError.hidden = true;
  });

  async function init() {
    try {
      await api("/api/auth/me");
      enterWorkspace();
      return;
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    const payload = await api("/api/auth/choices");
    if (payload.needsSetup) {
      dom.title.textContent = "创建首位管理员";
      dom.description.textContent = "完成初始化后将直接进入工作区。";
      dom.setupForm.hidden = false;
      dom.setupUsername.focus();
      return;
    }
    dom.chooser.hidden = false;
    renderChoices(payload.users || []);
  }

  init().catch((error) => {
    dom.title.textContent = "暂时无法连接 Bobo";
    dom.description.textContent = error.message;
  });
})();