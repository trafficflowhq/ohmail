import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { withoutFoldersFlag } from "../../../packages/api/src/routes/local.js";
import type { Route } from "../../../packages/api/src/router.js";
import { readFoldersEnabled, writeFoldersEnabled, writeScreenerAcknowledgement } from "../src/net/consent";
import type { ConnectedSession } from "../src/net/pairing";

/**
 * ═══ THE PAIRED PHONE AGAINST A DOOR THAT CANNOT KEEP THE FOLDERS CHOICE ═════════════════════
 *
 * ── WHAT WAS BROKEN ─────────────────────────────────────────────────────────────────────────
 *
 * A phone pairs with a desktop host, and `desktopHostRoutes` spreads `localRoutes`, which wraps
 * its consent group in `withoutFoldersFlag` — no folder verb is served on that table, so the
 * flag cannot be raised there. The wrapper used to force `foldersEnabledAt` to NULL on the read,
 * which every client reads as "off" and no client can tell from "off, and storable". So the
 * phone drew "Use folders", the press wrote, the PATCH echo omitted the axis, and
 * `writeFoldersEnabled` read that omission as `{ on: false }`: the switch flipped and snapped
 * back with no sentence anywhere. The webapp shell has never had this — its transport DECLARES
 * `foldersStorable`, which the phone has no equivalent of because its door is remote.
 *
 * ── WHY THIS IS A TWIN AND NOT A FIXTURE ────────────────────────────────────────────────────
 *
 * The server side is the REAL wrapper (`packages/api/src/routes/local.ts`) over a handler
 * answering the consent row's real shape, served over real HTTP; the client side is the phone's
 * real parser. Neither is written to agree with the other — a fixture hand-shaped to the wrapper
 * would measure this file's author, which is exactly how the defect survived: the phone's own
 * fixtures answered `foldersEnabledAt: null` because that is what somebody assumed.
 *
 * The unwrapped arm is the positive control: the SAME handler on the managed table's shape,
 * where the axis is carried, must still store and read back.
 */

/** The account row this door answers from — `foldersEnabledAt` as the real route carries it. */
let stored: string | null = null;
let screenerAcknowledgements = 0;

/**
 * The consent group, in the two shapes a client meets: the hosted table spreads it raw, every
 * door built from `localRoutes` spreads it through the stripper.
 */
function consentGroup(): Route[] {
  return [
    {
      method: "GET", pattern: "/consent", relay: true, cost: "read",
      handler: async () => json({
        dormancyDays: 45,
        screeningScope: "window",
        screeningBaselineAt: "2026-01-02T03:04:05.000Z",
        foldersEnabledAt: stored,
        screenerAcknowledgements,
        signatures: {},
        themeFace: null,
      }),
    } as unknown as Route,
    {
      method: "PATCH", pattern: "/consent/settings", relay: true, cost: "work",
      handler: async (req: Request) => {
        const body = (await req.json()) as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        /* The route's own rule, verbatim: presence decides, and the echo carries back ONLY the
           axes the request named. That is why a stripped field echoes nothing — the half of the
           contract the phone was misreading. */
        if ("foldersEnabled" in body) {
          stored = body.foldersEnabled === true ? "2026-03-04T05:06:07.000Z" : null;
          out.foldersEnabledAt = stored;
        }
        if (body.acknowledgeScreener === "applySuggestions") {
          screenerAcknowledgements = 4;
          out.screenerAcknowledgements = screenerAcknowledgements;
        }
        if ("dormancyDays" in body) out.dormancyDays = body.dormancyDays;
        return json(out);
      },
    } as unknown as Route,
  ];
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200, headers: { "content-type": "application/json" },
  });

/** One loopback door serving a route array — the shape `makeHttpServer` gives the real host. */
function doorOver(routes: Route[]): Promise<{ origin: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const route = routes.find((r) => r.method === req.method && r.pattern === url.pathname);
      if (!route) { res.writeHead(404).end("{}"); return; }
      const answer = await route.handler(
        new Request(url, {
          method: req.method,
          headers: { "content-type": "application/json" },
          ...(chunks.length > 0 ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
        }),
        {} as never,
        {} as never,
      );
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(await answer.text());
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

const sessionAt = (origin: string): ConnectedSession =>
  ({ fetch: (...a: Parameters<typeof fetch>) => fetch(...a), profile: { origin } }) as unknown as ConnectedSession;

let host: { origin: string; close: () => Promise<void> };
let hosted: { origin: string; close: () => Promise<void> };

beforeAll(async () => {
  // The paired door: the real stripper over the real group, exactly as `localRoutes` composes it.
  host = await doorOver(withoutFoldersFlag(consentGroup()));
  // The managed table's shape: the same group, spread raw.
  hosted = await doorOver(consentGroup());
});

afterAll(async () => {
  await host.close();
  await hosted.close();
});

it("writes and reads a Screener acknowledgement through the paired consent door", async () => {
  screenerAcknowledgements = 0;
  expect((await readFoldersEnabled(sessionAt(host.origin)))?.screenerAcknowledgements).toBe(0);
  expect(await writeScreenerAcknowledgement(sessionAt(host.origin), "applySuggestions")).toBe(4);
  expect((await readFoldersEnabled(sessionAt(host.origin)))?.screenerAcknowledgements).toBe(4);
});

describe("a paired phone reading a door that serves no folder verb", () => {
  it("is told the door carries no folders axis, and is not told 'off'", async () => {
    stored = null;
    const ans = await readFoldersEnabled(sessionAt(host.origin));
    expect(ans, "the paired read failed outright").not.toBeNull();
    expect(ans!.storable, "the phone believes this door can keep a folders choice").toBe(false);
    // OFF as well — the flag-off parity claim is untouched by naming the second fact.
    expect(ans!.on).toBe(false);
    // And the rest of the row still arrives: this door's screening window is what mail 0083
    // mounted `consentRoutes` here FOR, and a wrapper that cost it would be a worse defect.
    expect(ans!.screening?.dormancyDays).toBe(45);
  });

  it("reads an instant written on another door as OFF, and still says not storable", async () => {
    // A row switched on where the verbs exist, then read through this door. Off is the answer the
    // pre-feature interface needs; "not storable" is what stops the phone offering to change it.
    stored = "2026-01-09T10:11:12.000Z";
    const ans = await readFoldersEnabled(sessionAt(host.origin));
    expect(ans!.on).toBe(false);
    expect(ans!.storable).toBe(false);
    stored = null;
  });

  it("REFUSES a write this door dropped, instead of reporting it off", async () => {
    stored = null;
    // The press. The wrapper drops the field, the handler never sees it, the echo omits the axis.
    await expect(writeFoldersEnabled(sessionAt(host.origin), true)).rejects.toThrow();
    // Nothing was stored, which is the whole point: reported as `{ on: false }` this reads as a
    // server calmly answering "off" about a write it never made.
    expect(stored).toBeNull();
  });

  it("POSITIVE CONTROL — on a door that carries the axis the same calls store and read back", async () => {
    stored = null;
    const before = await readFoldersEnabled(sessionAt(hosted.origin));
    expect(before!.storable, "the unwrapped group lost its folders axis").toBe(true);
    expect(before!.on).toBe(false);

    const wrote = await writeFoldersEnabled(sessionAt(hosted.origin), true);
    expect(wrote.on, "the write's own echo did not confirm").toBe(true);

    const after = await readFoldersEnabled(sessionAt(hosted.origin));
    expect(after!.on, "the flag did not read back on the door that stores it").toBe(true);
    expect(after!.storable).toBe(true);
    stored = null;
  });
});
