import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  insertOrganizerRequest, readRequestEligibility, readAccountErasedAt,
  AccountErasedError, OrganizedElsewhereError, MailboxNotFoundError, mailboxes,
  MOVE_DESTINATIONS, messages,
  type OrganizedBy, type RequestRefusalReason, type Tx,
} from "@trafficflow/db";
import {
  capabilityForKind, REQUEST_PAYLOAD_MAX_BYTES, type RequestKind,
} from "@trafficflow/core/adapters/organizer-lease";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE READER'S WRITE DOORS — one dispatch, four families (mail 0093)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * On a mailbox this install organizes, a write door writes. On a mailbox another install holds,
 * the same press becomes a REQUEST the holder applies — a row in `organizer_requests`, which the
 * reader's own cycle later signs and appends to `ohmail/_meta`
 * (`apps/worker/src/request-drain.ts#driveOutstandingRequests`). This module is the branch, and it
 * exists so that there is exactly one of it.
 *
 * ── EXTRACTED FROM `ScreenerService.requestAsReader`, WHICH WAS THE ONLY ONE ────────────────
 *
 * 0.14.1 shipped this shape for a single kind (`screener.decide`) inside the Screener's own
 * service. Mail 0093 adds three families — moves, rules and profile edits — and the alternative to
 * extracting was four copies of "read the eligibility, decide the branch, fence the account, write
 * the row". Four copies of a security branch is how one of them ends up asking a slightly
 * different question: the version that forgets the erasure fence, or the one that passes the wrong
 * capability and queues a decision nobody will ever take.
 *
 * ── THIS MODULE DOES NOT SIGN, AND THAT SURPRISES EVERY READER OF IT ───────────────────────
 *
 * A request is signed with a key derived from the mailbox PASSWORD (`deriveRequestKey`), which the
 * API tier does not hold — it has no IMAP connection and no credential. So the door writes a
 * `pending` ROW and stops. The reader's cycle, which does hold both, picks up every `pending` row
 * for the mailbox, signs it and appends it, KIND-AGNOSTICALLY: it reads `kind` and `payload` off
 * the row and formats the record. That is why a new kind needs no change on the sending side at
 * all, and why "signed" is a property of the channel rather than of this file.
 *
 * ── TWO DISPATCH SHAPES, BECAUSE THE FAMILIES ARE SCOPED DIFFERENTLY ───────────────────────
 *
 *  · PER-MAILBOX ({@link routeMailboxWrite}) — the write is about ONE mailbox's mail or one
 *    mailbox's own column. `message.move` and the mailbox signature. The question is "who holds
 *    THIS mailbox", and there is exactly one answer.
 *  · FAN-OUT ({@link planAccountFanOut}) — the write is ACCOUNT-scoped configuration (rules, the
 *    away responder, the screening preference, the dormancy window) that TRAVELS to whoever holds
 *    each mailbox. One press can therefore be a local write AND several requests at once, and the
 *    answer has to say which mailbox got which — see that function's header.
 */

/**
 * WHAT A DOOR ANSWERS WHEN THE WRITE DID NOT HAPPEN HERE — the record was written instead, and
 * the person is waiting on the install named in {@link holder}.
 *
 * `pending: true` is the discriminator every route switches its status code on (202, not 200 —
 * see `packages/api/src/routes/screener.ts`'s own note on why the replay would otherwise disagree
 * with the live call).
 */
export interface PendingRequest {
  pending: true;
  /** The `organizer_requests.id`, which is also the `X-Ohmail-Request-Id` the wire record carries. */
  requestId: string;
  /** Who this is waiting on, so the sentence names a machine rather than "another install". */
  holder: OrganizedBy;
}

/**
 * WHICH WAY A PER-MAILBOX DOOR GOES. `organizer` means the caller runs its OWN existing write path
 * unchanged — including its own locked `assertOrganizerRole` re-check, which this decision does
 * NOT replace and must not be read as replacing (see {@link routeMailboxWrite}).
 */
export type MailboxRoute =
  | { route: "organizer" }
  | { route: "request"; holder: OrganizedBy };

