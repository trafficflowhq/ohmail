import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  insertOrganizerRequest, insertOrganizerRequestSet, readRequestEligibility, readAccountErasedAt,
  AccountErasedError, OrganizedElsewhereError, MailboxNotFoundError, mailboxes,
  MOVE_DESTINATIONS, messages,
  type OrganizedBy, type RequestRefusalReason, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import {
  capabilityForKind, REQUEST_PAYLOAD_MAX_BYTES, REQUEST_SET_MAX, type RequestKind,
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
 * changes nothing here.
 */

/* THREE SHAPES: PER-MAILBOX (`routeMailboxWrite`), FAN-OUT (`planAccountFanOut` — one press can
   be a local write AND several requests), and the SET (`planBulkMoveOnReader` +
   `writeReaderRequestSet` — one press is N records on one mailbox, keyed so a retry writes the
   rows it already wrote and no others). */

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

/**
 * THE ID OF ONE RECORD IN A PRESS'S SET — derived, never minted.
 *
 * A retried press must write the rows it already wrote and no others, so the id cannot come from
 * `randomUUID`: a second attempt would mint fresh ids, the organizer would apply both sets and
 * somebody's mail would move twice. `sha256` over the press's key and the record's own member,
 * folded into a version-8 UUID because the column is one. The two halves are joined through
 * `JSON.stringify`, so no member string can be spelled to collide with a different pair.
 */
export function requestIdInSet(batchKey: string, member: string): string {
  const h = createHash("sha256").update(JSON.stringify([batchKey, member]), "utf8").digest("hex");
  // Version 8 (custom) and the RFC variant, so the value is a well-formed UUID and not merely
  // 32 hex characters that happen to fit the column.
  const v = `${h.slice(0, 12)}8${h.slice(13, 16)}${"89ab"[parseInt(h[16]!, 16) % 4]}${h.slice(17, 32)}`;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/**
 * WHAT A DOOR ANSWERS WHEN ONE PRESS BECAME N RECORDS. {@link PendingRequest} could not say it:
 * it carries one id, and a caller handed one id for forty moves has no way to render "waiting on
 * forty" or to tell a retry from a first attempt.
 */
export interface PendingRequestSet {
  pending: true;
  /** The press's own key. Every record's id derives from it, so a retry IS this same set. */
  batchKey: string;
  /** The record ids, in the order the caller named their members. */
  requestIds: string[];
  /** How many rows THIS attempt wrote. Below `of` means an earlier attempt had written the rest. */
  written: number;
  /** How many records the press is, written now or already standing — `requestIds.length`. */
  of: number;
  /** Who this is waiting on, so the sentence names a machine rather than "another install". */
  holder: OrganizedBy;
}

/**
 * THE SET DOOR: one press, N records, one key (the bulk half of mail 0094) — the shape
 * {@link writeReaderRequest} cannot express, and the reason the many-from-one doors refused.
 *
 * The BOUND is asked here, where the count is known, and it refuses rather than emitting the
 * flood: {@link REQUEST_SET_MAX} is the folder's own read ceiling. The reader's cycle appends
 * inside its own headroom against that ceiling, so a set under the bound cannot make
 * `ohmail/_meta` unreadable however long it takes to drain.
 */
export async function writeReaderRequestSet(
  tx: Tx, ctx: ServiceContext,
  input: {
    mailboxId: string; kind: RequestKind; holder: OrganizedBy;
    /** The press's key — one string per press, stable across its retries. */
    batchKey: string;
    /** One per record: `key` identifies the member within the press, `payload` is the decision. */
    members: readonly { key: string; payload: unknown }[];
    decidedAt?: Date;
  },
): Promise<PendingRequestSet> {
  assertSetFits(input.kind, input.members.length);
  for (const m of input.members) assertPayloadFits(input.kind, m.payload);
  const erasedAt = await readAccountErasedAt(tx, dialect(ctx.db), ctx.accountId);
  if (erasedAt != null) throw new AccountErasedError(ctx.accountId);

  const records = input.members.map((m) => ({
    id: requestIdInSet(input.batchKey, m.key), payload: m.payload,
  }));
  const { written } = await insertOrganizerRequestSet(tx, {
    accountId: ctx.accountId, mailboxId: input.mailboxId, kind: input.kind,
    decidedAt: input.decidedAt ?? ctx.now(),
    records,
  });
  return {
    pending: true,
    batchKey: input.batchKey,
    requestIds: records.map((r) => r.id),
    written: written.length,
    of: records.length,
    holder: input.holder,
  };
}

/**
 * THE QUEUE BOUND, asked at the door. Separate from the byte ceiling and for a different reason:
 * that one is about one record being readable, this one is about the SET being drainable.
 */
function assertSetFits(kind: RequestKind, count: number): void {
  if (count > REQUEST_SET_MAX) {
    throw new ServiceError(
      "validation_failed", 400,
      `this press is ${count} ${kind} records, over the ${REQUEST_SET_MAX} one pass can carry to `
      + "the install that organizes this mailbox — narrow it and try again",
    );
  }
}

/** A held mailbox in a bulk move: the messages on it, and the holder its records go to. */
export interface BulkMoveTarget {
  mailboxId: string;
  holder: OrganizedBy;
  /** Its messages — with `dedupKey`, because that is how a `message.move` record names one. */
  messages: { id: string; dedupKey: string }[];
}

/**
 * WHAT A BULK MOVE DOES, PER MAILBOX (mail 0094, bulk half) — the ONE branch both
 * many-from-one-press move doors take, replacing the refusal they shared.
 *
 * Three answers. ORGANIZED here: the messages come back in `organized`. READ, with a holder that
 * takes `message.move`: they come back as a target and the caller writes one record each. A
 * holder that will NOT take the kind: refused WHOLE — travelling the rest would leave a state
 * nobody chose. The SET BOUND is asked over the total that would TRAVEL, before any write.
 */
export async function planBulkMoveOnReader(
  tx: Tx, accountId: string, messageIds: readonly string[],
): Promise<{ organized: string[]; requestTo: BulkMoveTarget[] }> {
  if (messageIds.length === 0) return { organized: [], requestTo: [] };
  /* The mailbox each id sits on, account-scoped — a message id is not an authorisation. Read in
     the same chunks `refuseBulkMoveOnReader` reads in, with the account fence inside EVERY chunk's
     `where`: a statement that asks about ids without saying whose account they belong to is the
     shape that leaks one account's mailbox id into another's refusal. */
  const byMailbox = new Map<string, { id: string; dedupKey: string }[]>();
  for (let i = 0; i < messageIds.length; i += READ_CHUNK) {
    const chunk = messageIds.slice(i, i + READ_CHUNK);
    const rows = await tx
      .select({ id: messages.id, mailboxId: messages.mailboxId, dedupKey: messages.dedupKey })
      .from(messages)
      .where(and(eq(messages.accountId, accountId), inArray(messages.id, chunk)));
    for (const { id, mailboxId, dedupKey } of rows) {
      const held = byMailbox.get(mailboxId);
      if (held) held.push({ id, dedupKey });
      else byMailbox.set(mailboxId, [{ id, dedupKey }]);
    }
  }

  const organized: string[] = [];
  const requestTo: BulkMoveTarget[] = [];
  for (const [mailboxId, rows] of byMailbox) {
    const e = await readRequestEligibility(
      tx, accountId, mailboxId, capabilityForKind("message.move"),
    );
    // A row that vanished, or a tombstone: nothing there to organize or to read, and not a reason
    // to refuse either.
    if (!e || e.status === "disabled") continue;
    if (e.role === "organizer") { organized.push(...rows.map((r) => r.id)); continue; }
    if (!e.capable) {
      /* NAMED. `by` carries kind/name/since, so the sentence names the machine that holds it
         rather than "something else has one of these". The finer reason travels too, now that
         there IS a channel: `organizer_outdated` is a holder that could be updated, `no_organizer`
         is a mailbox nothing holds — two sentences, two affordances. */
      throw new OrganizedElsewhereError(
        mailboxId, e.by, e.by.kind === null ? "no_organizer" : "organizer_outdated",
      );
    }
    requestTo.push({ mailboxId, holder: e.by, messages: rows });
  }
  // The bound over what would TRAVEL, before any write: a press whose queue cannot be drained in
  // one pass is refused where the count is known rather than half-appended across cycles.
  const travelling = requestTo.reduce((n, t) => n + t.messages.length, 0);
  assertSetFits("message.move", travelling);
  return { organized, requestTo };
}
