"use strict";

// src/chat-window.js（内置对话窗口，阶段一）的单元测试。
//
// 用 FakeBrowserWindow 记录构造参数、事件与窗口方法调用；定时器用真实的
// setTimeout（不去猜防抖毫秒数），用 waitFor 轮询等待落盘回调。

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const createChatWindowRuntime = require("../src/chat-window");

class FakeBrowserWindow {
  static instances = [];

  constructor(options) {
    this.options = options;
    this.bounds = {
      x: options.x,
      y: options.y,
      width: options.width,
      height: options.height,
    };
    this.normalBounds = { ...this.bounds };
    this.destroyed = false;
    this.minimized = false;
    this.visible = false;
    this.opacity = 1;
    this.title = options.title;
    this.calls = [];
    this.events = new Map();
    this.onceEvents = new Map();
    this.webContents = {
      insertedCss: [],
      isDestroyed: () => false,
      onceCallbacks: new Map(),
      onCallbacks: new Map(),
      once(event, cb) {
        this.onceCallbacks.set(event, cb);
      },
      on(event, cb) {
        this.onCallbacks.set(event, cb);
      },
      send: (channel, payload) => this.calls.push(["send", channel, payload]),
      insertCSS: (css) => {
        this.webContents.insertedCss.push(css);
        return Promise.resolve("css-key");
      },
      setZoomFactor: () => {},
    };
    FakeBrowserWindow.instances.push(this);
  }

  isDestroyed() {
    return this.destroyed;
  }

  isMinimized() {
    return this.minimized;
  }

  restore() {
    this.calls.push("restore");
    this.minimized = false;
  }

  show() {
    this.calls.push("show");
    this.visible = true;
  }

  showInactive() {
    this.calls.push("showInactive");
    this.visible = true;
  }

  hide() {
    this.calls.push("hide");
    this.visible = false;
  }

  isFocused() {
    return this.focused === true;
  }

  isVisible() {
    return this.visible;
  }

  setOpacity(value) {
    this.calls.push(["setOpacity", value]);
    this.opacity = value;
  }

  getOpacity() {
    return this.opacity;
  }

  focus() {
    this.calls.push("focus");
  }

  moveTop() {
    this.calls.push("moveTop");
  }

  close() {
    this.calls.push("close");
    this.emit("close");
  }

  destroy() {
    this.calls.push("destroy");
    this.destroyed = true;
    this.emit("closed");
  }

  setAlwaysOnTop(value, level) {
    this.calls.push(["setAlwaysOnTop", value, level]);
  }

  setTitle(value) {
    this.calls.push(["setTitle", value]);
    this.title = value;
  }

  setBounds(bounds) {
    this.calls.push(["setBounds", bounds]);
    // 真机语义：只给 x/y 时保留原有宽高。
    this.bounds = { ...this.bounds, ...bounds };
    this.normalBounds = { ...this.bounds };
    // 真机 setBounds 会发 move 事件；跟随逻辑正是靠它区分「自己搬的」和「用户拖的」。
    this.emit("move");
  }

  setMinimumSize(width, height) {
    this.calls.push(["setMinimumSize", width, height]);
    this.minimumSize = { width, height };
  }

  getBounds() {
    return { ...this.bounds };
  }

  getNormalBounds() {
    return { ...this.normalBounds };
  }

  loadFile(filePath) {
    this.calls.push(["loadFile", filePath]);
    this.loadedFile = filePath;
  }

  setMenuBarVisibility() {}

  setAppDetails() {}

  once(eventName, listener) {
    this.onceEvents.set(eventName, listener);
  }

  on(eventName, listener) {
    this.events.set(eventName, listener);
  }

  emit(eventName, ...args) {
    const onceListener = this.onceEvents.get(eventName);
    if (onceListener) {
      this.onceEvents.delete(eventName);
      onceListener(...args);
    }
    const listener = this.events.get(eventName);
    if (listener) listener(...args);
  }

  emitWebContents(eventName, ...args) {
    const onceCallback = this.webContents.onceCallbacks.get(eventName);
    if (onceCallback) {
      this.webContents.onceCallbacks.delete(eventName);
      onceCallback(...args);
    }
    const callback = this.webContents.onCallbacks.get(eventName);
    if (callback) callback(...args);
  }
}

