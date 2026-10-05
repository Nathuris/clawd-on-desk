"use strict";

// ── 内置 Claude 对话窗口 preload ──
//
// Surface: window.chatAPI
//
//   getState()               Promise<state> — 取完整状态快照（含 lang）
//   send(text)               Promise<state> — 发送一条用户消息
//   stop()                   Promise<state> — 停止当前进行中的会话
//   newSession()             Promise<state> — 丢弃当前会话，开新会话
//   pickWorkingDir()         Promise<{status, path?, state?}> — 选工作目录
//   setEffort(value)         Promise<state> — 切 effort 档位（会开新会话）
//   setPermissionMode(value) Promise<state> — 切权限模式（中途生效）
//   onUpdate(cb)             cb(完整状态快照 + lang)；返回退订函数
//
// 渲染端只渲染主进程推来的快照（或 getState 拉到的快照），不自己拼状态。
// 所有 invoke 都走 chat-ipc.js 的信任校验通道；preload 只做转发。
// 权限确认不在本窗口内进行：走桌宠气泡（PermissionRequest hook → /permission）。

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
  send: (text) => ipcRenderer.invoke("chat:send", text),
  stop: () => ipcRenderer.invoke("chat:stop"),
  newSession: () => ipcRenderer.invoke("chat:new-session"),
  pickWorkingDir: () => ipcRenderer.invoke("chat:pick-working-dir"),
  setEffort: (value) => ipcRenderer.invoke("chat:set-effort", value),
  setPermissionMode: (value) => ipcRenderer.invoke("chat:set-permission-mode", value),
  onUpdate: (cb) => {
    if (typeof cb !== "function") return () => {};
    updateListeners.add(cb);
    return () => updateListeners.delete(cb);
  },
});
