import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { changelogIn, plainText, releasesFrom, renderReleases, withReleases, LIMIT }
  from "../scripts/appstream-releases.mjs";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE SOFTWARE CENTRE'S COPY OF THIS APP.
 *
 * The metainfo is what a person reads before installing, and its release notes are the changelog
 * — derived by `scripts/appstream-releases.mjs` rather than written twice, because the second
 * copy is the one that stops being true. The check here is the one that bites at a tag: a
 * version that lands in CHANGELOG.md without the metainfo being regenerated is red, instead of
 * shipping a listing whose newest release is the previous one.
 *
 * The desktop entry is beside it for the two lines that are not cosmetic: the window is
 * attributed to the entry by `StartupWMClass`, and ohmail is selectable as the system mail app
 * only through the two scheme handlers.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (rel: string) => readFileSync(join(HERE, "..", rel), "utf8");

const APP_ID = "app.ohmail.Desktop";
const metainfo = read(`apps/desktop/flatpak/${APP_ID}.metainfo.xml`);
const entry = read(`apps/desktop/flatpak/${APP_ID}.desktop`);
const changelog = read(publicRel("CHANGELOG.md"));

describe("the metainfo names this app and launches it", () => {
  it("carries the app id, and the launchable is the exported entry", () => {
    expect(metainfo).toContain(`<id>${APP_ID}</id>`);
    expect(metainfo).toContain(`<launchable type="desktop-id">${APP_ID}.desktop</launchable>`);
  });

  it("states the licence this repository is under", () => {
    expect(metainfo).toContain("<project_license>AGPL-3.0-only</project_license>");
    expect(metainfo).toContain("<metadata_license>CC0-1.0</metadata_license>");
  });

  it("has the developer id the domain verification is for", () => {
    expect(metainfo).toContain('<developer id="app.ohmail">');
    expect(metainfo).toContain("<url type=\"homepage\">https://ohmail.app</url>");
  });

  it("keeps the summary short enough for a software centre to show whole", () => {
    const summary = /<summary>(.+)<\/summary>/.exec(metainfo)?.[1] ?? "";
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(35);
    expect(summary.endsWith(".")).toBe(false);
  });

  it("names no mailbox, no address and no count of anybody's mail", () => {
    // Store copy is read by strangers. An address in it would be somebody's, and a measurement
    // of a real mailbox is a measurement of a real person's mail.
    expect(metainfo).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(entry).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
  });
});

describe("the release notes are the changelog's", () => {
  it("the committed file is what the generator would write", () => {
    const wanted = withReleases(
      metainfo,
      renderReleases(releasesFrom(changelog).slice(0, LIMIT)),
    );
    expect(metainfo).toBe(wanted);
  });

  it("the changelog's newest released version is in the file", () => {
    // The cell that bites at a tag. `## [Unreleased]` is not a release and is deliberately not
    // matched — a tag turns it into a version and a date, and this goes red until the metainfo
    // is regenerated.
    const newest = releasesFrom(changelog)[0];
    expect(newest).toBeDefined();
    expect(metainfo).toContain(`<release version="${newest.version}" date="${newest.date}">`);
  });

  it("an unreleased heading contributes no release", () => {
    const versions = releasesFrom(changelog).map((release) => release.version);
    expect(versions).not.toContain("Unreleased");
    expect(versions.every((version) => /^\d+\.\d+\.\d+$/.test(version))).toBe(true);
  });

  it("changelog prose reaches the file as text, not as markup", () => {
    expect(plainText("A `--flag` and a [link](https://example.com) and **bold**"))
      .toBe("A --flag and a link and bold");
    expect(plainText("Trash <em> & Spam")).toBe("Trash &lt;em&gt; &amp; Spam");
  });
});

