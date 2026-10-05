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
    this.bounds = { ...bounds };
    this.normalBounds = { ...bounds };
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

  emit(eventName) {
    const onceListener = this.onceEvents.get(eventName);
    if (onceListener) {
      this.onceEvents.delete(eventName);
      onceListener();
    }
    const listener = this.events.get(eventName);
    if (listener) listener();
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
    getTextScale: () => 1,
    getSavedBounds: () => null,
    getTitle: () => "Clawd Chat",
    ...options,
  });
}

async function waitFor(predicate, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

test("chat window loads the chat page with the chat preload and saved bounds", () => {
  const saved = { x: 120, y: 90, width: 900, height: 640 };
  const runtime = createRuntime({ getSavedBounds: () => saved });

  runtime.open();
  const win = FakeBrowserWindow.instances[0];
  assert.ok(win, "open() must create exactly one BrowserWindow");
  assert.equal(runtime.getWindow(), win);
  assert.equal(win.options.title, "Clawd Chat");
  assert.deepEqual(
    { x: win.options.x, y: win.options.y, width: win.options.width, height: win.options.height },
    saved,
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

test("saved chat bounds feed the next window that opens", async () => {
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
  assert.deepEqual(
    { x: reopened.options.x, y: reopened.options.y, width: reopened.options.width, height: reopened.options.height },
    persisted,
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
