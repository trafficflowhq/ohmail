/**
 * ═══ WHAT BOUNDS EACH ENTITY TYPE IN THE MIRROR ═══════════════════════════════════════════
 *
 * The window is over the MIRROR, not over one entity type — and that was not true. The pass
 * reached `message` and cascaded to `message_body`; every other type was outside it, not
 * exempted but never asked about. `draft` was the expensive one, holding the text of every reply
 * ever sent, and nothing here could say which types had a bound and which had one by accident.
 */
/**
 * So the answer is a TABLE OVER EVERY TYPE, total by construction: a `Record` over {@link
 * KnownMirrorEntityType}, so a type added without a bound fails `tsc -b` here. The census beside
 * it DRIVES the mechanical arms through a real engine — a table asserting what the code does is
 * a claim, not a measurement.
 */
/**
 * A stated reason is admitted where it IS one: "the set is what a person typed" is a reason the
 * bootstrap reader itself relies on. "Nobody thought about it" is not, so every non-mechanical
 * arm carries `growsWith` — the thing the row count is a function of.
 */

/**
 * EVERY TYPE THE MIRROR HOLDS, CLOSED. `MirrorEntityType` stays open (`string & {}`) because an
 * older client must tolerate a type from a newer server rather than throw; this list is what the
 * BOUNDS are declared over, and the two are held together by the exhaustiveness below plus the
 * census's runtime sweep of what a driven engine actually wrote.
 */
export const MIRROR_ENTITY_TYPES = [
  // The `/sync` feed's vocabulary (contract §3.1).
  "message", "thread", "routing_decision", "approval", "draft", "rule", "message_state",
  "folder", "tag", "mailbox", "screener_suggestion",
  // Client-local: the demo world, view metadata, hydrated bodies, the held-release derivation.
  "screener_sender", "triage_item", "view_meta", "message_body", "held_release_group",
  // Client-local and DURABLE: the outbox and its abandoned half.
  "outbox_entry", "outbox_abandoned",
] as const;

export type KnownMirrorEntityType = (typeof MIRROR_ENTITY_TYPES)[number];

/**
 * WHAT KEEPS ONE TYPE FROM GROWING WITH THE MAILBOX.
 *
 * Four of the five arms name a MECHANISM this package runs and the census drives. `person` is the
 * one that names a reason instead, and it carries `growsWith` so that the reason is a claim
 * somebody can disagree with rather than a silence.
 */
export type MirrorBound =
  /** {@link OhmailEngine.pruneToPolicy} — the floor, the ceiling, the age term and the pin set. */
  | { by: "window"; why: string }
  /** It goes with the message it names, in the same prune pass. `via` is the field that names it. */
  | { by: "cascade"; via: string; why: string }
  /** A ceiling this package enforces, named so the census can read its value. */
  | { by: "ceiling"; at: string; why: string }
  /** One named writer rewrites the WHOLE set and prunes the complement, so it cannot accumulate. */
  | { by: "replaced"; via: string; why: string }
  /** No mechanism: the set is bounded by what it is a function of, which `growsWith` names. */
  | { by: "person"; growsWith: string; why: string };

/**
 * THE TABLE. Every type, one answer, and `tsc` refuses a missing key.
 *
 * TOMBSTONES are a STATE and not a type, so they have no row here: a delete leaves a record whose
 * `entity` is `null` — a key, a seq and nothing else — and the payload is what the window exists
 * to bound. They are swept wholesale by the 410 re-bootstrap and by `pruneBySeq`; sweeping one
 * earlier would let a replayed page below the cursor resurrect deleted mail, which is a worse
 * defect than the bytes. Recorded here rather than left out.
 */
