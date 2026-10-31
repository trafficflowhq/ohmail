import { THREAD_JOIN_HEAL_MAX_GROUPS, type ThreadJoinHealCursor, type ThreadJoinHealResult } from "./thread-join-heal.js";

/**
 * THE CYCLE TAIL'S THREAD-JOIN HEAL WALK: the six-hour gate and each account's resume point. One heal
 * slice runs under the tail's slice clock and may stop between two groups (`cut`); the account then stays
 * owed, and the gate stays open for the following tail walks until every account of this walk has spent
 * its group budget, its time budget (`walkMs`, summed over its slices) or reached the end. The time budget
 * is what ends a walk whose slices are each cut after a group or two: without it such an account stayed
 * owed for hundreds of tails. A walk never outlives its period: when the next one starts, an unfinished
 * account's cursor is carried into it. The walk also holds each account's widespread-address memo for the
 * pass, so the account-wide witness read runs once per account per walk, not once per slice. In memory
 * only, so a leader handover starts from the top.
 */
export interface ThreadJoinHealWalk {
  /** Is a heal walk running or due at `now`. Starts a new walk once the period has passed. */
  due(now: number): boolean;
  /** What this account's next slice takes, or null when it is done for this walk. */
  slice(accountId: string, accounts: readonly string[]): {
    cursor?: ThreadJoinHealCursor; maxGroups: number; widespread: Map<string, ReadonlySet<string>>;
  } | null;
  /** Records a slice's result and the time it took; returns the account's totals when this closed its walk. */
  settle(accountId: string, r: ThreadJoinHealResult, ms: number): ThreadJoinHealWalkClosed | null;
  /** The slice threw: the account is done for this walk and keeps its last settled cursor. */
  abandon(accountId: string): void;
}

/** One account's walk as it closed; `more` ⇒ it closed with groups left (budget or time spent). */
export interface ThreadJoinHealWalkClosed { scanned: number; slices: number; ms: number; more: boolean }

interface Owed { cursor?: ThreadJoinHealCursor; left: number; spentMs: number; slices: number; scanned: number; done: boolean }

export function makeThreadJoinHealWalk(everyMs: number, walkMs: number): ThreadJoinHealWalk {
  let startedAt: number | null = null;
  let owed = new Map<string, Owed>();
  /** Resume points carried from one walk into the next. */
  const carried = new Map<string, ThreadJoinHealCursor>();
  /** Each owed account's widespread addresses, filled by its first slice and dropped when it closes. */
  const widespread = new Map<string, ReadonlySet<string>>();

  const carry = (accountId: string, cursor: ThreadJoinHealCursor | null | undefined): void => {
    if (cursor) carried.set(accountId, cursor);
    else carried.delete(accountId);
  };
  const close = (accountId: string, e: Owed): void => {
    e.done = true;
    widespread.delete(accountId);
    if (e.cursor) carried.set(accountId, e.cursor);
  };

  return {
    due(now) {
      if (startedAt === null || now - startedAt >= everyMs) {
        for (const [accountId, e] of owed) if (!e.done) close(accountId, e);
        owed = new Map();
        widespread.clear();
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
        e = { left: THREAD_JOIN_HEAL_MAX_GROUPS, spentMs: 0, slices: 0, scanned: 0, done: false, ...(cursor ? { cursor } : {}) };
        owed.set(accountId, e);
      }
      if (e.done) return null;
      return { ...(e.cursor ? { cursor: e.cursor } : {}), maxGroups: e.left, widespread };
    },

    settle(accountId, r, ms) {
      const e = owed.get(accountId);
      if (!e || e.done) return null;
      e.left -= r.groupsScanned;
      e.scanned += r.groupsScanned;
      e.spentMs += Math.max(0, ms);
      e.slices += 1;
      if (r.cut && r.cursor && e.left > 0 && e.spentMs < walkMs) {
        e.cursor = r.cursor;
        return null;
      }
      e.done = true;
      widespread.delete(accountId);
      // Capped, or cut with its group or time budget spent: the next walk resumes here. Exhausted: from the top.
      const more = (r.capped || r.cut) && r.cursor !== null;
      carry(accountId, more ? r.cursor : null);
      return { scanned: e.scanned, slices: e.slices, ms: e.spentMs, more };
    },

    abandon(accountId) {
      const e = owed.get(accountId);
      if (e && !e.done) close(accountId, e);
    },
  };
}
