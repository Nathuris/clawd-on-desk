"use strict";

// ══════════════════════════════════════════════════════════════════
// Session HUD 渲染端（整块面板一份）
//
// 单窗口整块卡片，从上到下：状态行 → 输入框。
// 状态行说「这句话会发给谁」（终端里最近活动的那个会话），输入框里的话由
// 主进程投递到终端 App 里那个正在运行的 CLI 会话——真正的对话仍然发生在
// 终端里，这个面板只是个远程输入框。
//
// 窗口的显隐与尺寸都由主进程负责（showInactive() 显示），渲染端不关心。
// 语言和 quick-state 推送都只更新已有节点的内容，不重建输入框，
// 这样打字时的焦点和草稿不会丢。
// ══════════════════════════════════════════════════════════════════

const QUICK_FEEDBACK_MS = 4000;

const hudEl = document.getElementById("hud");

let i18nPayload = { lang: "en", translations: {} };
// i18n 未就绪前不写文案，避免闪出一串 key 名
let i18nReady = false;

// 主进程推送的快捷状态（字段缺失时用 normalizeQuickState 兜默认值）
let quickState = normalizeQuickState(null);

// 输入框上的临时提示（已发送 / 已复制 / 失败），4 秒后自动消失
let quickFeedback = null;
let quickFeedbackTimer = null;
let quickFeedbackIsError = false;

// 常驻节点：面板只建一次，之后只改内容
let statusTextEl = null;
let targetBtnEl = null;
let sessionListEl = null;
let promptInputEl = null;
// 卡片节点 + 上一次上报的穿透状态：指针进出卡片时通知主进程切换
let cardEl = null;
let lastClickThrough = null;

function t(key) {
  const dict = i18nPayload && i18nPayload.translations ? i18nPayload.translations : {};
  return dict[key] || key;
}

// 主进程推送的 quick-state 可能缺字段，这里统一补默认值
function normalizeSession(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) return null;
  return {
    id: String(raw.id),
    title: typeof raw.title === "string" && raw.title ? raw.title : null,
    folder: typeof raw.folder === "string" && raw.folder ? raw.folder : null,
    state: typeof raw.state === "string" && raw.state ? raw.state : null,
    active: raw.active === true,
  };
}

function normalizeQuickState(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  return {
    targetId: typeof s.targetId === "string" && s.targetId ? s.targetId : null,
    targetTitle: typeof s.targetTitle === "string" && s.targetTitle ? s.targetTitle : null,
    targetFolder: typeof s.targetFolder === "string" && s.targetFolder ? s.targetFolder : null,
    targetState: typeof s.targetState === "string" && s.targetState ? s.targetState : null,
    canSend: s.canSend === true,
    sessions: Array.isArray(s.sessions) ? s.sessions.map(normalizeSession).filter(Boolean) : [],
    canCreateSession: s.canCreateSession === true,
    // 新建会话落在哪个文件夹：主进程给「显示用短路径」和「最后一段目录名」两份。
    newSessionFolder: typeof s.newSessionFolder === "string" && s.newSessionFolder ? s.newSessionFolder : null,
    newSessionFolderName: typeof s.newSessionFolderName === "string" && s.newSessionFolderName
      ? s.newSessionFolderName
      : null,
    // 新建会话的两个开关（主进程是唯一状态源，取不到就都算没选，不画高亮）。
    permissionMode: typeof s.permissionMode === "string" && s.permissionMode ? s.permissionMode : "",
    effort: typeof s.effort === "string" && s.effort ? s.effort : "",
    // 排好的新会话占位（列表第一行）。
    pendingId: typeof s.pendingId === "string" && s.pendingId ? s.pendingId : null,
    pendingLaunched: s.pendingLaunched === true,
    targetPending: s.targetPending === true,
    listOpen: s.listOpen === true,
  };
}

/* ===== 状态行 / 输入 ===== */

// 会话状态压成两种说法：在跑 / 闲着。面板只有 16px 一行，细节留给 Dashboard。
function targetStateText() {
  if (!quickState.targetState) return "";
  const quiet = quickState.targetState === "idle" || quickState.targetState === "sleeping";
  return t(quiet ? "hudQuickStatusIdle" : "hudQuickStatusWorking");
}

