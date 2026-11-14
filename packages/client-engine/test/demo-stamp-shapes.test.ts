/**
 * ═══ THE DEMO RENDERS THE PRODUCT'S OWN STAMP, ON WHATEVER DAY IT IS OPENED ═════════════════
 *
 * ── THE DEFECT, AND WHY NOTHING COULD SEE IT ────────────────────────────────────────────────
 *
 * Fixture rows used to carry a display string in `time`, and the adapter copied it straight onto
 * the materialized message. `messageStamp` returns `m.time` on its first line and stops — so over
 * the whole fixture world the row stamp's actual rule never ran. Not in the demo, not in a render
 * check, not anywhere.
 *
 * What that hid: three rows said "yesterday" and twenty were a bare weekday, which is the form the
 * product rendered before the stamp carried a time. The landing demo was therefore advertising a
 * shape the product no longer produces, and every guard was green, because the only thing any of
 * them could see was a string somebody typed.
 *
 * A literal could not have been made correct in any case. The fixtures have no clock of their own —
 * `parseFixtureTime` builds each instant relative to the REAL now — so a row that means "yesterday"
 * is a different weekday every day, and no fixed string names it. That is the argument for deriving
 * rather than for typing better strings.
 *
 * ── WHAT IS PINNED HERE ─────────────────────────────────────────────────────────────────────
 *
 * That every stamp the demo puts on screen is a form `messageStamp` can emit — asserted over the
 * booted demo world, at several "nows" spread across the week, so a shape that is only correct on
 * the day the suite happens to run cannot pass. The strings in `data.ts` are an instant spec now,
 * not display copy, and this is what holds the two apart.
 */
import { describe, expect, it } from "vitest";
import {
  OhmailEngine, messageDisplayTime, messagesIn, type EngineMessage,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/** The four bands `messageStamp` can emit, with the names taken from `Intl` and not retyped. */
const LOCALES = ["en", "de"] as const;
const namesOf = (opts: Intl.DateTimeFormatOptions, days: Date[]): string[] =>
  LOCALES.flatMap((l) =>
    days.map((d) => new Intl.DateTimeFormat(l, { ...opts, timeZone: "UTC" }).format(d)));
const A_WEEK = [...Array(7)].map((_, i) => new Date(Date.UTC(2026, 7, 2 + i)));
const A_YEAR = [...Array(12)].map((_, i) => new Date(Date.UTC(2026, i, 15)));
const esc = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DAY = `(${[...new Set(namesOf({ weekday: "short" }, A_WEEK))].map(esc).join("|")})`;
const MONTH = `(${[...new Set(namesOf({ month: "short" }, A_YEAR))].map(esc).join("|")})`;
const CLOCK = String.raw`\d{2}:\d{2}`;
const PRODUCIBLE = new RegExp(
  `^(${CLOCK}|${DAY} ${CLOCK}|\\d{1,2} ${MONTH}|\\d{1,2} ${MONTH} \\d{4})$`,
);

/** Seven "nows", so no assertion here can be true only on the weekday the suite happens to run. */
const NOWS = [...Array(7)].map((_, i) => new Date(Date.UTC(2026, 8, 6 + i, 13, 40, 0)));

async function demoMessages(now: Date): Promise<EngineMessage[]> {
  const engine = new OhmailEngine({ adapter: new FixturesAdapter({ now: () => now }), now: () => now });
  await engine.start();
  const r = engine.read();
  return ["INBOX", "ohmail/News", "ohmail/Receipts"].flatMap((f) => messagesIn(r, f as never));
}

describe("every stamp the demo shows is one the row stamp can produce", () => {
  it("the demo world has rows to check — a census over nothing would pass over nothing", async () => {
    const msgs = await demoMessages(NOWS[0]!);
    expect(msgs.length).toBeGreaterThan(25);
  });

  it("no fixture ships its own display string any more", async () => {
    /* The one-line change this file defends. A row carrying `time` short-circuits the rule, and it
       does it silently — the stamp still renders, it is simply not the product's. */
    const msgs = await demoMessages(NOWS[0]!);
    const carried = msgs.filter((m) => m.time).map((m) => `${m.id}=${m.time!}`);
    expect(carried, `${carried.join(", ")}: a fixture stamp is shadowing the derived one`).toEqual([]);
  });

  for (const [i, now] of NOWS.entries()) {
    const weekday = new Intl.DateTimeFormat("en", { weekday: "long", timeZone: "UTC" }).format(now);
    it(`renders only producible shapes when the demo is opened on a ${weekday}`, async () => {
      const msgs = await demoMessages(now);
      const bad: string[] = [];
      for (const m of msgs) {
        for (const locale of LOCALES) {
          const s = messageStampOf(m, now, locale);
          if (!PRODUCIBLE.test(s)) bad.push(`${m.id} (${locale}): ${JSON.stringify(s)}`);
        }
      }
      expect(bad, `${bad.join(", ")}: not a form the row stamp emits`).toEqual([]);
      void i;
    });
  }

  it("and the weekday band always carries its clock, in both languages", async () => {
    /* The band the change is about. Somewhere in a week of "nows" the demo always has rows one to
       six days old, and each of them must show a time — that is the thing that used to vanish at
       the reader's midnight. */
    let seen = 0;
    for (const now of NOWS) {
      for (const m of await demoMessages(now)) {
        for (const locale of LOCALES) {
          const s = messageStampOf(m, now, locale);
          if (!new RegExp(`^${DAY} `).test(s)) continue;
          seen += 1;
          expect(s).toMatch(new RegExp(`^${DAY} ${CLOCK}$`));
        }
      }
    }
    expect(seen, "no demo row landed in the weekday band on any day of the week")
      .toBeGreaterThan(20);
  });
});

function messageStampOf(m: EngineMessage, now: Date, locale: string): string {
  // Through the barrel's own name, so this measures what every surface calls.
  return messageDisplayTime(m, now, "UTC", locale);
}
