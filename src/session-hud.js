"use strict";

// 快捷面板（点击桌宠弹出）——单个整块窗口，默认贴桌宠左侧（放不下自动换
// 右侧、再放不下落桌宠下方）：
//   状态行（这句话会发给终端里哪个会话）+ 输入框
// 输入的话由主进程投递到终端 App 里那个正在运行的 CLI 会话——真正的对话
// 仍然发生在终端里，这里只是个远程输入框。
// 外加可选的配额环（quota-ring.html，独立小窗，原逻辑保留）。
//
// 生命周期沿用原 HUD 契约：
// - 单击桌宠 → revealFromPet()（hit-renderer 单击经 IPC 调到这里）
// - 轮询盯「指针离开热区 + 500ms 宽限」自动收起；拖拽 / 右键菜单 / mini 立即收
// - 输入框聚焦 / 有草稿（holdReasons）时面板不收起
// - pinned（设置）时面板常显；sessionHudEnabled=false 时面板不出来（环独立）
// - 面板打开期间漫游由 roam 侧读 isPanelOpen() 暂停（见 roam.js）
//
// 卡片尺寸/窗口壳常量必须与 session-hud.html 的 CSS 严格一致：
//   卡片 300×66（状态行 16 + 行距 4 + 输入行 32 + 内边距 12 + 边框 2）
//   + 壳 top2/right3/bottom60(输入法候选窗净空)/left3 → 窗口 306×128

const { BrowserWindow, screen } = require("electron");
const path = require("path");
const { keepOutOfTaskbar } = require("./taskbar");
const { clampTextScale, scaleHeight, applyZoomToWindow } = require("./text-scale");
const { decideReplyWindowVisibility } = require("./reply-window-autohide");
const ringGeom = require("./quota-ring-geometry");

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";
const isWin = process.platform === "win32";

// 卡片默认两行：状态行（16）+ 行距（4）+ 输入行（32），
// 6 + 16 + 4 + 32 + 6 + 2 = 66。
const QUICK_CARD = Object.freeze({ width: 300, height: 66 });
// 点状态行展开会话列表，列表区从上到下：最多 4 条会话（各 28）＋ 新建会话（28）
// ＋ 权限模式（34）＋ 思考强度（34）＋ 选文件夹（28），行距一律 2：
// 4×28 + 28 + 34 + 34 + 28 + 7×2 = 250，再加一个卡片行距 4 → 66 + 250 + 4 = 320。
const QUICK_CARD_EXPANDED = Object.freeze({ width: 300, height: 320 });
// 挂了附件时多出来的一行小标签：行高 24 + 卡片自己的一个行距 4 = 28。
// 这一行插在会话列表和输入行之间，所以多出来的高度全往上长，输入框不动。
const QUICK_ATTACH_ROW = Object.freeze({ height: 24 });
const QUICK_ATTACH_EXTRA = QUICK_ATTACH_ROW.height + 4;
// 卡片该多高：展开列表 +254、挂附件 +28，两者可叠加（数字必须和 session-hud.html
// 的 .quick-card / .quick-attach-row 一一对应）。
function quickCardHeight(listOpen, hasAttachments) {
  const base = listOpen ? QUICK_CARD_EXPANDED.height : QUICK_CARD.height;
  return base + (hasAttachments ? QUICK_ATTACH_EXTRA : 0);
}
// 底部 60px 是输入法候选窗的净空：太小的话 macOS 会认为「光标下面放不下」，
// 把候选窗翻到输入框上方，结果被卡片盖住。
const QUICK_SHELL = Object.freeze({ top: 2, right: 3, bottom: 60, left: 3 });
const BLOCK_PET_GAP = 6;
const BLOCK_WIDTH_GROWTH_RATIO = 0.4;
const EDGE_MARGIN = 8;
const WIN_TOPMOST_LEVEL = "pop-up-menu";
const LINUX_WINDOW_TYPE = "toolbar";
const MAC_FLOATING_TOPMOST_DELAY_MS = 120;
const HOT_ZONE_PAD = 24;
const AUTO_HIDE_POLL_MS = 150;
const HIDE_GRACE_MS = 500;
const HIDDEN_WINDOW_DESTROY_MS = 30000;
// 面板淡入淡出：整窗透明度渐变，别直接闪出来。淡出走完才真正 hide()。
const PANEL_FADE_MS = 140;
const PANEL_FADE_STEPS = 6;
// 缩窗只发生在窗口隐藏之后：macOS 合成器在「画面静止 + 窗口尺寸变化」的
// 瞬间偶发亮出一帧错位画面（用户看到的"闪"），展开方向因为画面本来就在动
// 所以看不出来，收起方向（动画结束、画面静止后缩窗）就非常明显。
// 所以收起后先把目标尺寸记下来，等 hidePanel 真正隐藏的那一刻再缩。

function clampToWorkArea(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(value, max));
}

function isScreenRect(rect) {
  return !!rect
    && Number.isFinite(rect.left)
    && Number.isFinite(rect.top)
    && Number.isFinite(rect.right)
    && Number.isFinite(rect.bottom);
}

function rectsIntersect(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width
    && b.x < a.x + a.width
    && a.y < b.y + b.height
    && b.y < a.y + a.height;
}

// 面板总开关（sessionHudEnabled，原「会话状态显示」）+ 配额环独立门。
function evaluateBaseEligible({
  sessionHudEnabled,
  petHidden,
  miniMode,
  miniTransitioning,
  ringEligible,
}) {
  if (petHidden) return false;
  if (miniMode || miniTransitioning) return false;
  const panelEligible = sessionHudEnabled !== false;
  return panelEligible || ringEligible === true;
}

function pointInExpandedRect(point, rect, pad) {
  if (!point || !isScreenRect(rect)) return false;
  const p = Number.isFinite(pad) ? pad : 0;
  return point.x >= rect.left - p
    && point.x <= rect.right + p
    && point.y >= rect.top - p
    && point.y <= rect.bottom + p;
}

function computeAutoHideHotZone({ petHitRect, contentBoundsList, expectedRingContentBounds, pad }) {
  const rects = [];
  if (isScreenRect(petHitRect)) rects.push(petHitRect);
  // 桌宠 + 面板 + 配额环都算热区：指针在宠物和面板之间移动都不能收起。
  const candidates = Array.isArray(contentBoundsList) ? contentBoundsList.slice() : [];
  candidates.push(expectedRingContentBounds);
  for (const r of candidates) {
    if (!r) continue;
    if (Number.isFinite(r.x) && Number.isFinite(r.y)
        && Number.isFinite(r.width) && Number.isFinite(r.height)
        && r.width > 0 && r.height > 0) {
      rects.push({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });
    } else if (isScreenRect(r)) {
      rects.push(r);
    }
  }
  return { rects, pad: Number.isFinite(pad) ? pad : 0 };
}

function pointInHotZone(point, hotZone) {
  if (!hotZone || !Array.isArray(hotZone.rects)) return false;
  for (const rect of hotZone.rects) {
    if (pointInExpandedRect(point, rect, hotZone.pad)) return true;
  }
  return false;
}

