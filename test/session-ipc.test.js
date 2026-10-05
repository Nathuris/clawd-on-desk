"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { registerSessionIpc } = require("../src/session-ipc");
const { SUPPORTED_LANGS } = require("../src/i18n");

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
    this.listeners = new Map();
  }

  handle(channel, listener) {
    this.handlers.set(channel, listener);
  }

  on(channel, listener) {
    this.listeners.set(channel, listener);
  }

  removeHandler(channel) {
    this.handlers.delete(channel);
  }

  removeListener(channel, listener) {
    if (this.listeners.get(channel) === listener) this.listeners.delete(channel);
  }

  invoke(channel, ...args) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }

  invokeFrom(event, channel, ...args) {
    const listener = this.handlers.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener(event, ...args);
  }

  send(channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener({ sender: "sender-web-contents" }, ...args);
  }

  // 指定 event 的 fire-and-forget 调用（信任闸门要用到）。
  sendFrom(event, channel, ...args) {
    const listener = this.listeners.get(channel);
    assert.strictEqual(typeof listener, "function", `missing IPC listener ${channel}`);
    return listener(event, ...args);
  }
}

function createHarness(overrides = {}) {
  const calls = [];
  const ipcMain = new FakeIpcMain();
  const dashboardMainFrame = {
    url: pathToFileURL(path.join(__dirname, "..", "src", "dashboard.html")).toString(),
  };
  // The page's WebContents belongs to a WebContentsView on darwin/win32, so
  // the trust check must resolve it directly and never through a window.
  const dashboardWebContents = {
    mainFrame: dashboardMainFrame,
    isDestroyed: () => false,
  };
  // 悬停快捷面板（session-hud.html）的信任锚点，与 Dashboard 同一形状：
  // 只认自家 HUD 窗口的主 frame + 精确的本地页面 URL。
  const hudMainFrame = {
    url: pathToFileURL(path.join(__dirname, "..", "src", "session-hud.html")).toString(),
  };
  const hudWebContents = {
    mainFrame: hudMainFrame,
    isDestroyed: () => false,
  };
  // 快捷面板的能力注入缝：默认记账进 calls；quickDeps:false 模拟未接线形态。
  const quickDeps = overrides.quickDeps === false
    ? {}
    : {
        quickSendPrompt: overrides.quickSendPrompt
          || ((text) => { calls.push(["quickSendPrompt", text]); return { status: "ok" }; }),
        quickSetEffort: overrides.quickSetEffort
          || ((value) => { calls.push(["quickSetEffort", value]); return { status: "ok" }; }),
        quickSetPermissionMode: overrides.quickSetPermissionMode
          || ((value) => { calls.push(["quickSetPermissionMode", value]); return { status: "ok" }; }),
        quickPickWorkingDir: overrides.quickPickWorkingDir
          || (() => { calls.push(["quickPickWorkingDir"]); return { status: "ok" }; }),
        quickStopChat: overrides.quickStopChat
          || (() => { calls.push(["quickStopChat"]); return { status: "ok" }; }),
        quickSetHold: overrides.quickSetHold
          || ((reason, held) => { calls.push(["quickSetHold", reason, held]); }),
        quickSetMenuOpen: overrides.quickSetMenuOpen
          || ((open) => { calls.push(["quickSetMenuOpen", open]); return { status: "ok" }; }),
      };
  // A supported-platform quick mode by default, so the shared channel set
  // reflects a darwin/win32 install.
  const quickMode = {
    isSupported: () => overrides.quickSupported !== false,
    getPendingRevision: () => 7,
    enter: (payload) => { calls.push(["quickEnter", payload]); return { status: "ok" }; },
    ready: (payload) => { calls.push(["quickReady", payload]); return { status: "ok" }; },
    activate: (payload) => { calls.push(["quickActivate", payload]); return { status: "submitted" }; },
    dismissFromRenderer: (payload) => {
      calls.push(["quickDismiss", payload]);
      return { status: "ok" };
    },
  };
  const runtime = registerSessionIpc({
    ipcMain,
    getSessionSnapshot: overrides.getSessionSnapshot || (() => ({ sessions: [{ id: "s1" }] })),
    getI18n: overrides.getI18n || (() => ({ lang: "en", translations: { title: "Sessions" } })),
    focusSession: overrides.focusSession || ((sessionId, options) => {
      calls.push(["focusSession", sessionId, options]);
    }),
    hideSession: overrides.hideSession || ((sessionId) => {
      calls.push(["hideSession", sessionId]);
      return { status: "ok", hidden: sessionId };
    }),
    setSessionAlias: overrides.setSessionAlias || (async (payload) => {
      calls.push(["setSessionAlias", payload]);
      return { status: "ok", alias: payload.alias };
    }),
    showDashboard: overrides.showDashboard || ((options) => {
      calls.push(["showDashboard", options]);
    }),
    setSessionHudPinned: overrides.setSessionHudPinned || ((value) => {
      calls.push(["setSessionHudPinned", value]);
    }),
    ackSessionCompletion: overrides.ackSessionCompletion || ((sessionId) => {
      calls.push(["ackSessionCompletion", sessionId]);
      return true;
    }),
    openSessionFolder: overrides.openSessionFolder || (async (sessionId) => {
      calls.push(["openSessionFolder", sessionId]);
      return { status: "ok" };
    }),
    setSessionAutomationOverride: overrides.setSessionAutomationOverride || (async (payload, context) => {
      calls.push(["setSessionAutomationOverride", payload, context]);
      return { status: "applied" };
    }),
    clearSessionAutomationGrant: overrides.clearSessionAutomationGrant || ((payload) => {
      calls.push(["clearSessionAutomationGrant", payload]);
      return { status: "applied" };
    }),
    getSessionHistory: overrides.getSessionHistory || (() => {
      calls.push(["getSessionHistory"]);
      return [{ agentId: "claude-code", sessionId: "h1", cwd: "/work" }];
    }),
    resumeSessionFromHistory: overrides.resumeSessionFromHistory || ((payload) => {
      calls.push(["resumeSessionFromHistory", payload]);
      return { status: "ok" };
    }),
    getDashboardWebContents: overrides.getDashboardWebContents
      || (() => dashboardWebContents),
    quickMode: Object.prototype.hasOwnProperty.call(overrides, "quickMode")
      ? overrides.quickMode
      : quickMode,
    getKimiQuotaStatus: overrides.getKimiQuotaStatus || (() => ({
      status: "ok",
      configured: true,
      decryptable: true,
      collectionEnabled: true,
      agentEnabled: true,
    })),
    refreshKimiQuota: overrides.refreshKimiQuota || (() => {
      calls.push(["refreshKimiQuota"]);
      return { status: "ok" };
    }),
    getSessionHudWebContents: overrides.getSessionHudWebContents || (() => hudWebContents),
    ...quickDeps,
  });
  return {
    ipcMain,
    runtime,
    calls,
    trustedDashboardEvent: {
      sender: dashboardWebContents,
      senderFrame: dashboardMainFrame,
    },
    trustedHudEvent: {
      sender: hudWebContents,
      senderFrame: hudMainFrame,
    },
    hudWebContents,
    hudMainFrame,
  };
}

