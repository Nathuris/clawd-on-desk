"use strict";

// src/chat-transcript-backfill.js（历史对话回填）单元测试。
//
// 全部用自建 fixture：把条目对象写进 os.tmpdir() 下的临时 .jsonl 文件，
// 不读真实的 ~/.claude/projects，也不加载 SDK。
// 覆盖：基本映射、机器包装跳过、thinking 跳过、tool_use / tool_result 配对
// （含 is_error 与截断）、未配对工具卡、isMeta / isSidechain / isCompactSummary 跳过、
// 坏行容错、尾部读取的残行丢弃、maxMessages / maxBytes 截断、文件不存在、
// uuid 与 bf- 序号兜底。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");

const backfillModule = require("../src/chat-transcript-backfill");
const readTranscriptTail = backfillModule.readTranscriptTail || backfillModule;
const { summarizeToolInput } = require("../src/chat-driver-sdk");

const tempDirs = [];

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function writeRawTranscript(content, name = "transcript.jsonl") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-transcript-backfill-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

function writeTranscript(lines, name = "transcript.jsonl") {
  const content = lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n");
  return writeRawTranscript(`${content}\n`, name);
}

function userEntry({ uuid, text, isMeta, isSidechain }) {
  const entry = {
    type: "user",
    uuid,
    parentUuid: null,
    message: { role: "user", content: [{ type: "text", text }] },
    timestamp: "2026-10-05T00:00:00.000Z",
  };
  if (isMeta !== undefined) entry.isMeta = isMeta;
  if (isSidechain !== undefined) entry.isSidechain = isSidechain;
  return entry;
}

function toolResultEntry({ uuid, toolUseId, content, isError }) {
  return {
    type: "user",
    uuid,
    parentUuid: null,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: !!isError, content }],
    },
    timestamp: "2026-10-05T00:00:00.000Z",
  };
}

function assistantEntry({ uuid, blocks, isSidechain }) {
  const entry = {
    type: "assistant",
    uuid,
    parentUuid: null,
    message: {
      id: `msg-${uuid}`,
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: blocks,
    },
    timestamp: "2026-10-05T00:00:00.000Z",
  };
  if (isSidechain !== undefined) entry.isSidechain = isSidechain;
  return entry;
}

const textBlock = (text) => ({ type: "text", text });
const thinkingBlock = (thinking) => ({ type: "thinking", thinking, signature: "sig" });
const toolUseBlock = (id, name, input) => ({ type: "tool_use", id, name, input });

const isNotice = (message) => message.role === "system" && message.kind === "notice";

function chatMessages(result) {
  return result.messages.filter((message) => !isNotice(message));
}

