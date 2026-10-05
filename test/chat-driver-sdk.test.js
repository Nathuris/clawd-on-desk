"use strict";

// chat-driver-sdk：事件规整与去重行为，以及附件 blocks / 斜杠指令拉取 / 工具 diff
// 预览 / 上下文用量的契约。用假 SDK（sdkLoader 注入）按节奏喂预设消息，断言
// driver 吐出的事件流。

const { describe, it } = require("node:test");
const assert = require("node:assert");
const driverModule = require("../src/chat-driver-sdk");

const createChatDriver = driverModule.createChatDriver || driverModule;

// 假 SDK：query() 返回一个可手动 push/end 的异步迭代器，节奏完全由测试控制。
// supportedCommands 可替换 / 移除，用来验证指令拉取的成功与静默失败路径。
function makeFakeSdk() {
  const calls = { interrupt: 0, setPermissionMode: [], supportedCommands: 0, getContextUsage: 0 };
  const queue = [];
  const waiters = [];
  let ended = false;
  let commandsImpl = async () => [];
  let contextUsageImpl = async () => null;
  const queryObj = {
    interrupt: async () => { calls.interrupt += 1; },
    setPermissionMode: async (mode) => { calls.setPermissionMode.push(mode); },
    supportedCommands: async () => {
      calls.supportedCommands += 1;
      return commandsImpl();
    },
    getContextUsage: async () => {
      calls.getContextUsage += 1;
      return contextUsageImpl();
    },
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
  const fake = {
    queryArgs: null,
    sdk: { query: (args) => { fake.queryArgs = args; return queryObj; } },
    calls,
    push: (message) => {
      if (waiters.length) waiters.shift()({ value: message, done: false });
      else queue.push(message);
    },
    end: () => queryObj.close(),
    setSupportedCommands: (impl) => { commandsImpl = impl; },
    removeSupportedCommands: () => { delete queryObj.supportedCommands; },
    setContextUsage: (impl) => { contextUsageImpl = impl; },
    removeContextUsage: () => { delete queryObj.getContextUsage; },
    // 取回 driver 经 prompt 异步队列发给 SDK 的下一条用户消息。
    async nextPrompt() {
      const iterator = fake.queryArgs.prompt[Symbol.asyncIterator]();
      const { value } = await iterator.next();
      return value;
    },
  };
  return fake;
}

// prompt 队列为空：给 next() 一个短观察窗口，没有立即拿到消息即视为空。
async function promptIsEmpty(fake) {
  const iterator = fake.queryArgs.prompt[Symbol.asyncIterator]();
  let timer = null;
  const verdict = await Promise.race([
    iterator.next().then(() => "message"),
    new Promise((resolve) => { timer = setTimeout(() => resolve("empty"), 10); }),
  ]);
  clearTimeout(timer);
  return verdict === "empty";
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

function assistantToolUse(id, toolUseId, toolName, input, messageId) {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      id: messageId || id,
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: toolName, input }],
    },
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

// 工具卡片 diff 预览：Edit / MultiEdit / Write 带上 oldText / newText，每侧截 2000；
// 其他工具不产生该字段（runtime 靠它决定是否渲染 diff 对照块）。
describe("chat-driver-sdk 工具 diff 预览", () => {
  it("Edit 带出 old_string / new_string 两侧文本", async () => {
    const { driver, events, fake } = await startDriver();
    fake.push(assistantToolUse("md-1", "td-1", "Edit", {
      file_path: "/tmp/a.txt",
      old_string: "旧的一行",
      new_string: "新的一行",
    }));
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();

    const start = events.find((e) => e.kind === "tool-start");
    assert.ok(start, "应有 tool-start 事件");
    assert.deepStrictEqual(start.diffPreview, { oldText: "旧的一行", newText: "新的一行" });
    await driver.dispose();
  });

  it("Write 的旧侧为空、新侧是写入内容", async () => {
    const { driver, events, fake } = await startDriver();
    fake.push(assistantToolUse("md-2", "td-2", "Write", {
      file_path: "/tmp/new.txt",
      content: "全新内容",
    }));
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();

    const start = events.find((e) => e.kind === "tool-start");
    assert.deepStrictEqual(start.diffPreview, { oldText: "", newText: "全新内容" });
    await driver.dispose();
  });

  it("MultiEdit 把多个 edits 合并成一份预览", async () => {
    const { driver, events, fake } = await startDriver();
    fake.push(assistantToolUse("md-3", "td-3", "MultiEdit", {
      file_path: "/tmp/b.txt",
      edits: [
        { old_string: "第一处旧", new_string: "第一处新" },
        { old_string: "第二处旧", new_string: "第二处新" },
      ],
    }));
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();

    const { diffPreview } = events.find((e) => e.kind === "tool-start");
    assert.ok(diffPreview, "MultiEdit 必须带 diffPreview");
    for (const text of ["第一处旧", "第二处旧"]) {
      assert.ok(diffPreview.oldText.includes(text), `旧侧必须包含 ${text}`);
    }
    for (const text of ["第一处新", "第二处新"]) {
      assert.ok(diffPreview.newText.includes(text), `新侧必须包含 ${text}`);
    }
    // 合并保持 edits 的先后顺序。
    assert.ok(diffPreview.oldText.indexOf("第一处旧") < diffPreview.oldText.indexOf("第二处旧"));
    await driver.dispose();
  });

  it("diff 每侧最多 2000 字符", async () => {
    const { driver, events, fake } = await startDriver();
    fake.push(assistantToolUse("md-4", "td-4", "Edit", {
      file_path: "/tmp/long.txt",
      old_string: "甲".repeat(2500),
      new_string: "乙".repeat(2500),
    }));
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();

    const { diffPreview } = events.find((e) => e.kind === "tool-start");
    assert.ok(diffPreview.oldText.startsWith("甲".repeat(2000)), "旧侧保留前 2000 字符");
    assert.ok(diffPreview.oldText.length <= 2001, "旧侧最多 2000 字符（至多再带一个省略号）");
    assert.ok(diffPreview.newText.startsWith("乙".repeat(2000)), "新侧保留前 2000 字符");
    assert.ok(diffPreview.newText.length <= 2001, "新侧最多 2000 字符（至多再带一个省略号）");
    await driver.dispose();
  });

  it("其他工具（如 Bash）不带 diffPreview 字段", async () => {
    const { driver, events, fake } = await startDriver();
    fake.push(assistantToolUse("md-5", "td-5", "Bash", { command: "ls -la" }));
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();

    const start = events.find((e) => e.kind === "tool-start");
    assert.strictEqual(start.toolName, "Bash");
    assert.strictEqual(start.diffPreview, undefined, "没有 diff 可看的工具不得带该字段");
    await driver.dispose();
  });
});

