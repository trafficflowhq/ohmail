/**
 * WHAT A MAIL ROW SAYS OUT LOUD — the phone's half of the row language.
 *
 * `MailRow` spoke the sender, the subject, the stamp and the read state, and every badge beside
 * them was drawn in silence: the conversation's count, the protected capsule, the history place,
 * the blocked tracker, the amount and the chip saying somebody wrote since this came back. The
 * facts are read from the very fields the strip draws from, so the spoken row and the drawn row
 * cannot come apart, and the ORDER is the web row's — `packages/ui/src/composites/row-spoken.ts`
 * holds it, and `test/mail-row-badges-spoken.test.ts` holds the two lists together.
 */
import { Copy } from "../copy";
import type { Mail } from "../state/model";

/** The badge facts this surface has. The head — name, subject, stamp, read state — comes first. */
export type PhoneRowBadgeKind = "thread" | "protected" | "newSince" | "tracker" | "place" | "amount";

/** The web's order, restricted to the badges this row wears. */
export const PHONE_ROW_BADGE_ORDER: readonly PhoneRowBadgeKind[] = [
  "thread",
  "protected",
  "newSince",
  "tracker",
  "place",
  "amount",
];

export interface PhoneRowBadgeFact {
  kind: PhoneRowBadgeKind;
  text: string;
}

/** "1 spy pixel blocked (open-tracker)" → "1 spy pixel blocked". */
export function trackerShort(note: string): string {
  return note.replace(/\s*\([^)]*\)\s*$/, "");
}

/**
 * How many messages this row stands for — 0 where it stands for one. Drawn and spoken from this
 * one read, so the count cannot appear on the strip without being said.
 *
 * The projection's count first: it is the conversation's length as the server knows it, and it is
 * the only answer a LIST row has, since only the reading view fills `earlier`. `earlier` stays as
 * the fallback for a row built without the projection, where the members in hand are the count.
 */
export function threadOfRow(m: Mail): number {
  if (m.threadCount !== undefined) return m.threadCount;
  return m.earlier.length > 0 ? m.earlier.length + 1 : 0;
}

/** Every badge the row wears, in the order it is spoken in. */
export function rowBadgeFacts(m: Mail): PhoneRowBadgeFact[] {
  const said: PhoneRowBadgeFact[] = [];
  const thread = threadOfRow(m);
  if (thread > 1) said.push({ kind: "thread", text: Copy.mailRowThreadAria(thread) });
  if (m.protected) said.push({ kind: "protected", text: Copy.protectedLead });
  /* The SENTENCE, not the chip's face: "2 new" read aloud in a list is a number and a word with
     no referent. The web row's own description makes the same substitution. */
  if (m.newSince) said.push({ kind: "newSince", text: Copy.mailRowNewSinceAria(m.newSince) });
  if (m.trackerNote) said.push({ kind: "tracker", text: trackerShort(m.trackerNote) });
  if (m.historyPlace) said.push({ kind: "place", text: m.historyPlace });
  if (m.amount) said.push({ kind: "amount", text: m.amount });
  const rank = (f: PhoneRowBadgeFact) => PHONE_ROW_BADGE_ORDER.indexOf(f.kind);
  return said.sort((a, b) => rank(a) - rank(b));
}

/** The row's whole accessibility label: its name and stamp, then everything it wears. */
export function mailRowSpoken(m: Mail): string {
  const head = Copy.mailRowAria(m.from.name, m.subject, m.time, !!m.unread);
  return [head, ...rowBadgeFacts(m).map((f) => `${f.text}.`)].join(" ");
}
