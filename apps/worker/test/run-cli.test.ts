import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LeaseUnavailableError, OrganizerStandDownError } from "../src/lease.js";
import {
  RELEASE_REQUESTED_REFUSAL, cliArgs, leaseUnreadableRefusal, standDownRefusal,
} from "../src/run-cli.js";

/**
 * THE ONE-OFF RUNNERS SAY THE SAME THINGS, AND SAID THEM TWICE UNTIL `run-cli.ts`.
 *
 * These commands have no behavioural suite, so what is asserted is what an operator reads: the
 * flags, the refusal for a mailbox asked to stop being organized, and the two lease refusals with
 * their exit codes, each against its literal sentence. The census at the bottom is the other half:
 * a sentence nothing routes through is two copies again. The cases that compared each sentence with
 * the runners' own copies before this module existed read that commit out of git history, which a
 * checkout of this repository does not carry, so they left this file.
 */

const WORKER_SRC = fileURLToPath(new URL("../src/", import.meta.url));
const SWEEP = "apps/worker/src/run-junk-sweep.ts";
const RESTORE = "apps/worker/src/run-redacted-restore.ts";
const now = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

/** Every runner that routes through the scaffold, found by its import rather than listed. */
const RUNNERS = readdirSync(WORKER_SRC)
  .filter((f) => /^run-.+\.ts$/.test(f) && f !== "run-cli.ts")
  .map((f) => `apps/worker/src/${f}`)
  .filter((path) => /from "\.\/run-cli\.js"/.test(now(path)))
  .sort();

/**
 * What a runner must not do on its own any more. The CALL, not the word: a name in a comment is
 * not a second copy, and these files discuss both at length. `takeRunnerLease` is the one door, so
 * a runner calling `acquireLeasePermit` directly would be the second answer this module exists to
 * prevent.
 */
