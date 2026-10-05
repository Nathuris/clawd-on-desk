"use strict";

// src/chat-ipc.js（内置对话窗口的 IPC 层）单元测试。
//
// 重点：
//   - 14 个 invoke 通道全部注册 / dispose 全部注销；
//   - isTrustedChatEvent 仿 isTrustedSettingsEvent：只认 chat 窗口的
//     webContents + mainFrame + chat.html 的 URL；
//   - chat:pick-working-dir 的 dialog 调用、prefs 落盘与 runtime 透传；
//   - chat:list-history 的字段白名单、当前目录过滤、排除进行中会话与 25 条上限；
//   - chat:resume-session 的正常路径与非法 historyKey / 非当前目录 / 反查失败拒绝；
//   - 附件（阶段三）：pick / register-dropped 授权集合、20MB 与存在性闸门、
//     图片 / PDF / 小文本 / 其它类型的 block 构建、单附件失败跳过并带 warnings；
//   - 粘贴图片（chat:save-pasted-image）：PNG data URL 落临时目录并进授权集合、
//     非图片 / 超 8MB / 损坏 base64 整张拒绝；
//   - 外链（chat:open-external）：只放行 http(s)，其余协议不调用 shell；
//   - 权限确认不再走窗口内卡片：chat:permission-decision 通道已移除；
//   - 旧的 dialog 版 createPermissionConfirmer 已从模块导出与返回对象中移除。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
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
  "chat:list-history",
  "chat:resume-session",
  "chat:pick-attachments",
  "chat:list-commands",
  "chat:register-dropped-paths",
  "chat:save-pasted-image",
  "chat:open-external",
];

// ── 附件测试的真实临时文件 ──

// 1x1 透明 PNG（真实字节，附件读取走真实分支）。
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const tempDirs = [];
function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-chat-ipc-"));
  tempDirs.push(dir);
  return dir;
}

function writeTempFile(dir, name, data) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, data);
  return filePath;
}

// 渲染端会回传的附件元数据条目（path 是授权校验的关键字段）。
function attachmentEntry(filePath, extra = {}) {
  return {
    path: filePath,
    name: path.basename(filePath),
    size: fs.statSync(filePath).size,
    isImage: /\.(png|jpe?g|gif|webp)$/i.test(filePath),
    ...extra,
  };
}

// 假 fs：stat 等照常走真实文件，只让指定路径的 readFile 失败——
// 用来稳定复现「附件通过闸门、构建阶段读取失败」的分支。
function failingReadFs(targetPath) {
  return {
    promises: {
      stat: (filePath, ...args) => fs.promises.stat(filePath, ...args),
      readFile: (filePath, ...args) => {
        if (filePath === targetPath) return Promise.reject(new Error("EIO"));
        return fs.promises.readFile(filePath, ...args);
      },
    },
  };
}

test.after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

