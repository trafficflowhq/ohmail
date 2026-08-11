import type { EngineMessage } from "@ohmail/client-engine";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   CONVERSATION ROWS FOR THE OHBOX LIST
   ══════════════════════════════════════════════════════════════════════════════════════════

   Five unread replies in one conversation used to be five rows in "New for you" — the list
   rendered one row per unread MESSAGE by design, and the only thing that ever grouped was the
   demo world (whose fixtures carry a `threadCount` no live row has). The data was never the
   gap: every mirror row carries `threadId`. This module is the missing view-layer step — it
   folds one SECTION's rows into one row per conversation, derived entirely client-side.

   ── GROUPING IS PER SECTION, NOT PER MAILBOX ────────────────────────────────────────────────

   The caller groups "New for you" and "Earlier" separately, AFTER the view's session placement
   has decided which rows each section shows. A thread with unread mail in New and read history
   in Earlier therefore shows one row in each — the sections answer different questions ("what
   is waiting" / "what was read"), and collapsing across them would make a conversation's unread
   row disappear because its history was long. Resurfaced rows and the server-paged "Older" tail
   are deliberately NOT grouped: a resurfaced row is a per-message "you asked to see this again",
   and the tail is a bounded server page whose membership this client cannot see all of.

   ── ORDER: THE FIRST MEMBER KEEPS THE ROW'S PLACE ───────────────────────────────────────────

   A group renders at its first member's position in the section's own order, so grouping never
   re-sorts a section. That is also what keeps a live arrival IN PLACE: the view's session
   placement appends a new unread's id to the end of its session order, and folding it into the
   conversation's existing group leaves the row where it was — the count and the newest snippet
   change, the row does not move and no second row appears.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

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
