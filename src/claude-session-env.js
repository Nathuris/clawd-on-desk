"use strict";

// ══════════════════════════════════════════════════════════════════
// 清掉「从启动环境继承来的」Claude Code 会话标记
//
// Claude Code 每开一个会话，都会往环境变量里放一批「这个会话是谁」的标记：
// 会话 id、进程号、消息 socket、以及「我是被谁派生的子会话」等等。这些标记
// 只对那个会话有意义，一旦顺着进程树传下去，就会误导下一个 claude：
// 最典型的是 CLAUDE_CODE_CHILD_SESSION——新会话一看到它，就认为自己是别人
// 派生的子会话，于是干脆不往磁盘写对话记录（终端里会打印
// 「Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker」），
// 那次对话既不能 /resume，也不会出现在面板的历史里。
//
// 传递链是这样的：桌宠经常是从一个终端里启动的（npm start），而那个终端里
// 可能正跑着 Claude Code；应用继承下来之后，它启动的「终端」App 又继承一遍，
// 于是新开的标签页里的 claude 就带着别人的会话标记出生了。
//
// 所以启动时清一次：之后不管从哪儿打开终端，里面都是干净的。
//
// 只清 CLAUDE*/AI_AGENT 这一类「会话身份」标记；ANTHROPIC_* 是用户的账号配置
// 与凭证，一律不动（清了反而会让新会话连不上）。而且就算真的清掉了用户自己
// 配的变量也不要紧——终端里的 shell 启动时会再读一遍他的配置文件，值照样回来。
// ══════════════════════════════════════════════════════════════════

// CLAUDE 开头的（CLAUDE_CODE_*、CLAUDECODE、CLAUDE_PID、CLAUDE_EFFORT…）都算
// 会话标记；AI_AGENT 标记「当前进程跑在某个 agent 会话里」，同理。
const SESSION_ENV_PATTERN = /^CLAUDE/i;
const SESSION_ENV_KEYS = Object.freeze(["AI_AGENT"]);

function isSessionEnvKey(key) {
  return typeof key === "string" && (SESSION_ENV_PATTERN.test(key) || SESSION_ENV_KEYS.includes(key));
}

// 就地清掉 env（默认 process.env）里的会话标记，返回被清掉的变量名。
// 返回值只用于日志/测试，不参与任何判断。
function stripInheritedClaudeSessionEnv(env = process.env) {
  const removed = [];
  // 传了东西但它不是个对象（测试里的脏输入）就什么也不做：这种情况悄悄去动
  // process.env 只会更糟。
  if (!env || typeof env !== "object") return removed;
  for (const key of Object.keys(env)) {
    if (!isSessionEnvKey(key)) continue;
    try {
      delete env[key];
      removed.push(key);
    } catch {
      // 只读的 env（极少见）不该拖垮启动：留着它，继续清下一个。
    }
  }
  return removed;
}

module.exports = {
  SESSION_ENV_KEYS,
  stripInheritedClaudeSessionEnv,
};
