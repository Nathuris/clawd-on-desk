"use strict";

// src/quick-history-cache.js：面板的历史会话缓存。
// 它存在的唯一理由是"读盘不能挂在状态投影上"——这些用例锁的就是这句话：
// TTL 之内不重复读、同一时间窗的并发只读一次、菜单打开时才真的读。

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createQuickHistoryCache, DEFAULT_TTL_MS } = require("../src/quick-history-cache");

function makeClock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

function makeLoader(result = { rows: [{ historyKey: "k1" }], truncated: 0 }) {
  const calls = [];
  return {
    calls,
    load: async () => {
      calls.push(calls.length);
      return result;
    },
  };
}

describe("quick-history-cache", () => {
  it("TTL 之内只读一次盘，过期后再读", async () => {
    const clock = makeClock();
    const loader = makeLoader();
    const cache = createQuickHistoryCache({ load: loader.load, ttlMs: 5000, now: clock.now });

    await cache.get({});
    await cache.get({});
    assert.strictEqual(loader.calls.length, 1);

    clock.advance(DEFAULT_TTL_MS - 1);
    await cache.get({});
    assert.strictEqual(loader.calls.length, 1, "还没到点就不该再读");

    clock.advance(1);
    await cache.get({});
    assert.strictEqual(loader.calls.length, 2);
  });

  it("同一个时间窗里并发来几次，也只读一次盘", async () => {
    const loader = makeLoader();
    const cache = createQuickHistoryCache({ load: loader.load, ttlMs: 5000, now: makeClock().now });
    await Promise.all([cache.get({}), cache.get({}), cache.get({})]);
    assert.strictEqual(loader.calls.length, 1);
  });

  it("peek 同步给上一次的结果，不触发读盘", () => {
    const loader = makeLoader();
    const cache = createQuickHistoryCache({ load: loader.load, ttlMs: 5000, now: makeClock().now });
    assert.strictEqual(cache.peek(), null, "还没读过就是空");
    return cache.get({}).then(() => {
      assert.deepStrictEqual(cache.peek().rows, [{ historyKey: "k1" }]);
      assert.strictEqual(loader.calls.length, 1);
    });
  });

  it("invalidate 之后 peek 还能拿到旧数据，但下次 get 会重读", async () => {
    const clock = makeClock();
    const loader = makeLoader();
    const cache = createQuickHistoryCache({ load: loader.load, ttlMs: 5000, now: clock.now });
    await cache.get({});
    cache.invalidate();
    // 关键：清空的话列表会闪一下空白。旧数据留着，只有"是否新鲜"作废。
    assert.deepStrictEqual(cache.peek().rows, [{ historyKey: "k1" }]);
    await cache.get({});
    assert.strictEqual(loader.calls.length, 2);
  });

  it("force 绕过 TTL", async () => {
    const loader = makeLoader();
    const cache = createQuickHistoryCache({ load: loader.load, ttlMs: 5000, now: makeClock().now });
    await cache.get({});
    await cache.get({ force: true });
    assert.strictEqual(loader.calls.length, 2);
  });

  it("读盘炸了也不把面板搞崩，而且不缓存失败", async () => {
    let fail = true;
    const calls = [];
    const cache = createQuickHistoryCache({
      load: async () => {
        calls.push(1);
        if (fail) throw new Error("disk on fire");
        return { rows: [{ historyKey: "k9" }], truncated: 3 };
      },
      ttlMs: 5000,
      now: makeClock().now,
    });
    const first = await cache.get({});
    assert.deepStrictEqual(first.rows, []);
    assert.strictEqual(first.truncated, 0);
    fail = false;
    const second = await cache.get({});
    assert.strictEqual(calls.length, 2, "失败不该被缓存住");
    assert.deepStrictEqual(second.rows, [{ historyKey: "k9" }]);
    assert.strictEqual(second.truncated, 3);
  });

  it("读盘回来的是垃圾也不崩：行数截断都归一成数", async () => {
    const cache = createQuickHistoryCache({
      load: async () => ({ rows: "nope", truncated: -4 }),
      ttlMs: 5000,
      now: makeClock().now,
    });
    const result = await cache.get({});
    assert.deepStrictEqual(result.rows, []);
    assert.strictEqual(result.truncated, 0);
  });
});
