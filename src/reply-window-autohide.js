"use strict";

// 回复窗口「自动消失」的判定：纯函数，谁在轮询、光标怎么读都不归它管。
//
// 和快捷面板同一套节奏（指针离开热区 + 宽限期后收起），但**不**沿用面板那条
// 「拖着宠物 / 菜单开着就收」的动作互斥——拖桌宠时回复窗口正要跟着走，不能消失；
// 右键菜单弹出来时也一样，窗口在旁边看着就行。
//
// 三种保活（任一成立就一直显示）：
// - 指针在热区内（桌宠 / 面板 / 回复窗口，含 pad）
// - 窗口自己拿着键盘焦点（用户正在里面选字、复制）
// - Claude 正在回复（busy）：请求刚发出、回复还在流的时候窗口不能溜走

// 回复刚结束后的额外停留：用户多半还在看最后几行。
const REPLY_DONE_HOLD_MS = 4000;

function decideReplyWindowVisibility(options = {}) {
  const open = options.open === true;
  if (!open) return { show: false, nextHoldUntil: 0, busyEnded: false };

  const now = Number.isFinite(options.now) ? options.now : 0;
  const grace = Number.isFinite(options.hideGraceMs) ? Math.max(0, options.hideGraceMs) : 0;
  const doneHold = Number.isFinite(options.doneHoldMs) ? Math.max(0, options.doneHoldMs) : REPLY_DONE_HOLD_MS;
  const holdUntil = Number.isFinite(options.holdUntil) ? options.holdUntil : 0;
  const busy = options.busy === true;
  const busyEnded = busy === false && options.wasBusy === true;

  // 回复刚结束：给一段阅读时间，即使指针已经离开。
  const baseHold = busyEnded ? Math.max(holdUntil, now + doneHold) : holdUntil;

  if (options.pointerInHotZone === true || options.focused === true || busy) {
    return { show: true, nextHoldUntil: now + grace, busyEnded };
  }
  if (now <= baseHold) {
    return { show: true, nextHoldUntil: baseHold, busyEnded };
  }
  return { show: false, nextHoldUntil: 0, busyEnded };
}

module.exports = {
  REPLY_DONE_HOLD_MS,
  decideReplyWindowVisibility,
};