// result 事件附带上下文用量：来自 query.getContextUsage()，取不到时为 null
//（字段始终存在，渲染端据此决定是否展示用量条）。
describe("chat-driver-sdk 上下文用量", () => {
  it("result 事件带出 getContextUsage 返回的用量（归一成 percent/usedTokens/maxTokens）", async () => {
    const { driver, events, fake } = await startDriver();
    // SDK 原始响应字段：totalTokens / maxTokens / percentage（见 SDK 类型定义）。
    fake.setContextUsage(async () => ({
      totalTokens: 42000,
      maxTokens: 100000,
      percentage: 42,
      categories: [{ name: "Messages", tokens: 42000, kind: "used" }],
    }));
    fake.push({ type: "result", subtype: "success", total_cost_usd: 0.5 });
    fake.end();
    await tick();

    assert.strictEqual(fake.calls.getContextUsage, 1, "result 到达时应查询一次上下文用量");
    const result = events.find((e) => e.kind === "result");
    assert.deepStrictEqual(result.contextUsage, { percent: 42, usedTokens: 42000, maxTokens: 100000 });
    await driver.dispose();
  });

  it("getContextUsage 抛错、返回空值或缺失时 contextUsage 为 null", async () => {
    const throwing = await startDriver();
    throwing.fake.setContextUsage(async () => { throw new Error("query not ready"); });
    throwing.fake.push({ type: "result", subtype: "success" });
    await tick();
    const failedResult = throwing.events.find((e) => e.kind === "result");
    assert.ok(failedResult, "查询失败不得吞掉 result 事件");
    assert.strictEqual(failedResult.contextUsage, null);
    assert.strictEqual(throwing.events.some((e) => e.kind === "error"), false, "查询失败静默处理");
    await throwing.driver.dispose();

    const empty = await startDriver();
    empty.fake.setContextUsage(async () => null);
    empty.fake.push({ type: "result", subtype: "success" });
    await tick();
    assert.strictEqual(empty.events.find((e) => e.kind === "result").contextUsage, null);
    await empty.driver.dispose();

    const missing = await startDriver();
    missing.fake.removeContextUsage();
    missing.fake.push({ type: "result", subtype: "success" });
    await tick();
    assert.strictEqual(missing.events.find((e) => e.kind === "result").contextUsage, null);
    await missing.driver.dispose();
  });
});

const IMAGE_BLOCK = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "aGk=" },
};

