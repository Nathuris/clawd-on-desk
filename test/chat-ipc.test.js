"use strict";

// src/chat-ipc.js（内置对话窗口的 IPC 层）单元测试。
//
// 重点：
//   - 7 个 invoke 通道全部注册 / dispose 全部注销；
//   - isTrustedChatEvent 仿 isTrustedSettingsEvent：只认 chat 窗口的
//     webContents + mainFrame + chat.html 的 URL；
//   - chat:pick-working-dir 的 dialog 调用、prefs 落盘与 runtime 透传；
//   - 权限确认不再走窗口内卡片：chat:permission-decision 通道已移除；
//   - 旧的 dialog 版 createPermissionConfirmer 已从模块导出与返回对象中移除。

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");

const chatIpcModule = require("../src/chat-ipc");
const { registerChatIpc } = chatIpcModule;
const prefs = require("../src/prefs");
const { updateRegistry } = require("../src/settings-actions");

const CHANNELS = [
  "chat:get-state",
  "chat:send",
  "chat:stop",
  "chat:new-session",
  "chat:pick-working-dir",
  "chat:set-effort",
  "chat:set-permission-mode",
];

class FakeIpcMain {
  constructor() {
    this.handlers = new Map();
    this.listeners = new Map();
    this.invokeEvent = { sender: "sender-web-contents", senderFrame: null };
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
    assert.equal(typeof listener, "function", `missing IPC handler ${channel}`);
    return listener(this.invokeEvent, ...args);
  }
}

function createHarness(overrides = {}) {
  const calls = [];
  const pushes = [];
  const ipcMain = new FakeIpcMain();
  const chatMainFrame = {
    url: pathToFileURL(path.join(__dirname, "..", "src", "chat.html")).href,
  };
  const chatWebContents = new EventEmitter();
  chatWebContents.mainFrame = chatMainFrame;
  chatWebContents.send = (channel, payload) => {
    pushes.push([channel, payload]);
  };
  chatWebContents.isDestroyed = () => false;
  const chatWindow = {
    id: "chat-window",
    webContents: chatWebContents,
    isDestroyed: () => false,
  };
  ipcMain.invokeEvent = {
    sender: chatWebContents,
    senderFrame: chatMainFrame,
  };

  const state = {
    status: "idle",
    sessionId: null,
    cwd: null,
    effort: "medium",
    permissionMode: "acceptEdits",
    model: null,
    busy: false,
    messages: [],
    ...(overrides.state || {}),
  };
  const chatRuntime = overrides.chatRuntime || {
    getState: () => state,
    send: (text) => { calls.push(["send", text]); return { status: "ok" }; },
    stop: () => { calls.push(["stop"]); return { status: "ok" }; },
    newSession: () => { calls.push(["newSession"]); return { status: "ok" }; },
    setEffort: (value) => { calls.push(["setEffort", value]); return { status: "ok" }; },
    setPermissionMode: (value) => { calls.push(["setPermissionMode", value]); return { status: "ok" }; },
    setWorkingDir: (dir) => { calls.push(["setWorkingDir", dir]); return { status: "ok" }; },
    ensureStarted: () => { calls.push(["ensureStarted"]); return { status: "ok" }; },
    dispose: () => { calls.push(["dispose"]); },
  };

  const settingsController = overrides.settingsController || {
    getSnapshot: () => ({ chatLastWorkingDir: "" }),
    applyUpdate: (key, value) => {
      calls.push(["applyUpdate", key, value]);
      return { status: "ok" };
    },
  };

  const dialogCalls = [];
  const dialog = overrides.dialog || {
    showOpenDialog: async (...args) => {
      dialogCalls.push(args);
      return { canceled: false, filePaths: [path.join("/tmp", "chat-project")] };
    },
  };

  const getChatWindow = overrides.getChatWindow || (() => chatWindow);
  const runtime = registerChatIpc({
    ipcMain,
    getChatWindow,
    chatRuntime,
    settingsController,
    dialog,
  });
  return {
    ipcMain,
    runtime,
    calls,
    pushes,
    state,
    chatRuntime,
    settingsController,
    dialog,
    dialogCalls,
    chatWindow,
    chatWebContents,
    chatMainFrame,
  };
}

