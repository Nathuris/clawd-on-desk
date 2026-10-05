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
let attachBtnEl = null;
let attachRowEl = null;

// 挂在输入框上的附件（发送时跟着消息一起走）。路径不进输入框——一长串路径
// 挤在里面就没法打字了，所以在这儿存着，界面上只显示文件名。
// 只有这份状态在渲染端：主进程只要一个数字（几个附件）来决定卡片多高。
const MAX_ATTACHMENTS = 4;
let attachments = [];
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
  // 剪贴板里是图片/文件时，把它变成路径填进来（见 handlePaste）
  promptInputEl.addEventListener("paste", handlePaste);
  // 聚焦 / 有草稿时让面板保持显示（hold 由主进程解释）
  promptInputEl.addEventListener("focus", () => {
    window.sessionHudAPI.setHold("focus", true);
  });
  promptInputEl.addEventListener("blur", () => {
    window.sessionHudAPI.setHold("focus", false);
  });
  promptInputEl.addEventListener("input", () => {
    window.sessionHudAPI.setHold("draft", promptInputEl.value.length > 0 || attachments.length > 0);
  });

  inputRow.appendChild(promptInputEl);

  const attachBtn = document.createElement("button");
  attachBtn.type = "button";
  attachBtn.className = "quick-attach-btn";
  attachBtn.textContent = "📎";
  attachBtn.addEventListener("click", handleAttachFile);
  inputRow.appendChild(attachBtn);
  attachBtnEl = attachBtn;

  return inputRow;
}

/* ===== 加文件：选文件 / 粘贴图片 ===== */

// 路径里带空格或引号的，拼进消息时包成双引号——不然 Claude 会把它读成几个词。
function formatPathForInput(value) {
  const text = String(value || "");
  if (!text) return "";
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

// 路径的最后一段当显示名（渲染端拿不到 node 的 path，按分隔符切就够了）。
function fileNameFor(path) {
  const text = String(path || "");
  const parts = text.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : text;
}

// 挂上文件。重复的路径不再挂第二遍；超过上限的丢掉并说一声。
function addAttachments(paths) {
  const incoming = (Array.isArray(paths) ? paths : [paths])
    .filter((item) => typeof item === "string" && item)
    .map((item) => ({ path: item, name: fileNameFor(item) }));
  let rejected = 0;
  for (const item of incoming) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      rejected += 1;
      continue;
    }
    if (attachments.some((existing) => existing.path === item.path)) continue;
    attachments.push(item);
  }
  syncAttachments();
  if (rejected) showQuickFeedback(t("hudQuickAttachLimit").replace("{n}", String(MAX_ATTACHMENTS)), true);
}

function removeAttachment(path) {
  const next = attachments.filter((item) => item.path !== path);
  if (next.length === attachments.length) return;
  attachments = next;
  syncAttachments();
}

// 附件变了：重画标签行 + 告诉主进程「现在挂了几个」（卡片高度要跟着变）
// + 按住面板（还挂着东西没发出去，别让它自己收起、更别让窗口被回收）。
function syncAttachments() {
  const count = attachments.length;
  renderAttachments();
  try {
    window.sessionHudAPI.setAttachments(count);
  } catch (err) {
    console.warn("set attachments threw:", err);
  }
  window.sessionHudAPI.setHold("draft", count > 0 || !!(promptInputEl && promptInputEl.value));
}

// 一行标签：每个附件显示 📎 + 文件名 + ✕。没有附件时整行不占位置。
function createAttachRow() {
  attachRowEl = document.createElement("div");
  attachRowEl.className = "quick-attach-row is-empty";
  return attachRowEl;
}

function renderAttachments() {
  if (!attachRowEl) return;
  const nodes = attachments.map((item) => {
    const chip = document.createElement("span");
    chip.className = "quick-attach-chip";
    chip.setAttribute("data-attachment-path", item.path);
    chip.title = item.path;

    const icon = document.createElement("span");
    icon.textContent = "📎";
    chip.appendChild(icon);

    const nameEl = document.createElement("span");
    nameEl.className = "quick-attach-name";
    nameEl.textContent = item.name;
    chip.appendChild(nameEl);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "quick-attach-remove";
    remove.textContent = "✕";
    const label = t("hudQuickAttachRemove");
    remove.setAttribute("aria-label", label);
    remove.title = label;
    remove.addEventListener("click", () => {
      removeAttachment(item.path);
      // 点 ✕ 会把焦点从输入框抢走，交回去，免得面板的「聚焦中」状态断掉
      if (promptInputEl && typeof promptInputEl.focus === "function") promptInputEl.focus();
    });
    chip.appendChild(remove);

    return chip;
  });
  attachRowEl.replaceChildren(...nodes);
  attachRowEl.classList.toggle("is-empty", nodes.length === 0);
  // 卡片高度靠这个 class（CSS）和主进程的 quickCardHeight 同源于同一个判断
  if (document.body) document.body.classList.toggle("has-attachments", nodes.length > 0);
}