describe("chat-driver-sdk 附件 blocks", () => {
  it("文本块在前、附件块在后拼成同一条用户消息", async () => {
    const { driver, fake } = await startDriver();
    assert.strictEqual(driver.send("看这张图", [IMAGE_BLOCK]), true);
    const message = await fake.nextPrompt();

    assert.strictEqual(message.type, "user");
    assert.strictEqual(message.message.role, "user");
    assert.deepStrictEqual(message.message.content, [{ type: "text", text: "看这张图" }, IMAGE_BLOCK]);
    await driver.dispose();
  });

  it("只有附件、没有文字时不插入空 text 块", async () => {
    const { driver, fake } = await startDriver();
    assert.strictEqual(driver.send("", [IMAGE_BLOCK]), true);
    const message = await fake.nextPrompt();
    assert.deepStrictEqual(message.message.content, [IMAGE_BLOCK]);
    await driver.dispose();
  });

  it("文字与附件都为空时拒绝发送", async () => {
    const { driver, fake } = await startDriver();
    assert.strictEqual(driver.send("", []), false);
    assert.strictEqual(driver.send("", undefined), false);
    assert.strictEqual(driver.send(null, null), false);
    assert.strictEqual(driver.send(undefined, IMAGE_BLOCK), false, "blocks 必须是数组");
    assert.strictEqual(await promptIsEmpty(fake), true, "空发送不得进入 SDK 的 prompt 队列");
    await driver.dispose();
  });

  it("未启动的会话不接受附件发送", async () => {
    const events = [];
    const fake = makeFakeSdk();
    const driver = createChatDriver({
      cwd: "/tmp",
      sdkLoader: async () => fake.sdk,
      onEvent: (event) => events.push(event),
    });
    assert.strictEqual(driver.send("还没启动", [IMAGE_BLOCK]), false, "start 之前不能发送");
    await driver.start();
    assert.strictEqual(driver.send("启动后", [IMAGE_BLOCK]), true);
    await driver.dispose();
  });
});

describe("chat-driver-sdk 斜杠指令拉取", () => {
  it("init 之后拉取 supportedCommands 并发出 commands 事件", async () => {
    const { driver, events, fake } = await startDriver();
    fake.setSupportedCommands(async () => [
      { name: "/compact", description: "压缩对话历史" },
      { name: "/clear", description: "" },
    ]);
    fake.push({ type: "system", subtype: "init", session_id: "sess-1", model: "test-model" });
    // supportedCommands 是 init 之后的异步拉取，等一拍再核对事件流。
    await tick();
    fake.push({ type: "result", subtype: "success" });
    fake.end();
    await tick();

    assert.strictEqual(fake.calls.supportedCommands, 1);
    const commandEvents = events.filter((e) => e.kind === "commands");
    assert.strictEqual(commandEvents.length, 1);
    assert.deepStrictEqual(commandEvents[0].commands, [
      { name: "/compact", description: "压缩对话历史" },
      { name: "/clear", description: "" },
    ]);
    await driver.dispose();
  });

  it("指令名统一补斜杠、丢弃无效项并截断到 100 条", async () => {
    const { driver, events, fake } = await startDriver();
    const raw = [];
    for (let index = 0; index < 99; index += 1) {
      raw.push({ name: `/cmd-${index}`, description: `第${index}条` });
    }
    raw.push({ name: "/no-desc" }); // 缺描述：补空串
    for (let index = 0; index < 25; index += 1) {
      raw.push({ name: `/extra-${index}`, description: "超出上限" });
    }
    // 实测 SDK 返回的 name 不带前导斜杠（如 "deep-research"）：必须补斜杠而不是丢弃；
    // 非字符串 / 空项才丢弃。曾因按「必须带斜杠」过滤导致 48 条指令全被丢光。
    raw.splice(3, 0, { name: "not-slash", description: "x" }, { name: 42, description: "y" }, null);
    fake.setSupportedCommands(async () => raw);
    fake.push({ type: "system", subtype: "init", session_id: "sess-1" });
    await tick();
    fake.end();
    await tick();

    const list = events.find((e) => e.kind === "commands").commands;
    assert.strictEqual(list.length, 100, "指令列表必须截断到 100 条");
    for (const command of list) {
      assert.match(command.name, /^\//, "所有指令名都必须以斜杠开头");
    }
    assert.deepStrictEqual(list[3], { name: "/not-slash", description: "x" }, "不带斜杠的名字要补斜杠保留");
    assert.strictEqual(list.some((command) => command.name === "/extra-0"), false, "超出 100 条的部分被截掉");
    assert.deepStrictEqual(list[0], { name: "/cmd-0", description: "第0条" });
    await driver.dispose();
  });

  it("supportedCommands 抛错或缺失时静默，不报 error 事件", async () => {
    const failing = await startDriver();
    failing.fake.setSupportedCommands(async () => { throw new Error("query not ready"); });
    failing.fake.push({ type: "system", subtype: "init", session_id: "sess-1" });
    await tick();
    assert.strictEqual(failing.fake.calls.supportedCommands, 1);
    assert.strictEqual(failing.events.some((e) => e.kind === "commands"), false);
    assert.strictEqual(failing.events.some((e) => e.kind === "error"), false);
    await failing.driver.dispose();

    const missing = await startDriver();
    missing.fake.removeSupportedCommands();
    missing.fake.push({ type: "system", subtype: "init", session_id: "sess-2" });
    await tick();
    assert.strictEqual(missing.events.some((e) => e.kind === "commands"), false);
    assert.strictEqual(missing.events.some((e) => e.kind === "error"), false);
    await missing.driver.dispose();
  });
});