// 状态行文字：临时提示最优先，其余时候说「正在发给谁」。
function quickStatusText() {
  if (quickFeedback) return quickFeedback;
  if (!quickState.canSend) return t("hudSendNoSession");
  if (quickState.targetPending) {
    // 目标是「排好但还没开起来的新会话」：名字与状态都在字典里。
    const line = t("hudQuickSendingTo").replace("{name}", t("hudQuickPendingTitle"));
    const state = t(quickState.pendingLaunched ? "hudQuickPendingStarting" : "hudQuickPendingState");
    return `${line} · ${state}`;
  }
  const name = quickState.targetTitle || quickState.targetFolder || "";
  const line = t("hudQuickSendingTo").replace("{name}", name);
  const state = targetStateText();
  return state ? `${line} · ${state}` : line;
}

// 状态行只在内容/样式真的变了才动，避免无谓重排
function updateStatusRow() {
  if (!statusTextEl || !i18nReady) return;
  const text = quickStatusText();
  if (statusTextEl.textContent !== text) statusTextEl.textContent = text;
  if (statusTextEl.classList.contains("is-error") !== quickFeedbackIsError) {
    statusTextEl.classList.toggle("is-error", quickFeedbackIsError);
  }
  if (document.body) document.body.classList.toggle("session-list-open", quickState.listOpen);
  if (targetBtnEl) {
    const label = t("hudQuickTargetLabel");
    if (targetBtnEl.getAttribute("aria-label") !== label) {
      targetBtnEl.setAttribute("aria-label", label);
      targetBtnEl.title = label;
    }
    targetBtnEl.setAttribute("aria-expanded", quickState.listOpen ? "true" : "false");
  }
}

// 会话列表只在展开时重建（收起时不碰 DOM，省掉无谓重排）
function updateSessionList() {
  if (!sessionListEl) return;
  if (!quickState.listOpen) {
    if (sessionListEl.children.length) sessionListEl.replaceChildren();
    return;
  }
  renderSessionList();
}

function showQuickFeedback(message, isError = false) {
  if (quickFeedbackTimer) clearTimeout(quickFeedbackTimer);
  quickFeedback = message;
  quickFeedbackIsError = isError;
  updateStatusRow();
  quickFeedbackTimer = setTimeout(() => {
    quickFeedbackTimer = null;
    quickFeedback = null;
    quickFeedbackIsError = false;
    updateStatusRow();
  }, QUICK_FEEDBACK_MS);
}

function createStatusRow() {
  const statusRow = document.createElement("div");
  statusRow.className = "quick-status-row";
  statusTextEl = document.createElement("span");
  statusTextEl.className = "quick-status-text";
  targetBtnEl = document.createElement("button");
  targetBtnEl.type = "button";
  targetBtnEl.className = "quick-target-btn";
  targetBtnEl.appendChild(statusTextEl);
  const caret = document.createElement("span");
  caret.className = "quick-target-caret";
  caret.textContent = "⌄";
  targetBtnEl.appendChild(caret);
  targetBtnEl.addEventListener("click", handleToggleList);
  statusRow.appendChild(targetBtnEl);
  return statusRow;
}

// 会话列表：每条一行（名称 + 文件夹/状态），然后是新建会话的两个开关、新建入口，
// 最后一行是选文件夹。行数由主进程给的列表决定；渲染端最多画 SESSION_ROW_LIMIT
// 条会话，加上四个固定行正好把列表区填满（卡片高度是写死的一组数字）。
const SESSION_ROW_LIMIT = 4;

