"use strict";

// src/chat-session-runtime.js（内置对话会话状态机）单元测试。
//
// 通过 createChatSessionRuntime({ driverFactory }) 的注入缝传入假 driver：
// 假 driver 记录每次调用，并可手动 emit 事件，从而完整驱动状态机而不碰真实 SDK。
//
// 事件契约来自 chat-driver-sdk.js 的统一 onEvent 形态：
//   init / text(delta|text) / thinking / tool-start / tool-end / result /
//   error / exit；权限确认不在本窗口内进行（走桌宠气泡的 PermissionRequest
//   hook），runtime 只在 init 事件里登记归属的 session 供路由豁免查询。

const test = require("node:test");
const assert = require("node:assert/strict");

const createChatSessionRuntime = require("../src/chat-session-runtime");

function createFakeDriverFactory() {
  const drivers = [];
  function driverFactory(options) {
    const driver = {
      options,
      calls: [],
      running: false,
      disposed: false,
      start: async () => {
        driver.calls.push(["start"]);
        driver.running = true;
        return true;
      },
      send: (text) => {
        driver.calls.push(["send", text]);
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
  const fake = createFakeDriverFactory();
  const findClaudeCmd = overrides.findClaudeCmd || (async () => "/usr/local/bin/claude");
  const runtime = createChatSessionRuntime({
    settingsController,
    findClaudeCmd,
    onUpdate: (state) => updates.push(state),
    driverFactory: overrides.driverFactory || fake.driverFactory,
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
  assert.deepEqual(state.messages[0], {
    id: state.messages[0].id,
    role: "user",
    kind: "text",
    text: "你好",
  });
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

  driver.emit({ kind: "result", subtype: "success", costUsd: 0.01, usage: {} });
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
      ["busy", "cwd", "effort", "messages", "model", "permissionMode", "sessionId", "status"],
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
