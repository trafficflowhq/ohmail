/**
 * The download manifest — the contract between this page and the release pipeline. The landing links
 * these URLs directly, which only works if the published assets carry EXACTLY these names. The
 * release must: (1) publish under these exact filenames — the bundlers emit version-bearing names,
 * renamed in place before attaching, never both copies; (2) publish as a full release, not a
 * pre-release — `/releases/latest/download/…` resolves through "latest stable", and the v0.1–v0.4
 * pre-release tags 404'd the whole set; (3) keep the suffixes — the update-feed job selects by glob
 * and takes the first match. Also attached, must not collide: `latest.json`, `appcast-macos.xml`,
 * `ohmail.app.zip`, the Windows `.msi`. `ohmail.dmg` keeps its unversioned name.
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
 * The Android APK — the desktop row's mechanism, now that the APK is a release asset. This used to
 * read the newest `android-v*` tag once per build and link that tag's page, on the premise that
 * `latest` could never reach the APK (Android tags are pre-releases); the premise died when the
 * release began attaching the signed APK to the stable release, and a tag baked at build time went
 * stale — the button sat on `android-v0.15.0` two releases later. So the phone uses the same
 * indirection and asset contract as the three desktop buttons: one published name under
 * {@link RELEASE_BASE}, asserted in `download-assets.test.ts` and allow-listed in
 * `no-third-party.test.ts`. GitHub resolves `latest` per request, so this link cannot fall behind.
 */
export const ANDROID_APK_ASSET = "ohmail-android.apk";

/**
 * The full literal, like the desktop entries below: the off-origin scan reads string
 * literals, and `download-assets.test.ts` asserts this is `RELEASE_BASE` + the asset name.
 */
export const ANDROID_RELEASE_URL = "https://github.com/trafficflowhq/ohmail/releases/latest/download/ohmail-android.apk";

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
  /**
   * Other packagings of the same app, offered quietly beside the button.
   *
   * A LIST rather than one optional `secondary`, which is what this was while Linux had
   * exactly two packagings. A third arrived — the `.rpm` for Fedora and openSUSE — and the
   * two shapes are not equivalent: with a single slot, adding a packaging means either a
   * `tertiary` field or dropping one of the two already there, and both of those are edits
   * that reach into the component. With a list, a packaging is one entry here and the page
   * renders what it is given. The order is the order they are shown in.
   */
  alternates?: readonly DownloadFormat[];
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
    /*
     * THE PACKAGE-MANAGER FORMATS, x86_64 ONLY — deliberately, and for the reason the
     * AppImage above it is x86_64 only: a browser cannot tell the two Linux architectures
     * apart — Chrome reports the same 64-bit Linux user-agent on an arm64 machine as on an
     * Intel one — so a link the page chooses is an x86_64 link whatever the hardware is. The
     * release attaches all four Linux packages, and the README's table is where somebody on
     * aarch64 is sent.
     */
    alternates: [
      {
        asset: "ohmail-linux-amd64.deb",
        url: "https://github.com/trafficflowhq/ohmail/releases/latest/download/ohmail-linux-amd64.deb",
        labelKey: "linuxFormatDeb",
      },
      {
        asset: "ohmail-linux-x86_64.rpm",
        url: "https://github.com/trafficflowhq/ohmail/releases/latest/download/ohmail-linux-x86_64.rpm",
        labelKey: "linuxFormatRpm",
      },
    ],
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
 * The build-stage oracle: which platforms ship an interface preview rather than the complete app.
 * The macOS build carries the mail engine; Windows and Linux run the interface against a sample
 * mailbox — "one app, three platforms" would be false of two, and site copy is judged against the
 * code. This constant drives the caption under each button (`Downloads.tsx`) AND a published-claims
 * guard that fails the build when a `messages/en.json` string makes a working-local-client claim
 * about a platform listed here without the disclosure. When the engine ships everywhere: empty this
 * array and nothing else — the captions leave and the same guard flips to assert NO preview
 * disclosure remains; the oracle cannot flip quietly and the copy cannot un-hedge early.
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
