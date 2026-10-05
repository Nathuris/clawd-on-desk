"use strict";

// ── 内置 Claude 对话窗口：主进程 IPC 注册器 ──
//
// 渲染端（chat.html）经 window.chatAPI 调用的 invoke 通道：
//   chat:get-state            取当前完整状态快照
//   chat:send                 发送一条用户消息
//   chat:stop                 停止当前进行中的会话
//   chat:new-session          丢弃当前会话，开一个新会话
//   chat:pick-working-dir     弹目录选择框，记住选择并切换工作目录
//   chat:set-effort           切换 effort 档位（在 runtime 内触发开新会话）
//   chat:set-permission-mode  切换权限模式（中途生效）
//   chat:list-history         当前工作目录下可续聊的历史会话（阶段二）
//   chat:resume-session       按 historyKey 恢复某个历史会话并回填消息（阶段二）
//   chat:pick-attachments     弹文件选择框（多选），返回附件元数据（图片带小图预览）
//   chat:save-pasted-image    把渲染端粘贴的图片 data URL 落成临时文件并登记为附件
//   chat:open-external        仅限 http(s)：用系统默认浏览器打开外链
//   chat:list-commands        当前会话可用的斜杠指令列表（无会话时为空数组）
//   chat:register-dropped-paths 把拖拽进窗口的文件路径并入已授权集合
// 权限确认不走本窗口：由 Claude Code 的 PermissionRequest hook 打到应用自己的
// /permission 路由，经桌宠气泡完成（见 server-route-permission.js）。
//
// 附件（阶段三）：chat:pick-attachments、chat:register-dropped-paths 与
// chat:save-pasted-image 把用户操作产生的绝对路径登记进闭包内的已授权集合；
// chat:send 只接受集合内、存在且 ≤20MB 的文件，任一不满足整个请求拒绝。
// 这是纵深防御，不是安全边界——三个入口都由用户操作触发。读文件在本文件完成：
// 图片 / PDF 转 base64 block，小体量疑似文本内联，其余给路径提示让模型按需用工具读取。
//
// 历史列表 / 续聊依赖三个注入缝（缺省时安全降级，见各处理器）：
//   loadHistory(options) -> rows[]   读历史存储（main.js 接 session-history-loader）
//   resolveResumeTarget(agentId, historyKey) -> target|null
//                                    按 historyKey 从存储反查可信记录（渲染端无权传 cwd/sessionId）
//   loadBackfill(sessionId) -> 回填消息
//                                    恢复前读记录文件尾部（随 resumeSession 参数转交 runtime）
//
// 主进程 → 渲染端只有一个 push 通道：
//   chat:update               载荷 = 完整状态快照 + 当前语言 lang
// （每次变化都推全量，简单可靠；不要改成增量。）
//
// 信任校验与 settings-ipc.js 的 isTrustedSettingsEvent 同构：只接受来自
// chat 窗口 webContents、主 frame、且 frame.url 精确等于 chat 页面 URL 的
// 事件；窗口不存在、已销毁、sender 不符、子 frame 一律拒绝。

const defaultPath = require("path");
const defaultFs = require("fs");
const { URL, pathToFileURL } = require("url");

const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];
const PERMISSION_MODE_VALUES = ["default", "acceptEdits", "plan", "auto"];
// 防御性上限：单条用户消息最多 10 万字符，避免异常渲染端塞爆内存。
const MAX_SEND_LENGTH = 100000;
// 历史会话列表一次最多回传 25 条（与 Dashboard 的默认上限一致）。
const HISTORY_LIMIT = 25;
// historyKey 是历史存储发的 32 位十六进制不透明键（与 session-history-loader 同一规则）。
const HISTORY_KEY_PATTERN = /^[a-f0-9]{32}$/;
// 附件（阶段三）：单文件硬上限 20MB（超出整个请求拒绝）；图片预览阈值 4MB；
// 疑似文本内联阈值 200KB（超过就只给路径提示，不把大文件塞进消息）。
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 200 * 1024;
const IMAGE_MEDIA_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
// 粘贴图片（chat:save-pasted-image）：只接受这四种图片 data URL，解码后 ≤8MB；
// 落盘文件名 clawd-chat-paste-<时间戳>.<按媒体类型映射的扩展名>。
const PASTED_IMAGE_DATA_URL_PATTERN = /^data:image\/(png|jpeg|gif|webp);base64,/i;
const PASTED_IMAGE_EXTENSIONS = { png: ".png", jpeg: ".jpg", gif: ".gif", webp: ".webp" };
const MAX_PASTED_IMAGE_BYTES = 8 * 1024 * 1024;
// dataUrl 的廉价长度闸门：base64 体积约为解码后的 4/3，超长字符串直接判非法，
// 避免先解码再拒绝造成的大内存分配（留 4KB 余量给前缀与空白字符）。
const MAX_PASTED_IMAGE_DATA_URL_LENGTH = Math.ceil(MAX_PASTED_IMAGE_BYTES / 3) * 4 + 4096;
// 疑似文本的扩展名（无扩展名也算，见 isTextLikeAttachmentPath）。
const TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".py", ".csv", ".log", ".yml", ".yaml", ".sh",
]);

