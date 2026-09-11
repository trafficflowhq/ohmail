import { and, asc, eq, isNull, notInArray, sql, type SQL } from "drizzle-orm";
import {
  accountSettings, awayResponders, folderState, mailboxes, messages, organizerRequests,
  rules as rulesTbl,
} from "./schema-mail.js";
import { recordChange, type LedgerTx, type Tx } from "./change-log.js";
import { dialect } from "./dialect/index.js";
import { insertOrganizerRequest, TERMINAL_REQUEST_STATES } from "./organizer-requests.js";

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
  "INBOX", "ohmail/Reads", "ohmail/Receipts", "ohmail/Screener",
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
      for (const member of p) {
        if (typeof member !== "string" || !AWAY_PILES.has(member)) return null;
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

/**
 * `rule.create` | `rule.update` | `rule.delete` — a reader's rule, applied by the organizer. The
 * natural key is FOUR fields: there is no unique index on `(account_id, kind, match)`, and two
 * rules on one sender differing only in a narrowing term are two different rules on purpose — so
 * the key is `{kind, match, subjectContains, bodyContains}`; `{kind, match}` alone still names
 * the BARE rule the Screener promotes. The key cannot be edited: `set` may not contain a key
 * field — changing what a rule MATCHES is a different rule, expressed as a delete and a create. A
 * duplicate pair is resolved, not refused: refusing would strand the person's edit forever, so
 * the oldest wins (`created_at`, then `id`) — stable across retries.
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
 * Apply one rule request. RETRO is the default: creating a rule applies it to mail already on
 * disk (mail 0034), so `retro_requested_at` is stamped on create unless the request says
 * otherwise, and on update ONLY when what the rule claims or where it sends actually MOVED —
 * compared against the STORED value, so a habit-click re-sending the same destination costs
 * nothing. `retro_done_at` and `retro_cursor` are cleared with it: a re-arm that left the cursor
 * at the end of a previous run would resume there and move nothing. `provenance` is `manual`,
 * never `promoted`: a request is a person pressing something on their own install, and claiming
 * `promoted` would make an explicit rule look learned.
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
    const last = rows[rows.length - 1]!;
    cursor = { updatedAt: last.updatedAt, id: last.messageId };
    if (rows.length < page) return out;
  }
}
