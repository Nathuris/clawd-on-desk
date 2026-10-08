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
let statusDotEl = null;
let settingsBtnEl = null;
// 设置菜单里那几个控件的引用：状态一变就地打补丁，不重建 DOM——滑块拖到一半
// 被重建的话，指针下面的把手就没了，拖一下就断。
let settingsMenuEls = null;
let targetBtnEl = null;
let sessionListEl = null;
// 会话菜单里的两个壳：上面是可滚动的列表，下面是钉在底部不滚的两行。
let sessionScrollEl = null;
let sessionFooterEl = null;
// 上一次画进滚动区的内容签名：状态变了但列表内容没变就不重建 DOM，
// 否则每来一次会话状态更新都会把滚动位置顶回顶部（还会闪一下）。
let sessionScrollSignature = null;
let promptInputEl = null;
let attachBtnEl = null;
let attachRowEl = null;
// 设置菜单最上面那行只读状态（终端里现在是什么），菜单重建时换新节点。
let liveLabelEl = null;
let liveValueEl = null;

// 挂在输入框上的附件（发送时跟着消息一起走）。路径不进输入框——一长串路径
// 挤在里面就没法打字了，所以在这儿存着，界面上只显示文件名。
// 只有这份状态在渲染端：主进程只要一个数字（几个附件）来决定卡片多高。
const MAX_ATTACHMENTS = 4;
let attachments = [];
// 卡片节点 + 上一次上报的穿透状态：指针进出卡片时通知主进程切换
let cardEl = null;
// 菜单卡片（主卡片上面那张，开着才显示）
let menuCardEl = null;
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
    pinned: raw.pinned === true,
  };
}

