/**
 * ENDING A SESSION AT THE SERVER THAT ISSUED IT. Every sign-out forgets its session here first,
 * then asks that server to end it with the pair it held, inside ONE deadline; a pairing redeem an
 * undo marked keeps nothing and signs its own pair out the same way. No engine imports; the
 * window's wait (`AT_HOST_WAIT_MS` in `apps/desktop/src/bridge-fetch.ts`) is pinned above
 * {@link SIGN_OUT_AT_HOST_MS}.
 */

/** The ONE deadline a sign-out spends at the server, entered once and threaded through. */
export const SIGN_OUT_AT_HOST_MS = 5_000;

/** Every deadline here is a MONOTONIC instant (`deadlineIn`), so a wall clock stepped back inside
 *  a sign-out cannot stretch it. */
export const deadlineIn = (ms: number): number => performance.now() + ms;
/**
 * What the deadline keeps for the revoke itself: the bearer door is one round trip, the refresh
 * door a second. Before it, the press waits for the window's accepted writes to land under the
 * still-live session; a write still out at that share is deferred, never ended.
 */
export const REVOKE_RESERVE_MS = 2_000;

/** A redeem between spending its token and keeping (or not keeping) what came back. */
export interface PairFlight {
  /** The undo's deadline once an undo marked this flight; `null` while it is unmarked. */
  readonly undoneBy: () => number | null;
  /** The redeem's outcome: `true`/`false` it signed a session out at the host or failed to, `null` none was kept. */
  settle(outcome: boolean | null): void;
}

export interface PairFlights {
  open(): PairFlight;
  /** Mark every open flight undone and wait, until `deadline`, for what each did. */
  undo(deadline: number): Promise<boolean | null>;
}

export function pairFlights(): PairFlights {
  const live = new Set<{ undoneBy: number | null; settled: Promise<boolean | null>; resolve: (v: boolean | null) => void }>();
  return {
    open() {
      let resolve!: (v: boolean | null) => void;
      const settled = new Promise<boolean | null>((r) => { resolve = r; });
      const entry = { undoneBy: null as number | null, settled, resolve };
      live.add(entry);
      return {
        undoneBy: () => entry.undoneBy,
        settle(outcome) {
          live.delete(entry);
          entry.resolve(outcome);
        },
      };
    },
    async undo(deadline) {
      const open = [...live];
      if (open.length === 0) return null;
      for (const entry of open) entry.undoneBy = deadline;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outOfTime = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), leftOf(deadline)); });
      const outcomes = await Promise.race([Promise.all(open.map((e) => e.settled)), outOfTime]);
      clearTimeout(timer);
      /* Still in flight at the deadline: a session may yet arrive, and it is signed out when it
         does, but nothing can be said to have been taken back. */
      if (outcomes === "late") return false;
      if (outcomes.includes(false)) return false;
      return outcomes.includes(true) ? true : null;
    },
  };
}

/** What is left of a deadline, never negative, in WHOLE milliseconds (`AbortSignal.timeout` refuses
 *  a fraction, and a monotonic reading carries one). */
export function leftOf(deadline: number): number {
  return Math.max(Math.ceil(deadline - performance.now()), 0);
}

/** A held session's pair, as the engine holds it in memory. Nothing here reads or writes disk. */
export interface HeldPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * End a held session at its server, bounded by `deadline`: `POST /auth/logout` with the bearer,
 * and on a 401 ONLY (the access token lapsed) `POST /auth/refresh/logout`, whose refresh token
 * names the family in any state. Answers whether the server said so; past the deadline nothing
 * is asked. Never a renewal: that would mint the very pair this is ending.
 */
export async function revokeHeldSession(
  fetchImpl: typeof fetch, base: string, held: HeldPair, deadline: number,
): Promise<boolean> {
  const ask = async (path: string, init: RequestInit): Promise<number | null> => {
    const left = leftOf(deadline);
    if (left <= 0) return null;
    try {
      const res = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(left) });
      void res.body?.cancel().catch(() => undefined);
      return res.status;
    } catch {
      return null;
    }
  };
  const ended = (status: number | null): boolean => status !== null && status >= 200 && status < 300;
  const bearer = await ask("/auth/logout", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${held.accessToken}` },
    body: "{}",
  });
  if (ended(bearer)) return true;
  if (bearer !== 401) return false;
  return ended(await ask("/auth/refresh/logout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refreshToken: held.refreshToken }),
  }));
}

/** A deadline an undo already spent gets a bound of its own: nobody waits on that sign-out. */
export function boundForUnwaited(deadline: number): number {
  return leftOf(deadline) > 0 ? deadline : deadlineIn(SIGN_OUT_AT_HOST_MS);
}

/** Settle when `work` settles or at `deadline`, whichever is first; `work` goes on regardless. */
export async function settledBy(work: Promise<unknown>, deadline: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((r) => { timer = setTimeout(r, leftOf(deadline)); });
  try {
    await Promise.race([work.then(() => undefined, () => undefined), bound]);
  } finally {
    clearTimeout(timer);
  }
}
