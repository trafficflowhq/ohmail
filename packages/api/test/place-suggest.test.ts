import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@trafficflow/core";
import { makePlaceSuggester, placeRowsOf, readPlaceQuestion, type PlaceSuggester } from "@trafficflow/api/calendar";
import { boxAddress, collection, feature, loopback, placeBox, refusal, type PlaceBox } from "./_place-box.js";

/**
 * THE SUGGESTER, over the product's one door out, against a stand-in geocoder on this machine: the
 * rows it writes, what it sends and what it never sends, the states the geocoder's answers turn
 * into, and the three things it keeps in memory (the limits, the cache, the hold after a refusal),
 * each read on a clock the test drives.
 */

const open: PlaceBox[] = [];
afterEach(async () => { for (const b of open.splice(0)) await b.close(); });

async function rig(opts: { token?: string | null } = {}) {
  const box = await placeBox();
  open.push(box);
  let t = 1_000_000;
  const lines: string[] = [];
  const logger = createLogger({ service: "api", level: "debug", sink: (l) => { lines.push(l); } });
  const suggester: PlaceSuggester = makePlaceSuggester(
    { address: boxAddress(box), token: opts.token === undefined ? "box-bearer" : opts.token },
    { resolver: loopback, now: () => t },
  );
  const ask = (text: string, more: Record<string, unknown> = {}, account = "acct-1") =>
    suggester.suggest(account, readPlaceQuestion({ text, ...more }), { logger });
  return { box, lines, ask, suggester, tick: (ms: number) => { t += ms; } };
}

const ZURICH = feature({
  name: "Café Sprüngli", street: "Bahnhofstrasse", housenumber: "21", postcode: "8001", city: "Zürich",
  country: "Schweiz", countrycode: "CH", osm_key: "amenity", osm_value: "cafe", type: "house",
}, 8.5393, 47.3699);

/** One street's houses around the lake, in the geocoder's order: Germany, Switzerland, Austria, Germany, Switzerland. */
const BORDER = collection(
  feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "78224", city: "Singen", country: "Deutschland", countrycode: "DE", type: "house" }),
  feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "8200", city: "Schaffhausen", country: "Schweiz", countrycode: "CH", type: "house" }),
  feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "6900", city: "Bregenz", country: "Österreich", countrycode: "AT", type: "house" }),
  feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "79539", city: "Lörrach", country: "Deutschland", countrycode: "DE", type: "house" }),
  feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "4051", city: "Basel", country: "Schweiz", countrycode: "CH", type: "house" }),
);

