"use strict";

// 「与 Claude 对话」窗口运行时：只负责窗口生命周期、位置尺寸持久化与文字缩放。
// 页面内容（chat.html + chat-renderer.js）通过 preload-chat.js 暴露的 window.chatAPI
// 与主进程通信；会话状态、IPC 注册在 chat-ipc.js / chat-session-runtime.js，
// 本模块不感知任何会话内容。
//
// 生命周期回调约定（由 main.js 注入）：
// - getSavedBounds()/onSaveBounds(bounds)：读写 prefs 的 chatWindowBounds
// - getNearestWorkArea(x, y)/getTextScale(bounds)：与 settings 窗口共用注入风格
// - getTitle()：窗口标题（i18n chatWindowTitle），缺失时用兜底英文标题
// - onDidFinishLoad(win)：页面每次加载完成（含刷新）后调用，供 IPC 层首推状态快照
// - onAfterClosed()：窗口关闭后调用；main.js 在这里停止当前会话
// - onRendererReset()：渲染进程崩溃或主 frame 重新导航时调用（可选）
//
// 定位（阶段二）注入，全部可缺省（缺省时不跟随、位置退回工作区居中）：
// - getPetBounds()：桌宠窗口矩形（跟随的基准）
// - getAnchorRect()：桌宠的可视锚点矩形（比窗口矩形更贴合画面，优先用它）
// - getPrimaryWorkArea()：主显示器工作区（固定角落模式用）
// - getPositionMode()/getFixedCorner()：设置里的定位模式与所选角落
// - isAppQuitting()：应用正在退出时不放淡出动画，绝不挡住退出

const defaultPath = require("path");

const {
  DEFAULT_EDGE_MARGIN,
  computeChatWindowBounds,
  computeAttachedChatBounds,
  normalizeChatPositionMode,
  normalizeChatFixedCorner,
  chatBoundsDiffer,
} = require("./chat-window-placement");
const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");

// 回复窗口 =「瘦高」的一条（300 × 680，接近微信聊天窗的比例），跟随时与快捷
// 面板同宽同列、上下紧贴。旧版本存下来的宽扁尺寸由 prefs 的 v20→v21 迁移清掉。
const DEFAULT_WIDTH = 300;
const DEFAULT_HEIGHT = 680;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 320;
const READY_TO_SHOW_FALLBACK_MS = 2000;
const FRONT_LIFT_MS = 200;
const BOUNDS_SAVE_DEBOUNCE_MS = 500;
const MOVE_TEXT_SCALE_DEBOUNCE_MS = 350;
const FALLBACK_WORK_AREA = { x: 0, y: 0, width: 1280, height: 800 };
// 跟随：位置死区（小于这个位移不动窗口，省掉纯取整带来的无意义 setBounds）。
// 刻意不做节流——桌宠是逐帧移动的，窗口必须同一帧跟上才「黏」得平滑；
// 攒几帧再搬会变成一跳一跳。
const FOLLOW_MIN_DELTA_PX = 1;
// 程序化跟随移动的识别：move 事件里位置与刚设下去的值对得上（容差内、时限内）
// 就是我们自己搬的，既不算「用户拖动」也不落盘。
const PROGRAMMATIC_MOVE_TOLERANCE_PX = 2;
const PROGRAMMATIC_MOVE_GRACE_MS = 300;
// 开窗淡入 / 关窗淡出（照快捷面板的做法：setOpacity 分步推）。
const WINDOW_FADE_MS = 140;
const WINDOW_FADE_STEPS = 6;
// getTitle() 未注入或抛错时的兜底标题（正式标题来自 i18n 的 chatWindowTitle）。
const CHAT_WINDOW_TITLE = "Clawd Chat";

function requiredDependency(value, name) {
  if (!value) throw new Error(`createChatWindowRuntime requires ${name}`);
  return value;
}

function isUsableBounds(bounds) {
  return !!bounds
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.width > 0
    && bounds.height > 0;
}

function normalizeWorkArea(workArea) {
  return isUsableBounds(workArea) ? workArea : FALLBACK_WORK_AREA;
}

