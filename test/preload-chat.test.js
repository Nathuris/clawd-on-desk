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
    "listHistory",
    "resumeSession",
    "pickAttachments",
    "savePastedImage",
    "openExternal",
    "listCommands",
    "registerDroppedPaths",
    "getPathForFile",
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
  const historyKey = "a".repeat(32);

  await chatAPI.getState();
  await chatAPI.send("你好");
  await chatAPI.stop();
  await chatAPI.newSession();
  await chatAPI.pickWorkingDir();
  await chatAPI.setEffort("high");
  await chatAPI.setPermissionMode("plan");
  await chatAPI.listHistory();
  await chatAPI.resumeSession(historyKey);
  await chatAPI.pickAttachments();
  await chatAPI.savePastedImage("data:image/png;base64,aGk=", "clip.png");
  await chatAPI.openExternal("https://example.com/docs");
  await chatAPI.listCommands();
  await chatAPI.registerDroppedPaths(["/tmp/a.txt", "/tmp/b.png"]);

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
      "chat:list-history",
      "chat:resume-session",
      "chat:pick-attachments",
      "chat:save-pasted-image",
      "chat:open-external",
      "chat:list-commands",
      "chat:register-dropped-paths",
    ],
  );
  assert.equal(payloadValue(invokes[1][1], "text"), "你好");
  assert.equal(payloadValue(invokes[5][1], "effort"), "high");
  assert.equal(payloadValue(invokes[6][1], "permissionMode"), "plan");
  assert.equal(payloadValue(invokes[8][1], "historyKey"), historyKey);
  assert.equal(payloadValue(invokes[10][1], "dataUrl"), "data:image/png;base64,aGk=");
  assert.equal(payloadValue(invokes[10][1], "name"), "clip.png");
  assert.equal(payloadValue(invokes[11][1], "url"), "https://example.com/docs");
  assert.deepEqual(payloadValue(invokes[13][1], "paths"), ["/tmp/a.txt", "/tmp/b.png"]);

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

test("chat preload forwards send attachments inside the payload and normalizes them to an array", async () => {
  const { exposed, invokes } = loadPreload();
  const chatAPI = exposed.get("chatAPI");
  const attachments = [{ path: "/tmp/note.txt", name: "note.txt", size: 3, isImage: false }];
  // vm 沙箱里造的对象与测试进程原型不同，比较前先 JSON 归一化。
  const plain = (value) => JSON.parse(JSON.stringify(value));

  await chatAPI.send("看附件", attachments);
  assert.equal(invokes[0][0], "chat:send");
  assert.deepEqual(plain(invokes[0][1]), { text: "看附件", attachments });

  // 不带附件 / 传非数组时归一成空数组，主进程只见到统一载荷。
  await chatAPI.send("没有附件");
  assert.deepEqual(plain(invokes[1][1]), { text: "没有附件", attachments: [] });
  await chatAPI.send("怪参数", "not-an-array");
  assert.deepEqual(plain(invokes[2][1]), { text: "怪参数", attachments: [] });
});

test("chat preload forwards pasted images and external links in the contract payload shapes", async () => {
  const { exposed, invokes } = loadPreload();
  const chatAPI = exposed.get("chatAPI");
  // vm 沙箱里造的对象与测试进程原型不同，比较前先 JSON 归一化（顺带丢掉 undefined）。
  const plain = (value) => JSON.parse(JSON.stringify(value));
  const dataUrl = "data:image/png;base64,aGk=";

  await chatAPI.savePastedImage(dataUrl, "clip.png");
  assert.equal(invokes[0][0], "chat:save-pasted-image");
  assert.deepEqual(plain(invokes[0][1]), { dataUrl, name: "clip.png" });

  // 没给名字 / 名字不是字符串：不把无效字段塞给主进程。
  await chatAPI.savePastedImage(dataUrl);
  assert.deepEqual(plain(invokes[1][1]), { dataUrl });
  await chatAPI.savePastedImage(dataUrl, 42);
  assert.deepEqual(plain(invokes[2][1]), { dataUrl });

  // 外链走主进程统一通道（渲染端不直接开新窗口）。
  await chatAPI.openExternal("https://example.com/a?b=1");
  assert.equal(invokes[3][0], "chat:open-external");
  assert.deepEqual(plain(invokes[3][1]), { url: "https://example.com/a?b=1" });
});

test("chat preload resolves dropped files to paths through electron webUtils", () => {
  const { exposed } = loadPreload();
  const chatAPI = exposed.get("chatAPI");

  assert.equal(chatAPI.getPathForFile({ __testPath: "/tmp/dropped.png" }), "/tmp/dropped.png");
  // 拿不到路径（非文件等）返回空串，不向渲染端抛错。
  assert.equal(chatAPI.getPathForFile(null), "");
  assert.equal(chatAPI.getPathForFile({}), "");
});
