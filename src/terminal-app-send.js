"use strict";

// 把文字送进 macOS「终端」App 的指定标签页（桌宠当终端会话的远程输入框）。
//
// 原理：终端 App 的 AppleScript 接口能按 tty 精确定位标签页，`do script 文本 in 标签页`
// 会把文本当作**输入**喂给标签页里正在运行的程序（末尾自动带回车）——这正是
// 「在桌宠这里打字、话出现在 claude 的输入行里」要的效果。
// tty 的取法与 src/focus.js 的 iTerm2 分支同源：沿进程链 `ps -o pid=,tty=`，
// 第一个有有效 tty 的那个进程就是 shell/登录进程，它用的就是该标签页的 pty。
//
// 安全闸门（很重要）：只有标签页 `busy`（有程序正在跑）时才投递。标签页已经回到
// shell 提示符时，`do script` 会把文本当成 **shell 命令执行**——那必须挡住，宁可
// 什么都不做，让上层退到「复制到剪贴板」。
//
// 文本先折叠成单行、剥掉控制字符，再按 AppleScript 字符串字面量转义（只可能出现在
// 双引号里，转义 \\ 与 \" 即可），CJK/emoji 原样保留。

const defaultPath = require("path");

const PS_TIMEOUT_MS = 800;
const OSA_TIMEOUT_MS = 2500;
// 进程链上最多看几个 pid（与 focus.js 的 iTerm2 分支一致）
const MAX_PID_CANDIDATES = 8;
// 与面板输入框的上限一致（session-ipc 的 QUICK_PROMPT_MAX_LENGTH），这里再兜一层。
const MAX_TEXT_LENGTH = 2000;
// 只接受 /dev/ttysNNN 形态：它会被拼进 AppleScript，必须先卡死形状。
const TTY_PATTERN = /^\/dev\/ttys\d+$/;
// 用户拒绝了「允许控制终端」时 osascript 的经典错误码。
const NOT_AUTHORIZED_CODE = -1743;

function normalizePromptText(value) {
  if (typeof value !== "string") return null;
  // 面板是单行输入框：换行/制表符折叠成空格，避免半句话就被回车提交出去。
  const collapsed = value.replace(/[\r\n\t]+/g, " ");
  // 控制字符（含零宽字符之外的所有 C0/C1）直接丢掉。
  // eslint-disable-next-line no-control-regex
  const cleaned = collapsed.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  const trimmed = cleaned.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_TEXT_LENGTH);
}

function escapeAppleScriptString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// `ps -o pid=,tty=` 的输出：每行 "1234 ttys003"（无 tty 的是 "??"）。
// 也接受只有一列 tty 的宽松输入（不同 ps 参数组合下的形态），形状不对的一律不认。
function findFirstValidTty(psOutput) {
  const lines = String(psOutput || "").trim().split("\n");
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (!parts.length) continue;
    const tty = parts[parts.length - 1];
    if (!tty || tty === "??" || tty === "?") continue;
    const full = tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
    if (TTY_PATTERN.test(full)) return full;
  }
  return null;
}

function buildSendScript(ttyName, text) {
  // 文本与大写/小写无关地原样写进字符串字面量；tty 已经过 TTY_PATTERN 卡形状。
  return [
    'tell application "Terminal"',
    "  repeat with w in windows",
    "    repeat with t in tabs of w",
    `      if (tty of t) is "${ttyName}" then`,
    "        if busy of t then",
    `          do script "${escapeAppleScriptString(text)}" in t`,
    '          return "sent"',
    "        end if",
    '        return "not-busy"',
    "      end if",
    "    end repeat",
    "  end repeat",
    "end tell",
    'return "not-found"',
  ].join("\n");
}

function classifyOsaError(err, platform) {
  const message = String((err && (err.stderr || err.message)) || "");
  if (message.includes(String(NOT_AUTHORIZED_CODE)) || /not authorized/i.test(message)) {
    return "unauthorized";
  }
  if (err && err.killed) return "timeout";
  return platform === "darwin" ? "error" : "unsupported";
}

// 新会话的第一句话当参数传给 claude（`claude [选项] [提示词]`）：一开起来
// 就把这句话送进去了，不用等 TUI 就绪再往里打字——少一层时序，也少一次
// 「打早了、字被吃掉」的机会。文本用单引号整个包住，shell 不会解释里面任何
// 东西；以减号开头的文本会被 claude 当成选项，前面垫一个空格。
function quoteClaudePrompt(text) {
  return quoteShellPath(text.startsWith("-") ? ` ${text}` : text);
}

// 在终端 App 里新开一个标签页（没窗口就新开窗口）跑一个新会话。
// 命令走 shell，所以目录要按 shell 规则单引号包裹；路径里的单引号用 '\'' 断开。
function quoteShellPath(value) {
  return `'${String(value || "").replace(/'/g, "'\\''")}'`;
}

// claude 后面的参数（--effort high 这类）。它们最终拼进 shell 命令行，所以只
// 放行「字母/数字/连字符」这种形状；形状不对的一律丢掉。参数本来来自固定的
// 允许列表（见 src/session-new-options.js），正常永远走不到「丢掉」这一步。
const CLI_ARG_PATTERN = /^(?:--?)?[A-Za-z][A-Za-z0-9-]*$/;

