"use strict";

// 内置 Claude 对话（阶段一）：会话状态机。
//
// 职责：
// - 从 settingsController 读偏好作为默认值（chatWindowBounds 归窗口层，这里不读）；
// - 维护状态快照与消息列表，把 driver 事件归并成 UI 可渲染的数据；
// - 调起 / 停止 SDK driver；effort 改变 = 开新会话，permissionMode 改变 = 中途热切换；
// - 每次变化都用完整快照回调 onUpdate(state)，由上层推送 chat:update；
// - 登记本 runtime 发起过的会话 id（isOwnedSession），供服务端路由识别内置对话；
// - 恢复历史会话（resumeSession）：停掉当前上下文后用 resume 选项重启 driver，
//   启动前经注入的 loadBackfill 回填消息；getActiveSessionIds 供历史列表排除
//   正在使用的会话。
//
// 状态形状（唯一数据形态）：
//   { status, sessionId, cwd, effort, permissionMode, model, busy, messages,
//     commands, contextUsage }
// commands 是 driver 在 init 后拉取的斜杠指令列表（[{name, description}]，
// 可能为空）；换会话 / 换目录不主动清空，等新会话 init 后整体刷新。
// contextUsage 是最近一轮 result 报上来的上下文用量
// （{ percent, usedTokens, maxTokens }，字段可各自为 null；没数据时为 null）；
// 会话上下文重置（stop / 换会话）会清空它。
//
// 消息时间戳：runtime 新建的每条消息都带 ts（毫秒时间戳，Date.now()）；
// 回填消息沿用回填模块给的历史 ts（有就不覆盖），缺失时补当前时间——
// 保证 state.messages 里每条消息都有数字 ts，渲染端只需处理一种形状。
//
// 权限确认不经过本模块：窗口内卡片已移除，只走桌宠原本的气泡路径
// （Claude Code 的 PermissionRequest hook → 应用 /permission → 气泡）。
// 但 /permission 的「名单内编辑器窗口可见时压制」闸门会误伤内置对话的请求：
// 内置对话由应用自己发起，窗口里没有原生的确认界面可看，压掉即静默丢弃。
// 所以 runtime 用 ownedSessionIds 登记自己发起过的会话 id（driver init 事件），
// 由 isOwnedSession 暴露给服务端 ctx 做豁免判断。登记只增不减：同一 runtime
// 生命周期内出现过的会话 id 都要保持可识别，开新会话 / 换目录 / 清空对话都不清。
//
// system notice 的 text 用渲染端 i18n 的键名（chatNoticeNewSessionForEffort /
// chatNoticeDirChanged），由渲染端查表翻译后展示。

const path = require("path");
const createChatDriver = require("./chat-driver-sdk");
// 上下文用量的归一化规则与 driver 共用一份（见 chat-driver-sdk 的
// normalizeContextUsage）：畸形事件不会把坏形状写进 state。
const normalizeContextUsage = createChatDriver.normalizeContextUsage;

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"];
const DEFAULT_EFFORT = "medium";
const DEFAULT_PERMISSION_MODE = "acceptEdits";
const MAX_MESSAGES = 200;
const NOTICE_NEW_SESSION_FOR_EFFORT = "chatNoticeNewSessionForEffort";
const NOTICE_DIR_CHANGED = "chatNoticeDirChanged";
const NOTICE_HISTORY_RESUMED = "chatHistoryResumed";

const BUSY_STATUSES = new Set(["starting", "thinking", "streaming", "tool"]);

function isEffortLevel(value) {
  return EFFORT_LEVELS.includes(value);
}

function isPermissionMode(value) {
  return PERMISSION_MODES.includes(value);
}

