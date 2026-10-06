"use strict";

// Claude Code 的 hook 载荷里带着会话当前的**权限模式**与**思考强度**：
//   - 大多数事件带 permission_mode（SessionStart 不带）；
//   - Stop 带 effort，形状是 { level: "high" }（少数路径可能直接给字符串）。
// 面板会拿这两个值显示"终端里现在是什么"，所以这里只放行白名单里的值，
// 其余一律丢掉——宁可面板显示"未知"，也不把没见过的字符串画上去。
//
// 权限模式的全集来自本机 `claude --help` 的 --permission-mode 取值，加上
// CLI 内部模式表里的 default：
//   default(= --permission-mode manual) / acceptEdits / plan / auto /
//   bypassPermissions / dontAsk
// 内部统一用 default 这个名字（CLI 自己的循环切换函数用的就是这个）。

const PERMISSION_MODE_ALIASES = Object.freeze({ manual: "default" });
const PERMISSION_MODES = Object.freeze([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
  "dontAsk",
]);
const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

// 面板上要显示的字，长度很短，但仍然卡一下形状：空白/换行/超长一律丢。
const MAX_FIELD_LENGTH = 32;

function cleanString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_FIELD_LENGTH) return null;
  return /[\0\r\n]/.test(trimmed) ? null : trimmed;
}

function normalizePermissionMode(value) {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  const resolved = PERMISSION_MODE_ALIASES[cleaned] || cleaned;
  return PERMISSION_MODES.includes(resolved) ? resolved : null;
}

function normalizeEffort(value) {
  // Stop 事件给的是 { level: "high" }，直接给字符串的形态也认。
  const raw = value && typeof value === "object" ? value.level : value;
  const cleaned = cleanString(raw);
  return cleaned && EFFORT_LEVELS.includes(cleaned) ? cleaned : null;
}

module.exports = {
  PERMISSION_MODES,
  EFFORT_LEVELS,
  normalizePermissionMode,
  normalizeEffort,
};