// 两个开关的可选项。值必须和 src/session-new-options.js 的允许列表一致——
// 主进程只认那几个值，写错了会被打回默认档。
const PERMISSION_CHIPS = [
  { value: "auto", labelKey: "hudQuickPermissionAuto" },
  { value: "manual", labelKey: "hudQuickPermissionManual" },
  { value: "acceptEdits", labelKey: "hudQuickPermissionEdits" },
  { value: "plan", labelKey: "hudQuickPermissionPlan" },
];
const EFFORT_CHIPS = [
  { value: "low", labelKey: "hudQuickEffortLow" },
  { value: "medium", labelKey: "hudQuickEffortMedium" },
  { value: "high", labelKey: "hudQuickEffortHigh" },
  { value: "xhigh", labelKey: "hudQuickEffortXHigh" },
  { value: "max", labelKey: "hudQuickEffortMax" },
];

function createSessionList() {
  sessionListEl = document.createElement("div");
  sessionListEl.className = "quick-session-list";
  return sessionListEl;
}

function renderSessionList() {
  if (!sessionListEl || !i18nReady) return;
  // 排好的新会话占一行，所以真会话的行数让出一位给它。
  const budget = SESSION_ROW_LIMIT - (quickState.pendingId ? 1 : 0);
  const items = quickState.sessions.slice(0, budget);
  const nodes = [];
  if (quickState.pendingId) nodes.push(createPendingRow());
  for (const item of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "quick-session-item";
    if (item.active) row.classList.add("is-active");
    row.setAttribute("data-session-id", item.id);

    const nameEl = document.createElement("span");
    nameEl.className = "quick-session-name";
    nameEl.textContent = item.title || item.folder || item.id;
    row.appendChild(nameEl);

    const metaEl = document.createElement("span");
    metaEl.className = "quick-session-meta";
    metaEl.textContent = sessionMetaText(item);
    row.appendChild(metaEl);

    row.addEventListener("click", () => handleSessionPick(item.id));
    nodes.push(row);
  }
  if (quickState.canCreateSession) {
    const createRow = document.createElement("button");
    createRow.type = "button";
    createRow.className = "quick-session-item quick-session-create";
    const nameEl = document.createElement("span");
    nameEl.className = "quick-session-name";
    nameEl.textContent = t("hudQuickNewSession");
    createRow.appendChild(nameEl);
    // 第二行小字说清新会话会落在哪个文件夹——不写出来的话，用户只能开完
    // 才知道自己在哪儿。
    const where = sessionFolderLabel();
    if (where) {
      const metaEl = document.createElement("span");
      metaEl.className = "quick-session-meta";
      metaEl.textContent = where;
      createRow.appendChild(metaEl);
    }
    createRow.addEventListener("click", handleCreateSession);
    nodes.push(createRow);

    // 两个开关紧跟着「新建会话」：上半截是「发给谁 / 开一个」（选择会话 → 新建
    // 会话），下半截是这两个开关和最底下最不常用的「选文件夹」。
    nodes.push(createSettingRow("hudQuickPermissionLabel", PERMISSION_CHIPS, "permissionMode"));
    nodes.push(createSettingRow("hudQuickEffortLabel", EFFORT_CHIPS, "effort"));

    const folderRow = document.createElement("button");
    folderRow.type = "button";
    folderRow.className = "quick-session-item quick-session-folder";
    const folderNameEl = document.createElement("span");
    folderNameEl.className = "quick-session-name";
    folderNameEl.textContent = t("hudQuickPickFolder");
    folderRow.appendChild(folderNameEl);
    if (quickState.newSessionFolder) {
      const metaEl = document.createElement("span");
      metaEl.className = "quick-session-meta";
      metaEl.textContent = quickState.newSessionFolder;
      folderRow.appendChild(metaEl);
    }
    folderRow.addEventListener("click", handlePickFolder);
    nodes.push(folderRow);
  }
  sessionListEl.replaceChildren(...nodes);
}

