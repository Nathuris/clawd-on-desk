"use strict";

// src/chat-window-placement.js 的单元测试：纯几何，没有 Electron 依赖。
//
// 基准：主显示器工作区 1600×900，窗口 900×640，间隙 12、边距 8。

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeChatPositionMode,
  normalizeChatFixedCorner,
  computeChatWindowBounds,
  computeAttachedChatBounds,
  chatBoundsDiffer,
} = require("../src/chat-window-placement");

const AREA = { x: 0, y: 0, width: 1600, height: 900 };
const SIZE = { width: 900, height: 640 };

function place(overrides = {}) {
  return computeChatWindowBounds({ workArea: AREA, ...SIZE, ...overrides });
}

test("normalizers fall back to the documented defaults", () => {
  assert.equal(normalizeChatPositionMode("corner"), "corner");
  assert.equal(normalizeChatPositionMode("nonsense"), "follow");
  assert.equal(normalizeChatPositionMode(undefined), "follow");
  assert.equal(normalizeChatFixedCorner("top-left"), "top-left");
  assert.equal(normalizeChatFixedCorner("middle"), "bottom-right");
  assert.equal(normalizeChatFixedCorner(null), "bottom-right");
});

test("corner mode pins the window to each corner of the work area", () => {
  const expected = {
    "top-left": { x: 8, y: 8 },
    "top-right": { x: 692, y: 8 },
    "bottom-left": { x: 8, y: 252 },
    "bottom-right": { x: 692, y: 252 },
  };
  for (const [corner, point] of Object.entries(expected)) {
    const bounds = place({ mode: "corner", corner });
    assert.deepEqual({ x: bounds.x, y: bounds.y }, point, `${corner} must land at ${JSON.stringify(point)}`);
    assert.equal(bounds.side, corner);
  }
});

test("corner mode respects the offset of a secondary display", () => {
  const bounds = computeChatWindowBounds({
    mode: "corner",
    corner: "top-left",
    workArea: { x: 1920, y: 120, width: 1280, height: 800 },
    ...SIZE,
  });
  assert.deepEqual({ x: bounds.x, y: bounds.y }, { x: 1928, y: 128 });
});

test("follow mode sits to the left of the pet when there is room", () => {
  const bounds = place({ mode: "follow", petRect: { x: 1300, y: 400, width: 120, height: 120 } });
  assert.equal(bounds.x, 1300 - 12 - 900);
  assert.equal(bounds.side, "left");
  // 纵向以桌宠中心 460 为基准：460 - 320 = 140。
  assert.equal(bounds.y, 140);
});

test("follow mode prefers the left side and only flips right when the left does not fit", () => {
  // 左侧放不下（x<8）、右侧放得下 → 翻到右边。
  const bounds = place({ mode: "follow", petRect: { x: 40, y: 400, width: 120, height: 120 } });
  assert.equal(bounds.side, "right");
  assert.equal(bounds.x, 160 + 12);
});

test("follow mode clamps into the work area on the far side when neither side fits", () => {
  // 桌宠在 760，工作区中心 800：窗口 900 宽两边都放不下 → 贴右边缘。
  const right = place({ mode: "follow", petRect: { x: 700, y: 400, width: 120, height: 120 } });
  assert.equal(right.side, "clamped");
  assert.equal(right.x, 1600 - 8 - 900);
  // 桌宠在 820（工作区中心 800 右侧）、两边都放不下 → 贴左边缘。
  const left = place({ mode: "follow", petRect: { x: 760, y: 400, width: 120, height: 120 } });
  assert.equal(left.side, "clamped");
  assert.equal(left.x, 8);
});

test("follow mode clamps vertically and keeps the window on screen", () => {
  const top = place({ mode: "follow", petRect: { x: 1300, y: 0, width: 120, height: 120 } });
  assert.equal(top.y, 8);
  const bottom = place({ mode: "follow", petRect: { x: 1300, y: 860, width: 120, height: 120 } });
  assert.equal(bottom.y, 252);
});

