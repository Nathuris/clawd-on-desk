"use strict";

const {
  loadResumableSessionHistoryWithStats,
  resolveResumeTarget,
  resolveHistoryIdentity,
} = require("./session-history-loader");
const { sessionAliasKey } = require("./session-alias");

const RESUME_CONFIRMATION_MS = 30_000;

// One owner in main, surviving Dashboard recreation. Terminal spawn is only
// submission; the normal hook/state path is the evidence that a session is live.
function createSessionHistoryRuntime({ getSessions, isAgentEnabled, launchClaudeSession,
  historyOptions = {}, getSessionAliases = null, now = Date.now } = {}) {
  const launches = new Map();

  function activeIds() {
    const ids = new Set();
    for (const session of getSessions().values()) {
      if (session.agentId === "claude-code" && (session.profileId || "local") === "local"
        && !session.host && !session.wslDistro && session.rawSessionId) {
        ids.add(session.rawSessionId);
      }
    }
    for (const [historyKey, entry] of launches) {
      if (!entry.launching && (ids.has(entry.sessionId) || now() >= entry.retryAt)) {
        launches.delete(historyKey);
      }
    }
    return ids;
  }

  // 用户给会话起过的名字（会话别名）。历史行的名字本来是从对话记录里现读的，
  // 会话一关，用户起过的名字就丢了、退回成一串会话编号——这正是"关了会话名字
  // 变乱码"的来头。所以这里先查别名，查到就用它。
  // key 跟会话还活着时（state-session-snapshot）算的是同一套，用的是同一个
  // rawSessionId，所以"运行中起的名字 -> 关掉后还在"是接得上的。
  function aliasFor(row) {
    if (typeof getSessionAliases !== "function") return null;
    let aliases = null;
    try {
      aliases = getSessionAliases();
    } catch {
      return null;
    }
    if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return null;
    const key = sessionAliasKey("local", row.agentId, row.sessionId, { cwd: row.cwd });
    const entry = key ? aliases[key] : null;
    return entry && typeof entry.title === "string" && entry.title ? entry.title : null;
  }

  function annotate(rows) {
    return rows.map((row) => {
      const alias = aliasFor(row);
      if (alias) row = { ...row, title: alias, hasAlias: true };
      // Live state currently identifies local Claude sessions by raw id,
      // not by CLAUDE_CONFIG_DIR. Treat every profile row with that raw id
      // as one conservative launch unit so two Dashboard clicks cannot
      // create processes that immediately collapse into the same live key.
      const pending = launches.get(row.historyKey)
        || [...launches.values()].find((entry) => entry.sessionId === row.sessionId);
      return { ...row, resumePending: !!pending, resumeRetryAt: pending?.retryAt || null };
    });
  }

  // 现在到底有哪些"点了续跑、还没等到它报到"的会话。
  //
  // 为什么不能直接用行上的 resumePending：面板的历史是**缓存**的，缓存里那个
  // 字段是读盘那一刻的快照。会话起来又关掉之后，面板还拿着旧的 true 在画，
  // 那行就一直写着「已提交，等终端上报」，过一会儿才对。
  // 这里顺带跑一次 activeIds()：它会把"已经被看到活着"的续跑记录清掉——所以
  // 只要会话真的起来过，这一次查询就不会再把它算成待确认。
  function pendingResumes() {
    const active = activeIds();
    const historyKeys = new Set();
    const sessionIds = new Set();
    for (const [historyKey, entry] of launches) {
      if (entry.launching) continue;
      historyKeys.add(historyKey);
      sessionIds.add(entry.sessionId);
    }
    return { historyKeys, sessionIds, activeRawSessionIds: active };
  }

  // 面板要比 Dashboard 多知道一件事：有多少条被 limit 截掉了（好如实说
  // 「还有 N 条更早的」），所以另开一个带统计的入口，getHistory 保持原样。
  function getHistoryWithStats() {
    const activeRawSessionIds = activeIds();
    const { rows, truncated } = loadResumableSessionHistoryWithStats({
      ...historyOptions, isAgentEnabled, activeRawSessionIds,
    });
    return { rows: annotate(rows), truncated };
  }

  function getHistory() {
    return getHistoryWithStats().rows;
  }

  async function resume({ agentId, historyKey }) {
    if (agentId !== "claude-code" || !isAgentEnabled(agentId)) {
      return { status: "error", reason: "agent-unavailable" };
    }
    const target = resolveResumeTarget(agentId, historyKey, { ...historyOptions, isAgentEnabled });
    if (!target) return { status: "error", reason: "unresolvable" };
    if (activeIds().has(target.sessionId)) return { status: "already-running" };
    const pending = launches.get(historyKey);
    if (pending) return pending.promise;
    const sameSessionPending = [...launches.values()]
      .find((entry) => entry.sessionId === target.sessionId);
    if (sameSessionPending) return sameSessionPending.promise;
    // Bound memory even if a compromised trusted renderer asks for many rows.
    if (launches.size >= 200) return { status: "error", reason: "busy" };
    const entry = {
      sessionId: target.sessionId,
      launching: true,
      retryAt: now() + RESUME_CONFIRMATION_MS,
      promise: null,
    };
    launches.set(historyKey, entry);
    entry.promise = Promise.resolve().then(async () => {
      let submitted = false;
      try {
        // Gate again at dispatch, in case settings changed before this microtask.
        if (!isAgentEnabled(agentId)) return { status: "error", reason: "agent-unavailable" };
        if (activeIds().has(target.sessionId)) return { status: "already-running" };
        const result = await launchClaudeSession("resume", target.cwd, target.sessionId, target.profile);
        if (!result || result.ok !== true) {
          return { status: "error", reason: "launch-failed", message: result?.message };
        }
        entry.retryAt = now() + RESUME_CONFIRMATION_MS;
        submitted = true;
        return { status: "submitted", retryAt: entry.retryAt };
      } catch (err) {
        return { status: "error", reason: "launch-failed", message: err && err.message };
      } finally {
        entry.launching = false;
        if (!submitted) launches.delete(historyKey);
      }
    });
    return entry.promise;
  }

  // 面板置顶要用：把一条历史行的不透明 key 还原成"哪个 agent 的哪个会话"。
  // 走同一个 historyOptions，免得两处读的存储目录哪天对不上。
  function resolveIdentity(agentId, historyKey) {
    return resolveHistoryIdentity(agentId, historyKey, historyOptions);
  }

  return { getHistory, getHistoryWithStats, resume, resolveIdentity, pendingResumes };
}

module.exports = { createSessionHistoryRuntime, RESUME_CONFIRMATION_MS };
