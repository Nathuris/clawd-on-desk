"use strict";

// src/chat-session-runtime.js（内置对话会话状态机）单元测试。
//
// 通过 createChatSessionRuntime({ driverFactory }) 的注入缝传入假 driver：
// 假 driver 记录每次调用，并可手动 emit 事件，从而完整驱动状态机而不碰真实 SDK。
//
// 事件契约来自 chat-driver-sdk.js 的统一 onEvent 形态：
//   init / text(delta|text) / thinking / tool-start(diffPreview?) / tool-end /
//   result(contextUsage) / error / exit；权限确认不在本窗口内进行
//   （走桌宠气泡的 PermissionRequest hook），runtime 只在 init 事件里登记归属的
//   session 供路由豁免查询。

const test = require("node:test");
const assert = require("node:assert/strict");

const createChatSessionRuntime = require("../src/chat-session-runtime");

function createFakeDriverFactory(config = {}) {
  // startResults：按 driver 创建顺序消费的启动结果；不足时默认成功。
  const startResults = Array.isArray(config.startResults) ? config.startResults.slice() : [];
  const drivers = [];
  function driverFactory(options) {
    const startResult = startResults.length ? startResults.shift() : true;
    const driver = {
      options,
      calls: [],
      // 附件 blocks 单独记录：既有断言只关心文本，附件用例检查透传。
      sendArgs: [],
      running: false,
      disposed: false,
      start: async () => {
        driver.calls.push(["start"]);
        if (startResult === false) return false;
        driver.running = true;
        return true;
      },
      send: (text, blocks) => {
        driver.calls.push(["send", text]);
        driver.sendArgs.push([text, blocks]);
        return true;
      },
      interrupt: async () => {
        driver.calls.push(["interrupt"]);
        return true;
      },
      setPermissionMode: async (mode) => {
        driver.calls.push(["setPermissionMode", mode]);
        return true;
      },
      dispose: async () => {
        driver.calls.push(["dispose"]);
        driver.disposed = true;
        driver.running = false;
      },
      isRunning: () => driver.running,
      // 测试助手：模拟 driver 向 runtime 推事件。
      emit(event) {
        options.onEvent(event);
      },
    };
    drivers.push(driver);
    return driver;
  }
  return { driverFactory, drivers };
}

function createHarness(overrides = {}) {
  const updates = [];
  const prefWrites = [];
  const prefs = {
    chatLastWorkingDir: "/tmp/chat-project",
    chatDefaultEffort: "medium",
    chatDefaultPermissionMode: "acceptEdits",
    ...(overrides.prefs || {}),
  };
  const settingsController = overrides.settingsController || {
    get: (key) => prefs[key],
    applyUpdate: (key, value) => {
      prefWrites.push([key, value]);
      prefs[key] = value;
      return { status: "ok" };
    },
  };
  const fake = createFakeDriverFactory({ startResults: overrides.startResults });
  const findClaudeCmd = overrides.findClaudeCmd || (async () => "/usr/local/bin/claude");
  const runtime = createChatSessionRuntime({
    settingsController,
    findClaudeCmd,
    onUpdate: (state) => updates.push(state),
    driverFactory: overrides.driverFactory || fake.driverFactory,
    loadBackfill: overrides.loadBackfill,
  });
  return {
    runtime,
    drivers: fake.drivers,
    updates,
    prefWrites,
    prefs,
    settingsController,
    findClaudeCmd,
  };
}

function messageOf(state, predicate) {
  return state.messages.find(predicate) || null;
}

test("initial state is derived from the persisted chat preferences", () => {
  const { runtime } = createHarness({
    prefs: {
      chatLastWorkingDir: "/tmp/proj",
      chatDefaultEffort: "high",
      chatDefaultPermissionMode: "plan",
    },
  });
  assert.deepEqual(runtime.getState(), {
    status: "idle",
    sessionId: null,
    cwd: "/tmp/proj",
    effort: "high",
    permissionMode: "plan",
    model: null,
    busy: false,
    messages: [],
    commands: [],
    contextUsage: null,
  });
});

test("invalid or missing preferences fall back to the contract defaults", () => {
  const { runtime } = createHarness({
    prefs: { chatLastWorkingDir: "", chatDefaultEffort: "wild", chatDefaultPermissionMode: "yolo" },
  });
  const state = runtime.getState();
  assert.equal(state.cwd, null);
  assert.equal(state.effort, "medium");
  assert.equal(state.permissionMode, "acceptEdits");
});

test("getState returns a detached message list", async () => {
  const { runtime } = createHarness();
  await runtime.send("你好");
  const snapshot = runtime.getState();
  assert.equal(snapshot.messages.length, 1);
  snapshot.messages.push({ id: "forged" });
  snapshot.messages[0].text = "hacked";
  const fresh = runtime.getState();
  assert.equal(fresh.messages.length, 1);
  assert.equal(fresh.messages[0].text, "你好");
});

