"use strict";

// ── 回复窗口 preload ──
//
// Surface: window.chatAPI
//
//   getState()                Promise<state> — 取完整状态快照（含 lang、showUserMessages）
//   stop()                    Promise<state> — 停止当前进行中的会话
//   newSession()               Promise<state> — 丢弃当前会话，开新会话
//   setShowUserMessages(bool) Promise<state> — 显示/隐藏「我自己的消息」
//   openExternal(url)         Promise<{status}> — 用系统默认浏览器打开 http(s) 链接
//   listHistory()             Promise<{status, rows:[…]}> — 当前工作目录下可续聊的历史会话
//   resumeSession(historyKey) Promise<{status, state?}> — 恢复历史会话并回填消息
//   onUpdate(cb)              cb(完整状态快照 + lang)；返回退订函数
//
// 这个窗口只负责"看"：发消息、选目录、effort/权限模式、附件都在桌宠面板那边，
// 相关通道仍留在主进程（chat-ipc.js）备查，但不再从这里暴露。
// 渲染端只渲染主进程推来的快照，不自己拼状态；所有 invoke 都走信任校验。

const { contextBridge, ipcRenderer } = require("electron");

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
  stop: () => ipcRenderer.invoke("chat:stop"),
  newSession: () => ipcRenderer.invoke("chat:new-session"),
  // 回复窗口的「显示我的消息」开关：落 prefs，随后主进程回一份新状态。
  setShowUserMessages: (value) => ipcRenderer.invoke("chat:set-show-user-messages", value === true),
  // 外链统一走主进程（仅放行 http/https），不在渲染端直接开新窗口。
  openExternal: (url) => ipcRenderer.invoke("chat:open-external", { url }),
  listHistory: () => ipcRenderer.invoke("chat:list-history"),
  resumeSession: (historyKey) => ipcRenderer.invoke("chat:resume-session", historyKey),
  onUpdate: (cb) => {
    if (typeof cb !== "function") return () => {};
    updateListeners.add(cb);
    return () => updateListeners.delete(cb);
  },
});
