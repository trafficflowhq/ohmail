/**
 * THE DOWNLOAD MANIFEST — the contract between this page and the release pipeline.
 *
 * The landing page links these URLs directly, so a visitor's click starts the download
 * instead of landing them on a releases index to guess from. That only works if the
 * published assets carry EXACTLY the names below, which makes this file the source of
 * truth for the release procedure, not a description of it.
 *
 * ── WHAT THE RELEASE MUST DO ─────────────────────────────────────────────────────────
 *
 *  1. **Publish under these exact filenames.** The bundlers emit version-bearing names
 *     (`ohmail_0.6.1_x64-setup.exe`, `ohmail_0.6.1_amd64.AppImage`, …). A version in the
 *     filename cannot be linked from a static page, so the release step renames each
 *     artifact to its stable name BEFORE attaching it. Rename in place — never attach
 *     both a versioned and a stable copy of the same artifact.
 *  2. **Publish as a full release, not a pre-release.** `/releases/latest/download/…`
 *     resolves through GitHub's "latest stable release", which does not exist while every
 *     published release is a pre-release; the whole set of links below 404s at once. The
 *     v0.1–v0.4 tags were pre-releases and this is exactly what broke then.
 *  3. **Keep the suffixes.** The update-feed job selects payloads by glob — `*-setup.exe`,
 *     `*.AppImage`, `*.app.zip` — and takes the first match. Renaming is safe because it
 *     happens before the signature is computed, but dropping a suffix breaks the feed, and
 *     two files matching one glob makes the pick arbitrary.
 *
 * Names NOT in this manifest that the release also attaches, and which must not collide
 * with the ones here: `latest.json` and `appcast-macos.xml` (the update feeds),
 * `ohmail.app.zip` (the macOS update payload, not a download a person wants), and the
 * Windows `.msi`, which stays a deployment-tooling artifact rather than a button here.
 *
 * `ohmail.dmg` keeps the name it already ships under. It carries no version today because
 * the macOS packaging script hardcodes it, so it is the one asset that needs no rename —
 * and it is the name the public README already points people at.
 */

/** Where a released asset lives. `latest` = the most recent NON-pre-release. */
export const RELEASE_BASE = "https://github.com/trafficflowhq/ohmail/releases/latest/download";

/**
 * The current release's own page — notes for the exact build the buttons above hand out.
 *
 * Same `latest` indirection as `RELEASE_BASE`, for the same reason: a visitor asking
 * "what am I installing?" must land on the version they are about to download, and a
 * `…/releases/tag/vX.Y.Z` link answers that question correctly for exactly one release
 * and then lies. It resolves through GitHub's "latest stable release", so the pre-release
 * caveat in point 2 above applies to it as well.
 */
export const LATEST_RELEASE_URL = "https://github.com/trafficflowhq/ohmail/releases/latest";

/** The releases index — every version, notes and checksums. Always resolves. */
export const ALL_RELEASES_URL = "https://github.com/trafficflowhq/ohmail/releases";

/** The three desktop platforms, in the order the page presents them. */
export type PlatformId = "apple" | "linux" | "windows";

/** The two phone platforms of the second row. */
export type MobileId = "android" | "ios";

/**
 * ── THE ANDROID RELEASE — a page, not an asset, and it follows the newest tag ──────────
 *
 * Android ships from this same repository under its own tag family (`android-v*`), as a
 * GitHub PRE-release with the APK attached. That rules out the desktop row's mechanism:
 * `/releases/latest` resolves to the newest STABLE release, which is always a desktop
 * `v*` tag, so there is no `latest/download/…` path that could ever hand out the APK. And
 * a link pinned to one `android-vX.Y.Z` tag is the exact thing the desktop card once did
 * and went four releases stale doing.
 *
 * So the tag is read ONCE PER BUILD in `next.config.mjs` — the same build-time fetch, the
 * same failure posture as the nav's star count — and inlined as
 * {@link ANDROID_RELEASE_TAG_VAR}. The button links the tag's own release page (notes,
 * checksum, the APK), which is the honest destination for a sideloaded pre-release: a
 * person should read what they are about to install. When the build had no usable tag,
 * the link falls back to the releases index FILTERED to the Android family, which GitHub
 * lists newest first — never to a hard-coded version.
 */
export const ANDROID_RELEASE_TAG_VAR = "NEXT_PUBLIC_ANDROID_RELEASE_TAG";

/** The shape of an Android tag: `android-v` + a semver, optionally with a pre-release suffix. */
const ANDROID_TAG = /^android-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The releases index, filtered to the Android family — GitHub sorts it newest first. */
export const ANDROID_RELEASES_INDEX_URL = "https://github.com/trafficflowhq/ohmail/releases?q=android-v&expanded=true";

/** The release page for one tag. Refuses anything that is not an Android tag. */
export function androidReleaseUrl(tag: string | undefined): string {
  const t = (tag ?? "").trim();
  if (!ANDROID_TAG.test(t)) return ANDROID_RELEASES_INDEX_URL;
  return `${"https://github.com/trafficflowhq/ohmail/releases/tag/"}${t}`;
}

/**
 * Read as the full literal so Next inlines it at build time — a dynamic lookup would ship
 * `undefined` and silently send every visitor to the fallback index for ever.
 */
