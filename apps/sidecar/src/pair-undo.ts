/**
 * THE UNDO OF A PAIRING WHOSE REDEEM IS STILL IN FLIGHT. The window has two roads out of such a
 * pairing — the redeem answering, and the person leaving the card — and this engine is the one
 * process that holds the bearer the redeem brings back. So the undo marks the flight first; a
 * redeem that lands marked keeps nothing (no seal, no session) and signs its own bearer out at the
 * other computer. One outcome per redeem, decided here. No engine imports; the window's bound
 * (`UNDO_AT_HOST_MS` in `apps/desktop/src/doors.ts`) is pinned above {@link PAIR_UNDO_REVOKE_MS}.
 */

/** The ONE deadline an undo spends on the other computer, entered once and threaded through. */
export const PAIR_UNDO_REVOKE_MS = 5_000;

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
      const outOfTime = new Promise<"late">((r) => { timer = setTimeout(() => r("late"), Math.max(deadline - Date.now(), 0)); });
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

/** What is left of a deadline, never negative. */
export function leftOf(deadline: number): number {
  return Math.max(deadline - Date.now(), 0);
}

/**
 * Sign a bearer the redeem just received out at the host that issued it: `POST /auth/logout`
 * with that bearer, bounded. Answers whether the host said so. A deadline already spent gets its
 * own bound: nobody waits on this call, and the session it revokes would otherwise stay listed.
 */
export async function revokeBearerAtHost(
  fetchImpl: typeof fetch,
  base: string,
  accessToken: string,
  deadline: number,
): Promise<boolean> {
  const left = leftOf(deadline);
  try {
    const res = await fetchImpl(`${base}/auth/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: "{}",
      signal: AbortSignal.timeout(left > 0 ? left : PAIR_UNDO_REVOKE_MS),
    });
    void res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}
