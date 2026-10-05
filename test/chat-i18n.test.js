"use strict";

// 内置 Claude 对话界面（阶段一）的语言表检查。
//
// 分两块：
// 1. 主进程 src/i18n.js —— 菜单项 chatWithClaude、窗口标题 chatWindowTitle；
// 2. 渲染端 src/chat-i18n.js —— 7 种语言的完整字符串表。
//
// chat-i18n.js 是纯渲染端文件（不通过 require 导出），按项目惯例在 vm
// 沙箱里执行后读取挂出来的全局对象；这里不写死全局对象的名字，而是按
// “含有 en.chatInputPlaceholder 的字符串表”这一形状去识别，避免命名
// 细节让测试替实现做主。

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const CHAT_I18N_PATH = path.join(ROOT, "src", "chat-i18n.js");

const { i18n, SUPPORTED_LANGS } = require("../src/i18n");

// 契约里逐字固定的键（chatEffortLabel 在需求里出现两次，去重后如下）。
const REQUIRED_CHAT_KEYS = [
  "chatInputPlaceholder",
  "chatSend",
  "chatStop",
  "chatNewSession",
  "chatPickDir",
  "chatDirLabel",
  "chatEffortLabel",
  "chatModeLabel",
  "chatModeDefault",
  "chatModeAcceptEdits",
  "chatModePlan",
  "chatModeAuto",
  "chatEmptyHint",
  "chatErrorPrefix",
  "chatNoticeNewSessionForEffort",
  "chatNoticeDirChanged",
  "chatNoDirHint",
  "chatTitle",
  // 阶段二：历史会话浮层与相对时间
  "chatHistoryButton",
  "chatHistoryLoading",
  "chatHistoryEmpty",
  "chatHistoryUntitled",
  "chatHistoryLoadFailed",
  "chatHistoryTruncated",
  "chatHistoryResumed",
  "chatJustNow",
  "chatMinutesAgo",
  "chatHoursAgo",
  "chatDaysAgo",
  // 阶段三：附件与斜杠指令
  "chatAttachButton",
  "chatAttachRemove",
  "chatDropHint",
  "chatCmdCompactDesc",
  "chatCmdClearDesc",
  "chatCmdHelpDesc",
  "chatAttachmentLabel",
  "chatAttachPickFailed",
  // 阶段四：代码块复制 / diff 折叠 / 粘贴图片 / 状态栏用量
  "chatCopyCode",
  "chatCopied",
  "chatDiffExpand",
  "chatDiffCollapse",
  "chatPasteFailed",
  "chatContextUsage",
];

function looksLikeChatStrings(value) {
  return !!value
    && typeof value === "object"
    && !!value.en
    && typeof value.en === "object"
    && Object.prototype.hasOwnProperty.call(value.en, "chatInputPlaceholder");
}

// 在沙箱里跑 chat-i18n.js，并在挂到全局的直接属性（一层深）里找回字符串表。
function loadChatStrings() {
  const source = fs.readFileSync(CHAT_I18N_PATH, "utf8");
  const context = {};
  context.globalThis = context;
  context.window = context;
  vm.runInNewContext(source, context, { filename: CHAT_I18N_PATH });

  for (const key of Object.keys(context)) {
    const value = context[key];
    if (looksLikeChatStrings(value)) return value;
    if (!value || typeof value !== "object") continue;
    for (const nestedKey of Object.keys(value)) {
      const nested = value[nestedKey];
      if (looksLikeChatStrings(nested)) return nested;
    }
  }
  assert.fail("src/chat-i18n.js must expose a { en: { chatInputPlaceholder, ... } } string table");
}

test("chat i18n table covers every required key in all seven languages", () => {
  const strings = loadChatStrings();
  for (const lang of SUPPORTED_LANGS) {
    assert.ok(strings[lang], `chat i18n is missing the ${lang} locale`);
    for (const key of REQUIRED_CHAT_KEYS) {
      const value = strings[lang][key];
      assert.equal(typeof value, "string", `${lang}.${key} must be a string`);
      assert.notEqual(value.trim(), "", `${lang}.${key} must not be empty`);
      assert.notEqual(value, key, `${lang}.${key} must not render as its own key`);
    }
  }
});

// 走模板替换的键：渲染端把 {n} 换成数字 / 金额，模板必须保留占位符。
test("chat i18n templates keep the {n} placeholder", () => {
  const strings = loadChatStrings();
  const templateKeys = [
    "chatMinutesAgo",
    "chatHoursAgo",
    "chatDaysAgo",
    "chatContextUsage",
  ];
  for (const lang of SUPPORTED_LANGS) {
    for (const key of templateKeys) {
      assert.match(strings[lang][key], /\{n\}/, `${lang}.${key} must keep the {n} placeholder`);
    }
  }
});

test("chat i18n keeps every locale key-complete against English", () => {
  const strings = loadChatStrings();
  const englishKeys = Object.keys(strings.en).sort();
  assert.ok(englishKeys.length >= REQUIRED_CHAT_KEYS.length);
  for (const lang of SUPPORTED_LANGS) {
    assert.deepEqual(
      Object.keys(strings[lang]).sort(),
      englishKeys,
      `${lang} must expose exactly the same keys as en`,
    );
  }
});

// 权限确认只走桌宠原本的气泡，聊天窗口不再弹确认卡片；这些键已随卡片一并移除，不应复活。
const REMOVED_CHAT_KEYS = [
  "chatStatusAwaitingPermission",
  "chatPermissionTitle",
  "chatPermissionAllow",
  "chatPermissionDeny",
  "chatPermissionHint",
];

test("chat i18n no longer carries the removed permission-card keys", () => {
  const strings = loadChatStrings();
  for (const lang of SUPPORTED_LANGS) {
    for (const key of REMOVED_CHAT_KEYS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(strings[lang], key),
        false,
        `${lang}.${key} must stay removed: permission confirmation runs through the desktop-pet bubble`,
      );
    }
  }
});

test("main-process dictionary localizes the chat menu item and window title", () => {
  for (const lang of SUPPORTED_LANGS) {
    for (const key of ["chatWithClaude", "chatWindowTitle"]) {
      const value = i18n[lang][key];
      assert.equal(typeof value, "string", `${lang}.${key} must exist in src/i18n.js`);
      assert.notEqual(value.trim(), "", `${lang}.${key} must not be empty`);
      assert.notEqual(value, key, `${lang}.${key} must not fall back to its key`);
    }
  }
});