// 排好的新会话：整行可点（点它 = 发给它），右边的 ✕ 取消。
// 它排在整个列表的最前面——用户刚点出来的东西，应该在眼皮底下。
function createPendingRow() {
  const row = document.createElement("div");
  row.className = "quick-pending-row";

  const main = document.createElement("button");
  main.type = "button";
  main.className = "quick-session-item quick-session-pending";
  main.setAttribute("data-pending-id", quickState.pendingId);
  if (quickState.targetPending) main.classList.add("is-active");

  const nameEl = document.createElement("span");
  nameEl.className = "quick-session-name";
  nameEl.textContent = t("hudQuickPendingTitle");
  main.appendChild(nameEl);

  const metaEl = document.createElement("span");
  metaEl.className = "quick-session-meta";
  metaEl.textContent = t("hudQuickPendingHint");
  main.appendChild(metaEl);

  main.addEventListener("click", handlePendingPick);
  row.appendChild(main);

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "quick-pending-cancel";
  cancel.textContent = "✕";
  const cancelLabel = t("hudQuickCancelPending");
  cancel.title = cancelLabel;
  cancel.setAttribute("aria-label", cancelLabel);
  cancel.addEventListener("click", handleCancelPending);
  row.appendChild(cancel);

  return row;
}

// 一行开关：上面一行小标签，下面一排小按钮（单选，当前档高亮）。
// 标签单独占一行是因为按钮最多有 6 个（默认+五档），和标签挤一行在
// 西语/葡语那种长单词下会被挤掉。
function createSettingRow(labelKey, chips, optionKey) {
  const row = document.createElement("div");
  row.className = "quick-setting-row";
  row.setAttribute("data-option", optionKey);

  const label = document.createElement("span");
  label.className = "quick-setting-label";
  label.textContent = t(labelKey);
  row.appendChild(label);

  const chipsEl = document.createElement("div");
  chipsEl.className = "quick-setting-chips";
  for (const chip of chips) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quick-chip";
    if (chip.danger) button.classList.add("is-danger");
    button.setAttribute("data-value", chip.value);
    button.textContent = t(chip.labelKey);
    if (quickState[optionKey] === chip.value) button.classList.add("is-selected");
    button.addEventListener("click", () => handleSettingPick(optionKey, chip.value));
    chipsEl.appendChild(button);
  }
  row.appendChild(chipsEl);
  return row;
}

// 「新建会话」那一行的第二行小字：位置：<目录名> · 全部允许 · 强度：高。
// 把当前两个开关也写在这儿——按钮在上面、动作用的是它们，不写出来的话
// 用户点下去之前没法确认自己开的是哪一档。
function sessionFolderLabel() {
  const name = quickState.newSessionFolderName || quickState.newSessionFolder;
  const parts = [];
  if (name) parts.push(t("hudQuickNewSessionAt").replace("{path}", name));
  const permission = chipLabel(PERMISSION_CHIPS, quickState.permissionMode);
  if (permission) parts.push(permission);
  const effort = chipLabel(EFFORT_CHIPS, quickState.effort);
  if (effort) parts.push(`${t("hudQuickEffortLabel")}：${effort}`);
  return parts.join(" · ");
}

// 认不出的值（主进程还没推过状态）什么都不写：宁可少一行字，也不要凭空造词。
function chipLabel(chips, value) {
  const chip = chips.find((item) => item.value === value);
  return chip ? t(chip.labelKey) : "";
}

function sessionMetaText(item) {
  const quiet = item.state === "idle" || item.state === "sleeping";
  const state = item.state ? t(quiet ? "hudQuickStatusIdle" : "hudQuickStatusWorking") : "";
  return [item.folder, state].filter(Boolean).join(" · ");
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

  inputRow.appendChild(promptInputEl);
  return inputRow;
}

function handleInputKeydown(event) {
  // 229 / isComposing：中文等输入法组字过程中不触发发送
  if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    handleSendPrompt();
  }
}

// 发送结果 → 状态行文案。主进程一般会带 textKey；万一没带，按 status 兜一个，
// 免得一次成功的发送被显示成「发送失败」。
const SEND_RESULT_KEYS = {
  ok: "hudSendSent",
  copied: "hudSendCopied",
  "no-session": "hudSendNoSession",
  starting: "hudNewSessionStarting",
  error: "hudQuickSendFailed",
};

