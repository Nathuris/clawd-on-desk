"use strict";

// 内置 Claude 聊天窗口（回复窗口）渲染端行为测试。
//
// src/chat-renderer.js 是 IIFE：运行时读 globalThis.chatAPI 与
// globalThis.ClawdChatI18n，挂载到 #chatApp。这里用一套轻量假 DOM + vm 加载，
// 只断言「回复窗口」契约：工具栏结构、忙闲、显示我的消息、消息渲染、空态、语言切换。

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

class FakeClassList {
  constructor(element) { this.element = element; }
  _set() { return new Set(String(this.element.className || "").split(/\s+/).filter(Boolean)); }
  _commit(set) { this.element.className = [...set].join(" "); }
  add(...names) {
    const set = this._set();
    for (const name of names) set.add(name);
    this._commit(set);
  }
  remove(...names) {
    const set = this._set();
    for (const name of names) set.delete(name);
    this._commit(set);
  }
  toggle(name, force) {
    const set = this._set();
    const shouldAdd = force === undefined ? !set.has(name) : Boolean(force);
    if (shouldAdd) set.add(name);
    else set.delete(name);
    this._commit(set);
    return shouldAdd;
  }
  contains(name) { return this._set().has(name); }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase();
    this.className = "";
    this._text = "";
    this.classList = new FakeClassList(this);
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this.title = "";
    this.hidden = false;
    this.disabled = false;
    this.style = {};
    this.parentNode = null;
    // 滚动相关：渲染端只在贴底判断里读，给零值即可。
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.value = "";
    this.type = "";
    this.src = "";
    this.alt = "";
  }
  // 真 DOM 的 textContent 赋值会清空子节点（renderMarkdownInto 等靠它重置容器）。
  get textContent() { return this._text; }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._text = value == null ? "" : String(value);
  }
  get childNodes() { return this.children; }
  get lastElementChild() { return this.children.length ? this.children[this.children.length - 1] : null; }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(node, ref) {
    node.parentNode = this;
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index === -1) this.children.push(node);
    else this.children.splice(index, 0, node);
    return node;
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
    if (child) child.parentNode = null;
    return child;
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  replaceWith(node) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index === -1) return;
    parent.children.splice(index, 1, node);
    node.parentNode = parent;
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(listener);
  }
  async dispatch(name, event = {}) {
    const composed = {
      key: "",
      defaultPrevented: false,
      target: this,
      stopPropagation() {},
      preventDefault() { this.defaultPrevented = true; },
      ...event,
    };
    for (const listener of this.listeners.get(name) || []) await listener(composed);
    return composed;
  }
  contains(target) { return target === this || descendants(this).includes(target); }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  select() {}
}

function descendants(root) {
  const result = [];
  for (const child of root.children || []) result.push(child, ...descendants(child));
  return result;
}

function byClass(root, className) {
  return descendants(root).filter((element) =>
    element.classList && element.classList.contains(className));
}

function createDocument(ids) {
  const elements = new Map(ids.map((id) => [id, new FakeElement("div")]));
  const documentListeners = new Map();
  const document = {
    title: "",
    readyState: "complete",
    activeElement: null,
    body: new FakeElement("body"),
    createElement: (tag) => {
      const element = new FakeElement(tag);
      element.ownerDocument = document;
      return element;
    },
    createTextNode: (text) => {
      const node = new FakeElement("#text");
      node.textContent = String(text);
      return node;
    },
    createDocumentFragment: () => new FakeElement("fragment"),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => true,
    addEventListener: (name, listener) => {
      if (!documentListeners.has(name)) documentListeners.set(name, []);
      documentListeners.get(name).push(listener);
    },
    removeEventListener: (name, listener) => {
      const list = documentListeners.get(name) || [];
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    },
    dispatch: async (name, event = {}) => {
      const composed = {
        key: "",
        defaultPrevented: false,
        stopPropagation() {},
        preventDefault() { this.defaultPrevented = true; },
        ...event,
      };
      for (const listener of documentListeners.get(name) || []) await listener(composed);
      return composed;
    },
    elements,
  };
  document.body.ownerDocument = document;
  for (const element of elements.values()) element.ownerDocument = document;
  return document;
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

// 加载回复窗口渲染端：chatAPI 的八个方法全部假实现并记录调用；
// boot 会调 getState() 与 onUpdate()，getState 默认返回 null（被 applyState 忽略），
// 用例统一走 onUpdate 的回调推送快照。
async function loadChat(options = {}) {
  const document = createDocument(["chatApp"]);
  const calls = {
    stop: 0,
    newSession: 0,
    setShowUserMessages: [],
    openExternal: [],
    listHistory: 0,
    resumeSession: [],
  };
  const warnings = [];
  let updateListener = null;

  const api = {
    getState: async () => options.initialState || null,
    stop: () => { calls.stop += 1; },
    newSession: () => { calls.newSession += 1; },
    setShowUserMessages: (value) => { calls.setShowUserMessages.push(value); },
    openExternal: (url) => { calls.openExternal.push(url); },
    listHistory: async () => ({ status: "ok", rows: [] }),
    resumeSession: async (historyKey) => {
      calls.resumeSession.push(historyKey);
      return { status: "ok" };
    },
    onUpdate: (listener) => { updateListener = listener; },
  };

  const context = vm.createContext({
    chatAPI: api,
    document,
    navigator: { language: options.language || "en-US" },
    console: {
      log: (...args) => warnings.push(["log", ...args]),
      warn: (...args) => warnings.push(["warn", ...args]),
      error: (...args) => warnings.push(["error", ...args]),
    },
    Date,
    setTimeout,
    clearTimeout,
  });
  // 与 chat.html 的加载顺序一致：先词典，再渲染端。
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "chat-i18n.js"), "utf8"),
    context
  );
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "src", "chat-renderer.js"), "utf8"),
    context
  );
  await flush();

  const root = document.elements.get("chatApp");
  const find = (className) => byClass(root, className);
  return {
    document,
    root,
    calls,
    warnings,
    find,
    one: (className) => find(className)[0] || null,
    applyState: (snapshot) => {
      assert.strictEqual(typeof updateListener, "function", "renderer must register onUpdate");
      updateListener(snapshot);
    },
  };
}

