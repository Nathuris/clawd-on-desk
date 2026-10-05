"use strict";

// ── 内置 Claude 对话窗口：主进程 IPC 注册器 ──
//
// 渲染端（chat.html）经 window.chatAPI 调用的 invoke 通道：
//   chat:get-state            取当前完整状态快照
//   chat:send                 发送一条用户消息
//   chat:stop                 停止当前进行中的会话
//   chat:new-session          丢弃当前会话，开一个新会话
//   chat:pick-working-dir     弹目录选择框，记住选择并切换工作目录
//   chat:set-effort           切换 effort 档位（在 runtime 内触发开新会话）
//   chat:set-permission-mode  切换权限模式（中途生效）
// 权限确认不走本窗口：由 Claude Code 的 PermissionRequest hook 打到应用自己的
// /permission 路由，经桌宠气泡完成（见 server-route-permission.js）。
//
// 主进程 → 渲染端只有一个 push 通道：
//   chat:update               载荷 = 完整状态快照 + 当前语言 lang
// （每次变化都推全量，简单可靠；不要改成增量。）
//
// 信任校验与 settings-ipc.js 的 isTrustedSettingsEvent 同构：只接受来自
// chat 窗口 webContents、主 frame、且 frame.url 精确等于 chat 页面 URL 的
// 事件；窗口不存在、已销毁、sender 不符、子 frame 一律拒绝。

const defaultPath = require("path");
const { pathToFileURL } = require("url");

const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODE_VALUES = ["default", "acceptEdits", "plan", "auto"];
// 防御性上限：单条用户消息最多 10 万字符，避免异常渲染端塞爆内存。
const MAX_SEND_LENGTH = 100000;