function normalizeCliArgs(args) {
  if (!Array.isArray(args)) return [];
  return args.filter((arg) => typeof arg === "string" && CLI_ARG_PATTERN.test(arg));
}

function buildNewSessionScript(folder, command, options = {}) {
  const activate = options.activate !== false;
  const parts = [];
  if (folder) parts.push(`cd ${quoteShellPath(folder)}`);
  const prompt = normalizePromptText(options.prompt);
  parts.push([
    command,
    ...normalizeCliArgs(options.args),
    ...(prompt ? [quoteClaudePrompt(prompt)] : []),
  ].join(" "));
  const line = parts.join(" && ");
  return [
    'tell application "Terminal"',
    `  if (count of windows) > 0 then`,
    `    do script "${escapeAppleScriptString(line)}" in front window`,
    "  else",
    `    do script "${escapeAppleScriptString(line)}"`,
    "  end if",
    ...(activate ? ["  activate"] : []),
    "end tell",
    'return "opened"',
  ].join("\n");
}

function createTerminalAppSender(options = {}) {
  const execFile = options.execFile || require("child_process").execFile;
  const platform = options.platform || process.platform;
  const path = options.path || defaultPath;
  const log = typeof options.log === "function" ? options.log : () => {};

  function run(command, args, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        execFile(command, args, { encoding: "utf8", timeout: timeoutMs }, (err, stdout) => {
          done({ err: err || null, stdout: stdout || "" });
        });
      } catch (err) {
        done({ err, stdout: "" });
      }
    });
  }

  // 会话的 sourcePid 就是终端 App 自己的 pid（hook 沿进程树走到最上层的宿主）。
  async function isTerminalApp(sourcePid) {
    if (platform !== "darwin") return false;
    if (!Number.isFinite(sourcePid) || sourcePid <= 0) return false;
    const { err, stdout } = await run("ps", ["-o", "comm=", "-p", String(sourcePid)], PS_TIMEOUT_MS);
    if (err) return false;
    const name = path.basename(String(stdout).trim()).toLowerCase();
    return name === "terminal";
  }

  // 沿进程链找那个标签页的 tty；sourcePid 是终端 App 本身，跳过它。
  async function resolveTty(pidChain, sourcePid) {
    if (platform !== "darwin") return null;
    const candidates = (Array.isArray(pidChain) ? pidChain : [])
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== sourcePid)
      .slice(0, MAX_PID_CANDIDATES);
    if (!candidates.length) return null;
    const { err, stdout } = await run(
      "ps",
      ["-o", "pid=,tty=", "-p", candidates.join(",")],
      PS_TIMEOUT_MS,
    );
    if (err) return null;
    return findFirstValidTty(stdout);
  }

  // 返回 { status, tty }；status ∈ sent / not-busy / not-found / unauthorized /
  // unsupported / error。只有 sent 才算真的送进去了，其余都要由上层决定怎么办。
  async function deliver({ sourcePid, pidChain, text } = {}) {
    if (platform !== "darwin") return { status: "unsupported", tty: null };
    const promptText = normalizePromptText(text);
    if (!promptText) return { status: "empty", tty: null };

    const terminalApp = await isTerminalApp(sourcePid);
    if (!terminalApp) return { status: "unsupported", tty: null };

    const tty = await resolveTty(pidChain, sourcePid);
    if (!tty) {
      log("terminal-app-send: no tty for session");
      return { status: "not-found", tty: null };
    }

    const { err, stdout } = await run("osascript", ["-e", buildSendScript(tty, promptText)], OSA_TIMEOUT_MS);
    if (err) {
      const status = classifyOsaError(err, platform);
      log(`terminal-app-send: osascript failed (${status})`);
      return { status, tty };
    }
    const verdict = String(stdout).trim();
    if (verdict === "sent") return { status: "sent", tty };
    if (verdict === "not-busy") return { status: "not-busy", tty };
    if (verdict === "not-found") return { status: "not-found", tty };
    return { status: "error", tty };
  }

  // 在终端 App 里新开一个标签页跑新会话（用户点了「新建会话」才会走这里，
  // 所以把终端带到前台是预期的）。
  async function openNewSession({ folder = null, command = "claude", args = [], prompt = null } = {}) {
    if (platform !== "darwin") return { status: "unsupported" };
    const cmd = typeof command === "string" && command.trim() ? command.trim() : "claude";
    const script = buildNewSessionScript(folder, cmd, { args, prompt });
    const { err, stdout } = await run("osascript", ["-e", script], OSA_TIMEOUT_MS);
    if (err) {
      const status = classifyOsaError(err, platform);
      log(`terminal-app-send: new session failed (${status})`);
      return { status };
    }
    return { status: String(stdout).trim() === "opened" ? "opened" : "error" };
  }

  return { deliver, openNewSession, isTerminalApp, resolveTty };
}

module.exports = {
  MAX_TEXT_LENGTH,
  normalizePromptText,
  escapeAppleScriptString,
  findFirstValidTty,
  buildSendScript,
  buildNewSessionScript,
  createTerminalAppSender,
};
