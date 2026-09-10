import { and, asc, eq, isNull } from "drizzle-orm";
import {
  accountSettings, awayResponders, folderState, mailboxes, messages, organizerRequests,
  rules as rulesTbl,
} from "./schema-mail.js";
import { recordChange, type LedgerTx, type Tx } from "./change-log.js";
import { insertOrganizerRequest } from "./organizer-requests.js";

/**
 * `recordChange` wants `LedgerTx` (`PgTransaction`, narrower than `Tx`/`PgDatabase`) because it is
 * only safe inside an open transaction. Every caller here already is one, so this is the same cast
 * `screener-apply.ts` makes at its own call sites rather than a widening of what is safe.
 */
const ledger = (tx: Tx): LedgerTx => tx as unknown as LedgerTx;

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT AN ORGANIZER DOES WITH A REQUEST THAT IS NOT A SCREENER DECISION (mail 0094)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `screener-apply.ts` is the model and the sibling: one transactional core, reached from BOTH the
 * organizer's own HTTP door and the request drain, so the two cannot drift into two answers about
 * one action. This module is the same shape for the kinds that arrive with mail 0094.
 *
 * It lives in `@trafficflow/db` for `screener-apply.ts`'s reason, unchanged: the worker may not
 * import `@trafficflow/services` at runtime (a CJS `sanitize-html` re-entering an ESM
 * `htmlparser2` mid-evaluation is a hard `ERR_REQUIRE_CYCLE_MODULE`), so a core both the drain and
 * the service tier run has to sit below both.
 *
 * ── WHY A MOVE NEEDS AN APPLIER AT ALL, WHEN `MessageService.move` EXISTS ──────────────────
 *
 * Because the two do not receive the same thing. `MessageService.move` is handed a message ID
 * this install minted, in its own database. A request record crossed an install boundary through
 * an IMAP folder: the reader that wrote it has a DIFFERENT database with different row ids, so it
 * cannot name a row here. What both installs DO agree on is the message itself, and the name they
 * share for it is `messages.dedup_key` under `messages_mailbox_dedup_uq`.
 *
 * That is the whole reason the natural key is `(dedupKey, destination)` and not an id.
 */

/**
 * ── THE DESTINATION VOCABULARY IS SYMBOLIC, AND THAT IS A SECURITY PROPERTY ───────────────
 *
 * A request record's destination is one of these WORDS, never an IMAP path. The applier resolves
 * the word against THIS mailbox. Three reasons, and the third is the one that matters:
 *
 *  1. `trash` is not a constant. Every provider spells it differently and ohmail DISCOVERS it per
 *     mailbox at connect (`mailboxes.trash_folder`, mail 0065). A reader writing a path would be
 *     writing its guess about a server the organizer is the one actually connected to.
 *  2. A closed word set is checkable at the boundary. `folder_state.desired_folder` is what the
 *     reconciler turns into a physical IMAP move, so the set of things that may reach it should be
 *     enumerable in one line rather than pattern-matched.
 *  3. **A raw path is an instruction to move mail somewhere nobody chose.** The record is a
 *     message in a folder anyone with the mailbox password can append to. Signed, so a forgery is
 *     refused — but the signature proves WHO wrote it, not that what they wrote is sane, and a
 *     compromised or simply buggy reader that could name an arbitrary path could file a person's
 *     mail into a folder outside ohmail's own tree, where nothing in this product would ever look
 *     for it again. A word that must map through {@link MOVE_DESTINATIONS} cannot express that.
 *
 * The five `ohmail/*` folders plus `inbox` mirror the canonical `Destination` union
 * (`packages/core/src/rules.ts`), duplicated here rather than imported for the dependency-direction
 * reason `organizer-role.ts#CAPABILITY_REQUESTS` states at length: this package must not depend on
 * `@trafficflow/core`. `request-apply.test.ts` holds the two equal, the same way
 * `screener-apply.test.ts` holds `DECIDABLE_FOLDERS` equal to `effectForDestination`.
 *
 * `trash` maps to `null` HERE and is resolved per mailbox in {@link applyMessageMove} — the map
 * cannot answer it, and a map that pretended to (by naming a default like `"Trash"`) would be the
 * guess this whole design exists to refuse.
 */
export const MOVE_DESTINATIONS: ReadonlyMap<string, string | null> = new Map([
  ["inbox", "INBOX"],
  ["screener", "ohmail/Screener"],
  ["reads", "ohmail/Reads"],
  ["receipts", "ohmail/Receipts"],
  ["screened", "ohmail/Screened"],
  ["quarantine", "ohmail/Quarantine"],
  // Per-mailbox, discovered at connect. See the header.
  ["trash", null],
]);

/** The longest `dedup_key` this applier will read out of a record. See {@link validateMovePayload}. */
export const MOVE_DEDUP_KEY_MAX = 512;

/** A `message.move` request's payload, validated. */
export interface ValidatedMovePayload {
  /** `messages.dedup_key` — the name both installs have for one message. */
  dedupKey: string;
  /** A {@link MOVE_DESTINATIONS} key. NOT a folder path. */
  destination: string;
}

/**
 * VALIDATE A `message.move` PAYLOAD THAT ARRIVED THROUGH AN RFC822 HEADER.
 *
 * Untrusted input, on `validateRequestPayload`'s terms exactly: the writing door validated it, and
 * then it crossed an install boundary through a mailbox another machine wrote to, so it is
 * validated again here, independently, before a single write happens.
 *
 * Returns `null` for ANY failure — a missing field, a wrong type, an unknown destination word, an
 * empty or over-long dedup key. The caller's response to `null` is to REFUSE the record, never to
 * coerce it to a guess: a move is the least reversible thing in this product after a delete.
 *
 * `dedupKey` is length-bounded even though the wire format already caps the whole encoded payload
 * (`REQUEST_PAYLOAD_MAX_BYTES`), because the two bounds answer different questions — the wire cap
 * stops a folder being used as storage, this stops a pathological key reaching a `WHERE` clause.
 * A key longer than this cannot match any row this codebase ever wrote (`messageFingerprint`
 * produces a hex digest), so refusing is strictly more honest than truncating.
 */
export function validateMovePayload(payload: unknown): ValidatedMovePayload | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const o = payload as Record<string, unknown>;
  const dedupKey = o.dedupKey;
  const destination = o.destination;
  if (typeof dedupKey !== "string" || dedupKey.length === 0 || dedupKey.length > MOVE_DEDUP_KEY_MAX) return null;
  if (typeof destination !== "string" || !MOVE_DESTINATIONS.has(destination)) return null;
  return { dedupKey, destination };
}