/**
 * DECIDE ONE PER-MAILBOX DOOR: does this install write, or does it ask?
 *
 * Throws {@link MailboxNotFoundError} when the account does not hold the mailbox or the mailbox is
 * a tombstone, and {@link OrganizedElsewhereError} when it is held by an install that will not
 * take this KIND of request — `organizer_outdated` when there is a holder that cannot, and
 * `no_organizer` when there is no holder at all. Those are two different sentences and a client
 * renders different affordances for them, which is why the reason travels.
 *
 * ── IT IS A PLAIN READ, AND IT IS NOT THE REFUSAL ───────────────────────────────────────────
 *
 * `readRequestEligibility` takes no lock, deliberately (its own header). That is right for
 * CHOOSING A BRANCH and is not evidence about a write that has not started yet: under READ
 * COMMITTED the worker's lease gate can commit a demotion between this read and the caller's
 * write. So the `organizer` arm here is a routing decision, and the caller still takes
 * `assertOrganizerRole`'s share lock inside its own transaction before writing. Deleting that
 * second check because "we already asked" would reintroduce exactly the interleaving
 * `assertOrganizerRole`'s header records.
 *
 * The capability is derived from the KIND rather than passed, so a door and the record it writes
 * cannot disagree about what the holder must advertise.
 */
export async function routeMailboxWrite(
  tx: Tx, accountId: string, mailboxId: string, kind: RequestKind,
): Promise<MailboxRoute> {
  const eligibility = await readRequestEligibility(
    tx, accountId, mailboxId, capabilityForKind(kind),
  );
  if (!eligibility) throw new MailboxNotFoundError(mailboxId);
  /* A TOMBSTONE IS NOT A READER — `ScreenerService.decide`'s rule, restated because it is the one
     every new door gets wrong. A removed mailbox keeps whatever `organizer_role` it had, so it
     reads `capable: false` and would fall to the request arm — which names a holder that holds
     nothing and offers a takeover of a mailbox that is gone. Not-found is what the row says. */
  if (eligibility.status === "disabled") throw new MailboxNotFoundError(mailboxId);
  if (eligibility.role === "organizer") return { route: "organizer" };
  if (!eligibility.capable) {
    throw new OrganizedElsewhereError(
      mailboxId, eligibility.by,
      eligibility.by.kind === null ? "no_organizer" : "organizer_outdated",
    );
  }
  return { route: "request", holder: eligibility.by };
}

/**
 * THE SYMBOLIC WORD FOR A CANONICAL FOLDER — the inverse of `MOVE_DESTINATIONS` (mail 0093).
 *
 * A `message.move` request names a WORD, never an IMAP path: the applier resolves it against the
 * mailbox on the machine that is actually connected, and a reader writing a path would be writing
 * its guess about somebody else's server. `request-apply.ts#MOVE_DESTINATIONS` carries the full
 * argument; the one with teeth is that a raw path is an instruction to file a person's mail outside
 * ohmail's own tree, where nothing here would ever look for it again.
 *
 * DERIVED from that map rather than typed out beside it, so the two cannot drift.
 *
 * ── HERE, AND NOT PRIVATE TO ONE DOOR ─────────────────────────────────────────────────────
 *
 * It began as a private method on `MessageService`. The moment a SECOND door needed it — the
 * approval decision, whose approve arm is a move — copying it would have been exactly the drift
 * that method's own comment warns about, with two inversions of one map free to disagree about a
 * folder rename. One place, both callers.
 *
 * `trash` is deliberately absent: it maps to `null` in the source map because it is discovered per
 * mailbox, and the delete door names the word directly rather than looking a path up.
 */
const DESTINATION_WORDS: ReadonlyMap<string, string> = new Map(
  [...MOVE_DESTINATIONS].flatMap(
    ([word, path]) => (path === null ? [] : [[path, word] as [string, string]]),
  ),
);

/**
 * The word for a canonical folder, or a 400.
 *
 * A THROW rather than a `?? folder` fallback, and that is the whole point: the fallback would put
 * whatever string arrived into the record's `destination`, which is the raw-path case the closed
 * set exists to make unrepresentable — and it would do it silently on the day somebody adds a
 * seventh folder and forgets the map. Every caller validates the folder first, so this is
 * unreachable from a well-formed request; failing loudly is the only version that stays true.
 */
export function moveDestinationWord(folder: string): string {
  const word = DESTINATION_WORDS.get(folder);
  if (word === undefined) {
    throw new ServiceError(
      "validation_failed", 400,
      `${folder} cannot travel to the install that organizes this mailbox — it is not one of the `
      + "places a request may name",
    );
  }
  return word;
}

/**
 * How many message ids one `IN` predicate carries.
 *
 * Postgres refuses a statement with more than 65 535 bind parameters, and the predicate below
 * binds one per id plus the account — so a single-statement version is refused at about 65 534
 * ids. That is not a theoretical number here: neither caller's array is bounded by anything. The
 * Hey migration's re-route pass names every message in the account whose sender or domain matches
 * a migrated observation, and a workflow undo names one id per recorded step, both from reads with
 * no `limit`. The failure would therefore arrive on the largest accounts and nowhere else, which
 * is the shape that reaches people rather than tests.
 *
 * Five hundred is `consent-seed.ts`'s `WRITE_CHUNK`, chosen there for the same arithmetic and kept
 * the same here so that "how many values fit in a statement" has one answer in this codebase.
 */
