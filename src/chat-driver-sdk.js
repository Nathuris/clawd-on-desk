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
//   { kind:'text', delta?, text? }
//   { kind:'thinking', delta }
//   { kind:'tool-start', toolName, summary, toolUseId }
//   { kind:'tool-end', toolUseId, isError, resultText }
//   { kind:'result', subtype, costUsd, usage }
//   { kind:'error', message }
//   { kind:'exit', code }

const INPUT_SUMMARY_LIMIT = 200;
const TOOL_RESULT_LIMIT = 2000;
const DISPOSE_GRACE_MS = 1500;

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

function createChatDriver(options = {}) {
  const cwd = typeof options.cwd === "string" && options.cwd ? options.cwd : process.cwd();
  const effort = options.effort || null;
  const permissionMode = options.permissionMode || "default";
  const model = options.model || null;
  const executable = typeof options.executable === "string" && options.executable ? options.executable : null;
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
      emitEvent({
        kind: "tool-start",
        toolName: typeof block.name === "string" ? block.name : "Tool",
        summary: summarizeToolInput(block.name, block.input),
        toolUseId,
      });
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

  function handleSdkMessage(message) {
    if (!message || typeof message !== "object") return;
    if (typeof message.session_id === "string" && message.session_id) sessionId = message.session_id;

    switch (message.type) {
      case "system": {
        if (message.subtype === "init") {
          if (typeof message.model === "string" && message.model) modelName = message.model;
          emitEvent({ kind: "init", sessionId: message.session_id || sessionId, model: modelName });
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
        emitEvent({
          kind: "result",
          subtype,
          costUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
          usage: message.usage || null,
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
        handleSdkMessage(message);
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

  function send(text) {
    if (typeof text !== "string" || !text) return false;
    if (disposed || !running) return false;
    // 新一轮开始：恢复正常错误上报
    stopping = false;
    turnErrorEmitted = false;
    const message = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
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
module.exports.summarizeToolInput = summarizeToolInput;