export const ANDROID_RELEASE_URL: string = androidReleaseUrl(process.env.NEXT_PUBLIC_ANDROID_RELEASE_TAG);

export interface DownloadFormat {
  /** The published asset filename. The release MUST attach exactly this. */
  asset: string;
  /** The direct link. Asserted to be `RELEASE_BASE` + "/" + `asset`. */
  url: string;
  /** Message key under `downloads` for the format's short label. */
  labelKey: string;
}

export interface PlatformDownload {
  id: PlatformId;
  /** Message key for the platform name. */
  nameKey: string;
  /** The download the button performs. */
  primary: DownloadFormat;
  /** A second packaging of the same app, offered quietly beside the button. */
  secondary?: DownloadFormat;
}

/**
 * Apple first, then Linux, then Windows.
 *
 * The order is deliberate and is not a popularity ranking: it is the order the platforms
 * are presented in everywhere else the product talks about itself, and a stable order
 * means the button a returning visitor reaches for does not move.
 */
export const DOWNLOADS: readonly PlatformDownload[] = [
  {
    id: "apple",
    nameKey: "apple",
    primary: {
      asset: "ohmail.dmg",
      url: "https://github.com/trafficflowhq/ohmail/releases/latest/download/ohmail.dmg",
      labelKey: "appleFormat",
    },
  },
  {
    id: "linux",
    nameKey: "linux",
    primary: {
      asset: "ohmail-linux-x86_64.AppImage",
      url: "https://github.com/trafficflowhq/ohmail/releases/latest/download/ohmail-linux-x86_64.AppImage",
      labelKey: "linuxFormat",
    },
    secondary: {
      asset: "ohmail-linux-amd64.deb",
      url: "https://github.com/trafficflowhq/ohmail/releases/latest/download/ohmail-linux-amd64.deb",
      labelKey: "linuxFormatAlt",
    },
  },
  {
    id: "windows",
    nameKey: "windows",
    primary: {
      asset: "ohmail-windows-setup.exe",
      url: "https://github.com/trafficflowhq/ohmail/releases/latest/download/ohmail-windows-setup.exe",
      labelKey: "windowsFormat",
    },
  },
] as const;

/**
 * ── THE BUILD-STAGE ORACLE ────────────────────────────────────────────────────────────
 *
 * WHICH PLATFORMS SHIP AN INTERFACE PREVIEW RATHER THAN THE COMPLETE APP, TODAY.
 *
 * The three downloads above all resolve and all install. They are not all the same
 * program: the macOS build carries the mail engine and connects to your own IMAP server,
 * while the Windows and Linux builds are the interface running against a sample mailbox
 * with no engine behind it. A page that says "one app, three platforms, on the mailboxes
 * you already own" is therefore true of one of the three and false of the other two, which
 * is exactly the kind of statement this project treats as a contract: site copy is judged
 * against the code.
 *
 * This constant is the single place that fact is written down. It drives BOTH:
 *
 *  · the caption the download section prints under each button (`Downloads.tsx`), and
 *  · a published-claims guard, which fails the build when any string in
 *    `messages/en.json` makes a working-local-client claim, names a platform listed here,
 *    and does not carry the "interface preview" disclosure alongside it.
 *
 * ── WHEN THE ENGINE SHIPS EVERYWHERE (0.7.0) ──────────────────────────────────────────
 *
 * Empty this array — `= []` — and nothing else here. That one edit removes the captions
 * from the page and, in the same motion, flips the guard: with no preview platforms left,
 * that same guard asserts the site carries NO preview disclosure
 * anywhere, so every hedged sentence has to be written back to the full three-platform
 * claim before the suite is green again. The oracle cannot be flipped quietly and the copy
 * cannot be un-hedged early; each half forces the other.
 */
export const PREVIEW_PLATFORMS: readonly PlatformId[] = [];

/** Is this platform's published build an interface preview today? */
export function isPreview(id: PlatformId): boolean {
  return PREVIEW_PLATFORMS.includes(id);
}

/**
 * True while at least one build is still a preview. The section only draws the
 * complete/preview distinction while it exists — once the array empties, no column gets a
 * stage caption and the panel returns to the shape it had before this existed.
 */
export const HAS_PREVIEW_BUILDS: boolean = PREVIEW_PLATFORMS.length > 0;

/**
 * Which platform is this visitor on? Used to EMPHASIZE one button — never to hide the
 * others, because the answer is a guess and the wrong guess must cost nothing.
 *
 * Returns null when the guess would be a coin toss, in which case all three buttons are
 * presented equally. Deliberately narrow: no version sniffing, no feature detection, no
 * attempt to distinguish Apple silicon from Intel (one universal disk image covers both).
 */
export function guessPlatform(ua: string): PlatformId | null {
  const s = ua.toLowerCase();
  // iOS and Android reach this page too. The desktop row is not for them, so the honest
  // answer here is "no guess" — an emphasized desktop button on a phone is a promise of the
  // wrong thing. The mobile row underneath is where a phone finds its own release.
  if (/iphone|ipad|ipod|android/.test(s)) return null;
  if (/windows|win32|win64/.test(s)) return "windows";
  // Order matters: a Mac UA contains "mac os x", and Linux UAs contain neither.
  if (/mac os x|macintosh/.test(s)) return "apple";
  if (/linux|x11|ubuntu|fedora|debian/.test(s)) return "linux";
  return null;
}
