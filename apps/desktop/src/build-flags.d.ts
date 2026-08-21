/**
 * `__OHMAIL_LOCAL_ENGINE__` was declared here while a fixtures-only preview artifact shared the
 * window entry; the entry has one arm now and the flag is gone with its last consumer. What
 * remains below is the one build-time constant the window still reads.
 */

/**
 * The version in `apps/desktop/package.json`, folded to a string literal at build time.
 *
 * A DEFINE and not a JSON import: importing the manifest would put the whole of it — its scripts,
 * its dependency ranges, its prose — into the bundle for one field, and the About pane needs the
 * number the installer was stamped with, which is exactly what that field is.
 */
declare const __OHMAIL_VERSION__: string;

