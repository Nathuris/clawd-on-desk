"use strict";

// src/session-control-send.js：把控制命令（目前只有 /effort）送进正在跑的会话。
// 这里锁的是它跟"发聊天内容"那条链最大的区别：**只认 sent，绝不降级**。

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  createSessionControlSend,
  effortCommandText,
  assessTarget,
} = require("../src/session-control-send");

function claudeSession(extra = {}) {
  return {
    id: "s1",
    agentId: "claude-code",
    host: null,
    headless: false,
    sourcePid: 1234,
    pidChain: [1234, 1235],
    ...extra,
  };
}

function makeSender(result = { status: "sent" }) {
  const calls = [];
  return {
    calls,
    deliver: async (payload) => {
      calls.push(payload);
      return result;
    },
  };
}

describe("session-control-send", () => {
  it("送的是官方 /effort 命令，并且带着那个会话自己的 pid 链", async () => {
    const sender = makeSender();
    const control = createSessionControlSend({ terminalAppSender: sender });
    const result = await control.setEffort({ level: "xhigh", session: claudeSession() });

    assert.deepStrictEqual(result, { status: "sent", reason: "sent", textKey: "hudControlEffortSent" });
    assert.strictEqual(sender.calls.length, 1);
    assert.strictEqual(sender.calls[0].text, "/effort xhigh");
    assert.strictEqual(sender.calls[0].sourcePid, 1234);
    assert.deepStrictEqual(sender.calls[0].pidChain, [1234, 1235]);
    assert.strictEqual(effortCommandText("low"), "/effort low");
  });

  it("没真送进去就是 failed——不假装成功", async () => {
    for (const status of ["not-busy", "not-found", "unauthorized", "error", "timeout", "unsupported"]) {
      const sender = makeSender({ status });
      const control = createSessionControlSend({ terminalAppSender: sender });
      const result = await control.setEffort({ level: "high", session: claudeSession() });
      assert.strictEqual(result.status, "failed", status);
      assert.strictEqual(result.reason, status);
      assert.strictEqual(result.textKey, "hudControlEffortFailed");
    }
  });

  it("不碰剪贴板、不抢焦点（那是聊天内容的兜底，对控制命令是错的）", async () => {
    // 故意给两个"看起来能用"的回调：模块不该有办法拿到它们。
    const copyText = () => { throw new Error("控制命令不该写剪贴板"); };
    const focusSession = () => { throw new Error("控制命令不该抢焦点"); };
    const sender = makeSender({ status: "not-busy" });
    const control = createSessionControlSend({ terminalAppSender: sender, copyText, focusSession });
    const result = await control.setEffort({ level: "high", session: claudeSession() });
    assert.strictEqual(result.status, "failed");
    assert.deepStrictEqual(Object.keys(control), ["setEffort"], "只暴露一个入口，没有剪贴板通道");
  });

  it("够不着的目标一律拒绝，且不去打扰终端", async () => {
    const cases = [
      [null, "skipped", "no-session"],
      [claudeSession({ agentId: "codex" }), "unsupported", "not-claude"],
      [claudeSession({ host: "remote-box" }), "unsupported", "remote"],
      [claudeSession({ headless: true }), "unsupported", "headless"],
      [claudeSession({ sourcePid: null, pidChain: [] }), "unsupported", "not-terminal"],
    ];
    for (const [session, status, reason] of cases) {
      const sender = makeSender();
      const control = createSessionControlSend({ terminalAppSender: sender });
      const result = await control.setEffort({ level: "high", session });
      assert.strictEqual(result.status, status, reason);
      assert.strictEqual(result.reason, reason);
      assert.deepStrictEqual(sender.calls, [], `${reason} 不该发任何东西`);
    }
  });

  it("不在允许表里的强度直接拒绝，一个字节都不发", async () => {
    const sender = makeSender();
    const control = createSessionControlSend({ terminalAppSender: sender });
    for (const level of ["", "turbo", "HIGH", "high; rm -rf /", null, 3, {}]) {
      const result = await control.setEffort({ level, session: claudeSession() });
      assert.strictEqual(result.status, "failed");
      assert.strictEqual(result.reason, "invalid-level");
    }
    assert.deepStrictEqual(sender.calls, []);
  });

  it("两个档位的判定表：本地 Claude Code 才够得着", () => {
    assert.deepStrictEqual(assessTarget(claudeSession()), { ok: true, status: null, reason: null });
    assert.strictEqual(assessTarget({ id: "s", agentId: "claude-code", pidChain: [1] }).ok, true);
    assert.strictEqual(assessTarget(null).reason, "no-session");
  });

  it("连着拖滑块时按顺序发，不互相踩", async () => {
    const order = [];
    const sender = {
      deliver: async (payload) => {
        order.push(payload.text);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { status: "sent" };
      },
    };
    const control = createSessionControlSend({ terminalAppSender: sender });
    await Promise.all([
      control.setEffort({ level: "low", session: claudeSession() }),
      control.setEffort({ level: "max", session: claudeSession() }),
    ]);
    assert.deepStrictEqual(order, ["/effort low", "/effort max"]);
  });
});
