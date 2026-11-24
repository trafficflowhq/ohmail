/**
 * How long "Undo" is true, and the two numbers that have to agree. The window is the GUARD'S, not the capsule's: `commit`
 * fires on its own timer from the press and `undo` restores only rows still pending, and neither reads the toast — a capsule
 * replaced by the next decision's leaves this decision's window as it was (`test/undo-window.test.ts`). So the window is ONE
 * number: `UNDO_MS` is the offer, the Undo slot's duration that no notice shortens, and the commit is derived from it.
 * `COMMIT_GRACE_MS` covers the capsule's fade, after which `ToastHost` takes its button out of the tree, so the capsule is
 * gone before the decision is sent. `undo()` stays independently guarded: a late press on a callback held elsewhere is told
 * the truth ("Too late to undo"), never "Undone — 0 waiting again."
 */
export const UNDO_MS = 8000;
