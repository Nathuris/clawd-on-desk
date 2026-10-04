"use strict";

// ── 编辑器窗口可见性探测（fork 个性化功能）──
//
// 用途：当名单里的图形编辑器（默认 VSCode）有窗口正显示在桌面上时，
// 权限请求直接交还给编辑器/终端自带的确认界面，不再弹 Clawd 权限气泡。
//
// 设计底线：
// - 一切失败都「照常弹窗」（fail-open）：探测初始化失败或查询出错，
//   一律视为「没有编辑器可见」，宁可多弹不可漏弹。
// - 绝不代用户做任何决定：调用方只拿到 true/false，断连回落由调用方处理。
// - macOS：CGWindowList（OnScreenOnly 自带「未最小化且在当前桌面」语义，
//   只读窗口属主名，不需要辅助功能/屏幕录制权限）。
// - Windows：EnumWindows + IsWindowVisible/IsIconic + DWM 遮挡检查
//   （被藏到别的虚拟桌面的窗口不算可见），进程名复用 win-process-ancestry。
// - Linux：系统不允许普通程序查询全局窗口（尤其 Wayland）→ 恒不压制。

const MAX_EDITOR_APP_ENTRIES = 32;
const MAX_EDITOR_APP_ENTRY_LENGTH = 64;
const PROBE_CACHE_TTL_MS = 1000;

// 常见编辑器的别名展开：用户按「人话名字」填名单，系统按进程/窗口属主名匹配。
// key 与 value 都是规范化后的名字（见 normalizeAppToken）。
const EDITOR_APP_ALIASES = Object.freeze({
  "visual studio code": ["visual studio code", "code"],
  "vscode": ["visual studio code", "code"],
  "vs code": ["visual studio code", "code"],
  "visual studio code insiders": ["visual studio code insiders", "code insiders"],
  "vscode insiders": ["visual studio code insiders", "code insiders"],
  "code insiders": ["visual studio code insiders", "code insiders"],
});

// ── 名字规范化与匹配 ──

// 把「用户填的名字」和「系统报的名字」都折成同一种形态：
// 小写、去 .exe、去掉首尾空白、连续的空格/下划线/连字符折成单个空格。
function normalizeAppToken(value) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\0/g, "")
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, "")
    .replace(/[\s_\-]+/g, " ")
    .trim();
}

// 把一条名单项展开成「可以匹配的规范名」集合（本名 + 别名）。
function expandAppEntry(entry) {
  const normalized = normalizeAppToken(entry);
  if (!normalized) return new Set();
  const out = new Set([normalized]);
  const aliases = EDITOR_APP_ALIASES[normalized];
  if (aliases) {
    for (const alias of aliases) out.add(alias);
  }
  return out;
}

// 词边界前缀匹配：把名字按空格拆成词，一边的词序列是另一边的前缀即算命中。
// 这样 "code" 能匹配 "code helpers"（VSCode 的辅助窗口），但绝不匹配
// "xcode" / "codec"——裸子串匹配会误伤，这里刻意不用。
function tokensMatchAtWordBoundary(aTokens, bTokens) {
  const n = Math.min(aTokens.length, bTokens.length);
  if (!n) return false;
  for (let i = 0; i < n; i++) {
    if (aTokens[i] !== bTokens[i]) return false;
  }
  return true;
}

function appEntryMatchesCandidate(entry, candidateName) {
  const candidate = normalizeAppToken(candidateName);
  if (!candidate) return false;
  const candidateTokens = candidate.split(" ");
  for (const expanded of expandAppEntry(entry)) {
    if (expanded === candidate) return true;
    if (tokensMatchAtWordBoundary(expanded.split(" "), candidateTokens)) return true;
  }
  return false;
}

// 清洗用户编辑过的应用名单（写入 prefs 前的规范化）。
function normalizeEditorAppList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.replace(/\0/g, "").trim().slice(0, MAX_EDITOR_APP_ENTRY_LENGTH);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= MAX_EDITOR_APP_ENTRIES) break;
  }
  return out;
}

// ── 平台窗口记录 → 可见应用名（纯函数，便于测试）──

