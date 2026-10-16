import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isValidSparklePublicKey } from "../scripts/lib/sparkle-key.mjs";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE macOS UPDATER'S TRUST ANCHOR HAS TO BE REAL, AND THAT NEEDS A TEST.
 *
 * The apps are unsigned, so `SUPublicEDKey` in the committed Info.plist is the whole of what makes a
 * downloaded update trustworthy: an archive is installed only if its EdDSA signature verifies against
 * that key. A committed key that was missing, empty or malformed would mean trusting an unverified
 * download — remote code execution.
 *
 * ── WHAT THIS FILE STILL GUARDS, AND WHAT IT STOPPED GUARDING ───────────────────────────────────
 *
 * The key is NOT vestigial. macOS ships the same app as Windows and Linux now, and that app updates
 * through `latest.json` with a minisign key of its own — but every Mac carrying the previous, native
 * client still asks Sparkle for `appcast-macos.xml`, and the archive that feed offers is verified
 * against THIS key. It is the trust anchor of the handover, so it outlives the client it was minted
 * for and has to keep being correct.
 *
 * What this file used to also assert is that two packaging scripts refused to assemble a bundle whose
 * key was bad. Both scripts built the SwiftUI `.app` and went with it; there is no longer a packaging
 * step in this repository that reads the key, so those two assertions were removed rather than
 * weakened into something that passes. The remaining ones are about the committed key and the
 * predicate over it, which is the whole of what is left to be true.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INFO_PLIST = join(ROOT, publicRel("Resources/Info.plist"));

function plistString(xml: string, key: string): string | null {
  // Match `<key>KEY</key>` then the next `<string>…</string>`.
  const re = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`);
  return re.exec(xml)?.[1] ?? null;
}

describe("the committed Sparkle public key", () => {
  const xml = readFileSync(INFO_PLIST, "utf8");

  it("is present and a well-formed 32-byte Ed25519 key", () => {
    const key = plistString(xml, "SUPublicEDKey");
    expect(key, "Info.plist must carry SUPublicEDKey").not.toBeNull();
    expect(isValidSparklePublicKey(key!)).toBe(true);
  });

  it("names an https feed on the project's own repo", () => {
    const feed = plistString(xml, "SUFeedURL");
    expect(feed, "Info.plist must carry SUFeedURL").not.toBeNull();
    expect(feed!).toMatch(/^https:\/\//);
    expect(feed!).toContain("github.com/trafficflowhq/ohmail");
  });

  it("never installs silently — automatic install is off", () => {
    // A found update must be presented for consent (notify-and-install), so SUAutomaticallyUpdate
    // must be false. The <key> is followed by a bare <true/>/<false/> element.
    const m = /<key>SUAutomaticallyUpdate<\/key>\s*<(true|false)\/>/.exec(xml);
    expect(m, "Info.plist must set SUAutomaticallyUpdate").not.toBeNull();
    expect(m![1]).toBe("false");
  });
});

describe("the missing-key refusal (negative control)", () => {
  it("rejects a missing, empty or malformed key", () => {
    expect(isValidSparklePublicKey("")).toBe(false);
    expect(isValidSparklePublicKey("   ")).toBe(false);
    // @ts-expect-error — a plist read that found nothing is null.
    expect(isValidSparklePublicKey(null)).toBe(false);
    expect(isValidSparklePublicKey("!!! not base64 !!!")).toBe(false);
    expect(isValidSparklePublicKey(Buffer.alloc(31).toString("base64"))).toBe(false); // wrong length
    expect(isValidSparklePublicKey(Buffer.alloc(33).toString("base64"))).toBe(false);
  });

  it("accepts exactly the committed key, so the two agree", () => {
    const key = plistString(readFileSync(INFO_PLIST, "utf8"), "SUPublicEDKey");
    expect(isValidSparklePublicKey(key!)).toBe(true);
  });
});

/**
 * THE FEED THIS KEY VERIFIES IS STILL PUBLISHED, AND THAT IS THE OTHER HALF OF THE CLAIM.
 *
 * A correct key on a feed nobody produces protects nobody. The release-feeds workflow is what signs
 * the handover archive and attaches `appcast-macos.xml` to every release; if it ever stopped doing
 * that, an installed Swift client would ask for the feed, get a 404, and stay where it is for ever —
 * the silent stranding the whole handover exists to avoid. So the workflow is read here too.
 */
describe("the handover feed that key verifies", () => {
  it("is produced on every release and signed with the matching private key", () => {
    const wf = readFileSync(join(ROOT, publicRel("github/workflows/release-feeds.yml")), "utf8");
    expect(wf).toContain("appcast-macos.xml");
    expect(wf).toContain("OHMAIL_SPARKLE_ED_PRIVATE_KEY");
    // Both feeds are uploaded to the release; the appcast is not optional.
    expect(wf).toMatch(/gh release upload[\s\S]{0,200}appcast-macos\.xml/);
  });
});
