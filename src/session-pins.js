"use strict";

// 会话置顶：把常聊的会话钉在面板列表最上面，重启还在。
//
// 存法照抄「会话别名」（src/session-alias.js）：clawd-prefs.json 里一个
// key -> 值的对象。key 复用别名那套归一化，省得两边各写一份对不上的规则。

const { sessionAliasKey } = require("./session-alias");

// 上限：跟历史仓的上限（200 个文件）对齐。真到 200 条的时候，排在最后面的
// 那些本来也永远不会被渲染到面板上。
const MAX_SESSION_PINS = 200;
const MAX_PIN_KEY_LENGTH = 200;

/**
 * 一条会话的置顶 key。
 *
 * 只跟 agent 与 session id 有关，**不带 profile、cwd、host**——这三个都是
 * 有意为之：
 *   - 历史会话那几行（session-history-loader.js）刻意不把 profile / 目录路径
 *     放进行对象里（那些行要过 IPC 去 Dashboard），带上 profile 的话，
 *     "会话还活着时置顶 -> 结束后在历史里认不出是同一条"，正好破坏连续性。
 *   - host 只在远程/WSL 会话上有，而历史行没有远程这个概念；带上它同样会失配。
 * 代价：不同 profile 下同名的 session id 会共用一条置顶记录。这条是最新版
 * Claude Code 才有的场景（本机只用默认 profile），先记在这儿。
 */
function sessionPinKey(agentId, sessionId) {
  const key = sessionAliasKey("local", agentId, sessionId);
  if (!key || key.length > MAX_PIN_KEY_LENGTH) return null;
  return key;
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * 校验并归一化整个置顶表。脏数据一律丢掉而不是整个作废——一个坏条目不该把
 * 用户其余的置顶全废掉。超过上限时留最近钉的那几条。
 */
function normalizeSessionPins(value) {
  if (!isPlainObject(value)) return {};
  const entries = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key !== "string") continue;
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > MAX_PIN_KEY_LENGTH) continue;
    if (!isPlainObject(entry)) continue;
    const pinnedAt = Number(entry.pinnedAt);
    if (!Number.isFinite(pinnedAt) || pinnedAt <= 0) continue;
    entries.push([trimmed, { pinnedAt }]);
  }
  // 最近的排前面，同刻按 key 定序，保证同样的输入永远归一成同样的结果
  entries.sort((a, b) => b[1].pinnedAt - a[1].pinnedAt || a[0].localeCompare(b[0]));
  const out = {};
  for (const [key, entry] of entries.slice(0, MAX_SESSION_PINS)) out[key] = entry;
  return out;
}

// 置顶**不过期**：历史会话本来就是"可能永远不再出现"的东西，按时间清掉会让
// 用户下周回来发现钉的东西没了。只受上限约束。
function pruneSessionPins(value) {
  return normalizeSessionPins(value);
}

module.exports = {
  MAX_SESSION_PINS,
  MAX_PIN_KEY_LENGTH,
  sessionPinKey,
  normalizeSessionPins,
  pruneSessionPins,
};
