"use strict";

// src/session-prompt-send.js：面板一句话 → 终端会话的通道选择与如实回报。

const test = require("node:test");
const assert = require("node:assert/strict");

const { textKeyFor, createSessionPromptSend } = require("../src/session-prompt-send");

const SESSION = { id: "local|claude|1", sourcePid: 4242, pidChain: [4242, 15267], agentId: "claude-code" };

function makeHarness(options = {}) {
  const calls = { delivered: [], copied: [], focused: [] };
  const terminalResults = Array.isArray(options.terminalResults) ? options.terminalResults.slice() : [];
  const terminalAppSender = options.noTerminalApp ? null : {
    deliver: async (payload) => {
      calls.delivered.push(payload);
      const next = terminalResults.length ? terminalResults.shift() : { status: "sent" };
      if (next.throw) throw new Error("boom");
      return next;
    },
  };
  const sender = createSessionPromptSend({
    getTargetSession: options.getTargetSession || (() => SESSION),
    terminalAppSender,
    codexQueueAdapter: options.codexQueueAdapter || null,
    copyText: options.copyText || ((text) => { calls.copied.push(text); return true; }),
    focusSession: options.focusSession === null ? null : (id) => calls.focused.push(id),
    log: () => {},
  });
  return { sender, calls };
}

test("真送进终端时报 sent", async () => {
  const { sender, calls } = makeHarness({ terminalResults: [{ status: "sent" }] });
  const result = await sender.send({ text: "你好" });
  assert.equal(result.status, "sent");
  assert.equal(result.channel, "terminal-app");
  assert.equal(result.textKey, "hudSendSent");
  assert.deepEqual(calls.copied, [], "真的送进去了就不该再碰剪贴板");
  assert.equal(calls.delivered[0].sourcePid, SESSION.sourcePid);
  assert.equal(calls.delivered[0].pidChain, SESSION.pidChain);
});

test("没有可发送的会话时返回 no-session", async () => {
  const { sender, calls } = makeHarness({ getTargetSession: () => null });
  const result = await sender.send({ text: "你好" });
  assert.equal(result.status, "no-session");
  assert.equal(result.textKey, "hudSendNoSession");
  assert.deepEqual(calls.delivered, []);
});

test("空文本不发，也不会污染剪贴板", async () => {
  const { sender, calls } = makeHarness();
  const result = await sender.send({ text: "   " });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "empty");
  assert.deepEqual(calls.copied, []);
});

test("终端通道用不上时退到剪贴板，并如实说「去粘贴」", async () => {
  const { sender, calls } = makeHarness({ terminalResults: [{ status: "not-busy" }] });
  const result = await sender.send({ text: "帮我看看" });
  assert.equal(result.status, "copied", "绝不能把「只复制了」说成「已发送」");
  assert.equal(result.channel, "clipboard");
  assert.equal(result.reason, "not-busy");
  assert.equal(result.textKey, "hudSendCopied");
  assert.deepEqual(calls.copied, ["帮我看看"]);
  assert.deepEqual(calls.focused, [SESSION.id], "复制之后顺手把终端切到前面");
});

test("用户还没允许控制终端时，提示去点允许", async () => {
  const { sender } = makeHarness({ terminalResults: [{ status: "unauthorized" }] });
  const result = await sender.send({ text: "你好" });
  assert.equal(result.status, "copied");
  assert.equal(result.textKey, "hudSendNeedsPermission");
});

test("没有终端通道时（比如 Windows）直接走剪贴板", async () => {
  const { sender } = makeHarness({ noTerminalApp: true });
  const result = await sender.send({ text: "你好" });
  assert.equal(result.status, "copied");
  assert.equal(result.reason, null);
  assert.equal(result.textKey, "hudSendCopied");
});

test("剪贴板也写不进去时才是 error", async () => {
  const { sender } = makeHarness({ noTerminalApp: true, copyText: () => false });
  const result = await sender.send({ text: "你好" });
  assert.equal(result.status, "error");
  assert.equal(result.textKey, "hudQuickSendFailed");
});

test("Codex 会话在终端通道用不上时走官方队列", async () => {
  const queued = [];
  const { sender } = makeHarness({
    getTargetSession: () => ({ ...SESSION, agentId: "codex" }),
    terminalResults: [{ status: "unsupported" }],
    codexQueueAdapter: {
      canDeliver: (session) => session.agentId === "codex",
      deliver: async (payload) => { queued.push(payload); return { status: "queued" }; },
    },
  });
  const result = await sender.send({ text: "继续" });
  assert.equal(result.status, "sent");
  assert.equal(result.channel, "codex-queue");
  assert.equal(queued.length, 1);
});

test("Codex 队列不可用时仍然退到剪贴板", async () => {
  const { sender, calls } = makeHarness({
    getTargetSession: () => ({ ...SESSION, agentId: "codex" }),
    terminalResults: [{ status: "unsupported" }],
    codexQueueAdapter: {
      canDeliver: () => true,
      deliver: async () => ({ status: "failed" }),
    },
  });
  const result = await sender.send({ text: "继续" });
  assert.equal(result.status, "copied");
  assert.deepEqual(calls.copied, ["继续"]);
});

test("终端通道抛异常不会把整条发送打断", async () => {
  const { sender, calls } = makeHarness({ terminalResults: [{ throw: true }] });
  const result = await sender.send({ text: "你好" });
  assert.equal(result.status, "copied");
  assert.equal(result.reason, "error");
  assert.deepEqual(calls.copied, ["你好"]);
});

test("两次发送串行执行，不交错抢剪贴板", async () => {
  const order = [];
  const sender = createSessionPromptSend({
    getTargetSession: () => SESSION,
    terminalAppSender: {
      deliver: async ({ text }) => {
        order.push(`start:${text}`);
        await new Promise((resolve) => setTimeout(resolve, text === "第一条" ? 30 : 1));
        order.push(`end:${text}`);
        return { status: "sent" };
      },
    },
    log: () => {},
  });
  await Promise.all([sender.send({ text: "第一条" }), sender.send({ text: "第二条" })]);
  assert.deepEqual(order, ["start:第一条", "end:第一条", "start:第二条", "end:第二条"]);
});

test("textKeyFor 覆盖四种状态的文案 key", () => {
  assert.equal(textKeyFor("sent"), "hudSendSent");
  assert.equal(textKeyFor("no-session"), "hudSendNoSession");
  assert.equal(textKeyFor("error"), "hudQuickSendFailed");
  assert.equal(textKeyFor("copied", null), "hudSendCopied");
  assert.equal(textKeyFor("copied", "unauthorized"), "hudSendNeedsPermission");
});
