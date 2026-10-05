"use strict";

// ══════════════════════════════════════════════════════════════════
// Session HUD 渲染端（整块面板一份）
//
// 单窗口整块卡片，从上到下：
//   状态行 → 「权限模式 · effort」按钮 → 工作文件夹行 → 输入框（+ 停止按钮）
//
// 点按钮展开二级设置菜单（卡片随之变高）：上方是权限模式列表（每项带一行
// 解释），下方是 effort 左右滑块。菜单开关状态由主进程持有，渲染端只投影
// （窗口高度要跟着变，渲染端自己存状态会跟窗口尺寸脱节）。
//
// 窗口的显隐与尺寸都由主进程负责（showInactive() 显示），渲染端不关心。
// 语言和 quick-state 推送都只更新已有节点的内容，不重建输入框/滑块，
// 这样打字时的焦点和草稿不会丢。
// ══════════════════════════════════════════════════════════════════

const QUICK_FEEDBACK_MS = 4000;

// effort / 权限模式的取值顺序（与主进程约定一致）
const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_OPTION_KEYS = { low: "chatEffortLow", medium: "chatEffortMedium", high: "chatEffortHigh", xhigh: "chatEffortXhigh", max: "chatEffortMax" };
const MODE_OPTIONS = ["default", "acceptEdits", "plan", "auto"];
const MODE_OPTION_KEYS = { default: "chatModeDefault", acceptEdits: "chatModeAcceptEdits", plan: "chatModePlan", auto: "chatModeAuto" };
// 模式名下方的一行解释（菜单里显示，帮用户选）
const MODE_DESC_KEYS = { default: "chatModeDefaultDesc", acceptEdits: "chatModeAcceptEditsDesc", plan: "chatModePlanDesc", auto: "chatModeAutoDesc" };

// 停止按钮的图标（圆角方块）
const STOP_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"/></svg>`;

const hudEl = document.getElementById("hud");

let i18nPayload = { lang: "en", translations: {} };
// i18n 未就绪前不写文案，避免闪出一串 key 名
let i18nReady = false;

// 主进程推送的快捷状态（字段缺失时用 normalizeQuickState 兜默认值）
let quickState = normalizeQuickState(null);

// 输入块上的临时提示（发送失败 / 队列满），4 秒后自动消失
let quickFeedback = null;
let quickFeedbackTimer = null;

// 常驻节点：面板只建一次，之后只改内容
let statusTextEl = null;
let promptInputEl = null;
let stopBtnEl = null;
let levelBtnEl = null;
let levelLabelEl = null;
const modeOptionEls = [];   // [{ value, el, nameEl, descEl }]
let effortRangeEl = null;
let effortLabelEl = null;
let effortValueEl = null;
let folderBtnEl = null;
let folderLabelEl = null;
// 正在拖 effort 滑块：拖动期间不被 quick-state 推来的旧值抢回去。
let effortDragging = false;
// 卡片节点 + 上一次上报的穿透状态：指针进出卡片时通知主进程切换
let cardEl = null;
let lastClickThrough = null;

function t(key) {
  const dict = i18nPayload && i18nPayload.translations ? i18nPayload.translations : {};
  return dict[key] || key;
}

// 主进程推送的 quick-state 可能缺字段，这里统一补默认值
function normalizeQuickState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  const queued = Number(s.queuedCount);
  return {
    effort: EFFORT_OPTIONS.includes(s.effort) ? s.effort : "medium",
    permissionMode: MODE_OPTIONS.includes(s.permissionMode) ? s.permissionMode : "default",
    status: typeof s.status === "string" && s.status ? s.status : "idle",
    busy: !!s.busy,
    queuedCount: Number.isFinite(queued) && queued > 0 ? Math.floor(queued) : 0,
    blocked: s.blocked === "no-cwd" ? "no-cwd" : null,
    hasCwd: !!s.hasCwd,
    cwdName: typeof s.cwdName === "string" && s.cwdName ? s.cwdName : null,
    menuOpen: !!s.menuOpen,
  };
}

/* ===== 状态行 / 输入 ===== */

// 状态行文字（优先级）：临时提示 > 未选工作目录 > busy > error > idle；
// 有排队时一律追加「· 已排队 n」（即使没在忙）。
function quickStatusText() {
  if (quickFeedback) return quickFeedback;
  if (quickState.blocked === "no-cwd") return t("hudQuickNoCwd");
  let text = quickState.busy
    ? t("hudQuickStatusWorking")
    : (quickState.status === "error" ? t("hudQuickStatusError") : t("hudQuickStatusIdle"));
  if (quickState.queuedCount > 0) {
    text += ` · ${t("hudQuickQueued").replace("{n}", String(quickState.queuedCount))}`;
  }
  return text;
}