/**
 * WHY A MOVE DID NOT HAPPEN, when the record itself was perfectly valid.
 *
 * These are NOT refusals of the record — they are outcomes the drain reports back so a person is
 * told something true, and each is a state a reader could not have known about when it decided.
 *
 *  · `no_such_message` — no row in THIS database carries that dedup key for that mailbox. The
 *    reader has a message this organizer has never synced, or has since deleted. Not an error:
 *    two installs of the same mailbox legitimately hold different subsets of it.
 *  · `no_trash_folder` — the destination was `trash` and this mailbox has no Trash path
 *    discovered. ohmail never expunges, so there is nowhere to put it and nothing to guess.
 */
export type MoveRefusal = "no_such_message" | "no_trash_folder";

export interface ApplyMessageMoveInput {
  accountId: string;
  /** The mailbox the record named — already checked against the folder it was read FROM. */
  mailboxId: string;
  payload: ValidatedMovePayload;
  now: Date;
}

export type ApplyMessageMoveResult =
  | {
    applied: true;
    /** The row this resolved to, so the caller can log which message moved. */
    messageId: string;
    /** Where it was, per `folder_state.observed_folder` — the worker's own truth. */
    from: string;
    /** The resolved PATH, not the symbolic word. */
    to: string;
    lastSeq: bigint;
  }
  | { applied: false; refusal: MoveRefusal };

/**
 * APPLY ONE `message.move`, IDEMPOTENTLY, WRITING DESIRED STATE AND NOTHING ELSE.
 *
 * ── ORGANIZE-IN-PLACE IS WHY THIS TOUCHES NO IMAP ─────────────────────────────────────────
 *
 * It writes `folder_state.desired_folder` with `last_set_by = 'us'` and `reconcile_status =
 * 'pending'`, exactly as `MessageService.move` does, and the worker's reconciler performs the
 * physical move on its own pass. So a drain that dies half-way has moved nobody's mail: it has
 * either recorded an intention or it has not.
 *
 * **`observed_folder` IS READ AND PRESERVED, NEVER WRITTEN.** It is the worker's record of where
 * the message actually is on the server, and the worker flips it when a move lands. An applier
 * that set it would be asserting a physical fact it has not performed — after which the
 * reconciler would compare desired against a lie and conclude there was nothing to do. The
 * message would sit where it was, the row would say it had arrived, and no guard anywhere would
 * fire. That is the whole reason this function reads the existing row first.
 *
 * ── IDEMPOTENCY, AND WHERE IT ACTUALLY COMES FROM ─────────────────────────────────────────
 *
 * The same record drained twice must be one outcome, and the caller's idempotency key
 * (`meta-request:<request id>`) is the first line of that. This function is idempotent on its own
 * terms too, which is the line that holds when two cycles race the same record: the write is an
 * upsert keyed on `folder_state.message_id`, so the second one sets the same `desired_folder` it
 * already has. It is not "applied twice"; it is one desired state, asserted twice.
 *
 * What is NOT idempotent is `change_log`: two racing cycles would emit two `move` rows for one
 * message. That is deliberate and harmless — the client's apply is idempotent by contract, so a
 * duplicate converges on the same state — and it is cheaper than making the ledger conditional on
 * a read, which is where a real race would hide.
 *
 * A move to where the message ALREADY is still writes and still records: a reader can legitimately
 * ask for a state that has since become true, and answering "nothing to do" would make the ack it
 * gets back depend on a race it cannot see.
 */
export async function applyMessageMove(
  tx: Tx, input: ApplyMessageMoveInput,
): Promise<ApplyMessageMoveResult> {
  const { accountId, mailboxId, payload, now } = input;

  /* THE NATURAL KEY, AND IT IS SCOPED BY ACCOUNT AS WELL AS BY MAILBOX.
     `messages_mailbox_dedup_uq` is `(mailbox_id, dedup_key)`, so the mailbox predicate alone
     already identifies at most one row — the account column is here anyway because a query that
     is correct only because of a uniqueness constraint elsewhere in the schema stops being
     correct the day that constraint moves, and which account a row belongs to must not depend on
     an index definition. `deleted_at` is NOT filtered: a tombstoned row is a message this install
     has been told to forget, and moving it would resurrect an intent the person cancelled — so it
     resolves, and the `no_such_message` arm below covers it by never matching. */
  const [msg] = await tx.select({
    id: messages.id,
    nativeLocator: messages.nativeLocator,
    deletedAt: messages.deletedAt,
  })
    .from(messages)
    .where(and(
      eq(messages.accountId, accountId),
      eq(messages.mailboxId, mailboxId),
      eq(messages.dedupKey, payload.dedupKey),
    ))
    .limit(1);

  if (!msg || msg.deletedAt !== null) return { applied: false, refusal: "no_such_message" };

  /* RESOLVE THE WORD. `trash` is the one member the map cannot answer; everything else is a
     canonical path. A word absent from the map cannot reach here — `validateMovePayload` refused
     it — so this is a resolution rather than a second validation. */
  let to = MOVE_DESTINATIONS.get(payload.destination) ?? null;
  /* `trash` is the ONE word the map answers with null (see it), and the payload was validated
     against that map, so this is the destination-is-Trash question already answered. */
  const toTrash = to === null;
  if (to === null) {
    const [mb] = await tx.select({ trashFolder: mailboxes.trashFolder }).from(mailboxes)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId))).limit(1);
    to = mb?.trashFolder ?? null;
    /* NO TRASH, NO GUESS. ohmail never expunges, so there is no fallback that is not a lie about
       where a person's mail went — the same refusal `MessageService.delete` gives at its own door,
       and it is reported rather than thrown so the drain can ack the reader honestly. */
    if (to === null) return { applied: false, refusal: "no_trash_folder" };
  }

  /* WHERE IT IS NOW — the worker's truth, or the message's own locator when no `folder_state` row
     exists yet. `MessageService.observedFolder`'s exact fallback, deliberately: two answers to
     "where is this message" would show up as a `change_log` `from` that disagrees with the row. */
  const [fs] = await tx.select({ observedFolder: folderState.observedFolder }).from(folderState)
    .where(eq(folderState.messageId, msg.id)).limit(1);
  const loc = (msg.nativeLocator as { folder?: string } | null) ?? null;
  const from = fs?.observedFolder ?? loc?.folder ?? "INBOX";

  /* WHERE IT CAME FROM, SO A RESTORE PUTS IT BACK THERE — `MessageService.upsertDesired`'s rule,
     applied here because this is the same write through another door: a move to the mailbox's
     Trash path records the origin, every other destination CLEARS it, and `observed === to`
     records nothing (Trash as an origin would restore a message to where it already is).
     Both halves were missing: a message deleted through a reader install restored to INBOX while
     the folder it came from still existed, and a forwarded move left a previous delete's origin
     for the next delete to inherit. Written on the conflict too, where the row already exists. */
  const trashedFrom = toTrash && from !== to ? from : null;

  // DESIRED ONLY, observed preserved on conflict. See the header.
  await tx.insert(folderState).values({
    messageId: msg.id, desiredFolder: to, observedFolder: from,
    lastSetBy: "us", reconcileStatus: "pending", conflict: false, trashedFrom,
  }).onConflictDoUpdate({
    target: folderState.messageId,
    // `observedFolder` deliberately omitted → preserved. The worker owns it.
    set: { desiredFolder: to, lastSetBy: "us", reconcileStatus: "pending", conflict: false, updatedAt: now, trashedFrom },
  });

  const lastSeq = await recordChange(ledger(tx), {
    accountId, entityType: "message", entityId: msg.id, op: "move",
    meta: { from, to },
  });

  return { applied: true, messageId: msg.id, from, to, lastSeq };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `profile.update` — the per-mailbox configuration a reader may ask the organizer to change
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── WHY THIS KIND EXISTS AT ALL, which is the sharpest reason in mail 0094 ─────────────────
 *
 * Before it, a reader editing an away responder, a signature, a dormancy window or a screening
 * posture got `200`. The write landed — in the READER's own row, which the organizer's pass never
 * reads. The setting was on screen and in effect nowhere. That is worse than the `409` a move
 * got, because a refusal is a decision somebody can argue with and a success that changes nothing
 * is not.
 *
 * ── PARTIAL, AND EVERY PRESENT FIELD REPLACES ─────────────────────────────────────────────
 *
 * A settings pane produces a partial: the person changed one thing. A whole-document replace
 * would let two panes edited a minute apart silently undo one another — the second writer
 * carrying stale copies of everything it did not touch. So an ABSENT key is "leave it alone" and
 * a PRESENT key replaces, `null` included: `signature: null` is "I removed my signature", which is
 * a change, and treating it as absent would make the one edit a person cannot make be the removal.
 *
 * A payload naming NO recognised field is refused rather than applied as a no-op. A reader that
 * queues an empty record has asked for nothing, and answering `applied` would tell somebody a
 * change they did not make had been made.
 */

