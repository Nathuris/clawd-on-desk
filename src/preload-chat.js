"use strict";

// ── 内置 Claude 对话窗口 preload ──
//
// Surface: window.chatAPI
//
//   getState()               Promise<state> — 取完整状态快照（含 lang）
//   send(text, attachments?) Promise<state> — 发送一条用户消息（可带附件）
//   pickAttachments()        Promise<{status, files?}> — 弹文件选择框（图片/文件）
//   savePastedImage(dataUrl, name?) Promise<{status, file?}> — 粘贴的图片落盘并登记为附件
//   openExternal(url)        Promise<{status}> — 用系统默认浏览器打开 http(s) 链接
//   listCommands()           Promise<{status, commands}> — 当前会话可用的斜杠指令
//   registerDroppedPaths(paths) Promise<{status}> — 把拖拽进窗口的文件登记为附件
//   getPathForFile(file)     string — 拖拽的 File 对象 → 绝对路径（非文件返回 ""）
//   stop()                   Promise<state> — 停止当前进行中的会话
//   newSession()             Promise<state> — 丢弃当前会话，开新会话
//   pickWorkingDir()         Promise<{status, path?, state?}> — 选工作目录
//   setEffort(value)         Promise<state> — 切 effort 档位（会开新会话）
//   setPermissionMode(value) Promise<state> — 切权限模式（中途生效）
//   listHistory()            Promise<{status, rows:[{historyKey,title,lastEventAt,endedAt}]}>
//                            — 当前工作目录下可续聊的历史会话
//   resumeSession(historyKey) Promise<{status, state?}> — 恢复历史会话并回填消息
//   onUpdate(cb)             cb(完整状态快照 + lang)；返回退订函数
//
// 渲染端只渲染主进程推来的快照（或 getState 拉到的快照），不自己拼状态。
// 所有 invoke 都走 chat-ipc.js 的信任校验通道；preload 只做转发。
// 权限确认不在本窗口内进行：走桌宠气泡（PermissionRequest hook → /permission）。

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const updateListeners = new Set();

ipcRenderer.on("chat:update", (_event, payload) => {
  for (const cb of updateListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.warn("chat onUpdate listener threw:", err);
    }
  }
});

contextBridge.exposeInMainWorld("chatAPI", {
  getState: () => ipcRenderer.invoke("chat:get-state"),
  send: (text, attachments) => ipcRenderer.invoke("chat:send", {
    text,
    attachments: Array.isArray(attachments) ? attachments : [],
  }),
  stop: () => ipcRenderer.invoke("chat:stop"),
  newSession: () => ipcRenderer.invoke("chat:new-session"),
  pickWorkingDir: () => ipcRenderer.invoke("chat:pick-working-dir"),
  // 附件：文件选择 / 斜杠指令 / 拖拽路径登记 / File → 绝对路径。
  // Electron ≥32 起渲染端没有 File.path，webUtils.getPathForFile 只能在 preload
  // 里调用（与 preload-hit.js 的拖拽入口同一处理）；非文件系统来源返回 ""。
  pickAttachments: () => ipcRenderer.invoke("chat:pick-attachments"),
  // 粘贴图片：渲染端把剪贴板图片读成 data URL 交主进程落盘（并登记为已授权附件）；
  // name 可选，只是建议的展示名，主进程仍会完整校验。
  savePastedImage: (dataUrl, name) => ipcRenderer.invoke("chat:save-pasted-image", {
    dataUrl,
    name: typeof name === "string" ? name : undefined,
  }),
  // 外链统一走主进程（仅放行 http/https），不在渲染端直接开新窗口。
  openExternal: (url) => ipcRenderer.invoke("chat:open-external", { url }),
  listCommands: () => ipcRenderer.invoke("chat:list-commands"),
  registerDroppedPaths: (paths) => ipcRenderer.invoke("chat:register-dropped-paths", {
    paths: Array.isArray(paths) ? paths : [],
  }),
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ""; } catch (_) { return ""; }
  },
  setEffort: (value) => ipcRenderer.invoke("chat:set-effort", value),
  setPermissionMode: (value) => ipcRenderer.invoke("chat:set-permission-mode", value),
  listHistory: () => ipcRenderer.invoke("chat:list-history"),
  resumeSession: (historyKey) => ipcRenderer.invoke("chat:resume-session", historyKey),
  onUpdate: (cb) => {
    if (typeof cb !== "function") return () => {};
    updateListeners.add(cb);
    return () => updateListeners.delete(cb);
  },
});
