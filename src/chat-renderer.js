"use strict";

// 内置 Claude 对话窗口——渲染端
//
// 数据流：主进程把「完整状态快照」经 chat:update 推送，本文件只做三件事：
//   1) 把快照调和（reconcile）成 DOM：消息按 id 复用节点，流式文本原地更新；
//   2) 把用户操作转成 window.chatAPI 调用（发送 / 停止 / 新会话 / 选目录 / 两个下拉）；
//   3) 所有可见文案走 globalThis.ClawdChatI18n（t(key)）；语言取快照里的 state.lang，
//      主进程没带 lang 时用系统语言（navigator.language）兜底，再不行用中文。
//
// 依赖：chat.html 先加载 chat-i18n.js，再加载本文件；preload 暴露 window.chatAPI。

(function initChatRenderer(root) {
  const i18n = root.ClawdChatI18n || {};
  const STRINGS = i18n.STRINGS || { en: {} };
  const LANG_KEYS = Object.keys(STRINGS);
  const FALLBACK_LANG = "zh";

  // 状态 → 状态栏文案
  const STATUS_KEYS = {
    idle: "chatStatusIdle",
    starting: "chatStatusStarting",
    thinking: "chatStatusThinking",
    streaming: "chatStatusStreaming",
    tool: "chatStatusTool",
    error: "chatStatusError",
  };
  // 工具卡片状态 → 图标（纯符号，不依赖字体 emoji）
  const TOOL_ICONS = { running: "●", done: "✓", denied: "!", error: "✕" };
  const TOOL_STATUS_KEYS = {
    running: "chatToolRunning",
    done: "chatToolDone",
    denied: "chatToolDenied",
    error: "chatToolError",
  };
  const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];
  const EFFORT_LABEL_KEYS = {
    low: "chatEffortLow",
    medium: "chatEffortMedium",
    high: "chatEffortHigh",
    xhigh: "chatEffortXhigh",
    max: "chatEffortMax",
  };
  const MODE_VALUES = ["default", "acceptEdits", "plan", "auto"];
  const MODE_LABEL_KEYS = {
    default: "chatModeDefault",
    acceptEdits: "chatModeAcceptEdits",
    plan: "chatModePlan",
    auto: "chatModeAuto",
  };

  let lang = null;             // 当前渲染语言（en/zh/zh-TW/ko/ja/pt-BR/es）
  let state = null;            // 最近一次应用的状态快照
  let hasAppliedState = false; // 是否已应用过任何快照（防止 getState 的迟到旧值覆盖推送）
  let localErrorSeq = 0;
  const localErrors = [];      // 渲染端自身操作失败（invoke 异常）产生的提示
  const entries = new Map();   // 消息 id → 已渲染节点信息（增量更新用）

  const els = {};

  // ── 小工具 ─────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function t(key) {
    const dict = (lang && STRINGS[lang]) || {};
    if (dict[key] != null) return dict[key];
    if (STRINGS.en && STRINGS.en[key] != null) return STRINGS.en[key];
    return key;
  }

  // 主进程给的 lang 可能是 "zh-tw" / "pt-br" 这类大小写变体，也可能是系统区域串。
  function normalizeLang(value) {
    if (typeof value !== "string" || !value) return null;
    const raw = value.trim();
    if (!raw) return null;
    if (Object.prototype.hasOwnProperty.call(STRINGS, raw)) return raw;
    const lower = raw.toLowerCase();
    for (const key of LANG_KEYS) {
      if (key.toLowerCase() === lower) return key;
    }
    // 系统区域 → 应用语言（与 src/prefs.js 的 mapLocaleToLang 保持一致）
    const l = lower.replace(/_/g, "-");
    if (l === "zh" || l.startsWith("zh-")) {
      if (/hant/.test(l) || /^zh-(tw|hk|mo)\b/.test(l)) return "zh-TW";
      return "zh";
    }
    if (l === "ko" || l.startsWith("ko-")) return "ko";
    if (l === "ja" || l.startsWith("ja-")) return "ja";
    if (l === "pt-br") return "pt-BR";
    if (l === "es" || l.startsWith("es-")) return "es";
    return "en";
  }

  function resolveLang(candidate) {
    const direct = normalizeLang(candidate);
    if (direct) return direct;
    const nav = root.navigator || {};
    const systemLang = nav.language || (Array.isArray(nav.languages) && nav.languages[0]) || "";
    return normalizeLang(systemLang) || FALLBACK_LANG;
  }

  // 主进程推送的 system notice 可能是 i18n 键名（用于跨语言提示），能翻译就翻译。
  function localizeText(text) {
    if (typeof text !== "string") return "";
    if (STRINGS.en && Object.prototype.hasOwnProperty.call(STRINGS.en, text)) return t(text);
    return text;
  }

  function errorText(err) {
    if (err && typeof err.message === "string" && err.message) return err.message;
    return String(err == null ? "unknown error" : err);
  }

  function addLocalError(text) {
    localErrorSeq += 1;
    localErrors.push({
      id: "local-error-" + localErrorSeq,
      role: "system",
      kind: "error",
      text: String(text),
    });
    if (localErrors.length > 3) localErrors.splice(0, localErrors.length - 3);
    renderMessages(true);
  }

  function shortenPath(p) {
    if (typeof p !== "string" || !p) return "";
    if (p.length <= 42) return p;
    const parts = p.split(/[\\/]/).filter(Boolean);
    const tail = parts.slice(-2).join("/");
    return tail ? "…/" + tail : p;
  }

  // ── 构建界面 ───────────────────────────────────────────

  function buildUi(mount) {
    els.app = el("div", "chat-app");

    // 顶部工具条：工作目录 / 思考强度 / 权限模式 / 新会话
    const toolbar = el("header", "chat-toolbar");

    const dirGroup = el("div", "chat-toolbar-group chat-dir-group");
    els.dirLabel = el("span", "chat-field-label");
    els.dirButton = el("button", "chat-dir-button");
    els.dirButton.type = "button";
    els.dirButton.addEventListener("click", () => callApi("pickWorkingDir"));
    dirGroup.appendChild(els.dirLabel);
    dirGroup.appendChild(els.dirButton);

    const effortGroup = el("div", "chat-toolbar-group");
    els.effortLabel = el("span", "chat-field-label");
    els.effortSelect = el("select", "chat-select chat-effort-select");
    els.effortOptions = new Map();
    for (const value of EFFORT_VALUES) {
      const option = el("option", "", "");
      option.value = value;
      els.effortOptions.set(value, option);
      els.effortSelect.appendChild(option);
    }
    els.effortSelect.addEventListener("change", () => callApi("setEffort", els.effortSelect.value));
    effortGroup.appendChild(els.effortLabel);
    effortGroup.appendChild(els.effortSelect);

    const modeGroup = el("div", "chat-toolbar-group");
    els.modeLabel = el("span", "chat-field-label");
    els.modeSelect = el("select", "chat-select chat-mode-select");
    els.modeOptions = new Map();
    for (const value of MODE_VALUES) {
      const option = el("option", "", "");
      option.value = value;
      els.modeOptions.set(value, option);
      els.modeSelect.appendChild(option);
    }
    els.modeSelect.addEventListener("change", () => callApi("setPermissionMode", els.modeSelect.value));
    modeGroup.appendChild(els.modeLabel);
    modeGroup.appendChild(els.modeSelect);

    els.newSessionButton = el("button", "chat-new-session-button");
    els.newSessionButton.type = "button";
    els.newSessionButton.addEventListener("click", () => callApi("newSession"));

    toolbar.appendChild(dirGroup);
    toolbar.appendChild(effortGroup);
    toolbar.appendChild(modeGroup);
    toolbar.appendChild(els.newSessionButton);

    // 状态栏
    els.statusBar = el("div", "chat-status-bar");
    els.statusBar.setAttribute("role", "status");
    els.statusDot = el("span", "chat-status-dot", "");
    els.statusDot.setAttribute("aria-hidden", "true");
    els.statusText = el("span", "chat-status-text", "");
    els.statusBar.appendChild(els.statusDot);
    els.statusBar.appendChild(els.statusText);

    // 消息区
    els.scroll = el("div", "chat-scroll");
    els.empty = el("div", "chat-empty", "");
    els.messages = el("div", "chat-messages");
    els.messages.setAttribute("role", "log");
    els.messages.setAttribute("aria-live", "polite");
    els.scroll.appendChild(els.empty);
    els.scroll.appendChild(els.messages);

    // 输入区
    els.form = el("form", "chat-composer");
    els.input = el("textarea", "chat-input");
    els.input.rows = 1;
    els.input.addEventListener("input", () => {
      autosizeInput();
      updateComposer();
    });
    els.input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey) return;
      // 中文等输入法组合期间的回车只用于选词，不发送（keyCode 229 是 IME 兼容判断）
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      submitInput();
    });
    els.sendButton = el("button", "chat-send-button");
    els.sendButton.type = "submit";
    els.stopButton = el("button", "chat-stop-button");
    els.stopButton.type = "button";
    els.stopButton.hidden = true;
    els.stopButton.addEventListener("click", () => callApi("stop"));
    els.form.addEventListener("submit", (event) => {
      event.preventDefault();
      submitInput();
    });
    els.form.appendChild(els.input);
    els.form.appendChild(els.sendButton);
    els.form.appendChild(els.stopButton);

    els.hint = el("div", "chat-composer-hint", "");
    els.hint.hidden = true;

    els.app.appendChild(toolbar);
    els.app.appendChild(els.statusBar);
    els.app.appendChild(els.scroll);
    els.app.appendChild(els.form);
    els.app.appendChild(els.hint);

    if (mount !== document.body && mount.childNodes.length > 0) mount.textContent = "";
    mount.appendChild(els.app);
  }

  // ── 静态文案 ───────────────────────────────────────────

  function refreshStaticText() {
    document.title = t("chatTitle");
    els.dirLabel.textContent = t("chatDirLabel");
    els.effortLabel.textContent = t("chatEffortLabel");
    els.modeLabel.textContent = t("chatModeLabel");
    els.newSessionButton.textContent = t("chatNewSession");
    els.sendButton.textContent = t("chatSend");
    els.stopButton.textContent = t("chatStop");
    els.input.placeholder = t("chatInputPlaceholder");
    els.input.setAttribute("aria-label", t("chatInputPlaceholder"));
    els.empty.textContent = t("chatEmptyHint");
    els.hint.textContent = t("chatNoDirHint");
    for (const value of EFFORT_VALUES) {
      els.effortOptions.get(value).textContent = t(EFFORT_LABEL_KEYS[value]);
    }
    for (const value of MODE_VALUES) {
      els.modeOptions.get(value).textContent = t(MODE_LABEL_KEYS[value]);
    }
  }

  function applyToolbar() {
    const cwd = state && typeof state.cwd === "string" ? state.cwd : "";
    els.dirButton.textContent = cwd ? shortenPath(cwd) : t("chatPickDir");
    els.dirButton.title = cwd || t("chatPickDir");
    els.dirButton.classList.toggle("has-dir", !!cwd);
    if (state && EFFORT_VALUES.includes(state.effort)) els.effortSelect.value = state.effort;
    if (state && MODE_VALUES.includes(state.permissionMode)) els.modeSelect.value = state.permissionMode;
  }

  function applyStatus() {
    const status = state && typeof state.status === "string" ? state.status : "idle";
    els.statusBar.dataset.status = status;
    els.statusBar.classList.toggle("busy", !!(state && state.busy));
    els.statusText.textContent = t(STATUS_KEYS[status] || "chatStatusIdle");
  }

  function updateComposer() {
    const hasDir = !!(state && state.cwd);
    const busy = !!(state && state.busy);
    els.input.disabled = !hasDir;
    els.sendButton.disabled = busy || !hasDir || !els.input.value.trim();
    els.stopButton.hidden = !busy;
    els.hint.hidden = !state || hasDir;
  }

  function autosizeInput() {
    els.input.style.height = "auto";
    els.input.style.height = Math.min(els.input.scrollHeight, 160) + "px";
  }

  // ── 消息渲染（按 id 增量调和）───────────────────────────

  function visibleMessages() {
    const list = [];
    if (state && Array.isArray(state.messages)) list.push(...state.messages);
    list.push(...localErrors);
    return list;
  }

  function shapeOf(msg) {
    if (msg.role === "assistant" && msg.kind === "tool") return "tool";
    if (msg.role === "system") return msg.kind === "error" ? "system-error" : "system-notice";
    return msg.role === "user" ? "text-user" : "text-assistant";
  }

  function createEntry(shape) {
    if (shape === "tool") {
      const wrap = el("div", "chat-msg chat-msg-assistant chat-msg-tool");
      const card = el("div", "chat-tool-card");
      const head = el("button", "chat-tool-head");
      head.type = "button";
      const icon = el("span", "chat-tool-icon", "");
      const name = el("span", "chat-tool-name", "");
      const summary = el("span", "chat-tool-summary", "");
      const status = el("span", "chat-tool-status", "");
      head.appendChild(icon);
      head.appendChild(name);
      head.appendChild(summary);
      head.appendChild(status);
      const result = el("pre", "chat-tool-result", "");
      result.hidden = true;
      card.appendChild(head);
      card.appendChild(result);
      wrap.appendChild(card);
      const entry = {
        shape,
        el: wrap,
        kind: "tool",
        card,
        head,
        icon,
        name,
        summary,
        status,
        result,
        expanded: false,
        hasResult: false,
        lastMsg: null,
      };
      head.addEventListener("click", () => {
        if (!entry.hasResult) return;
        entry.expanded = !entry.expanded;
        applyToolEntry(entry, entry.lastMsg);
      });
      return entry;
    }

    if (shape === "system-error" || shape === "system-notice") {
      const isError = shape === "system-error";
      const wrap = el("div", "chat-msg chat-msg-system " + (isError ? "chat-error" : "chat-notice"));
      const entry = { shape, el: wrap, kind: "system", prefixEl: null, textEl: el("span", "chat-text", "") };
      if (isError) {
        entry.prefixEl = el("span", "chat-error-prefix", "");
        wrap.appendChild(entry.prefixEl);
      }
      wrap.appendChild(entry.textEl);
      return entry;
    }

    const isUser = shape === "text-user";
    const wrap = el("div", "chat-msg " + (isUser ? "chat-msg-user" : "chat-msg-assistant"));
    const bubble = el("div", "chat-bubble");
    const textEl = el("span", "chat-text", "");
    bubble.appendChild(textEl);
    wrap.appendChild(bubble);
    return { shape, el: wrap, kind: "text", bubble, textEl, cursor: null };
  }

  function applyToolEntry(entry, msg) {
    if (!msg) return;
    entry.lastMsg = msg;
    const status = TOOL_STATUS_KEYS[msg.status] ? msg.status : "running";
    entry.card.dataset.status = status;
    entry.icon.textContent = TOOL_ICONS[status] || TOOL_ICONS.running;
    entry.name.textContent = msg.toolName || "";
    entry.summary.textContent = typeof msg.summary === "string" ? msg.summary : "";
    entry.summary.hidden = !entry.summary.textContent;
    entry.status.textContent = t(TOOL_STATUS_KEYS[status]);
    const hasResult = typeof msg.resultText === "string" && msg.resultText.length > 0;
    entry.hasResult = hasResult;
    if (!hasResult) entry.expanded = false;
    entry.head.disabled = !hasResult;
    entry.head.setAttribute("aria-expanded", entry.expanded ? "true" : "false");
    entry.head.title = hasResult ? t(entry.expanded ? "chatToolCollapse" : "chatToolExpand") : "";
    entry.result.textContent = hasResult ? msg.resultText : "";
    entry.result.hidden = !(hasResult && entry.expanded);
  }

  function applyEntry(entry, msg) {
    if (entry.kind === "tool") {
      applyToolEntry(entry, msg);
      return;
    }
    if (entry.kind === "system") {
      if (entry.prefixEl) entry.prefixEl.textContent = t("chatErrorPrefix");
      entry.textEl.textContent = localizeText(msg.text);
      return;
    }
    // 文本消息：只更新文本节点内容，避免整段重建打断选中
    entry.textEl.textContent = typeof msg.text === "string" ? msg.text : "";
    if (msg.streaming) {
      if (!entry.cursor) {
        entry.cursor = el("span", "chat-cursor", "");
        entry.cursor.setAttribute("aria-hidden", "true");
        entry.bubble.appendChild(entry.cursor);
      }
    } else if (entry.cursor) {
      entry.cursor.remove();
      entry.cursor = null;
    }
  }

  // chat.css 可能把滚动放在外层 .chat-scroll，也可能放在 .chat-messages；
  // 运行时挑真正溢出（可滚动）的那一个，两边都兼容。
  function scrollBox() {
    for (const box of [els.scroll, els.messages]) {
      if (box && box.scrollHeight > box.clientHeight + 1) return box;
    }
    return els.scroll;
  }

  function isNearBottom() {
    const box = scrollBox();
    if (!box) return true;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  }

  function renderMessages(forceScroll) {
    const list = visibleMessages();
    const stick = forceScroll === true || isNearBottom();
    const seen = new Set();

    list.forEach((msg, index) => {
      const id = msg && msg.id != null ? String(msg.id) : "__index-" + index;
      const shape = shapeOf(msg || {});
      let entry = entries.get(id);
      if (!entry || entry.shape !== shape) {
        const replacement = createEntry(shape);
        if (entry) {
          entry.el.replaceWith(replacement.el);
        }
        entry = replacement;
        entries.set(id, entry);
      }
      applyEntry(entry, msg);
      seen.add(id);
      // 顺序保证：第 index 个消息节点必须是当前 entry 的节点
      const expected = els.messages.children[index] || null;
      if (entry.el !== expected) {
        els.messages.insertBefore(entry.el, expected);
      }
    });

    for (const [id, entry] of entries) {
      if (!seen.has(id)) {
        entry.el.remove();
        entries.delete(id);
      }
    }

    els.empty.hidden = list.length > 0;
    if (stick) {
      const box = scrollBox();
      if (box) box.scrollTop = box.scrollHeight;
    }
  }

  // ── 状态应用与 API 调用 ────────────────────────────────

  function applyState(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    hasAppliedState = true;
    const nextLang = resolveLang(snapshot.lang);
    const langChanged = nextLang !== lang;
    lang = nextLang;
    state = snapshot;
    if (langChanged) refreshStaticText();
    applyToolbar();
    applyStatus();
    updateComposer();
    renderMessages(false);
  }

  function callApi(method, ...args) {
    const api = root.chatAPI;
    if (!api || typeof api[method] !== "function") {
      console.warn("chat: chatAPI." + method + " is unavailable");
      addLocalError("chatAPI." + method + " is unavailable");
      return;
    }
    let result;
    try {
      result = api[method](...args);
    } catch (err) {
      console.warn("chat: " + method + " failed", err);
      addLocalError(errorText(err));
      return;
    }
    if (result && typeof result.catch === "function") {
      result.catch((err) => {
        console.warn("chat: " + method + " failed", err);
        addLocalError(errorText(err));
      });
    }
  }

  function submitInput() {
    const text = els.input.value.trim();
    if (!text) return;
    const hasDir = !!(state && state.cwd);
    const busy = !!(state && state.busy);
    if (!hasDir || busy) return;
    const api = root.chatAPI;
    if (!api || typeof api.send !== "function") {
      console.warn("chat: chatAPI.send is unavailable");
      addLocalError("chatAPI.send is unavailable");
      return;
    }
    let result;
    try {
      result = api.send(text);
    } catch (err) {
      console.warn("chat: send failed", err);
      addLocalError(errorText(err));
      return;
    }
    els.input.value = "";
    autosizeInput();
    updateComposer();
    if (result && typeof result.catch === "function") {
      result.catch((err) => {
        console.warn("chat: send failed", err);
        // 发送失败就把用户输入还回去，避免打字内容丢失
        if (!els.input.value) {
          els.input.value = text;
          autosizeInput();
          updateComposer();
        }
        addLocalError(errorText(err));
      });
    }
  }

  // ── 启动 ───────────────────────────────────────────────

  function boot() {
    const mount =
      document.getElementById("chatApp") ||
      document.getElementById("app") ||
      document.getElementById("root") ||
      document.body;
    lang = resolveLang(null);
    buildUi(mount);
    refreshStaticText();
    applyStatus();
    updateComposer();
    renderMessages(true);

    const api = root.chatAPI;
    if (!api) {
      console.warn("chat: window.chatAPI is unavailable; the chat UI stays read-only.");
      return;
    }
    if (typeof api.onUpdate === "function") {
      api.onUpdate((snapshot) => applyState(snapshot));
    }
    if (typeof api.getState === "function") {
      Promise.resolve(api.getState())
        .then((snapshot) => {
          // 订阅期间若已收到推送，就不再用可能更旧的 getState 快照覆盖
          if (!hasAppliedState) applyState(snapshot);
        })
        .catch((err) => {
          console.warn("chat: getState failed", err);
          addLocalError(errorText(err));
        });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(globalThis);