/** The longest signature a request may carry. See {@link validateProfileUpdatePayload}. */
export const PROFILE_SIGNATURE_MAX = 2_000;

/**
 * The longest MARKUP a request may carry, in {@link PROFILE_SIGNATURE_MAX}'s unit.
 *
 * Sized from the column's own local cap the way the text half is: a local save is bounded at
 * 10 000 characters for whichever shape it carried (mail 0098), the travelling text takes a fifth
 * of that, and the markup takes the same fifth. An INDEPENDENT bound that happens to equal the
 * text's — the two govern different columns, so neither moves by editing the other.
 *
 * Both halves at their bounds exceed the record's own 3 072-byte JSON ceiling, which is the text
 * half's documented arrangement rather than an oversight: this bound is the sentence a person
 * reads, and the wire ceiling behind it refuses at the reader's door instead of truncating.
 */
export const TRAVELLING_SIGNATURE_HTML_MAX_BYTES = 2_000;

/** `away_responders.audience` — the closed pair the column's own CHECK enforces. */
const AWAY_AUDIENCES: ReadonlySet<string> = new Set(["screened_in", "everyone"]);
/** `away_responders.throttle` — the closed four `away_responders_throttle_closed` enforces. */
const AWAY_THROTTLES: ReadonlySet<string> = new Set(["always", "per_message", "per_day", "per_week"]);
/**
 * `away_responders.piles` — the closed pair `away_responders_piles_closed` (mail 0096) enforces.
 *
 * ── WHY THIS IS A SECOND SPELLING OF `AWAY_ANSWERABLE_PILES` AND NOT AN IMPORT ──────────────
 *
 * The canonical set is `@trafficflow/core/away-scope`'s `AWAY_ANSWERABLE_PILES`, and importing it
 * HERE does not compile: `@trafficflow/core` depends on `@trafficflow/db`, never the reverse
 * (`organizer-role.ts#CAPABILITY_REQUESTS` states the direction at length), so the import answers
 * `TS2307: Cannot find module '@trafficflow/core/away-scope'` — measured, not assumed.
 *
 * So it takes the arrangement {@link MOVE_DESTINATIONS} already documents forty lines up, for the
 * same reason and with the same obligation: the literal is restated and `request-apply.test.ts`
 * HOLDS THE TWO EQUAL. The equality is the point — a third pile added to the core set and not to
 * this one would be a scope a person can choose, that travels, and that the organizer's applier
 * then refuses as `invalid_payload`, which is a save that appears to work and changes nothing on
 * the one install whose row the responder reads.
 *
 * Exported for that guard alone. `AWAY_AUDIENCES` and `AWAY_THROTTLES` above are not exported and
 * have no such guard, which is a gap in their favour rather than a precedent: both are closed by
 * a CHECK as well, and widening either is a ruling that would come through this file anyway.
 */
export const AWAY_PILES: ReadonlySet<string> = new Set(["INBOX", "ohmail/Reads"]);
/** `account_settings.ohbox_policy` — the closed pair, or `null` for "the product default". */
const OHBOX_POLICY_VALUES: ReadonlySet<string> = new Set(["people_only", "people_and_replied"]);

/** The away responder as it travels — the whole row, replaced together. */
export interface ProfileAwayUpdate {
  enabled: boolean;
  body: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  audience: string;
  throttle: string;
  /**
   * WHICH PILES GET A REPLY (mail 0096), or ABSENT from an install one release older.
   *
   * THE ONE OPTIONAL MEMBER OF THIS INTERFACE, and it is optional for a compatibility reason
   * rather than a stylistic one. Every other field is required because a request that carries an
   * away responder at all carries those six; `piles` began travelling with the ruling of
   * 2026-09-10, so a request written by a 0.15 install has an `awayResponder` and no `piles`, and
   * refusing that record would 400 that install's every responder save — including the save that
   * turns the responder OFF, which is the one save nobody may be prevented from making.
   *
   * ABSENT therefore means "this request is not about the scope", and {@link applyProfileUpdate}
   * leaves the stored array alone. That is the recoverable direction: an existing row keeps the
   * scope it had, and a row created by such a request takes the column's own narrow default.
   */
  piles?: string[];
}