test("session IPC registers owned channels and disposes them", () => {
  const { ipcMain, runtime } = createHarness();

  assert.deepStrictEqual([...ipcMain.handlers.keys()].sort(), [
    "dashboard:clear-session-automation-grant",
    "dashboard:get-i18n",
    "dashboard:get-kimi-quota-status",
    "dashboard:get-session-history",
    "dashboard:get-snapshot",
    "dashboard:hide-session",
    "dashboard:open-session-folder",
    "dashboard:quick-activate",
    "dashboard:quick-dismiss",
    "dashboard:quick-enter",
    "dashboard:quick-pending",
    "dashboard:quick-ready",
    "dashboard:refresh-kimi-quota",
    "dashboard:resume-session",
    "dashboard:set-session-alias",
    "dashboard:set-session-automation",
    "session-hud:get-i18n",
    "session-hud:pick-working-dir",
    "session-hud:send-prompt",
    "session-hud:set-effort",
    "session-hud:set-menu-open",
    "session-hud:set-permission-mode",
    "session-hud:stop-chat",
    "session:ack-completion",
  ]);
  assert.deepStrictEqual([...ipcMain.listeners.keys()].sort(), [
    "dashboard:focus-session",
    "session-hud:set-hold",
    "settings:open-dashboard",
    "show-dashboard",
  ]);

  runtime.dispose();

  assert.strictEqual(ipcMain.handlers.size, 0);
  assert.strictEqual(ipcMain.listeners.size, 0);
});

