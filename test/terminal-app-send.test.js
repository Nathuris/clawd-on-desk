"use strict";

// src/terminal-app-send.js：把文字送进 macOS「终端」App 的标签页。
// 全程用注入的假 execFile，不真的跑 ps / osascript。

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  MAX_TEXT_LENGTH,
  normalizePromptText,
  escapeAppleScriptString,
  findFirstValidTty,
  buildSendScript,
  buildNewSessionScript,
  createTerminalAppSender,
} = require("../src/terminal-app-send");

// 假 execFile：按命令返回预置结果，并记录调用。
function makeExecFile(script) {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    const result = script(command, args) || {};
    callback(result.err || null, result.stdout || "");
  };
  return { execFile, calls };
}

function makeSender(script, platform = "darwin") {
  const { execFile, calls } = makeExecFile(script);
  const sender = createTerminalAppSender({ execFile, platform, path, log: () => {} });
  return { sender, calls };
}

const TERMINAL_COMM = { stdout: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal\n" };
const CHAIN_PS = { stdout: " 15267 ttys001\n 15270 ??\n" };

test("normalizePromptText 折叠成单行、剥控制字符、限长", () => {
  assert.equal(normalizePromptText("你好\n世界"), "你好 世界", "换行折叠成空格，避免半句话就被回车提交");
  assert.equal(normalizePromptText("  a\t\tb  "), "a b");
  assert.equal(normalizePromptText("bad\u0007bell"), "badbell");
  assert.equal(normalizePromptText(""), null);
  assert.equal(normalizePromptText("   "), null);
  assert.equal(normalizePromptText(null), null);
  assert.equal(normalizePromptText("x".repeat(MAX_TEXT_LENGTH + 500)).length, MAX_TEXT_LENGTH);
});

test("escapeAppleScriptString 只转义反斜杠与双引号", () => {
  assert.equal(escapeAppleScriptString('说"你好"'), '说\\"你好\\"');
  assert.equal(escapeAppleScriptString("C:\\tmp"), "C:\\\\tmp");
  assert.equal(escapeAppleScriptString("emoji 🎵 中文"), "emoji 🎵 中文");
});

test("findFirstValidTty 取第一个有效 tty 并补上 /dev/", () => {
  assert.equal(findFirstValidTty(" 15267 ttys001\n 15270 ttys002\n"), "/dev/ttys001");
  assert.equal(findFirstValidTty(" 1 ??\n 2 ?\n 3 ttys009\n"), "/dev/ttys009");
  assert.equal(findFirstValidTty("/dev/ttys004\n"), "/dev/ttys004");
  assert.equal(findFirstValidTty(" 1 ??\n"), null);
  assert.equal(findFirstValidTty(""), null);
  // 形状不对的一律不认——它会被拼进 AppleScript。
  assert.equal(findFirstValidTty(" 1 ../../etc/passwd\n"), null);
});

test("生成的 AppleScript 带 busy 闸门与 do script", () => {
  const script = buildSendScript("/dev/ttys003", '你好"世界"');
  assert.match(script, /tell application "Terminal"/);
  assert.match(script, /if \(tty of t\) is "\/dev\/ttys003" then/);
  assert.match(script, /if busy of t then/, "只有标签页正跑着程序才投递");
  assert.match(script, /do script "你好\\"世界\\"" in t/);
  assert.match(script, /return "not-busy"/, "回到 shell 提示符时绝不执行");
});

test("非 macOS 直接不支持，连 ps 都不跑", async () => {
  const { sender, calls } = makeSender(() => ({}), "win32");
  const result = await sender.deliver({ sourcePid: 1, pidChain: [2], text: "hi" });
  assert.equal(result.status, "unsupported");
  assert.equal(calls.length, 0);
});

test("宿主不是终端 App 时不冒充发送", async () => {
  const { sender, calls } = makeSender((command, args) => {
    if (command === "ps" && args[1] === "comm=") return { stdout: "/Applications/iTerm.app/Contents/MacOS/iTerm2\n" };
    return {};
  });
  const result = await sender.deliver({ sourcePid: 100, pidChain: [200], text: "hi" });
  assert.equal(result.status, "unsupported");
  // 认出不是终端 App 就该停手，不去查 tty、更不跑 osascript
  assert.equal(calls.filter((call) => call.command === "osascript").length, 0);
});

test("链上没有有效 tty 时返回 not-found", async () => {
  const { sender } = makeSender((command, args) => {
    if (command === "ps" && args[1] === "comm=") return TERMINAL_COMM;
    if (command === "ps") return { stdout: " 200 ??\n" };
    return {};
  });
  const result = await sender.deliver({ sourcePid: 100, pidChain: [200], text: "hi" });
  assert.equal(result.status, "not-found");
});

test("成功投递：按 tty 定位标签页并执行 do script", async () => {
  const { sender, calls } = makeSender((command, args) => {
    if (command === "ps" && args[1] === "comm=") return TERMINAL_COMM;
    if (command === "ps") return CHAIN_PS;
    if (command === "osascript") return { stdout: "sent\n" };
    return {};
  });
  const result = await sender.deliver({ sourcePid: 100, pidChain: [200, 15267], text: "帮我看看" });
  assert.equal(result.status, "sent");
  assert.equal(result.tty, "/dev/ttys001");

  // tty 查询要把终端 App 自己的 pid 排除掉（它没有 tty 也没意义）
  const psCall = calls.find((call) => call.command === "ps" && call.args[1] === "pid=,tty=");
  assert.ok(psCall.args[3].split(",").every((pid) => pid !== "100"));
});

test("标签页回到 shell 提示符（not busy）时如实返回，不执行任何东西", async () => {
  const { sender } = makeSender((command, args) => {
    if (command === "ps" && args[1] === "comm=") return TERMINAL_COMM;
    if (command === "ps") return CHAIN_PS;
    if (command === "osascript") return { stdout: "not-busy\n" };
    return {};
  });
  const result = await sender.deliver({ sourcePid: 100, pidChain: [200], text: "rm -rf /" });
  assert.equal(result.status, "not-busy");
});

test("找不到那个标签页时返回 not-found", async () => {
  const { sender } = makeSender((command, args) => {
    if (command === "ps" && args[1] === "comm=") return TERMINAL_COMM;
    if (command === "ps") return CHAIN_PS;
    if (command === "osascript") return { stdout: "not-found\n" };
    return {};
  });
  assert.equal((await sender.deliver({ sourcePid: 100, pidChain: [200], text: "hi" })).status, "not-found");
});

test("用户没允许控制终端时返回 unauthorized（供上层提示去点允许）", async () => {
  const { sender } = makeSender((command, args) => {
    if (command === "ps" && args[1] === "comm=") return TERMINAL_COMM;
    if (command === "ps") return CHAIN_PS;
    if (command === "osascript") return { err: new Error("Not authorized to send Apple events to Terminal. (-1743)") };
    return {};
  });
  const result = await sender.deliver({ sourcePid: 100, pidChain: [200], text: "hi" });
  assert.equal(result.status, "unauthorized");
});

test("osascript 超时算 timeout，其它错误算 error", async () => {
  const timeout = makeSender((command, args) => {
    if (command === "ps" && args[1] === "comm=") return TERMINAL_COMM;
    if (command === "ps") return CHAIN_PS;
    if (command === "osascript") {
      const err = new Error("killed");
      err.killed = true;
      return { err };
    }
    return {};
  });
  assert.equal((await timeout.sender.deliver({ sourcePid: 100, pidChain: [200], text: "hi" })).status, "timeout");

  const broken = makeSender((command, args) => {
    if (command === "ps" && args[1] === "comm=") return TERMINAL_COMM;
    if (command === "ps") return CHAIN_PS;
    if (command === "osascript") return { stdout: "???\n" };
    return {};
  });
  assert.equal((await broken.sender.deliver({ sourcePid: 100, pidChain: [200], text: "hi" })).status, "error");
});

test("空文本什么也不做", async () => {
  const { sender, calls } = makeSender(() => ({}));
  assert.equal((await sender.deliver({ sourcePid: 100, pidChain: [200], text: "   " })).status, "empty");
  assert.equal(calls.length, 0);
});

// ── 新建会话 ──

test("新建会话脚本：先 cd 再跑 claude，有窗口就新开标签页", () => {
  const script = buildNewSessionScript("/Users/me/my project", "claude");
  assert.match(script, /cd '\/Users\/me\/my project' && claude/);
  assert.match(script, /if \(count of windows\) > 0 then/);
  assert.match(script, /do script "cd '\/Users\/me\/my project' && claude" in front window/);
  assert.match(script, /^\s*do script "cd .*"$/m, "没有窗口时退化成新开窗口");
  assert.match(script, /\n\s*activate\n/);
  assert.match(script, /return "opened"/);
});

test("新建会话脚本：路径里的单引号按 shell 规则断开（再过一层 AppleScript 转义）", () => {
  const script = buildNewSessionScript("/Users/me/it's here", "claude");
  // shell 侧：' → '\'' ；AppleScript 字面量里反斜杠要写成 \\，
  // 所以最终源码里是两个反斜杠，运行时才还原成一个。
  assert.match(script, /cd '\/Users\/me\/it'\\\\''s here' && claude/);
});

test("新建会话脚本：把参数接在 claude 后面", () => {
  const script = buildNewSessionScript("/tmp/p", "claude", {
    args: ["--dangerously-skip-permissions", "--effort", "high"],
  });
  assert.match(script, /cd '\/tmp\/p' && claude --dangerously-skip-permissions --effort high/);
});

test("新建会话脚本：形状不对的参数一律丢掉，不进命令行", () => {
  const script = buildNewSessionScript("/tmp/p", "claude", {
    args: ["--effort", "high; rm -rf /", "$(whoami)", "`id`", "", null, 42, "--ok"],
  });
  assert.match(script, /&& claude --effort --ok"/, "好形状的留着");
  assert.doesNotMatch(script, /rm -rf/);
  assert.doesNotMatch(script, /whoami/);
  assert.doesNotMatch(script, /`id`/);
  assert.doesNotMatch(script, /claude[^"]*\$\{/, "任何会被 shell 再解释一次的东西都不能进命令行");
});

test("新建会话脚本：第一句话当参数交给 claude（不靠往里打字）", () => {
  const script = buildNewSessionScript("/tmp/p", "claude", {
    args: ["--effort", "high"],
    prompt: "帮我看看这段和声",
  });
  assert.match(script, /cd '\/tmp\/p' && claude --effort high '帮我看看这段和声'/);
});

test("新建会话脚本：提示词整个进单引号，shell 不解释里面任何东西", () => {
  const prompt = '他说"你好"；$(whoami)`id` \\ 还有\n换行';
  const script = buildNewSessionScript("/tmp/p", "claude", { prompt });
  const line = script.split("\n").find((lineText) => lineText.includes('do script "cd'));
  assert.ok(line, "要生成 do script 行");

  // 把 AppleScript 那一层的转义还原，看 shell 实际收到的那条命令
  const shell = line
    .replace(/^\s*do script "/, "")
    .replace(/" in front window$/, "")
    .replace(/\\(["\\])/g, "$1");
  assert.strictEqual(shell, `cd '/tmp/p' && claude '${prompt.replace("\n", " ")}'`);
  // 把单引号里的内容挖掉：剩下的部分不能有任何会被 shell 解释的符号
  assert.strictEqual(shell.replace(/'[^']*'/g, "''"), "cd '' && claude ''");
});

test("新建会话脚本：以减号开头的提示词先垫一个空格（免得被当成选项）", () => {
  const script = buildNewSessionScript("/tmp/p", "claude", { prompt: "-v 是什么" });
  assert.match(script, /&& claude ' -v 是什么'/);
});

test("新建会话脚本：没有目录时直接跑命令", () => {
  const script = buildNewSessionScript(null, "claude");
  assert.match(script, /do script "claude"/);
  assert.doesNotMatch(script, /cd /);
});

test("openNewSession 把 osascript 的结果翻成状态", async () => {
  const opened = makeSender(() => ({ stdout: "opened\n" }));
  assert.equal((await opened.sender.openNewSession({ folder: "/tmp" })).status, "opened");
  // 提示词要真的进到 osascript 执行的那段脚本里
  const withPrompt = makeSender(() => ({ stdout: "opened\n" }));
  await withPrompt.sender.openNewSession({ folder: "/tmp", prompt: "你好" });
  const osaPrompt = withPrompt.calls.find((call) => call.command === "osascript");
  assert.match(osaPrompt.args[1], /claude '你好'/);
  // 参数要真的进到 osascript 执行的那段脚本里
  const withArgs = makeSender(() => ({ stdout: "opened\n" }));
  await withArgs.sender.openNewSession({ folder: "/tmp", args: ["--effort", "low"] });
  const osaCall = withArgs.calls.find((call) => call.command === "osascript");
  assert.match(osaCall.args[1], /claude --effort low/);

  const broken = makeSender(() => ({ stdout: "???\n" }));
  assert.equal((await broken.sender.openNewSession({ folder: "/tmp" })).status, "error");

  const denied = makeSender(() => ({ err: new Error("Not authorized to send Apple events. (-1743)") }));
  assert.equal((await denied.sender.openNewSession({ folder: "/tmp" })).status, "unauthorized");

  const notMac = makeSender(() => ({}), "win32");
  assert.equal((await notMac.sender.openNewSession({ folder: "/tmp" })).status, "unsupported");
});
