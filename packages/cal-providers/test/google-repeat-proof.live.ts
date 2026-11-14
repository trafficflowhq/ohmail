/**
 * THE REPEAT PROOF AT GOOGLE, live (MAP 3.8): the dispatcher's run at the Google test account, never
 * a lane's. Every case of `support/repeat-proof.ts` is written as the Google writer builds it
 * (`bodyOf`), through the bench's Google test client (`sendUpdates: "none"`, no invitee, the bench's
 * private marker on each), read back by Google's own `instances` over the case's window and by the
 * reader's converter of the series as Google keeps it, compared day by day, and removed.
 *
 *   OHCAL_TEST_ACCOUNTS_FILE=<the accounts file> [OHCAL_REPEAT_PROOF_RECORD=1] npx vitest run --config packages/cal-providers/vitest.live.config.ts packages/cal-providers/test/google-repeat-proof.live.ts
 *
 * Preconditions: Google's weekly test consent current; `cal-bench.live.ts google count` exits 0
 * before and after. With `OHCAL_REPEAT_PROOF_RECORD=1` the answers are kept, through the recorder's
 * check, as `support/fixtures/google/repeat-proof.json`; Google's proven row is filled only by the
 * change that brings that file. Prints statuses, counts and shapes only.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { intlZones } from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import { convertEvent } from "../src/google/convert.js";
import { bodyOf } from "../src/google/writer.js";
import { readCalendarTestAccounts } from "./support/calendar-test-accounts.ts";
import { GoogleTestClient, type GoogleJson } from "./support/google-test-client.ts";
import { assertClean } from "./support/recorder.ts";
import {
  PROOF_CASES,
  googleCoreDays,
  googleServerDays,
  sha256,
  type GoogleProofRecord,
  type GoogleRecordedCase,
} from "./support/repeat-proof.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ZONES = intlZones();
const say = (line: string): void => void process.stdout.write(`${line}\n`);
const convert = (raw: unknown) => {
  const one = convertEvent(raw, ZONES, Date.now());
  return one.kind === "item" && one.item.kind === "upsert" ? one.item.event : null;
};
const agreeing = (r: GoogleRecordedCase): boolean => {
  const c = PROOF_CASES.find((p) => p.name === r.name)!;
  return (
    r.insert === 200 &&
    r.status === 200 &&
    JSON.stringify(googleServerDays(c, r.days)) === JSON.stringify(googleCoreDays(c, r.master, convert))
  );
};

describe("the repeat proof at Google", () => {
  it(
    "writes each case as the Google writer builds it, reads Google's own days back, and compares them with the core's",
    { timeout: 900_000 },
    async () => {
      if (!process.env.OHCAL_TEST_ACCOUNTS_FILE) {
        say("google-repeat-proof: NOT ASKED (the accounts file's place is not named to this run)");
        return;
      }
      const g = new GoogleTestClient({
        accounts: readCalendarTestAccounts(process.env),
        benchId: `repeat-proof-${randomBytes(4).toString("hex")}`,
      });
      say(`google-repeat-proof: sign-in ${await g.signIn()}`);
      const calendar = await g.writableCalendar();
      const recorded: GoogleRecordedCase[] = [];
      const removed: number[] = [];
      for (const c of PROOF_CASES) {
        const body = bodyOf(c.draft, true);
        if (body === "field_unwritable") throw new Error(`the Google writer refuses the case ${c.name}`);
        const made = await g.insertEvent(calendar, body as GoogleJson, { sendUpdates: "none" });
        let master: GoogleRecordedCase["master"] = { start: null, end: null, recurrence: null };
        let days: { status: number; items: GoogleJson[] } = { status: 0, items: [] };
        if (made.status === 200) {
          const id = made.json.id as string;
          const kept = await g.getEvent(calendar, id);
          master = { start: kept.json.start, end: kept.json.end, recurrence: kept.json.recurrence };
          days = await g.instances(calendar, id, {
            timeMin: new Date(c.window.startMs).toISOString(),
            timeMax: new Date(c.window.endMs).toISOString(),
          });
          removed.push(await g.deleteEvent(calendar, id, { sendUpdates: "none" }));
        }
        recorded.push({
          name: c.name,
          shape: c.shape,
          written: sha256(JSON.stringify(body)),
          insert: made.status,
          status: days.status,
          master,
          days: days.items.map((i) => i.start),
        });
      }
      say(
        `google-repeat-proof: insert ${[...new Set(recorded.map((r) => r.insert))].join(",")} | instances ${[...new Set(recorded.map((r) => r.status))].join(",")} | removed ${removed.filter((s) => s === 204 || s === 200).length} of ${removed.length}`,
      );
      const shapes = [...new Set(PROOF_CASES.flatMap((p) => (p.shape === null ? [] : [p.shape])))].sort();
      for (const shape of shapes) {
        const cases = recorded.filter((r) => r.shape === shape);
        const against = cases.filter((r) => !agreeing(r)).map((r) => r.name);
        say(
          `google-repeat-proof: ${against.length === 0 ? "PROVEN" : "NOT PROVEN"} ${shape} (${cases.length} cases)${against.length > 0 ? `: not agreeing ${against.join("; ")}` : ""}`,
        );
      }
      expect(recorded.length).toBe(PROOF_CASES.length);
      if (process.env.OHCAL_REPEAT_PROOF_RECORD === "1") {
        const record: GoogleProofRecord = {
          server: "google",
          how: "each case inserted through the bench's Google test client (sendUpdates none, no invitee) as the Google writer's bodyOf builds it; the series read back by GET and its days by instances over the case's window; then deleted",
          cases: recorded,
        };
        const json = `${JSON.stringify(record, null, 2)}\n`;
        assertClean(json);
        const file = join(HERE, "support", "fixtures", "google", "repeat-proof.json");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, json);
        say(`google-repeat-proof: recorded ${recorded.length} cases`);
      }
    },
  );
});