// 合法 historyKey：32 位十六进制（与 session-history-loader 的规则一致）。
function historyKey(seed) {
  return String(seed).repeat(32).slice(0, 32);
}

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
  const activeSessionIds = overrides.activeSessionIds || [];
  const chatRuntime = overrides.chatRuntime || {
    getState: () => state,
    send: (text, options) => { calls.push(["send", text, options]); return { status: "ok" }; },
    stop: () => { calls.push(["stop"]); return { status: "ok" }; },
    newSession: () => { calls.push(["newSession"]); return { status: "ok" }; },
    setEffort: (value) => { calls.push(["setEffort", value]); return { status: "ok" }; },
    setPermissionMode: (value) => { calls.push(["setPermissionMode", value]); return { status: "ok" }; },
    setWorkingDir: (dir) => { calls.push(["setWorkingDir", dir]); return { status: "ok" }; },
    ensureStarted: () => { calls.push(["ensureStarted"]); return { status: "ok" }; },
    getActiveSessionIds: () => { calls.push(["getActiveSessionIds"]); return activeSessionIds.slice(); },
    resumeSession: (args) => { calls.push(["resumeSession", args]); return { status: "ok" }; },
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

  // 历史会话 / 续聊（阶段二）注入缝的默认假实现（记录调用；可用 overrides 覆盖）。
  const loadHistoryCalls = [];
  const loadHistory = overrides.loadHistory || (async (options) => {
    loadHistoryCalls.push(options);
    calls.push(["loadHistory", options]);
    return [];
  });
  const resolveCalls = [];
  const resolveResumeTarget = overrides.resolveResumeTarget || ((agentId, key) => {
    resolveCalls.push([agentId, key]);
    calls.push(["resolveResumeTarget", agentId, key]);
    return null;
  });
  const loadBackfill = overrides.loadBackfill || null;

  // 粘贴图片落盘 / 打开外链的注入缝：tempDir 是 os.tmpdir 下的真实子目录
  // （app.getPath("temp") 指向它），shellCalls 记录每次 openExternal 的目标。
  const tempDir = overrides.tempDir || makeTempDir();
  const shellCalls = [];
  const app = overrides.app || {
    getPath: (name) => {
      if (name !== "temp") throw new Error(`unexpected app.getPath("${name}")`);
      return tempDir;
    },
  };
  const shell = overrides.shell || {
    openExternal: async (url) => { shellCalls.push(url); },
  };

  const getChatWindow = overrides.getChatWindow || (() => chatWindow);
  const runtime = registerChatIpc({
    ipcMain,
    getChatWindow,
    chatRuntime,
    settingsController,
    dialog,
    // 附件读取默认走真实 fs；测试可注入包装实现（见 failingReadFs）。
    fs: overrides.fs,
    loadHistory,
    resolveResumeTarget,
    loadBackfill,
    app,
    shell,
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
    loadHistoryCalls,
    resolveCalls,
    chatWindow,
    chatWebContents,
    chatMainFrame,
    tempDir,
    shellCalls,
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
    ["send", "你好", undefined],
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

// ── 阶段二：历史会话列表 / 续聊 ──

test("chat:list-history maps rows of the current folder with a whitelisted field set", async () => {
  const cwd = "/tmp/chat-project";
  const activeId = "active-session";
  const rows = [
    {
      agentId: "claude-code",
      sessionId: "s1",
      historyKey: historyKey("a"),
      cwd,
      title: "写一首曲子",
      lastEventAt: 1000,
      endedAt: null,
      transcriptPresent: true,
      group: "confirmed",
      secret: "must not leak",
    },
    // 正在聊的会话：即使注入的 loadHistory 没滤掉，通道层也必须排除。
    {
      agentId: "claude-code", sessionId: activeId, historyKey: historyKey("b"),
      cwd, title: "当前会话", lastEventAt: 2000,
    },
    // 别的工作目录：必须排除。
    {
      agentId: "claude-code", sessionId: "s3", historyKey: historyKey("c"),
      cwd: "/tmp/other", title: "别的目录", lastEventAt: 3000,
    },
    // 没标题（渲染端显示「未命名对话」），endedAt 一并回传。
    {
      agentId: "claude-code", sessionId: "s4", historyKey: historyKey("d"),
      cwd, title: null, lastEventAt: 4000, endedAt: 4500,
    },
    // loader 标了不可恢复原因（旧版记录 profile 无法核验）：不给恢复入口。
    {
      agentId: "claude-code", sessionId: "s5", historyKey: historyKey("e"),
      cwd, title: "旧记录", lastEventAt: 5000, resumeDisabledReason: "profile-unverified",
    },
  ];
  const seenOptions = [];
  const harness = createHarness({
    state: { cwd },
    activeSessionIds: [activeId],
    loadHistory: async (options) => {
      seenOptions.push(options);
      return rows;
    },
  });
  const result = await harness.ipcMain.invoke("chat:list-history");

  assert.equal(result.status, "ok");
  assert.equal(result.rows.length, 2);
  // 只回传白名单字段，cwd / sessionId / group 等留在主进程。
  assert.deepEqual(Object.keys(result.rows[0]).sort(), ["endedAt", "historyKey", "lastEventAt", "title"]);
  assert.equal(result.rows[0].historyKey, historyKey("a"));
  assert.equal(result.rows[0].title, "写一首曲子");
  assert.equal(result.rows[0].lastEventAt, 1000);
  assert.equal(result.rows[0].endedAt, null);
  assert.equal(result.rows[1].title, null);
  assert.equal(result.rows[1].lastEventAt, 4000);
  assert.equal(result.rows[1].endedAt, 4500);
  assert.equal("secret" in result.rows[0], false);

  // 排除进行中会话靠 loader 的 activeRawSessionIds；cwd 与上限 25 一起交给 loader，
  // 让它在截断前先按目录过滤（当前目录的会话不会被别的目录挤掉）。
  assert.equal(seenOptions.length, 1);
  assert.equal(seenOptions[0].limit, 25);
  assert.equal(seenOptions[0].cwd, cwd);
  assert.ok(seenOptions[0].activeRawSessionIds instanceof Set);
  assert.equal(seenOptions[0].activeRawSessionIds.has(activeId), true);
  assert.equal(seenOptions[0].activeRawSessionIds.has("s1"), false);
});

test("chat:list-history caps the list at 25 rows", async () => {
  const cwd = "/tmp/chat-project";
  const rows = Array.from({ length: 40 }, (_, index) => ({
    sessionId: `sess-${index}`,
    historyKey: index.toString(16).padStart(32, "0"),
    cwd,
    title: `对话 ${index}`,
    lastEventAt: 1000 + index,
    endedAt: null,
  }));
  const harness = createHarness({ state: { cwd }, loadHistory: async () => rows });
  const result = await harness.ipcMain.invoke("chat:list-history");
  assert.equal(result.rows.length, 25);
  assert.equal(result.rows[0].title, "对话 0");
  assert.equal(result.rows[24].title, "对话 24");
});

test("chat:list-history degrades to an empty list on failure or without a working folder", async () => {
  const failing = createHarness({
    state: { cwd: "/tmp/chat-project" },
    loadHistory: async () => { throw new Error("store down"); },
  });
  const failed = await failing.ipcMain.invoke("chat:list-history");
  assert.deepEqual(failed, { status: "ok", rows: [] });

  let called = false;
  const noFolder = createHarness({
    state: { cwd: null },
    loadHistory: async () => { called = true; return []; },
  });
  const empty = await noFolder.ipcMain.invoke("chat:list-history");
  assert.deepEqual(empty, { status: "ok", rows: [] });
  assert.equal(called, false, "without a working folder the history store must not be read");
});

test("chat:resume-session resolves the key, checks the folder, and starts the resume", async () => {
  const cwd = "/tmp/chat-project";
  const key = historyKey("a");
  const backfill = async () => [];
  const resolved = [];
  const harness = createHarness({
    state: { cwd },
    loadBackfill: backfill,
    resolveResumeTarget: (agentId, requestedKey) => {
      resolved.push([agentId, requestedKey]);
      return { agentId, sessionId: "sess-9", historyKey: requestedKey, cwd };
    },
  });
  const result = await harness.ipcMain.invoke("chat:resume-session", key);

  assert.equal(result.status, "ok");
  // 渲染端只交 historyKey，反查必须按 claude-code 走存储。
  assert.deepEqual(resolved, [["claude-code", key]]);
  const resumeCall = harness.calls.find((entry) => entry[0] === "resumeSession");
  assert.ok(resumeCall, "the runtime resumeSession must be invoked");
  assert.deepEqual(resumeCall[1], { sessionId: "sess-9", loadBackfill: backfill });
  // 回包带最新快照，并主动补推一次 chat:update。
  assert.equal(result.state.status, harness.state.status);
  assert.equal(harness.pushes.at(-1)[0], "chat:update");
});

test("chat:resume-session rejects malformed keys, foreign folders, and unknown sessions", async () => {
  const cwd = "/tmp/chat-project";
  const key = historyKey("a");

  // 非法 historyKey：不查存储、不动 runtime。
  const malformed = createHarness({ state: { cwd } });
  for (const bad of ["not-a-key", "", null, 42, key.toUpperCase(), key.slice(0, 31)]) {
    const result = await malformed.ipcMain.invoke("chat:resume-session", bad);
    assert.equal(result.status, "error");
    assert.equal(result.message, "无法恢复该会话");
  }
  assert.deepEqual(malformed.resolveCalls, []);
  assert.equal(malformed.calls.some((entry) => entry[0] === "resumeSession"), false);

  // 反查到的目录不是当前工作目录：拒绝。
  const foreign = createHarness({
    state: { cwd },
    resolveResumeTarget: () => ({
      agentId: "claude-code", sessionId: "sess-9", historyKey: key, cwd: "/tmp/other",
    }),
  });
  const foreignResult = await foreign.ipcMain.invoke("chat:resume-session", key);
  assert.equal(foreignResult.status, "error");
  assert.equal(foreignResult.message, "无法恢复该会话");
  assert.equal(foreign.calls.some((entry) => entry[0] === "resumeSession"), false);

  // 反查失败（默认假实现返回 null）：统一中文错误。
  const unknown = createHarness({ state: { cwd } });
  const unknownResult = await unknown.ipcMain.invoke("chat:resume-session", key);
  assert.equal(unknownResult.status, "error");
  assert.equal(unknownResult.message, "无法恢复该会话");

  // runtime 拒绝（driver 启动失败等）：同样回统一中文错误，不透传英文异常。
  const refusing = createHarness({
    state: { cwd },
    resolveResumeTarget: () => ({ agentId: "claude-code", sessionId: "sess-9", historyKey: key, cwd }),
    chatRuntime: {
      getState: () => ({ status: "idle", cwd, messages: [] }),
      resumeSession: () => ({ status: "error", message: "driver exploded" }),
    },
  });
  const refusingResult = await refusing.ipcMain.invoke("chat:resume-session", key);
  assert.equal(refusingResult.status, "error");
  assert.equal(refusingResult.message, "无法恢复该会话");
});

// ── 阶段三：附件上传与斜杠指令 ──

test("chat:pick-attachments returns real file metadata and authorizes the picks", async () => {
  const dir = makeTempDir();
  const note = writeTempFile(dir, "note.txt", "你好，附件");
  const png = writeTempFile(dir, "pic.png", PNG_1X1);
  let dialogOptions = null;
  const harness = createHarness({
    dialog: {
      showOpenDialog: async (...args) => {
        dialogOptions = args.at(-1);
        return { canceled: false, filePaths: [note, png] };
      },
    },
  });
  const result = await harness.ipcMain.invoke("chat:pick-attachments");

  assert.equal(result.status, "ok");
  assert.deepEqual(result.files.map((file) => file.path), [note, png]);
  const [noteEntry, pngEntry] = result.files;
  assert.deepEqual(
    { name: noteEntry.name, size: noteEntry.size, isImage: noteEntry.isImage },
    { name: "note.txt", size: Buffer.byteLength("你好，附件"), isImage: false },
  );
  assert.deepEqual(
    { name: pngEntry.name, size: pngEntry.size, isImage: pngEntry.isImage },
    { name: "pic.png", size: PNG_1X1.length, isImage: true },
  );
  // 图片带 data URL 预览；文本文件不带。
  assert.equal(pngEntry.preview, `data:image/png;base64,${PNG_1X1.toString("base64")}`);
  assert.equal("preview" in noteEntry, false);
  // 多选、只选文件。
  assert.deepEqual(dialogOptions.properties, ["openFile", "multiSelections"]);
  assert.equal(typeof dialogOptions.title, "string");

  // 选中的文件立刻进入已授权集合：原样回传即可发送。
  const sendResult = await harness.ipcMain.invoke("chat:send", {
    text: "看看",
    attachments: result.files,
  });
  assert.notEqual(sendResult.status, "error");
});

test("cancelling chat:pick-attachments reports cancel without touching the runtime", async () => {
  const harness = createHarness({
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  });
  assert.deepEqual(await harness.ipcMain.invoke("chat:pick-attachments"), { status: "cancel" });
  assert.deepEqual(harness.calls, []);
});

test("chat:send builds image and inline-text blocks for picked attachments", async () => {
  const dir = makeTempDir();
  const png = writeTempFile(dir, "pic.png", PNG_1X1);
  const note = writeTempFile(dir, "note.txt", "谱子在这里");
  const harness = createHarness({
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [png, note] }) },
  });
  const picked = await harness.ipcMain.invoke("chat:pick-attachments");

  const result = await harness.ipcMain.invoke("chat:send", { text: "看看", attachments: picked.files });
  assert.notEqual(result.status, "error");
  assert.equal("warnings" in result, false);

  const sendCall = harness.calls.find((entry) => entry[0] === "send");
  assert.ok(sendCall, "runtime.send must be invoked");
  assert.equal(sendCall[1], "看看");
  const { blocks, attachments } = sendCall[2];
  assert.deepEqual(blocks, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1.toString("base64") } },
    { type: "text", text: "【附件 note.txt】\n谱子在这里" },
  ]);
  // 界面元数据原样转交 runtime（供用户消息里的附件条渲染）。
  assert.deepEqual(attachments.map((entry) => entry.name), ["pic.png", "note.txt"]);
  assert.deepEqual(attachments.map((entry) => entry.isImage), [true, false]);
});