describe("readTranscriptTail：基本映射", () => {
  it("模块导出 readTranscriptTail 函数", () => {
    assert.equal(typeof readTranscriptTail, "function");
  });

  it("user / assistant 文本转成气泡，非对话条目跳过，id 用条目 uuid", () => {
    const filePath = writeTranscript([
      { type: "system", subtype: "init", session_id: "s1" },
      userEntry({ uuid: "u-1", text: "你好" }),
      { type: "file-history-snapshot", messageId: "x", snapshot: {} },
      assistantEntry({ uuid: "a-1", blocks: [textBlock("你好呀")] }),
      { type: "queue-operation", operation: "enqueue" },
      userEntry({ uuid: "u-2", text: "谢谢" }),
    ]);
    const result = readTranscriptTail(filePath);
    assert.equal(result.truncated, false);
    assert.ok(!result.messages.some(isNotice), "未截断时不应有提示");
    assert.deepEqual(
      chatMessages(result).map((message) => [message.role, message.kind, message.text]),
      [
        ["user", "text", "你好"],
        ["assistant", "text", "你好呀"],
        ["user", "text", "谢谢"],
      ],
    );
    assert.deepEqual(chatMessages(result).map((message) => message.id), ["u-1", "a-1", "u-2"]);
  });

  it("消息带条目自带的时间戳（毫秒），缺失或非法时不带 ts 字段", () => {
    const noTs = userEntry({ uuid: "u-2", text: "没有时间的消息" });
    delete noTs.timestamp;
    const badTs = userEntry({ uuid: "u-3", text: "时间坏掉的消息" });
    badTs.timestamp = "not-a-date";
    const filePath = writeTranscript([
      userEntry({ uuid: "u-1", text: "有时间的消息" }),
      noTs,
      badTs,
      assistantEntry({ uuid: "a-1", blocks: [textBlock("回复")] }),
    ]);
    const result = readTranscriptTail(filePath);
    const expected = Date.parse("2026-10-05T00:00:00.000Z");
    const [first, second, third, fourth] = chatMessages(result);
    assert.equal(first.ts, expected, "条目时间戳应转成毫秒放进 ts");
    assert.ok(!("ts" in second), "缺时间戳的条目不应带 ts 字段");
    assert.ok(!("ts" in third), "非法时间戳不应带 ts 字段");
    assert.equal(fourth.ts, expected, "assistant 条目同样带 ts");
  });

  it("以 < 开头的机器包装文本被跳过", () => {
    const filePath = writeTranscript([
      userEntry({ uuid: "u-wrap", text: "<command-message>compact</command-message>" }),
      userEntry({ uuid: "u-real", text: "真正的输入" }),
      userEntry({ uuid: "u-stdout", text: "<local-command-stdout>done</local-command-stdout>" }),
    ]);
    const result = readTranscriptTail(filePath);
    assert.deepEqual(chatMessages(result).map((message) => message.text), ["真正的输入"]);
  });

  it("assistant 的 thinking 块被跳过，text 块保留", () => {
    const filePath = writeTranscript([
      assistantEntry({ uuid: "a-1", blocks: [thinkingBlock("内部推理"), textBlock("正式回答")] }),
    ]);
    const result = readTranscriptTail(filePath);
    assert.deepEqual(
      chatMessages(result).map((message) => [message.role, message.kind, message.text]),
      [["assistant", "text", "正式回答"]],
    );
  });

  it("isMeta / isSidechain / isCompactSummary 条目被跳过", () => {
    // /compact 续聊摘要的真实形状：type:"user"、isSidechain:false、
    // isCompactSummary:true、content 是字符串（既不以 < 开头也不带 isMeta）。
    const compactSummary = {
      type: "user",
      uuid: "u-compact",
      parentUuid: null,
      isSidechain: false,
      isCompactSummary: true,
      message: {
        role: "user",
        content: "This session is being continued from a previous conversation...",
      },
      timestamp: "2026-10-05T00:00:00.000Z",
    };
    const filePath = writeTranscript([
      userEntry({ uuid: "u-meta", text: "meta 包装", isMeta: true }),
      userEntry({ uuid: "u-ok", text: "保留我" }),
      assistantEntry({ uuid: "a-side", blocks: [textBlock("子代理输出")], isSidechain: true }),
      compactSummary,
      assistantEntry({ uuid: "a-ok", blocks: [textBlock("主会话输出")] }),
    ]);
    const result = readTranscriptTail(filePath);
    assert.deepEqual(chatMessages(result).map((message) => message.text), ["保留我", "主会话输出"]);
  });
});