test("send appends the user message, starts the driver, then forwards the text", async () => {
  const { runtime, drivers, updates, prefWrites } = createHarness();
  const sent = await runtime.send("  你好  ");
  assert.equal(sent, true);

  assert.equal(drivers.length, 1);
  const driver = drivers[0];
  assert.deepEqual(driver.calls, [["start"], ["send", "你好"]]);
  assert.equal(driver.options.cwd, "/tmp/chat-project");
  assert.equal(driver.options.effort, "medium");
  assert.equal(driver.options.permissionMode, "acceptEdits");
  assert.equal(driver.options.executable, "/usr/local/bin/claude");

  const state = runtime.getState();
  assert.equal(state.status, "starting");
  assert.equal(state.busy, true);
  assert.deepEqual(
    {
      id: state.messages[0].id,
      role: state.messages[0].role,
      kind: state.messages[0].kind,
      text: state.messages[0].text,
    },
    { id: state.messages[0].id, role: "user", kind: "text", text: "你好" },
  );
  assert.equal(typeof state.messages[0].ts, "number", "新消息必须带数字时间戳");
  assert.match(state.messages[0].id, /^chat-msg-/);

  // 先推“带用户消息的 thinking 快照”，再推 starting —— 渲染端不会闪掉刚发的消息。
  assert.equal(updates.length >= 2, true);
  assert.equal(updates[0].status, "thinking");
  assert.equal(updates[0].messages[0].text, "你好");
  assert.equal(updates[1].status, "starting");
  assert.deepEqual(prefWrites, []);
});

test("send without a working directory or with blank text is rejected", async () => {
  const withoutDir = createHarness({ prefs: { chatLastWorkingDir: "" } });
  assert.equal(await withoutDir.runtime.send("hello"), false);
  assert.deepEqual(withoutDir.runtime.getState().messages, []);
  assert.equal(withoutDir.drivers.length, 0);

  const withDir = createHarness();
  assert.equal(await withDir.runtime.send("   "), false);
  assert.deepEqual(withDir.runtime.getState().messages, []);
  assert.equal(withDir.drivers.length, 0);
});

test("a bare command name from findClaudeCmd is not used as an executable path", async () => {
  const { runtime, drivers } = createHarness({
    findClaudeCmd: async () => "claude",
  });
  await runtime.send("hi");
  assert.equal(drivers[0].options.executable, null);

  const throwing = createHarness({
    findClaudeCmd: async () => { throw new Error("not found"); },
  });
  await throwing.runtime.send("hi");
  assert.equal(throwing.drivers[0].options.executable, null);
  assert.deepEqual(throwing.drivers[0].calls, [["start"], ["send", "hi"]]);
});

test("init moves to thinking and text deltas merge into one streaming message", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("写点什么");
  const driver = drivers[0];

  driver.emit({ kind: "init", sessionId: "sess-1", model: "claude-sonnet" });
  let state = runtime.getState();
  assert.equal(state.status, "thinking");
  assert.equal(state.sessionId, "sess-1");
  assert.equal(state.model, "claude-sonnet");

  // thinking 增量只改状态，不产生消息。
  driver.emit({ kind: "thinking", delta: "hmm" });
  assert.equal(runtime.getState().messages.filter((m) => m.role === "assistant").length, 0);
  assert.equal(runtime.getState().status, "thinking");

  driver.emit({ kind: "text", delta: "Hel" });
  driver.emit({ kind: "text", delta: "lo" });
  state = runtime.getState();
  const assistantTexts = state.messages.filter((m) => m.role === "assistant" && m.kind === "text");
  assert.equal(assistantTexts.length, 1, "consecutive deltas must merge into one message");
  assert.equal(assistantTexts[0].text, "Hello");
  assert.equal(assistantTexts[0].streaming, true);
  assert.equal(state.status, "streaming");
  assert.equal(state.busy, true);

  driver.emit({ kind: "result", subtype: "success", usage: {} });
  state = runtime.getState();
  assert.equal(state.status, "idle");
  assert.equal(state.busy, false);
  assert.equal("streaming" in state.messages.find((m) => m.kind === "text" && m.role === "assistant"), false);
});

test("a full text event is stored as a completed assistant message", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("hi");
  const driver = drivers[0];
  driver.emit({ kind: "text", text: "完整回复" });
  const state = runtime.getState();
  const assistantTexts = state.messages.filter((m) => m.role === "assistant" && m.kind === "text");
  assert.equal(assistantTexts.length, 1);
  assert.equal(assistantTexts[0].text, "完整回复");
  assert.equal("streaming" in assistantTexts[0], false);
});