// macOS：CGWindowList 的窗口记录。layer 0 是普通应用窗口；
// 菜单栏附加、状态项等高层窗口不算「编辑器窗口显示在桌面上」。
function selectMacVisibleOwnerNames(records) {
  if (!Array.isArray(records)) return [];
  const out = [];
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record.ownerName !== "string") continue;
    const name = record.ownerName.trim();
    if (!name) continue;
    if (Number.isInteger(record.layer) && record.layer !== 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// Windows：EnumWindows 收集的窗口记录。
// 可见 = IsWindowVisible 且未最小化（IsIconic）且未被 DWM 遮挡
// （遮挡包括被藏到别的虚拟桌面——用户看不见，就不该压制弹窗）。
function selectWinVisibleAppNames(records) {
  if (!Array.isArray(records)) return [];
  const out = [];
  const seen = new Set();
  for (const record of records) {
    if (!record || typeof record.name !== "string") continue;
    const name = record.name.trim();
    if (!name) continue;
    if (record.visible !== true || record.minimized === true || record.cloaked === true) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// ── 各平台探测后端 ──

function createMacVisibleAppsBackend(koffi) {
  const cg = koffi.load("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
  const cf = koffi.load("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");

  const CGWindowListCopyWindowInfo = cg.func("void *__cdecl CGWindowListCopyWindowInfo(uint32_t option, uint32_t relativeToWindow)");
  const CFArrayGetCount = cf.func("long CFArrayGetCount(void *theArray)");
  const CFArrayGetValueAtIndex = cf.func("void *CFArrayGetValueAtIndex(void *theArray, long idx)");
  const CFDictionaryGetValue = cf.func("void *CFDictionaryGetValue(void *theDict, const void *key)");
  const CFStringCreateWithCString = cf.func("void *CFStringCreateWithCString(void *alloc, const char *str, uint32_t encoding)");
  const CFStringGetCString = cf.func("bool CFStringGetCString(void *theString, void *buffer, long bufferSize, uint32_t encoding)");
  const CFNumberGetValue = cf.func("bool CFNumberGetValue(void *number, int32_t theType, void *valuePtr)");
  const CFRelease = cf.func("void CFRelease(void *ref)");

  const KCG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY = 1 << 0;
  const KCG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS = 1 << 4;
  const KCG_NULL_WINDOW_ID = 0;
  const KCF_STRING_ENCODING_UTF8 = 0x08000100;
  const KCF_NUMBER_SINT32_TYPE = 3;

  const keyLayer = CFStringCreateWithCString(null, "kCGWindowLayer", KCF_STRING_ENCODING_UTF8);
  const keyOwnerName = CFStringCreateWithCString(null, "kCGWindowOwnerName", KCF_STRING_ENCODING_UTF8);
  if (!keyLayer || !keyOwnerName) {
    throw new Error("CGWindowList key creation failed");
  }

  return function listMacVisibleOwnerNames() {
    const list = CGWindowListCopyWindowInfo(
      KCG_WINDOW_LIST_OPTION_ON_SCREEN_ONLY | KCG_WINDOW_LIST_EXCLUDE_DESKTOP_ELEMENTS,
      KCG_NULL_WINDOW_ID
    );
    if (!list) return [];
    try {
      const count = Number(CFArrayGetCount(list));
      const records = [];
      for (let i = 0; i < count; i++) {
        const dict = CFArrayGetValueAtIndex(list, i);
        if (!dict) continue;
        let layer = null;
        const layerRef = CFDictionaryGetValue(dict, keyLayer);
        if (layerRef) {
          const layerBuf = Buffer.alloc(4);
          if (CFNumberGetValue(layerRef, KCF_NUMBER_SINT32_TYPE, layerBuf)) {
            layer = layerBuf.readInt32LE(0);
          }
        }
        let ownerName = "";
        const ownerRef = CFDictionaryGetValue(dict, keyOwnerName);
        if (ownerRef) {
          const nameBuf = Buffer.alloc(512);
          if (CFStringGetCString(ownerRef, nameBuf, nameBuf.length, KCF_STRING_ENCODING_UTF8)) {
            ownerName = nameBuf.toString("utf8").split("\0")[0];
          }
        }
        records.push({ ownerName, layer });
      }
      return selectMacVisibleOwnerNames(records);
    } finally {
      CFRelease(list);
    }
  };
}

function createWinVisibleAppsBackend(koffi) {
  const user32 = koffi.load("user32.dll");
  const dwmapi = koffi.load("dwmapi.dll");

  const EnumWindows = user32.func("bool __stdcall EnumWindows(void *fn, void *lParam)");
  const IsWindowVisible = user32.func("bool __stdcall IsWindowVisible(void *hwnd)");
  const IsIconic = user32.func("bool __stdcall IsIconic(void *hwnd)");
  const GetWindowThreadProcessId = user32.func("uint32_t __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32_t *pid)");
  const DwmGetWindowAttribute = dwmapi.func("int __stdcall DwmGetWindowAttribute(void *hwnd, uint dwAttribute, void *pvAttribute, uint cbAttribute)");

  // 进程名查询复用 win-process-ancestry 的缓存绑定（AGENTS.md 约定：同一
  // Koffi registry 的绑定不得重复注册）。
  const { createWindowsProcessQuery } = require("./win-process-ancestry");
  const processQuery = createWindowsProcessQuery({ koffi });

  // WndEnumProc 的命名 proto 同样只在初始化时注册一次：koffi 的命名类型是
  // registry 级全局的，重名会直接抛 "Duplicate type name"，查询函数内只做
  // koffi.register / unregister（对照 win-cloak-recovery.js 的写法）。
  const WndEnumProc = koffi.proto("bool __stdcall WndEnumProc(void *hwnd, void *lParam)");

  const DWMWA_CLOAKED = 14;

  return function listWinVisibleAppNames() {
    const records = [];
    const callback = koffi.register((hwnd) => {
      try {
        const visible = IsWindowVisible(hwnd) === true;
        const minimized = IsIconic(hwnd) === true;
        let cloaked = false;
        if (visible && !minimized) {
          const cloakBuf = Buffer.alloc(4);
          if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloakBuf, 4) === 0) {
            cloaked = cloakBuf.readUInt32LE(0) !== 0;
          }
        }
        let name = "";
        if (visible && !minimized && !cloaked) {
          const pidOut = [0];
          GetWindowThreadProcessId(hwnd, pidOut);
          const pid = pidOut[0];
          if (pid) {
            const info = processQuery(pid);
            if (info && info.status === "ok" && typeof info.name === "string") {
              name = info.name;
            }
          }
        }
        if (name) records.push({ name, visible, minimized, cloaked });
      } catch {
        // 单个窗口查询失败不影响其余窗口（fail-open 由上层兜底）。
      }
      return true;
    }, koffi.pointer(WndEnumProc));
    try {
      EnumWindows(callback, null);
    } finally {
      koffi.unregister(callback);
    }
    return selectWinVisibleAppNames(records);
  };
}

// ── 对外的探测器 ──

// 返回 { available, listVisibleAppNames() }。
// available=false 表示这个平台/环境查不了窗口（如 Linux、FFI 加载失败），
// 此时 listVisibleAppNames() 恒返回 []，调用方不会压制任何弹窗。
function createVisibleAppProbe(options = {}) {
  const platform = options.platform || process.platform;
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, options.ttlMs) : PROBE_CACHE_TTL_MS;

  let backend = null;
  try {
    if (platform === "darwin" || platform === "win32") {
      const koffi = options.koffi || require("koffi");
      backend = platform === "darwin"
        ? createMacVisibleAppsBackend(koffi)
        : createWinVisibleAppsBackend(koffi);
    }
  } catch {
    backend = null;
  }

  let cachedNames = null;
  let cachedAt = 0;

  return {
    get available() {
      return backend !== null;
    },
    listVisibleAppNames() {
      if (!backend) return [];
      const now = Date.now();
      if (cachedNames && now - cachedAt < ttlMs) return cachedNames;
      try {
        cachedNames = backend();
      } catch {
        cachedNames = [];
      }
      cachedAt = now;
      return cachedNames;
    },
  };
}

// ── 压制闸门 ──

// 只回答一个问题：「此刻应不应该压住权限气泡？」
// 调用方（/permission 路由）拿 true 就断连回落到原生确认界面——
// 永远不会替用户点允许/拒绝，也绝不把请求留着稍后补弹。
function createEditorVisibleSuppressGate({ getEnabled, getAppNames, probe } = {}) {
  return {
    shouldSuppress() {
      try {
        if (typeof getEnabled !== "function" || getEnabled() !== true) return false;
        const entries = normalizeEditorAppList(
          typeof getAppNames === "function" ? getAppNames() : []
        );
        if (!entries.length) return false;
        if (!probe || typeof probe.listVisibleAppNames !== "function") return false;
        if (probe.available === false) return false;
        const visibleNames = probe.listVisibleAppNames();
        if (!Array.isArray(visibleNames) || !visibleNames.length) return false;
        for (const candidate of visibleNames) {
          if (typeof candidate !== "string" || !candidate) continue;
          for (const entry of entries) {
            if (appEntryMatchesCandidate(entry, candidate)) return true;
          }
        }
        return false;
      } catch {
        return false;
      }
    },
  };
}

module.exports = {
  MAX_EDITOR_APP_ENTRIES,
  normalizeAppToken,
  expandAppEntry,
  appEntryMatchesCandidate,
  normalizeEditorAppList,
  selectMacVisibleOwnerNames,
  selectWinVisibleAppNames,
  createVisibleAppProbe,
  createEditorVisibleSuppressGate,
};
