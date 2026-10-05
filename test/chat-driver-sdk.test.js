"use strict";

// chat-driver-sdk：事件规整与去重行为。
// 用假 SDK（sdkLoader 注入）按节奏喂预设消息，断言 driver 吐出的事件流。

const { describe, it } = require("node:test");
const assert = require("node:assert");
const driverModule = require("../src/chat-driver-sdk");

const createChatDriver = driverModule.createChatDriver || driverModule;

// 假 SDK：query() 返回一个可手动 push/end 的异步迭代器，节奏完全由测试控制。
function makeFakeSdk() {
  const calls = { interrupt: 0, setPermissionMode: [] };
  const queue = [];
  const waiters = [];
  let ended = false;
  const queryObj = {
    interrupt: async () => { calls.interrupt += 1; },
    setPermissionMode: async (mode) => { calls.setPermissionMode.push(mode); },
    close: () => {
      ended = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() { return this; },
    next: () => {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
  return {
    sdk: { query: () => queryObj },
    calls,
    push: (message) => {
      if (waiters.length) waiters.shift()({ value: message, done: false });
      else queue.push(message);
    },
    end: () => queryObj.close(),
  };
}

async function startDriver() {
  const events = [];
  const fake = makeFakeSdk();
  const driver = createChatDriver({
    cwd: "/tmp",
    sdkLoader: async () => fake.sdk,
    onEvent: (event) => events.push(event),
  });
  const started = await driver.start();
  return { driver, events, started, fake };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function streamDelta(text) {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
}

function assistantText(id, text) {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, role: "assistant", content: [{ type: "text", text }] },
  };
}

describe("chat-driver-sdk 事件去重", () => {
  it("有增量时，同一消息的全文不会重复显示", async () => {
    const { driver, events, fake } = await startDriver();
    fake.push({ type: "stream_event", event: { type: "message_start" } });
    fake.push(streamDelta("你好"));
    fake.push(assistantText("m1", "你好"));
    fake.push(assistantText("m1", "你好"));
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();
    const texts = events.filter((e) => e.kind === "text");
    assert.strictEqual(texts.length, 1);
    assert.strictEqual(texts[0].delta, "你好");
    await driver.dispose();
  });

  it("没有增量、同一条消息重复到达时只显示一次", async () => {
    const { driver, events, fake } = await startDriver();
    fake.push(assistantText("m2", "只有一段话"));
    fake.push(assistantText("m2", "只有一段话"));
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();
    const texts = events.filter((e) => e.kind === "text");
    assert.strictEqual(texts.length, 1);
    assert.strictEqual(texts[0].text, "只有一段话");
    await driver.dispose();
  });

  it("两条不同消息的文本都会显示", async () => {
    const { driver, events, fake } = await startDriver();
    fake.push(assistantText("m3", "第一段"));
    fake.push(assistantText("m4", "第二段"));
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();
    const texts = events.filter((e) => e.kind === "text");
    assert.deepStrictEqual(texts.map((e) => e.text), ["第一段", "第二段"]);
    await driver.dispose();
  });
});

describe("chat-driver-sdk 基础映射", () => {
  it("init 事件带出会话编号与模型", async () => {
    const { driver, events, fake } = await startDriver();
    fake.push({ type: "system", subtype: "init", session_id: "sess-1", model: "test-model" });
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();
    const init = events.find((e) => e.kind === "init");
    assert.ok(init, "应有 init 事件");
    assert.strictEqual(init.sessionId, "sess-1");
    assert.strictEqual(init.model, "test-model");
    await driver.dispose();
  });

  it("同一工具调用重复到达只报一次 tool-start", async () => {
    const toolUse = {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "m5",
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }],
      },
    };
    const { driver, events, fake } = await startDriver();
    fake.push(toolUse);
    fake.push(toolUse);
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();
    const starts = events.filter((e) => e.kind === "tool-start");
    assert.strictEqual(starts.length, 1);
    assert.strictEqual(starts[0].toolName, "Bash");
    assert.strictEqual(starts[0].summary, "ls");
    assert.strictEqual(starts[0].toolUseId, "t1");
    await driver.dispose();
  });

  it("setPermissionMode 在会话运行中透传给 SDK", async () => {
    const { driver, fake } = await startDriver();
    const ok = await driver.setPermissionMode("plan");
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(fake.calls.setPermissionMode, ["plan"]);
    await driver.dispose();
  });
});
