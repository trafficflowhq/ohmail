/**
 * THE KEY FAMILIES OF THE COUNTERS: every shape a key of `auth_throttle` or `account_counters`
 * may take, and which of the two tables holds it. Data and pure readers: no driver, no schema.
 *
 * `auth_throttle` began as the sign-in lock and became the rolling-window counter of everything
 * (the mail quota, the registration slots, a mailbox's connection cap, an owed notice). Its keys
 * came in two kinds: a keyed hash or a fixed word, which names nobody, and an id in the clear,
 * which names a user, a mailbox or an account. Cloud 0101 splits them: what names a row moves to
 * `account_counters`, which carries the account; what is left names no row and carries none.
 *
 *   moves     the key names a row by its id: it lives in `account_counters`, under that row's account
 *   stays     the key is a keyed hash, a fixed word or a number: it lives in `auth_throttle`
 *   deleted   0101 deleted the rows (nothing could hold one while it ran); new ones are keyed hashes
 *             and live in `auth_throttle`
 *
 * A KEY OF NO FAMILY IS REFUSED, at the door (`account-counters.ts`) and by the tests. A new
 * counter brings its row here first.
 */
export type CounterKeyClass = "moves" | "stays" | "deleted";

/** The row a moving key names; its account is the counter's. */
export type CounterKeyParent = "user" | "mailbox" | "account";

export interface CounterKeyFamily {
  /** What every key of the family begins with. The longest matching prefix decides a key's family. */
  readonly prefix: string;
  readonly class: CounterKeyClass;
  /** A moving family: whose id the key carries. */
  readonly parent?: CounterKeyParent;
  /** The whole key. POSIX-safe, so the same text is a database check. */
  readonly shape: RegExp;
  readonly counts: string;
}

/** A keyed hash as `throttle-keys.ts` writes it: 32 hex characters. */
const H = "[0-9a-f]{32}";
/** An id in the clear. */
const U = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const shape = (body: string): RegExp => new RegExp(`^${body}$`);

export const COUNTER_KEY_FAMILIES: readonly CounterKeyFamily[] = [
  { prefix: "pw:", class: "stays", shape: shape(`pw:${H}:${H}`), counts: "the sign-in lock, per address and client" },
  { prefix: "pwa:", class: "stays", shape: shape(`pwa:${H}`), counts: "the per-address ceiling over every client" },
  { prefix: "known:", class: "stays", shape: shape(`known:${H}:${H}`), counts: "a client that completed a sign-in to the address" },
  { prefix: "email:", class: "stays", shape: shape(`email:${H}`), counts: "the first lock's hashed form: no writer, named by the erasure, pruned by age" },
  { prefix: "notice:ceiling:", class: "stays", shape: shape(`notice:ceiling:${H}`), counts: "a notice owed on an address nobody registered" },
  { prefix: "notice:factor:", class: "moves", parent: "user", shape: shape(`notice:factor:${U}`), counts: "an owed second-factor notice" },
  { prefix: "user:", class: "moves", parent: "user", shape: shape(`user:${U}`), counts: "second-factor refusals, 15 minutes" },
  { prefix: "factor-day:", class: "moves", parent: "user", shape: shape(`factor-day:${U}`), counts: "second-factor refusals, 24 hours" },
  { prefix: "mail:unsolicited:", class: "stays", shape: shape(`mail:unsolicited:${H}`), counts: "mail an anonymous caller can cause, per recipient" },
  { prefix: "mail:transactional:", class: "stays", shape: shape(`mail:transactional:(${H}|operator)`), counts: "mail the product owes someone, per recipient; the operator's slot holds no address" },
  { prefix: "waitlist:ip:", class: "stays", shape: shape(`waitlist:ip:${H}`), counts: "waitlist joins per client" },
  { prefix: "register:ip:open:", class: "stays", shape: shape(`register:ip:open:${H}`), counts: "open registrations per client" },
  { prefix: "register:ip:invite:", class: "stays", shape: shape(`register:ip:invite:${H}`), counts: "invited registrations per client" },
  { prefix: "verify:ip:", class: "stays", shape: shape(`verify:ip:${H}`), counts: "verification mails per client" },
  { prefix: "desktop_claim:ip:", class: "stays", shape: shape(`desktop_claim:ip:${H}`), counts: "desktop approval claims per client" },
  { prefix: "desktop_approval:ip:", class: "stays", shape: shape(`desktop_approval:ip:${H}`), counts: "desktop approval requests per client" },
  { prefix: "staff:email:", class: "stays", shape: shape(`staff:email:${H}`), counts: "the staff door, per address" },
  { prefix: "staff:ip:", class: "stays", shape: shape(`staff:ip:${H}`), counts: "the staff door, per client" },
  { prefix: "imap:refused:all:", class: "stays", shape: shape("imap:refused:all:[0-9]+"), counts: "refused mail connections, one bucket a minute for the whole service" },
  { prefix: "imap:mailbox:probe:", class: "moves", parent: "account", shape: shape(`imap:mailbox:probe:${H}:${U}`), counts: "a connect probe's slot" },
  { prefix: "imap:mailbox:", class: "moves", parent: "mailbox", shape: shape(`imap:mailbox:${U}`), counts: "one mailbox's connection slots" },
  { prefix: "probe-rate:", class: "moves", parent: "account", shape: shape(`probe-rate:(t:${H}:[0-9]+|a:[0-9]+):${U}`), counts: "the probes' budget over time" },
  { prefix: "live-body:", class: "deleted", shape: shape(`live-body:${H}`), counts: "live body fetches per account, an admission slot of minutes" },
];

/** The family `key` belongs to: the longest prefix it begins with. `null`: nobody classed it. */
export function familyOf(key: string): CounterKeyFamily | null {
  let found: CounterKeyFamily | null = null;
  for (const f of COUNTER_KEY_FAMILIES) {
    if (key.startsWith(f.prefix) && (found === null || f.prefix.length > found.prefix.length)) found = f;
  }
  return found;
}

/** The id a moving key carries: the key's last 36 characters, in every moving family. */
export function parentIdOf(key: string): string | null {
  const f = familyOf(key);
  return f?.class === "moves" && f.shape.test(key) ? key.slice(-36) : null;
}

/** The prefixes none of which begins with another of the list: what a statement by `LIKE` names. */
function covering(prefixes: readonly string[]): string[] {
  return prefixes.filter((p) => !prefixes.some((q) => q !== p && p.startsWith(q)));
}

/** The prefixes whose rows left `auth_throttle` in cloud 0101, moved or deleted. */
export const COUNTER_PREFIXES_THAT_LEFT: readonly string[] =
  covering(COUNTER_KEY_FAMILIES.filter((f) => f.class !== "stays").map((f) => f.prefix));

/**
 * The form from before the keys were hashed, `email:<address>`: known by the `@` it carries, which
 * no key of any family can (hex, ids, fixed words, numbers). 0101 deleted every such row.
 */
export function carriesAnAddress(key: string): boolean {
  return key.includes("@");
}
