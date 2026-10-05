"use strict";

// chat-prompt-queue：悬停面板快捷输入的排队模块（纯逻辑，无 Electron）。
// 覆盖：立即发送 / 忙时排队 / 上限 / 无目录阻塞与放行 / 失败退避与丢弃 / 清空。

const test = require("node:test");
const assert = require("node:assert/strict");

const createChatPromptQueue = require("../src/chat-prompt-queue");

function makeHarness({ busy = false, cwd = "/tmp/proj", maxSize } = {}) {
  const state = { busy, cwd, sendResults: [] };
  const sent = [];
  const changes = [];
  const timers = [];
  const queue = createChatPromptQueue({
    maxSize,
    send: async (text) => {
      sent.push(text);
      const next = state.sendResults.length ? state.sendResults.shift() : true;
      return next;
    },
    isBusy: () => state.busy,
    hasCwd: () => !!state.cwd,
    onChanged: (snap) => changes.push(snap),
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => { if (handle) handle.cleared = true; },
  });
  return { state, sent, changes, timers, queue };
}

test("空闲且有目录时直接发送，不入队", async () => {
  const h = makeHarness();
  const result = await h.queue.enqueue("  你好  ");
  assert.equal(result.status, "sent");
  assert.equal(result.queuedCount, 0);
  assert.deepEqual(h.sent, ["你好"], "文本应 trim 后发送");
  assert.equal(h.queue.getSnapshot().count, 0);
});

test("空文本返回 empty，不发送", async () => {
  const h = makeHarness();
  assert.equal((await h.queue.enqueue("   ")).status, "empty");
  assert.equal((await h.queue.enqueue(null)).status, "empty");
  assert.deepEqual(h.sent, []);
});

test("忙碌时排队，状态边沿（忙→闲）后按顺序自动发出", async () => {
  const h = makeHarness({ busy: true });
  assert.equal((await h.queue.enqueue("第一条")).status, "queued");
  assert.equal((await h.queue.enqueue("第二条")).status, "queued");
  assert.equal(h.queue.getSnapshot().count, 2);
  assert.deepEqual(h.sent, []);

  h.state.busy = false;
  h.queue.handleRuntimeState();
  await h.queue._settle();
  assert.deepEqual(h.sent, ["第一条"], "每次边沿只发一条");
  assert.equal(h.queue.getSnapshot().count, 1);

  h.queue.handleRuntimeState();
  await h.queue._settle();
  assert.deepEqual(h.sent, ["第一条", "第二条"]);
  assert.equal(h.queue.getSnapshot().count, 0);
});

test("队列满返回 full 且不丢用户文字", async () => {
  const h = makeHarness({ busy: true, maxSize: 2 });
  await h.queue.enqueue("a");
  await h.queue.enqueue("b");
  const result = await h.queue.enqueue("c");
  assert.equal(result.status, "full");
  assert.equal(result.queuedCount, 2);
  assert.equal(h.queue.getSnapshot().count, 2);
});

test("无工作目录时保持排队并标记 no-cwd，目录出现后自动放行", async () => {
  const h = makeHarness({ busy: true, cwd: "" });
  assert.equal((await h.queue.enqueue("等目录")).status, "queued");
  assert.equal(h.queue.getSnapshot().blocked, "no-cwd");

  // 忙→闲但没目录：仍不发。
  h.state.busy = false;
  h.queue.handleRuntimeState();
  await h.queue._settle();
  assert.deepEqual(h.sent, []);

  // 目录出现（状态边沿）→ 放行。
  h.state.cwd = "/tmp/proj";
  assert.equal(h.queue.getSnapshot().blocked, null);
  h.queue.handleRuntimeState();
  await h.queue._settle();
  assert.deepEqual(h.sent, ["等目录"]);
});

test("发送抛错按失败处理，重试上限后丢弃并记 lastError", async () => {
  const h = makeHarness();
  h.state.sendResults = [false, false, false];
  const result = await h.queue.enqueue("会失败");
  assert.equal(result.status, "queued", "立即发送失败后退回队列");
  assert.equal(h.queue.getSnapshot().count, 1);

  // 第 2 次尝试（退避定时器触发）。
  assert.equal(h.timers.length, 1, "失败后应排一次退避定时器");
  h.timers[0].fn();
  await h.queue._settle();
  assert.equal(h.queue.getSnapshot().count, 1, "第 2 次失败仍在队列");
  assert.equal(h.queue.getSnapshot().lastError, "send-failed");

  // 第 3 次尝试失败 → 丢弃。
  const retry = h.timers.find((timer) => !timer.cleared);
  assert.ok(retry, "第 2 次失败后还有一次退避");
  retry.fn();
  await h.queue._settle();
  assert.equal(h.queue.getSnapshot().count, 0, "达到重试上限后丢弃");
  assert.equal(h.queue.getSnapshot().lastError, "send-failed");
  assert.equal(h.sent.length, 3);
});

test("clear 同步清空队列与退避定时器，返回清空条数", async () => {
  const h = makeHarness({ busy: true });
  await h.queue.enqueue("a");
  await h.queue.enqueue("b");
  const result = h.queue.clear("user-stop");
  assert.deepEqual(result, { cleared: 2, reason: "user-stop" });
  assert.equal(h.queue.getSnapshot().count, 0);
  assert.equal(h.queue.getSnapshot().lastError, null);
  // 清空后状态边沿不再误发。
  h.state.busy = false;
  h.queue.handleRuntimeState();
  await h.queue._settle();
  assert.deepEqual(h.sent, []);
});

