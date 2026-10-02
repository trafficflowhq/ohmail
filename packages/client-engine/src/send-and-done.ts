import { isOwnSent, ohboxView, resurfacedThreads } from "./selectors.js";
import { inverseMutations } from "./undo.js";
import type { EntityReader } from "./store.js";
import type { EngineMessage, EngineMutation } from "./types.js";

/**
 * SEND + DONE — one rule, read by every surface.
 *
 * The composer's second send action answers a message and files it in one press. It is NOT a
 * second Done: the release is the Ohbox row's own (clear the bookings, then ONE deliberate
 * `mark_seen` over the row), dispatched only once the engine has accepted the send. The press
 * carries the INTENT; the release and its Undo are read from the mirror at the release
 * ({@link releasePlanAt}), because a send can confirm minutes or a restart later.
 */

/** Which group of the Ohbox the source stands in. Nothing else is a source. */
export type OhboxSection = "new" | "earlier" | "resurfaced";

/**
 * THE INTENT a Send + Done press carries on its outbox row: the source, the section it stood in,
 * and the members the press saw. No mutations and no Undo — those are read at the release.
 */
export interface SendAndDonePlan {
  section: OhboxSection;
  source: string;
  messageIds: string[];
}

/** The release over one row, read from one mirror. Only this is dispatched or undone. */
export interface SendAndDoneRelease {
  /** Where the source is now — what Undo puts it back into. */
  section: OhboxSection;
  /** The row the release files, as the Ohbox counts it. */
  messageIds: string[];
  /** In dispatch order: each booking cleared, then the one deliberate read over the row. */
  mutations: EngineMutation[];
  /** What Undo dispatches, read off the same mirror. Never empty. */
  undo: EngineMutation[];
  /** The mirror version the release was read at. */
  readonly readAt: number;
}

export type SendAndDoneOutcome =
  /** The engine did not accept the send. NOTHING was dispatched and nothing is done. */
  | { kind: "send_refused" }
  /** Sent, and nothing to release: an ordinary Send, said in the ordinary words. */
  | { kind: "sent" }
  /** Sent, and the row released — the release carries the Undo to offer. */
  | { kind: "sent_and_done"; release: SendAndDoneRelease }
  /** Sent, and the release refused — the refusal is the caller's to say. */
  | { kind: "send_done_refused" };

/** The bookings among these rows — a `bubbled_up` member has a schedule to cancel first. */
function bookedIn(rows: readonly EngineMessage[]): string[] {
  return rows.filter((m) => m.triage?.state === "bubbled_up").map((m) => m.id);
}

/**
 * THE ROW THE SOURCE STANDS IN, and the release that finishes it — or `null`, which is the plain
 * Send and every reason for it at once: no source, a source the Ohbox does not hold (filed away,
 * in a bottom pile, in another view), and a source the release would not move.
 *
 * That last case is DERIVED rather than spelled: the release's own inverses are read off the
 * mirror first, and an empty inverse set means this press would change nothing — which is exactly
 * what "already done" is. So a read, unpinned row in Earlier offers the plain Send, and nothing
 * here has to keep a second definition of done in step with `inverseMutations`.
 */
export function sendAndDonePlanFor(
  reader: EntityReader,
  sourceId: string | null,
): SendAndDoneRelease | null {
  if (sourceId === null) return null;
  const view = ohboxView(reader);
  /* RESURFACED FIRST, and by the ENGINE's row: the pin is per message and the row is per
     conversation, so a member of a resurfaced conversation is held out of the two groups below
     while standing in the Ohbox. The row's own Done acts on the members carrying the claim — the
     same ids `bulk.run("done", pinned)` passes — not on every member of the thread. */
  for (const row of resurfacedThreads(reader)) {
    if (!row.members.some((m) => m.id === sourceId)) continue;
    return planOver(reader, "resurfaced", row.pinned);
  }
  /* The two flat groups each hold whole conversations (`ohboxView` files a conversation in ONE
     group), so the source's section is the conversation's one section and the release is that
     row's: from New it finishes the unread members, from an all-read Earlier row it changes
     nothing and the plain Send stands. */
  const inNew = view.newForYou.find((m) => m.id === sourceId);
  if (inNew) return planOver(reader, "new", threadIn(view.newForYou, inNew));
  const inEarlier = view.previouslySeen.find((m) => m.id === sourceId);
  if (inEarlier) return planOver(reader, "earlier", threadIn(view.previouslySeen, inEarlier));
  return null;
}

/**
 * The conversation's members the release reads, or the message alone when it has none. The
 * account's own mail is left out: it is read already, and the confirm-time copy's id is the
 * client's own, which no server row answers to.
 */