/** A `profile.update` payload, validated. Every field optional; at least one present. */
export interface ValidatedProfileUpdate {
  awayResponder?: ProfileAwayUpdate;
  signature?: string | null;
  /**
   * THE SIGNATURE'S MARKUP (mail 0098), or ABSENT from an install one release older.
   *
   * Three states, all reachable and all different: absent leaves the column alone, `null` is "this
   * signature has no formatting" — what a plain save means, and it has to be able to say so across
   * the wire or the holder keeps markup the words no longer match — and a string replaces.
   */
  signatureHtml?: string | null;
  dormancyDays?: number | null;
  screeningPreference?: string | null;
}

/** ISO 8601 or null, and anything else refuses the whole record. */
function asDateOrNull(v: unknown): Date | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * VALIDATE A `profile.update` PAYLOAD THAT ARRIVED THROUGH AN RFC822 HEADER.
 *
 * `validateMovePayload`'s terms exactly: the writing door validated it, then it crossed an install
 * boundary through a mailbox another machine wrote to, so it is validated again here before a
 * single write happens. `null` for ANY failure, and the caller refuses the record.
 *
 * The bounds are the columns' own closed sets, restated here rather than imported, for the
 * dependency-direction reason this package states elsewhere — and each one is a CHECK in the
 * schema too, so a value that slipped past this function would be refused by the database rather
 * than stored. Two gates, and the schema is the one that holds when this code is wrong.
 */
export function validateProfileUpdatePayload(payload: unknown): ValidatedProfileUpdate | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const o = payload as Record<string, unknown>;
  const out: ValidatedProfileUpdate = {};

  if ("signature" in o) {
    const sig = o.signature;
    if (sig !== null && typeof sig !== "string") return null;
    /* BYTES, not UTF-16 units. `.length` would let a multi-byte signature past a byte ceiling, and
       the whole encoded payload is capped on the wire at `REQUEST_PAYLOAD_MAX_BYTES` — a bound
       this one has to sit under rather than duplicate. */
    if (typeof sig === "string" && Buffer.byteLength(sig, "utf8") > PROFILE_SIGNATURE_MAX) return null;
    out.signature = sig;
  }

  /* THE MARKUP HALF, WHEN THE SENDER IS NEW ENOUGH TO HAVE ONE (ruling of 2026-09-10).
   *
   * `in` and not truthiness, for the text half's reason one field over: the three states above are
   * distinguishable and mean different things. Bytes for {@link PROFILE_SIGNATURE_MAX}'s reason —
   * markup is the longer shape of the same value, and a UTF-16 count would let a multi-byte
   * document past a byte ceiling the record is measured against. */
  if ("signatureHtml" in o) {
    const html = o.signatureHtml;
    if (html !== null && typeof html !== "string") return null;
    if (typeof html === "string"
      && Buffer.byteLength(html, "utf8") > TRAVELLING_SIGNATURE_HTML_MAX_BYTES) return null;
    out.signatureHtml = html;
  }

  if ("dormancyDays" in o) {
    const d = o.dormancyDays;
    if (d === null) out.dormancyDays = null;
    else if (typeof d === "number" && Number.isInteger(d) && d > 0 && d <= 3_650) out.dormancyDays = d;
    else return null;   // a non-integer, a zero, a negative or a decade-plus window is not a window
  }

  if ("screeningPreference" in o) {
    const p = o.screeningPreference;
    if (p === null) out.screeningPreference = null;
    else if (typeof p === "string" && OHBOX_POLICY_VALUES.has(p)) out.screeningPreference = p;
    else return null;
  }

  if ("awayResponder" in o) {
    const a = o.awayResponder;
    if (a === null || typeof a !== "object" || Array.isArray(a)) return null;
    const r = a as Record<string, unknown>;
    if (typeof r.enabled !== "boolean") return null;
    if (r.body !== null && typeof r.body !== "string") return null;
    if (typeof r.audience !== "string" || !AWAY_AUDIENCES.has(r.audience)) return null;
    if (typeof r.throttle !== "string" || !AWAY_THROTTLES.has(r.throttle)) return null;
    const startsAt = asDateOrNull(r.startsAt);
    const endsAt = asDateOrNull(r.endsAt);
    if (startsAt === undefined || endsAt === undefined) return null;
    /* A WINDOW THAT ENDS BEFORE IT BEGINS IS NOT A WINDOW. Refused rather than stored and left for
       the away pass to interpret: the pass would answer nobody, which looks exactly like a
       responder that is off, and the person would have configured something invisible. */
    if (startsAt !== null && endsAt !== null && endsAt.getTime() < startsAt.getTime()) return null;
    out.awayResponder = {
      enabled: r.enabled, body: (r.body as string | null), startsAt, endsAt,
      audience: r.audience, throttle: r.throttle,
    };
    /* ── THE PILE SCOPE, WHEN THE SENDER IS NEW ENOUGH TO HAVE ONE (ruling of 2026-09-10) ──
     *
     * `in` and not a truthiness check, because the three states are distinguishable and mean
     * different things: ABSENT is an older install that has no scope to send, and the stored
     * array is left alone; an EMPTY array is "answer nobody", which is what unticking every box
     * means and is a coherent thing to ask for; and a NON-MEMBER refuses the whole record.
     *
     * A non-member refuses rather than being filtered out. Filtering would store a NARROWER scope
     * than the request asked for and ack it `applied`, so the person would be told their edit
     * travelled while the responder answered a different set of mail — and the surface would then
     * state a scope nobody chose. The refusal reaches the reader as `invalid_payload`
     * (`request-drain.ts`), which is a decision somebody can act on.
     */
    if ("piles" in r) {
      const p = r.piles;
      if (!Array.isArray(p)) return null;
      const piles: string[] = [];
      for (const member of p) {
        if (typeof member !== "string" || !AWAY_PILES.has(member)) return null;
        /* DUPLICATES COLLAPSED, exactly as the local door's `validPiles` collapses them. The value
           is a SET ("which piles"), the CHECK is containment and admits `{INBOX,INBOX}`, and the
           two write paths producing different rows for the same ask is a diff nobody can read. */
        if (!piles.includes(member)) piles.push(member);
      }
      out.awayResponder.piles = piles;
    }
  }

  // Nothing recognised — see the header. An empty ask is not a change.
  if (Object.keys(out).length === 0) return null;
  return out;
}

export interface ApplyProfileUpdateInput {
  accountId: string;
  /** The mailbox the record named — `signature` is per-mailbox; the rest is account-scoped. */
  mailboxId: string;
  payload: ValidatedProfileUpdate;
  now: Date;
}

export interface ApplyProfileUpdateResult {
  /** Which fields this call actually wrote, for the drain's log line. */
  wrote: readonly string[];
  lastSeq: bigint | null;
}

