/**
 * What the two providers that answer in JSON share (Google, and Microsoft beside it): the refusal's
 * shape, the short sign-in for one call, the body as one object, and the few values both write the
 * same way. A refusal carries a word and a number, never the answer's text.
 */
import { isValidWall, MS_PER_SECOND, wallSeconds } from "@ohmail/cal-core";
import { MAX_URL_CHARS } from "./limits.js";
import type { Connection, LeftReason } from "./port.js";
import type { ProviderRefusal } from "./refusals.js";

export interface Refused {
  readonly ok: false;
  readonly reason: ProviderRefusal;
  readonly retryAfterMs: number | null;
}
export const refuse = (reason: ProviderRefusal, retryAfterMs: number | null = null): Refused => ({ ok: false, reason, retryAfterMs });

/** What a short sign-in may be made of to stand in a header: visible ASCII, no space, no line break. */
const HEADER_SAFE = /^[\x21-\x7e]{1,4096}$/;

/** The short sign-in for one call of the port, from the connection's own port. Nothing of it is kept. */
export async function bearerOf(c: Connection, signal: AbortSignal): Promise<{ readonly ok: true; readonly token: string } | Refused> {
  if (c.credential.kind !== "bearer") return refuse("sign_in_refused");
  const answer = await c.credential.accessToken(signal);
  if (!answer.ok) return refuse(answer.reason, answer.retryAfterMs);
  return HEADER_SAFE.test(answer.token) ? answer : refuse("sign_in_refused");
}

/** An id as the one segment of a path it may be, or `null` for a text that is no id at all (half a character, which no address can carry). */
export function pathSegment(id: string): string | null {
  try {
    return encodeURIComponent(id);
  } catch {
    // Not well-formed text: it names nothing at any provider.
    return null;
  }
}

/** A provider's own ceiling for an id is 1,024 characters at Google and far less at Microsoft; a longer one is no id of theirs. */
export const MAX_PROVIDER_ID_CHARS = 1024;

export type Left = { readonly id: string; readonly reason: LeftReason };
/**
 * A record that is left out, named by its id whole: a reading of the whole calendar spares the
 * stored object of that id, so a part of the id would name nothing (Microsoft's ids share their
 * first hundred characters across a mailbox). Only what is past the ceiling and so no id at all is
 * cut to it, so that a megabyte is never handed on.
 */
export const leftOut = (id: string, reason: LeftReason): Left => ({ id: id.slice(0, MAX_PROVIDER_ID_CHARS), reason });

export type Json = Record<string, unknown>;
export const isRecord = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** An answer's body as the one JSON object it should be, or `null`. UTF-8, a byte-order mark taken off. */
export function jsonOf(body: Uint8Array): Json | null {
  try {
    const read: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return isRecord(read) ? read : null;
  } catch {
    // No JSON, or no UTF-8: the answer is not what was asked for, whatever it is.
    return null;
  }
}

/** A text that is there and not empty. */
export const filled = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;
/** No RFC 3339 time is longer: a date, a clock time, nine fraction digits, an offset. */
const RFC3339_MAX_CHARS = 35;

/** The moment an RFC 3339 time names, in epoch milliseconds to the second, or `null`. No clock and no `Date` is asked. */
export function instantOfRfc3339(value: string): number | null {
  if (value.length > RFC3339_MAX_CHARS) return null;
  const m = RFC3339.exec(value);
  if (m === null) return null;
  const wall = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Math.min(Number(m[6]), 59) };
  if (!isValidWall(wall)) return null;
  const offset = m[7]!;
  const east = offset === "Z" || offset === "z" ? 0 : (offset.startsWith("-") ? -1 : 1) * (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(4, 6)) * 60);
  return (wallSeconds(wall) - east) * MS_PER_SECOND;
}

/** RFC 5321: a longer text is no mail address. */
const ADDRESS_MAX_CHARS = 254;
/** One address and nothing else: no space, no bracket, no query, no control character. Each class shuts out the at sign, so the scan is one pass. */
const ADDRESS = /^[^\s@<>"?\u0000-\u001f\u007f]+@[^\s@<>"?\u0000-\u001f\u007f]+$/;

/** A person's mail address as an invitation may carry it, or `undefined`. */
export function addressOf(v: unknown): string | undefined {
  const address = filled(v);
  return address !== undefined && address.length <= ADDRESS_MAX_CHARS && ADDRESS.test(address) ? address : undefined;
}

/** A link to a call as the provider wrote it: https and nothing a line could break on, or `undefined`. */
export function callLinkOf(v: unknown): string | undefined {
  const link = filled(v);
  return link !== undefined && link.length <= MAX_URL_CHARS && /^https:\/\/[^\s\u0000-\u001f\u007f]+$/.test(link) ? link : undefined;
}
