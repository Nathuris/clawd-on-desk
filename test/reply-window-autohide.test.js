"use strict";

// src/reply-window-autohide.js：回复窗口「自动消失」的判定（纯函数）。

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  REPLY_DONE_HOLD_MS,
  decideReplyWindowVisibility,
} = require("../src/reply-window-autohide");

const GRACE = 500;

function decide(overrides = {}) {
  return decideReplyWindowVisibility({
    open: true,
    pointerInHotZone: false,
    focused: false,
    busy: false,
    wasBusy: false,
    now: 10_000,
    holdUntil: 0,
    hideGraceMs: GRACE,
    ...overrides,
  });
}

test("关着窗口时永远判定为不显示", () => {
  const result = decide({ open: false, pointerInHotZone: true, busy: true });
  assert.equal(result.show, false);
  assert.equal(result.nextHoldUntil, 0);
});

test("指针在热区内就保持显示，并把宽限期往后推", () => {
  const result = decide({ pointerInHotZone: true });
  assert.equal(result.show, true);
  assert.equal(result.nextHoldUntil, 10_000 + GRACE);
});

test("指针离开后仍保留一段宽限期，过了才收", () => {
  const justLeft = decide({ holdUntil: 10_000 + GRACE });
  assert.equal(justLeft.show, true, "宽限期内不急着收");
  const expired = decide({ holdUntil: 9_000 });
  assert.equal(expired.show, false, "宽限期过了才收");
  assert.equal(expired.nextHoldUntil, 0);
});

test("窗口拿着键盘焦点时不收（用户正在选中/复制）", () => {
  const result = decide({ focused: true });
  assert.equal(result.show, true);
  assert.equal(result.nextHoldUntil, 10_000 + GRACE);
});

test("Claude 正在回复时不收——回复中途溜走最要命", () => {
  const result = decide({ busy: true });
  assert.equal(result.show, true);
  assert.equal(result.nextHoldUntil, 10_000 + GRACE);
});

test("回复刚结束时额外停留几秒，让用户看完最后几行", () => {
  const justFinished = decide({ busy: false, wasBusy: true });
  assert.equal(justFinished.show, true);
  assert.equal(justFinished.busyEnded, true);
  assert.equal(justFinished.nextHoldUntil, 10_000 + REPLY_DONE_HOLD_MS);

  // 停留期间即使指针在外面也继续显示。
  const withinHold = decide({ holdUntil: justFinished.nextHoldUntil, now: 10_000 + 1000 });
  assert.equal(withinHold.show, true);
  assert.equal(withinHold.nextHoldUntil, justFinished.nextHoldUntil, "停留时间不因轮询被续命");

  // 停留结束、指针仍在外 → 收起。
  const afterHold = decide({ holdUntil: justFinished.nextHoldUntil, now: 10_000 + REPLY_DONE_HOLD_MS + 1 });
  assert.equal(afterHold.show, false);
});

test("busy 只是延续状态时不算「刚结束」", () => {
  const stillBusy = decide({ busy: true, wasBusy: true });
  assert.equal(stillBusy.busyEnded, false);
  const idleForAWhile = decide({ busy: false, wasBusy: false });
  assert.equal(idleForAWhile.busyEnded, false);
  assert.equal(idleForAWhile.show, false);
});

test("宽限期 / 停留时间可以用参数覆盖，负值按 0 处理", () => {
  const noGrace = decide({ pointerInHotZone: true, hideGraceMs: -100 });
  assert.equal(noGrace.nextHoldUntil, 10_000);
  const noDoneHold = decide({ busy: false, wasBusy: true, doneHoldMs: 0 });
  assert.equal(noDoneHold.nextHoldUntil, 10_000);
});
