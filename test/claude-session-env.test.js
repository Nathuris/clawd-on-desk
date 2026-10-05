"use strict";

// src/claude-session-env.js：启动时清掉随环境继承下来的 Claude Code 会话标记。
// 背景：CLAUDE_CODE_CHILD_SESSION 跟着进程树传到终端里，新会话会以为自己是
// 子会话而不再保存对话记录。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { SESSION_ENV_KEYS, stripInheritedClaudeSessionEnv } = require("../src/claude-session-env");

const mainSource = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

test("清掉 Claude Code 的会话标记，返回被清掉的变量名", () => {
  const env = {
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ID: "abc",
    CLAUDECODE: "1",
    CLAUDE_PID: "123",
    CLAUDE_EFFORT: "high",
    AI_AGENT: "claude-code",
    HOME: "/Users/me",
  };

  const removed = stripInheritedClaudeSessionEnv(env);

  assert.deepStrictEqual(removed.sort(), [
    "AI_AGENT",
    "CLAUDECODE",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
  ]);
  assert.deepStrictEqual(env, { HOME: "/Users/me" }, "只动会话标记，别的变量原样留着");
});

test("账号配置与凭证一律不动", () => {
  const env = {
    ANTHROPIC_BASE_URL: "https://example.invalid",
    ANTHROPIC_AUTH_TOKEN: "secret",
    ANTHROPIC_MODEL: "some-model",
    PATH: "/usr/bin",
  };
  const snapshot = { ...env };

  assert.deepStrictEqual(stripInheritedClaudeSessionEnv(env), []);
  assert.deepStrictEqual(env, snapshot, "清了这些会让新会话连不上，一个都不能碰");
});

test("干净的环境里什么也不做", () => {
  const env = { PATH: "/usr/bin", TERM_PROGRAM: "Apple_Terminal" };
  assert.deepStrictEqual(stripInheritedClaudeSessionEnv(env), []);
  assert.deepStrictEqual(env, { PATH: "/usr/bin", TERM_PROGRAM: "Apple_Terminal" });
});

test("env 形状不对时不抛错，也不去动真环境", () => {
  // 只有「不传参数」才等于 process.env；传了脏输入就该什么都不做。
  assert.deepStrictEqual(stripInheritedClaudeSessionEnv(null), []);
  assert.deepStrictEqual(stripInheritedClaudeSessionEnv(42), []);
  assert.deepStrictEqual(stripInheritedClaudeSessionEnv("nope"), []);
  assert.deepStrictEqual(stripInheritedClaudeSessionEnv(Object.create(null)), []);
  assert.strictEqual(process.env.CLAUDE_CODE_CHILD_SESSION, "1", "脏输入不该顺手动真环境");
});

test("删不掉的变量不会拖垮启动", () => {
  const env = {};
  Object.defineProperty(env, "CLAUDE_CODE_CHILD_SESSION", {
    value: "1",
    enumerable: true,
    configurable: false,
  });
  env.CLAUDECODE = "1";

  const removed = stripInheritedClaudeSessionEnv(env);

  assert.deepStrictEqual(removed, ["CLAUDECODE"], "删不掉的跳过，后面的照清");
  assert.strictEqual(env.CLAUDE_CODE_CHILD_SESSION, "1");
});

test("main.js 在建任何窗口之前就调用它", () => {
  const callIndex = mainSource.indexOf("stripInheritedClaudeSessionEnv();");
  assert.ok(callIndex > 0, "main.js 必须调用 stripInheritedClaudeSessionEnv()");
  // 必须早于 app.whenReady：窗口、子进程都是 onReady 之后才建的。
  const readyIndex = mainSource.indexOf("app.whenReady(");
  assert.ok(readyIndex > callIndex, "清理要发生在应用就绪、开始拉进程之前");
  assert.match(
    mainSource,
    /const \{ stripInheritedClaudeSessionEnv \} = require\("\.\/claude-session-env"\);/,
    "要引这份模块，别就地再写一份"
  );
});

test("SESSION_ENV_KEYS 里的键都被认作会话标记", () => {
  assert.ok(SESSION_ENV_KEYS.includes("AI_AGENT"));
  const env = {};
  for (const key of SESSION_ENV_KEYS) env[key] = "1";
  assert.deepStrictEqual(stripInheritedClaudeSessionEnv(env).sort(), [...SESSION_ENV_KEYS].sort());
  assert.deepStrictEqual(env, {});
});