// 目录选择弹窗文案（7 语言，与 i18n.js / chat-i18n.js 的语言集合保持一致）。
// 未注入 getLang 时回退简体中文：本 fork 的产品文案以中文为准。
const CHAT_DIALOG_STRINGS = {
  zh: { pickDirTitle: "选择工作目录" },
  en: { pickDirTitle: "Choose a working folder" },
  "zh-TW": { pickDirTitle: "選擇工作目錄" },
  ko: { pickDirTitle: "작업 폴더 선택" },
  ja: { pickDirTitle: "作業フォルダーを選択" },
  "pt-BR": { pickDirTitle: "Escolha uma pasta de trabalho" },
  es: { pickDirTitle: "Elige una carpeta de trabajo" },
};

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerChatIpc requires ${name}`);
  return value;
}

function isWindowUsable(win) {
  return !!win && !(typeof win.isDestroyed === "function" && win.isDestroyed());
}

function registerChatIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const chatRuntime = requiredDependency(options.chatRuntime, "chatRuntime");
  const settingsController = requiredDependency(options.settingsController, "settingsController");
  const dialog = requiredDependency(options.dialog, "dialog");
  const getChatWindow = typeof options.getChatWindow === "function"
    ? options.getChatWindow
    : () => null;
  // 当前语言：优先用 main.js 注入的 getLang（与 settings-ipc.js 一致）；
  // 没注入就照 Settings 的做法从 controller 读 prefs.lang，最后回退中文。
  const getLang = typeof options.getLang === "function"
    ? options.getLang
    : () => {
        try {
          const lang = typeof settingsController.get === "function"
            ? settingsController.get("lang")
            : null;
          return typeof lang === "string" && lang ? lang : "zh";
        } catch {
          return "zh";
        }
      };
  const path = options.path || defaultPath;
  const chatPageUrl = pathToFileURL(
    options.chatHtmlPath || path.join(__dirname, "chat.html"),
  ).href;
  // onPickDir：可选的目录选择替换实现（测试 / 自定义入口用），
  // 签名 async () => string | null（null 表示取消）。
  const pickDirOverride = typeof options.onPickDir === "function" ? options.onPickDir : null;
  const disposers = [];
  const watchedWebContents = new WeakSet();

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function isTrustedChatEvent(event) {
    const win = getChatWindow();
    if (!isWindowUsable(win)) return false;
    const contents = win.webContents;
    const frame = event && event.senderFrame;
    return !!contents
      && event.sender === contents
      && !!frame
      && frame === contents.mainFrame
      && frame.url === chatPageUrl;
  }

  function rejectUntrustedChatEvent(event) {
    return isTrustedChatEvent(event)
      ? null
      : { status: "error", message: "untrusted chat sender" };
  }

  // 当前完整状态快照 + lang。渲染端 chat-i18n 依赖该字段选语言。
  function currentState() {
    let state = null;
    try {
      state = typeof chatRuntime.getState === "function" ? chatRuntime.getState() : null;
    } catch (err) {
      console.warn("Clawd: chatRuntime.getState failed:", err && err.message);
    }
    return { ...(isPlainObject(state) ? state : {}), lang: getLang() };
  }

  function sendStateToWindow(payload) {
    const win = getChatWindow();
    if (!isWindowUsable(win)) return;
    const contents = win.webContents;
    if (!contents || (typeof contents.isDestroyed === "function" && contents.isDestroyed())) return;
    try {
      contents.send("chat:update", payload);
    } catch (err) {
      console.warn("Clawd: chat:update push failed:", err && err.message);
    }
  }

  // 状态推送入口：main.js 可把它接到 createChatSessionRuntime({ onUpdate })、
  // 或由 runtime 主动调用（若 runtime 暴露 onUpdate(cb) 注册接口，本文件也会自动挂上）。
  function pushUpdate(state) {
    const payload = isPlainObject(state) ? { ...state, lang: getLang() } : currentState();
    sendStateToWindow(payload);
  }

  function broadcastState() {
    pushUpdate(currentState());
  }

  // 用户动作完成后的统一回包：返回快照，并主动补推一次（即使 runtime 的
  // onUpdate 没接线，界面也能靠这次推送刷新）。重复推送是幂等的全量快照。
  function respondWithState() {
    const state = currentState();
    pushUpdate(state);
    return state;
  }

  async function applyRuntimeCall(methodName, ...args) {
    if (typeof chatRuntime[methodName] !== "function") return;
    try {
      await chatRuntime[methodName](...args);
    } catch (err) {
      // runtime / driver 约定把异常转成状态内 notice，这里只做兜底。
      console.warn(`Clawd: chatRuntime.${methodName} failed:`, err && err.message);
    }
  }

  // ── invoke 通道 ──

  handle("chat:get-state", (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    return rejected || currentState();
  });

  handle("chat:send", async (event, text) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    if (typeof text !== "string" || !text.trim()) {
      return { status: "error", message: "chat:send requires a non-empty string" };
    }
    await applyRuntimeCall("send", text.slice(0, MAX_SEND_LENGTH));
    return respondWithState();
  });

  handle("chat:stop", async (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    await applyRuntimeCall("stop");
    return respondWithState();
  });

  handle("chat:new-session", async (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    await applyRuntimeCall("newSession");
    return respondWithState();
  });

  handle("chat:set-effort", async (event, value) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    if (!EFFORT_VALUES.includes(value)) {
      return { status: "error", message: `invalid effort "${value}"` };
    }
    await applyRuntimeCall("setEffort", value);
    return respondWithState();
  });

  handle("chat:set-permission-mode", async (event, value) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    if (!PERMISSION_MODE_VALUES.includes(value)) {
      return { status: "error", message: `invalid permission mode "${value}"` };
    }
    await applyRuntimeCall("setPermissionMode", value);
    return respondWithState();
  });

  handle("chat:pick-working-dir", async (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    const strings = CHAT_DIALOG_STRINGS[getLang()] || CHAT_DIALOG_STRINGS.zh;

    let dir = null;
    if (pickDirOverride) {
      try {
        dir = await pickDirOverride();
      } catch (err) {
        return { status: "error", message: (err && err.message) || String(err) };
      }
    } else {
      const parent = getChatWindow();
      const dialogOptions = {
        title: strings.pickDirTitle,
        properties: ["openDirectory", "createDirectory"],
      };
      let result;
      try {
        result = isWindowUsable(parent)
          ? await dialog.showOpenDialog(parent, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
      } catch (err) {
        return { status: "error", message: `chat working dir dialog failed: ${err && err.message}` };
      }
      if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
        return { status: "cancel", state: currentState() };
      }
      dir = result.filePaths[0];
    }
    if (typeof dir !== "string" || !dir) {
      return { status: "cancel", state: currentState() };
    }

    // 先记住选择（prefs 校验失败只告警，不挡住本次会话使用该目录），
    // 再让 runtime 切目录；runtime 收到新目录会丢弃旧会话。
    try {
      const applyResult = settingsController.applyUpdate("chatLastWorkingDir", dir);
      if (applyResult && applyResult.status === "error") {
        console.warn("Clawd: failed to persist chatLastWorkingDir:", applyResult.message);
      }
    } catch (err) {
      console.warn("Clawd: failed to persist chatLastWorkingDir:", err && err.message);
    }
    await applyRuntimeCall("setWorkingDir", dir);
    return { status: "ok", path: dir, state: respondWithState() };
  });

  // ── 状态推送接线 ──

  // 若 runtime 暴露 onUpdate(cb) 注册接口（返回退订函数），自动订阅；
  // 否则由 main.js 把 pushUpdate 接到 createChatSessionRuntime({ onUpdate })。
  if (typeof chatRuntime.onUpdate === "function") {
    try {
      const unsubscribe = chatRuntime.onUpdate((state) => pushUpdate(state));
      if (typeof unsubscribe === "function") disposers.push(unsubscribe);
    } catch (err) {
      console.warn("Clawd: chatRuntime.onUpdate subscription failed:", err && err.message);
    }
  }

  // chat 窗口 did-finish-load 后首推一次状态。这里按「所有窗口创建」挂监听、
  // 加载完成时再核对是不是 chat 窗口，避免依赖窗口 runtime 的创建顺序。
  function attachLoadPush(win) {
    const contents = win && win.webContents;
    if (!contents || typeof contents.on !== "function" || watchedWebContents.has(contents)) return;
    watchedWebContents.add(contents);
    const onLoaded = () => {
      if (getChatWindow() !== win) return;
      try {
        broadcastState();
      } catch (err) {
        console.warn("Clawd: chat initial push failed:", err && err.message);
      }
    };
    contents.on("did-finish-load", onLoaded);
    disposers.push(() => {
      try { contents.removeListener("did-finish-load", onLoaded); } catch {}
    });
  }

  function attachAppWindowHook() {
    const app = options.app;
    if (!app || typeof app.on !== "function") return;
    const onWindowCreated = (_event, win) => attachLoadPush(win);
    app.on("browser-window-created", onWindowCreated);
    disposers.push(() => {
      try { app.removeListener("browser-window-created", onWindowCreated); } catch {}
    });
  }

  attachAppWindowHook();
  // 注册时窗口可能已经存在（例如先建窗后注册 IPC 的顺序）。
  attachLoadPush(getChatWindow());

  return {
    dispose() {
      while (disposers.length) {
        const disposeOne = disposers.pop();
        try { disposeOne(); } catch {}
      }
    },
    // 供 main.js 接 createChatSessionRuntime({ onUpdate: (state) => chatIpc.pushUpdate(state) })
    pushUpdate,
    // 主动按 runtime 最新状态推一帧（窗口打开后、语言切换后可调用）。
    broadcastState,
  };
}

module.exports = {
  registerChatIpc,
};
