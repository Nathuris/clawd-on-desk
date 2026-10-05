"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { i18n, SUPPORTED_LANGS } = require("../src/i18n");

class FakeClassList {
  constructor(element) { this.element = element; }
  _set() { return new Set(this.element.className.split(/\s+/).filter(Boolean)); }
  _commit(set) { this.element.className = [...set].join(" "); }
  add(...names) {
    const set = this._set();
    for (const name of names) set.add(name);
    this._commit(set);
  }
  remove(...names) {
    const set = this._set();
    for (const name of names) set.delete(name);
    this._commit(set);
  }
  toggle(name, force) {
    const set = this._set();
    const shouldAdd = force === undefined ? !set.has(name) : Boolean(force);
    if (shouldAdd) set.add(name);
    else set.delete(name);
    this._commit(set);
    return shouldAdd;
  }
  contains(name) { return this._set().has(name); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.placeholder = "";
    this.value = "";
    this.innerHTML = "";
    this.hidden = false;
    this.disabled = false;
    this.style = {};
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    if (child) child.parentNode = null;
    return child;
  }
  replaceChildren(...children) {
    const document = this.ownerDocument;
    if (document && document.activeElement !== this && this.contains(document.activeElement)) {
      document.activeElement = document.body;
    }
    for (const child of this.children) child.parentNode = null;
    this.children = children;
    for (const child of children) child.parentNode = this;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  // 事件对象允许用例补充字段（Enter/isComposing/keyCode…），
  // 同时记录 preventDefault，方便断言回车被渲染端接管。
  async dispatch(name, event = {}) {
    const composed = {
      key: "",
      defaultPrevented: false,
      stopPropagation() {},
      preventDefault() { this.defaultPrevented = true; },
      ...event,
    };
    for (const listener of this.listeners.get(name) || []) await listener(composed);
    return composed;
  }
  querySelector(selector) {
    if (!selector.startsWith(".")) return null;
    return byClass(this, selector.slice(1))[0] || null;
  }
  contains(target) { return target === this || descendants(this).includes(target); }
  closest(selector) {
    if (!selector.startsWith(".")) return null;
    const className = selector.slice(1);
    let current = this;
    while (current) {
      if (current.classList && current.classList.contains(className)) return current;
      current = current.parentNode;
    }
    return null;
  }
  replaceWith() {}
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  select() {}
  // 假布局：默认零矩形，用例通过 setCardRect 覆盖（卡片高度随菜单展开变化由用例模拟）。
  getBoundingClientRect() {
    return this.rect || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  // 真 DOM 的 <select> 一定有 options 集合（保留给可能带下拉的渲染端）。
  get options() {
    return this.children.filter((child) => child && child.tagName === "OPTION");
  }
}

function createDocument(ids) {
  const elements = new Map(ids.map((id) => [id, new FakeElement("div")]));
  const documentListeners = new Map();
  const document = {
    title: "",
    activeElement: null,
    body: new FakeElement("body"),
    documentElement: { clientHeight: 0 },
    createElement: (tag) => {
      const element = new FakeElement(tag);
      element.ownerDocument = document;
      return element;
    },
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new FakeElement("fragment"),
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    contains: () => true,
    // 文档级事件：Esc 收起二级菜单就挂在 document 上，需要能派发并记录 preventDefault。
    addEventListener: (name, listener) => {
      if (!documentListeners.has(name)) documentListeners.set(name, []);
      documentListeners.get(name).push(listener);
    },
    removeEventListener: (name, listener) => {
      const list = documentListeners.get(name) || [];
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    },
    dispatch: async (name, event = {}) => {
      const composed = {
        key: "",
        defaultPrevented: false,
        stopPropagation() {},
        preventDefault() { this.defaultPrevented = true; },
        ...event,
      };
      for (const listener of documentListeners.get(name) || []) await listener(composed);
      return composed;
    },
    elements,
  };
  document.body.ownerDocument = document;
  for (const element of elements.values()) element.ownerDocument = document;
  return document;
}

function descendants(root) {
  const result = [];
  for (const child of root.children || []) {
    result.push(child, ...descendants(child));
  }
  return result;
}

function byClass(root, className) {
  return descendants(root).filter((element) =>
    element.classList && element.classList.contains(className));
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function translations() {
  return {
    dashboardWindowTitle: "Sessions",
    dashboardCount: "{n} active",
    dashboardJumpTerminal: "Jump",
    dashboardOpenFolder: "Open Folder",
    sessionFocusUnavailableRemote: "Remote sessions cannot focus a terminal on this computer.",
    sessionFocusUnavailableWebui: "WebUI sessions do not have a local terminal window.",
    sessionFocusUnavailableMissingTerminalInfo: "This session did not provide terminal window information.",
    sessionOpenFolderFailed: "Could not open folder: {reason}",
    sessionOpenFolderUnavailable: "This folder is no longer available.",
    sessionJustNow: "now",
    sessionHudElapsedSec: "{n}s",
    sessionMinAgo: "{n}m",
    sessionHrAgo: "{n}h",
    sessionBadgeIdle: "Idle",
    sessionLocal: "Local",
    sessionAutomationLabel: "Session automation",
    sessionAutomationFollowGlobal: "Follow global",
    sessionAutomationAsk: "Always ask",
    sessionAutomationAutoTools: "Auto-allow tools",
    sessionAutomationUnavailableValue: "Unavailable",
    sessionAutomationUnavailable: "Per-session settings unavailable.",
    sessionAutomationUnavailableCodexDesktop: "Codex Desktop does not support per-session permission settings yet.",
    sessionAutomationChangeFailed: "Could not update session automation.",
    sessionAutomationOrphansTitle: "Ended or hidden sessions",
    sessionAutomationOrphansHint: "These overrides remain active until revoked.",
    sessionAutomationRevoke: "Revoke",
    dashboardKimiQuotaRefresh: "Refresh Kimi quota",
    dashboardKimiQuotaRefreshing: "Refreshing Kimi…",
    dashboardKimiQuotaUpdated: "Kimi quota updated.",
    dashboardKimiQuotaRefreshFailed: "Refresh failed: {reason}",
    dashboardKimiQuotaEmpty: "No quota data yet. Click refresh to fetch it.",
    dashboardKimiQuotaRefreshShort: "Refresh",
    dashboardModel: "Model",
  };
}

// 快捷面板（输入块 + 设置块）渲染端要用的文案。
function hudTranslations(overrides = {}) {
  return {
    hudQuickPlaceholder: "Type a message, Enter to send…",
    hudQuickSendingTo: "Sending to: {name}",
    hudQuickStatusIdle: "Idle",
    hudQuickStatusWorking: "Working",
    hudQuickSendFailed: "Send failed",
    hudSendSent: "Sent to the terminal",
    hudSendCopied: "Copied — paste it in the terminal",
    hudSendNeedsPermission: "Copied — click Allow in the system dialog",
    hudSendNoSession: "No session running",
    hudQuickTargetLabel: "Choose which session to send to",
    hudQuickNewSession: "＋ New session in the terminal",
    hudQuickNewSessionAt: "Folder: {path}",
    hudQuickPickFolder: "📁 Choose a folder…",
    hudPickFolderFailed: "Could not open the folder picker",
    hudQuickPermissionLabel: "Permissions",
    hudQuickEffortLabel: "Effort",
    hudQuickAttachFile: "Add a file…",
    hudQuickAttachRemove: "Remove this file",
    hudQuickAttachLimit: "At most {n} files",
    hudQuickAttachFailed: "Could not open the file picker",
    hudQuickPastedFileFailed: "Could not save the pasted file",
    hudNewSessionQueued: "Queued — the terminal opens with your first message",
    hudNewSessionStarted: "New session opened in the terminal, message sent",
    hudNewSessionStarting: "The new session is still starting",
    hudQuickPendingTitle: "New session",
    hudQuickPendingHint: "Opens in the terminal with your first message",
    hudQuickPendingState: "not started",
    hudQuickPendingStarting: "starting up",
    hudQuickCancelPending: "Cancel this new session",
    hudQuickPermissionAuto: "Auto",
    hudQuickPermissionManual: "Manual",
    hudQuickPermissionEdits: "Edits",
    hudQuickPermissionPlan: "Plan",
    hudQuickEffortLow: "Low",
    hudQuickEffortMedium: "Med",
    hudQuickEffortHigh: "High",
    hudQuickEffortXHigh: "XHigh",
    hudQuickEffortMax: "Max",
    hudQuickOptionFailed: "Could not switch that setting",
    hudNewSessionOpened: "Opened a new session in the terminal",
    hudNewSessionFailed: "Could not open a new session",
    ...overrides,
  };
}

const HUD_ZH_TRANSLATIONS = hudTranslations({
  hudQuickPlaceholder: "输入消息，回车发送…",
  hudQuickSendingTo: "正在发给：{name}",
  hudQuickStatusIdle: "空闲",
  hudQuickStatusWorking: "工作中",
  hudQuickSendFailed: "发送失败",
  hudSendSent: "已发送到终端",
  hudSendCopied: "已复制，去终端粘贴",
  hudSendNeedsPermission: "已复制；要直接发送请在系统弹窗里点“允许”",
  hudSendNoSession: "没有正在运行的会话",
  hudQuickTargetLabel: "选择发给哪个会话",
  hudQuickNewSession: "＋ 在终端里新建会话",
  hudQuickNewSessionAt: "位置：{path}",
  hudQuickPickFolder: "📁 选择文件夹…",
  hudPickFolderFailed: "没能打开文件夹选择框",
  hudQuickPermissionLabel: "权限",
  hudQuickEffortLabel: "强度",
  hudQuickAttachFile: "添加文件…",
  hudQuickAttachRemove: "移除这个附件",
  hudQuickAttachLimit: "最多挂 {n} 个文件",
  hudQuickAttachFailed: "没能打开文件选择框",
  hudQuickPastedFileFailed: "没能保存粘贴的文件",
  hudNewSessionQueued: "已排好，发消息时会在终端里打开",
  hudNewSessionStarted: "新会话已在终端里开好，消息已送出",
  hudNewSessionStarting: "新会话正在启动，稍等一下再发",
  hudQuickPendingTitle: "新会话",
  hudQuickPendingHint: "发第一句话时才在终端里打开",
  hudQuickPendingState: "还没开始",
  hudQuickPendingStarting: "正在启动",
  hudQuickCancelPending: "取消这个新会话",
  hudQuickPermissionAuto: "自动",
  hudQuickPermissionManual: "手动",
  hudQuickPermissionEdits: "自动编辑",
  hudQuickPermissionPlan: "计划",
  hudQuickEffortLow: "低",
  hudQuickEffortMedium: "中",
  hudQuickEffortHigh: "高",
  hudQuickEffortXHigh: "极高",
  hudQuickEffortMax: "最大",
  hudQuickOptionFailed: "切换失败",
  hudNewSessionOpened: "已在终端里新建会话",
  hudNewSessionFailed: "新建会话失败",
});

function session(id, overrides = {}) {
  return {
    id,
    displayTitle: id,
    state: "idle",
    badge: "idle",
    updatedAt: Date.now(),
    canFocus: false,
    sourceType: "local",
    host: null,
    platform: null,
    cwd: "/safe/project",
    ...overrides,
  };
}

async function loadDashboard(
  sessions,
  openResult = { status: "ok" },
  snapshotOverrides = {},
  automationResult = { status: "applied" },
  kimiOptions = {}
) {
  const document = createDocument([
    "title",
    "count",
    "content",
    "quotaSummary",
  ]);
  const openCalls = [];
  const automationCalls = [];
  const kimiRefreshCalls = [];
  let renderInterval = null;
  let snapshotListener = null;
  const api = {
    onLangChange: () => {},
    onSessionSnapshot: (listener) => { snapshotListener = listener; },
    getI18n: async () => ({ lang: "en", translations: translations() }),
    getSnapshot: async () => ({
      sessions,
      groups: [{ host: "", ids: sessions.map((s) => s.id) }],
      ...snapshotOverrides,
    }),
    openSessionFolder: async (...args) => {
      openCalls.push(args);
      return typeof openResult === "function" ? openResult(...args) : openResult;
    },
    focusSession: () => {},
    ackCompletion: async () => ({ status: "noop" }),
    hideSession: async () => ({ status: "ok" }),
    setSessionAutomationOverride: async (payload) => {
      automationCalls.push(["set", payload]);
      return typeof automationResult === "function"
        ? automationResult("set", payload)
        : automationResult;
    },
    clearSessionAutomationGrant: async (payload) => {
      automationCalls.push(["clear", payload]);
      return typeof automationResult === "function"
        ? automationResult("clear", payload)
        : automationResult;
    },
    getKimiQuotaStatus: async () => kimiOptions.status || {
      status: "ok",
      configured: false,
      decryptable: false,
      collectionEnabled: false,
      agentEnabled: true,
    },
    refreshKimiQuota: async () => {
      kimiRefreshCalls.push(true);
      return kimiOptions.refreshResult || { status: "ok" };
    },
  };
  const context = vm.createContext({
    window: { dashboardAPI: api }, document, console, Intl, Date,
    setInterval: (callback) => { renderInterval = callback; return 1; },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (cb) => cb(),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "session-focus-unavailable.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "language-picker.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8"), context);
  await flush();
  return {
    root: document.elements.get("content"),
    quotaSummary: document.elements.get("quotaSummary"),
    openCalls,
    automationCalls,
    kimiRefreshCalls,
    tickRender: () => { if (renderInterval) renderInterval(); },
    pushSnapshot: (nextSnapshot) => {
      if (snapshotListener) snapshotListener(nextSnapshot);
    },
    document,
  };
}

// 加载整块快捷面板（单窗口，不再有 ?block= 分支）。
// preload 暴露的 API 全部给出假实现并记录调用；setTimeout 换成假计时器，
// 便于断言 4 秒提示的消失时机；document 级事件可派发，用于测 Esc。
async function loadHud(options = {}) {
  const document = createDocument(["hud"]);
  const calls = {
    sendPrompt: [],
    setClickThrough: [],
    setHold: [],
    selectSession: [],
    setListOpen: [],
    newSession: 0,
    pickFolder: 0,
    setNewSessionOption: [],
    cancelPendingSession: 0,
    setAttachments: [],
    pickFiles: 0,
    savePastedFile: [],
  };
  const warnings = [];
  const timers = new Map();
  let timerSeq = 0;
  let langListener = null;
  let quickListener = null;
  const i18nPayload = options.i18n || { lang: "en", translations: hudTranslations() };

  const api = {
    getI18n: async () => i18nPayload,
    onLangChange: (listener) => { langListener = listener; },
    onQuickState: (listener) => { quickListener = listener; },
    sendPrompt: async (text) => {
      calls.sendPrompt.push(text);
      if (options.sendPromptThrows) throw new Error("send failed");
      return typeof options.sendPromptResult === "function"
        ? options.sendPromptResult(text)
        : (options.sendPromptResult || { status: "ok" });
    },
    // 与 preload 一致：同步 send，不返回 Promise。
    setClickThrough: (through) => {
      calls.setClickThrough.push(through);
      if (options.setClickThroughThrows) throw new Error("set click through failed");
    },
    setHold: (reason, held) => { calls.setHold.push([reason, held]); },
    setAttachments: (count) => { calls.setAttachments.push(count); },
    selectSession: async (sessionId) => {
      calls.selectSession.push(sessionId);
      return options.selectSessionResult || { status: "ok" };
    },
    setListOpen: async (open) => {
      calls.setListOpen.push(!!open);
      return options.setListOpenResult || { status: "ok" };
    },
    newSession: async () => {
      calls.newSession += 1;
      return options.newSessionResult || { status: "ok", textKey: "hudNewSessionOpened" };
    },
    pickFolder: async () => {
      calls.pickFolder += 1;
      if (options.pickFolderThrows) throw new Error("pick folder failed");
      return options.pickFolderResult || { status: "ok" };
    },
    pickFiles: async () => {
      calls.pickFiles += 1;
      if (options.pickFilesThrows) throw new Error("pick files failed");
      return options.pickFilesResult || { status: "ok", paths: ["/tmp/一张图.png"] };
    },
    savePastedFile: async (payload) => {
      calls.savePastedFile.push(payload);
      return options.savePastedResult || { status: "ok", path: "/tmp/clawd-pastes/paste-1.png" };
    },
    pathForFile: (file) => (options.pathForFile ? options.pathForFile(file) : ""),
    cancelPendingSession: async () => {
      calls.cancelPendingSession += 1;
      return options.cancelPendingResult || { status: "ok" };
    },
    setNewSessionOption: async (key, value) => {
      calls.setNewSessionOption.push([key, value]);
      if (options.setOptionThrows) throw new Error("set option failed");
      return options.setOptionResult || { status: "ok" };
    },
  };

  const context = vm.createContext({
    window: { sessionHudAPI: api },
    document,
    console: {
      log: (...args) => warnings.push(["log", ...args]),
      warn: (...args) => warnings.push(["warn", ...args]),
      error: (...args) => warnings.push(["error", ...args]),
    },
    Date,
    setTimeout: (callback, delay) => {
      const id = ++timerSeq;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
  });
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8"),
    context
  );
  await flush();

  const root = document.elements.get("hud");
  const find = (className) => byClass(root, className);
  // 面板一加载就会主动报一次附件数与 hold（窗口重建后别留着上次的数字）。
  // 这几笔单独记下来给专门的用例断言，其余用例从干净的账本开始数。
  const startupCalls = {
    setAttachments: calls.setAttachments.splice(0),
    setHold: calls.setHold.splice(0),
  };
  return {
    document,
    root,
    calls,
    startupCalls,
    warnings,
    find,
    one: (className) => find(className)[0] || null,
    byTag: (tagName) => descendants(root).filter((el) => el.tagName === String(tagName).toUpperCase()),
    // 假布局：给卡片设定 getBoundingClientRect 的返回值（菜单展开引起的高度变化由用例模拟）。
    setCardRect: (rect) => {
      const card = find("quick-card")[0];
      if (card) card.rect = rect;
    },
    pushQuickState: (state) => {
      assert.strictEqual(typeof quickListener, "function", "renderer must register onQuickState");
      quickListener(state);
    },
    pushLang: (payload) => {
      assert.strictEqual(typeof langListener, "function", "renderer must register onLangChange");
      langListener(payload);
    },
    pendingTimerDelays: () => [...timers.values()].map((timer) => timer.delay),
    fireTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const timer of pending) timer.callback();
    },
  };
}

test("Dashboard renders local/remote/webui reasons and only local folder action", async () => {
  const { root } = await loadDashboard([
    session("local"),
    session("remote", { sourceType: "ssh", host: "host" }),
    session("webui", { platform: "webui" }),
  ]);
  assert.strictEqual(byClass(root, "card-unfocusable").length, 3);
  assert.deepStrictEqual(byClass(root, "focus-unavailable-reason").map((el) => el.textContent), [
    "This session did not provide terminal window information.",
    "Remote sessions cannot focus a terminal on this computer.",
    "WebUI sessions do not have a local terminal window.",
  ]);

  const cards = byClass(root, "card");
  const jumpButtons = (card) => descendants(card)
    .filter((el) => el.tagName === "BUTTON" && el.textContent === "Jump");
  assert.deepStrictEqual(jumpButtons(cards[0]).map((button) => button.disabled), [true]);
  assert.deepStrictEqual(jumpButtons(cards[1]), []);
  assert.deepStrictEqual(jumpButtons(cards[2]).map((button) => button.disabled), [true]);
  assert.strictEqual(byClass(root, "open-folder-button").length, 1);
});

test("Dashboard hosts the manual Kimi quota refresh inside the Kimi quota section", async () => {
  const dashboard = await loadDashboard(
    [],
    { status: "ok" },
    {},
    { status: "applied" },
    {
      status: {
        status: "ok",
        configured: true,
        decryptable: true,
        collectionEnabled: true,
        agentEnabled: true,
      },
    }
  );

  // Connected but nothing reported yet: the section stays visible with an
  // empty hint so the refresh that fetches the first numbers has a home.
  const button = byClass(dashboard.quotaSummary, "quota-refresh-button")[0];
  assert.ok(button, "Kimi quota section header should host the refresh button");
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(button.title, "Refresh Kimi quota");
  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-empty-hint").length, 1);

  await button.dispatch("click");
  await flush();

  assert.strictEqual(dashboard.kimiRefreshCalls.length, 1);
  assert.strictEqual(button.disabled, false);
  const feedback = byClass(dashboard.quotaSummary, "quota-refresh-feedback")[0];
  assert.ok(feedback, "Kimi quota section header should host the refresh feedback");
  assert.strictEqual(feedback.hidden, false);
  assert.strictEqual(feedback.textContent, "Kimi quota updated.");
});

test("Dashboard renders no Kimi quota section or refresh for a disconnected key", async () => {
  const dashboard = await loadDashboard([]);

  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-refresh-button").length, 0);
  assert.strictEqual(byClass(dashboard.quotaSummary, "quota-section").length, 0);
});

test("Dashboard quota bars apply the same warn and hot boundaries as Orbit", async () => {
  const dashboard = await loadDashboard([], { status: "ok" }, {
    accountQuota: [{
      host: null,
      claudeQuota: {
        lastSeenAt: Date.now(),
        group: {
          claudeFiveHour: { usedPercent: 59 },
          claudeWeekly: { usedPercent: 60 },
        },
      },
      codexQuota: {
        lastSeenAt: Date.now(),
        group: {
          codexFiveHour: { usedPercent: 85 },
          codexWeekly: { usedPercent: 86 },
        },
      },
    }],
  });

  const classesByWidth = new Map(
    byClass(dashboard.quotaSummary, "quota-bar-fill")
      .map((fill) => [fill.style.width, fill.className])
  );
  assert.match(classesByWidth.get("59%"), /\bsev-ok\b/);
  assert.match(classesByWidth.get("60%"), /\bsev-warn\b/);
  assert.match(classesByWidth.get("85%"), /\bsev-warn\b/);
  assert.match(classesByWidth.get("86%"), /\bsev-hot\b/);
});

test("Dashboard renders the resolved custom agent name instead of its raw id", async () => {
  const { root } = await loadDashboard([
    session("custom", {
      agentId: "custom-nova-0123456789ab",
      agentName: "Nova AI",
    }),
  ]);

  const meta = byClass(root, "meta")[0];
  const renderedText = meta.children.map((child) => child.textContent || "").join("");
  assert.match(renderedText, /Nova AI/);
  assert.doesNotMatch(renderedText, /custom-nova/);
});

test("Dashboard keeps curated labels for built-in agents", async () => {
  const { root } = await loadDashboard([
    session("codex", { agentId: "codex", agentName: "Codex CLI" }),
  ]);

  const meta = byClass(root, "meta")[0];
  const renderedText = meta.children.map((child) => child.textContent || "").join("");
  assert.match(renderedText, /Codex/);
  assert.doesNotMatch(renderedText, /Codex CLI/);
});

test("Dashboard folder click sends only id and exposes open failure", async () => {
  const { root, openCalls } = await loadDashboard([session("local")], { status: "error", message: "denied" });
  await byClass(root, "open-folder-button")[0].dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);
  const feedback = byClass(root, "session-action-feedback")[0];
  assert.ok(feedback);
  assert.strictEqual(feedback.attributes["aria-live"], "polite");
  assert.strictEqual(feedback.textContent, "Could not open folder: denied");
});

test("Dashboard preserves folder pending and failure state across interval renders", async () => {
  let resolveOpen;
  const pendingResult = new Promise((resolve) => { resolveOpen = resolve; });
  const { root, openCalls, tickRender } = await loadDashboard(
    [session("local")],
    () => pendingResult
  );

  const clickPromise = byClass(root, "open-folder-button")[0].dispatch("click");
  await flush();
  tickRender();

  const replacementButton = byClass(root, "open-folder-button")[0];
  assert.strictEqual(replacementButton.disabled, true);
  await replacementButton.dispatch("click");
  assert.deepStrictEqual(openCalls, [["local"]]);

  resolveOpen({ status: "error", message: "slow denial" });
  await clickPromise;
  tickRender();
  assert.strictEqual(
    byClass(root, "session-action-feedback")[0].textContent,
    "Could not open folder: slow denial"
  );
  assert.strictEqual(byClass(root, "open-folder-button")[0].disabled, false);
});

test("Dashboard session automation sends only sessionId/mode and exact grantId", async () => {
  const configurable = session("configurable", {
    canConfigureSessionAutomation: true,
    sessionAutomationMode: "inherit",
  });
  const activeButIneligible = session("active", {
    canConfigureSessionAutomation: false,
    sessionAutomationMode: "auto-tools",
    sessionAutomationGrantId: "grant-current",
  });
  const inactiveIneligible = session("inactive", {
    agentId: "codex",
    canConfigureSessionAutomation: false,
    sessionAutomationMode: "inherit",
  });
  const { root, automationCalls } = await loadDashboard([
    configurable,
    activeButIneligible,
    inactiveIneligible,
  ]);
  const pickers = byClass(root, "session-automation-picker");
  assert.strictEqual(pickers.length, 2);
  assert.strictEqual(byClass(pickers[0], "language-picker-option").length, 3);
  assert.strictEqual(byClass(pickers[1], "language-picker-option").length, 2);
  assert.strictEqual(byClass(root, "session-automation-readonly").length, 1);

  const askOption = byClass(pickers[0], "language-picker-option")
    .find((option) => option.textContent === "Always ask");
  const inheritOption = byClass(pickers[1], "language-picker-option")
    .find((option) => option.textContent === "Follow global");
  await askOption.dispatch("click");
  await flush();
  await inheritOption.dispatch("click");
  await flush();

  assert.deepStrictEqual(JSON.parse(JSON.stringify(automationCalls)), [
    ["set", { sessionId: "configurable", mode: "off" }],
    ["clear", { grantId: "grant-current" }],
  ]);
});

test("Dashboard refreshes a closed focused automation picker before an immediate revoke", async () => {
  const initial = session("configurable", {
    canConfigureSessionAutomation: true,
    sessionAutomationMode: "inherit",
    sessionAutomationGrantId: null,
  });
  const harness = await loadDashboard([initial]);
  const firstPicker = byClass(harness.root, "session-automation-picker")[0];
  const firstTrigger = byClass(firstPicker, "language-picker-trigger")[0];
  const autoToolsOption = byClass(firstPicker, "language-picker-option")
    .find((option) => option.textContent === "Auto-allow tools");

  await firstTrigger.dispatch("click");
  await autoToolsOption.dispatch("click");
  await flush();
  harness.document.activeElement = firstTrigger;

  const updated = session("configurable", {
    canConfigureSessionAutomation: true,
    sessionAutomationMode: "auto-tools",
    sessionAutomationGrantId: "grant-new",
  });
  harness.pushSnapshot({
    sessions: [updated],
    groups: [{ host: "", ids: [updated.id] }],
  });

  const refreshedPicker = byClass(harness.root, "session-automation-picker")[0];
  const refreshedTrigger = byClass(refreshedPicker, "language-picker-trigger")[0];
  assert.strictEqual(harness.document.activeElement, refreshedTrigger, "snapshot refresh retains focus on the current control");
  const inheritOption = byClass(refreshedPicker, "language-picker-option")
    .find((option) => option.textContent === "Follow global");
  await refreshedTrigger.dispatch("click");
  await inheritOption.dispatch("click");
  await flush();

  assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.automationCalls)), [
    ["set", { sessionId: "configurable", mode: "auto-tools" }],
    ["clear", { grantId: "grant-new" }],
  ]);
});

