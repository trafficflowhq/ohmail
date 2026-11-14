import { afterEach, describe, expect, it } from "vitest";
import { calendarFeed } from "@trafficflow/services/calendar";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { MANAGED_ENV, PLAIN_ENV, PROCESS_DOOR, env, functionDoor, functionInput, processInput, recordingLogger } from "./_envs.js";

/**
 * THE CALENDAR IS KEPT ONLY WHERE THE OPERATOR SAYS SO (`OHMAIL_CALENDAR=1`), and then whole: the
 * feed is handed the calendar's port, its routes are mounted and `/hello` says so, all read from
 * one member of the service bag. Off — the default, and any other spelling — none of the three,
 * and `/hello` is the answer it always was.
 */

const open: Program[] = [];
afterEach(async () => { for (const p of open.splice(0)) await p.close(); });

const managed = (extra: Record<string, string> = {}): Program => {
  const p = buildProgram(loadSettings(env(MANAGED_ENV, extra), functionDoor()), functionInput(recordingLogger().logger));
  open.push(p);
  return p;
};
const plain = (extra: Record<string, string> = {}): Program => {
  const p = buildProgram(loadSettings(env(PLAIN_ENV, extra), PROCESS_DOOR), processInput(recordingLogger().logger));
  open.push(p);
  return p;
};
const ask = (p: Program, path: string): Promise<Response> => p.dispatch(new Request(`https://api.ohmail.app${path}`));
const helloOf = async (p: Program): Promise<{ features: Record<string, unknown> }> => (await ask(p, "/hello")).json() as never;

describe("OHMAIL_CALENDAR", () => {
  it("is off by default and on any spelling but 1, on either service", () => {
    for (const extra of [{}, { OHMAIL_CALENDAR: "true" }, { OHMAIL_CALENDAR: "0" }, { OHMAIL_CALENDAR: "yes" }]) {
      expect(loadSettings(env(MANAGED_ENV, extra), functionDoor()).calendar.enabled, JSON.stringify(extra)).toBe(false);
    }
    expect(loadSettings(env(MANAGED_ENV, { OHMAIL_CALENDAR: "1" }), functionDoor()).calendar.enabled).toBe(true);
    expect(loadSettings(env(PLAIN_ENV, { OHMAIL_CALENDAR: " 1 " }), PROCESS_DOOR).calendar.enabled).toBe(true);
  });

  it("off: no port in the bag, no calendar route, and /hello says nothing of a calendar", async () => {
    for (const p of [managed(), plain()]) {
      expect(p.services.calendar).toBeUndefined();
      expect(p.buildDeps(new Request("https://api.ohmail.app/hello")).hello!.features).not.toHaveProperty("calendar");
      expect((await ask(p, "/calendar/settings")).status).toBe(404);
    }
    expect(Object.keys((await helloOf(managed())).features)).not.toContain("calendar");
  });

  it("on: the port in the bag, the routes mounted behind a session, and /hello says calendar", async () => {
    for (const p of [managed({ OHMAIL_CALENDAR: "1" }), plain({ OHMAIL_CALENDAR: "1" })]) {
      expect(p.services.calendar).toBe(calendarFeed);
      expect(p.buildDeps(new Request("https://api.ohmail.app/hello")).hello!.features.calendar).toBe(true);
      // Mounted: refused for want of a session, not for want of a route.
      expect((await ask(p, "/calendar/settings")).status).toBe(401);
    }
    const on = await helloOf(managed({ OHMAIL_CALENDAR: "1" }));
    const off = await helloOf(managed());
    expect(on.features.calendar).toBe(true);
    const { calendar: _word, ...rest } = on.features;
    expect(rest).toEqual(off.features);
  });
});
