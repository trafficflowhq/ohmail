/**
 * What a connection's sign-in is kept as. The store seals ONE text (`serializeCredential`) and
 * opens it again (`parseCredential`); between the two the values live in `Secret`s. This package
 * is handed a credential for one call and keeps nothing of it afterwards.
 *
 * THE TEXT NAMES THE ROW IT WAS SEALED FOR: its account and its connection. It is written for a
 * place and read at a place, and read at any other it is nothing. So a sealed sign-in moved to
 * another connection's row, the same account's or another's, opens for nobody: there is no way to
 * read the text without saying where it was found.
 *
 * A PASSWORD'S TEXT ALSO NAMES THE SERVER IT WAS TYPED FOR. A connection's row holds that address in
 * the clear, and whoever can write rows can write another there: the address a password is sent to
 * is therefore read out of the sealed text, and a row that names another is not this sign-in's.
 */
import { MAX_URL_CHARS } from "./limits.js";
import type { Credential } from "./port.js";
import { Secret } from "./secret.js";

export type StoredCredential =
  /** A subscription: the address is the secret. */
  | { readonly kind: "address"; readonly url: Secret }
  /** CalDAV: the server's address as the connection was placed with it, a user and a password (at most providers an app password). */
  | { readonly kind: "basic"; readonly server: string; readonly user: string; readonly password: Secret }
  /** Google, Microsoft: the lasting sign-in a pass trades for a short one. */
  | { readonly kind: "oauth"; readonly provider: "google" | "microsoft"; readonly refreshToken: Secret };

/** The row a sealed sign-in is kept on: its account and its connection, each as the store spells its id. */
export interface CredentialPlace {
  readonly accountId: string;
  readonly connectionId: string;
}

/**
 * The stored form's version. A text of another version is not read: the one before this named no
 * place, and is nobody's.
 */
const VERSION = 2;

/**
 * The longest stored text read: an address at its ceiling and its few names around it. A server's
 * address near that ceiling leaves no room for its user and password, and is then not kept.
 */
export const MAX_CREDENTIAL_CHARS = MAX_URL_CHARS + 256;

function written(c: StoredCredential, at: CredentialPlace): string {
  const head = { v: VERSION, account: at.accountId, connection: at.connectionId, kind: c.kind };
  switch (c.kind) {
    case "address":
      return JSON.stringify({ ...head, url: c.url.reveal() });
    case "basic":
      return JSON.stringify({ ...head, server: c.server, user: c.user, password: c.password.reveal() });
    case "oauth":
      return JSON.stringify({ ...head, provider: c.provider, refreshToken: c.refreshToken.reveal() });
  }
}

/**
 * The one text to seal for the row at `at`, or `null` for a credential that could not be opened
 * again there: a value that is empty, a place that names no row, or a text past the ceiling. What
 * would not be read back is not written, so a sign-in that cannot be kept is refused when a person
 * connects and not found missing at the next reading. The text holds the values in the clear: it
 * goes nowhere but into the envelope.
 */
export function serializeCredential(c: StoredCredential, at: CredentialPlace): string | null {
  const text = written(c, at);
  return parseCredential(text, at) === null ? null : text;
}

const filled = (v: unknown): v is string => typeof v === "string" && v !== "";

/**
 * A sealed text opened again at the row it was found on, or `null` for anything that is not a
 * credential of this version SEALED FOR THAT ROW. Never a throw.
 */
export function parseCredential(text: string, at: CredentialPlace): StoredCredential | null {
  if (!filled(at.accountId) || !filled(at.connectionId)) return null;
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
  // Sealed for another row, or for none: whoever moved it here, it is not this connection's sign-in.
  if (o.account !== at.accountId || o.connection !== at.connectionId) return null;
  if (o.kind === "address" && filled(o.url)) return { kind: "address", url: new Secret(o.url) };
  // A password that names no server would be sent wherever its row says: it is no sign-in.
  if (o.kind === "basic" && filled(o.server) && filled(o.user) && filled(o.password)) {
    return { kind: "basic", server: o.server, user: o.user, password: new Secret(o.password) };
  }
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
