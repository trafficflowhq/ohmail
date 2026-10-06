/**
 * A `mailto:` pressed in a message, as the phone's composer takes it: the one parser every
 * surface reads (re-exported by the engine package) and its five fields, recipients typed as
 * the composer's fields type them. `undefined` for a link that asks for nothing, so a plain empty
 * compose opens.
 */
import { emptyMailtoDraft, parseMailto } from "@ohmail/client-engine";

export interface MailtoPrefill {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
}

export function mailtoPrefill(raw: unknown): MailtoPrefill | undefined {
  const d = parseMailto(raw);
  if (d === null || emptyMailtoDraft(d)) return undefined;
  return { to: d.to.join(", "), cc: d.cc.join(", "), bcc: d.bcc.join(", "), subject: d.subject, body: d.body };
}