test("chat:send rejects any attachment path that was not picked or dropped", async () => {
  const dir = makeTempDir();
  const secret = writeTempFile(dir, "secret.txt", "不能读");
  const dropped = writeTempFile(dir, "ok.txt", "能读");
  const harness = createHarness();

  // 从未经 pick / register-dropped 授权：整个请求拒绝，不读文件。
  const unauthorized = await harness.ipcMain.invoke("chat:send", {
    text: "送你",
    attachments: [attachmentEntry(secret)],
  });
  assert.equal(unauthorized.status, "error");
  assert.equal(unauthorized.message, "attachment not allowed");
  assert.equal(harness.calls.some((entry) => entry[0] === "send"), false);

  // 相对路径同样拒绝（授权集合里的路径必须是绝对路径）。
  const relative = await harness.ipcMain.invoke("chat:send", {
    text: "送你",
    attachments: [{ path: "secret.txt", name: "secret.txt", size: 6, isImage: false }],
  });
  assert.equal(relative.status, "error");

  // 混入一个未授权附件：整个请求拒绝，已授权的那个也不能发出去。
  await harness.ipcMain.invoke("chat:register-dropped-paths", { paths: [dropped] });
  const mixed = await harness.ipcMain.invoke("chat:send", {
    text: "混合",
    attachments: [attachmentEntry(dropped), attachmentEntry(secret)],
  });
  assert.equal(mixed.status, "error");
  assert.equal(harness.calls.some((entry) => entry[0] === "send"), false);
});