// 弹窗文案（目录选择 / 选择附件；7 语言，与 i18n.js / chat-i18n.js 的语言集合保持一致）。
// 未注入 getLang 时回退简体中文：本 fork 的产品文案以中文为准。
const CHAT_DIALOG_STRINGS = {
  zh: { pickDirTitle: "选择工作目录", pickAttachmentsTitle: "选择附件" },
  en: { pickDirTitle: "Choose a working folder", pickAttachmentsTitle: "Choose attachments" },
  "zh-TW": { pickDirTitle: "選擇工作目錄", pickAttachmentsTitle: "選擇附件" },
  ko: { pickDirTitle: "작업 폴더 선택", pickAttachmentsTitle: "첨부 파일 선택" },
  ja: { pickDirTitle: "作業フォルダーを選択", pickAttachmentsTitle: "添付ファイルを選択" },
  "pt-BR": { pickDirTitle: "Escolha uma pasta de trabalho", pickAttachmentsTitle: "Escolher anexos" },
  es: { pickDirTitle: "Elige una carpeta de trabajo", pickAttachmentsTitle: "Elegir archivos adjuntos" },
};

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function requiredDependency(value, name) {
  if (!value) throw new Error(`registerChatIpc requires ${name}`);
  return value;
}

function isWindowUsable(win) {
  return !!win && !(typeof win.isDestroyed === "function" && win.isDestroyed());
}

// Electron 内置模块兜底：优先用注入的实现（main.js 与测试都走注入），
// 没注入时回退 require("electron")。纯 Node 环境（部分测试）里 require("electron")
// 得到的是可执行文件路径字符串，取不到成员就返回 null，由各处理器安全降级。
function electronModuleFallback(name) {
  try {
    const electron = require("electron");
    return electron && typeof electron === "object" ? electron[name] || null : null;
  } catch {
    return null;
  }
}

// 解析粘贴图片的 data URL：格式必须是 image/(png|jpeg|gif|webp) + base64，
// 解码后非空且 ≤8MB，否则返回 null（宁严勿松，非法一律整张拒绝）。
function parsePastedImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || dataUrl.length > MAX_PASTED_IMAGE_DATA_URL_LENGTH) {
    return null;
  }
  const match = PASTED_IMAGE_DATA_URL_PATTERN.exec(dataUrl);
  if (!match) return null;
  const base64 = dataUrl.slice(match[0].length).replace(/\s+/g, "");
  if (!base64) return null;
  let buffer = null;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (!buffer || buffer.length === 0 || buffer.length > MAX_PASTED_IMAGE_BYTES) return null;
  return { extension: PASTED_IMAGE_EXTENSIONS[match[1].toLowerCase()], buffer };
}

