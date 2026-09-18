/**
 * WHICH BUILD IS THIS — for the error pages, the one screen where the answer matters most and
 * the least of the app is left to ask. The same two constants `next.config.mjs` inlines for the
 * About pane, derived the same way: the build sha keeps its `?? "dev"`, because "dev" is a TRUE
 * answer for a build with no commit behind it, and the RELEASE gets no fallback at all — a
 * `?? "dev"` there would print a version that is not this one in the one place somebody is
 * reading it in order to report a fault (`test/app-version.test.ts` states the rule for About;
 * this is the second reader and it obeys the same one).
 */
const BUILD = process.env.NEXT_PUBLIC_BUILD ?? "dev";
const VERSION = process.env.NEXT_PUBLIC_APP_VERSION;

/**
 * `<release> · build <short sha>`, or just the build when the release did not inline. Two facts in
 * the order About states them, and never a third that was guessed at.
 */
export function buildId(): string {
  return VERSION ? `${VERSION} · build ${BUILD}` : `build ${BUILD}`;
}
