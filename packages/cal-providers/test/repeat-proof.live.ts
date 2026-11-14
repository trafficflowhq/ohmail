/**
 * THE REPEAT PROOF AT A CALDAV SERVER, live (MAP 3.8): every case of `support/repeat-proof.ts` is
 * written as the CalDAV writer writes a new series, read back by the server's own expansion, and
 * compared day by day with the calendar core's. Each case stands alone in a calendar made for the
 * run, and the run removes what it made: the case, then the calendar.
 *
 *   OHCAL_CAL_BENCH_ENV_FILE=<the bench's file> npx vitest run --config packages/cal-providers/vitest.live.config.ts packages/cal-providers/test/repeat-proof.live.ts
 *
 * The bench's own server by default. iCloud is the dispatcher's run alone, with the accounts file's
 * place and `OHCAL_REPEAT_PROOF_AT=icloud`; the CalDAV test client refuses any invitee or organizer
 * line there, and the cases carry none. With `OHCAL_REPEAT_PROOF_RECORD=1` the answers are kept as
 * `support/fixtures/<server>/repeat-proof.json`, through the recorder's own check, and a shape joins
 * the provider's proven list only by the change that brings that file.
 *
 * Prints statuses, counts, shapes and the cases' own invented names; never an address or a password.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { proofPlaceOf } from "../src/repeat-shapes.js";
import { CalDavTestClient } from "./support/caldav-test-client.ts";
import { readCalBenchEnv, readCalendarTestAccounts, Secret } from "./support/calendar-test-accounts.ts";
import { assertClean } from "./support/recorder.ts";
import {
  PROOF_CASES,
  agrees,
  caseText,
  provenBy,
  serverStartLines,
  sha256,
  uidOf,
  utcText,
  type ProofRecord,
  type RecordedCase,
} from "./support/repeat-proof.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const say = (line: string): void => void process.stdout.write(`${line}\n`);

/** The server's client, and its place as a connection to it names it (the record's row is that place's alone). */
function client(at: "bench" | "icloud"): { readonly c: CalDavTestClient; readonly place: string } | null {
  if (at === "icloud") {
    if (!process.env.OHCAL_TEST_ACCOUNTS_FILE) return null;
    const a = readCalendarTestAccounts(process.env);
    const baseUrl = "https://caldav.icloud.com/";
    return {
      c: new CalDavTestClient({ baseUrl, user: a.ICLOUD_APPLE_ID, password: a.ICLOUD_APP_PASSWORD }),
      place: proofPlaceOf("caldav", baseUrl)!,
    };
  }
  if (!process.env.OHCAL_CAL_BENCH_ENV_FILE && !process.env.OHCAL_CALDAV_BENCH_URL) return null;
  const env = readCalBenchEnv(process.env);
  if (!env.OHCAL_CALDAV_BENCH_URL || !env.OHCAL_CALDAV_BENCH_USER || !env.OHCAL_CALDAV_BENCH_PASSWORD)
    throw new Error("the CalDAV bench is not named");
  const place = proofPlaceOf("caldav", env.OHCAL_CALDAV_BENCH_URL);
  if (place === null) throw new Error("the CalDAV bench's address names no place");
  return {
    c: new CalDavTestClient({
      baseUrl: env.OHCAL_CALDAV_BENCH_URL,
      user: new Secret(env.OHCAL_CALDAV_BENCH_USER),
      password: new Secret(env.OHCAL_CALDAV_BENCH_PASSWORD),
    }),
    place,
  };
}

