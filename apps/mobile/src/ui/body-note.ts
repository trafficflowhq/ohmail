import { Copy } from "../copy";
import type { WorldMail } from "../state/world";

type Row = Pick<WorldMail, "bodyState" | "bodyWithheld" | "bodyJunkLeaving">;

/** A spam verdict's husk on a message no longer in the spam pile — decided by the state layer. */
export function junkLeaving(m: Row): boolean {
  return m.bodyState === "withheld" && m.bodyJunkLeaving === true;
}

/**
 * THE SENTENCE A WITHHELD BODY GETS ON THE PHONE — per marker, as on the web: the storage cap
 * names the space, the verdict names Junk only while the message is in the spam pile, a husk
 * moved out is loading until `refillExpired`, then the preview is all that could be read; a
 * message over the download ceiling names the ceiling.
 */
export function withheldNote(m: Row, refillExpired: boolean): string {
  if (junkLeaving(m)) return refillExpired ? Copy.liveBodyFailed : Copy.liveBodyJunkLoading;
  switch (m.bodyWithheld) {
    case "junk_filed": return Copy.liveBodyWithheldJunk;
    case "expunged": return Copy.liveBodyWithheldExpunged;
    case "too_large": return Copy.liveBodyWithheldTooLarge;
    default: return Copy.liveBodyWithheld;
  }
}

/**
 * A MEETING INVITATION THE PHONE CANNOT SHOW SAYS SO — the web reader's `InvitationNote`. An OWA
 * stub in the full body text (`owaInvitationOf`, decided in the state layer) names the setting,
 * with core's options link (built from constants, Microsoft 365 hosts only, never the message's URL);
 * otherwise the header fact says the generic line.
 */
export function invitationNote(
  m: Pick<WorldMail, "bodyState" | "owaInvitation" | "invitationWithoutEvent">,
): { line: string; href: string | null } | null {
  const stub = m.bodyState === "full" ? m.owaInvitation : undefined;
  if (stub !== undefined) return { line: `${Copy.invitationOwaLink} ${Copy.invitationOwaRemedy}`, href: stub.optionsHref };
  if (m.invitationWithoutEvent === true) return { line: Copy.invitationWithoutEvent, href: null };
  return null;
}