// 回车发送：真的进了终端 → 清空输入框并提示；只落到剪贴板 → 保留文字（剪贴板
// 里也有一份，不会丢）并如实告诉用户去粘贴。
async function handleSendPrompt() {
  if (!promptInputEl) return;
  const text = promptInputEl.value;
  if (!text || !text.trim()) return; // 空白不发送
  try {
    const result = await window.sessionHudAPI.sendPrompt(text);
    const status = result && result.status;
    const textKey = (result && result.textKey) || SEND_RESULT_KEYS[status] || "hudQuickSendFailed";
    if (status === "ok") {
      promptInputEl.value = "";
      window.sessionHudAPI.setHold("draft", false);
    }
    showQuickFeedback(t(textKey), status !== "ok");
  } catch (err) {
    console.warn("send prompt threw:", err);
    showQuickFeedback(t("hudQuickSendFailed"), true);
  }
}

async function handleToggleList() {
  try {
    await window.sessionHudAPI.setListOpen(!quickState.listOpen);
  } catch (err) {
    console.warn("set list open threw:", err);
  }
}

async function handleSessionPick(sessionId) {
  try {
    await window.sessionHudAPI.selectSession(sessionId);
    // 选完就把列表收起来（主进程会把新的展开状态推回来）
    await window.sessionHudAPI.setListOpen(false);
  } catch (err) {
    console.warn("select session threw:", err);
  }
}

// 切换新建会话的权限模式 / 思考强度。选中的档由主进程推回来（它是唯一状态源），
// 这里只负责把「点了哪一排的哪一档」报上去。
async function handleSettingPick(optionKey, value) {
  try {
    await window.sessionHudAPI.setNewSessionOption(optionKey, value);
  } catch (err) {
    console.warn("set new session option threw:", err);
    showQuickFeedback(t("hudQuickOptionFailed"), true);
  }
}

// 选「新建会话」落在哪个文件夹：主进程弹系统文件夹选择框，选完把新的位置
// 推回来（那一行的第二行小字会跟着变）。列表保持展开，用户接着点新建就行。
async function handlePickFolder() {
  try {
    const result = await window.sessionHudAPI.pickFolder();
    if (result && result.status === "error") showQuickFeedback(t("hudPickFolderFailed"), true);
  } catch (err) {
    console.warn("pick folder threw:", err);
    showQuickFeedback(t("hudPickFolderFailed"), true);
  }
}

// 排一个「新会话」：列表不收起——刚排出来的那一行就在最上面，用户要看得见它。
async function handleCreateSession() {
  try {
    const result = await window.sessionHudAPI.newSession();
    const textKey = (result && result.textKey) || "hudNewSessionFailed";
    showQuickFeedback(t(textKey), !(result && result.status === "ok"));
  } catch (err) {
    console.warn("new session threw:", err);
    showQuickFeedback(t("hudNewSessionFailed"), true);
  }
}

// 点占位行 = 以后发给它（并收起列表，和点某个会话一样）。
async function handlePendingPick() {
  if (!quickState.pendingId) return;
  try {
    await window.sessionHudAPI.selectSession(quickState.pendingId);
    await window.sessionHudAPI.setListOpen(false);
  } catch (err) {
    console.warn("select pending session threw:", err);
  }
}

async function handleCancelPending() {
  try {
    await window.sessionHudAPI.cancelPendingSession();
  } catch (err) {
    console.warn("cancel pending session threw:", err);
  }
}

/* ===== 组装 / 刷新 ===== */

// 语言刷新：只改文案，不重建任何节点（保住输入框焦点与草稿）
function refreshTexts() {
  if (promptInputEl) {
    const placeholder = t("hudQuickPlaceholder");
    if (promptInputEl.placeholder !== placeholder) promptInputEl.placeholder = placeholder;
  }
  updateStatusRow();
  updateSessionList();
}

function buildPanel() {
  if (!hudEl) return;
  const card = document.createElement("div");
  card.className = "quick-card";
  cardEl = card;
  card.appendChild(createStatusRow());
  card.appendChild(createSessionList());
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
    updateSessionList();
  });
  // 指针进出卡片：卡片外的透明区放行点击（窗口比卡片高的那截），
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

  // Esc 收起会话列表（面板整体的收起仍走鼠标离开）
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !quickState.listOpen) return;
    event.preventDefault();
    window.sessionHudAPI.setListOpen(false);
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