test("chat:register-dropped-paths authorizes dropped files for later sends", async () => {
  const dir = makeTempDir();
  const dropped = writeTempFile(dir, "dropped.txt", "拖进来的文件");
  const harness = createHarness();

  // 非绝对路径与非字符串条目被忽略，其余照常登记。
  assert.deepEqual(
    await harness.ipcMain.invoke("chat:register-dropped-paths", { paths: [dropped, 42, "relative.txt"] }),
    { status: "ok" },
  );

  const result = await harness.ipcMain.invoke("chat:send", {
    text: "",
    attachments: [attachmentEntry(dropped)],
  });
  assert.notEqual(result.status, "error");
  const { blocks } = harness.calls.find((entry) => entry[0] === "send")[2];
  assert.deepEqual(blocks, [{ type: "text", text: "【附件 dropped.txt】\n拖进来的文件" }]);
});

test("chat:send maps pdf, small text and other files to the contract block shapes", async () => {
  const dir = makeTempDir();
  const pdfBytes = Buffer.from("%PDF-1.4\n% 假 PDF 内容\n");
  const pdf = writeTempFile(dir, "score.pdf", pdfBytes);
  const note = writeTempFile(dir, "note.txt", "这是谱子说明");
  const binary = writeTempFile(dir, "patch.bin", Buffer.from([0, 1, 2, 3, 255, 254]));
  const harness = createHarness();
  await harness.ipcMain.invoke("chat:register-dropped-paths", {
    paths: [pdf, note, binary],
  });

  const result = await harness.ipcMain.invoke("chat:send", {
    text: "文件都在这里",
    attachments: [attachmentEntry(pdf), attachmentEntry(note), attachmentEntry(binary)],
  });
  assert.notEqual(result.status, "error");
  const { blocks } = harness.calls.find((entry) => entry[0] === "send")[2];

  // PDF → document 块，顺序与附件一致。
  assert.deepEqual(blocks[0], {
    type: "document",
    source: { type: "base64", media_type: "application/pdf", data: pdfBytes.toString("base64") },
  });
  // 小文本 → 内联 text 块（内容真的读出来了）。
  assert.deepEqual(blocks[1], { type: "text", text: "【附件 note.txt】\n这是谱子说明" });
  // 其它类型 → 只给路径说明的 text 块，不内联二进制内容。
  assert.equal(blocks[2].type, "text");
  assert.ok(blocks[2].text.includes("patch.bin"), "路径说明必须带上文件名");
  assert.ok(blocks[2].text.includes(binary), "路径说明必须带上完整路径");
  assert.ok(blocks[2].text.includes("6 字节"), "路径说明必须带上文件大小");
});

