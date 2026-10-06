import { and, asc, desc, eq, inArray, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import {
  ACCOUNT_RULE_KEY_LOCK_CLASS, accountSettings, awayResponders, folderState, mailboxes, messages, organizerRequests,
  rules as rulesTbl,
} from "./schema-mail.js";
import { recordChange, recordRuleDelta, type LedgerTx, type Tx } from "./change-log.js";
import { dialect } from "./dialect/index.js";
import { insertOrganizerRequest, listPressLegs, TERMINAL_REQUEST_STATES } from "./organizer-requests.js";
import { accountWritesHere } from "./organizer-role.js";
import { decisionInstant, placementDecidedAfter } from "./press-floor.js";
import { NEWS_FOLDER, RULE_PRIORITY_MAX, canonicalNewsSpelling, ruleMatchKey } from "./screener-apply.js";
import { endGraduationOfRule } from "./learning-signal.js";
import { ruleMatchKeySql } from "./rule-match-sql.js";
import { convergeRuleKey, findRulesByKey, type FoundRule, type RuleKey } from "./rule-key.js";

/** The one bound, pinned beside the decide's lift in `screener-apply.ts` and re-exported here. */
export { RULE_PRIORITY_MAX };

/**
 * `recordChange` wants `LedgerTx` (`PgTransaction`, narrower than `Tx`/`PgDatabase`) because it is
 * only safe inside an open transaction. Every caller here already is one, so this is the same cast
 * `screener-apply.ts` makes at its own call sites rather than a widening of what is safe.
 */
const ledger = (tx: Tx): LedgerTx => tx as unknown as LedgerTx;

/**
 * What an organizer does with a request that is not a Screener decision (mail 0094).
 * `screener-apply.ts` is the model: one transactional core, reached from BOTH the organizer's own
 * HTTP door and the request drain, so the two cannot drift into two answers about one action. In
 * `@trafficflow/db` because the worker may not import `@trafficflow/services` at runtime — a core
 * both the drain and the service tier run sits below both. `MessageService.move` cannot serve
 * this: a request crossed an install boundary through an IMAP folder, the reader's database has
 * different row ids, and the name both installs share is `messages.dedup_key`. Hence the natural
 * key `(dedupKey, destination)`, not an id.
 */

/**
 * The destination vocabulary is SYMBOLIC, and that is a security property: a request's
 * destination is one of these WORDS, never an IMAP path, resolved against THIS mailbox. `trash`
 * is not a constant — providers spell it differently and ohmail discovers it per mailbox (mail
 * 0065). A raw path is an instruction to move mail somewhere nobody chose: the record is a
 * message anyone with the mailbox password can append, and the signature proves WHO wrote it, not
 * that it is sane — a buggy reader could file mail where nothing ever looks again. The words
 * mirror core's `Destination` union; `request-apply.test.ts` holds them equal. `trash` maps to
 * `null` HERE and is resolved per mailbox in {@link applyMessageMove}.
 */
export const MOVE_DESTINATIONS: ReadonlyMap<string, string | null> = new Map([
  ["inbox", "INBOX"],
  ["screener", "ohmail/Screener"],
  ["reads", NEWS_FOLDER],
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
 * Validate a `message.move` payload that arrived through an RFC822 header. Untrusted: the writing
 * door validated it, then it crossed an install boundary through a mailbox another machine wrote
 * to, so it is validated again here, independently, before a single write. Returns `null` for ANY
 * failure — missing field, wrong type, unknown destination word, empty or over-long dedup key —
 * and the caller REFUSES the record, never coerces: a move is the least reversible thing here
 * after a delete. `dedupKey` is length-bounded even though the wire caps the whole payload: the
 * two bounds answer different questions, and a key longer than this cannot match any row this
 * codebase ever wrote, so refusing is more honest than truncating.
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
 * Why a move did not happen, when the record itself was valid. NOT refusals of the record —
 * outcomes the drain reports back so a person is told something true, each a state the reader
 * could not have known when it decided. `no_such_message`: no row in THIS database carries that
 * dedup key for that mailbox — the reader has a message this organizer never synced or has since
 * deleted; not an error, two installs legitimately hold different subsets. `no_trash_folder`: the
 * destination was `trash` and this mailbox has no discovered Trash path — ohmail never expunges,
 * so there is nowhere to put it and nothing to guess.
 */
export type MoveRefusal = "no_such_message" | "no_trash_folder" | "stale_press";

export interface ApplyMessageMoveInput {
  accountId: string;
  /** The mailbox the record named — already checked against the folder it was read FROM. */
  mailboxId: string;
  payload: ValidatedMovePayload;
  now: Date;
  /**
   * When the reader's press was made (`organizer_requests.decided_at`, the record's own stamp).
   * A placement decided on this store after it stands: the request is refused `stale_press` and
   * nothing is written. Absent = applied at `now`, as before.
   */
  decidedAt?: Date | null;
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
 * Apply one `message.move`, idempotently, writing DESIRED state and nothing else. It touches no
 * IMAP: it writes `folder_state.desired_folder`, and the reconciler performs the physical move —
 * a drain that dies half-way has recorded an intention or it has not. `observed_folder` is READ
 * AND PRESERVED, never written: an applier setting it would assert a fact it has not performed,
 * and the reconciler would compare desired against a lie and do nothing. Idempotency: the
 * caller's key first, and the write is an upsert on `folder_state.message_id`. `change_log` is
 * not deduplicated — a duplicate `move` row converges. A move to where the message already is
 * still writes: the ack must not depend on a race the reader cannot see.
 */
export async function applyMessageMove(
  tx: Tx, input: ApplyMessageMoveInput,
): Promise<ApplyMessageMoveResult> {
  const { accountId, mailboxId, payload, now } = input;
  const decidedAt = input.decidedAt ?? null;

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

  // THE STALE PRESS, before any write: a placement decided here after the reader's press stands.
  if (decidedAt !== null && await placementDecidedAfter(tx, msg.id, decidedAt)) {
    return { applied: false, refusal: "stale_press" };
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
    decidedAt: decisionInstant(decidedAt, now),
  }).onConflictDoUpdate({
    target: folderState.messageId,
    // `observedFolder` deliberately omitted → preserved. The worker owns it.
    set: {
      desiredFolder: to, lastSetBy: "us", reconcileStatus: "pending", conflict: false, updatedAt: now, trashedFrom,
      decidedAt: decisionInstant(decidedAt, now),
    },
  });

  const lastSeq = await recordChange(ledger(tx), {
    accountId, entityType: "message", entityId: msg.id, op: "move",
    meta: { from, to },
  });

  return { applied: true, messageId: msg.id, from, to, lastSeq };
}

/**
 * `profile.update` — the per-mailbox configuration a reader may ask the organizer to change.
 * Before it, a reader editing an away responder, a signature or a screening posture got 200 — the
 * write landed in the READER's own row, which the organizer never reads: on screen and in effect
 * nowhere, worse than a 409, because a refusal can be argued with and a success that changes
 * nothing cannot. Partial, and every PRESENT field replaces — a whole-document replace would let
 * two panes a minute apart silently undo one another. ABSENT is "leave it alone"; PRESENT
 * replaces, `null` included: `signature: null` is "I removed my signature". A payload naming NO
 * recognised field is refused rather than applied as a no-op.
 */

/** The longest signature a request may carry. See {@link validateProfileUpdatePayload}. */
export const PROFILE_SIGNATURE_MAX = 2_000;

/**
 * The longest MARKUP a request may carry, in {@link PROFILE_SIGNATURE_MAX}'s unit. Sized from the
 * column's own local cap the way the text half is: a local save is bounded at 10 000 characters
 * (mail 0098), the travelling text takes a fifth, and the markup takes the same fifth — an
 * INDEPENDENT bound that happens to equal the text's, so neither moves by editing the other. Both
 * halves at their bounds exceed the record's own 3 072-byte JSON ceiling, which is the documented
 * arrangement rather than an oversight: this bound is the sentence a person reads, and the wire
 * ceiling refuses at the reader's door instead of truncating.
 */
export const TRAVELLING_SIGNATURE_HTML_MAX_BYTES = 2_000;

/** `away_responders.audience` — the closed pair the column's own CHECK enforces. */
const AWAY_AUDIENCES: ReadonlySet<string> = new Set(["screened_in", "everyone"]);
/** `away_responders.throttle` — the closed four `away_responders_throttle_closed` enforces. */
const AWAY_THROTTLES: ReadonlySet<string> = new Set(["always", "per_message", "per_day", "per_week"]);
/**
 * `away_responders.piles` — the closed set `away_responders_piles_closed` enforces (mail 0096,
 * widened by mail 0101). A second spelling of core's `AWAY_ANSWERABLE_PILES`, not an import,
 * because the import does not compile: core depends on db, never the reverse. So the literal is
 * restated and `request-apply.test.ts` HOLDS THE TWO EQUAL — a pile added to the core set and not
 * here would be a scope that travels and is then refused as `invalid_payload`: a save that
 * appears to work and changes nothing. Exported for that guard alone; `AWAY_AUDIENCES` and
 * `AWAY_THROTTLES` have no such guard — both are closed by a CHECK as well.
 */
export const AWAY_PILES: ReadonlySet<string> = new Set([
  "INBOX", NEWS_FOLDER, "ohmail/Receipts", "ohmail/Screener",
]);
/**
 * The one member that needs the wider audience — `AWAY_SCREENER_FOLDER`, restated for the import
 * direction {@link AWAY_PILES} explains and held equal to it by `request-apply.test.ts`. A
 * `screened_in` responder never answers a waiting stranger, so a record asking for both states a
 * scope no pass can act on.
 */
export const AWAY_SCREENER_PILE = "ohmail/Screener";
/** `account_settings.ohbox_policy` — the closed pair, or `null` for "the product default". */
const OHBOX_POLICY_VALUES: ReadonlySet<string> = new Set(["people_only", "people_and_replied"]);
/**
 * `account_settings.ohbox_bar`'s ceiling in BYTES, the column CHECK's `octet_length`. Restated
 * from services' `OHBOX_BAR_MAX_BYTES` for the import direction {@link AWAY_PILES} explains;
 * `profile-fan-out-round-trip.test.ts` holds the two doors to one boundary.
 */
export const TRAVELLING_OHBOX_BAR_MAX_BYTES = 2048;
/** The three sub-keys the reader's screening door sends. Anything else refuses the record. */
const SCREENING_KEYS: ReadonlySet<string> = new Set(["ohboxPolicy", "ohboxBar", "screenerAutoApply"]);

/** The screening preference as it travels: partial, each present key replaces. */
export interface ProfileScreeningUpdate {
  ohboxPolicy?: string | null;
  ohboxBar?: string | null;
  screenerAutoApply?: boolean;
}

/** The away responder as it travels — the whole row, replaced together. */
export interface ProfileAwayUpdate {
  enabled: boolean;
  body: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  audience: string;
  throttle: string;
  /**
   * Which piles get a reply (mail 0096), or ABSENT from an install one release older. The one
   * optional member, for compatibility rather than style: `piles` began travelling later, so a
   * request written by a 0.15 install has an `awayResponder` and no `piles`, and refusing that
   * record would 400 that install's every responder save — including the save that turns the
   * responder OFF, the one save nobody may be prevented from making. ABSENT therefore means "this
   * request is not about the scope", and {@link applyProfileUpdate} leaves the stored array alone
   * — the recoverable direction: an existing row keeps its scope, a new row takes the column's
   * narrow default.
   */
  piles?: string[];
}

/** A `profile.update` payload, validated. Every field optional; at least one present. */
export interface ValidatedProfileUpdate {
  awayResponder?: ProfileAwayUpdate;
  signature?: string | null;
  /** `account_settings.screening_scope` — the dormancy window's other answer, never NULL. */
  screeningScope?: "window" | "all_time";
  /**
   * THE SIGNATURE'S MARKUP (mail 0098), or ABSENT from an install one release older.
   *
   * Three states, all reachable and all different: absent leaves the column alone, `null` is "this
   * signature has no formatting" — what a plain save means, and it has to be able to say so across
   * the wire or the holder keeps markup the words no longer match — and a string replaces.
   */
  signatureHtml?: string | null;
  dormancyDays?: number | null;
  screeningPreference?: ProfileScreeningUpdate;
}

/**
 * The screening preference, or `null` to refuse the record. The OBJECT is what every reader
 * sends; a bare posture string (or `null`) is the older spelling and means `{ ohboxPolicy }`.
 * An unknown sub-key, a value outside its set or an empty object refuses rather than being
 * dropped: a partial apply acked `applied` tells the reader an edit travelled that did not.
 */
function readScreeningUpdate(v: unknown): ProfileScreeningUpdate | null {
  if (v === null) return { ohboxPolicy: null };
  if (typeof v === "string") return OHBOX_POLICY_VALUES.has(v) ? { ohboxPolicy: v } : null;
  if (typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (Object.keys(r).some((k) => !SCREENING_KEYS.has(k))) return null;
  const out: ProfileScreeningUpdate = {};
  if ("ohboxPolicy" in r) {
    const p = r.ohboxPolicy;
    if (p !== null && !(typeof p === "string" && OHBOX_POLICY_VALUES.has(p))) return null;
    out.ohboxPolicy = p;
  }
  if ("ohboxBar" in r) {
    const b = r.ohboxBar;
    if (b !== null && typeof b !== "string") return null;
    // A NUL is a value the column cannot hold: refused here rather than failing the apply.
    if (typeof b === "string"
      && (Buffer.byteLength(b, "utf8") > TRAVELLING_OHBOX_BAR_MAX_BYTES || b.includes("\u0000"))) return null;
    out.ohboxBar = b;
  }
  if ("screenerAutoApply" in r) {
    if (typeof r.screenerAutoApply !== "boolean") return null;
    out.screenerAutoApply = r.screenerAutoApply;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** ISO 8601 or null, and anything else refuses the whole record. */
function asDateOrNull(v: unknown): Date | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Validate a `profile.update` payload that arrived through an RFC822 header —
 * `validateMovePayload`'s terms exactly: the writing door validated it, then it crossed an
 * install boundary through a mailbox another machine wrote to, so it is validated again here
 * before a single write. `null` for ANY failure, and the caller refuses the record. The bounds
 * are the columns' own closed sets, restated rather than imported for the dependency-direction
 * reason this package states elsewhere — and each is a CHECK in the schema too, so a value that
 * slipped past this function is refused by the database. Two gates, and the schema is the one
 * that holds when this code is wrong.
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

  /* THE SCOPE, the dial's other answer (mail 0083): the column is NOT NULL with a closed pair, so
     anything else, `null` included, refuses the record rather than being dropped. */
  if ("screeningScope" in o) {
    const scope = o.screeningScope;
    if (scope !== "window" && scope !== "all_time") return null;
    out.screeningScope = scope;
  }

  if ("dormancyDays" in o) {
    const d = o.dormancyDays;
    if (d === null) out.dormancyDays = null;
    else if (typeof d === "number" && Number.isInteger(d) && d > 0 && d <= 3_650) out.dormancyDays = d;
    else return null;   // a non-integer, a zero, a negative or a decade-plus window is not a window
  }

  if ("screeningPreference" in o) {
    const screening = readScreeningUpdate(o.screeningPreference);
    if (screening === null) return null;
    out.screeningPreference = screening;
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
    // The pile scope, when the sender is new enough to have one. `in` and not a truthiness check,
    // because three states mean different things: ABSENT is an older install with no scope to
    // send — the stored array is left alone; an EMPTY array is "answer nobody", a coherent ask; a
    // NON-MEMBER refuses the whole record. A non-member refuses rather than being filtered:
    // filtering would store a NARROWER scope than asked and ack it `applied` — the person told
    // their edit travelled while the responder answers a different set of mail. The refusal
    // reaches the reader as `invalid_payload`, a decision somebody can act on.
    if ("piles" in r) {
      const p = r.piles;
      if (!Array.isArray(p)) return null;
      const piles: string[] = [];
      for (const raw of p) {
        if (typeof raw !== "string") return null;
        // A pre-0.22 install still spells the News pile `ohmail/Reads`; canonicalized before the
        // membership so its ask is admitted, and stored canonical so new rows carry one spelling.
        const member = canonicalNewsSpelling(raw);
        if (!AWAY_PILES.has(member)) return null;
        /* DUPLICATES COLLAPSED, exactly as the local door's `validPiles` collapses them. The value
           is a SET ("which piles"), the CHECK is containment and admits `{INBOX,INBOX}`, and the
           two write paths producing different rows for the same ask is a diff nobody can read. */
        if (!piles.includes(member)) piles.push(member);
      }
      /* THE SCREENER PILE NEEDS `everyone` (mail 0101), and this door checks the pair because it
         has both halves in one record. Refused rather than filtered, for the same reason a
         non-member is: a narrower scope acked `applied` is a save that appears to travel and
         changes something else. */
      if (!(r.audience === "everyone" || !piles.includes(AWAY_SCREENER_PILE))) return null;
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
 * Apply one `profile.update`. `signature` is `mailboxes.signature` — two addresses, two sign-offs
 * — scoped by account AND id, so its correctness does not lean on a uniqueness constraint
 * elsewhere. Everything else is the ACCOUNT's. The transition-arming is mirrored:
 * `setScreeningPreference` arms the tidy pass on the TRANSITION into `people_only` (cursor NULLed
 * in the same write); without it the backlog stays unfiled; only on the transition, so a re-save
 * does not re-run it. No `change_log` for the account-scoped fields: the delta feed is keyed by
 * ENTITY and no client apply mirrors these; the profile document carries them to other installs,
 * and the write-behind's fingerprint dirty check notices the rows.
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
    // The scope is named in both arms only when the request carried one. Named in the SET as well
    // as `values`, and the SET half was the missing one: the row is replaced together, so a scope
    // present on the wire and absent from the SET travels and is ignored — the reader's pane
    // shows the scope it asked for coming back as the old one, acked `applied`. And ABSENT must
    // leave the column untouched rather than write the default — a conditional, not `??
    // AWAY_PILES_DEFAULT`: an older install's save would otherwise NARROW a scope its own pane
    // never showed. The insert arm needs no branch: an omitted column takes the table's own
    // `'{INBOX}'`, the same value the local door infers.
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

  if (payload.screeningScope !== undefined) {
    settings.screeningScope = payload.screeningScope;
    insert.screeningScope = payload.screeningScope;
    wrote.push("screeningScope");
  }

  if (payload.dormancyDays !== undefined) {
    settings.dormancyDays = payload.dormancyDays;
    insert.dormancyDays = payload.dormancyDays;
    wrote.push("dormancyDays");
  }

  const screening = payload.screeningPreference;
  if (screening?.ohboxBar !== undefined) {
    settings.ohboxBar = screening.ohboxBar;
    insert.ohboxBar = screening.ohboxBar;
    wrote.push("ohboxBar");
  }
  if (screening?.screenerAutoApply !== undefined) {
    // A boolean on the wire, a timestamp in the column: the local door's own mapping.
    settings.screenerAutoApplyAt = screening.screenerAutoApply ? now : null;
    insert.screenerAutoApplyAt = screening.screenerAutoApply ? now : null;
    wrote.push("screenerAutoApply");
  }
  if (screening?.ohboxPolicy !== undefined) {
    settings.ohboxPolicy = screening.ohboxPolicy;
    insert.ohboxPolicy = screening.ohboxPolicy;
    wrote.push("ohboxPolicy");

    if (screening.ohboxPolicy === "people_only") {
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

/**
 * `rule.create` | `rule.update` | `rule.delete` — a reader's rule, applied by the organizer. The
 * natural key is FOUR fields: there is no unique index on `(account_id, kind, match)`, and two
 * rules on one sender differing only in a narrowing term are two different rules on purpose — so
 * the key is `{kind, match, subjectContains, bodyContains}`; `{kind, match}` alone still names
 * the BARE rule the Screener promotes. The key cannot be edited: `set` may not contain a key
 * field — changing what a rule MATCHES is a different rule, expressed as a delete and a create.
 * The match compares as `ruleMatchKey` on both sides; twins under one key are resolved, not
 * refused: the router's order picks the acting one, a delete takes all, an edit collapses them.
 */

/** `rules.kind` — the three the routing engine switches over. */
const RULE_KINDS: ReadonlySet<string> = new Set(["sender", "domain", "header"]);
/** `rules_subject_contains_nonempty` / `rules_body_contains_nonempty` — 200 chars, non-blank. */
export const RULE_TERM_MAX = 200;
/** `rules.match` — bounded so a pathological value cannot reach a `WHERE` clause. */
export const RULE_MATCH_MAX = 512;

/** What identifies one rule on the wire; defined in the leaf `rule-key.ts`, which imports nothing from here. */
export type { RuleKey } from "./rule-key.js";

/** `rule.create`'s payload, validated. */
export interface ValidatedRuleCreate {
  op: "create";
  key: RuleKey;
  /** A {@link MOVE_DESTINATIONS} word, already refused for `trash` — see the validator. */
  destination: string;
  /** Absent when the request named none: an existing row keeps its own, a new one starts at 0. */
  priority?: number;
  enabled: boolean;
  applyRetro: boolean;
}

/**
 * THE TWO SHAPES A `rule.create` HAS TRAVELLED IN, named here and nowhere else. FLAT is what the
 * doors send ({@link ruleCreatePayload}) and what every shipped organizer reads:
 * `{ key, destination, priority?, enabled?, applyRetro? }`. NESTED is what earlier readers queued,
 * the three fields under `set`, which no organizer read, so each was refused `invalid_payload`. A
 * nested row still queued is read as the flat one. A payload naming a field in both places, or
 * anything else under `set`, is refused whole: reading half of it would apply one of two answers.
 */
const RULE_CREATE_FIELDS = ["destination", "priority", "enabled"] as const;

function ruleCreateFields(o: Record<string, unknown>): Record<string, unknown> | null {
  if (!("set" in o)) return o;
  const set = o.set;
  if (set === null || typeof set !== "object" || Array.isArray(set)) return null;
  const named = Object.keys(set);
  if (!named.every((f) => (RULE_CREATE_FIELDS as readonly string[]).includes(f))) return null;
  if (RULE_CREATE_FIELDS.some((f) => f in o)) return null;
  return set as Record<string, unknown>;
}

/** The flat `rule.create` payload every door sends. `destination` is a {@link MOVE_DESTINATIONS} word. */
export function ruleCreatePayload(input: {
  key: RuleKey; destination: string; priority?: number; enabled: boolean; applyRetro?: boolean;
}): Record<string, unknown> {
  const { key } = input;
  return {
    key: { kind: key.kind, match: key.match, subjectContains: key.subjectContains, bodyContains: key.bodyContains },
    destination: input.destination,
    // Unstated stays unstated on the wire: a 0 here would lower the organizer's raised rule.
    ...(input.priority === undefined ? {} : { priority: input.priority }),
    enabled: input.enabled,
    ...(input.applyRetro === undefined ? {} : { applyRetro: input.applyRetro }),
  };
}

/** `rule.update`'s payload, validated. `set` never contains a key field. */
export interface ValidatedRuleUpdate {
  op: "update";
  key: RuleKey;
  set: { destination?: string; priority?: number; enabled?: boolean };
  applyRetro: boolean;
  /**
   * Did the request SAY `applyRetro: true`, as opposed to saying nothing? The two differ here and
   * nowhere else: absence means "the sender had no opinion" and leaves the retarget rule below in
   * charge; an explicit yes is the person asking an existing rule for the mail already filed, which
   * re-arms it even when nothing about the rule moved. The local half is `RulesService.update`'s
   * `retroAsked`, and the two must stay one rule.
   */
  retroAsked: boolean;
  /**
   * An undo, not a press: the stored provenance is KEPT whatever the request names. It can never
   * set a provenance. Absent on every request but a reversal's.
   */
  keepProvenance?: boolean;
  /** With `keepProvenance` only: the inferred value an undo puts back over a `manual` row. */
  restoreProvenance?: RestorableProvenance;
}

/**
 * WHAT AN UNDO MAY PUT BACK — the inferred values, never `manual`. The phone's way back from a
 * committed Move read the rule before the Move's own PATCH made it the person's, and returns it
 * as it was. Admitted only beside `keepProvenance` and only over a `manual` row
 * ({@link restoredProvenanceSql}): it can undo a claim and never make one. Both doors read this.
 */
export const RESTORABLE_PROVENANCE: ReadonlySet<string> = new Set(["promoted", "seeded-from-sent", "migrated"]);
export type RestorableProvenance = "promoted" | "seeded-from-sent" | "migrated";

/** The compare-and-set: the restored value only where the stored row is `manual`, else what it is. */
export function restoredProvenanceSql(restore: RestorableProvenance): SQL {
  return sql`case when ${rulesTbl.provenance} = 'manual' then ${restore} else ${rulesTbl.provenance} end`;
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
  // The key every reader compares (`ruleMatchKey`): spaces trimmed, lower case — never a second one.
  const match = ruleMatchKey(o.match);
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
    const f = ruleCreateFields(o);
    if (f === null) return null;
    const destination = asRuleDestination(f.destination);
    if (destination === null) return null;
    // ABSENT IS UNSTATED, never 0: a create over a raised rule must not lower it.
    const priority = f.priority;
    if (priority !== undefined
      && (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > RULE_PRIORITY_MAX)) return null;
    const enabled = f.enabled === undefined ? true : f.enabled;
    if (typeof enabled !== "boolean") return null;
    return { op: "create", key, destination, ...(priority === undefined ? {} : { priority }), enabled, applyRetro };
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
      if (typeof p !== "number" || !Number.isInteger(p) || p < 0 || p > RULE_PRIORITY_MAX) return null;
      set.priority = p;
    }
    if ("enabled" in r) {
      if (typeof r.enabled !== "boolean") return null;
      set.enabled = r.enabled;
    }
    // An update naming nothing is not a change — the same rule `profile.update` follows.
    if (Object.keys(set).length === 0) return null;
    if (o.keepProvenance !== undefined && typeof o.keepProvenance !== "boolean") return null;
    // A restore travels only with the keep and a destination, and only as an inferred value:
    // refused whole otherwise (the local door's `validRestoreProvenance` refuses the same shape).
    const restore = o.restoreProvenance;
    if (restore !== undefined && (o.keepProvenance !== true || set.destination === undefined || typeof restore !== "string"
      || !RESTORABLE_PROVENANCE.has(restore))) return null;
    return {
      op: "update", key, set, applyRetro, retroAsked: o.applyRetro === true,
      ...(o.keepProvenance === true ? { keepProvenance: true } : {}),
      ...(restore === undefined ? {} : { restoreProvenance: restore as RestorableProvenance }),
    };
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
  /** A create whose row already held the requested state; `lastSeq` names collapsed twins' deletes, if any. */
  | { applied: true; op: "unchanged"; ruleId: string; lastSeq: bigint | null }
  | { applied: false; refusal: RuleRefusal };

/**
 * THE STATE A `rule.create` ASKS FOR, derived from the request type rather than listed by hand.
 *
 * `op` and `key` say WHICH rule; `applyRetro` says what to do with mail already filed. Everything
 * else in {@link ValidatedRuleCreate} is a column the request would write, so `Record` over that
 * key set means a field added to the interface does not compile until it is named here — and the
 * next field is covered rather than repeating this fix per field.
 */
type RuleCreateStateField = Exclude<keyof ValidatedRuleCreate, "op" | "key" | "applyRetro">;

const RULE_CREATE_STATE: Readonly<Record<RuleCreateStateField, keyof FoundRule>> = {
  destination: "destination",
  priority: "priority",
  enabled: "enabled",
};

/**
 * WHAT THE ROW WOULD HAVE TO CHANGE FOR THE REQUESTED STATE TO HOLD.
 *
 * Empty means it already holds and nothing is written — that idempotence is the whole reason the
 * key lookup exists, and a reconciler that rewrote every row on every replay would undo it.
 */
function ruleCreateDiff(found: FoundRule, want: ValidatedRuleCreate): Partial<typeof rulesTbl.$inferInsert> {
  const diff: Record<string, unknown> = {};
  for (const field of Object.keys(RULE_CREATE_STATE) as RuleCreateStateField[]) {
    const column = RULE_CREATE_STATE[field];
    // A field the request did not state asks nothing of the row (a create naming no priority).
    if (want[field] === undefined) continue;
    const same = field === "destination"
      ? samePlace(found.destination, want.destination)
      : found[column] === want[field];
    if (!same) diff[column] = want[field];
  }
  // A create is a person's press (the header): an inferred twin under the key becomes theirs, once.
  if (found.provenance !== "manual") diff.provenance = "manual";
  return diff as Partial<typeof rulesTbl.$inferInsert>;
}

/**
 * One place in either spelling: a rule stored before the News rename says `ohmail/Reads`, which
 * {@link canonicalNewsSpelling} (this package's copy of the rename's alias table) reads as News.
 * A request naming the place a rule already files to moves nothing and keeps the stored spelling.
 */
function samePlace(a: string, b: string): boolean {
  return canonicalNewsSpelling(a) === canonicalNewsSpelling(b);
}

/** What one create under a key did. `lastSeq` is `null` only when nothing at all was written. */
export type RuleCreateOutcome =
  | { created: true; ruleId: string; lastSeq: bigint; collapsed: string[] }
  /** The row under the key was written: its `update` delta is `lastSeq`. */
  | { created: false; changed: true; ruleId: string; lastSeq: bigint; collapsed: string[] }
  /** The row already held the request; `lastSeq` is the last collapsed twin's delete, if any went. */
  | { created: false; changed: false; ruleId: string; lastSeq: bigint | null; collapsed: string[] };

/**
 * ONE RULE PER FOUR-FIELD KEY, on both create doors: `POST /rules` on an organizing install and the
 * organizer's `rule.create` apply. A key that already has a row is RECONCILED, never doubled: its
 * destination, priority and enabled take the request's values, the row becomes the person's, its
 * twins collapse, and the backlog re-opens only when the routing moved. A request the row already
 * satisfies writes nothing to it and records no delta of its own; twins under the key collapse on
 * every path, one `delete` delta each. The account's rule-key lock comes first, so two
 * creates under one key cannot both read "no row". `match` is the stored spelling (the local door's
 * own); the lookup always compares `ruleMatchKey`.
 */
export async function reconcileRuleCreate(
  tx: Tx, input: { accountId: string; create: ValidatedRuleCreate; now: Date; match?: string },
): Promise<RuleCreateOutcome> {
  const { accountId, create, now } = input;
  const { key } = create;
  /* A ROW UNDER THIS KEY IS NOT THE ANSWER ON ITS OWN. The key names WHICH rule; it says nothing
     about where that rule files, how it ranks or whether it is on, and a reader working from a
     stale profile creates over the organizer's rule with a destination of their own. So the
     difference is applied here, before anything is acked or answered. */
  const converged = await convergeRuleKey(tx, { accountId, key });
  const existing = converged.survivor;
  if (existing) {
    const collapsed = converged.collapsed.map((t) => t.id);
    const twinSeqs = converged.twinSeqs;
    const diff = ruleCreateDiff(existing, create);
    // Nothing differs: no write and no delta, so no client is woken for a change that is not one.
    if (Object.keys(diff).length === 0) {
      return { created: false, changed: false, ruleId: existing.id, lastSeq: twinSeqs[twinSeqs.length - 1] ?? null, collapsed };
    }
    /* The backlog re-opens on the update path's terms: only when the ROUTING moved, never for a
       reorder or an on/off, and only if the request asked for the mail already filed. */
    const retro: Partial<typeof rulesTbl.$inferInsert> =
      diff.destination !== undefined && create.applyRetro
        ? { retroRequestedAt: now, retroDoneAt: null, retroCursor: null, retroMoved: 0 }
        : {};
    // Flat, not nested: the delta below is this write's door and the census reads them together.
    await tx.update(rulesTbl)
      .set({ ...diff, ...retro, updatedAt: now })
      .where(and(eq(rulesTbl.id, existing.id), eq(rulesTbl.accountId, accountId)));
    const lastSeq = (await recordRuleDelta(ledger(tx), accountId, [existing.id], "update"))[0]!;
    return { created: false, changed: true, ruleId: existing.id, lastSeq, collapsed };
  }
  const [row] = await tx.insert(rulesTbl).values({
    accountId,
    kind: key.kind, match: input.match ?? key.match,
    destination: create.destination,
    priority: create.priority ?? 0,
    enabled: create.enabled,
    // A create is a person's own press, never an inference.
    provenance: "manual",
    subjectContains: key.subjectContains,
    bodyContains: key.bodyContains,
    retroRequestedAt: create.applyRetro ? now : null,
    // The writer's clock: the reader's belt compares a press's `decidedAt` against it.
    updatedAt: now,
  }).returning({ id: rulesTbl.id });
  const lastSeq = (await recordRuleDelta(ledger(tx), accountId, [row!.id], "create"))[0]!;
  return { created: true, ruleId: row!.id, lastSeq, collapsed: [] };
}

/**
 * Apply one rule request. RETRO is the default: creating a rule applies it to mail already on
 * disk (mail 0034), so `retro_requested_at` is stamped on create unless the request says
 * otherwise, and on update when what the rule claims or where it sends actually MOVED — compared
 * against the STORED value, so a habit-click costs nothing — or when the request STATED
 * `applyRetro: true`, a person asking an existing rule for the mail already filed. `retro_done_at`
 * and `retro_cursor` are cleared with it: a re-arm that left the cursor at the end of a previous
 * run would resume there and move nothing. `provenance` is `manual`, never `promoted`: claiming
 * `promoted` would make an explicit rule look learned.
 */
export async function applyRuleRequest(
  tx: Tx, input: ApplyRuleRequestInput,
): Promise<ApplyRuleRequestResult> {
  const { accountId, payload, now } = input;
  const { key } = payload;

  if (payload.op === "create") {
    const out = await reconcileRuleCreate(tx, { accountId, create: payload, now });
    if (out.created) return { applied: true, op: "create", ruleId: out.ruleId, lastSeq: out.lastSeq };
    // The row was not written: `unchanged`, with the seq of the twins it collapsed if any went.
    if (!out.changed) return { applied: true, op: "unchanged", ruleId: out.ruleId, lastSeq: out.lastSeq };
    /* `op: "update"`, BECAUSE THAT IS WHAT THIS BRANCH DID: the row was already there and the
       difference was written into it. A seam that answers the request's word instead of what it
       did is one reader away from saying "created" about a rule that existed. */
    return { applied: true, op: "update", ruleId: out.ruleId, lastSeq: out.lastSeq };
  }

  // The rule-key lock before the first `rules` statement, as on every writer; the update arm's
  // converge re-takes it (re-entrant per transaction).
  await dialect(tx).advisoryLock(tx, ACCOUNT_RULE_KEY_LOCK_CLASS, accountId);
  const [found, ...twins] = await findRulesByKey(tx, accountId, key);
  /* NOT FOUND IS AN OUTCOME, NOT A FAULT. The reader is editing a rule this organizer's store does
     not have — deleted here since, or never travelled. Named back so the person is told, on the
     move applier's reasoning: a record that quietly disappeared leaves them unable to tell
     "done" from "never happened". */
  if (!found) return { applied: false, refusal: "no_such_rule" };

  /* A person's pause or removal under a sender's bare key, travelled here: every graduation of the
     sender ends, from zero, in every place, as on the install it was pressed on (`RulesService`).
     After the delta: the other writers of a graduation's row take the counter first. */
  const endsLearning = async (): Promise<void> => {
    if (key.subjectContains !== null || key.bodyContains !== null) return;
    await endGraduationOfRule(tx, accountId, { kind: key.kind, match: key.match });
  };

  if (payload.op === "delete") {
    // The sender's rule goes, not one byte-shape of it: every twin, one `delete` delta per row.
    const ids = [found.id, ...twins.map((t) => t.id)];
    await tx.delete(rulesTbl).where(and(eq(rulesTbl.accountId, accountId), inArray(rulesTbl.id, ids)));
    const seqs = await recordRuleDelta(ledger(tx), accountId, ids, "delete");
    await endsLearning();
    return { applied: true, op: "delete", ruleId: found.id, lastSeq: seqs[seqs.length - 1]! };
  }

  const set: Partial<typeof rulesTbl.$inferInsert> = { updatedAt: now };
  if (payload.set.destination !== undefined) {
    set.destination = samePlace(payload.set.destination, found.destination)
      ? found.destination : payload.set.destination;
  }
  if (payload.set.priority !== undefined) set.priority = payload.set.priority;
  if (payload.set.enabled !== undefined) set.enabled = payload.set.enabled;
  // A person's pause makes the row theirs whatever wrote it (`RulesService.update`'s rule).
  const paused = payload.set.enabled === false;
  if (paused && found.personDecidedAt === null) set.personDecidedAt = now;
  // A person naming where the rule files makes it theirs: `people_only` refiles an inference's mail.
  // An undo (`keepProvenance`) names the old place without being a press, so it keeps the row's.
  if (payload.set.destination !== undefined && payload.keepProvenance !== true) set.provenance = "manual";
  else if (payload.keepProvenance === true && payload.restoreProvenance !== undefined) {
    (set as Record<string, unknown>).provenance = restoredProvenanceSql(payload.restoreProvenance);
  }

  /* RE-OPEN THE BACKLOG ONLY WHEN THE ROUTING ACTUALLY MOVED, compared against the STORED value.
     The key fields cannot move (the validator refuses that), so `destination` is the only term of
     "which mail does this claim and where does it go" an update can change — `priority` reorders
     rules against each other without changing what any one of them files, and `enabled` is
     handled by the pass itself. */
  const retargeted = set.destination !== undefined && set.destination !== found.destination;
  // …or the request asked for the backlog outright, which is the one way to re-open a rule whose
  // routing did not move. `retroAsked` and not `applyRetro`: the latter defaults an absent field to
  // true, and a travelled habit-click would then re-walk everything.
  if ((retargeted && payload.applyRetro) || payload.retroAsked) {
    set.retroRequestedAt = now;
    set.retroDoneAt = null;
    set.retroCursor = null;
    set.retroMoved = 0;
  }

  // The person edited the one row they could see; its hidden twins collapse into it (the acting
  // row survives: `found` is the first under the key, which is `convergeRuleKey`'s default).
  await convergeRuleKey(tx, { accountId, key, survivor: found.id });
  await tx.update(rulesTbl).set(set)
    .where(and(eq(rulesTbl.id, found.id), eq(rulesTbl.accountId, accountId)));
  const lastSeq = (await recordRuleDelta(ledger(tx), accountId, [found.id], "update"))[0]!;
  if (paused) await endsLearning();
  return { applied: true, op: "update", ruleId: found.id, lastSeq };
}

/** Why the belt left a request's answer unapplied — logged once per request by the caller. */
export type ReaderSettleSkip =
  | "unreadable_payload" | "no_decided_at" | "press_unfinished" | "no_row_stamp" | "newer_local_write"
  | "removed_after";

/** One leg of a press, as {@link pressSettled} reads it. */
export interface PressLeg {
  state: string;
  refusedReason: string | null;
}

/**
 * HAS EVERY HOLDER A PRESS WAS SENT TO CARRIED IT OUT? Every leg finished. A leg is finished when
 * `applied`, or, for a delete only, refused `no_such_rule`: that holder's word that the end state,
 * nothing under the key, already holds there. `expired`, `pending`, `sent` and every other refusal
 * mean the press did not land on that mailbox, and the reader's row keeps saying what still runs
 * there. No legs is not a press. A mailbox refused at the press, or disabled since, has no leg.
 */
export function pressSettled(op: ValidatedRuleRequest["op"], legs: readonly PressLeg[]): boolean {
  const finished = (l: PressLeg): boolean => l.state === "applied"
    || (op === "delete" && l.state === "refused" && l.refusedReason === "no_such_rule");
  return legs.length > 0 && legs.every(finished);
}

function sameKey(a: RuleKey, b: RuleKey): boolean {
  return a.kind === b.kind && a.match === b.match
    && a.subjectContains === b.subjectContains && a.bodyContains === b.bodyContains;
}

/**
 * THE READER'S OWN ROWS FOLLOW THE ORGANIZERS' ANSWER, once per PRESS: the legs of one press share
 * its kind, key and `decidedAt` (one instant for the press), and the rows under the key move only
 * when {@link pressSettled} says every live holder carried it out or, for a delete, holds nothing
 * under the key. Called on an applied ack and on a delete refused `no_such_rule`, in the unit that
 * records it, with the organizer's apply at `decidedAt`. The rule-key lock precedes the leg read.
 * THE GUARD: any row under the key written at or after `decidedAt` is the person's later hand and
 * stands. A CREATE inserts only where its press wrote no row here.
 */
export async function settleReaderRuleRows(
  tx: Tx, accountId: string, request: { kind: string; payload: unknown; decidedAt: Date | null },
): Promise<{ settled: boolean; skipped?: ReaderSettleSkip }> {
  const v = validateRulePayload(request.kind, request.payload);
  if (v === null) return { settled: false, skipped: "unreadable_payload" };
  const at = request.decidedAt;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) return { settled: false, skipped: "no_decided_at" };
  // The create door's order: the account's rule-key lock, then the legs and the rows, so two final
  // legs of one press settling at once each read the other's committed state.
  await dialect(tx).advisoryLock(tx, ACCOUNT_RULE_KEY_LOCK_CLASS, accountId);
  const legs = (await listPressLegs(tx, accountId, request.kind, at))
    .filter((l) => { const lv = validateRulePayload(l.kind, l.payload); return lv !== null && sameKey(lv.key, v.key); });
  if (!pressSettled(v.op, legs)) return { settled: false, skipped: "press_unfinished" };
  const rows = await findRulesByKey(tx, accountId, v.key, { lock: true });
  if (rows.some((r) => !(r.updatedAt instanceof Date))) return { settled: false, skipped: "no_row_stamp" };
  if (rows.some((r) => r.updatedAt!.getTime() >= at.getTime())) return { settled: false, skipped: "newer_local_write" };
  if (v.op === "create" && rows.length === 0 && await accountWritesHere(tx, accountId)) {
    return { settled: false, skipped: "removed_after" };
  }
  const bare: ValidatedRuleRequest = v.op === "delete" ? v
    : v.op === "create" ? { ...v, applyRetro: false }
      : { ...v, applyRetro: false, retroAsked: false };
  return { settled: (await applyRuleRequest(tx, { accountId, payload: bare, now: at })).applied };
}

/**
 * The other direction — an intent this install may no longer carry out: the moment a host STOPS
 * being the organizer, the same wire format read from the other end. Another install takes the
 * mailbox; until this host's next lease poll its role still reads `organizer`, and a forwarded
 * move passes `assertOrganizerRole`, recorded as a local intent. The drain's live lease check
 * then stands the mailbox down and the intent is left behind: this install may not perform it,
 * and the install that CAN has never heard of it. The database role cannot close that window (a
 * cached answer to a question only the mailbox settles), so the intent TRAVELS at the stand-down
 * — as the `message.move` request the door would have written had the role been current.
 */

/** The word for a canonical folder — {@link MOVE_DESTINATIONS} inverted, so the two cannot drift. */
const DESTINATION_WORD: ReadonlyMap<string, string> = new Map(
  [...MOVE_DESTINATIONS].flatMap(([word, path]) => (path === null ? [] : [[path, word] as [string, string]])),
);

/**
 * How many intents one PAGE of the handover reads — the ingest batch's number.
 *
 * A PAGE SIZE and no longer a bound. It was read once and the remainder was reported as `more`,
 * which meant a mailbox holding one intent past this number handed over 200 of 201 and demoted
 * anyway: the last intent stayed pending on an install that may not perform it, in front of the
 * one install that could. The walk in {@link exportPendingMovesOnStandDown} now continues until
 * the pending set is exhausted, and the number below only decides how many rows one statement
 * reads.
 */
export const STAND_DOWN_EXPORT_MAX = 200;

/** What one stand-down handed over, so the caller can log a number rather than a hope. */
export interface StandDownExport {
  /** Intents written out as `message.move` requests for the install that holds the mailbox now. */
  exported: number;
  /** Intents already travelling — a repeated stand-down on the same row mints nothing. */
  already: number;
  /**
   * Intents this handover cannot express: a desired folder no destination WORD covers (a user
   * folder), and — failing closed — a message with no usable `dedup_key`. A request may not carry
   * a raw IMAP path (see {@link MOVE_DESTINATIONS}), so these stay exactly where they are: a
   * pending row, still counted in `MailboxDTO.pendingMoves`, performed if this install is ever
   * promoted again. The number is reported because an absence is not something anybody can select.
   */
  unmappable: number;
}

/** One pending local intent, as one page of the handover reads it. */
interface PendingIntentRow {
  dedupKey: string | null;
  desiredFolder: string;
  updatedAt: Date;
  messageId: string;
}

/**
 * Hand every pending local move to the install that holds the mailbox now. Called from the
 * stand-down arm of both lease gates, IN THE SAME TRANSACTION as the role write: a handover
 * without the demotion mints requests for a mailbox this install still believes it organizes; a
 * demotion without the handover is the lost filing — both halves land or neither. `deleted_at` is
 * NOT a filter: a delete IS a move to Trash, its tombstone is local, and leaving it behind loses
 * the gesture hardest to notice. Idempotent on TWO terms: the caller exports only on the
 * stand-down TRANSITION, and a message already carrying a non-terminal `message.move` request is
 * skipped — covering two instances standing the same row down.
 */
export async function exportPendingMovesOnStandDown(
  tx: Tx,
  input: { accountId: string; mailboxId: string; now: Date; mintId: () => string; limit?: number },
): Promise<StandDownExport> {
  const page = input.limit ?? STAND_DOWN_EXPORT_MAX;
  // The row lock is the FIRST statement, and it is what makes the read below complete.
  // `assertOrganizerRole` takes `FOR SHARE` on this row inside the transaction that records a
  // forwarded move, so an exclusive lock here is granted only once every such write in flight has
  // COMMITTED — its intent is visible to the read below — and a write arriving afterwards blocks,
  // re-reads the role this transaction demoted, and is refused. Exported, or refused: an intent
  // admitted between the read and the demotion is the sequence this closes. It is also why the
  // walk terminates: nothing can add to the pending set while the lock is held, so a strictly
  // advancing cursor exhausts a fixed set.
  const d = dialect(tx);
  const [mb] = await d.forUpdate(tx.select({ trashFolder: mailboxes.trashFolder }).from(mailboxes)
    .where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.accountId, input.accountId))));
  const trash = mb?.trashFolder ?? null;

  /* Everything already travelling for this mailbox, by the name both installs share — and
   * NON-TERMINAL ONLY. An `applied`, `refused` or `expired` row is a request that is OVER, and
   * counting it here made a LATER move of the same message read as one already handed over: the
   * new intent was dropped, the host demoted, and the mailbox never heard of it. `sent` and
   * `pending` are the two states in which a request is genuinely still travelling. */
  const inFlight = await tx.select({ payload: organizerRequests.payload })
    .from(organizerRequests)
    .where(and(
      eq(organizerRequests.mailboxId, input.mailboxId),
      eq(organizerRequests.kind, "message.move"),
      notInArray(organizerRequests.state, [...TERMINAL_REQUEST_STATES]),
    ));
  const travelling = new Set<string>();
  for (const r of inFlight) {
    const p = r.payload as { dedupKey?: unknown } | null;
    if (p && typeof p.dedupKey === "string") travelling.add(p.dedupKey);
  }

  const out: StandDownExport = { exported: 0, already: 0, unmappable: 0 };
  /* THE CURSOR IS A KEYSET AND NOT AN OFFSET, and it is not an optimization: exporting does not
     change `reconcile_status`, so re-reading the same predicate without one would return the same
     page for ever. `(updated_at, id)` is the order intents are handed over in — oldest first, the
     order the person made them — and it is unique because `messages.id` is. */
  let cursor: { updatedAt: Date; id: string } | null = null;
  /* ANNOTATED, and that is not decoration: the page read's `where` mentions the cursor and the
     cursor is assigned from the page's last row, so an inferred return type here is a cycle tsc
     refuses (TS7022) rather than a type it resolves. */
  const after = (c: { updatedAt: Date; id: string } | null): SQL[] => (c === null
    ? []
    /* THROUGH THE SEAM, never as a JS `Date` in a bare fragment: a value interpolated into raw
       SQL has no column to take its type from, so each store has to be handed the literal its own
       timestamp columns compare against — a server timestamp on one, epoch milliseconds on the
       other. Row-value comparison itself is standard and needs no arm. */
    : [sql`(${folderState.updatedAt}, ${messages.id}) > (${d.ts(c.updatedAt)}, ${d.castUuid(sql`${c.id}`)})`]);
  for (;;) {
    /* ANNOTATED for the same TS7022 reason `after` is: the page read mentions the cursor and the
       cursor is assigned out of the page's last row, so an inferred type here closes a cycle. */
    const rows: PendingIntentRow[] = await tx.select({
      dedupKey: messages.dedupKey, desiredFolder: folderState.desiredFolder,
      updatedAt: folderState.updatedAt, messageId: messages.id,
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
        ...after(cursor),
      ))
      .orderBy(asc(folderState.updatedAt), asc(messages.id))
      .limit(page);
    if (rows.length === 0) return out;
    for (const row of rows) {
      if (row.dedupKey === null || row.dedupKey === "") { out.unmappable += 1; continue; }
      if (travelling.has(row.dedupKey)) { out.already += 1; continue; }
      // Canonicalized: an intent written before the 0.22 rename desires `ohmail/Reads`, and
      // reading it as "no word covers this" would strand the hand-over exactly where it matters.
      const destination = row.desiredFolder === trash && trash !== null
        ? "trash"
        : DESTINATION_WORD.get(canonicalNewsSpelling(row.desiredFolder));
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
    const last = rows[rows.length - 1]!;
    cursor = { updatedAt: last.updatedAt, id: last.messageId };
    if (rows.length < page) return out;
  }
}