// 一行历史会话。渲染端只需要展示要用的字段 + 一个不透明的 historyKey：
// 续跑时把它原样递回主进程，别的什么都不用（也不该）带。
function normalizeHistoryRow(raw) {
  if (!raw || typeof raw !== "object" || !raw.historyKey) return null;
  return {
    historyKey: String(raw.historyKey),
    agentId: typeof raw.agentId === "string" && raw.agentId ? raw.agentId : null,
    title: typeof raw.title === "string" && raw.title ? raw.title : null,
    folder: typeof raw.folder === "string" && raw.folder ? raw.folder : null,
    sessionTag: typeof raw.sessionTag === "string" && raw.sessionTag ? raw.sessionTag : null,
    lastEventAt: Number.isFinite(raw.lastEventAt) ? raw.lastEventAt : null,
    interrupted: raw.interrupted === true,
    // true 有记录 / false 确认没了 / null 说不准——三种分开，别把"拿不准"说成"没了"
    transcriptPresent: raw.transcriptPresent === true
      ? true
      : (raw.transcriptPresent === false ? false : null),
    resumeDisabledReason: typeof raw.resumeDisabledReason === "string" && raw.resumeDisabledReason
      ? raw.resumeDisabledReason
      : null,
    group: raw.group === "other" ? "other" : "confirmed",
    resumePending: raw.resumePending === true,
    pinned: raw.pinned === true,
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
    // 「最近」那一组：已经结束、但还能重新拉起来接着聊的会话
    history: Array.isArray(s.history) ? s.history.map(normalizeHistoryRow).filter(Boolean) : [],
    historyTruncated: Number.isFinite(s.historyTruncated) && s.historyTruncated > 0
      ? Math.floor(s.historyTruncated)
      : 0,
    // 置顶的那几条（活着的在前、历史的在后），主进程已经从下面两个数组里剔掉了。
    // kind 决定点它是"选中"还是"续跑"——这两件事绝不能混。
    // 每条都要把 kind 留下——渲染端靠它分辨「点一下是选中」还是「点一下是续跑」。
    // 丢了的话历史会话会被当成活着的会话画出来（没有身份的行，点什么都没反应）。
    // 置顶组里的每一条按定义都是钉着的，所以 pinned 一律补成 true。
    pinnedItems: Array.isArray(s.pinnedItems)
      ? s.pinnedItems
        .map((raw) => {
          if (!raw || typeof raw !== "object") return null;
          const isHistory = raw.kind === "history";
          const item = isHistory ? normalizeHistoryRow(raw) : normalizeSession(raw);
          return item ? { ...item, kind: isHistory ? "history" : "session", pinned: true } : null;
        })
        .filter(Boolean)
      : [],
    canCreateSession: s.canCreateSession === true,
    // 新建会话落在哪个文件夹：主进程给「显示用短路径」和「最后一段目录名」两份。
    newSessionFolder: typeof s.newSessionFolder === "string" && s.newSessionFolder ? s.newSessionFolder : null,
    newSessionFolderName: typeof s.newSessionFolderName === "string" && s.newSessionFolderName
      ? s.newSessionFolderName
      : null,
    // 新建会话的两个开关（主进程是唯一状态源，取不到就都算没选，不画高亮）。
    permissionMode: typeof s.permissionMode === "string" && s.permissionMode ? s.permissionMode : "",
    effort: typeof s.effort === "string" && s.effort ? s.effort : "",
    // 目标会话**自己现在的**模式与强度（终端里的真值）。取不到就是空串，
    // 界面上显示「未知」——绝不拿上面那两个"新会话档位"顶上。
    targetPermissionMode: typeof s.targetPermissionMode === "string" ? s.targetPermissionMode : "",
    targetEffort: typeof s.targetEffort === "string" ? s.targetEffort : "",
    // 排好的新会话占位（列表第一行）。
    pendingId: typeof s.pendingId === "string" && s.pendingId ? s.pendingId : null,
    pendingLaunched: s.pendingLaunched === true,
    targetPending: s.targetPending === true,
    menuOpen: s.menuOpen === "session" || s.menuOpen === "settings" ? s.menuOpen : null,
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

// 状态圆点：绿=在跑、灰=空闲、蓝=新会话在启动；临时提示时退回灰，别抢注意力。
function updateStatusDot() {
  if (!statusDotEl) return;
  let mode = "idle";
  if (!quickFeedback) {
    if (quickState.targetPending) mode = "pending";
    else if (quickState.targetState
      && quickState.targetState !== "idle"
      && quickState.targetState !== "sleeping") mode = "working";
  }
  for (const cls of ["is-working", "is-pending"]) {
    if (statusDotEl.classList.contains(cls) !== (mode === cls.slice(3))) {
      statusDotEl.classList.toggle(cls, mode === cls.slice(3));
    }
  }
}

// 状态行只在内容/样式真的变了才动，避免无谓重排
function updateStatusRow() {
  if (!statusTextEl || !i18nReady) return;
  const text = quickStatusText();
  if (statusTextEl.textContent !== text) statusTextEl.textContent = text;
  if (statusTextEl.classList.contains("is-error") !== quickFeedbackIsError) {
    statusTextEl.classList.toggle("is-error", quickFeedbackIsError);
  }
  updateStatusDot();
  if (document.body) {
    document.body.classList.toggle("session-menu-open", quickState.menuOpen === "session");
    document.body.classList.toggle("settings-menu-open", quickState.menuOpen === "settings");
  }
  if (targetBtnEl) {
    const label = t("hudQuickTargetLabel");
    if (targetBtnEl.getAttribute("aria-label") !== label) {
      targetBtnEl.setAttribute("aria-label", label);
      targetBtnEl.title = label;
    }
    targetBtnEl.setAttribute("aria-expanded", quickState.menuOpen === "session" ? "true" : "false");
  }
  if (settingsBtnEl) {
    const label = t("hudQuickSettingsLabel");
    if (settingsBtnEl.getAttribute("aria-label") !== label) {
      settingsBtnEl.setAttribute("aria-label", label);
      settingsBtnEl.title = label;
    }
    settingsBtnEl.classList.toggle("is-open", quickState.menuOpen === "settings");
    settingsBtnEl.setAttribute("aria-expanded", quickState.menuOpen === "settings" ? "true" : "false");
  }
}

// 菜单只在展开时重建（收起时不碰 DOM，省掉无谓重排）。
// 设置菜单已经画着的时候不重建，只打补丁——滑块拖到一半重建会把它从指针底下抽走。
function updateMenu() {
  if (!sessionListEl) return;
  if (!quickState.menuOpen) {
    settingsMenuEls = null;
    liveLabelEl = null;
    liveValueEl = null;
    sessionScrollSignature = null;
    // 续跑状态跟着菜单这一轮走：菜单一收就清掉。不然十分钟后重开菜单，那行字
    // 还停在"已提交"上——真相在主进程那边（它会说这条到底活了没有）。
    historyActionState.clear();
    clearHistoryRefreshTimer();
    if (sessionListEl.children.length) sessionListEl.replaceChildren();
    return;
  }
  if (quickState.menuOpen === "settings" && settingsMenuEls) {
    patchSettingsMenu();
    return;
  }
  settingsMenuEls = null;
  renderMenu();
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
  targetBtnEl = document.createElement("button");
  targetBtnEl.type = "button";
  targetBtnEl.className = "quick-target-btn";
  // 状态圆点在文字前面：绿=在跑、灰=空闲、蓝=新会话在启动。
  statusDotEl = document.createElement("span");
  statusDotEl.className = "quick-status-dot";
  targetBtnEl.appendChild(statusDotEl);
  statusTextEl = document.createElement("span");
  statusTextEl.className = "quick-status-text";
  targetBtnEl.appendChild(statusTextEl);
  const caret = document.createElement("span");
  caret.className = "quick-target-caret";
  caret.textContent = "⌄";
  targetBtnEl.appendChild(caret);
  targetBtnEl.addEventListener("click", () => handleToggleMenu("session"));
  statusRow.appendChild(targetBtnEl);

  return statusRow;
}

// 两个菜单共用这个容器：点状态行开会话菜单，点齿轮开设置菜单。
// 列表区现在能滚，看得见几条由 CSS 的滚动区高度说了算，这里只兜一个安全上限
// （面板就这么大，真给几百条也没意义，渲染还慢）。
const SESSION_RENDER_LIMIT = 20;

// 两个开关的可选项。值必须和 src/session-new-options.js 的允许列表一致——
// 主进程只认那几个值，写错了会被打回默认档。
const PERMISSION_OPTIONS = [
  { value: "auto", labelKey: "hudQuickPermissionAuto", descKey: "hudQuickPermissionAutoDesc" },
  { value: "manual", labelKey: "hudQuickPermissionManual", descKey: "hudQuickPermissionManualDesc" },
  { value: "acceptEdits", labelKey: "hudQuickPermissionEdits", descKey: "hudQuickPermissionEditsDesc" },
  { value: "plan", labelKey: "hudQuickPermissionPlan", descKey: "hudQuickPermissionPlanDesc" },
];
const EFFORT_OPTIONS = [
  { value: "low", labelKey: "hudQuickEffortLow" },
  { value: "medium", labelKey: "hudQuickEffortMedium" },
  { value: "high", labelKey: "hudQuickEffortHigh" },
  { value: "xhigh", labelKey: "hudQuickEffortXHigh" },
  { value: "max", labelKey: "hudQuickEffortMax" },
];

// 终端里**真实**的模式名 → 面板上的字。CLI 内部把"每步都问"叫 default，
// 命令行参数写作 manual，两个都归到「手动」。面板自己那 4 档之外的
// （不问 / 跳过确认）也要如实显示——显示成别的档比显示"未知"更糟。
const LIVE_MODE_LABEL_KEYS = {
  default: "hudQuickPermissionManual",
  manual: "hudQuickPermissionManual",
  acceptEdits: "hudQuickPermissionEdits",
  plan: "hudQuickPermissionPlan",
  auto: "hudQuickPermissionAuto",
  dontAsk: "hudQuickModeDontAsk",
  bypassPermissions: "hudQuickModeBypass",
};
const LIVE_EFFORT_LABEL_KEYS = {
  low: "hudQuickEffortLow",
  medium: "hudQuickEffortMedium",
  high: "hudQuickEffortHigh",
  xhigh: "hudQuickEffortXHigh",
  max: "hudQuickEffortMax",
};

// 「终端里：计划 · 高」这一行读什么：目标是运行中的会话就读**会话自己上报的**
// 值（那才是终端里的真值）；目标是排队中的新会话，它还没跑起来，读新会话档位
// 就是它的真值。取不到一律显示「未知」——绝不拿另一份值顶上。
function liveStateParts() {
  const isSession = !quickState.targetPending && !!quickState.targetId;
  const mode = isSession ? quickState.targetPermissionMode : quickState.permissionMode;
  const effort = isSession ? quickState.targetEffort : quickState.effort;
  return {
    labelKey: isSession ? "hudQuickLiveSessionLabel" : "hudQuickLivePendingLabel",
    mode: LIVE_MODE_LABEL_KEYS[mode] ? t(LIVE_MODE_LABEL_KEYS[mode]) : t("hudQuickLiveUnknown"),
    effort: LIVE_EFFORT_LABEL_KEYS[effort] ? t(LIVE_EFFORT_LABEL_KEYS[effort]) : t("hudQuickLiveUnknown"),
  };
}

// 设置菜单最上面那行只读状态。建好把两个节点记下来，之后背景变化只改文字。
function createLiveRow() {
  const row = document.createElement("div");
  row.className = "quick-live-row";
  liveLabelEl = document.createElement("span");
  liveLabelEl.className = "quick-live-label";
  liveValueEl = document.createElement("span");
  liveValueEl.className = "quick-live-value";
  row.appendChild(liveLabelEl);
  row.appendChild(liveValueEl);
  // 悬停提示：运行中的会话怎么改权限模式（面板不代劳）
  row.title = t("hudQuickLiveHint");
  refreshLiveRow();
  return row;
}

function refreshLiveRow() {
  if (!liveLabelEl || !liveValueEl) return;
  const parts = liveStateParts();
  const label = t(parts.labelKey);
  const value = `${parts.mode} · ${parts.effort}`;
  if (liveLabelEl.textContent !== label) liveLabelEl.textContent = label;
  if (liveValueEl.textContent !== value) liveValueEl.textContent = value;
}

function createSessionList() {
  sessionListEl = document.createElement("div");
  sessionListEl.className = "quick-session-list";
  ensureSessionShells();
  return sessionListEl;
}

// 会话菜单的两个壳：上面是可滚动的列表，下面是钉在底部不滚的「新建 / 选文件夹」。
// 设置菜单会把 sessionListEl 的内容整个换掉（replaceChildren），所以每次画会话
// 菜单之前先确认这两个壳还在，不在就重建（重建时上一次的内容签名作废）。
function ensureSessionShells() {
  if (sessionScrollEl && sessionScrollEl.parentNode === sessionListEl) return;
  sessionScrollSignature = null;
  sessionScrollEl = document.createElement("div");
  sessionScrollEl.className = "quick-session-scroll";
  // 滚动容器自己不参与 Tab：否则 Esc 收起菜单、方向键都会先被它吃掉。
  sessionScrollEl.tabIndex = -1;
  sessionFooterEl = document.createElement("div");
  sessionFooterEl.className = "quick-session-footer";
  sessionListEl.replaceChildren(sessionScrollEl, sessionFooterEl);
}

// 一条会话行。外面套一层 .quick-session-row：整行可点的按钮 +（之后）右边并排的
// 置顶按钮。置顶按钮不能嵌进按钮里，所以壳是必需的。
function createSessionRow(item) {
  const wrap = document.createElement("div");
  wrap.className = "quick-session-row";

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
  wrap.appendChild(row);
  wrap.appendChild(createSessionPinButton("session", item.id, item.pinned));
  return wrap;
}

// 📌 按钮。它必须是整行按钮的**兄弟节点**——按钮套按钮既是非法结构，点它也会
// 连着触发整行的点击。点了只置顶/取消置顶：不选中、不收菜单、不碰输入框。
function createSessionPinButton(kind, ref, pinned) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "quick-session-pin";
  if (pinned) button.classList.add("is-pinned");
  const label = t(pinned ? "hudSessionUnpin" : "hudSessionPin");
  button.setAttribute("aria-label", label);
  button.title = label;
  button.setAttribute("data-pin-kind", kind);
  button.textContent = "📌";
  button.addEventListener("click", () => handleTogglePin(kind, ref, pinned));
  return button;
}

// 置顶 / 取消置顶。只递"我点的是哪一行"（一个 action id 或一个不透明的
// historyKey），身份由主进程回查。置顶没有任何运行副作用。
async function handleTogglePin(kind, ref, pinned) {
  const payload = kind === "session"
    ? { target: { kind: "session", sessionId: ref }, pinned: !pinned }
    : { target: { kind: "history", agentId: ref.agentId, historyKey: ref.historyKey }, pinned: !pinned };
  let result = null;
  try {
    result = await window.sessionHudAPI.setSessionPin(payload);
  } catch {
    result = null;
  }
  if (!result || result.status !== "ok") showQuickFeedback(t("hudSessionPinFailed"), true);
}

/* ===== 「最近」那一组：历史会话（点一下 = 重新拉起来接着聊） =====
   这不是"往那儿发消息"——那个会话根本没在跑。所以这一组里的一行永远不会变成
   发送目标（主进程那边也有第二道闸：选中一个不在实时快照里的 id 会被拒）。 */

// 续跑的状态机。挂在 Map 上、不挂在 DOM 上：列表一推新状态就整个重建，
// 挂在节点上的状态会被冲掉，用户就会看到按钮"自己又活了"。
const historyActionState = new Map(); // historyKey -> { status, reason, retryAt }

// 主进程给的确认窗口（它自己也是这个时长）。过了这个点还没等到会话上报，
// 就不能再挂着"已提交"了——那是骗人：得如实说"还没等到"，并且让用户能再点一次。
const HISTORY_SUBMIT_TIMEOUT_MS = 30000;
let historyRefreshTimer = null;

function submittedExpired(state) {
  if (!state || state.status !== "submitted") return false;
  const at = Number.isFinite(state.retryAt) ? state.retryAt : 0;
  return Date.now() >= at;
}

function clearHistoryRefreshTimer() {
  if (historyRefreshTimer) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = null;
  }
}

