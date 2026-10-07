"use strict";

// src/session-pins.js：会话置顶的 key 与存储形状。
// key 的规则是这里最要紧的一件事——"活着的会话"和"它的历史行"必须算出同一个
// key，否则会话一结束，置顶就失配了。

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  MAX_SESSION_PINS,
  MAX_PIN_KEY_LENGTH,
  sessionPinKey,
  normalizeSessionPins,
  pruneSessionPins,
} = require("../src/session-pins");

describe("session-pins", () => {
  it("key 只跟 agent 与 session id 有关", () => {
    assert.strictEqual(sessionPinKey("claude-code", "abc"), "local|claude-code|abc");
    // 缺 agent 时和别名那边一样归成 unknown，而不是拼出个空段
    assert.strictEqual(sessionPinKey(null, "abc"), "local|unknown|abc");
    assert.strictEqual(sessionPinKey("", "abc"), "local|unknown|abc");
    // 前后空白去掉（会话 id 不可能是这个形状，但别让两条记录键不同）
    assert.strictEqual(sessionPinKey("claude-code", "  abc  "), "local|claude-code|abc");
  });

  it("没有 session id 就没有 key（宁可不记，也不记一条指向空气的置顶）", () => {
    assert.strictEqual(sessionPinKey("claude-code", ""), null);
    assert.strictEqual(sessionPinKey("claude-code", null), null);
    assert.strictEqual(sessionPinKey("claude-code", undefined), null);
    assert.strictEqual(sessionPinKey("claude-code", "   "), null);
  });

  it("profile / cwd / host 都不参与 key——这正是「活着的会话」与它的历史行对得上的原因", () => {
    // 历史行那边只能拿到 agentId + sessionId，拿不到 profile/host/cwd。
    // 只要两边算出来的 key 一样，"运行中置顶 -> 结束后还在最上面"就成立。
    const fromLive = sessionPinKey("claude-code", "s1");
    const fromHistory = sessionPinKey("claude-code", "s1");
    assert.strictEqual(fromLive, fromHistory);
    assert.strictEqual(fromLive, "local|claude-code|s1");
  });

  it("归一化：留下有效的，丢掉脏的（坏条目不影响好条目）", () => {
    const out = normalizeSessionPins({
      "local|claude-code|a": { pinnedAt: 10 },
      "local|claude-code|b": { pinnedAt: 20 },
      "local|claude-code|no-time": {},
      "local|claude-code|zero": { pinnedAt: 0 },
      "local|claude-code|negative": { pinnedAt: -5 },
      "local|claude-code|text": { pinnedAt: "later" },
      "local|claude-code|array": [1, 2],
      "local|claude-code|null": null,
      "   ": { pinnedAt: 10 },
    });
    assert.deepStrictEqual(out, {
      "local|claude-code|b": { pinnedAt: 20 },
      "local|claude-code|a": { pinnedAt: 10 },
    });
  });

  it("不是对象就整个当空", () => {
    for (const value of [null, undefined, "x", 42, [1, 2]]) {
      assert.deepStrictEqual(normalizeSessionPins(value), {});
    }
  });

  it("超过上限时留最近钉的，且顺序确定（同样输入永远同样输出）", () => {
    const many = {};
    for (let i = 0; i < MAX_SESSION_PINS + 20; i += 1) {
      many[`local|claude-code|s${String(i).padStart(4, "0")}`] = { pinnedAt: i + 1 };
    }
    const out = normalizeSessionPins(many);
    assert.strictEqual(Object.keys(out).length, MAX_SESSION_PINS);
    assert.ok(out[`local|claude-code|s${String(MAX_SESSION_PINS + 19).padStart(4, "0")}`], "最新钉的在");
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(out, "local|claude-code|s0000"),
      false,
      "最老的那条被挤掉"
    );
    assert.deepStrictEqual(normalizeSessionPins(many), out, "两次归一化结果必须一样");
  });

  it("同一时刻钉的多条按 key 定序，不靠对象键的顺序碰运气", () => {
    const out = normalizeSessionPins({
      "local|claude-code|bbb": { pinnedAt: 50 },
      "local|claude-code|aaa": { pinnedAt: 50 },
    });
    assert.deepStrictEqual(Object.keys(out), ["local|claude-code|aaa", "local|claude-code|bbb"]);
  });

  it("超长的 key 丢掉", () => {
    const long = "local|claude-code|" + "x".repeat(MAX_PIN_KEY_LENGTH);
    assert.deepStrictEqual(normalizeSessionPins({ [long]: { pinnedAt: 1 } }), {});
  });

  it("不过期：置顶不会因为时间流逝被清掉", () => {
    // 历史会话可能几周后才再出现，按时间清掉会让用户回来发现钉的东西没了
    const pins = { "local|claude-code|old": { pinnedAt: 1 } };
    assert.deepStrictEqual(pruneSessionPins(pins), pins);
  });
});

// 主进程这段没法在单测里跑起来（main.js 要 Electron），但它踩过一个真坑：
// applyCommand 一律异步，不等它就回执的话，置顶明明写进去了面板还是收到"失败"，
// 而且推状态时读到的是旧的那份表（列表纹丝不动）。用源码断言把顺序钉住。
describe("主进程的置顶处理（源码契约）", () => {
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

  it("先等落盘、再推状态、最后才回执", () => {
    const start = mainSrc.indexOf("async function quickSetSessionPin");
    assert.ok(start > -1, "找不到 quickSetSessionPin");
    const body = mainSrc.slice(start, mainSrc.indexOf("\n}\n", start));
    assert.match(body, /await _settingsController\.applyCommand\(/, "必须等 applyCommand 落盘");
    const awaited = body.indexOf("await _settingsController.applyCommand");
    const pushed = body.indexOf("pushQuickState()");
    assert.ok(pushed > awaited, "推状态必须在落盘之后，否则读到的还是旧的置顶表");
    assert.match(body, /result\.status === "ok"/);
  });

  it("身份一律主进程回查，不从渲染端接 key", () => {
    const start = mainSrc.indexOf("async function quickSetSessionPin");
    const body = mainSrc.slice(start, mainSrc.indexOf("\n}\n", start));
    assert.match(body, /_state\.sessions\.get\(target\.sessionId\)/);
    assert.match(body, /resolveIdentity\(target\.agentId, target\.historyKey\)/);
    // 渲染端给的 target 对象不许直接当身份用：没有把 target 整个传给存储层
    assert.doesNotMatch(body, /applyCommand\(\s*"setSessionPin",\s*target\s*\)/);
  });
});
