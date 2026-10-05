"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DASHBOARD_PAGE_URL = pathToFileURL(path.join(__dirname, "dashboard.html")).toString();
const SESSION_HUD_PAGE_URL = pathToFileURL(path.join(__dirname, "session-hud.html")).toString();

// 快捷输入面板允许的 effort / 权限模式取值（与 chat-session-runtime 同一份口径）。
const QUICK_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];
const QUICK_PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"];
// 输入框文本上限与聊天窗口同宽（chat-ipc 的 MAX_SEND_LENGTH）。
const QUICK_PROMPT_MAX_LENGTH = 100000;

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerSessionIpc requires ${name}`);
  return value;
}

function registerSessionIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const getSessionSnapshot = requiredDependency(options.getSessionSnapshot, "getSessionSnapshot");
  const getI18n = requiredDependency(options.getI18n, "getI18n");
  const focusSession = requiredDependency(options.focusSession, "focusSession");
  const hideSession = requiredDependency(options.hideSession, "hideSession");
  const setSessionAlias = requiredDependency(options.setSessionAlias, "setSessionAlias");
  const showDashboard = requiredDependency(options.showDashboard, "showDashboard");
  const ackSessionCompletion = requiredDependency(options.ackSessionCompletion, "ackSessionCompletion");
  const openSessionFolder = requiredDependency(options.openSessionFolder, "openSessionFolder");
  const setSessionAutomationOverride = requiredDependency(
    options.setSessionAutomationOverride,
    "setSessionAutomationOverride"
  );
  const clearSessionAutomationGrant = requiredDependency(
    options.clearSessionAutomationGrant,
    "clearSessionAutomationGrant"
  );
  const getDashboardWebContents = requiredDependency(
    options.getDashboardWebContents,
    "getDashboardWebContents"
  );
  const getKimiQuotaStatus = requiredDependency(options.getKimiQuotaStatus, "getKimiQuotaStatus");
  const refreshKimiQuota = requiredDependency(options.refreshKimiQuota, "refreshKimiQuota");
  const getSessionHistory = requiredDependency(options.getSessionHistory, "getSessionHistory");
  const resumeSessionFromHistory = requiredDependency(
    options.resumeSessionFromHistory,
    "resumeSessionFromHistory"
  );
  const quickMode = options.quickMode || null;
  const disposers = [];

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function on(channel, listener) {
    ipcMain.on(channel, listener);
    disposers.push(() => ipcMain.removeListener(channel, listener));
  }

  // The one owned Dashboard WebContents, its current real main frame, and the
  // exact local page URL. Resolving through a window would break once the page
  // lives in a WebContentsView, and loosening any of the three would widen the
  // Kimi manual-quota capability — neither is acceptable.
  function isTrustedDashboardEvent(event) {
    const contents = getDashboardWebContents();
    if (!contents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    const frame = event && event.senderFrame;
    return event.sender === contents
      && !!frame
      && frame === contents.mainFrame
      && frame.url === DASHBOARD_PAGE_URL;
  }

  function rejectUntrustedDashboardEvent(event) {
    return isTrustedDashboardEvent(event)
      ? null
      : { status: "error", reason: "untrusted-dashboard-sender" };
  }

  // 快捷输入面板（session-hud.html）的信任闸门，与 Dashboard 同一形状：
  // 只认自家 HUD 窗口的主 frame。发送消息 / 切 effort / 选目录都是要花钱
  // 或重置会话上下文的能力，绝不能被别的渲染端冒用。
  function isTrustedHudEvent(event) {
    const getContents = options.getSessionHudWebContents;
    const contents = typeof getContents === "function" ? getContents() : null;
    if (!contents) return false;
    if (typeof contents.isDestroyed === "function" && contents.isDestroyed()) return false;
    const frame = event && event.senderFrame;
    return event.sender === contents
      && !!frame
      && frame === contents.mainFrame
      && frame.url === SESSION_HUD_PAGE_URL;
  }

  function rejectUntrustedHudEvent(event) {
    return isTrustedHudEvent(event)
      ? null
      : { status: "error", reason: "untrusted-hud-sender" };
  }

  // 快捷动作的统一执行口：fn 直接传 options.quick*（依赖缺席时为 undefined，
  // 走 quick-panel-unavailable 降级——不能用箭头包一层，否则恒为函数、
  // 降级分支永远到不了，还会漏出 TypeError 文本）。
  function hudAction(event, fn, args) {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return Promise.resolve(rejected);
    if (typeof fn !== "function") {
      return Promise.resolve({ status: "error", reason: "quick-panel-unavailable" });
    }
    try {
      return Promise.resolve(fn(...(Array.isArray(args) ? args : [])));
    } catch (err) {
      return Promise.resolve({ status: "error", message: err && err.message });
    }
  }

  handle("dashboard:get-snapshot", () => getSessionSnapshot());
  handle("dashboard:get-i18n", () => getI18n());
  // Dashboard gets a narrow, secret-free manual refresh capability. The API
  // key remains inside kimiQuotaRuntime, and only the real local Dashboard
  // main frame may ask for status or trigger the existing refresh path.
  handle("dashboard:get-kimi-quota-status", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || getKimiQuotaStatus();
  });
  handle("dashboard:refresh-kimi-quota", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || refreshKimiQuota();
  });
  on("dashboard:focus-session", (_event, sessionId) =>
    focusSession(sessionId, { requestSource: "dashboard" })
  );
  handle("dashboard:hide-session", (_event, sessionId) => hideSession(sessionId));
  handle("dashboard:open-session-folder", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "dashboard:open-session-folder requires a sessionId string" };
    }
    return openSessionFolder(sessionId);
  });
  // Session history is the resume index for conversations that are no longer
  // running. Rows carry working-directory paths, and resuming spawns a real
  // agent process, so both channels are restricted to the trusted Dashboard
  // frame the same way the Kimi quota capability is.
  handle("dashboard:get-session-history", (event) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    return rejected || getSessionHistory();
  });
  handle("dashboard:resume-session", (event, payload) => {
    const rejected = rejectUntrustedDashboardEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "agentId"
      || keys[1] !== "historyKey"
      || typeof payload.agentId !== "string"
      || !payload.agentId
      || typeof payload.historyKey !== "string"
      || !/^[a-f0-9]{32}$/.test(payload.historyKey)
    ) {
      return { status: "invalid" };
    }
    // No mode field on purpose: the Dashboard can only resume with normal
    // permissions. --dangerously-skip-permissions stays behind the pet menu
    // flow, which confirms it explicitly.
    return resumeSessionFromHistory({
      agentId: payload.agentId,
      historyKey: payload.historyKey,
    });
  });

  handle("dashboard:set-session-alias", (_event, payload) => setSessionAlias(payload));
  handle("dashboard:set-session-automation", (event, payload) => {
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (
      keys.length !== 2
      || keys[0] !== "mode"
      || keys[1] !== "sessionId"
      || typeof payload.sessionId !== "string"
      || !payload.sessionId
      || (payload.mode !== "off" && payload.mode !== "auto-tools")
    ) {
      return { status: "invalid" };
    }
    return setSessionAutomationOverride(
      {
        sessionId: payload.sessionId,
        mode: payload.mode,
      },
      { sender: event && event.sender }
    );
  });
  handle("dashboard:clear-session-automation-grant", (_event, payload) => {
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload)
      : [];
    if (
      keys.length !== 1
      || keys[0] !== "grantId"
      || typeof payload.grantId !== "string"
      || !payload.grantId
    ) {
      return { status: "invalid" };
    }
    return clearSessionAutomationGrant({ grantId: payload.grantId });
  });

  // Dashboard keyboard mode. Every call is restricted to the trusted page and
  // carries the exact round it belongs to; a stale round can neither activate
  // a jump nor cancel the current one.
  //
  // On a platform where the mode is not offered the channels are never
  // registered at all — there is no capability to reach, not merely a handler
  // that answers "unsupported".
  const quickSupported = !!(quickMode
    && typeof quickMode.isSupported === "function"
    && quickMode.isSupported());

  if (quickSupported) {
    const quickResult = (handlerName, event, payload) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      if (rejected) return rejected;
      if (typeof quickMode[handlerName] !== "function") return { status: "unsupported" };
      return quickMode[handlerName](payload);
    };

    handle("dashboard:quick-pending", (event) => {
      const rejected = rejectUntrustedDashboardEvent(event);
      if (rejected) return rejected;
      return { status: "ok", revision: quickMode.getPendingRevision() };
    });
    handle("dashboard:quick-enter", (event, payload) => quickResult("enter", event, payload));
    handle("dashboard:quick-ready", (event, payload) => quickResult("ready", event, payload));
    handle("dashboard:quick-activate", (event, payload) =>
      quickResult("activate", event, payload));
    handle("dashboard:quick-dismiss", (event, payload) =>
      quickResult("dismissFromRenderer", event, payload));
  }

  // 快捷面板（输入块 + 设置块）只保留 i18n 与快捷动作通道；
  // 会话行相关的 focus-session / open-session-folder / set-pinned /
  // open-dashboard 已随会话显示功能一并删除。
  handle("session-hud:get-i18n", () => getI18n());

  // ── 快捷输入面板（悬停 footer）：发消息 / 切设置 / 选目录 / 停止 / 保持显示 ──
  // 全部走 HUD 信任闸门（发消息会花钱、切 effort/目录会重置会话上下文）；
  // 一律先验信任再验载荷，不给伪造 sender 泄露「值非法」之类的差异信息。
  handle("session-hud:send-prompt", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    const text = payload && typeof payload.text === "string" ? payload.text : "";
    // trim 挡不住零宽/格式字符（U+200B 等），先把这类字符剥掉再判空，
    // 否则一条「视觉全空」的消息会白烧一轮对话。
    const visible = text.replace(/[\u200B-\u200F\u2060\u00AD\u180E\uFEFF]/g, "").trim();
    if (!visible) return { status: "error", message: "empty prompt" };
    if (text.length > QUICK_PROMPT_MAX_LENGTH) {
      return { status: "error", message: "prompt too long" };
    }
    return hudAction(event, options.quickSendPrompt, [text]);
  });
  handle("session-hud:set-effort", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    const value = payload && typeof payload.value === "string" ? payload.value : null;
    if (!QUICK_EFFORT_VALUES.includes(value)) {
      return { status: "error", message: `invalid effort "${value}"` };
    }
    return hudAction(event, options.quickSetEffort, [value]);
  });
  handle("session-hud:set-permission-mode", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    const value = payload && typeof payload.value === "string" ? payload.value : null;
    if (!QUICK_PERMISSION_MODES.includes(value)) {
      return { status: "error", message: `invalid permission mode "${value}"` };
    }
    return hudAction(event, options.quickSetPermissionMode, [value]);
  });
  handle("session-hud:pick-working-dir", (event) =>
    hudAction(event, options.quickPickWorkingDir));
  handle("session-hud:stop-chat", (event) =>
    hudAction(event, options.quickStopChat));
  // 二级设置菜单的展开状态：只影响卡片高度与自动收起（hold），无副作用能力。
  // 只认严格布尔 true——其它值一律按收起处理，免得垃圾值把菜单点亮。
  handle("session-hud:set-menu-open", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    return hudAction(event, options.quickSetMenuOpen, [!!(payload && payload.open === true)]);
  });
  on("session-hud:set-hold", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return;
    // reason 白名单：契约只有「输入框聚焦 / 有草稿」两种。放行任意字符串
    // 会让拼错的 hold 永远配对不到 false，把面板永久钉住。
    const reason = payload && typeof payload.reason === "string" ? payload.reason : "";
    if (reason !== "focus" && reason !== "draft") return;
    if (typeof options.quickSetHold === "function") {
      options.quickSetHold(reason, !!(payload && payload.held));
    }
  });

  on("settings:open-dashboard", () => showDashboard({ source: "settings" }));
  on("show-dashboard", () => showDashboard());

  // Both HUD and Dashboard call into this — invoke/handle (not send) so the
  // click handlers can re-enable the Mark-read button if the ack failed.
  handle("session:ack-completion", (_event, sessionId) => {
    if (typeof sessionId !== "string" || !sessionId) {
      return { status: "error", message: "session:ack-completion requires a sessionId string" };
    }
    try {
      const acked = ackSessionCompletion(sessionId);
      if (!acked) return { status: "noop", reason: "not-pending-or-missing" };
      return { status: "ok" };
    } catch (err) {
      return { status: "error", message: err && err.message };
    }
  });

  return {
    dispose() {
      while (disposers.length) {
        const dispose = disposers.pop();
        dispose();
      }
    },
  };
}

module.exports = {
  registerSessionIpc,
};
