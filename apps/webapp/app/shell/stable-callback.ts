"use client";

/**
 * A CALLBACK WHOSE IDENTITY NEVER CHANGES AND WHOSE SCOPE HOLDS NOTHING.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────
 *
 * Every closure created in ONE invocation of a component shares ONE engine-level Context
 * holding that invocation's entire scope. So a memoized callback that React
 * hands back unchanged on a later render makes the LATER render's scope hold a function from an
 * EARLIER one — which pins that earlier render's scope entire, including whatever whole-mirror
 * derivation it computed. In `AppShell` that is a consent partition and a projection over every
 * message in the mailbox, and the chain gains a link per render.
 *
 * `useCallback` cannot fix this by having better dependencies. The problem is not WHICH render's
 * function survives; it is that ANY surviving function drags a whole render scope with it.
 *
 * ── WHAT THIS DOES INSTEAD ──────────────────────────────────────────────────────────────────
 *
 * The returned function is created ONCE, on the first render, and never replaced. Every call
 * forwards to the latest implementation through a ref. So:
 *
 *  · its identity is stable for the life of the component — no consumer re-renders because of it,
 *    and no dependency array needs it;
 *  · it always runs the NEWEST closure, so it reads this render's values, not the first render's;
 *  · and the previous render's implementation is dropped the moment a new one arrives.
 *
 * ── THE FACTORY IS AT MODULE SCOPE, AND IT IS BELT AND BRACES RATHER THAN THE MECHANISM ─────
 *
 * The obvious claim to make here — that inlining it as `stable.current ??= (...args) =>
 * latest.current(...args)` would pin `fn`, the first render's implementation, because it sits in
 * the same scope — IS FALSE, and it was measured rather than assumed: with the factory inlined,
 * `stable-callback.test.ts`'s reachability census still finds the first implementation collected.
 * The engine context-allocates only the variables an inner closure actually REFERENCES, and that closure
 * references `latest` alone, so `fn` is never promoted out of the frame.
 *
 * The header's opening paragraph is unaffected — `AppShell`'s heavy variables ARE referenced by
 * closures it creates, which is precisely why they are context-allocated and pinned there.
 *
 * So the module-scope factory buys robustness, not the property: it makes the surviving closure's
 * scope trivially inspectable, and it keeps the guarantee if a later edit adds a reference to
 * something else inside the hook. Kept for that, and labelled honestly for the next reader.
 *
 * ── THE ASSIGNMENT IS DURING RENDER, DELIBERATELY ───────────────────────────────────────────
 *
 * React's own event-callback proposal assigns in a layout effect, which is stricter under
 * concurrent rendering. Here the assignment is during render for the reason this hook exists: an
 * effect defers the swap to commit, so a render React discards would leave the DISCARDED render's
 * implementation installed and reachable until the next commit. It is also what lets a render-time
 * read be correct rather than one commit stale — see the contract below.
 *
 * ── CONTRACT ────────────────────────────────────────────────────────────────────────────────
 *
 * Call it from events, effects and callbacks — and, unlike the platform's effect-based hook, it may
 * also be called DURING RENDER, after its own hook call. Two sites in `AppShell` do
 * (`mirrorHolds`, `receiptsIsUnread`), so this is stated rather than left to be discovered.
 *
 * Why it is safe HERE and not there: React's `useEffectEvent` installs the new implementation in a
 * LAYOUT EFFECT, so during render the ref still holds the PREVIOUS COMMIT's closure and a
 * render-time read is genuinely stale. This hook assigns during render (see the section above, and
 * the reason it must), so by the time the binding exists the ref already holds THIS render's
 * implementation, and a call after it reads exactly the values the render is using. Calling it
 * before its own hook call is not a hazard but an impossibility — the binding is not in scope yet.
 * `stable-callback.test.tsx` pins this with a render-time read, and the assignment moved into an
 * effect makes that test red.
 *
 * What the stable identity does NOT license: treating the function as a reactive value. It never
 * changes, so it can never tell a consumer that anything changed, and listing it in a dependency
 * array communicates nothing. That is the point of it — not a caveat — but a dependency array that
 * was relying on it to re-run is one that has quietly stopped re-running.
 */
import { useRef } from "react";

/**
 * ANY function, as a constraint that PRESERVES the one it is given.
 *
 * `never[]` rather than `unknown[]` because parameters are contravariant: it accepts every
 * function shape without widening any of them. The type parameter is the whole function `F` and
 * not a separate `(...args: A) => R`, so the returned function is the SAME type as the one passed
 * in — the way `useCallback` is typed, and for a reason that is not cosmetic. Decomposing into
 * `A`/`R` re-infers the parameter list, and a parameter carrying an untyped default (`all = false`)
 * infers as `unknown` there instead of `boolean`. Two call sites in `AppShell` proved it.
 */
type AnyFunction = (...args: never[]) => unknown;

/** See the header: at module scope so the surviving closure's scope holds the ref and nothing else. */
function forwardTo<F extends AnyFunction>(latest: { current: F }): F {
  /* The casts route through `unknown` because `F` is only bounded, never known here: this
     function's whole job is to be shape-agnostic, and the shape is restored at the boundary. The
     forwarding itself is total — every argument is passed through and the result returned. */
  const forward = (...args: unknown[]): unknown =>
    (latest.current as unknown as (...a: unknown[]) => unknown)(...args);
  return forward as unknown as F;
}

/**
 * `fn`, as a function whose identity never changes and whose scope pins no render.
 *
 * See the file header for why this is not `useCallback` with better dependencies, and for what the
 * stable identity does and does not license.
 */
export function useStableCallback<F extends AnyFunction>(fn: F): F {
  const latest = useRef(fn);
  latest.current = fn;
  const stable = useRef<F | null>(null);
  stable.current ??= forwardTo(latest);
  return stable.current;
}
