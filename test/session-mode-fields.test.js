"use strict";

// hooks/session-mode-fields.js：Claude Code 的 hook 载荷里那两个字段的
// 白名单归一化。面板会拿它们显示"终端里现在是什么"，所以只放行认识的取值，
// 其余一律丢掉——宁可显示"未知"，也不把没见过的字符串画到面板上。

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  PERMISSION_MODES,
  EFFORT_LEVELS,
  normalizePermissionMode,
  normalizeEffort,
} = require("../hooks/session-mode-fields");

describe("session-mode-fields", () => {
  it("放行 CLI 认识的每一个权限模式", () => {
    for (const mode of PERMISSION_MODES) {
      assert.strictEqual(normalizePermissionMode(mode), mode);
    }
  });

  it("manual 归到内部的 default（命令行写法与内部叫法统一）", () => {
    assert.strictEqual(normalizePermissionMode("manual"), "default");
  });

  it("不认识/空的权限模式一律丢掉", () => {
    for (const bad of ["", "   ", "PLAN", "yolo", null, undefined, 42, {}, []]) {
      assert.strictEqual(normalizePermissionMode(bad), null, `应当丢掉 ${JSON.stringify(bad)}`);
    }
  });

  it("两头的空白先去掉再比对（前后带空格的写法照样认）", () => {
    assert.strictEqual(normalizePermissionMode("  plan  "), "plan");
    assert.strictEqual(normalizeEffort({ level: " high " }), "high");
  });

  it("权限模式里带换行或超长的也丢掉（会被画到一行里）", () => {
    assert.strictEqual(normalizePermissionMode("plan\nrm -rf /"), null);
    assert.strictEqual(normalizePermissionMode("p".repeat(64)), null);
  });

  it("强度：认 Stop 事件那种 { level } 形状，也认直接给字符串", () => {
    assert.strictEqual(normalizeEffort({ level: "high" }), "high");
    assert.strictEqual(normalizeEffort("xhigh"), "xhigh");
    for (const level of EFFORT_LEVELS) {
      assert.strictEqual(normalizeEffort({ level }), level);
      assert.strictEqual(normalizeEffort(level), level);
    }
  });

  it("不认识的强度丢掉", () => {
    for (const bad of [{ level: "turbo" }, "ultracode", "", null, 3, { level: 3 }, {}]) {
      assert.strictEqual(normalizeEffort(bad), null, `应当丢掉 ${JSON.stringify(bad)}`);
    }
  });
});