function evaluateShouldShow({
  eligible,
  sessionHudPinned,
  revealed,
  inHotZone,
  now,
  visibleHoldUntil,
  hideGraceMs,
}) {
  if (eligible !== true) return { show: false, nextHoldUntil: 0 };
  if (sessionHudPinned === true) return { show: true, nextHoldUntil: 0 };
  if (revealed !== true) return { show: false, nextHoldUntil: 0 };

  // revealed 态：hot zone（或输入框持有）续命 + grace period
  let nextHoldUntil = Number.isFinite(visibleHoldUntil) ? visibleHoldUntil : 0;
  const tNow = Number.isFinite(now) ? now : 0;
  const grace = Number.isFinite(hideGraceMs) ? hideGraceMs : 0;
  if (inHotZone) {
    nextHoldUntil = tNow + grace;
  }
  const show = inHotZone || tNow < nextHoldUntil;
  return { show, nextHoldUntil };
}

function countQuotaCoins(snapshot, showQuota, hiddenQuotaProviders) {
  return ringGeom.countQuotaCoins(snapshot, showQuota, hiddenQuotaProviders);
}

function getBlockWidthScale(scale) {
  const s = clampTextScale(scale);
  if (s <= 1) return s;
  return 1 + (s - 1) * BLOCK_WIDTH_GROWTH_RATIO;
}

// 单块定位：首选桌宠左/右侧垂直居中；首选侧放不下换另一侧；
// 两侧都放不下退到桌宠下方居中。
//
// baseCardH：展开态（二级菜单）用——按这个「收起高度」算出垂直居中的底边，
// 再让当前（更高的）卡片从同一条底边往上长，这样展开只向上延伸，像拉开抽屉，
// 而不是上下同时撑开。缺省时等同 cardH（普通居中）。
function computeBlockBounds({
  hitRect,
  anchorRect,
  workArea,
  cardW,
  cardH,
  shell,
  prefer = "left",
  scale = 1,
  widthScale = scale,
  baseCardH,
}) {
  const followRect = isScreenRect(anchorRect) ? anchorRect : hitRect;
  if (!isScreenRect(followRect) || !workArea) return null;

  const s = clampTextScale(scale);
  const ws = clampTextScale(widthScale);
  const dipWidth = Math.round(cardW * ws);
  const dipHeight = Math.ceil(cardH * s);
  const sh = {
    top: Math.round(shell.top * s),
    right: Math.round(shell.right * s),
    bottom: Math.round(shell.bottom * s),
    left: Math.round(shell.left * s),
  };
  const gap = Math.round(BLOCK_PET_GAP * s);
  const edge = Math.round(EDGE_MARGIN * s);

  const minX = Math.round(workArea.x + edge);
  const maxX = Math.round(workArea.x + workArea.width - edge - dipWidth);
  const minY = Math.round(workArea.y + edge);
  const maxY = Math.round(workArea.y + workArea.height - edge - dipHeight);
  const followCy = Math.round((followRect.top + followRect.bottom) / 2);

  // 底边基准：收起高度垂直居中时的底边。展开态保持这条底边不动，
  // 于是多出来的高度全部长在上方（不会向下顶到桌宠那边）。
  const baseHeight = Math.ceil((Number.isFinite(baseCardH) ? baseCardH : cardH) * s);
  const baseMinY = Math.round(workArea.y + edge);
  const baseMaxY = Math.round(workArea.y + workArea.height - edge - baseHeight);
  const baseY = clampToWorkArea(followCy - Math.round(baseHeight / 2), baseMinY, baseMaxY);
  const y = clampToWorkArea(baseY + baseHeight - dipHeight, minY, maxY);

  const sideX = (side) => (side === "left"
    ? Math.round(followRect.left - gap - dipWidth)
    : Math.round(followRect.right + gap));
  const fits = (x) => x >= minX && x <= maxX;

  let side = null;
  let x = null;
  for (const candidate of prefer === "right" ? ["right", "left"] : ["left", "right"]) {
    const candidateX = sideX(candidate);
    if (fits(candidateX)) {
      side = candidate;
      x = candidateX;
      break;
    }
  }

  let contentBounds;
  if (side === null) {
    // 屏幕太窄，两侧都放不下：落到桌宠下方居中（下一层冲突消解会再错开）。
    side = "below";
    x = clampToWorkArea(
      Math.round((followRect.left + followRect.right) / 2 - dipWidth / 2),
      minX,
      maxX
    );
    const belowY = clampToWorkArea(followRect.bottom + gap, minY, maxY);
    contentBounds = { x, y: belowY, width: dipWidth, height: dipHeight };
  } else {
    contentBounds = { x, y, width: dipWidth, height: dipHeight };
  }

  return {
    bounds: {
      x: contentBounds.x - sh.left,
      y: contentBounds.y - sh.top,
      width: dipWidth + sh.left + sh.right,
      height: dipHeight + sh.top + sh.bottom,
    },
    contentBounds,
    side,
  };
}

function deferMacFloatingVisibility(ctx, win) {
  if (!isMac || !win || win.isDestroyed()) return;
  const deferUntil = Date.now() + MAC_FLOATING_TOPMOST_DELAY_MS;
  win.__clawdMacDeferredVisibilityUntil = deferUntil;
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    if (win.__clawdMacDeferredVisibilityUntil === deferUntil) {
      delete win.__clawdMacDeferredVisibilityUntil;
    }
    if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
  }, MAC_FLOATING_TOPMOST_DELAY_MS);
}