test("Dashboard renders unsupported Codex Desktop automation as an explained read-only value", async () => {
  const { root } = await loadDashboard([
    session("desktop", {
      agentId: "codex",
      canConfigureSessionAutomation: false,
      sessionAutomationMode: null,
      sessionAutomationGrantId: null,
      sessionAutomationDisabledReason: "unsupported-codex-originator",
      codexOriginator: "codex_work_desktop",
    }),
  ]);

  assert.strictEqual(byClass(root, "session-automation-picker").length, 0);
  assert.strictEqual(
    byClass(root, "session-automation-readonly")[0].textContent,
    "Unavailable"
  );
  assert.strictEqual(
    byClass(root, "session-automation-unavailable")[0].textContent,
    "Codex Desktop does not support per-session permission settings yet."
  );
});

test("Dashboard preserves a closed picker focus across ticks without reviving removed sessions", async () => {
  const configured = session("focused", { canConfigureSessionAutomation: true });
  const harness = await loadDashboard([configured]);
  let trigger = byClass(harness.root, "language-picker-trigger")[0];
  trigger.focus();
  for (let i = 0; i < 2; i++) {
    harness.tickRender();
    const next = byClass(harness.root, "language-picker-trigger")[0];
    assert.notStrictEqual(next, trigger);
    assert.strictEqual(harness.document.activeElement, next);
    trigger = next;
  }
  harness.pushSnapshot({ sessions: [], groups: [] });
  assert.strictEqual(byClass(harness.root, "session-automation-picker").length, 0);
  assert.strictEqual(harness.document.activeElement, harness.document.body, "a removed session cannot regain focus");
});

