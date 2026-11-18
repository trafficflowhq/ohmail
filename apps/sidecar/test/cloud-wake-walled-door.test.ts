import type { SyncChange, SyncResponse } from "@ohmail/wire";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar, type CloudSidecarConfig } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * SSE-DESKTOP-WAKE-OFF-AFTER-THE-WALL at the composed door: `createCloudSidecar` over a fake Cloud.
 * The fake IS the managed host's two-instance shape: `/events` answers its own instance's refusal
 * while `/mailboxes` and `/sync` can answer from a held allow. A walled wake waits for the mirror
 * to be served again and then dials once; under a standing wall it never turns off and never storms.
 */

const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
const clouds: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const c of clouds.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, capMs: number): Promise<void> {
  const end = Date.now() + capMs;
  while (!ok() && Date.now() < end) await sleep(10);
}

const emptyPage = (): SyncResponse => ({
  changes: { creates: [] as SyncChange[], updates: [], moves: [], deletes: [] },
  cursor: "end", hasMore: false, serverTime: new Date().toISOString(),
});

interface Doors { events: 200 | 402; mail: 200 | 402 }

/** The hosted account: every `/events` dial and `/mailboxes` ask counted, each door's answer set by the test. */
function hostedCloud(initial: Doors) {
  const doors: Doors = { ...initial };
  let eventsDials = 0;
  let mailboxAsks = 0;
  const open = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const json = (v: unknown, status = 200): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const refused = (): Response => json({
    error: { code: "subscription_required", message: "not active", details: { reason: "suspended" } },
  }, 402);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.pathname === "/events") {
      eventsDials += 1;
      if (doors.events === 402) return refused();
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) { ctl = c; open.add(c); c.enqueue(enc.encode("retry: 3000\n\nevent: ready\ndata: {}\n\n")); },
      });
      init?.signal?.addEventListener("abort", () => { open.delete(ctl); try { ctl.close(); } catch { /* closed */ } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname === "/mailboxes") {
      mailboxAsks += 1;
      return doors.mail === 402 ? refused() : json(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
    }
    if (doors.mail === 402) return refused();
    if (url.pathname === "/sync") return json(emptyPage());
    if (url.pathname === "/sync/snapshot") {
      return json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    }
    if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const cloud = {
    fetchImpl,
    eventsDials: (): number => eventsDials,
    mailboxAsks: (): number => mailboxAsks,
    set: (next: Partial<Doors>): void => { Object.assign(doors, next); },
    close: (): void => { for (const c of open) { try { c.close(); } catch { /* closed */ } } open.clear(); },
  };
  clouds.push(cloud);
  return cloud;
}

async function standUp(
  cloud: ReturnType<typeof hostedCloud>, seams: Pick<CloudSidecarConfig, "pollIntervalMs" | "walledPollMs">,
): Promise<{ sidecar: CloudSidecar; events: string[] }> {
  const dataDir = await freshDataDir("ohmail-wake-walled-");
  dirs.push(dataDir);
  const events: string[] = [];
  const sidecar = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://cloud.test",
    address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" },
    fetchImpl: cloud.fetchImpl,
    log: (event) => { events.push(event); },
    ...seams,
  });
  sidecars.push(sidecar);
  // The wake dials as the door is assembled; the first answer is read before anything else moves.
  await until(() => events.includes("cloud_wake_walled") || events.includes("cloud_wake_off"), 5_000);
  expect(cloud.eventsDials(), "the premise: the wake dialled once and met the 402").toBe(1);
  return { sidecar, events };
}

const wakeLines = (events: string[]): string[] => events.filter((e) => e.startsWith("cloud_wake_"));

describe("after the wall, the desktop's wake comes back with the mirror", () => {
  // A Cloud door stands up in seconds here; the 5 s default is the store-stuck file's lesson.
  it("a 402 at /events while /sync is served: the next served pull re-dials the wake, and it connects", { timeout: 30_000 }, async () => {
    const cloud = hostedCloud({ events: 402, mail: 200 });
    const { sidecar, events } = await standUp(cloud, { pollIntervalMs: 3_600_000 });
    cloud.set({ events: 200 });
    await sidecar.start();
    await until(() => events.includes("cloud_wake_connected"), 5_000);
    expect(cloud.eventsDials(), "the served pull did not re-dial the walled wake").toBe(2);
    expect(wakeLines(events)).toEqual(["cloud_wake_walled", "cloud_wake_connected"]);
  });

  it("CONTROL: under a standing /events wall, ten served pulls buy one re-dial, and the wake never turns off", { timeout: 30_000 }, async () => {
    const cloud = hostedCloud({ events: 402, mail: 200 });
    const { sidecar, events } = await standUp(cloud, { pollIntervalMs: 50 });
    const asks0 = cloud.mailboxAsks();
    await sidecar.start();
    await until(() => cloud.mailboxAsks() >= asks0 + 10, 20_000);
    expect(cloud.mailboxAsks() - asks0, "the premise: ten served pulls").toBeGreaterThanOrEqual(10);
    expect(cloud.eventsDials(), "served pulls under a standing wall re-dialled more than once a minute").toBe(2);
    expect(wakeLines(events), "the wall is said once per episode, and never as off").toEqual(["cloud_wake_walled"]);
  });

  it("refused at every door: the mirror asks on its flat walled clock, and the first pull served after the payment brings the stream back", { timeout: 30_000 }, async () => {
    const cloud = hostedCloud({ events: 402, mail: 402 });
    const { sidecar, events } = await standUp(cloud, { pollIntervalMs: 3_600_000, walledPollMs: 150 });
    await sidecar.start();
    const asks0 = cloud.mailboxAsks();
    await sleep(1_200);
    // At 150 ms flat that is about eight asks; the 1, 2, 4 s ladder makes at most one.
    expect(cloud.mailboxAsks() - asks0, "a refused account's mirror waited on the failure ladder").toBeGreaterThanOrEqual(4);
    expect(cloud.eventsDials(), "a refused pull re-dialled the wake").toBe(1);
    cloud.set({ events: 200, mail: 200 });
    await until(() => events.includes("cloud_wake_connected"), 5_000);
    expect(cloud.eventsDials()).toBe(2);
    expect(wakeLines(events)).toEqual(["cloud_wake_walled", "cloud_wake_connected"]);
  });
});