describe("(1) a row from each kind of place", () => {
  // No line names a country: a row carries its country's code, and the field writes the name where it is not the person's own.
  it("writes the two lines a person reads, and the kind", () => {
    const rows = placeRowsOf(collection(
      ZURICH,
      feature({ street: "Seefeldstrasse", housenumber: "5", postcode: "8008", city: "Zürich", countrycode: "CH", osm_key: "building", osm_value: "yes", type: "house" }),
      feature({ name: "Limmatquai", postcode: "8001", city: "Zürich", countrycode: "CH", osm_key: "highway", osm_value: "pedestrian", type: "street" }),
      feature({ name: "Winterthur", state: "Zürich", country: "Schweiz", countrycode: "CH", osm_key: "place", osm_value: "city", type: "city" }),
      feature({ name: "Zürichsee", state: "Zürich", country: "Schweiz", countrycode: "CH", osm_key: "natural", osm_value: "water", type: "other" }),
    ), 8);
    expect(rows.map((r) => [r.kind, r.first, r.second, r.country])).toEqual([
      ["venue", "Café Sprüngli", "Bahnhofstrasse 21, 8001 Zürich", "CH"],
      ["address", "Seefeldstrasse 5", "8008 Zürich", "CH"],
      ["street", "Limmatquai", "8001 Zürich", "CH"],
      ["town", "Winterthur", "Zürich", "CH"],
      ["other", "Zürichsee", "Zürich", "CH"],
    ]);
    expect(rows[0]).toMatchObject({ lat: 47.3699, lon: 8.5393 });
  });

  it("writes a number before its street, and a town before its postcode, where the country's mail does", () => {
    const rows = placeRowsOf(collection(
      feature({ street: "Rue de Rivoli", housenumber: "99", postcode: "75001", city: "Paris", countrycode: "FR", type: "house" }),
      feature({ street: "Pennsylvania Avenue NW", housenumber: "1600", postcode: "20500", city: "Washington", countrycode: "US", type: "house" }),
    ), 8);
    expect(rows.map((r) => [r.first, r.second])).toEqual([
      ["99 Rue de Rivoli", "75001 Paris"],
      ["1600 Pennsylvania Avenue NW", "Washington 20500"],
    ]);
  });

  it("keeps a feature with fields missing as far as it can be read, and leaves out what cannot be one", () => {
    const rows = placeRowsOf(collection(
      // A venue with no address: its town stands for it.
      feature({ name: "Uetliberg", city: "Stallikon", country: "Schweiz", countrycode: "CH", type: "house" }),
      // No kind word at all, a number and a street: an address.
      feature({ street: "Hauptstrasse", housenumber: "7" }),
      // A country code that is no code is no country.
      feature({ name: "Somewhere", countrycode: "Narnia", type: "other" }),
      // Nothing a line could be written from.
      feature({ osm_key: "place", osm_value: "city", type: "city" }),
      // No point, and a point off the globe.
      { type: "Feature", properties: { name: "Nowhere", type: "city" } },
      feature({ name: "Off the map", type: "city" }, 200, 47),
      // Not a feature.
      "Langstrasse 1",
    ), 8);
    expect(rows.map((r) => [r.kind, r.first, r.second, r.country])).toEqual([
      ["venue", "Uetliberg", "Stallikon", "CH"],
      ["address", "Hauptstrasse 7", "", null],
      ["other", "Somewhere", "", null],
    ]);
    expect(placeRowsOf("not a collection", 8)).toEqual([]);
    expect(placeRowsOf({ type: "FeatureCollection", features: "none" }, 8)).toEqual([]);
  });

  it("writes a value without the marks that would turn its line's direction", () => {
    const rows = placeRowsOf(collection(
      feature({ name: "\u202Eilgnürps\u202C Café", street: "\u2067Bahnhofstrasse\u2069", housenumber: "1", city: "Zürich", countrycode: "CH", type: "house" }),
    ), 8);
    expect(rows.map((r) => [r.first, r.second])).toEqual([["ilgnürps Café", "Bahnhofstrasse 1, Zürich"]]);
  });

  it("folds two rows that read the same into one, and stops at the limit", () => {
    const twice = feature({ name: "Limmatquai", postcode: "8001", city: "Zürich", countrycode: "CH", type: "street" });
    const rows = placeRowsOf(collection(twice, twice, ZURICH, ZURICH), 8);
    expect(rows.map((r) => r.first)).toEqual(["Limmatquai", "Café Sprüngli"]);
    expect(placeRowsOf(collection(twice, ZURICH), 1).map((r) => r.first)).toEqual(["Limmatquai"]);
  });

  it("puts the rows in the town, district or postcode the person typed first, in the geocoder's order, before the cut", () => {
    const houses = collection(
      feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "8353", city: "Elgg", countrycode: "CH", type: "house" }),
      feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "8476", city: "Unterstammheim", countrycode: "CH", type: "house" }),
      feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "8001", city: "Zürich", district: "Altstadt", countrycode: "CH", type: "house" }),
      feature({ name: "Bahnhof Apotheke", street: "Bahnhofstrasse", housenumber: "1", postcode: "8001", city: "Zürich", countrycode: "CH", type: "house" }),
      feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "8050", city: "Zürich", district: "Oerlikon", countrycode: "CH", type: "house" }),
    );
    const where = (typed: string, limit = 8) => placeRowsOf(houses, limit, typed).map((r) => `${r.first} | ${r.second}`);
    const zurichFirst = [
      "Bahnhofstrasse 1 | 8001 Zürich", "Bahnhof Apotheke | Bahnhofstrasse 1, 8001 Zürich", "Bahnhofstrasse 1 | 8050 Zürich",
      "Bahnhofstrasse 1 | 8353 Elgg", "Bahnhofstrasse 1 | 8476 Unterstammheim",
    ];
    // However the town is written.
    for (const typed of ["bahnhofstrasse 1 zürich", "bahnhofstrasse 1 zurich", "bahnhofstrasse 1, zuerich"]) expect(where(typed), typed).toEqual(zurichFirst);
    // No town typed: the geocoder's order.
    expect(where("bahnhofstrasse 1")).toEqual([
      "Bahnhofstrasse 1 | 8353 Elgg", "Bahnhofstrasse 1 | 8476 Unterstammheim", "Bahnhofstrasse 1 | 8001 Zürich",
      "Bahnhof Apotheke | Bahnhofstrasse 1, 8001 Zürich", "Bahnhofstrasse 1 | 8050 Zürich",
    ]);
    // A postcode, and a district.
    expect(where("bahnhofstrasse 1 8476")[0]).toBe("Bahnhofstrasse 1 | 8476 Unterstammheim");
    expect(where("bahnhofstrasse 1 oerlikon")[0]).toBe("Bahnhofstrasse 1 | 8050 Zürich");
    // The re-rank comes before the cut to the field's limit.
    expect(where("bahnhofstrasse 1 zürich", 2)).toEqual(zurichFirst.slice(0, 2));
  });

  it("counts a town of several words when every word of it was typed, and never for one word of it", () => {
    const houses = collection(
      feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "8353", city: "Elgg", countrycode: "CH", type: "house" }),
      feature({ street: "Gallenweg", housenumber: "3", postcode: "8400", city: "Winterthur", countrycode: "CH", type: "house" }),
      feature({ street: "St. Gallerstrasse", housenumber: "1", postcode: "8400", city: "Winterthur", countrycode: "CH", type: "house" }),
      feature({ street: "Rue du Progrès", housenumber: "1", postcode: "2300", city: "La Chaux-de-Fonds", countrycode: "CH", type: "house" }),
      feature({ street: "Bahnhofstrasse", housenumber: "1", postcode: "9000", city: "St. Gallen", countrycode: "CH", type: "house" }),
    );
    const first = (typed: string) => placeRowsOf(houses, 8, typed)[0]!.second;
    // Typed whole, with its dot or without.
    expect(first("bahnhofstrasse 1 st. gallen")).toBe("9000 St. Gallen");
    expect(first("bahnhofstrasse 1 st gallen")).toBe("9000 St. Gallen");
    expect(first("rue du progrès 1 la chaux-de-fonds")).toBe("2300 La Chaux-de-Fonds");
    // A street named after a part of a town's name, or one word of it, pulls none of its rows up: the geocoder's order.
    for (const typed of ["gallenweg 3", "st. gallerstrasse 1", "chaux 1"]) expect(first(typed), typed).toBe("8353 Elgg");
  });

  it("puts the rows of the person's own country next, each group in the geocoder's order, and leaves no row out for its country", () => {
    const where = (home?: string) => placeRowsOf(BORDER, 8, "bahnhofstrasse 1 bregenz", home).map((r) => `${r.second} ${r.country}`);
    // The town typed first, whatever its country; then the person's own; then the rest.
    expect(where("CH")).toEqual(["6900 Bregenz AT", "8200 Schaffhausen CH", "4051 Basel CH", "78224 Singen DE", "79539 Lörrach DE"]);
    expect(where("DE")).toEqual(["6900 Bregenz AT", "78224 Singen DE", "79539 Lörrach DE", "8200 Schaffhausen CH", "4051 Basel CH"]);
    // No home: the geocoder's order after the town typed, and every row still carries its country's code.
    expect(where()).toEqual(["6900 Bregenz AT", "78224 Singen DE", "8200 Schaffhausen CH", "79539 Lörrach DE", "4051 Basel CH"]);
    // Two towns of one name in two countries stay two rows, though their lines name neither country.
    const twins = collection(
      feature({ name: "Laufenburg", country: "Schweiz", countrycode: "CH", osm_key: "place", osm_value: "town", type: "city" }),
      feature({ name: "Laufenburg", country: "Deutschland", countrycode: "DE", osm_key: "place", osm_value: "town", type: "city" }),
    );
    expect(placeRowsOf(twins, 8, "laufenburg", "DE").map((r) => [r.first, r.second, r.country])).toEqual([
      ["Laufenburg", "", "DE"], ["Laufenburg", "", "CH"],
    ]);
  });
});

