"use strict";

// 快捷面板（点击桌宠弹出）——主进程侧契约测试。
// 面板 = 单个整块窗口（状态行/设置行/文件夹行/输入行）；会话列表已删除。
// 这里锁：整卡几何（computeBlockBounds）、显隐判定
// （evaluateBaseEligible / evaluateShouldShow）、热区、以及源码级契约。

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sessionHud = require("../src/session-hud");
const {
  QUICK_CARD,
  QUICK_CARD_EXPANDED,
  QUICK_SHELL,
  computeBlockBounds,
  evaluateBaseEligible,
  evaluateShouldShow,
  rectsIntersect,
  pointInExpandedRect,
  computeAutoHideHotZone,
  pointInHotZone,
  getBlockWidthScale,
  constants,
} = sessionHud.__test;

const src = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud.js"), "utf8");
const mainSrc = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
const topmostSrc = fs.readFileSync(path.join(__dirname, "..", "src", "topmost-runtime.js"), "utf8");

const WORK_AREA = { x: 0, y: 0, width: 1440, height: 900 };
const HIT_RECT = { left: 700, top: 430, right: 760, bottom: 490 }; // 60×60 的宠物命中区

describe("快捷面板整卡几何", () => {
  it("panel prefers the left side, vertically centered on the pet", () => {
    const result = computeBlockBounds({
      hitRect: HIT_RECT,
      anchorRect: null,
      workArea: WORK_AREA,
      cardW: QUICK_CARD.width,
      cardH: QUICK_CARD.height,
      shell: QUICK_SHELL,
      prefer: "left",
      scale: 1,
      widthScale: 1,
    });
    assert.ok(result);
    assert.equal(result.side, "left");
    const gap = constants.BLOCK_PET_GAP;
    assert.equal(result.contentBounds.x, HIT_RECT.left - gap - QUICK_CARD.width);
    assert.equal(
      result.contentBounds.y,
      Math.round((HIT_RECT.top + HIT_RECT.bottom) / 2 - QUICK_CARD.height / 2)
    );
    // 窗口矩形 = 内容矩形 + 壳（壳底 30 是输入法候选窗净空）
    assert.equal(result.bounds.x, result.contentBounds.x - QUICK_SHELL.left);
    assert.equal(result.bounds.y, result.contentBounds.y - QUICK_SHELL.top);
    assert.equal(
      result.bounds.height,
      QUICK_CARD.height + QUICK_SHELL.top + QUICK_SHELL.bottom
    );
  });

  it("falls back to the other side when the preferred side has no room", () => {
    const petAtLeftEdge = { left: 20, top: 430, right: 80, bottom: 490 };
    const result = computeBlockBounds({
      hitRect: petAtLeftEdge,
      anchorRect: null,
      workArea: WORK_AREA,
      cardW: QUICK_CARD.width,
      cardH: QUICK_CARD.height,
      shell: QUICK_SHELL,
      prefer: "left",
      scale: 1,
      widthScale: 1,
    });
    assert.equal(result.side, "right");
    assert.equal(
      result.contentBounds.x,
      petAtLeftEdge.right + constants.BLOCK_PET_GAP
    );
  });

  it("falls below the pet when neither side fits", () => {
    const narrow = { x: 0, y: 0, width: QUICK_CARD.width + 40, height: 900 };
    const result = computeBlockBounds({
      hitRect: HIT_RECT,
      anchorRect: null,
      workArea: narrow,
      cardW: QUICK_CARD.width,
      cardH: QUICK_CARD.height,
      shell: QUICK_SHELL,
      prefer: "left",
      scale: 1,
      widthScale: 1,
    });
    assert.equal(result.side, "below");
    assert.ok(result.contentBounds.y >= HIT_RECT.bottom);
  });

  it("keeps vertical placement inside the work area near screen edges", () => {
    const petAtBottom = { left: 700, top: 860, right: 760, bottom: 895 };
    const result = computeBlockBounds({
      hitRect: petAtBottom,
      anchorRect: null,
      workArea: WORK_AREA,
      cardW: QUICK_CARD.width,
      cardH: QUICK_CARD.height,
      shell: QUICK_SHELL,
      prefer: "left",
      scale: 1,
      widthScale: 1,
    });
    assert.ok(result.contentBounds.y >= 0);
    assert.ok(
      result.contentBounds.y + result.contentBounds.height
        <= WORK_AREA.y + WORK_AREA.height
    );
  });

  it("scales with text scale (gentle width growth, full height growth)", () => {
    const scale = 1.6; // clampTextScale 的上限
    const result = computeBlockBounds({
      hitRect: HIT_RECT,
      anchorRect: null,
      workArea: WORK_AREA,
      cardW: QUICK_CARD.width,
      cardH: QUICK_CARD.height,
      shell: QUICK_SHELL,
      prefer: "left",
      scale,
      widthScale: getBlockWidthScale(scale),
    });
    assert.equal(result.contentBounds.height, Math.ceil(QUICK_CARD.height * scale));
    assert.ok(
      result.contentBounds.width < QUICK_CARD.width * scale,
      "width must grow more gently than height"
    );
  });

  it("returns null without a pet or work area", () => {
    assert.equal(computeBlockBounds({
      hitRect: null, anchorRect: null, workArea: WORK_AREA,
      cardW: 100, cardH: 50, shell: QUICK_SHELL,
    }), null);
    assert.equal(computeBlockBounds({
      hitRect: HIT_RECT, anchorRect: null, workArea: null,
      cardW: 100, cardH: 50, shell: QUICK_SHELL,
    }), null);
  });

  it("rectsIntersect detects overlap", () => {
    const a = { x: 0, y: 0, width: 10, height: 10 };
    assert.equal(rectsIntersect(a, { x: 5, y: 5, width: 10, height: 10 }), true);
    assert.equal(rectsIntersect(a, { x: 10, y: 0, width: 10, height: 10 }), false);
    assert.equal(rectsIntersect(null, a), false);
  });
});