test("an unsupported platform never registers the keyboard-mode channels", () => {
  const { ipcMain } = createHarness({ quickSupported: false });
  const quickChannels = [...ipcMain.handlers.keys()].filter((c) => c.startsWith("dashboard:quick-"));

  // Not registered at all: there is no capability to reach, rather than a
  // handler that politely answers "unsupported".
  assert.deepStrictEqual(quickChannels, []);
  // The rest of the Dashboard is untouched.
  assert.ok(ipcMain.handlers.has("dashboard:get-snapshot"));
  assert.ok(ipcMain.handlers.has("dashboard:get-kimi-quota-status"));
  assert.ok(ipcMain.listeners.has("dashboard:focus-session"));
});

test("keyword-mode channels reach the owner only from the trusted page", async () => {
  const { ipcMain, calls, trustedDashboardEvent } = createHarness();

  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedDashboardEvent, "dashboard:quick-pending"),
    { status: "ok", revision: 7 }
  );
  await ipcMain.invokeFrom(trustedDashboardEvent, "dashboard:quick-enter", { revision: 7 });
  await ipcMain.invokeFrom(trustedDashboardEvent, "dashboard:quick-ready", { revision: 7 });
  await ipcMain.invokeFrom(
    trustedDashboardEvent,
    "dashboard:quick-activate",
    { sessionId: "s1", revision: 7 }
  );
  await ipcMain.invokeFrom(trustedDashboardEvent, "dashboard:quick-dismiss", { revision: 7 });
  assert.deepStrictEqual(calls.map(([name]) => name), [
    "quickEnter",
    "quickReady",
    "quickActivate",
    "quickDismiss",
  ]);

  // An untrusted sender is refused before the owner is consulted.
  calls.length = 0;
  for (const channel of [
    "dashboard:quick-pending",
    "dashboard:quick-enter",
    "dashboard:quick-ready",
    "dashboard:quick-activate",
    "dashboard:quick-dismiss",
  ]) {
    const result = await ipcMain.invoke(channel, { revision: 7 });
    assert.strictEqual(result.reason, "untrusted-dashboard-sender", channel);
  }
  assert.deepStrictEqual(calls, []);
});

test("session IPC delegates dashboard and HUD behavior", async () => {
  const { ipcMain, calls } = createHarness();

  assert.deepStrictEqual(await ipcMain.invoke("dashboard:get-snapshot"), {
    sessions: [{ id: "s1" }],
  });
  assert.deepStrictEqual(await ipcMain.invoke("dashboard:get-i18n"), {
    lang: "en",
    translations: { title: "Sessions" },
  });
  assert.deepStrictEqual(await ipcMain.invoke("session-hud:get-i18n"), {
    lang: "en",
    translations: { title: "Sessions" },
  });
  ipcMain.send("dashboard:focus-session", "dash-session");
  assert.deepStrictEqual(await ipcMain.invoke("dashboard:hide-session", "hidden-session"), {
    status: "ok",
    hidden: "hidden-session",
  });
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:set-session-alias", { sessionId: "s1", alias: "Frontend" }),
    { status: "ok", alias: "Frontend" }
  );
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:open-session-folder", "folder-session"),
    { status: "ok" }
  );

  assert.deepStrictEqual(calls, [
    ["focusSession", "dash-session", { requestSource: "dashboard" }],
    ["hideSession", "hidden-session"],
    ["setSessionAlias", { sessionId: "s1", alias: "Frontend" }],
    ["openSessionFolder", "folder-session"],
  ]);
});

test("dashboard open-folder IPC accepts only a sessionId string", async () => {
  const { ipcMain, calls } = createHarness();
  for (const bad of [null, undefined, "", 42, { sessionId: "s1", cwd: "/tmp" }]) {
    const result = await ipcMain.invoke("dashboard:open-session-folder", bad);
    assert.strictEqual(result.status, "error");
  }
  assert.deepStrictEqual(calls, []);
});