test("Dashboard releases the menu refresh guard after keyboard focus moves outside", async () => {
  const configured = session("menu", { canConfigureSessionAutomation: true, canFocus: true });
  const harness = await loadDashboard([configured]);
  const picker = byClass(harness.root, "session-automation-picker")[0];
  await byClass(picker, "language-picker-trigger")[0].dispatch("click");
  assert.strictEqual(picker.classList.contains("open"), true);
  harness.tickRender();
  assert.strictEqual(byClass(harness.root, "session-automation-picker")[0], picker);
  const outside = byClass(harness.root, "actions")[0].children[0];
  outside.focus();
  const newer = session("new", { agentId: "codex" });
  harness.pushSnapshot({ sessions: [configured, newer], groups: [{ host: "", ids: [configured.id, newer.id] }] });
  assert.strictEqual(byClass(harness.root, "card").length, 2);
  assert.strictEqual(picker.classList.contains("open"), false);
});

test("Dashboard hides unsupported non-Codex rows while retaining exact grant revocation", async () => {
  const sessions = ["pi", "qoder", "zcode", "deepseek-harness", "claude-code"].map((agentId) =>
    session(agentId, { agentId, canConfigureSessionAutomation: false }));
  const harness = await loadDashboard(sessions);
  assert.strictEqual(byClass(harness.root, "session-automation-row").length, 0);
  const retained = session("retained", { agentId: "pi", canConfigureSessionAutomation: false,
    sessionAutomationMode: "auto-tools", sessionAutomationGrantId: "retained-grant" });
  harness.pushSnapshot({ sessions: [retained], groups: [{ host: "", ids: [retained.id] }] });
  const picker = byClass(harness.root, "session-automation-picker")[0];
  await byClass(picker, "language-picker-option").find(option => option.textContent === "Follow global").dispatch("click");
  await flush();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(harness.automationCalls)), [["clear", { grantId: "retained-grant" }]]);
});