function createRuntime(options = {}) {
  FakeBrowserWindow.instances = [];
  return createChatWindowRuntime({
    app: {
      isReady: () => true,
      isPackaged: false,
      once() {},
      getAppPath: () => "/app",
    },
    BrowserWindow: FakeBrowserWindow,
    nativeTheme: { shouldUseDarkColors: false },
    path,
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 1600, height: 900 }),
    getPrimaryWorkArea: () => ({ x: 0, y: 0, width: 1600, height: 900 }),
    getPetBounds: () => null,
    getAnchorRect: () => null,
    getPositionMode: () => "follow",
    getFixedCorner: () => "bottom-right",
    isAppQuitting: () => false,
    getTextScale: () => 1,
    getSavedBounds: () => null,
    getTitle: () => "Clawd Chat",
    ...options,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("chat window loads the chat page with the chat preload and the saved size", () => {
  // 阶段二起：尺寸沿用用户上次调出来的，位置改由定位规则算（没有桌宠矩形时居中）。
  const saved = { x: 120, y: 90, width: 900, height: 640 };
  const runtime = createRuntime({ getSavedBounds: () => saved });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.ok(win, "open() must create exactly one BrowserWindow");
  assert.equal(runtime.getWindow(), win);
  assert.equal(win.options.title, "Clawd Chat");
  assert.deepEqual(
    { x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height },
    { x: 350, y: 130, width: 900, height: 640 },
  );
  assert.equal(win.options.webPreferences.contextIsolation, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.match(win.options.webPreferences.preload, /preload-chat\.js$/);
  assert.match(win.loadedFile, /chat\.html$/);
});

test("chat window centers on the work area when no bounds were saved", () => {
  const runtime = createRuntime({
    getSavedBounds: () => null,
    getNearestWorkArea: () => ({ x: 1000, y: 200, width: 1200, height: 800 }),
  });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  const { x, y, width, height } = win.options;
  assert.ok(width > 0 && height > 0);
  assert.ok(x >= 1000 && y >= 200);
  assert.ok(x + width <= 2200, "window must stay inside the work area");
  assert.ok(y + height <= 1000, "window must stay inside the work area");
  // 真正锁住「居中」：窗口中心与工作区中心的偏差只允许取整带来的 ±1。
  assert.ok(Math.abs(x + width / 2 - (1000 + 1200 / 2)) <= 1, "window must be centered horizontally");
  assert.ok(Math.abs(y + height / 2 - (200 + 800 / 2)) <= 1, "window must be centered vertically");
});

test("did-finish-load reapplies the localized title and runs onDidFinishLoad", () => {
  const loads = [];
  const runtime = createRuntime({
    getTitle: () => "本地化聊天标题",
    onDidFinishLoad: (win) => loads.push(win),
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  // chat.html 里固定的英文 <title> 会在加载后覆盖构造时的标题，这里模拟该覆盖。
  win.title = "Clawd Chat";

  win.emitWebContents("did-finish-load");

  assert.equal(win.title, "本地化聊天标题", "did-finish-load must reapply the localized title");
  assert.equal(loads.length, 1, "onDidFinishLoad must run exactly once");
  assert.equal(loads[0], win);
});

test("render-process-gone and main-frame navigation notify onRendererReset", () => {
  const resets = [];
  const runtime = createRuntime({ onRendererReset: (win) => resets.push(win) });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];

  win.emitWebContents("render-process-gone");
  assert.deepEqual(resets, [win], "a crashed renderer must notify onRendererReset");

  win.emitWebContents("did-start-navigation", {}, "file:///chat.html", false, true);
  assert.deepEqual(resets, [win, win], "a main-frame navigation must notify onRendererReset");
});

test("macOS chat window accepts the first mouse click", { skip: process.platform !== "darwin" }, () => {
  const runtime = createRuntime();
  runtime.open();
  assert.equal(FakeBrowserWindow.instances[0].options.acceptFirstMouse, true);
});

test("non-macOS chat window does not force acceptFirstMouse", { skip: process.platform === "darwin" }, () => {
  const runtime = createRuntime();
  runtime.open();
  assert.ok(!FakeBrowserWindow.instances[0].options.acceptFirstMouse);
});

test("chat window open is a singleton that focuses the existing window", () => {
  const runtime = createRuntime();
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.calls = [];
  win.minimized = true;

  runtime.open();
  assert.equal(FakeBrowserWindow.instances.length, 1, "a second open must not create a window");
  assert.ok(win.calls.includes("show"), "the existing window must be shown");
  assert.ok(win.calls.includes("focus"), "the existing window must be focused");
});

test("closing the chat window clears the runtime reference and notifies onAfterClosed", () => {
  let closed = 0;
  const runtime = createRuntime({ onAfterClosed: () => { closed += 1; } });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];

  win.emit("closed");
  assert.equal(closed, 1);
  assert.equal(runtime.getWindow(), null);

  // 关掉之后再次 open 应当新建窗口。
  runtime.open();
  assert.equal(FakeBrowserWindow.instances.length, 2);
  assert.equal(runtime.getWindow(), FakeBrowserWindow.instances[1]);
});

test("chat window bounds are persisted through onSaveBounds with a debounce", async () => {
  const saved = [];
  const runtime = createRuntime({
    onSaveBounds: (bounds) => {
      saved.push(bounds);
      return { status: "ok" };
    },
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.normalBounds = { x: 300, y: 220, width: 880, height: 620 };

  win.emit("resize");
  assert.equal(saved.length, 0, "bounds save must not fire synchronously");
  win.emit("resize");

  const persisted = await waitFor(() => saved.length > 0);
  assert.ok(persisted, "a debounced bounds save must eventually run");
  assert.equal(saved.length, 1, "rapid resize events must coalesce into one save");
  assert.deepEqual(saved[0], { x: 300, y: 220, width: 880, height: 620 });
});

test("saved chat window size feeds the next window that opens", async () => {
  let persisted = null;
  const runtime = createRuntime({
    getSavedBounds: () => persisted,
    onSaveBounds: (bounds) => {
      persisted = bounds;
      return { status: "ok" };
    },
  });
  runtime.open();
  const first = FakeBrowserWindow.instances[0];
  first.normalBounds = { x: 420, y: 230, width: 940, height: 700 };
  first.emit("close");
  first.emit("closed");
  await waitFor(() => persisted !== null);

  runtime.open();
  const reopened = FakeBrowserWindow.instances[1];
  // 尺寸接着上次；位置由定位规则算（工作区 1600×900 里居中）。
  assert.deepEqual(
    { x: reopened.options.x, y: reopened.options.y, width: reopened.options.width, height: reopened.options.height },
    { x: 330, y: 100, width: 940, height: 700 },
  );
});

test("applyTextScale injects the text zoom into the chat page", () => {
  const runtime = createRuntime({ getTextScale: () => 1.25 });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];

  assert.doesNotThrow(() => runtime.applyTextScale());
  assert.equal(typeof runtime.applyTextScale, "function");
  assert.ok(
    win.webContents.insertedCss.some((css) => /zoom:\s*1\.25/.test(css)),
    "the chat page must receive a root zoom stylesheet",
  );
});

test("chat window show targets the open window and dispose is idempotent", () => {
  const runtime = createRuntime();
  assert.doesNotThrow(() => runtime.show());
  assert.doesNotThrow(() => runtime.dispose());

  runtime.open();
  const win = FakeBrowserWindow.instances.at(-1);
  win.calls = [];
  runtime.show();
  assert.ok(win.calls.includes("show"));

  assert.doesNotThrow(() => runtime.dispose());
  assert.doesNotThrow(() => runtime.dispose());
});

// ── 阶段二：跟随桌宠 / 固定角落 ──
// 测试工作区固定 1600×900，回复窗口默认 300×680：
// - 桌宠在右侧 (x=1300) 时左侧放得下 → 贴在桌宠左边 1300 - 12 - 300 = 988
// - 300 宽的窗口在 1600 宽的工作区里几乎总能贴到某一侧，「两侧都放不下」只在
//   很窄的屏幕上才会发生（用 700 宽的工作区验证）

const PET_ON_RIGHT = { x: 1300, y: 400, width: 120, height: 120 };

test("the default reply window is the tall narrow shape", () => {
  const runtime = createRuntime();
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.deepEqual({ width: win.options.width, height: win.options.height }, { width: 300, height: 680 });
});

test("follow mode places the window beside the pet", () => {
  const runtime = createRuntime({ getPetBounds: () => PET_ON_RIGHT });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  // 左边：1300 - 12 - 300 = 988；纵向以桌宠为中心 460 - 340 = 120。
  assert.deepEqual({ x: win.options.x, y: win.options.y }, { x: 988, y: 120 });
});

test("follow mode clamps to the far side when neither side fits", () => {
  const runtime = createRuntime({
    getNearestWorkArea: () => ({ x: 0, y: 0, width: 700, height: 900 }),
    getPrimaryWorkArea: () => ({ x: 0, y: 0, width: 700, height: 900 }),
    getPetBounds: () => ({ x: 280, y: 400, width: 120, height: 120 }),
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  // 桌宠在 340（工作区中心 350 左侧）→ 窗口贴右边缘 700 - 8 - 300 = 392。
  assert.equal(win.options.x, 392);
  assert.equal(win.options.y, 120);
});

test("corner mode snaps to the chosen corner and keeps the saved size", () => {
  const runtime = createRuntime({
    getSavedBounds: () => ({ x: 120, y: 90, width: 340, height: 700 }),
    getPositionMode: () => "corner",
    getFixedCorner: () => "top-left",
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.deepEqual({ x: win.options.x, y: win.options.y }, { x: 8, y: 8 });
  assert.deepEqual({ width: win.options.width, height: win.options.height }, { width: 340, height: 700 });
});

test("follow reposition moves the window with the pet and never persists those moves", () => {
  let pet = PET_ON_RIGHT;
  const saved = [];
  const runtime = createRuntime({
    getPetBounds: () => pet,
    onSaveBounds: (bounds) => {
      saved.push(bounds);
      return { status: "ok" };
    },
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.emit("ready-to-show");
  assert.equal(win.visible, true);

  // 同一帧就搬：桌宠逐帧移动，窗口必须逐帧跟上，攒帧会看起来一跳一跳。
  pet = { x: 1000, y: 400, width: 120, height: 120 };
  assert.equal(runtime.reposition(), true);
  assert.equal(win.bounds.x, 688, "1000 - 12 - 300 = 688");
  assert.equal(win.bounds.y, 120, "following only moves, it must not resize");
  assert.equal(win.bounds.width, 300);
  assert.deepEqual(saved, [], "programmatic follow moves must not be persisted");

  // 1px 的小位移落在死区内，窗口不动（省掉纯取整带来的无意义 setBounds）。
  pet = { x: 1001, y: 400, width: 120, height: 120 };
  assert.equal(runtime.reposition(), false);
  assert.equal(win.bounds.x, 688, "a sub-threshold move must not nudge the window");
});

test("a user drag suspends following until it is forced back", async () => {
  let pet = PET_ON_RIGHT;
  const runtime = createRuntime({ getPetBounds: () => pet });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.emit("ready-to-show");

  // 用户把窗口拖到别处（真机拖动会同时更新 bounds 与 normalBounds）。
  win.bounds = { x: 200, y: 300, width: 300, height: 680 };
  win.normalBounds = { ...win.bounds };
  win.emit("move");
  pet = { x: 1000, y: 400, width: 120, height: 120 };
  assert.equal(runtime.reposition(), false, "a dragged window must not schedule follows");
  assert.equal(win.bounds.x, 200, "a dragged window must stay where the user put it");

  // 重选设置（force）＝ 恢复跟随。
  runtime.reposition({ force: true });
  assert.equal(win.bounds.x, 688);
  pet = { x: 1100, y: 400, width: 120, height: 120 };
  assert.equal(runtime.reposition(), true);
  assert.equal(win.bounds.x, 788, "forcing must resume following");
});

test("following the pet onto another display re-injects that display's text scale", async () => {
  let pet = PET_ON_RIGHT;
  const runtime = createRuntime({
    getPetBounds: () => pet,
    getNearestWorkArea: (cx) => (cx >= 2000
      ? { x: 1920, y: 0, width: 1920, height: 1080 }
      : { x: 0, y: 0, width: 1600, height: 900 }),
    getTextScale: (bounds) => (bounds && bounds.x >= 1500 ? 1.5 : 1),
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.emit("ready-to-show");
  win.webContents.insertedCss.length = 0;

  pet = { x: 2100, y: 400, width: 120, height: 120 };
  runtime.reposition();
  assert.ok(win.bounds.x > 1500, "the window must follow the pet onto the second display");
  assert.ok(
    win.webContents.insertedCss.some((css) => /zoom:\s*1\.5/.test(css)),
    "the second display's text scale must be re-applied after the follow move",
  );
});

// ── 阶段二之二：「一条」版式（回复窗口贴在快捷面板卡片正上方）──

test("follow mode with a panel glues the window onto the panel card", () => {
  const attached = [];
  const runtime = createRuntime({
    getPetBounds: () => PET_ON_RIGHT,
    getPanelCardRect: () => ({ x: 900, y: 700, width: 300, height: 134 }),
    onReplyWindowStateChanged: () => attached.push("changed"),
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  // 左边缘对齐卡片（900），底边紧贴卡片顶边（700 - 680 = 20）。
  assert.deepEqual({ x: win.options.x, y: win.options.y }, { x: 900, y: 20 });
  assert.equal(attached.length, 1, "窗口一造出来就要通知面板让位");
});

test("the attached height is published before the panel card position is read", () => {
  // 面板卡片的位置取决于回复窗口多高（整条以桌宠为中心），所以先定尺寸、
  // 再让面板让位、最后才读卡片位置——顺序错了窗口会和卡片错开一大截。
  const seenHeights = [];
  let runtime = null;
  runtime = createRuntime({
    getPetBounds: () => PET_ON_RIGHT,
    getPanelCardRect: () => {
      seenHeights.push(runtime.getAttachedStackHeight());
      return { x: 900, y: 700, width: 300, height: 134 };
    },
    onReplyWindowStateChanged: () => {},
  });
  runtime.open();

  assert.equal(seenHeights.length, 2, "先读一次卡片高度定尺寸，再读一次定位置");
  assert.equal(seenHeights[0], 0, "定尺寸时还没有窗口，面板不必让位");
  assert.equal(seenHeights[1], 680, "定位置时面板必须已经按窗口高度让好位");
});

test("closing the window tells the panel to take its old place back", () => {
  const attached = [];
  const runtime = createRuntime({
    getPetBounds: () => PET_ON_RIGHT,
    getPanelCardRect: () => ({ x: 900, y: 700, width: 300, height: 134 }),
    onReplyWindowStateChanged: () => attached.push("changed"),
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  attached.length = 0;

  win.emit("closed");
  assert.equal(attached.length, 1, "窗口关掉后面板要收回原位");
  assert.equal(runtime.getAttachedStackHeight(), 0);
});

test("attached mode does not apply in corner mode", () => {
  const runtime = createRuntime({
    getPetBounds: () => PET_ON_RIGHT,
    getPanelCardRect: () => ({ x: 900, y: 700, width: 300, height: 134 }),
    getPositionMode: () => "corner",
    getFixedCorner: () => "top-left",
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.deepEqual({ x: win.options.x, y: win.options.y }, { x: 8, y: 8 });
  assert.equal(runtime.getAttachedStackHeight(), 0);
});

test("the attached window keeps following the panel card as the pet moves", () => {
  let cardX = 900;
  const runtime = createRuntime({
    getPetBounds: () => PET_ON_RIGHT,
    getPanelCardRect: () => ({ x: cardX, y: 700, width: 300, height: 134 }),
    onReplyWindowStateChanged: () => {},
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.emit("ready-to-show");

  cardX = 600;
  assert.equal(runtime.reposition(), true);
  assert.equal(win.bounds.x, 600, "the window must stay in the panel's column");
  assert.equal(win.bounds.y, 20);
});

test("follow reposition is a no-op while the window is hidden or in corner mode", async () => {
  let mode = "follow";
  const runtime = createRuntime({ getPetBounds: () => PET_ON_RIGHT, getPositionMode: () => mode });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];

  runtime.reposition();
  await sleep(220);
  assert.equal(win.bounds.x, 988, "a hidden window must not be repositioned");

  win.emit("ready-to-show");
  mode = "corner";
  assert.equal(runtime.reposition(), false, "corner mode must not schedule follows");
});

test("switching to corner mode through a settings change snaps the window to that corner", () => {
  let mode = "follow";
  const runtime = createRuntime({
    getPetBounds: () => PET_ON_RIGHT,
    getPositionMode: () => mode,
    getFixedCorner: () => "bottom-left",
  });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.emit("ready-to-show");
  assert.equal(win.bounds.x, 988);

  mode = "corner";
  runtime.reposition({ force: true });
  // 左下角：x = 8，y = 900 - 8 - 680 = 212。
  assert.deepEqual({ x: win.bounds.x, y: win.bounds.y }, { x: 8, y: 212 });
});

// ── 自动消失（和快捷面板一样：点桌宠出现、指针离开后消失）──

test("setRevealed shows the window without stealing focus and can hide it again", async () => {
  const runtime = createRuntime();
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.emit("ready-to-show");
  await waitFor(() => win.opacity === 1);

  assert.equal(runtime.setRevealed(false), true);
  const hidden = await waitFor(() => win.calls.includes("hide"));
  assert.ok(hidden, "指针离开后窗口要被藏起来（不是关掉）");
  assert.equal(win.opacity, 0, "藏之前先淡出");
  assert.equal(win.calls.filter((call) => call === "close").length, 0, "自动消失绝不能关窗（关窗会停会话）");

  win.calls.length = 0;
  assert.equal(runtime.setRevealed(true), true);
  assert.ok(win.calls.includes("showInactive"), "重新露出来不能抢走面板输入框的焦点");
  assert.ok(!win.calls.includes("show"), "不可以用会抢焦点的 show()");
  assert.ok(win.calls.includes("moveTop"), "要在不抢焦点的前提下抬到最前");
  const fadedIn = await waitFor(() => win.opacity === 1);
  assert.ok(fadedIn, "重新露出来同样淡入");
});

test("setRevealed is a no-op when the window is already in the target state", async () => {
  const runtime = createRuntime();
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.equal(runtime.setRevealed(false), false, "还没显示过就不用藏");
  assert.equal(runtime.setRevealed(false), false);

  win.emit("ready-to-show");
  await waitFor(() => win.opacity === 1);
  assert.equal(runtime.setRevealed(true), false, "已经显示着就不用再显示");
});

test("setRevealed re-places the window before showing it again", () => {
  let pet = PET_ON_RIGHT;
  const runtime = createRuntime({ getPetBounds: () => pet });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.emit("ready-to-show");

  win.visible = false; // 被自动收起了
  pet = { x: 1000, y: 400, width: 120, height: 120 };
  runtime.setRevealed(true);
  // 藏着的这段时间桌宠走远了：露出来之前必须按当前位置先摆好（688 = 1000-12-300）。
  assert.equal(win.bounds.x, 688);
});

test("setRevealed never touches a window that was never created", () => {
  const runtime = createRuntime();
  assert.equal(runtime.setRevealed(true), false);
  assert.equal(runtime.setRevealed(false), false);
  assert.equal(FakeBrowserWindow.instances.length, 0, "自动消失不该顺手建一个窗口");
});

// ── 阶段二：淡入淡出 ──

test("opening fades the window in and closing fades it out before really closing", async () => {
  const runtime = createRuntime();
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.equal(win.opacity, 0, "a fresh window starts fully transparent");

  win.emit("ready-to-show");
  const fadedIn = await waitFor(() => win.opacity === 1);
  assert.ok(fadedIn, "showing the window must fade it in");

  let prevented = false;
  win.emit("close", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true, "the close must be deferred for the fade");
  assert.equal(win.opacity, 1, "the fade must not jump straight to 0");

  const closed = await waitFor(() => win.calls.includes("close"));
  assert.ok(closed, "the window must really close once the fade is done");
  assert.equal(win.opacity, 0, "the fade must end fully transparent");
});

test("quitting skips the close fade so Cmd+Q is never blocked", () => {
  const runtime = createRuntime({ isAppQuitting: () => true });
  runtime.open();
  const win = FakeBrowserWindow.instances[0];

  let prevented = false;
  win.emit("close", { preventDefault() { prevented = true; } });
  assert.equal(prevented, false, "an app quit must not be deferred");
  assert.equal(win.opacity, 0, "the window keeps whatever opacity it had");
});

test("disposing during a close fade never closes a destroyed window", async () => {
  const runtime = createRuntime();
  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  win.emit("ready-to-show");
  await waitFor(() => win.opacity === 1);

  let prevented = false;
  win.emit("close", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);

  runtime.dispose();
  assert.ok(win.calls.includes("destroy"));
  assert.equal(runtime.getWindow(), null);

  await sleep(240);
  assert.equal(win.calls.filter((call) => call === "close").length, 0, "the fade must not close a destroyed window");
});
