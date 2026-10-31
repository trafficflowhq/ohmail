import { THREAD_JOIN_HEAL_MAX_GROUPS, type ThreadJoinHealCursor, type ThreadJoinHealResult } from "./thread-join-heal.js";

/**
 * THE CYCLE TAIL'S THREAD-JOIN HEAL WALK: the six-hour gate and each account's resume point. One heal
 * slice runs under the tail's slice clock and may stop between two groups (`cut`); the account then stays
 * owed, and the gate stays open for the following tail walks until every account of this walk has spent
 * its group budget or reached the end. A walk never outlives its period: when the next one starts, an
 * unfinished account's cursor is carried into it. In memory only, so a leader handover starts from the top.
 */
export interface ThreadJoinHealWalk {
  /** Is a heal walk running or due at `now`. Starts a new walk once the period has passed. */
  due(now: number): boolean;
  /** What this account's next slice takes, or null when it is done for this walk. */
  slice(accountId: string, accounts: readonly string[]): { cursor?: ThreadJoinHealCursor; maxGroups: number } | null;
  /** Records a slice's result. */
  settle(accountId: string, r: ThreadJoinHealResult): void;
  /** The slice threw: the account is done for this walk and keeps its last settled cursor. */
  abandon(accountId: string): void;
}

interface Owed { cursor?: ThreadJoinHealCursor; left: number; done: boolean }

export function makeThreadJoinHealWalk(everyMs: number): ThreadJoinHealWalk {
  let startedAt: number | null = null;
  let owed = new Map<string, Owed>();
  /** Resume points carried from one walk into the next. */
  const carried = new Map<string, ThreadJoinHealCursor>();

  const carry = (accountId: string, cursor: ThreadJoinHealCursor | null | undefined): void => {
    if (cursor) carried.set(accountId, cursor);
    else carried.delete(accountId);
  };
  const close = (accountId: string, e: Owed): void => {
    e.done = true;
    if (e.cursor) carried.set(accountId, e.cursor);
  };

  return {
    due(now) {
      if (startedAt === null || now - startedAt >= everyMs) {
        for (const [accountId, e] of owed) if (!e.done) close(accountId, e);
        owed = new Map();
        startedAt = now;
        return true;
      }
      for (const e of owed.values()) if (!e.done) return true;
      return false;
    },

    slice(accountId, accounts) {
      const present = new Set(accounts);
      for (const [id, e] of owed) if (!e.done && !present.has(id)) close(id, e);
      let e = owed.get(accountId);
      if (!e) {
        const cursor = carried.get(accountId);
        carried.delete(accountId);
        e = { left: THREAD_JOIN_HEAL_MAX_GROUPS, done: false, ...(cursor ? { cursor } : {}) };
        owed.set(accountId, e);
      }
      if (e.done) return null;
      return { ...(e.cursor ? { cursor: e.cursor } : {}), maxGroups: e.left };
    },

    settle(accountId, r) {
      const e = owed.get(accountId);
      if (!e || e.done) return;
      e.left -= r.groupsScanned;
      if (r.cut && r.cursor && e.left > 0) {
        e.cursor = r.cursor;
        return;
      }
      e.done = true;
      // Capped, or a cut that spent the budget: the next walk resumes here. Exhausted: from the top.
      carry(accountId, r.capped || r.cut ? r.cursor : null);
    },

    abandon(accountId) {
      const e = owed.get(accountId);
      if (e && !e.done) close(accountId, e);
    },
  };
}
