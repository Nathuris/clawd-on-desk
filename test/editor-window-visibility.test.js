"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  MAX_EDITOR_APP_ENTRIES,
  normalizeAppToken,
  expandAppEntry,
  appEntryMatchesCandidate,
  normalizeEditorAppList,
  selectMacVisibleOwnerNames,
  selectWinVisibleAppNames,
  createVisibleAppProbe,
  createEditorVisibleSuppressGate,
} = require("../src/editor-window-visibility");

describe("editor-window-visibility 名字规范化", () => {
  it("小写、去 .exe、折叠分隔符", () => {
    assert.strictEqual(normalizeAppToken("  Visual Studio  Code "), "visual studio code");
    assert.strictEqual(normalizeAppToken("Code.exe"), "code");
    assert.strictEqual(normalizeAppToken("Code - Insiders"), "code insiders");
    assert.strictEqual(normalizeAppToken("Code_Insiders"), "code insiders");
    assert.strictEqual(normalizeAppToken(42), "");
    assert.strictEqual(normalizeAppToken(""), "");
  });
});

describe("editor-window-visibility 名单清洗", () => {
  it("去空、去重（忽略大小写）、封顶", () => {
    assert.deepStrictEqual(
      normalizeEditorAppList([" Code ", "code", "", null, "Cursor", 7, "Xcode"]),
      ["Code", "Cursor", "Xcode"]
    );
    const big = Array.from({ length: 40 }, (_, i) => `App${i}`);
    assert.strictEqual(normalizeEditorAppList(big).length, MAX_EDITOR_APP_ENTRIES);
    assert.deepStrictEqual(normalizeEditorAppList("not-an-array"), []);
  });
});

describe("editor-window-visibility 别名展开", () => {
  it("VSCode 系名字展开到 Code 系", () => {
    assert.ok(expandAppEntry("Visual Studio Code").has("code"));
    assert.ok(expandAppEntry("vscode").has("code"));
    assert.ok(expandAppEntry("VS Code").has("visual studio code"));
    assert.ok(expandAppEntry("code").has("code"));
    assert.deepStrictEqual([...expandAppEntry("Cursor")], ["cursor"]);
  });
});

describe("editor-window-visibility 匹配规则", () => {
  it("VSCode 常见形态都能匹配", () => {
    for (const entry of ["Visual Studio Code", "vscode", "VS Code", "code"]) {
      assert.ok(appEntryMatchesCandidate(entry, "Code"), `${entry} 应匹配 Code`);
      assert.ok(appEntryMatchesCandidate(entry, "Code.exe"), `${entry} 应匹配 Code.exe`);
      assert.ok(appEntryMatchesCandidate(entry, "code helpers"), `${entry} 应匹配 code helpers`);
    }
    assert.ok(appEntryMatchesCandidate("Visual Studio Code", "Code - Insiders"));
    assert.ok(appEntryMatchesCandidate("code insiders", "Code - Insiders"));
    assert.ok(appEntryMatchesCandidate("Xcode", "Xcode"));
    assert.ok(appEntryMatchesCandidate("Cursor", "Cursor.exe"));
  });

  it("词边界：code 不误匹配 Xcode / codec", () => {
    assert.ok(!appEntryMatchesCandidate("code", "Xcode"));
    assert.ok(!appEntryMatchesCandidate("code", "Xcode Helper"));
    assert.ok(!appEntryMatchesCandidate("code", "codec"));
    assert.ok(!appEntryMatchesCandidate("code", "com.code.Editor"));
    assert.ok(!appEntryMatchesCandidate("", "Code"));
    assert.ok(!appEntryMatchesCandidate("code", ""));
  });

  it("不区分大小写", () => {
    assert.ok(appEntryMatchesCandidate("VISUAL STUDIO CODE", "code"));
    assert.ok(appEntryMatchesCandidate("xcode", "XCODE"));
  });
});

describe("editor-window-visibility 窗口记录过滤", () => {
  it("macOS：只收 layer 0 且有属主名的窗口", () => {
    assert.deepStrictEqual(
      selectMacVisibleOwnerNames([
        { ownerName: "Code", layer: 0 },
        { ownerName: "Code", layer: 0 },
        { ownerName: "Bartender", layer: 25 },
        { ownerName: " ", layer: 0 },
        { ownerName: "Xcode", layer: null },
        null,
      ]),
      ["Code", "Xcode"]
    );
  });

  it("Windows：可见、未最小化、未遮挡才算数", () => {
    assert.deepStrictEqual(
      selectWinVisibleAppNames([
        { name: "code.exe", visible: true, minimized: false, cloaked: false },
        { name: "code.exe", visible: true, minimized: false, cloaked: false },
        { name: "hidden.exe", visible: false, minimized: false, cloaked: false },
        { name: "minimized.exe", visible: true, minimized: true, cloaked: false },
        { name: "other-desktop.exe", visible: true, minimized: false, cloaked: true },
        { name: "", visible: true, minimized: false, cloaked: false },
        null,
      ]),
      ["code.exe"]
    );
  });
});