describe("the repeat proof at a CalDAV server", () => {
  it(
    "writes each case as the writer writes it, reads the server's own days back, and compares them with the core's",
    { timeout: 600_000 },
    async () => {
      const at = process.env.OHCAL_REPEAT_PROOF_AT === "icloud" ? "icloud" : "bench";
      const asked = client(at);
      if (asked === null) {
        say(`repeat-proof ${at}: NOT ASKED (its place is not named to this run)`);
        return;
      }
      const { c, place } = asked;
      const d = await c.discover();
      const slug = `ohmail-repeat-proof-${randomBytes(4).toString("hex")}`;
      const made = await c.makeCalendar(d.home, slug, "ohmail repeat proof");
      say(`repeat-proof ${at}: discover ${d.status} | the run's calendar ${made.status}`);
      expect(made.status).toBe(201);
      const recorded: RecordedCase[] = [];
      const cleanup: number[] = [];
      try {
        for (const pc of PROOF_CASES) {
          const uid = uidOf(pc);
          const member = new URL(`${uid.replace("@", "-at-")}.ics`, made.href).href;
          const text = caseText(pc, uid);
          const put = await c.put(member, text, { onlyIfNew: true });
          const expanded = await c.expand(made.href, utcText(pc.window.startMs), utcText(pc.window.endMs));
          const own = expanded.objects.find((o) => new URL(o.href).pathname === new URL(member).pathname);
          const lines = own?.data === undefined ? null : serverStartLines(own.data);
          const kept = await c.get(member);
          const keptLines = [
            ...kept.text.replace(/\r?\n[ \t]/g, "").matchAll(/^(RRULE|DTSTART)[;:].*$/gm),
          ].map((m) => m[0].trimEnd());
          cleanup.push((await c.delete(member)).status);
          recorded.push({
            name: pc.name,
            shape: pc.shape,
            written: sha256(text),
            put: put.status,
            answered: lines === null ? "not answered" : "expand",
            status: expanded.status,
            server: lines ?? [],
            kept: keptLines,
          });
        }
      } finally {
        const removed = await c.delete(made.href);
        say(
          `repeat-proof ${at}: case members removed ${cleanup.filter((s) => s === 204 || s === 200).length} of ${cleanup.length} | the run's calendar removed ${removed.status}`,
        );
      }
      const record: ProofRecord = {
        server: at,
        place,
        how: "each case PUT (If-None-Match: *) as the CalDAV writer writes a new series, alone in a calendar of the run; the server's own expansion asked by a calendar-query with expand over the case's window; the stored object read back by GET",
        cases: recorded,
      };
      const proven = provenBy(record);
      for (const p of PROOF_CASES.filter((x) => x.shape === null)) {
        say(
          `repeat-proof ${at}: REFUSED BY THE WRITE PATH ${p.name}: ${
            agrees(
              p,
              recorded.find((r) => r.name === p.name)!,
            )
              ? "the readings agree"
              : "the readings do not agree"
          }`,
        );
      }
      for (const shape of [
        ...new Set(PROOF_CASES.flatMap((p) => (p.shape === null ? [] : [p.shape]))),
      ].sort()) {
        const cases = PROOF_CASES.filter((p) => p.shape === shape);
        const against = cases
          .filter(
            (p) =>
              !agrees(
                p,
                recorded.find((r) => r.name === p.name)!,
              ),
          )
          .map((p) => p.name);
        say(
          `repeat-proof ${at}: ${proven.includes(shape) ? "PROVEN" : "NOT PROVEN"} ${shape} (${cases.length} cases)${against.length > 0 ? `: not agreeing ${against.join("; ")}` : ""}`,
        );
      }
      say(
        `repeat-proof ${at}: PUT ${[...new Set(recorded.map((r) => r.put))].join(",")} | expand ${[...new Set(recorded.map((r) => r.status))].join(",")} | answered ${recorded.filter((r) => r.answered === "expand").length} of ${recorded.length} | proven ${proven.length} shapes`,
      );
      expect(recorded.length).toBe(PROOF_CASES.length);
      if (process.env.OHCAL_REPEAT_PROOF_RECORD === "1") {
        const json = `${JSON.stringify(record, null, 2)}\n`;
        assertClean(json);
        const file = join(HERE, "support", "fixtures", at, "repeat-proof.json");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, json);
        say(`repeat-proof ${at}: recorded ${recorded.length} cases`);
      }
    },
  );
});