function clampBoundsToWorkArea(bounds, workArea) {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const minX = workArea.x;
  const minY = workArea.y;
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;
  return {
    x: Math.round(Math.min(Math.max(bounds.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(bounds.y, minY), maxY)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function roundedBounds(bounds) {
  if (!isUsableBounds(bounds)) return null;
  const normalized = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
  return isUsableBounds(normalized) ? normalized : null;
}

function sameBounds(a, b) {
  return !!a
    && !!b
    && a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height;
}

function createChatWindowRuntime(options = {}) {
  requiredDependency(options.app, "app");
  const BrowserWindow = requiredDependency(options.BrowserWindow, "BrowserWindow");
  const nativeTheme = requiredDependency(options.nativeTheme, "nativeTheme");
  const path = options.path || defaultPath;
  const platform = options.platform || process.platform;
  const isWin = options.isWin != null ? !!options.isWin : platform === "win32";
  const isMac = options.isMac != null ? !!options.isMac : platform === "darwin";
  const chatHtmlPath = options.chatHtmlPath || path.join(__dirname, "chat.html");
  const preloadPath = options.preloadPath || path.join(__dirname, "preload-chat.js");
  const scheduleLater = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearScheduled = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const now = typeof options.now === "function" ? options.now : Date.now;

  let chatWindow = null;
  let readyToShowFallbackTimer = null;
  let liftTimer = null;
  let saveBoundsTimer = null;
  let moveTextScaleTimer = null;
  let lastSavedBounds = null;
  // 「用户手动拖过窗口，本轮暂时不跟随」的内存标记（重开窗口或重选设置时恢复）。
  let followSuspended = false;
  let programmaticMove = null;
  // 上一次注入的缩放值：程序化跟随跨屏时用来判断「要不要重注入」。
  let lastAppliedScale = null;
  // 窗口还没造出来时，先把「将要多高」告诉面板，好让它一次就让好位（见 open()）。
  let attachedHeightHint = 0;
  // 淡入淡出与关窗拦截（见 fadeWindowTo / close 事件）。
  let fadeTimer = null;
  let closeFadeInFlight = false;
  // open() 可能在窗口创建过程中被再次触发（例如菜单连点）：保存待执行的显示函数，
  // 让重复 open 也走「就绪后聚焦」而不是新建第二个窗口。
  let showPendingWindow = null;

  function getWindow() {
    return chatWindow;
  }

  function isLiveWindow(win) {
    return !!win && (typeof win.isDestroyed !== "function" || !win.isDestroyed());
  }

  function scheduleTimer(callback, delayMs) {
    const timer = scheduleLater(callback, delayMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function clearReadyToShowFallbackTimer() {
    if (!readyToShowFallbackTimer) return;
    clearScheduled(readyToShowFallbackTimer);
    readyToShowFallbackTimer = null;
  }

  function clearLiftTimer() {
    if (!liftTimer) return;
    clearScheduled(liftTimer);
    liftTimer = null;
  }

  function clearSaveBoundsTimer() {
    if (!saveBoundsTimer) return;
    clearScheduled(saveBoundsTimer);
    saveBoundsTimer = null;
  }

  function clearMoveTextScaleTimer() {
    if (!moveTextScaleTimer) return;
    clearScheduled(moveTextScaleTimer);
    moveTextScaleTimer = null;
  }

  function getTextScale(bounds = null) {
    return clampTextScale(typeof options.getTextScale === "function" ? options.getTextScale(bounds) : 1);
  }

  function getTitle() {
    if (typeof options.getTitle !== "function") return CHAT_WINDOW_TITLE;
    try {
      const title = options.getTitle();
      return typeof title === "string" && title ? title : CHAT_WINDOW_TITLE;
    } catch {
      return CHAT_WINDOW_TITLE;
    }
  }

  function applyTitleToWindow() {
    const win = getWindow();
    if (!isLiveWindow(win) || typeof win.setTitle !== "function") return;
    win.setTitle(getTitle());
  }

  // ── 定位（跟随桌宠 / 固定角落）──

  function readPositionMode() {
    if (typeof options.getPositionMode !== "function") return "follow";
    try {
      return normalizeChatPositionMode(options.getPositionMode());
    } catch {
      return "follow";
    }
  }

  function readFixedCorner() {
    if (typeof options.getFixedCorner !== "function") return "bottom-right";
    try {
      return normalizeChatFixedCorner(options.getFixedCorner());
    } catch {
      return "bottom-right";
    }
  }

  function readPetBounds() {
    if (typeof options.getPetBounds !== "function") return null;
    try {
      return roundedBounds(options.getPetBounds());
    } catch {
      return null;
    }
  }

  // 锚点矩形（桌宠画面本体）比窗口矩形更贴合，优先用它；拿不到就退回窗口矩形。
  function readAnchorRect() {
    if (typeof options.getAnchorRect !== "function") return null;
    try {
      const rect = options.getAnchorRect();
      if (
        rect
        && Number.isFinite(rect.left)
        && Number.isFinite(rect.top)
        && Number.isFinite(rect.right)
        && Number.isFinite(rect.bottom)
        && rect.right > rect.left
        && rect.bottom > rect.top
      ) {
        return rect;
      }
    } catch {}
    return null;
  }

  function readPrimaryWorkArea() {
    if (typeof options.getPrimaryWorkArea !== "function") return null;
    try {
      return options.getPrimaryWorkArea();
    } catch {
      return null;
    }
  }

  // 跟随模式的工作区取桌宠所在显示器；角落模式固定主显示器。都拿不到时退回
  // 一个「离参考点最近的工作区」（多显示器接拔过程中的兜底）。
  function resolveWorkArea(mode, petBounds, cx, cy) {
    if (mode === "corner") {
      const primary = normalizeWorkArea(readPrimaryWorkArea());
      if (primary !== FALLBACK_WORK_AREA) return primary;
    }
    if (typeof options.getNearestWorkArea === "function") {
      try {
        return normalizeWorkArea(options.getNearestWorkArea(cx, cy));
      } catch {}
    }
    return FALLBACK_WORK_AREA;
  }

  // 面板「收起态卡片」的屏幕矩形：跟随模式下回复窗口贴着它摆（见 isAttachedMode）。
  function readPanelCardRect() {
    if (typeof options.getPanelCardRect !== "function") return null;
    try {
      const rect = options.getPanelCardRect();
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

  // 「一条」版式只在跟随模式成立，而且要拿得到面板卡片的位置。
  function isAttachedMode(mode, panelCard) {
    return mode === "follow" && !!panelCard;
  }

  function computePlacedBounds({ width, height, mode, petBounds, workArea, panelCard }) {
    if (isAttachedMode(mode, panelCard)) {
      return computeAttachedChatBounds({ panelCard, workArea, width, height });
    }
    return computeChatWindowBounds({
      mode,
      corner: readFixedCorner(),
      petRect: petBounds,
      anchorRect: readAnchorRect(),
      workArea,
      width,
      height,
    });
  }

  // 尺寸：沿用用户上次调出来的，只在低于最小尺寸 / 超过工作区时修正。
  // 「一条」版式下高度还得给下面的面板卡片让出位置，否则整条装不下屏幕。
  function computeInitialSize(savedBounds, workArea, panelCard) {
    const scale = getTextScale(workArea);
    const minWidth = scaleWidth(MIN_WIDTH, scale);
    const minHeight = scaleHeight(MIN_HEIGHT, scale);
    const available = panelCard
      ? Math.max(minHeight, workArea.height - panelCard.height - 2 * DEFAULT_EDGE_MARGIN)
      : workArea.height;
    return {
      width: Math.round(Math.min(
        Math.max(savedBounds ? savedBounds.width : scaleWidth(DEFAULT_WIDTH, scale), minWidth),
        Math.max(1, workArea.width),
      )),
      height: Math.round(Math.min(
        Math.max(savedBounds ? savedBounds.height : scaleHeight(DEFAULT_HEIGHT, scale), minHeight),
        Math.max(1, available),
      )),
    };
  }

  function readSavedBounds() {
    if (typeof options.getSavedBounds !== "function") return null;
    try {
      return roundedBounds(options.getSavedBounds());
    } catch {
      return null;
    }
  }

  function computeInitialBounds(size, mode, petBounds, workArea) {
    const { width, height } = size;

    const placed = computePlacedBounds({
      width,
      height,
      mode,
      petBounds,
      workArea,
      panelCard: readPanelCardRect(),
    });
    if (placed) return { x: placed.x, y: placed.y, width: placed.width, height: placed.height };
    return clampBoundsToWorkArea({
      x: workArea.x + (workArea.width - width) / 2,
      y: workArea.y + (workArea.height - height) / 2,
      width,
      height,
    }, workArea);
  }

  // 「一条」版式生效时回复窗口的高度（面板据此整体让位）；不生效时 0。
  // 窗口还没造出来时用的是 attachedHeightHint，保证面板在你看到窗口前就摆好了。
  function getAttachedStackHeight() {
    if (readPositionMode() !== "follow") return 0;
    const win = getWindow();
    if (!isLiveWindow(win)) return attachedHeightHint;
    const bounds = getNormalWindowBounds(win);
    return bounds ? bounds.height : attachedHeightHint;
  }

  // 自动消失：显示 / 隐藏窗口本体（**不**关窗、不结束会话）。和快捷面板同一套
  // 节奏——指针离开 + 宽限后消失，点桌宠再一起回来。
  // 显示时用 showInactive + moveTop：抬到最前但不抢键盘焦点（面板的输入框正在
  // 用，不能被顶掉）；隐藏前若已在隐藏则什么都不做。
  function setRevealed(visible) {
    const win = getWindow();
    if (!isLiveWindow(win)) return false;
    const shown = typeof win.isVisible === "function" ? win.isVisible() : true;
    if (visible === true) {
      if (shown) return false;
      // 藏着的这段时间桌宠可能已经走远了：露出来之前先按当前位置摆好，避免闪现一下。
      applyPlacement(true);
      try {
        if (typeof win.showInactive === "function") win.showInactive();
        else if (typeof win.show === "function") win.show();
        if (typeof win.moveTop === "function") win.moveTop();
      } catch {
        return false;
      }
      fadeWindowTo(win, 1, null);
      return true;
    }
    if (!shown) return false;
    fadeWindowTo(win, 0, () => {
      if (!isLiveWindow(win)) return;
      try { win.hide(); } catch {}
    });
    return true;
  }

  function notifyWindowStateChanged() {
    if (typeof options.onReplyWindowStateChanged !== "function") return;
    try {
      options.onReplyWindowStateChanged();
    } catch (err) {
      console.warn("Clawd: reply window state callback failed:", err && err.message);
    }
  }

  // 跟随可能把窗口搬到另一块屏幕（各屏缩放不同）：只有缩放值真的变了才重新
  // 注入一次 zoom，跟随时每 120ms 走一遍也不会反复写 CSS。
  function syncTextScaleAfterMove(bounds) {
    const scale = getTextScale(bounds);
    if (scale === lastAppliedScale) return;
    lastAppliedScale = scale;
    applyTextScale();
  }

  // 把窗口搬到「此刻应该在的位置」。返回是否真的动了。
  // - ignoreThreshold=true：无视死区/模式限制，立即按当前设置重排（设置变更、
  //   页面就绪后补一次都用它）；false：跟随桌宠的常规路径，带死区与可见性判断。
  function applyPlacement(ignoreThreshold) {
    const win = getWindow();
    if (!isLiveWindow(win) || typeof win.setBounds !== "function") return false;
    if (!ignoreThreshold) {
      if (followSuspended || readPositionMode() !== "follow") return false;
      if (typeof win.isVisible === "function" && !win.isVisible()) return false;
      if (typeof win.isMinimized === "function" && win.isMinimized()) return false;
    }
    const current = getNormalWindowBounds(win);
    if (!current) return false;
    const mode = readPositionMode();
    const petBounds = readPetBounds();
    const workArea = resolveWorkArea(
      mode,
      petBounds,
      petBounds ? petBounds.x + petBounds.width / 2 : current.x + current.width / 2,
      petBounds ? petBounds.y + petBounds.height / 2 : current.y + current.height / 2,
    );
    const placed = computePlacedBounds({
      width: current.width,
      height: current.height,
      mode,
      petBounds,
      workArea,
      panelCard: readPanelCardRect(),
    });
    if (!placed) return false;
    const desired = { x: placed.x, y: placed.y, width: current.width, height: current.height };
    if (sameBounds(current, desired)) return false;
    if (!ignoreThreshold && !chatBoundsDiffer(current, desired, FOLLOW_MIN_DELTA_PX)) return false;
    programmaticMove = { x: desired.x, y: desired.y, expiresAt: now() + PROGRAMMATIC_MOVE_GRACE_MS };
    try {
      // 只搬不缩：不传宽高，既不触发 resize 也不把尺寸写回 prefs。
      win.setBounds({ x: desired.x, y: desired.y });
      syncTextScaleAfterMove(desired);
      return true;
    } catch {
      programmaticMove = null;
      return false;
    }
  }

  // 跟随入口：桌宠漫步/被拖动时每帧都会调到这里，就地算一次、同一帧跟上，
  // 不做节流（攒帧会变成一跳一跳）。窗口没开、不在跟随模式、用户拖过窗口、
  // 位移在死区内时，一路直接返回，开销只有几次矩形读取。
  function reposition(repositionOptions = {}) {
    if (repositionOptions && repositionOptions.force === true) {
      // 设置里改了定位模式/角落：恢复跟随（用户之前的拖动不再算数）并立即重排。
      followSuspended = false;
      return applyPlacement(true);
    }
    // 用户手动拖过窗口：本轮不再跟随，直到窗口重开或重选设置。
    if (followSuspended) return false;
    if (readPositionMode() !== "follow") return false;
    if (!isLiveWindow(getWindow())) return false;
    return applyPlacement(false);
  }

  // ── 淡入淡出（整窗透明度）──
  // setOpacity 在 macOS/Windows 可用，Linux 上是空操作；getOpacity 失败时
  // 视为已到位，于是淡入直接显示、淡出立即关窗（不会白等一截）。
  function setWindowOpacity(win, value) {
    if (!win || win.isDestroyed()) return;
    try { win.setOpacity(value); } catch {}
  }

  function readWindowOpacity(win) {
    try { return win.getOpacity(); } catch { return null; }
  }

  function cancelFade() {
    if (!fadeTimer) return;
    clearScheduled(fadeTimer);
    fadeTimer = null;
  }

  function fadeWindowTo(win, target, onDone) {
    cancelFade();
    const finish = typeof onDone === "function" ? onDone : null;
    if (!isLiveWindow(win)) {
      if (finish) finish();
      return;
    }
    const from = readWindowOpacity(win);
    if (from === null || Math.abs(from - target) < 0.001) {
      setWindowOpacity(win, target);
      if (finish) finish();
      return;
    }
    const stepMs = Math.max(1, Math.round(WINDOW_FADE_MS / WINDOW_FADE_STEPS));
    let step = 0;
    const tick = () => {
      fadeTimer = null;
      if (!isLiveWindow(win)) {
        if (finish) finish();
        return;
      }
      step += 1;
      const done = step >= WINDOW_FADE_STEPS;
      setWindowOpacity(win, done ? target : from + (target - from) * (step / WINDOW_FADE_STEPS));
      if (done) {
        if (finish) finish();
        return;
      }
      fadeTimer = scheduleTimer(tick, stepMs);
    };
    fadeTimer = scheduleTimer(tick, stepMs);
  }

  // 程序化跟随移动会在 move 事件里露一帧：位置对得上（容差内、时限内）就认领，
  // 既不当成用户拖动，也不把跟随位置写回 prefs。
  function consumeProgrammaticMove(win) {
    if (!programmaticMove) return false;
    if (now() > programmaticMove.expiresAt) {
      programmaticMove = null;
      return false;
    }
    const bounds = getNormalWindowBounds(win);
    if (!bounds) return false;
    return Math.abs(bounds.x - programmaticMove.x) <= PROGRAMMATIC_MOVE_TOLERANCE_PX
      && Math.abs(bounds.y - programmaticMove.y) <= PROGRAMMATIC_MOVE_TOLERANCE_PX;
  }

  function shouldFadeOnClose() {
    if (typeof options.isAppQuitting !== "function") return true;
    try {
      return options.isAppQuitting() !== true;
    } catch {
      return true;
    }
  }

  function getNormalWindowBounds(win) {
    if (!isLiveWindow(win)) return null;
    try {
      if (typeof win.getNormalBounds === "function") {
        const bounds = roundedBounds(win.getNormalBounds());
        if (bounds) return bounds;
      }
    } catch {}
    try {
      return typeof win.getBounds === "function" ? roundedBounds(win.getBounds()) : null;
    } catch {
      return null;
    }
  }

  function persistWindowBoundsNow(win) {
    clearSaveBoundsTimer();
    if (typeof options.onSaveBounds !== "function") return false;
    const bounds = getNormalWindowBounds(win);
    if (!bounds || sameBounds(bounds, lastSavedBounds)) return false;
    try {
      const result = options.onSaveBounds(bounds);
      if (result && typeof result.then === "function") {
        const attemptedBounds = bounds;
        Promise.resolve(result).then(
          (response) => {
            if (!response || response.status !== "error") return;
            if (sameBounds(lastSavedBounds, attemptedBounds)) lastSavedBounds = null;
            console.warn("Clawd: failed to persist Chat window bounds:", response.message);
          },
          (err) => {
            if (sameBounds(lastSavedBounds, attemptedBounds)) lastSavedBounds = null;
            console.warn("Clawd: failed to persist Chat window bounds:", err && err.message);
          },
        );
      } else if (result && result.status === "error") {
        console.warn("Clawd: failed to persist Chat window bounds:", result.message);
        return false;
      }
      lastSavedBounds = bounds;
      return true;
    } catch (err) {
      console.warn("Clawd: failed to persist Chat window bounds:", err && err.message);
      return false;
    }
  }

  function scheduleWindowBoundsSave(win) {
    if (typeof options.onSaveBounds !== "function") return;
    clearSaveBoundsTimer();
    saveBoundsTimer = scheduleTimer(() => {
      saveBoundsTimer = null;
      persistWindowBoundsNow(win);
    }, BOUNDS_SAVE_DEBOUNCE_MS);
  }

  // Windows 下应用常驻托盘，第一次弹出的窗口可能停在其它窗口后面；
  // 短暂置顶再恢复，保证用户点了菜单就能看到（与 settings 窗口一致）。
  function temporarilyLiftWindow(win) {
    if (!isWin || !isLiveWindow(win) || typeof win.setAlwaysOnTop !== "function") return false;
    clearLiftTimer();
    win.setAlwaysOnTop(true);
    if (typeof win.moveTop === "function") win.moveTop();
    liftTimer = scheduleTimer(() => {
      liftTimer = null;
      if (isLiveWindow(win) && typeof win.setAlwaysOnTop === "function") {
        win.setAlwaysOnTop(false);
      }
    }, FRONT_LIFT_MS);
    return true;
  }

  function showAndFocusWindow(win, showOptions = {}) {
    if (!isLiveWindow(win)) return false;
    if (
      showOptions.restoreMinimized
      && typeof win.isMinimized === "function"
      && win.isMinimized()
      && typeof win.restore === "function"
    ) {
      win.restore();
    }
    if (typeof win.show === "function") win.show();
    const lifted = temporarilyLiftWindow(win);
    if (!lifted && typeof win.moveTop === "function") win.moveTop();
    if (typeof win.focus === "function") win.focus();
    return true;
  }

  function notifyRendererLoaded(win) {
    // 按聊天窗口自己所在显示器解析缩放（与 computeInitialBounds 一致）：
    // 多显示器各屏缩放不同时，加载后注入的 zoom 才不会取错屏幕。
    applyZoomToWindow(win, getTextScale(getNormalWindowBounds(win)));
    applyTitleToWindow();
    if (typeof options.onDidFinishLoad !== "function") return;
    try {
      options.onDidFinishLoad(win);
    } catch (err) {
      console.warn("Clawd: chat did-finish-load callback failed:", err && err.message);
    }
  }

  function notifyRendererReset(win) {
    if (chatWindow !== win) return;
    if (typeof options.onRendererReset !== "function") return;
    try {
      options.onRendererReset(win);
    } catch (err) {
      console.warn("Clawd: chat renderer reset callback failed:", err && err.message);
    }
  }

  function open(openOptions = {}) {
    if (chatWindow && !chatWindow.isDestroyed()) {
      showAndFocusWindow(chatWindow, { restoreMinimized: true });
      return chatWindow;
    }

    // 新窗口 = 重新跟随（用户上一轮拖窗口暂停的跟随之类，不跨窗口继承）。
    followSuspended = false;
    programmaticMove = null;
    lastAppliedScale = null;
    closeFadeInFlight = false;

    // 顺序很重要：先定尺寸 → 让面板给整条让位（attachedHeightHint）→ 再算位置。
    // 「一条」版式下面板卡片会整体下移「回复窗口高度 / 2」，这一步必须发生在读
    // 卡片位置之前，否则窗口会按旧位置摆、跟随后挪下去的卡片错开一大截。
    const savedBounds = readSavedBounds();
    const mode = readPositionMode();
    const petBounds = readPetBounds();
    const sizeWorkArea = resolveWorkArea(
      mode,
      petBounds,
      petBounds ? petBounds.x + petBounds.width / 2 : 0,
      petBounds ? petBounds.y + petBounds.height / 2 : 0,
    );
    const sizePanelCard = readPanelCardRect();
    const size = computeInitialSize(savedBounds, sizeWorkArea, sizePanelCard);
    attachedHeightHint = isAttachedMode(mode, sizePanelCard) ? size.height : 0;
    const bounds = computeInitialBounds(size, mode, petBounds, sizeWorkArea);
    const createScale = getTextScale(bounds);
    const opts = {
      ...bounds,
      minWidth: Math.min(scaleWidth(MIN_WIDTH, createScale), bounds.width),
      minHeight: Math.min(scaleHeight(MIN_HEIGHT, createScale), bounds.height),
      show: false,
      frame: true,
      transparent: false,
      resizable: true,
      minimizable: true,
      maximizable: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      // macOS：宠物应用常驻后台，首次点击非激活的聊天窗口应该直接落到页面，
      // 而不是被系统吃掉只作激活窗口（与 settings / 权限气泡一致）。
      ...(isMac ? { acceptFirstMouse: true } : {}),
      title: getTitle(),
      // 与 chat.css 的 --bg 深浅色值保持一致，避免 CSS 生效前闪白/闪黑。
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1f" : "#f5f5f7",
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
      },
    };

    if (typeof options.onBeforeCreate === "function") options.onBeforeCreate();
    chatWindow = new BrowserWindow(opts);
    const createdWindow = chatWindow;
    // 带边框的窗口在部分 DPI 下会被系统量化外框尺寸，这里重新落一遍请求值，
    // 避免反复开关时把漂移累积进 chatWindowBounds（与 settings 窗口一致）。
    try {
      const createdBounds = typeof createdWindow.getBounds === "function"
        ? roundedBounds(createdWindow.getBounds())
        : null;
      if (
        createdBounds
        && !sameBounds(createdBounds, bounds)
        && typeof createdWindow.setBounds === "function"
      ) {
        createdWindow.setBounds(bounds);
      }
    } catch {}
    // 把修正后的原生矩形作为初始基线：没动过的窗口关闭时不回写 prefs。
    lastSavedBounds = getNormalWindowBounds(createdWindow) || bounds;
    // 首次显示也淡入：窗口从全透明开始（setOpacity 不可用的平台上是空操作）。
    try { createdWindow.setOpacity(0); } catch {}
    // 窗口出现了：面板给整条让位，同时开始/重排自动收起轮询（窗口还没显示出来，
    // 这一步看不见）。
    notifyWindowStateChanged();

    if (typeof createdWindow.setMenuBarVisibility === "function") createdWindow.setMenuBarVisibility(false);
    if (typeof createdWindow.loadFile === "function") createdWindow.loadFile(chatHtmlPath);

    const webContents = createdWindow.webContents;
    if (webContents && typeof webContents.once === "function") {
      webContents.once("did-finish-load", () => {
        notifyRendererLoaded(createdWindow);
      });
    }
    if (webContents && typeof webContents.on === "function") {
      webContents.on("render-process-gone", () => notifyRendererReset(createdWindow));
      webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isInPlace || isMainFrame === false) return;
        notifyRendererReset(createdWindow);
      });
    }

    if (typeof createdWindow.on === "function") {
      createdWindow.on("move", () => {
        // 自己搬的（跟随桌宠）不算用户拖动，也不落盘。
        if (consumeProgrammaticMove(createdWindow)) return;
        // 用户拖过窗口：本轮暂停跟随，窗口就停在他放的地方。
        // 顺手取消在途的跟随补帧，免得拖到一半被程序化搬走。
        followSuspended = true;
        // textScale 按显示器解析：拖动到别的屏幕后重新取一次（防抖，move 会连续触发）。
        clearMoveTextScaleTimer();
        moveTextScaleTimer = scheduleTimer(() => {
          moveTextScaleTimer = null;
          applyTextScale();
        }, MOVE_TEXT_SCALE_DEBOUNCE_MS);
        scheduleWindowBoundsSave(createdWindow);
      });
      createdWindow.on("resize", () => scheduleWindowBoundsSave(createdWindow));
      // `closed` 之后拿不到原生窗口几何，所以趁窗口还活着冲刷待保存的防抖值。
      createdWindow.on("close", (event) => {
        persistWindowBoundsNow(createdWindow);
        // 用户关窗：先淡出再真关。退出流程（Cmd+Q）直接放行，绝不挡住退出；
        // 没有 event 对象（单测直接 emit）时也当普通关闭处理。
        if (closeFadeInFlight || !shouldFadeOnClose()) return;
        if (!event || typeof event.preventDefault !== "function") return;
        closeFadeInFlight = true;
        event.preventDefault();
        fadeWindowTo(createdWindow, 0, () => {
          if (!isLiveWindow(createdWindow)) return;
          try { createdWindow.close(); } catch {}
        });
      });
    }

    let didShowCreatedWindow = false;
    function showCreatedWindow(showOptions = {}) {
      if (didShowCreatedWindow) return;
      didShowCreatedWindow = true;
      if (showPendingWindow === showCreatedWindow) showPendingWindow = null;
      clearReadyToShowFallbackTimer();
      // 首开时序兜底：创建窗口时桌宠矩形可能还没就绪，显示前用此刻的位置再摆一次
      // （窗口还没露出来，这一步看不见）。
      applyPlacement(true);
      showAndFocusWindow(createdWindow, showOptions);
      fadeWindowTo(createdWindow, 1, null);
    }
    showPendingWindow = showCreatedWindow;
    if (typeof createdWindow.once === "function") createdWindow.once("ready-to-show", showCreatedWindow);
    readyToShowFallbackTimer = scheduleTimer(showCreatedWindow, READY_TO_SHOW_FALLBACK_MS);

    if (typeof createdWindow.on === "function") {
      createdWindow.on("closed", () => {
        const isCurrentWindow = chatWindow === createdWindow;
        if (isCurrentWindow) {
          showPendingWindow = null;
          clearReadyToShowFallbackTimer();
          clearLiftTimer();
          clearSaveBoundsTimer();
          clearMoveTextScaleTimer();
          cancelFade();
          programmaticMove = null;
          lastAppliedScale = null;
          closeFadeInFlight = false;
          // 窗口没了 = 整条没了：面板收回桌宠旁边原来那条线上，轮询也停掉。
          attachedHeightHint = 0;
          notifyWindowStateChanged();
        }
        if (isCurrentWindow) chatWindow = null;
        // 通知外部（main.js）停止当前会话；窗口对象本身已经不可复用。
        if (typeof options.onAfterClosed === "function") options.onAfterClosed();
      });
    }

    return createdWindow;
  }

  function show(showOptions = {}) {
    const win = getWindow();
    if (!win) return open(showOptions);
    showAndFocusWindow(win, { restoreMinimized: true });
    return win;
  }

  // textScale 变化时调用：重新注入缩放，必要时抬高最小尺寸；
  // 只在下限被突破时改窗口大小，不覆盖用户自己拖出来的尺寸。
  function applyTextScale() {
    const win = getWindow();
    if (!isLiveWindow(win)) return false;
    const bounds = typeof win.getBounds === "function" ? win.getBounds() : null;
    const scale = getTextScale(bounds);
    applyZoomToWindow(win, scale);
    const minWidth = scaleWidth(MIN_WIDTH, scale);
    const minHeight = scaleHeight(MIN_HEIGHT, scale);
    if (typeof win.setMinimumSize === "function") win.setMinimumSize(minWidth, minHeight);
    if (bounds && (bounds.width < minWidth || bounds.height < minHeight) && typeof win.setBounds === "function") {
      win.setBounds({
        ...bounds,
        width: Math.max(bounds.width, minWidth),
        height: Math.max(bounds.height, minHeight),
      });
    }
    return true;
  }

  // 应用退出时调用：清掉所有定时器并销毁窗口（子进程由 runtime.dispose() 负责）。
  function dispose() {
    attachedHeightHint = 0;
    clearReadyToShowFallbackTimer();
    clearLiftTimer();
    clearSaveBoundsTimer();
    clearMoveTextScaleTimer();
    cancelFade();
    programmaticMove = null;
    // 退出流程：destroy 不会再触发 close，就算触发也必须一路放行。
    closeFadeInFlight = true;
    const win = chatWindow;
    chatWindow = null;
    if (!isLiveWindow(win)) return;
    try {
      if (typeof win.destroy === "function") win.destroy();
      else if (typeof win.close === "function") win.close();
    } catch {}
  }

  return {
    getWindow,
    open,
    show,
    reposition,
    // 自动消失（点桌宠一起出现、指针离开一起消失）
    setRevealed,
    // 面板（session-hud）在算自己的位置时读这两个：整条让位多少、卡片贴哪。
    getAttachedStackHeight,
    applyTextScale,
    // 语言切换后由 main.js 调用：重设原生标题（页面标题是固定英文）。
    applyTitleToWindow,
    dispose,
  };
}

module.exports = createChatWindowRuntime;