test("chat:send rejects oversized, missing and non-file attachments before sending", async () => {
  const dir = makeTempDir();
  const big = path.join(dir, "big.bin");
  fs.writeFileSync(big, "");
  fs.truncateSync(big, 21 * 1024 * 1024); // 稀疏文件：stat 报 21MB，不必真写盘
  const missing = path.join(dir, "gone.txt");
  const harness = createHarness();
  await harness.ipcMain.invoke("chat:register-dropped-paths", { paths: [big, missing, dir] });

  const oversized = await harness.ipcMain.invoke("chat:send", {
    text: "",
    attachments: [{ path: big, name: "big.bin", size: 21 * 1024 * 1024, isImage: false }],
  });
  assert.equal(oversized.status, "error");

  const gone = await harness.ipcMain.invoke("chat:send", {
    text: "",
    attachments: [{ path: missing, name: "gone.txt", size: 10, isImage: false }],
  });
  assert.equal(gone.status, "error");

  // 目录通过 stat 但不是常规文件：同样拒绝。
  const folder = await harness.ipcMain.invoke("chat:send", {
    text: "",
    attachments: [{ path: dir, name: "folder", size: 0, isImage: false }],
  });
  assert.equal(folder.status, "error");

  assert.equal(harness.calls.some((entry) => entry[0] === "send"), false, "被拒绝的附件不得进入 runtime");
});

