import type { None } from "./contract.js";

/**
 * Who is signed in, as the server answered. A failure to ask is not an answer: `unknown` says
 * the question could not be put, and when it may be put again.
 */
export type SessionAnswer =
  | { kind: "owner"; accountId: string }
  | { kind: "none" }
  | { kind: "unknown"; retryAfterMs: number | null };

export interface HostSession {
  /** Asks who is signed in. Replaces `resolveOwner`. `none`: a shell with no account to ask about. */
  readonly resolve: (() => Promise<SessionAnswer>) | None;
  /** Told the account the shell has believed. Replaces `onConfirmed`. */
  readonly confirmed: ((accountId: string) => void) | None;
  /** Replaces `sessionRefused`. `none`: no hosted session stands behind this shell. */
  readonly state: "live" | "refused" | None;
  /**
   * The partition of everything the shell keeps in the browser, or null while nobody is known
   * and nothing may be kept. No input today: each mount sets the storage's owner itself.
   *
   * It is fixed for the life of a mounted frame. A shell whose scope changes mounts the frame
   * again, keyed by the scope, and sets the scope before the frame's first effect runs.
   */
  readonly scope: string | null;
  /** Ends the session. No input today: it lives inside the panes each mount hands in. */
  readonly signOut: (() => Promise<void>) | None;
}