describe("(2) nothing of the person goes out", () => {
  it("asks for the text made plain, the language, the limit and the region rounded, with the bearer and our name only", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 200, body: collection(ZURICH) }));
    const answer = await r.ask("  Café   SPRÜNGLI\tZürich ", { lang: "de", limit: 6, near: { lat: 47.37689, lon: 8.54169 } });
    expect(answer).toMatchObject({ state: "ok", credit: "osm" });
    expect(answer.places.map((p) => p.first)).toEqual(["Café Sprüngli"]);
    expect(r.box.asked).toHaveLength(1);
    const [asked] = r.box.asked;
    expect(asked!.method).toBe("GET");
    expect(asked!.path).toBe("/api");
    // The limit asked is the field's and six more: the folding of equal rows and the town typed choose from them.
    expect(asked!.query).toEqual({ q: "café sprüngli zürich", lang: "de", limit: "12", lat: "47.4", lon: "8.5" });
    expect(Object.keys(asked!.headers).sort()).toEqual(["accept", "accept-encoding", "authorization", "connection", "host", "user-agent"]);
    expect(asked!.headers).toMatchObject({
      authorization: "Bearer box-bearer", "user-agent": "ohmail-Places/1.0", accept: "application/json",
      "accept-encoding": "identity", host: `localhost:${r.box.port}`,
    });
    expect(asked!.body).toBe("");
  });

  it("rounds a region on every side of the globe before it leaves, and sends none when it is not given", async () => {
    const r = await rig();
    // A second apart: one account is asked for once in any second.
    await r.ask("sydney opera", { near: { lat: -33.85678, lon: 151.21529 } });
    r.tick(1_000);
    await r.ask("north cape", { near: { lat: 71.17089, lon: -25.78302 } });
    r.tick(1_000);
    await r.ask("anywhere at all");
    expect(r.box.asked.map((a) => [a.query.lat, a.query.lon])).toEqual([["-33.9", "151.2"], ["71.2", "-25.8"], [undefined, undefined]]);
  });

  it("sends no Authorization line where the geocoder is one's own and has no bearer", async () => {
    const r = await rig({ token: null });
    await r.ask("bahnhofstrasse");
    expect(Object.keys(r.box.asked[0]!.headers)).not.toContain("authorization");
  });
});