test("chat:send skips a single failed attachment, keeps the rest and reports warnings", async () => {
  const dir = makeTempDir();
  const note = writeTempFile(dir, "note.txt", "只有这个能读");
  const locked = writeTempFile(dir, "locked.png", PNG_1X1);
  const harness = createHarness({ fs: failingReadFs(locked) });
  await harness.ipcMain.invoke("chat:register-dropped-paths", { paths: [note, locked] });

  const result = await harness.ipcMain.invoke("chat:send", {
    text: "",
    attachments: [attachmentEntry(note), attachmentEntry(locked)],
  });
  assert.notEqual(result.status, "error");
  assert.deepEqual(result.warnings, ["附件「locked.png」读取失败，已跳过"]);

  const { blocks, attachments } = harness.calls.find((entry) => entry[0] === "send")[2];
  assert.deepEqual(blocks, [{ type: "text", text: "【附件 note.txt】\n只有这个能读" }]);
  assert.deepEqual(attachments.map((entry) => entry.name), ["note.txt"], "失败的附件不能留在元数据里");
});

test("chat:send rejects a fully empty message even when attachments were listed", async () => {
  const dir = makeTempDir();
  const note = writeTempFile(dir, "note.txt", "内容");
  const harness = createHarness({ fs: failingReadFs(note) });
  await harness.ipcMain.invoke("chat:register-dropped-paths", { paths: [note] });

  // 没有文字、唯一附件又构建失败 → 没有可发送的内容，整体报错。
  const result = await harness.ipcMain.invoke("chat:send", {
    text: "   ",
    attachments: [attachmentEntry(note)],
  });
  assert.equal(result.status, "error");
  assert.equal(result.message, "empty message");
  assert.deepEqual(result.warnings, ["附件「note.txt」读取失败，已跳过"]);
  assert.equal(harness.calls.some((entry) => entry[0] === "send"), false);
});

