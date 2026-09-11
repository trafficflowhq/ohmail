import { randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  insertOrganizerRequest, readRequestEligibility, readAccountErasedAt,
  AccountErasedError, OrganizedElsewhereError, MailboxNotFoundError, mailboxes,
  MOVE_DESTINATIONS, messages,
  type OrganizedBy, type RequestRefusalReason, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import {
  capabilityForKind, REQUEST_PAYLOAD_MAX_BYTES, type RequestKind,
} from "@trafficflow/core/adapters/organizer-lease";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";

/**
 * THE READER'S WRITE DOORS — one dispatch, four families (mail 0094). Where this install
 * organizes, a door writes; where another install holds, the press becomes a REQUEST — a row in
 * `organizer_requests` the reader's cycle signs and appends to `ohmail/_meta`
 * (`request-drain.ts`). Exactly ONE branch — copies of a security branch drift. IT DOES NOT SIGN:
 * the key derives from the mailbox PASSWORD (`deriveRequestKey`), which the API tier does not
 * hold — the door writes `pending` and stops; the cycle signs KIND-AGNOSTICALLY, so a new kind
 * changes nothing here. TWO SHAPES: PER-MAILBOX (`routeMailboxWrite`) and FAN-OUT
 * (`planAccountFanOut` — one press can be a local write AND several requests).
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
 * DECIDE ONE PER-MAILBOX DOOR: write, or ask? Throws `MailboxNotFoundError` when the account does
 * not hold the mailbox (or it is a tombstone), `OrganizedElsewhereError` when the holder will not
 * take this KIND — `organizer_outdated` for a holder that cannot, `no_organizer` for none: two
 * sentences, two affordances, so the reason travels. A PLAIN READ, NOT THE REFUSAL:
 * `readRequestEligibility` takes no lock — right for choosing a branch; under READ COMMITTED the
 * worker's lease gate can demote between this read and the write, so the caller still takes
 * `assertOrganizerRole`'s share lock in its own transaction. The capability derives from the
 * KIND, so a door and its record cannot disagree about what the holder must advertise.
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
 * THE SYMBOLIC WORD FOR A CANONICAL FOLDER — the inverse of `MOVE_DESTINATIONS` (mail 0094). A
 * `message.move` request names a WORD, never an IMAP path: the applier resolves it on the machine
 * actually connected; a raw path is an instruction to file mail outside ohmail's tree
 * (`request-apply.ts#MOVE_DESTINATIONS` carries the argument). DERIVED from that map so the two
 * cannot drift. HERE, not private to one door: it began on `MessageService`, and the approval
 * decision's approve arm needed the same inversion — one place, both callers. `trash` is
 * deliberately absent: it maps to `null` (discovered per mailbox), and the delete door names the
 * word directly.
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
 * How many message ids one `IN` predicate carries. Postgres refuses a statement with more than 65
 * 535 bind parameters, and the predicate binds one per id plus the account — a single-statement
 * version dies at about 65 534 ids. Not theoretical: neither caller's array is bounded — the Hey
 * migration's re-route pass names every matching message in the account, a workflow undo one id
 * per recorded step. The failure would arrive on the largest accounts and nowhere else. Five
 * hundred is `consent-seed.ts`'s `WRITE_CHUNK`, the same arithmetic, kept equal so "how many
 * values fit in a statement" has one answer in this codebase.
 */
const READ_CHUNK = 500;

/**
 * REFUSE A BULK MOVE ON A READER, BY NAME, AND WHOLE (mail 0094). Two doors move MANY messages
 * from one press: `WorkflowsService.undoRun` (one per recorded step) and the Hey migration's
 * RE-ROUTE PASS (`rerouteToMatchRules` — not the UNDO, which moves no mail). They refuse rather
 * than travel: N `message.move` records from one press would sit half-appended across cycles or
 * drive `ohmail/_meta` to the ceiling — a folder past it is unreadable by EVERY install; the bulk
 * shape is owed a design (`messages.move_many`). WHOLE on a mixed account: if ANY message sits on
 * a read-only mailbox the whole operation refuses — half an undo leaves a state nobody chose —
 * and it runs before any write, so nothing is left behind.
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
 * PLAN THE FAN-OUT for an ACCOUNT-SCOPED door: rules, away responder, screening preference,
 * dormancy window (mail 0094). Replaces the account-wide "organizes ANYTHING?" check, wrong both
 * ways: a MIXED account was PERMITTED a write that never travelled; an all-reader account was
 * refused a request that could travel. THREE STATES: ≥1 organized here ⇒ write locally + request
 * every capable holder. 0 organized, ≥1 held ⇒ NO local write; requests, or
 * `OrganizedElsewhereError`. 0 and 0 ⇒ WRITE LOCALLY — consent time: configuration is INERT until
 * something organizes. Per-mailbox reads: `capable` is a conjunction the eligibility rule owns —
 * one rule asked N times, not two that drift.
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
 * THE BYTE CEILING, ASKED AT THE DOOR IN THE CYCLE'S OWN UNITS. `formatRequest` throws past
 * `REQUEST_PAYLOAD_MAX_BYTES` — but it runs in the reader's CYCLE, long after this door answered
 * 202. Without this check an over-large payload is a row that is accepted, fails to append on
 * every pass, then expires as `outstanding_requests_never_sent`: a spinner for something that was
 * never going to travel, every guard green. Measured as the cycle measures — `base64url(JSON)`
 * length, not the JSON's bytes; base64 inflates by 4/3 and a bound in the wrong unit shares the
 * assumption it should check. A door with a narrower rule (the signature's 2 000 characters)
 * still states it; this is the backstop nothing gets past.
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
 * WRITE ONE REQUEST ROW. Nothing else: no local write, no IMAP, no signature. Takes the caller's
 * transaction, so a door already inside one (`MessageService.move` reads, decides and writes in a
 * single transaction) commits the record with whatever else it decided. THE ERASURE FENCE IS THE
 * FIRST THING THIS DOES — `erasure-fence.ts`'s rule for every writer of account-scoped state: a
 * reader with a stale page could queue a request against an erased account; the drain would fence
 * it too, but the row should never exist. Callers touching `accounts` themselves must reach it
 * BEFORE `mailboxes` — `deleteAccount` takes the same row first, and crossing the orders
 * deadlocks. Every caller takes no lock before this, so the order holds by construction.
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
  const erasedAt = await readAccountErasedAt(tx, dialect(ctx.db), ctx.accountId);
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