test("the chat preferences live in the real prefs schema with the contract defaults", () => {
  const defaults = prefs.getDefaults();
  assert.equal(defaults.chatWindowBounds, null);
  assert.equal(defaults.chatDefaultEffort, "medium");
  assert.equal(defaults.chatDefaultPermissionMode, "acceptEdits");
  assert.equal(defaults.chatLastWorkingDir, "");

  // updateRegistry 的校验器必须收紧到契约里的枚举 / 形状。
  assert.equal(updateRegistry.chatDefaultEffort("high").status, "ok");
  assert.equal(updateRegistry.chatDefaultEffort("wild").status, "error");
  assert.equal(updateRegistry.chatDefaultPermissionMode("plan").status, "ok");
  assert.equal(updateRegistry.chatDefaultPermissionMode("yolo").status, "error");
  assert.equal(updateRegistry.chatLastWorkingDir("").status, "ok");
  assert.equal(updateRegistry.chatLastWorkingDir("/tmp/proj").status, "ok");
  assert.equal(updateRegistry.chatLastWorkingDir(42).status, "error");
  assert.equal(updateRegistry.chatWindowBounds(null).status, "ok");
  assert.equal(
    updateRegistry.chatWindowBounds({ x: 10, y: 20, width: 900, height: 640 }).status,
    "ok",
  );
  assert.equal(
    updateRegistry.chatWindowBounds({ x: 1.5, y: 0, width: 900, height: 640 }).status,
    "error",
  );
});

test("chat IPC registers every invoke channel and dispose removes them all", () => {
  const { ipcMain, runtime } = createHarness();
  for (const channel of CHANNELS) {
    assert.equal(typeof ipcMain.handlers.get(channel), "function", `${channel} must be registered`);
  }

  // 注销后任何通道都不再可用。
  runtime.dispose();
  for (const channel of CHANNELS) {
    assert.equal(ipcMain.handlers.has(channel), false, `${channel} must be removed on dispose`);
  }
});

test("chat:get-state returns the runtime snapshot with the current language", async () => {
  const { ipcMain, state } = createHarness();
  const result = await ipcMain.invoke("chat:get-state");
  assert.equal(result.status, state.status);
  assert.equal(result.busy, state.busy);
  assert.deepEqual(result.messages, state.messages);
  assert.equal(typeof result.lang, "string");
  assert.ok(result.lang.length > 0, "the renderer picks its locale from this field");
});

test("chat IPC forwards send/stop/new-session/effort/mode operations", async () => {
  const { ipcMain, calls } = createHarness();
  await ipcMain.invoke("chat:send", "你好");
  await ipcMain.invoke("chat:stop");
  await ipcMain.invoke("chat:new-session");
  await ipcMain.invoke("chat:set-effort", "high");
  await ipcMain.invoke("chat:set-permission-mode", "plan");
  assert.deepEqual(calls, [
    ["send", "你好"],
    ["stop"],
    ["newSession"],
    ["setEffort", "high"],
    ["setPermissionMode", "plan"],
  ]);
});

test("chat IPC rejects invalid enum values and blank sends before the runtime", async () => {
  const { ipcMain, calls } = createHarness();
  const badSend = await ipcMain.invoke("chat:send", "   ");
  assert.equal(badSend.status, "error");
  const badEffort = await ipcMain.invoke("chat:set-effort", "wild");
  assert.equal(badEffort.status, "error");
  const badMode = await ipcMain.invoke("chat:set-permission-mode", "yolo");
  assert.equal(badMode.status, "error");
  assert.deepEqual(calls, [], "validation failures must not reach the runtime");
});

test("the window permission card channel is gone from the IPC surface", () => {
  const { ipcMain, runtime } = createHarness();
  assert.equal(
    ipcMain.handlers.has("chat:permission-decision"),
    false,
    "permission confirmations go through the pet bubble, not a window channel",
  );
  // 注册器返回对象只暴露状态推送入口，不再有任何权限决策入口。
  assert.deepEqual(Object.keys(runtime).sort(), ["broadcastState", "dispose", "pushUpdate"]);
});

