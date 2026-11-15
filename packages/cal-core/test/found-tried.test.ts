/**
 * The letters the look before landing and its recheck tried (corpus/tried.ts), each read whole and
 * held to the reading a person calls right. A row marked `owed` is read wrongly today: it is expected
 * to fail, and the fix that makes it pass removes its mark.
 */
import { describe, expect, it } from "vitest";
import { readFound } from "@ohmail/cal-core/found/rules";
import type { FoundReading } from "@ohmail/cal-core/found/types";
import { intlZones } from "@ohmail/cal-core/time/zones";
import { NOW, SENT } from "./corpus/letters.js";
import { TRIED, type Tried } from "./corpus/tried.js";
import { at } from "./support.js";

const zones = intlZones();
const two = (n: number): string => String(n).padStart(2, "0");

/** A reading in the words of corpus/tried.ts. */
function readingOf(r: FoundReading): string {
  const out: string[] = [];
  for (const f of r.findings) {
    const end = f.event.endGiven && f.event.end?.kind === "zoned" ? f.event.end.wall : null;
    out.push(`${f.level} ${f.key}${end === null ? "" : `-${two(end.hour)}:${two(end.minute)}`}`);
  }
  for (const n of r.notOffered) out.push(`not ${n.why}`);
  if (r.askable.length > 0) out.push(`asked ${r.askable.length}`);
  return out.length > 0 ? out.join(" | ") : "nothing";
}

const read = (row: Tried): FoundReading =>
  readFound(
    {
      subject: row.subject ?? "",
      body: row.body,
      sentAt: { kind: "instant", epochMs: at(SENT) },
      language: row.language,
      place: row.place ?? "ohbox",
    },
    { zone: "Europe/Zurich", now: { kind: "instant", epochMs: at(NOW) }, zones },
  );

describe("the letters the look and its recheck tried", () => {
  for (const row of TRIED) {
    const title = `${row.owed === undefined ? "" : `owed (${row.owed}): `}${row.language ?? "any"}: ${row.body.slice(0, 90)}`;
    (row.owed === undefined ? it : it.fails)(title, () => {
      expect(readingOf(read(row))).toBe(row.right);
    });
  }

  it("holds every letter once", () => {
    const keys = TRIED.map((t) => JSON.stringify([t.language, t.subject, t.place, t.body]));
    expect(new Set(keys).size).toBe(TRIED.length);
  });
});