describe("readTranscriptTail：工具卡片", () => {
  it("tool_use 生成卡片，Bash 摘要为命令，配对 tool_result 后为 done", () => {
    const filePath = writeTranscript([
      assistantEntry({ uuid: "a-1", blocks: [toolUseBlock("toolu_1", "Bash", { command: "ls -la" })] }),
      toolResultEntry({ uuid: "u-1", toolUseId: "toolu_1", content: "file-a\nfile-b" }),
    ]);
    const result = readTranscriptTail(filePath);
    assert.equal(chatMessages(result).length, 1);
    const card = chatMessages(result)[0];
    assert.equal(card.id, "a-1");
    assert.equal(card.role, "assistant");
    assert.equal(card.kind, "tool");
    assert.equal(card.toolName, "Bash");
    assert.equal(card.summary, "ls -la");
    assert.equal(card.status, "done");
    assert.equal(card.resultText, "file-a\nfile-b");
  });

  it("Edit / Read 摘要为文件路径，其余工具与 driver 的摘要规则一致", () => {
    const otherInput = { url: "https://example.com", extra: 1 };
    const filePath = writeTranscript([
      assistantEntry({
        uuid: "a-1",
        blocks: [
          toolUseBlock("toolu_1", "Edit", { file_path: "/tmp/a.txt", old_string: "a", new_string: "b" }),
          toolUseBlock("toolu_2", "Read", { file_path: "/tmp/b.txt" }),
          toolUseBlock("toolu_3", "WebFetch", otherInput),
        ],
      }),
    ]);
    const result = readTranscriptTail(filePath);
    const summaries = chatMessages(result).map((message) => message.summary);
    assert.deepEqual(summaries, [
      "/tmp/a.txt",
      "/tmp/b.txt",
      summarizeToolInput("WebFetch", otherInput),
    ]);
    assert.equal(summaries[2], JSON.stringify(otherInput), "其余工具应为输入对象 JSON");
  });

  it("Edit / Write 卡片带 diff 对照，其他工具与畸形输入不带", () => {
    const filePath = writeTranscript([
      assistantEntry({
        uuid: "a-1",
        blocks: [
          toolUseBlock("toolu_1", "Edit", { file_path: "/tmp/a.txt", old_string: "旧", new_string: "新" }),
          toolUseBlock("toolu_2", "Write", { file_path: "/tmp/b.txt", content: "全文" }),
          toolUseBlock("toolu_3", "Read", { file_path: "/tmp/c.txt" }),
          toolUseBlock("toolu_4", "Edit", { file_path: "/tmp/d.txt", old_string: "只有旧文本" }),
        ],
      }),
    ]);
    const result = readTranscriptTail(filePath);
    const [edit, write, read, broken] = chatMessages(result);
    assert.deepEqual(edit.diff, { oldText: "旧", newText: "新" }, "Edit 应带改前/改后对照");
    assert.deepEqual(write.diff, { oldText: "", newText: "全文" }, "Write 旧文本为空");
    assert.ok(!("diff" in read), "Read 不应带 diff");
    assert.ok(!("diff" in broken), "缺 new_string 的 Edit 不应带 diff");
  });

  it("tool_result 的 is_error 映射成 error 状态", () => {
    const filePath = writeTranscript([
      assistantEntry({ uuid: "a-1", blocks: [toolUseBlock("toolu_1", "Bash", { command: "false" })] }),
      toolResultEntry({ uuid: "u-1", toolUseId: "toolu_1", content: "command failed", isError: true }),
    ]);
    const result = readTranscriptTail(filePath);
    const card = chatMessages(result)[0];
    assert.equal(card.status, "error");
    assert.equal(card.resultText, "command failed");
  });

  it("tool_result 的数组内容按 text 块拼接，超长截断", () => {
    const long = "A".repeat(3000);
    const filePath = writeTranscript([
      assistantEntry({
        uuid: "a-1",
        blocks: [
          toolUseBlock("toolu_1", "Bash", { command: "cat" }),
          toolUseBlock("toolu_2", "Bash", { command: "long" }),
        ],
      }),
      toolResultEntry({
        uuid: "u-1",
        toolUseId: "toolu_1",
        content: [
          { type: "text", text: "第一行" },
          { type: "image", source: {} },
          { type: "text", text: "第二行" },
        ],
      }),
      toolResultEntry({ uuid: "u-2", toolUseId: "toolu_2", content: long }),
    ]);
    const result = readTranscriptTail(filePath);
    const [first, second] = chatMessages(result);
    assert.ok(first.resultText.includes("第一行"));
    assert.ok(first.resultText.includes("第二行"));
    assert.ok(
      first.resultText.indexOf("第一行") < first.resultText.indexOf("第二行"),
      "拼接应保持原始顺序",
    );
    assert.ok(second.resultText.startsWith("A".repeat(100)));
    assert.ok(second.resultText.length < long.length, "3000 字符的结果必须被截断");
    assert.ok(
      second.resultText.length <= 2001,
      `截断后最多 2000 字符（可带省略号），实际 ${second.resultText.length}`,
    );
  });

  it("没有配对 tool_result 的工具卡为 done 且无结果", () => {
    const filePath = writeTranscript([
      assistantEntry({ uuid: "a-1", blocks: [toolUseBlock("toolu_1", "Bash", { command: "sleep 1" })] }),
    ]);
    const result = readTranscriptTail(filePath);
    const card = chatMessages(result)[0];
    assert.equal(card.kind, "tool");
    assert.equal(card.status, "done");
    assert.ok(!card.resultText, "未配对的工具卡不应带 resultText");
  });
});

