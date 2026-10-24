/**
 * THE ONE ATTACH BOUND EVERY COMPOSE SURFACE STATES — the client-side mirror of the send
 * service's `effectiveAttachmentCap`/`attachmentBudgetFor` (a client bundle may not import a
 * server package), pinned value for value by the repository's `compose-attach-cap-parity` suite.
 * It lived in the webapp's `ComposeAttach` and the phone could not reach it there, so the phone
 * would have been a third implementation of a rule that had already drifted between two. The webapp
 * re-exports these under the same names; both composers now read one rule.
 */

/**
 * The inline transport's ceiling on total RAW attachment bytes — base64 attachment bytes on one
 * JSON request must clear the hosted API's serverless body limit (~4.5 MB) with room for the
 * envelope and the ~1.33× inflation. The strict fallback for any caller with no declared
 * surface; the same number as the adapter's `SEND_INLINE_MAX_TOTAL_BYTES` and the send
 * service's `SEND_ATTACHMENT_MAX_TOTAL_BYTES`, by the parity pin.
 */
export const COMPOSE_ATTACH_MAX_TOTAL_BYTES = 3 * 1024 * 1024;

/**
 * The ceiling on a forward's INHERITED files — the parts the server streams from the original,
 * which never ride the client's request. Mirrors the send's `FORWARD_MAX_TOTAL_BYTES`, same pin.
 */
export const COMPOSE_FORWARD_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * The envelope allowance behind an announced `SIZE`: headers, MIME boundaries, and the base64
 * wrap at 76 with CRLF — the expansion is (4/3)·(78/76), inverse exactly 19/26. Mirrors the
 * send's `SEND_MIME_ENVELOPE_BYTES`, same parity pin.
 */
export const COMPOSE_ATTACH_MIME_ENVELOPE_BYTES = 64 * 1024;

/**
 * What the hosted window's staging transport can carry — the staging bucket's per-object
 * ceiling, used as a per-total bound (always correct in the safe direction: if the total fits,
 * every file fits). Mirrors `SEND_STAGED_OBJECT_MAX_BYTES`.
 */
export const COMPOSE_ATTACH_STAGED_SURFACE_BYTES = 40 * 1024 * 1024;

/**
 * THE `SIZE` ASSUMED FOR A MAILBOX THAT HAS ANNOUNCED NONE — a provider-typical message limit,
 * budgeted like a real announcement (about 18 MiB of files). The 3 MB inline constant is a fact
 * about the hosted request body, not about a mail server, and it refused a 4 MB video on the
 * desktop's standalone door. Past this the server's own answer decides. Mirrors the send's
 * `SEND_UNMEASURED_MESSAGE_BYTES`, same parity pin.
 */
export const COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES = 25 * 1024 * 1024;

/** An announced `SIZE` converted to a budget for RAW attachment bytes. See the constants above. */
export function composeAttachBudgetFor(announcedMessageBytes: number): number {
  const forAttachments = announcedMessageBytes - COMPOSE_ATTACH_MIME_ENVELOPE_BYTES;
  if (forAttachments <= 0) return 1;
  return Math.max(1, Math.floor((forAttachments * 19) / 26));
}

/**
 * The ceiling a compose form may promise — the smaller of what the sending surface can carry
 * and what the sending mailbox's server said it will accept (RFC 1870 `SIZE`, from
 * `GET /mailboxes`). `surfaceMax`: ABSENT resolves to the strict constant (an untaught caller
 * gains no allowance by not passing it); `null` is explicitly uncapped (a staged-only send), the
 * mailbox's announcement governing; a number is that surface's ceiling. A mailbox with no usable
 * announcement counts as {@link COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES}. The mirror of
 * `effectiveAttachmentCap` in the services package.
 */
export function composeAttachCap(
  mailboxMax: number | null | undefined,
  surfaceMax?: number | null,
): number {
  const { surface, mailbox } = attachCapTerms(mailboxMax, surfaceMax);
  const bounds = [surface, mailbox].filter((n): n is number => n !== null);
  return bounds.length > 0 ? Math.min(...bounds) : composeAttachBudgetFor(COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES);
}

/**
 * THE TWO CANDIDATE CEILINGS, apart — so `composeAttachCap` and `composeAttachCapBinding` are
 * one rule read twice rather than two implementations that can disagree about a number and the
 * sentence printed beside it. `null` means "contributes no ceiling": a non-positive or
 * non-finite `SIZE` is RFC 1870 §6's "no fixed maximum", and an explicitly uncapped surface is
 * the one-process door's `null`.
 */
function attachCapTerms(
  mailboxMax: number | null | undefined,
  surfaceMax?: number | null,
): { surface: number | null; mailbox: number | null } {
  const usable = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n) && n > 0;
  const surface = surfaceMax === undefined ? COMPOSE_ATTACH_MAX_TOTAL_BYTES : surfaceMax;
  return {
    surface: usable(surface) ? surface : null,
    // UNPROBED counts as the assumed provider-typical `SIZE`; a REAL ANNOUNCEMENT is about the
    // encoded message, and both become a budget for raw bytes the same way.
    mailbox: mailboxMax === null || mailboxMax === undefined
      ? composeAttachBudgetFor(COMPOSE_ATTACH_UNMEASURED_MESSAGE_BYTES)
      : usable(mailboxMax) ? composeAttachBudgetFor(mailboxMax) : null,
  };
}

/** Which term produced {@link composeAttachCap}'s answer. See the function below. */
export type ComposeAttachCapBinding = "surface" | "mailbox" | "unmeasured";

/**
 * WHICH OF THE TWO CEILINGS THE STATED NUMBER CAME FROM, so a surface can say why a small one is
 * small: the desktop window carries less per send than the hosted browser stages, and a number
 * with no reason reads as a product disagreeing with itself.
 *
 * `"surface"` ONLY on a strict inequality against a MEASURED server: on a tie the mail server's
 * limit binds just as much, and for an unmeasured one "the server would take more" is a guess.
 */
export function composeAttachCapBinding(
  mailboxMax: number | null | undefined,
  surfaceMax?: number | null,
): ComposeAttachCapBinding {
  const { surface, mailbox } = attachCapTerms(mailboxMax, surfaceMax);
  /* An UNPROBED mailbox contributes an assumption; calling that "the mail server's limit" would
     state a fact nobody measured. */
  if (mailboxMax === null || mailboxMax === undefined) return "unmeasured";
  const announced = typeof mailboxMax === "number" && Number.isFinite(mailboxMax) && mailboxMax > 0;
  if (surface !== null && (mailbox === null || surface < mailbox)) return "surface";
  return announced ? "mailbox" : "unmeasured";
}
