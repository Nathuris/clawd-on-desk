"use strict";

// 内置对话的快捷输入排队（悬停面板输入框 → 聊天会话）。
//
// 纯主进程状态，不依赖 Electron：面板隐藏/销毁不影响队列。
// 行为约定（与悬停面板的展示一一对应）：
// - 空闲且有工作目录 → 立即发送（返回 sent）
// - 忙碌 → 排队（上限 maxSize，超出返回 full 并保留用户文字）
// - 无工作目录 → 保持排队并标记 blocked:"no-cwd"；目录出现后（状态边沿）自动放行
// - send 返回假 → 退避重试，累计 MAX_SEND_ATTEMPTS 次后丢弃并记录 lastError
// - clear(reason) 由调用方在「用户点停止 / 关窗 / 换上下文（新会话、恢复、换目录）/ 退出」
//   时同步调用；必须先于 runtime.stop() 执行，否则 stop 回到 idle 的边沿会把
//   队列里的下一条误发出去（inFlight 只防重入，不防这个边沿）。

const DEFAULT_MAX_SIZE = 5;
const MAX_SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;

function normalizeText(text) {
  return typeof text === "string" ? text.trim() : "";
}

function createChatPromptQueue(options = {}) {
  const send = typeof options.send === "function" ? options.send : null;
  const isBusy = typeof options.isBusy === "function" ? options.isBusy : () => false;
  const hasCwd = typeof options.hasCwd === "function" ? options.hasCwd : () => false;
  const onChanged = typeof options.onChanged === "function" ? options.onChanged : () => {};
  const setTimeoutFn = typeof options.setTimeout === "function" ? options.setTimeout : setTimeout;
  const clearTimeoutFn = typeof options.clearTimeout === "function" ? options.clearTimeout : clearTimeout;
  const maxSize = Number.isFinite(options.maxSize) && options.maxSize > 0
    ? Math.floor(options.maxSize)
    : DEFAULT_MAX_SIZE;

  const queue = []; // [{ text, attempts }]
  let inFlight = false;
  let lastError = null;
  let retryTimer = null;

  function snapshot() {
    return {
      count: queue.length,
      blocked: hasCwd() ? null : (queue.length > 0 ? "no-cwd" : null),
      lastError,
      inFlight,
    };
  }

  function notify() {
    try { onChanged(snapshot()); } catch {}
  }

  function cancelRetry() {
    if (retryTimer) {
      clearTimeoutFn(retryTimer);
      retryTimer = null;
    }
  }

  // 发送失败后的退避：到点再试一次（drainOne 内部会再判断条件）。
  function scheduleRetry() {
    cancelRetry();
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      drainOne().catch(() => {});
    }, RETRY_DELAY_MS);
  }

  // 从队列里摘掉指定条目（只删它自己）。结算时不能用 queue.shift()：
  // 在途发送期间队列可能被 clear 清空又进了新消息，shift 会误删别人的。
  function removeEntry(entry) {
    const index = queue.indexOf(entry);
    if (index === -1) return false;
    queue.splice(index, 1);
    return true;
  }

  // 尝试发一条。只在「不忙、有目录、没有在途发送」时动手；
  // 任何一步不满足就原样留在队列里等下一次状态边沿。
  async function drainOne() {
    if (inFlight || !queue.length || !send) return false;
    if (isBusy() || !hasCwd()) return false;
    const entry = queue[0];
    inFlight = true;
    let ok = false;
    try {
      ok = (await send(entry.text)) !== false;
    } catch {
      ok = false;
    } finally {
      inFlight = false;
    }
    // 在途期间可能被 clear() 清队（用户点停止 / 关窗）：条目已不在队列，
    // 结算既不碰队列也不记失败、不拉退避——静默收场即可。
    if (queue.indexOf(entry) === -1) return ok;
    if (ok) {
      removeEntry(entry);
      lastError = null;
      notify();
      return true;
    }
    // 发送失败：没目录按阻塞处理（不计次），有目录则计次退避。
    if (!hasCwd()) {
      notify();
      return false;
    }
    entry.attempts += 1;
    lastError = "send-failed";
    if (entry.attempts >= MAX_SEND_ATTEMPTS) {
      removeEntry(entry);
    } else {
      scheduleRetry();
    }
    notify();
    return false;
  }

  return {
    // 用户在面板输入框回车。返回 { status, queuedCount }：
    // sent / queued / full / empty。
    async enqueue(text) {
      const value = normalizeText(text);
      if (!value) return { status: "empty", queuedCount: queue.length };
      lastError = null;
      // 空闲且有目录：不入队直接发；失败则退回队列（算一次失败），走退避重试。
      let triedImmediate = false;
      if (!isBusy() && hasCwd() && !inFlight && queue.length === 0 && send) {
        triedImmediate = true;
        inFlight = true;
        let ok = false;
        try {
          ok = (await send(value)) !== false;
        } catch {
          ok = false;
        } finally {
          inFlight = false;
        }
        if (ok) {
          notify();
          return { status: "sent", queuedCount: 0 };
        }
      }
      if (queue.length >= maxSize) {
        return { status: "full", queuedCount: queue.length };
      }
      const entry = { text: value, attempts: triedImmediate ? 1 : 0 };
      if (triedImmediate) {
        // 立即发送失败退回队列：插到队头保发送顺序（在途期间可能已有
        // 别的消息排队，push 到队尾会让后输入的反而先发）。
        queue.unshift(entry);
        scheduleRetry();
      } else {
        queue.push(entry);
        drainOne().catch(() => {});
      }
      notify();
      return { status: "queued", queuedCount: queue.length };
    },

    // runtime 状态边沿：忙→闲、无目录→有目录时放行下一条。
    handleRuntimeState() {
      if (!queue.length || inFlight) return;
      if (isBusy()) return;
      drainOne().catch(() => {});
    },

    clear(reason = "reset") {
      cancelRetry();
      const cleared = queue.length;
      queue.length = 0;
      lastError = null;
      if (cleared > 0) notify();
      return { cleared, reason };
    },

    getSnapshot: snapshot,
    // 仅供测试：等在途的 send 结算（用真实定时器，不走注入的假 setTimeout）。
    _settle: async () => {
      for (let i = 0; i < 20 && inFlight; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
  };
}

module.exports = createChatPromptQueue;
module.exports.createChatPromptQueue = createChatPromptQueue;
module.exports.DEFAULT_MAX_SIZE = DEFAULT_MAX_SIZE;
module.exports.MAX_SEND_ATTEMPTS = MAX_SEND_ATTEMPTS;