test("Dashboard labels only known Desktop originators as Codex Desktop", async () => {
  const { isCodexDesktopOriginator } = require("../hooks/codex-originator");
  for (const originator of ["codex desktop", " CODEX_WORK_DESKTOP ", "codex_vscode", "codex-exec", "unknown", null]) {
    const harness = await loadDashboard([session("unsupported", { agentId: "codex",
      canConfigureSessionAutomation: false, codexOriginator: originator,
      sessionAutomationDisabledReason: "unsupported-codex-session-source" })]);
    assert.strictEqual(byClass(harness.root, "session-automation-unavailable")[0].textContent,
      isCodexDesktopOriginator(originator)
        ? translations().sessionAutomationUnavailableCodexDesktop
        : translations().sessionAutomationUnavailable);
  }
});

test("Dashboard renders and revokes an orphan grant by exact grantId", async () => {
  const { root, automationCalls } = await loadDashboard([], { status: "ok" }, {
    sessionAutomationOrphans: [{
      agentId: "claude-code",
      sessionId: "ended",
      mode: "auto-tools",
      displayLabel: "Ended project",
      sessionAutomationGrantId: "grant-orphan",
    }],
  });

  assert.strictEqual(byClass(root, "automation-orphan-card").length, 1);
  assert.strictEqual(byClass(root, "automation-orphan-title")[0].textContent, "Ended project");
  const revoke = byClass(root, "automation-orphan-card")[0].children[1];
  await revoke.dispatch("click");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(automationCalls)), [
    ["clear", { grantId: "grant-orphan" }],
  ]);
});

test("Dashboard keeps session automation failure feedback visible after rerender", async () => {
  const { root, tickRender } = await loadDashboard([
    session("configurable", {
      canConfigureSessionAutomation: true,
      sessionAutomationMode: "inherit",
    }),
  ], { status: "ok" }, {}, { status: "full" });
  const picker = byClass(root, "session-automation-picker")[0];
  const autoToolsOption = byClass(picker, "language-picker-option")
    .find((option) => option.textContent === "Auto-allow tools");
  await autoToolsOption.dispatch("click");
  await flush();

  tickRender();
  const refreshedPicker = byClass(root, "session-automation-picker")[0];
  assert.notStrictEqual(refreshedPicker, picker);
  assert.strictEqual(byClass(refreshedPicker, "language-picker-value")[0].textContent, "Follow global");
  assert.strictEqual(
    byClass(root, "session-automation-feedback")[0].textContent,
    "Could not update session automation."
  );
});

/* ===== 快捷面板：状态行（正在发给谁）+ 输入行 ===== */

const PANEL_ZH = "zh";

function withTarget(hud, { title = "clawd-on-desk", state = "working", folder = "clawd-on-desk" } = {}) {
  hud.pushQuickState({ targetTitle: title, targetFolder: folder, targetState: state, canSend: true });
}

test("quick panel: 只有状态行与输入框两行，没有下拉/菜单/停止按钮", async () => {
  const hud = await loadHud();
  assert.strictEqual(hud.find("quick-card").length, 1);
  assert.strictEqual(hud.find("quick-status-row").length, 1);
  assert.strictEqual(hud.find("quick-input-row").length, 1);
  for (const gone of [
    "quick-level-btn", "quick-menu", "quick-mode-option", "quick-effort-range",
    "quick-folder-btn", "quick-stop-btn",
  ]) {
    assert.strictEqual(hud.one(gone), null, `${gone} 应随内置客户端一起删掉`);
  }
  assert.strictEqual(hud.byTag("select").length, 0);
});

test("quick panel: 没有会话时说「没有正在运行的会话」", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  assert.strictEqual(hud.one("quick-status-text").textContent, "没有正在运行的会话");
  assert.strictEqual(hud.one("quick-input").placeholder, "输入消息，回车发送…");
});