test("chat:list-commands returns the runtime command list or an empty array", async () => {
  const commands = [
    { name: "/compact", description: "压缩对话" },
    { name: "/clear", description: "清空对话" },
  ];
  const harness = createHarness({ state: { commands } });
  assert.deepEqual(await harness.ipcMain.invoke("chat:list-commands"), { status: "ok", commands });

  // 没有会话 / 旧 runtime 不带 commands 时安全降级为空数组。
  const without = createHarness();
  assert.deepEqual(await without.ipcMain.invoke("chat:list-commands"), { status: "ok", commands: [] });
});

// ── 第一波完善：粘贴图片通道 / 外链通道 ──

test("chat:save-pasted-image writes a real image into the temp dir and authorizes it", async () => {
  const harness = createHarness();
  const dataUrl = `data:image/png;base64,${PNG_1X1.toString("base64")}`;
  const result = await harness.ipcMain.invoke("chat:save-pasted-image", { dataUrl, name: "clip.png" });

  assert.equal(result.status, "ok");
  const file = result.file;
  assert.ok(path.isAbsolute(file.path), "落盘路径必须是绝对路径");
  assert.equal(path.dirname(file.path), harness.tempDir, "必须落在注入的 app.getPath('temp') 目录");
  assert.ok(fs.existsSync(file.path), "文件必须真的写到了磁盘上");
  assert.ok(fs.readFileSync(file.path).equals(PNG_1X1), "写入内容必须与粘贴的图片字节一致");
  assert.equal(file.name, "clip.png");
  assert.equal(file.size, PNG_1X1.length);
  assert.equal(file.isImage, true);
  assert.equal(file.preview, dataUrl, "preview 原样带回 data URL");

  // 路径已进授权集合：随后 chat:send 带它不再报 not allowed，并按图片块构建。
  const send = await harness.ipcMain.invoke("chat:send", {
    text: "看这张图",
    attachments: [attachmentEntry(file.path, { name: file.name, isImage: true })],
  });
  assert.notEqual(send.status, "error");
  const { blocks } = harness.calls.find((entry) => entry[0] === "send")[2];
  assert.deepEqual(blocks, [{
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG_1X1.toString("base64") },
  }]);
});

