import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshDataDir } from "./_datadir.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";
import {
  armFirstPageGate, FIRST_PAGE_GRACE_MS, resetFirstPageGate, yieldsToFirstPage,
} from "../src/first-page-gate.js";

/**
 * THE WINDOW'S FIRST PAGE IS SERVED BEFORE ITS SCREENER READS. At mount the window asks
 * `GET /screener`, `/screener/held-releases` and `/screener/unscreened` beside the outbox read its
 * first page waits on; on the large rig mirror the two Screener scans held the loop ~2.2 s and
 * the first page was asked only after them (start-to-list p95 3.5 s). Driven through the shipped
 * stdio door, so the release is the snapshot page the host frames. Watched red: the hold removed
 * from the window's door, the door-armed check removed, the method check removed.
 */
interface Door { sidecar: Sidecar; host: StdioHost; client: StdioClient }

const open: Array<() => Promise<void> | void> = [];
beforeEach(() => resetFirstPageGate());
afterEach(async () => {
  for (const c of open.splice(0).reverse()) await c();
  resetFirstPageGate();
});

async function door(): Promise<Door> {
  const dataDir = await freshDataDir("ohmail-screener-first-page-");
  const sidecar = await createSidecar({
    dataDir,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
    address: "owner@trafficflow.test",
    pollIntervalMs: 60 * 60 * 1000,
    searchBackfillTiming: { waitMs: 60 * 60 * 1000 },
  });
  const toHost = new PassThrough();
  const toClient = new PassThrough();
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  open.push(async () => {
    client.close();
    host.stop();
    await sidecar.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { sidecar, host, client };
}

const get = (d: Door, path: string, init: RequestInit = {}): Promise<Response> =>
  d.client.fetch(path, { ...init, headers: { authorization: `Bearer ${d.sidecar.sessionToken}`, ...(init.headers ?? {}) } });

/** Has it answered yet — read off a flag set when it settles, never by racing another promise. */
function watched(p: Promise<Response>): { p: Promise<Response>; answered: () => boolean } {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  return { p, answered: () => done };
}
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("the window's door serves its first page before its Screener reads", () => {
  it("holds GET /screener* until the first snapshot page, and answers the outbox read meanwhile", async () => {
    const d = await door();
    // Warmed while nothing is armed, so "not answered yet" below is the hold and not a cold store.
    await get(d, "/screener");
    await get(d, "/screener/unscreened");
    armFirstPageGate();
    const screener = watched(get(d, "/screener"));
    const unscreened = watched(get(d, "/screener/unscreened"));
    const outbox = get(d, `/local/window/outbox?scope=${encodeURIComponent(d.sidecar.world.mailboxId)}`);
    expect((await outbox).status, "the outbox read the first page waits on was held").toBeLessThan(500);
    await tick(FIRST_PAGE_GRACE_MS / 4);
    expect(screener.answered(), "GET /screener answered ahead of the first page").toBe(false);
    expect(unscreened.answered(), "GET /screener/unscreened answered ahead of the first page").toBe(false);

    const page = await get(d, "/sync/snapshot");
    expect(page.status).toBe(200);
    // Released by the page, not by the grace: well inside what is left of it.
    const t = performance.now();
    await Promise.all([screener.p, unscreened.p]);
    expect(performance.now() - t).toBeLessThan(FIRST_PAGE_GRACE_MS / 2);
  }, 60_000);

  /* A held request answers at the grace (1.5 s from the arm); an unheld one in what its handler
     costs, measured after an unrelated read has warmed the store. */
  const UNHELD_MS = FIRST_PAGE_GRACE_MS * 0.6;

  it("never holds a press", async () => {
    const d = await door();
    await get(d, "/consent");
    armFirstPageGate();
    const t = performance.now();
    await get(d, "/screener/held-releases/dismiss", {
      method: "POST", body: "{}", headers: { "content-type": "application/json" },
    });
    expect(performance.now() - t, "a press under /screener waited for the first page").toBeLessThan(UNHELD_MS);
  }, 60_000);

  it("holds nothing where no door armed the gate (the phone)", async () => {
    const d = await door();
    await get(d, "/consent");
    const t = performance.now();
    await get(d, "/screener");
    expect(performance.now() - t, "an unarmed gate held a Screener read").toBeLessThan(UNHELD_MS);
  }, 60_000);

  it("a window that never asks for a page gets its Screener reads at the grace", async () => {
    const d = await door();
    armFirstPageGate();
    const t = performance.now();
    expect((await get(d, "/screener/unscreened")).status).toBeLessThan(500);
    expect(performance.now() - t).toBeLessThan(FIRST_PAGE_GRACE_MS + 2_000);
  }, 60_000);

  it("names the Screener's reads and nothing else", () => {
    expect(yieldsToFirstPage("GET", "/screener")).toBe(true);
    expect(yieldsToFirstPage("get", "/screener/unscreened")).toBe(true);
    expect(yieldsToFirstPage("GET", "/screener/held-releases")).toBe(true);
    expect(yieldsToFirstPage("POST", "/screener/unscreened")).toBe(false);
    expect(yieldsToFirstPage("GET", "/screenerx")).toBe(false);
    expect(yieldsToFirstPage("GET", "/sync/snapshot")).toBe(false);
    expect(yieldsToFirstPage("GET", "/local/window/outbox")).toBe(false);
  });
});
