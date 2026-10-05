"use strict";

const { contextBridge, ipcRenderer } = require("electron");

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
  // 状态跟随 quick-state 推送，操作走 invoke（send-prompt 会花钱，
  // 主进程侧有信任闸门），hold 用 send 因为不需要回执。
  sendPrompt: (text) => ipcRenderer.invoke("session-hud:send-prompt", { text }),
  setEffort: (value) => ipcRenderer.invoke("session-hud:set-effort", { value }),
  setPermissionMode: (value) => ipcRenderer.invoke("session-hud:set-permission-mode", { value }),
  pickWorkingDir: () => ipcRenderer.invoke("session-hud:pick-working-dir"),
  stopChat: () => ipcRenderer.invoke("session-hud:stop-chat"),
  // 二级菜单展开状态由主进程持有（窗口高度要跟着变）。
  setMenuOpen: (open) => ipcRenderer.invoke("session-hud:set-menu-open", { open: !!open }),
  setHold: (reason, held) => ipcRenderer.send("session-hud:set-hold", { reason, held }),
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
