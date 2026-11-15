import { ServiceError, type SendDeps } from "@trafficflow/services/mail";
import type { ApiDeps } from "./deps.js";
import { makeSendAdapter } from "./send-adapter.js";
import { makeOpenAdapter } from "./attachments-adapter.js";

/**
 * A SEND'S KEY, AS THE CLIENTS MINT IT: a UUID, or a short tag in front of one. Required, and refused
 * past {@link SEND_KEY_MAX} characters: the reservation and a Cancel's tombstone keep it in a row
 * that is never pruned, so an unbounded header would be storage any session could grow.
 */
export const SEND_KEY_MAX = 64;
export function sendKeyOf(req: Request): string {
  const key = req.headers.get("idempotency-key");
  if (!key) throw new ServiceError("validation_failed", 400, "Idempotency-Key header is required");
  if (key.length > SEND_KEY_MAX) {
    throw new ServiceError("validation_failed", 400, `Idempotency-Key is longer than ${SEND_KEY_MAX} characters`);
  }
  return key;
}

/**
 * THE SEND'S DEPS, as every route that sends a letter builds them: one builder, so no route can
 * forget the storage cap, the owed copy or the host's ceilings and send down the branch an absent
 * setting selects.
 */
export function sendDepsOf(deps: ApiDeps): SendDeps {
  // Prod: decrypt both imap+smtp creds → connected ImapAdapter. Tests
  // may inject a fake/GreenMail send spy via `deps.services.sendAdapter`.
  const openSendAdapter = deps.services?.sendAdapter ?? ((mailboxId: string) => makeSendAdapter(deps, mailboxId));
  // Only ever OPENED on a forward (SendService calls it lazily), so a normal send builds this
  // factory and never dials. Streams the forwarded original's attachments from the user's own
  // IMAP, straight onto the outgoing message, never persisted.
  const openFetchAdapter = makeOpenAdapter(deps);
  return {
    openSendAdapter, openFetchAdapter,
    // Its clients replay a retryable answer under the same key.
    rearmTransient: true,
    // THE STORAGE CAP for the sent-copy projection. Every live host declares one
    // (`ApiDeps.storageCapOf` — the hosted deployment's subscription read, the local
    // hosts' typed UNMETERED). Passed through as-is: ABSENT means the service REFUSES
    // the projection (never unmetered) — `SendDeps.resolveStorageCap` carries the rule.
    ...(deps.services?.storageCapOf ? { resolveStorageCap: deps.services.storageCapOf } : {}),
    // WHICH HOST IS CARRYING THESE BYTES. Absent on the hosted API, which resolves to the
    // serverless body limit; `null` from the local engine, which has no request pipeline
    // between this handler and SMTP. `SendService` takes the SMALLER of this and the
    // mailbox's own announced `SIZE`, so neither host can send past what the user's mail
    // server said it will accept.
    //
    // For a send whose bytes are STAGED the service resolves this to `null` itself — those
    // bytes did not ride this host's request body, so a declaration about that body says
    // nothing about them. `sendSurfaceFor` holds that rule; this stays the host's honest
    // statement about its own pipeline.
    surfaceMaxTotalBytes: deps.services?.sendSurfaceMaxTotalBytes,
    // WHERE THE SENT COPY IS WAITED FOR: inside the request on Cloud, in memory where the host outlives it.
    ...(deps.services?.sendCopyOutlivesAnswer === true ? { copyOutlivesAnswer: true } : {}),
    ...(deps.services?.sendKeepOwedCopy !== undefined && deps.services.sendKeepOwedCopy !== false
      ? { keepOwedCopy: deps.services.sendKeepOwedCopy } : {}),
    ...(deps.services?.sendSubmissionCeilingMs !== undefined
      ? { submissionCeilingMs: deps.services.sendSubmissionCeilingMs } : {}),
    ...(deps.services?.sendHoldOffer ? { holdOffer: deps.services.sendHoldOffer } : {}),
    // WHERE STAGED BYTES COME FROM. Absent on a host with no object storage — a local
    // install — and then a request naming staged references is REFUSED rather than sent
    // without its files.
    ...(deps.services?.attachmentStaging
      ? { stagedAttachments: deps.services.attachmentStaging(deps.db).source }
      : {}),
  };
}
