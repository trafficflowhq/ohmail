/**
 * What a connection's sign-in is kept as. The store seals ONE text (`serializeCredential`) and
 * opens it again (`parseCredential`); between the two the values live in `Secret`s. This package
 * is handed a credential for one call and keeps nothing of it afterwards.
 */
import { MAX_URL_CHARS } from "./limits.js";
import type { Credential } from "./port.js";
import { Secret } from "./secret.js";

export type StoredCredential =
  /** A subscription: the address is the secret. */
  | { readonly kind: "address"; readonly url: Secret }
  /** CalDAV: a user and a password (at most providers an app password). */
  | { readonly kind: "basic"; readonly user: string; readonly password: Secret }
  /** Google, Microsoft: the lasting sign-in a pass trades for a short one. */
  | { readonly kind: "oauth"; readonly provider: "google" | "microsoft"; readonly refreshToken: Secret };

/** The stored form's version. A text of another version is not read. */
const VERSION = 1;

/** The longest stored text read: an address at its ceiling and its few names around it. */
export const MAX_CREDENTIAL_CHARS = MAX_URL_CHARS + 256;

function written(c: StoredCredential): string {
  switch (c.kind) {
    case "address":
      return JSON.stringify({ v: VERSION, kind: c.kind, url: c.url.reveal() });
    case "basic":
      return JSON.stringify({ v: VERSION, kind: c.kind, user: c.user, password: c.password.reveal() });
    case "oauth":
      return JSON.stringify({ v: VERSION, kind: c.kind, provider: c.provider, refreshToken: c.refreshToken.reveal() });
  }
}

/**
 * The one text to seal, or `null` for a credential that could not be opened again: a value that is
 * empty, or a text past the ceiling. What would not be read back is not written, so a sign-in that
 * cannot be kept is refused when a person connects and not found missing at the next reading. The
 * text holds the values in the clear: it goes nowhere but into the envelope.
 */
export function serializeCredential(c: StoredCredential): string | null {
  const text = written(c);
  return parseCredential(text) === null ? null : text;
}

const filled = (v: unknown): v is string => typeof v === "string" && v !== "";

/** A sealed text opened again, or `null` for anything that is not one of this version. Never a throw. */
export function parseCredential(text: string): StoredCredential | null {
  if (text.length > MAX_CREDENTIAL_CHARS) return null;
  let read: unknown;
  try {
    read = JSON.parse(text);
  } catch {
    // Not a credential: the answer for every text that is none.
    return null;
  }
  if (read === null || typeof read !== "object" || Array.isArray(read)) return null;
  const o = read as Record<string, unknown>;
  if (o.v !== VERSION) return null;
  if (o.kind === "address" && filled(o.url)) return { kind: "address", url: new Secret(o.url) };
  if (o.kind === "basic" && filled(o.user) && filled(o.password)) return { kind: "basic", user: o.user, password: new Secret(o.password) };
  if (o.kind === "oauth" && (o.provider === "google" || o.provider === "microsoft") && filled(o.refreshToken)) {
    return { kind: "oauth", provider: o.provider, refreshToken: new Secret(o.refreshToken) };
  }
  return null;
}

/**
 * The port's credential for an address or a password. A lasting sign-in has no such form: a pass
 * trades it for a short one at the provider and hands the port a `bearer` of its own.
 */
export function toCredential(stored: Exclude<StoredCredential, { kind: "oauth" }>): Credential {
  return stored.kind === "address"
    ? { kind: "address", url: () => stored.url.reveal() }
    : { kind: "basic", user: stored.user, password: () => stored.password.reveal() };
}
