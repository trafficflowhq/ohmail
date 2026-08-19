/**
 * The ohmail demo world as a pure state machine.
 *
 * No React, no React Native, no I/O — every function here is
 * `(state, …) => state`. Two reasons, both load-bearing:
 *
 *  1. **The rules are testable without a renderer.** Screener seen-semantics,
 *     the scroll-seen waterline, tag filtering and the no-collapse manifest are
 *     all asserted by the root vitest suite against this module directly.
 *  2. **The screens can hold no logic of their own.** Whatever a screen shows,
 *     it shows by iterating one of the selectors in `derived.ts`. That is what
 *     makes `renderManifest()` a real promise rather than a comment: a list
 *     that quietly collapsed into "12 more" would drop identities from the
 *     manifest and fail the suite.
 *
 * Ported from the retired native macOS client's state machine, which was the
 * reference implementation of these semantics. Where the two differed, the
 * difference is noted at the call site.
 */
import {
  account,
  composeDraft,
  counts,
  mailboxes,
  notificationSettings,
  ohbox as ohboxFixture,
  reads as readsFixture,
  readsAiChip,
  readsWaterline,
  receipts as receiptsFixture,
  receiptsGroups,
  screenedOut,
  screenerEmptyStates,
  search as searchFixture,
  spam as spamFixture,
  tags as tagFixtures,
  triage as triageFixture,
  waiting as waitingFixture,
  type AttachmentFixture,
  type InlineArtFixture,
  type MessageFixture,
  type ProtectedFixture,
  type TagId,
} from "@ohmail/fixtures";

/* ------------------------------------------------------------------ types */

export type Place = "ohbox" | "reads" | "receipts";
export type Destination = Place | "screened" | "spam";
export type Scope = "sender" | "domain";
export type PileKind = "replyLater" | "setAside" | "resurface";
export type ScreenerSeg = "waiting" | "screened" | "spam";

export interface Address {
  name: string;
  address: string;
}

/** One message inside a held bag or a conversation. Always its own identity. */
export interface Held {
  id: string;
  subject: string;
  time: string;
  body: string;
  trackerNote?: string;
  seen: boolean;
}

export interface Mail {
  id: string;
  place: Place;
  from: Address;
  subject: string;
  time: string;
  body: string;
  snippet?: string;
  unread: boolean;
  rationale?: string;
  trackerNote?: string;
  amount?: string;
  attachment?: AttachmentFixture;
  protected?: ProtectedFixture;
  art?: InlineArtFixture;
  /**
   * The rest of the conversation, oldest → newest, excluding this message.
   * Rendered in full in the reading view — never summarised into a count.
   */
  earlier: Held[];
}

export interface WaitingSender {
  id: string;
  from: Address;
  initial: string;
  time: string;
  scope: Scope;
  dull: boolean;
  ai: { dest: Destination; confidence: number; rationale: string };
  held: Held[];
}

export interface ScreenedSender {
  id: string;
  address: string;
  screenedOn: string;
  held: Held[];
}

export interface SpamSender {
  id: string;
  from: string;
  detection: string;
  held: Held[];
}

export interface PileItem {
  id: string;
  messageId?: string;
  title: string;
  subtitle?: string;
  preview?: string;
  resurfaceAt?: string;
}

export interface Pile {
  kind: PileKind;
  title: string;
  note: string;
  items: PileItem[];
}

export interface Toast {
  id: number;
  message: string;
  /** Present when the action is reversible. */
  undo?: UndoOp;
}

export type UndoOp =
  | { kind: "decision"; snapshot: DecisionSnapshot }
  | { kind: "allow"; sender: ScreenedSender; index: number; newIds: string[]; dest: Place }
  | { kind: "notSpam"; sender: SpamSender; index: number; newIds: string[]; dest: Place };

export interface DecisionSnapshot {
  sender: WaitingSender;
  index: number;
  dest: Destination;
  read: boolean;
  newId?: string;
}

export type ThemePref = "system" | "light" | "dark";

export interface AppState {
  ohbox: Mail[];
  reads: Mail[];
  receipts: Mail[];
  receiptGroups: { label: string; ids: string[] }[];
  waiting: WaitingSender[];
  screened: ScreenedSender[];
  spam: SpamSender[];
  piles: Pile[];
  /** Cross-cutting tags — message ids per tag. Tags never move mail. */
  tagged: Record<TagId, string[]>;
  /** Reads' pending AI classification chip: null once approved or corrected. */
  readsChip: "pending" | "approved" | "corrected";
  themePref: ThemePref;
  notifications: Record<string, boolean>;
  vips: string[];
  /** The learned-pattern suggestion in Settings — dismissible, undoable. */
  vipSuggestion: "open" | "accepted" | "dismissed";
  seq: number;
  toast: Toast | null;
}