test("quick panel: 状态行显示目标会话名与它的状态", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  withTarget(hud);
  assert.strictEqual(hud.one("quick-status-text").textContent, "正在发给：clawd-on-desk · 工作中");

  hud.pushQuickState({ targetTitle: "clawd-on-desk", targetState: "idle", canSend: true });
  assert.strictEqual(hud.one("quick-status-text").textContent, "正在发给：clawd-on-desk · 空闲");

  // 目标会话切走了 → 回到「没有会话」
  hud.pushQuickState({ canSend: false });
  assert.strictEqual(hud.one("quick-status-text").textContent, "没有正在运行的会话");
});

test("quick panel: Enter 发送，送进终端后清空输入框并提示", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  withTarget(hud);
  const input = hud.one("quick-input");
  input.value = "帮我看看这个 bug";
  await input.dispatch("keydown", { key: "Enter", keyCode: 13, isComposing: false });
  await flush();

  assert.deepStrictEqual(hud.calls.sendPrompt, ["帮我看看这个 bug"]);
  assert.strictEqual(input.value, "", "真的送进去了才清空");
  assert.strictEqual(hud.one("quick-status-text").textContent, "已发送到终端");
  assert.deepStrictEqual(hud.calls.setHold, [["draft", false]]);
  // 4 秒后提示消失，状态行回到「正在发给谁」
  hud.fireTimers();
  assert.strictEqual(hud.one("quick-status-text").textContent, "正在发给：clawd-on-desk · 工作中");
});

test("quick panel: 只复制到剪贴板时保留文字，并如实说「去粘贴」", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    sendPromptResult: { status: "copied", textKey: "hudSendCopied" },
  });
  withTarget(hud);
  const input = hud.one("quick-input");
  input.value = "你好";
  await input.dispatch("keydown", { key: "Enter", keyCode: 13, isComposing: false });
  await flush();

  assert.strictEqual(input.value, "你好", "没真送进去，文字要留着");
  assert.strictEqual(hud.one("quick-status-text").textContent, "已复制，去终端粘贴");
  assert.ok(hud.one("quick-status-text").classList.contains("is-error"));
});

test("quick panel: 没会话/失败都如实提示，不谎报已发送", async () => {
  const noSession = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    sendPromptResult: { status: "no-session", textKey: "hudSendNoSession" },
  });
  noSession.pushQuickState({ canSend: true, targetTitle: "x" });
  const inputA = noSession.one("quick-input");
  inputA.value = "在吗";
  await inputA.dispatch("keydown", { key: "Enter", keyCode: 13, isComposing: false });
  await flush();
  assert.strictEqual(noSession.one("quick-status-text").textContent, "没有正在运行的会话");
  assert.strictEqual(inputA.value, "在吗");

  const failed = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    sendPromptResult: { status: "error", textKey: "hudQuickSendFailed" },
  });
  failed.pushQuickState({ canSend: true, targetTitle: "x" });
  const inputB = failed.one("quick-input");
  inputB.value = "在吗";
  await inputB.dispatch("keydown", { key: "Enter", keyCode: 13, isComposing: false });
  await flush();
  assert.strictEqual(failed.one("quick-status-text").textContent, "发送失败");
  assert.strictEqual(inputB.value, "在吗");
});

test("quick panel: 抛错也走失败提示", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    sendPromptThrows: true,
  });
  hud.pushQuickState({ canSend: true, targetTitle: "x" });
  const input = hud.one("quick-input");
  input.value = "在吗";
  await input.dispatch("keydown", { key: "Enter", keyCode: 13, isComposing: false });
  await flush();
  assert.strictEqual(hud.one("quick-status-text").textContent, "发送失败");
  assert.strictEqual(input.value, "在吗");
});

test("quick panel: IME 组字中的回车不发送", async () => {
  const hud = await loadHud();
  withTarget(hud);
  const input = hud.one("quick-input");
  input.value = "在";
  await input.dispatch("keydown", { key: "Enter", keyCode: 229, isComposing: true });
  await flush();
  assert.deepStrictEqual(hud.calls.sendPrompt, []);
});

test("quick panel: 空白草稿不发送", async () => {
  const hud = await loadHud();
  withTarget(hud);
  const input = hud.one("quick-input");
  input.value = "   ";
  await input.dispatch("keydown", { key: "Enter", keyCode: 13, isComposing: false });
  await flush();
  assert.deepStrictEqual(hud.calls.sendPrompt, []);
});

test("quick panel: 聚焦与草稿分别上报 hold", async () => {
  const hud = await loadHud();
  const input = hud.one("quick-input");
  assert.deepStrictEqual(hud.calls.setHold, []);
  await input.dispatch("focus");
  input.value = "草稿";
  await input.dispatch("input");
  input.value = "";
  await input.dispatch("input");
  await input.dispatch("blur");
  assert.deepStrictEqual(hud.calls.setHold, [["focus", true], ["draft", true], ["draft", false], ["focus", false]]);
});

test("quick panel: 语言切换只改文案，不重建输入框", async () => {
  const hud = await loadHud();
  withTarget(hud);
  const input = hud.one("quick-input");
  input.value = "draft text";
  hud.pushLang({ lang: "zh", translations: HUD_ZH_TRANSLATIONS });

  assert.strictEqual(hud.one("quick-input"), input, "输入框节点要复用");
  assert.strictEqual(input.value, "draft text", "草稿不能在切语言时丢");
  assert.strictEqual(input.placeholder, "输入消息，回车发送…");
  assert.strictEqual(hud.one("quick-status-text").textContent, "正在发给：clawd-on-desk · 工作中");
});

test("quick panel: 点状态行开合会话列表", async () => {
  const hud = await loadHud();
  withTarget(hud);
  const button = hud.one("quick-target-btn");
  assert.ok(button, "状态行要是一个可点的按钮");
  assert.strictEqual(button.getAttribute("aria-expanded"), "false");

  await button.dispatch("click");
  await flush();
  assert.deepStrictEqual(hud.calls.setListOpen, [true]);

  hud.pushQuickState({
    canSend: true, targetTitle: "x", listOpen: true,
    sessions: [{ id: "s1", title: "x", folder: "proj", state: "working", active: true }],
  });
  assert.strictEqual(button.getAttribute("aria-expanded"), "true");
  assert.strictEqual(hud.find("quick-session-item").length, 1, "展开后才建列表行");
});

test("quick panel: 列表按会话渲染，当前目标高亮，新建入口在最后", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({
    canSend: true,
    targetId: "s2",
    targetTitle: "第二个",
    listOpen: true,
    canCreateSession: true,
    newSessionFolder: "~/Documents/谱子",
    newSessionFolderName: "谱子",
    sessions: [
      { id: "s1", title: "第一个", folder: "proj-a", state: "idle", active: false },
      { id: "s2", title: "第二个", folder: "proj-b", state: "working", active: true },
    ],
  });
  const items = hud.find("quick-session-item");
  assert.strictEqual(items.length, 4, "两条会话 + 新建入口 + 选文件夹入口");
  assert.strictEqual(byClass(items[0], "quick-session-name")[0].textContent, "第一个");
  assert.strictEqual(byClass(items[0], "quick-session-meta")[0].textContent, "proj-a · 空闲");
  assert.ok(items[1].classList.contains("is-active"), "当前目标要高亮");
  assert.strictEqual(byClass(items[2], "quick-session-name")[0].textContent, "＋ 在终端里新建会话");
  // 列表收起时清空 DOM，不留看不见的节点
  hud.pushQuickState({ canSend: true, targetTitle: "x", listOpen: false });
  assert.strictEqual(hud.find("quick-session-item").length, 0);
});

test("quick panel: 只有支持新建会话的平台才画新建与选文件夹那两行", async () => {
  const hud = await loadHud();
  hud.pushQuickState({ listOpen: true, canCreateSession: false, sessions: [] });
  assert.strictEqual(hud.find("quick-session-create").length, 0);
  assert.strictEqual(hud.find("quick-session-folder").length, 0);
});

test("quick panel: 排好的新会话占列表第一行，并挤掉一条会话行", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({
    listOpen: true,
    canCreateSession: true,
    pendingId: "pending:1",
    targetPending: true,
    sessions: [1, 2, 3, 4].map((n) => ({ id: `s${n}`, title: `S${n}`, state: "idle", active: false })),
  });

  const pending = hud.one("quick-session-pending");
  assert.ok(pending, "要有占位行");
  assert.strictEqual(byClass(pending, "quick-session-name")[0].textContent, "新会话");
  assert.strictEqual(
    byClass(pending, "quick-session-meta")[0].textContent,
    "发第一句话时才在终端里打开"
  );
  assert.ok(pending.classList.contains("is-active"), "目标是它时要高亮");

  // 占位占一行，所以真会话只画 3 条——列表区高度是写死的
  const sessions = hud.find("quick-session-item").filter((row) => row.getAttribute("data-session-id"));
  assert.strictEqual(sessions.length, 3, "4 条会话被占位挤掉一条");
  assert.deepStrictEqual(
    sessions.map((row) => row.getAttribute("data-session-id")),
    ["s1", "s2", "s3"]
  );
  assert.strictEqual(
    hud.one("quick-session-list").children[0].className,
    "quick-pending-row",
    "占位在最上面"
  );
});