export const MIRROR_BOUNDS: Record<KnownMirrorEntityType, MirrorBound> = {
  message: {
    by: "window",
    why: "the newest minRows unconditionally, plus what is inside `days` and under `maxRows`; "
      + "the pin set overrides all three",
  },
  message_body: {
    by: "ceiling",
    at: "BODY_CACHE_MAX",
    why: "the largest thing the mirror holds, evicted oldest-first by `trimBodyCache` and "
      + "cascaded structurally when its message is pruned — raw text never sits without its row",
  },
  thread: {
    by: "cascade",
    via: "message.threadId",
    why: "a thread no surviving message names renders nothing; it is re-delivered with the next "
      + "message that names it, because a /sync change carries the FULL DTO",
  },
  message_state: {
    by: "cascade",
    via: "messageId",
    why: "a park that is not `none` PINS its message, so only a resting state can be orphaned, "
      + "and a resting state over a message this device no longer holds is nothing",
  },
  routing_decision: {
    by: "cascade",
    via: "messageId",
    why: "a `pending_approval` decision pins its message; a settled one over an evicted message "
      + "is history, which is what the window is for",
  },
  approval: {
    by: "cascade",
    via: "messageId",
    why: "a `pending` approval pins its message; one with NO message is page-1 live state and is "
      + "never cascaded — the cascade reads the named message, not the absence of one",
  },
  draft: {
    by: "person",
    growsWith: "what the person has written",
    why: "the ROWS stay by ruling — the sent list is read offline and the address book learns its "
      + "counterparties from them — and the BYTES are bounded instead: a sent draft carries no "
      + "body and no html (`draftRowToSnapshotDTO`, and the engine's own strip against an older "
      + "server), and an unsent one is a message somebody is still holding, each under "
      + "DRAFT_BODY_MAX_BYTES at the write door",
  },
  rule: {
    by: "person",
    growsWith: "the rules the person wrote",
    why: "the bootstrap serves the whole set unpaged and must: a paged rule set would show "
      + "routing that does not match what the server does",
  },
  folder: {
    by: "person",
    growsWith: "the folders in the mailbox",
    why: "the mailbox's own folders, served in full on page 1; the organized six, Sent and the "
      + "ohmail namespace are excluded by construction",
  },
  tag: {
    by: "person",
    growsWith: "the tags the person made",
    why: "identity — a name and a hue — and the rail is rendered by filtering this set against "
      + "each message's `labels`, so a paged set boots an empty rail over mail that names it",
  },
  mailbox: {
    by: "person",
    growsWith: "the mailboxes the account connected",
    why: "one row per connected mailbox; a removal arrives as the one op this type has and "
      + "cascades every row keyed by it",
  },
  screener_suggestion: {
    by: "cascade",
    via: "messageId",
    why: "advice bought about one message: it goes when that message goes, and a re-buy arrives "
      + "as a delete + create pair so one purchase is one live row; a chip for a sender whose "
      + "message left the window is re-served free by the activation re-read, never re-bought",
  },
  screener_sender: {
    by: "person",
    growsWith: "the fixture world",
    why: "client-local, written only by the demo's FixturesAdapter — a Cloud account has none and "
      + "sees pure derivation from the message mirror",
  },
  triage_item: {
    by: "person",
    growsWith: "the fixture world",
    why: "client-local, written only by the demo's FixturesAdapter for triage entries that have "
      + "no message behind them",
  },
  view_meta: {
    by: "ceiling",
    at: "FeedView",
    why: "one row per reading stream, ids from `waterlineIdOf` — a closed enumeration of two, not "
      + "a set that grows with anything",
  },
  held_release_group: {
    by: "replaced",
    via: "OhmailEngine.refreshHeldReleases",
    why: "a server derivation over the caller's own rules, one row per rule; every refresh writes "
      + "the whole set and prunes the complement, so it is replaced rather than accumulated",
  },
  outbox_entry: {
    by: "person",
    growsWith: "the verbs this device issued that the server has not taken",
    why: "a queued verb IS the user's intent and leaves on its outcome; the replay deadline "
      + "(OUTBOX_REPLAY_DEADLINE_MS) retires what no longer can be sent",
  },
  outbox_abandoned: {
    by: "person",
    growsWith: "the verbs the server refused",
    why: "one row per refusal a person has not answered, retired by a newer verb of the same kind "
      + "on the same target",
  },
};

/**
 * THE TYPES THE PRUNE PASS CASCADES TO, derived from the table rather than typed twice — the
 * engine reads this, so a type whose bound is `cascade` is one the pass really evicts. The field
 * that names the message travels with it, because `thread` is named the other way round (the
 * MESSAGE points at the thread) and the pass has to know which.
 */
export const CASCADE_TYPES: ReadonlyArray<{ type: KnownMirrorEntityType; via: string }> =
  MIRROR_ENTITY_TYPES
    .filter((t): t is KnownMirrorEntityType => MIRROR_BOUNDS[t].by === "cascade")
    .map((type) => ({ type, via: (MIRROR_BOUNDS[type] as { via: string }).via }));