// 状态行只在内容/样式真的变了才动，避免无谓重排
function updateStatusRow() {
  if (!statusTextEl || !i18nReady) return;
  const text = quickStatusText();
  if (statusTextEl.textContent !== text) statusTextEl.textContent = text;
  const isError = !!quickFeedback
    || (quickState.blocked !== "no-cwd" && !quickState.busy && quickState.status === "error");
  if (statusTextEl.classList.contains("is-error") !== isError) {
    statusTextEl.classList.toggle("is-error", isError);
  }
}

// 停止按钮只在正忙时出现（行高固定 32px，出现/消失不影响卡片高度）
function updateStopButton() {
  if (!stopBtnEl) return;
  const display = quickState.busy ? "" : "none";
  if (stopBtnEl.style.display !== display) stopBtnEl.style.display = display;
}

function showQuickFeedback(message) {
  if (quickFeedbackTimer) clearTimeout(quickFeedbackTimer);
  quickFeedback = message;
  updateStatusRow();
  quickFeedbackTimer = setTimeout(() => {
    quickFeedbackTimer = null;
    quickFeedback = null;
    updateStatusRow();
  }, QUICK_FEEDBACK_MS);
}

function createStatusRow() {
  const statusRow = document.createElement("div");
  statusRow.className = "quick-status-row";
  statusTextEl = document.createElement("span");
  statusTextEl.className = "quick-status-text";
  statusRow.appendChild(statusTextEl);
  return statusRow;
}

function createLevelRow() {
  levelBtnEl = document.createElement("button");
  levelBtnEl.type = "button";
  levelBtnEl.className = "quick-level-btn";
  levelLabelEl = document.createElement("span");
  levelLabelEl.className = "quick-level-label";
  const caret = document.createElement("span");
  caret.className = "quick-level-caret";
  levelBtnEl.appendChild(levelLabelEl);
  levelBtnEl.appendChild(caret);
  // 开合状态在主进程；这里只发请求，界面等状态推回来再变。
  levelBtnEl.addEventListener("click", handleLevelToggle);
  return levelBtnEl;
}

// 二级菜单：上方权限模式列表（名称 + 解释），下方 effort 滑块。
function createMenu() {
  const menu = document.createElement("div");
  menu.className = "quick-menu";

  const modes = document.createElement("div");
  modes.className = "quick-menu-modes";
  for (const value of MODE_OPTIONS) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "quick-mode-option";
    const nameEl = document.createElement("span");
    nameEl.className = "quick-mode-name";
    const descEl = document.createElement("span");
    descEl.className = "quick-mode-desc";
    option.appendChild(nameEl);
    option.appendChild(descEl);
    option.addEventListener("click", () => handleModePick(value));
    modeOptionEls.push({ value, el: option, nameEl, descEl });
    modes.appendChild(option);
  }

  const effortBox = document.createElement("div");
  effortBox.className = "quick-menu-effort";
  const head = document.createElement("div");
  head.className = "quick-effort-head";
  effortLabelEl = document.createElement("span");
  effortLabelEl.className = "quick-effort-label";
  effortValueEl = document.createElement("span");
  effortValueEl.className = "quick-effort-value";
  head.appendChild(effortLabelEl);
  head.appendChild(effortValueEl);

  effortRangeEl = document.createElement("input");
  effortRangeEl.type = "range";
  effortRangeEl.className = "quick-effort-range";
  effortRangeEl.min = "0";
  effortRangeEl.max = String(EFFORT_OPTIONS.length - 1);
  effortRangeEl.step = "1";
  // 拖动中（input）只改本地显示，松手（change）才发请求——effort 会重置
  // 会话上下文，不能每挪一格就发一次。
  effortRangeEl.addEventListener("input", handleEffortSlide);
  effortRangeEl.addEventListener("change", handleEffortCommit);

  effortBox.appendChild(head);
  effortBox.appendChild(effortRangeEl);
  menu.appendChild(modes);
  menu.appendChild(effortBox);
  return menu;
}

function createFolderRow() {
  folderBtnEl = document.createElement("button");
  folderBtnEl.type = "button";
  folderBtnEl.className = "quick-folder-btn";
  folderLabelEl = document.createElement("span");
  folderLabelEl.className = "quick-folder-label";
  folderBtnEl.appendChild(folderLabelEl);
  folderBtnEl.addEventListener("click", handlePickFolder);
  return folderBtnEl;
}