test("quick panel: 目标是不成信儿的占位时，状态行说明它在等第一句话", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({
    listOpen: true, canCreateSession: true, canSend: true, pendingId: "pending:1", targetPending: true,
  });
  assert.strictEqual(hud.one("quick-status-text").textContent, "正在发给：新会话 · 还没开始");

  hud.pushQuickState({
    listOpen: true, canCreateSession: true, canSend: true, pendingId: "pending:1",
    targetPending: true, pendingLaunched: true,
  });
  assert.strictEqual(hud.one("quick-status-text").textContent, "正在发给：新会话 · 正在启动");
});

test("quick panel: 点占位行 = 选中它并收起列表", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({ listOpen: true, canCreateSession: true, pendingId: "pending:7", targetPending: false });
  await hud.one("quick-session-pending").dispatch("click");
  await flush();
  assert.deepStrictEqual(hud.calls.selectSession, ["pending:7"]);
  assert.deepStrictEqual(hud.calls.setListOpen, [false]);
});

test("quick panel: 点 ✕ 取消排好的新会话", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({ listOpen: true, canCreateSession: true, pendingId: "pending:7", targetPending: true });
  const cancel = hud.one("quick-pending-cancel");
  assert.strictEqual(cancel.getAttribute("aria-label"), "取消这个新会话");
  await cancel.dispatch("click");
  await flush();
  assert.strictEqual(hud.calls.cancelPendingSession, 1);
  assert.deepStrictEqual(hud.calls.selectSession, [], "取消不是选中");
});

test("quick panel: 没有占位时不画那一行", async () => {
  const hud = await loadHud();
  hud.pushQuickState({ listOpen: true, canCreateSession: true, sessions: [] });
  assert.strictEqual(hud.find("quick-pending-row").length, 0);
});

test("quick panel: 会话行最多 4 条，列表区行数固定", async () => {
  const hud = await loadHud();
  hud.pushQuickState({
    listOpen: true,
    canCreateSession: true,
    sessions: [1, 2, 3, 4, 5].map((n) => ({
      id: `s${n}`, title: `S${n}`, folder: `p${n}`, state: "idle", active: false,
    })),
  });
  const items = hud.find("quick-session-item");
  // 4 条会话 + 新建入口 + 选文件夹入口 = 6 行，正好是列表区的固定行数。
  assert.strictEqual(items.length, 6);
  assert.strictEqual(byClass(items[3], "quick-session-name")[0].textContent, "S4");
  assert.strictEqual(byClass(items[4], "quick-session-name")[0].textContent, "＋ New session in the terminal");
  assert.strictEqual(byClass(items[5], "quick-session-name")[0].textContent, "📁 Choose a folder…");
});

test("quick panel: 新建会话那一行与选文件夹那一行都写明当前目录", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({
    listOpen: true, canCreateSession: true, sessions: [],
    newSessionFolder: "~/Documents/谱子", newSessionFolderName: "谱子",
  });
  assert.strictEqual(
    byClass(hud.one("quick-session-create"), "quick-session-meta")[0].textContent,
    "位置：谱子",
    "点之前就要看得出新会话开在哪儿"
  );
  const folderRow = hud.one("quick-session-folder");
  assert.strictEqual(byClass(folderRow, "quick-session-name")[0].textContent, "📁 选择文件夹…");
  assert.strictEqual(byClass(folderRow, "quick-session-meta")[0].textContent, "~/Documents/谱子");

  // 主进程还没给目录时，那一行只画标题，不画空的小字
  hud.pushQuickState({ listOpen: true, canCreateSession: true, sessions: [] });
  assert.strictEqual(byClass(hud.one("quick-session-create"), "quick-session-meta").length, 0);
  assert.strictEqual(byClass(hud.one("quick-session-folder"), "quick-session-meta").length, 0);
});

test("quick panel: 权限与强度两排按钮按当前档高亮", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({
    listOpen: true,
    canCreateSession: true,
    sessions: [],
    permissionMode: "acceptEdits",
    effort: "xhigh",
  });

  const rows = hud.find("quick-setting-row");
  assert.strictEqual(rows.length, 2, "权限一排、强度一排");
  const chipsText = (row) => byClass(row, "quick-chip").map((chip) => chip.textContent);
  assert.deepStrictEqual(chipsText(rows[0]), ["自动", "手动", "自动编辑", "计划"]);
  assert.deepStrictEqual(chipsText(rows[1]), ["低", "中", "高", "极高", "最大"]);
  assert.strictEqual(byClass(rows[0], "quick-setting-label")[0].textContent, "权限");
  assert.strictEqual(byClass(rows[1], "quick-setting-label")[0].textContent, "强度");

  const selected = (row) => byClass(row, "quick-chip")
    .filter((chip) => chip.classList.contains("is-selected"))
    .map((chip) => chip.textContent);
  assert.deepStrictEqual(selected(rows[0]), ["自动编辑"]);
  assert.deepStrictEqual(selected(rows[1]), ["极高"]);
});

test("quick panel: 点权限/强度按钮 → 把键和值交给主进程", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({ listOpen: true, canCreateSession: true, sessions: [] });
  const rows = hud.find("quick-setting-row");

  await byClass(rows[0], "quick-chip")[3].dispatch("click"); // 计划
  await byClass(rows[1], "quick-chip")[4].dispatch("click"); // 最大
  await flush();

  assert.deepStrictEqual(hud.calls.setNewSessionOption, [
    ["permissionMode", "plan"],
    ["effort", "max"],
  ]);
});

test("quick panel: 两排开关排在新建会话下面、选文件夹上面", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({
    listOpen: true, canCreateSession: true, sessions: [],
    newSessionFolder: "~", newSessionFolderName: "~",
  });
  const order = [...hud.one("quick-session-list").children].map((node) => node.className);
  assert.deepStrictEqual(order, [
    "quick-session-item quick-session-create",
    "quick-setting-row",
    "quick-setting-row",
    "quick-session-item quick-session-folder",
  ]);
});

test("quick panel: 新建会话那一行把当前两个开关也写出来", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({
    listOpen: true, canCreateSession: true, sessions: [],
    newSessionFolderName: "谱子", permissionMode: "plan", effort: "high",
  });
  assert.strictEqual(
    byClass(hud.one("quick-session-create"), "quick-session-meta")[0].textContent,
    "位置：谱子 · 计划 · 强度：高"
  );

  hud.pushQuickState({
    listOpen: true, canCreateSession: true, sessions: [],
    newSessionFolderName: "谱子", permissionMode: "default", effort: "default",
  });
  assert.strictEqual(
    byClass(hud.one("quick-session-create"), "quick-session-meta")[0].textContent,
    "位置：谱子",
    "默认档不提，省得那行太长"
  );
});

test("quick panel: 切开关失败时如实提示", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    setOptionThrows: true,
  });
  hud.pushQuickState({ listOpen: true, canCreateSession: true, sessions: [] });
  await byClass(hud.find("quick-setting-row")[1], "quick-chip")[1].dispatch("click");
  await flush();
  assert.strictEqual(hud.one("quick-status-text").textContent, "切换失败");
  assert.ok(hud.one("quick-status-text").classList.contains("is-error"));
});

test("quick panel: 点选文件夹 → 调主进程，列表保持展开", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  hud.pushQuickState({ listOpen: true, canCreateSession: true, sessions: [], newSessionFolder: "~" });
  await hud.one("quick-session-folder").dispatch("click");
  await flush();
  assert.strictEqual(hud.calls.pickFolder, 1);
  assert.deepStrictEqual(hud.calls.setListOpen, [], "选完不收起：用户接着要点新建会话");
  assert.ok(!hud.one("quick-status-text").classList.contains("is-error"), "取消选择不该报错");
});

test("quick panel: 文件夹选择框打不开（含抛错）时如实提示", async () => {
  const failed = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pickFolderResult: { status: "error" },
  });
  failed.pushQuickState({ listOpen: true, canCreateSession: true, sessions: [] });
  await failed.one("quick-session-folder").dispatch("click");
  await flush();
  assert.strictEqual(failed.one("quick-status-text").textContent, "没能打开文件夹选择框");
  assert.ok(failed.one("quick-status-text").classList.contains("is-error"));

  const threw = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pickFolderThrows: true,
  });
  threw.pushQuickState({ listOpen: true, canCreateSession: true, sessions: [] });
  await threw.one("quick-session-folder").dispatch("click");
  await flush();
  assert.strictEqual(threw.one("quick-status-text").textContent, "没能打开文件夹选择框");
});