test("toolbar keeps only the reply-window controls and drops the old composer", async () => {
  const chat = await loadChat();
  assert.strictEqual(chat.find("chat-toolbar").length, 1);
  for (const className of [
    "chat-new-session-button",
    "chat-history-button",
    "chat-show-user-button",
    "chat-stop-button",
  ]) {
    assert.strictEqual(chat.find(className).length, 1, `${className} should exist`);
  }
  // 输入区 / 下拉 / 指令浮层确已移除。
  for (const className of [
    "chat-input",
    "chat-composer",
    "chat-send-button",
    "chat-attach-button",
    "chat-dir-button",
    "chat-effort-select",
    "chat-mode-select",
    "chat-command-popover",
  ]) {
    assert.strictEqual(chat.find(className).length, 0, `${className} should be gone`);
  }
});

test("the stop button tracks busy state and calls stop once", async () => {
  const chat = await loadChat();
  const stop = chat.one("chat-stop-button");
  assert.strictEqual(stop.hidden, true, "idle sessions hide the stop button");

  chat.applyState({ lang: "zh", busy: true });
  assert.strictEqual(stop.hidden, false);
  await stop.dispatch("click");
  assert.strictEqual(chat.calls.stop, 1);

  chat.applyState({ lang: "zh", busy: false });
  assert.strictEqual(stop.hidden, true);
});

test("show-user toggle drives the app class, its label and aria-pressed", async () => {
  const chat = await loadChat();
  chat.applyState({ lang: "zh", messages: [] });
  const app = chat.one("chat-app");
  const button = chat.one("chat-show-user-button");

  // 默认（未给 showUserMessages）隐藏自己的消息
  assert.strictEqual(app.classList.contains("chat-hide-user"), true);
  assert.strictEqual(button.textContent, "显示我的消息");
  assert.strictEqual(button.getAttribute("aria-pressed"), "false");
  assert.strictEqual(button.classList.contains("active"), false);

  await button.dispatch("click");
  assert.deepStrictEqual(chat.calls.setShowUserMessages, [true]);

  chat.applyState({ lang: "zh", messages: [], showUserMessages: true });
  assert.strictEqual(app.classList.contains("chat-hide-user"), false);
  assert.strictEqual(button.textContent, "隐藏我的消息");
  assert.strictEqual(button.getAttribute("aria-pressed"), "true");
  assert.strictEqual(button.classList.contains("active"), true);
});

test("user, assistant, tool and system messages all render, hidden users stay in the DOM", async () => {
  const chat = await loadChat();
  chat.applyState({
    lang: "zh",
    showUserMessages: false,
    messages: [
      { id: "u1", role: "user", text: "我的问题" },
      { id: "a1", role: "assistant", text: "回答" },
      { id: "t1", role: "assistant", kind: "tool", toolName: "Read", status: "done", resultText: "ok" },
      { id: "s1", role: "system", text: "一条提示" },
    ],
  });

  assert.strictEqual(chat.find("chat-msg-user").length, 1);
  assert.strictEqual(chat.find("chat-msg-tool").length, 1);
  assert.strictEqual(chat.find("chat-msg-system").length, 1);
  // 助手节点含普通回复 + 工具卡
  assert.strictEqual(chat.find("chat-msg-assistant").length, 2);
  // 自己的消息只是被样式隐藏，节点仍在
  assert.ok(chat.one("chat-msg-user"), "hidden user message keeps its node");
});

test("empty hint shows only when no visible message remains", async () => {
  const chat = await loadChat();
  const empty = chat.one("chat-empty");

  chat.applyState({
    lang: "zh",
    showUserMessages: false,
    messages: [{ id: "u1", role: "user", text: "只有我自己的话" }],
  });
  assert.strictEqual(empty.hidden, false, "a lone hidden user message leaves the panel empty");

  chat.applyState({
    lang: "zh",
    showUserMessages: false,
    messages: [
      { id: "u1", role: "user", text: "只有我自己的话" },
      { id: "a1", role: "assistant", text: "有回复了" },
    ],
  });
  assert.strictEqual(empty.hidden, true);

  // 打开「显示我的消息」后，先前那条用户消息就算可见内容
  chat.applyState({
    lang: "zh",
    showUserMessages: true,
    messages: [{ id: "u1", role: "user", text: "只有我自己的话" }],
  });
  assert.strictEqual(empty.hidden, true);
});

test("a language switch re-labels the reused nodes", async () => {
  const chat = await loadChat();
  chat.applyState({ lang: "zh", messages: [] });
  const button = chat.one("chat-show-user-button");
  const empty = chat.one("chat-empty");
  assert.strictEqual(button.textContent, "显示我的消息");
  assert.strictEqual(empty.textContent, "给 Claude 发一条消息，开始对话。");
  assert.strictEqual(chat.document.title, "Clawd 对话");

  chat.applyState({ lang: "en", messages: [] });
  assert.strictEqual(chat.one("chat-show-user-button"), button, "the button node is reused");
  assert.strictEqual(chat.one("chat-empty"), empty, "the empty node is reused");
  assert.strictEqual(button.textContent, "Show my messages");
  assert.strictEqual(empty.textContent, "Ask Claude something to start the conversation.");
  assert.strictEqual(chat.document.title, "Clawd Chat");
});