// 到点了重画一次，把"已提交"换成"还没等到"。不重画的话那行字会一直挂着不动。
function scheduleHistoryRefresh(retryAt) {
  clearHistoryRefreshTimer();
  if (!Number.isFinite(retryAt)) return;
  const delay = Math.max(0, retryAt - Date.now()) + 200;
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null;
    repaintSessionMenu();
  }, delay);
}

// 主进程回来的失败原因是分开的，别糅成一句"失败了"——用户得知道能不能再试。
const RESUME_ERROR_KEYS = {
  unresolvable: "hudHistoryUnresolvable",
  "agent-unavailable": "hudHistoryAgentUnavailable",
  busy: "hudHistoryBusy",
  "already-running": "hudHistoryAlreadyRunning",
};

function resumeStateText(state) {
  if (!state) return "";
  if (state.status === "pending") return t("hudHistoryResuming");
  if (state.status === "submitted") {
    return t(submittedExpired(state) ? "hudHistoryNotConfirmed" : "hudHistorySubmitted");
  }
  return t(RESUME_ERROR_KEYS[state.reason] || "hudHistoryResumeFailed");
}

// 这一行现在是不是"正忙着"（要禁用）。超时之后的"已提交"不算忙——用户可以再点。
function historyRowBusy(row) {
  const local = historyActionState.get(row.historyKey);
  if (local && local.status === "pending") return true;
  if (local && local.status === "submitted") return !submittedExpired(local);
  return row.resumePending === true;
}

