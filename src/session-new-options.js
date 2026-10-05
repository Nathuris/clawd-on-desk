"use strict";

// ══════════════════════════════════════════════════════════════════
// 「新会话」的两个开关：权限模式与思考强度
//
// 面板里排好一个新会话后，用户发出第一句话时才会真的在终端里开起来
// （见 src/terminal-app-send.js 的 openNewSession），这两个设置就是那时
// 跟在 claude 后面的参数：
//   权限模式 —— 自动 / 手动 / 自动编辑 / 计划
//   思考强度 —— 低 / 中 / 高 / 极高 / 最大
// 只影响从那句话开起来的新会话；已经在终端里跑着的会话不受影响（要改它自己
// 的模式，得在那个会话里按 Shift+Tab 或输入斜杠命令）。
//
// 可选值与 claude CLI 自己的说法对齐（claude --help）：
//   --permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>
//   --effort <low|medium|high|xhigh|max>
// 面板上没有「不带参数」这一档：每排永远有一个选中项，所以命令里永远带着这两个
// 参数。bypassPermissions（跳过一切确认）不在面板里——那档要走桌宠菜单里那条
// 会明确确认的路径，不能被面板一下点开。
//
// 初始档：权限取「手动」（每步都问，最保守），强度取「高」（不下调，
// 免得面板开出来的会话悄悄比平时弱）。
// ══════════════════════════════════════════════════════════════════

const PERMISSION_MODES = Object.freeze(["auto", "manual", "acceptEdits", "plan"]);
const EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

const INITIAL_PERMISSION_MODE = "manual";
const INITIAL_EFFORT = "high";

function normalizePermissionMode(value) {
  return PERMISSION_MODES.includes(value) ? value : INITIAL_PERMISSION_MODE;
}

function normalizeEffort(value) {
  return EFFORT_LEVELS.includes(value) ? value : INITIAL_EFFORT;
}

// 把设置翻成跟在 claude 后面的参数。两排永远各有一个选中项，所以这里总是
// 两个参数都带——面板上显示什么，命令行里就是什么。
function buildNewSessionArgs(options = {}) {
  return [
    "--permission-mode", normalizePermissionMode(options.permissionMode),
    "--effort", normalizeEffort(options.effort),
  ];
}

module.exports = {
  PERMISSION_MODES,
  EFFORT_LEVELS,
  INITIAL_PERMISSION_MODE,
  INITIAL_EFFORT,
  normalizePermissionMode,
  normalizeEffort,
  buildNewSessionArgs,
};