test("tool-start creates a running card and tool-end pairs by toolUseId", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("列出文件");
  const driver = drivers[0];

  driver.emit({ kind: "tool-start", toolName: "Bash", summary: "ls -la", toolUseId: "tu1" });
  let state = runtime.getState();
  let card = messageOf(state, (m) => m.kind === "tool");
  assert.deepEqual(
    { role: card.role, kind: card.kind, toolName: card.toolName, summary: card.summary, status: card.status },
    { role: "assistant", kind: "tool", toolName: "Bash", summary: "ls -la", status: "running" },
  );
  assert.equal(state.status, "tool");

  driver.emit({ kind: "tool-end", toolUseId: "tu1", isError: false, resultText: "file1\nfile2" });
  state = runtime.getState();
  card = messageOf(state, (m) => m.kind === "tool");
  assert.equal(card.status, "done");
  assert.equal(card.resultText, "file1\nfile2");
  assert.equal(state.status, "thinking", "no running tools left → back to thinking");

  driver.emit({ kind: "tool-start", toolName: "Read", summary: "/tmp/a.txt", toolUseId: "tu2" });
  driver.emit({ kind: "tool-end", toolUseId: "tu2", isError: true, resultText: "boom" });
  card = messageOf(runtime.getState(), (m) => m.toolName === "Read");
  assert.equal(card.status, "error");

  // result 到达时仍 running 的卡片兜底收尾为 done。
  driver.emit({ kind: "tool-start", toolName: "Grep", summary: "x", toolUseId: "tu3" });
  driver.emit({ kind: "result", subtype: "success" });
  assert.equal(messageOf(runtime.getState(), (m) => m.toolName === "Grep").status, "done");
  assert.equal(runtime.getState().status, "idle");
});

test("isOwnedSession only recognizes sessions announced by this runtime's driver", async () => {
  const { runtime, drivers } = createHarness();
  assert.equal(runtime.isOwnedSession("sess-1"), false, "nothing is owned before the driver init");

  await runtime.send("hi");
  drivers[0].emit({ kind: "init", sessionId: "sess-1", model: "claude-x" });
  assert.equal(runtime.isOwnedSession("sess-1"), true);
  assert.equal(runtime.isOwnedSession("sess-2"), false, "unknown session ids are not owned");

  // 归属只属于登记它的那个 runtime。
  const other = createHarness();
  assert.equal(other.runtime.isOwnedSession("sess-1"), false);
});

test("isOwnedSession tolerates empty and non-string ids", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("hi");
  drivers[0].emit({ kind: "init", sessionId: "sess-1", model: "claude-x" });

  for (const value of [null, undefined, "", 42, {}]) {
    assert.equal(runtime.isOwnedSession(value), false, `isOwnedSession(${String(value)}) must be false`);
  }
});

test("session ids from earlier sessions stay recognizable after switching", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("第一句");
  drivers[0].emit({ kind: "init", sessionId: "sess-1" });
  assert.equal(runtime.isOwnedSession("sess-1"), true);

  // 换 effort = 开新会话：旧 id 仍要可识别（在途的权限请求可能还带着它）。
  await runtime.setEffort("high");
  assert.equal(runtime.isOwnedSession("sess-1"), true, "session reset must not forget earlier ids");
  assert.equal(runtime.getState().sessionId, null);

  await runtime.send("第二句");
  assert.equal(drivers.length, 2);
  drivers[1].emit({ kind: "init", sessionId: "sess-2" });
  assert.equal(runtime.isOwnedSession("sess-1"), true);
  assert.equal(runtime.isOwnedSession("sess-2"), true);

  // newSession 清空对话也不清登记。
  await runtime.newSession();
  assert.equal(runtime.isOwnedSession("sess-1"), true);
  assert.equal(runtime.isOwnedSession("sess-2"), true);

  // 被替换掉的旧 driver 再发 init 也不会登记（事件按 sourceDriver 丢弃）。
  drivers[0].emit({ kind: "init", sessionId: "sess-stale" });
  assert.equal(runtime.isOwnedSession("sess-stale"), false);
});

test("stop interrupts the driver and returns to idle immediately", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("停一下");
  const driver = drivers[0];
  assert.equal(driver.running, true);

  const stopped = await runtime.stop();
  assert.equal(stopped, true);
  assert.ok(driver.calls.some(([name]) => name === "interrupt"));
  const state = runtime.getState();
  assert.equal(state.status, "idle");
  assert.equal(state.busy, false);

  // driver 退出后 runtime 丢弃它，下一次发送会新建 driver。
  driver.emit({ kind: "exit", code: 0 });
  await runtime.send("再来");
  assert.equal(drivers.length, 2);
});

test("setPermissionMode updates state, persists the pref, and hot-switches a running driver", async () => {
  const { runtime, drivers, prefWrites } = createHarness();
  await runtime.send("hi");
  const driver = drivers[0];

  assert.equal(await runtime.setPermissionMode("plan"), true);
  assert.equal(runtime.getState().permissionMode, "plan");
  assert.deepEqual(prefWrites, [["chatDefaultPermissionMode", "plan"]]);
  assert.ok(driver.calls.some(([name, value]) => name === "setPermissionMode" && value === "plan"));

  assert.equal(await runtime.setPermissionMode("not-a-mode"), false);
  assert.equal(runtime.getState().permissionMode, "plan");
  assert.equal(prefWrites.length, 1);
});

