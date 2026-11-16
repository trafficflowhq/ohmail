import { randomUUID } from "node:crypto";
import { request as httpRequest, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "@trafficflow/core";
import { createApp, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { accounts, sessions, users } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { generateToken, hashToken } from "@trafficflow/services";
import { makeDispatch } from "../src/handler.js";
import { makeHttpServer } from "../src/http.js";
import { buildProgram, type Program } from "../src/program.js";
import { loadSettings } from "../src/settings.js";
import { PLAIN_ENV, PROCESS_DOOR, env, fixture, processInput } from "./_envs.js";
import { collection, feature, placeBox, refusal, type PlaceBox } from "../../../packages/api/test/_place-box.js";

/**
 * WHAT A PERSON TYPED, THE COUNTRY THEY HAND AS THEIR OWN, AND THE GEOCODER'S SECRET, ARE IN NO LINE
 * OF OURS. The server's program, built from its settings as a door builds it, with the server's own
 * logger writing every line at every level into this test and the fault recorder's every record
 * caught; a signed-in person asks a good question, refused ones and one the geocoder fails, the
 * geocoder echoes the question and the bearer back in its own refusals, and not one captured line,
 * record or answer holds any of them; the country goes to no geocoder either.
 */

const TYPED = "Pestalozzistrasse 41b, Hinterhaus";
const MARK = "pestalozzi";
/** The person's own country as the field hands it: a code no country carries, so nothing else in a line reads as it. */
const HOME = "QZ";

const boxes: PlaceBox[] = [];
const programs: Program[] = [];
afterEach(async () => {
  for (const p of programs.splice(0)) await p.close();
  for (const b of boxes.splice(0)) await b.close();
});

/** `url`: the geocoder's address when it is not the stand-in's (one nothing answers at). */
async function rig(opts: { url?: string } = {}) {
  const box = await placeBox();
  boxes.push(box);
  // Assembled here, as every stand-in credential of this suite is.
  const secret = fixture("planted", "geocoder", "bearer", randomUUID());
  const lines: string[] = [];
  const logger = createLogger({ service: "server", level: "debug", sink: (l) => { lines.push(l); } });
  const program = buildProgram(
    loadSettings(env(PLAIN_ENV, { OHMAIL_CALENDAR: "1", PLACES_SUGGEST_URL: opts.url ?? box.url, PLACES_SUGGEST_TOKEN: secret }), PROCESS_DOOR),
    processInput(logger),
  );
  programs.push(program);
  const app = createApp([...program.chosen.routes, ...calendarRoutes]);

  const db = await makeTestDb();
  const now = new Date();
  const token = generateToken();
  const [account] = await db.insert(accounts).values({ name: "Test" }).returning();
  const [user] = await db.insert(users).values({
    accountId: account!.id, email: `mila+${account!.id}@lichtgrat.example`, displayName: "Mila", emailVerifiedAt: now,
  }).returning();
  await db.insert(sessions).values({
    accountId: account!.id, userId: user!.id, familyId: randomUUID(), accessTokenHash: hashToken(token),
    accessExpiresAt: new Date(now.getTime() + 3_600_000), refreshExpiresAt: new Date(now.getTime() + 7_200_000),
  });

  const records: string[] = [];
  const answers: string[] = [];
  const ask = async (body: unknown): Promise<Response> => {
    const request = new Request("https://mail.example.com/calendar/places/suggest", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify(body),
    });
    const deps = program.buildDeps(request);
    deps.db = db as unknown as ApiDeps["db"];
    // The recorder's every record, caught as it is handed over.
    deps.faultLog = { record: async (fault) => { records.push(JSON.stringify(fault)); } };
    const res = await app.handle(request, deps);
    answers.push(await res.clone().text());
    return res;
  };
  return { box, secret, lines, records, answers, ask, accountId: account!.id, program, db, logger, token };
}

const everything = (r: { lines: string[]; records: string[]; answers: string[] }): string =>
  [...r.lines, ...r.records, ...r.answers].join("\n");

describe("(3) the typed text and the person's country are in no line of ours", () => {
  it("a good question, refused ones and a failed one: no log line, fault record or answer holds them", async () => {
    const r = await rig();
    r.box.answer(() => ({ status: 200, body: collection(feature({ street: "Pestalozzistrasse", housenumber: "41b", city: "Zürich", type: "house" })) }));
    const good = await r.ask({ text: TYPED, lang: "de", home: HOME });
    expect(good.status).toBe(200);
    // The person's own place comes back to them: that is the answer, not a line of ours.
    expect(((await good.json()) as { places: { first: string }[] }).places[0]!.first).toBe("Pestalozzistrasse 41b");
    r.answers.length = 0;

    const refused = await r.ask({ text: `${TYPED} ${"x".repeat(200)}`, home: HOME });
    expect(refused.status).toBe(400);
    // A home of another shape is refused without being repeated.
    const homeRefused = await r.ask({ text: TYPED, home: `${HOME}${HOME}` });
    expect(homeRefused.status).toBe(400);

    // Each failure on a program of its own: one account is asked for once in any second, and a failure holds a program 5 s.
    const failed = await rig();
    failed.box.answer((a) => ({ status: 500, body: refusal("internal", `failed on ${a.query.q}`) }));
    expect((await (await failed.ask({ text: `${TYPED} Hof`, home: HOME })).json()) as { state: string }).toMatchObject({ state: "down" });

    // A geocoder echoing the question in a 400 is said in one line.
    const echo = await rig();
    echo.box.answer((a) => ({ status: 400, body: refusal("bad_param", `nothing near ${a.query.q}`) }));
    expect((await (await echo.ask({ text: TYPED, home: HOME })).json()) as { state: string }).toMatchObject({ state: "ok" });
    expect(echo.lines.some((l) => l.includes("places_question_refused"))).toBe(true);

    for (const run of [r, failed, echo]) {
      expect(run.box.asked.every((a) => a.query.q!.includes(MARK))).toBe(true);
      expect(everything(run).toLowerCase()).not.toContain(MARK);
      expect(everything(run)).not.toContain("Hinterhaus");
      expect(everything(run)).not.toContain(HOME);
      // The country orders the rows on our side: no address the geocoder was asked at, and no header, holds it.
      expect(JSON.stringify(run.box.asked)).not.toContain(HOME);
    }
    // The failure was said, in words of ours.
    expect(failed.lines.some((l) => l.includes("places_held"))).toBe(true);
  });

  it("a geocoder nothing answers at, and one that holds the question past 2 s: the failure is said, the text and the country are in no line", async () => {
    const gone = await placeBox();
    const port = gone.port;
    await gone.close();
    const closed = await rig({ url: `http://localhost:${port}` });
    const held = await rig();
    held.box.answer(() => "hold");
    for (const run of [closed, held]) {
      expect((await (await run.ask({ text: TYPED, lang: "de", home: HOME })).json()) as { state: string }).toMatchObject({ state: "down" });
      expect(run.lines.some((l) => l.includes("places_held"))).toBe(true);
      expect(everything(run).toLowerCase()).not.toContain(MARK);
      expect(everything(run)).not.toContain("Hinterhaus");
      expect(everything(run)).not.toContain(HOME);
      expect(JSON.stringify(run.box.asked)).not.toContain(HOME);
    }
  }, 10_000);
});

describe("(4) the secret is in no line of ours", () => {
  it("the geocoder refusing the bearer (and quoting it back) is said once, without it; no line, record or answer holds it", async () => {
    const r = await rig();
    r.box.answer((a) => ({ status: 401, body: refusal("unauthorized", `refused ${a.headers.authorization ?? ""}`) }));
    for (const text of ["Bahnhofstrasse", "Seefeldstrasse", "Limmatquai"]) {
      expect((await (await r.ask({ text })).json()) as { state: string }).toMatchObject({ state: "off" });
    }
    expect(r.box.asked).toHaveLength(1);
    expect(r.box.asked[0]!.headers.authorization).toBe(`Bearer ${r.secret}`);
    const said = r.lines.filter((l) => l.includes("places_settings_refused"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("PLACES_SUGGEST_TOKEN");
    // The lines include every one the program wrote while it was built from its settings.
    expect(r.lines.length).toBeGreaterThan(0);
    expect(everything(r)).not.toContain(r.secret);
  });

  it("the good and the failed paths hold it nowhere either", async () => {
    // Each on a program of its own: one account is asked for once in any second.
    const good = await rig();
    good.box.answer(() => ({ status: 200, body: collection() }));
    expect((await (await good.ask({ text: "Bahnhofstrasse" })).json()) as { state: string }).toMatchObject({ state: "ok" });
    const failed = await rig();
    failed.box.answer(() => "hold");
    expect((await (await failed.ask({ text: "Seefeldstrasse" })).json()) as { state: string }).toMatchObject({ state: "down" });
    for (const run of [good, failed]) {
      expect(run.box.asked.map((a) => a.headers.authorization)).toEqual([`Bearer ${run.secret}`]);
      expect(everything(run)).not.toContain(run.secret);
    }
  }, 10_000);
});

/** A question posted on a real socket; `keep` is handed the request, so a case can end its socket. */
function post(port: number, token: string, body: unknown, keep?: (r: ClientRequest) => void): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = httpRequest({
      host: "127.0.0.1", port, method: "POST", path: "/calendar/places/suggest",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(data), host: "mail.example.com" },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    r.on("error", reject);
    keep?.(r);
    r.end(data);
  });
}

describe("a person who leaves, at the server's own door", () => {
  it("the client ends its socket while the geocoder holds the question, and the server's call to it ends too", async () => {
    const r = await rig();
    // The door the program listens through, around the program's own pipeline; only the database handle is the test's.
    const dispatch = makeDispatch({
      routes: [...r.program.chosen.routes, ...calendarRoutes],
      bodyMaxBytes: 1024 * 1024,
      closeUndrained: true,
      logger: r.logger,
      buildDeps: (req) => {
        const d = r.program.buildDeps(req);
        d.db = r.db as unknown as ApiDeps["db"];
        return d;
      },
    });
    const server = makeHttpServer(dispatch, { bodyMaxBytes: 1024 * 1024, headersTimeoutMs: 10_000, requestTimeoutMs: 30_000 });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      // Through this door a question the person waits for is answered: the path is the real one.
      r.box.answer(() => ({ status: 200, body: collection() }));
      const answered = await post(port, r.token, { text: "Bahnhofstrasse" });
      expect(answered.status).toBe(200);
      expect((JSON.parse(answered.body) as { state: string }).state).toBe("ok");

      // A second on: one account is asked for once in any second, and this program's clock is the wall's.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      r.box.answer(() => "hold");
      let client: ClientRequest | null = null;
      const pending = post(port, r.token, { text: "Seefeldstrasse" }, (c) => { client = c; }).catch(() => null);
      await expect.poll(() => r.box.asked.length, { timeout: 3_000 }).toBe(2);
      (client as ClientRequest | null)?.destroy();
      const leftAt = Date.now();
      await expect.poll(() => r.box.asked[1]!.gaveUpAt, { timeout: 6_000, interval: 20 }).not.toBeNull();
      await pending;
      // Well inside the call's own 2 s bound: the leave ended it, not the bound.
      expect(r.box.asked[1]!.gaveUpAt! - leftAt).toBeLessThan(500);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20_000);
});
