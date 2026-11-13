/**
 * WHICH WAYS ARE OFFERED, AND WHICH STEP STANDS: the server's list is the only list, a failure reads as none, and an
 * address can never reach a step for a way that is not offered.
 */
import { describe, expect, it } from "vitest";
import {
  offeredWays,
  stepOf,
  waysSaid,
  type CalendarSetupPort,
  type CalendarWay,
  type SteppedWay,
} from "../../../src/calendar/setup/index.js";

const taken = async () => ({ kind: "taken" as const });
function port(ways: () => Promise<readonly CalendarWay[]>, connect: CalendarSetupPort["connect"] = taken) {
  return {
    ways,
    connect,
    signInAgain: "none",
    remove: "none",
    check: "none",
    setCalendar: "none",
    saveSettings: "none",
  } satisfies CalendarSetupPort;
}

describe("the ways our server lists", () => {
  it("reads a failing, a throwing or a strange answer as no way at all", async () => {
    expect(await waysSaid(port(() => Promise.reject(new Error("offline"))))).toEqual([]);
    expect(
      await waysSaid(
        port(() => {
          throw new Error("no door");
        }),
      ),
    ).toEqual([]);
    expect(await waysSaid(port(async () => "icloud" as unknown as CalendarWay[]))).toEqual([]);
  });

  it("drops a word it does not know and keeps the server's order once", async () => {
    const said = await waysSaid(port(async () => ["ics", "exchange", "icloud", "ics"] as CalendarWay[]));
    expect(said).toEqual(["ics", "icloud"]);
  });

  it("offers only the ways this build has a step for, and none where connecting has no door", () => {
    const all: CalendarWay[] = ["google", "icloud", "microsoft", "caldav", "ics"];
    expect(
      offeredWays(
        all,
        port(async () => all),
      ),
    ).toEqual(["icloud", "caldav", "ics"]);
    expect(
      offeredWays(
        all,
        port(async () => all, "none"),
      ),
    ).toEqual([]);
    expect(
      offeredWays(
        [],
        port(async () => []),
      ),
    ).toEqual([]);
  });
});

describe("the step an address stands on", () => {
  const offered: readonly SteppedWay[] = ["icloud", "ics"];

  it("folds every step to the first one where the way is not offered", () => {
    expect(stepOf({ step: "signin", way: "google" }, offered)).toEqual({ step: "way" });
    expect(stepOf({ step: "signin", way: "caldav" }, offered)).toEqual({ step: "way" });
    expect(stepOf({ step: "signin", way: "icloud" }, [])).toEqual({ step: "way" });
    expect(stepOf({ step: "nowhere" }, offered)).toEqual({ step: "way" });
    expect(stepOf({}, offered)).toEqual({ step: "way" });
  });

  it("stands on a sign-in for an offered way, and again for a named connection", () => {
    expect(stepOf({ step: "signin", way: "icloud" }, offered)).toEqual({
      step: "signin",
      way: "icloud",
      again: null,
    });
    expect(stepOf({ step: "signin", way: "icloud", again: "c-1" }, offered)).toEqual({
      step: "signin",
      way: "icloud",
      again: "c-1",
    });
  });

  it("needs the connection's id for the steps after a sign-in", () => {
    expect(stepOf({ step: "calendars" }, offered)).toEqual({ step: "way" });
    expect(stepOf({ step: "calendars", connection: "c-1", way: "ics" }, offered)).toEqual({
      step: "calendars",
      way: "ics",
      connection: "c-1",
    });
    expect(stepOf({ step: "wait", connection: "c-1", way: "ics" }, offered)).toEqual({
      step: "wait",
      way: "ics",
      connection: "c-1",
    });
  });
});
