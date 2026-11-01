import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readFragments, releasesFrom } from "../../../scripts/changelog-fold.mjs";
import { ROOT, publicPath } from "../../../test/support/public-root.mjs";
import { writtenByABuildThatRecordsNothing } from "../src/profile.js";

/**
 * THE FIRST RELEASE THAT RECORDS IS THE RELEASE THAT SHIPS THE RECORD. A settings copy whose label names a
 * release before `FIRST_RECORDING_RELEASE` (profile.ts) is read as written by a build that records nothing.
 * Named too low, a release without the record reads as one with it: after a rollback to it and forward again
 * the store asks about its own copy and stops publishing until the person answers. Named too high, a release
 * with the record reads as one without: a restored store takes its later life's copy for its own and
 * overwrites it. The release that ships the record is the one whose CHANGELOG.md section carries this
 * change's entry: every release before it reads as recording nothing, it and every later one as recording,
 * and while the entry waits in changelog.d/, every release so far records nothing and the next one records.
 */
const ENTRY = "A restored backup no longer rolls back the settings stored in the mailbox";

const parts = (v: string): number[] => v.split(".").map(Number);
const order = (a: string, b: string): number => {
  const [x, y] = [parts(a), parts(b)];
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
};
const nextPatch = (v: string): string => {
  const [major, minor, patch] = parts(v);
  return `${major}.${minor}.${patch! + 1}`;
};

/** The versions the label rule reads wrongly against `changelog`; `waiting`: the entry is still in changelog.d/. */
function misread(changelog: string, waiting: boolean): string[] {
  const released = releasesFrom(changelog).sort((a, b) => order(a.version, b.version));
  const first = released.find((r) => r.items.includes(ENTRY))?.version;
  const wrong = released
    .filter((r) => writtenByABuildThatRecordsNothing(r.version) === (first !== undefined && order(r.version, first) >= 0))
    .map((r) => r.version);
  const newest = released[released.length - 1]?.version;
  if (waiting && first === undefined && newest !== undefined && writtenByABuildThatRecordsNothing(nextPatch(newest))) {
    wrong.push(nextPatch(newest));
  }
  return wrong;
}

describe("the first release that records is the release that carries the record", () => {
  const changelog = readFileSync(publicPath("CHANGELOG.md"), "utf8");
  const waiting = readFragments(ROOT).fragments.some((f) => f.headline === ENTRY);
  const carrying = releasesFrom(changelog).filter((r) => r.items.includes(ENTRY)).map((r) => r.version);

  it("the entry waits in changelog.d/ or sits in one released section", () => {
    expect((waiting ? 1 : 0) + carrying.length).toBe(1);
  });

  it("every released version, and the next one while the entry waits, reads as the build it is", () => {
    expect(misread(changelog, waiting)).toEqual([]);
  });

  /* The positive control: the release this change rides, cut without it, is read wrongly. */
  it("finds the release this change rides cut without it", () => {
    const newest = releasesFrom(changelog)[0]!.version;
    const cut = carrying.length === 0
      ? changelog.replace(/^## \[\d+\.\d+\.\d+\]/m, (h) => `## [${nextPatch(newest)}] — 2026-11-01\n\n### Another change\n\nIts text.\n\n${h}`)
      : changelog.replace(`### ${ENTRY}`, "### Another change");
    expect(misread(cut, true)).toContain(carrying[0] ?? nextPatch(newest));
  });
});
