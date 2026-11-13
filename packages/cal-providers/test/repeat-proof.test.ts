/**
 * THE REPEAT PROOF, AS RECORDED (MAP 3.8): the bench's CalDAV server's own answers to every case of
 * the proof, read again here with the calendar core's expansion of the same text. A shape is in
 * CalDAV's proven row only where every case of it was answered and both readings name the same days;
 * the rows of the providers the proof has not been run at stay empty, and a series in a shape no
 * row names is refused by the write path (`repeat_unsupported`, the drain's own case).
 *
 * The record is made by `repeat-proof.live.ts` at the bench's own server (`OHCAL_REPEAT_PROOF_RECORD=1`).
 * A change that writes a series' text otherwise makes every case's digest differ: the proof is then
 * of another text, and it is made again before the row may stand.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { intlZones } from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import { convertEvent } from "../src/google/convert.js";
import { bodyOf } from "../src/google/writer.js";
import { BENCH_CALDAV_PLACE, PROVEN_REPEATS } from "../src/repeat-shapes.js";
import { carriesInvitees } from "./support/caldav-test-client.ts";
import {
  PROOF_CASES,
  agrees,
  caseText,
  coreDays,
  provenBy,
  provenByGoogle,
  serverDays,
  sha256,
  uidOf,
  type GoogleProofRecord,
  type ProofRecord,
} from "./support/repeat-proof.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const bench = JSON.parse(
  readFileSync(join(HERE, "support", "fixtures", "bench", "repeat-proof.json"), "utf8"),
) as ProofRecord;
const recorded = new Map(bench.cases.map((r) => [r.name, r] as const));

describe("the repeat proof, as the bench's server answered it", () => {
  it("holds every case, each made on the text the CalDAV writer writes today, and carries no invitee", () => {
    expect(bench.server).toBe("bench");
    expect(PROOF_CASES.map((c) => c.name).filter((name) => !recorded.has(name))).toEqual([]);
    for (const c of PROOF_CASES) {
      const text = caseText(c, uidOf(c));
      expect([c.name, recorded.get(c.name)!.written]).toEqual([c.name, sha256(text)]);
      expect([c.name, carriesInvitees(text)]).toEqual([c.name, false]);
    }
  });

  it("reads the same days from the server's answer and from the core, case by case, where the write path takes the series", () => {
    for (const c of PROOF_CASES.filter((p) => p.shape !== null)) {
      const r = recorded.get(c.name)!;
      expect([c.name, r.answered, serverDays(c, r.server)]).toEqual([
        c.name,
        "expand",
        coreDays(c, caseText(c, uidOf(c))),
      ]);
      expect([c.name, agrees(c, r)]).toEqual([c.name, true]);
    }
  });

  it("refuses only the series that meet a clock time their zone skips, where the server puts that day elsewhere than the core", () => {
    const refused = PROOF_CASES.filter((c) => c.shape === null);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((c) => c.kind === "zoned" && c.name.includes("02:30"))).toBe(true);
    // Where such a series meets the skipped time, the two readings part: the reason no write makes it.
    const meeting = refused.filter((c) => c.name.includes("into summer time"));
    expect(meeting.map((c) => agrees(c, recorded.get(c.name)!))).toEqual(meeting.map(() => false));
  });

  it("proves at the bench's own server exactly the shapes every case of which agreed, and nothing at a place the proof was not run at", () => {
    // The row is the place's the record names, and no other CalDAV server's: iCloud's run is owed, and its record brings its own row.
    expect(bench.place).toBe(BENCH_CALDAV_PLACE);
    expect([...PROVEN_REPEATS[BENCH_CALDAV_PLACE]!].sort()).toEqual(provenBy(bench));
    expect(Object.keys(PROVEN_REPEATS).sort()).toEqual(
      [BENCH_CALDAV_PLACE, "google", "ics", "microsoft"].sort(),
    );
    expect([PROVEN_REPEATS.microsoft, PROVEN_REPEATS.ics]).toEqual([[], []]);
  });

  it("names at Google what Google's own recorded answers prove, and nothing while they are not recorded", () => {
    // The dispatcher's run (`google-repeat-proof.live.ts`) records them; the change that brings its file fills the row.
    const file = join(HERE, "support", "fixtures", "google", "repeat-proof.json");
    if (!existsSync(file)) {
      expect(PROVEN_REPEATS.google).toEqual([]);
      return;
    }
    const record = JSON.parse(readFileSync(file, "utf8")) as GoogleProofRecord;
    const zones = intlZones();
    const convert = (raw: unknown) => {
      const one = convertEvent(raw, zones, 0);
      return one.kind === "item" && one.item.kind === "upsert" ? one.item.event : null;
    };
    expect([...PROVEN_REPEATS.google].sort()).toEqual(
      provenByGoogle(record, (c) => bodyOf(c.draft, true), convert),
    );
  });
});