describe("readTranscriptTail：读取容错与截断", () => {
  it("坏行 / 非对象行跳过，其他条目正常解析", () => {
    const validFirst = JSON.stringify(userEntry({ uuid: "u-1", text: "第一条" }));
    const validSecond = JSON.stringify(assistantEntry({ uuid: "a-1", blocks: [textBlock("第二条")] }));
    const filePath = writeRawTranscript(
      [validFirst, "{ 这不是合法 JSON", "", "42", "null", validSecond].join("\n") + "\n{ 尾部残行",
    );
    const result = readTranscriptTail(filePath);
    assert.deepEqual(chatMessages(result).map((message) => message.text), ["第一条", "第二条"]);
  });

  it("文件不存在时返回空结果且不抛错", () => {
    const missing = path.join(
      os.tmpdir(),
      `chat-transcript-backfill-missing-${process.pid}-${Date.now()}.jsonl`,
    );
    const result = readTranscriptTail(missing);
    assert.deepEqual(result, { messages: [], truncated: false });
  });

  it("maxBytes 从行中间截断时丢弃残行，只保留完整的尾部条目", () => {
    const secondLine = JSON.stringify(userEntry({ uuid: "u-2", text: "第二条" }));
    const thirdLine = JSON.stringify(assistantEntry({ uuid: "a-3", blocks: [textBlock("第三条")] }));
    // 残行片段故意构造成「本身是合法 JSON 的完整 user 条目」：整行以 x 填充开头
    // （整行不是合法 JSON，但会被截断丢弃），读取窗口正好切在条目开头的 { 上。
    // 这样只有真的执行「首行残段丢弃」，片段才不会被解析成消息——否则本用例
    // 靠 JSON.parse 容错也能过，测不到丢弃逻辑。
    const padding = "x".repeat(400);
    const residualEntry = JSON.stringify(userEntry({ uuid: "u-residual", text: "残行片段" }));
    const firstLine = `${padding}${residualEntry}`;
    const content = `${firstLine}\n${secondLine}\n${thirdLine}\n`;
    const maxBytes = Buffer.byteLength(content) - padding.length;
    // fixture 自检：读取窗口必须正好落在残行的条目开头（前一字节不是换行）。
    const windowStart = Buffer.byteLength(content) - maxBytes;
    assert.equal(windowStart, padding.length, "fixture 必须让读取窗口正好切在残行条目开头");
    assert.equal(content[windowStart], "{", "窗口起点应是残行条目的开头");
    assert.notEqual(content[windowStart - 1], "\n", "窗口前一个字节不是换行，残行才会被识别");

    const filePath = writeRawTranscript(content);
    const result = readTranscriptTail(filePath, { maxBytes });

    assert.equal(result.truncated, true);
    assert.equal(result.messages[0].role, "system");
    assert.equal(result.messages[0].kind, "notice");
    assert.equal(result.messages[0].text, "chatHistoryTruncated");
    assert.deepEqual(
      chatMessages(result).map((message) => message.text),
      ["第二条", "第三条"],
    );
    assert.ok(
      !chatMessages(result).some((message) => message.text === "残行片段"),
      "被截断的残行不应生成任何消息",
    );
  });

  it("maxMessages 只保留最近的对话", () => {
    const entries = [];
    for (let i = 1; i <= 5; i += 1) entries.push(userEntry({ uuid: `u-${i}`, text: `第${i}条` }));
    const filePath = writeTranscript(entries);
    const result = readTranscriptTail(filePath, { maxMessages: 3 });

    // truncated / 截断提示只表示「尾部字节窗口砍掉了文件开头」；
    // maxMessages 只是裁消息列表本身，不额外产生提示。
    assert.equal(result.truncated, false);
    assert.ok(!result.messages.some(isNotice));
    assert.deepEqual(
      chatMessages(result).map((message) => [message.id, message.text]),
      [
        ["u-3", "第3条"],
        ["u-4", "第4条"],
        ["u-5", "第5条"],
      ],
    );
  });

  it("id 优先用条目 uuid，缺失时用 bf- 序号兜底", () => {
    const noUuidUser = {
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "无编号一" }] },
    };
    const noUuidAssistant = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "无编号二" }] },
    };
    const filePath = writeTranscript([
      noUuidUser,
      noUuidAssistant,
      userEntry({ uuid: "u-9", text: "有编号" }),
    ]);
    const result = readTranscriptTail(filePath);
    const ids = chatMessages(result).map((message) => message.id);
    assert.match(ids[0], /^bf-\d+$/);
    assert.match(ids[1], /^bf-\d+$/);
    assert.notEqual(ids[0], ids[1], "兜底序号不能重复");
    assert.equal(ids[2], "u-9");
  });
});
