const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const sessionHudHtml = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud.html"), "utf8");
const sessionHudRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud-renderer.js"), "utf8");
const sessionHudJs = fs.readFileSync(path.join(__dirname, "..", "src", "session-hud.js"), "utf8");
const quotaRingHtml = fs.readFileSync(path.join(__dirname, "..", "src", "quota-ring.html"), "utf8");
const quotaRingRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "quota-ring-renderer.js"), "utf8");

describe("session HUD is sessions-only (quota moved to the ring)", () => {
  it("no longer renders an account-quota strip inside the HUD", () => {
    assert.doesNotMatch(sessionHudRenderer, /buildQuotaStrip/);
    assert.doesNotMatch(sessionHudRenderer, /createQuotaMeter/);
    assert.doesNotMatch(sessionHudHtml, /\.quota-strip/);
    assert.doesNotMatch(sessionHudHtml, /\.quota-window-fill/);
  });
});

describe("pet-attached quota ring", () => {
  it("draws one coin per provider with up to two concentric rings (outer/inner window)", () => {
    assert.match(quotaRingRenderer, /buildCoinSvg/);
    assert.match(quotaRingRenderer, /OUTER_R/);
    assert.match(quotaRingRenderer, /INNER_R/);
    // Fill sweeps with the selected display percentage, clockwise from 12 o'clock.
    assert.match(quotaRingRenderer, /rotate\(-90/);
    assert.match(quotaRingRenderer, /stroke-dasharray/);
  });

  // A healthy ring is colored by identity, not by headroom: severity has only
  // three steps, so two healthy windows used to come out the same color and read
  // as one thick ring. Severity still owns the alert states.
  it("gives every ring provider its own identity pair, so none silently wears another's colors", () => {
    // The generic --id-outer/--id-inner pair is Claude's, by design (it is the
    // most common coin). That makes a missing pair invisible rather than loud:
    // a new provider would just look like Claude. Pin the mapping instead.
    const declared = new Set(
      [...quotaRingHtml.matchAll(/--id-([a-z]+)-(outer|inner)\s*:/g)].map((m) => `${m[1]}-${m[2]}`)
    );
    // RING_PROVIDERS keys are "<name>Quota"; the CSS classes are pv-<key>.
    const providerKeys = [...quotaRingRenderer.matchAll(/key:\s*"(\w+Quota)"/g)].map((m) => m[1]);
    assert.ok(providerKeys.length >= 3, `expected the ring providers, got ${providerKeys}`);
    const valueOf = (name, slot) =>
      (quotaRingHtml.match(new RegExp(`--id-${name}-${slot}\\s*:\\s*(#[0-9a-fA-F]{3,8})`)) || [])[1];
    for (const key of providerKeys) {
      const name = key.replace(/Quota$/, "").toLowerCase();
      for (const slot of ["outer", "inner"]) {
        assert.ok(
          declared.has(`${name}-${slot}`),
          `${key} has no --id-${name}-${slot} in quota-ring.html; it would inherit the generic (Claude) pair`
        );
        assert.match(
          quotaRingHtml,
          new RegExp(`\\.pv-${key}\\.rg-${slot}\\s*\\{[^}]*--ring-id`),
          `${key}/${slot} resolves no --ring-id, so fill and track would not share a hue`
        );
      }
      // Declaring a pair is not enough — the whole point is that the two rings
      // are tellable apart. Identical values would sail past the checks above
      // and reinstate the exact "two healthy windows merge into one thick ring"
      // bug this palette exists to fix.
      assert.notStrictEqual(
        valueOf(name, "outer"), valueOf(name, "inner"),
        `${key} paints its outer and inner rings the same color`
      );
    }
  });

  // A reset ring draws no fill in "used" mode, so its bed is the only thing on
  // screen — and 14% under a stale row's 0.72 leaves ~10%. It gets a stronger
  // alpha plus a dash, and the marker is per RING: .coin-row.is-reset only
  // exists when every window reset, missing the common one-of-two case.
  it("strengthens the bed of a reset ring, per ring rather than per row", () => {
    assert.match(quotaRingRenderer, /bedOnly\s*=\s*\(w\)\s*=>[^;]*w\.reset === true/);
    assert.match(quotaRingRenderer, /bedOnly\(outer\) \? " is-reset-bed"/);
    assert.match(quotaRingRenderer, /bedOnly\(inner\) \? " is-reset-bed"/);
    const bedRule = quotaRingHtml.match(/\.coin \.track\.is-reset-bed\s*\{[\s\S]*?\}/);
    assert.ok(bedRule, "no .coin .track.is-reset-bed rule");
    assert.match(bedRule[0], /stroke-opacity:\s*var\(--track-alpha-reset\)/);
    // Non-color channel for the same state: color alone cannot carry it under
    // color-vision deficiency.
    assert.match(bedRule[0], /stroke-dasharray/);
  });

  // The track is the same hue as the fill, laid down faintly. A reset ring draws
  // no fill at all, so the track is the only thing left on screen — it must not
  // fall back to grey there, which is why it carries the identity classes too.
  it("beds every track in its own ring's hue, fill and track from one source", () => {
    // Match the template itself, not its position in the call — the assertion
    // should survive the argument list being wrapped across lines.
    // The class argument is the window's LOGICAL slot (outer.ring), not the
    // physical ring it is drawn on: a weekly-only provider draws at the outer
    // radius yet still wears the weekly hue, matching the Dashboard's bar.
    assert.match(quotaRingRenderer, /`track \$\{identityClass\(model\.providerKey, outer\.ring\)/);
    assert.match(quotaRingRenderer, /`track \$\{identityClass\(model\.providerKey, inner\.ring\)/);
    // Scope the assertions to the track rule itself. Matching the whole file
    // would let the identical fallback on .fill.sev-ok satisfy them while the
    // track quietly lost its own (a mutation run caught exactly that).
    const trackRule = quotaRingHtml.match(/\.coin \.track\.rg-outer,[\s\S]*?\n\}/);
    assert.ok(trackRule, "no .coin .track.rg-outer rule found");
    // Hue and alpha stay on separate properties on purpose. A single
    // color-mix() that goes invalid resolves to `unset` — the cascade does NOT
    // fall back to the lower-specificity `.coin .track` rule, and `stroke`
    // inherits down to its initial `none`, erasing the ring. Split, a bad hue
    // still falls back via var() and a bad alpha only lands at opacity 1.
    // Strip comments first: the rule explains why color-mix is avoided, so a
    // naive doesNotMatch would trip over the word in the prose.
    const trackDecls = trackRule[0].replace(/\/\*[\s\S]*?\*\//g, "");
    assert.doesNotMatch(trackDecls, /color-mix/);
    assert.match(trackDecls, /stroke:\s*var\(--ring-id,\s*var\(--id-outer\)\)/);
    assert.match(trackDecls, /stroke-opacity:\s*var\(--track-alpha\)/);
    // Exactly one --ring-track declaration: a duplicate silently shadows the
    // other and the comment stops describing what ships.
    assert.strictEqual((quotaRingHtml.match(/^\s*--ring-track\s*:/gm) || []).length, 1);
  });

  it("colors coins by severity and dims reset/stale states", () => {
    assert.match(quotaRingRenderer, /severityClass/);
    assert.match(quotaRingHtml, /\.fill\.sev-ok/);
    assert.match(quotaRingHtml, /\.fill\.sev-warn/);
    assert.match(quotaRingHtml, /\.fill\.sev-hot/);
    assert.match(quotaRingHtml, /\.fill\.sev-reset/);
    assert.match(quotaRingHtml, /\.fill\.sev-reset\s*\{[^}]*opacity:\s*0\.56/);
    assert.match(quotaRingHtml, /is-stale/);
    // Expired data is normalized to zero used; remaining mode renders that as
    // a weak full ring without inheriting the pre-reset severity or pulse.
    assert.match(quotaRingRenderer, /usedPercent: 0, expired: true/);
    assert.match(quotaRingRenderer, /outer\.reset \? "sev-reset"/);
  });

  it("labels windows from reporter metadata, never hard-coding 5h/7d", () => {
    assert.match(quotaRingRenderer, /formatWindowLabel/);
    assert.match(quotaRingRenderer, /windowMinutes/);
    assert.match(quotaRingRenderer, /minutes \/ \(24 \* 60\)/);
  });

  it("keeps the ring compact without hover cards and reuses provider agent icons", () => {
    assert.doesNotMatch(quotaRingRenderer, /coinTooltip/);
    assert.doesNotMatch(quotaRingRenderer, /mouseenter|mouseleave/);
    assert.doesNotMatch(quotaRingRenderer, /\.title\s*=/);
    assert.match(quotaRingRenderer, /quotaDisplayPercent/);
    assert.match(quotaRingRenderer, /quotaAgentIcons/);
  });

  it("clicking a coin or the overflow opens the Dashboard", () => {
    assert.match(quotaRingRenderer, /openDashboard\(\)/);
    assert.match(quotaRingRenderer, /buildOverflow/);
  });

  it("does not advertise unreachable keyboard controls in the non-focusable ring panel", () => {
    assert.match(quotaRingHtml, /id="cluster"[^>]*aria-hidden="true"/);
    assert.doesNotMatch(quotaRingRenderer, /tabindex/);
    assert.doesNotMatch(quotaRingRenderer, /addEventListener\("keydown"/);
    assert.doesNotMatch(quotaRingRenderer, /setAttribute\("role", "button"\)/);
  });

  it("honors reduced motion for the near-exhausted pulse", () => {
    assert.match(quotaRingHtml, /prefers-reduced-motion: reduce/);
    assert.match(quotaRingHtml, /coin-pulse/);
  });
});

describe("快捷面板整卡（视觉外壳）", () => {
  it("卡片高 66px：状态行 + 行距 + 输入行，壳底留 60px 输入法净空", () => {
    // 主进程按「卡片 + 壳」算窗口尺寸（见 src/session-hud.js 顶部注释）：
    // 6+16+4+32+6+2 = 66；窗口高 = 66 + 2 + 60 = 128。
    assert.match(sessionHudHtml, /body \{[\s\S]*?padding:\s*2px 3px 60px;[\s\S]*?\}/);
    assert.match(sessionHudHtml, /\.quick-card \{ height: 66px; \}/);
  });

  it("两张卡片贴底叠放（窗口变高时只往上长）", () => {
    // 主卡片在下、菜单卡片在上，整列贴底：窗口变高时主卡片底边钉住不动。
    assert.match(sessionHudHtml, /#hud \{[\s\S]*flex-direction:\s*column;[\s\S]*\}/);
    assert.match(sessionHudHtml, /#hud \{[\s\S]*justify-content:\s*flex-end;[\s\S]*\}/);
    assert.match(sessionHudHtml, /#hud \{[\s\S]*height:\s*100%;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.quick-card \{[\s\S]*overflow:\s*hidden;[\s\S]*\}/);
    // 缩窗不依赖任何计时：渲染端只负责 CSS，主进程等窗口隐藏后才缩
    assert.doesNotMatch(sessionHudJs, /PANEL_RESIZE|panelResizeTimer/);
  });

  it("菜单是独立的卡片，开着才淡入（主卡片高度不变）", () => {
    assert.match(sessionHudHtml, /\.quick-menu-card \{[\s\S]*display:\s*none;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.quick-menu-card \{[\s\S]*opacity:\s*1;[\s\S]*transition:[\s\S]*opacity[\s\S]*\}/);
    assert.match(sessionHudHtml, /body\.session-menu-open \.quick-menu-card,[\s\S]*body\.settings-menu-open \.quick-menu-card \{ display:\s*flex; \}/);
    // 淡入首帧：透明 + 稍微靠下
    assert.match(sessionHudHtml, /@starting-style \{[\s\S]*opacity:\s*0;[\s\S]*translateY\(6px\);[\s\S]*\}/);
    // 主卡片不会再因为开菜单而变高：这两条规则不该再存在
    assert.doesNotMatch(sessionHudHtml, /body\.session-menu-open \.quick-card \{ height/);
    assert.doesNotMatch(sessionHudHtml, /body\.settings-menu-open \.quick-card \{ height/);
    // 渲染端把菜单挂在独立卡片里
    assert.match(sessionHudRenderer, /menuCardEl\.className = "quick-menu-card"/);
    assert.match(sessionHudRenderer, /menuCardEl\.appendChild\(createSessionList\(\)\)/);
  });

  it("卡片外观：圆角、毛玻璃底、内高光阴影、主题变量", () => {
    assert.match(sessionHudHtml, /\.quick-card \{[\s\S]*border-radius:\s*14px;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.quick-card \{[\s\S]*background:\s*var\(--hud-bg\);[\s\S]*\}/);
    // 毛玻璃：半透明底 + backdrop 模糊，内高光（inset）给玻璃一条亮边。
    assert.match(sessionHudHtml, /\.quick-card \{[\s\S]*backdrop-filter:\s*blur\(24px\) saturate\(180%\);[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.quick-card \{[\s\S]*box-shadow:[\s\S]*var\(--card-highlight\) inset,[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.quick-card \{[\s\S]*border:\s*1px solid var\(--hud-border\);[\s\S]*\}/);
  });

  it("行件固定高度与算式一致：状态 16 / 输入 32", () => {
    assert.match(sessionHudHtml, /\.quick-status-row \{[\s\S]*height:\s*16px;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.quick-input-row \{[\s\S]*height:\s*32px;[\s\S]*\}/);
    assert.strictEqual(6 + 16 + 4 + 32 + 6 + 2, 66);
  });

  it("会话行遗留的 CSS 与渲染逻辑全面清场", () => {
    for (const pattern of [
      /\.row\s*\{/,
      /\.row-unfocusable/,
      /\.pin-btn/,
      /\.sessions\b/,
      /completion-bell/,
      /\.state-chip/,
      /\.elapsed\b/,
      /\.usage-chip/,
      /\.quick-footer\b/,
      /\.hud\s*\{/,
    ]) {
      assert.doesNotMatch(sessionHudHtml, pattern, String(pattern));
    }
    for (const pattern of [
      /createRowForSession/,
      /createPinButton/,
      /unreadSessions/,
      /updateElapsedLabels/,
      /openSessionFolder/,
      /onSessionSnapshot/,
    ]) {
      assert.doesNotMatch(sessionHudRenderer, pattern, String(pattern));
    }
  });

  it("整卡的 DOM 类由 HTML 样式与渲染端共同认领", () => {
    const classes = [
      "quick-card",
      "quick-status-row",
      "quick-status-text",
      "quick-input-row",
      "quick-input",
    ];
    for (const cls of classes) {
      assert.match(sessionHudHtml, new RegExp(`\\.${cls}\\b`), `html 缺少 .${cls}`);
      assert.ok(sessionHudRenderer.includes(`"${cls}"`), `renderer 缺少 "${cls}"`);
    }
    // 分块版遗留：复合卡片类名必须消失，整卡只有一种卡片。
    assert.doesNotMatch(sessionHudRenderer, /quick-card-input|quick-card-settings/);
    assert.doesNotMatch(sessionHudHtml, /block-input|block-settings/);
  });

  it("输入框不出现系统焦点环，聚焦时用一圈柔光", () => {
    // 输入框自己 outline:none（去掉 macOS 那圈黄边），聚焦用主题蓝 + 柔光
    assert.match(sessionHudHtml, /\.quick-input \{[\s\S]*outline:\s*none;[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.quick-input:focus \{[\s\S]*border-color:\s*var\(--accent\);[\s\S]*\}/);
    assert.match(sessionHudHtml, /\.quick-input:focus \{[\s\S]*box-shadow:\s*0 0 0 3px var\(--accent-soft\);[\s\S]*\}/);
    assert.doesNotMatch(sessionHudHtml, /quick-level-btn|quick-stop-btn|quick-effort-range/);
  });

});

// The exporter gives a plain mark 56 of its 64px canvas but a contrast-tile
// mark only 40 (the rest is the light plate that keeps a black-on-transparent
// logo alive on dark HUD/Dashboard surfaces). A coin crops its glyph to a
// circle, so one shared zoom makes tiled marks render visibly smaller and
// framed. This pins the per-provider zoom against the exporter's own manifest,
// so adding a ring provider cannot silently inherit the wrong one.
describe("quota ring glyph zoom follows the exporter's artwork ratio", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "assets", "source", "agent-icons", "source-manifest.json"), "utf8"
  ));
  const snapshotSource = fs.readFileSync(
    path.join(__dirname, "..", "src", "state-session-snapshot.js"), "utf8"
  );

  it("zooms tiled marks to their artwork, not to the plate", () => {
    // providerKey -> agent id, straight from the snapshot that feeds the ring.
    const block = snapshotSource.match(/quotaAgentIcons: \(\(\) => \{[\s\S]*?\n    \}\)\(\)/);
    assert.ok(block, "could not locate the quotaAgentIcons block");
    const mapping = [...block[0].matchAll(/(\w+Quota):\s*iconFor\("([\w-]+)"\)/g)]
      .map((m) => ({ providerKey: m[1], agentId: m[2] }));
    assert.ok(mapping.length >= 3, `expected the ring providers, got ${JSON.stringify(mapping)}`);

    const zoomBlock = quotaRingRenderer.match(/GLYPH_ZOOM_BY_PROVIDER = \{[\s\S]*?\}/);
    assert.ok(zoomBlock, "no GLYPH_ZOOM_BY_PROVIDER");
    const zooms = Object.fromEntries(
      [...zoomBlock[0].matchAll(/(\w+Quota):\s*64\s*\/\s*([\d.]+)/g)].map((m) => [m[1], Number(m[2])])
    );

    // Only providers the ring actually draws; RING_PROVIDERS is the authority.
    const drawn = new Set(
      [...quotaRingRenderer.matchAll(/key:\s*"(\w+Quota)"/g)].map((m) => m[1])
    );

    for (const { providerKey, agentId } of mapping) {
      if (!drawn.has(providerKey)) continue;
      const tiled = !!(manifest.sources[agentId] || {}).contrastTreatment;
      const divisor = zooms[providerKey];
      assert.ok(
        divisor !== undefined,
        `${providerKey} (${agentId}) has no entry in GLYPH_ZOOM_BY_PROVIDER; it would fall back to `
        + "the shared zoom, which fits neither artwork size"
      );
      if (tiled) {
        // Artwork is 40 of 64, inside a 56px plate. The divisor may exceed 40 to
        // leave breathing room, but must stay well under the 56 that would put
        // the plate's edge back inside the clip as a visible frame.
        assert.ok(
          divisor >= 40 && divisor <= 46,
          `${providerKey} (${agentId}) is contrast-tiled — its artwork fills 40 of 64, so the divisor `
          + `should sit between 40 (flush) and ~46 (before the plate shows), got ${divisor}`
        );
      } else {
        assert.strictEqual(
          divisor, 56,
          `${providerKey} (${agentId}) is not contrast-tiled, so its glyph fills 56 of 64`
        );
      }
    }
  });
});

describe("Kimi quota freshness policy mirrors across browser renderers", () => {
  const dashboardRenderer = fs.readFileSync(
    path.join(__dirname, "..", "src", "dashboard-renderer.js"), "utf8"
  );

  it("keeps Kimi at seven minutes and every other provider at five", () => {
    for (const source of [quotaRingRenderer, dashboardRenderer]) {
      assert.match(source, /DEFAULT_QUOTA_STALE_AFTER_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
      assert.match(source, /PROVIDER_STALE_AFTER_MS\s*=\s*Object\.freeze\(\{[\s\S]*?kimiQuota:\s*7\s*\*\s*60\s*\*\s*1000/);
    }
  });
});

// ── 窗口尺寸：主进程常量与 CSS 必须一一对上（整卡版）──
//
// 主进程按「卡片 + 窗口壳」算窗口尺寸（见 src/session-hud.js）；
// session-hud.html 的 body 内边距与卡片高度是同一组数字的另一半。
// 任何一侧改动而另一侧没跟上，窗口与卡片就会错位（露白/裁切），
// 所以这里把两侧数字钉在一起。
describe("面板窗口尺寸：主进程常量与 CSS 一致", () => {
  const hudTest = require("../src/session-hud").__test;

  it("卡片常量与 HTML 的高度声明一一对应", () => {
    assert.deepStrictEqual(hudTest.QUICK_CARD, { width: 300, height: 66 });
    assert.match(sessionHudHtml, /\.quick-card \{ height: 66px; \}/);
  });

  it("窗口壳：底 30（输入法净空），与 body padding 一致", () => {
    assert.equal(hudTest.QUICK_SHELL.top, 2);
    assert.equal(hudTest.QUICK_SHELL.bottom, 60);
    assert.equal(hudTest.QUICK_SHELL.left, 3);
    assert.equal(hudTest.QUICK_SHELL.right, 3);
    assert.match(sessionHudHtml, /body \{[\s\S]*?padding:\s*2px 3px 60px;[\s\S]*?\}/);
  });

  it("卡片高度的算式成立（状态行 + 输入行）", () => {
    // padding 6+6 + 状态 16 + 间隙 4 + 输入 32 + 边框 2 = 66
    assert.strictEqual(6 + 16 + 4 + 32 + 6 + 2, hudTest.QUICK_CARD.height);
  });

  it("菜单卡片的列表区与卡片高度两侧一致", () => {
    assert.deepStrictEqual(hudTest.QUICK_MENU_CARD, { width: 300, session: 192, settings: 242 });
    assert.strictEqual(hudTest.QUICK_MENU_GAP, 6);
    assert.match(sessionHudHtml, /body\.session-menu-open \.quick-menu-card \{ height: 192px; \}/);
    assert.match(sessionHudHtml, /body\.settings-menu-open \.quick-menu-card \{ height: 242px; \}/);
    assert.match(sessionHudHtml, /body\.session-menu-open \.quick-session-list \{ height: 178px; \}/);
    assert.match(sessionHudHtml, /body\.settings-menu-open \.quick-session-list \{ height: 228px; \}/);
    assert.match(sessionHudHtml, /\.quick-session-item \{[\s\S]*?height: 28px;[\s\S]*?\}/);
    assert.match(sessionHudHtml, /\.quick-permission-item \{[\s\S]*?height: 44px;[\s\S]*?\}/);
    assert.match(sessionHudHtml, /\.quick-effort-block \{[\s\S]*?height: 44px;[\s\S]*?\}/);
    // 卡片本体 = 列表区 + 上下内边距 12 + 边框 2
    assert.strictEqual(178 + 6 + 6 + 2, hudTest.QUICK_MENU_CARD.session);
    assert.strictEqual(228 + 6 + 6 + 2, hudTest.QUICK_MENU_CARD.settings);
    assert.match(sessionHudHtml, /#hud \{[\s\S]*gap:\s*6px;[\s\S]*\}/);
  });

  it("挂了附件时多出来的一行，两侧数字也一致", () => {
    // 标签行 24 + 卡片自己的一个行距 4 = 28；主卡片 66 + 28 = 94
    assert.strictEqual(hudTest.QUICK_ATTACH_ROW.height, 24);
    assert.strictEqual(hudTest.QUICK_ATTACH_EXTRA, 24 + 4);
    assert.match(sessionHudHtml, /\.quick-attach-row \{[\s\S]*?height:\s*24px;[\s\S]*?\}/);
    assert.match(sessionHudHtml, /body\.has-attachments \.quick-card \{ height: 94px; \}/);
    assert.strictEqual(hudTest.QUICK_CARD.height + hudTest.QUICK_ATTACH_EXTRA, 94);
  });

  it("强度刻度与滑块把手对齐（左右让出半个把手的宽度）", () => {
    // 把手 14px → 半个 7px：刻度行左右各 7px，每个刻度零宽 + 文字居中溢出，
    // 文字中心才正好落在把手能到的那 5 个位置上。
    assert.match(sessionHudHtml, /\.quick-effort-slider::-webkit-slider-thumb \{[\s\S]*?width:\s*14px;[\s\S]*?\}/);
    assert.match(sessionHudHtml, /\.quick-effort-ticks \{[\s\S]*?padding:\s*0 7px;[\s\S]*?\}/);
    assert.match(sessionHudHtml, /\.quick-effort-ticks span \{[\s\S]*?width:\s*0;[\s\S]*?text-align:\s*center;[\s\S]*?\}/);
  });

  it("齿轮和「＋」是同款方块，都只画图标不写字", () => {
    // 同一套尺寸：26×26、圆角 6px、图标居中。
    for (const sel of ["quick-settings-btn", "quick-attach-btn"]) {
      assert.match(sessionHudHtml, new RegExp(`\\.${sel} \\{[\\s\\S]*?flex:\\s*0 0 26px;[\\s\\S]*?height:\\s*26px;[\\s\\S]*?\\}`));
      assert.match(sessionHudHtml, new RegExp(`\\.${sel} \\{[\\s\\S]*?border-radius:\\s*6px;[\\s\\S]*?\\}`));
      assert.match(sessionHudHtml, new RegExp(`\\.${sel} \\{[\\s\\S]*?justify-content:\\s*center;[\\s\\S]*?\\}`));
    }
    assert.match(sessionHudHtml, /\.quick-settings-icon \{[\s\S]*?\}/);
    // 两个按钮里都只有图标，没有文字（这一行的宽度留给输入框）
    assert.doesNotMatch(sessionHudRenderer, /quick-settings-text/);
    assert.doesNotMatch(sessionHudHtml, /quick-settings-text/);
    assert.match(sessionHudRenderer, /attachBtn\.textContent = "\+";/);
    assert.doesNotMatch(sessionHudRenderer, /attachBtn\.textContent = "📎"/);
  });

  it("「＋」在输入框左边、齿轮在右边（都不在状态行上）", () => {
    const inputRow = sessionHudRenderer.slice(sessionHudRenderer.indexOf("function createInputRow()"));
    // 按「装进这一行」的先后顺序看（而不是按创建顺序——输入框是最后 append 的）
    const attachIdx = inputRow.indexOf("inputRow.appendChild(attachBtn)");
    const inputIdx = inputRow.indexOf("inputRow.appendChild(promptInputEl)");
    const gearIdx = inputRow.indexOf("inputRow.appendChild(settingsBtnEl)");
    assert.ok(attachIdx > 0 && inputIdx > 0 && gearIdx > 0, "都在 createInputRow 里");
    assert.ok(attachIdx < inputIdx, "「＋」排在输入框前面（左侧）");
    assert.ok(gearIdx > inputIdx, "齿轮排在输入框后面（右侧）");
    // 状态行只剩「目标会话」这一个可点区域
    const statusRow = sessionHudRenderer.slice(
      sessionHudRenderer.indexOf("function createStatusRow()"),
      sessionHudRenderer.indexOf("function createInputRow()")
    );
    assert.doesNotMatch(statusRow, /quick-settings-btn/);
  });

  it("卡片下方 30px 壳内不放任何节点（输入法净空）", () => {
    // 净空靠 body padding，不在卡片里；渲染端不应往卡片下方塞节点。
    const cardClose = sessionHudHtml.indexOf("</style>");
    assert.ok(cardClose > 0);
    assert.doesNotMatch(sessionHudRenderer, /ime-clearance|imeClearance/);
    assert.match(sessionHudHtml, /输入法候选窗/);
  });
});
