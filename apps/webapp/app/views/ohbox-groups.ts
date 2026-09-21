import {
  isItipAcknowledgement, resurfacedFocus, type EngineMessage, type ResurfacedThreadRow,
} from "@ohmail/client-engine";

/*
 * Conversation rows for the Ohbox list. Five unread replies in one conversation used to be five
 * rows in "New for you"; every mirror row carries `threadId`, and this module is the missing
 * view-layer step — it folds one SECTION's rows into one row per conversation, client-side.
 * Grouping is per section, not per mailbox: the caller groups "New for you" and "Earlier"
 * separately, AFTER session placement, so a thread with unread mail in New and read history in
 * Earlier shows one row in each — the sections answer different questions, and collapsing across
 * them would make a conversation's unread row disappear because its history was long.
 */

/*
 * Resurfaced folds too, by the ENGINE's row ({@link groupResurfaced}) rather than this module's
 * rule: the pin is per message and the conversation is what the reader asked to see again, so the
 * fold, the badge and the open target are one derivation the phone reads as well. Only the
 * server-paged "Older" tail is left whole — it is not this client's to fold.
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
  /**
   * The member whose snippet and time the row shows — the newest one a PERSON wrote. A calendar
   * client's acknowledgement is a member like any other and never the face; see
   * {@link facingMemberOf}.
   */
  latest: EngineMessage;
  /**
   * The message a click or ↵ acts on: the LATEST UNREAD member, else {@link latest}. Opening
   * the row is opening this message — the ordinary per-message open, so the thread view, the
   * read-state dwell and the `\Seen` commit all behave exactly as they do for a plain row.
   */
  openTarget: EngineMessage;
  /** How many members are unread — the row's dot, and (via the member count) its `⤷ N`. */
  unreadCount: number;
  /**
   * PRESENT ONLY ON A RESURFACED ROW, and its presence is what says this row is one. The three
   * facts arrive together from `resurfacedThreads` or not at all — a row cannot have a badge and
   * no pin, or a server count and no badge — so they are ONE field rather than three optionals
   * that could disagree. `count` is the conversation's length as the server knows it, `newSince`
   * how many unread messages arrived after the pin went up, `pinned` what Done acts on.
   */
  resurfaced?: { count: number; newSince: number; pinned: EngineMessage[] };
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

/**
 * THE MEMBER WHOSE WORDS THE ROW SHOWS — the newest one a PERSON wrote.
 *
 * A calendar client's acknowledgement is newest by send time the moment it is sent, so unheld it
 * takes the conversation's face and the row reads "Accepted: …" over what somebody wrote. Held
 * out here it stays an ordinary member: the count, the history and the open target are untouched.
 * All-acknowledgement conversations fall back to {@link latestOf} — a row with no face is not a row.
 */
function facingMemberOf(members: readonly EngineMessage[]): EngineMessage {
  const human = members.filter((m) => !isItipAcknowledgement(m));
  return human.length > 0 ? latestOf(human) : latestOf(members);
}

function toGroup(key: string, members: EngineMessage[]): OhboxRowGroup {
  const latest = facingMemberOf(members);
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

/**
 * THE RESURFACED BLOCK, FOLDED — the engine's rows laid over the section's own display order.
 *
 * The fold is the ENGINE's ({@link ResurfacedThreadRow}): which conversations are back, what
 * opening one lands on and what arrived since are one derivation, and the phone reads the same.
 * This maps it onto the rows actually on screen, because the block keeps its session placement
 * and its slide — a member released by Done is still displayed for the length of that slide while
 * the engine has already dropped its row. Such a row falls back to {@link toGroup}, which is the
 * right degradation: no badge, no pin, its own members counted.
 */
export function groupResurfaced(
  rows: readonly ResurfacedThreadRow[],
  displayed: readonly EngineMessage[],
): OhboxRowGroup[] {
  const rowOf = new Map(rows.map((r) => [r.key, r]));
  const order: string[] = [];
  const membersOf = new Map<string, EngineMessage[]>();
  for (const m of displayed) {
    const key = m.threadId ?? `msg:${m.id}`;
    const members = membersOf.get(key);
    if (members) members.push(m);
    else {
      membersOf.set(key, [m]);
      order.push(key);
    }
  }
  return order.map((key) => {
    const members = membersOf.get(key)!;
    const row = rowOf.get(key);
    if (!row) return toGroup(key, members);
    // The engine's focus, but only while it is still on screen: during a slide the displayed
    // members are a subset, and a target the row cannot show is a click going nowhere — so the
    // same rule is re-asked over the members in hand. The FACE is the focus too: a resurfaced
    // row shows what came back, not the account's own answer standing in for it (2026-09-21).
    const shown = new Set(members.map((m) => m.id));
    const focus = shown.has(row.openTarget.id)
      ? row.openTarget
      : resurfacedFocus(members, row.pinned.filter((m) => shown.has(m.id)));
    return {
      key,
      members,
      latest: focus,
      openTarget: focus,
      unreadCount: members.filter((m) => m.unread).length,
      resurfaced: {
        count: row.count,
        newSince: row.newSince.length,
        pinned: row.pinned.filter((m) => shown.has(m.id)),
      },
    };
  });
}
