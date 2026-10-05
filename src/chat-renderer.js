"use strict";

// 内置 Claude 对话窗口——渲染端
//
// 数据流：主进程把「完整状态快照」经 chat:update 推送，本文件只做三件事：
//   1) 把快照调和（reconcile）成 DOM：消息按 id 复用节点，流式文本原地更新；
//   2) 把用户操作转成 window.chatAPI 调用（发送 / 停止 / 新会话 / 选目录 / 两个下拉 /
//      选附件 / 拖拽文件 / 列斜杠指令）；
//   3) 所有可见文案走 globalThis.ClawdChatI18n（t(key)）；语言取快照里的 state.lang，
//      主进程没带 lang 时用系统语言（navigator.language）兜底，再不行用中文。
//
// 附件：托盘里的图片在发送前用 canvas 压到最长边 96px 的 data URL 作为 thumb，
// 随 send(text, attachments) 一起交给主进程；气泡只认消息对象里的 attachments 元数据。
//
// 正文渲染：助手与用户消息走手写 Markdown 子集（围栏代码块 / 行内 code / 加粗 /
// 标题 / 列表 / 引用 / http(s) 链接），只建 DOM 不用 innerHTML；工具卡片在消息
// 带 diff 时多一块对照区；输入框支持粘贴图片（chatAPI.savePastedImage）。
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

  // 斜杠指令：state.commands 为空时用的内置兜底（名字固定，描述走 i18n 键）。
  const BUILTIN_COMMANDS = [
    { name: "/compact", description: "chatCmdCompactDesc" },
    { name: "/clear", description: "chatCmdClearDesc" },
    { name: "/help", description: "chatCmdHelpDesc" },
  ];
  const COMMAND_LIMIT = 8;      // 弹层最多显示的候选条数
  const THUMB_MAX_SIDE = 96;    // 发送前图片压缩后的最长边（px）
  const DIFF_PREVIEW_LINES = 6;   // 工具卡片 diff 折叠时显示的行数
  const COPY_FEEDBACK_MS = 1400;  // 代码块「已复制」反馈的停留时长
  const SVG_NS = "http://www.w3.org/2000/svg";
  // 纯线条图标（Feather 风格路径），避免依赖字体 emoji。
  const PAPERCLIP_PATHS = [
    "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
  ];
  const FILE_ICON_PATHS = ["M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z", "M13 2v7h7"];

  let lang = null;             // 当前渲染语言（en/zh/zh-TW/ko/ja/pt-BR/es）
  let state = null;            // 最近一次应用的状态快照
  let hasAppliedState = false; // 是否已应用过任何快照（防止 getState 的迟到旧值覆盖推送）
  let localErrorSeq = 0;
  let resumePending = false;   // 正在恢复历史会话：invoke 落地前本窗口禁用输入
  let historyStatus = null;    // 历史浮层状态：loading / empty / error / list
  let historyRows = [];        // 最近一次成功加载的历史列表
  let historyLoadSeq = 0;      // 在途加载序号：关闭或重开浮层后丢弃过期结果
  let commandsCache = [];      // chatAPI.listCommands() 的结果（state 推送为空时兜底）
  let commandMatches = [];     // 弹层当前显示的候选（已截断到 COMMAND_LIMIT）
  let commandIndex = 0;        // 键盘选中的候选下标
  let dragDepth = 0;           // 文件拖拽进出计数：>0 时显示拖拽高亮
  let sendPending = false;     // send invoke 在途：防连点重复提交
  const trayItems = [];        // 待发送附件：{path,name,size,isImage,sourceUrl,file}
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

  // params 用于相对时间里的 {n} 占位符；只有命中真实文案时才替换，
  // 兜底返回键名时保持原样（方便在界面上直接看出缺失的键）。
  function t(key, params) {
    const dict = (lang && STRINGS[lang]) || {};
    let text = dict[key];
    if (text == null && STRINGS.en) text = STRINGS.en[key];
    if (text == null) return key;
    text = String(text);
    if (params) {
      for (const name of Object.keys(params)) {
        text = text.split("{" + name + "}").join(String(params[name]));
      }
    }
    return text;
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

  function basenameOf(p) {
    if (typeof p !== "string" || !p) return "";
    const parts = p.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  }

  // 附件大小：B / KB / MB / GB 自适应，小数值保留一位小数。
  function formatSize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n < 0) return "";
    if (n < 1024) return Math.round(n) + " B";
    const kb = n / 1024;
    if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + " KB";
    const mb = kb / 1024;
    if (mb < 1024) return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + " MB";
    const gb = mb / 1024;
    return (gb < 10 ? gb.toFixed(1) : String(Math.round(gb))) + " GB";
  }

  function svgIcon(paths, className) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  // 判断一次拖拽是否带着文件（纯文字拖拽不接管）。
  function isFileDrag(event) {
    const dt = event && event.dataTransfer;
    const types = dt && dt.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i += 1) {
      if (types[i] === "Files") return true;
    }
    return false;
  }

  // ── Markdown 子集渲染 ──────────────────────────────────
  //
  // 手写解析：只把原始文本切成块与行内片段，再用 createElement / createTextNode
  // 逐个建 DOM，绝不 innerHTML 直插消息原文（正文内容可被模型或用户输入控制）。
  // 支持：围栏代码块（含流式未闭合的）、行内 `code`、**加粗**、#/##/### 标题、
  // - / 1. 列表、> 引用、[文字](http(s)://…) 与裸 http(s):// 链接。
  // 不认识的语法按普通文本显示；段落内的换行用 <br> 保留。

  const FENCE_LINE_RE = /^\s{0,3}`{3,}\s*([^\s`]*)\s*$/;
  const LIST_LINE_RE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
  const QUOTE_LINE_RE = /^\s{0,3}>/;
  const HEADING_LINE_RE = /^(#{1,3})\s+(.*)$/;
  // 行内片段：换行 / `code` / **加粗** / [文字](http(s)链接) / 裸 http(s) 链接。
  const INLINE_RE = /\n|`([^`\n]+)`|\*\*([^\n]+?)\*\*|\[([^\]\n]*)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"'`]+)/g;
  // 光标可以贴在这些块内部的末尾（代码块等块级容器则另起一行）。
  const CURSOR_HOST_TAGS = { p: 1, h1: 1, h2: 1, h3: 1, blockquote: 1, li: 1 };

  function matchFenceLine(line) {
    const match = FENCE_LINE_RE.exec(String(line));
    if (!match) return null;
    return { lang: (match[1] || "").slice(0, 20) };
  }

  function isFenceClose(line) {
    return /^\s{0,3}`{3,}\s*$/.test(String(line));
  }

  function appendTextNode(container, text) {
    if (!text) return;
    container.appendChild(document.createTextNode(text));
  }

  // 裸链接尾部常带句读或右括号（英文写作习惯），剪掉不影响可见文本。
  function trimUrlTail(url) {
    let end = url.length;
    while (end > 0) {
      const ch = url.charAt(end - 1);
      if (".,;:!?".indexOf(ch) >= 0) {
        end -= 1;
        continue;
      }
      if (ch === ")") {
        const head = url.slice(0, end);
        const opens = (head.match(/\(/g) || []).length;
        const closes = (head.match(/\)/g) || []).length;
        if (closes > opens) {
          end -= 1;
          continue;
        }
      }
      break;
    }
    return url.slice(0, end);
  }

  // 链接只认 http(s)：不用 <a href>（避免中键 / 意外导航把窗口带走），
  // 点击或回车走 chatAPI.openExternal；其他协议原样当文本。
  function buildLink(label, url) {
    const safe = typeof url === "string" && /^https?:\/\//i.test(url) && url.indexOf("//") + 2 < url.length
      ? url
      : "";
    if (!safe) return document.createTextNode(String(label));
    const link = el("span", "chat-link", String(label));
    link.setAttribute("role", "link");
    link.setAttribute("tabindex", "0");
    link.title = safe;
    const open = () => callApi("openExternal", safe);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      open();
    });
    link.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    return link;
  }

  // 剪贴板 API 不可用（或无权限）时的兜底：临时 textarea + execCommand("copy")。
  function copyViaTextarea(text) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      if (typeof area.select === "function") area.select();
      const ok = typeof document.execCommand === "function" ? document.execCommand("copy") : false;
      area.remove();
      return !!ok;
    } catch (err) {
      console.warn("chat: fallback copy failed", err);
      return false;
    }
  }

  function copyTextToClipboard(text) {
    return new Promise((resolve) => {
      const clipboard = root.navigator && root.navigator.clipboard;
      if (clipboard && typeof clipboard.writeText === "function") {
        Promise.resolve(clipboard.writeText(text)).then(
          () => resolve(true),
          (err) => {
            console.warn("chat: clipboard.writeText failed", err);
            resolve(copyViaTextarea(text));
          },
        );
        return;
      }
      resolve(copyViaTextarea(text));
    });
  }

  // 围栏代码块：语言小标 + 右上角复制按钮；复制的是去掉围栏后的原文。
  function buildCodeBlock(lang, code) {
    const wrap = el("div", "chat-code-block");
    const head = el("div", "chat-code-head");
    const langEl = el("span", "chat-code-lang", lang || "");
    if (lang) langEl.title = lang;
    const copy = el("button", "chat-code-copy", t("chatCopyCode"));
    copy.type = "button";
    copy.setAttribute("aria-label", t("chatCopyCode"));
    let timer = null;
    copy.addEventListener("click", () => {
      copyTextToClipboard(code).then((ok) => {
        if (!ok) return;
        copy.textContent = t("chatCopied");
        copy.classList.add("copied");
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          copy.textContent = t("chatCopyCode");
          copy.classList.remove("copied");
        }, COPY_FEEDBACK_MS);
      });
    });
    head.appendChild(langEl);
    head.appendChild(copy);
    const pre = el("pre", "chat-code");
    pre.textContent = code;
    wrap.appendChild(head);
    wrap.appendChild(pre);
    return wrap;
  }

  // 行内渲染：按出现顺序切分，普通片段走文本节点，其余建行内元素。
  function renderInline(container, text) {
    const source = String(text == null ? "" : text);
    let last = 0;
    let match;
    INLINE_RE.lastIndex = 0;
    while ((match = INLINE_RE.exec(source)) !== null) {
      if (match.index > last) appendTextNode(container, source.slice(last, match.index));
      if (match[0] === "\n") {
        container.appendChild(document.createElement("br"));
      } else if (match[1] != null) {
        container.appendChild(el("code", "chat-inline-code", match[1]));
      } else if (match[2] != null) {
        container.appendChild(el("strong", "chat-bold", match[2]));
      } else if (match[3] != null) {
        container.appendChild(buildLink(match[3].trim() ? match[3] : match[4], match[4]));
      } else if (match[4] != null || match[5] != null) {
        const raw = match[4] != null ? match[4] : match[5];
        const url = trimUrlTail(raw);
        container.appendChild(buildLink(url, url));
        if (url.length < raw.length) appendTextNode(container, raw.slice(url.length));
      }
      last = match.index + match[0].length;
    }
    if (last < source.length) appendTextNode(container, source.slice(last));
  }

  // 块级渲染：逐行扫描，返回后 container 里是完整的块序列。
  // 遇到没等到结束围栏的代码块（流式输出中）也按代码块渲染，避免闪断成普通文本。
  function renderMarkdownInto(container, text) {
    container.textContent = "";
    const lines = String(text == null ? "" : text).split(/\r\n|\r|\n/);
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const fence = matchFenceLine(line);
      if (fence) {
        const code = [];
        i += 1;
        while (i < lines.length) {
          if (isFenceClose(lines[i])) {
            i += 1;
            break;
          }
          code.push(lines[i]);
          i += 1;
        }
        container.appendChild(buildCodeBlock(fence.lang, code.join("\n")));
        continue;
      }
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const heading = HEADING_LINE_RE.exec(line);
      if (heading) {
        const level = heading[1].length;
        const node = el("h" + level, "chat-md-heading chat-md-h" + level);
        renderInline(node, heading[2]);
        container.appendChild(node);
        i += 1;
        continue;
      }
      const item = LIST_LINE_RE.exec(line);
      if (item) {
        const ordered = /^\d+\.$/.test(item[2]);
        const list = el(ordered ? "ol" : "ul", "chat-md-list");
        while (i < lines.length) {
          const next = LIST_LINE_RE.exec(lines[i]);
          if (!next || /^\d+\.$/.test(next[2]) !== ordered) break;
          const li = el("li", "chat-md-li");
          renderInline(li, next[3]);
          list.appendChild(li);
          i += 1;
        }
        container.appendChild(list);
        continue;
      }
      if (QUOTE_LINE_RE.test(line)) {
        const parts = [];
        while (i < lines.length && QUOTE_LINE_RE.test(lines[i])) {
          parts.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
          i += 1;
        }
        const quote = el("blockquote", "chat-md-quote");
        renderInline(quote, parts.join("\n"));
        container.appendChild(quote);
        continue;
      }
      // 段落：连续的非空、非其他块起始行；行内换行用 <br> 保留。
      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !matchFenceLine(lines[i]) &&
        !HEADING_LINE_RE.test(lines[i]) &&
        !LIST_LINE_RE.test(lines[i]) &&
        !QUOTE_LINE_RE.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i += 1;
      }
      const para = el("p", "chat-md-p");
      renderInline(para, paraLines.join("\n"));
      container.appendChild(para);
    }
  }

  // 流式光标跟着最后一段正文；最后一块是代码块等块级容器时只能另起一行。
  function cursorHost(container) {
    const last = container && container.lastElementChild;
    if (!last) return container;
    const tag = String(last.tagName || "").toLowerCase();
    return CURSOR_HOST_TAGS[tag] ? last : container;
  }

  function placeCursor(entry) {
    if (!entry.cursor || !entry.textEl) return;
    cursorHost(entry.textEl).appendChild(entry.cursor);
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
    els.newSessionButton.addEventListener("click", () => {
      closeHistoryPopover();
      callApi("newSession");
    });

    // 「历史」按钮 + 历史会话浮层：列出当前工作目录下可恢复的对话
    els.historyWrap = el("div", "chat-history-wrap");
    els.historyButton = el("button", "chat-history-button");
    els.historyButton.type = "button";
    els.historyButton.setAttribute("aria-haspopup", "true");
    els.historyButton.setAttribute("aria-expanded", "false");
    els.historyButton.addEventListener("click", () => toggleHistoryPopover());

    els.historyPopover = el("div", "chat-history-popover");
    els.historyPopover.hidden = true;
    els.historyStatus = el("div", "chat-history-status");
    els.historySpinner = el("span", "chat-history-spinner", "");
    els.historySpinner.setAttribute("aria-hidden", "true");
    els.historyStatusText = el("span", "chat-history-status-text", "");
    els.historyStatus.appendChild(els.historySpinner);
    els.historyStatus.appendChild(els.historyStatusText);
    els.historyList = el("div", "chat-history-list");
    els.historyPopover.appendChild(els.historyStatus);
    els.historyPopover.appendChild(els.historyList);
    els.historyWrap.appendChild(els.historyButton);
    els.historyWrap.appendChild(els.historyPopover);

    const actions = el("div", "chat-toolbar-actions");
    actions.appendChild(els.historyWrap);
    actions.appendChild(els.newSessionButton);

    toolbar.appendChild(dirGroup);
    toolbar.appendChild(effortGroup);
    toolbar.appendChild(modeGroup);
    toolbar.appendChild(actions);

    // 点浮层外面 / 按 Esc 关闭历史列表
    document.addEventListener("click", (event) => {
      if (els.historyPopover.hidden) return;
      const target = event.target;
      if (target && els.historyWrap.contains(target)) return;
      closeHistoryPopover();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !els.historyPopover.hidden) closeHistoryPopover();
    });
    // 点指令弹层和输入框以外的区域时关闭弹层
    document.addEventListener("click", (event) => {
      if (els.commandPopover.hidden) return;
      const target = event.target;
      if (target === els.input || (target && els.commandPopover.contains(target))) return;
      closeCommandPopover();
    });

    // 状态栏
    els.statusBar = el("div", "chat-status-bar");
    els.statusBar.setAttribute("role", "status");
    els.statusDot = el("span", "chat-status-dot", "");
    els.statusDot.setAttribute("aria-hidden", "true");
    els.statusText = el("span", "chat-status-text", "");
    // 右侧用量：上下文占用（无数据时整体隐藏）
    els.statusMeta = el("span", "chat-status-meta", "");
    els.statusMeta.hidden = true;
    els.statusBar.appendChild(els.statusDot);
    els.statusBar.appendChild(els.statusText);
    els.statusBar.appendChild(els.statusMeta);

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
    els.attachButton = el("button", "chat-attach-button");
    els.attachButton.type = "button";
    els.attachButton.appendChild(svgIcon(PAPERCLIP_PATHS));
    els.attachButton.addEventListener("click", () => pickAttachments());
    els.input = el("textarea", "chat-input");
    els.input.rows = 1;
    els.input.addEventListener("input", () => {
      autosizeInput();
      updateComposer();
      updateCommands();
    });
    els.input.addEventListener("keydown", (event) => {
      // 指令弹层打开时先消化方向键 / 回车 / Esc
      if (!els.commandPopover.hidden && handleCommandKeydown(event)) return;
      // 输入框内按 Esc：正在生成时停止；指令弹层的 Esc 已在上面优先处理，
      // 历史浮层开着时把 Esc 留给 document 上的既有监听（只关浮层）。
      if (event.key === "Escape") {
        if (els.historyPopover.hidden && !event.defaultPrevented && isBusy()) {
          event.preventDefault();
          callApi("stop");
        }
        return;
      }
      if (event.key !== "Enter" || event.shiftKey) return;
      // 中文等输入法组合期间的回车只用于选词，不发送（keyCode 229 是 IME 兼容判断）
      if (event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      submitInput();
    });
    // 粘贴板里有图片：转 data URL 交给主进程落盘，成功进附件托盘；
    // 只有图片粘贴才接管，纯文本粘贴完全不受影响。
    els.input.addEventListener("paste", (event) => {
      const items = event && event.clipboardData && event.clipboardData.items
        ? Array.prototype.slice.call(event.clipboardData.items)
        : [];
      const imageItems = items.filter(
        (item) => item && item.kind === "file" && typeof item.type === "string" && item.type.indexOf("image/") === 0,
      );
      if (!imageItems.length) return;
      event.preventDefault();
      for (const item of imageItems) {
        const file = typeof item.getAsFile === "function" ? item.getAsFile() : null;
        if (!file) continue;
        savePastedImageFile(file).catch((err) => {
          console.warn("chat: paste failed", err);
          addLocalError(t("chatPasteFailed"));
        });
      }
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

    // 斜杠指令弹层：绝对定位在输入框上方，属于 form 但不参与 flex 布局
    els.commandPopover = el("div", "chat-command-popover");
    els.commandPopover.hidden = true;
    els.commandPopover.setAttribute("role", "listbox");
    els.commandList = el("div", "chat-command-list");
    els.commandPopover.appendChild(els.commandList);
    // 点弹层时不抢走输入框焦点（否则 click 前先触发 blur）
    els.commandPopover.addEventListener("mousedown", (event) => event.preventDefault());

    els.form.appendChild(els.attachButton);
    els.form.appendChild(els.input);
    els.form.appendChild(els.sendButton);
    els.form.appendChild(els.stopButton);
    els.form.appendChild(els.commandPopover);

    els.hint = el("div", "chat-composer-hint", "");
    els.hint.hidden = true;

    // 附件托盘：与提示条同在输入框上方（CSS 用 order 排到 form 之前）
    els.tray = el("div", "chat-attach-tray");
    els.tray.hidden = true;
    els.tray.setAttribute("role", "list");
    els.tray.setAttribute("aria-label", "");

    // 拖拽文件时的整窗高亮提示
    els.dropOverlay = el("div", "chat-drop-overlay");
    els.dropOverlay.hidden = true;
    els.dropText = el("div", "chat-drop-hint-text", "");
    els.dropOverlay.appendChild(els.dropText);

    els.app.appendChild(toolbar);
    els.app.appendChild(els.statusBar);
    els.app.appendChild(els.scroll);
    els.app.appendChild(els.form);
    els.app.appendChild(els.hint);
    els.app.appendChild(els.tray);
    els.app.appendChild(els.dropOverlay);

    // 文件拖进窗口：显示 / 收起高亮，drop 时登记路径并加入托盘
    document.addEventListener("dragenter", (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setDropHint(true);
    });
    document.addEventListener("dragover", (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      if (els.dropOverlay.hidden) setDropHint(true);
    });
    // dragleave 在子元素之间也会触发，用计数进出成对抵消；
    // 这里不再检查 types（个别平台在 leave 时已拿不到 Files）。
    document.addEventListener("dragleave", () => {
      if (!dragDepth) return;
      dragDepth -= 1;
      if (dragDepth <= 0) {
        dragDepth = 0;
        setDropHint(false);
      }
    });
    document.addEventListener("dragend", () => {
      dragDepth = 0;
      setDropHint(false);
    });
    document.addEventListener("drop", (event) => {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setDropHint(false);
      handleFileDrop(event);
    });

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
    els.historyButton.textContent = t("chatHistoryButton");
    els.historyButton.setAttribute("aria-label", t("chatHistoryButton"));
    els.sendButton.textContent = t("chatSend");
    els.stopButton.textContent = t("chatStop");
    els.input.placeholder = t("chatInputPlaceholder");
    els.input.setAttribute("aria-label", t("chatInputPlaceholder"));
    els.empty.textContent = t("chatEmptyHint");
    els.hint.textContent = t("chatNoDirHint");
    els.attachButton.setAttribute("aria-label", t("chatAttachButton"));
    els.attachButton.title = t("chatAttachButton");
    els.tray.setAttribute("aria-label", t("chatAttachmentLabel"));
    els.dropText.textContent = t("chatDropHint");
    for (const value of EFFORT_VALUES) {
      els.effortOptions.get(value).textContent = t(EFFORT_LABEL_KEYS[value]);
    }
    for (const value of MODE_VALUES) {
      els.modeOptions.get(value).textContent = t(MODE_LABEL_KEYS[value]);
    }
    // 浮层开着 / 托盘非空时切换语言：重建文案（移除按钮 aria、指令描述等）
    refreshHistoryPopover();
    renderTray();
    if (!els.commandPopover.hidden) renderCommandItems();
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
    applyStatusMeta();
  }

  // 会话是否进行中（恢复历史会话期间也算，复用同一套禁用/视觉/停止逻辑）
  function isBusy() {
    return !!(state && state.busy) || resumePending;
  }

  function updateComposer() {
    const hasDir = !!(state && state.cwd);
    const busy = isBusy();
    const sending = busy || sendPending;
    els.input.disabled = !hasDir;
    // 只有附件、没有文字也能发送（文本与附件都为空才禁用）
    const hasPayload = !!els.input.value.trim() || trayItems.length > 0;
    els.sendButton.disabled = sending || !hasDir || !hasPayload;
    els.stopButton.hidden = !busy;
    els.attachButton.disabled = !hasDir || sending;
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
      const timeEl = el("span", "chat-msg-time", "");
      timeEl.hidden = true;
      wrap.appendChild(timeEl);
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
        timeEl,
        expanded: false,
        hasResult: false,
        lastMsg: null,
        // diff 对照区（无 diff 时为 null）
        diffWrap: null,
        diffBody: null,
        diffToggle: null,
        diffLines: [],
        diffOld: null,
        diffNew: null,
        diffExpanded: false,
        diffRenderKey: null,
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
    const textEl = el("div", "chat-text", "");
    bubble.appendChild(textEl);
    let attachEl = null;
    if (isUser) {
      // 只有用户消息可能带附件（附件属于用户发出去的内容）
      attachEl = el("div", "chat-bubble-attachments");
      attachEl.hidden = true;
      attachEl.setAttribute("role", "group");
      bubble.appendChild(attachEl);
    }
    const timeEl = el("span", "chat-msg-time", "");
    timeEl.hidden = true;
    if (isUser) {
      // 时间贴着气泡外侧：用户消息在左，助手消息在右
      wrap.appendChild(timeEl);
      wrap.appendChild(bubble);
    } else {
      wrap.appendChild(bubble);
      wrap.appendChild(timeEl);
    }
    return {
      shape,
      el: wrap,
      kind: "text",
      bubble,
      textEl,
      cursor: null,
      attachEl,
      attachSig: null,
      timeEl,
      rawText: null,
      renderedLang: null,
    };
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
    applyToolDiff(entry, msg);
    applyMessageTime(entry, msg);
  }

  // ── 时间戳 / 工具卡片 diff / 状态栏用量 ────────────────

  // ts 是毫秒时间戳，显示成本地时间的 HH:MM；没有（或非法）就不显示。
  function formatMessageTime(ts) {
    const ms = typeof ts === "number" ? ts : (typeof ts === "string" && ts ? Number(ts) : NaN);
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const date = new Date(ms);
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return hours + ":" + minutes;
  }

  function applyMessageTime(entry, msg) {
    if (!entry.timeEl) return;
    const text = formatMessageTime(msg && msg.ts);
    entry.timeEl.textContent = text;
    entry.timeEl.hidden = !text;
  }

  function normalizeDiff(diff) {
    if (!diff || typeof diff !== "object") return null;
    const oldText = typeof diff.oldText === "string" ? diff.oldText : "";
    const newText = typeof diff.newText === "string" ? diff.newText : "";
    if (!oldText && !newText) return null;
    return { oldText, newText };
  }

  function splitDiffLines(value) {
    return value ? value.split(/\r\n|\r|\n/) : [];
  }

  function buildDiffRegion(diff) {
    const wrap = el("div", "chat-tool-diff");
    const body = el("div", "chat-tool-diff-lines");
    const toggle = el("button", "chat-diff-toggle");
    toggle.type = "button";
    toggle.hidden = true;
    wrap.appendChild(body);
    wrap.appendChild(toggle);
    const lines = [];
    for (const line of splitDiffLines(diff.oldText)) lines.push({ kind: "del", text: line });
    for (const line of splitDiffLines(diff.newText)) lines.push({ kind: "add", text: line });
    return { wrap, body, toggle, lines };
  }

  // 按展开状态渲染行；展开 / 收起 / 内容 / 语言有变化才重建。
  function renderDiffRegion(entry) {
    if (!entry.diffBody) return;
    const total = entry.diffLines.length;
    const key = total + "|" + (entry.diffExpanded ? "1" : "0") + "|" + (lang || "");
    if (entry.diffRenderKey === key) return;
    entry.diffRenderKey = key;
    const visible = entry.diffExpanded ? entry.diffLines : entry.diffLines.slice(0, DIFF_PREVIEW_LINES);
    entry.diffBody.textContent = "";
    for (const line of visible) {
      entry.diffBody.appendChild(el(
        "div",
        "chat-diff-line chat-diff-" + line.kind,
        (line.kind === "del" ? "- " : "+ ") + line.text,
      ));
    }
    entry.diffWrap.dataset.expanded = entry.diffExpanded ? "true" : "false";
    entry.diffToggle.hidden = total <= DIFF_PREVIEW_LINES;
    entry.diffToggle.textContent = t(entry.diffExpanded ? "chatDiffCollapse" : "chatDiffExpand");
  }

  // 消息带 diff 时在 head 与 result 之间插一块对照区；无 diff 的卡片保持原样。
  function applyToolDiff(entry, msg) {
    const diff = normalizeDiff(msg && msg.diff);
    if (!diff) {
      if (entry.diffWrap) {
        entry.diffWrap.remove();
        entry.diffWrap = null;
        entry.diffBody = null;
        entry.diffToggle = null;
      }
      entry.diffLines = [];
      entry.diffOld = null;
      entry.diffNew = null;
      entry.diffExpanded = false;
      entry.diffRenderKey = null;
      return;
    }
    const changed = entry.diffOld !== diff.oldText || entry.diffNew !== diff.newText;
    if (changed || !entry.diffWrap) {
      entry.diffOld = diff.oldText;
      entry.diffNew = diff.newText;
      if (entry.diffWrap) entry.diffWrap.remove();
      const built = buildDiffRegion(diff);
      entry.diffWrap = built.wrap;
      entry.diffBody = built.body;
      entry.diffToggle = built.toggle;
      entry.diffLines = built.lines;
      entry.diffRenderKey = null;
      built.toggle.addEventListener("click", () => {
        entry.diffExpanded = !entry.diffExpanded;
        renderDiffRegion(entry);
      });
      entry.card.insertBefore(entry.diffWrap, entry.result);
    }
    renderDiffRegion(entry);
  }

  // 上下文占用百分比：优先 percent 字段（非 null 才算）；缺失时按 usedTokens / maxTokens 折算。
  function contextUsagePercent(usage) {
    if (!usage || typeof usage !== "object") return null;
    if (usage.percent != null) {
      const percent = Number(usage.percent);
      if (Number.isFinite(percent)) return Math.min(100, Math.max(0, percent));
    }
    if (usage.usedTokens != null && usage.maxTokens != null) {
      const used = Number(usage.usedTokens);
      const max = Number(usage.maxTokens);
      if (Number.isFinite(used) && Number.isFinite(max) && max > 0) {
        return Math.min(100, Math.max(0, (used / max) * 100));
      }
    }
    return null;
  }

  function applyStatusMeta() {
    if (!els.statusMeta) return;
    const parts = [];
    const percent = state ? contextUsagePercent(state.contextUsage) : null;
    if (percent != null) parts.push(t("chatContextUsage", { n: Math.round(percent) }));
    els.statusMeta.textContent = parts.join(" · ");
    els.statusMeta.hidden = parts.length === 0;
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
    // 文本消息：正文走 Markdown 子集渲染；原文或语言没变就不重建 DOM，
    // 简单状态推送（如 busy 切换）不会打断选中与「已复制」反馈。
    const rawText = typeof msg.text === "string" ? msg.text : "";
    if (entry.rawText !== rawText || entry.renderedLang !== lang) {
      entry.rawText = rawText;
      entry.renderedLang = lang;
      renderMarkdownInto(entry.textEl, rawText);
    }
    applyMessageAttachments(entry, msg);
    applyMessageTime(entry, msg);
    if (msg.streaming) {
      if (!entry.cursor) {
        entry.cursor = el("span", "chat-cursor", "");
        entry.cursor.setAttribute("aria-hidden", "true");
      }
      // 光标宿主可能刚被 markdown 重建，每次重新挂到末尾
      placeCursor(entry);
    } else if (entry.cursor) {
      entry.cursor.remove();
      entry.cursor = null;
    }
  }

  // 已发送消息的附件区：图片走 thumb 小图，其余是「名字 + 大小」chip。
  // 用签名（名字 / 大小 / thumb 长度）判断内容有没有变，没变就不重建 DOM。
  function applyMessageAttachments(entry, msg) {
    if (!entry.attachEl) return;
    entry.attachEl.setAttribute("aria-label", t("chatAttachmentLabel"));
    const list = Array.isArray(msg.attachments)
      ? msg.attachments.filter((att) => att && typeof att === "object")
      : [];
    const sig = list
      .map((att) => [att.name || "", att.size || 0, att.isImage ? 1 : 0, typeof att.thumb === "string" ? att.thumb.length : 0].join("|"))
      .join("§");
    if (entry.attachSig === sig) return;
    entry.attachSig = sig;
    entry.attachEl.textContent = "";
    entry.attachEl.hidden = list.length === 0;
    for (const att of list) {
      const thumb = typeof att.thumb === "string" && att.thumb.indexOf("data:image/") === 0 ? att.thumb : "";
      const preview = typeof att.preview === "string" && att.preview.indexOf("data:image/") === 0 ? att.preview : "";
      const src = thumb || preview;
      if (att.isImage && src) {
        const img = el("img", "chat-bubble-thumb");
        img.src = src;
        img.alt = typeof att.name === "string" ? att.name : "";
        entry.attachEl.appendChild(img);
        continue;
      }
      const chip = el("span", "chat-bubble-chip");
      const rawName = typeof att.name === "string" && att.name ? att.name : shortenPath(String(att.path || ""));
      const name = rawName || t("chatAttachmentLabel");
      chip.appendChild(el("span", "chat-bubble-chip-name", name));
      const size = formatSize(att.size);
      if (size) chip.appendChild(el("span", "chat-bubble-chip-size", size));
      chip.title = name;
      entry.attachEl.appendChild(chip);
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
    // state.commands 由主进程推送，可能在弹层开着时更新
    if (!els.commandPopover.hidden) updateCommands();
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

  // ── 历史会话浮层 ───────────────────────────────────────

  // 相对时间：<1 分钟「刚刚」、<1 小时「X分钟前」、<24 小时「X小时前」、否则「X天前」。
  function relativeTimeText(at) {
    const ms = typeof at === "number" ? at : Date.parse(at);
    if (!Number.isFinite(ms) || ms <= 0) return "";
    const diff = Date.now() - ms;
    if (diff < 60 * 1000) return t("chatJustNow");
    if (diff < 60 * 60 * 1000) return t("chatMinutesAgo", { n: Math.floor(diff / (60 * 1000)) });
    if (diff < 24 * 60 * 60 * 1000) return t("chatHoursAgo", { n: Math.floor(diff / (60 * 60 * 1000)) });
    return t("chatDaysAgo", { n: Math.floor(diff / (24 * 60 * 60 * 1000)) });
  }

  // 列表优先显示最近活动时间；缺失时退回结束时间。
  function historyRowTime(row) {
    const last = Number(row && row.lastEventAt);
    if (Number.isFinite(last) && last > 0) return last;
    const ended = Number(row && row.endedAt);
    return Number.isFinite(ended) && ended > 0 ? ended : null;
  }

  function setHistoryStatus(kind) {
    historyStatus = kind;
    els.historyStatus.dataset.kind = kind || "";
    els.historySpinner.hidden = kind !== "loading";
    els.historyStatus.hidden = kind !== "loading" && kind !== "empty" && kind !== "error";
    if (kind === "loading") els.historyStatusText.textContent = t("chatHistoryLoading");
    else if (kind === "empty") els.historyStatusText.textContent = t("chatHistoryEmpty");
    else if (kind === "error") els.historyStatusText.textContent = t("chatHistoryLoadFailed");
    else els.historyStatusText.textContent = "";
  }

  function renderHistoryRows() {
    els.historyList.textContent = "";
    for (const row of historyRows) {
      const item = el("button", "chat-history-item");
      item.type = "button";
      const raw = row && typeof row.title === "string" ? row.title.replace(/\s+/g, " ").trim() : "";
      const title = raw || t("chatHistoryUntitled");
      const titleEl = el("span", "chat-history-title", title);
      titleEl.title = title;
      const timeEl = el("span", "chat-history-time", relativeTimeText(historyRowTime(row)));
      item.appendChild(titleEl);
      item.appendChild(timeEl);
      item.addEventListener("click", () => resumeFromHistory(row.historyKey));
      els.historyList.appendChild(item);
    }
  }

  // 语言变化时刷新浮层里已显示的文案（标题除外，标题来自历史记录本身）。
  function refreshHistoryPopover() {
    if (!els.historyPopover || els.historyPopover.hidden) return;
    if (historyStatus === "list") renderHistoryRows();
    else if (historyStatus) setHistoryStatus(historyStatus);
  }

  async function loadHistoryList() {
    const seq = ++historyLoadSeq;
    historyRows = [];
    els.historyList.textContent = "";
    setHistoryStatus("loading");
    const api = root.chatAPI;
    if (!api || typeof api.listHistory !== "function") {
      console.warn("chat: chatAPI.listHistory is unavailable");
      if (seq === historyLoadSeq) setHistoryStatus("error");
      return;
    }
    let result;
    try {
      result = await api.listHistory();
    } catch (err) {
      console.warn("chat: listHistory failed", err);
      if (seq === historyLoadSeq) setHistoryStatus("error");
      return;
    }
    if (seq !== historyLoadSeq) return;
    if (!result || result.status !== "ok" || !Array.isArray(result.rows)) {
      setHistoryStatus("error");
      return;
    }
    historyRows = result.rows.filter(
      (row) => row && typeof row.historyKey === "string" && row.historyKey,
    );
    if (!historyRows.length) {
      setHistoryStatus("empty");
      return;
    }
    setHistoryStatus("list");
    renderHistoryRows();
  }

  function openHistoryPopover() {
    if (!els.historyPopover.hidden) return;
    els.historyPopover.hidden = false;
    els.historyButton.setAttribute("aria-expanded", "true");
    loadHistoryList();
  }

  function closeHistoryPopover() {
    historyLoadSeq += 1; // 作废在途加载，避免关闭后旧结果再写入浮层
    if (els.historyPopover.hidden) return;
    els.historyPopover.hidden = true;
    els.historyButton.setAttribute("aria-expanded", "false");
  }

  function toggleHistoryPopover() {
    if (els.historyPopover.hidden) openHistoryPopover();
    else closeHistoryPopover();
  }

  // 恢复历史会话：关闭浮层 → invoke（主进程换 driver 并回填消息）→ 期间禁用输入。
  async function resumeFromHistory(historyKey) {
    closeHistoryPopover();
    const api = root.chatAPI;
    if (!api || typeof api.resumeSession !== "function") {
      console.warn("chat: chatAPI.resumeSession is unavailable");
      addLocalError("chatAPI.resumeSession is unavailable");
      return;
    }
    resumePending = true;
    updateComposer();
    try {
      const result = await api.resumeSession(historyKey);
      if (result && result.status === "error") {
        addLocalError(result.message || t("chatHistoryLoadFailed"));
      }
    } catch (err) {
      console.warn("chat: resumeSession failed", err);
      addLocalError(errorText(err));
    } finally {
      resumePending = false;
      updateComposer();
    }
  }

  function restoreDraft(text) {
    // 发送失败就把用户输入还回去，避免打字内容丢失（已有新输入时不覆盖）
    if (!els.input.value && text) {
      els.input.value = text;
      autosizeInput();
    }
  }

  // send 正常时返回的是状态快照（一定带 messages 数组）；错误响应形如
  // {status:"error", message}，没有 messages 字段。
  function isSendFailure(result) {
    if (result === false) return true;
    if (!result || typeof result !== "object") return false;
    if (result.ok === false) return true;
    return result.status === "error" && !Array.isArray(result.messages);
  }

  function sendErrorMessage(result) {
    if (result && typeof result.message === "string" && result.message) return result.message;
    return t("chatStatusError");
  }

  async function submitInput() {
    if (sendPending) return;
    const text = els.input.value.trim();
    const items = trayItems.slice();
    if (!text && !items.length) return;
    const hasDir = !!(state && state.cwd);
    if (!hasDir || isBusy()) return;
    const api = root.chatAPI;
    if (!api || typeof api.send !== "function") {
      console.warn("chat: chatAPI.send is unavailable");
      addLocalError("chatAPI.send is unavailable");
      return;
    }
    sendPending = true;
    els.input.value = "";
    autosizeInput();
    closeCommandPopover();
    updateComposer();
    let result;
    try {
      const attachments = await buildAttachmentPayload(items);
      result = await api.send(text, attachments);
    } catch (err) {
      console.warn("chat: send failed", err);
      sendPending = false;
      restoreDraft(text);
      updateComposer();
      addLocalError(errorText(err));
      return;
    }
    sendPending = false;
    if (isSendFailure(result)) {
      // 失败保留托盘，报错把输入还回去
      restoreDraft(text);
      updateComposer();
      addLocalError(sendErrorMessage(result));
      return;
    }
    // 成功：只清掉本次真正发出去的托盘项，保留等待期间新加的附件
    for (const item of items) {
      const index = trayItems.indexOf(item);
      if (index >= 0) trayItems.splice(index, 1);
    }
    renderTray();
    updateComposer();
  }

  // ── 附件托盘 / 拖拽 / 缩略图 ────────────────────────────

  function renderTray() {
    els.tray.textContent = "";
    els.tray.hidden = trayItems.length === 0;
    for (const item of trayItems) {
      const chip = el("div", "chat-attach-chip");
      chip.setAttribute("role", "listitem");
      if (item.isImage && item.sourceUrl) {
        const img = el("img", "chat-attach-thumb");
        img.src = item.sourceUrl;
        img.alt = "";
        chip.appendChild(img);
      } else {
        chip.appendChild(svgIcon(FILE_ICON_PATHS, "chat-attach-file-icon"));
      }
      const meta = el("div", "chat-attach-meta");
      const nameText = item.name || item.path;
      const nameEl = el("span", "chat-attach-name", nameText);
      nameEl.title = nameText;
      meta.appendChild(nameEl);
      const sizeText = formatSize(item.size);
      if (sizeText) meta.appendChild(el("span", "chat-attach-size", sizeText));
      chip.appendChild(meta);
      const remove = el("button", "chat-attach-remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", t("chatAttachRemove"));
      remove.title = t("chatAttachRemove");
      remove.addEventListener("click", () => removeTrayItem(item));
      chip.appendChild(remove);
      els.tray.appendChild(chip);
    }
  }

  function removeTrayItem(item) {
    const index = trayItems.indexOf(item);
    if (index < 0) return;
    trayItems.splice(index, 1);
    renderTray();
    updateComposer();
  }

  function addTrayItems(items) {
    let added = false;
    for (const item of items) {
      if (!item || !item.path) continue;
      // 同一路径只保留一份
      if (trayItems.some((existing) => existing.path === item.path)) continue;
      trayItems.push(item);
      added = true;
    }
    if (added) {
      renderTray();
      updateComposer();
    }
  }

  function trayItemFromPicked(file) {
    if (!file || typeof file.path !== "string" || !file.path) return null;
    const isImage = !!file.isImage;
    const preview = typeof file.preview === "string" && file.preview.indexOf("data:image/") === 0 ? file.preview : "";
    return {
      path: file.path,
      name: typeof file.name === "string" && file.name ? file.name : basenameOf(file.path),
      size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0,
      isImage,
      sourceUrl: isImage ? preview : "",
      file: null,
    };
  }

  async function pickAttachments() {
    const api = root.chatAPI;
    if (!api || typeof api.pickAttachments !== "function") {
      console.warn("chat: chatAPI.pickAttachments is unavailable");
      addLocalError("chatAPI.pickAttachments is unavailable");
      return;
    }
    let result;
    try {
      result = await api.pickAttachments();
    } catch (err) {
      console.warn("chat: pickAttachments failed", err);
      addLocalError(t("chatAttachPickFailed"));
      return;
    }
    if (!result || result.status === "cancel") return;
    if (result.status !== "ok" || !Array.isArray(result.files)) {
      addLocalError(typeof result.message === "string" && result.message ? result.message : t("chatAttachPickFailed"));
      return;
    }
    addTrayItems(result.files.map(trayItemFromPicked).filter(Boolean));
  }

  // 粘贴板里的图片：读成 data URL 交给主进程落盘（savePastedImage），
  // 返回的单文件形状与 pickAttachments 一致，拿到后进附件托盘。
  async function savePastedImageFile(file) {
    const api = root.chatAPI;
    if (!api || typeof api.savePastedImage !== "function") {
      console.warn("chat: chatAPI.savePastedImage is unavailable");
      addLocalError("chatAPI.savePastedImage is unavailable");
      return;
    }
    const dataUrl = await readFileDataUrl(file);
    if (!dataUrl) {
      addLocalError(t("chatPasteFailed"));
      return;
    }
    const name = typeof file.name === "string" && file.name ? file.name : "";
    let result;
    try {
      // 没有可用名字就不传第二个参数，让主进程自己起名
      result = name ? await api.savePastedImage(dataUrl, name) : await api.savePastedImage(dataUrl);
    } catch (err) {
      console.warn("chat: savePastedImage failed", err);
      addLocalError(errorText(err));
      return;
    }
    const saved = normalizePastedResult(result);
    if (!saved) {
      const message = result && typeof result.message === "string" && result.message ? result.message : "";
      addLocalError(message || t("chatPasteFailed"));
      return;
    }
    if (!saved.preview && dataUrl) saved.preview = dataUrl;
    const item = trayItemFromPicked(saved);
    if (!item) {
      addLocalError(t("chatPasteFailed"));
      return;
    }
    addTrayItems([item]);
  }

  // savePastedImage 的成功形状：单文件对象本身，或包成 {status:"ok", file}。
  function normalizePastedResult(result) {
    if (!result || typeof result !== "object") return null;
    const file = result.file && typeof result.file === "object" ? result.file : result;
    if (typeof file.path !== "string" || !file.path) return null;
    return {
      path: file.path,
      name: typeof file.name === "string" ? file.name : "",
      size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0,
      isImage: file.isImage !== false,
      preview: typeof file.preview === "string" && file.preview.indexOf("data:image/") === 0 ? file.preview : "",
    };
  }

  async function pathForFile(file) {
    const api = root.chatAPI;
    if (!api || typeof api.getPathForFile !== "function") return "";
    try {
      const value = api.getPathForFile(file);
      const resolved = value && typeof value.then === "function" ? await value : value;
      return typeof resolved === "string" ? resolved : "";
    } catch (err) {
      console.warn("chat: getPathForFile failed", err);
      return "";
    }
  }

  function readFileDataUrl(file) {
    return new Promise((resolve) => {
      const FileReaderCtor = root.FileReader;
      if (typeof FileReaderCtor !== "function") {
        resolve("");
        return;
      }
      try {
        const reader = new FileReaderCtor();
        reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
        reader.onerror = () => resolve("");
        reader.readAsDataURL(file);
      } catch (err) {
        resolve("");
      }
    });
  }

  function prefersPng(item) {
    if (typeof item.sourceUrl === "string" && item.sourceUrl.indexOf("data:image/png") === 0) return true;
    return /\.(png|webp|gif|bmp)$/i.test(item.name || "");
  }

  // 用 canvas 把图片压到最长边 96px；失败（解码失败 / 无 canvas）返回空字符串。
  function makeThumbnail(sourceUrl, preferPng) {
    return new Promise((resolve) => {
      const ImageCtor = root.Image;
      if (typeof ImageCtor !== "function") {
        resolve("");
        return;
      }
      let settled = false;
      let timer = null;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(typeof value === "string" ? value : "");
      };
      const image = new ImageCtor();
      image.onload = () => {
        try {
          const width = image.naturalWidth || image.width || 0;
          const height = image.naturalHeight || image.height || 0;
          if (!width || !height) {
            finish("");
            return;
          }
          const scale = Math.min(1, THUMB_MAX_SIDE / Math.max(width, height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(width * scale));
          canvas.height = Math.max(1, Math.round(height * scale));
          const context = canvas.getContext ? canvas.getContext("2d") : null;
          if (!context) {
            finish("");
            return;
          }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const url = preferPng ? canvas.toDataURL("image/png") : canvas.toDataURL("image/jpeg", 0.82);
          finish(typeof url === "string" && url.indexOf("data:image/") === 0 ? url : "");
        } catch (err) {
          finish("");
        }
      };
      image.onerror = () => finish("");
      // 个别图片解码可能一直不回调，加超时兜底，避免卡住发送
      timer = setTimeout(() => finish(""), 5000);
      image.src = sourceUrl;
    });
  }

  // 发送载荷：图片尽量带上 canvas 压缩出的 thumb（失败就不带）。
  async function buildAttachmentPayload(items) {
    const payload = [];
    for (const item of items) {
      if (!item || typeof item.path !== "string" || !item.path) continue;
      const attachment = {
        path: item.path,
        name: item.name || "",
        size: Number.isFinite(item.size) ? item.size : 0,
        isImage: !!item.isImage,
      };
      if (attachment.isImage && item.sourceUrl) {
        const thumb = await makeThumbnail(item.sourceUrl, prefersPng(item));
        if (thumb) attachment.thumb = thumb;
      }
      payload.push(attachment);
    }
    return payload;
  }

  function setDropHint(show) {
    if (els.dropOverlay) els.dropOverlay.hidden = !show;
    if (els.app) els.app.classList.toggle("chat-drop-active", show);
  }

  async function handleFileDrop(event) {
    const dt = event && event.dataTransfer;
    const files = dt && dt.files ? Array.prototype.slice.call(dt.files) : [];
    if (!files.length) return;
    const api = root.chatAPI;
    const items = [];
    for (const file of files) {
      const path = await pathForFile(file);
      if (!path) continue;
      const isImage = !!(file.type && String(file.type).indexOf("image/") === 0);
      let sourceUrl = "";
      if (isImage) sourceUrl = await readFileDataUrl(file);
      items.push({
        path,
        name: typeof file.name === "string" && file.name ? file.name : basenameOf(path),
        size: Number.isFinite(Number(file.size)) ? Number(file.size) : 0,
        isImage,
        sourceUrl,
        file,
      });
    }
    if (items.length && api && typeof api.registerDroppedPaths === "function") {
      try {
        const registered = api.registerDroppedPaths(items.map((item) => item.path));
        if (registered && typeof registered.catch === "function") registered.catch(() => {});
      } catch (err) {
        console.warn("chat: registerDroppedPaths failed", err);
      }
    }
    if (!items.length) {
      addLocalError(t("chatAttachPickFailed"));
      return;
    }
    addTrayItems(items);
  }

  // ── 斜杠指令弹层 ───────────────────────────────────────

  function normalizeCommands(list) {
    if (!Array.isArray(list)) return [];
    const commands = [];
    for (const item of list) {
      if (!item || typeof item.name !== "string") continue;
      const name = item.name.trim();
      if (!name || name.charAt(0) !== "/") continue;
      commands.push({
        name,
        description: typeof item.description === "string" ? item.description : "",
      });
    }
    return commands;
  }

  // state.commands 优先；为空时退回 listCommands() 缓存，再退回内置三条。
  function availableCommands() {
    const pushed = state && Array.isArray(state.commands) ? normalizeCommands(state.commands) : [];
    if (pushed.length) return pushed;
    if (commandsCache.length) return commandsCache;
    return BUILTIN_COMMANDS.map((cmd) => ({ name: cmd.name, description: cmd.description }));
  }

  // 输入以 "/" 开头、还没打空格时才匹配；按 name 前缀过滤，最多 8 条。
  function matchingCommands() {
    const value = els.input.value || "";
    if (value.charAt(0) !== "/" || /\s/.test(value)) return [];
    const query = value.toLowerCase();
    const matches = [];
    for (const cmd of availableCommands()) {
      if (cmd.name.toLowerCase().indexOf(query) !== 0) continue;
      matches.push(cmd);
      if (matches.length >= COMMAND_LIMIT) break;
    }
    return matches;
  }

  function renderCommandItems() {
    els.commandList.textContent = "";
    commandMatches.forEach((cmd, index) => {
      const item = el("button", "chat-command-item" + (index === commandIndex ? " selected" : ""));
      item.type = "button";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === commandIndex ? "true" : "false");
      item.appendChild(el("span", "chat-command-name", cmd.name));
      const description = localizeText(cmd.description);
      if (description) item.appendChild(el("span", "chat-command-desc", description));
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () => selectCommand(cmd));
      els.commandList.appendChild(item);
    });
  }

  function updateCommands() {
    const matches = matchingCommands();
    if (!matches.length) {
      closeCommandPopover();
      return;
    }
    const changed =
      matches.length !== commandMatches.length ||
      matches.some((cmd, index) => cmd.name !== (commandMatches[index] && commandMatches[index].name));
    commandMatches = matches;
    if (changed) commandIndex = 0;
    if (commandIndex >= commandMatches.length) commandIndex = commandMatches.length - 1;
    if (commandIndex < 0) commandIndex = 0;
    renderCommandItems();
    els.commandPopover.hidden = false;
  }

  function closeCommandPopover() {
    if (els.commandPopover.hidden) return;
    els.commandPopover.hidden = true;
    commandMatches = [];
    commandIndex = 0;
    els.commandList.textContent = "";
  }

  // 选中后把输入替换成 "/name "，光标留给用户补参数，弹层关闭。
  function selectCommand(cmd) {
    if (!cmd || typeof cmd.name !== "string" || !cmd.name) return;
    els.input.value = cmd.name + " ";
    closeCommandPopover();
    autosizeInput();
    updateComposer();
    if (typeof els.input.focus === "function") els.input.focus();
  }

  function handleCommandKeydown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const count = commandMatches.length;
      if (!count) return false;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      commandIndex = (commandIndex + delta + count) % count;
      renderCommandItems();
      event.preventDefault();
      return true;
    }
    if (event.key === "Enter") {
      if (event.isComposing || event.keyCode === 229) return false;
      const cmd = commandMatches[commandIndex];
      if (!cmd) return false;
      selectCommand(cmd);
      event.preventDefault();
      return true;
    }
    if (event.key === "Escape") {
      closeCommandPopover();
      event.preventDefault();
      return true;
    }
    return false;
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
    // 打开窗口时拉一次指令清单补缓存（主用 state.commands 推送；失败不打扰用户）
    if (typeof api.listCommands === "function") {
      Promise.resolve(api.listCommands())
        .then((result) => {
          if (!result || result.status !== "ok" || !Array.isArray(result.commands)) return;
          commandsCache = normalizeCommands(result.commands);
          if (!els.commandPopover.hidden) updateCommands();
        })
        .catch(() => {});
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})(globalThis);
