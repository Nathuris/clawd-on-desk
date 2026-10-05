"use strict";

// 回复窗口的定位计算：纯几何，不依赖 Electron，方便单测。
//
// 两种模式（设置里切换）：
// - follow：贴在桌宠左右两侧，优先左侧（与快捷面板一致）；900×640 的大窗在
//   普通屏幕上常常两侧都放不下，这时夹进工作区、停在工作区里离桌宠远的那一侧，
//   尽量别把桌宠压住。
// - corner：固定在某个显示器（主显示器）工作区的某个角。
//
// 约定：传入/返回的都是窗口「外框」矩形（含标题栏），与 win.setBounds 一致；
// 桌宠矩形既接受 { x, y, width, height }（BrowserWindow.getBounds 形状），
// 也接受 { left, top, right, bottom }（命中矩形/锚点矩形形状）。

const { isUsableWorkArea } = require("./bubble-work-area");

const POSITION_MODES = Object.freeze(["follow", "corner"]);
const FIXED_CORNERS = Object.freeze(["top-left", "top-right", "bottom-left", "bottom-right"]);
const DEFAULT_POSITION_MODE = "follow";
const DEFAULT_FIXED_CORNER = "bottom-right";
// 窗口与桌宠之间的水平间隙、窗口距离工作区边缘的安全边距（像素）。
const DEFAULT_GAP = 12;
const DEFAULT_EDGE_MARGIN = 8;

function normalizeChatPositionMode(value) {
  return POSITION_MODES.includes(value) ? value : DEFAULT_POSITION_MODE;
}

function normalizeChatFixedCorner(value) {
  return FIXED_CORNERS.includes(value) ? value : DEFAULT_FIXED_CORNER;
}

function normalizeRect(value) {
  if (!value) return null;
  if (
    Number.isFinite(value.left)
    && Number.isFinite(value.top)
    && Number.isFinite(value.right)
    && Number.isFinite(value.bottom)
    && value.right > value.left
    && value.bottom > value.top
  ) {
    return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
  }
  if (
    Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.width)
    && Number.isFinite(value.height)
    && value.width > 0
    && value.height > 0
  ) {
    return {
      left: value.x,
      top: value.y,
      right: value.x + value.width,
      bottom: value.y + value.height,
    };
  }
  return null;
}

// 夹取到 [min, max]；窗口比可用区域还大时（min > max）取中点，让溢出左右对称，
// 而不是死死贴着左边、整个窗口甩到屏幕外。
function clampAxis(value, min, max) {
  if (max < min) return Math.round((min + max) / 2);
  return Math.round(Math.min(Math.max(value, min), max));
}

