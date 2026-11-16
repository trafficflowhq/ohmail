import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { MANAGED_ENV, PLAIN_ENV, PROCESS_DOOR, env, fixture, functionDoor, functionInput, processInput, recordingLogger } from "./_envs.js";

/**
 * PLACE SUGGESTIONS ARE OFFERED ONLY WHERE THE OPERATOR NAMES A GEOCODER (`PLACES_SUGGEST_URL`,
 * with `PLACES_SUGGEST_TOKEN` where it wants a bearer), and only beside the calendar. Neither set:
 * no suggester in the bag, the route answers `off`, and `/hello` does not offer them, so an app
 * never asks. A half or malformed configuration refuses the start, naming the variables and never
 * a value.
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
/** `/hello` as a client reads it; on the managed service, whose answer asks no database. */
const helloOf = async (p: Program): Promise<{ features: Record<string, unknown> }> =>
  (await p.dispatch(new Request("https://api.ohmail.app/hello"))).json() as never;
/** The descriptor `/hello` answers from, on either service. */
const wordsOf = (p: Program): Record<string, unknown> =>
  p.buildDeps(new Request("https://api.ohmail.app/hello")).hello!.features as Record<string, unknown>;
const refusalOf = (extra: Record<string, string>, base = PLAIN_ENV): string => {
  try {
    loadSettings(env(base, extra), base === PLAIN_ENV ? PROCESS_DOOR : functionDoor());
  } catch (err) {
    return (err as Error).message;
  }
  return "";
};

const BEARER = fixture("places", "bearer", "of", "the", "geocoder");
const CALENDAR = { OHMAIL_CALENDAR: "1" };

describe("PLACES_SUGGEST_URL and PLACES_SUGGEST_TOKEN", () => {
  it("neither: off on both services; no suggester, and /hello does not offer them", async () => {
    expect((await helloOf(managed(CALENDAR))).features).not.toHaveProperty("placeSuggestions");
    for (const p of [managed(CALENDAR), plain(CALENDAR)]) {
      expect(p.settings.places).toBeNull();
      expect(p.services.places).toBeUndefined();
      expect(wordsOf(p)).not.toHaveProperty("placeSuggestions");
      // Mounted beside the calendar: refused for want of a session, not for want of a route.
      expect((await p.dispatch(new Request("https://api.ohmail.app/calendar/places/suggest", { method: "POST" }))).status).toBe(401);
    }
  });

  it("the address alone: suggestions without a bearer; /hello offers them where the calendar is kept", async () => {
    const p = plain({ ...CALENDAR, PLACES_SUGGEST_URL: "http://photon:2322" });
    expect(p.settings.places).toEqual({ address: { origin: "http://photon:2322", hostname: "photon", transport: "http-private" }, token: null });
    expect(p.services.places).toBeDefined();
    expect(wordsOf(p).placeSuggestions).toBe(true);
  });

  it("the address and its bearer, on the managed service", async () => {
    const p = managed({ ...CALENDAR, PLACES_SUGGEST_URL: "https://places.example.com", PLACES_SUGGEST_TOKEN: BEARER });
    expect(p.settings.places).toEqual({ address: { origin: "https://places.example.com", hostname: "places.example.com", transport: "https" }, token: BEARER });
    const on = await helloOf(p);
    expect(on.features.placeSuggestions).toBe(true);
    const { placeSuggestions: _word, ...rest } = on.features;
    expect(rest).toEqual((await helloOf(managed(CALENDAR))).features);
  });

  it("without the calendar nothing of them is built, mounted or said", async () => {
    const p = managed({ PLACES_SUGGEST_URL: "https://places.example.com", PLACES_SUGGEST_TOKEN: BEARER });
    expect(p.services.places).toBeUndefined();
    expect((await helloOf(p)).features).not.toHaveProperty("placeSuggestions");
    expect((await p.dispatch(new Request("https://api.ohmail.app/calendar/places/suggest", { method: "POST" }))).status).toBe(404);
  });

  it("a bearer without an address refuses the start, naming both and never the value", () => {
    const said = refusalOf({ PLACES_SUGGEST_TOKEN: BEARER });
    expect(said).toContain("PLACES_SUGGEST_TOKEN");
    expect(said).toContain("PLACES_SUGGEST_URL");
    expect(said).not.toContain(BEARER);
  });

  it("an address the rule refuses refuses the start, naming the variable and never the value", () => {
    for (const raw of ["http://places.example.com", "http://203.0.113.9:2322", "https://places.example.com/photon", "https://u:p@places.example.com", "ftp://places.example.com", "places"]) {
      const said = refusalOf({ PLACES_SUGGEST_URL: raw });
      expect(said, raw).toContain("PLACES_SUGGEST_URL");
      expect(said, raw).not.toContain("places.example.com");
      expect(said, raw).not.toContain("203.0.113.9");
    }
  });

  it("a bearer that cannot be one header line refuses the start, and is never repeated", () => {
    for (const bad of [`${BEARER} two`, `${BEARER}é`]) {
      const said = refusalOf({ PLACES_SUGGEST_URL: "https://places.example.com", PLACES_SUGGEST_TOKEN: bad }, MANAGED_ENV);
      expect(said).toContain("PLACES_SUGGEST_TOKEN");
      expect(said).not.toContain(BEARER);
    }
  });

  it("a blank value is no value: a set name with nothing in it is unset", () => {
    expect(loadSettings(env(PLAIN_ENV, { PLACES_SUGGEST_URL: "  ", PLACES_SUGGEST_TOKEN: "" }), PROCESS_DOOR).places).toBeNull();
  });
});