function createInputRow() {
  const inputRow = document.createElement("div");
  inputRow.className = "quick-input-row";

  promptInputEl = document.createElement("input");
  promptInputEl.type = "text";
  promptInputEl.className = "quick-input";
  promptInputEl.addEventListener("keydown", handleInputKeydown);
  // 聚焦 / 有草稿时让面板保持显示（hold 由主进程解释）
  promptInputEl.addEventListener("focus", () => {
    window.sessionHudAPI.setHold("focus", true);
  });
  promptInputEl.addEventListener("blur", () => {
    window.sessionHudAPI.setHold("focus", false);
  });
  promptInputEl.addEventListener("input", () => {
    window.sessionHudAPI.setHold("draft", promptInputEl.value.length > 0);
  });

  stopBtnEl = document.createElement("button");
  stopBtnEl.type = "button";
  stopBtnEl.className = "quick-stop-btn";
  stopBtnEl.innerHTML = STOP_SVG;
  stopBtnEl.style.display = "none";
  stopBtnEl.addEventListener("click", handleStopChat);

  inputRow.appendChild(promptInputEl);
  inputRow.appendChild(stopBtnEl);
  return inputRow;
}

function handleInputKeydown(event) {
  // 229 / isComposing：中文等输入法组字过程中不触发发送
  if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    handleSendPrompt();
  }
}

// 回车发送：成功/排队 → 清空输入框；队列满 / 失败 → 保留文字并在状态行提示
async function handleSendPrompt() {
  if (!promptInputEl) return;
  const text = promptInputEl.value;
  if (!text || !text.trim()) return; // 空白不发送
  try {
    const result = await window.sessionHudAPI.sendPrompt(text);
    const status = result && result.status;
    if (status === "ok" || status === "queued") {
      promptInputEl.value = "";
      window.sessionHudAPI.setHold("draft", false);
      return;
    }
    showQuickFeedback(status === "full" ? t("hudQuickQueueFull") : t("hudQuickSendFailed"));
  } catch (err) {
    console.warn("send prompt threw:", err);
    showQuickFeedback(t("hudQuickSendFailed"));
  }
}

async function handleStopChat() {
  try {
    await window.sessionHudAPI.stopChat();
  } catch (err) {
    console.warn("stop chat threw:", err);
  }
}

/* ===== 权限模式 / effort / 文件夹 ===== */

// 「权限模式 · effort」按钮的文案，如「自动 · 高」
function levelButtonText(state = quickState) {
  const mode = t(MODE_OPTION_KEYS[state.permissionMode] || state.permissionMode);
  const effort = t(EFFORT_OPTION_KEYS[state.effort] || state.effort);
  return `${mode} · ${effort}`;
}

function effortLabelText(value) {
  return t(EFFORT_OPTION_KEYS[value] || value);
}

