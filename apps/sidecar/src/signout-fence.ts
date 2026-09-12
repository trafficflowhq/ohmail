/**
 * ONE SIGN-OUT FENCE. Signing out removes every mailbox password this install holds, and nothing
 * already on its way may write one back afterwards.
 *
 * A read-back cannot see a writer ALREADY IN FLIGHT: sealing a password dials first and commits
 * seconds later, so a sign-out in that window proved the row gone, answered, and the probe sealed
 * it again. So a sign-out is an EPOCH: bump, wait (bounded) for every writer that started under
 * the previous one, then discard the stores. A stale epoch means a sign-out overtook the writer,
 * which discards what it wrote; the same epoch governs the DIAL. Per-ENGINE, never per-process.
 */

/** One credential write, from the moment it starts to the moment it has settled. */
export interface CredentialWrite {
  /** Whether a sign-out began after this write started. */
  stale(): boolean;
  /** The epoch this write began under. */
  startedUnder(): number;
  /**
   * Exactly once, on EVERY exit — a sign-out waiting on this write is what makes the bound
   * meaningful, and a writer that never settles is one the sign-out has to report rather than
   * wait for.
   */
  settle(): void;
}

export interface SignOutFence {
  /** The sign-out epoch in force. Every credential this install holds belongs to one. */
  generation(): number;
  /** Start a credential write under the current epoch. */
  begin(): CredentialWrite;
  /** How many credential writes have begun and not settled — read for the sign-out's receipt. */
  outstanding(): number;
  /**
   * One store discarded its own credential — the refused-launch path, which is not a sign-out but
   * leaves the same fact behind: nothing in flight may write that password back.
   */
  bump(): void;
  /**
   * Sign out. Bumps the epoch FIRST, then waits up to `waitMs` for the writes that began under the
   * previous one. `unsettled` is how many were still out when the wait ran out — a sign-out that
   * reports those cannot promise the store is clean, and saying so is the whole point of counting
   * them.
   */
  signOut(waitMs: number): Promise<{ generation: number; unsettled: number }>;
}

export function createSignOutFence(): SignOutFence {
  let generation = 0;
  /** Every write that has begun and not settled. Its `done` is what a sign-out waits on. */
  const open = new Set<{ under: number; done: Promise<void> }>();

  const begin = (): CredentialWrite => {
    const under = generation;
    let finish: () => void = () => {};
    const entry = { under, done: new Promise<void>((r) => { finish = r; }) };
    open.add(entry);
    let settled = false;
    return {
      stale: () => generation !== under,
      startedUnder: () => under,
      settle: () => {
        /* LATCHED. `settle()` sits in a `finally` and the routes that own one also answer on a
           throw, so a second call is ordinary rather than a defect; what must not happen is a
           second entry being removed or a resolved promise being re-armed. */
        if (settled) return;
        settled = true;
        open.delete(entry);
        finish();
      },
    };
  };

  return {
    generation: () => generation,
    begin,
    outstanding: () => open.size,
    bump: () => { generation += 1; },
    async signOut(waitMs: number) {
      /* THE BUMP IS FIRST AND NOTHING IS AWAITED BEFORE IT. A writer that begins after this line
         reads the new epoch and is not a race; one that began before it is in `waiting` below,
         and the pair is exhaustive only because no `await` separates the two statements. */
      generation += 1;
      const waiting = [...open].filter((w) => w.under < generation);
      if (waiting.length > 0) {
        let ran: () => void = () => {};
        const timer = setTimeout(() => ran(), waitMs);
        (timer as unknown as { unref?: () => void }).unref?.();
        await Promise.race([
          Promise.all(waiting.map((w) => w.done)),
          new Promise<void>((r) => { ran = r; }),
        ]);
        clearTimeout(timer);
      }
      /* READ AFTER THE WAIT, not before: the answer is how many are STILL out, which is what the
         sign-out can and cannot promise about the store. */
      return { generation, unsettled: waiting.filter((w) => open.has(w)).length };
    },
  };
}

/**
 * How long a sign-out waits for a credential write that was already on its way. Long enough for a
 * probe that has answered to finish committing, short enough that pressing Sign out is not a stall
 * — past it the sign-out discards the stores anyway and REPORTS the writer it could not wait for,
 * which the shell turns into a refusal rather than a clean sign-out.
 */
export const SIGN_OUT_FENCE_WAIT_MS = 5_000;