describe("(5) the geocoder's answers", () => {
  it("a 503 of the share is busy, and nothing is asked again inside the second it names", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 503, body: refusal("busy_share", "over the share"), headers: { "retry-after": "1" } }));
    expect((await r.ask("bahnhofstrasse")).state).toBe("busy");
    r.tick(999);
    expect(await r.ask("seefeldstrasse")).toEqual({ state: "busy", places: [], credit: null });
    expect(r.box.asked).toHaveLength(1);
    r.tick(1);
    r.box.answer(() => ({ status: 200, body: collection(ZURICH) }));
    expect((await r.ask("seefeldstrasse")).state).toBe("ok");
    expect(r.box.asked).toHaveLength(2);
  });

  it("a 503 of a rebuild is down, and nothing is asked for the thirty seconds it names", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 503, body: refusal("dial", "index rebuilding"), headers: { "retry-after": "30" } }));
    expect((await r.ask("bahnhofstrasse")).state).toBe("down");
    r.tick(29_999);
    expect((await r.ask("limmatquai")).state).toBe("down");
    expect(r.box.asked).toHaveLength(1);
    r.tick(1);
    r.box.answer(() => ({ status: 200, body: collection() }));
    expect(await r.ask("limmatquai")).toEqual({ state: "ok", places: [], credit: "osm" });
    expect(r.box.asked).toHaveLength(2);
  });

  it("a Retry-After is honoured within 1 to 60 s, and one that is no number of seconds is the state's own", async () => {
    // The geocoder's word, its Retry-After, how long the program then holds, and the state it answers meanwhile.
    const held: [string, string, number, "busy" | "down"][] = [
      ["busy_share", "3600", 60_000, "busy"], ["dial", "3600", 60_000, "down"],
      ["busy_share", "0", 1_000, "busy"], ["dial", "0", 1_000, "down"],
      ["busy_share", "-5", 1_000, "busy"], ["dial", "-5", 30_000, "down"],
      ["busy_share", "Wed, 21 Oct 2026 07:28:00 GMT", 1_000, "busy"], ["dial", "Wed, 21 Oct 2026 07:28:00 GMT", 30_000, "down"],
    ];
    for (const [word, after, ms, state] of held) {
      const r = await rig();
      r.box.answer(() => ({ status: 503, body: refusal(word, "held"), headers: { "retry-after": after } }));
      expect((await r.ask("bahnhofstrasse")).state).toBe(state);
      r.tick(ms - 1);
      expect((await r.ask("seefeldstrasse")).state, `${word} ${after}`).toBe(state);
      expect(r.box.asked, `${word} ${after}`).toHaveLength(1);
      r.tick(1);
      r.box.answer(() => ({ status: 200, body: collection() }));
      expect((await r.ask("seefeldstrasse")).state, `${word} ${after}`).toBe("ok");
      expect(r.box.asked).toHaveLength(2);
    }
  });

  it("a geocoder that does not answer in 2 s is down, the request given up, and asked nothing for 5 s", async () => {
    const r = await rig();
    r.box.answer(() => "hold");
    const started = Date.now();
    expect((await r.ask("bahnhofstrasse")).state).toBe("down");
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(4_000);
    await expect.poll(() => r.box.asked[0]!.gaveUpAt).not.toBeNull();
    r.tick(4_999);
    expect((await r.ask("seefeldstrasse")).state).toBe("down");
    expect(r.box.asked).toHaveLength(1);
    r.tick(1);
    r.box.answer(() => ({ status: 200, body: collection() }));
    expect((await r.ask("seefeldstrasse")).state).toBe("ok");
  }, 10_000);

  it("a 502 and a 504 are down for 5 s", async () => {
    for (const status of [502, 504]) {
      const r = await rig();
      r.box.answer(() => ({ status }));
      expect((await r.ask("bahnhofstrasse")).state).toBe("down");
      r.tick(4_999);
      expect((await r.ask("bahnhofstrasse")).state).toBe("down");
      expect(r.box.asked).toHaveLength(1);
    }
  });

  it("a 400 is an empty ok and one line for us, naming only a word the geocoder documents and never what it echoed", async () => {
    const r = await rig();
    r.box.answer((a) => ({ status: 400, body: refusal("bad_param", `no results for ${a.query.q}`) }));
    expect(await r.ask("Pestalozzistrasse 41b")).toEqual({ state: "ok", places: [], credit: null });
    const said = r.lines.filter((l) => l.includes("places_question_refused"));
    expect(said).toHaveLength(1);
    expect(JSON.parse(said[0]!)).toMatchObject({ refusal: "unknown", level: "warn" });
    expect(r.lines.join("\n").toLowerCase()).not.toContain("pestalozzi");
    // Not held: the next question, another account's in the same moment, is asked.
    r.box.answer(() => ({ status: 200, body: collection() }));
    expect((await r.ask("Seefeldstrasse", {}, "acct-2")).state).toBe("ok");
    expect(r.box.asked).toHaveLength(2);
  });

  it("a 400 whose word is the person's own one-word question writes no line holding it", async () => {
    const r = await rig();
    r.box.answer((a) => ({ status: 400, body: refusal(a.query.q!, "bad parameter") }));
    expect((await r.ask("Pestalozzistrasse")).state).toBe("ok");
    expect(r.lines.join("\n").toLowerCase()).not.toContain("pestalozzistrasse");
  });

  it("a 403 is down for 5 s, as a refusal of one question; only a 401 turns the suggestions off", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 403, body: refusal("forbidden", "refused") }));
    expect((await r.ask("bahnhofstrasse")).state).toBe("down");
    r.tick(4_999);
    expect((await r.ask("seefeldstrasse")).state).toBe("down");
    expect(r.box.asked).toHaveLength(1);
    r.tick(1);
    r.box.answer(() => ({ status: 200, body: collection() }));
    expect((await r.ask("seefeldstrasse")).state).toBe("ok");
    expect(r.lines.filter((l) => l.includes("places_settings_refused"))).toHaveLength(0);
  });

  it("a later answer never shortens a hold an earlier one asked for", async () => {
    const r = await rig();
    // Two questions out at once: a rebuild's thirty seconds come back first, a busy second after them.
    r.box.answer(() => (r.box.asked.length === 1
      ? { status: 503, body: refusal("dial", "rebuilding"), headers: { "retry-after": "30" }, delayMs: 100 }
      : { status: 503, body: refusal("busy_share", "over"), headers: { "retry-after": "1" }, delayMs: 400 }));
    await Promise.all([r.ask("erste frage"), r.ask("zweite frage", {}, "acct-2")]);
    r.tick(2_000);
    expect((await r.ask("dritte frage", {}, "acct-3")).state).toBe("down");
    expect(r.box.asked).toHaveLength(2);
    r.tick(28_000);
    r.box.answer(() => ({ status: 200, body: collection() }));
    expect((await r.ask("dritte frage", {}, "acct-3")).state).toBe("ok");
  });

  it("a 401 is off until the server is built again, said in one line", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 401, body: refusal("unauthorized", "bad bearer") }));
    expect(await r.ask("bahnhofstrasse")).toEqual({ state: "off", places: [], credit: null });
    r.tick(3_600_000);
    expect((await r.ask("seefeldstrasse")).state).toBe("off");
    expect(r.box.asked).toHaveLength(1);
    expect(r.lines.filter((l) => l.includes("places_settings_refused"))).toHaveLength(1);
    // A suggester built again, as a new program would build it, asks again.
    const again = makePlaceSuggester({ address: boxAddress(r.box), token: "box-bearer" }, { resolver: loopback });
    r.box.answer(() => ({ status: 200, body: collection() }));
    expect((await again.suggest("acct-1", readPlaceQuestion({ text: "seefeldstrasse" }))).state).toBe("ok");
  });

  it("an answer that is no collection is down, and so is a geocoder that is not there", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 200, body: "<html>a proxy's page</html>" }));
    expect((await r.ask("bahnhofstrasse")).state).toBe("down");
    const gone = makePlaceSuggester(
      { address: { origin: "http://localhost:9", transport: "http-private" }, token: null },
      { resolver: loopback },
    );
    expect((await gone.suggest("acct-1", readPlaceQuestion({ text: "bahnhofstrasse" }))).state).toBe("down");
  });

  it("a plain http name that resolves to a public address is never asked: down, and nothing leaves", async () => {
    const box = await placeBox();
    open.push(box);
    const lines: string[] = [];
    const logger = createLogger({ service: "api", level: "debug", sink: (l) => { lines.push(l); } });
    const outside = makePlaceSuggester(
      { address: boxAddress(box), token: "box-bearer" },
      { resolver: { resolve: async () => ["203.0.113.9"] } },
    );
    expect((await outside.suggest("acct-1", readPlaceQuestion({ text: "bahnhofstrasse" }), { logger })).state).toBe("down");
    expect(box.asked).toHaveLength(0);
    // Refused before any dial: a dial that started and failed would say `connection` or `timeout`.
    expect(lines.map((l) => JSON.parse(l).why)).toEqual(["not_private"]);
  });

  it("a question the person gave up ends the call and holds nothing", async () => {
    const r = await rig();
    r.box.answer(() => "hold");
    const leave = new AbortController();
    const pending = r.suggester.suggest("acct-1", readPlaceQuestion({ text: "bahnhofstrasse" }), { signal: leave.signal });
    await expect.poll(() => r.box.asked.length).toBe(1);
    leave.abort();
    expect((await pending).state).toBe("down");
    await expect.poll(() => r.box.asked[0]!.gaveUpAt).not.toBeNull();
    r.box.answer(() => ({ status: 200, body: collection() }));
    // Nothing held: another account is asked in the same moment. Nothing kept: the question, a second later, is asked again.
    expect((await r.ask("bahnhofstrasse", {}, "acct-2")).state).toBe("ok");
    r.tick(1_000);
    expect((await r.ask("bahnhofstrasse")).state).toBe("ok");
    expect(r.box.asked).toHaveLength(3);
  });
});