/* ------------------------------------------------------- world construction */

const DEST_LABEL: Record<Destination, string> = {
  ohbox: "Ohbox",
  reads: "Reads",
  receipts: "Receipts",
  screened: "Screen out",
  spam: "Spam",
};

/** Past-tense name used in toasts and the AI "suggests…" line. */
export function destDone(d: Destination): string {
  return d === "screened" ? "Screened out" : DEST_LABEL[d];
}
export function destLabel(d: Destination): string {
  return DEST_LABEL[d];
}
export const DESTINATIONS: Destination[] = ["ohbox", "reads", "receipts", "screened", "spam"];

export function isPlace(d: Destination): d is Place {
  return d === "ohbox" || d === "reads" || d === "receipts";
}

function toMail(m: MessageFixture): Mail {
  return {
    id: m.id,
    place: m.folder,
    from: m.from,
    subject: m.subject,
    time: m.time,
    body: m.body ?? m.snippet ?? "",
    snippet: m.snippet,
    unread: m.unread,
    rationale: m.rationale,
    trackerNote: m.trackerNote,
    amount: m.amount,
    attachment: m.attachment,
    protected: m.protected,
    art: m.art,
    /**
     * NOTE — the thread badge. `MessageFixture.threadCount` says 4 on Giulia's
     * message, but `packages/fixtures` carries no bodies for the other three;
     * the retired macOS client invented them in its own corpus. Rendering "4"
     * here over one message would be exactly the collapsed count the demo
     * corpus bans (a badge must be backed by mail that actually renders),
     * so the badge is derived from `earlier` instead (see `threadCount()`) and
     * reads 0 until the shared fixtures grow the conversation. Reported, not
     * patched: `packages/fixtures` is out of scope for this app.
     */
    earlier: [],
  };
}

const heldOf = (h: { id: string; subject: string; time: string; body: string; trackerNote?: string }): Held => ({
  ...h,
  seen: false,
});

export function initialState(): AppState {
  return {
    ohbox: ohboxFixture.map(toMail),
    reads: readsFixture.map(toMail),
    receipts: receiptsFixture.map(toMail),
    receiptGroups: receiptsGroups.map((g) => ({ label: g.label, ids: [...g.items] })),
    waiting: waitingFixture.map((w) => ({
      id: w.id,
      from: w.from,
      initial: w.initial,
      time: w.time,
      scope: w.scope,
      dull: w.dull ?? false,
      ai: { dest: w.ai.dest, confidence: w.ai.confidence, rationale: w.ai.rationale },
      held: w.held.map(heldOf),
    })),
    screened: screenedOut.map((s) => ({
      id: s.address,
      address: s.address,
      screenedOn: s.screenedOn,
      held: s.held.map(heldOf),
    })),
    spam: spamFixture.map((s) => ({
      id: s.from,
      from: s.from,
      detection: s.detection.label,
      held: s.held.map(heldOf),
    })),
    piles: [
      {
        kind: "replyLater",
        title: "Answer Later",
        note: "Answers you owe. A Reply Run walks them one screen at a time.",
        items: triageFixture.replyLater.map(pileItem),
      },
      {
        kind: "setAside",
        title: "Parked",
        note: "Kept in view without keeping the Ohbox busy.",
        items: triageFixture.setAside.map(pileItem),
      },
      {
        kind: "resurface",
        title: "Resurface",
        note: "Comes back on its own, at the time you chose.",
        items: triageFixture.resurface.map(pileItem),
      },
    ],
    tagged: Object.fromEntries(tagFixtures.map((t) => [t.id, [...t.assignedTo]])) as Record<
      TagId,
      string[]
    >,
    readsChip: "pending",
    themePref: "system",
    notifications: Object.fromEntries(
      notificationSettings.channels.map((c) => [c.id, c.enabled]),
    ),
    vips: [...notificationSettings.vips],
    vipSuggestion: "open",
    seq: 0,
    toast: null,
  };
}

