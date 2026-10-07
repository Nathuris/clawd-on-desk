"use strict";

const test = require("node:test");
const { MAX_PASTED_BYTES } = require("../src/pasted-file-store");
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
        quickSelectSession: overrides.quickSelectSession
          || ((sessionId) => { calls.push(["quickSelectSession", sessionId]); return { status: "ok" }; }),
        quickCreateSession: overrides.quickCreateSession
          || (() => { calls.push(["quickCreateSession"]); return { status: "ok" }; }),
        quickCancelPendingSession: overrides.quickCancelPendingSession
          || (() => { calls.push(["quickCancelPendingSession"]); return { status: "ok" }; }),
        quickPickFolder: overrides.quickPickFolder
          || (() => { calls.push(["quickPickFolder"]); return { status: "ok" }; }),
        quickPickFiles: overrides.quickPickFiles
          || (() => { calls.push(["quickPickFiles"]); return { status: "ok", paths: ["/tmp/a.png"] }; }),
        quickSavePastedFile: overrides.quickSavePastedFile
          || ((payload) => { calls.push(["quickSavePastedFile", payload]); return { status: "ok", path: "/tmp/p.png" }; }),
        quickSetNewSessionOption: overrides.quickSetNewSessionOption
          || ((key, value) => {
            calls.push(["quickSetNewSessionOption", key, value]);
            return { status: "ok" };
          }),
        quickSetMenuOpen: overrides.quickSetMenuOpen
          || ((menu) => { calls.push(["quickSetMenuOpen", menu]); return { status: "ok" }; }),
        quickApplyEffort: overrides.quickApplyEffort
          || ((level) => { calls.push(["quickApplyEffort", level]); return { status: "sent" }; }),
        quickResumeSession: overrides.quickResumeSession
          || ((payload) => { calls.push(["quickResumeSession", payload]); return { status: "submitted" }; }),
        quickSetHold: overrides.quickSetHold
          || ((reason, held) => { calls.push(["quickSetHold", reason, held]); }),
        quickSetClickThrough: overrides.quickSetClickThrough
          || ((through) => { calls.push(["quickSetClickThrough", through]); }),
        quickSetAttachments: overrides.quickSetAttachments
          || ((count) => { calls.push(["quickSetAttachments", count]); }),
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
    "session-hud:apply-effort",
    "session-hud:cancel-pending-session",
    "session-hud:get-i18n",
    "session-hud:new-session",
    "session-hud:pick-file",
    "session-hud:pick-folder",
    "session-hud:resume-session",
    "session-hud:save-pasted-file",
    "session-hud:select-session",
    "session-hud:send-prompt",
    "session-hud:set-menu-open",
    "session-hud:set-new-session-option",
    "session:ack-completion",
  ]);
  assert.deepStrictEqual([...ipcMain.listeners.keys()].sort(), [
    "dashboard:focus-session",
    "session-hud:set-attachments",
    "session-hud:set-click-through",
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

// ── 悬停快捷面板：发消息 / 选会话 / 新建会话 / 选文件夹 / 保持显示 ──
//
// 这些通道会往终端里的真实会话投递文字、在终端里开进程、弹系统对话框，
// 信任闸门与载荷校验都必须挡在 owner 之前。

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

test("quick* 依赖未注入时 send-prompt 回 quick-panel-unavailable", async () => {
  const { ipcMain, calls, trustedHudEvent } = createHarness({ quickDeps: false });
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:send-prompt", { text: "hi" }),
    { status: "error", reason: "quick-panel-unavailable" }
  );
  assert.deepStrictEqual(calls, []);
});

test("select-session 的载荷闸门：只认非空字符串 id", async () => {
  const { ipcMain, calls, trustedHudEvent } = createHarness();

  for (const bad of [undefined, null, {}, { sessionId: "" }, { sessionId: 42 }, "s1"]) {
    const result = await ipcMain.invokeFrom(trustedHudEvent, "session-hud:select-session", bad);
    assert.strictEqual(result.status, "error", `必须拒绝载荷 ${JSON.stringify(bad)}`);
    assert.match(result.message, /empty session id/);
  }
  assert.deepStrictEqual(calls, [], "非法 id 不得触达 owner");

  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:select-session", { sessionId: "s1" }),
    { status: "ok" }
  );
  assert.deepStrictEqual(calls, [["quickSelectSession", "s1"]]);
});

test("set-menu-open 的载荷闸门：只认 session / settings，其它一律当收起", async () => {
  const { ipcMain, calls, trustedHudEvent } = createHarness();

  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-menu-open", { menu: "session" }),
    { status: "ok" }
  );
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-menu-open", { menu: "settings" }),
    { status: "ok" }
  );
  // 不认识的值、缺字段、垃圾载荷：一律当「收起」交给主进程，不触达别的能力
  for (const payload of [{ menu: "bogus" }, { menu: null }, {}, undefined, 42]) {
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-menu-open", payload);
  }
  assert.deepStrictEqual(calls, [
    ["quickSetMenuOpen", "session"],
    ["quickSetMenuOpen", "settings"],
    ["quickSetMenuOpen", null],
    ["quickSetMenuOpen", null],
    ["quickSetMenuOpen", null],
    ["quickSetMenuOpen", null],
    ["quickSetMenuOpen", null],
  ]);
});