test("Kimi quota Dashboard IPC accepts only the real Dashboard main frame", async () => {
  const { ipcMain, calls, trustedDashboardEvent } = createHarness();

  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedDashboardEvent, "dashboard:get-kimi-quota-status"),
    {
      status: "ok",
      configured: true,
      decryptable: true,
      collectionEnabled: true,
      agentEnabled: true,
    }
  );
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedDashboardEvent, "dashboard:refresh-kimi-quota"),
    { status: "ok" }
  );
  assert.deepStrictEqual(calls, [["refreshKimiQuota"]]);

  for (const event of [
    { sender: trustedDashboardEvent.sender },
    { sender: {}, senderFrame: trustedDashboardEvent.senderFrame },
    { sender: trustedDashboardEvent.sender, senderFrame: { ...trustedDashboardEvent.senderFrame } },
  ]) {
    assert.deepStrictEqual(
      await ipcMain.invokeFrom(event, "dashboard:refresh-kimi-quota"),
      { status: "error", reason: "untrusted-dashboard-sender" }
    );
  }
  assert.deepStrictEqual(calls, [["refreshKimiQuota"]]);
});

test("session history IPC accepts only the real Dashboard main frame", async () => {
  const { ipcMain, calls, trustedDashboardEvent } = createHarness();
  const historyKey = "a".repeat(32);

  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedDashboardEvent, "dashboard:get-session-history"),
    [{ agentId: "claude-code", sessionId: "h1", cwd: "/work" }]
  );
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(
      trustedDashboardEvent,
      "dashboard:resume-session",
      { agentId: "claude-code", historyKey }
    ),
    { status: "ok" }
  );
  assert.deepStrictEqual(calls, [
    ["getSessionHistory"],
    ["resumeSessionFromHistory", { agentId: "claude-code", historyKey }],
  ]);

  // Rows expose working-directory paths and resuming spawns a real process,
  // so a near-miss sender must not reach either owner.
  calls.length = 0;
  for (const event of [
    { sender: trustedDashboardEvent.sender },
    { sender: {}, senderFrame: trustedDashboardEvent.senderFrame },
    { sender: trustedDashboardEvent.sender, senderFrame: { ...trustedDashboardEvent.senderFrame } },
  ]) {
    for (const channel of ["dashboard:get-session-history", "dashboard:resume-session"]) {
      assert.deepStrictEqual(
        await ipcMain.invokeFrom(event, channel, { agentId: "claude-code", historyKey }),
        { status: "error", reason: "untrusted-dashboard-sender" },
        channel
      );
    }
  }
  assert.deepStrictEqual(calls, []);
});

test("resume-session takes exactly an agentId/opaque-historyKey pair", async () => {
  const { ipcMain, calls, trustedDashboardEvent } = createHarness();

  for (const bad of [
    null,
    undefined,
    "claude-code",
    42,
    [],
    {},
    { historyKey: "a".repeat(32) },
    { agentId: "claude-code" },
    { agentId: "claude-code", historyKey: "" },
    { agentId: "claude-code", historyKey: "not-opaque" },
    { agentId: "", historyKey: "a".repeat(32) },
    { agentId: "claude-code", historyKey: "a".repeat(32), mode: "resume-dangerous" },
    { agentId: "claude-code", historyKey: "a".repeat(32), cwd: "/somewhere/else" },
  ]) {
    assert.deepStrictEqual(
      await ipcMain.invokeFrom(trustedDashboardEvent, "dashboard:resume-session", bad),
      { status: "invalid" },
      JSON.stringify(bad)
    );
  }
  // Above all: no extra field may ride along. cwd is resolved in main from the
  // store, and a dangerous-mode flag has no route in from the Dashboard.
  assert.deepStrictEqual(calls, []);
});

test("session IPC owns dashboard open bridges", () => {
  const { ipcMain, calls } = createHarness();

  ipcMain.send("settings:open-dashboard");
  ipcMain.send("show-dashboard");

  assert.deepStrictEqual(calls, [
    ["showDashboard", { source: "settings" }],
    ["showDashboard", undefined],
  ]);
});