describe("(6) the limits", () => {
  it("the eleventh question of one account inside a second is busy and asks nothing; another account is answered", async () => {
    const r = await rig();
    // Every question counts against its account, an answer from the cache too.
    for (let i = 0; i < 10; i++) expect((await r.ask("zürich hb")).state).toBe("ok");
    expect(r.box.asked).toHaveLength(1);
    expect(await r.ask("bern bahnhof")).toEqual({ state: "busy", places: [], credit: null });
    expect(r.box.asked).toHaveLength(1);
    expect((await r.ask("bern bahnhof", {}, "acct-2")).state).toBe("ok");
    expect(r.box.asked).toHaveLength(2);
    // Five a second come back (answers from the cache: the program's own cap is not what is read here).
    r.tick(1_000);
    for (let i = 0; i < 5; i++) expect((await r.ask("zürich hb")).state).toBe("ok");
    expect((await r.ask("zürich hb")).state).toBe("busy");
  });

  it("sixty questions of one account in a minute, and no more", async () => {
    const r = await rig();
    let ok = 0;
    // One question again and again: an answer from the cache counts as a call does.
    for (let i = 0; i < 65; i++) {
      if ((await r.ask("bahnhofstrasse")).state === "ok") ok++;
      r.tick(200);
    }
    expect(ok).toBe(60);
    expect(r.box.asked).toHaveLength(1);
    r.tick(60_000);
    expect((await r.ask("a new minute")).state).toBe("ok");
  });

  it("one account is asked for once in any second, an answer from memory free: three new texts are one answer and two busy, and another account's in that second is answered", async () => {
    const r = await rig();
    const states: string[] = [];
    for (const text of ["bahnhofstrasse", "seefeldstrasse", "limmatquai"]) states.push((await r.ask(text)).state);
    expect(states).toEqual(["ok", "busy", "busy"]);
    expect((await r.ask("bahnhofstrasse")).state).toBe("ok");
    expect((await r.ask("rämistrasse", {}, "acct-2")).state).toBe("ok");
    expect(r.box.asked.map((a) => a.query.q)).toEqual(["bahnhofstrasse", "rämistrasse"]);
    // The review's walk: three new texts every second for a minute never hold the other account's question.
    let otherBusy = 0;
    for (let s = 1; s < 60; s++) {
      r.tick(1_000);
      for (const k of ["a", "b", "c"]) await r.ask(`heavy ${s} ${k}`);
      if ((await r.ask(`other ${s}`, {}, "acct-2")).state === "busy") otherBusy++;
    }
    expect(otherBusy).toBe(0);
  });

  it("the whole server asks the geocoder three times a second at most, what it can take", async () => {
    const r = await rig();
    for (let i = 0; i < 3; i++) expect((await r.ask(`street ${i}`, {}, `acct-${i}`)).state).toBe("ok");
    expect((await r.ask("street 3", {}, "acct-3")).state).toBe("busy");
    expect(r.box.asked).toHaveLength(3);
    r.tick(1_000);
    expect((await r.ask("street 3", {}, "acct-3")).state).toBe("ok");
  });
});