function registerChatIpc(options = {}) {
  const ipcMain = requiredDependency(options.ipcMain, "ipcMain");
  const chatRuntime = requiredDependency(options.chatRuntime, "chatRuntime");
  const settingsController = requiredDependency(options.settingsController, "settingsController");
  const dialog = requiredDependency(options.dialog, "dialog");
  const getChatWindow = typeof options.getChatWindow === "function"
    ? options.getChatWindow
    : () => null;
  // 当前语言：优先用 main.js 注入的 getLang（与 settings-ipc.js 一致）；
  // 没注入就照 Settings 的做法从 controller 读 prefs.lang，最后回退中文。
  const getLang = typeof options.getLang === "function"
    ? options.getLang
    : () => {
        try {
          const lang = typeof settingsController.get === "function"
            ? settingsController.get("lang")
            : null;
          return typeof lang === "string" && lang ? lang : "zh";
        } catch {
          return "zh";
        }
      };
  const path = options.path || defaultPath;
  // 读附件用 fs；main.js 显式注入（测试可注入假实现），缺省用 Node 内置。
  const fs = options.fs && options.fs.promises ? options.fs : defaultFs;
  // 粘贴图片落盘要 app.getPath("temp")；打开外链要 shell.openExternal。
  // 两者都优先用注入的实现，缺省回退 electron 内置模块（见 electronModuleFallback）。
  const app = options.app || electronModuleFallback("app");
  const shell = options.shell || electronModuleFallback("shell");
  // 已授权附件路径集合（本窗口）：chat:pick-attachments 与
  // chat:register-dropped-paths 写入，chat:send 校验。窗口销毁时不强求清理。
  const authorizedAttachmentPaths = new Set();
  const chatPageUrl = pathToFileURL(
    options.chatHtmlPath || path.join(__dirname, "chat.html"),
  ).href;
  // onPickDir：可选的目录选择替换实现（测试 / 自定义入口用），
  // 签名 async () => string | null（null 表示取消）。
  const pickDirOverride = typeof options.onPickDir === "function" ? options.onPickDir : null;
  // 阶段二（历史会话 / 续聊）的注入缝；缺省时对应通道安全降级：
  // 列表返回空、恢复返回「无法恢复该会话」。真实实现由 main.js 注入。
  const loadHistory = typeof options.loadHistory === "function" ? options.loadHistory : null;
  const resolveResumeTargetForChat = typeof options.resolveResumeTarget === "function"
    ? options.resolveResumeTarget
    : null;
  const loadBackfill = typeof options.loadBackfill === "function" ? options.loadBackfill : null;
  // 悬停面板排队器的清理钩子：用户点停止 / 换上下文（新会话、恢复、换目录）
  // 时由主进程同步清队，防止排队消息发进已变的上下文（见 main.js）。
  const onUserStop = typeof options.onUserStop === "function" ? options.onUserStop : null;
  const onContextReset = typeof options.onContextReset === "function" ? options.onContextReset : null;

  function notifyUserStop() {
    if (onUserStop) { try { onUserStop(); } catch {} }
  }

  function notifyContextReset(reason) {
    if (onContextReset) { try { onContextReset(reason); } catch {} }
  }
  const disposers = [];
  const watchedWebContents = new WeakSet();

  function handle(channel, listener) {
    ipcMain.handle(channel, listener);
    disposers.push(() => ipcMain.removeHandler(channel));
  }

  function isTrustedChatEvent(event) {
    const win = getChatWindow();
    if (!isWindowUsable(win)) return false;
    const contents = win.webContents;
    const frame = event && event.senderFrame;
    return !!contents
      && event.sender === contents
      && !!frame
      && frame === contents.mainFrame
      && frame.url === chatPageUrl;
  }

  function rejectUntrustedChatEvent(event) {
    return isTrustedChatEvent(event)
      ? null
      : { status: "error", message: "untrusted chat sender" };
  }

  // 当前完整状态快照 + lang。渲染端 chat-i18n 依赖该字段选语言。
  function currentState() {
    let state = null;
    try {
      state = typeof chatRuntime.getState === "function" ? chatRuntime.getState() : null;
    } catch (err) {
      console.warn("Clawd: chatRuntime.getState failed:", err && err.message);
    }
    return { ...(isPlainObject(state) ? state : {}), lang: getLang() };
  }

  function sendStateToWindow(payload) {
    const win = getChatWindow();
    if (!isWindowUsable(win)) return;
    const contents = win.webContents;
    if (!contents || (typeof contents.isDestroyed === "function" && contents.isDestroyed())) return;
    try {
      contents.send("chat:update", payload);
    } catch (err) {
      console.warn("Clawd: chat:update push failed:", err && err.message);
    }
  }

  // 状态推送入口：main.js 可把它接到 createChatSessionRuntime({ onUpdate })、
  // 或由 runtime 主动调用（若 runtime 暴露 onUpdate(cb) 注册接口，本文件也会自动挂上）。
  function pushUpdate(state) {
    const payload = isPlainObject(state) ? { ...state, lang: getLang() } : currentState();
    sendStateToWindow(payload);
  }

  function broadcastState() {
    pushUpdate(currentState());
  }

  // 用户动作完成后的统一回包：返回快照，并主动补推一次（即使 runtime 的
  // onUpdate 没接线，界面也能靠这次推送刷新）。重复推送是幂等的全量快照。
  function respondWithState() {
    const state = currentState();
    pushUpdate(state);
    return state;
  }

  async function applyRuntimeCall(methodName, ...args) {
    if (typeof chatRuntime[methodName] !== "function") return;
    try {
      await chatRuntime[methodName](...args);
    } catch (err) {
      // runtime / driver 约定把异常转成状态内 notice，这里只做兜底。
      console.warn(`Clawd: chatRuntime.${methodName} failed:`, err && err.message);
    }
  }

  // 内置对话当前占用的会话 id（正在聊的 + 正在启动的），历史列表要用它排除自己。
  function collectActiveSessionIds() {
    const ids = new Set();
    if (typeof chatRuntime.getActiveSessionIds !== "function") return ids;
    let listed = null;
    try {
      listed = chatRuntime.getActiveSessionIds();
    } catch (err) {
      console.warn("Clawd: chatRuntime.getActiveSessionIds failed:", err && err.message);
    }
    for (const id of Array.isArray(listed) ? listed : []) {
      if (typeof id === "string" && id) ids.add(id);
    }
    return ids;
  }

  // 当前工作目录；空目录（用户还没选文件夹）时历史列表为空。
  function currentChatCwd() {
    try {
      const state = typeof chatRuntime.getState === "function" ? chatRuntime.getState() : null;
      return state && typeof state.cwd === "string" && state.cwd ? state.cwd : null;
    } catch (err) {
      console.warn("Clawd: chatRuntime.getState failed:", err && err.message);
      return null;
    }
  }

  // ── 附件（阶段三）──

  function attachmentExtension(filePath) {
    return path.extname(typeof filePath === "string" ? filePath : "").toLowerCase();
  }

  function isImageAttachmentPath(filePath) {
    return Object.prototype.hasOwnProperty.call(IMAGE_MEDIA_TYPES, attachmentExtension(filePath));
  }

  // 疑似文本：登记的扩展名之一，或无扩展名（如 README / Makefile）。
  function isTextLikeAttachmentPath(filePath) {
    const ext = attachmentExtension(filePath);
    return ext === "" || TEXT_ATTACHMENT_EXTENSIONS.has(ext);
  }

  // 只接受常规文件（目录 / 符号链接指向的目录等一律视为不可用）；不存在会抛错。
  async function statAttachmentFile(filePath) {
    const stat = await fs.promises.stat(filePath);
    return stat && typeof stat.isFile === "function" && stat.isFile() ? stat : null;
  }

  // 文件选择框返回的单条附件元数据（图片 ≤4MB 时带 data URL 预览）。
  async function describePickedAttachment(filePath) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
    let stat = null;
    try {
      stat = await statAttachmentFile(filePath);
    } catch (err) {
      console.warn("Clawd: 读取附件信息失败:", err && err.message);
      return null;
    }
    if (!stat) return null;
    const ext = attachmentExtension(filePath);
    const entry = {
      path: filePath,
      name: path.basename(filePath),
      size: stat.size,
      isImage: Object.prototype.hasOwnProperty.call(IMAGE_MEDIA_TYPES, ext),
    };
    if (entry.isImage && stat.size <= MAX_PREVIEW_BYTES) {
      try {
        const buffer = await fs.promises.readFile(filePath);
        entry.preview = `data:${IMAGE_MEDIA_TYPES[ext]};base64,${buffer.toString("base64")}`;
      } catch (err) {
        // 预览读失败只丢预览，附件本身仍可用。
        console.warn("Clawd: 读取附件预览失败:", err && err.message);
      }
    }
    return entry;
  }

  // 按附件类型构建 Anthropic content block。读取失败会抛错，由 chat:send 转成
  // warning 并跳过该附件（不整体失败）。
  async function buildAttachmentBlock(item) {
    const ext = attachmentExtension(item.path);
    if (Object.prototype.hasOwnProperty.call(IMAGE_MEDIA_TYPES, ext)) {
      const buffer = await fs.promises.readFile(item.path);
      return {
        type: "image",
        source: { type: "base64", media_type: IMAGE_MEDIA_TYPES[ext], data: buffer.toString("base64") },
      };
    }
    if (ext === ".pdf") {
      const buffer = await fs.promises.readFile(item.path);
      return {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: buffer.toString("base64") },
      };
    }
    // 疑似文本且不超阈值：内容内联进消息，模型直接可读。
    if (isTextLikeAttachmentPath(item.path) && item.size <= MAX_INLINE_TEXT_BYTES) {
      const buffer = await fs.promises.readFile(item.path);
      return { type: "text", text: `【附件 ${item.name}】\n${buffer.toString("utf8")}` };
    }
    // 二进制或过大：不读内容，给路径提示，让模型按需用工具读取。
    return {
      type: "text",
      text: `【附件】${item.name}（路径：${item.path}，大小 ${item.size} 字节）——请按需用工具读取该文件。`,
    };
  }

  // ── invoke 通道 ──

  handle("chat:get-state", (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    return rejected || currentState();
  });

  // 文件选择框（图片 / 任意文件，多选）。选中路径立刻登记进已授权集合，
  // 之后 chat:send 才接受它们；取消返回 { status: "cancel" }。
  handle("chat:pick-attachments", async (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    const strings = CHAT_DIALOG_STRINGS[getLang()] || CHAT_DIALOG_STRINGS.zh;
    const parent = getChatWindow();
    const dialogOptions = {
      title: strings.pickAttachmentsTitle,
      properties: ["openFile", "multiSelections"],
    };
    let result;
    try {
      result = isWindowUsable(parent)
        ? await dialog.showOpenDialog(parent, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);
    } catch (err) {
      return { status: "error", message: `chat attachments dialog failed: ${err && err.message}` };
    }
    if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { status: "cancel" };
    }
    const files = [];
    for (const filePath of result.filePaths) {
      const entry = await describePickedAttachment(filePath);
      if (!entry) continue;
      authorizedAttachmentPaths.add(entry.path);
      files.push(entry);
    }
    return { status: "ok", files };
  });

  // 发送一条用户消息。载荷是新契约的 { text, attachments }；兼容旧版纯字符串与
  // (text, attachments) 位置参数。附件先过安全闸门（绝对路径 + 已授权集合 +
  // 存在 + ≤20MB，任一不满足整个请求拒绝），再逐个读文件构建 content blocks。
  handle("chat:send", async (event, payload, extraAttachments) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;

    let rawText = "";
    let rawAttachments = [];
    if (typeof payload === "string") {
      rawText = payload;
      if (Array.isArray(extraAttachments)) rawAttachments = extraAttachments;
    } else if (isPlainObject(payload)) {
      if (typeof payload.text === "string") rawText = payload.text;
      if (Array.isArray(payload.attachments)) rawAttachments = payload.attachments;
    }

    // 安全闸门（宁严勿松）：任一附件不合格，整个请求拒绝，不发送任何内容。
    const gated = [];
    for (const entry of rawAttachments) {
      const filePath = isPlainObject(entry) && typeof entry.path === "string" ? entry.path : null;
      if (!filePath || !path.isAbsolute(filePath) || !authorizedAttachmentPaths.has(filePath)) {
        return { status: "error", message: "attachment not allowed" };
      }
      let stat = null;
      try {
        stat = await statAttachmentFile(filePath);
      } catch (err) {
        console.warn("Clawd: 附件校验失败:", err && err.message);
        return { status: "error", message: "attachment not allowed" };
      }
      if (!stat || stat.size > MAX_ATTACHMENT_BYTES) {
        return { status: "error", message: "attachment not allowed" };
      }
      gated.push({
        path: filePath,
        name: isPlainObject(entry) && typeof entry.name === "string" && entry.name
          ? entry.name
          : path.basename(filePath),
        size: stat.size,
        raw: entry,
      });
    }

    const text = rawText.slice(0, MAX_SEND_LENGTH);
    if (!text.trim() && gated.length === 0) {
      return { status: "error", message: "empty message" };
    }

    // 构建阶段：单个附件读取失败只跳过它并记 warning，不整体失败。
    const blocks = [];
    const attachments = [];
    const warnings = [];
    for (const item of gated) {
      try {
        blocks.push(await buildAttachmentBlock(item));
        // 界面元数据（name / size / isImage / thumb 等）原样透传，供用户消息气泡渲染。
        attachments.push(item.raw);
      } catch (err) {
        warnings.push(`附件「${item.name}」读取失败，已跳过`);
        console.warn("Clawd: 附件读取失败，已跳过:", item.path, err && err.message);
      }
    }
    if (!text.trim() && blocks.length === 0) {
      return warnings.length
        ? { status: "error", message: "empty message", warnings }
        : { status: "error", message: "empty message" };
    }

    if (blocks.length) {
      await applyRuntimeCall("send", text, { blocks, attachments });
    } else {
      // 无附件：沿用旧签名，runtime 不必认识 options（新 runtime 也兼容）。
      await applyRuntimeCall("send", text);
    }
    const state = respondWithState();
    return warnings.length ? { ...state, warnings } : state;
  });

  // 当前会话可用的斜杠指令列表：runtime 在会话 init 后把 driver 的列表写进
  // state.commands（形状 [{ name, description }]）；无会话 / 未接线时回空数组，
  // 渲染端用内置兜底列表。
  handle("chat:list-commands", (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    const state = currentState();
    return { status: "ok", commands: Array.isArray(state.commands) ? state.commands : [] };
  });

  // 拖拽入口：preload 的 getPathForFile 解析出绝对路径后登记到这里，chat:send
  // 才接受这些附件。与 pick-attachments 一样是纵深防御而非安全边界——两个入口
  // 都由用户操作触发；非绝对路径的条目直接忽略。
  handle("chat:register-dropped-paths", (event, payload) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    const paths = isPlainObject(payload) && Array.isArray(payload.paths) ? payload.paths : [];
    for (const filePath of paths) {
      if (typeof filePath === "string" && path.isAbsolute(filePath)) {
        authorizedAttachmentPaths.add(filePath);
      }
    }
    return { status: "ok" };
  });

  // 粘贴图片落盘：渲染端把剪贴板图片转成 data URL 发到这里，校验通过后写入
  // 系统临时目录，并把路径登记进已授权附件集合（与 pick / 拖拽同一集合），
  // 之后 chat:send 才接受它。dataUrl / name 都按不受信输入校验。
  handle("chat:save-pasted-image", async (event, payload) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    const dataUrl = isPlainObject(payload) && typeof payload.dataUrl === "string" ? payload.dataUrl : "";
    const parsed = parsePastedImageDataUrl(dataUrl);
    if (!parsed) return { status: "error", message: "invalid image" };

    let tempDir = null;
    try {
      tempDir = app && typeof app.getPath === "function" ? app.getPath("temp") : null;
    } catch (err) {
      console.warn("Clawd: 读取临时目录失败:", err && err.message);
    }
    if (typeof tempDir !== "string" || !tempDir) {
      return { status: "error", message: "could not save image" };
    }

    const filePath = path.join(tempDir, `clawd-chat-paste-${Date.now()}${parsed.extension}`);
    try {
      await fs.promises.writeFile(filePath, parsed.buffer);
    } catch (err) {
      console.warn("Clawd: 粘贴图片写入失败:", err && err.message);
      return { status: "error", message: "could not save image" };
    }
    authorizedAttachmentPaths.add(filePath);

    const rawName = isPlainObject(payload) && typeof payload.name === "string" ? payload.name.trim() : "";
    return {
      status: "ok",
      file: {
        path: filePath,
        // name 只是界面展示名，不参与路径拼接；优先用渲染端给的名字。
        name: rawName ? rawName.slice(0, 255) : path.basename(filePath),
        size: parsed.buffer.length,
        isImage: true,
        preview: dataUrl,
      },
    };
  });

  // 打开外链：只放行 http / https，其余协议（file:、javascript: 等）一律拒绝；
  // 交给注入的 shell（缺省回退 electron 内置），失败也只回 error 不外抛。
  handle("chat:open-external", async (event, payload) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    const url = isPlainObject(payload) && typeof payload.url === "string" ? payload.url : "";
    let parsed = null;
    try {
      parsed = new URL(url);
    } catch {
      return { status: "error" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { status: "error" };
    if (!shell || typeof shell.openExternal !== "function") return { status: "error" };
    try {
      await shell.openExternal(url);
    } catch (err) {
      console.warn("Clawd: 打开外链失败:", err && err.message);
      return { status: "error" };
    }
    return { status: "ok" };
  });

  handle("chat:stop", async (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    // 先清队再 stop：stop 回到 idle 的边沿会触发排队器放行下一条。
    notifyUserStop();
    await applyRuntimeCall("stop");
    return respondWithState();
  });

  handle("chat:new-session", async (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    notifyContextReset("new-session");
    await applyRuntimeCall("newSession");
    return respondWithState();
  });

  handle("chat:set-effort", async (event, value) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    if (!EFFORT_VALUES.includes(value)) {
      return { status: "error", message: `invalid effort "${value}"` };
    }
    // setEffort 会重置会话上下文（开新会话）：面板排队消息属于旧上下文，先清。
    notifyContextReset("effort-changed");
    await applyRuntimeCall("setEffort", value);
    return respondWithState();
  });

  handle("chat:set-permission-mode", async (event, value) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    if (!PERMISSION_MODE_VALUES.includes(value)) {
      return { status: "error", message: `invalid permission mode "${value}"` };
    }
    await applyRuntimeCall("setPermissionMode", value);
    return respondWithState();
  });

  handle("chat:pick-working-dir", async (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    const strings = CHAT_DIALOG_STRINGS[getLang()] || CHAT_DIALOG_STRINGS.zh;

    let dir = null;
    if (pickDirOverride) {
      try {
        dir = await pickDirOverride();
      } catch (err) {
        return { status: "error", message: (err && err.message) || String(err) };
      }
    } else {
      const parent = getChatWindow();
      const dialogOptions = {
        title: strings.pickDirTitle,
        properties: ["openDirectory", "createDirectory"],
      };
      let result;
      try {
        result = isWindowUsable(parent)
          ? await dialog.showOpenDialog(parent, dialogOptions)
          : await dialog.showOpenDialog(dialogOptions);
      } catch (err) {
        return { status: "error", message: `chat working dir dialog failed: ${err && err.message}` };
      }
      if (!result || result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
        return { status: "cancel", state: currentState() };
      }
      dir = result.filePaths[0];
    }
    if (typeof dir !== "string" || !dir) {
      return { status: "cancel", state: currentState() };
    }

    // 先记住选择（prefs 校验失败只告警，不挡住本次会话使用该目录），
    // 再让 runtime 切目录；runtime 收到新目录会丢弃旧会话。
    try {
      const applyResult = settingsController.applyUpdate("chatLastWorkingDir", dir);
      if (applyResult && applyResult.status === "error") {
        console.warn("Clawd: failed to persist chatLastWorkingDir:", applyResult.message);
      }
    } catch (err) {
      console.warn("Clawd: failed to persist chatLastWorkingDir:", err && err.message);
    }
    // 重选同一目录不算换上下文（runtime 对同目录 no-op），不误清排队消息。
    if (dir !== currentChatCwd()) notifyContextReset("dir-changed");
    await applyRuntimeCall("setWorkingDir", dir);
    return { status: "ok", path: dir, state: respondWithState() };
  });

  // 当前工作目录下可续聊的历史会话（阶段二）。
  // 只回传白名单字段：sessionId / cwd 留在主进程，渲染端拿到的 historyKey
  // 只能用于 chat:resume-session 回查，不能自己指定恢复目标。
  handle("chat:list-history", async (event) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    const empty = { status: "ok", rows: [] };
    if (!loadHistory) {
      console.warn("Clawd: 对话历史列表未接线（缺少注入的 loadHistory），返回空列表");
      return empty;
    }
    const cwd = currentChatCwd();
    if (!cwd) return empty;
    const activeRawSessionIds = collectActiveSessionIds();
    let rows = null;
    try {
      // cwd 一并交给 loader：它在 limit 截断之前先按目录过滤，
      // 否则其他目录的近期会话会把当前目录的会话挤出「最近 25 条」。
      rows = await loadHistory({ activeRawSessionIds, cwd, limit: HISTORY_LIMIT });
    } catch (err) {
      console.warn("Clawd: 读取对话历史列表失败:", err && err.message);
      return empty;
    }
    const mapped = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (mapped.length >= HISTORY_LIMIT) break;
      // 只看当前工作目录；正在聊的会话（含启动中的）不出现。
      if (!row || row.cwd !== cwd) continue;
      if (activeRawSessionIds.has(row.sessionId)) continue;
      if (typeof row.historyKey !== "string" || !row.historyKey) continue;
      // 与 Dashboard 对齐：loader 标了不可恢复原因的行（旧版记录 profile 无法核验等）
      // 不给恢复入口，否则用户点了只能得到「无法恢复该会话」。
      if (row.resumeDisabledReason) continue;
      mapped.push({
        historyKey: row.historyKey,
        title: typeof row.title === "string" && row.title ? row.title : null,
        lastEventAt: Number.isFinite(row.lastEventAt) ? row.lastEventAt : null,
        endedAt: Number.isFinite(row.endedAt) ? row.endedAt : null,
      });
    }
    return { status: "ok", rows: mapped };
  });

  // 恢复历史会话：渲染端只交 historyKey，sessionId / cwd 从历史存储反查；
  // 只允许恢复当前工作目录下的会话（恢复过程不换目录）。
  handle("chat:resume-session", async (event, historyKey) => {
    const rejected = rejectUntrustedChatEvent(event);
    if (rejected) return rejected;
    const failed = { status: "error", message: "无法恢复该会话" };
    if (typeof historyKey !== "string" || !HISTORY_KEY_PATTERN.test(historyKey)) return failed;
    if (!resolveResumeTargetForChat || typeof chatRuntime.resumeSession !== "function") {
      console.warn("Clawd: 对话恢复未接线（缺少注入的 resolveResumeTarget / chatRuntime.resumeSession）");
      return failed;
    }
    let target = null;
    try {
      target = resolveResumeTargetForChat("claude-code", historyKey);
    } catch (err) {
      console.warn("Clawd: 反查对话恢复目标失败:", err && err.message);
      return failed;
    }
    if (!target || typeof target.sessionId !== "string" || !target.sessionId) return failed;
    const cwd = currentChatCwd();
    if (!cwd || target.cwd !== cwd) return failed;
    let result = null;
    try {
      const args = { sessionId: target.sessionId };
      // 回填缝随参数转交 runtime（runtime 也可自带注入，两者等价）。
      if (loadBackfill) args.loadBackfill = loadBackfill;
      // 恢复=换上下文：排队消息先清掉，避免发进刚恢复的旧对话。
      notifyContextReset("resume");
      result = await chatRuntime.resumeSession(args);
    } catch (err) {
      console.warn("Clawd: chatRuntime.resumeSession failed:", err && err.message);
      return failed;
    }
    if (!result || result.status !== "ok") {
      console.warn("Clawd: 恢复历史对话失败:", (result && result.message) || "unknown error");
      return failed;
    }
    return { status: "ok", state: respondWithState() };
  });

  // ── 状态推送接线 ──

  // 若 runtime 暴露 onUpdate(cb) 注册接口（返回退订函数），自动订阅；
  // 否则由 main.js 把 pushUpdate 接到 createChatSessionRuntime({ onUpdate })。
  if (typeof chatRuntime.onUpdate === "function") {
    try {
      const unsubscribe = chatRuntime.onUpdate((state) => pushUpdate(state));
      if (typeof unsubscribe === "function") disposers.push(unsubscribe);
    } catch (err) {
      console.warn("Clawd: chatRuntime.onUpdate subscription failed:", err && err.message);
    }
  }

  // chat 窗口 did-finish-load 后首推一次状态。这里按「所有窗口创建」挂监听、
  // 加载完成时再核对是不是 chat 窗口，避免依赖窗口 runtime 的创建顺序。
  function attachLoadPush(win) {
    const contents = win && win.webContents;
    if (!contents || typeof contents.on !== "function" || watchedWebContents.has(contents)) return;
    watchedWebContents.add(contents);
    const onLoaded = () => {
      if (getChatWindow() !== win) return;
      try {
        broadcastState();
      } catch (err) {
        console.warn("Clawd: chat initial push failed:", err && err.message);
      }
    };
    contents.on("did-finish-load", onLoaded);
    disposers.push(() => {
      try { contents.removeListener("did-finish-load", onLoaded); } catch {}
    });
  }

  function attachAppWindowHook() {
    // app 用上面解析过的注入值（缺省回退 electron 内置），兼作粘贴图片的临时目录来源。
    if (!app || typeof app.on !== "function") return;
    const onWindowCreated = (_event, win) => attachLoadPush(win);
    app.on("browser-window-created", onWindowCreated);
    disposers.push(() => {
      try { app.removeListener("browser-window-created", onWindowCreated); } catch {}
    });
  }

  attachAppWindowHook();
  // 注册时窗口可能已经存在（例如先建窗后注册 IPC 的顺序）。
  attachLoadPush(getChatWindow());

  return {
    dispose() {
      while (disposers.length) {
        const disposeOne = disposers.pop();
        try { disposeOne(); } catch {}
      }
    },
    // 供 main.js 接 createChatSessionRuntime({ onUpdate: (state) => chatIpc.pushUpdate(state) })
    pushUpdate,
    // 主动按 runtime 最新状态推一帧（窗口打开后、语言切换后可调用）。
    broadcastState,
  };
}

module.exports = {
  registerChatIpc,
};