test("quick panel: 点某条会话 → 选中它并收起列表", async () => {
  const hud = await loadHud();
  hud.pushQuickState({
    canSend: true, targetTitle: "x", listOpen: true,
    sessions: [{ id: "s9", title: "目标", state: "working", active: true }],
  });
  await hud.find("quick-session-item")[0].dispatch("click");
  await flush();
  assert.deepStrictEqual(hud.calls.selectSession, ["s9"]);
  assert.deepStrictEqual(hud.calls.setListOpen, [false]);
});

test("quick panel: 点新建会话 → 只排一个位，不开终端、也不收列表", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    newSessionResult: { status: "ok", textKey: "hudNewSessionQueued" },
  });
  hud.pushQuickState({ listOpen: true, canCreateSession: true, sessions: [] });
  await hud.find("quick-session-create")[0].dispatch("click");
  await flush();
  assert.strictEqual(hud.calls.newSession, 1);
  assert.strictEqual(hud.one("quick-status-text").textContent, "已排好，发消息时会在终端里打开");
  assert.deepStrictEqual(hud.calls.setListOpen, [], "列表留着，用户得看见刚排出来的那一行");
});

test("quick panel: 新建会话失败时如实提示", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    newSessionResult: { status: "error", textKey: "hudNewSessionFailed" },
  });
  hud.pushQuickState({ listOpen: true, canCreateSession: true, sessions: [] });
  await hud.find("quick-session-create")[0].dispatch("click");
  await flush();
  assert.strictEqual(hud.one("quick-status-text").textContent, "新建会话失败");
  assert.ok(hud.one("quick-status-text").classList.contains("is-error"));
});

test("quick panel: Esc 只收会话列表", async () => {
  const hud = await loadHud();
  await hud.document.dispatch("keydown", { key: "Escape" });
  assert.deepStrictEqual(hud.calls.setListOpen, [], "没展开时按 Esc 什么都不做");

  hud.pushQuickState({ listOpen: true, canCreateSession: true, sessions: [] });
  await hud.document.dispatch("keydown", { key: "Escape" });
  assert.deepStrictEqual(hud.calls.setListOpen, [false]);
});

// ── 加文件：📎 选文件 / ⌘V 粘贴 ──

test("quick panel: 一加载就把附件数报成 0，免得主进程留着上次的数字", async () => {
  const hud = await loadHud();
  // 数字对不上会让卡片一直偏高，而且面板再也不自动收起（主进程拿它当「别收」的理由）
  assert.deepStrictEqual(hud.startupCalls.setAttachments, [0]);
  assert.deepStrictEqual(hud.startupCalls.setHold, [["draft", false]]);
});

test("quick panel: 点 📎 → 文件变成标签，输入框干干净净", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pickFilesResult: { status: "ok", paths: ["/tmp/一张图.png", "/tmp/my score.pdf"] },
  });
  const input = hud.one("quick-input");
  input.value = "看看这个";

  await hud.one("quick-attach-btn").dispatch("click");
  await flush();

  assert.strictEqual(hud.calls.pickFiles, 1);
  assert.strictEqual(input.value, "看看这个", "路径不许再塞进输入框");
  const chips = hud.find("quick-attach-chip");
  assert.strictEqual(chips.length, 2);
  assert.deepStrictEqual(
    hud.find("quick-attach-name").map((el) => el.textContent),
    ["一张图.png", "my score.pdf"],
    "标签上只显示文件名"
  );
  assert.strictEqual(chips[1].title, "/tmp/my score.pdf", "完整路径留作悬停提示");
  assert.deepStrictEqual(hud.calls.setAttachments, [2], "要把数量报给主进程（卡片高度）");
  assert.ok(hud.document.body.classList.contains("has-attachments"));
  assert.deepStrictEqual(hud.calls.setHold.at(-1), ["draft", true], "还挂着东西，面板别收");
});

test("quick panel: 取消选文件什么都不做，失败才提示", async () => {
  const canceled = await loadHud({ pickFilesResult: { status: "canceled" } });
  canceled.one("quick-input").value = "";
  await canceled.one("quick-attach-btn").dispatch("click");
  await flush();
  assert.strictEqual(canceled.find("quick-attach-chip").length, 0);
  assert.ok(!canceled.one("quick-status-text").classList.contains("is-error"), "取消不是错误");

  const failed = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pickFilesResult: { status: "error" },
  });
  await failed.one("quick-attach-btn").dispatch("click");
  await flush();
  assert.strictEqual(failed.one("quick-status-text").textContent, "没能打开文件选择框");

  const threw = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pickFilesThrows: true,
  });
  await threw.one("quick-attach-btn").dispatch("click");
  await flush();
  assert.strictEqual(threw.one("quick-status-text").textContent, "没能打开文件选择框");
});

// 造一个跟浏览器里形状一致的粘贴事件（总是夹一个纯文字项：它不该被当成文件）
function pasteEvent(files) {
  // 假 DOM 的 dispatch 会把事件复制一份再交给监听器，所以标记写在闭包里的
  // 共享状态上，测试读的也是它。
  const state = { prevented: false };
  const event = {
    state,
    clipboardData: {
      items: files.map((file) => ({
        kind: "file",
        getAsFile: () => file,
      })).concat([{ kind: "string", getAsFile: () => null }]),
    },
  };
  event.preventDefault = () => { state.prevented = true; };
  return event;
}

function fakeFile(name, type, bytes) {
  return {
    name,
    type,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

test("quick panel: 粘贴截图 → 存成临时文件，变成标签", async () => {
  const hud = await loadHud({ i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS } });
  const input = hud.one("quick-input");
  const event = pasteEvent([fakeFile("图片.png", "image/png", [1, 2, 3])]);

  await input.dispatch("paste", event);
  await flush();

  assert.ok(event.state.prevented, "处理了文件就该拦掉浏览器默认行为");
  assert.strictEqual(hud.calls.savePastedFile.length, 1);
  assert.strictEqual(hud.calls.savePastedFile[0].type, "image/png");
  assert.strictEqual(hud.calls.savePastedFile[0].data.byteLength, 3);
  assert.strictEqual(input.value, "", "输入框里不留路径");
  assert.deepStrictEqual(
    hud.find("quick-attach-name").map((el) => el.textContent),
    ["paste-1.png"]
  );
});

test("quick panel: 剪贴板里是从 Finder 拷的文件 → 直接用它的真实路径，不复制一份", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pathForFile: () => "/Users/nathuris/Desktop/我的 谱子.pdf",
  });
  const input = hud.one("quick-input");
  await input.dispatch("paste", pasteEvent([fakeFile("我的 谱子.pdf", "application/pdf", [1])]));
  await flush();

  assert.strictEqual(hud.calls.savePastedFile.length, 0, "有路径就不用落临时文件");
  assert.strictEqual(hud.find("quick-attach-chip")[0].title, "/Users/nathuris/Desktop/我的 谱子.pdf");
  assert.strictEqual(input.value, "");
});

test("quick panel: 粘贴纯文字不动它，交给浏览器自己插进输入框", async () => {
  const hud = await loadHud();
  const input = hud.one("quick-input");
  const event = pasteEvent([]);
  await input.dispatch("paste", event);
  await flush();
  assert.strictEqual(event.state.prevented, false);
  assert.strictEqual(hud.calls.savePastedFile.length, 0);
});

test("quick panel: 粘贴的文件存不下来时如实提示，也不留下半个附件", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    savePastedResult: { status: "error" },
  });
  const input = hud.one("quick-input");
  await input.dispatch("paste", pasteEvent([fakeFile("图片.png", "image/png", [1])]));
  await flush();
  assert.strictEqual(hud.one("quick-status-text").textContent, "没能保存粘贴的文件");
  assert.ok(hud.one("quick-status-text").classList.contains("is-error"));
  assert.strictEqual(hud.find("quick-attach-chip").length, 0);
});

// ── 附件：删除 / 发送拼装 ──

test("quick panel: 点标签上的 ✕ 只删那一个，并把焦点交回输入框", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pickFilesResult: { status: "ok", paths: ["/tmp/a.png", "/tmp/b.png"] },
  });
  await hud.one("quick-attach-btn").dispatch("click");
  await flush();
  assert.strictEqual(hud.find("quick-attach-chip").length, 2);

  const removeBtn = byClass(hud.find("quick-attach-chip")[0], "quick-attach-remove")[0];
  assert.strictEqual(removeBtn.getAttribute("aria-label"), "移除这个附件");
  await removeBtn.dispatch("click");
  await flush();

  const left = hud.find("quick-attach-chip");
  assert.strictEqual(left.length, 1);
  assert.strictEqual(left[0].title, "/tmp/b.png", "删掉的正好是点的那个");
  assert.deepStrictEqual(hud.calls.setAttachments, [2, 1], "删完要把新数量报上去");

  // 全删光：标签行不占位置、body 摘掉 has-attachments
  await byClass(left[0], "quick-attach-remove")[0].dispatch("click");
  await flush();
  assert.strictEqual(hud.find("quick-attach-chip").length, 0);
  assert.ok(hud.one("quick-attach-row").classList.contains("is-empty"));
  assert.ok(!hud.document.body.classList.contains("has-attachments"));
  assert.deepStrictEqual(hud.calls.setAttachments, [2, 1, 0]);
});