const READ_CHUNK = 500;

/**
 * REFUSE A BULK MOVE ON A READER, BY NAME, AND REFUSE IT WHOLE (mail 0093).
 *
 * Two doors move MANY messages from one press: `WorkflowsService.undoRun` (one move per recorded
 * step of a run, unbounded) and the Hey migration's RE-ROUTE PASS — `rerouteToMatchRules`, the
 * opt-in second half of the FORWARD verb, which walks every message in the account and files each
 * one whose sender or domain matches a migrated observation. Not the migration's UNDO, which removes
 * `provenance:'migrated'` rules and moves no mail at all. Both wrote `folder_state.desired_folder`
 * with `last_set_by: 'us'` and asked nothing about who organizes the mailboxes involved.
 *
 * ── WHY THEY REFUSE RATHER THAN TRAVEL, WHICH IS A RULING AND NOT A PREFERENCE ─────────────
 *
 * Converting them would mean N `message.move` records from ONE press. LB1's drain already carries
 * the guard against exactly that flood — it bounds appends to the headroom measured on the cycle
 * and leaves the rest `pending`, because *"filling the folder this way is a state that does not
 * heal on its own"*. A whole-account migration undo on a reader would therefore either sit
 * half-appended across many cycles or drive `ohmail/_meta` toward the ceiling from one button, and
 * a folder past that ceiling is unreadable by EVERY install. Ruling 6 gives `message.move` a
 * per-message natural key and no bulk form, no bound and no DTO for "pending n of m", so the bulk
 * shape is owed a design (0.17 `messages.move_many`) rather than an improvisation here.
 *
 * Deferring the TRAVEL is not deferring the TRUTH: until that design lands, these doors say no on
 * a mailbox this install only reads, and say which mailbox and who holds it.
 *
 * ── WHOLE, ON A MIXED ACCOUNT, AND THAT IS THE DELIBERATE PART ─────────────────────────────
 *
 * If ANY message the operation would move sits on a mailbox this install reads, the whole
 * operation is refused — including the moves that WOULD have been legal. A partial undo is worse
 * than a refused one: an undo is a single act in the person's head ("put this back the way it
 * was"), and half of one leaves a state nobody chose and no surface describes. It also runs before
 * any write, so a refusal leaves nothing behind.
 */
export async function refuseBulkMoveOnReader(
  tx: Tx, accountId: string, messageIds: readonly string[],
): Promise<void> {
  if (messageIds.length === 0) return;
  /* The DISTINCT mailboxes of the affected messages, account-scoped — a message id is not an
     authorisation. Distinct rather than per-message: an account holds one or two mailboxes, and
     asking the role once per message would be N reads for a question with N-of-two answers.

     READ IN CHUNKS, AND UNION THE ANSWERS. The question this asks — "which distinct mailboxes do
     these ids sit on" — is answered exactly by asking it of each slice and taking the union, so
     chunking costs a few round trips and changes no answer. The account fence is inside EVERY
     chunk's `where` rather than hoisted anywhere: a chunk is a whole statement, and a statement
     that asks about ids without saying whose account they belong to is the shape that leaks one
     account's mailbox id into another's refusal. */
  const mailboxIds = new Set<string>();
  for (let i = 0; i < messageIds.length; i += READ_CHUNK) {
    const chunk = messageIds.slice(i, i + READ_CHUNK);
    const rows = await tx.selectDistinct({ mailboxId: messages.mailboxId })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), inArray(messages.id, chunk)));
    for (const { mailboxId } of rows) mailboxIds.add(mailboxId);
  }

  for (const mailboxId of mailboxIds) {
    const e = await readRequestEligibility(
      tx, accountId, mailboxId, capabilityForKind("message.move"),
    );
    // A row that vanished, or a tombstone: not a mailbox this operation can move mail on, and not
    // a reason to refuse either — there is nothing there to organize or to read.
    if (!e || e.status === "disabled") continue;
    if (e.role === "organizer") continue;
    /* NAMED. `by` carries kind/name/since, so the sentence names the machine that holds it —
       "<that laptop> organizes this mailbox" — rather than "something else has one of these".
       No `reason` is passed: this is not a
       reader asking whether its press may become a request — there is no request shape for it yet —
       so the finer `organizer_outdated` / `no_organizer` distinction would answer a question
       nobody asked and would imply a channel that does not exist. */
    throw new OrganizedElsewhereError(mailboxId, e.by);
  }
}