test("set-new-session-option 的载荷闸门：键与值都必须在允许表里", async () => {
  const { ipcMain, calls, trustedHudEvent } = createHarness();

  const bad = [
    undefined,
    null,
    [],
    "permissionMode",
    { key: "permissionMode" },
    { value: "low" },
    { key: "permissionMode", value: "low", extra: 1 },
    { key: "nope", value: "default" },
    // 值对了但键不对：这两个值分属不同的表，不能互相串。
    { key: "permissionMode", value: "low" },
    { key: "effort", value: "plan" },
    // 跳过权限确认那档不在面板的允许表里。
    { key: "permissionMode", value: "bypassPermissions" },
    // 注入形状的值。
    { key: "effort", value: "high; rm -rf /" },
    { key: "effort", value: "" },
  ];
  for (const payload of bad) {
    const result = await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-new-session-option", payload);
    assert.deepStrictEqual(result, { status: "invalid" }, JSON.stringify(payload));
  }
  assert.deepStrictEqual(calls, [], "非法载荷不得触达 owner");

  // 允许表里的组合照常放行。
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-new-session-option", {
      key: "permissionMode",
      value: "plan",
    }),
    { status: "ok" }
  );
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:set-new-session-option", {
      key: "effort",
      value: "high",
    }),
    { status: "ok" }
  );
  assert.deepStrictEqual(calls, [
    ["quickSetNewSessionOption", "permissionMode", "plan"],
    ["quickSetNewSessionOption", "effort", "high"],
  ]);
});

test("apply-effort 的载荷闸门：只认一个 level，且必须在允许表里", async () => {
  const { ipcMain, calls, trustedHudEvent } = createHarness();

  const bad = [
    undefined,
    null,
    [],
    "high",
    {},
    { level: "turbo" },
    { level: "high " },
    { level: "HIGH" },
    { level: "high; rm -rf /" },
    { level: "high", extra: 1 },
    { level: "" },
  ];
  for (const payload of bad) {
    const result = await ipcMain.invokeFrom(trustedHudEvent, "session-hud:apply-effort", payload);
    assert.deepStrictEqual(result, { status: "invalid" }, JSON.stringify(payload));
  }
  assert.deepStrictEqual(calls, [], "非法载荷不得触达 owner");

  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:apply-effort", { level: "xhigh" }),
    { status: "sent" }
  );
  assert.deepStrictEqual(calls, [["quickApplyEffort", "xhigh"]]);
});

test("resume-session 的载荷闸门：只认 agent 与 32 位 hex 的 historyKey", async () => {
  const { ipcMain, calls, trustedHudEvent, hudWebContents, hudMainFrame } = createHarness();
  const good = { agentId: "claude-code", historyKey: "a".repeat(32) };

  const bad = [
    undefined,
    null,
    [],
    "claude-code",
    {},
    { agentId: "claude-code" },
    { historyKey: "a".repeat(32) },
    { agentId: "", historyKey: "a".repeat(32) },
    { agentId: "claude-code", historyKey: "" },
    { agentId: "claude-code", historyKey: "ZZZZ" },
    { agentId: "claude-code", historyKey: "A".repeat(32) },
    { agentId: "claude-code", historyKey: "a".repeat(31) },
    { agentId: "claude-code", historyKey: "a".repeat(33) },
    // 续跑会拉起真进程：多带字段（比如想自己指定目录/权限）一律不接受
    { agentId: "claude-code", historyKey: "a".repeat(32), cwd: "/tmp" },
    { agentId: "claude-code", historyKey: "a".repeat(32), mode: "dangerous" },
  ];
  for (const payload of bad) {
    const result = await ipcMain.invokeFrom(trustedHudEvent, "session-hud:resume-session", payload);
    assert.deepStrictEqual(result, { status: "invalid" }, JSON.stringify(payload));
  }
  assert.deepStrictEqual(calls, [], "非法载荷不得触达 owner");

  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:resume-session", good),
    { status: "submitted" }
  );
  // 交给 owner 的只有这两个字段，别的都不带（尤其没有权限模式）
  assert.deepStrictEqual(calls, [["quickResumeSession", { agentId: "claude-code", historyKey: "a".repeat(32) }]]);

  // 伪造的 sender 一律先被信任闸门拦下
  const forged = { sender: hudWebContents, senderFrame: { ...hudMainFrame } };
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(forged, "session-hud:resume-session", good),
    { status: "error", reason: "untrusted-hud-sender" }
  );
  assert.deepStrictEqual(calls.length, 1, "不可信的 sender 不该触达 owner");
});