test("setEffort starts a new session, persists the pref, and keeps the messages", async () => {
  const { runtime, drivers, prefWrites } = createHarness();
  await runtime.send("第一句");
  drivers[0].emit({ kind: "init", sessionId: "sess-1", model: "claude-x" });
  drivers[0].emit({ kind: "text", delta: "回复" });

  assert.equal(await runtime.setEffort("high"), true);
  const state = runtime.getState();
  assert.equal(state.effort, "high");
  assert.deepEqual(prefWrites, [["chatDefaultEffort", "high"]]);
  assert.equal(state.sessionId, null, "effort only applies at session start → new session");
  assert.equal(state.model, null);
  assert.equal(state.status, "idle");
  assert.ok(drivers[0].calls.some(([name]) => name === "dispose"), "the old driver must be disposed");
  assert.ok(
    state.messages.some((m) => m.role === "system" && m.kind === "notice" && m.text === "chatNoticeNewSessionForEffort"),
    "a notice must explain the forced new session",
  );
  assert.ok(state.messages.some((m) => m.role === "user" && m.text === "第一句"));
  assert.ok(state.messages.some((m) => m.role === "assistant" && m.text === "回复"));

  // 下一次发送用新 effort 起新 driver；旧 driver 的事件一律丢弃。
  await runtime.send("第二句");
  assert.equal(drivers.length, 2);
  assert.equal(drivers[1].options.effort, "high");
  drivers[0].emit({ kind: "text", delta: "stale" });
  assert.equal(runtime.getState().messages.some((m) => m.text && m.text.includes("stale")), false);

  assert.equal(await runtime.setEffort("not-a-level"), false);
  assert.equal(runtime.getState().effort, "high");
});

test("setWorkingDir switches the context, persists the pref, and keeps the messages", async () => {
  const { runtime, drivers, prefWrites } = createHarness();
  await runtime.send("hi");

  assert.equal(await runtime.setWorkingDir("/tmp/other-project"), true);
  let state = runtime.getState();
  assert.equal(state.cwd, "/tmp/other-project");
  assert.deepEqual(prefWrites, [["chatLastWorkingDir", "/tmp/other-project"]]);
  assert.equal(state.sessionId, null);
  assert.ok(drivers[0].calls.some(([name]) => name === "dispose"));
  assert.ok(
    state.messages.some((m) => m.role === "system" && m.kind === "notice" && m.text === "chatNoticeDirChanged"),
  );
  assert.ok(state.messages.some((m) => m.role === "user" && m.text === "hi"));

  // 同一个目录重复设置是幂等的：不再新增 notice，也不再 dispose。
  const disposeCalls = drivers[0].calls.filter(([name]) => name === "dispose").length;
  assert.equal(await runtime.setWorkingDir("/tmp/other-project"), true);
  assert.equal(drivers[0].calls.filter(([name]) => name === "dispose").length, disposeCalls);
  assert.equal(
    runtime.getState().messages.filter((m) => m.kind === "notice" && m.text === "chatNoticeDirChanged").length,
    1,
  );

  assert.equal(await runtime.setWorkingDir(""), false);
  assert.equal(runtime.getState().cwd, "/tmp/other-project");
});

test("newSession clears the transcript and disposes the driver", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("hi");
  drivers[0].emit({ kind: "init", sessionId: "sess-1", model: "claude-x" });

  assert.equal(await runtime.newSession(), true);
  const state = runtime.getState();
  assert.deepEqual(state.messages, []);
  assert.equal(state.sessionId, null);
  assert.equal(state.model, null);
  assert.equal(state.status, "idle");
  assert.ok(drivers[0].calls.some(([name]) => name === "dispose"));
  assert.deepEqual(state, {
    status: "idle",
    sessionId: null,
    cwd: "/tmp/chat-project",
    effort: "medium",
    permissionMode: "acceptEdits",
    model: null,
    busy: false,
    messages: [],
    commands: [],
    contextUsage: null,
  });
});

test("driver errors surface as a system error message and error status", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("hi");
  drivers[0].emit({ kind: "error", message: "boom" });

  const state = runtime.getState();
  assert.equal(state.status, "error");
  assert.equal(state.busy, false);
  const errorMessage = state.messages.at(-1);
  assert.deepEqual(
    { role: errorMessage.role, kind: errorMessage.kind, text: errorMessage.text },
    { role: "system", kind: "error", text: "boom" },
  );
});

test("onUpdate always receives a full snapshot", async () => {
  const { runtime, updates } = createHarness();
  await runtime.send("hi");
  assert.ok(updates.length > 0);
  for (const update of updates) {
    assert.deepEqual(
      Object.keys(update).sort(),
      [
        "busy", "commands", "contextUsage", "cwd", "effort",
        "messages", "model", "permissionMode", "sessionId", "status",
      ],
    );
    assert.ok(Array.isArray(update.messages));
  }
  assert.deepEqual(updates.at(-1), runtime.getState());
});

test("ensureStarted starts once, and dispose cleans the driver up", async () => {
  const { runtime, drivers } = createHarness();
  assert.equal(await runtime.ensureStarted(), true);
  assert.equal(drivers.length, 1);
  await runtime.ensureStarted();
  assert.equal(drivers.length, 1, "an already running driver must be reused");
  assert.deepEqual(drivers[0].calls, [["start"]]);

  await runtime.dispose();
  assert.ok(drivers[0].calls.some(([name]) => name === "dispose"));
  await assert.doesNotReject(() => runtime.dispose());
});