function createChatSessionRuntime(options = {}) {
  const settingsController = options.settingsController || null;
  const platform = options.platform || process.platform;
  const findClaudeCmd = typeof options.findClaudeCmd === "function" ? options.findClaudeCmd : null;
  const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : () => {};
  const driverFactory = typeof options.driverFactory === "function" ? options.driverFactory : createChatDriver;
  // 历史回填注入缝：async (sessionId) => messages[]；主进程侧接 transcript 读取，
  // 测试 / 无历史场景可不注入（null）。回填失败不阻塞恢复。
  const loadBackfill = typeof options.loadBackfill === "function" ? options.loadBackfill : null;

  function readPref(key, fallback, isValid) {
    if (!settingsController || typeof settingsController.get !== "function") return fallback;
    let value;
    try {
      value = settingsController.get(key);
    } catch {
      return fallback;
    }
    return isValid(value) ? value : fallback;
  }

  function persistPref(key, value) {
    if (!settingsController || typeof settingsController.applyUpdate !== "function") return;
    try {
      const result = settingsController.applyUpdate(key, value);
      if (result && typeof result.then === "function") result.catch(() => {});
    } catch {}
  }

  const state = {
    status: "idle",
    sessionId: null,
    cwd: readPref("chatLastWorkingDir", "", (value) => typeof value === "string") || null,
    effort: readPref("chatDefaultEffort", DEFAULT_EFFORT, isEffortLevel),
    permissionMode: readPref("chatDefaultPermissionMode", DEFAULT_PERMISSION_MODE, isPermissionMode),
    model: null,
    busy: false,
    messages: [],
    commands: [],
    contextUsage: null,
  };

  // 本 runtime 发起过的会话 id 登记表（见文件头注释）；只增不减。
  const ownedSessionIds = new Set();

  let driver = null;
  let startInFlight = null;
  // 下一次创建 driver 时要带上的 resume 会话 id（resumeSession 设置，init 到达 /
  // 启动失败 / 上下文重置时清空），同时用于 getActiveSessionIds 排除该会话。
  let pendingResumeSessionId = null;
  // resumeSession 进行中标志：期间拒绝 send，避免和回填 / 重启 driver 交叉。
  let resuming = false;
  // 当前 driver 是否已经收到过用户消息：用于区分“预启动”和“真的要发消息”。
  let turnRequestedInDriver = false;
  // 每次 stop / 换会话 +1；启动期间被取消的 send 按代次丢弃。
  let turnGeneration = 0;
  let messageCounter = 0;
  let streamingTextId = null;
  const toolMessageIds = new Map(); // toolUseId -> 消息 id

  function nextMessageId() {
    messageCounter += 1;
    return `chat-msg-${messageCounter}`;
  }

  function syncBusy() {
    state.busy = BUSY_STATUSES.has(state.status);
  }

  function setStatus(status) {
    state.status = status;
    syncBusy();
  }

  function getState() {
    return {
      ...state,
      messages: state.messages.map((message) => ({ ...message })),
      commands: state.commands.map((command) => ({ ...command })),
      contextUsage: state.contextUsage ? { ...state.contextUsage } : null,
    };
  }

  // 会话上下文重置（stop / newSession / 换目录 / 换 effort / resumeSession）
  // 时清空上下文用量（见文件头注释）。
  function clearContextUsage() {
    state.contextUsage = null;
  }

  // 该 session_id 是否属于本 runtime 发起的内置对话（driver init 事件登记过）。
  // 服务端路由靠它豁免「名单内编辑器窗口可见时压制」闸门。
  function isOwnedSession(sessionId) {
    return typeof sessionId === "string" && sessionId.length > 0 && ownedSessionIds.has(sessionId);
  }

  // 当前占用中的会话 id 列表（含正在恢复、还没等到 init 的会话），
  // 供历史列表排除「正在聊的这个」。去重、不含空值。
  function getActiveSessionIds() {
    const ids = [];
    if (typeof state.sessionId === "string" && state.sessionId) ids.push(state.sessionId);
    if (pendingResumeSessionId && !ids.includes(pendingResumeSessionId)) {
      ids.push(pendingResumeSessionId);
    }
    return ids;
  }

  function emit() {
    try {
      onUpdate(getState());
    } catch (err) {
      console.warn("Clawd: chat runtime onUpdate callback failed:", err && err.message);
    }
  }

  // 从头部把消息裁到 MAX_MESSAGES：system 提示（notice / error）不占额度、也不被
  // 裁掉。回填置顶的「较早的消息已省略」提示一旦被裁，大文件历史就永远看不到
  // 「历史不完整」的说明（见 adoptBackfilledMessages 与 resumeSession）。
  function trimMessagesToLimit(messages) {
    let excess = messages.length - MAX_MESSAGES;
    if (excess <= 0) return;
    for (let index = 0; index < messages.length && excess > 0;) {
      if (messages[index].role === "system") {
        index += 1;
        continue;
      }
      messages.splice(index, 1);
      excess -= 1;
    }
  }

  // 新建消息统一带 ts（毫秒时间戳）；partial 自带 ts 时不覆盖。
  // 回填路径不走这里：由 adoptBackfilledMessages 处理（自带 ts 保留、缺失补当前时间）。
  function addMessage(partial) {
    const message = { id: nextMessageId(), ts: Date.now(), ...partial };
    state.messages.push(message);
    trimMessagesToLimit(state.messages);
    return message;
  }

  function findMessage(id) {
    return state.messages.find((message) => message.id === id) || null;
  }

  function removeMessage(id) {
    const index = state.messages.findIndex((message) => message.id === id);
    if (index === -1) return false;
    state.messages.splice(index, 1);
    return true;
  }

  function addNotice(key) {
    addMessage({ role: "system", kind: "notice", text: key });
  }

  // 采纳回填消息：形状与运行时消息一致，原样浅拷贝；id 缺失 / 重复时补运行时
  // 序号 id，最后套用与实时消息相同的条数上限（从头部丢弃最旧的，system 提示除外）。
  // ts 优先沿用回填模块给的历史时间（有就不覆盖）；缺失时补当前时间，
  // 保证 state.messages 里每条消息都带数字 ts，渲染端不必处理两种形状。
  function adoptBackfilledMessages(rawMessages) {
    const adopted = [];
    const seenIds = new Set();
    for (const raw of Array.isArray(rawMessages) ? rawMessages : []) {
      if (!raw || typeof raw !== "object") continue;
      const id = typeof raw.id === "string" && raw.id && !seenIds.has(raw.id) ? raw.id : nextMessageId();
      seenIds.add(id);
      const ts = typeof raw.ts === "number" && Number.isFinite(raw.ts) ? raw.ts : Date.now();
      adopted.push({ ...raw, id, ts });
    }
    trimMessagesToLimit(adopted);
    return adopted;
  }

  function addError(text) {
    addMessage({ role: "system", kind: "error", text: String(text == null ? "Unknown error" : text) });
  }

  function finalizeStreamingText() {
    if (!streamingTextId) return;
    const message = findMessage(streamingTextId);
    if (message) delete message.streaming;
    streamingTextId = null;
  }

  function forEachRunningTool(callback) {
    for (const message of state.messages) {
      if (message.role === "assistant" && message.kind === "tool" && message.status === "running") {
        callback(message);
      }
    }
  }

  function hasRunningTools() {
    return state.messages.some(
      (message) => message.role === "assistant" && message.kind === "tool" && message.status === "running",
    );
  }

  function finalizeRunningTools(status) {
    forEachRunningTool((message) => {
      message.status = status;
    });
  }

  function appendAssistantText(event) {
    if (typeof event.delta === "string" && event.delta) {
      let message = streamingTextId ? findMessage(streamingTextId) : null;
      if (!message || !message.streaming) {
        message = addMessage({ role: "assistant", kind: "text", text: "", streaming: true });
        streamingTextId = message.id;
      }
      message.text += event.delta;
    } else if (typeof event.text === "string" && event.text) {
      // driver 在拿不到增量时才会发整段文本，直接作为一条完成态消息。
      finalizeStreamingText();
      addMessage({ role: "assistant", kind: "text", text: event.text });
    } else {
      return;
    }
    setStatus("streaming");
    emit();
  }

  function handleToolStart(event) {
    finalizeStreamingText();
    const toolName = typeof event.toolName === "string" && event.toolName ? event.toolName : "Tool";
    const message = addMessage({
      role: "assistant",
      kind: "tool",
      toolName,
      summary: typeof event.summary === "string" ? event.summary : "",
      status: "running",
    });
    // 改动对照：driver 只对 Edit / MultiEdit / Write 构建 diffPreview；
    // 形状不完整（缺任一侧文本）时不给消息加字段。
    const preview = event.diffPreview;
    if (
      preview
      && typeof preview === "object"
      && typeof preview.oldText === "string"
      && typeof preview.newText === "string"
    ) {
      message.diff = { oldText: preview.oldText, newText: preview.newText };
    }
    if (event.toolUseId) toolMessageIds.set(event.toolUseId, message.id);
    setStatus("tool");
    emit();
  }

  function handleToolEnd(event) {
    const messageId = event.toolUseId ? toolMessageIds.get(event.toolUseId) : null;
    const message = messageId ? findMessage(messageId) : null;
    if (message) {
      message.status = event.isError ? "error" : "done";
      if (typeof event.resultText === "string" && event.resultText) {
        message.resultText = event.resultText;
      }
      if (event.toolUseId) toolMessageIds.delete(event.toolUseId);
    }
    if (state.status === "tool" && !hasRunningTools()) setStatus("thinking");
    emit();
  }

  function handleResult(event) {
    finalizeStreamingText();
    const subtype = typeof event.subtype === "string" ? event.subtype : "";
    const isErrorResult = subtype.startsWith("error");
    // 正常情况下 result 到达时不会再有 running 卡片；兜底避免转圈不结束。
    finalizeRunningTools(isErrorResult ? "error" : "done");
    // 上下文用量整体替换（事件缺失 / 形状畸形时为 null，表示「这轮没测到」）。
    state.contextUsage = normalizeContextUsage(event.contextUsage);
    setStatus("idle");
    emit();
  }

  function handleDriverError(event) {
    finalizeStreamingText();
    finalizeRunningTools("error");
    addError(event.message || "Unknown error");
    setStatus("error");
    emit();
  }

  function handleDriverExit(sourceDriver) {
    if (driver === sourceDriver) driver = null;
    // 驱动退出（含未等到 init 的极端情况）：丢弃未消费的 resume 意图。
    pendingResumeSessionId = null;
    turnRequestedInDriver = false;
    finalizeStreamingText();
    if (state.busy) {
      finalizeRunningTools("error");
      setStatus("idle");
    }
    emit();
  }

  function handleDriverEvent(sourceDriver, event) {
    // 已作废 / 已被替换的 driver 的事件一律丢弃。
    if (sourceDriver !== driver) return;
    if (!event || typeof event !== "object") return;
    switch (event.kind) {
      case "init":
        // 驱动已确认会话身份：resume 意图消费完毕（含 fork 出新 id 的情况）。
        pendingResumeSessionId = null;
        if (event.sessionId) {
          state.sessionId = event.sessionId;
          // 登记会话归属：服务端路由靠它豁免「编辑器可见时压制」（见文件头注释）。
          ownedSessionIds.add(event.sessionId);
        }
        if (event.model) state.model = event.model;
        if (state.status === "starting") setStatus(turnRequestedInDriver ? "thinking" : "idle");
        emit();
        return;
      case "commands":
        // 指令列表是全量的：换会话 / 换目录不清空（旧列表仍可用），
        // 新会话 init 后会重新拉取并整体覆盖。
        state.commands = (Array.isArray(event.commands) ? event.commands : [])
          .filter((command) => command && typeof command.name === "string" && command.name)
          .map((command) => ({
            name: command.name,
            description: typeof command.description === "string" ? command.description : "",
          }));
        emit();
        return;
      case "text":
        appendAssistantText(event);
        return;
      case "thinking":
        if (state.status !== "tool") setStatus("thinking");
        emit();
        return;
      case "tool-start":
        handleToolStart(event);
        return;
      case "tool-end":
        handleToolEnd(event);
        return;
      case "result":
        handleResult(event);
        return;
      case "error":
        handleDriverError(event);
        return;
      case "exit":
        handleDriverExit(sourceDriver);
        return;
      default:
        return;
    }
  }

  async function disposeDriver() {
    turnRequestedInDriver = false;
    const current = driver;
    driver = null;
    if (!current) return;
    try {
      if (typeof current.dispose === "function") await current.dispose();
    } catch {}
  }

  // 换会话上下文：停掉 driver、清空 sessionId/model、清临时工具映射，保留界面消息。
  // turnGeneration 自增同时取消在途的 startDriver（其内部按代次核对后放弃启动）。
  async function resetSessionContext(noticeKey) {
    turnGeneration += 1;
    await disposeDriver();
    pendingResumeSessionId = null;
    state.sessionId = null;
    state.model = null;
    finalizeStreamingText();
    // 旧 driver 的 exit / result 已不会再被处理（事件按 sourceDriver 丢弃），
    // 仍 running 的工具卡片在这里收尾，避免一直显示「运行中」。
    finalizeRunningTools("done");
    toolMessageIds.clear();
    clearContextUsage();
    if (noticeKey) addNotice(noticeKey);
    setStatus("idle");
  }

  async function startDriver() {
    // 启动可能被 stop / 换会话取消：记住进入时的代次，await 之后核对；
    // 被取消就放弃启动，不留下与当前回合无关的 driver。
    const generation = turnGeneration;
    if (driver) await disposeDriver();
    // dispose 期间被 stop / 换会话取消：不再继续启动。
    if (generation !== turnGeneration) return false;
    state.sessionId = null;
    state.model = null;
    setStatus("starting");
    emit();

    let executable = null;
    if (findClaudeCmd) {
      try {
        const command = await findClaudeCmd();
        // findClaudeCmd 可能只回退到裸命令名（"claude"）；那不是绝对路径，
        // 交给 SDK 自带引擎更稳妥。
        // Windows 上 npm 安装的 claude 是 .cmd/.bat shim：SDK 直接 spawn 不经
        // shell，Node 会以 EINVAL 拒绝启动，这类路径同样不交付。
        const isWindowsShim = platform === "win32" && /\.(cmd|bat)$/i.test(command);
        if (
          typeof command === "string"
          && command
          && path.isAbsolute(command)
          && !isWindowsShim
        ) {
          executable = command;
        }
      } catch {}
    }
    // 找可执行文件期间被 stop / 换会话：不再创建 driver。
    if (generation !== turnGeneration) return false;

    let nextDriver = null;
    try {
      nextDriver = driverFactory({
        cwd: state.cwd,
        effort: state.effort,
        permissionMode: state.permissionMode,
        executable,
        // 历史续聊：带上待恢复的会话 id（普通新会话为 null）。
        resume: pendingResumeSessionId,
        onEvent: (event) => handleDriverEvent(nextDriver, event),
      });
    } catch (err) {
      addError(`failed to create chat driver: ${(err && err.message) || String(err)}`);
      setStatus("error");
      emit();
      return false;
    }
    driver = nextDriver;

    let started = false;
    try {
      started = await nextDriver.start();
    } catch (err) {
      started = false;
      if (driver === nextDriver) driver = null;
      addError(`failed to start chat driver: ${(err && err.message) || String(err)}`);
      setStatus("error");
      emit();
      return false;
    }
    // start() 期间被 stop / 换会话取消：释放刚起的 driver，不留下后台会话。
    if (generation !== turnGeneration) {
      if (driver === nextDriver) {
        driver = null;
        turnRequestedInDriver = false;
      }
      try { await nextDriver.dispose(); } catch {}
      return false;
    }
    if (!started) {
      if (driver === nextDriver) driver = null;
      // driver.start() 内部已发 error 事件；这里只兜底状态。
      if (state.status === "starting") {
        setStatus("error");
        emit();
      }
      return false;
    }
    return true;
  }

  async function ensureStarted() {
    if (driver && typeof driver.isRunning === "function" && driver.isRunning()) return true;
    // 只复用同一代次的在途启动；被 stop / 换会话作废的启动不再挂住新的 send。
    if (startInFlight && startInFlight.generation === turnGeneration) return startInFlight.promise;
    if (!state.cwd) return false;
    const entry = { generation: turnGeneration, promise: startDriver() };
    startInFlight = entry;
    try {
      return await entry.promise;
    } finally {
      if (startInFlight === entry) startInFlight = null;
    }
  }

  // 附件元数据只保留渲染需要的字段；没有可用项时不产生该可选字段。
  // thumb 是渲染端压缩过的小图 data URL，可为空。
  function normalizeAttachments(value) {
    if (!Array.isArray(value)) return [];
    const attachments = [];
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const attachment = {
        name: typeof item.name === "string" ? item.name : "",
        size: typeof item.size === "number" && Number.isFinite(item.size) ? item.size : 0,
        isImage: !!item.isImage,
      };
      if (typeof item.thumb === "string" && item.thumb) attachment.thumb = item.thumb;
      attachments.push(attachment);
    }
    return attachments;
  }

  // options 可选：{ blocks, attachments }
  // - blocks：转发给 driver 的 Anthropic content block 数组（图片 / PDF 附件本体），
  //   不放进 state；
  // - attachments：附件元数据数组，存进用户消息对象供界面展示已发送的附件。
  // 文本与 blocks 都空时拒绝；只有附件没有文字时消息 text 为空字符串，渲染端
  // 只看 attachments。
  async function send(text, options = {}) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    const blocks = options && Array.isArray(options.blocks) ? options.blocks : [];
    if (!trimmed && !blocks.length) return false;
    if (!state.cwd) return false;
    // 恢复历史会话期间不接受新输入（界面同时被 busy 禁用，这里是兜底）。
    if (resuming) return false;
    const partial = { role: "user", kind: "text", text: trimmed };
    const attachments = normalizeAttachments(options && options.attachments);
    if (attachments.length) partial.attachments = attachments;
    const userMessage = addMessage(partial);
    turnRequestedInDriver = true;
    const generation = turnGeneration;
    setStatus("thinking");
    emit();
    const started = await ensureStarted();
    if (!started) {
      if (generation !== turnGeneration) {
        // 启动被 stop / 换会话取消：撤回乐观追加的用户消息，
        // 它从未投递，不能显示成已发送（标记已由 disposeDriver 清理）。
        removeMessage(userMessage.id);
        emit();
      } else {
        turnRequestedInDriver = false;
      }
      return false;
    }
    // 等会话启动期间用户可能按了停止 / 换了会话：这轮不再发出去，撤回用户消息。
    if (generation !== turnGeneration) {
      removeMessage(userMessage.id);
      emit();
      return false;
    }
    if (!driver || typeof driver.send !== "function") return false;
    // 状态保持在 starting，等 SDK 的 init 事件到达后再切 thinking。
    return driver.send(trimmed, blocks) !== false;
  }

  async function stop() {
    turnGeneration += 1;
    if (driver && typeof driver.isRunning === "function" && driver.isRunning()) {
      try {
        await driver.interrupt();
      } catch {}
    }
    // 立即回 idle；中断后 SDK 抛出的异常由 driver 吞掉，exit 事件也会再兜底一次。
    finalizeStreamingText();
    // 中断时仍 running 的工具卡片不会再收到 tool-end / result，先行收尾，
    // 否则渲染端会一直显示「运行中」。
    finalizeRunningTools("done");
    clearContextUsage();
    setStatus("idle");
    emit();
    return true;
  }

  async function newSession() {
    turnGeneration += 1;
    await disposeDriver();
    pendingResumeSessionId = null;
    state.sessionId = null;
    state.model = null;
    state.messages = [];
    streamingTextId = null;
    toolMessageIds.clear();
    clearContextUsage();
    setStatus("idle");
    emit();
    return true;
  }

  // 恢复历史会话：停掉当前会话上下文（不击杀整个 runtime），先回填历史消息，
  // 再用 resume 选项重启 driver；cwd 保持当前工作目录不变。
  // 回填是尽力而为，失败不阻塞恢复；新 driver 启动失败时状态回错误、
  // 消息保留回填内容。返回 { status:'ok' } 或 { status:'error', message }。
  async function resumeSession(options = {}) {
    const rawId = options && options.sessionId;
    const sessionId = typeof rawId === "string" ? rawId.trim() : "";
    if (!sessionId) return { status: "error", message: "invalid session id" };
    if (!state.cwd) return { status: "error", message: "no working directory" };
    if (resuming) return { status: "error", message: "resume already in progress" };

    resuming = true;
    turnGeneration += 1;
    const generation = turnGeneration;
    try {
      // 清理顺序：旧 driver 先释放，再回填消息，最后启动带 resume 的新 driver。
      await disposeDriver();
      pendingResumeSessionId = null;
      state.sessionId = null;
      state.model = null;
      finalizeStreamingText();
      // 旧 driver 的事件不会再被处理，仍 running 的工具卡片在这里收尾；
      // 稍后回填会用历史记录里的最终状态整体替换。
      finalizeRunningTools("done");
      toolMessageIds.clear();
      clearContextUsage();
      setStatus("starting");
      emit();

      // 回填缝优先用在调用参数里转交的实现（IPC 侧注入），其次用构造时注入的。
      const backfillLoader = options && typeof options.loadBackfill === "function"
        ? options.loadBackfill
        : loadBackfill;
      let backfill = [];
      if (backfillLoader) {
        try {
          const loaded = await backfillLoader(sessionId);
          // 兼容两种回填结果形态：直接给消息数组，或 { messages, truncated }。
          if (Array.isArray(loaded)) backfill = loaded;
          else if (loaded && Array.isArray(loaded.messages)) backfill = loaded.messages;
        } catch (err) {
          console.warn("Clawd: chat session backfill failed:", err && err.message);
        }
      }
      // 回填期间被 stop / 换会话 / 新会话取消：不再启动恢复。
      if (generation !== turnGeneration) {
        if (state.status === "starting") {
          setStatus("idle");
          emit();
        }
        return { status: "error", message: "resume cancelled" };
      }

      state.messages = adoptBackfilledMessages(backfill);
      addNotice(NOTICE_HISTORY_RESUMED);
      emit();

      pendingResumeSessionId = sessionId;
      const started = await startDriver();
      if (!started) {
        if (pendingResumeSessionId === sessionId) pendingResumeSessionId = null;
        return {
          status: "error",
          message: generation === turnGeneration ? "failed to start resumed session" : "resume cancelled",
        };
      }
      // 续聊模式下 CLI 要等第一条输入才发 init 事件：不能等 init 才恢复可输入状态，
      // 否则界面一直停在「工作中」（发送禁用、只剩停止）。启动成功即视为就绪；
      // 第一条消息发出时 init 会到达，turnRequestedInDriver 路径会接管状态流转。
      if (generation === turnGeneration && !turnRequestedInDriver && state.status === "starting") {
        setStatus("idle");
        emit();
      }
      return { status: "ok" };
    } finally {
      resuming = false;
    }
  }

  async function setEffort(value) {
    if (!isEffortLevel(value)) return false;
    if (value === state.effort) return true;
    state.effort = value;
    persistPref("chatDefaultEffort", value);
    // effort 只在会话开始时生效：必须开新会话（界面消息保留，加 notice 说明）。
    // 首次改档位（还没有目录 / 会话）没有旧会话可换，不加提示，避免误导。
    const hadContext = !!state.cwd || !!state.sessionId;
    await resetSessionContext(hadContext ? NOTICE_NEW_SESSION_FOR_EFFORT : null);
    emit();
    return true;
  }

  async function setPermissionMode(value) {
    if (!isPermissionMode(value)) return false;
    if (value === state.permissionMode) return true;
    state.permissionMode = value;
    persistPref("chatDefaultPermissionMode", value);
    // 权限模式可以中途生效：driver 在运行时直接热切换。
    if (driver && typeof driver.isRunning === "function" && driver.isRunning()) {
      try {
        await driver.setPermissionMode(value);
      } catch {}
    }
    emit();
    return true;
  }

  async function setWorkingDir(dir) {
    if (typeof dir !== "string" || !dir) return false;
    if (dir === state.cwd) return true;
    // 之前已有目录 / 会话才算「切换」；首次选择目录不该提示「已开始新会话」。
    const hadContext = !!state.cwd || !!state.sessionId;
    state.cwd = dir;
    persistPref("chatLastWorkingDir", dir);
    // SDK 会话上下文绑定工作目录：换目录必须开新会话（保留消息并提示）。
    await resetSessionContext(hadContext ? NOTICE_DIR_CHANGED : null);
    emit();
    return true;
  }

  async function dispose() {
    await disposeDriver();
  }

  return {
    getState,
    isOwnedSession,
    getActiveSessionIds,
    send,
    stop,
    newSession,
    resumeSession,
    setEffort,
    setPermissionMode,
    setWorkingDir,
    ensureStarted,
    dispose,
  };
}

module.exports = createChatSessionRuntime;
module.exports.createChatSessionRuntime = createChatSessionRuntime;