test("a trusted operation pushes the fresh snapshot on chat:update", async () => {
  const { ipcMain, pushes, state } = createHarness();
  await ipcMain.invoke("chat:send", "你好");
  assert.ok(pushes.length > 0, "the renderer must receive an immediate chat:update");
  const [channel, payload] = pushes.at(-1);
  assert.equal(channel, "chat:update");
  assert.equal(payload.status, state.status);
  assert.deepEqual(payload.messages, state.messages);
  assert.equal(typeof payload.lang, "string");
});

test("an untrusted sender cannot reach any chat IPC channel", async () => {
  const harness = createHarness();
  const { ipcMain, chatWebContents, chatMainFrame, calls } = harness;

  const badEvents = [
    { sender: {}, senderFrame: null },
    // 伪装成 mainFrame 的另一个对象：身份不等就必须拒绝。
    { sender: chatWebContents, senderFrame: { url: chatMainFrame.url } },
  ];
  for (const event of badEvents) {
    ipcMain.invokeEvent = event;
    for (const channel of CHANNELS) {
      const result = await ipcMain.invoke(channel);
      assert.equal(result.status, "error", `${channel} must reject an untrusted caller`);
      assert.match(result.message, /untrusted/i, `${channel} rejection message`);
    }
  }

  // 同一个 frame 被导航到外部页面后也必须拒绝。
  const trustedEvent = { sender: chatWebContents, senderFrame: chatMainFrame };
  const trustedUrl = chatMainFrame.url;
  chatMainFrame.url = "https://example.invalid/";
  ipcMain.invokeEvent = trustedEvent;
  for (const channel of CHANNELS) {
    const result = await ipcMain.invoke(channel);
    assert.match(result.message, /untrusted/i, `${channel} must reject a navigated frame`);
  }
  chatMainFrame.url = trustedUrl;

  assert.equal(calls.length, 0, "untrusted callers must cause no side effects");
});

test("with no chat window open every channel is rejected", async () => {
  const { ipcMain, calls } = createHarness({ getChatWindow: () => null });
  for (const channel of CHANNELS) {
    const result = await ipcMain.invoke(channel);
    assert.equal(result.status, "error", `${channel} must reject without a window`);
    assert.match(result.message, /untrusted/i);
  }
  assert.equal(calls.length, 0);
});

test("chat:pick-working-dir opens the directory dialog and stores the choice", async () => {
  const dir = path.join("/tmp", "chat-project");
  const { ipcMain, calls, dialogCalls } = createHarness();
  const result = await ipcMain.invoke("chat:pick-working-dir");

  assert.equal(dialogCalls.length, 1);
  const options = dialogCalls[0].at(-1);
  assert.deepEqual(options.properties, ["openDirectory", "createDirectory"]);
  assert.ok(
    calls.some((entry) => entry[0] === "applyUpdate" && entry[1] === "chatLastWorkingDir" && entry[2] === dir),
    "the picked directory must be persisted to chatLastWorkingDir",
  );
  assert.ok(
    calls.some((entry) => entry[0] === "setWorkingDir" && entry[1] === dir),
    "the runtime must be told about the picked directory",
  );
  assert.notEqual(result && result.status, "error", "a successful pick must not report an error");
});

test("cancelling chat:pick-working-dir writes nothing", async () => {
  const { ipcMain, calls } = createHarness({
    dialog: {
      showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    },
  });
  await ipcMain.invoke("chat:pick-working-dir");
  assert.deepEqual(calls, [], "a cancelled directory pick must not touch prefs or the runtime");
});

test("an untrusted caller cannot open the directory dialog", async () => {
  const { ipcMain, calls, dialogCalls } = createHarness();
  ipcMain.invokeEvent = { sender: {}, senderFrame: null };
  const result = await ipcMain.invoke("chat:pick-working-dir");
  assert.match(result.message, /untrusted/i);
  assert.equal(dialogCalls.length, 0);
  assert.deepEqual(calls, []);
});

test("the dialog-based permission confirmer is gone from the module and the registrar", () => {
  assert.equal(typeof chatIpcModule.registerChatIpc, "function");
  assert.equal(
    Object.hasOwn(chatIpcModule, "createPermissionConfirmer"),
    false,
    "createPermissionConfirmer must not be exported anymore",
  );
  const { runtime } = createHarness();
  assert.equal(
    Object.hasOwn(runtime, "confirmPermission"),
    false,
    "registerChatIpc must no longer return the dialog confirmer for main.js to inject",
  );
});
