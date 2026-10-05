"use strict";

// src/preload-chat.js 的验证：window.chatAPI 的形状、调用转发的 IPC 通道、
// 以及 chat:update 订阅的转发与精准退订。
//
// preload 在沙箱里只能 require("electron")，测试按 test/preload-settings.test.js
// 的惯例用 vm + 假 contextBridge/ipcRenderer 加载。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const PRELOAD_CHAT = path.join(__dirname, "..", "src", "preload-chat.js");

function loadPreload() {
  const invokes = [];
  const ipcHandlers = new Map();
  const exposed = new Map();
  const ipcRenderer = {
    invoke: (...args) => {
      invokes.push(args);
      return Promise.resolve({ status: "ok" });
    },
    send: () => {},
    on(channel, handler) {
      if (!ipcHandlers.has(channel)) ipcHandlers.set(channel, new Set());
      ipcHandlers.get(channel).add(handler);
    },
    removeListener(channel, handler) {
      const handlers = ipcHandlers.get(channel);
      if (handlers) handlers.delete(handler);
    },
  };
  const contextBridge = {
    exposeInMainWorld(name, value) {
      exposed.set(name, value);
    },
  };
  // 与 preload-hit.js 同款：拖拽的 File → 绝对路径只能经 electron 的 webUtils。
  const webUtils = {
    getPathForFile: (file) => (file && typeof file === "object" && file.__testPath) || "",
  };
  const context = {
    console,
    process: { argv: [] },
    require(name) {
      if (name === "electron") return { contextBridge, ipcRenderer, webUtils };
      throw new Error(`Unexpected preload dependency: ${name}`);
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(PRELOAD_CHAT, "utf8"), context, {
    filename: PRELOAD_CHAT,
  });
  return {
    exposed,
    invokes,
    // 只用当前还挂着的监听器派发（退订后就不再收到），兼容“单监听扇出”
    // 和“每个订阅各挂一个监听器”两种实现。
    dispatch(channel, payload) {
      for (const handler of [...(ipcHandlers.get(channel) || [])]) {
        handler({}, payload);
      }
    },
  };
}

// invoke 载荷允许直接传值，也允许包一层对象（实现未在契约里固定形状时两者都算对）。
function payloadValue(payload, field) {
  if (payload === undefined) return undefined;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload[field];
  return payload;
}

test("chat preload exposes exactly the reply-window surface", () => {
  const { exposed } = loadPreload();
  const chatAPI = exposed.get("chatAPI");
  assert.ok(chatAPI, "preload must expose window.chatAPI");
  for (const method of [
    "getState",
    "stop",
    "newSession",
    "setShowUserMessages",
    "openExternal",
    "listHistory",
    "resumeSession",
    "onUpdate",
  ]) {
    assert.equal(typeof chatAPI[method], "function", `chatAPI.${method} must be a function`);
  }
  // 只读窗口：发送 / 附件 / 指令 / 目录 / effort / 权限模式都不再从窗口暴露
  for (const gone of [
    "send",
    "pickWorkingDir",
    "setEffort",
    "setPermissionMode",
    "pickAttachments",
    "savePastedImage",
    "listCommands",
    "registerDroppedPaths",
    "getPathForFile",
  ]) {
    assert.equal(gone in chatAPI, false, `chatAPI.${gone} must not be exposed anymore`);
  }
  // 权限确认走桌宠气泡：窗口 API 不再暴露决策入口。
  assert.equal("respondPermission" in chatAPI, false, "respondPermission must not be exposed");
});

test("chat preload forwards each operation to its dedicated invoke channel", async () => {
  const { exposed, invokes } = loadPreload();
  const chatAPI = exposed.get("chatAPI");
  const historyKey = "a".repeat(32);

  await chatAPI.getState();
  await chatAPI.stop();
  await chatAPI.newSession();
  await chatAPI.setShowUserMessages(true);
  await chatAPI.openExternal("https://example.com/docs");
  await chatAPI.listHistory();
  await chatAPI.resumeSession(historyKey);

  assert.deepEqual(
    invokes.map(([channel]) => channel),
    [
      "chat:get-state",
      "chat:stop",
      "chat:new-session",
      "chat:set-show-user-messages",
      "chat:open-external",
      "chat:list-history",
      "chat:resume-session",
    ],
  );
  // 开关只传严格布尔：非 true 一律按 false（与主进程校验一致）
  assert.equal(invokes[3][1], true);
  assert.equal(payloadValue(invokes[4][1], "url"), "https://example.com/docs");
  assert.equal(payloadValue(invokes[6][1], "historyKey"), historyKey);

  // invoke 的结果原样返回给渲染端。
  assert.deepEqual(await chatAPI.getState(), { status: "ok" });
});

test("chat preload coerces the show-user-messages flag to a strict boolean", async () => {
  const { exposed, invokes } = loadPreload();
  const chatAPI = exposed.get("chatAPI");
  await chatAPI.setShowUserMessages("yes");
  await chatAPI.setShowUserMessages(undefined);
  assert.deepEqual(invokes.map(([, arg]) => arg), [false, false]);
});

test("chat preload forwards chat:update snapshots and unsubscribes exactly", () => {
  const { exposed, dispatch } = loadPreload();
  const chatAPI = exposed.get("chatAPI");
  const receivedA = [];
  const receivedB = [];

  const unsubscribeA = chatAPI.onUpdate((state) => receivedA.push(state));
  const unsubscribeB = chatAPI.onUpdate((state) => receivedB.push(state));
  assert.equal(typeof unsubscribeA, "function");
  assert.equal(typeof unsubscribeB, "function");

  const snapshot = { status: "idle", busy: false, messages: [] };
  dispatch("chat:update", snapshot);
  assert.equal(receivedA.length, 1);
  assert.equal(receivedA[0], snapshot, "the state snapshot must pass through unchanged");
  assert.equal(receivedB.length, 1);
  assert.equal(receivedB[0], snapshot);

  unsubscribeA();
  dispatch("chat:update", { status: "thinking" });
  assert.equal(receivedA.length, 1, "unsubscribed listener must stop receiving updates");
  assert.equal(receivedB.length, 2);

  unsubscribeB();
  assert.doesNotThrow(() => dispatch("chat:update", { status: "idle" }));
  assert.equal(receivedB.length, 2);
});

test("chat preload tolerates a non-function onUpdate listener", () => {
  const { exposed, dispatch } = loadPreload();
  const chatAPI = exposed.get("chatAPI");
  const unsubscribe = chatAPI.onUpdate(null);
  assert.equal(typeof unsubscribe, "function");
  assert.doesNotThrow(() => unsubscribe());
  assert.doesNotThrow(() => dispatch("chat:update", { status: "idle" }));
});