/**
 * APPLY ONE `profile.update`.
 *
 * ── THREE TABLES, AND WHY THEY ARE NOT ALL ACCOUNT-SCOPED ─────────────────────────────────
 *
 * `signature` is `mailboxes.signature` — a person with two addresses has two sign-offs, and it is
 * scoped by ACCOUNT as well as by id for the reason the move applier states: a predicate that is
 * correct only because of a uniqueness constraint elsewhere in the schema stops being correct the
 * day that constraint moves. Everything else — the responder, the dormancy window, the screening
 * posture — is the ACCOUNT's, exactly as the organizer's own doors write them.
 *
 * ── THE TRANSITION-ARMING IS MIRRORED, NOT REINVENTED ─────────────────────────────────────
 *
 * `setScreeningPreference` arms the Ohbox tidy pass on the TRANSITION into `people_only`, and
 * NULLs the cursor in the same write so a re-arm cannot resume at the end of a previous run. A
 * request that changed the posture without arming would leave the backlog unfiled — the setting
 * would take effect for new mail and silently not for the mail already misfiled, which is the
 * halfway state the arming exists to prevent. Only on the transition: a re-save that leaves the
 * posture where it was must not re-run the backlog.
 *
 * ── NO `change_log` FOR THE ACCOUNT-SCOPED FIELDS, DELIBERATELY ────────────────────────────
 *
 * The delta feed is keyed by ENTITY, and these are account configuration rather than an entity a
 * client mirrors — the organizer's own doors do not log them either, and a second answer here
 * would put rows in the feed that no client apply knows what to do with. `signature` is the
 * exception in shape only: it belongs to a mailbox, and the mailbox is not a synced entity either.
 * `signature_html` (mail 0098) owes this block the same answer and takes it: no client mirrors a
 * mailbox row, so the new column needs no client apply either, and it appears in `wrote` for the
 * drain's log line and nowhere else.
 * The profile document is how this configuration reaches other installs, and the write-behind
 * republishes it on its own dirty check — which is a FINGERPRINT over the serializer's output, so
 * writing these rows IS what makes it notice.
 */
export async function applyProfileUpdate(
  tx: Tx, input: ApplyProfileUpdateInput,
): Promise<ApplyProfileUpdateResult> {
  const { accountId, mailboxId, payload, now } = input;
  const wrote: string[] = [];

  /* BOTH COLUMNS IN ONE STATEMENT, each named ONLY when the payload carried it (ruling of
     2026-09-10). One statement because the two halves are one value in two shapes: a row holding
     the text of one signature and the markup of another is the drift the local door refuses
     outright, and two statements is where it would come from. Named conditionally because an
     install a release older sends no markup at all — writing NULL for it would strip formatting
     that install's own pane never showed and never offered. */
  const mailboxSet: Partial<typeof mailboxes.$inferInsert> = {};
  if (payload.signature !== undefined) {
    mailboxSet.signature = payload.signature;
    wrote.push("signature");
  }
  if (payload.signatureHtml !== undefined) {
    mailboxSet.signatureHtml = payload.signatureHtml;
    wrote.push("signature_html");
  }
  if (Object.keys(mailboxSet).length > 0) {
    await tx.update(mailboxes).set(mailboxSet)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, accountId)));
  }

  if (payload.awayResponder !== undefined) {
    const a = payload.awayResponder;
    /* THE SINGLE PER-ACCOUNT ROW, replaced wholly when the request carries one — the same shape
       the organizer's own `put` has. `subject` is deliberately not written: the responder has been
       reply-only since mail 0087 and derives `Re: <what they wrote>`, so a request carrying one
       would be writing a dead column. */
    const awayValues: typeof awayResponders.$inferInsert = {
      accountId, enabled: a.enabled, body: a.body,
      startsAt: a.startsAt, endsAt: a.endsAt, audience: a.audience, throttle: a.throttle,
    };
    const awaySet: Partial<typeof awayResponders.$inferInsert> = {
      enabled: a.enabled, body: a.body, startsAt: a.startsAt, endsAt: a.endsAt,
      audience: a.audience, throttle: a.throttle, updatedAt: now,
    };
    /* THE SCOPE IS NAMED IN BOTH ARMS ONLY WHEN THE REQUEST CARRIED ONE (ruling of 2026-09-10).
     *
     * Named in the SET as well as in `values`, and this is the half that was missing: the whole
     * row is replaced together, so a scope present on the wire and absent from the SET is a field
     * that travels and is ignored — the reader's pane shows the scope it asked for coming back as
     * the old one, with the request acked `applied`.
     *
     * And ABSENT must leave the column untouched rather than write the default, which is why this
     * is a conditional on the payload rather than a `?? AWAY_PILES_DEFAULT`: an older install's
     * save would otherwise NARROW a scope its own pane never showed and never offered. The insert
     * arm needs no such branch — an omitted column takes the table's own `'{INBOX}'`, the narrow
     * member, which is the same value the local door infers for an omitted list. */
    if (a.piles !== undefined) {
      awayValues.piles = a.piles;
      awaySet.piles = a.piles;
    }
    await tx.insert(awayResponders).values(awayValues).onConflictDoUpdate({
      target: awayResponders.accountId,
      set: awaySet,
    });
    wrote.push("awayResponder");
  }

  const settings: Partial<typeof accountSettings.$inferInsert> = {};
  const insert: typeof accountSettings.$inferInsert = { accountId };

  if (payload.dormancyDays !== undefined) {
    settings.dormancyDays = payload.dormancyDays;
    insert.dormancyDays = payload.dormancyDays;
    wrote.push("dormancyDays");
  }

  if (payload.screeningPreference !== undefined) {
    settings.ohboxPolicy = payload.screeningPreference;
    insert.ohboxPolicy = payload.screeningPreference;
    wrote.push("screeningPreference");

    if (payload.screeningPreference === "people_only") {
      /* ONLY ON THE TRANSITION — see the header. The prior posture is read first, and a re-save
         that leaves it on `people_only` arms nothing. A double-flip that double-stamps merely
         re-arms an idempotent pass, which re-examines a drained backlog and writes zero. */
      const [prior] = await tx.select({ ohboxPolicy: accountSettings.ohboxPolicy })
        .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
      if ((prior?.ohboxPolicy ?? null) !== "people_only") {
        settings.ohboxTidyRequestedAt = now;
        settings.ohboxTidyCursor = null;
        insert.ohboxTidyRequestedAt = now;
        insert.ohboxTidyCursor = null;
      }
    }
  }

  if (Object.keys(settings).length > 0) {
    settings.updatedAt = now;
    await tx.insert(accountSettings).values(insert).onConflictDoUpdate({
      target: accountSettings.accountId,
      set: settings,
    });
  }

  return { wrote, lastSeq: null };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `rule.create` | `rule.update` | `rule.delete` — a reader's rule, applied by the organizer
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── THE NATURAL KEY IS FOUR FIELDS, NOT TWO, AND THE SCHEMA IS WHY ────────────────────────
 *
 * The shape these kinds were specified with is `{kind, match}`. That is under-determined by this
 * database: there is NO unique index on `(account_id, kind, match)`, and two rules on one sender
 * that differ only in a narrowing term are two different rules — *from this address* and *from
 * this address AND with this in the subject* file different mail to different places, on purpose.
 * A two-field key would have named both and had to guess.
 *
 * So the key is `{kind, match, subjectContains, bodyContains}`, with the two terms defaulting to
 * `null`. `{kind, match}` alone still identifies the BARE rule — both terms absent — which is the
 * promoted-rule shape the Screener writes and the case the two-field spelling had in mind.
 *
 * ── AND THE KEY CANNOT BE EDITED, WHICH IS THE OTHER HALF OF THAT ─────────────────────────
 *
 * `rule.update` carries a `key` and a `set`, and `set` may not contain a key field. Changing what
 * a rule MATCHES is not an edit to that rule, it is a different rule — a reader that could move
 * the key would be asking the organizer to guess whether the person meant "re-target this" or
 * "replace it with this", and those differ in what happens to mail the old rule already filed.
 * Expressed as a delete and a create, which says which one they meant.
 *
 * ── A DUPLICATE PAIR IS RESOLVED, NOT REFUSED ─────────────────────────────────────────────
 *
 * With no unique index, a database MAY hold two rows identical in all four key fields — nothing
 * created them here, but the schema permits it and old data might. Refusing would strand the
 * person's edit for ever with no way to fix it from the install they are sitting at. So the oldest
 * row wins (`created_at`, then `id` to break a tie deterministically), and the choice is stable
 * across retries — which is what makes the drain's idempotency mean anything.
 */