test("session automation IPC accepts only the two narrow renderer payloads", async () => {
  const { ipcMain, calls } = createHarness();
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:set-session-automation", {
      sessionId: "s1",
      mode: "auto-tools",
    }),
    { status: "applied" }
  );
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:clear-session-automation-grant", { grantId: "g1" }),
    { status: "applied" }
  );
  for (const payload of [
    { sessionId: "s1", mode: "auto-tools", agentId: "claude-code" },
    { sessionId: "s1", mode: "unattended" },
    { mode: "off" },
  ]) {
    assert.deepStrictEqual(
      await ipcMain.invoke("dashboard:set-session-automation", payload),
      { status: "invalid" }
    );
  }
  assert.deepStrictEqual(
    await ipcMain.invoke("dashboard:clear-session-automation-grant", {
      grantId: "g1",
      target: "remote-revoke",
    }),
    { status: "invalid" }
  );
  assert.deepStrictEqual(calls, [
    [
      "setSessionAutomationOverride",
      { sessionId: "s1", mode: "auto-tools" },
      { sender: "sender-web-contents" },
    ],
    ["clearSessionAutomationGrant", { grantId: "g1" }],
  ]);
});

test("session:ack-completion returns {status:ok} when ack lands", async () => {
  const { ipcMain, calls } = createHarness({
    ackSessionCompletion: (sessionId) => {
      calls.push(["ackSessionCompletion", sessionId]);
      return true;
    },
  });
  const result = await ipcMain.invoke("session:ack-completion", "s1");
  assert.deepStrictEqual(result, { status: "ok" });
  assert.deepStrictEqual(calls, [["ackSessionCompletion", "s1"]]);
});

test("session:ack-completion returns noop when session missing or unflagged", async () => {
  const { ipcMain } = createHarness({
    ackSessionCompletion: () => false,
  });
  const result = await ipcMain.invoke("session:ack-completion", "s-missing");
  assert.deepStrictEqual(result, { status: "noop", reason: "not-pending-or-missing" });
});

test("session:ack-completion returns error when ackSessionCompletion throws", async () => {
  const { ipcMain } = createHarness({
    ackSessionCompletion: () => { throw new Error("boom"); },
  });
  const result = await ipcMain.invoke("session:ack-completion", "s1");
  assert.strictEqual(result.status, "error");
  assert.strictEqual(result.message, "boom");
});

test("session:ack-completion validates sessionId payload", async () => {
  const { ipcMain } = createHarness();
  for (const bad of [null, undefined, "", 42, { id: "s1" }]) {
    const result = await ipcMain.invoke("session:ack-completion", bad);
    assert.strictEqual(result.status, "error", `expected error for payload ${JSON.stringify(bad)}`);
  }
});

test("registerSessionIpc requires ackSessionCompletion dep", () => {
  assert.throws(
    () => registerSessionIpc({
      ipcMain: new FakeIpcMain(),
      getSessionSnapshot: () => ({}),
      getI18n: () => ({}),
      focusSession: () => {},
      hideSession: () => {},
      setSessionAlias: () => {},
      showDashboard: () => {},
      setSessionHudPinned: () => {},
      openSessionFolder: () => {},
      setSessionAutomationOverride: () => {},
      clearSessionAutomationGrant: () => {},
      // ackSessionCompletion intentionally absent
    }),
    /ackSessionCompletion/
  );
});

test("dashboard renderer wires the Mark-read button + ackCompletion fallback (source check)", () => {
  // The renderer module runs in a browser context; a full DOM harness
  // would be heavy. The contract this test enforces is structural:
  // (1) Mark-read button mounts gated on requiresCompletionAck,
  // (2) Jump-to-terminal click awaits ackCompletion,
  // (3) Mark-read click awaits invoke result and re-enables on failure.
  // Manual QA covers the actual click flow.
  const rendererSrc = fs.readFileSync(
    path.join(__dirname, "..", "src", "dashboard-renderer.js"),
    "utf8"
  );
  assert.ok(rendererSrc.includes("session.requiresCompletionAck === true"),
    "Mark-read button visibility must gate on requiresCompletionAck");
  assert.ok(rendererSrc.includes("createMarkReadButton"),
    "Mark-read button helper missing");
  assert.ok(rendererSrc.includes("dashboardAPI.ackCompletion"),
    "Renderer must call dashboardAPI.ackCompletion");
  // Failure path re-enables the button so the user can retry
  assert.ok(/result\.status !== "ok"[\s\S]+button\.disabled = false/.test(rendererSrc),
    "Mark-read click must re-enable button on ack failure");

  const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");
  // Both new keys must appear once in every supported language table.
  for (const key of ["dashboardMarkRead", "dashboardMarkReadTitle"]) {
    const matches = i18nSrc.match(new RegExp(`\\b${key}:`, "g"));
    const matchCount = matches ? matches.length : 0;
    assert.strictEqual(matchCount, SUPPORTED_LANGS.length,
      `${key} should appear in all ${SUPPORTED_LANGS.length} supported language tables (saw ${matchCount})`);
  }
});

