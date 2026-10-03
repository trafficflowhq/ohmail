import { createHmac } from "node:crypto";
import type { KeyProvider } from "@trafficflow/core/mail";

/** The HKDF `info` of the throttle keyer's subkey. Renaming it resets every counter once. */
export const THROTTLE_SUBKEY_INFO = "ohmail auth-throttle v1";

/**
 * THE ONE SPELLING OF A THROTTLE KEY THAT NAMES A PERSON OR A CLIENT. A typed address and a client
 * IP are stored only as a keyed hash: HMAC-SHA256 under a subkey of the deployment's KEK, 32 HEX
 * characters. Hex, because a key is matched by `LIKE '<prefix><hash>:%'` at erasure and base64url
 * carries `_`, a LIKE wildcard. The subkey is derived on first use, so a host whose KEK is broken
 * boots and answers `/health`, and refuses a sign-in rather than counting it in the clear.
 */
export interface ThrottleKeys {
  /** A sign-in address, normalized (trimmed, lowercased) by the caller. */
  address(email: string): string;
  /**
   * A client identity — the trusted client IP; `""` is one bucket for callers the host cannot
   * identify, and takes no lock: the password lock never keys on it (`AuthService.passwordKeys`).
   */
  client(ip: string): string;
}

export function throttleKeys(keyProvider: KeyProvider): ThrottleKeys {
  let subkey: Buffer | null = null;
  const mac = (kind: string, value: string): string => {
    subkey ??= keyProvider.deriveSubkey(THROTTLE_SUBKEY_INFO);
    return createHmac("sha256", subkey).update(JSON.stringify([kind, value])).digest("hex").slice(0, 32);
  };
  return { address: (email) => mac("address", email), client: (ip) => mac("client", ip) };
}

/** One keyer per provider, so the subkey is derived once per process and not per request. */
const byProvider = new WeakMap<KeyProvider, ThrottleKeys>();
export function throttleKeysFor(keyProvider: KeyProvider): ThrottleKeys {
  let keys = byProvider.get(keyProvider);
  if (!keys) { keys = throttleKeys(keyProvider); byProvider.set(keyProvider, keys); }
  return keys;
}

/** Key prefixes. Every key naming an address is `<prefix><address hash>…`; the rest name a user id. */
export const THROTTLE_PREFIX = {
  /** The hard lock, per (address, client): `pw:<hA>:<hC>`. */
  password: "pw:",
  /** The per-address ceiling over every client: `pwa:<hA>`. */
  addressCeiling: "pwa:",
  /** A client that completed a sign-in to the address: `known:<hA>:<hC>`. */
  knownClient: "known:",
  /** Second-factor refusals, per user, 15 min: `user:<id>`. */
  user: "user:",
  /** Pre-session second-factor refusals, per user, 24 h: `factor-day:<id>`. */
  factorDay: "factor-day:",
  /** The once-per-day notice an account is owed: `notice:<kind>:<id>`. */
  notice: "notice:",
} as const;