/** `rules.kind` — the three the routing engine switches over. */
const RULE_KINDS: ReadonlySet<string> = new Set(["sender", "domain", "header"]);
/** `rules_subject_contains_nonempty` / `rules_body_contains_nonempty` — 200 chars, non-blank. */
export const RULE_TERM_MAX = 200;
/** `rules.match` — bounded so a pathological value cannot reach a `WHERE` clause. */
export const RULE_MATCH_MAX = 512;

/** What identifies one rule on the wire. See the header: four fields, two of them nullable. */
export interface RuleKey {
  kind: string;
  match: string;
  subjectContains: string | null;
  bodyContains: string | null;
}

/** `rule.create`'s payload, validated. */
export interface ValidatedRuleCreate {
  op: "create";
  key: RuleKey;
  /** A {@link MOVE_DESTINATIONS} word, already refused for `trash` — see the validator. */
  destination: string;
  priority: number;
  enabled: boolean;
  applyRetro: boolean;
}

/** `rule.update`'s payload, validated. `set` never contains a key field. */
export interface ValidatedRuleUpdate {
  op: "update";
  key: RuleKey;
  set: { destination?: string; priority?: number; enabled?: boolean };
  applyRetro: boolean;
}

/** `rule.delete`'s payload, validated. */
export interface ValidatedRuleDelete {
  op: "delete";
  key: RuleKey;
}

export type ValidatedRuleRequest = ValidatedRuleCreate | ValidatedRuleUpdate | ValidatedRuleDelete;

/** A 200-char, non-blank term, or `null`. `undefined` means the value was present and invalid. */
function asTerm(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  /* BLANK IS NULL, never a stored term. `rules_subject_contains_nonempty` refuses a whitespace-only
     value, and a term that matched every subject would make a narrowing conjunct widen the rule —
     the opposite of what a second term is for. */
  const t = v.trim();
  if (t === "") return null;
  if (t.length > RULE_TERM_MAX) return undefined;
  return t;
}

function asRuleKey(v: unknown): RuleKey | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.kind !== "string" || !RULE_KINDS.has(o.kind)) return null;
  if (typeof o.match !== "string") return null;
  const match = o.match.trim();
  if (match === "" || match.length > RULE_MATCH_MAX) return null;
  const subjectContains = asTerm(o.subjectContains);
  const bodyContains = asTerm(o.bodyContains);
  if (subjectContains === undefined || bodyContains === undefined) return null;
  return { kind: o.kind, match, subjectContains, bodyContains };
}

/**
 * A rule's destination, from the same closed word table a move uses — and `trash` is REFUSED here.
 *
 * Not an oversight and not symmetry for its own sake. `trash` resolves per MAILBOX, and a rule is
 * ACCOUNT-scoped: one rule matches across every mailbox on the account, so a Trash word would have
 * to mean a different folder per mailbox the rule fires on. And a rule that files to Trash is a
 * standing instruction to delete somebody's mail on arrival, which is not a thing this product
 * offers from any door.
 */
function asRuleDestination(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (v === "trash") return null;
  const path = MOVE_DESTINATIONS.get(v);
  return path ?? null;
}

/**
 * VALIDATE A `rule.*` PAYLOAD THAT ARRIVED THROUGH AN RFC822 HEADER.
 *
 * `kind` selects which of the three shapes is expected, so a `rule.delete` carrying a create's
 * body is refused rather than half-read. `null` for ANY failure, and the caller refuses the record.
 */
export function validateRulePayload(kind: string, payload: unknown): ValidatedRuleRequest | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const o = payload as Record<string, unknown>;
  const key = asRuleKey(o.key);
  if (!key) return null;
  const applyRetro = o.applyRetro === undefined ? true : o.applyRetro === true;
  if (o.applyRetro !== undefined && typeof o.applyRetro !== "boolean") return null;

  if (kind === "rule.delete") {
    // A delete carries the key and NOTHING else that would change the row it is removing.
    return { op: "delete", key };
  }

  if (kind === "rule.create") {
    const destination = asRuleDestination(o.destination);
    if (destination === null) return null;
    const priority = o.priority === undefined ? 0 : o.priority;
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 1_000) return null;
    const enabled = o.enabled === undefined ? true : o.enabled;
    if (typeof enabled !== "boolean") return null;
    return { op: "create", key, destination, priority, enabled, applyRetro };
  }

  if (kind === "rule.update") {
    const raw = o.set;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    /* THE KEY IS NOT EDITABLE — see the header. A `set` naming any key field is refused rather
       than silently ignored: ignoring it would apply a DIFFERENT change from the one asked for,
       and the reader would be acked `applied` for it. */
    for (const forbidden of ["kind", "match", "subjectContains", "bodyContains"]) {
      if (forbidden in r) return null;
    }
    const set: ValidatedRuleUpdate["set"] = {};
    if ("destination" in r) {
      const d = asRuleDestination(r.destination);
      if (d === null) return null;
      set.destination = d;
    }
    if ("priority" in r) {
      const p = r.priority;
      if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > 1_000) return null;
      set.priority = p;
    }
    if ("enabled" in r) {
      if (typeof r.enabled !== "boolean") return null;
      set.enabled = r.enabled;
    }
    // An update naming nothing is not a change — the same rule `profile.update` follows.
    if (Object.keys(set).length === 0) return null;
    return { op: "update", key, set, applyRetro };
  }

  return null;   // a kind this function was not asked about
}