describe("every screenshot the listing names is a file this repository publishes", () => {
  // A software centre and the Flathub reviewer both FETCH these. `appstreamcli validate` reports
  // `screenshot-image-not-found` for a URL that 404s, which is a review stop — and the way one
  // gets there is a file renamed or moved while the metainfo keeps the old path. Derived here:
  // the URL is read apart and the path it names must exist in the tree.
  const RAW = "https://raw.githubusercontent.com/trafficflowhq/ohmail/main/";
  const images = [...metainfo.matchAll(/<image>([^<]+)<\/image>/g)].map((found) => found[1]);

  it("names at least one, because a listing with none is refused", () => {
    expect(images.length).toBeGreaterThanOrEqual(1);
  });

  it("each one is a raw URL on the published repository, and the file is here", () => {
    for (const url of images) {
      expect(url.startsWith(RAW), url).toBe(true);
      const path = url.slice(RAW.length);
      expect(path.startsWith("apps/desktop/flatpak/screenshots/"), url).toBe(true);
      expect(existsSync(join(HERE, "..", path)), path).toBe(true);
    }
  });

  it("each carries a caption, which is what a reader without the image gets", () => {
    const shots = [...metainfo.matchAll(/<screenshot[^>]*>([\s\S]*?)<\/screenshot>/g)];
    expect(shots).toHaveLength(images.length);
    for (const [, body] of shots) expect(body).toMatch(/<caption>.+<\/caption>/);
  });
});

describe("the desktop entry is the one the window maps to", () => {
  it("attributes the window by the BINARY name, not the app id", () => {
    // The Wayland app_id and the X window instance name are both `ohmail`. This line is what stops a
    // running window drawing an unlabelled second taskbar icon.
    expect(entry).toMatch(/^StartupWMClass=ohmail$/m);
    expect(entry).toMatch(/^Exec=ohmail %U$/m);
  });

  it("claims both schemes, so ohmail is selectable as the mail app", () => {
    const mime = /^MimeType=(.+)$/m.exec(entry)?.[1] ?? "";
    expect(mime).toContain("x-scheme-handler/mailto");
    expect(mime).toContain("x-scheme-handler/ohmail");
  });

  it("takes its icon from the app id, which is what the manifest installs", () => {
    expect(entry).toMatch(new RegExp(`^Icon=${APP_ID.replace(/\./g, "\\.")}$`, "m"));
  });
});

describe("the derivation finds the changelog in either tree", () => {
  /* This script runs in two trees and the check died ENOENT in the published one for the whole of
   * 0.18.0's CI: the job could not compare anything, which reads as a red about the app. The two
   * shapes are built here rather than described, because the spelling is the whole defect. */
  const shape = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "ohmail-changelog-shape-"));
    for (const [rel, body] of Object.entries(files)) {
      const at = join(root, rel);
      mkdirSync(join(at, ".."), { recursive: true });
      writeFileSync(at, body);
    }
    return root;
  };

  it("takes the payload spelling in a monorepo tree, even beside a stray root file", () => {
    const root = shape({
      "public/ohmail/CHANGELOG.md": "# the maintained one\n",
      "CHANGELOG.md": "# a stray stub\n",
    });
    try {
      expect(changelogIn(root)).toBe(join(root, "public", "ohmail", "CHANGELOG.md"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("takes the published spelling in a mirror-shaped tree, which has no payload root", () => {
    const root = shape({ "CHANGELOG.md": "# the published one\n" });
    try {
      expect(existsSync(join(root, "public"))).toBe(false);
      expect(changelogIn(root)).toBe(join(root, "CHANGELOG.md"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("answers null where neither exists, so the caller refuses by name", () => {
    const root = shape({ "apps/desktop/flatpak/keep": "" });
    try {
      expect(changelogIn(root)).toBe(null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("resolves in this checkout, whichever tree it is", () => {
    const here = join(HERE, "..");
    expect(changelogIn(here)).not.toBe(null);
    expect(readFileSync(changelogIn(here) as string, "utf8")).toMatch(/^## \[\d+\.\d+\.\d+\]/m);
  });
});
