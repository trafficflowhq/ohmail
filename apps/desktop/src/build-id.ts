/**
 * WHICH BUILD THIS IS — the version, plus the commit it was built from when there is one.
 *
 * `OHMAIL_BUILD_SHA` is folded in by `vite.config.ts`. Only 40 lowercase hex names a commit: a
 * partial or decorated value looks like an identifier without being one, so the label falls back
 * to the version alone — which is also the honest answer for a build made from a checkout.
 */

/** `git log --oneline` prints nine characters here, so nine is what identifies a commit. */
const SHORT = 9;

/** The rule alone, pure so a test can assert every case from one machine. */
export function buildLabelOf(version: string, sha: string): string {
  const trimmed = sha.trim();
  return /^[0-9a-f]{40}$/.test(trimmed) ? `${version} · ${trimmed.slice(0, SHORT)}` : version;
}

/* The two constants for THIS build. `typeof` guards the one context where no bundler folded them
   in — the test runner importing from source — and answers as an unstamped build does. */
export const BUILD_LABEL: string = buildLabelOf(
  typeof __OHMAIL_VERSION__ === "string" ? __OHMAIL_VERSION__ : "dev",
  typeof __OHMAIL_BUILD_SHA__ === "string" ? __OHMAIL_BUILD_SHA__ : "",
);

/** The full commit, or "" where the build was not stamped. */
export const BUILD_SHA: string =
  typeof __OHMAIL_BUILD_SHA__ === "string" && /^[0-9a-f]{40}$/.test(__OHMAIL_BUILD_SHA__)
    ? __OHMAIL_BUILD_SHA__
    : "";
