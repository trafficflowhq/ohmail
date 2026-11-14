import { IMAP_REFUSAL_KEY, imapAdmissionKey } from "../src/imap-admission.js";

/**
 * ONE COUNTER KEY PER FAMILY, written the way its builder writes it. The registry's test asks the
 * registry, cloud 0101's statements and the door about these; the transition's tests plant them
 * on a store in 1.0.11's shape.
 */
export const HASH = "0123456789abcdef0123456789abcdef";
export const OTHER_HASH = "fedcba9876543210fedcba9876543210";
export interface SampleIds { userId: string; mailboxId: string; accountId: string }

export const COUNTER_SAMPLES: Record<string, (ids: SampleIds) => string> = {
  "pw:": () => `pw:${HASH}:${OTHER_HASH}`,
  "pwa:": () => `pwa:${HASH}`,
  "known:": () => `known:${HASH}:${OTHER_HASH}`,
  "email:": () => `email:${HASH}`,
  "notice:ceiling:": () => `notice:ceiling:${HASH}`,
  "notice:factor:": (i) => `notice:factor:${i.userId}`,
  "user:": (i) => `user:${i.userId}`,
  "factor-day:": (i) => `factor-day:${i.userId}`,
  "mail:unsolicited:": () => `mail:unsolicited:${HASH}`,
  "mail:transactional:": () => "mail:transactional:operator",
  "waitlist:ip:": () => `waitlist:ip:${HASH}`,
  "register:ip:open:": () => `register:ip:open:${HASH}`,
  "register:ip:invite:": () => `register:ip:invite:${HASH}`,
  "verify:ip:": () => `verify:ip:${HASH}`,
  "desktop_claim:ip:": () => `desktop_claim:ip:${HASH}`,
  "desktop_approval:ip:": () => `desktop_approval:ip:${HASH}`,
  "staff:email:": () => `staff:email:${HASH}`,
  "staff:ip:": () => `staff:ip:${HASH}`,
  "imap:refused:all:": () => `${IMAP_REFUSAL_KEY}:1700000000000`,
  "imap:mailbox:probe:": (i) => `imap:mailbox:probe:${HASH}:${i.accountId}`,
  "imap:mailbox:": (i) => imapAdmissionKey(i.mailboxId),
  "probe-rate:": (i) => `probe-rate:t:${HASH}:60:${i.accountId}`,
  "live-body:": () => `live-body:${HASH}`,
};

/**
 * A family's other spellings, each as its builder writes it. Every one is of the family, fits its
 * shape and goes where the family goes.
 */
export const COUNTER_OTHER_SPELLINGS: Record<string, (ids: SampleIds) => string[]> = {
  // The submission server's slot of a connect probe, beside the incoming server's (packages/api, `smtpProbeAdmissionKey`).
  "imap:mailbox:probe:": (i) => [imapAdmissionKey(`probe:smtp:${OTHER_HASH}:${i.accountId}`)],
  // The account's own budget over time, beside the one per login typed (`spendProbeBudget`).
  "probe-rate:": (i) => [`probe-rate:a:3600:${i.accountId}`],
};

/** Every sample of a family: its first spelling, then the others. */
export function samplesOf(prefix: string, ids: SampleIds): string[] {
  return [COUNTER_SAMPLES[prefix]!(ids), ...(COUNTER_OTHER_SPELLINGS[prefix]?.(ids) ?? [])];
}
