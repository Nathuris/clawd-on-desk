"use strict";

// 「面板里打一句话 → 送到终端里正在跑的那个会话」的编排层。
//
// 只做三件事：挑通道、投递、如实回报结果。所有副作用都靠注入，方便单测。
// 通道顺序：
//   ① 终端 App（AppleScript 按 tty 精确打进那个标签页；需要标签页正跑着程序）
//   ② Codex 官方队列（目标会话是 Codex 且不在终端 App 里时）
//   ③ 复制到剪贴板 + 把终端切到前面（兜底，必须如实告诉用户「去粘贴」）
//
// 结果里 status 只有四种，面板据此显示文案；**绝不用 sent 冒充没真送进去的情况**：
//   sent       真的写进终端了
//   copied     只复制到剪贴板了（用户要自己粘贴）
//   no-session 没有可发送的会话
//   error      其它失败

const { normalizePromptText } = require("./terminal-app-send");

// 终端 App 的几种"没送成"分别怎么降级：
// - not-busy：标签页回到 shell 提示符了（claude 大概退出了）→ 走剪贴板，绝不 do script
// - unauthorized：用户还没允许"控制终端" → 复制到剪贴板，并提示去点允许
// - not-found / error / unsupported：这台机器/这个会话不归终端 App 管 → 走剪贴板
const PERMISSION_REASONS = new Set(["unauthorized"]);

// 面板状态行要显示的文案 key（7 语言见 src/i18n.js）。
function textKeyFor(status, reason) {
  if (status === "sent") return "hudSendSent";
  if (status === "no-session") return "hudSendNoSession";
  if (status === "error") return "hudQuickSendFailed";
  return PERMISSION_REASONS.has(reason) ? "hudSendNeedsPermission" : "hudSendCopied";
}

function createSessionPromptSend(options = {}) {
  const getTargetSession = options.getTargetSession || (() => null);
  const terminalAppSender = options.terminalAppSender || null;
  const codexQueueAdapter = options.codexQueueAdapter || null;
  const copyText = options.copyText || null;
  const focusSession = typeof options.focusSession === "function" ? options.focusSession : null;
  const log = typeof options.log === "function" ? options.log : () => {};

  // 串行化：两次发送不交错地抢剪贴板/切标签页。这里不做"排队"语义——
  // 终端本身就是队列，连续发两条完全合理，只是别让它们在毫秒内互相踩。
  let deliveryChain = Promise.resolve();

  function toClipboard(text, reason) {
    let copied = false;
    if (typeof copyText === "function") {
      try {
        copied = copyText(text) !== false;
      } catch (err) {
        log(`session-prompt-send: clipboard write failed: ${err && err.message}`);
        copied = false;
      }
    }
    if (!copied) {
      return { status: "error", channel: null, reason: reason ? `${reason}+clipboard_failed` : "clipboard_failed", textKey: textKeyFor("error", reason) };
    }
    return { status: "copied", channel: "clipboard", reason: reason || null, textKey: textKeyFor("copied", reason) };
  }

  async function deliverNow({ sessionId, text }) {
    const promptText = normalizePromptText(text);
    if (!promptText) return { status: "error", channel: null, reason: "empty", textKey: textKeyFor("error", "empty") };

    let session = null;
    try {
      session = getTargetSession(sessionId) || null;
    } catch (err) {
      log(`session-prompt-send: target lookup failed: ${err && err.message}`);
      return { status: "error", channel: null, reason: "lookup_failed", textKey: textKeyFor("error", null) };
    }
    if (!session) {
      return { status: "no-session", channel: null, reason: "no_session", textKey: textKeyFor("no-session", null) };
    }

    // ① 终端 App：真正的"打进终端"。
    let terminalFailure = null;
    if (terminalAppSender) {
      let result = null;
      try {
        result = await terminalAppSender.deliver({
          sourcePid: session.sourcePid,
          pidChain: session.pidChain,
          text: promptText,
        });
      } catch (err) {
        log(`session-prompt-send: terminal app delivery threw: ${err && err.message}`);
        result = { status: "error" };
      }
      if (result && result.status === "sent") {
        return { status: "sent", channel: "terminal-app", reason: null, textKey: textKeyFor("sent", null) };
      }
      terminalFailure = (result && result.status) || "error";
      log(`session-prompt-send: terminal app channel unavailable (${terminalFailure})`);
    }

    // ② Codex 官方队列（与终端无关的独立通道，只有 Codex 会话有）。
    if (codexQueueAdapter) {
      let canQueue = false;
      try {
        canQueue = typeof codexQueueAdapter.canDeliver === "function" && codexQueueAdapter.canDeliver(session) === true;
      } catch { canQueue = false; }
      if (canQueue) {
        try {
          const queued = await codexQueueAdapter.deliver({ entry: session, promptText });
          if (queued && (queued.status === "queued" || queued.status === "sent")) {
            return { status: "sent", channel: "codex-queue", reason: null, textKey: textKeyFor("sent", null) };
          }
        } catch (err) {
          log(`session-prompt-send: codex queue delivery failed: ${err && err.message}`);
        }
      }
    }

    // ③ 兜底：复制到剪贴板 + 把那个终端切到前面，然后**如实说**要用户自己粘贴。
    const fallback = toClipboard(promptText, terminalFailure);
    if (fallback.status === "copied" && focusSession) {
      try {
        focusSession(session.id);
      } catch (err) {
        log(`session-prompt-send: focus after copy failed: ${err && err.message}`);
      }
    }
    return fallback;
  }

  function send(payload = {}) {
    const run = deliveryChain.catch(() => {}).then(() => deliverNow(payload));
    deliveryChain = run;
    return run;
  }

  return { send, _deliverNow: deliverNow };
}

module.exports = {
  textKeyFor,
  createSessionPromptSend,
};
