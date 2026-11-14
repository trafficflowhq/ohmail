"use client";

/**
 * A callback whose identity never changes and whose scope holds nothing. Every closure created in one invocation of a
 * component shares ONE engine-level Context holding that invocation's entire scope, so a memoized callback handed
 * back unchanged makes the LATER render's scope hold a function from an EARLIER one — pinning that render's scope
 * entire, including whole-mirror derivations (in `AppShell`, a consent partition and a projection over every message,
 * one link per render).
 */

/**
 * `useCallback` cannot fix this with better dependencies: the problem is that ANY surviving function drags a whole
 * render scope. The returned function is created ONCE and forwards to the latest implementation through a ref: stable
 * identity, always the newest closure, the previous implementation dropped the moment a new one arrives.
 */

/**
 * The factory is at module scope as belt and braces, not the mechanism — the obvious claim (that an inlined factory
 * would pin `fn`) IS FALSE and was measured: the engine context-allocates only what an inner closure references, and
 * that closure references `latest` alone. The assignment is during RENDER, deliberately: an effect defers the swap to
 * commit, so a discarded render would leave the discarded implementation installed — and render-time assignment is
 * what makes a render-time read correct rather than one commit stale.
 */

/**
 * Contract: call it from events, effects, callbacks — and, unlike the platform's effect-based hook, DURING RENDER
 * after its own hook call (two `AppShell` sites do: `mirrorHolds`, `receiptsIsUnread`); the tests pin a render-time
 * read, and moving the assignment into an effect makes that test red.
 */

/**
 * What the stable identity does NOT license: treating the function as a reactive value — it never changes, so listing
 * it in a dependency array communicates nothing, and an array that relied on it has quietly stopped re-running
 * (`StreamCardMemo`'s comparator is the worked example: three mutable fields went missing for as long as a shifting
 * `onAction` re-rendered the card anyway).
 */

/**
 * The measured limit: "reads exactly the values the render is using" holds for a render that COMMITS — under
 * concurrent rendering an interrupted render B over a visible A can leave A's committed handler running B's
 * implementation. No product failure path has been demonstrated (the shell renders synchronously and nothing is
 * scheduled at a transition), so this is a stated limit; if this shell adopts `startTransition` or a Suspense
 * boundary that can abandon a render of `ShellInner`, re-open this and the effect-based assignment becomes the safer
 * trade.
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
