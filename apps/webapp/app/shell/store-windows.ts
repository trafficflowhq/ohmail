import type { StorePolicy } from "@ohmail/client-engine";

/**
 * HOW MUCH OF THE MAILBOX EACH CLIENT'S MIRROR HOLDS — the two windows, side by side.
 *
 * A LEAF ON PURPOSE. These live apart from `engine-config.ts` because the desktop's door module
 * reads one of them, and `engine-config` imports the sync scheduler at module level: a VALUE
 * import from the door would convey that whole module into the bundle a paired device is served,
 * which is the hazard `apps/desktop/test/host-client-no-engine-door.test.ts` exists to refuse.
 * Nothing here imports anything but a type, so importing it costs a bundle nothing.
 *
 * `engine-config.ts` re-exports {@link BROWSER_WINDOW} so its own consumers and their pins are
 * unchanged by the move.
 */

/**
 * WHY BOTH WINDOWS CARRY A CEILING, AND WHY IT IS 10 000. `days` with only a floor under it bounds
 * the window by AGE and not by SIZE, so a mailbox dense inside ninety days sits almost entirely in
 * a "windowed" mirror — 2.7x the floor on the rig's own large corpus.
 *
 * 10 000 is twice the floor, chosen so BOTH halves stay reachable: at 5 000 the ceiling would equal
 * the floor and `days` could never decide anything, and at 15 000 it is above what ninety days
 * holds on that corpus and the ceiling never could. Each bound binds for a real mailbox, which is
 * the only way either can be watched fail.
 */
/**
 * THE BROWSER'S WINDOW. A browser mirror is a cache in front of a server that still holds
 * everything, so the window is about what a tab should carry rather than about what exists.
 *
 * Nothing is lost by pruning. `MirrorStore.prune` deletes rather than tombstones, so an evicted
 * row is one `/sync` change or one re-snapshot away — and the mail past the window is reachable
 * directly through `OhmailEngine.listOlder`, which is the other half of this decision.
 *
 * It is a NAMED CONSTANT rather than an inline literal so that the test pinning it to the live
 * path can name it too. The risk this guards is one-sided and silent: dropping the option leaves
 * a working, correct, fully-tested app whose only symptom is a mirror that quietly regrows to the
 * whole mailbox, months later, on somebody else's machine.
 */
export const BROWSER_WINDOW = { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 } as const satisfies StorePolicy;

/**
 * THE DESKTOP'S WINDOW — the same size, for a different reason.
 *
 * The standalone window used to pass no policy at all, which is `full`: the renderer held every
 * message and every hydrated body for the life of the window, and `pruneToPolicy` evicts nothing
 * in that mode. On a large mailbox one whole-mirror derivation cost 180–236 ms and the eager
 * pass cost minutes of one core, with RSS at 1.5 GB.
 *
 * The mail is still all on the machine — the engine's own store holds it, which is this tier's
 * promise — so what this bounds is the RENDERER's projection, not the mailbox. Reach-past here is
 * a pipe to a process on the same machine rather than a network round trip, so the desktop has
 * less reason than a browser to hold a large window, not more: the same 90 days and 5 000 rows,
 * kept as its own constant so the two can be pinned and can diverge on a measurement rather than
 * by accident.
 */
export const DESKTOP_WINDOW = { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 } as const satisfies StorePolicy;