// 这一行现在该显示什么状态词。有本地动作状态就优先显示它（正在拉起/已提交/失败），
// 否则显示它本来的样子（已结束 / 已中断 / 不能续跑的原因）。
function historyStatusText(row) {
  const local = resumeStateText(historyActionState.get(row.historyKey));
  if (local) return local;
  if (row.resumeDisabledReason === "profile-unverified") return t("hudHistoryDisabledProfile");
  // 主进程说这条正在续跑中（比如 Dashboard 那边刚点的）
  if (row.resumePending) return t("hudHistorySubmitted");
  return t(row.interrupted ? "hudHistoryInterrupted" : "hudHistoryEnded");
}

function historyMetaText(row) {
  const when = row.lastEventAt ? formatElapsed(Date.now() - row.lastEventAt) : "";
  // 拿不准（null）和确认没了（false）分开说：把"说不准"说成"没了"是撒谎。
  const transcript = row.transcriptPresent === false
    ? t("hudHistoryTranscriptMissing")
    : (row.transcriptPresent === null ? t("hudHistoryTranscriptUnknown") : "");
  return [row.folder, historyStatusText(row), when, transcript].filter(Boolean).join(" · ");
}

function createHistoryDivider() {
  const divider = document.createElement("div");
  divider.className = "quick-session-divider";
  const label = document.createElement("span");
  label.textContent = t("hudHistorySection");
  divider.appendChild(label);
  return divider;
}