test("Dashboard exposes the trusted Kimi quota refresh bridge and localized action", () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8");
  const preloadSrc = fs.readFileSync(path.join(__dirname, "..", "src", "preload-dashboard.js"), "utf8");
  const htmlSrc = fs.readFileSync(path.join(__dirname, "..", "src", "dashboard.html"), "utf8");
  const i18nSrc = fs.readFileSync(path.join(__dirname, "..", "src", "i18n.js"), "utf8");

  // The refresh button is built by the renderer inside the Kimi quota
  // section header, not static markup in dashboard.html.
  assert.match(rendererSrc, /quota-refresh-button/);
  assert.match(htmlSrc, /\.quota-refresh-button\s*\{/);
  assert.match(preloadSrc, /dashboard:get-kimi-quota-status/);
  assert.match(preloadSrc, /dashboard:refresh-kimi-quota/);
  assert.match(rendererSrc, /refreshKimiQuotaFromDashboard/);
  for (const key of [
    "dashboardKimiQuotaRefresh",
    "dashboardKimiQuotaRefreshing",
    "dashboardKimiQuotaUpdated",
    "dashboardKimiQuotaRefreshFailed",
    "dashboardKimiQuotaEmpty",
    "dashboardKimiQuotaRefreshShort",
  ]) {
    const matches = i18nSrc.match(new RegExp(`\\b${key}:`, "g"));
    assert.strictEqual(matches ? matches.length : 0, SUPPORTED_LANGS.length);
  }
});

