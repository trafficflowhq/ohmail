/**
 * THE ACCOUNT THIS TAB WAS FOR HAS BEEN ERASED — one fact, one writer, and no imports: the shell
 * ships in the desktop build, where nothing registers a door and every function here is inert.
 *
 * The server says it as `410 account_erased` naming the account (`X-Ohmail-Account`), only to a
 * request that declared it understands the answer. Three transports hear it (the API client, the
 * refresh, the engine's adapter); each captures who the request left under BEFORE it goes out,
 * because the refresh's answer clears the jar in flight, and hands both to the one door.
 */

/** The request header a client names `account_erased` in; the server answers 401 otherwise. */
export const ERASED_ANSWER_HEADER = "x-ohmail-accepts";
export const ACCOUNT_ERASED = "account_erased";
export const ERASED_DECLARATION: Readonly<Record<string, string>> = { [ERASED_ANSWER_HEADER]: ACCOUNT_ERASED };

/**
 * The cross-tab word: written AFTER a door's sweep, read by every other tab's `storage` listener,
 * removed by the next minted session. Not under any prefix a sweep removes.
 */
export const ERASED_KEY = "ohmail.erased";

/** What a door decided. Only `erased` latched anything; `not-ours` is the answer-owner refusal. */
export type ErasedVerdict = "erased" | "not-ours" | "nothing-here" | "unnamed" | "no-door";

export interface ErasedDoor {
  /** Who this request leaves under, read before it goes out. */
  capture(): unknown;
  /** Decide on a 410 naming `named` (null = the header was absent), latch, start the wipe. */
  hear(named: string | null, before: unknown): ErasedVerdict;
}

let door: ErasedDoor | null = null;

/** The web registers its door (`app/erased-door.ts`); nothing else does. Last writer wins. */
export function registerErasedDoor(d: ErasedDoor | null): void {
  door = d;
}

export function erasedCapture(): unknown {
  return door ? door.capture() : null;
}

/**
 * THE DECIDING READ OF AN ANSWER: status 410 AND our envelope's code. A 410 is also a cursor
 * expiry and an epoch change, so the status alone is never the verdict. Reads a clone.
 */
export async function erasedAnswerOf(res: Response): Promise<{ named: string | null } | null> {
  if (res.status !== 410) return null;
  let code: unknown = null;
  try {
    code = ((await res.clone().json()) as { error?: { code?: unknown } } | null)?.error?.code;
  } catch {
    return null;
  }
  if (code !== ACCOUNT_ERASED) return null;
  return { named: res.headers.get("X-Ohmail-Account") };
}

export function hearAccountErased(named: string | null, before: unknown): ErasedVerdict {
  // A header-less 410 (an older server) wipes nothing: fail closed.
  if (named === null) return "unnamed";
  return door ? door.hear(named, before) : "no-door";
}

/**
 * The engine's transport, wrapped: it declares, captures, and on a verdict hands the engine the
 * refusal a dead session gets. The 410 itself would read to the adapter as a cursor expiry, whose
 * remedy is a re-bootstrap — a loop against an account that is gone.
 */
export function erasedAwareFetch(
  inner: (url: string, init?: RequestInit) => Promise<Response>,
  ended: () => Response,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const before = erasedCapture();
    const res = await inner(url, init);
    const answer = await erasedAnswerOf(res);
    if (answer === null) return res;
    return hearAccountErased(answer.named, before) === "erased" ? ended() : res;
  };
}

/* ── THE LATCH ────────────────────────────────────────────────────────────────────────────── */

let erasedOwner: string | null = null;
const listeners = new Set<() => void>();

/**
 * The tab's account is gone: nothing more may be asked (`sessionMayAsk`) and nothing re-arms a
 * refresh. Its own writer rather than `markSessionDead`, which arms the heal schedule.
 */
export function markAccountErased(owner: string): void {
  if (erasedOwner === owner) return;
  erasedOwner = owner;
  for (const l of [...listeners]) l();
}

/** Which erased account this tab latched on, or null. */
export function accountErasedOwner(): string | null {
  return erasedOwner;
}

export function subscribeAccountErased(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** A session was established again (a sign-in, a minted refresh): the latch and the word go. */
export function clearAccountErased(): void {
  try {
    globalThis.localStorage?.removeItem(ERASED_KEY);
  } catch {
    /* an unreadable jar holds no word to remove */
  }
  if (erasedOwner === null) return;
  erasedOwner = null;
  for (const l of [...listeners]) l();
}

/** Test seam. */
export function resetAccountErasedForTests(): void {
  erasedOwner = null;
  door = null;
}