function createHistoryMore(count) {
  const more = document.createElement("div");
  more.className = "quick-session-more";
  more.textContent = t("hudHistoryMore").replace("{n}", count);
  return more;
}

// 一行历史会话：整行可点的按钮。永远不带 .is-active（那是"消息会发到这里"的
// 唯一标记），点了是续跑，不是选中。
function createHistoryRow(row) {
  const wrap = document.createElement("div");
  wrap.className = "quick-session-row";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "quick-session-item quick-session-history";
  button.setAttribute("data-history-key", row.historyKey);
  const disabled = !!row.resumeDisabledReason;
  const busy = historyRowBusy(row);
  if (disabled || busy) {
    button.disabled = true;
    button.classList.add("is-disabled");
  }

  const nameEl = document.createElement("span");
  nameEl.className = "quick-session-name";
  nameEl.textContent = row.title || row.sessionTag || row.historyKey;
  button.appendChild(nameEl);

  const metaEl = document.createElement("span");
  metaEl.className = "quick-session-meta";
  metaEl.textContent = historyMetaText(row);
  button.appendChild(metaEl);

  if (!disabled && !busy) button.addEventListener("click", () => handleResumeHistoryRow(row));
  wrap.appendChild(button);
  // 续跑不了的历史会话照样能置顶——置顶只是排序，跟能不能拉起来没关系
  wrap.appendChild(createSessionPinButton("history", { agentId: row.agentId, historyKey: row.historyKey }, row.pinned));
  return wrap;
}

// 点一条历史会话 = 请主进程把那个会话重新拉起来。状态先本地置位（按钮立刻变灰，
// 免得连点两下开出两个进程），再按主进程的回复落到 submitted 或 error。
async function handleResumeHistoryRow(row) {
  if (row.resumeDisabledReason) return;
  // 正在拉起的、以及还在等上报的，就别重复发请求；但"等上报"过了确认窗之后
  // 要放行——用户得能再试一次。
  const current = historyActionState.get(row.historyKey);
  if (current && current.status === "pending") return;
  if (current && current.status === "submitted" && !submittedExpired(current)) return;
  historyActionState.set(row.historyKey, { status: "pending" });
  repaintSessionMenu();
  let result = null;
  try {
    result = await window.sessionHudAPI.resumeSession({
      agentId: row.agentId,
      historyKey: row.historyKey,
    });
  } catch {
    result = { status: "error", reason: "launch-failed" };
  }
  const status = result && result.status;
  if (status === "submitted") {
    const retryAt = Number.isFinite(result && result.retryAt)
      ? result.retryAt
      : Date.now() + HISTORY_SUBMIT_TIMEOUT_MS;
    historyActionState.set(row.historyKey, { status: "submitted", retryAt });
    scheduleHistoryRefresh(retryAt);
  } else if (status === "already-running") {
    // 它其实已经在跑了：从这一组里拿掉，等主进程下一次推送就会出现在上面
    historyActionState.delete(row.historyKey);
    showQuickFeedback(t("hudHistoryAlreadyRunning"), false);
  } else {
    historyActionState.set(row.historyKey, {
      status: "error",
      reason: (result && result.reason) || "launch-failed",
    });
  }
  repaintSessionMenu();
}

