/**
 * Why a reader did not answer: one closed list for all four providers. A refusal is a word of it and
 * nothing else: never an address, a host, a header, a body or a provider's own text, because the
 * word is stored with the connection and read by people who are not the account's owner.
 */
export const PROVIDER_REFUSALS = [
  // ── the sign-in ──
  /** The provider refused the credential: a 401, or a 207 that names nobody. Never retried in a loop. */
  "sign_in_refused",
  /** A token answer without a scope that is needed, or without a lasting sign-in. Nothing of it is kept. */
  "sign_in_incomplete",
  /** The lasting sign-in is no longer accepted. The person connects again; nothing retries before that. */
  "consent_needed",

  // ── what the provider said of the thing asked for ──
  /** Signed in, and not allowed to read this. For a subscription: the address is no longer readable. */
  "forbidden",
  "not_found",
  /** No calendar service at the address, by any of the starts the standard names. */
  "no_service",
  /** An answer came, and it holds no calendar. Its content type decides nothing. */
  "not_a_calendar",
  /** Gone for good (410): a subscription that ended. The last copy stays; nothing is asked again. */
  "ended",
  /** The token no longer names a state the provider keeps. The caller reads the calendar whole again. */
  "token_gone",
  /** Too many requests, or busy. The answer's `retryAfterMs` says how long, where the provider did. */
  "throttled",
  /** The provider answered with a fault of its own (5xx). */
  "unavailable",

  // ── the address, each decided before a socket opens ──
  /** No address at all: unparseable, too long, another scheme, or with a user and password inside. */
  "address_invalid",
  /** An address this deployment does not fetch: its own network, a metadata host, a name that leaves no building. */
  "address_not_allowed",
  /** A port below 1024 that is neither 80 nor 443. No calendar server is known there; mail servers are. */
  "port_not_allowed",
  "host_unresolved",
  /** A redirect or a discovered address names a host the credential may not travel to. No request is made. */
  "host_changed",
  "too_many_redirects",
  /** A redirect with no target, an unreadable one, or one from https to http. */
  "redirect_invalid",
  /** A provider's link to its next page that leaves the provider's base, names the page just read, or comes after the last page one call follows. */
  "page_link_refused",

  // ── the answer itself ──
  "timeout",
  "connection_failed",
  /** Past a ceiling: on bytes, on members, on nesting, on what one page may make a reader ask for. Never read in part. */
  "too_large",
  /** An answer that cannot be read as what was asked for: packed, in a markup that defines its own entities, no JSON. */
  "unreadable",

  // ── this program ──
  /** The provider has no such request (a subscription has no sign-in to check). */
  "unsupported",
  /** The provider is not switched on in the program that asked. */
  "provider_off",
  /** A word from a newer version of this list, or a status nothing here has a word for. */
  "unknown",
] as const;

export type ProviderRefusal = (typeof PROVIDER_REFUSALS)[number];

const KNOWN: ReadonlySet<string> = new Set(PROVIDER_REFUSALS);

/** A stored or received word as a word of this list: one this version does not know reads as `unknown`. */
export const asProviderRefusal = (word: string): ProviderRefusal => (KNOWN.has(word) ? (word as ProviderRefusal) : "unknown");