async function handleAttachFile() {
  try {
    const result = await window.sessionHudAPI.pickFiles();
    if (!result || result.status !== "ok" || !Array.isArray(result.paths) || !result.paths.length) {
      // 用户点了取消：什么都不说
      if (result && result.status === "error") showQuickFeedback(t("hudQuickAttachFailed"), true);
      return;
    }
    addAttachments(result.paths);
  } catch (err) {
    console.warn("pick files threw:", err);
    showQuickFeedback(t("hudQuickAttachFailed"), true);
  }
}

// 粘贴：剪贴板里是文件（从 Finder 拷的、或截图）就换成路径填进来；
// 是纯文字就什么都不做，让浏览器自己把它插进输入框。
async function handlePaste(event) {
  const clipboard = event && event.clipboardData;
  const items = clipboard && clipboard.items ? clipboard.items : null;
  if (!items || typeof items.length !== "number") return;
  const files = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!item || item.kind !== "file" || typeof item.getAsFile !== "function") continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (!files.length) return;
  event.preventDefault();
  const paths = [];
  for (const file of files) {
    const path = await resolveFileObjectPath(file);
    if (path) paths.push(path);
  }
  if (paths.length) addAttachments(paths);
}

// 有真实路径的（Finder 里拷的）直接用那个路径；没有的（截图、网页里的图）
// 把字节交给主进程存成临时文件，再拿那条路径。拿不到就返回空串。
async function resolveFileObjectPath(file) {
  try {
    const existing = window.sessionHudAPI.pathForFile ? window.sessionHudAPI.pathForFile(file) : "";
    if (existing) return existing;
    const data = typeof file.arrayBuffer === "function" ? await file.arrayBuffer() : null;
    if (!data) {
      showQuickFeedback(t("hudQuickPastedFileFailed"), true);
      return "";
    }
    const result = await window.sessionHudAPI.savePastedFile({
      name: file.name || "paste",
      type: file.type || "",
      data,
    });
    if (result && result.status === "ok" && result.path) return result.path;
    showQuickFeedback(t("hudQuickPastedFileFailed"), true);
    return "";
  } catch (err) {
    console.warn("save pasted file threw:", err);
    showQuickFeedback(t("hudQuickPastedFileFailed"), true);
    return "";
  }
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
// 发出去的那条消息 = 你打的字 + 各附件的路径（含空格的加引号）。
// 终端那边只认文字，所以路径必须跟着消息走；只挂附件不写字也发得出去。
function composePromptText(text) {
  const typed = typeof text === "string" ? text.trim() : "";
  return [typed, ...attachments.map((item) => formatPathForInput(item.path))]
    .filter(Boolean)
    .join(" ");
}

async function handleSendPrompt() {
  if (!promptInputEl) return;
  const outgoing = composePromptText(promptInputEl.value);
  if (!outgoing) return; // 没字也没附件：什么都不发
  try {
    const result = await window.sessionHudAPI.sendPrompt(outgoing);
    const status = result && result.status;
    const textKey = (result && result.textKey) || SEND_RESULT_KEYS[status] || "hudQuickSendFailed";
    if (status === "ok") {
      promptInputEl.value = "";
      // 真送进去了才清附件；只落到剪贴板（copied）或出错时都留着，不让人白挂一遍
      attachments = [];
      syncAttachments();
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
  if (attachBtnEl) {
    const label = t("hudQuickAttachFile");
    if (attachBtnEl.getAttribute("aria-label") !== label) {
      attachBtnEl.setAttribute("aria-label", label);
      attachBtnEl.title = label;
    }
  }
  updateStatusRow();
  updateSessionList();
  // ✕ 的提示语按语言重画一遍（不重建输入框，焦点与草稿都不动）
  renderAttachments();
}

function buildPanel() {
  if (!hudEl) return;
  const card = document.createElement("div");
  card.className = "quick-card";
  cardEl = card;
  card.appendChild(createStatusRow());
  card.appendChild(createSessionList());
  // 附件标签行在输入框上面、列表下面：挂着的文件紧挨着你要打的那句话
  card.appendChild(createAttachRow());
  card.appendChild(createInputRow());
  hudEl.appendChild(card);
}

async function init() {
  // 先把 DOM 搭出来，文案等 i18n 到了再填
  buildPanel();
  // 面板这一份脚本是全新的（窗口重建时），附件自然是 0：主动报一次，
  // 免得主进程还留着上次的数字——那会让卡片一直偏高、面板再也不自动收起。
  syncAttachments();

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