// 菜单还开着才重画（关着的时候列表是空的，重画只会白建节点）。
function repaintSessionMenu() {
  if (quickState.menuOpen === "session") renderSessionMenu();
}

// 按开的是哪个菜单画对应内容。
function renderMenu() {
  if (!sessionListEl || !i18nReady) return;
  if (quickState.menuOpen === "settings") renderSettingsMenu();
  else renderSessionMenu();
}

// 状态变了但不是第一次画这个菜单：只改样式与取值，不换节点（见 settingsMenuEls）。
function patchSettingsMenu() {
  const els = settingsMenuEls;
  if (!els) return;
  // 开着菜单时终端里换了模式/强度 -> 这行字跟着变（它读的是会话上报的真值）
  refreshLiveRow();
  for (const [value, item] of els.items) {
    if (item.classList.contains("is-selected") !== (quickState.permissionMode === value)) {
      item.classList.toggle("is-selected", quickState.permissionMode === value);
    }
  }
  const index = Math.max(0, EFFORT_OPTIONS.findIndex((item) => item.value === quickState.effort));
  const next = String(index);
  if (els.slider.value !== next) els.slider.value = next;
  const label = chipLabel(EFFORT_OPTIONS, quickState.effort) || "—";
  if (els.valueEl.textContent !== label) els.valueEl.textContent = label;
  // 语言换了时，刻度的文字也要跟着换
  EFFORT_OPTIONS.forEach((option, i) => {
    const tick = els.ticks[i];
    if (tick) {
      const text = t(option.labelKey);
      if (tick.textContent !== text) tick.textContent = text;
    }
  });
}

// 会话菜单：滚动区（排好的新会话 + 会话列表）+ 底部固定的新建 / 选文件夹。
function renderSessionMenu() {
  ensureSessionShells();
  // 列表能滚了，排好的新会话（占位行）不再需要挤掉一条会话——它只是排在最上面。
  const items = quickState.sessions.slice(0, SESSION_RENDER_LIMIT);
  const nodes = [];
  // 置顶的那几条排最前面（主进程已经按"先活着的、再历史的"排好，
  // 组内按钉的时间倒序）。它们已经从下面两个数组里剔掉了，不会画两遍。
  for (const item of quickState.pinnedItems) {
    nodes.push(item.kind === "history" ? createHistoryRow(item) : createSessionRow(item));
  }
  if (quickState.pendingId) nodes.push(createPendingRow());
  for (const item of items) nodes.push(createSessionRow(item));

  // 「最近」那一组：已经结束、但还能重新拉起来接着聊的会话。分隔线一直在——
  // 这一组里的一行不是发送目标，界线得看得出来。
  if (quickState.history.length) {
    nodes.push(createHistoryDivider());
    for (const row of quickState.history) nodes.push(createHistoryRow(row));
    if (quickState.historyTruncated > 0) nodes.push(createHistoryMore(quickState.historyTruncated));
  }

  // 滚动区只在内容真的变了才重建。会话状态每变一次主进程都会推一份新投影，
  // 每次都重建的话滚动位置会被顶回顶部、还会闪一下。
  const signature = JSON.stringify([
    i18nPayload.lang, quickState.pendingId, quickState.targetPending, items,
    quickState.pinnedItems, quickState.history, quickState.historyTruncated,
    [...historyActionState],
  ]);
  if (signature !== sessionScrollSignature) {
    const scrollTop = sessionScrollEl.scrollTop;
    sessionScrollEl.replaceChildren(...nodes);
    sessionScrollEl.scrollTop = scrollTop;
    sessionScrollSignature = signature;
  }

  const footerNodes = [];
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
    footerNodes.push(createRow);

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
    footerNodes.push(folderRow);
  }
  sessionFooterEl.replaceChildren(...footerNodes);
}

// 设置菜单：权限列表（大字名称 + 小字解释）+ 强度滑块。
// 建完把关键节点记下来，之后状态变化走 patchSettingsMenu 就地更新。
function renderSettingsMenu() {
  const items = new Map();
  const nodes = [createLiveRow()];
  for (const option of PERMISSION_OPTIONS) {
    const item = createPermissionItem(option);
    items.set(option.value, item);
    nodes.push(item);
  }
  const effort = createEffortBlock();
  nodes.push(effort.block);
  sessionListEl.replaceChildren(...nodes);
  settingsMenuEls = { items, slider: effort.slider, valueEl: effort.valueEl, ticks: effort.ticks };
}

