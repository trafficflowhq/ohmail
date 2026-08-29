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

/**
 * The platform this bundle was BUILT ON — `process.platform` folded to a literal at build time,
 * which is also the platform it ships to: the release workflow runs `tauri build` on a macOS,
 * Windows and Linux runner respectively, one artifact each. `src/platform.ts` is the only
 * consumer and owns the mapping to a user-facing word; everything else imports the word.
 * Absent (typeof-guarded) where no bundler ran — the test runner importing source.
 */
declare const __OHMAIL_PLATFORM__: string;

