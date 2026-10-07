"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
// 新建会话的两个开关：允许值表与主进程拼启动参数用的是同一份，不另抄一遍。
const { PERMISSION_MODES, EFFORT_LEVELS } = require("./session-new-options");
// 粘贴文件的字节上限也共用一份（主进程落盘时还会再卡一次）。
const { MAX_PASTED_BYTES } = require("./pasted-file-store");

const DASHBOARD_PAGE_URL = pathToFileURL(path.join(__dirname, "dashboard.html")).toString();
const SESSION_HUD_PAGE_URL = pathToFileURL(path.join(__dirname, "session-hud.html")).toString();

// 输入框文本上限：一句话，远不至于要 10 万字符（投递层另有 2000 的更紧上限）。
const QUICK_PROMPT_MAX_LENGTH = 100000;
// 附件个数的上限：面板自己最多挂 4 个，这里给一个宽松的天花板，只用来挡脏数据
// （数字一变主进程就要重算窗口高度）。
const MAX_QUICK_ATTACHMENTS = 8;

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
  // 只认自家 HUD 窗口的主 frame。发消息会把文字打进终端里那个真实会话、
  // 新建会话会在终端里开进程、选文件夹会弹系统对话框——这些能力绝不能
  // 被别的渲染端冒用。
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

  // 快捷面板只保留 i18n 与快捷动作通道；会话行相关的 focus-session /
  // open-session-folder / set-pinned / open-dashboard 已随会话显示功能一并删除。
  handle("session-hud:get-i18n", () => getI18n());

  // ── 快捷输入面板（悬停 footer）：发消息 / 保持显示 ──
  // 全部走 HUD 信任闸门（发出去的话会进终端里那个真实会话）；
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
  // 手选目标会话：列表可能过期，主进程会再核一遍会话还在不在。
  handle("session-hud:select-session", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    const sessionId = payload && typeof payload.sessionId === "string" ? payload.sessionId : "";
    if (!sessionId) return { status: "error", message: "empty session id" };
    return hudAction(event, options.quickSelectSession, [sessionId]);
  });
  // 面板里点一条历史会话 = 把那个会话重新拉起来接着聊。载荷只有 agent 与不透明
  // 的 historyKey（和 Dashboard 的 dashboard:resume-session 同一套取舍）：项目
  // 目录、profile 都由主进程回查，渲染端指定不了。
  // 这里**不带**权限模式参数——续跑只用普通权限，「跳过确认」仍然只走宠物菜单
  // 里那个有确认弹窗的入口。
  handle("session-hud:resume-session", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (keys.length !== 2 || keys[0] !== "agentId" || keys[1] !== "historyKey") {
      return { status: "invalid" };
    }
    if (typeof payload.agentId !== "string" || !payload.agentId) return { status: "invalid" };
    if (typeof payload.historyKey !== "string" || !/^[a-f0-9]{32}$/.test(payload.historyKey)) {
      return { status: "invalid" };
    }
    return hudAction(event, options.quickResumeSession, [
      { agentId: payload.agentId, historyKey: payload.historyKey },
    ]);
  });
  // 开/关哪个菜单（点状态行 = 会话菜单，点齿轮 = 设置菜单）：只影响卡片高度与
  // 自动收起（hold），无副作用能力。menu 只认 null / "session" / "settings"。
  handle("session-hud:set-menu-open", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    const menu = payload && (payload.menu === "session" || payload.menu === "settings")
      ? payload.menu
      : null;
    return hudAction(event, options.quickSetMenuOpen, [menu]);
  });
  // 排一个「新会话」占位（真正的终端要等第一句话发出去才开）。
  handle("session-hud:new-session", (event) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    return hudAction(event, options.quickCreateSession);
  });
  // 取消那个占位。
  handle("session-hud:cancel-pending-session", (event) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    return hudAction(event, options.quickCancelPendingSession);
  });
  // 选「新建会话」落在哪个文件夹（主进程弹系统文件夹选择框）。
  handle("session-hud:pick-folder", (event) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    return hudAction(event, options.quickPickFolder);
  });
  // 「📎 添加文件」：系统选文件框，返回绝对路径（面板把它填进输入框）。
  handle("session-hud:pick-file", (event) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    return hudAction(event, options.quickPickFiles);
  });
  // 粘贴进来的图片/文件：渲染端把字节交过来，主进程落成临时文件并回路径。
  // 字节是二进制的，形状和大小都要在这道闸门里卡死，别让渲染端塞别的东西。
  handle("session-hud:save-pasted-file", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (keys.length !== 3 || keys[0] !== "data" || keys[1] !== "name" || keys[2] !== "type") {
      return { status: "invalid" };
    }
    if (typeof payload.name !== "string" || payload.name.length > 200) return { status: "invalid" };
    if (typeof payload.type !== "string" || payload.type.length > 200) return { status: "invalid" };
    const bytes = payload.data;
    const byteLength = bytes && typeof bytes.byteLength === "number" ? bytes.byteLength : -1;
    if (byteLength <= 0) return { status: "invalid" };
    if (byteLength > MAX_PASTED_BYTES) return { status: "too-large" };
    return hudAction(event, options.quickSavePastedFile, [payload]);
  });

  // 切「新建会话」的权限模式 / 思考强度。这两个值会变成 claude 的启动参数，
  // 所以按「键 → 允许值」表逐项卡形状：表是唯一入口，别的字符串一律 invalid。
  const NEW_SESSION_OPTION_VALUES = {
    permissionMode: PERMISSION_MODES,
    effort: EFFORT_LEVELS,
  };
  handle("session-hud:set-new-session-option", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload).sort()
      : [];
    if (keys.length !== 2 || keys[0] !== "key" || keys[1] !== "value") {
      return { status: "invalid" };
    }
    const allowed = NEW_SESSION_OPTION_VALUES[payload.key];
    if (!allowed || !allowed.includes(payload.value)) return { status: "invalid" };
    return hudAction(event, options.quickSetNewSessionOption, [payload.key, payload.value]);
  });
  // 把强度**应用到当前目标**：目标是正在跑的本地 Claude Code 会话时，主进程
  // 会把官方的 /effort 命令送进那个会话。渲染端只在"松手"（change）时调它，
  // 拖动过程中走上面的 set-new-session-option，免得每动一格就发一条命令。
  handle("session-hud:apply-effort", (event, payload) => {
    const rejected = rejectUntrustedHudEvent(event);
    if (rejected) return rejected;
    const keys = payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload)
      : [];
    if (keys.length !== 1 || keys[0] !== "level") return { status: "invalid" };
    if (!EFFORT_LEVELS.includes(payload.level)) return { status: "invalid" };
    return hudAction(event, options.quickApplyEffort, [payload.level]);
  });
  // 指针进出卡片时上报：卡片外的透明区让点击穿透到下面的应用。
  // 单向 send（高频、不需要回执），主进程侧另有轮询兜底。
  on("session-hud:set-click-through", (event, payload) => {
    if (!isTrustedHudEvent(event)) return;
    if (typeof options.quickSetClickThrough === "function") {
      options.quickSetClickThrough(!!(payload && payload.through === true));
    }
  });
  // 输入框上挂了几个附件（面板那边挂 / 删 / 清之后上报）。附件本身留在渲染端，
  // 主进程只要这个数字：卡片要不要多出一行标签、面板要不要因此不自动收起。
  on("session-hud:set-attachments", (event, payload) => {
    if (!isTrustedHudEvent(event)) return;
    const count = payload && typeof payload.count === "number" ? payload.count : null;
    if (count === null || !Number.isInteger(count) || count < 0 || count > MAX_QUICK_ATTACHMENTS) return;
    if (typeof options.quickSetAttachments === "function") options.quickSetAttachments(count);
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