function setTextIfChanged(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

// 语言变化时只改文案，不重建节点
function syncMenuLabels() {
  if (levelBtnEl) {
    setTextIfChanged(levelLabelEl, levelButtonText());
    const aria = `${t("chatModeLabel")} · ${t("chatEffortLabel")}`;
    if (levelBtnEl.getAttribute("aria-label") !== aria) {
      levelBtnEl.setAttribute("aria-label", aria);
      levelBtnEl.title = aria;
    }
  }
  for (const { value, el, nameEl, descEl } of modeOptionEls) {
    setTextIfChanged(nameEl, t(MODE_OPTION_KEYS[value] || value));
    setTextIfChanged(descEl, t(MODE_DESC_KEYS[value] || ""));
    el.setAttribute("aria-label", t(MODE_OPTION_KEYS[value] || value));
  }
  setTextIfChanged(effortLabelEl, t("chatEffortLabel"));
  if (effortRangeEl) effortRangeEl.setAttribute("aria-label", t("chatEffortLabel"));
}

// 菜单/按钮跟随状态刷新：展开态、模式高亮、滑块位置与禁用态。
function updateMenu() {
  if (!i18nReady) return;
  if (document.body) document.body.classList.toggle("menu-open", quickState.menuOpen);
  syncMenuLabels();
  for (const { value, el } of modeOptionEls) {
    const active = value === quickState.permissionMode;
    if (el.classList.contains("is-active") !== active) el.classList.toggle("is-active", active);
  }
  const index = Math.max(0, EFFORT_OPTIONS.indexOf(quickState.effort));
  if (effortRangeEl) {
    // 用户正在拖：不抢滑块；松手后（或状态推送）再对齐。
    if (!effortDragging && Number(effortRangeEl.value) !== index) effortRangeEl.value = String(index);
    // 正忙或有排队时不允许改 effort（会重置会话上下文）。
    const disabled = quickState.busy || quickState.queuedCount > 0;
    if (effortRangeEl.disabled !== disabled) effortRangeEl.disabled = disabled;
    setTextIfChanged(effortValueEl, effortLabelText(EFFORT_OPTIONS[Number(effortRangeEl.value)] || quickState.effort));
  }
}

function updateSettingsBlock() {
  if (folderLabelEl) {
    const label = quickState.cwdName || t("hudQuickPickFolder");
    setTextIfChanged(folderLabelEl, label);
    if (folderBtnEl.title !== label) folderBtnEl.title = label;
  }
}

async function handleLevelToggle() {
  try {
    await window.sessionHudAPI.setMenuOpen(!quickState.menuOpen);
  } catch (err) {
    console.warn("set menu open threw:", err);
  }
}

// 选了某个权限模式：高亮等状态推回来再变，失败保持原样。
async function handleModePick(value) {
  if (value === quickState.permissionMode) return;
  try {
    const result = await window.sessionHudAPI.setPermissionMode(value);
    if (result && result.status === "error") {
      throw new Error(result.message || "set permission mode failed");
    }
  } catch (err) {
    console.warn("set permission mode threw:", err);
  }
}

// 拖动滑块：只更新本地名称显示，不发请求。
function handleEffortSlide() {
  if (!effortRangeEl) return;
  effortDragging = true;
  const value = EFFORT_OPTIONS[Number(effortRangeEl.value)];
  setTextIfChanged(effortValueEl, effortLabelText(value || quickState.effort));
}

// 松手才提交；失败（返回 error 或抛错）就回到当前生效档位。
async function handleEffortCommit() {
  if (!effortRangeEl) return;
  effortDragging = false;
  const index = Number(effortRangeEl.value);
  const value = EFFORT_OPTIONS[index];
  if (!value || value === quickState.effort) {
    updateMenu();
    return;
  }
  try {
    const result = await window.sessionHudAPI.setEffort(value);
    if (result && result.status === "error") {
      throw new Error(result.message || "set effort failed");
    }
  } catch (err) {
    console.warn("set effort threw:", err);
    updateMenu();
  }
}

async function handlePickFolder() {
  try {
    const result = await window.sessionHudAPI.pickWorkingDir();
    if (result && result.status === "error") {
      console.warn("pick working dir failed:", result.message);
    }
  } catch (err) {
    console.warn("pick working dir threw:", err);
  }
}

/* ===== 组装 / 刷新 ===== */

// 语言刷新：只改文案，不重建任何节点（保住输入框焦点与草稿）
function refreshTexts() {
  if (promptInputEl) {
    const placeholder = t("hudQuickPlaceholder");
    if (promptInputEl.placeholder !== placeholder) promptInputEl.placeholder = placeholder;
  }
  if (stopBtnEl) {
    const stopLabel = t("hudQuickStop");
    if (stopBtnEl.getAttribute("aria-label") !== stopLabel) {
      stopBtnEl.setAttribute("aria-label", stopLabel);
      stopBtnEl.title = stopLabel;
    }
  }
  updateMenu();
  updateStatusRow();
  updateSettingsBlock();
}

function buildPanel() {
  if (!hudEl) return;
  const card = document.createElement("div");
  card.className = "quick-card";
  cardEl = card;
  card.appendChild(createStatusRow());
  card.appendChild(createLevelRow());
  card.appendChild(createMenu());
  card.appendChild(createFolderRow());
  card.appendChild(createInputRow());
  hudEl.appendChild(card);
}

async function init() {
  // 先把 DOM 搭出来，文案等 i18n 到了再填
  buildPanel();

  window.sessionHudAPI.onLangChange((payload) => {
    i18nPayload = payload || i18nPayload;
    i18nReady = true;
    refreshTexts();
  });
  // quick-state 只更新对应控件，不重建 DOM，避免打字时丢焦点
  window.sessionHudAPI.onQuickState((next) => {
    quickState = normalizeQuickState(next);
    updateStatusRow();
    updateStopButton();
    updateMenu();
    updateSettingsBlock();
  });
  // 指针进出卡片：卡片外的透明区（收起菜单后窗口比卡片高的那截）放行点击，
  // 别挡住底下应用的点击。主进程的轮询另有兜底。
  document.addEventListener("mousemove", (event) => {
    if (!cardEl) return;
    const rect = cardEl.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside === lastClickThrough) return;
    lastClickThrough = !inside;
    try {
      window.sessionHudAPI.setClickThrough(!inside);
    } catch (err) {
      console.warn("set click through threw:", err);
    }
  });
  // Esc 收起二级菜单（面板整体的收起仍走鼠标离开）
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !quickState.menuOpen) return;
    event.preventDefault();
    Promise.resolve(window.sessionHudAPI.setMenuOpen(false)).catch(() => {});
  });

  try {
    i18nPayload = (await window.sessionHudAPI.getI18n()) || i18nPayload;
  } catch (err) {
    console.warn("load i18n threw:", err);
  }
  i18nReady = true;
  refreshTexts();
}

if (window.sessionHudAPI) {
  init().catch((err) => {
    console.warn("session hud renderer init failed:", err);
  });
} else {
  console.warn("session hud renderer: preload API 不可用（缺 window.sessionHudAPI）");
}
