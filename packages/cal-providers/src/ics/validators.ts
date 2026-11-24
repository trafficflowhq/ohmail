/**
 * Where a subscription's reading stands, kept as the calendar's change token: the validators of the
 * last answer, a hash of its text, and the file's own wish for the next ask. Nobody says when a file
 * changes, so every reading asks again; this is what makes asking cheap.
 *
 * The address is a secret and is not in the token. What is: a short hash of it, so that a
 * validator goes back to the address it came from and to no other.
 */
import { createHash } from "node:crypto";
import { MAX_VALIDATOR_CHARS, SUBSCRIPTION_INTERVAL_CEILING_MS, SUBSCRIPTION_INTERVAL_FLOOR_MS, TOKEN_MAX_CHARS } from "../limits.js";
import type { ChangeToken } from "../port.js";

export interface FeedState {
  /** The address the validators came from, hashed. */
  readonly from: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  /** The text as it arrived, hashed: many feeds are made on request and send no validator, or a new one every time. */
  readonly hash: string;
  /** The file's own wish for the least time between two asks, inside the floor and the ceiling. */
  readonly refreshMs: number | null;
}

const VERSION = 1;
const VISIBLE = /^[\x20-\x7e]+$/;

export const hashOf = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("base64url");
export const addressKey = (address: string): string => hashOf(address).slice(0, 22);

/** A validator as it may be kept and sent back: a header's visible text within its ceiling, or nothing. */
export const keptValidator = (value: string | null): string | null => (value !== null && value.length <= MAX_VALIDATOR_CHARS && VISIBLE.test(value) ? value : null);

/** A wish for the time between two asks, held inside the floor and the ceiling. */
export const heldInterval = (ms: number): number => Math.min(Math.max(ms, SUBSCRIPTION_INTERVAL_FLOOR_MS), SUBSCRIPTION_INTERVAL_CEILING_MS);

const write = (s: FeedState): string => JSON.stringify({ v: VERSION, a: s.from, e: s.etag, m: s.lastModified, h: s.hash, r: s.refreshMs });

export function tokenOf(state: FeedState): ChangeToken {
  const whole = write(state);
  // The hash always fits. Validators that do not fit beside it are given up, never the token.
  return { provider: "ics", value: whole.length <= TOKEN_MAX_CHARS ? whole : write({ ...state, etag: null, lastModified: null }) };
}

/** A token read back, or `null` for anything that is none of this reader's: the calendar is then read from the beginning. */
export function stateOf(token: ChangeToken | null): FeedState | null {
  if (token === null || token.provider !== "ics" || token.value.length > TOKEN_MAX_CHARS) return null;
  let read: unknown;
  try {
    read = JSON.parse(token.value);
  } catch {
    // No token of this reader's.
    return null;
  }
  if (read === null || typeof read !== "object" || Array.isArray(read)) return null;
  const o = read as Record<string, unknown>;
  if (o.v !== VERSION || typeof o.a !== "string" || typeof o.h !== "string" || o.h === "") return null;
  const validator = (v: unknown): string | null => keptValidator(typeof v === "string" ? v : null);
  return { from: o.a, etag: validator(o.e), lastModified: validator(o.m), hash: o.h, refreshMs: typeof o.r === "number" && Number.isFinite(o.r) && o.r > 0 ? heldInterval(o.r) : null };
}
