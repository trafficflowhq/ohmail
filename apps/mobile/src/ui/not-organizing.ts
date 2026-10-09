/**
 * THE PHONE'S TWIN of core's `notOrganizingYet` (`packages/core/src/reader-refusal.ts`): a mailbox nobody agreed to
 * organize and no live holder organizes, so nothing screens it. The phone carries no core dependency, so the rule is
 * restated here over its own wire shape and `test/not-organizing-yet-parity.test.ts` holds the two to one table.
 * One difference is the wire's: the phone reads an absent consent as `null`, so a server too old to send the column
 * reads as not organizing — the direction that never claims screening without consent.
 */
import type { PhoneMailbox } from "../net/mailboxes";

export type NotOrganizingFacts = Pick<
  PhoneMailbox, "status" | "organizerRole" | "organizeConsentedAt" | "organizedBy" | "organizerState"
>;

export function notOrganizingYet(m: NotOrganizingFacts): boolean {
  if (m.status === "disabled" || m.organizerRole !== "reader") return false;
  if (m.organizeConsentedAt !== null) return false;
  const named = Boolean(m.organizedBy && (m.organizedBy.kind || (m.organizedBy.name && m.organizedBy.name.trim() !== "")));
  return !(named && m.organizerState !== "stopped");
}

/** Every live mailbox is one {@link notOrganizingYet} names — the only case the Screener's hint gives way. */
export function noneOrganized(rows: readonly NotOrganizingFacts[]): boolean {
  const live = rows.filter((m) => m.status !== "disabled");
  return live.length > 0 && live.every(notOrganizingYet);
}