test("consecutive sends reuse the running driver", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("one");
  await runtime.send("two");
  assert.equal(drivers.length, 1);
  assert.deepEqual(drivers[0].calls, [["start"], ["send", "one"], ["send", "two"]]);
  const texts = runtime.getState().messages.filter((m) => m.role === "user").map((m) => m.text);
  assert.deepEqual(texts, ["one", "two"]);
});

test("getActiveSessionIds tracks the current session", async () => {
  const { runtime, drivers } = createHarness();
  assert.deepEqual(runtime.getActiveSessionIds(), [], "nothing active before the first session");

  await runtime.send("hi");
  assert.deepEqual(runtime.getActiveSessionIds(), [], "the id is unknown until the driver announces it");
  drivers[0].emit({ kind: "init", sessionId: "sess-1" });
  assert.deepEqual(runtime.getActiveSessionIds(), ["sess-1"]);

  await runtime.newSession();
  assert.deepEqual(runtime.getActiveSessionIds(), [], "newSession releases the active session");
});

test("resumeSession disposes the old driver, backfills messages, and starts a resumed driver", async () => {
  const backfillCalls = [];
  const backfillMessages = [
    { id: "bf-1", role: "user", kind: "text", text: "之前的问题" },
    { id: "bf-2", role: "assistant", kind: "tool", toolName: "Bash", summary: "ls", status: "done", resultText: "a\nb" },
    { id: "bf-3", role: "assistant", kind: "text", text: "之前的回答" },
  ];
  const { runtime, drivers } = createHarness({
    loadBackfill: async (sessionId) => {
      backfillCalls.push(sessionId);
      return backfillMessages;
    },
  });

  // 先有一个进行中的会话：恢复时旧消息要被历史记录整体替换。
  await runtime.send("旧对话");
  drivers[0].emit({ kind: "init", sessionId: "old-sess" });
  await runtime.send("再来一句");
  assert.deepEqual(runtime.getActiveSessionIds(), ["old-sess"]);

  const result = await runtime.resumeSession({ sessionId: "  sess-history  " });
  assert.deepEqual(result, { status: "ok" });
  assert.deepEqual(backfillCalls, ["sess-history"], "loadBackfill must receive the trimmed session id");

  // 旧 driver 被释放，新 driver 带 resume 选项在同一目录启动。
  assert.ok(drivers[0].calls.some(([name]) => name === "dispose"), "the old driver must be disposed");
  assert.equal(drivers.length, 2);
  assert.equal(drivers[1].options.resume, "sess-history");
  assert.equal(drivers[1].options.cwd, "/tmp/chat-project");
  assert.deepEqual(drivers[1].calls, [["start"]]);

  // 回填消息整体替换旧消息，并带一条「已载入历史对话」提示。
  let state = runtime.getState();
  assert.deepEqual(
    state.messages.filter((m) => m.kind === "text").map((m) => m.text),
    ["之前的问题", "之前的回答"],
  );
  const toolCard = messageOf(state, (m) => m.kind === "tool");
  assert.deepEqual(
    { toolName: toolCard.toolName, summary: toolCard.summary, status: toolCard.status, resultText: toolCard.resultText },
    { toolName: "Bash", summary: "ls", status: "done", resultText: "a\nb" },
  );
  assert.ok(state.messages.some((m) => m.role === "system" && m.kind === "notice" && m.text === "chatHistoryResumed"));
  // 续聊模式下 CLI 要等第一条输入才发 init：启动成功即回到可输入状态，
  // 不能等 init（否则发送按钮会一直禁用，用户得先点停止——见回归用例）。
  assert.equal(state.status, "idle");
  assert.equal(state.busy, false);

  // 还没等到 init：恢复中的会话 id 也必须在 active 列表里（供历史列表排除）。
  assert.deepEqual(runtime.getActiveSessionIds(), ["sess-history"]);

  // init 到达后依然可聊，消息走新 driver。
  drivers[1].emit({ kind: "init", sessionId: "sess-history", model: "claude-x" });
  state = runtime.getState();
  assert.equal(state.status, "idle");
  assert.equal(state.busy, false);
  assert.equal(state.sessionId, "sess-history");
  assert.deepEqual(runtime.getActiveSessionIds(), ["sess-history"]);

  assert.equal(await runtime.send("继续聊"), true);
  assert.deepEqual(drivers[1].calls, [["start"], ["send", "继续聊"]]);
  assert.equal(runtime.getState().messages.at(-1).text, "继续聊");
});

test("resumeSession returns to idle without waiting for init (composer must not stay stuck busy)", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("旧的对话");
  drivers[0].emit({ kind: "init", sessionId: "old-sess" });

  assert.deepEqual(await runtime.resumeSession({ sessionId: "sess-x" }), { status: "ok" });

  // 续聊模式下 CLI 直到第一条消息才发 init（实测确认）：此刻界面必须已可输入，
  // 否则发送按钮一直禁用、只剩停止，用户必须先点停止才能说话（用户报告的 bug）。
  assert.equal(runtime.getState().status, "idle");
  assert.equal(runtime.getState().busy, false);

  // 无需先停止，直接发送即可。
  assert.equal(await runtime.send("接着聊"), true);
  assert.deepEqual(drivers[1].calls, [["start"], ["send", "接着聊"]]);
  assert.equal(runtime.getState().status, "thinking");
});