/** A held mailbox whose holder will take this kind — one request goes to it. */
export interface FanOutTarget { mailboxId: string; holder: OrganizedBy }

/** A held mailbox whose holder will NOT, and why. Reported, never thrown, when others succeeded. */
export interface FanOutRefusal {
  mailboxId: string;
  holder: OrganizedBy;
  reason: RequestRefusalReason;
}

/**
 * WHAT ONE PRESS ON ACCOUNT-SCOPED CONFIGURATION ACTUALLY DOES, PER MAILBOX.
 *
 * Never one word. An account may hold several mailboxes with different roles, so a single edit is
 * a local write for the ones this install organizes AND a request to each install that holds one of
 * the others — at the same time, from one press.
 */
export interface AccountFanOut {
  /** Write the account's own row. False means the write would be dead here — see the planner. */
  writeLocally: boolean;
  /** The mailboxes this install organizes, which is WHY the local write is live. */
  organized: string[];
  /** One request each. */
  requestTo: FanOutTarget[];
  /** Held elsewhere by an install that cannot take this kind. */
  refused: FanOutRefusal[];
}

/**
 * PLAN THE FAN-OUT for an ACCOUNT-SCOPED door: rules, the away responder, the screening preference,
 * the dormancy window (mail 0093, ruling 6).
 *
 * ── WHAT THIS REPLACES, AND WHY IT IS NOT JUST A WIDER REFUSAL ─────────────────────────────
 *
 * `assertAccountOrganizes` asked one question — "does this account organize ANYTHING" — and refused
 * when the answer was no. That was right when a refusal was the only alternative to a dead write.
 * It has two costs now. On a MIXED account (one mailbox organized here, one held elsewhere) it
 * PERMITTED the write and nothing travelled, so the install holding the other mailbox never learned
 * the rule and the person was told their mail would be filed that way on both. And on an
 * all-reader account it refused where a request could have travelled.
 *
 * So the account-wide yes/no becomes a per-mailbox dispatch, and the caller reports the per-mailbox
 * outcome rather than one "saved".
 *
 * ── THE THREE STATES, AND THE ONBOARDING ONE IS THE EASY ONE TO GET WRONG ──────────────────
 *
 *  · ≥1 mailbox organized here ⇒ WRITE LOCALLY, plus a request to every capable holder.
 *  · 0 organized and ≥1 held   ⇒ NO local write. The row would be an instruction this install never
 *    carries out. Requests to the capable holders; if there are none, {@link OrganizedElsewhereError}
 *    naming the first holder we can name.
 *  · 0 organized and 0 held    ⇒ WRITE LOCALLY. This is CONSENT TIME — an account with no mailbox,
 *    or none live — and it is the state a fail-closed rule gets wrong. `organizer-role-census`'s own
 *    exemption for `consent-seed.ts` was written about exactly this: refusing here means a person
 *    cannot choose a window, name a tag or write a rule until they have connected a mailbox, which
 *    is precisely the moment nothing is organized yet. Account configuration is INERT until
 *    something organizes, and inert is not dangerous; what is dangerous is configuration that
 *    reaches an organizer which is somebody else's. It is a POSITIVE case by name in the suite,
 *    not an implicit fall-through.
 *
 * ── PER-MAILBOX READS RATHER THAN ONE PASS, DELIBERATELY ───────────────────────────────────
 *
 * `assertAccountOrganizes` projected everything it needed in a single SELECT. This asks
 * `readRequestEligibility` once per live mailbox instead, which is one round trip per mailbox on an
 * account that has one or two of them. The reason is that `capable` is not a column: it is a
 * conjunction over `status`, `organizer_state` and a parsed capability list, and re-deriving that
 * conjunction here would be a second implementation of the eligibility rule that could drift from
 * the one every per-mailbox door uses. One rule, asked N times, beats two rules asked once each.
 */
