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

const defaultPath = require("path");

const { clampTextScale, scaleWidth, scaleHeight, applyZoomToWindow } = require("./text-scale");

const DEFAULT_WIDTH = 900;
const DEFAULT_HEIGHT = 640;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 480;
const READY_TO_SHOW_FALLBACK_MS = 2000;
const FRONT_LIFT_MS = 200;
const BOUNDS_SAVE_DEBOUNCE_MS = 500;
const MOVE_TEXT_SCALE_DEBOUNCE_MS = 350;
const FALLBACK_WORK_AREA = { x: 0, y: 0, width: 1280, height: 800 };
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

  let chatWindow = null;
  let readyToShowFallbackTimer = null;
  let liftTimer = null;
  let saveBoundsTimer = null;
  let moveTextScaleTimer = null;
  let lastSavedBounds = null;
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

  function computeInitialBounds() {
    let savedBounds = null;
    if (typeof options.getSavedBounds === "function") {
      try { savedBounds = roundedBounds(options.getSavedBounds()); } catch {}
    }

    // 没有历史记录时，以主显示器（最近工作区）中心为基准，不依赖桌宠窗口位置。
    const cx = savedBounds ? savedBounds.x + savedBounds.width / 2 : 0;
    const cy = savedBounds ? savedBounds.y + savedBounds.height / 2 : 0;

    let workArea = FALLBACK_WORK_AREA;
    if (typeof options.getNearestWorkArea === "function") {
      try {
        workArea = normalizeWorkArea(options.getNearestWorkArea(cx, cy));
      } catch {
        workArea = FALLBACK_WORK_AREA;
      }
    }

    const scale = getTextScale(savedBounds || workArea);
    const minWidth = scaleWidth(MIN_WIDTH, scale);
    const minHeight = scaleHeight(MIN_HEIGHT, scale);
    if (savedBounds) {
      // 与 settings 窗口略有不同：聊天窗口优先原样恢复用户上次摆的位置和大小
      // （只在低于最小尺寸/超过工作区大小时修正），只有整个窗口已经完全不在
      // 工作区内（例如拔掉外接显示器）才整体拉回，避免位置被反复改写。
      const sized = {
        ...savedBounds,
        width: Math.min(Math.max(savedBounds.width, minWidth), Math.max(1, workArea.width)),
        height: Math.min(Math.max(savedBounds.height, minHeight), Math.max(1, workArea.height)),
      };
      const overlapsWorkArea = sized.x < workArea.x + workArea.width
        && sized.x + sized.width > workArea.x
        && sized.y < workArea.y + workArea.height
        && sized.y + sized.height > workArea.y;
      return overlapsWorkArea
        ? {
            x: Math.round(sized.x),
            y: Math.round(sized.y),
            width: Math.round(sized.width),
            height: Math.round(sized.height),
          }
        : clampBoundsToWorkArea(sized, workArea);
    }
    const width = Math.min(scaleWidth(DEFAULT_WIDTH, scale), Math.max(1, workArea.width));
    const height = Math.min(scaleHeight(DEFAULT_HEIGHT, scale), Math.max(1, workArea.height));
    return clampBoundsToWorkArea({
      x: workArea.x + (workArea.width - width) / 2,
      y: workArea.y + (workArea.height - height) / 2,
      width,
      height,
    }, workArea);
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

    const bounds = computeInitialBounds();
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
      createdWindow.on("close", () => persistWindowBoundsNow(createdWindow));
    }

    let didShowCreatedWindow = false;
    function showCreatedWindow(showOptions = {}) {
      if (didShowCreatedWindow) return;
      didShowCreatedWindow = true;
      if (showPendingWindow === showCreatedWindow) showPendingWindow = null;
      clearReadyToShowFallbackTimer();
      showAndFocusWindow(createdWindow, showOptions);
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
    clearReadyToShowFallbackTimer();
    clearLiftTimer();
    clearSaveBoundsTimer();
    clearMoveTextScaleTimer();
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
    applyTextScale,
    // 语言切换后由 main.js 调用：重设原生标题（页面标题是固定英文）。
    applyTitleToWindow,
    dispose,
  };
}

module.exports = createChatWindowRuntime;
