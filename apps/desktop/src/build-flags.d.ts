/**
 * The one flag that tells the two artifacts apart, folded in at build time.
 *
 * `vite.config.ts` defines it from `OHMAIL_LOCAL_ENGINE`, so it is a literal `true` or `false` in
 * the emitted code and every branch on it is removed by the bundler rather than taken at runtime.
 * That is the point: in the preview build the local engine's bridge is not "unused", it is not in
 * the file — and in the engine build the preview's stub is not aliased in.
 *
 * Declared here rather than in a source module so that reading it costs no import, and so `tsc`
 * and the bundler agree about a value neither of them owns.
 */
declare const __OHMAIL_LOCAL_ENGINE__: boolean;

/**
 * The version in `apps/desktop/package.json`, folded to a string literal at build time.
 *
 * A DEFINE and not a JSON import: importing the manifest would put the whole of it — its scripts,
 * its dependency ranges, its prose — into the bundle for one field, and the About pane needs the
 * number the installer was stamped with, which is exactly what that field is.
 */
declare const __OHMAIL_VERSION__: string;