describe("(7) the cache", () => {
  it("the same question twice is one call, however it was spaced or written", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 200, body: collection(ZURICH) }));
    const first = await r.ask("Zürich HB", { lang: "de" });
    const second = await r.ask("  zürich   hb ", { lang: "de" });
    expect(second).toEqual(first);
    expect(r.box.asked).toHaveLength(1);
  });

  it("an answer is kept for the account that asked it: another account's same question is asked again", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 200, body: collection(ZURICH) }));
    await r.ask("zürich hb", { lang: "de" });
    await r.ask("zürich hb", { lang: "de" }, "acct-2");
    expect(r.box.asked).toHaveLength(2);
  });

  it("no account can tell whether another asked a question: one someone asked reads as one nobody asked", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 200, body: collection(feature({ name: "Beratungsstelle", street: "Musterweg", housenumber: "3", postcode: "8000", city: "Zürich", countrycode: "CH", type: "house" })) }));
    expect((await r.ask("beratungsstelle musterweg", { lang: "de" }, "acct-asked")).state).toBe("ok");
    r.tick(120_000);
    // Other accounts fill the program's second; then one account asks that question, and one nobody asked.
    let full = false;
    for (let i = 0; i < 20 && !full; i++) full = (await r.ask(`filler ${i}`, {}, `acct-filler-${i}`)).state === "busy";
    expect(full).toBe(true);
    const asked = await r.ask("beratungsstelle musterweg", { lang: "de" }, "acct-prober");
    const never = await r.ask("kinderarzt musterweg", { lang: "de" }, "acct-prober");
    expect(asked).toEqual(never);
  });

  it("the person's own country is part of the question: two homes, one text, each answered in its own order from its own kept answer", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 200, body: BORDER }));
    const order = async (account: string, home?: string) =>
      (await r.ask("bahnhofstrasse 1 bregenz", home === undefined ? {} : { home }, account)).places.map((p) => p.country);
    const swiss = ["AT", "CH", "CH", "DE", "DE"];
    const german = ["AT", "DE", "DE", "CH", "CH"];
    // Two accounts, two homes, one text: neither reads the other's order, asked or from memory.
    expect(await order("acct-ch", "CH")).toEqual(swiss);
    expect(await order("acct-de", "DE")).toEqual(german);
    expect(await order("acct-ch", "CH")).toEqual(swiss);
    expect(await order("acct-de", "DE")).toEqual(german);
    expect(r.box.asked).toHaveLength(2);
    // One account, another home: asked again and answered in that home's order; the first home's answer stays its own.
    r.tick(1_000);
    expect(await order("acct-ch", "DE")).toEqual(german);
    expect(await order("acct-ch", "CH")).toEqual(swiss);
    expect(r.box.asked).toHaveLength(3);
    // No home: another question again, in the geocoder's order after the town typed.
    r.tick(1_000);
    expect(await order("acct-ch")).toEqual(["AT", "DE", "CH", "DE", "CH"]);
    expect(r.box.asked).toHaveLength(4);
  });

  it("another region, language or limit is another question", async () => {
    const r = await rig();
    // A second apart: one account is asked for once in any second.
    await r.ask("zürich hb", { near: { lat: 47.37, lon: 8.54 } });
    r.tick(1_000);
    await r.ask("zürich hb", { near: { lat: 47.31, lon: 8.54 } });
    // The first region again once rounded: no call.
    await r.ask("zürich hb", { near: { lat: 47.41, lon: 8.53 } });
    r.tick(1_000);
    await r.ask("zürich hb", { lang: "fr" });
    r.tick(1_000);
    await r.ask("zürich hb", { limit: 3 });
    expect(r.box.asked.map((a) => [a.query.lat ?? "", a.query.lang ?? "", a.query.limit])).toEqual([
      ["47.4", "", "12"], ["47.3", "", "12"], ["", "fr", "12"], ["", "", "9"],
    ]);
  });

  it("is asked again ten minutes later", async () => {
    const r = await rig();
    await r.ask("zürich hb");
    r.tick(599_999);
    await r.ask("zürich hb");
    expect(r.box.asked).toHaveLength(1);
    r.tick(1);
    await r.ask("zürich hb");
    expect(r.box.asked).toHaveLength(2);
  });

  it("keeps five hundred questions, and lets the oldest go", async () => {
    const r = await rig();
    // Under the program's three calls a second.
    for (let i = 0; i <= 500; i++) {
      await r.ask(`place number ${i}`, {}, `acct-${i % 50}`);
      r.tick(400);
    }
    expect(r.box.asked).toHaveLength(501);
    await r.ask("place number 500", {}, "acct-0");
    expect(r.box.asked).toHaveLength(501);
    // A second on: the account's own last call was 400 ms ago.
    r.tick(1_000);
    await r.ask("place number 0", {}, "acct-0");
    expect(r.box.asked).toHaveLength(502);
  });

  it("keeps no answer that was not the geocoder's own", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 400, body: refusal("bad_param", "no") }));
    await r.ask("bahnhofstrasse");
    r.tick(1_000);
    r.box.answer(() => ({ status: 200, body: collection(ZURICH) }));
    expect((await r.ask("bahnhofstrasse")).places).toHaveLength(1);
    expect(r.box.asked).toHaveLength(2);
  });
});
