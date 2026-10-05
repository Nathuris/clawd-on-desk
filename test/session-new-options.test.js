"use strict";

// src/session-new-options.js：面板里「新会话」的两个开关怎么变成 claude 的参数。
// 面板上每排永远有一个选中项（没有「不带参数」那一档），所以命令里永远带着两个参数。

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PERMISSION_MODES,
  EFFORT_LEVELS,
  INITIAL_PERMISSION_MODE,
  INITIAL_EFFORT,
  normalizePermissionMode,
  normalizeEffort,
  buildNewSessionArgs,
} = require("../src/session-new-options");

test("两个开关都翻成 claude 的参数", () => {
  assert.deepStrictEqual(
    buildNewSessionArgs({ permissionMode: "plan", effort: "xhigh" }),
    ["--permission-mode", "plan", "--effort", "xhigh"]
  );
  // 不给设置时用初始档，绝不出现「只带一半参数」的命令。
  assert.deepStrictEqual(
    buildNewSessionArgs(),
    ["--permission-mode", INITIAL_PERMISSION_MODE, "--effort", INITIAL_EFFORT]
  );
});

test("权限模式：四个档都原样翻成 --permission-mode", () => {
  for (const mode of PERMISSION_MODES) {
    assert.deepStrictEqual(
      buildNewSessionArgs({ permissionMode: mode }),
      ["--permission-mode", mode, "--effort", INITIAL_EFFORT],
      mode
    );
  }
  assert.deepStrictEqual([...PERMISSION_MODES].sort(), ["acceptEdits", "auto", "manual", "plan"]);
});

test("强度：五个档都原样翻成 --effort", () => {
  for (const level of EFFORT_LEVELS) {
    assert.deepStrictEqual(
      buildNewSessionArgs({ effort: level }),
      ["--permission-mode", INITIAL_PERMISSION_MODE, "--effort", level],
      level
    );
  }
  assert.deepStrictEqual([...EFFORT_LEVELS].sort(), ["high", "low", "max", "medium", "xhigh"]);
});

test("初始档：权限手动（每步都问）、强度高（不下调）", () => {
  assert.strictEqual(INITIAL_PERMISSION_MODE, "manual");
  assert.strictEqual(INITIAL_EFFORT, "high");
  assert.ok(PERMISSION_MODES.includes(INITIAL_PERMISSION_MODE));
  assert.ok(EFFORT_LEVELS.includes(INITIAL_EFFORT));
});

test("跳过权限确认那档不在面板的可选值里", () => {
  // 面板一下点开「不再询问任何操作」太危险：那一档只走桌宠菜单里会明确确认的路径。
  assert.deepStrictEqual(
    buildNewSessionArgs({ permissionMode: "bypassPermissions" }),
    ["--permission-mode", INITIAL_PERMISSION_MODE, "--effort", INITIAL_EFFORT]
  );
});

test("不认识的值一律落回初始档，绝不拼进命令里", () => {
  for (const bad of ["nope", "", null, undefined, 42, {}, [], "acceptEdits; rm -rf /"]) {
    assert.strictEqual(normalizePermissionMode(bad), INITIAL_PERMISSION_MODE, String(bad));
    assert.strictEqual(normalizeEffort(bad), INITIAL_EFFORT, String(bad));
    const args = buildNewSessionArgs({ permissionMode: bad, effort: bad });
    assert.ok(!args.includes(String(bad)) || bad === "", "脏值不能出现在参数里");
  }
  // "default" 曾经是个档位，现在没了：给回来也只当脏值。
  assert.strictEqual(normalizePermissionMode("default"), INITIAL_PERMISSION_MODE);
  assert.strictEqual(normalizeEffort("default"), INITIAL_EFFORT);
});