// 权限列表项：上方大字模式名，下方小字解释；选中的高亮。
function createPermissionItem(option) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "quick-permission-item";
  if (quickState.permissionMode === option.value) item.classList.add("is-selected");
  item.setAttribute("data-permission", option.value);

  const nameEl = document.createElement("span");
  nameEl.className = "quick-permission-name";
  nameEl.textContent = t(option.labelKey);
  item.appendChild(nameEl);

  const descEl = document.createElement("span");
  descEl.className = "quick-permission-desc";
  descEl.textContent = t(option.descKey);
  item.appendChild(descEl);

  item.addEventListener("click", () => handleSettingPick("permissionMode", option.value));
  return item;
}

// 强度块：标签 + 5 档滑块 + 两端刻度；拖动即切换（不重置会话，只是新会话的参数）。
// 拖动过程中把节点交回去，主进程推状态回来时由 patchSettingsMenu 就地更新，
// 不重建——所以能一直拖着走，不会滑一下就断。
function createEffortBlock() {
  const block = document.createElement("div");
  block.className = "quick-effort-block";

  const head = document.createElement("div");
  head.className = "quick-effort-head";
  const label = document.createElement("span");
  label.className = "quick-effort-label";
  label.textContent = t("hudQuickEffortLabel");
  head.appendChild(label);
  const valueEl = document.createElement("span");
  valueEl.className = "quick-effort-value";
  valueEl.textContent = chipLabel(EFFORT_OPTIONS, quickState.effort) || "—";
  head.appendChild(valueEl);
  block.appendChild(head);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "quick-effort-slider";
  slider.min = "0";
  slider.max = String(EFFORT_OPTIONS.length - 1);
  slider.step = "1";
  const currentIndex = Math.max(0, EFFORT_OPTIONS.findIndex((item) => item.value === quickState.effort));
  slider.value = String(currentIndex);
  slider.addEventListener("input", () => {
    const option = EFFORT_OPTIONS[Number(slider.value)];
    if (option) {
      valueEl.textContent = t(option.labelKey);
      // 拖动过程中只更新默认档位（便宜），不发控制命令——松手才发（见下面）
      handleSettingPick("effort", option.value);
    }
  });
  slider.addEventListener("change", () => {
    const option = EFFORT_OPTIONS[Number(slider.value)];
    if (option) handleApplyEffort(option.value);
  });
  block.appendChild(slider);

  const ticks = document.createElement("div");
  ticks.className = "quick-effort-ticks";
  const tickEls = [];
  for (const option of EFFORT_OPTIONS) {
    const tick = document.createElement("span");
    tick.textContent = t(option.labelKey);
    ticks.appendChild(tick);
    tickEls.push(tick);
  }
  block.appendChild(ticks);

  return { block, slider, valueEl, ticks: tickEls };
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

// 「新建会话」那一行的第二行小字：位置：<目录名> · 权限档 · 强度：<档>。
// 把当前两个开关也写在这儿——它们在设置菜单里改，不写出来的话用户点下去之前
// 没法确认自己开的是哪一档。
function sessionFolderLabel() {
  const name = quickState.newSessionFolderName || quickState.newSessionFolder;
  const parts = [];
  if (name) parts.push(t("hudQuickNewSessionAt").replace("{path}", name));
  const permission = chipLabel(PERMISSION_OPTIONS, quickState.permissionMode);
  if (permission) parts.push(permission);
  const effort = chipLabel(EFFORT_OPTIONS, quickState.effort);
  if (effort) parts.push(`${t("hudQuickEffortLabel")}：${effort}`);
  return parts.join(" · ");
}

// 认不出的值（主进程还没推过状态）什么都不写：宁可少一行字，也不要凭空造词。
function chipLabel(options, value) {
  const option = options.find((item) => item.value === value);
  return option ? t(option.labelKey) : "";
}

function sessionMetaText(item) {
  const quiet = item.state === "idle" || item.state === "sleeping";
  const state = item.state ? t(quiet ? "hudQuickStatusIdle" : "hudQuickStatusWorking") : "";
  return [item.folder, state].filter(Boolean).join(" · ");
}

// 「多久以前」——和 Dashboard 那份 formatElapsed 同一套文案，口径保持一致。
function formatElapsed(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 5) return t("sessionJustNow");
  if (sec < 60) return t("sessionHudElapsedSec").replace("{n}", sec);
  const min = Math.floor(sec / 60);
  if (min < 60) return t("sessionMinAgo").replace("{n}", min);
  return t("sessionHrAgo").replace("{n}", Math.floor(min / 60));
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

  // 输入框左边的「＋」：选文件（选中的会变成上面那行小标签）。放在左边，
  // 右边就只留一个齿轮，输入框不会被两个按钮夹得太窄。
  const attachBtn = document.createElement("button");
  attachBtn.type = "button";
  attachBtn.className = "quick-attach-btn";
  attachBtn.textContent = "+";
  attachBtn.addEventListener("click", handleAttachFile);
  inputRow.appendChild(attachBtn);
  attachBtnEl = attachBtn;

  inputRow.appendChild(promptInputEl);

  // 输入框右边的齿轮：点开「设置」菜单（权限 + 强度）。和「＋」一样是个方块
  // 按钮，只画齿轮不带字——两个字挤在这一行会把输入框压短。
  settingsBtnEl = document.createElement("button");
  settingsBtnEl.type = "button";
  settingsBtnEl.className = "quick-settings-btn";
  const gearIcon = document.createElement("span");
  gearIcon.className = "quick-settings-icon";
  gearIcon.textContent = "⚙";
  settingsBtnEl.appendChild(gearIcon);
  settingsBtnEl.addEventListener("click", () => handleToggleMenu("settings"));
  inputRow.appendChild(settingsBtnEl);

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

// 点状态行 / 点齿轮：开或关对应的菜单（再点一次同一个 = 收起，点另一个 = 切换）。
async function handleToggleMenu(menu) {
  try {
    const next = quickState.menuOpen === menu ? null : menu;
    await window.sessionHudAPI.setMenuOpen(next);
  } catch (err) {
    console.warn("set menu open threw:", err);
  }
}

async function handleSessionPick(sessionId) {
  try {
    await window.sessionHudAPI.selectSession(sessionId);
    // 选完就把菜单收起来（主进程会把新的展开状态推回来）
    await window.sessionHudAPI.setMenuOpen(null);
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

// 强度滑块**松手**时，把这个档位应用到当前目标：目标是正在跑的本地 Claude Code
// 会话时，主进程会往那个终端里送一条官方 /effort 命令（立刻就改）；目标是排队中
// 的新会话/没有会话时，主进程只记成默认档位，这种情况不弹提示（面板上那行
//「新会话：…」已经说明白了）。失败如实说，不装作改好了。
async function handleApplyEffort(level) {
  let result = null;
  try {
    result = await window.sessionHudAPI.applyEffort(level);
  } catch (err) {
    console.warn("apply effort threw:", err);
    showQuickFeedback(t("hudControlEffortFailed"), true);
    return;
  }
  const status = result && result.status;
  if (status === "sent") showQuickFeedback(t("hudControlEffortSent"));
  else if (status === "unsupported") showQuickFeedback(t("hudControlEffortUnsupported"), true);
  else if (status === "failed") showQuickFeedback(t("hudControlEffortFailed"), true);
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
    await window.sessionHudAPI.setMenuOpen(null);
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

// 指针是否落在某张卡片里（菜单卡片收起时 display:none，测得的是 0×0，自然为假）。
function inRect(el, event) {
  if (!el || typeof el.getBoundingClientRect !== "function") return false;
  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  return event.clientX >= rect.left && event.clientX <= rect.right
    && event.clientY >= rect.top && event.clientY <= rect.bottom;
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
  updateMenu();
  // ✕ 的提示语按语言重画一遍（不重建输入框，焦点与草稿都不动）
  renderAttachments();
}

function buildPanel() {
  if (!hudEl) return;
  // 菜单是主卡片上面另起的**一张卡片**（开着才淡入出现），主卡片高度不变。
  menuCardEl = document.createElement("div");
  menuCardEl.className = "quick-menu-card";
  menuCardEl.appendChild(createSessionList());
  hudEl.appendChild(menuCardEl);

  const card = document.createElement("div");
  card.className = "quick-card";
  cardEl = card;
  card.appendChild(createStatusRow());
  // 附件标签行在输入框上面：挂着的文件紧挨着你要打的那句话
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
    updateMenu();
  });
  // 指针进出卡片：两张卡片之外的透明区放行点击（窗口比卡片高的那截），
  // 别挡住底下应用的点击。主进程的轮询另有兜底。
  document.addEventListener("mousemove", (event) => {
    if (!cardEl) return;
    const inside = inRect(cardEl, event) || inRect(menuCardEl, event);
    if (!inside === lastClickThrough) return;
    lastClickThrough = !inside;
    try {
      window.sessionHudAPI.setClickThrough(!inside);
    } catch (err) {
      console.warn("set click through threw:", err);
    }
  });

  // Esc 收起当前菜单（面板整体的收起仍走鼠标离开）
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !quickState.menuOpen) return;
    event.preventDefault();
    window.sessionHudAPI.setMenuOpen(null);
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