export async function planAccountFanOut(
  tx: Tx, accountId: string, kind: RequestKind,
): Promise<AccountFanOut> {
  // Live mailboxes only. A tombstone organizes nothing — `assertAccountOrganizes`' own reason: the
  // row keeps whatever `organizer_role` it had at removal, so counting it would let an account
  // whose only mailbox was deleted be told it still organizes something.
  const live = await tx.select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.accountId, accountId), ne(mailboxes.status, "disabled")));

  const organized: string[] = [];
  const requestTo: FanOutTarget[] = [];
  const refused: FanOutRefusal[] = [];

  for (const { id } of live) {
    const e = await readRequestEligibility(tx, accountId, id, capabilityForKind(kind));
    // A row that vanished between the two statements: it is not live any more, so it is not a
    // reason to refuse and not a place to send anything.
    if (!e || e.status === "disabled") continue;
    if (e.role === "organizer") { organized.push(id); continue; }
    if (e.capable) { requestTo.push({ mailboxId: id, holder: e.by }); continue; }
    refused.push({
      mailboxId: id, holder: e.by,
      reason: e.by.kind === null ? "no_organizer" : "organizer_outdated",
    });
  }

  const heldElsewhere = requestTo.length + refused.length;
  const writeLocally = organized.length > 0 || heldElsewhere === 0;

  /* NOTHING THIS PRESS COULD DO ANYWHERE. Every live mailbox is held by an install that will not
     take this kind, so there is no local write to make and no request to send — the one state that
     is still a refusal. Named from the first holder we can name, which is how the copy layer gets
     a machine into the sentence; a reader whose holder columns are still NULL yields
     `by.kind === null` and a different sentence. */
  if (!writeLocally && requestTo.length === 0) {
    const named = refused.find((r) => r.holder.kind !== null) ?? refused[0]!;
    throw new OrganizedElsewhereError(named.mailboxId, named.holder, named.reason);
  }

  return { writeLocally, organized, requestTo, refused };
}

/**
 * THE BYTE CEILING, ASKED AT THE DOOR IN THE CYCLE'S OWN UNITS.
 *
 * `formatRequest` THROWS when the base64url-encoded payload exceeds
 * {@link REQUEST_PAYLOAD_MAX_BYTES}, and it runs in the reader's CYCLE — long after this door
 * answered 202 to a person. Without this check an over-large payload is a row that is accepted,
 * fails to append on every pass for a day, and then expires as `outstanding_requests_never_sent`:
 * the person watched a spinner for something that was never going to travel, and every guard was
 * green the whole time.
 *
 * Measured the same way the cycle measures it — `base64url(JSON)` length, not the JSON's own byte
 * count — because base64 inflates by 4/3 and a bound expressed in the wrong unit is the
 * verification-shares-the-assumption failure with extra steps. A door with its own narrower rule
 * (the signature's 2 000 characters) still states that rule where it belongs; this is the backstop
 * that no payload can get past.
 */
function assertPayloadFits(kind: RequestKind, payload: unknown): void {
  const encoded = Buffer.from(JSON.stringify(payload ?? null), "utf8").toString("base64url");
  if (encoded.length > REQUEST_PAYLOAD_MAX_BYTES) {
    throw new ServiceError(
      "validation_failed", 400,
      `this ${kind} is ${encoded.length} bytes encoded, over the ${REQUEST_PAYLOAD_MAX_BYTES}-byte `
      + "ceiling for a request the other install can read — shorten it and try again",
    );
  }
}

/**
 * WRITE ONE REQUEST ROW. Nothing else happens: no local write, no IMAP, no signature.
 *
 * Takes the caller's transaction rather than opening its own, so that a door already inside one
 * (`MessageService.move` reads the message, decides, and writes in a single transaction) commits
 * the record with whatever else it decided, and a door outside one can pass the ambient handle.
 *
 * ── THE ERASURE FENCE IS THE FIRST THING THIS FUNCTION DOES ────────────────────────────────
 *
 * `erasure-fence.ts`'s rule for every writer of account-scoped state. A reader with a stale page
 * open could otherwise queue a request against an account whose erasure has already committed; the
 * organizer's drain would (correctly) fence it too, but the row should never exist. Callers that
 * touch `accounts` themselves must reach it BEFORE `mailboxes` — `deleteAccount` takes the same
 * row first, and crossing the two orders deadlocks. Every caller of this helper takes no lock
 * before it, so the order holds by construction.
 */
export async function writeReaderRequest(
  tx: Tx, ctx: ServiceContext,
  input: {
    mailboxId: string; kind: RequestKind; payload: unknown; holder: OrganizedBy;
    /** Supplied when the caller has already minted the id (an idempotency claim needs it early). */
    requestId?: string;
    decidedAt?: Date;
  },
): Promise<PendingRequest> {
  assertPayloadFits(input.kind, input.payload);
  const erasedAt = await readAccountErasedAt(tx, ctx.accountId);
  if (erasedAt != null) throw new AccountErasedError(ctx.accountId);

  const requestId = input.requestId ?? randomUUID();
  await insertOrganizerRequest(tx, {
    id: requestId,
    accountId: ctx.accountId,
    mailboxId: input.mailboxId,
    kind: input.kind,
    payload: input.payload,
    decidedAt: input.decidedAt ?? ctx.now(),
  });
  return { pending: true, requestId, holder: input.holder };
}
