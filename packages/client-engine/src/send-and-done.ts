import { ohboxView, resurfacedThreads } from "./selectors.js";
import { inverseMutations } from "./undo.js";
import type { EntityReader } from "./store.js";
import type { EngineMessage, EngineMutation } from "./types.js";

/**
 * SEND + DONE — one rule, read by every surface.
 *
 * The composer's second send action answers a message and files it in one press. It is NOT a
 * second Done: the plan below is the Ohbox row's own release (clear the bookings, then ONE
 * deliberate `mark_seen` over the row), and the intent dispatches it only once the engine has
 * accepted the send. Offered only where it would change something — see {@link
 * sendAndDonePlanFor}, whose `null` IS the plain Send.
 */

/** Which group of the Ohbox the source stands in. Nothing else is a source. */
export type OhboxSection = "new" | "earlier" | "resurfaced";

export interface SendAndDonePlan {
  /** Where the source is now — what Undo puts it back into. */
  section: OhboxSection;
  /** The row the source stands in, as the Ohbox counts it: a conversation, or a lone message. */
  messageIds: string[];
  /** In dispatch order: each booking cleared, then the one deliberate read over the row. */
  mutations: EngineMutation[];
  /** What Undo dispatches, read off the PRE-PRESS mirror. Never empty — see the rule below. */
  undo: EngineMutation[];
}

export type SendAndDoneOutcome =
  /** The engine did not accept the send. NOTHING was dispatched and nothing is done. */
  | { kind: "send_refused" }
  /** Sent, with no plan: an ordinary Send, said in the ordinary words. */
  | { kind: "sent" }
  /** Sent, and the row released. */
  | { kind: "sent_and_done" }
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
): SendAndDonePlan | null {
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
  /* The two flat groups fold by conversation WITHIN one section (the list's own rule): reading
     one of five unread replies moves that message to Earlier, and a row stops waiting only when
     its last unread member has gone — so a release that reached across the sections would file
     history the reader never saw. */
  const inNew = view.newForYou.find((m) => m.id === sourceId);
  if (inNew) return planOver(reader, "new", threadIn(view.newForYou, inNew));
  const inEarlier = view.previouslySeen.find((m) => m.id === sourceId);
  if (inEarlier) return planOver(reader, "earlier", threadIn(view.previouslySeen, inEarlier));
  return null;
}

/** One section's members of this message's conversation; the message alone when it has none. */
function threadIn(section: readonly EngineMessage[], m: EngineMessage): EngineMessage[] {
  if (m.threadId == null) return [m];
  return section.filter((r) => r.threadId === m.threadId);
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
): SendAndDonePlan | null {
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
  };
}

/**
 * The release, dispatched in order. A refused booking clear STOPS it: half a release is a
 * message read out of a pile it is still in, and a reader install cannot triage at all.
 */
export async function applySendAndDone(
  plan: SendAndDonePlan,
  dispatch: (m: EngineMutation) => Promise<boolean>,
): Promise<boolean> {
  for (const m of plan.mutations) {
    if (!await dispatch(m)) return false;
  }
  return true;
}

/**
 * SEND + DONE, THE INTENT — the send, and then the release, in that order and only in that order.
 *
 * `send` is the surface's own Send, unchanged and unwrapped: it answers `true` only when the
 * engine ACCEPTED the message (the webapp's confirmation, the phone's `sent` outcome). A `false`
 * dispatches nothing at all, which is the whole guarantee — a refused send marks nothing done and
 * says only the send's own sentence. `plan` of `null` is an ordinary Send with an ordinary answer.
 */
export async function sendAndDone(opts: {
  plan: SendAndDonePlan | null;
  send: () => Promise<boolean>;
  dispatch: (m: EngineMutation) => Promise<boolean>;
}): Promise<SendAndDoneOutcome> {
  const accepted = await opts.send();
  if (!accepted) return { kind: "send_refused" };
  if (opts.plan === null) return { kind: "sent" };
  return await applySendAndDone(opts.plan, opts.dispatch)
    ? { kind: "sent_and_done" }
    : { kind: "send_done_refused" };
}
