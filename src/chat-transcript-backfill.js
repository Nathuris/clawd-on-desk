"use strict";

// 内置 Claude 对话（阶段二）：历史会话回填。
//
// 从 Claude Code 的 transcript 文件（~/.claude/projects/<编码后的 cwd>/<sessionId>.jsonl）
// 尾部读取最近的消息，转成与运行期完全一致的消息形状，供渲染端在「续聊」时直接展示。
// 纯读取、容错：文件不存在或读取失败都返回空结果，绝不抛异常；单行解析失败跳过。
//
// 消息形状（与 chat-session-runtime 一致）：
//   { id, role:'user'|'assistant', kind:'text', text, ts? }
//   { id, role:'assistant', kind:'tool', toolName, summary, status:'done'|'error', resultText?, diff?, ts? }
//   { id, role:'system', kind:'notice', text:'chatHistoryTruncated' }  // 仅截断时置顶
// ts 为毫秒（来自条目自带的 timestamp），缺失时不带该字段（运行期补当前时间）；
// diff 形状 { oldText, newText }，与 tool-start 的 diffPreview 一致。
//
// 工具卡片的 summary / resultText 规则与运行期 driver 完全一致，直接复用其导出函数，
// 不复制第二份实现（见 chat-driver-sdk.js 的 summarizeToolInput / extractResultText）。

const fs = require("fs");
const { summarizeToolInput, extractResultText, buildDiffPreview } = require("./chat-driver-sdk");

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 200;

// 消息 id：优先用条目自身的 uuid；同一条目产出多条消息（如文字 + 工具调用）或
// uuid 重复出现时加后缀，保证唯一——渲染端按 id 做增量调和，重复 id 会互相覆盖。
function createMessageIdFactory() {
  const used = new Set();
  let fallbackSeq = 0;
  return function assignId(preferred) {
    const base = typeof preferred === "string" && preferred ? preferred : `bf-${fallbackSeq++}`;
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return id;
  };
}

// 条目时间戳：transcript 每行自带 ISO 时间（entry.timestamp），转成毫秒给消息的 ts；
// 缺失或非法返回 null——调用方据此不加 ts 字段，交由运行期补当前时间。
function entryTimestamp(entry) {
  if (typeof entry.timestamp !== "string" || !entry.timestamp) return null;
  const ms = Date.parse(entry.timestamp);
  return Number.isFinite(ms) ? ms : null;
}

// 从文件尾部读取并解析。options: { maxBytes = 2MB, maxMessages = 200 }。
// 返回 { messages, truncated }：truncated 表示尾部窗口砍掉了文件开头（历史不完整）。
function readTranscriptTail(filePath, options = {}) {
  const empty = { messages: [], truncated: false };
  if (typeof filePath !== "string" || !filePath) return empty;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.floor(options.maxBytes)
    : DEFAULT_MAX_BYTES;
  const maxMessages = Number.isInteger(options.maxMessages) && options.maxMessages > 0
    ? options.maxMessages
    : DEFAULT_MAX_MESSAGES;

  let text = "";
  let truncated = false;
  let firstLinePartial = false;
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    truncated = start > 0;
    if (truncated) {
      // 起始字节若不是行首（前一个字节不是换行），第一段是残行，必须丢弃；
      // 探测失败按残行处理，宁可少一条也不要解析半行。
      const prev = Buffer.alloc(1);
      let prevRead = 0;
      try {
        prevRead = fs.readSync(fd, prev, 0, 1, start - 1);
      } catch {
        prevRead = 0;
      }
      firstLinePartial = prevRead !== 1 || prev[0] !== 0x0a;
    }
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, start + offset);
      if (read <= 0) break;
      offset += read;
    }
    text = buffer.subarray(0, offset).toString("utf8");
  } catch {
    return empty;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  const lines = text.split("\n");
  if (firstLinePartial) lines.shift();

  const assignId = createMessageIdFactory();
  const messages = [];
  const toolCardByUseId = new Map(); // tool_use id -> 已生成的工具卡片消息（等待 tool_result 回填）

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 容错：坏行（含窗口切出的残行）直接跳过
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    // isCompactSummary 是 /compact 续聊时写入的上下文摘要：形状是 type:"user"、
    // content 为长字符串，既不以 < 开头也不带 isMeta，只能靠这个标记排除，
    // 否则会被当成一条超长的「用户」气泡展示。
    if (entry.isMeta || entry.isSidechain || entry.isCompactSummary) continue;

    const content = entry.message && entry.message.content;
    const blocks = Array.isArray(content)
      ? content
      : (typeof content === "string" ? [{ type: "text", text: content }] : []);
    const ts = entryTimestamp(entry);
    const tsField = ts !== null ? { ts } : {};

    if (entry.type === "user") {
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result") {
          // 回到此前对应的工具卡片：is_error 决定状态，content 提取文本（与运行期同一规则）。
          const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
          const card = toolUseId ? toolCardByUseId.get(toolUseId) : null;
          if (!card) continue;
          card.status = block.is_error ? "error" : "done";
          const resultText = extractResultText(block.content);
          if (resultText) card.resultText = resultText;
          toolCardByUseId.delete(toolUseId);
          continue;
        }
        if (block.type !== "text" || typeof block.text !== "string" || !block.text) continue;
        // 机器生成的包装（<command-message> / <local-command-stdout> 等）不是用户输入。
        if (block.text.startsWith("<")) continue;
        messages.push({ id: assignId(entry.uuid), role: "user", kind: "text", text: block.text, ...tsField });
      }
      continue;
    }

    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") {
        if (typeof block.text !== "string" || !block.text) continue;
        messages.push({ id: assignId(entry.uuid), role: "assistant", kind: "text", text: block.text, ...tsField });
        continue;
      }
      if (block.type === "tool_use") {
        const toolName = typeof block.name === "string" && block.name ? block.name : "Tool";
        const card = {
          id: assignId(entry.uuid),
          role: "assistant",
          kind: "tool",
          toolName,
          summary: summarizeToolInput(toolName, block.input),
          // 历史卡片没有「进行中」；未被 tool_result 配对的保持 done。
          status: "done",
          ...tsField,
        };
        // 与运行期一致：Edit / MultiEdit / Write 的历史卡片也带改动对照（+/- 显示）。
        const diff = buildDiffPreview(toolName, block.input);
        if (diff) card.diff = diff;
        messages.push(card);
        if (typeof block.id === "string" && block.id) toolCardByUseId.set(block.id, card);
        continue;
      }
      // thinking 及其他块不需要展示。
    }
  }

  // 只保留最近的 maxMessages 条（与运行期 MAX_MESSAGES 一致，从尾部截断）。
  const visible = messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
  if (truncated) {
    visible.unshift({ id: "bf-notice", role: "system", kind: "notice", text: "chatHistoryTruncated" });
  }
  return { messages: visible, truncated };
}

module.exports = readTranscriptTail;
module.exports.readTranscriptTail = readTranscriptTail;
