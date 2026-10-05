"use strict";

// 内置 Claude 对话（阶段一）：SDK driver。
//
// 职责：
// 1. 动态加载 ESM 包 @anthropic-ai/claude-agent-sdk（CommonJS 里必须 await import）；
// 2. 用异步队列把 prompt 做成 AsyncIterable<SDKUserMessage>，支持多轮对话；
// 3. 把 SDK 的原始消息 / 流事件规整成统一的 onEvent 事件；
// 4. 所有异常都转成 onEvent({ kind: 'error' | 'notice', ... })，不向调用方冒泡。
// 权限请求不在此处理：驱动不注入权限回调，SDK 会让请求走 Claude Code 的
// PermissionRequest hook（应用自己的 /permission + 桌宠气泡）。
//
// 统一 onEvent 形态：
//   { kind:'init', sessionId, model }
//   { kind:'commands', commands:[{ name, description }] }
//   { kind:'text', delta?, text? }
//   { kind:'thinking', delta }
//   { kind:'tool-start', toolName, summary, toolUseId, diffPreview? }
//   { kind:'tool-end', toolUseId, isError, resultText }
//   { kind:'result', subtype, usage, contextUsage }
//   { kind:'error', message }
//   { kind:'exit', code }
// diffPreview 只对会写文件的工具出现，形状 { oldText, newText }（见 buildDiffPreview）；
// contextUsage 是 { percent, usedTokens, maxTokens }（字段可各自为 null）或 null。

const INPUT_SUMMARY_LIMIT = 200;
const TOOL_RESULT_LIMIT = 2000;
// 改动对照每侧最大字符数：超长截断加省略号（与 tool_result 同一约定）。
const DIFF_TEXT_LIMIT = 2000;
// MultiEdit 多条改动合并成单一对照文本时的分隔行。
const DIFF_ENTRY_SEPARATOR = "\n---\n";
const DISPOSE_GRACE_MS = 1500;
const SUPPORTED_COMMANDS_LIMIT = 100;
// getContextUsage 是控制通道请求：给个上限，避免异常情况下卡住 result 事件。
const CONTEXT_USAGE_TIMEOUT_MS = 2000;

const defaultSdkLoader = () => import("@anthropic-ai/claude-agent-sdk");

function clampText(value, limit) {
  const text = typeof value === "string" ? value : String(value == null ? "" : value);
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// 工具卡片副标题：Bash 显示命令，Edit/Write/Read 显示文件路径，其余输入转 JSON 截断。
function summarizeToolInput(toolName, input) {
  const source = isPlainObject(input) ? input : {};
  if (toolName === "Bash" && typeof source.command === "string") {
    return clampText(source.command, INPUT_SUMMARY_LIMIT);
  }
  if (
    (toolName === "Edit" || toolName === "Write" || toolName === "Read")
    && typeof source.file_path === "string"
  ) {
    return clampText(source.file_path, INPUT_SUMMARY_LIMIT);
  }
  let json;
  try {
    json = JSON.stringify(source);
  } catch {
    json = String(source);
  }
  return clampText(json || "", INPUT_SUMMARY_LIMIT);
}

// tool_result 的 content 可能是字符串或内容块数组，只取可读文本并截断。
function extractResultText(content) {
  if (typeof content === "string") return clampText(content, TOOL_RESULT_LIMIT);
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return clampText(parts.join("\n"), TOOL_RESULT_LIMIT);
}

// 工具改动对照：只对会写文件的工具构建。Edit 取 old_string/new_string；
// MultiEdit 把各条 edits 按顺序各自拼接（两侧用同一分隔行，保证对照行对齐）；
// Write 没有旧文本，oldText 固定为空字符串。必需的输入缺失或不是字符串时返回
// null——调用方据此不给 tool-start 加 diffPreview 字段（而不是给出误导性的空对照）。
function buildDiffPreview(toolName, input) {
  const source = isPlainObject(input) ? input : {};
  if (toolName === "Edit") {
    if (typeof source.old_string !== "string" || typeof source.new_string !== "string") return null;
    return {
      oldText: clampText(source.old_string, DIFF_TEXT_LIMIT),
      newText: clampText(source.new_string, DIFF_TEXT_LIMIT),
    };
  }
  if (toolName === "Write") {
    if (typeof source.content !== "string") return null;
    return { oldText: "", newText: clampText(source.content, DIFF_TEXT_LIMIT) };
  }
  if (toolName === "MultiEdit") {
    if (!Array.isArray(source.edits)) return null;
    const oldParts = [];
    const newParts = [];
    for (const edit of source.edits) {
      if (!isPlainObject(edit)) continue;
      if (typeof edit.old_string !== "string" || typeof edit.new_string !== "string") continue;
      oldParts.push(edit.old_string);
      newParts.push(edit.new_string);
    }
    if (!oldParts.length) return null;
    return {
      oldText: clampText(oldParts.join(DIFF_ENTRY_SEPARATOR), DIFF_TEXT_LIMIT),
      newText: clampText(newParts.join(DIFF_ENTRY_SEPARATOR), DIFF_TEXT_LIMIT),
    };
  }
  return null;
}

// 上下文用量的归一化：SDK 的 SDKControlGetContextUsageResponse（d.ts）里
// 已用 token 是 totalTokens、上限是 maxTokens、占比是 percentage（0-100 的整数）。
// 这里只挑界面需要的三个字段，非有限数字一律归 null；一个都拿不到时整体返回
// null（等价于「这次查不到」）。runtime 也复用这个规则，形状只此一份。
// 函数保持幂等：已归一化的 { percent, usedTokens, maxTokens } 再喂一次结果不变
// （driver 事件里的 contextUsage 已是这个形状，runtime 收到后会二次校验）。
function normalizeContextUsage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const readNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const normalized = {
    percent: readNumber(raw.percent) ?? readNumber(raw.percentage),
    usedTokens: readNumber(raw.usedTokens) ?? readNumber(raw.totalTokens),
    maxTokens: readNumber(raw.maxTokens),
  };
  if (normalized.percent === null && normalized.usedTokens === null && normalized.maxTokens === null) {
    return null;
  }
  return normalized;
}

