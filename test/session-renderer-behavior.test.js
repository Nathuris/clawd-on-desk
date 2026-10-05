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
    hudQuickStatusIdle: "Idle",
    hudQuickStatusWorking: "Working",
    hudQuickStatusError: "Error",
    hudQuickQueued: "{n} queued",
    hudQuickNoCwd: "Pick a working folder first",
    hudQuickPickFolder: "Pick folder…",
    hudQuickStop: "Stop",
    hudQuickSendFailed: "Send failed",
    hudQuickQueueFull: "Queue full",
    chatEffortLabel: "Effort",
    chatModeLabel: "Permission mode",
    chatEffortLow: "Low",
    chatEffortMedium: "Medium",
    chatEffortHigh: "High",
    chatEffortXhigh: "Very high",
    chatEffortMax: "Max",
    chatModeDefault: "Manual",
    chatModeAcceptEdits: "Auto-edit",
    chatModePlan: "Plan",
    chatModeAuto: "Auto",
    chatModeDefaultDesc: "Asks before risky operations do",
    chatModeAcceptEditsDesc: "File edits go through, the rest still asks",
    chatModePlanDesc: "Plans only — runs nothing",
    chatModeAutoDesc: "A model classifier approves actions",
    ...overrides,
  };
}

const HUD_ZH_TRANSLATIONS = hudTranslations({
  hudQuickPlaceholder: "输入消息，回车发送…",
  hudQuickStatusIdle: "空闲",
  hudQuickStatusWorking: "工作中",
  hudQuickStatusError: "出错",
  hudQuickQueued: "已排队 {n}",
  hudQuickNoCwd: "先选择工作文件夹",
  hudQuickPickFolder: "选文件夹…",
  hudQuickStop: "停止",
  hudQuickSendFailed: "发送失败",
  hudQuickQueueFull: "队列已满",
  chatEffortLabel: "强度",
  chatModeLabel: "权限模式",
  chatEffortLow: "低",
  chatEffortMedium: "中",
  chatEffortHigh: "高",
  chatEffortXhigh: "很高",
  chatEffortMax: "最大",
  chatModeDefault: "手动",
  chatModeAcceptEdits: "自动编辑",
  chatModePlan: "计划",
  chatModeAuto: "自动",
  chatModeDefaultDesc: "危险操作前会先询问你",
  chatModeAcceptEditsDesc: "文件修改自动放行，其余仍会询问",
  chatModePlanDesc: "只做方案，不执行任何操作",
  chatModeAutoDesc: "由模型自动判断并放行",
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
    setEffort: [],
    setPermissionMode: [],
    setMenuOpen: [],
    setClickThrough: [],
    pickWorkingDir: 0,
    stopChat: 0,
    setHold: [],
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
    setEffort: async (value) => {
      calls.setEffort.push(value);
      if (options.setEffortThrows) throw new Error("set effort failed");
      return typeof options.setEffortResult === "function"
        ? options.setEffortResult(value)
        : (options.setEffortResult || { status: "ok" });
    },
    setPermissionMode: async (value) => {
      calls.setPermissionMode.push(value);
      if (options.setPermissionModeThrows) throw new Error("set permission mode failed");
      return typeof options.setPermissionModeResult === "function"
        ? options.setPermissionModeResult(value)
        : (options.setPermissionModeResult || { status: "ok" });
    },
    setMenuOpen: async (open) => {
      calls.setMenuOpen.push(open);
      if (options.setMenuOpenThrows) throw new Error("set menu open failed");
      return options.setMenuOpenResult || { status: "ok" };
    },
    // 与 preload 一致：同步 send，不返回 Promise。
    setClickThrough: (through) => {
      calls.setClickThrough.push(through);
      if (options.setClickThroughThrows) throw new Error("set click through failed");
    },
    pickWorkingDir: async () => {
      calls.pickWorkingDir += 1;
      return options.pickWorkingDirResult || { status: "canceled" };
    },
    stopChat: async () => {
      calls.stopChat += 1;
      return { status: "ok" };
    },
    setHold: (reason, held) => { calls.setHold.push([reason, held]); },
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
  return {
    document,
    root,
    calls,
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

/* ===== 快捷面板：单窗口整卡结构 ===== */

test("quick panel: idle default shows Idle, hides the stop button and has no selects", async () => {
  const hud = await loadHud();
  assert.strictEqual(hud.one("quick-status-text").textContent, "Idle");
  assert.strictEqual(hud.one("quick-status-text").classList.contains("is-error"), false);
  assert.strictEqual(hud.one("quick-input").placeholder, "Type a message, Enter to send…");
  assert.strictEqual(hud.one("quick-stop-btn").style.display, "none");
  assert.strictEqual(hud.one("quick-stop-btn").getAttribute("aria-label"), "Stop");
  assert.strictEqual(hud.find("quick-card").length, 1, "one card holds the whole panel");
  assert.strictEqual(hud.byTag("select").length, 0, "the old two-select layout is gone");
});

test("quick panel: builds status / level / menu / folder / input rows in order", async () => {
  const hud = await loadHud();
  const card = hud.one("quick-card");
  assert.deepStrictEqual(card.children.map((child) => child.className), [
    "quick-status-row",
    "quick-level-btn",
    "quick-menu",
    "quick-folder-btn",
    "quick-input-row",
  ]);
  assert.strictEqual(hud.find("quick-level-label").length, 1);
  assert.strictEqual(hud.find("quick-level-caret").length, 1);
  assert.strictEqual(hud.one("quick-folder-label").textContent, "Pick folder…");
});

test("quick panel: the menu lists four modes with names and descriptions plus the effort slider", async () => {
  const hud = await loadHud();
  const options = hud.find("quick-mode-option");
  assert.strictEqual(options.length, 4);
  assert.deepStrictEqual(
    options.map((el) => byClass(el, "quick-mode-name")[0].textContent),
    ["Manual", "Auto-edit", "Plan", "Auto"]
  );
  assert.deepStrictEqual(
    options.map((el) => byClass(el, "quick-mode-desc")[0].textContent),
    [
      "Asks before risky operations do",
      "File edits go through, the rest still asks",
      "Plans only — runs nothing",
      "A model classifier approves actions",
    ]
  );
  const range = hud.one("quick-effort-range");
  assert.strictEqual(range.type, "range");
  assert.strictEqual(range.min, "0");
  assert.strictEqual(range.max, "4");
  assert.strictEqual(range.step, "1");
  assert.strictEqual(range.value, "1", "medium is the default effort");
  assert.strictEqual(hud.one("quick-effort-label").textContent, "Effort");
  assert.strictEqual(hud.one("quick-effort-value").textContent, "Medium");
  assert.strictEqual(range.getAttribute("aria-label"), "Effort");
});

test("quick panel: menuOpen follows the pushed state on the body class", async () => {
  const hud = await loadHud();
  assert.strictEqual(hud.document.body.classList.contains("menu-open"), false);
  hud.pushQuickState({ menuOpen: true });
  assert.strictEqual(hud.document.body.classList.contains("menu-open"), true);
  hud.pushQuickState({ menuOpen: false });
  assert.strictEqual(hud.document.body.classList.contains("menu-open"), false);
});

test("quick panel: the level button reads mode · effort and toggles the menu", async () => {
  const hud = await loadHud();
  hud.pushQuickState({ permissionMode: "auto", effort: "high" });
  const button = hud.one("quick-level-btn");
  assert.strictEqual(hud.one("quick-level-label").textContent, "Auto · High");
  assert.strictEqual(button.getAttribute("aria-label"), "Permission mode · Effort");
  assert.strictEqual(button.title, "Permission mode · Effort");

  await button.dispatch("click");
  assert.deepStrictEqual(hud.calls.setMenuOpen, [true]);
  hud.pushQuickState({ menuOpen: true });
  await button.dispatch("click");
  assert.deepStrictEqual(hud.calls.setMenuOpen, [true, false]);
});

test("quick panel: the active mode follows state and picking a mode sends setPermissionMode", async () => {
  const hud = await loadHud();
  hud.pushQuickState({ permissionMode: "plan" });
  const options = hud.find("quick-mode-option");
  const active = () => options.filter((el) => el.classList.contains("is-active"));
  assert.strictEqual(active().length, 1);
  assert.strictEqual(byClass(active()[0], "quick-mode-name")[0].textContent, "Plan");

  await options[3].dispatch("click");
  assert.deepStrictEqual(hud.calls.setPermissionMode, ["auto"]);
  // 点当前项不发请求，高亮也仍只由状态推送驱动
  await options[2].dispatch("click");
  assert.deepStrictEqual(hud.calls.setPermissionMode, ["auto"]);
  assert.strictEqual(active().length, 1);
  assert.strictEqual(byClass(active()[0], "quick-mode-name")[0].textContent, "Plan");
});

test("quick panel: a failed mode pick leaves the highlight untouched", async () => {
  const hud = await loadHud({ setPermissionModeResult: { status: "error" } });
  hud.pushQuickState({ permissionMode: "plan" });
  const options = hud.find("quick-mode-option");
  await options[3].dispatch("click");
  await flush();
  assert.deepStrictEqual(hud.calls.setPermissionMode, ["auto"]);
  const active = options.filter((el) => el.classList.contains("is-active"));
  assert.strictEqual(active.length, 1);
  assert.strictEqual(byClass(active[0], "quick-mode-name")[0].textContent, "Plan");
  assert.ok(hud.warnings.some(([level]) => level === "warn"));
});

test("quick panel: the slider follows effort and locks while busy or queued", async () => {
  const hud = await loadHud();
  const range = hud.one("quick-effort-range");
  assert.strictEqual(range.value, "1");
  hud.pushQuickState({ effort: "xhigh" });
  assert.strictEqual(range.value, "3");
  assert.strictEqual(hud.one("quick-effort-value").textContent, "Very high");

  hud.pushQuickState({ busy: true });
  assert.strictEqual(range.disabled, true);
  hud.pushQuickState({ busy: false, queuedCount: 2 });
  assert.strictEqual(range.disabled, true);
  hud.pushQuickState({ busy: false, queuedCount: 0 });
  assert.strictEqual(range.disabled, false);
});

test("quick panel: sliding updates only the label, releasing commits setEffort", async () => {
  const hud = await loadHud();
  const range = hud.one("quick-effort-range");
  range.value = "4";
  await range.dispatch("input");
  assert.deepStrictEqual(hud.calls.setEffort, [], "dragging never sends a request");
  assert.strictEqual(hud.one("quick-effort-value").textContent, "Max");

  await range.dispatch("change");
  await flush();
  assert.deepStrictEqual(hud.calls.setEffort, ["max"]);

  // 生效值没变就不重复发
  hud.pushQuickState({ effort: "max" });
  await range.dispatch("change");
  await flush();
  assert.deepStrictEqual(hud.calls.setEffort, ["max"]);
});

test("quick panel: a push during a drag cannot move the thumb and a failed commit rolls back", async () => {
  const dragging = await loadHud();
  const dragRange = dragging.one("quick-effort-range");
  dragRange.value = "4";
  await dragRange.dispatch("input");
  dragging.pushQuickState({ effort: "low" });
  assert.strictEqual(dragRange.value, "4", "a push mid-drag must not steal the slider");
  assert.strictEqual(dragging.one("quick-effort-value").textContent, "Max");
  await dragRange.dispatch("change");
  await flush();
  assert.deepStrictEqual(dragging.calls.setEffort, ["max"]);

  const failing = await loadHud({ setEffortResult: { status: "error" } });
  const failRange = failing.one("quick-effort-range");
  failRange.value = "2";
  await failRange.dispatch("input");
  await failRange.dispatch("change");
  await flush();
  assert.deepStrictEqual(failing.calls.setEffort, ["high"]);
  assert.strictEqual(failRange.value, "1", "a failed commit rolls the thumb back");
  assert.strictEqual(failing.one("quick-effort-value").textContent, "Medium");
  assert.ok(failing.warnings.some(([level]) => level === "warn"));
});

test("quick panel: Escape closes an open menu only", async () => {
  const hud = await loadHud();
  await hud.document.dispatch("keydown", { key: "Escape" });
  assert.deepStrictEqual(hud.calls.setMenuOpen, [], "a closed menu ignores Escape");

  hud.pushQuickState({ menuOpen: true });
  const event = await hud.document.dispatch("keydown", { key: "Escape" });
  await flush();
  assert.deepStrictEqual(hud.calls.setMenuOpen, [false]);
  assert.strictEqual(event.defaultPrevented, true);
});

/* ===== 快捷面板：指针进出卡片的点击穿透 ===== */

test("click through: pointer moves report only when the inside/outside side changes", async () => {
  const hud = await loadHud();
  hud.setCardRect({ left: 0, top: 0, right: 300, bottom: 130 });
  await hud.document.dispatch("mousemove", { clientX: 500, clientY: 500 }); // 卡片外
  await hud.document.dispatch("mousemove", { clientX: 10, clientY: 10 });   // 卡片内
  await hud.document.dispatch("mousemove", { clientX: 20, clientY: 20 });   // 仍在卡片内
  assert.deepStrictEqual(hud.calls.setClickThrough, [true, false]);
});

test("click through: the card rect follows the menu height so the same point flips inside", async () => {
  const hud = await loadHud();
  hud.setCardRect({ left: 0, top: 0, right: 300, bottom: 130 }); // 收起态
  await hud.document.dispatch("mousemove", { clientX: 150, clientY: 200 }); // 在收起卡片下方
  assert.deepStrictEqual(hud.calls.setClickThrough, [true]);

  hud.pushQuickState({ menuOpen: true });
  hud.setCardRect({ left: 0, top: 0, right: 300, bottom: 316 }); // 展开态
  await hud.document.dispatch("mousemove", { clientX: 150, clientY: 200 }); // 同一点落进卡片内
  assert.deepStrictEqual(hud.calls.setClickThrough, [true, false]);
});

/* ===== 快捷面板：状态行与输入行 ===== */

test("quick panel: busy shows Working with the queue count and a stop button that stops chat", async () => {
  const hud = await loadHud();
  hud.pushQuickState({ busy: true, queuedCount: 2 });
  assert.strictEqual(hud.one("quick-status-text").textContent, "Working · 2 queued");
  const stopButton = hud.one("quick-stop-btn");
  assert.strictEqual(stopButton.style.display, "");
  await stopButton.dispatch("click");
  assert.strictEqual(hud.calls.stopChat, 1);

  hud.pushQuickState({ busy: false, queuedCount: 0 });
  assert.strictEqual(hud.one("quick-status-text").textContent, "Idle");
  assert.strictEqual(hud.one("quick-stop-btn").style.display, "none");
});

test("quick panel: a missing working folder blocks sending with its own copy", async () => {
  const hud = await loadHud();
  hud.pushQuickState({ blocked: "no-cwd" });
  assert.strictEqual(hud.one("quick-status-text").textContent, "Pick a working folder first");
});

test("quick panel: an error status paints the Error copy", async () => {
  const hud = await loadHud();
  hud.pushQuickState({ status: "error" });
  assert.strictEqual(hud.one("quick-status-text").textContent, "Error");
  assert.strictEqual(hud.one("quick-status-text").classList.contains("is-error"), true);
});

test("quick panel: Enter sends, an accepted prompt clears the field and releases the draft hold", async () => {
  const hud = await loadHud();
  const input = hud.one("quick-input");
  input.value = "hi";
  const event = await input.dispatch("keydown", { key: "Enter" });
  assert.strictEqual(event.defaultPrevented, true);
  await flush();
  assert.deepStrictEqual(hud.calls.sendPrompt, ["hi"]);
  assert.strictEqual(input.value, "");
  assert.deepStrictEqual(hud.calls.setHold, [["draft", false]]);
});

test("quick panel: a queued prompt clears the field just like an accepted one", async () => {
  const hud = await loadHud({ sendPromptResult: { status: "queued" } });
  const input = hud.one("quick-input");
  input.value = "hi";
  await input.dispatch("keydown", { key: "Enter" });
  await flush();
  assert.deepStrictEqual(hud.calls.sendPrompt, ["hi"]);
  assert.strictEqual(input.value, "");
  assert.deepStrictEqual(hud.calls.setHold, [["draft", false]]);
});

test("quick panel: a full queue keeps the text and the notice clears after the 4s timer", async () => {
  const hud = await loadHud({ sendPromptResult: { status: "full" } });
  const input = hud.one("quick-input");
  input.value = "hi";
  await input.dispatch("keydown", { key: "Enter" });
  await flush();
  assert.strictEqual(hud.one("quick-status-text").textContent, "Queue full");
  assert.strictEqual(hud.one("quick-status-text").classList.contains("is-error"), true);
  assert.strictEqual(input.value, "hi");
  assert.deepStrictEqual(hud.pendingTimerDelays(), [4000]);
  hud.fireTimers();
  assert.strictEqual(hud.one("quick-status-text").textContent, "Idle");
  assert.strictEqual(hud.one("quick-status-text").classList.contains("is-error"), false);
  assert.strictEqual(input.value, "hi");
});

test("quick panel: a failed send keeps the text and shows the failure notice", async () => {
  const rejected = await loadHud({ sendPromptResult: { status: "error" } });
  const rejectedInput = rejected.one("quick-input");
  rejectedInput.value = "hi";
  await rejectedInput.dispatch("keydown", { key: "Enter" });
  await flush();
  assert.strictEqual(rejected.one("quick-status-text").textContent, "Send failed");
  assert.strictEqual(rejectedInput.value, "hi");

  const thrown = await loadHud({ sendPromptThrows: true });
  const thrownInput = thrown.one("quick-input");
  thrownInput.value = "hi";
  await thrownInput.dispatch("keydown", { key: "Enter" });
  await flush();
  assert.strictEqual(thrown.one("quick-status-text").textContent, "Send failed");
  assert.strictEqual(thrownInput.value, "hi");
  assert.ok(
    thrown.warnings.some(([level]) => level === "warn"),
    "a thrown send is caught and logged"
  );
});

test("quick panel: IME composition Enter never sends", async () => {
  const hud = await loadHud();
  const input = hud.one("quick-input");
  input.value = "hi";
  await input.dispatch("keydown", { key: "Enter", isComposing: true });
  await input.dispatch("keydown", { key: "Enter", keyCode: 229 });
  assert.deepStrictEqual(hud.calls.sendPrompt, []);
  await input.dispatch("keydown", { key: "Enter" });
  await flush();
  assert.deepStrictEqual(hud.calls.sendPrompt, ["hi"], "a plain Enter still sends");
});

test("quick panel: blank and whitespace-only drafts are never sent", async () => {
  const hud = await loadHud();
  const input = hud.one("quick-input");
  input.value = "   ";
  await input.dispatch("keydown", { key: "Enter" });
  input.value = "";
  await input.dispatch("keydown", { key: "Enter" });
  assert.deepStrictEqual(hud.calls.sendPrompt, []);
});

test("quick panel: focus and draft holds follow focus and input emptiness", async () => {
  const hud = await loadHud();
  const input = hud.one("quick-input");
  await input.dispatch("focus");
  await input.dispatch("blur");
  input.value = "draft";
  await input.dispatch("input");
  input.value = "";
  await input.dispatch("input");
  assert.deepStrictEqual(hud.calls.setHold, [
    ["focus", true],
    ["focus", false],
    ["draft", true],
    ["draft", false],
  ]);
});

test("quick panel: the folder button shows the cwd name and fires pickWorkingDir", async () => {
  const hud = await loadHud();
  const button = hud.one("quick-folder-btn");
  const label = hud.one("quick-folder-label");
  assert.strictEqual(label.textContent, "Pick folder…");
  hud.pushQuickState({ hasCwd: true, cwdName: "my-project" });
  assert.strictEqual(label.textContent, "my-project");
  assert.strictEqual(button.title, "my-project");
  hud.pushQuickState({ hasCwd: false, cwdName: null });
  assert.strictEqual(label.textContent, "Pick folder…");

  await button.dispatch("click");
  assert.strictEqual(hud.calls.pickWorkingDir, 1);
});

/* ===== 快捷面板：语言切换 ===== */

test("quick panel: a language push re-labels every node without rebuilding it", async () => {
  const hud = await loadHud();
  const input = hud.one("quick-input");
  const levelButton = hud.one("quick-level-btn");
  const range = hud.one("quick-effort-range");
  const modeOptions = hud.find("quick-mode-option");
  input.value = "draft text";
  hud.pushQuickState({ permissionMode: "auto", effort: "high" });

  hud.pushLang({ lang: "zh", translations: HUD_ZH_TRANSLATIONS });

  assert.strictEqual(hud.one("quick-input"), input, "the input node is reused");
  assert.strictEqual(hud.one("quick-level-btn"), levelButton, "the level button is reused");
  assert.strictEqual(hud.one("quick-effort-range"), range, "the slider is reused");
  hud.find("quick-mode-option").forEach((el, index) => {
    assert.strictEqual(el, modeOptions[index], "mode rows are reused");
  });
  assert.strictEqual(input.value, "draft text", "the draft survives the language change");
  assert.strictEqual(input.placeholder, "输入消息，回车发送…");
  assert.strictEqual(hud.one("quick-status-text").textContent, "空闲");
  assert.strictEqual(hud.one("quick-stop-btn").getAttribute("aria-label"), "停止");
  assert.strictEqual(hud.one("quick-level-label").textContent, "自动 · 高");
  assert.strictEqual(levelButton.getAttribute("aria-label"), "权限模式 · 强度");
  assert.deepStrictEqual(
    hud.find("quick-mode-option").map((el) => byClass(el, "quick-mode-name")[0].textContent),
    ["手动", "自动编辑", "计划", "自动"]
  );
  assert.deepStrictEqual(
    hud.find("quick-mode-option").map((el) => byClass(el, "quick-mode-desc")[0].textContent),
    ["危险操作前会先询问你", "文件修改自动放行，其余仍会询问", "只做方案，不执行任何操作", "由模型自动判断并放行"]
  );
  assert.strictEqual(hud.one("quick-effort-label").textContent, "强度");
  assert.strictEqual(hud.one("quick-effort-value").textContent, "高");
  assert.strictEqual(range.getAttribute("aria-label"), "强度");
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