test("follow mode prefers the pet anchor rect over the window rect", () => {
  const bounds = place({
    mode: "follow",
    petRect: { x: 0, y: 0, width: 400, height: 400 },
    anchorRect: { left: 1300, top: 400, right: 1420, bottom: 520 },
  });
  assert.equal(bounds.x, 1300 - 12 - 900);
  assert.equal(bounds.y, 140);
});

test("follow mode centers on the work area before the pet rect is known", () => {
  const centered = place({ mode: "follow", petRect: null });
  assert.deepEqual({ x: centered.x, y: centered.y }, { x: 350, y: 130 });
  assert.equal(centered.side, "center");
  // 就绪前的占位矩形（宽高为 0）也按「不知道」处理。
  const placeholder = place({ mode: "follow", petRect: { x: 0, y: 0, width: 0, height: 0 } });
  assert.equal(placeholder.side, "center");
});

test("a window bigger than the work area is shrunk to it and never hangs off one edge", () => {
  const bounds = computeChatWindowBounds({
    mode: "corner",
    corner: "top-left",
    workArea: { x: 0, y: 0, width: 800, height: 600 },
    width: 1200,
    height: 900,
  });
  assert.equal(bounds.width, 800);
  assert.equal(bounds.height, 600);
  // 边距把可用区间挤成负数时取中点（0），窗口铺满工作区而不是整体甩到屏幕外。
  assert.deepEqual({ x: bounds.x, y: bounds.y }, { x: 0, y: 0 });
});

test("invalid inputs return null instead of a bogus rectangle", () => {
  assert.equal(computeChatWindowBounds({ workArea: AREA, width: 0, height: 640 }), null);
  assert.equal(computeChatWindowBounds({ workArea: AREA, width: 900, height: Number.NaN }), null);
  assert.equal(computeChatWindowBounds({ width: 900, height: 640 }), null);
  assert.equal(computeChatWindowBounds({ workArea: { x: 0, y: 0, width: 0, height: 0 }, ...SIZE }), null);
});

// ── 「一条」版式：回复窗口贴在面板卡片正上方 ──

test("attached mode sits flush on top of the panel card, same left edge", () => {
  const panelCard = { x: 988, y: 750, width: 300, height: 134 };
  const bounds = computeAttachedChatBounds({ panelCard, workArea: AREA, width: 300, height: 680 });
  assert.equal(bounds.x, 988);
  assert.equal(bounds.y, 750 - 680, "底边必须紧贴卡片顶边（无缝隙）");
  assert.equal(bounds.side, "attached");
});

test("attached mode clamps the column into the work area", () => {
  const panelCard = { x: -40, y: 120, width: 300, height: 134 };
  const bounds = computeAttachedChatBounds({ panelCard, workArea: AREA, width: 300, height: 680 });
  // 卡片顶边太靠上，窗口放不下：夹到工作区顶部（宁可压住卡片，也不能跑出屏幕）。
  assert.equal(bounds.y, 8);
  assert.equal(bounds.x, 8);
});

test("attached mode falls back to null without a usable card or work area", () => {
  assert.equal(computeAttachedChatBounds({ workArea: AREA, ...SIZE }), null);
  assert.equal(computeAttachedChatBounds({ panelCard: { x: 0, y: 0, width: 0, height: 0 }, workArea: AREA, ...SIZE }), null);
  assert.equal(computeAttachedChatBounds({ panelCard: { x: 0, y: 0, width: 300, height: 134 }, ...SIZE }), null);
});

test("chatBoundsDiffer treats sub-threshold drift as unchanged", () => {
  const base = { x: 100, y: 200, width: 900, height: 640 };
  assert.equal(chatBoundsDiffer(base, { ...base }, 6), false);
  assert.equal(chatBoundsDiffer(base, { ...base, x: 106 }, 6), false);
  assert.equal(chatBoundsDiffer(base, { ...base, x: 107 }, 6), true);
  assert.equal(chatBoundsDiffer(base, { ...base, y: 193 }, 6), true);
  // 尺寸变了永远算变了。
  assert.equal(chatBoundsDiffer(base, { ...base, width: 901 }, 100), true);
  assert.equal(chatBoundsDiffer(null, base, 6), true);
  assert.equal(chatBoundsDiffer(base, null, 6), true);
});
