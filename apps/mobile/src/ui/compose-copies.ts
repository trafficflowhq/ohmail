/**
 * A NEW MAIL'S COPIES — Cc and Bcc, where the letter carries them (a `mailto:` link, or a kept draft
 * that has them; PHONE-MAILTO-CC-BCC-NOT-CARRIED). Typed and refused as To is: an entry that does
 * not parse locks Send rather than narrowing who gets the mail. A letter that carries none shows
 * neither field, so the plain composer is unchanged.
 */
import { keptRecipients, parseRecipients } from "../state/live";

type Recipients = ReturnType<typeof keptRecipients>;

export interface TypedCopies {
  cc: string;
  bcc: string;
}

/** Whether the composer shows the two fields: decided once, from what the letter arrived with. */
export function copiesShown(seed: Partial<TypedCopies> | undefined): boolean {
  return (seed?.cc ?? "").trim() !== "" || (seed?.bcc ?? "").trim() !== "";
}

/** Both lists for the send, or `null` while an entry in either does not parse. */
export function copiesToSend(c: TypedCopies): { cc: Recipients; bcc: Recipients } | null {
  const cc = parseRecipients(c.cc);
  const bcc = parseRecipients(c.bcc);
  return cc === null || bcc === null ? null : { cc, bcc };
}

/** What a kept draft holds: the entries that parse, as To keeps its own. */
export function copiesToKeep(c: TypedCopies): { cc: Recipients; bcc: Recipients } {
  return { cc: keptRecipients(c.cc), bcc: keptRecipients(c.bcc) };
}
