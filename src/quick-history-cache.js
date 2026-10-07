"use strict";

// 面板（快捷输入卡片）用的历史会话缓存。
//
// 历史是从磁盘读出来的：读目录、逐条看文件、探每个会话的 transcript。面板的状态
// 投影每次会话动静都会重算一遍，绝不能把读盘挂在上面。所以：只在会话菜单真的
// 打开时读一次，之后 TTL 之内复用同一份。
//
// 这层只在主进程内存里，不落盘；读失败也不缓存，下次打开菜单会再试一次。

const DEFAULT_TTL_MS = 5000;

function createQuickHistoryCache({ load, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  let cached = null;
  let inflight = null;

  function isFresh() {
    return !!cached && !cached.stale && now() - cached.loadedAt < ttlMs;
  }

  // 命中 TTL 时同步就有结果（返回的也是 Promise，调用方一视同仁）。
  function get(options = {}) {
    if (options.force !== true && isFresh()) return Promise.resolve(cached);
    if (inflight) return inflight; // 同一时间窗里只读一次盘
    inflight = Promise.resolve()
      .then(() => load())
      .then((result) => {
        const rows = Array.isArray(result && result.rows) ? result.rows : [];
        const truncated = Number.isFinite(result && result.truncated)
          ? Math.max(0, Math.floor(result.truncated))
          : 0;
        cached = { rows, truncated, loadedAt: now() };
        return cached;
      })
      // 读失败时退回上一次的结果（哪怕是空的）。不缓存失败，下次还会再试。
      .catch(() => cached || { rows: [], truncated: 0, loadedAt: now() })
      .finally(() => { inflight = null; });
    return inflight;
  }

  // 同步看一眼当前缓存（不触发读盘）。面板的状态投影是同步算的，只能用它；
  // 读盘由 get() 在菜单打开时发起，读完再推一次状态。
  function peek() {
    return cached;
  }

  // 续跑刚提交过：那个人可能马上就活过来了，历史列表得重读一次。
  // 只标过期、不清空——重读落地之前 peek() 还能拿到上一份，列表不会闪一下空。
  function invalidate() {
    if (cached) cached = { ...cached, stale: true };
  }

  return { get, peek, invalidate };
}

module.exports = { createQuickHistoryCache, DEFAULT_TTL_MS };