test("失败退避期间 clear 会取消定时器，不再补发", async () => {
  const h = makeHarness();
  h.state.sendResults = [false];
  await h.queue.enqueue("只失败一次");
  assert.equal(h.timers.length, 1);
  h.queue.clear("closed");
  assert.equal(h.timers[0].cleared, true, "退避定时器应被取消");
  h.timers[0].fn(); // 即便被误触发也不发（队列已空）
  await h.queue._settle();
  assert.deepEqual(h.sent.length, 1);
  assert.equal(h.queue.getSnapshot().count, 0);
});

test("成功发送会清掉 lastError", async () => {
  const h = makeHarness();
  h.state.sendResults = [false];
  await h.queue.enqueue("先失败");
  h.state.sendResults = [true];
  h.timers[0].fn();
  await h.queue._settle();
  assert.equal(h.queue.getSnapshot().lastError, null);
  assert.equal(h.queue.getSnapshot().count, 0);
});

test("立即发送失败不烧第二次尝试：只排一个退避定时器，sent 长度保持 1", async () => {
  const h = makeHarness();
  h.state.sendResults = [false]; // 只让立即发送这一次失败，后续不再自动补发
  const result = await h.queue.enqueue("失败一次");
  assert.equal(result.status, "queued", "立即发送失败后退回队列");
  assert.deepEqual(h.sent, ["失败一次"], "只烧了立即发送这一次，不得立刻补第二次");
  assert.equal(h.timers.length, 1, "失败后只排一个退避定时器");
  assert.equal(h.timers[0].cleared, false);
  assert.equal(h.queue.getSnapshot().inFlight, false);

  // 定时器不到点就不该有第二次尝试（多结算几轮也不发）。
  await h.queue._settle();
  assert.deepEqual(h.sent, ["失败一次"], "退避定时器到点前不得再发");
  assert.equal(h.timers.length, 1, "期间不得再排第二个退避定时器");
  assert.equal(h.queue.getSnapshot().count, 1);
});

test("inFlight 期间的 handleRuntimeState 不会双发同一条（并发调用只发一次）", async () => {
  const state = { busy: true, cwd: "/tmp/proj" };
  const sent = [];
  let releaseSend = null;
  const gate = new Promise((resolve) => { releaseSend = resolve; });
  const queue = createChatPromptQueue({
    send: async (text) => {
      sent.push(text);
      await gate; // 卡在途，模拟 send 尚未返回
      return true;
    },
    isBusy: () => state.busy,
    hasCwd: () => !!state.cwd,
    setTimeout: () => ({}),
    clearTimeout: () => {},
  });

  assert.equal((await queue.enqueue("只发一次")).status, "queued");
  state.busy = false;

  // 第一次状态边沿：发起在途发送（send 卡住未返回）。
  queue.handleRuntimeState();
  assert.deepEqual(sent, ["只发一次"]);
  assert.equal(queue.getSnapshot().inFlight, true);

  // 在途期间再触发多次状态边沿：不得双发同一条。
  queue.handleRuntimeState();
  queue.handleRuntimeState();
  queue.handleRuntimeState();
  await queue._settle(); // send 仍未放行，确认没有偷偷补发
  assert.deepEqual(sent, ["只发一次"], "在途期间不得重复发送同一条");
  assert.equal(queue.getSnapshot().count, 1, "发送成功前不得出队");

  // 放行后正常结算，只发过一次。
  releaseSend();
  await queue._settle();
  assert.deepEqual(sent, ["只发一次"]);
  assert.equal(queue.getSnapshot().count, 0, "发送成功后出队");

  // 结算后队列已空，再来状态边沿也不发。
  queue.handleRuntimeState();
  await queue._settle();
  assert.deepEqual(sent, ["只发一次"]);
});

test("在途发送期间 clear 又入队的新消息，不会被在途结算误删", async () => {
  const h = makeHarness();
  // A 的 send 挂起（gate 不放行）。
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  h.state.sendResults = [];
  const queue = createChatPromptQueue({
    send: async (text) => {
      h.sent.push(text);
      if (text === "A") await gate;
      return true;
    },
    isBusy: () => false,
    hasCwd: () => true,
    onChanged: (snap) => h.changes.push(snap),
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; h.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
  });
  const pending = queue.enqueue("A");
  // A 在途时用户清队（点停止），随后又输入 B。
  queue.clear("user-stop");
  await queue.enqueue("B");
  assert.equal(queue.getSnapshot().count, 1);
  // A 的发送现在才结算成功——只许摘掉 A 自己，B 必须还在。
  release();
  await pending;
  await queue._settle();
  assert.equal(queue.getSnapshot().count, 1, "B 不能被 A 的结算误删");
});

test("立即发送失败退回队列时插到队头，保持输入顺序", async () => {
  const h = makeHarness();
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  let first = true;
  const queue = createChatPromptQueue({
    send: async (text) => {
      h.sent.push(text);
      if (first) { first = false; await gate; return false; } // A 立即发送失败
      return true;
    },
    isBusy: () => false,
    hasCwd: () => true,
    onChanged: () => {},
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false }; h.timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.cleared = true; },
  });
  const pendingA = queue.enqueue("A"); // 立即发送，挂起
  const pendingB = queue.enqueue("B"); // A 在途 → B 先排队
  release();
  await pendingA;
  await pendingB;
  // A 失败退回队列应排在 B 前面：退避重试先发 A。
  h.timers[0].fn();
  await queue._settle();
  assert.deepEqual(h.sent, ["A", "A"], "重试先发 A");
  // A 成功后 B 等下一次状态边沿（每次边沿只放一条）。
  queue.handleRuntimeState();
  await queue._settle();
  assert.deepEqual(h.sent, ["A", "A", "B"], "顺序必须是 A 先于 B");
});
