/**
 * WHAT AN ERROR BOUNDARY SAYS ABOUT WHAT IT CAUGHT, in one place because the rule is one rule:
 * the DIGEST and nothing else. Next's digest is a hash it also logs server-side, so it identifies
 * the fault without carrying it; a thrown value can hold whatever the app had in hand when it
 * threw — an address, a subject line — and the console is copied into bug reports. The view
 * boundary's `console.error("[view] render failed", …)` is the path this joins, one level up.
 * A log line, never control flow: no boundary here re-throws.
 */
export function reportRenderError(digest?: string): void {
  // eslint-disable-next-line no-console
  if (digest) console.error("[app] render failed, digest", digest);
  else console.error("[app] render failed");
}