test("resumeSession keeps the truncation notice when the backfill fills MAX_MESSAGES", async () => {
  // 回填置顶了一条「历史已截断」提示 + 200 条真实消息（共 201 条，超过上限）。
  const backfill = [
    { id: "bf-notice", role: "system", kind: "notice", text: "chatHistoryTruncated" },
  ];
  for (let i = 0; i < 200; i += 1) {
    backfill.push({ id: `bf-${i}`, role: "user", kind: "text", text: `第${i}条` });
  }
  const { runtime } = createHarness({ loadBackfill: async () => backfill });
  assert.deepEqual(await runtime.resumeSession({ sessionId: "sess-1" }), { status: "ok" });

  const state = runtime.getState();
  const notice = messageOf(state, (m) => m.id === "bf-notice");
  assert.ok(notice, "置顶的截断提示不能被 MAX_MESSAGES 裁剪删掉");
  assert.equal(notice.text, "chatHistoryTruncated");
  // 「已载入历史对话」提示同样保留，两条提示都不占消息条数额度。
  assert.ok(state.messages.some((m) => m.text === "chatHistoryResumed"));
  assert.ok(state.messages.length <= 201, "提示之外的实时消息仍受上限约束");
  // 裁剪只能从最旧的普通消息开始丢，最新的回填消息必须在。
  assert.ok(state.messages.some((m) => m.text === "第199条"));
});

test("resumeSession keeps the backfill and reports error when the resumed driver fails to start", async () => {
  const { runtime, drivers } = createHarness({
    startResults: [true, false],
    loadBackfill: async () => [{ id: "bf-1", role: "user", kind: "text", text: "历史问题" }],
  });
  await runtime.send("hi");
  drivers[0].emit({ kind: "init", sessionId: "sess-1" });

  const result = await runtime.resumeSession({ sessionId: "sess-2" });
  assert.deepEqual(result, { status: "error", message: "failed to start resumed session" });
  const state = runtime.getState();
  assert.equal(state.status, "error");
  assert.equal(state.busy, false);
  assert.equal(state.sessionId, null);
  assert.ok(state.messages.some((m) => m.role === "user" && m.text === "历史问题"), "backfill must be kept on failure");
  assert.ok(state.messages.some((m) => m.kind === "notice" && m.text === "chatHistoryResumed"));
  assert.equal(state.messages.some((m) => m.kind === "text" && m.text === "hi"), false, "old messages stay replaced");
  assert.deepEqual(runtime.getActiveSessionIds(), [], "a failed resume must not leave the id active");

  // 失败的 resume 意图不能泄漏到下一次普通启动（driver 2 是 send 新起的）。
  await runtime.send("新话题");
  assert.equal(drivers.length, 3);
  assert.equal(drivers[1].options.resume, "sess-2", "the failed driver was created with the resume id");
  assert.equal(drivers[2].options.resume, null);
  assert.equal(runtime.getState().messages.at(-1).text, "新话题");
});

test("resumeSession still starts when loadBackfill is missing or fails", async () => {
  const noBackfill = createHarness();
  assert.deepEqual(await noBackfill.runtime.resumeSession({ sessionId: "sess-a" }), { status: "ok" });
  assert.equal(noBackfill.drivers[0].options.resume, "sess-a");
  assert.deepEqual(
    noBackfill.runtime.getState().messages.map((m) => m.text),
    ["chatHistoryResumed"],
  );

  const broken = createHarness({
    loadBackfill: async () => { throw new Error("transcript unreadable"); },
  });
  assert.deepEqual(await broken.runtime.resumeSession({ sessionId: "sess-b" }), { status: "ok" });
  assert.equal(broken.drivers[0].options.resume, "sess-b");
  assert.deepEqual(
    broken.runtime.getState().messages.map((m) => m.text),
    ["chatHistoryResumed"],
    "a failed backfill must not block the resume",
  );
});

test("resumeSession accepts a per-call loadBackfill (IPC handoff) over the injected one", async () => {
  const calls = [];
  const { runtime, drivers } = createHarness({
    loadBackfill: async () => {
      calls.push("injected");
      return [];
    },
  });
  const result = await runtime.resumeSession({
    sessionId: "sess-1",
    loadBackfill: async (sessionId) => {
      calls.push(["call", sessionId]);
      return [{ id: "bf-1", role: "user", kind: "text", text: "从参数来" }];
    },
  });
  assert.deepEqual(result, { status: "ok" });
  assert.deepEqual(calls, [["call", "sess-1"]]);
  assert.equal(drivers[0].options.resume, "sess-1");
  assert.ok(runtime.getState().messages.some((m) => m.text === "从参数来"));
});

test("resumeSession accepts a { messages } backfill result shape too", async () => {
  const { runtime } = createHarness({
    loadBackfill: async () => ({
      messages: [{ id: "bf-1", role: "assistant", kind: "text", text: "对象形态" }],
      truncated: true,
    }),
  });
  assert.deepEqual(await runtime.resumeSession({ sessionId: "sess-1" }), { status: "ok" });
  assert.ok(runtime.getState().messages.some((m) => m.text === "对象形态"));
});