function pileItem(i: {
  messageId?: string;
  title: string;
  subtitle?: string;
  preview?: string;
  resurfaceAt?: string;
}): PileItem {
  return { id: i.messageId ?? slug(i.title), ...i };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/* ------------------------------------------------------------- fixture refs */

/** Copy the app reads straight from the demo world rather than restating. */
export const world = {
  account,
  mailboxes,
  tags: tagFixtures,
  waterline: readsWaterline,
  readsChip: readsAiChip,
  emptyStates: screenerEmptyStates,
  search: searchFixture,
  composeDraft,
  notificationSettings,
  counts,
} as const;

/* ---------------------------------------------------------------- mutations */

const replace = <T extends { id: string }>(list: T[], id: string, f: (t: T) => T): T[] =>
  list.map((t) => (t.id === id ? f(t) : t));

/**
 * Mark a message seen.
 *
 * Fades the dot in place — no reshuffle — and ticks the "new" count down by
 * one. Idempotent: a message already read stays put and the count does not
 * double-decrement. **Never touches Ohbox**: reading in the Ohbox is
 * non-destructive, so its unread count is an invariant across reading and only
 * a Screener decision can move it.
 */
export function markSeen(s: AppState, id: string): AppState {
  const inReads = s.reads.some((m) => m.id === id && m.unread);
  if (inReads) return { ...s, reads: replace(s.reads, id, (m) => ({ ...m, unread: false })) };
  const inReceipts = s.receipts.some((m) => m.id === id && m.unread);
  if (inReceipts)
    return { ...s, receipts: replace(s.receipts, id, (m) => ({ ...m, unread: false })) };
  return s;
}

/** The scroll-seen waterline: everything the reader has scrolled past is seen. */
export function markSeenThrough(s: AppState, place: "reads" | "receipts", ids: string[]): AppState {
  return ids.reduce(markSeen, s);
}

export function setScope(s: AppState, id: string, scope: Scope): AppState {
  return { ...s, waiting: replace(s.waiting, id, (w) => ({ ...w, scope })) };
}

/** The rule target the decision bar names: one address, or the whole domain. */
export function ruleTarget(w: WaitingSender): string {
  return w.scope === "domain" ? "@" + domainOf(w.from.address) : w.from.address;
}

export function domainOf(addr: string): string {
  return addr.split("@").pop() ?? addr;
}

/**
 * File a waiting sender to a destination.
 *
 * Lossless by construction: **every** held message travels, keeping its id,
 * subject, time, trackers and read state. Filing to a mail place produces one
 * row whose `earlier` array carries the rest of the conversation (so a thread
 * badge is always backed by mail that is actually rendered); Screen out and
 * Spam keep the whole held bag.
 *
 * `read === true` — the "& read" half of every button — marks every held
 * message seen **before** the move. That is what makes "& read" mean the same
 * thing at all five destinations, including Screen out and Spam where there is
 * no unread count but there is still read state. And because the resulting row
 * is inserted already-seen, **the unread count does not move**: `& read` files
 * mail, it does not announce it.
 */
export function decide(
  s: AppState,
  senderId: string,
  dest: Destination,
  read: boolean,
): AppState {
  const index = s.waiting.findIndex((w) => w.id === senderId);
  if (index < 0) return s;
  const sender = s.waiting[index];
  const waiting = s.waiting.filter((w) => w.id !== senderId);
  const bag: Held[] = read ? sender.held.map((h) => ({ ...h, seen: true })) : sender.held;
  const seq = s.seq + 1;
  const snapshot: DecisionSnapshot = { sender, index, dest, read };

  let next: AppState = { ...s, waiting, seq };

  if (isPlace(dest)) {
    const id = `scn${seq}-${sender.id}`;
    snapshot.newId = id;
    const newest = bag[bag.length - 1];
    const row: Mail = {
      id,
      place: dest,
      from: sender.from,
      subject: newest.subject,
      time: sender.time,
      body: bag.map((h) => h.body).join("\n\n— — —\n\n"),
      snippet: firstLine(newest.body),
      unread: !read,
      rationale: `${destDone(dest)} — you said Yes to ${sender.from.address} in the Screener`,
      trackerNote: newest.trackerNote,
      earlier: bag.slice(0, -1),
    };
    if (dest === "receipts") {
      next.receipts = [row, ...s.receipts];
      next.receiptGroups = s.receiptGroups.length
        ? [{ ...s.receiptGroups[0], ids: [id, ...s.receiptGroups[0].ids] }, ...s.receiptGroups.slice(1)]
        : [{ label: "Today", ids: [id] }];
    } else if (dest === "reads") {
      next.reads = read ? insertSeen(s.reads, row) : [row, ...s.reads];
    } else {
      next.ohbox = read ? insertSeen(s.ohbox, row) : [row, ...s.ohbox];
    }
  } else if (dest === "screened") {
    next.screened = [
      { id: sender.from.address, address: sender.from.address, screenedOn: "today", held: bag },
      ...s.screened,
    ];
  } else {
    next.spam = [
      { id: sender.from.address, from: sender.from.address, detection: "marked spam by you", held: bag },
      ...s.spam,
    ];
  }

  const scopeText =
    sender.scope === "domain" ? `the whole domain @${domainOf(sender.from.address)}` : sender.from.address;
  const readNote = read ? " Held mail marked read." : "";
  const message =
    dest === "screened"
      ? `Screened out — ${scopeText}.${readNote}`
      : dest === "spam"
        ? `Marked spam — ${sender.from.address}.${readNote}`
        : `${destDone(dest)} — filed${read ? " · marked read" : ""}. Future mail from ${scopeText} files there automatically.`;

  next.toast = { id: seq, message, undo: { kind: "decision", snapshot } };
  return next;
}

/** A row filed already-seen slots in above the first seen row, not at the top. */
function insertSeen(list: Mail[], row: Mail): Mail[] {
  const at = list.findIndex((m) => !m.unread);
  if (at < 0) return [...list, row];
  return [...list.slice(0, at), row, ...list.slice(at)];
}

function firstLine(body: string): string {
  const line = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return line.length > 96 ? `${line.slice(0, 95)}…` : line;
}

/** Apply every AI suggestion at once. Files unread — the user still has to read. */
export function applyAllSuggestions(s: AppState): AppState {
  const senders = [...s.waiting];
  const after = senders.reduce((acc, w) => decide(acc, w.id, w.ai.dest, false), s);
  return {
    ...after,
    toast: {
      id: after.seq,
      message: `${senders.length} suggestion${senders.length === 1 ? "" : "s"} applied — nothing was read.`,
    },
  };
}

/** Release a screened-out sender's held mail to a place. Never deletes. */
export function allowScreened(s: AppState, id: string, dest: Place): AppState {
  const index = s.screened.findIndex((x) => x.id === id);
  if (index < 0) return s;
  const sender = s.screened[index];
  return releaseHeld(s, sender.held, sender.address, dest, {
    kind: "allow",
    sender,
    index,
    newIds: [],
    dest,
  }, {
    ...s,
    screened: s.screened.filter((x) => x.id !== id),
  }, `Allowed — ${sender.held.length} held message${sender.held.length === 1 ? "" : "s"} released to ${destDone(dest)}.`);
}

/** Move spam-held mail out of quarantine. Nothing is deleted unseen. */
export function notSpam(s: AppState, id: string, dest: Place): AppState {
  const index = s.spam.findIndex((x) => x.id === id);
  if (index < 0) return s;
  const sender = s.spam[index];
  return releaseHeld(s, sender.held, sender.from, dest, {
    kind: "notSpam",
    sender,
    index,
    newIds: [],
    dest,
  }, {
    ...s,
    spam: s.spam.filter((x) => x.id !== id),
  }, `Not spam — ${sender.held.length} message${sender.held.length === 1 ? "" : "s"} moved to ${destDone(dest)}.`);
}

function releaseHeld(
  s: AppState,
  held: Held[],
  address: string,
  dest: Place,
  op: UndoOp,
  base: AppState,
  message: string,
): AppState {
  let seq = s.seq;
  const newIds: string[] = [];
  const rows: Mail[] = held.map((h) => {
    seq += 1;
    const id = `rel${seq}-${h.id}`;
    newIds.push(id);
    return {
      id,
      place: dest,
      from: { name: address, address },
      subject: h.subject,
      time: h.time,
      body: h.body,
      snippet: firstLine(h.body),
      unread: !h.seen,
      rationale: `${destDone(dest)} — released from the Screener, every held message`,
      trackerNote: h.trackerNote,
      earlier: [],
    };
  });
  const next: AppState = { ...base, seq };
  if (dest === "receipts") {
    next.receipts = [...rows, ...base.receipts];
    next.receiptGroups = base.receiptGroups.length
      ? [
          { ...base.receiptGroups[0], ids: [...newIds, ...base.receiptGroups[0].ids] },
          ...base.receiptGroups.slice(1),
        ]
      : [{ label: "Today", ids: newIds }];
  } else if (dest === "reads") {
    next.reads = [...rows, ...base.reads];
  } else {
    next.ohbox = [...rows, ...base.ohbox];
  }
  if (op.kind === "allow" || op.kind === "notSpam") op.newIds = newIds;
  next.toast = { id: seq, message, undo: op };
  return next;
}

/** Every undo branch is a *move back*, never a delete. */
export function undo(s: AppState, op: UndoOp): AppState {
  const drop = (list: Mail[], ids: string[]) => list.filter((m) => !ids.includes(m.id));
  if (op.kind === "decision") {
    const { sender, index, dest, newId } = op.snapshot;
    const next: AppState = { ...s, toast: null };
    if (newId) {
      next.ohbox = drop(s.ohbox, [newId]);
      next.reads = drop(s.reads, [newId]);
      next.receipts = drop(s.receipts, [newId]);
      next.receiptGroups = s.receiptGroups.map((g) => ({ ...g, ids: g.ids.filter((i) => i !== newId) }));
    }
    if (dest === "screened") next.screened = s.screened.filter((x) => x.id !== sender.from.address);
    if (dest === "spam") next.spam = s.spam.filter((x) => x.id !== sender.from.address);
    const waiting = [...s.waiting];
    waiting.splice(Math.min(index, waiting.length), 0, sender);
    next.waiting = waiting;
    next.toast = { id: s.seq + 1, message: "Undone — 1 waiting again." };
    return next;
  }
  const next: AppState = {
    ...s,
    ohbox: drop(s.ohbox, op.newIds),
    reads: drop(s.reads, op.newIds),
    receipts: drop(s.receipts, op.newIds),
    receiptGroups: s.receiptGroups.map((g) => ({
      ...g,
      ids: g.ids.filter((i) => !op.newIds.includes(i)),
    })),
    toast: null,
  };
  if (op.kind === "allow") {
    const screened = [...s.screened];
    screened.splice(Math.min(op.index, screened.length), 0, op.sender);
    next.screened = screened;
    next.toast = { id: s.seq + 1, message: `Undone — ${op.sender.address} is screened out again.` };
  } else {
    const spam = [...s.spam];
    spam.splice(Math.min(op.index, spam.length), 0, op.sender);
    next.spam = spam;
    next.toast = { id: s.seq + 1, message: `Undone — ${op.sender.from} is held again.` };
  }
  return next;
}

/* -------------------------------------------------------------------- tags */

export function toggleTag(s: AppState, messageId: string, tag: TagId): AppState {
  const on = s.tagged[tag].includes(messageId);
  return {
    ...s,
    tagged: {
      ...s.tagged,
      [tag]: on ? s.tagged[tag].filter((i) => i !== messageId) : [...s.tagged[tag], messageId],
    },
  };
}

/* ------------------------------------------------------------------ triage */

export function addToPile(s: AppState, kind: PileKind, item: PileItem): AppState {
  return {
    ...s,
    piles: s.piles.map((p) =>
      p.kind === kind && !p.items.some((i) => i.id === item.id)
        ? { ...p, items: [...p.items, item] }
        : p,
    ),
    toast: { id: s.seq + 1, message: `${pileTitle(kind)} — added.` },
  };
}

export function removeFromPile(s: AppState, kind: PileKind, id: string): AppState {
  return {
    ...s,
    piles: s.piles.map((p) => (p.kind === kind ? { ...p, items: p.items.filter((i) => i.id !== id) } : p)),
  };
}

export function pileTitle(kind: PileKind): string {
  return kind === "replyLater" ? "Answer Later" : kind === "setAside" ? "Parked" : "Resurface";
}

/* ---------------------------------------------------------------- settings */

export function setTheme(s: AppState, themePref: ThemePref): AppState {
  return { ...s, themePref };
}

export function toggleNotification(s: AppState, id: string): AppState {
  return { ...s, notifications: { ...s.notifications, [id]: !s.notifications[id] } };
}

export function resolveVipSuggestion(s: AppState, accept: boolean): AppState {
  const sug = world.notificationSettings.learnedSuggestion;
  return {
    ...s,
    vipSuggestion: accept ? "accepted" : "dismissed",
    vips: accept && !s.vips.includes(sug.target) ? [...s.vips, sug.target] : s.vips,
    toast: { id: s.seq + 1, message: accept ? sug.acceptedToast : sug.dismissedToast },
  };
}

export function setReadsChip(s: AppState, value: AppState["readsChip"]): AppState {
  return { ...s, readsChip: value };
}

export function dismissToast(s: AppState): AppState {
  return s.toast ? { ...s, toast: null } : s;
}