test("main forwards dashboard open source options into session IPC", () => {
  const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const preservesOptions = [
    /registerSessionIpc\(\{[\s\S]*?showDashboard\s*,/,
    /registerSessionIpc\(\{[\s\S]*?showDashboard:\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*showDashboard\(\s*\1\s*\)/,
    /registerSessionIpc\(\{[\s\S]*?showDashboard:\s*\(\s*\.\.\.\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*showDashboard\(\s*\.\.\.\s*\1\s*\)/,
  ].some((pattern) => pattern.test(mainSource));

  assert.strictEqual(
    preservesOptions,
    true,
    "main.js should preserve dashboard open options when wiring session IPC"
  );
});

// ── 悬停快捷面板（阶段一）：发消息 / 切 effort / 切权限模式 / 选目录 / 停止 / 保持显示 ──
//
// 这些通道会花钱（send-prompt）或重置会话上下文（set-effort / set-permission-mode /
// pick-working-dir），信任闸门与载荷校验都必须挡在 owner 之前。

test("快捷面板通道只认 HUD 主 frame，伪造 sender 一律 untrusted-hud-sender", async () => {
  const { ipcMain, calls, trustedHudEvent, hudWebContents, hudMainFrame } = createHarness();

  // 先用合法 sender 走通一条，证明通道本身接线正常。
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:send-prompt", { text: "hi" }),
    { status: "ok" }
  );
  assert.deepStrictEqual(calls, [["quickSendPrompt", "hi"]]);
  calls.length = 0;

  // 合法请求形状（非法载荷另有校验分支，不能拿来测闸门）。
  const wellFormed = [
    ["session-hud:send-prompt", { text: "hi" }],
    ["session-hud:set-effort", { value: "high" }],
    ["session-hud:set-permission-mode", { value: "plan" }],
    ["session-hud:pick-working-dir", undefined],
    ["session-hud:stop-chat", undefined],
  ];

  const forgedEvents = [
    // 别的 webContents 冒充（frame 形状再像也不行）。
    { sender: {}, senderFrame: hudMainFrame },
    // 缺 senderFrame。
    { sender: hudWebContents },
    { sender: hudWebContents, senderFrame: null },
    // 另一个 frame 对象：URL 相同也不行，身份必须是 mainFrame 本体。
    { sender: hudWebContents, senderFrame: { ...hudMainFrame } },
  ];
  for (const event of forgedEvents) {
    for (const [channel, arg] of wellFormed) {
      assert.deepStrictEqual(
        await ipcMain.invokeFrom(event, channel, arg),
        { status: "error", reason: "untrusted-hud-sender" },
        channel
      );
    }
    // set-hold 是 fire-and-forget：伪造 sender 只能什么都不触发。
    ipcMain.sendFrom(event, "session-hud:set-hold", { reason: "focus", held: true });
  }

  // 同一个 mainFrame 被导航走之后（URL 不再是 session-hud.html）也必须拒绝。
  const trustedUrl = hudMainFrame.url;
  hudMainFrame.url = pathToFileURL(path.join(__dirname, "..", "src", "dashboard.html")).toString();
  try {
    const navigated = { sender: hudWebContents, senderFrame: hudMainFrame };
    for (const [channel, arg] of wellFormed) {
      assert.deepStrictEqual(
        await ipcMain.invokeFrom(navigated, channel, arg),
        { status: "error", reason: "untrusted-hud-sender" },
        channel
      );
    }
    ipcMain.sendFrom(navigated, "session-hud:set-hold", { reason: "focus", held: true });
  } finally {
    hudMainFrame.url = trustedUrl;
  }

  assert.deepStrictEqual(calls, [], "伪造 sender 一律不得触达 owner");
});

test("send-prompt 的文本闸门：空文本与超长文本拦在 owner 之前", async () => {
  const { ipcMain, calls, trustedHudEvent } = createHarness();

  for (const bad of [undefined, null, "", "   ", 42, {}, { text: "" }, { text: " \n\t" }, { text: 42 }]) {
    const result = await ipcMain.invokeFrom(trustedHudEvent, "session-hud:send-prompt", bad);
    assert.strictEqual(result.status, "error", `必须拒绝载荷 ${JSON.stringify(bad)}`);
    assert.match(result.message, /empty prompt/);
  }
  // 契约上限 100000 字符：100001 拒绝。
  const tooLong = await ipcMain.invokeFrom(
    trustedHudEvent,
    "session-hud:send-prompt",
    { text: "a".repeat(100001) }
  );
  assert.strictEqual(tooLong.status, "error");
  assert.match(tooLong.message, /prompt too long/);
  assert.deepStrictEqual(calls, [], "被拦下的文本不得触达 owner");

  // 边界：正好 100000 字符放行（契约：≤100000）。
  const edge = "a".repeat(100000);
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:send-prompt", { text: edge }),
    { status: "ok" }
  );
  assert.deepStrictEqual(calls, [["quickSendPrompt", edge]]);
});

test("set-effort / set-permission-mode 只接受契约枚举值", async () => {
  const { ipcMain, calls, trustedHudEvent } = createHarness();

  for (const bad of [undefined, null, 42, "wild", {}, { value: "WILD" }, { value: 42 }]) {
    const result = await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-effort", bad);
    assert.strictEqual(result.status, "error", `set-effort 必须拒绝 ${JSON.stringify(bad)}`);
    assert.match(result.message, /invalid effort/);
  }
  for (const value of ["low", "medium", "high", "xhigh", "max"]) {
    assert.deepStrictEqual(
      await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-effort", { value }),
      { status: "ok" },
      value
    );
    assert.deepStrictEqual(calls.at(-1), ["quickSetEffort", value]);
  }

  for (const bad of [undefined, null, 42, "yolo", {}, { value: "Auto" }, { value: 42 }]) {
    const result = await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-permission-mode", bad);
    assert.strictEqual(result.status, "error", `set-permission-mode 必须拒绝 ${JSON.stringify(bad)}`);
    assert.match(result.message, /invalid permission mode/);
  }
  for (const value of ["default", "acceptEdits", "plan", "auto"]) {
    assert.deepStrictEqual(
      await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-permission-mode", { value }),
      { status: "ok" },
      value
    );
    assert.deepStrictEqual(calls.at(-1), ["quickSetPermissionMode", value]);
  }

  // 非法值全部拦下之后，只有合法枚举触达过 owner。
  assert.strictEqual(
    calls.filter(([name]) => name === "quickSetEffort").length,
    5
  );
  assert.strictEqual(
    calls.filter(([name]) => name === "quickSetPermissionMode").length,
    4
  );
});

test("set-hold 把 reason/held 交给 quickSetHold，空 reason 与伪造 sender 不触发", async () => {
  const { ipcMain, calls, trustedHudEvent, hudWebContents, hudMainFrame } = createHarness();

  ipcMain.sendFrom(trustedHudEvent, "session-hud:set-hold", { reason: "focus", held: true });
  ipcMain.sendFrom(trustedHudEvent, "session-hud:set-hold", { reason: "draft", held: 0 });
  assert.deepStrictEqual(calls, [
    ["quickSetHold", "focus", true],
    ["quickSetHold", "draft", false],
  ]);

  // 没有 reason 的载荷不触发（held 永远布尔化）。
  ipcMain.sendFrom(trustedHudEvent, "session-hud:set-hold", { reason: "", held: true });
  ipcMain.sendFrom(trustedHudEvent, "session-hud:set-hold", { held: true });
  ipcMain.sendFrom(trustedHudEvent, "session-hud:set-hold", "focus");
  assert.strictEqual(calls.length, 2);

  // 伪造 sender 不触发。
  ipcMain.sendFrom({ sender: {}, senderFrame: hudMainFrame }, "session-hud:set-hold", {
    reason: "focus",
    held: true,
  });
  ipcMain.sendFrom({ sender: hudWebContents, senderFrame: { ...hudMainFrame } }, "session-hud:set-hold", {
    reason: "focus",
    held: true,
  });
  assert.strictEqual(calls.length, 2);
});

test("set-menu-open 只收布尔载荷，展开/收起都走 quickSetMenuOpen", async () => {
  const { ipcMain, calls, trustedHudEvent, hudMainFrame } = createHarness();

  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-menu-open", { open: true }),
    { status: "ok" }
  );
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-menu-open", { open: false }),
    { status: "ok" }
  );
  // 非布尔载荷一律当 false：菜单状态不能被"真值串"之类的值点亮。
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-menu-open", { open: "yes" }),
    { status: "ok" }
  );
  assert.deepStrictEqual(calls, [
    ["quickSetMenuOpen", true],
    ["quickSetMenuOpen", false],
    ["quickSetMenuOpen", false],
  ]);
  calls.length = 0;

  // 伪造 sender 不生效（与其它 HUD 通道同一道闸门）。
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(
      { sender: {}, senderFrame: hudMainFrame },
      "session-hud:set-menu-open",
      { open: true }
    ),
    { status: "error", reason: "untrusted-hud-sender" }
  );
  assert.deepStrictEqual(calls, []);
});

test("quick* 依赖未注入时 pick-working-dir / stop-chat 回 quick-panel-unavailable", async () => {
  const { ipcMain, calls, trustedHudEvent } = createHarness({ quickDeps: false });

  for (const channel of ["session-hud:pick-working-dir", "session-hud:stop-chat"]) {
    assert.deepStrictEqual(
      await ipcMain.invokeFrom(trustedHudEvent, channel),
      { status: "error", reason: "quick-panel-unavailable" },
      channel
    );
  }
  assert.deepStrictEqual(calls, []);
});

test(
  "quick* 依赖未注入时 send-prompt / set-effort / set-permission-mode 同样回 quick-panel-unavailable",
  async () => {
    const { ipcMain, calls, trustedHudEvent } = createHarness({ quickDeps: false });
    for (const [channel, arg] of [
      ["session-hud:send-prompt", { text: "hi" }],
      ["session-hud:set-effort", { value: "high" }],
      ["session-hud:set-permission-mode", { value: "plan" }],
    ]) {
      assert.deepStrictEqual(
        await ipcMain.invokeFrom(trustedHudEvent, channel, arg),
        { status: "error", reason: "quick-panel-unavailable" },
        channel
      );
    }
    assert.deepStrictEqual(calls, []);
  }
);
