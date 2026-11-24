import { createApp } from "@trafficflow/api";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { MANAGED_ENV, PLAIN_ENV, PROCESS_DOOR, env, fixture, functionDoor, functionInput, processInput, recordingLogger } from "./_envs.js";

/**
 * Both services offer map suggestions beside the calendar when the operator names a geocoder.
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
const refusalOf = (extra: Record<string, string>, base = MANAGED_ENV): string => {
  try {
    loadSettings(env(base, extra), base === PLAIN_ENV ? PROCESS_DOOR : functionDoor());
  } catch (err) {
    return (err as Error).message;
  }
  return "";
};

const BEARER = fixture("places", "bearer", "of", "the", "geocoder");
const CALENDAR = { OHMAIL_CALENDAR: "1" };
const PUBLIC_PHOTON = "https://photon.komoot.io";

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

  it.each([
    { geocoder: "public Photon", address: PUBLIC_PHOTON, hostname: "photon.komoot.io", token: null },
    { geocoder: "its own keyed geocoder", address: "https://places.example.com", hostname: "places.example.com", token: BEARER },
  ])("a self-hosted server offers suggestions from $geocoder", async ({ address, hostname, token }) => {
    const p = plain({ ...CALENDAR, PLACES_SUGGEST_URL: address, ...(token ? { PLACES_SUGGEST_TOKEN: token } : {}) });
    expect(p.settings.managed).toBe(false);
    expect(p.settings.places).toEqual({ address: { origin: address, hostname, transport: "https" }, token });
    expect(p.services.places).toBeDefined();

    const req = new Request("https://mail.example.com/hello");
    const deps = p.buildDeps(req);
    // Stand in for the setup-state database read while serving the real /hello route.
    const res = await createApp(p.chosen.routes).handle(req, { ...deps, hello: { ...deps.hello!, needsSetup: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ flavor: "selfhost", features: { placeSuggestions: true } });
  });

  it("the managed service offers suggestions from a private HTTP geocoder without a bearer", async () => {
    const p = managed({ ...CALENDAR, PLACES_SUGGEST_URL: "http://photon:2322" });
    expect(p.settings.places).toEqual({
      address: { origin: "http://photon:2322", hostname: "photon", transport: "http-private" },
      token: null,
    });
    expect(p.services.places).toBeDefined();
    expect((await helloOf(p)).features.placeSuggestions).toBe(true);
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
    const publicHttpAddress = "http://203.0.113.9:2322";
    for (const raw of ["http://places.example.com", publicHttpAddress, "https://places.example.com/photon", "https://u:p@places.example.com", "ftp://places.example.com", "places"]) {
      const extra = { PLACES_SUGGEST_URL: raw };
      const said = refusalOf(extra);
      expect(said, raw).toContain("PLACES_SUGGEST_URL");
      expect(said, raw).not.toContain("places.example.com");
      expect(said, raw).not.toContain("203.0.113.9");
      if (raw === publicHttpAddress) {
        const plainRefusal = refusalOf(extra, PLAIN_ENV);
        expect(plainRefusal).toContain("PLACES_SUGGEST_URL");
        expect(plainRefusal).not.toContain("203.0.113.9");
      }
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