function computeChatWindowBounds(options = {}) {
  const width = Math.round(Number(options.width));
  const height = Math.round(Number(options.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (!isUsableWorkArea(options.workArea)) return null;
  const workArea = options.workArea;

  const edge = Math.max(0, Math.round(Number.isFinite(options.edgeMargin) ? options.edgeMargin : DEFAULT_EDGE_MARGIN));
  const gap = Math.max(0, Math.round(Number.isFinite(options.gap) ? options.gap : DEFAULT_GAP));
  const w = Math.min(width, Math.max(1, Math.round(workArea.width)));
  const h = Math.min(height, Math.max(1, Math.round(workArea.height)));

  const minX = Math.round(workArea.x + edge);
  const minY = Math.round(workArea.y + edge);
  const maxX = Math.round(workArea.x + workArea.width - edge - w);
  const maxY = Math.round(workArea.y + workArea.height - edge - h);

  if (normalizeChatPositionMode(options.mode) === "corner") {
    const corner = normalizeChatFixedCorner(options.corner);
    const onLeft = corner.endsWith("left");
    const onTop = corner.startsWith("top");
    return {
      x: clampAxis(onLeft ? minX : maxX, minX, maxX),
      y: clampAxis(onTop ? minY : maxY, minY, maxY),
      width: w,
      height: h,
      side: corner,
    };
  }

  const follow = normalizeRect(options.anchorRect) || normalizeRect(options.petRect);
  if (!follow) {
    // 桌宠矩形还没就绪（首次启动的时序）：退回工作区居中。
    return {
      x: clampAxis(workArea.x + (workArea.width - w) / 2, minX, maxX),
      y: clampAxis(workArea.y + (workArea.height - h) / 2, minY, maxY),
      width: w,
      height: h,
      side: "center",
    };
  }

  const leftX = Math.round(follow.left - gap - w);
  const rightX = Math.round(follow.right + gap);
  const fitsLeft = leftX >= minX && leftX <= maxX;
  const fitsRight = rightX >= minX && rightX <= maxX;

  let side = null;
  let x = null;
  if (fitsLeft) {
    side = "left";
    x = leftX;
  } else if (fitsRight) {
    side = "right";
    x = rightX;
  } else {
    // 两侧都放不下：夹进工作区，停在工作区里离桌宠远的那一侧。
    side = "clamped";
    const petCx = (follow.left + follow.right) / 2;
    const areaCx = workArea.x + workArea.width / 2;
    x = clampAxis(petCx >= areaCx ? minX : maxX, minX, maxX);
  }

  // 纵向以桌宠为中心，夹在工作区内。
  const followCy = Math.round((follow.top + follow.bottom) / 2);
  const y = clampAxis(followCy - h / 2, minY, maxY);

  return { x, y, width: w, height: h, side };
}

// 「一条」版式（跟随模式专用）：回复窗口贴在快捷面板卡片的正上方，左边缘对齐、
// 底边紧贴卡片顶边——两个窗口视觉上就是一条竖着的聊天窗，输入框在最下面。
// panelCard 是面板「收起态卡片」的屏幕矩形（由 session-hud 给出，跟面板当前是否
// 可见无关）。整条夹进工作区；真放不下时窗口会压住卡片，而面板始终置顶，
// 所以只是位置不理想，不会看不见。
function computeAttachedChatBounds(options = {}) {
  const panelCard = normalizeRect(options.panelCard);
  const width = Math.round(Number(options.width));
  const height = Math.round(Number(options.height));
  if (!panelCard || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  if (!isUsableWorkArea(options.workArea)) return null;
  const workArea = options.workArea;

  const edge = Math.max(0, Math.round(Number.isFinite(options.edgeMargin) ? options.edgeMargin : DEFAULT_EDGE_MARGIN));
  const gap = Math.max(0, Math.round(Number.isFinite(options.gap) ? options.gap : 0));
  const w = Math.min(width, Math.max(1, Math.round(workArea.width)));
  const h = Math.min(height, Math.max(1, Math.round(workArea.height)));

  const minX = Math.round(workArea.x + edge);
  const maxX = Math.round(workArea.x + workArea.width - edge - w);
  const minY = Math.round(workArea.y + edge);
  const maxY = Math.round(workArea.y + workArea.height - edge - h);

  return {
    x: clampAxis(Math.round(panelCard.left), minX, maxX),
    y: clampAxis(Math.round(panelCard.top - gap - h), minY, maxY),
    width: w,
    height: h,
    side: "attached",
  };
}

// 位置是否「明显不同」：宽高只要不等就算不同；坐标差不超过 minDelta 视为没动
// （用于跟随时的小抖动死区）。
function chatBoundsDiffer(a, b, minDelta) {
  if (!a || !b) return true;
  if (a.width !== b.width || a.height !== b.height) return true;
  const delta = Number.isFinite(minDelta) ? Math.max(0, minDelta) : 0;
  return Math.abs(a.x - b.x) > delta || Math.abs(a.y - b.y) > delta;
}

module.exports = {
  POSITION_MODES,
  FIXED_CORNERS,
  DEFAULT_POSITION_MODE,
  DEFAULT_FIXED_CORNER,
  DEFAULT_GAP,
  DEFAULT_EDGE_MARGIN,
  normalizeChatPositionMode,
  normalizeChatFixedCorner,
  computeChatWindowBounds,
  computeAttachedChatBounds,
  chatBoundsDiffer,
};