describe("快捷面板显隐判定", () => {
  const baseFlags = {
    petHidden: false,
    miniMode: false,
    miniTransitioning: false,
    ringEligible: false,
  };

  it("base eligible: 面板开关关掉且没有配额环时不出", () => {
    assert.equal(
      evaluateBaseEligible({ ...baseFlags, sessionHudEnabled: false }),
      false
    );
    assert.equal(
      evaluateBaseEligible({ ...baseFlags, sessionHudEnabled: false, ringEligible: true }),
      true,
      "配额环独立于面板开关"
    );
    assert.equal(evaluateBaseEligible({ ...baseFlags, sessionHudEnabled: true }), true);
  });

  it("base eligible: 宠物隐藏 / mini 形态一律不出", () => {
    assert.equal(evaluateBaseEligible({ ...baseFlags, sessionHudEnabled: true, petHidden: true }), false);
    assert.equal(evaluateBaseEligible({ ...baseFlags, sessionHudEnabled: true, miniMode: true }), false);
    assert.equal(evaluateBaseEligible({ ...baseFlags, sessionHudEnabled: true, miniTransitioning: true }), false);
  });

  it("evaluateShouldShow hides when not revealed (default hidden state)", () => {
    const r = evaluateShouldShow({
      eligible: true, sessionHudPinned: false, revealed: false,
      inHotZone: true, now: 1000, visibleHoldUntil: 5000, hideGraceMs: 500,
    });
    assert.equal(r.show, false);
  });

  it("evaluateShouldShow shows when pinned regardless of revealed/zone", () => {
    const r = evaluateShouldShow({
      eligible: true, sessionHudPinned: true, revealed: false,
      inHotZone: false, now: 1000, visibleHoldUntil: 0, hideGraceMs: 500,
    });
    assert.equal(r.show, true);
  });

  it("evaluateShouldShow advances visibleHoldUntil when revealed and in hot zone", () => {
    const r = evaluateShouldShow({
      eligible: true, sessionHudPinned: false, revealed: true,
      inHotZone: true, now: 1000, visibleHoldUntil: 0, hideGraceMs: 500,
    });
    assert.equal(r.show, true);
    assert.equal(r.nextHoldUntil, 1500);
  });

  it("evaluateShouldShow keeps visible during the grace window after leaving", () => {
    const r = evaluateShouldShow({
      eligible: true, sessionHudPinned: false, revealed: true,
      inHotZone: false, now: 520, visibleHoldUntil: 1000, hideGraceMs: 500,
    });
    assert.equal(r.show, true, "宽限期内不收起");
    const expired = evaluateShouldShow({
      eligible: true, sessionHudPinned: false, revealed: true,
      inHotZone: false, now: 1200, visibleHoldUntil: 1000, hideGraceMs: 500,
    });
    assert.equal(expired.show, false, "宽限期结束收起");
  });

  it("evaluateShouldShow hides when not eligible", () => {
    const r = evaluateShouldShow({
      eligible: false, sessionHudPinned: true, revealed: true,
      inHotZone: true, now: 0, visibleHoldUntil: 99999, hideGraceMs: 500,
    });
    assert.equal(r.show, false);
  });
});

