/**
 * Typed application error. Services throw these; route handlers (1f) map them to
 * the `ApiError` envelope (contract §1.4). `code` is the stable machine code the
 * client switches on; `httpStatus` is the response status.
 */
export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

/**
 * Thrown by a mutation whose `claimIdempotencyKey` came back FALSE: a concurrent transaction
 * carrying the same `Idempotency-Key` committed first. Throwing is the mechanism, not a
 * diagnostic — it rolls this transaction back, and because the effect and the idempotency row are
 * in ONE transaction, the rollback undoes the duplicate effect in full. `withIdempotency`
 * (`packages/api`) catches it and replays the winner's stored response, so the client sees one
 * effect and one answer. Deliberately NOT a {@link ServiceError}: it must never reach
 * `withErrorEnvelope` as an HTTP status — if it surfaces as a 500, the winner's row could not be
 * read back, a genuine fault and not something to paper over.
 */
export class IdempotencyRaceLost extends Error {
  constructor(readonly accountId: string, readonly key: string) {
    super("idempotency key was claimed by a concurrent request");
    this.name = "IdempotencyRaceLost";
  }
}

/**
 * The dial could not be attempted NOW; another cycle may do better. Thrown by an
 * `OpenSendAdapter` that refused before any socket existed, for a reason expected to pass (the
 * per-mailbox IMAP admission counter being full). A separate class because {@link
 * SendService.resolveStale} reads a `ServiceError` from the factory as "this mailbox can never be
 * dialled again" and answers `unverified` on the spot — right for a permanent refusal,
 * catastrophic for a transient one: a mailbox merely BUSY would be written terminally
 * `unverified` without the Sent folder ever being looked at. The distinction lives with the
 * factory that knows what its refusals mean; the resolver defers the row.
 */
export class TransientDialRefusal extends Error {
  constructor(readonly mailboxId: string, reason: string) {
    super(reason);
    this.name = "TransientDialRefusal";
  }
}

/**
 * The evidence was in; writing it down is what failed. Raised by {@link SendService.resolveStale}
 * when a finalize transaction throws AFTER the Sent folder has already answered. Two cases the
 * reconciling pass reads oppositely: a PROBE that threw means the mailbox could not be asked —
 * after a day of trying the honest ending is `unverified`; a WRITE that threw means the mailbox
 * WAS asked and answered — applying the give-up would take "the message is in Sent", discard it,
 * and terminally record the opposite. So this one always defers: the next cycle re-probes and
 * re-writes, and the row stays `pending` — what a database that cannot commit should leave
 * behind.
 */
export class SettleFailed extends Error {
  constructor(readonly decided: "sent" | "unverified", cause: unknown) {
    super(`the reservation could not be settled as ${decided}`);
    this.name = "SettleFailed";
    this.cause = cause;
  }
}