test("pick-file 只认 HUD 主 frame，并把路径交回渲染端", async () => {
  const { ipcMain, calls, trustedHudEvent, hudWebContents, hudMainFrame } = createHarness();
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:pick-file"),
    { status: "ok", paths: ["/tmp/a.png"] }
  );
  assert.deepStrictEqual(calls, [["quickPickFiles"]]);

  const forged = { sender: hudWebContents, senderFrame: { ...hudMainFrame } };
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(forged, "session-hud:pick-file"),
    { status: "error", reason: "untrusted-hud-sender" }
  );
});

test("save-pasted-file 的载荷闸门：形状、大小都要过关", async () => {
  const { ipcMain, calls, trustedHudEvent } = createHarness();
  const okPayload = { name: "shot.png", type: "image/png", data: new Uint8Array([1, 2, 3]) };

  const bad = [
    undefined,
    null,
    "x",
    [],
    { name: "a", type: "b" },
    { name: "a", type: "b", data: new Uint8Array([1]), extra: 1 },
    { name: 1, type: "b", data: new Uint8Array([1]) },
    { name: "a", type: 2, data: new Uint8Array([1]) },
    { name: "a", type: "b", data: "not-bytes" },
    { name: "a", type: "b", data: new Uint8Array([]) },
    { name: "a".repeat(201), type: "b", data: new Uint8Array([1]) },
  ];
  for (const payload of bad) {
    assert.deepStrictEqual(
      await ipcMain.invokeFrom(trustedHudEvent, "session-hud:save-pasted-file", payload),
      { status: "invalid" },
      JSON.stringify(payload && payload.name)
    );
  }
  // 大小上限共用一份：正好的过了，超一点点的被挡在 owner 之前
  const edge = await ipcMain.invokeFrom(trustedHudEvent, "session-hud:save-pasted-file", {
    name: "a.png", type: "image/png", data: new Uint8Array(MAX_PASTED_BYTES),
  });
  assert.strictEqual(edge.status, "ok");
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:save-pasted-file", {
      name: "a.png", type: "image/png", data: new Uint8Array(MAX_PASTED_BYTES + 1),
    }),
    { status: "too-large" }
  );

  calls.length = 0;
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:save-pasted-file", okPayload),
    { status: "ok", path: "/tmp/p.png" }
  );
  assert.deepStrictEqual(calls, [["quickSavePastedFile", okPayload]]);
});

test("set-attachments 只认 HUD 主 frame，且只收 0..8 的整数", async () => {
  const { ipcMain, calls, trustedHudEvent, hudWebContents, hudMainFrame } = createHarness();

  ipcMain.sendFrom(trustedHudEvent, "session-hud:set-attachments", { count: 2 });
  assert.deepStrictEqual(calls, [["quickSetAttachments", 2]]);
  calls.length = 0;

  // 脏数据一律不触达 owner（数字一变主进程就要重算窗口高度）
  for (const count of [undefined, null, "2", 2.5, -1, 9, NaN, Infinity]) {
    ipcMain.sendFrom(trustedHudEvent, "session-hud:set-attachments", { count });
  }
  ipcMain.sendFrom(trustedHudEvent, "session-hud:set-attachments", undefined);
  assert.deepStrictEqual(calls, []);

  // 伪造 sender 什么都不该发生
  const forged = { sender: hudWebContents, senderFrame: { ...hudMainFrame } };
  ipcMain.sendFrom(forged, "session-hud:set-attachments", { count: 3 });
  assert.deepStrictEqual(calls, []);
});

test("new-session / pick-folder 只认 HUD 主 frame", async () => {
  const { ipcMain, calls, trustedHudEvent, hudWebContents, hudMainFrame } = createHarness();

  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:new-session"),
    { status: "ok" }
  );
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:pick-folder"),
    { status: "ok" }
  );
  assert.deepStrictEqual(
    await ipcMain.invokeFrom(trustedHudEvent, "session-hud:cancel-pending-session"),
    { status: "ok" }
  );
  assert.deepStrictEqual(calls, [["quickCreateSession"], ["quickPickFolder"], ["quickCancelPendingSession"]]);
  calls.length = 0;

  const forged = { sender: hudWebContents, senderFrame: { ...hudMainFrame } };
  for (const channel of [
    "session-hud:new-session",
    "session-hud:apply-effort",
    "session-hud:cancel-pending-session",
    "session-hud:pick-folder",
  ]) {
    assert.deepStrictEqual(
      await ipcMain.invokeFrom(forged, channel),
      { status: "error", reason: "untrusted-hud-sender" },
      channel
    );
  }
  assert.deepStrictEqual(calls, [], "伪造 sender 不得在终端里开会话、更不得弹系统对话框");
});
