/**
 * build-variant.mjs: what one `--distribution` word selects, in one table.
 *
 * A distribution is three things that must agree: the window's `OHMAIL_DISTRIBUTION` literal, the
 * shell's cargo features, and the bundler's config overlays. `build-engine-app.mjs` takes all
 * three from here, so a new distribution is one row and cannot be half-applied.
 *
 *   direct   the download page's build, and the default
 *   mas      the Mac App Store's: the store updates it
 *   preview  a nightly build of the next major version, made to run beside a released install:
 *            its own identifier (and so its own data and log folders), its own keystore item,
 *            no update of its own. Linux only, for now: the macOS and Windows shells still name
 *            the released app's mail-link handler and registry keys, so a preview built there
 *            would not be separate from an installed ohmail.
 */

/** Every distribution, in the order the usage line prints them. */
export const DISTRIBUTIONS = ["direct", "mas", "preview"];

/** The platforms a distribution may be built on; absent means all three. */
const PLATFORMS = { preview: ["linux"] };

/** The overlay each distribution adds after `tauri.engine.conf.json`, by file name in `src-tauri`. */
const OVERLAY = { preview: "tauri.preview.conf.json" };

/**
 * The three halves for one distribution on one platform, or a thrown sentence.
 *
 * `features` is ONE comma-joined value: whether a repeated `--features` flag appends or replaces
 * is the CLI's business, and an artifact must not depend on it.
 */
export function buildVariant({ distribution, platform }) {
  if (!DISTRIBUTIONS.includes(distribution)) {
    throw new Error(`unknown --distribution ${distribution} (${DISTRIBUTIONS.join(" | ")})`);
  }
  const allowed = PLATFORMS[distribution];
  if (allowed && !allowed.includes(platform)) {
    throw new Error(
      `--distribution ${distribution} is built on ${allowed.join(", ")} only: on ${platform} it would `
      + "still share the released app's mail-link handler, so it is refused instead of built",
    );
  }
  return {
    /** The window's literal, read by `src/distribution.ts`. */
    literal: distribution,
    features: ["local-engine", ...(distribution === "direct" ? [] : [distribution])].join(","),
    /** In the order they are passed: a later overlay wins. */
    configs: ["tauri.engine.conf.json", ...(OVERLAY[distribution] ? [OVERLAY[distribution]] : [])],
  };
}
