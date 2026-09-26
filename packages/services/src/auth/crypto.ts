import {
  randomBytes, scrypt as _scrypt, timingSafeEqual, createHash, type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

// The envelope-encryption primitive (KeyProvider) now lives in @trafficflow/core
// so the worker can decrypt `mailbox_credentials` without importing services.
// Re-exported here UNCHANGED so every existing auth import (config/types/index) and
// the existing tests keep resolving `KeyProvider`/`StaticKeyProvider` from this module.
export { type KeyProvider, StaticKeyProvider } from "@trafficflow/core/mail";

const scrypt = promisify(_scrypt) as (
  password: string | Buffer, salt: string | Buffer, keylen: number, options?: ScryptOptions,
) => Promise<Buffer>;

// ─────────────────────────────────────────────────────────────────────────────
// Password hashing — scrypt via node:crypto. NOT native argon2.
// Stored form: "scrypt$<keylen>$<saltB64url>$<hashB64url>$n<log2 N>r<r>p<p>"; a hash with no fifth
// field is the original "n14r8p1".
// ─────────────────────────────────────────────────────────────────────────────

const SCRYPT_KEYLEN = 64;

/** A cost as stored: log2 N, r, p. */
export interface ScryptCost { ln: number; r: number; p: number }

/** What a hash before the cost was encoded used: Node's default, N = 2^14. */
const LEGACY_COST: ScryptCost = { ln: 14, r: 8, p: 1 };

/**
 * What new hashes cost: N = 2^17, r = 8, p = 1 — OWASP's floor, 128 MiB per derivation. Node's
 * default `maxmem` is 32 MiB and REFUSES it, hence {@link SCRYPT_MAXMEM}. The process peak is the
 * libuv threadpool times 128 MiB (async scrypt runs there): `UV_THREADPOOL_SIZE` is the multiplier,
 * 4 by default, and the hosted API pins its function memory against it.
 */
export const CURRENT_COST: ScryptCost = { ln: 17, r: 8, p: 1 };
export const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const costTag = (c: ScryptCost): string => `n${c.ln}r${c.r}p${c.p}`;

/** A stored cost, or null when it is malformed or above the current one (a corrupt row must not size the process). */
function parseCost(tag: string | undefined): ScryptCost | null {
  if (tag === undefined) return LEGACY_COST;
  const m = /^n(\d{1,2})r(\d{1,2})p(\d{1,2})$/.exec(tag);
  if (!m) return null;
  const c = { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
  const work = (x: ScryptCost): number => 2 ** x.ln * x.r * x.p;
  return c.ln >= 1 && c.r >= 1 && c.p >= 1 && work(c) <= work(CURRENT_COST) && c.ln <= CURRENT_COST.ln ? c : null;
}

/** One scrypt derivation at a cost — the unit the timing pad and its test count. */
export type ScryptDerive = (password: string, salt: Buffer | string, keylen: number, cost: ScryptCost) => Promise<Buffer>;

const realDerive: ScryptDerive = (password, salt, keylen, c) =>
  scrypt(password, salt, keylen, { N: 2 ** c.ln, r: c.r, p: c.p, maxmem: SCRYPT_MAXMEM });

const sameCost = (a: ScryptCost, b: ScryptCost): boolean => a.ln === b.ln && a.r === b.r && a.p === b.p;

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  /** Constant-time verify. MUST run its full cost even when `stored` is a decoy
   *  (unknown-email path) so login timing does not leak account existence. */
  verify(password: string, stored: string): Promise<boolean>;
  /** Whether a VERIFIED stored hash should be written again at the current cost. */
  needsRehash?(stored: string): boolean;
}

/**
 * The hasher over a derivation and a cost — {@link scryptHasher} is the production pair. A test
 * counts derivations through `derive`; the test deps pass a cheap `cost` so a suite of sign-ins
 * stays fast. The ceiling a stored cost may not exceed is {@link CURRENT_COST} either way.
 */
export function makeScryptHasher(opts: { derive?: ScryptDerive; cost?: ScryptCost } = {}): PasswordHasher {
  const derive = opts.derive ?? realDerive;
  const own = opts.cost ?? CURRENT_COST;
  return {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await derive(password, salt, SCRYPT_KEYLEN, own);
    return `scrypt$${SCRYPT_KEYLEN}$${salt.toString("base64url")}$${derived.toString("base64url")}$${costTag(own)}`;
  },

  /**
   * EVERY VERIFY COSTS ONE CURRENT AND ONE LEGACY DERIVATION: the real one, then a pad at the
   * other cost, sequentially. A not-yet-rehashed account would otherwise answer ~8x faster than
   * the unknown-address decoy (current cost), an existence oracle for every account that has not
   * signed in since the cost rose. A malformed or over-cost hash pays the same two and fails.
   */
  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    const cost = parts[0] === "scrypt" && (parts.length === 4 || parts.length === 5) ? parseCost(parts[4]) : null;
    if (!cost) {
      await derive(password, "decoy-salt", SCRYPT_KEYLEN, own);
      await derive(password, "decoy-salt", SCRYPT_KEYLEN, LEGACY_COST);
      return false;
    }
    const keylen = Number(parts[1]);
    const salt = Buffer.from(parts[2]!, "base64url");
    const expected = Buffer.from(parts[3]!, "base64url");
    const derived = await derive(password, salt, keylen, cost);
    await derive(password, salt, keylen, sameCost(cost, own) ? LEGACY_COST : own);
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  },

  needsRehash(stored: string): boolean {
    const parts = stored.split("$");
    const cost = parts[0] === "scrypt" ? parseCost(parts[4]) : null;
    return cost === null || !sameCost(cost, own);
  },
  };
}

export const scryptHasher: PasswordHasher = makeScryptHasher();

// ─────────────────────────────────────────────────────────────────────────────
// Opaque-token generation + hash-at-rest. Session/refresh/login/OAuth/recovery
// tokens are random secrets; only their SHA-256 hash is persisted, and lookups
// hash the presented token before comparing.
// ─────────────────────────────────────────────────────────────────────────────

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function sha256(input: string | Buffer): Buffer {
  return createHash("sha256").update(input).digest();
}
