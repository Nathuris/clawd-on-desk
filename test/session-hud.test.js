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
  QUICK_MENU_CARD,
  QUICK_MENU_GAP,
  QUICK_ATTACH_ROW,
  QUICK_ATTACH_EXTRA,
  quickCardHeight,
  QUICK_SHELL,
  QUICK_DROP,
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

  it("nudges the whole panel down by QUICK_DROP", () => {
    const common = {
      hitRect: HIT_RECT,
      anchorRect: null,
      workArea: WORK_AREA,
      cardW: QUICK_CARD.width,
      cardH: QUICK_CARD.height,
      shell: QUICK_SHELL,
      prefer: "left",
      scale: 1,
      widthScale: 1,
    };
    const plain = computeBlockBounds(common);
    const dropped = computeBlockBounds({ ...common, dropY: QUICK_DROP });
    // 收起态整体下移：窗口矩形和内容矩形都跟着走，高度不变
    assert.equal(dropped.contentBounds.y - plain.contentBounds.y, QUICK_DROP);
    assert.equal(dropped.bounds.y - plain.bounds.y, QUICK_DROP);
    assert.equal(dropped.bounds.height, plain.bounds.height);
  });

  it("keeps the bottom edge pinned when the panel grows, drop included", () => {
    const common = {
      hitRect: HIT_RECT,
      anchorRect: null,
      workArea: WORK_AREA,
      cardW: QUICK_CARD.width,
      shell: QUICK_SHELL,
      prefer: "left",
      scale: 1,
      widthScale: 1,
      dropY: QUICK_DROP,
    };
    const collapsed = computeBlockBounds({ ...common, cardH: QUICK_CARD.height });
    const expanded = computeBlockBounds({
      ...common,
      cardH: quickCardHeight("session", false),
      baseCardH: QUICK_CARD.height,
    });
    const bottomOf = (r) => r.contentBounds.y + r.contentBounds.height;
    assert.equal(bottomOf(expanded), bottomOf(collapsed));
    // 长出来的高度全在上方
    assert.ok(expanded.contentBounds.y < collapsed.contentBounds.y);
  });

  it("the drop never pushes the panel out of the work area", () => {
    const petAtBottom = { left: 700, top: 860, right: 760, bottom: 895 };
    const dropped = computeBlockBounds({
      hitRect: petAtBottom,
      anchorRect: null,
      workArea: WORK_AREA,
      cardW: QUICK_CARD.width,
      cardH: QUICK_CARD.height,
      shell: QUICK_SHELL,
      prefer: "left",
      scale: 1,
      widthScale: 1,
      dropY: QUICK_DROP,
    });
    assert.ok(
      dropped.contentBounds.y + dropped.contentBounds.height
        <= WORK_AREA.y + WORK_AREA.height
    );
  });

  it("整扇窗口（含上下壳）都留在工作区里：桌宠贴屏幕下沿也不越界", () => {
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
      dropY: QUICK_DROP,
    });
    // 窗口底边越出屏幕的话，macOS 会把窗口顶回屏幕内，面板就会「先出现在
    // 偏上的位置、下一次刷新再往下蹦一下」，热区判定也跟着和眼睛看到的错位。
    assert.ok(
      result.bounds.y + result.bounds.height <= WORK_AREA.y + WORK_AREA.height,
      "窗口底边（含 60px 输入法净空）不能越出工作区"
    );
    assert.ok(result.bounds.y >= WORK_AREA.y, "窗口顶边也在工作区内");
    // 展开（开菜单）时也一样：长大只往上，底边不越界
    const expanded = computeBlockBounds({
      hitRect: petAtBottom,
      anchorRect: null,
      workArea: WORK_AREA,
      cardW: QUICK_CARD.width,
      cardH: quickCardHeight("settings", false),
      baseCardH: QUICK_CARD.height,
      shell: QUICK_SHELL,
      prefer: "left",
      scale: 1,
      widthScale: 1,
      dropY: QUICK_DROP,
    });
    assert.ok(
      expanded.bounds.y + expanded.bounds.height <= WORK_AREA.y + WORK_AREA.height,
      "展开态同样不越界"
    );
    assert.ok(expanded.bounds.y >= WORK_AREA.y, "展开态的顶边也不越界");
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

