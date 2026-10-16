import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publicPath } from "./support/public-root.mjs";

/**
 * EVERY PLATFORM'S SHIPPED BINARY IS READ, AND macOS WAS NOT BEING READ AT ALL.
 *
 * The UI bundle is embedded uncompressed in the binary on purpose, so the artifact people
 * download can be audited without being run: the CSP is grepped out of it and every URL string
 * enumerated, failing on any first-party address that is not one of the named endpoints. Windows
 * and both Linux jobs did that. macOS did not, so a phone-home or a missing CSP compiled into the
 * .app shipped unchallenged — and `RELEASING.md` said so in as many words.
 *
 * `desktop-first-party-urls.test.ts` keeps the four allow-lists equal to the Rust link table and
 * the README. This is the other half: that each job's check WORKS. The blocks are pulled out of
 * the workflow and run as the shell they are, against planted binaries — a retyped copy could
 * pass while the shipped bytes fail.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const WF = readFileSync(publicPath("github/workflows/build.yml"), "utf8").split("\n");

const CSP = "default-src 'self'; connect-src 'none'; object-src 'none'";
const FEED = "https://github.com/trafficflowhq/ohmail/releases/latest/download/latest.json";
const CLOUD = "https://api.ohmail.app";

/**
 * Each inspecting job's URL/CSP block, keyed by job id: from the CSP grep to the closing count.
 * The job id comes from the nearest preceding top-level key, so a failure names the job.
 */
function blocks(): Map<string, string> {
  const found = new Map<string, string>();
  let job: string | null = null;
  for (let i = 0; i < WF.length; i++) {
    const key = /^ {2}([A-Za-z0-9_-]+):$/.exec(WF[i]);
    if (key) job = key[1];
    if (!WF[i].includes(`grep -aq "connect-src 'none'"`)) continue;
    const end = WF.findIndex((l, k) => k > i && l.includes("unique URL strings (reconcile with the README"));
    expect(end, `${job}: the CSP grep has no closing count line after it`).toBeGreaterThan(i);
    if (job === null) throw new Error(`build.yml:${i + 1}: an inspection outside any job`);
    found.set(job, WF.slice(i, end + 1).map((l) => l.replace(/^ {10}/, "")).join("\n"));
  }
  return found;
}

const BLOCKS = blocks();

/** Runs one job's block against a planted binary, and answers with the shell's own status. */
function run(job: string, contents: string): { code: number; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-inspect-"));
  writeFileSync(join(dir, "bin"), contents);
  writeFileSync(join(dir, "check.sh"), `set -euo pipefail\nBIN=bin\n${BLOCKS.get(job)}\n`);
  try {
    execFileSync("bash", ["check.sh"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, err: "" };
  } catch (e) {
    const x = e as { status?: number; stderr?: string };
    return { code: x.status ?? -1, err: x.stderr ?? "" };
  }
}

describe("every platform job reads its shipped binary", () => {
  it("inspects all four artifacts, macOS included", () => {
    expect([...BLOCKS.keys()].sort()).toEqual(["linux", "linux-arm64", "macos", "windows"]);
  });

  for (const job of ["macos", "windows", "linux", "linux-arm64"]) {
    describe(job, () => {
      it("admits a binary carrying the CSP and only the named endpoints", () => {
        // The positive control, per job: a check that refuses every build is worse than none.
        expect(run(job, `${CSP}\n${FEED}\n${CLOUD}\nhttps://example.org/unrelated\n`).code).toBe(0);
      });

      it("admits a third-party address with one of our literals glued to its end", () => {
        // The 0.22.1 rc1 shape, read off both Linux jobs: Rust literals sit unterminated in
        // read-only data, and a first-party NAME after a third-party HOST is not our endpoint.
        const glued = "https://tailscale.com/downloadpublishedOHMAIL_BUILD_COMMITNODE_EXTRA_CA_CERTS";
        expect(run(job, `${CSP}\n${FEED}\n${CLOUD}\n${glued}\n`).code).toBe(0);
      });
      it("refuses a first-party URL nobody named", () => {
        const { code, err } = run(job, `${CSP}\n${FEED}\n${CLOUD}\nhttps://beacon.ohmail.app/t\n`);
        expect(code).not.toBe(0);
        expect(err).toContain("unexpected first-party URL");
      });

      it("refuses a binary with no CSP in it", () => {
        expect(run(job, `${FEED}\n${CLOUD}\n`).code).not.toBe(0);
      });

      it("refuses a binary with no update feed in it", () => {
        const { code, err } = run(job, `${CSP}\nhttps://example.org/unrelated\n`);
        expect(code).not.toBe(0);
        expect(err).toContain("the pinned update feed URL is missing");
      });

      it("is not fooled by a host glued onto an allowed one", () => {
        // Measured on a real release build: `https://api.ohmail.appcloud-tokens.sealthe` came back
        // as one match, two unrelated string literals stuck to the end of an allowed URL. The
        // re-split on the scheme is what makes a prefix match answer for exactly one address.
        const { code } = run(job, `${CSP}\n${FEED}\n${CLOUD}https://evil.ohmail.example/x\n`);
        expect(code).not.toBe(0);
      });
    });
  }
});