test("resumeSession validates the session id and the working directory", async () => {
  const { runtime, drivers } = createHarness();
  assert.deepEqual(await runtime.resumeSession({}), { status: "error", message: "invalid session id" });
  assert.deepEqual(await runtime.resumeSession({ sessionId: "   " }), { status: "error", message: "invalid session id" });
  assert.deepEqual(await runtime.resumeSession({ sessionId: 42 }), { status: "error", message: "invalid session id" });
  assert.equal(drivers.length, 0);

  const noDir = createHarness({ prefs: { chatLastWorkingDir: "" } });
  assert.deepEqual(
    await noDir.runtime.resumeSession({ sessionId: "sess-1" }),
    { status: "error", message: "no working directory" },
  );
  assert.equal(noDir.drivers.length, 0);
});

test("resumeSession aborts when the context is reset while the backfill loads", async () => {
  let releaseBackfill;
  const gate = new Promise((resolve) => { releaseBackfill = resolve; });
  const { runtime, drivers } = createHarness({
    loadBackfill: async () => { await gate; return []; },
  });

  const pending = runtime.resumeSession({ sessionId: "sess-1" });
  await new Promise((resolve) => setImmediate(resolve));
  await runtime.newSession();
  releaseBackfill([]);

  assert.deepEqual(await pending, { status: "error", message: "resume cancelled" });
  assert.equal(drivers.length, 0, "no driver may be started after the resume was cancelled");
  const state = runtime.getState();
  assert.equal(state.status, "idle");
  assert.equal(state.busy, false);
  assert.deepEqual(state.messages, []);
});

test("resumed messages get runtime ids when the backfill id is missing or duplicated", async () => {
  const { runtime } = createHarness({
    loadBackfill: async () => [
      { role: "user", kind: "text", text: "a" },
      { id: "dup", role: "assistant", kind: "text", text: "b" },
      { id: "dup", role: "assistant", kind: "text", text: "c" },
    ],
  });
  assert.deepEqual(await runtime.resumeSession({ sessionId: "sess-1" }), { status: "ok" });

  const texts = runtime.getState().messages.filter((m) => m.kind === "text");
  assert.deepEqual(texts.map((m) => m.text), ["a", "b", "c"]);
  assert.match(texts[0].id, /^chat-msg-/);
  assert.equal(texts[1].id, "dup");
  assert.match(texts[2].id, /^chat-msg-/, "a duplicated id must be replaced");
  assert.equal(new Set(texts.map((m) => m.id)).size, 3);
});

// ── 附件与斜杠指令 ──

test("send forwards attachment blocks to the driver and stores the attachment metadata", async () => {
  const { runtime, drivers } = createHarness();
  const blocks = [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
  ];
  const attachments = [
    { name: "pic.png", size: 1234, isImage: true, thumb: "data:image/png;base64,aGk=" },
    { name: "note.txt", size: 12, isImage: false },
  ];
  assert.equal(await runtime.send("看这些附件", { blocks, attachments }), true);

  // blocks 原样透传给 driver（driver 契约：send(text, blocks)）。
  assert.deepEqual(drivers[0].sendArgs, [["看这些附件", blocks]]);
  const message = runtime.getState().messages[0];
  assert.equal(message.role, "user");
  assert.equal(message.kind, "text");
  assert.equal(message.text, "看这些附件");
  assert.deepEqual(message.attachments, attachments, "附件元数据必须存进用户消息");
});

test("send accepts an attachment-only turn without text and rejects fully empty sends", async () => {
  const { runtime, drivers } = createHarness();
  const blocks = [{ type: "text", text: "文件内容" }];
  const attachments = [{ name: "note.txt", size: 12, isImage: false }];

  assert.equal(await runtime.send("", { blocks, attachments }), true);
  const message = runtime.getState().messages[0];
  assert.equal(message.role, "user");
  assert.equal(message.text, "");
  assert.deepEqual(message.attachments, attachments);
  assert.deepEqual(drivers[0].sendArgs, [["", blocks]]);

  const empty = createHarness();
  assert.equal(await empty.runtime.send("", {}), false);
  assert.equal(
    await empty.runtime.send("   ", { attachments }),
    false,
    "只有附件元数据、没有任何 blocks 的请求不算内容，必须拒绝",
  );
  assert.deepEqual(empty.runtime.getState().messages, []);
  assert.equal(empty.drivers.length, 0, "被拒绝的发送不得启动 driver");
});

test("commands state starts empty, fills from driver commands events, and emits snapshots", async () => {
  const { runtime, drivers, updates } = createHarness();
  assert.deepEqual(runtime.getState().commands, []);

  await runtime.send("hi");
  drivers[0].emit({
    kind: "commands",
    commands: [
      { name: "/compact", description: "压缩对话" },
      { name: "/clear", description: "清空对话" },
    ],
  });

  const state = runtime.getState();
  assert.deepEqual(state.commands, [
    { name: "/compact", description: "压缩对话" },
    { name: "/clear", description: "清空对话" },
  ]);
  assert.deepEqual(updates.at(-1).commands, state.commands, "commands 更新必须推送完整快照");

  // 快照是拷贝：渲染端改动不得串回 runtime 内部状态。
  state.commands[0].name = "/hacked";
  assert.equal(runtime.getState().commands[0].name, "/compact");
});

