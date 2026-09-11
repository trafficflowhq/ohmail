import type { EngineMessage } from "@ohmail/client-engine";

/*
 * Conversation rows for the Ohbox list. Five unread replies in one conversation used to be five
 * rows in "New for you"; every mirror row carries `threadId`, and this module is the missing
 * view-layer step — it folds one SECTION's rows into one row per conversation, client-side.
 * Grouping is per section, not per mailbox: the caller groups "New for you" and "Earlier"
 * separately, AFTER session placement, so a thread with unread mail in New and read history in
 * Earlier shows one row in each — the sections answer different questions, and collapsing across
 * them would make a conversation's unread row disappear because its history was long. Resurfaced
 * rows and the server-paged "Older" tail are deliberately not grouped.
 */

/*
 * Per-section grouping is also what makes reading through a conversation behave: reading one of
 * five unread replies moves that MESSAGE to "Earlier" (the unit the read state lives on), so the
 * New row folds from four members and its count says so — the conversation stops being listed as
 * waiting only when its last unread member has gone. Order: a group renders at its first member's
 * position in the section's own order, so grouping never re-sorts a section; a live arrival merges
 * in at the slot the selector's date order gives it, so a new unread reply SURFACES its
 * conversation's row, while an old member delivered late (a mirror backfill) merges below and moves
 * nothing. Either way the count and newest snippet update and no second row appears.
 */

/** One rendered row of a grouped section: a conversation, or a lone message. */
export interface OhboxRowGroup {
  /**
   * Stable render key — the `threadId` for a conversation, `msg:<id>` for a row with no
   * thread. Thread-keyed so the DOM row survives its newest-unread representative changing
   * when another reply arrives.
   */
  key: string;
  /** The section rows folded into this row, in the section's own order. */
  members: EngineMessage[];
  /** The newest member by send time — the row shows ITS snippet and time. */
  latest: EngineMessage;
  /**
   * The message a click or ↵ acts on: the LATEST UNREAD member, else {@link latest}. Opening
   * the row is opening this message — the ordinary per-message open, so the thread view, the
   * read-state dwell and the `\Seen` commit all behave exactly as they do for a plain row.
   */
  openTarget: EngineMessage;
  /** How many members are unread — the row's dot, and (via the member count) its `⤷ N`. */
  unreadCount: number;
}

/**
 * A send instant for ordering members within one group. `null`, absent and unparseable all
 * collapse to "older than anything dated" — the same rule the Ohbox's own comparators follow —
 * so an undated row can represent a conversation only when nothing dated is present.
 */
export function sendTimeOf(m: EngineMessage): number {
  const t = m.date ? Date.parse(m.date) : Number.NaN;
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/** The newest member by send time; ties keep the earlier one in section order (stable). */
function latestOf(members: readonly EngineMessage[]): EngineMessage {
  let best = members[0]!;
  for (const m of members) if (sendTimeOf(m) > sendTimeOf(best)) best = m;
  return best;
}

function toGroup(key: string, members: EngineMessage[]): OhboxRowGroup {
  const latest = latestOf(members);
  const unread = members.filter((m) => m.unread);
  return {
    key,
    members,
    latest,
    openTarget: unread.length > 0 ? latestOf(unread) : latest,
    unreadCount: unread.length,
  };
}

/** A one-message group, threadless on purpose — used for the sections that do not fold. */
export function singletonGroup(m: EngineMessage): OhboxRowGroup {
  return { key: `msg:${m.id}`, members: [m], latest: m, openTarget: m, unreadCount: m.unread ? 1 : 0 };
}

/**
 * Fold one section's rows into one row per conversation. Rows without a `threadId` stay
 * themselves. Section order is preserved — see the module header.
 */
export function groupSection(rows: readonly EngineMessage[]): OhboxRowGroup[] {
  const order: string[] = [];
  const membersOf = new Map<string, EngineMessage[]>();
  for (const m of rows) {
    // `msg:` prefixes the threadless key so a thread id can never collide with a message id.
    const key = m.threadId ?? `msg:${m.id}`;
    const members = membersOf.get(key);
    if (members) {
      members.push(m);
    } else {
      membersOf.set(key, [m]);
      order.push(key);
    }
  }
  return order.map((key) => toGroup(key, membersOf.get(key)!));
}
