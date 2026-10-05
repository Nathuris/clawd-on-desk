"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const langListeners = new Set();
const quickStateListeners = new Set();

ipcRenderer.on("session-hud:lang-change", (_event, payload) => {
  for (const cb of langListeners) {
    try { cb(payload); } catch (err) { console.warn("session hud lang listener threw:", err); }
  }
});

ipcRenderer.on("session-hud:quick-state", (_event, payload) => {
  for (const cb of quickStateListeners) {
    try { cb(payload); } catch (err) { console.warn("session hud quick-state listener threw:", err); }
  }
});

contextBridge.exposeInMainWorld("sessionHudAPI", {
  getI18n: () => ipcRenderer.invoke("session-hud:get-i18n"),
  // 状态跟随 quick-state 推送，操作走 invoke（发出去的话会进终端里那个真实
  // 会话，主进程侧有信任闸门），hold 用 send 因为不需要回执。
  sendPrompt: (text) => ipcRenderer.invoke("session-hud:send-prompt", { text }),
  // 手选目标会话 / 展开会话列表 / 在终端里新建会话
  selectSession: (sessionId) => ipcRenderer.invoke("session-hud:select-session", { sessionId }),
  setListOpen: (open) => ipcRenderer.invoke("session-hud:set-list-open", { open: !!open }),
  newSession: () => ipcRenderer.invoke("session-hud:new-session"),
  // 取消排好的新会话占位。
  cancelPendingSession: () => ipcRenderer.invoke("session-hud:cancel-pending-session"),
  // 「📎 添加文件」：系统选文件框，回来的是绝对路径。
  pickFiles: () => ipcRenderer.invoke("session-hud:pick-file"),
  // 粘贴的图片/文件：字节交给主进程落成临时文件，回来的是路径。
  savePastedFile: (payload) => ipcRenderer.invoke("session-hud:save-pasted-file", payload),
  // 剪贴板里的东西本来就来自磁盘时（从 Finder 拷的文件）拿它的真实路径；
  // 截图这类没有路径的返回空串。webUtils 只能在 preload 里用，所以从这里转出去。
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  // 选「新建会话」落在哪个文件夹（主进程弹系统文件夹选择框）。
  pickFolder: () => ipcRenderer.invoke("session-hud:pick-folder"),
  // 切「新建会话」的权限模式 / 思考强度（key ∈ permissionMode / effort）。
  setNewSessionOption: (key, value) =>
    ipcRenderer.invoke("session-hud:set-new-session-option", { key, value }),
  // 指针进出卡片：卡片外的透明区放行点击（单向、高频，用 send）。
  setClickThrough: (through) => ipcRenderer.send("session-hud:set-click-through", { through: !!through }),
  setHold: (reason, held) => ipcRenderer.send("session-hud:set-hold", { reason, held }),
  // 挂了几个附件（决定卡片要多高、面板要不要因此不自动收起），同样不需要回执。
  setAttachments: (count) => ipcRenderer.send("session-hud:set-attachments", { count }),
  onLangChange: (cb) => {
    if (typeof cb !== "function") return () => {};
    langListeners.add(cb);
    return () => langListeners.delete(cb);
  },
  onQuickState: (cb) => {
    if (typeof cb !== "function") return () => {};
    quickStateListeners.add(cb);
    return () => quickStateListeners.delete(cb);
  },
});