describe("editor-window-visibility 探测器", () => {
  it("Linux 不提供探测（恒不压制）", () => {
    const probe = createVisibleAppProbe({ platform: "linux" });
    assert.strictEqual(probe.available, false);
    assert.deepStrictEqual(probe.listVisibleAppNames(), []);
  });

  it("FFI 加载失败时 fail-open（照常弹窗）", () => {
    const fakeKoffi = {
      load() {
        throw new Error("no ffi on this machine");
      },
    };
    const probe = createVisibleAppProbe({ platform: "darwin", koffi: fakeKoffi });
    assert.strictEqual(probe.available, false);
    assert.deepStrictEqual(probe.listVisibleAppNames(), []);
  });

  it("Windows 后端：WndEnumProc 的 proto 只注册一次，TTL 过期后仍能重复探测", () => {
    // 回归锁：koffi.proto 的命名类型是 registry 级全局的，重名直接抛
    // "Duplicate type name"。以前 proto 写在查询函数里，第一次探测之后的
    // 每次查询都在这里抛错、被 fail-open 吞成空列表，Windows 上压制功能
    // 从第二次权限请求起永久失效。fake koffi 照真机语义对重名抛错。
    const protoCalls = [];
    const registeredNames = new Set();
    let enumWindowsCalls = 0;
    const lib = {
      func(sig) {
        if (sig.includes("EnumWindows")) {
          return (callback) => {
            enumWindowsCalls += 1;
            callback({ hwnd: 1 }, null);
            return true;
          };
        }
        if (sig.includes("IsWindowVisible")) return () => true;
        if (sig.includes("IsIconic")) return () => false;
        if (sig.includes("GetWindowThreadProcessId")) return (hwnd, pidOut) => {
          pidOut[0] = 4242;
          return 4242;
        };
        if (sig.includes("DwmGetWindowAttribute")) return (hwnd, attr, buf) => {
          buf.writeUInt32LE(0, 0);
          return 0;
        };
        return () => 0;
      },
    };
    const fakeKoffi = {
      load: () => lib,
      proto(def) {
        protoCalls.push(def);
        const name = def.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/)[1];
        if (registeredNames.has(name)) {
          throw new Error(`Duplicate type name '${name}'`);
        }
        registeredNames.add(name);
        return { name };
      },
      pointer: (type) => type,
      register: (fn) => fn,
      unregister: () => {},
    };

    const probe = createVisibleAppProbe({ platform: "win32", koffi: fakeKoffi, ttlMs: 0 });
    assert.strictEqual(probe.available, true);
    // 进程名查询走 win-process-ancestry，与本回归点无关，这里只看枚举有没有跑起来。
    probe.listVisibleAppNames();
    probe.listVisibleAppNames();
    assert.strictEqual(protoCalls.length, 1, "proto 必须只在初始化注册一次");
    assert.strictEqual(enumWindowsCalls, 2, "每次查询都要重新枚举窗口，不能被重复注册炸掉");
  });
});

describe("editor-window-visibility 压制闸门", () => {
  function fakeProbe(names, available = true) {
    return {
      available,
      listVisibleAppNames: () => names,
    };
  }

  it("开关关闭 → 不压制", () => {
    const gate = createEditorVisibleSuppressGate({
      getEnabled: () => false,
      getAppNames: () => ["Visual Studio Code"],
      probe: fakeProbe(["Code"]),
    });
    assert.strictEqual(gate.shouldSuppress(), false);
  });

  it("开关开启且命中 → 压制", () => {
    const gate = createEditorVisibleSuppressGate({
      getEnabled: () => true,
      getAppNames: () => ["Visual Studio Code"],
      probe: fakeProbe(["Code"]),
    });
    assert.strictEqual(gate.shouldSuppress(), true);
  });

  it("名单为空 / 没命中 / 探测不可用 → 不压制", () => {
    assert.strictEqual(createEditorVisibleSuppressGate({
      getEnabled: () => true,
      getAppNames: () => [],
      probe: fakeProbe(["Code"]),
    }).shouldSuppress(), false);

    assert.strictEqual(createEditorVisibleSuppressGate({
      getEnabled: () => true,
      getAppNames: () => ["Visual Studio Code"],
      probe: fakeProbe(["Safari"]),
    }).shouldSuppress(), false);

    assert.strictEqual(createEditorVisibleSuppressGate({
      getEnabled: () => true,
      getAppNames: () => ["Visual Studio Code"],
      probe: fakeProbe(["Code"], false),
    }).shouldSuppress(), false);
  });

  it("探测/设置读取抛错 → fail-open 不压制", () => {
    assert.strictEqual(createEditorVisibleSuppressGate({
      getEnabled: () => true,
      getAppNames: () => ["Visual Studio Code"],
      probe: {
        available: true,
        listVisibleAppNames() {
          throw new Error("boom");
        },
      },
    }).shouldSuppress(), false);

    assert.strictEqual(createEditorVisibleSuppressGate({
      getEnabled: () => {
        throw new Error("boom");
      },
      getAppNames: () => ["Visual Studio Code"],
      probe: fakeProbe(["Code"]),
    }).shouldSuppress(), false);
  });

  it("窗口名脏数据不炸、只按字符串匹配", () => {
    const gate = createEditorVisibleSuppressGate({
      getEnabled: () => true,
      getAppNames: () => ["Visual Studio Code"],
      probe: fakeProbe([null, 42, "", "Code"]),
    });
    assert.strictEqual(gate.shouldSuppress(), true);
  });
});
