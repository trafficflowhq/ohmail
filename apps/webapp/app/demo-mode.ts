/**
 * The demo decision — one function, fail-SAFE toward the demo, because the demo is fiction and must make no external
 * request. `?demo=1` is a promise: fixtures only, zero network. The failure that matters is a URL presented as the
 * demo booting the HttpAdapter against a real mailbox, and it happened two ways: repeated parameters — Next hands a
 * repeated key an ARRAY, so `/?demo=1&demo=0` produced `["1","0"] === "1"` → false → live; here EVERY value is
 * inspected and ANY of them asking for the demo wins.
 */

/**
 * And a build-time gate — a prerender bakes `searchParams = {}` into the one emitted HTML, so {@link isDemoRequested}
 * also accepts a raw query STRING and the client re-derives from `window.location.search` before the engine is
 * constructed. One-directional, deliberately: the client may turn the demo ON, never OFF.
 */

/** The query parameter that opens the demo. */
export const DEMO_PARAM = "demo";

/**
 * Values that mean "yes". `""` covers a bare `/?demo`, which a human plainly means as a
 * request for the demo; anything else (`0`, `false`, `no`, a typo) is not a demo request
 * and falls through to the ordinary gate.
 */
const TRUTHY = new Set(["1", "true", "yes", "on", ""]);

/** Next's `searchParams` shape: a repeated key arrives as an array. */
export type SearchParamsLike = Record<string, string | string[] | undefined>;

const asks = (value: string): boolean => TRUTHY.has(value.trim().toLowerCase());

/**
 * Does this URL ask for the demo?
 *
 * Accepts every shape the answer can arrive in — Next's `searchParams` record (server), a
 * `URLSearchParams`, or the raw `window.location.search` (client) — because the SAME rule
 * has to hold on both sides of hydration or the two disagree and one of them is wrong.
 */
export function isDemoRequested(
  input: SearchParamsLike | URLSearchParams | string | null | undefined,
): boolean {
  if (input == null) return false;

  if (typeof input === "string") {
    return isDemoRequested(new URLSearchParams(input.startsWith("?") ? input.slice(1) : input));
  }
  if (input instanceof URLSearchParams) {
    // `getAll` is what makes `?demo=0&demo=1` a demo: every occurrence is considered.
    return input.getAll(DEMO_PARAM).some(asks);
  }
  const raw = input[DEMO_PARAM];
  if (raw === undefined) return false;
  return (Array.isArray(raw) ? raw : [raw]).some(asks);
}

/** `NEXT_PUBLIC_DEMO` — the build-time forcing of demo mode (Stage 1's default). */
export function isDemoBuild(env: Record<string, string | undefined>): boolean {
  const v = (env.NEXT_PUBLIC_DEMO ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}