describe("卡片几何（只剩状态行 + 输入行）", () => {
  it("卡片高度 = 状态行 + 行距 + 输入行 + 内边距 + 边框", () => {
    // 6 + 16 + 4 + 32 + 6 + 2 = 66
    assert.deepStrictEqual(QUICK_CARD, { width: 300, height: 66 });
  });

  it("卡片始终夹在工作区内，贴桌宠那一侧的锚点不变", () => {
    const bounds = computeBlockBounds({
      hitRect: HIT_RECT, anchorRect: null, workArea: WORK_AREA,
      cardW: QUICK_CARD.width, cardH: QUICK_CARD.height, shell: QUICK_SHELL,
      prefer: "left", scale: 1, widthScale: 1,
    });
    assert.ok(bounds.contentBounds.y >= WORK_AREA.y);
    assert.ok(
      bounds.contentBounds.y + bounds.contentBounds.height
        <= WORK_AREA.y + WORK_AREA.height
    );
    assert.ok(bounds.contentBounds.x < HIT_RECT.left, "默认贴桌宠左侧");
  });

  it("两个菜单分开：会话菜单由状态行开，设置菜单由齿轮开", () => {
    // 老的二级菜单（quick-menu / quick-mode-option 那几个类名）不能复活；
    // 现在的菜单卡片类名是 .quick-menu-card，由渲染端与 HTML 认领。
    assert.doesNotMatch(src, /quick-mode-option|quick-effort-range/);
    // 菜单展开：卡片变高 + 钉住 hold，收起时复位；两个菜单互斥
    assert.match(src, /cardH: quickCardHeight\(menuOpen, attachmentCount > 0\)/);
    assert.match(src, /if \(next\) holdReasons\.add\("menu"\);/);
    assert.match(src, /function setMenuOpen\(menu\)/);
    assert.match(src, /const next = menu === "session" \|\| menu === "settings" \? menu : null/);
  });

  it("窗口内容高度：主卡片 + 间距 + 菜单卡片，附件是主卡片上的加法", () => {
    // 主卡片 66（挂附件 94）；菜单卡片浮在上面，中间隔 6px。
    assert.strictEqual(QUICK_ATTACH_ROW.height, 24);
    assert.strictEqual(QUICK_ATTACH_EXTRA, 24 + 4);
    assert.strictEqual(QUICK_MENU_CARD.session, 178 + 6 + 6 + 2);
    assert.strictEqual(QUICK_MENU_CARD.settings, 248 + 6 + 6 + 2);
    assert.strictEqual(QUICK_MENU_GAP, 6);

    assert.strictEqual(quickCardHeight(null, false), QUICK_CARD.height);
    assert.strictEqual(quickCardHeight("session", false), QUICK_CARD.height + 6 + QUICK_MENU_CARD.session);
    assert.strictEqual(quickCardHeight("settings", false), QUICK_CARD.height + 6 + QUICK_MENU_CARD.settings);
    assert.strictEqual(quickCardHeight(null, true), QUICK_CARD.height + QUICK_ATTACH_EXTRA);
    assert.strictEqual(
      quickCardHeight("session", true),
      QUICK_CARD.height + QUICK_ATTACH_EXTRA + 6 + QUICK_MENU_CARD.session
    );
    assert.strictEqual(
      quickCardHeight("settings", true),
      QUICK_CARD.height + QUICK_ATTACH_EXTRA + 6 + QUICK_MENU_CARD.settings
    );
    // 乱给的值就当收起处理
    assert.strictEqual(quickCardHeight("bogus", false), QUICK_CARD.height);
  });

  it("开菜单时卡片变高，且只往上长（底边钉住）", () => {
    const base = {
      hitRect: HIT_RECT, anchorRect: null, workArea: WORK_AREA,
      cardW: QUICK_CARD.width, shell: QUICK_SHELL,
      prefer: "left", scale: 1, widthScale: 1,
    };
    const collapsed = computeBlockBounds({ ...base, cardH: QUICK_CARD.height });
    const opened = computeBlockBounds({
      ...base, cardH: quickCardHeight("session", false), baseCardH: QUICK_CARD.height,
    });
    assert.equal(opened.contentBounds.x, collapsed.contentBounds.x, "贴桌宠那一侧不动");
    assert.equal(
      opened.contentBounds.y + opened.contentBounds.height,
      collapsed.contentBounds.y + collapsed.contentBounds.height,
      "底边钉住，多出来的高度全在上方"
    );
    assert.ok(opened.contentBounds.y < collapsed.contentBounds.y);
    assert.strictEqual(
      quickCardHeight("session", false) - QUICK_CARD.height,
      6 + 192,
      "会话菜单卡片 192（列表区 178 + 内边距 12 + 边框 2）＋ 6px 间距"
    );
    assert.strictEqual(
      quickCardHeight("settings", false) - QUICK_CARD.height,
      6 + 262,
      "设置菜单卡片 262（列表区 248 + 内边距 12 + 边框 2）＋ 6px 间距"
    );
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
      "getPanelCardRect",
      "getWindows",
      "cleanup",
      "getWindow",
      "getQuotaRingWindow",
      "revealFromPet",
      "handlePinnedChanged",
      "clearReveal",
      "dismissForAction",
      "setHold",
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
    assert.match(src, /let inHotZone = holdReasons\.size > 0 \|\| attachmentCount > 0;/);
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

  it("卡片矩形仍按「收起态」的底边算（展开/挂附件都不该挪上面那条接缝）", () => {
    assert.match(src, /function getPanelCardRect\(\)/);
    assert.match(src, /const cardHeight = Math\.ceil\(QUICK_CARD\.height \* getTextScale\(\)\)/);
    assert.match(src, /y: Math\.round\(content\.y \+ content\.height - cardHeight\)/);
  });

  it("一个会话都没有时，发消息会自己开一个新会话（main 侧接线）", () => {
    // 两条入口共用同一个占位构造：点「＋ 在终端里新建会话」，以及没会话时直接发。
    assert.match(mainSrc, /function ensurePendingNewSession\(\) \{/);
    assert.match(mainSrc, /function quickCreateSession\(\) \{[\s\S]*?ensurePendingNewSession\(\);/);
    assert.match(mainSrc, /if \(!entry && process\.platform === "darwin"\) \{/);
    assert.match(mainSrc, /const pending = ensurePendingNewSession\(\);/);
    // 交给同一条「新会话」路径：终端里开起来 + 把这句话当第一句送进去。
    assert.match(mainSrc, /return sendToPendingNewSession\(pending, text\);/);
  });

  it("回复窗口这一整条链已经拆干净（面板只往终端里发消息）", () => {
    // 内置聊天窗口连同它的自动消失一起删了：面板不再有「窗口开着就轮询」这类判定，
    // 残留会让面板永远收不起来。
    assert.doesNotMatch(src, /reply-window-autohide/);
    assert.doesNotMatch(src, /decideReplyWindowVisibility|syncReplyWindowAutoHide|replyRevealed/);
    assert.doesNotMatch(src, /isReplyWindowOpen|noteReplyWindowStateChanged|getAttachedReply/);
    assert.doesNotMatch(mainSrc, /getChatWindow|chatWindowRuntime|isReplyBusy|onReplyVisibilityChanged/);
  });
});