test("quick panel: 发送时把字和路径拼成一条（含空格的加引号）", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pickFilesResult: { status: "ok", paths: ["/tmp/a.png", "/tmp/my b.pdf"] },
  });
  await hud.one("quick-attach-btn").dispatch("click");
  await flush();
  hud.one("quick-input").value = "看看这个";

  await hud.one("quick-input").dispatch("keydown", { key: "Enter" });
  await flush();

  assert.deepStrictEqual(hud.calls.sendPrompt, [
    '看看这个 /tmp/a.png "/tmp/my b.pdf"',
  ]);
  assert.strictEqual(hud.one("quick-input").value, "", "发成功要清空输入框");
  assert.strictEqual(hud.find("quick-attach-chip").length, 0, "发成功要清空附件");
  assert.deepStrictEqual(hud.calls.setAttachments.at(-1), 0);
  assert.strictEqual(hud.one("quick-status-text").textContent, "已发送到终端");
});

test("quick panel: 只挂附件不写字也能发", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pickFilesResult: { status: "ok", paths: ["/tmp/a.png"] },
  });
  await hud.one("quick-attach-btn").dispatch("click");
  await flush();

  await hud.one("quick-input").dispatch("keydown", { key: "Enter" });
  await flush();

  assert.deepStrictEqual(hud.calls.sendPrompt, ["/tmp/a.png"], "空草稿 + 有附件 = 照发");
});

test("quick panel: 没真送进去（只复制/出错）时，字和附件都留着", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pickFilesResult: { status: "ok", paths: ["/tmp/a.png"] },
    sendPromptResult: { status: "copied", textKey: "hudSendCopied" },
  });
  await hud.one("quick-attach-btn").dispatch("click");
  await flush();
  hud.one("quick-input").value = "这些话";

  await hud.one("quick-input").dispatch("keydown", { key: "Enter" });
  await flush();

  assert.strictEqual(hud.one("quick-input").value, "这些话", "没发出去就别清空");
  assert.strictEqual(hud.find("quick-attach-chip").length, 1, "附件也留着");
});

test("quick panel: 没字也没附件时回车什么都不发", async () => {
  const hud = await loadHud();
  await hud.one("quick-input").dispatch("keydown", { key: "Enter" });
  await flush();
  assert.deepStrictEqual(hud.calls.sendPrompt, []);
});

test("quick panel: 附件最多 4 个，多出来的给提示", async () => {
  const hud = await loadHud({
    i18n: { lang: PANEL_ZH, translations: HUD_ZH_TRANSLATIONS },
    pickFilesResult: { status: "ok", paths: ["/tmp/a", "/tmp/b", "/tmp/c", "/tmp/d", "/tmp/e"] },
  });
  await hud.one("quick-attach-btn").dispatch("click");
  await flush();

  assert.strictEqual(hud.find("quick-attach-chip").length, 4, "上限 4");
  assert.strictEqual(hud.one("quick-status-text").textContent, "最多挂 4 个文件");
});

test("quick panel: 同一个文件挂两遍只算一个", async () => {
  const hud = await loadHud({
    pickFilesResult: { status: "ok", paths: ["/tmp/a.png"] },
  });
  await hud.one("quick-attach-btn").dispatch("click");
  await flush();
  await hud.one("quick-attach-btn").dispatch("click");
  await flush();
  assert.strictEqual(hud.find("quick-attach-chip").length, 1);
});

test("quick panel: 切语言不重建输入框，标签的 ✕ 提示语跟着换", async () => {
  const hud = await loadHud();
  await hud.one("quick-attach-btn").dispatch("click");
  await flush();
  const input = hud.one("quick-input");
  const chipCount = hud.find("quick-attach-chip").length;

  hud.pushLang({ lang: "zh", translations: HUD_ZH_TRANSLATIONS });

  assert.strictEqual(hud.one("quick-input"), input, "输入框节点要复用");
  assert.strictEqual(hud.find("quick-attach-chip").length, chipCount);
  assert.strictEqual(
    byClass(hud.find("quick-attach-chip")[0], "quick-attach-remove")[0].getAttribute("aria-label"),
    "移除这个附件"
  );
});

test("click through: 只有内外切换时才上报", async () => {
  const hud = await loadHud();
  hud.setCardRect({ left: 0, top: 0, right: 300, bottom: 66 });
  await hud.document.dispatch("mousemove", { clientX: 500, clientY: 500 }); // 卡片外
  await hud.document.dispatch("mousemove", { clientX: 10, clientY: 10 });   // 卡片内
  await hud.document.dispatch("mousemove", { clientX: 20, clientY: 20 });   // 仍在卡片内
  assert.deepStrictEqual(hud.calls.setClickThrough, [true, false]);
});

test("面板新文案在 7 种语言里都齐全", () => {
  for (const lang of SUPPORTED_LANGS) {
    for (const key of [
      "hudQuickPlaceholder", "hudQuickSendingTo", "hudQuickStatusIdle",
      "hudQuickStatusWorking", "hudQuickSendFailed", "hudSendSent",
      "hudSendCopied", "hudSendNeedsPermission", "hudSendNoSession",
    ]) {
      assert.ok(i18n[lang][key], `${lang}.${key} is required`);
    }
  }
});


test("渲染端用到的每个 hud 文案键，7 种语言里都真的存在", () => {
  // 渲染端要的键从源码里现抓，不手抄一份——漏加一个键，面板会把键名
  // 原样显示给用户（"hudQuickXxx" 这种），这种事故只有源码对得上才发现得了。
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8");
  const keys = new Set();
  for (const match of src.matchAll(/"(hud[A-Za-z0-9]+)"/g)) keys.add(match[1]);
  assert.ok(keys.size >= 20, `只抓到 ${keys.size} 个键，抓法大概过期了`);

  // 主进程回给面板的 textKey 同样是文案键，一并卡住。
  for (const key of [
    "hudSendSent", "hudSendNoSession", "hudSendCopied", "hudSendNeedsPermission",
    "hudQuickSendFailed", "hudNewSessionOpened", "hudNewSessionFailed",
  ]) {
    keys.add(key);
  }

  for (const lang of SUPPORTED_LANGS) {
    for (const key of keys) assert.ok(i18n[lang][key], `${lang}.${key} is required`);
  }
});

test("unfocusable and folder feedback copy exists in all supported languages", () => {
  const keys = [
    "dashboardOpenFolder",
    "sessionOpenFolderFailed",
    "sessionOpenFolderUnavailable",
    "sessionFocusUnavailableRemote",
    "sessionFocusUnavailableWebui",
    "sessionFocusUnavailableMissingTerminalInfo",
  ];
  for (const lang of SUPPORTED_LANGS) {
    for (const key of keys) assert.ok(i18n[lang][key], `${lang}.${key} is required`);
  }
});

test("Dashboard shows a model row only for sessions that report one", async () => {
  const { root } = await loadDashboard([
    session("with-model", { model: "claude-opus-5" }),
    session("without-model"),
  ]);

  const rows = byClass(root, "model-row");
  assert.strictEqual(rows.length, 1, "only the session reporting a model gets a row");
  assert.strictEqual(rows[0].textContent, "Model: claude-opus-5");
  // Long ids are ellipsized by CSS, so the full value must stay reachable.
  assert.strictEqual(rows[0].title, "claude-opus-5");
});

test("model row is its own line, not a chip inside the clipped meta row", async () => {
  // Regression guard: `.meta` is a single nowrap+overflow-hidden line, so a
  // model appended there is invisible at the dashboard's default 480px width.
  const { root } = await loadDashboard([session("with-model", { model: "claude-opus-5" })]);

  const meta = byClass(root, "meta")[0];
  assert.ok(meta, "meta row must still render");
  assert.ok(
    !descendants(meta).some((el) => String(el.textContent || "").includes("claude-opus-5")),
    "the model must not live inside the clipped meta row"
  );
  assert.strictEqual(byClass(root, "model-row").length, 1);
});

test("model copy exists in all supported languages", () => {
  for (const lang of SUPPORTED_LANGS) {
    assert.ok(i18n[lang].dashboardModel, `${lang}.dashboardModel is required`);
  }
});
