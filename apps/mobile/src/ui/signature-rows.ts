/**
 * THE SIGNATURES PANE'S ROWS — one per live mailbox, the web's `SignaturesRow` rules. A row is a
 * report, not a control, where the signature in force is the organizer's (a reader mailbox whose
 * organizer published one) or where it carries formatting: this phone saves text, and a text save
 * clears markup, so it never offers to.
 */
import type { SignatureChange } from "../net/consent";

export interface SignatureRow {
  id: string;
  address: string;
  /** The stored text, `""` for none. */
  text: string;
  readOnly: boolean;
  /** Why the row is read only. */
  why: "organizer" | "markup" | null;
  /** Where its last change to the organizer went, while there is still something to say. */
  change: SignatureChange | null;
}

export function signatureRows(o: {
  mailboxes: readonly { id: string; address: string; status: string | null; organizerRole: string | null }[];
  signatures: Readonly<Record<string, string>>;
  signaturesHtml: Readonly<Record<string, string>>;
  sources: Readonly<Record<string, "organizer" | "local">>;
  changes: Readonly<Record<string, SignatureChange>>;
}): SignatureRow[] {
  return o.mailboxes.filter((m) => m.status !== "disabled").map((m) => {
    const organizer = m.organizerRole === "reader" && o.sources[m.id] === "organizer";
    const markup = (o.signaturesHtml[m.id] ?? "").trim() !== "";
    const change = o.changes[m.id];
    return {
      id: m.id,
      address: m.address,
      text: o.signatures[m.id] ?? "",
      readOnly: organizer || markup,
      why: organizer ? "organizer" : markup ? "markup" : null,
      // "Applied" is not news on a read; a change on its way or refused still is.
      change: change !== undefined && change.state !== "applied" ? change : null,
    };
  });
}
