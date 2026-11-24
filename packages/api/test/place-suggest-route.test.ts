import { afterEach, describe, expect, it } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes, makePlaceSuggester } from "@trafficflow/api/calendar";
import type { AccessVerdict, EntitlementsPort } from "@trafficflow/db";
import type { PlaceSuggestAnswer } from "@ohmail/wire";
import { makeDeps, req, seedSession, FIXED_NOW } from "./helpers.js";
import { boxAddress, collection, feature, loopback, placeBox, type PlaceBox } from "./_place-box.js";

/**
 * `POST /calendar/places/suggest` THROUGH THE COMPOSED PIPELINE: a signed-in question reaches the
 * geocoder with nothing of the person's request on it, a malformed one is refused as a bad request
 * before anything is asked, and a well-formed one from an allowed account gets 200 with its state.
 * The pipeline refuses callers without a session and accounts denied by the entitlements port.
 */

const app = createApp([...apiRoutes, ...calendarRoutes]);
const open: PlaceBox[] = [];
afterEach(async () => { for (const b of open.splice(0)) await b.close(); });

async function rig(opts: { places?: boolean; entitlementsPort?: EntitlementsPort } = {}) {
  const { db, deps } = await makeDeps();
  const box = await placeBox();
  open.push(box);
  box.answer(() => ({ status: 200, body: collection(feature({ name: "Limmatquai", postcode: "8001", city: "Zürich", countrycode: "CH", type: "street" })) }));
  // The suggester's clock is the test's: a case reads what is asked, never how fast.
  let t = 1_000_000;
  deps.services = {
    ...deps.services!,
    ...(opts.places !== false ? {
      places: makePlaceSuggester({ address: boxAddress(box), token: "box-bearer" }, { resolver: loopback, now: () => t }),
    } : {}),
    ...(opts.entitlementsPort ? { entitlementsPort: opts.entitlementsPort } : {}),
  };
  const s = await seedSession(db, { now: FIXED_NOW });
  const ask = (body: unknown, headers: Record<string, string> = {}, bearer: string | null = s.token): Promise<Response> => app.handle(
    req("POST", "/calendar/places/suggest", {
      ...(bearer !== null ? { bearer } : {}),
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers,
    }),
    { ...deps, session: null, idempotency: null } as ApiDeps,
  );
  return { box, s, ask, tick: (ms: number) => { t += ms; } };
}

const read = async (res: Response): Promise<PlaceSuggestAnswer> => (await res.json()) as PlaceSuggestAnswer;
const codeOf = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code;

function portWith(verdict: AccessVerdict): EntitlementsPort {
  const access = async () => verdict;
  return {
    access,
    accessOrFault: access,
    spend: async (_account, _action, attempt) => ({ verdict: "ok", charged: true, attempt }),
    release: async () => "settled",
    manageLink: async () => null,
    releaseAccount: async () => "none",
  };
}

describe("subscription access for place suggestions", () => {
  it("an account that requires payment is refused before the geocoder is asked", async () => {
    const r = await rig({ entitlementsPort: portWith({ ok: false, reason: "payment_required" }) });
    const res = await r.ask({ text: "limmatquai" });
    expect(res.status).toBe(402);
    expect(await codeOf(res)).toBe("subscription_required");
    expect(r.box.asked).toHaveLength(0);
  });

  it("an account on a trial can ask the geocoder", async () => {
    const r = await rig({ entitlementsPort: portWith({
      ok: true,
      limits: { mailboxes: 5, storageBytes: null, canAddMailbox: true, aiEnabled: true },
      lifecycle: {
        state: "trialing", closedReason: null, trialEndsAt: "2026-09-30T20:00:00.000Z", graceUntil: null,
        closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: false,
      },
    }) });
    const res = await r.ask({ text: "limmatquai" });
    expect(res.status).toBe(200);
    expect(r.box.asked).toHaveLength(1);
  });
});

describe("(2) through the route, nothing of the person's request goes on to the geocoder", () => {
  it("no cookie, no address, no client name, no account: only the question, our name and the bearer", async () => {
    const r = await rig();
    const res = await r.ask({ text: "Limmatquai", lang: "de", near: { lat: 47.37216, lon: 8.54389 } }, {
      cookie: "tf_owner=someone; theme=dark", "x-forwarded-for": "203.0.113.7", "x-real-ip": "203.0.113.7",
      "user-agent": "Mozilla/5.0 (a person's own browser)", "x-ohmail-client": "web/1.0.12", "accept-language": "de-CH",
      referer: "https://ohmail.app/calendar/event/1", "x-request-id": "chosen-by-the-caller",
    });
    expect(res.status).toBe(200);
    expect(await read(res)).toMatchObject({ state: "ok", credit: "osm", places: [{ kind: "street", first: "Limmatquai", second: "8001 Zürich" }] });
    expect(r.box.asked).toHaveLength(1);
    const asked = r.box.asked[0]!;
    expect(asked.query).toEqual({ q: "limmatquai", lang: "de", limit: "12", lat: "47.4", lon: "8.5", zoom: "10", location_bias_scale: "0.2" });
    expect(Object.keys(asked.headers).sort()).toEqual(["accept", "accept-encoding", "authorization", "connection", "host", "user-agent"]);
    const everything = JSON.stringify(asked);
    for (const of_the_person of [r.s.accountId, r.s.userId, r.s.token, "203.0.113.7", "someone", "Mozilla", "web/1.0.12", "de-CH", "chosen-by-the-caller", "47.37216"]) {
      expect(everything).not.toContain(of_the_person);
    }
  });
});

