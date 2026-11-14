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
   * The partition of everything the shell keeps in the browser: the value the host's engine was
   * built by, never a second read of anything. The web hands the account its engine's mirror is
   * named for, the desktop the mailbox it mounts, the paired page its pairing, the demo its own
   * word. Null while nobody is known: the frame then mounts nothing.
   *
   * It is fixed for the life of a mounted frame. A host whose scope changes mounts the frame
   * again, keyed by the scope; today's views read it once, as they mount, and keep it.
   */
  readonly scope: string | null;
  /**
   * The ohmail account behind this session, as the server confirmed it: an opaque id, never an address. Null where no
   * account stands behind this shell, and until the answer has come.
   */
  readonly account: string | null;
  /**
   * The way back to a live session: sign in again, or reload the window. `none` withholds the control, and the frame
   * says in words to start ohmail again.
   */
  readonly recover: ((how: "signIn" | "reload") => void) | None;
  /** Ends the session. No input today: it lives inside the panes each mount hands in. */
  readonly signOut: (() => Promise<void>) | None;
}
