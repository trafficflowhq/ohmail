import { randomUUID } from "node:crypto";
import {
  insertOrganizerRequest, readRequestEligibility, readAccountErasedAt,
  AccountErasedError, OrganizedElsewhereError, MailboxNotFoundError,
  type OrganizedBy, type Tx,
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
 *  · FAN-OUT — the write is ACCOUNT-scoped configuration (rules, the away responder, the screening
 *    preference, the dormancy window) that TRAVELS to whoever holds each mailbox. One press can
 *    therefore be a local write AND several requests at once. That shape lands with the rules
 *    family; this module carries the per-mailbox half first so the two do not have to be reviewed
 *    together.
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