module.exports = function initSessionHud(ctx) {
  // 单个面板窗口（整块）；ring 独立窗口。
  const panel = { win: null, loaded: false };
  const hiddenDestroyTimers = { panel: null, ring: null };
  // 淡入/淡出推进定时器
  let panelOpacityTimer = null;
  // 收起菜单后待应用的「隐藏时缩窗」目标（可见期间只记不缩）
  let pendingHiddenBounds = null;
  // 透明区点击穿透：卡片外的区域（收起菜单后窗口比卡片高的那截）不该挡住
  // 底下应用的点击。null = 尚未设置过（新建窗口后要重新应用一次）。
  let clickThrough = null;
  let latestSnapshot = null;
  let ringWindow = null;
  let ringDidFinishLoad = false;
  let ringSide = "left";

  let pollTimer = null;
  // 点击揭示状态机：单击桌宠 → revealFromPet() 置 revealed；
  // 轮询盯「指针离开热区 + 宽限期」自动收起。
  // holdReasons=渲染端报告的「不能收」原因（输入框聚焦/有草稿）。
  let revealed = false;
  const holdReasons = new Set();
  let visibleHoldUntil = 0;
  // 会话列表是否展开：展开时卡片更高，且 holdReasons 里钉一个 "menu"
  // 让面板不被自动收起（用户正在挑会话）。
  let sessionListOpen = false;
  // 输入框上挂了几个附件（渲染端持有附件本身，只把这个数字报上来）。
  // 它决定卡片要不要多出一行标签，所以窗口几何这边必须知道。
  let attachmentCount = 0;
  // 回复窗口的自动消失状态：replyRevealed = 我们让它显示；replyHoldUntil =
  // 宽限/「刚回复完」的停留截止时间；replyWasBusy 用来识别「回复刚结束」这个边沿。
  let replyRevealed = false;
  let replyHoldUntil = 0;
  let replyWasBusy = false;
  // 快捷面板的状态投影（effort/权限/忙碌/排队数…），主进程推来后转发面板窗口。
  let latestQuickState = null;
  let lastQuickStateJson = null;
  // 上一次同步时是否画面上有东西（用于通知气泡重排，避免无谓调用）。
  let lastAnyVisible = false;

  function getTextScale() {
    return clampTextScale(typeof ctx.getTextScale === "function" ? ctx.getTextScale() : 1);
  }

  function getMiniMode() {
    return typeof ctx.getMiniMode === "function" && ctx.getMiniMode();
  }

  function getMiniTransitioning() {
    return typeof ctx.getMiniTransitioning === "function" && ctx.getMiniTransitioning();
  }

  function getCurrentSnapshot() {
    return typeof ctx.getSessionSnapshot === "function"
      ? ctx.getSessionSnapshot()
      : { sessions: [], groups: [], orderedIds: [], menuOrderedIds: [] };
  }

  function ringEligible(snapshot = latestSnapshot) {
    return countQuotaCoins(snapshot, ctx.sessionHudShowQuota !== false, ctx.quotaRingHiddenProviders) > 0;
  }

  function baseEligible(snapshot = latestSnapshot) {
    return evaluateBaseEligible({
      sessionHudEnabled: ctx.sessionHudEnabled,
      petHidden: ctx.petHidden,
      miniMode: getMiniMode(),
      miniTransitioning: getMiniTransitioning(),
      ringEligible: ringEligible(snapshot),
    });
  }

  function shouldShow(snapshot = latestSnapshot) {
    if (!baseEligible(snapshot)) return false;
    if (ctx.sessionHudPinned === true) return true;
    return revealed;
  }

  // 轮询只为「已揭示的面板盯收起」（指针离开热区 + 宽限期）。
  function isAutoHidePollingNeeded() {
    if (ctx.petHidden) return false;
    if (getMiniMode() || getMiniTransitioning()) return false;
    if (ctx.lowPowerIdleMode) return false;
    // 回复窗口的自动消失也要靠这次轮询（它是普通窗口，宠物藏了/省电模式下
    // 不该继续轮询）。
    if (isReplyWindowOpen()) return true;
    if (ctx.sessionHudPinned === true) return false;
    return revealed === true;
  }

  function isReplyWindowOpen() {
    return typeof ctx.isReplyWindowOpen === "function" && ctx.isReplyWindowOpen() === true;
  }

  // 发送等动作刚发生：收起面板（视线转移到弹出的对话窗口上）。
  // 下一次点击会正常重新揭示（点击是明确意图，无需防回弹闩）。
  function dismissForAction() {
    clearReveal();
    syncSessionHud(latestSnapshot || getCurrentSnapshot());
  }

  // 面板（含配额环）是否正显示：漫游判定读它——用户在输入/调设置时
  // 宠物必须原地待命，不能一边输一边走。
  function isPanelOpen() {
    if (revealed) return true;
    const win = panel.win;
    if (win && !win.isDestroyed() && win.isVisible()) return true;
    return !!(ringWindow && !ringWindow.isDestroyed() && ringWindow.isVisible());
  }

  // 渲染端报告「不能收起」的原因（输入框聚焦、有草稿）。
  function setHold(reason, held) {
    if (typeof reason !== "string" || !reason) return;
    if (held) holdReasons.add(reason);
    else holdReasons.delete(reason);
    // 输入框聚焦期间（mac）让出置顶，中文输入法候选窗才浮得出来；
    // 与权限气泡的 __clawdMacImeEditing 处理同款（见 topmost-runtime）。
    const inputWin = panel.win;
    if (reason === "focus" && inputWin && !inputWin.isDestroyed()) {
      if (held) inputWin.__clawdMacImeEditing = true;
      else delete inputWin.__clawdMacImeEditing;
      if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
    }
  }

  // 主进程把面板状态投影推过来（有哪些会话可选、当前发给谁、能不能新建、
  // 新会话开在哪个目录、列表是否展开）。
  function pushQuickState(projection) {
    latestQuickState = projection && typeof projection === "object" ? projection : null;
    sendQuickState();
  }

  function sendQuickState() {
    if (!latestQuickState) return;
    // 投影很小，用 JSON 比对接近零成本；流式期间每个 delta 都会推状态，
    // 不去重的话面板会被无意义的重复包刷屏。
    const json = JSON.stringify(latestQuickState);
    if (json === lastQuickStateJson) return;
    lastQuickStateJson = json;
    const { win, loaded } = panel;
    if (!win || win.isDestroyed() || !loaded) return;
    if (!win.webContents || win.webContents.isDestroyed()) return;
    win.webContents.send("session-hud:quick-state", latestQuickState);
  }

  function sendI18n() {
    if (typeof ctx.getI18n !== "function") return;
    const payload = ctx.getI18n();
    const { win: panelWin, loaded: panelLoaded } = panel;
    if (panelWin && !panelWin.isDestroyed() && panelLoaded
        && panelWin.webContents && !panelWin.webContents.isDestroyed()) {
      panelWin.webContents.send("session-hud:lang-change", payload);
    }
    if (ringWindow && !ringWindow.isDestroyed() && ringDidFinishLoad
        && ringWindow.webContents && !ringWindow.webContents.isDestroyed()) {
      ringWindow.webContents.send("quota-ring:lang-change", payload);
    }
  }

  function collectRingAvoidRects(blockContentBounds) {
    const rects = [];
    for (const r of Array.isArray(blockContentBounds) ? blockContentBounds : []) {
      if (r) rects.push(r);
    }

    if (typeof ctx.getPermissionBubbleBounds === "function") {
      try {
        const permissionBounds = ctx.getPermissionBubbleBounds();
        if (Array.isArray(permissionBounds)) rects.push(...permissionBounds);
      } catch {}
    }

    if (typeof ctx.getUpdateBubbleWindow === "function") {
      try {
        const updateWindow = ctx.getUpdateBubbleWindow();
        if (updateWindow
            && !updateWindow.isDestroyed()
            && updateWindow.isVisible()
            && typeof updateWindow.getBounds === "function") {
          rects.push(updateWindow.getBounds());
        }
      } catch {}
    }
    return rects;
  }

  // 面板 + 环的期望布局（同一份几何喂给可见窗口和热区判定，保证一致）。
  function computeExpectedLayout(scale = getTextScale()) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const petBounds = typeof ctx.getPetWindowBounds === "function" ? ctx.getPetWindowBounds() : null;
    if (!petBounds) return null;
    const hitRect = typeof ctx.getHitRectScreen === "function"
      ? ctx.getHitRectScreen(petBounds)
      : null;
    const anchorRect = typeof ctx.getSessionHudAnchorRect === "function"
      ? ctx.getSessionHudAnchorRect(petBounds)
      : null;
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    const widthScale = getBlockWidthScale(scale);

    // 「一条」版式：回复窗口开着时，它贴在卡片正上方，两者合起来才是一个整体。
    // 卡片整体下移 回复窗口高度/2，好让「窗口 + 卡片」这条竖条以桌宠为中心，
    // 否则 680 高的窗口在普通屏幕上总是顶到屏幕外、把卡片压住。
    const attachedHeight = getAttachedReplyHeight();
    const stackedAnchorRect = attachedHeight > 0 && anchorRect
      ? {
        ...anchorRect,
        top: anchorRect.top + attachedHeight / 2,
        bottom: anchorRect.bottom + attachedHeight / 2,
      }
      : anchorRect;

    const panelLayout = computeBlockBounds({
      hitRect, anchorRect: stackedAnchorRect, workArea,
      cardW: QUICK_CARD.width,
      cardH: quickCardHeight(sessionListOpen, attachmentCount > 0),
      // 展开态以收起态的底边为基准向上长（只向上延伸，不向下撑）
      baseCardH: QUICK_CARD.height,
      shell: QUICK_SHELL, prefer: "left", scale, widthScale,
    });

    const coinCount = countQuotaCoins(latestSnapshot, ctx.sessionHudShowQuota !== false, ctx.quotaRingHiddenProviders);
    const ring = coinCount > 0
      ? ringGeom.computeQuotaRingBounds({
        hitRect,
        anchorRect,
        workArea,
        coinCount,
        scale,
        avoidRects: collectRingAvoidRects([panelLayout && panelLayout.contentBounds]),
      })
      : null;
    return { hitRect, panel: panelLayout, ringContentBounds: ring && ring.contentBounds };
  }

  function shellScaled(shell, scale) {
    const s = clampTextScale(scale);
    return {
      top: Math.round(shell.top * s),
      right: Math.round(shell.right * s),
      bottom: Math.round(shell.bottom * s),
      left: Math.round(shell.left * s),
    };
  }

  // 动作互斥：拖着宠物走 / 右键菜单开着 / mini 形态 → 已揭示的面板立即收。
  function isRevealBlocked() {
    if (getMiniMode() || getMiniTransitioning()) return true;
    if (typeof ctx.isDragLocked === "function" && ctx.isDragLocked()) return true;
    if (ctx.menuOpen === true) return true;
    return false;
  }

  // 回复窗口刚开 / 刚关时收敛状态：刚开先给一段宽限，别让它在消息还在排队的
  // 那一瞬间就被判成「该收了」；关掉后把「应为显示」复位，下次开窗重新开始。
  function noteReplyWindowStateChanged(open) {
    if (open === true) {
      replyRevealed = true;
      replyHoldUntil = Date.now() + HIDE_GRACE_MS;
      return;
    }
    replyRevealed = false;
    replyHoldUntil = 0;
    replyWasBusy = false;
  }

  // 只在需要盯收起时被轮询调用：面板自动收起（指针离开热区 + 宽限期、或动作
  // 互斥命中）与回复窗口的自动消失共用这一次光标采样。
  function evaluateAutoHideCursorNow({ syncOnChange = true } = {}) {
    if (!isAutoHidePollingNeeded()) {
      stopAutoHidePoll();
      return false;
    }
    let cursor = null;
    try {
      cursor = screen.getCursorScreenPoint();
    } catch (_err) {
      cursor = null;
    }
    const scale = getTextScale();
    const expected = computeExpectedLayout(scale);
    // 输入框聚焦 / 有草稿 / 挂了附件（holdReasons）视同在热区内：打字到一半、
    // 或者还挂着文件没发出去，面板都不能溜。附件不走 holdReasons（窗口重建时
    // 那份集合会被清空、没人补），直接用 attachmentCount 派生。
    // 这条判定不依赖光标位置——getCursorScreenPoint 偶发失败时 hold 也要保活。
    let inHotZone = holdReasons.size > 0 || attachmentCount > 0;
    if (cursor) {
      const hotZone = computeAutoHideHotZone({
        petHitRect: expected && expected.hitRect,
        // 「一条」版式下面板被推到底部、桌宠挪到了回复窗口旁边，鼠标从面板移到
        // 桌宠/窗口的路上会经过回复窗口——把它的矩形也算进热区，面板才不会
        // 因为「指针离开了面板」而提前收回去。
        contentBoundsList: [
          expected && expected.panel && expected.panel.contentBounds,
          getAttachedReplyRect(),
        ],
        expectedRingContentBounds: expected && expected.ringContentBounds,
        pad: Math.round(HOT_ZONE_PAD * scale),
      });
      inHotZone = inHotZone || pointInHotZone(cursor, hotZone);
      // 透明区穿透兜底：指针在卡片内 → 正常接收点击；在卡片外的透明区
      // → 放行给下面的应用。渲染端的 mousemove 是快路径，这里防漏。
      const cardBounds = expected && expected.panel && expected.panel.contentBounds;
      if (cardBounds) {
        const insideCard = cursor.x >= cardBounds.x
          && cursor.x <= cardBounds.x + cardBounds.width
          && cursor.y >= cardBounds.y
          && cursor.y <= cardBounds.y + cardBounds.height;
        setClickThrough(!insideCard);
      }
    }
    const now = Date.now();

    let changed = false;
    if (syncPanelAutoHide({ inHotZone, now, syncOnChange })) changed = true;
    if (syncReplyWindowAutoHide({ inHotZone, now })) changed = true;
    return changed;
  }

  // 面板的自动收起（只在已揭示时才需要看）。
  function syncPanelAutoHide({ inHotZone, now, syncOnChange }) {
    if (!revealed) return false;
    if (isRevealBlocked()) {
      revealed = false;
      visibleHoldUntil = 0;
      if (syncOnChange) syncSessionHud(latestSnapshot, {});
      return true;
    }
    const result = evaluateShouldShow({
      eligible: baseEligible(latestSnapshot),
      sessionHudPinned: ctx.sessionHudPinned,
      revealed,
      inHotZone,
      now,
      visibleHoldUntil,
      hideGraceMs: HIDE_GRACE_MS,
    });
    visibleHoldUntil = result.nextHoldUntil;
    if (!result.show) {
      revealed = false;
      visibleHoldUntil = 0;
      if (syncOnChange) syncSessionHud(latestSnapshot, {});
      return true;
    }
    return false;
  }

  // 回复窗口的自动消失：和面板同款「离开热区 + 宽限」，另有焦点 / 正在回复 /
  // 刚回复完三种保活（判定写在 reply-window-autohide.js，这里只负责采样与通知）。
  function syncReplyWindowAutoHide({ inHotZone, now }) {
    const open = typeof ctx.isReplyWindowOpen === "function" && ctx.isReplyWindowOpen();
    const busy = open && typeof ctx.isReplyBusy === "function" && ctx.isReplyBusy() === true;
    const result = decideReplyWindowVisibility({
      open,
      busy,
      wasBusy: replyWasBusy,
      pointerInHotZone: inHotZone,
      // 留着草稿或正在输入时也算「人在用」：窗口别在打字中途消失。
      focused: holdReasons.size > 0
        || (typeof ctx.isReplyWindowFocused === "function" && ctx.isReplyWindowFocused() === true),
      now,
      holdUntil: replyHoldUntil,
      hideGraceMs: HIDE_GRACE_MS,
    });
    replyWasBusy = busy;
    replyHoldUntil = result.nextHoldUntil;
    if (result.show === replyRevealed) return false;
    replyRevealed = result.show;
    if (typeof ctx.onReplyVisibilityChanged === "function") {
      try {
        ctx.onReplyVisibilityChanged(result.show);
      } catch (err) {
        console.warn("Clawd: reply window visibility callback failed:", err && err.message);
      }
    }
    return true;
  }

  function pollAutoHideCursor() {
    pollTimer = null;
    if (!isAutoHidePollingNeeded()) {
      stopAutoHidePoll();
      return;
    }
    evaluateAutoHideCursorNow();
    schedulePollTick();
  }

  function schedulePollTick() {
    if (pollTimer) return;
    pollTimer = setTimeout(pollAutoHideCursor, AUTO_HIDE_POLL_MS);
  }

  function startAutoHidePoll() {
    evaluateAutoHideCursorNow({ syncOnChange: false });
    if (!isAutoHidePollingNeeded()) return;
    if (!pollTimer) schedulePollTick();
  }

  function stopAutoHidePoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    revealed = false;
    visibleHoldUntil = 0;
  }

  function managedWindow(kind) {
    return kind === "ring" ? ringWindow : panel.win;
  }

  function cancelHiddenDestroy(kind) {
    const kinds = kind ? [kind] : ["panel", "ring"];
    for (const key of kinds) {
      const timer = hiddenDestroyTimers[key];
      if (!timer) continue;
      clearTimeout(timer);
      hiddenDestroyTimers[key] = null;
    }
  }

  function scheduleHiddenDestroy(kind) {
    // Reclaiming a hidden panel/ring renderer is a low-power-idle-mode behavior;
    // default mode keeps windows warm so reveals stay instant.
    if (!ctx.lowPowerIdleMode) return;
    const win = managedWindow(kind);
    if (!win || win.isDestroyed() || win.isVisible()) return;
    if (hiddenDestroyTimers[kind]) return;
    hiddenDestroyTimers[kind] = setTimeout(() => {
      hiddenDestroyTimers[kind] = null;
      // Re-check the flag: the user may have left low-power mode while hidden.
      if (!ctx.lowPowerIdleMode) return;
      const current = managedWindow(kind);
      if (!current || current.isDestroyed() || current.isVisible()) return;
      current.destroy();
    }, HIDDEN_WINDOW_DESTROY_MS);
  }

  // Internal: clear revealed state without syncing. Caller decides next sync.
  function clearReveal() {
    revealed = false;
    visibleHoldUntil = 0;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  // Public API: 单击桌宠 → 揭示面板（hit-renderer 单击经 IPC 调到这里）。
  function revealFromPet() {
    // Quota can expire while the overlay windows are hidden and no session
    // event arrives. Re-read before deciding eligibility so a stale cached
    // snapshot cannot resurrect a dead Orbit coin.
    latestSnapshot = getCurrentSnapshot();
    if (!baseEligible(latestSnapshot)) return;
    if (ctx.sessionHudPinned === true) {
      // pinned 已常显：点一下只当作宽限续命，保证指针移开后按宽限收起前
      // 还有反悔时间（与历史行为一致）。
      visibleHoldUntil = Date.now() + HIDE_GRACE_MS;
      return;
    }
    if (revealed) {
      // Already revealed — refresh grace as a click tolerance.
      visibleHoldUntil = Date.now() + HIDE_GRACE_MS;
      return;
    }
    revealed = true;
    visibleHoldUntil = Date.now() + HIDE_GRACE_MS;  // seed
    syncSessionHud(latestSnapshot, {});
    startAutoHidePoll();
  }

  // Public API: settings effect router calls this when sessionHudPinned flips.
  // Router has already updated ctx.sessionHudPinned before calling.
  function handlePinnedChanged(next) {
    if (next === true) {
      stopAutoHidePoll();
      // Pinned now — panel always shows via shouldShow. Clear any stale reveal.
      revealed = false;
      visibleHoldUntil = 0;
      syncSessionHud(latestSnapshot);
      return;
    }
    // unpin transition — read real window state, NOT shouldShow() (router
    // already mirrored sessionHudPinned=false so shouldShow would return
    // false and cause the panel to flash hidden).
    let wasVisible = false;
    const panelWin = panel.win;
    if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) wasVisible = true;
    if (ringWindow && !ringWindow.isDestroyed() && ringWindow.isVisible()) wasVisible = true;
    if (wasVisible && baseEligible(latestSnapshot)) {
      // Seed revealed state so the panel stays visible until the user moves
      // away (grace period), preserving the on-screen experience.
      revealed = true;
      visibleHoldUntil = Date.now() + HIDE_GRACE_MS;
      startAutoHidePoll();
      syncSessionHud(latestSnapshot);
    } else {
      syncSessionHud(latestSnapshot);
    }
  }

  function syncAutoHidePollLifecycle() {
    if (isAutoHidePollingNeeded()) startAutoHidePoll();
    else stopAutoHidePoll();
  }

  function sendRingSnapshot(snapshot = latestSnapshot, side = ringSide) {
    if (!snapshot || !ringWindow || ringWindow.isDestroyed() || !ringDidFinishLoad) return;
    if (!ringWindow.webContents || ringWindow.webContents.isDestroyed()) return;
    ringWindow.webContents.send("quota-ring:snapshot", {
      accountQuota: Array.isArray(snapshot.accountQuota) ? snapshot.accountQuota : [],
      quotaAgentIcons: snapshot.quotaAgentIcons || {},
      displayMode: ctx.quotaRingDisplayMode === "remaining" ? "remaining" : "used",
      // The same list quota-ring-geometry.js used to size this window. Sent
      // rather than pre-filtered out of accountQuota so the renderer's own draw
      // rule stays the single place that decides whether a coin exists — and so
      // the two filters cannot drift into sizing for coins nobody draws.
      hiddenQuotaProviders: Array.isArray(ctx.quotaRingHiddenProviders)
        ? ctx.quotaRingHiddenProviders
        : [],
      side,
    });
  }

  // The quota ring window mirrors the panel block chrome (transparent,
  // non-focusable, always-on-top panel) — only the preload/page and the
  // snapshot channel differ.
  function ensureQuotaRing() {
    cancelHiddenDestroy("ring");
    if (ringWindow && !ringWindow.isDestroyed()) return ringWindow;
    if (!ctx.win || ctx.win.isDestroyed()) return null;

    ringDidFinishLoad = false;
    const scale = getTextScale();
    const provisional = ringGeom.constants;
    ringWindow = new BrowserWindow({
      parent: ctx.win,
      width: scaleHeight(provisional.COIN_SIZE + provisional.READOUT_W + 40, scale),
      height: scaleHeight(provisional.COIN_SIZE * 2 + 40, scale),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: !isMac,
      focusable: false,
      hasShadow: false,
      backgroundColor: "#00000000",
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-quota-ring.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    if (isWin) ringWindow.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(ringWindow);

    ringWindow.loadFile(path.join(__dirname, "quota-ring.html"));
    ringWindow.webContents.once("did-finish-load", () => {
      ringDidFinishLoad = true;
      applyZoomToWindow(ringWindow, getTextScale());
      sendI18n();
      // Correct the renderer's optimistic default before any snapshot lands:
      // the window is created hidden, and a flashback armed while nobody can
      // see it would be spent on an empty screen.
      sendRingVisibility(ringWindow.isVisible());
      syncSessionHud();
    });
    ringWindow.on("closed", () => {
      cancelHiddenDestroy("ring");
      ringWindow = null;
      ringDidFinishLoad = false;
    });

    return ringWindow;
  }

  // The renderer replays the rolling-window number when the cluster appears
  // after that number moved, so it needs the appear/disappear edges — which it
  // cannot observe itself (a hidden Electron window does not reliably flip
  // document.visibilityState, and a pinned cluster never hides).
  function sendRingVisibility(visible) {
    if (!ringWindow || ringWindow.isDestroyed() || !ringDidFinishLoad) return;
    if (!ringWindow.webContents || ringWindow.webContents.isDestroyed()) return;
    ringWindow.webContents.send("quota-ring:visibility", visible);
  }

  function hideQuotaRing() {
    if (ringWindow && !ringWindow.isDestroyed()) {
      // Only the notification is conditional. hide() stays unconditional and
      // idempotent: isVisible() can report false while the window is merely
      // occluded (app hidden on macOS, another Space, parent state), and
      // skipping the real hide there would let the system surface it again.
      if (ringWindow.isVisible()) sendRingVisibility(false);
      ringWindow.hide();
    }
    scheduleHiddenDestroy("ring");
  }

  function showQuotaRing(win) {
    if (!win || win.isDestroyed() || !ringDidFinishLoad) return;
    cancelHiddenDestroy("ring");
    if (!win.isVisible()) {
      win.showInactive();
      keepOutOfTaskbar(win);
      if (isMac) deferMacFloatingVisibility(ctx, win);
      else if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
      sendRingVisibility(true);
    }
  }

  function computeRingBounds(snapshot, scale = getTextScale(), avoidRects = []) {
    if (!ctx.win || ctx.win.isDestroyed()) return null;
    const coinCount = countQuotaCoins(snapshot, ctx.sessionHudShowQuota !== false, ctx.quotaRingHiddenProviders);
    if (coinCount <= 0) return null;
    const petBounds = typeof ctx.getPetWindowBounds === "function" ? ctx.getPetWindowBounds() : null;
    if (!petBounds) return null;
    const hitRect = typeof ctx.getHitRectScreen === "function" ? ctx.getHitRectScreen(petBounds) : null;
    const anchorRect = typeof ctx.getSessionHudAnchorRect === "function" ? ctx.getSessionHudAnchorRect(petBounds) : null;
    const cx = petBounds.x + petBounds.width / 2;
    const cy = petBounds.y + petBounds.height / 2;
    const workArea = typeof ctx.getNearestWorkArea === "function"
      ? ctx.getNearestWorkArea(cx, cy)
      : { x: 0, y: 0, width: 1280, height: 800 };
    return ringGeom.computeQuotaRingBounds({
      hitRect,
      anchorRect,
      workArea,
      coinCount,
      scale,
      avoidRects,
    });
  }

  // 面板窗口：session-hud.html 整块渲染（不带 query，渲染端总是画整张卡片）。
  function ensurePanel() {
    cancelHiddenDestroy("panel");
    if (panel.win && !panel.win.isDestroyed()) return panel.win;
    if (!ctx.win || ctx.win.isDestroyed()) return null;

    panel.loaded = false;
    const scale = getTextScale();
    const widthScale = getBlockWidthScale(scale);
    const sh = shellScaled(QUICK_SHELL, scale);
    // 刻意不设 parent：子窗口会继承宠物窗口的层级，输入框聚焦时「让出置顶」
    // 对它无效，中文输入法候选窗会被面板压住。权限气泡（输入法正常）也是
    // 独立窗口；面板靠 reapplyMacVisibility 自己维持层级与跨 Space。
    const win = new BrowserWindow({
      width: Math.round(QUICK_CARD.width * widthScale) + sh.left + sh.right,
      height: scaleHeight(QUICK_CARD.height, scale) + sh.top + sh.bottom,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: !isMac,
      // 输入框/下拉都要键盘焦点（点击激活是权限气泡同款先例）；
      // mac 上 acceptFirstMouse 让第一次点击就落到控件上。
      focusable: true,
      ...(isMac ? { acceptFirstMouse: true } : {}),
      hasShadow: false,
      backgroundColor: "#00000000",
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel" } : {}),
      webPreferences: {
        preload: path.join(__dirname, "preload-session-hud.js"),
        nodeIntegration: false,
        contextIsolation: true,
      },
    });
    panel.win = win;
    // 新窗口：穿透状态要重新应用一次（显示时默认穿透）。
    clickThrough = null;
    // 首次显示也要淡入：窗口从全透明开始（setOpacity 不可用的平台上是空操作）。
    try { win.setOpacity(0); } catch {}

    // mac：面板带文本输入，按权限气泡 #626 的先例处理——保 screen-saver 层级
    // + Electron 跨 Space，但不委托进 SkyLight 私有空间，中文输入法候选窗
    // 才浮得出来（见 topmost-runtime reapplyMacVisibility 的 __clawdMacTextInputBubble 分支）。
    if (isMac) win.__clawdMacTextInputBubble = true;

    if (isWin) win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof ctx.guardAlwaysOnTop === "function") ctx.guardAlwaysOnTop(win);

    win.loadFile(path.join(__dirname, "session-hud.html"));
    win.webContents.once("did-finish-load", () => {
      panel.loaded = true;
      // Explicit even though same-origin propagation usually covers it — a
      // stale partition-persisted factor must never win over prefs.
      applyZoomToWindow(win, getTextScale());
      sendI18n();
      lastQuickStateJson = null; // 新窗口要完整推一次快捷状态
      sendQuickState();
      syncSessionHud();
    });
    win.on("closed", () => {
      cancelHiddenDestroy("panel");
      cancelPanelFade();
      pendingHiddenBounds = null;
      clickThrough = null;
      panel.win = null;
      panel.loaded = false;
      // 渲染端随窗口一起没了，再也发不出 setHold(..., false)——残留的 hold
      // 会把之后所有点击面板永久钉住（低电量回收窗口后尤其明显）。
      holdReasons.clear();
      lastQuickStateJson = null;
      notifyGeometryChanged();
    });

    return win;
  }

  // ── 淡入淡出（整窗透明度）──
  // setOpacity 在 macOS/Windows 可用，Linux 上是空操作；getOpacity 失败时
  // 视为 1（不淡入直接显示），所以每个调用点都兜着 try/catch。
  function setPanelOpacity(win, value) {
    if (!win || win.isDestroyed()) return;
    try { win.setOpacity(value); } catch {}
  }

  function readPanelOpacity(win) {
    try { return win.getOpacity(); } catch { return 1; }
  }

  function cancelPanelFade() {
    if (panelOpacityTimer) {
      clearInterval(panelOpacityTimer);
      panelOpacityTimer = null;
    }
  }

  // 淡入：从当前不透明度几帧推到 1。中途被打断的淡出会从中间值接着淡回来。
  function fadePanelIn(win) {
    cancelPanelFade();
    if (!win || win.isDestroyed()) return;
    const from = readPanelOpacity(win);
    if (!(from < 1)) {
      setPanelOpacity(win, 1);
      return;
    }
    const stepMs = Math.max(1, Math.round(PANEL_FADE_MS / PANEL_FADE_STEPS));
    let i = 0;
    panelOpacityTimer = setInterval(() => {
      i += 1;
      const done = i >= PANEL_FADE_STEPS;
      setPanelOpacity(win, done ? 1 : from + (1 - from) * (i / PANEL_FADE_STEPS));
      if (done) {
        clearInterval(panelOpacityTimer);
        panelOpacityTimer = null;
      }
    }, stepMs);
  }

  // 淡出：几帧推到 0，之后才真正 hide()——窗口先没了就看不到渐变。
  function fadePanelOut(win, onHidden) {
    cancelPanelFade();
    if (!win || win.isDestroyed()) {
      onHidden();
      return;
    }
    const from = readPanelOpacity(win);
    const stepMs = Math.max(1, Math.round(PANEL_FADE_MS / PANEL_FADE_STEPS));
    let i = 0;
    panelOpacityTimer = setInterval(() => {
      i += 1;
      const done = i >= PANEL_FADE_STEPS;
      setPanelOpacity(win, done ? 0 : from * (1 - i / PANEL_FADE_STEPS));
      if (done) {
        clearInterval(panelOpacityTimer);
        panelOpacityTimer = null;
        onHidden();
      }
    }, stepMs);
  }

  // 窗口尺寸变更：变大立即生效（多出来的区域是透明的，卡片慢慢长进去，
  // 画面本来就在动、看不出来）；变小只记不缩——等窗口隐藏时再应用
  // （见 hidePanel / applyPendingHiddenBounds）。macOS 合成器在「画面静止
  // + 窗口缩小」的瞬间偶发亮出一帧错位画面，就是用户看到的闪。
  function applyPanelBounds(win, bounds) {
    const current = readPanelBounds(win);
    const shrinks = !!current && bounds.height < current.height;
    if (!shrinks) {
      pendingHiddenBounds = null;
      win.setBounds(bounds);
      return;
    }
    // 窗口不可见时直接应用：尺寸变化无迹可寻（比如菜单开着时被动作收起，
    // 下次显示前先在这里缩到位，免得带着多余透明区露出来挡点击）。
    const visible = typeof win.isVisible === "function" && win.isVisible();
    if (!visible) {
      pendingHiddenBounds = null;
      win.setBounds(bounds);
      return;
    }
    // 可见时只记不缩：始终保存最新的收起布局（期间宠物移动会更新这份目标）。
    pendingHiddenBounds = bounds;
  }

  function readPanelBounds(win) {
    if (!win || win.isDestroyed() || typeof win.getBounds !== "function") return null;
    try {
      return win.getBounds();
    } catch {
      return null;
    }
  }

  // 隐藏时应用待命缩窗：窗口已不可见，尺寸变化不会有任何视觉痕迹。
  function applyPendingHiddenBounds() {
    const target = pendingHiddenBounds;
    pendingHiddenBounds = null;
    const win = panel.win;
    if (!target || !win || win.isDestroyed()) return;
    win.setBounds(target);
  }


  // 透明区穿透开关。渲染端在指针进出卡片时用 mousemove 快速上报，主进程
  // 的自动收起轮询也会同步一次兜底（避免漏掉一次移动导致点击被吃掉）。
  function setClickThrough(through) {
    const next = through === true;
    if (next === clickThrough) return;
    const win = panel.win;
    if (!win || win.isDestroyed()) return;
    clickThrough = next;
    try {
      if (next) win.setIgnoreMouseEvents(true, { forward: true });
      else win.setIgnoreMouseEvents(false);
    } catch {}
  }

  function showPanel() {
    const win = panel.win;
    if (!win || win.isDestroyed() || !panel.loaded) return;
    cancelHiddenDestroy("panel");
    if (!win.isVisible()) {
      // 只在状态未知时默认穿透（新窗口 / 首次显示）。已知值不覆盖：
      // 同一轮 sync 里轮询已经按真实光标位置算过一次了。
      if (clickThrough === null) setClickThrough(true);
      win.showInactive();
      keepOutOfTaskbar(win);
      if (isMac) deferMacFloatingVisibility(ctx, win);
      else if (typeof ctx.reapplyMacVisibility === "function") ctx.reapplyMacVisibility();
    }
    fadePanelIn(win);
  }

  function hidePanel() {
    // 面板一收，会话列表必须跟着复位：下次点桌宠应是收起态。否则窗口按
    // 收起高度算、渲染端还画着展开卡片，内容会被裁掉。
    if (sessionListOpen) {
      sessionListOpen = false;
      holdReasons.delete("menu");
      if (typeof ctx.onQuickStateChanged === "function") ctx.onQuickStateChanged();
    }
    const win = panel.win;
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) {
      // 已经不可见：待命缩窗也无法被看见，直接应用。
      applyPendingHiddenBounds();
      scheduleHiddenDestroy("panel");
      return;
    }
    fadePanelOut(win, () => {
      const current = panel.win;
      if (!current || current.isDestroyed()) return;
      current.hide();
      // 隐藏后应用待命缩窗：收起菜单后窗口一直保持展开尺寸，就等这一刻。
      applyPendingHiddenBounds();
      scheduleHiddenDestroy("panel");
      // 淡出期间窗口还占着避让矩形，真正隐藏后再通知气泡重排一次。
      notifyGeometryChanged();
    });
  }

  // 面板显示/隐藏/移动都会改变气泡要避让的占位：变更后通知气泡重排。
  function notifyGeometryChanged() {
    let anyVisible = false;
    const panelWin = panel.win;
    if (panelWin && !panelWin.isDestroyed() && panelWin.isVisible()) anyVisible = true;
    if (ringWindow && !ringWindow.isDestroyed() && ringWindow.isVisible()) anyVisible = true;
    if (anyVisible === lastAnyVisible) return;
    lastAnyVisible = anyVisible;
    if (typeof ctx.onReservedOffsetChange === "function") ctx.onReservedOffsetChange();
  }

  // 会话列表展开/收起：主进程是唯一状态源（渲染端只投影），因为窗口高度要
  // 跟着变——渲染端自己做状态会跟窗口尺寸脱节。
  function setSessionListOpen(open) {
    const next = open === true;
    if (next === sessionListOpen) return;
    sessionListOpen = next;
    if (next) holdReasons.add("menu");
    else holdReasons.delete("menu");
    syncSessionHud(latestSnapshot || getCurrentSnapshot(), {});
    if (typeof ctx.onQuickStateChanged === "function") ctx.onQuickStateChanged();
  }

  function isSessionListOpen() {
    return sessionListOpen;
  }

  // 输入框上挂了几个附件（渲染端持有附件本身，只把这个数字报上来）。
  // 数字一变就得同步一次窗口几何，否则多出来的标签行会被窗口裁掉、点不到。
  function setAttachments(count) {
    const next = Number.isFinite(count) ? Math.min(Math.max(Math.floor(count), 0), 8) : 0;
    if (next === attachmentCount) return;
    attachmentCount = next;
    syncSessionHud(latestSnapshot || getCurrentSnapshot(), {});
    if (typeof ctx.onQuickStateChanged === "function") ctx.onQuickStateChanged();
  }

  function getAttachmentCount() {
    return attachmentCount;
  }

  // 回复窗口跟随时的高度（0 = 没开窗口、或不在跟随模式）。面板据此给整条让位：
  // 卡片整体下移「回复窗口高度 / 2」，让「窗口 + 卡片」这条竖条以桌宠为中心。
  function getAttachedReplyHeight() {
    if (typeof ctx.getAttachedReplyHeight !== "function") return 0;
    try {
      const height = Number(ctx.getAttachedReplyHeight());
      return Number.isFinite(height) && height > 0 ? height : 0;
    } catch {
      return 0;
    }
  }

  // 回复窗口自己的屏幕矩形（跟随模式下和面板是同一条）；没开窗口时 null。
  function getAttachedReplyRect() {
    if (typeof ctx.getAttachedReplyRect !== "function") return null;
    try {
      const rect = ctx.getAttachedReplyRect();
      if (
        rect
        && Number.isFinite(rect.x)
        && Number.isFinite(rect.y)
        && Number.isFinite(rect.width)
        && rect.width > 0
        && Number.isFinite(rect.height)
        && rect.height > 0
      ) {
        return rect;
      }
    } catch {}
    return null;
  }

  // 回复窗口的定位基准：面板「收起态卡片」的屏幕矩形。
  // 与面板当前是否可见无关（收起只是把窗口藏起来，位置照旧），也不随展开菜单
  // 变化——展开的菜单会临时盖住上面的回复窗口，卡片收起态的底边才是那条固定的线。
  function getPanelCardRect() {
    const layout = computeExpectedLayout();
    const content = layout && layout.panel && layout.panel.contentBounds;
    if (!content) return null;
    const cardHeight = Math.ceil(QUICK_CARD.height * getTextScale());
    return {
      x: content.x,
      y: Math.round(content.y + content.height - cardHeight),
      width: content.width,
      height: cardHeight,
    };
  }

  // 可见面板的窗口矩形（供气泡避让读取；main 侧 getVisibleSessionHudBounds）。
  function getBlockRects() {
    const rects = [];
    const win = panel.win;
    if (win && !win.isDestroyed() && win.isVisible() && typeof win.getBounds === "function") {
      try {
        const bounds = win.getBounds();
        if (bounds && Number.isFinite(bounds.width) && bounds.width > 0) rects.push(bounds);
      } catch {}
    }
    return rects;
  }

  function syncQuotaRing(snapshot, scale, blockContentBounds, options = {}) {
    const ring = shouldShow(snapshot)
      ? computeRingBounds(snapshot, scale, collectRingAvoidRects(blockContentBounds))
      : null;
    if (!ring) {
      hideQuotaRing();
      return;
    }
    const rwin = ensureQuotaRing();
    if (!rwin || rwin.isDestroyed()) return;
    applyZoomToWindow(rwin, scale);
    rwin.setBounds(ring.bounds);
    // Send the side whenever it flips (edge crossing) even on a
    // reposition-only sync, or the renderer keeps the stale layout.
    const sideChanged = ring.side !== ringSide;
    ringSide = ring.side;
    if (options.sendRingSnapshot !== false || sideChanged) sendRingSnapshot(snapshot, ring.side);
    showQuotaRing(rwin);
  }

  function syncSessionHud(snapshot = latestSnapshot || getCurrentSnapshot(), options = {}) {
    latestSnapshot = snapshot;
    // Defend against stale reveal: if base eligibility dropped, clear any
    // leftover revealed so a future eligible state does not pop the UI
    // without a fresh user click.
    if (!baseEligible(snapshot)) {
      clearReveal();
    }
    syncAutoHidePollLifecycle();

    const show = shouldShow(snapshot);
    const panelAllowed = ctx.sessionHudEnabled !== false;
    // Resolve the scale ONCE per sync and feed the same value to the panel and
    // the bounds math — separate reads could disagree mid-display-crossing.
    const scale = getTextScale();

    // ── 面板（整块）──
    const layout = show && panelAllowed ? computeExpectedLayout(scale) : null;
    if (!layout || !layout.panel) {
      hidePanel();
    } else {
      const win = ensurePanel();
      if (win && !win.isDestroyed()) {
        applyZoomToWindow(win, scale);
        applyPanelBounds(win, layout.panel.bounds);
        showPanel();
      }
    }

    // ── Quota ring (quota only; attached beside the pet) ──
    syncQuotaRing(snapshot, scale, layout && layout.panel ? [layout.panel.contentBounds] : [], options);

    notifyGeometryChanged();
  }

  function broadcastSessionSnapshot(snapshot) {
    syncSessionHud(snapshot);
  }

  function repositionSessionHud() {
    syncSessionHud(latestSnapshot || getCurrentSnapshot(), { sendRingSnapshot: false });
  }

  function repositionQuotaRing() {
    const snapshot = latestSnapshot || getCurrentSnapshot();
    const scale = getTextScale();
    const layout = shouldShow(snapshot) && ctx.sessionHudEnabled !== false
      ? computeExpectedLayout(scale)
      : null;
    syncQuotaRing(snapshot, scale, layout && layout.panel ? [layout.panel.contentBounds] : [], { sendRingSnapshot: false });
  }

  // 历史 API：气泡的「HUD 下方预留」已废除（块在桌宠两侧，气泡改走避让矩形）。
  function getHudReservedOffset() {
    return 0;
  }

  function cleanup() {
    stopAutoHidePoll();
    cancelHiddenDestroy();
    cancelPanelFade();
    pendingHiddenBounds = null;
    clickThrough = null;
    sessionListOpen = false;
    attachmentCount = 0;
    holdReasons.delete("menu");
    const win = panel.win;
    if (win && !win.isDestroyed()) win.destroy();
    panel.win = null;
    panel.loaded = false;
    if (ringWindow && !ringWindow.isDestroyed()) ringWindow.destroy();
    ringWindow = null;
    ringDidFinishLoad = false;
  }

  return {
    broadcastSessionSnapshot,
    repositionSessionHud,
    repositionQuotaRing,
    syncSessionHud,
    sendI18n,
    getHudReservedOffset,
    getBlockRects,
    getPanelCardRect,
    setSessionListOpen,
    isSessionListOpen,
    setAttachments,
    getAttachmentCount,
    noteReplyWindowStateChanged,
    cleanup,
    getWindow: () => panel.win,
    // 面板窗口给 topmost-runtime 做 mac 层级/跨 Space 处理（数组形状保持兼容）。
    getWindows: () => {
      const win = panel.win;
      return win && !win.isDestroyed() ? [win] : [];
    },
    getQuotaRingWindow: () => ringWindow,
    // 点击揭示状态机
    revealFromPet,
    handlePinnedChanged,
    clearReveal,
    // 快捷输入面板 API
    dismissForAction,
    setHold,
    setClickThrough,
    pushQuickState,
    isPanelOpen,
  };
};

module.exports.__test = {
  QUICK_CARD,
  QUICK_CARD_EXPANDED,
  QUICK_ATTACH_ROW,
  QUICK_ATTACH_EXTRA,
  quickCardHeight,
  QUICK_SHELL,
  computeBlockBounds,
  evaluateBaseEligible,
  evaluateShouldShow,
  countQuotaCoins,
  getBlockWidthScale,
  rectsIntersect,
  pointInExpandedRect,
  computeAutoHideHotZone,
  pointInHotZone,
  constants: {
    BLOCK_PET_GAP,
    BLOCK_WIDTH_GROWTH_RATIO,
    EDGE_MARGIN,
    HOT_ZONE_PAD,
    AUTO_HIDE_POLL_MS,
    HIDE_GRACE_MS,
    HIDDEN_WINDOW_DESTROY_MS,
  },
};