function createChatDriver(options = {}) {
  const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd();
  const effort = options.effort || null;
  const permissionMode = options.permissionMode || "default";
  const model = options.model || null;
  const executable = typeof options.executable === "string" && options.executable ? options.executable : null;
  // 历史会话续聊：合法非空 sessionId 时透传给 SDK 的 resume 选项（恢复既有会话）。
  const resume = typeof options.resume === "string" && options.resume.trim() ? options.resume.trim() : null;
  const onEvent = typeof options.onEvent === "function" ? options.onEvent : () => {};
  const onExit = typeof options.onExit === "function" ? options.onExit : () => {};
  const sdkLoader = typeof options.sdkLoader === "function" ? options.sdkLoader : defaultSdkLoader;
  const scheduleLater = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;

  let query = null;
  let consumePromise = null;
  let abortController = null;
  let sessionId = null;
  let modelName = model;
  let running = false;
  let disposed = false;
  let stopping = false;
  // 本条 assistant 消息是否已经通过 stream_event 增量送出文本；
  // 是的话，随后的完整 assistant 消息不再重复发全文。
  let textDeltaSeen = false;
  // 上一条处理过的 assistant 消息 id：同一条消息可能被 SDK 重复送出
  // （增量一次、完成后又一次），按 id 去重避免界面上出现重复文字。
  let lastAssistantMessageId = null;
  // 本轮是否已经报过 error，避免 error 帧 + result 错误帧重复显示。
  let turnErrorEmitted = false;
  const emittedToolStarts = new Set();

  // ---- prompt 异步队列：数组缓存 + 等待者 resolve ----
  const pendingInputs = [];
  const inputWaiters = [];
  let inputClosed = false;

  function resolveInputWaiter(message) {
    const waiter = inputWaiters.shift();
    if (!waiter) return false;
    waiter({ value: message, done: false });
    return true;
  }

  function pushInput(message) {
    if (disposed || inputClosed) return false;
    if (!resolveInputWaiter(message)) pendingInputs.push(message);
    return true;
  }

  function closeInput() {
    inputClosed = true;
    while (inputWaiters.length) {
      const waiter = inputWaiters.shift();
      waiter({ value: undefined, done: true });
    }
  }

  const promptIterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pendingInputs.length) {
            return Promise.resolve({ value: pendingInputs.shift(), done: false });
          }
          if (inputClosed || disposed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => inputWaiters.push(resolve));
        },
        return() {
          closeInput();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(error) {
          closeInput();
          return Promise.reject(error);
        },
      };
    },
  };

  function emitEvent(event) {
    try {
      onEvent(event);
    } catch (err) {
      console.warn("Clawd: chat driver onEvent callback failed:", err && err.message);
    }
  }

  function emitError(message) {
    turnErrorEmitted = true;
    emitEvent({ kind: "error", message: clampText(String(message == null ? "Unknown error" : message), TOOL_RESULT_LIMIT) });
  }

  function handleStreamEvent(message) {
    if (message.parent_tool_use_id) return;
    const event = message.event;
    if (!event || typeof event !== "object") return;
    if (event.type === "message_start") {
      textDeltaSeen = false;
      return;
    }
    if (event.type !== "content_block_delta") return;
    const delta = event.delta;
    if (!delta || typeof delta !== "object") return;
    if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
      textDeltaSeen = true;
      emitEvent({ kind: "text", delta: delta.text });
      return;
    }
    if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
      emitEvent({ kind: "thinking", delta: delta.thinking });
    }
  }

  function handleAssistantMessage(message) {
    const content = message.message && Array.isArray(message.message.content)
      ? message.message.content
      : [];
    const isSubagent = !!message.parent_tool_use_id;
    const messageId = !isSubagent && message.message && typeof message.message.id === "string"
      ? message.message.id
      : null;
    const repeatedMessage = messageId !== null && messageId === lastAssistantMessageId;
    if (!isSubagent) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        // 有增量时不再发全文；同一条消息重复到达时同样不再发（去重）；
        // 没有 stream_event 的旧路径才走这里兜底。
        if (block.type === "text" && typeof block.text === "string" && block.text && !textDeltaSeen && !repeatedMessage) {
          emitEvent({ kind: "text", text: block.text });
        }
      }
      if (!repeatedMessage) textDeltaSeen = false;
      if (messageId) lastAssistantMessageId = messageId;
    }
    if (message.error) emitError(message.error);
    for (const block of content) {
      if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
      const toolUseId = typeof block.id === "string" ? block.id : null;
      if (toolUseId && emittedToolStarts.has(toolUseId)) continue;
      if (toolUseId) emittedToolStarts.add(toolUseId);
      const toolStartEvent = {
        kind: "tool-start",
        toolName: typeof block.name === "string" ? block.name : "Tool",
        summary: summarizeToolInput(block.name, block.input),
        toolUseId,
      };
      const diffPreview = buildDiffPreview(block.name, block.input);
      if (diffPreview) toolStartEvent.diffPreview = diffPreview;
      emitEvent(toolStartEvent);
    }
  }

  function handleUserMessage(message) {
    const content = message.message && Array.isArray(message.message.content)
      ? message.message.content
      : [];
    for (const block of content) {
      if (!block || typeof block !== "object" || block.type !== "tool_result") continue;
      emitEvent({
        kind: "tool-end",
        toolUseId: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
        isError: !!block.is_error,
        resultText: extractResultText(block.content),
      });
    }
  }

  // init 事件之后才可调用 supportedCommands()：流式输入模式下 CLI 收到第一条
  // 消息才发 init，只有到这时 query 才真正连上会话。查询期间 query 可能已被
  // 替换 / 销毁，返回后核对仍是同一个实例才发事件。查询失败只记一行日志，
  // 不影响会话本身（指令列表只服务输入框补全）。
  async function requestSupportedCommands() {
    const queryInstance = query;
    if (!queryInstance) return;
    if (typeof queryInstance.supportedCommands !== "function") {
      console.warn("Clawd: chat driver supportedCommands unavailable on this SDK query");
      return;
    }
    let commands;
    try {
      commands = await queryInstance.supportedCommands();
    } catch (err) {
      console.warn("Clawd: chat driver supportedCommands failed:", err && err.message);
      return;
    }
    if (disposed || query !== queryInstance) return;
    const list = (Array.isArray(commands) ? commands : [])
      // SDK 返回的 name 实测不带前导斜杠（如 "deep-research"）：统一补上，
      // 渲染端按「输入以 / 开头」匹配，缺斜杠的条目会全部匹配不上。
      .map((command) => {
        if (!command || typeof command.name !== "string" || !command.name.trim()) return null;
        const raw = command.name.trim();
        return {
          name: raw.startsWith("/") ? raw : `/${raw}`,
          description: typeof command.description === "string" ? command.description : "",
        };
      })
      .filter(Boolean)
      .slice(0, SUPPORTED_COMMANDS_LIMIT);
    emitEvent({ kind: "commands", commands: list });
  }

  // 上下文用量：只在当前 query 实例可用且实现了 getContextUsage 时尝试。
  // detail:'summary' 表示只用上一轮响应里的用量做估算，不额外触发按分词计费的
  // 调用（d.ts 里 'full' 会逐类目调用分词接口，对每轮刷新来说太重）。
  // 任何失败（方法缺失 / 请求报错 / 超时）都静默返回 null，不影响 result 上报。
  async function fetchContextUsage() {
    const queryInstance = query;
    if (!queryInstance || typeof queryInstance.getContextUsage !== "function") return null;
    try {
      const request = Promise.resolve(queryInstance.getContextUsage({ detail: "summary" }));
      const timeout = new Promise((resolve) => {
        const timer = scheduleLater(() => resolve(null), CONTEXT_USAGE_TIMEOUT_MS);
        if (timer && typeof timer.unref === "function") timer.unref();
      });
      return normalizeContextUsage(await Promise.race([request, timeout]));
    } catch {
      return null;
    }
  }

  async function handleSdkMessage(message) {
    if (!message || typeof message !== "object") return;
    if (typeof message.session_id === "string" && message.session_id) sessionId = message.session_id;

    switch (message.type) {
      case "system": {
        if (message.subtype === "init") {
          if (typeof message.model === "string" && message.model) modelName = message.model;
          emitEvent({ kind: "init", sessionId: message.session_id || sessionId, model: modelName });
          // init 是 supportedCommands() 可用的最早时机（见函数注释）。
          void requestSupportedCommands();
        }
        return;
      }
      case "stream_event":
        handleStreamEvent(message);
        return;
      case "assistant":
        handleAssistantMessage(message);
        return;
      case "user":
        handleUserMessage(message);
        return;
      case "result": {
        const subtype = typeof message.subtype === "string" && message.subtype
          ? message.subtype
          : (message.is_error ? "error" : "success");
        const isErrorResult = !!message.is_error || subtype.startsWith("error");
        if (isErrorResult && !turnErrorEmitted) {
          const fallback = `Claude reported an error (${subtype})`;
          emitError(typeof message.result === "string" && message.result ? message.result : fallback);
        }
        turnErrorEmitted = false;
        // 上下文用量在 result 事件之前查询；查不到（含旧 SDK 没有该方法）为 null。
        const contextUsage = await fetchContextUsage();
        emitEvent({
          kind: "result",
          subtype,
          usage: message.usage || null,
          contextUsage,
        });
        return;
      }
      default:
        return;
    }
  }

  async function consume(queryInstance) {
    let code = 0;
    try {
      for await (const message of queryInstance) {
        if (disposed) break;
        // await：result 分支要在发出事件前查询上下文用量（见 fetchContextUsage）。
        await handleSdkMessage(message);
      }
    } catch (err) {
      // interrupt / dispose 之后 SDK 会抛异常或噪声：一律吞掉，当作正常停止。
      if (!stopping && !disposed) {
        code = 1;
        emitError((err && err.message) || String(err));
      }
    } finally {
      running = false;
      if (query === queryInstance) query = null;
      emitEvent({ kind: "exit", code });
      try {
        onExit({ code, sessionId });
      } catch {}
    }
  }

  async function start() {
    if (disposed) return false;
    if (running) return true;
    let sdk;
    try {
      sdk = await sdkLoader();
    } catch (err) {
      emitError(`failed to load Claude Agent SDK: ${(err && err.message) || String(err)}`);
      return false;
    }
    if (disposed) return false;
    if (typeof sdk.query !== "function") {
      emitError("Claude Agent SDK does not expose query()");
      return false;
    }

    abortController = new AbortController();
    const queryOptions = {
      cwd,
      permissionMode,
      includePartialMessages: true,
      abortController,
    };
    if (effort) queryOptions.effort = effort;
    if (model) queryOptions.model = model;
    // executable 为空时交给 SDK 自带的引擎；只在拿到可执行路径时指定。
    if (executable) queryOptions.pathToClaudeCodeExecutable = executable;
    // resume 只在拿到合法 sessionId 时指定；否则开全新会话。
    if (resume) queryOptions.resume = resume;

    let queryInstance;
    try {
      queryInstance = sdk.query({ prompt: promptIterable, options: queryOptions });
      if (!queryInstance || typeof queryInstance[Symbol.asyncIterator] !== "function") {
        throw new Error("query() returned an invalid Query object");
      }
    } catch (err) {
      try { abortController.abort(); } catch {}
      abortController = null;
      emitError(`failed to start Claude session: ${(err && err.message) || String(err)}`);
      return false;
    }

    query = queryInstance;
    running = true;
    stopping = false;
    textDeltaSeen = false;
    lastAssistantMessageId = null;
    turnErrorEmitted = false;
    emittedToolStarts.clear();
    consumePromise = consume(queryInstance);
    return true;
  }

  // blocks 是可选的 Anthropic content block 数组（图片 / PDF 等附件），由 runtime
  // 传入；只传 text 时行为与之前完全一致。text 与 blocks 至少一个非空才发送。
  function send(text, blocks) {
    const textPart = typeof text === "string" && text ? [{ type: "text", text }] : [];
    const blockList = Array.isArray(blocks) ? blocks : [];
    if (!textPart.length && !blockList.length) return false;
    if (disposed || !running) return false;
    // 新一轮开始：恢复正常错误上报
    stopping = false;
    turnErrorEmitted = false;
    const message = {
      type: "user",
      message: { role: "user", content: [...textPart, ...blockList] },
      parent_tool_use_id: null,
    };
    if (sessionId) message.session_id = sessionId;
    return pushInput(message);
  }

  async function interrupt() {
    if (!query || !running) return false;
    stopping = true;
    try {
      await query.interrupt();
    } catch {}
    return true;
  }

  async function setPermissionMode(mode) {
    if (!running || !query || typeof query.setPermissionMode !== "function") return false;
    try {
      await query.setPermissionMode(mode);
      return true;
    } catch (err) {
      console.warn("Clawd: chat driver setPermissionMode failed:", err && err.message);
      return false;
    }
  }

  // 关掉输入队列、中止、强关 query，并等消费循环退出（超时兜底），保证不留子进程。
  async function dispose() {
    if (disposed) return;
    disposed = true;
    stopping = true;
    closeInput();
    const queryInstance = query;
    query = null;
    if (abortController) {
      try { abortController.abort(); } catch {}
      abortController = null;
    }
    if (queryInstance) {
      if (typeof queryInstance.close === "function") {
        try { queryInstance.close(); } catch {}
      } else {
        try { await queryInstance.interrupt(); } catch {}
        if (typeof queryInstance.return === "function") {
          try { await queryInstance.return(); } catch {}
        }
      }
    }
    if (consumePromise) {
      const timeout = new Promise((resolve) => {
        const timer = scheduleLater(resolve, DISPOSE_GRACE_MS);
        if (timer && typeof timer.unref === "function") timer.unref();
      });
      await Promise.race([consumePromise.catch(() => {}), timeout]);
      consumePromise = null;
    }
    running = false;
  }

  return {
    start,
    send,
    interrupt,
    setPermissionMode,
    dispose,
    getSessionId: () => sessionId,
    isRunning: () => running,
  };
}

module.exports = createChatDriver;
module.exports.createChatDriver = createChatDriver;
// 阶段二历史回填复用：摘要、截断与 tool_result 文本提取规则必须与运行期一致，
// 只此一份实现（chat-transcript-backfill 直接引这里）。
module.exports.summarizeToolInput = summarizeToolInput;
module.exports.clampText = clampText;
module.exports.extractResultText = extractResultText;
// 上下文用量归一化同样只此一份：runtime 写 state 时复用（见 chat-session-runtime）。
module.exports.normalizeContextUsage = normalizeContextUsage;
// 仅供测试/诊断：改动对照的构建规则。
module.exports.buildDiffPreview = buildDiffPreview;
