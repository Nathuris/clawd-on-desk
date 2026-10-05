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
  const context = {
    console,
    process: { argv: [] },
    require(name) {
      if (name === "electron") return { contextBridge, ipcRenderer };
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

test("chat preload exposes the full window.chatAPI surface", () => {
  const { exposed } = loadPreload();
  const chatAPI = exposed.get("chatAPI");
  assert.ok(chatAPI, "preload must expose window.chatAPI");
  for (const method of [
    "getState",
    "send",
    "stop",
    "newSession",
    "pickWorkingDir",
    "setEffort",
    "setPermissionMode",
    "onUpdate",
  ]) {
    assert.equal(typeof chatAPI[method], "function", `chatAPI.${method} must be a function`);
  }
  // 权限确认走桌宠气泡：窗口 API 不再暴露决策入口。
  assert.equal("respondPermission" in chatAPI, false, "respondPermission must not be exposed");
});

test("chat preload forwards each operation to its dedicated invoke channel", async () => {
  const { exposed, invokes } = loadPreload();
  const chatAPI = exposed.get("chatAPI");

  await chatAPI.getState();
  await chatAPI.send("你好");
  await chatAPI.stop();
  await chatAPI.newSession();
  await chatAPI.pickWorkingDir();
  await chatAPI.setEffort("high");
  await chatAPI.setPermissionMode("plan");

  assert.deepEqual(
    invokes.map(([channel]) => channel),
    [
      "chat:get-state",
      "chat:send",
      "chat:stop",
      "chat:new-session",
      "chat:pick-working-dir",
      "chat:set-effort",
      "chat:set-permission-mode",
    ],
  );
  assert.equal(payloadValue(invokes[1][1], "text"), "你好");
  assert.equal(payloadValue(invokes[5][1], "effort"), "high");
  assert.equal(payloadValue(invokes[6][1], "permissionMode"), "plan");

  // invoke 的结果原样返回给渲染端。
  assert.deepEqual(await chatAPI.getState(), { status: "ok" });
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