function threadIn(section: readonly EngineMessage[], m: EngineMessage): EngineMessage[] {
  if (m.threadId == null) return [m];
  return section.filter((r) => r.threadId === m.threadId && !isOwnSent(r));
}

/**
 * The release over one row, composed exactly as the row's own Done composes it: the bookings
 * first (a read left under a schedule is a message read out of a pile it is still in), then ONE
 * deliberate `mark_seen` over the whole row, which spends every pin in a single transaction.
 */
function planOver(
  reader: EntityReader,
  section: OhboxSection,
  rows: readonly EngineMessage[],
): SendAndDoneRelease | null {
  const messageIds = rows.map((m) => m.id);
  if (messageIds.length === 0) return null;
  const booked = bookedIn(rows);
  const read: EngineMutation = { kind: "mark_seen", messageIds, unread: false };
  const undo = [
    ...inverseMutations(reader, read),
    ...booked.flatMap((messageId) =>
      inverseMutations(reader, { kind: "triage_set", messageId, state: "none" })),
  ];
  /* NOTHING TO FINISH ⇒ NO SECOND BUTTON. An Undo over a press that changed nothing would
     change state itself, which is the rule `inverseMutations` already states for every verb. */
  if (undo.length === 0) return null;
  return {
    section,
    messageIds,
    mutations: [
      ...booked.map((messageId): EngineMutation => ({ kind: "triage_set", messageId, state: "none" })),
      read,
    ],
    undo,
    readAt: reader.version(),
  };
}

/** What a press carries: the source and the members its read saw, never the read itself. */
export function intentOf(release: SendAndDoneRelease, source: string): SendAndDonePlan {
  return { section: release.section, source, messageIds: [...release.messageIds] };
}

/**
 * A PERSISTED INTENT read back defensively, by PICK: a malformed one is a plain Send. An older
 * row carries the press-time `mutations`/`undo` and no `source`; it is read as its first member,
 * and what it carried is never applied.
 */
export function asSendAndDoneIntent(v: unknown): SendAndDonePlan | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const section = r.section;
  if (section !== "new" && section !== "earlier" && section !== "resurfaced") return undefined;
  if (!Array.isArray(r.messageIds) || !r.messageIds.every((x) => typeof x === "string")) return undefined;
  const messageIds = r.messageIds as string[];
  const source = typeof r.source === "string" ? r.source : messageIds[0];
  if (source === undefined) return undefined;
  return { section, source, messageIds: [...messageIds] };
}

/**
 * THE RELEASE, READ AT THE RELEASE. The source's row as the mirror holds it now, narrowed to the
 * members the press saw: a member that arrived later is not filed by it. `null` — the source left
 * the Ohbox, is done already, or shares no member with the press — is no release and no Undo.
 */
export function releasePlanAt(reader: EntityReader, intent: SendAndDonePlan): SendAndDoneRelease | null {
  const now = sendAndDonePlanFor(reader, intent.source);
  if (now === null) return null;
  const seen = new Set(intent.messageIds);
  const rows = now.messageIds
    .filter((id) => seen.has(id))
    .map((id) => reader.get<EngineMessage>("message", id))
    .filter((m): m is EngineMessage => m !== undefined);
  if (rows.length === 0) return null;
  return planOver(reader, now.section, rows);
}

/**
 * The release, dispatched in order. A refused booking clear STOPS it: half a release is a
 * message read out of a pile it is still in, and a reader install cannot triage at all.
 */
export async function applySendAndDone(
  release: SendAndDoneRelease,
  dispatch: (m: EngineMutation) => Promise<boolean>,
): Promise<boolean> {
  for (const m of release.mutations) {
    if (!await dispatch(m)) return false;
  }
  return true;
}

/**
 * SEND + DONE, THE INTENT — the send, then the release read at that moment, in that order.
 *
 * `send` answers `true` only when the engine ACCEPTED the message. A `false` dispatches nothing,
 * which is the whole guarantee. `intent` of `null`, or a release that reads `null`, is an
 * ordinary Send with an ordinary answer.
 */
export async function sendAndDone(opts: {
  intent: SendAndDonePlan | null;
  reader: () => EntityReader;
  send: () => Promise<boolean>;
  dispatch: (m: EngineMutation) => Promise<boolean>;
}): Promise<SendAndDoneOutcome> {
  const accepted = await opts.send();
  if (!accepted) return { kind: "send_refused" };
  const release = opts.intent === null ? null : releasePlanAt(opts.reader(), opts.intent);
  if (release === null) return { kind: "sent" };
  return await applySendAndDone(release, opts.dispatch)
    ? { kind: "sent_and_done", release }
    : { kind: "send_done_refused" };
}
