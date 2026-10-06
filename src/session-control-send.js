"use strict";

// 「在面板上改一个**正在运行**的会话的设置」的投递层。
//
// 和 session-prompt-send 最大的区别，也是它单独存在的理由：**绝不降级**。
// 那边送的是聊天内容，送不进去可以退到"复制到剪贴板 + 把终端切到前面"，
// 用户自己粘一下就行；这里送的是控制命令——偷偷复制到剪贴板再抢焦点，用户
// 完全看不懂发生了什么，剪贴板里还躺着一句 `/effort xhigh` 等着被误粘。
// 所以这里只认 "sent"：没真送进终端就如实报失败，让面板说清楚。
//
// 目前只有一件事：把思考强度送进已经在跑的 Claude Code 会话（官方 /effort 命令，
// 只对那个会话生效）。权限模式不在这里——Claude Code 没有"直接切到某个模式"的
// 命令，只有 Shift+Tab 循环，靠注入按键去猜步数有把会话切到更宽松模式的风险，
// 所以面板不代劳（见面板那行的悬停提示）。

const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

// 只有"本地终端里跑着的 Claude Code 会话"才够得着、才有这个命令：
// 别的 agent 没有 /effort；远程/WSL 的会话在另一台机器上；headless 的没有终端。
function assessTarget(session) {
  if (!session || !session.id) return { ok: false, status: "skipped", reason: "no-session" };
  if (session.agentId !== "claude-code") return { ok: false, status: "unsupported", reason: "not-claude" };
  if (session.host) return { ok: false, status: "unsupported", reason: "remote" };
  if (session.headless) return { ok: false, status: "unsupported", reason: "headless" };
  const hasTty = !!session.sourcePid
    || (Array.isArray(session.pidChain) && session.pidChain.length > 0);
  if (!hasTty) return { ok: false, status: "unsupported", reason: "not-terminal" };
  return { ok: true, status: null, reason: null };
}

function normalizeEffortLevel(value) {
  return EFFORT_LEVELS.includes(value) ? value : null;
}

// 送进终端的原话。斜杠命令，末尾回车由投递通道自带（do script 的语义）。
function effortCommandText(level) {
  return `/effort ${level}`;
}

function textKeyFor(status, reason) {
  if (status === "sent") return "hudControlEffortSent";
  if (status === "unsupported") return "hudControlEffortUnsupported";
  if (status === "failed") return "hudControlEffortFailed";
  return null;
}

function createSessionControlSend(options = {}) {
  const terminalAppSender = options.terminalAppSender || null;
  const log = typeof options.log === "function" ? options.log : () => {};

  // 和聊天那条一样串行化：两次操作别在毫秒内互相踩（终端本身就是队列）。
  let chain = Promise.resolve();

  async function deliverEffort(session, level) {
    if (!terminalAppSender || typeof terminalAppSender.deliver !== "function") {
      return { status: "failed", reason: "no-channel", textKey: textKeyFor("failed") };
    }
    const result = await terminalAppSender.deliver({
      sourcePid: session.sourcePid || null,
      pidChain: Array.isArray(session.pidChain) ? session.pidChain : [],
      text: effortCommandText(level),
    });
    const status = result && result.status === "sent" ? "sent" : "failed";
    if (status === "failed") {
      log(`session-control-send: /effort ${level} 没能送进去（${(result && result.status) || "unknown"}）`);
    }
    return { status, reason: (result && result.status) || null, textKey: textKeyFor(status) };
  }

  // 返回 { status, reason, textKey }：
  //   sent        真送进终端了
  //   failed      够得着但没送成（标签页回到 shell 了 / 没授权 / 出错）
  //   unsupported 这个会话根本不吃这套（别的 agent、远程、headless、没有终端）
  //   skipped     当前目标不是"正在跑的会话"（排队中的新会话、没有会话）——
  //               这种情况只当作设置新会话的默认档位，面板不用报错
  function setEffort({ level, session } = {}) {
    const run = async () => {
      const value = normalizeEffortLevel(level);
      if (!value) return { status: "failed", reason: "invalid-level", textKey: textKeyFor("failed") };
      const assessment = assessTarget(session);
      if (!assessment.ok) {
        return { status: assessment.status, reason: assessment.reason, textKey: textKeyFor(assessment.status, assessment.reason) };
      }
      return deliverEffort(session, value);
    };
    const result = chain.then(run, run);
    chain = result.then(() => {}, () => {});
    return result;
  }

  return { setEffort };
}

module.exports = {
  createSessionControlSend,
  EFFORT_LEVELS,
  effortCommandText,
  assessTarget,
  __test: { normalizeEffortLevel, textKeyFor },
};
