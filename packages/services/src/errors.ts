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
 * Thrown by a mutation whose `claimIdempotencyKey` came back FALSE: a concurrent
 * transaction carrying the same `Idempotency-Key` committed first.
 *
 * Throwing is the mechanism, not a diagnostic — it rolls this transaction back, and
 * because the effect and the idempotency row are in ONE transaction, the rollback
 * undoes the duplicate effect in full. `withIdempotency` (`packages/api`) catches it and
 * replays the winner's stored response, so the client sees one effect and one answer
 * rather than two runs or a spurious 409.
 *
 * It is deliberately NOT a {@link ServiceError}: it must never reach `withErrorEnvelope`
 * as an HTTP status. If it ever does surface as a 500, that means the winner's row could
 * not be read back, which is a genuine fault and not something to paper over.
 */
export class IdempotencyRaceLost extends Error {
  constructor(readonly accountId: string, readonly key: string) {
    super("idempotency key was claimed by a concurrent request");
    this.name = "IdempotencyRaceLost";
  }
}

/**
 * THE DIAL COULD NOT BE ATTEMPTED **NOW**, AND ANOTHER CYCLE MAY DO BETTER.
 *
 * Thrown by an `OpenSendAdapter` that refused before any socket existed, for a reason that is
 * expected to pass — the hosted reconciler's per-mailbox IMAP admission counter being full is the
 * one that exists today. It says nothing whatever about the message.
 *
 * ── WHY IT IS A SEPARATE CLASS AND NOT A {@link ServiceError} ────────────────────────────────
 *
 * {@link SendService.resolveStale} reads a `ServiceError` from the adapter factory as "this
 * mailbox can never be dialled again" — the case where its credential rows are gone — and answers
 * `unverified` on the spot, because leaving such a row `pending` would strand it for ever. That
 * inference is right for a permanent refusal and CATASTROPHIC for a transient one: a mailbox
 * merely BUSY (the cap is two, and the attachment path holds the same slots) would have its
 * stranded reservation written to a terminal `unverified` WITHOUT THE SENT FOLDER EVER BEING
 * LOOKED AT — telling somebody to go and check for a message that is most likely sitting in it,
 * and terminal means no later cycle revisits it.
 *
 * So the distinction cannot live in `resolveStale`, which does not know what a given factory's
 * refusals mean. It lives with the factory that does: throw this, and the resolver propagates it
 * untouched so the caller defers the row and asks again next cycle.
 */
export class TransientDialRefusal extends Error {
  constructor(readonly mailboxId: string, reason: string) {
    super(reason);
    this.name = "TransientDialRefusal";
  }
}

/**
 * THE EVIDENCE WAS IN; WRITING IT DOWN IS WHAT FAILED.
 *
 * Raised by {@link SendService.resolveStale} when a finalize transaction throws AFTER the Sent
 * folder (or the mirror) has already answered. It exists to keep those two apart, because the
 * reconciling pass draws opposite conclusions from them:
 *
 *  · a PROBE that threw means the mailbox could not be asked, so after a day of trying the
 *    honest ending is `unverified`;
 *  · a WRITE that threw means the mailbox WAS asked and answered — possibly `sent` — and the
 *    only thing that failed was the database. Applying the give-up to that would take a probe
 *    answer of "the message is in Sent", discard it, and record the opposite: `unverified` for a
 *    message the Sent folder demonstrably held milliseconds earlier, terminally, with nothing
 *    ever re-examining it.
 *
 * So this one always defers. The next cycle re-probes and re-writes, and the row stays `pending`
 * meanwhile — which is exactly what a database that cannot commit should leave behind.
 */
export class SettleFailed extends Error {
  constructor(readonly decided: "sent" | "unverified", cause: unknown) {
    super(`the reservation could not be settled as ${decided}`);
    this.name = "SettleFailed";
    this.cause = cause;
  }
}