describe("(8) the edges", () => {
  it("two characters are answered empty and ask nothing; three are asked", async () => {
    const r = await rig();
    const short = await r.ask({ text: " ab  " });
    expect(short.status).toBe(200);
    expect(await read(short)).toEqual({ state: "ok", places: [], credit: null });
    expect(r.box.asked).toHaveLength(0);
    expect((await r.ask({ text: "abc" })).status).toBe(200);
    expect(r.box.asked).toHaveLength(1);
  });

  it("200 characters are asked; 201 are refused as a bad request, and nothing is asked", async () => {
    const r = await rig();
    const ok = await r.ask({ text: ` ${"a".repeat(200)} ` });
    expect(ok.status).toBe(200);
    expect(r.box.asked[0]!.query.q).toBe("a".repeat(200));
    const over = await r.ask({ text: "b".repeat(201) });
    expect(over.status).toBe(400);
    expect(await codeOf(over)).toBe("validation_failed");
    expect(r.box.asked).toHaveLength(1);
    // 150 characters that are 300 once made plain (a capital İ is two in lower case): refused too.
    const grown = await r.ask({ text: "İ".repeat(150) });
    expect(grown.status).toBe(400);
    expect(r.box.asked).toHaveLength(1);
  });

  it("a limit of 0 or of 99 is refused; 1 and 8 are asked, and none is 6", async () => {
    const r = await rig();
    for (const limit of [0, 99, 2.5, -1, "6"]) {
      const res = await r.ask({ text: "limmatquai", limit });
      expect(res.status, `limit ${String(limit)}`).toBe(400);
    }
    expect(r.box.asked).toHaveLength(0);
    // A second apart: one account is asked for once in any second.
    expect((await r.ask({ text: "limmatquai", limit: 1 })).status).toBe(200);
    r.tick(1_000);
    expect((await r.ask({ text: "bahnhofstrasse", limit: 8 })).status).toBe(200);
    r.tick(1_000);
    // JSON's own nothing is no limit, as an absent one is.
    expect((await r.ask({ text: "seefeldstrasse", limit: null })).status).toBe(200);
    expect(r.box.asked.map((a) => a.query.limit)).toEqual(["7", "14", "12"]);
  });

  it("a language the geocoder does not have is asked with none; a region tag is read for its language", async () => {
    const r = await rig();
    expect((await r.ask({ text: "limmatquai", lang: "it" })).status).toBe(200);
    r.tick(1_000);
    expect((await r.ask({ text: "bahnhofstrasse", lang: "de-CH" })).status).toBe(200);
    r.tick(1_000);
    expect((await r.ask({ text: "seefeldstrasse", lang: "FR" })).status).toBe(200);
    expect(r.box.asked.map((a) => a.query.lang ?? null)).toEqual([null, "de", "fr"]);
    for (const lang of [42, "x".repeat(36), ["de"]]) {
      expect((await r.ask({ text: "limmatquai", lang })).status, JSON.stringify(lang)).toBe(400);
    }
  });

  it("a home of two capital letters is asked; one of three letters, of digits, in lower case or not a text is refused, and nothing is asked", async () => {
    const r = await rig();
    for (const home of ["CHE", "C", "", "41", "ch", "Ch", "ÄÖ", " CH", { code: "CH" }, ["CH"], 41, true]) {
      const res = await r.ask({ text: "limmatquai", home });
      expect(res.status, JSON.stringify(home)).toBe(400);
      expect(await codeOf(res)).toBe("validation_failed");
    }
    expect(r.box.asked).toHaveLength(0);
    expect((await r.ask({ text: "limmatquai", home: "CH" })).status).toBe(200);
    r.tick(1_000);
    // JSON's own nothing is no home, as an absent one is.
    expect((await r.ask({ text: "bahnhofstrasse", home: null })).status).toBe(200);
    // The home orders the rows here and goes no further: the geocoder is asked the question alone.
    expect(r.box.asked.map((a) => a.query)).toEqual([{ q: "limmatquai", limit: "12" }, { q: "bahnhofstrasse", limit: "12" }]);
  });

  it("a region needs both numbers on the globe, or it is refused", async () => {
    const r = await rig();
    for (const near of [{ lat: 47.3 }, { lon: 8.5 }, { lat: 91, lon: 8.5 }, { lat: 47.3, lon: -181 }, { lat: "47.3", lon: 8.5 }, "47.3,8.5", { lat: Number.NaN, lon: 8.5 }]) {
      expect((await r.ask({ text: "limmatquai", near })).status, JSON.stringify(near)).toBe(400);
    }
    expect(r.box.asked).toHaveLength(0);
  });

  it("a text that is no text, and a body that is no JSON, are refused", async () => {
    const r = await rig();
    expect((await r.ask({})).status).toBe(400);
    expect((await r.ask({ text: 42 })).status).toBe(400);
    expect((await r.ask("{not json")).status).toBe(400);
    expect(r.box.asked).toHaveLength(0);
  });

  it("not signed in: refused as every route refuses, and nothing is asked", async () => {
    const r = await rig();
    const res = await r.ask({ text: "limmatquai" }, {}, null);
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("unauthorized");
    expect(r.box.asked).toHaveLength(0);
  });

  it("where no geocoder is set, a well-formed question is answered off and a malformed one is still refused", async () => {
    const r = await rig({ places: false });
    const off = await r.ask({ text: "limmatquai" });
    expect(off.status).toBe(200);
    expect(await read(off)).toEqual({ state: "off", places: [], credit: null });
    expect((await r.ask({ text: "x".repeat(201) })).status).toBe(400);
    expect(r.box.asked).toHaveLength(0);
  });
});