export interface ApplyRuleRequestInput {
  accountId: string;
  payload: ValidatedRuleRequest;
  now: Date;
}

/** `no_such_rule` is the one outcome an update or a delete can legitimately not find. */
export type RuleRefusal = "no_such_rule";

export type ApplyRuleRequestResult =
  | { applied: true; op: "create" | "update" | "delete"; ruleId: string; lastSeq: bigint }
  | { applied: false; refusal: RuleRefusal };

/** The oldest row matching the four-field key — deterministic, see the family header. */
async function findRuleByKey(tx: Tx, accountId: string, key: RuleKey): Promise<{ id: string; destination: string; subjectContains: string | null; bodyContains: string | null } | null> {
  const rows = await tx.select({
    id: rulesTbl.id, destination: rulesTbl.destination,
    subjectContains: rulesTbl.subjectContains, bodyContains: rulesTbl.bodyContains,
    createdAt: rulesTbl.createdAt,
  })
    .from(rulesTbl)
    .where(and(
      eq(rulesTbl.accountId, accountId),
      eq(rulesTbl.kind, key.kind),
      eq(rulesTbl.match, key.match),
      key.subjectContains === null ? isNull(rulesTbl.subjectContains) : eq(rulesTbl.subjectContains, key.subjectContains),
      key.bodyContains === null ? isNull(rulesTbl.bodyContains) : eq(rulesTbl.bodyContains, key.bodyContains),
    ))
    .orderBy(asc(rulesTbl.createdAt), asc(rulesTbl.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * APPLY ONE `rule.create` / `rule.update` / `rule.delete`.
 *
 * ── RETRO IS THE DEFAULT, AND IT IS THE PRODUCT'S OWN RULE ────────────────────────────────
 *
 * Creating a rule applies it to mail ALREADY on disk, not only to mail that arrives next — mail
 * 0034's requirement, and it is a default rather than an opt-in. So `retro_requested_at` is
 * stamped on create unless the request says otherwise, and on update ONLY when what the rule
 * claims or where it sends it actually MOVED. That last part is compared against the STORED value:
 * a request that re-sends the destination it already has costs nothing, which is what makes a
 * habit-click harmless.
 *
 * `retro_done_at` and `retro_cursor` are cleared with it. A re-arm that left the cursor at the end
 * of a previous run would resume there and move nothing — the pass would report success over a
 * backlog it never looked at.
 *
 * ── `provenance` IS `manual`, NEVER `promoted` ────────────────────────────────────────────
 *
 * A request is a person pressing something on one of their own installs, which is the same
 * provenance the organizer's own door records. `promoted` means the Screener derived the rule from
 * a decision, and a request path that claimed it would make a person's explicit rule look learned
 * — which changes how the rules pane ranks and explains it.
 */
export async function applyRuleRequest(
  tx: Tx, input: ApplyRuleRequestInput,
): Promise<ApplyRuleRequestResult> {
  const { accountId, payload, now } = input;
  const { key } = payload;

  if (payload.op === "create") {
    /* AN EXISTING ROW FOR THIS KEY IS THE IDEMPOTENT REPLAY, not a conflict. The rule the person
       asked for exists; answering `applied` is the honest outcome, and creating a second identical
       row would be the schema's missing unique index doing damage rather than the request. */
    const existing = await findRuleByKey(tx, accountId, key);
    if (existing) {
      return { applied: true, op: "create", ruleId: existing.id, lastSeq: await recordChange(ledger(tx), {
        accountId, entityType: "rule", entityId: existing.id, op: "update", meta: null,
      }) };
    }
    const [row] = await tx.insert(rulesTbl).values({
      accountId,
      kind: key.kind, match: key.match,
      destination: payload.destination,
      priority: payload.priority,
      enabled: payload.enabled,
      // See the header: a request is a person's own press.
      provenance: "manual",
      subjectContains: key.subjectContains,
      bodyContains: key.bodyContains,
      retroRequestedAt: payload.applyRetro ? now : null,
    }).returning({ id: rulesTbl.id });
    const lastSeq = await recordChange(ledger(tx), {
      accountId, entityType: "rule", entityId: row!.id, op: "create", meta: null,
    });
    return { applied: true, op: "create", ruleId: row!.id, lastSeq };
  }

  const found = await findRuleByKey(tx, accountId, key);
  /* NOT FOUND IS AN OUTCOME, NOT A FAULT. The reader is editing a rule this organizer's store does
     not have — deleted here since, or never travelled. Named back so the person is told, on the
     move applier's reasoning: a record that quietly disappeared leaves them unable to tell
     "done" from "never happened". */
  if (!found) return { applied: false, refusal: "no_such_rule" };

  if (payload.op === "delete") {
    await tx.delete(rulesTbl).where(and(eq(rulesTbl.id, found.id), eq(rulesTbl.accountId, accountId)));
    const lastSeq = await recordChange(ledger(tx), {
      accountId, entityType: "rule", entityId: found.id, op: "delete", meta: null,
    });
    return { applied: true, op: "delete", ruleId: found.id, lastSeq };
  }

  const set: Partial<typeof rulesTbl.$inferInsert> = { updatedAt: now };
  if (payload.set.destination !== undefined) set.destination = payload.set.destination;
  if (payload.set.priority !== undefined) set.priority = payload.set.priority;
  if (payload.set.enabled !== undefined) set.enabled = payload.set.enabled;

  /* RE-OPEN THE BACKLOG ONLY WHEN THE ROUTING ACTUALLY MOVED, compared against the STORED value.
     The key fields cannot move (the validator refuses that), so `destination` is the only term of
     "which mail does this claim and where does it go" an update can change — `priority` reorders
     rules against each other without changing what any one of them files, and `enabled` is
     handled by the pass itself. */
  const retargeted = set.destination !== undefined && set.destination !== found.destination;
  if (retargeted && payload.applyRetro) {
    set.retroRequestedAt = now;
    set.retroDoneAt = null;
    set.retroCursor = null;
  }

  await tx.update(rulesTbl).set(set)
    .where(and(eq(rulesTbl.id, found.id), eq(rulesTbl.accountId, accountId)));
  const lastSeq = await recordChange(ledger(tx), {
    accountId, entityType: "rule", entityId: found.id, op: "update", meta: null,
  });
  return { applied: true, op: "update", ruleId: found.id, lastSeq };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE OTHER DIRECTION — AN INTENT THIS INSTALL MAY NO LONGER CARRY OUT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Everything above is the ORGANIZER receiving a request. This is the moment a host STOPS being
 * the organizer, and it is the same wire format read from the other end.
 *
 * ── THE SEQUENCE, AND WHY NEITHER GATE CATCHES IT ──────────────────────────────────────────
 *
 * Another install takes the mailbox. Between that takeover and this host's next lease poll its
 * `organizer_role` still reads `organizer`, so a paired device's forwarded move passes
 * `assertOrganizerRole`, is recorded as a local `folder_state` intent and answered 200. The
 * drain's own live lease check then stands the mailbox down — correctly, exactly one organizer per
 * mailbox — and the intent is left behind: this install may not perform it (a reader's
 * `reconcileFolders` skips), and the install that CAN has never heard of it. The near side shows a
 * move that never reaches the mail server.
 *
 * The database role cannot close that window: it is a cached answer to a question only the mailbox
 * can settle, and refusing a paired device's write whenever the poll is merely late would break
 * an ordinary sleeping host. So the intent TRAVELS at the stand-down instead — as the
 * `message.move` request the door would have written had the role been current.
 */

/** The word for a canonical folder — {@link MOVE_DESTINATIONS} inverted, so the two cannot drift. */
const DESTINATION_WORD: ReadonlyMap<string, string> = new Map(
  [...MOVE_DESTINATIONS].flatMap(([word, path]) => (path === null ? [] : [[path, word] as [string, string]])),
);

/**
 * How many intents one stand-down hands over. The ingest batch's number: a mailbox with more
 * pending moves than this at the instant it changes hands is a state nobody has produced, and the
 * remainder is REPORTED rather than silently dropped.
 */
export const STAND_DOWN_EXPORT_MAX = 200;

/** What one stand-down handed over, so the caller can log a number rather than a hope. */
export interface StandDownExport {
  /** Intents written out as `message.move` requests for the install that holds the mailbox now. */
  exported: number;
  /** Intents already travelling — a repeated stand-down on the same row mints nothing. */
  already: number;
  /**
   * Intents whose desired folder no destination WORD covers — a user folder. A request may not
   * carry a raw IMAP path (see {@link MOVE_DESTINATIONS}), so these stay where they are and are
   * counted: a number in a log is a thing somebody can select, an absence is not.
   */
  unmappable: number;
  /**
   * TRUE when at least one intent was past {@link STAND_DOWN_EXPORT_MAX} — and a FLAG rather than
   * a count because the read is bounded at `limit + 1`: a number here could only ever say 0 or 1
   * while reading as a total, which is the quiet inaccuracy a log gets believed for.
   */
  more: boolean;
}

/**
 * HAND EVERY PENDING LOCAL MOVE TO THE INSTALL THAT HOLDS THE MAILBOX NOW.
 *
 * Called from the stand-down arm of both hosts' lease gates, in the same decision as the role
 * write. Best-effort by contract: standing down is a decision this process has already made and
 * may not be made contingent on a second write.
 *
 * `deleted_at` is deliberately NOT a filter, for the reason {@link applyMessageMove}'s own lookup
 * gives: a delete IS a move to Trash, its tombstone is local to this install, and leaving it
 * behind loses exactly the gesture that is hardest to notice.
 *
 * Idempotent on TWO independent terms, because one of them is not enough: the caller exports only
 * on the stand-down TRANSITION (a gate that answers `stand_down` every cycle would otherwise mint
 * a request per cycle), and a message already carrying a non-terminal `message.move` request is
 * skipped here — which covers two instances standing the same row down.
 */
export async function exportPendingMovesOnStandDown(
  tx: Tx,
  input: { accountId: string; mailboxId: string; now: Date; mintId: () => string; limit?: number },
): Promise<StandDownExport> {
  const limit = input.limit ?? STAND_DOWN_EXPORT_MAX;
  const [mb] = await tx.select({ trashFolder: mailboxes.trashFolder }).from(mailboxes)
    .where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.accountId, input.accountId))).limit(1);
  const trash = mb?.trashFolder ?? null;

  const pending = await tx.select({
    dedupKey: messages.dedupKey, desiredFolder: folderState.desiredFolder,
  })
    .from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(
      eq(messages.accountId, input.accountId),
      eq(messages.mailboxId, input.mailboxId),
      eq(folderState.reconcileStatus, "pending"),
      // OUR OWN intents only. A row the worker left pending from its own reconcile bookkeeping is
      // not somebody's decision to hand over.
      eq(folderState.lastSetBy, "us"),
    ))
    .orderBy(asc(folderState.updatedAt), asc(messages.id))
    .limit(limit + 1);

  // Everything already travelling for this mailbox, by the name both installs share.
  const inFlight = await tx.select({ payload: organizerRequests.payload })
    .from(organizerRequests)
    .where(and(
      eq(organizerRequests.mailboxId, input.mailboxId),
      eq(organizerRequests.kind, "message.move"),
    ));
  const travelling = new Set<string>();
  for (const r of inFlight) {
    const p = r.payload as { dedupKey?: unknown } | null;
    if (p && typeof p.dedupKey === "string") travelling.add(p.dedupKey);
  }

  const out: StandDownExport = { exported: 0, already: 0, unmappable: 0, more: false };
  for (const row of pending.slice(0, limit)) {
    if (row.dedupKey === null || row.dedupKey === "") { out.unmappable += 1; continue; }
    if (travelling.has(row.dedupKey)) { out.already += 1; continue; }
    const destination = row.desiredFolder === trash && trash !== null
      ? "trash"
      : DESTINATION_WORD.get(row.desiredFolder);
    if (destination === undefined) { out.unmappable += 1; continue; }
    await insertOrganizerRequest(tx, {
      id: input.mintId(),
      accountId: input.accountId,
      mailboxId: input.mailboxId,
      kind: "message.move",
      payload: { dedupKey: row.dedupKey, destination },
      decidedAt: input.now,
    });
    travelling.add(row.dedupKey);
    out.exported += 1;
  }
  out.more = pending.length > limit;
  return out;
}