test("commands events from a replaced driver are ignored", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("one");
  drivers[0].emit({ kind: "init", sessionId: "sess-1" });

  // 换 effort = 换代：被替换掉的旧 driver 再发事件一律丢弃。
  await runtime.setEffort("high");
  drivers[0].emit({ kind: "commands", commands: [{ name: "/stale", description: "" }] });
  assert.deepEqual(runtime.getState().commands, []);
});

// ── 第一波完善：diff 预览 / 上下文用量 / 消息时间戳 ──

test("tool cards carry the diff preview from the driver event", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("改文件");
  const driver = drivers[0];

  driver.emit({
    kind: "tool-start",
    toolName: "Edit",
    summary: "/tmp/a.txt",
    toolUseId: "tu-diff",
    diffPreview: { oldText: "旧行", newText: "新行" },
  });
  const card = messageOf(runtime.getState(), (m) => m.kind === "tool");
  assert.deepEqual(card.diff, { oldText: "旧行", newText: "新行" }, "diffPreview 必须落到卡片的 diff 字段");
  assert.equal(typeof card.ts, "number");

  driver.emit({ kind: "tool-start", toolName: "Bash", summary: "ls", toolUseId: "tu-bash" });
  const bash = messageOf(runtime.getState(), (m) => m.toolName === "Bash");
  assert.equal(bash.diff, undefined, "没有 diffPreview 的工具卡片不带 diff 字段");
});

test("contextUsage starts null and updates from result events", async () => {
  const { runtime, drivers } = createHarness();
  let state = runtime.getState();
  assert.equal(state.contextUsage, null);

  await runtime.send("hi");
  drivers[0].emit({ kind: "init", sessionId: "sess-1" });
  drivers[0].emit({
    kind: "result",
    subtype: "success",
    contextUsage: { percent: 12, usedTokens: 1200, maxTokens: 10000 },
  });
  state = runtime.getState();
  assert.deepEqual(state.contextUsage, { percent: 12, usedTokens: 1200, maxTokens: 10000 });

  // driver 查不到用量时回 null。
  drivers[0].emit({ kind: "result", subtype: "success", contextUsage: null });
  state = runtime.getState();
  assert.equal(state.contextUsage, null);
});

test("session context resets clear contextUsage", async () => {
  const { runtime, drivers } = createHarness();
  await runtime.send("hi");
  drivers[0].emit({
    kind: "result",
    subtype: "success",
    contextUsage: { percent: 12, usedTokens: 1200, maxTokens: 10000 },
  });

  // 换 effort = 重置会话上下文。
  await runtime.setEffort("high");
  let state = runtime.getState();
  assert.equal(state.contextUsage, null, "新会话的旧上下文用量必须清空");

  // 换目录同样重置上下文。
  await runtime.send("再来");
  drivers[1].emit({
    kind: "result",
    subtype: "success",
    contextUsage: { percent: 30, usedTokens: 3000, maxTokens: 10000 },
  });
  await runtime.setWorkingDir("/tmp/other");
  state = runtime.getState();
  assert.equal(state.contextUsage, null);

  // newSession 清空对话同样属于会话上下文重置。
  await runtime.send("第三句");
  drivers[2].emit({
    kind: "result",
    subtype: "success",
    contextUsage: { percent: 40, usedTokens: 4000, maxTokens: 10000 },
  });
  await runtime.newSession();
  state = runtime.getState();
  assert.equal(state.contextUsage, null, "newSession 后旧上下文用量必须清空");
});

test("newly created messages carry a numeric ts", async () => {
  const { runtime, drivers } = createHarness();
  const before = Date.now();
  await runtime.send("现在几点");
  const after = Date.now();

  const userMessage = runtime.getState().messages[0];
  assert.equal(typeof userMessage.ts, "number");
  assert.ok(userMessage.ts >= before && userMessage.ts <= after);

  drivers[0].emit({ kind: "text", delta: "回复" });
  const assistant = runtime.getState().messages.find((m) => m.role === "assistant" && m.kind === "text");
  assert.equal(typeof assistant.ts, "number");
  assert.ok(assistant.ts >= before && assistant.ts <= Date.now());
});

test("backfilled messages keep their own ts and get one when missing", async () => {
  const { runtime } = createHarness({
    loadBackfill: async () => [
      { id: "bf-1", role: "user", kind: "text", text: "带时间的历史", ts: 111 },
      { id: "bf-2", role: "assistant", kind: "text", text: "没时间的历史" },
    ],
  });
  assert.deepEqual(await runtime.resumeSession({ sessionId: "sess-1" }), { status: "ok" });

  const state = runtime.getState();
  assert.equal(state.messages.find((m) => m.id === "bf-1").ts, 111, "回填消息已有的 ts 不得被覆盖");
  const stamped = state.messages.find((m) => m.id === "bf-2").ts;
  assert.equal(typeof stamped, "number", "没有 ts 的回填消息也要补齐数字时间戳");
  assert.ok(stamped > 0);
});
