/**
 * WHICH BUILD THIS IS — the version, plus the commit it was built from when there is one.
 *
 * A desktop artifact carried no identity but its version string, so a release candidate, the tag
 * build and any later rebuild were indistinguishable: same name, same reported version, nothing
 * inside to tell them apart. A pass could not assert that the binary it exercised is the binary
 * the tag ships.
 *
 * The build workflow puts its commit in `OHMAIL_BUILD_SHA` and `vite.config.ts` folds it in. A
 * build from a checkout with nothing set — the ordinary case for anyone building this themselves
 * — reports the version alone, which is honest: there is no commit to name.
 */

/** The shortest prefix that identifies a commit here. `git log --oneline` prints nine. */
const SHORT = 9;

/** The label alone, pure so a test can assert every case from one machine. */
export function buildLabelOf(version: string, sha: string): string {
  const trimmed = sha.trim();
  // 40-hex or nothing: a partial or decorated value names no commit, and a label that looks like
  // an identifier without being one is worse than the version on its own.
  return /^[0-9a-f]{40}$/.test(trimmed) ? `${version} · ${trimmed.slice(0, SHORT)}` : version;
}

/**
 * The label for THIS build. `typeof` guards the context where no bundler folded the constants in
 * — the test runner importing this module from source — and answers as an unstamped build does.
 */
export const BUILD_LABEL: string = buildLabelOf(
  typeof __OHMAIL_VERSION__ === "string" ? __OHMAIL_VERSION__ : "dev",
  typeof __OHMAIL_BUILD_SHA__ === "string" ? __OHMAIL_BUILD_SHA__ : "",
);

/** The full commit, or "" where the build was not stamped. Beside the label for a diagnostic. */
export const BUILD_SHA: string =
  typeof __OHMAIL_BUILD_SHA__ === "string" && /^[0-9a-f]{40}$/.test(__OHMAIL_BUILD_SHA__)
    ? __OHMAIL_BUILD_SHA__
    : "";