test("chat:save-pasted-image defaults the display name when the renderer sends none", async () => {
  const harness = createHarness();
  const result = await harness.ipcMain.invoke("chat:save-pasted-image", {
    dataUrl: `data:image/png;base64,${PNG_1X1.toString("base64")}`,
  });
  assert.equal(result.status, "ok");
  assert.equal(typeof result.file.name, "string");
  assert.notEqual(result.file.name.trim(), "");
  assert.equal(result.file.isImage, true);
});

test("chat:save-pasted-image rejects non-image, oversized and corrupt payloads without writing", async () => {
  const harness = createHarness();
  const huge = Buffer.alloc(8 * 1024 * 1024 + 3, 0x41).toString("base64");
  const cases = [
    ["非图片 data URL", { dataUrl: "data:text/plain;base64,aGk=" }],
    ["非光栅图片类型", { dataUrl: "data:image/svg+xml;base64,aGk=" }],
    ["不是 data URL", { dataUrl: "https://example.com/pic.png" }],
    ["超过 8MB", { dataUrl: `data:image/png;base64,${huge}` }],
    ["损坏的 base64", { dataUrl: "data:image/png;base64,!!!!" }],
    ["载荷缺失", undefined],
    ["载荷类型不对", { dataUrl: 42 }],
  ];
  for (const [label, payload] of cases) {
    const result = await harness.ipcMain.invoke("chat:save-pasted-image", payload);
    assert.equal(result.status, "error", label);
  }

  // 整张拒绝：一个文件都不许落盘。
  assert.deepEqual(fs.readdirSync(harness.tempDir), []);
});

test("chat:save-pasted-image accepts exactly 8MB but nothing larger", async () => {
  const harness = createHarness();
  const atLimit = Buffer.alloc(8 * 1024 * 1024, 0x41);
  const accepted = await harness.ipcMain.invoke("chat:save-pasted-image", {
    dataUrl: `data:image/png;base64,${atLimit.toString("base64")}`,
  });
  assert.equal(accepted.status, "ok", "8MB 整的图片不算超限");
  assert.equal(accepted.file.size, atLimit.length);
  assert.ok(fs.readFileSync(accepted.file.path).equals(atLimit));

  const overLimit = Buffer.alloc(8 * 1024 * 1024 + 3, 0x41);
  const rejected = await harness.ipcMain.invoke("chat:save-pasted-image", {
    dataUrl: `data:image/png;base64,${overLimit.toString("base64")}`,
  });
  assert.equal(rejected.status, "error");
});

test("chat:open-external opens http(s) links and rejects every other protocol", async () => {
  const harness = createHarness();
  assert.deepEqual(
    await harness.ipcMain.invoke("chat:open-external", { url: "https://example.com/a?b=1" }),
    { status: "ok" },
  );
  assert.deepEqual(
    await harness.ipcMain.invoke("chat:open-external", { url: "http://example.com/b" }),
    { status: "ok" },
  );
  assert.deepEqual(harness.shellCalls, ["https://example.com/a?b=1", "http://example.com/b"]);

  const rejected = [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "mailto:someone@example.com",
    "not a url",
    "",
  ];
  for (const url of rejected) {
    const result = await harness.ipcMain.invoke("chat:open-external", { url });
    assert.equal(result.status, "error", `必须拒绝 ${url}`);
  }
  const malformed = await harness.ipcMain.invoke("chat:open-external", { url: 42 });
  assert.equal(malformed.status, "error");
  assert.equal(harness.shellCalls.length, 2, "被拒绝的链接不得交给 shell.openExternal");
});

test("chat:open-external reports an error when the shell refuses to open the link", async () => {
  const harness = createHarness({
    shell: { openExternal: async () => { throw new Error("no browser handler"); } },
  });
  const result = await harness.ipcMain.invoke("chat:open-external", { url: "https://example.com" });
  assert.equal(result.status, "error");
});