describe("二级设置菜单（主进程侧）", () => {
  it("expanded card is exactly the collapsed card plus the menu area", () => {
    assert.deepStrictEqual(QUICK_CARD, { width: 300, height: 134 });
    assert.deepStrictEqual(QUICK_CARD_EXPANDED, { width: 300, height: 316 });
    assert.strictEqual(QUICK_CARD_EXPANDED.width, QUICK_CARD.width);
    // 收起态菜单高度 0（仍占 4px 行距），展开 = 收起 + 菜单 182
    assert.strictEqual(QUICK_CARD_EXPANDED.height, QUICK_CARD.height + 182);
  });

  it("expanding grows upward only: bottom edge pinned, pet-side anchor stays put", () => {
    const base = {
      hitRect: HIT_RECT, anchorRect: null, workArea: WORK_AREA,
      cardW: QUICK_CARD.width, shell: QUICK_SHELL,
      prefer: "left", scale: 1, widthScale: 1,
    };
    const collapsed = computeBlockBounds({ ...base, cardH: QUICK_CARD.height });
    const expanded = computeBlockBounds({
      ...base,
      cardH: QUICK_CARD_EXPANDED.height,
      baseCardH: QUICK_CARD.height,
    });
    // 水平锚点（贴桌宠那一侧）不变
    assert.equal(expanded.contentBounds.x, collapsed.contentBounds.x);
    assert.equal(expanded.contentBounds.width, collapsed.contentBounds.width);
    // 底边钉住不动，多出来的高度全在上方
    assert.equal(
      expanded.contentBounds.y + expanded.contentBounds.height,
      collapsed.contentBounds.y + collapsed.contentBounds.height
    );
    assert.ok(expanded.contentBounds.y < collapsed.contentBounds.y);
  });

  it("expanding near the top edge clamps back inside the work area", () => {
    const petAtTop = { left: 700, top: 60, right: 760, bottom: 120 };
    const expanded = computeBlockBounds({
      hitRect: petAtTop, anchorRect: null, workArea: WORK_AREA,
      cardW: QUICK_CARD.width, cardH: QUICK_CARD_EXPANDED.height,
      baseCardH: QUICK_CARD.height, shell: QUICK_SHELL,
      prefer: "left", scale: 1, widthScale: 1,
    });
    assert.ok(expanded.contentBounds.y >= WORK_AREA.y);
    assert.ok(
      expanded.contentBounds.y + expanded.contentBounds.height
        <= WORK_AREA.y + WORK_AREA.height
    );
  });

  it("menu state drives the card height and holds the panel open", () => {
    assert.match(src, /cardH: expanded \? QUICK_CARD_EXPANDED\.height : QUICK_CARD\.height/);
    assert.match(src, /if \(next\) holdReasons\.add\("menu"\);/);
    assert.match(src, /holdReasons\.delete\("menu"\)/);
  });

  it("hiding the panel resets the menu so the next reveal is collapsed", () => {
    const hideFn = src.match(/function hidePanel\(\) \{[\s\S]*?\n  \}/);
    assert.ok(hideFn, "hidePanel function missing");
    assert.match(hideFn[0], /expanded = false/);
  });

  it("grows the window immediately but defers shrinking until the panel is hidden", () => {
    // macOS 合成器在「画面静止 + 窗口缩小」的瞬间偶发亮出一帧错位画面
    // （用户看到的闪）；展开时画面本来就在动所以无感。缩小只记目标，
    // 等窗口隐藏时再应用。
    const applyFn = src.match(/function applyPanelBounds\(win, bounds\) \{[\s\S]*?\n  \}/);
    assert.ok(applyFn, "applyPanelBounds missing");
    assert.match(applyFn[0], /const shrinks = !!current && bounds\.height < current\.height/);
    // 放大 / 不可见：立即 setBounds
    assert.match(applyFn[0], /if \(!shrinks\) \{[\s\S]*?win\.setBounds\(bounds\);/);
    assert.match(applyFn[0], /const visible = typeof win\.isVisible === "function" && win\.isVisible\(\);/);
    assert.match(applyFn[0], /if \(!visible\) \{[\s\S]*?win\.setBounds\(bounds\);/);
    // 可见时只记不缩
    assert.match(applyFn[0], /pendingHiddenBounds = bounds;/);
    // 隐藏时应用
    const hiddenFn = src.match(/function applyPendingHiddenBounds\(\) \{[\s\S]*?\n  \}/);
    assert.ok(hiddenFn, "applyPendingHiddenBounds missing");
    assert.match(hiddenFn[0], /win\.setBounds\(target\);/);
    const hideFn = src.match(/function hidePanel\(\) \{[\s\S]*?\n  \}/);
    assert.ok(hideFn, "hidePanel missing");
    assert.match(hideFn[0], /current\.hide\(\);[\s\S]*?applyPendingHiddenBounds\(\);/);
    // 旧的「挂起计时 + 分步收缩 + 渲染端确认」机制必须清干净
    assert.doesNotMatch(src, /panelResizeTimer|panelResizeAnimTimer|applyPendingPanelBounds|handleMenuSettled/);
  });

  it("lets clicks through outside the card and takes them back inside it", () => {
    assert.match(src, /function setClickThrough\(through\)/);
    assert.match(src, /win\.setIgnoreMouseEvents\(true, \{ forward: true \}\)/);
    assert.match(src, /win\.setIgnoreMouseEvents\(false\)/);
    // 显示瞬间默认穿透：面板是点桌宠弹出的，指针不会正好在卡片上
    const showFn = src.match(/function showPanel\(\) \{[\s\S]*?\n  \}/);
    assert.ok(showFn, "showPanel missing");
    assert.match(showFn[0], /setClickThrough\(true\)/);
    // 轮询兜底：指针在卡片内 → 收回穿透（渲染端的 mousemove 是快路径）
    const pollFn = src.match(/function evaluateAutoHideCursorNow\([\s\S]*?\n  \}/);
    assert.ok(pollFn, "evaluateAutoHideCursorNow missing");
    assert.match(pollFn[0], /setClickThrough\(!insideCard\)/);
    // 新窗口 / 窗口回收后穿透状态要重新应用
    assert.match(src, /clickThrough = null;/);
  });

  it("wires the click-through fast path end to end", () => {
    const preloadSrc = fs.readFileSync(
      path.join(__dirname, "..", "src", "preload-session-hud.js"), "utf8"
    );
    const ipcSrc = fs.readFileSync(
      path.join(__dirname, "..", "src", "session-ipc.js"), "utf8"
    );
    const rendererSrc = fs.readFileSync(
      path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8"
    );
    assert.match(preloadSrc, /setClickThrough: \(through\) => ipcRenderer\.send\("session-hud:set-click-through"/);
    assert.match(ipcSrc, /on\("session-hud:set-click-through"/);
    assert.match(ipcSrc, /options\.quickSetClickThrough/);
    assert.match(mainSrc, /quickSetClickThrough,/);
    assert.match(mainSrc, /_sessionHud\.setClickThrough/);
    // 渲染端：指针进出卡片时上报（同一状态不重复发）
    assert.match(rendererSrc, /document\.addEventListener\("mousemove"/);
    assert.match(rendererSrc, /if \(!inside === lastClickThrough\) return;/);
    assert.match(rendererSrc, /window\.sessionHudAPI\.setClickThrough\(!inside\)/);
  });

  it("fades the panel in and out instead of popping", () => {
    assert.match(src, /function fadePanelIn\(/);
    assert.match(src, /function fadePanelOut\(/);
    assert.match(src, /setOpacity/);
    // 淡出跑完才 hide，否则窗口先没了看不到渐变
    assert.match(src, /fadePanelOut\(win, \(\) => \{[\s\S]*?\.hide\(\)/);
    // 新窗口从全透明开始，首次显示同样有淡入
    assert.match(src, /win\.setOpacity\(0\)/);
  });
});

describe("快捷面板热区", () => {
  it("collects pet + panel + ring, skipping invalid rects", () => {
    const hotZone = computeAutoHideHotZone({
      petHitRect: HIT_RECT,
      contentBoundsList: [
        { x: 420, y: 445, width: QUICK_CARD.width, height: QUICK_CARD.height },
        null,
      ],
      expectedRingContentBounds: { x: 380, y: 200, width: 80, height: 80 },
      pad: 24,
    });
    assert.equal(hotZone.rects.length, 3);
    assert.equal(hotZone.pad, 24);
    assert.equal(pointInHotZone({ x: 710, y: 460 }, hotZone), true, "在宠物上");
    assert.equal(pointInHotZone({ x: 500, y: 470 }, hotZone), true, "在面板上");
    assert.equal(pointInHotZone({ x: 410, y: 220 }, hotZone), true, "在环上（含 pad）");
    assert.equal(pointInHotZone({ x: 100, y: 100 }, hotZone), false);
  });

  it("pointInExpandedRect 支持左右上下边界与 pad", () => {
    const rect = { left: 0, top: 0, right: 10, bottom: 10 };
    assert.equal(pointInExpandedRect({ x: 5, y: 5 }, rect, 0), true);
    assert.equal(pointInExpandedRect({ x: -5, y: 5 }, rect, 6), true);
    assert.equal(pointInExpandedRect({ x: -5, y: 5 }, rect, 0), false);
  });
});

describe("快捷面板源码级契约", () => {
  it("exposes the click-reveal API surface main.js depends on", () => {
    for (const name of [
      "broadcastSessionSnapshot",
      "repositionSessionHud",
      "repositionQuotaRing",
      "syncSessionHud",
      "sendI18n",
      "getHudReservedOffset",
      "getBlockRects",
      "getWindows",
      "cleanup",
      "getWindow",
      "getQuotaRingWindow",
      "revealFromPet",
      "handlePinnedChanged",
      "clearReveal",
      "dismissForAction",
      "setHold",
      "setMenuOpen",
      "isMenuOpen",
      "pushQuickState",
      "isPanelOpen",
    ]) {
      assert.ok(
        new RegExp(`\\b${name}\\b`).test(src),
        `module must expose ${name}`
      );
    }
  });

  it("loads one whole-card window from session-hud.html (no query)", () => {
    assert.match(src, /loadFile\(path\.join\(__dirname, "session-hud\.html"\)\)/);
    assert.doesNotMatch(src, /\?block|query: \{ block/);
    assert.match(src, /const panel = \{ win: null, loaded: false \};/);
  });

  it("keeps the panel windows focusable with mac acceptFirstMouse and IME treatment", () => {
    assert.match(src, /focusable: true/);
    assert.match(src, /acceptFirstMouse: true/);
    assert.match(src, /__clawdMacTextInputBubble = true/);
  });

  it("polls only while revealed, gated by pinned/mini/low-power", () => {
    const pollFn = src.match(/function isAutoHidePollingNeeded\(\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(pollFn, "isAutoHidePollingNeeded function missing");
    assert.ok(/if\s*\(ctx\.petHidden\)\s*return false/.test(pollFn[0]));
    assert.ok(/if\s*\(getMiniMode\(\)\s*\|\|\s*getMiniTransitioning\(\)\)\s*return false/.test(pollFn[0]));
    assert.ok(/if\s*\(ctx\.lowPowerIdleMode\)\s*return false/.test(pollFn[0]));
    assert.ok(/if\s*\(ctx\.sessionHudPinned === true\)\s*return false/.test(pollFn[0]));
    assert.ok(/return revealed === true/.test(pollFn[0]));
  });

  it("no longer renders or ships any session-row machinery", () => {
    assert.ok(!/clickRevealed/.test(src), "clickRevealed must be gone");
    assert.ok(!/computeHudLayout/.test(src), "session rows layout must be gone");
    assert.ok(!/snapshotHasVisibleSessions/.test(src), "session rows gate must be gone");
    assert.ok(!/hudWindow/.test(src), "legacy single hudWindow name must not come back");
    assert.match(src, /let revealed = false;/);
    assert.match(src, /const holdReasons = new Set\(\);/);
  });

  it("hold keeps the panel alive regardless of cursor read failures", () => {
    assert.match(src, /let inHotZone = holdReasons\.size > 0;/);
  });

  it("window closed handlers clear stale holds", () => {
    const closedFn = src.match(/win\.on\("closed", \(\) => \{[\s\S]*?\n    \}\);/);
    assert.ok(closedFn, "block closed handler missing");
    assert.ok(/holdReasons\.clear\(\)/.test(closedFn[0]));
  });

  it("quick state goes to the single panel window", () => {
    assert.match(src, /function sendQuickState\(\)/);
    const sendFn = src.match(/function sendQuickState\(\)\s*\{[\s\S]*?\n  \}/);
    assert.ok(/const \{ win, loaded \} = panel;/.test(sendFn[0]));
    assert.doesNotMatch(src, /for \(const kind of \["input", "settings"\]\)/);
  });

  it("main wires block windows into the mac topmost runtime", () => {
    assert.match(mainSrc, /getSessionHudWindows: \(\) => getSessionHudWindows\(\)/);
    assert.match(mainSrc, /getSessionHudBlockRects = _sessionHud\.getBlockRects/);
    assert.match(mainSrc, /getSessionHudWindows = _sessionHud\.getWindows/);
    assert.match(topmostSrc, /getSessionHudWindows = options\.getSessionHudWindows/);
  });

  it("main reads the visible block rects for bubble avoidance", () => {
    assert.match(mainSrc, /let getSessionHudBlockRects = \(\) => \[\];/);
    assert.match(mainSrc, /getSessionHudBounds: \(\) => getVisibleSessionHudBounds\(\)/);
  });

  it("roam reads isPanelOpen to hold the pet still", () => {
    const roamSrc = fs.readFileSync(path.join(__dirname, "..", "src", "roam.js"), "utf8");
    assert.match(roamSrc, /ctx\.isQuickPanelOpen/);
    assert.match(mainSrc, /isQuickPanelOpen: \(\) => !!\(/);
  });
});