const CENSUS: ReadonlyArray<readonly [string, (src: string) => boolean]> = [
  ["calls acquireLeasePermit", (src) => /\bacquireLeasePermit\s*\(/.test(src)],
  ["calls assertNoLiveTwin", (src) => /\bassertNoLiveTwin\s*\(/.test(src)],
  ["reads releaseRequestedAt", (src) => /mailboxes\.releaseRequestedAt/.test(src)],
  ["spells the refusal", (src) => src.includes("has been asked to stop being organized here")],
];
const breaches = (src: string): string[] => CENSUS.filter(([, fires]) => fires(src)).map(([what]) => what);

/** A real stand-down, built from the outcome shape the lease gate hands the error. */
const standDown = (
  o: { reason: string; state: string; by: { displayName: string } | null },
): OrganizerStandDownError =>
  new OrganizerStandDownError(o as unknown as ConstructorParameters<typeof OrganizerStandDownError>[0]);

describe("the flags these runners parse", () => {
  it("reads a flag, an option and refuses an option whose value is another flag", () => {
    const { flag, opt } = cliArgs(["--execute", "--mailbox", "mb-1", "--limit", "--apply"]);
    expect([flag("execute"), flag("apply"), flag("nope")]).toEqual([true, true, false]);
    expect(opt("mailbox")).toBe("mb-1");
    // `--limit --apply` is a missing value, not a limit of "--apply".
    expect(opt("limit")).toBeNull();
    expect(opt("absent")).toBeNull();
  });
});

describe("the refusals, word for word", () => {
  it("refuses a mailbox that has been asked to stop being organized here", () => {
    const HEAD = " has been asked to stop being organized here — refusing to write to it. ";
    const TAIL = "The organizer's next pass releases the claim; run this again afterwards if it is still needed.";
    expect(RELEASE_REQUESTED_REFUSAL("mb-7")).toBe(`mailbox mb-7${HEAD}${TAIL}`);
  });

  it("keeps each runner's own verb and closing sentence in the stand-down", () => {
    const err = standDown({ reason: "organized_elsewhere", state: "held", by: { displayName: "laptop" } });

    const sweep = standDownRefusal(
      { verb: "sweep", nothingDone: "Nothing was moved. Exactly one organizer per mailbox; this process is not it." },
      err,
    );
    const restore = standDownRefusal(
      { verb: "restore", nothingDone: "Nothing was created and nothing was fetched." },
      err,
    );

    // The shape is shared; only the first and last lines differ, which is the whole point.
    const lines = (s: string): string[] => s.split("\n");
    expect(lines(sweep).slice(1, 3)).toEqual(lines(restore).slice(1, 3));
    expect(lines(sweep)[1]).toBe("  held by: laptop — still renewing");
    expect(lines(sweep)[2]).toBe("  reason:  organized_elsewhere");
    // The message is the error's own, which is what the operator was reading before too.
    expect(lines(sweep)[0]).toBe(`refusing to sweep: ${err.message}`);
    expect(lines(restore)[0]).toBe(`refusing to restore: ${err.message}`);
    expect(lines(sweep)[3]).toBe("Nothing was moved. Exactly one organizer per mailbox; this process is not it.");
    expect(lines(restore)[3]).toBe("Nothing was created and nothing was fetched.");

    // And each closing sentence is the one that runner hands the scaffold.
    expect(now(SWEEP)).toContain("Nothing was moved. Exactly one organizer per mailbox; this process is not it.");
    expect(now(RESTORE)).toContain("Nothing was created and nothing was fetched.");
  });

  it("names an UNREADABLE lease as our problem, never as somebody holding the mailbox", () => {
    const err = new LeaseUnavailableError("the folder would not open", { op: "list_claims" });
    for (const verb of ["sweep", "restore"] as const) {
      const line = leaseUnreadableRefusal({ verb, nothingDone: "" }, err);
      expect(line).toBe(`refusing to ${verb}: the organizer lease could not be read — the folder would not open`);
    }
  });

  it("a stand-down that is NOT held reads `stopped, but not ours to take`", () => {
    const err = standDown({ reason: "organizer_stopped", state: "released", by: null });
    expect(standDownRefusal({ verb: "sweep", nothingDone: "x" }, err).split("\n")[1])
      .toBe("  held by: (unnamed) — stopped, but not ours to take");
  });
});

describe("the census — every runner routes through the module, none re-spells it", () => {
  it("each imports the shared scaffold", () => {
    for (const path of [SWEEP, RESTORE]) {
      expect(now(path), `${path} imports ./run-cli.js`).toMatch(/from "\.\/run-cli\.js"/);
    }
  });

  it("neither takes the lease or reads the release fence on its own any more", () => {
    for (const path of [SWEEP, RESTORE]) {
      expect(breaches(now(path)), path).toEqual([]);
    }
  });

  it("no runner that imports the scaffold does any of that either", () => {
    // Found by the import, so a new runner joins the census without an edit here.
    expect(RUNNERS).toEqual(expect.arrayContaining([SWEEP, RESTORE, "apps/worker/src/run-blank-repair.ts"]));
    for (const path of RUNNERS) {
      expect(breaches(now(path)), path).toEqual([]);
    }
  });

  it("control: every census predicate fires on a runner that does it itself", () => {
    // Without this the cases above would pass for a census that matches nothing.
    const planted = [
      "await assertNoLiveTwin({ adapter, installId, now });",
      "const permit = await acquireLeasePermit({ adapter, mailboxId });",
      "if (row.releaseRequestedAt !== null) return; // via mailboxes.releaseRequestedAt",
      "console.error(`mailbox ${id} has been asked to stop being organized here — refusing`);",
    ].join("\n");
    expect(breaches(planted)).toEqual(CENSUS.map(([what]) => what));
    expect(breaches("// acquireLeasePermit is called by takeRunnerLease, not here\nawait takeRunnerLease(opts);"))
      .toEqual([]);
  });
});
