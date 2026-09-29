/**
 * WHAT THE BOOT SHELL SAYS WHILE THE ENGINE'S STORE UPGRADES — the desktop's rule, phone-worded.
 * The count shows only where more than one entry is owed on a store that is not fresh: a first
 * launch migrates an empty store and nobody waits on a number, and one entry has nothing to count.
 * The slow line joins after {@link BOOT_MIGRATING_SLOW_MS} in the phase, never at once. Pure, so
 * the suite drives it without a renderer; `BootShell` renders the answer and decides nothing.
 */
import { Copy } from "../copy";
import type { StoreMigrating } from "../engine/standalone-door";

/** The connecting state's upgrade: the engine's latest announcement, and when the first came. */
export interface BootMigrating extends StoreMigrating {
  /** Epoch ms of the first announcement in this connect — the phase's own clock. */
  readonly since: number;
}

/** Five seconds in the phase: late enough that an ordinary upgrade never sees the second line. */
export const BOOT_MIGRATING_SLOW_MS = 5_000;

/** Fold one announcement into the state; the first one stamps the phase's start. */
export function migratingNext(prev: BootMigrating | undefined, p: StoreMigrating, nowMs: number): BootMigrating {
  return { applied: p.applied, pending: p.pending, fresh: p.fresh, since: prev?.since ?? nowMs };
}

/**
 * WHERE AN ANNOUNCEMENT MAY LAND — only on the connecting state of the connect that is waiting on
 * it. A state that moved on (a refusal, a live session, another origin) is `null`: an upgrade that
 * failed ends in its refusal, and no count survives into it.
 */
export function migratingState(
  at: { readonly k: string; readonly origin?: string; readonly migrating?: BootMigrating | undefined },
  origin: string, progress: StoreMigrating, nowMs: number,
): { k: "connecting"; origin: string; migrating: BootMigrating } | null {
  if (at.k !== "connecting" || at.origin !== origin) return null;
  return { k: "connecting", origin, migrating: migratingNext(at.migrating, progress, nowMs) };
}

/** The two lines, or nulls — see the header. "3 of 12" is THIS open's owed entries, never the journal's. */
export function bootMigratingLines(
  m: BootMigrating | undefined, nowMs: number,
): { count: string | null; slow: string | null } {
  if (m === undefined || m.fresh || m.pending <= 1) return { count: null, slow: null };
  return {
    count: Copy.bootMigratingOf(m.applied, m.pending),
    slow: nowMs - m.since >= BOOT_MIGRATING_SLOW_MS ? Copy.bootMigratingSlow : null,
  };
}
