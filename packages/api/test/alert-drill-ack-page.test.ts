import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { asc } from "drizzle-orm";
import { chromium, type Browser } from "playwright";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { alertDrills, type Alert, type AlertSink } from "@trafficflow/db/cloud";
import { makeDeps, req } from "./helpers.js";

/**
 * THE ACK PAGE IN A BROWSER: the real route table over PGlite behind a loopback HTTP server, the
 * link a drill mailed opened in Chromium, its button pressed. This is the proof the unit cases
 * cannot give: the page's one script runs under the page's own CSP, its POST passes the request
 * guard (same origin, JSON), and the press stamps the message once.
 */

const SECRET = "s".repeat(32);
const START = new Date("2026-12-01T12:00:00.000Z");
const app = createApp(apiRoutes);

let server: Server | null = null;
let origin = "";
let browser: Browser | null = null;
let h: Awaited<ReturnType<typeof makeDeps>>;
let deps: ApiDeps;
const messages: Alert[][] = [];
const sink: AlertSink = { name: "mail", channel: "mail", async notify(alerts) { messages.push([...alerts]); return true; } };

beforeAll(async () => {
  server = createServer((incoming, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const c of incoming) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(incoming.headers)) {
        if (typeof v === "string") headers.set(k, v);
        else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      }
      const method = incoming.method ?? "GET";
      const request = new Request(`${origin}${incoming.url ?? "/"}`, {
        method, headers, body: method === "GET" || method === "HEAD" || chunks.length === 0 ? undefined : Buffer.concat(chunks),
      });
      const answer = await app.handle(request, { ...deps, session: null });
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    })().catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, "localhost");
  await once(server, "listening");
  origin = `http://localhost:${(server.address() as AddressInfo).port}`;
  // The page's press carries this origin; the request guard admits only the deployment's own.
  h = await makeDeps(START, { origin: ["http://localhost:3000", origin] });
  deps = { ...h.deps, alerts: { secret: SECRET, sinks: [sink], environment: "production", drillAckBase: origin } } as ApiDeps;
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
});

describe("the drill's ack link, opened and pressed in a browser", () => {
  it("shows the page, runs its one script under its policy, and the press acknowledges the message once", async () => {
    const started = await app.handle(req("POST", "/internal/alerts/drill", { bearer: SECRET, body: JSON.stringify({ drivers: ["api"] }) }), { ...deps, session: null });
    expect(started.status).toBe(200);
    const link = /(http:\/\/localhost:\d+\/internal\/alerts\/drill\/ack\?t=[A-Za-z0-9_-]{43})/.exec(messages[0]![0]!.detail)?.[1];
    expect(link, "the message carries a link to this server").toBeDefined();

    const page = await browser!.newPage();
    const problems: string[] = [];
    page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
    page.on("pageerror", (e) => problems.push(e.message));
    await page.goto(link!);
    await page.waitForSelector("#ack", { timeout: 30_000 });
    const unacked = await h.db.select({ ackedAt: alertDrills.ackedAt }).from(alertDrills).orderBy(asc(alertDrills.kind));
    expect(unacked.every((r) => r.ackedAt === null), "opening the page recorded nothing").toBe(true);

    await page.click("#ack");
    await page.waitForFunction(() => (document.getElementById("out")?.textContent ?? "").length > 0, undefined, { timeout: 30_000 });
    expect(await page.textContent("#out")).toBe("Acknowledged. Thank you.");
    expect(problems, "no policy refusal, no script error").toEqual([]);
    const rows = await h.db.select({ ackedAt: alertDrills.ackedAt }).from(alertDrills);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ackedAt !== null)).toBe(true);

    // A second visit says so, and offers nothing to press.
    await page.goto(link!);
    expect(await page.textContent("body")).toContain("was acknowledged at");
    expect(await page.$("#ack")).toBeNull();
    await page.close();
  }, 90_000);
});
