import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncChange, SyncResponse } from "@trafficflow/services/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror, DEFAULT_CLOUD_POLL_MS, RECONNECT_BASE_MS, WALLED_POLL_MS, type CloudMirror } from "../src/cloud-mirror.js";
import { builtAnswer, type CloudAuth } from "../src/cloud-auth.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown } from "./_teardown.js";

/**
 * A REFUSED ACCOUNT'S MIRROR asks again on a flat minute, never the 1-2-4…300 s failure ladder, so
 * a payment is pulled within one; any other failure keeps the ladder. The pull that is SERVED fires
 * `onServed` (the wake's re-arm), scheduled or kicked, and clears the walled clock. The production
 * constants on a fake clock; PGlite on real turns.
 */

const MB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fakeClock = (): void => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); };
const turn = (): Promise<void> => new Promise((r) => setImmediate(r));
async function advance(ms: number, step = 10): Promise<void> {
  for (let at = 0; at < ms; at += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - at));
    await turn();
  }
}
const gaps = (at: number[]): number[] => at.slice(1).map((t, i) => t - at[i]!);
/** A gap read on the fake clock, which also moves while PGlite works on real turns: within `slack` above. */
function within(actual: number | undefined, expected: number, slack: number, why: string): void {
  expect(actual, why).toBeGreaterThanOrEqual(expected);
  expect(actual, why).toBeLessThanOrEqual(expected + slack);
}

type Door =
  | 200 | 402 | 403 | 404 | 429 | 500 | 502 | 503 | 504 | "unreachable" | "erased" | "built-402"
  | "edge-404" | "edge-402" | "firewall-403" | "edge-json-404";
const statusOf = (d: Door): number => (typeof d === "number" ? d : Number(/\d{3}/.exec(d)?.[0] ?? 0));

/** The hosting platform's own error page: plain text and its error header, the API never reached. */
const platformPage = (status: number, code: string, text: string): Response =>
  new Response(`${text}\n\n${code}\n`, {
    status, headers: { "content-type": "text/plain; charset=utf-8", "x-vercel-error": code },
  });

function hosted() {
  /* `door` answers `/mailboxes`; `snapshot` and `rules` the two doors a first import meets before the
     feed: the opening window and the rules-first pass. */
  const knobs: { door: Door; snapshot: 404 | 402; rules: 200 | 402 } = { door: 200, snapshot: 404, rules: 200 };
  const asked: number[] = [];
  const json = (v: unknown, status = 200): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const empty: SyncResponse = {
    changes: { creates: [] as SyncChange[], updates: [], moves: [], deletes: [] },
    cursor: "end", hasMore: false, serverTime: new Date(0).toISOString(),
  };
  const auth = {
    authedFetch: async (path: string) => {
      const url = new URL(path, "https://cloud.test");
      if (url.pathname === "/mailboxes") {
        asked.push(Date.now());
        if (knobs.door === "unreachable") throw new TypeError("fetch failed");
        if (knobs.door === "erased") return json({ error: { code: "account_erased", message: "gone" } }, 410);
        // An answer this process built (cloud-auth's door) whose status a server could have sent.
        if (knobs.door === "built-402") return builtAnswer(json({ error: { code: "subscription_required", message: "built" } }, 402));
        if (knobs.door === 402) return json({ error: { code: "subscription_required", message: "refused" } }, 402);
        if (knobs.door === "edge-404") return platformPage(404, "DEPLOYMENT_NOT_FOUND", "The deployment could not be found.");
        if (knobs.door === "edge-402") return platformPage(402, "DEPLOYMENT_DISABLED", "Payment required");
        // A firewall's refusal: plain text, no header, no API body.
        if (knobs.door === "firewall-403") return new Response("Forbidden", { status: 403, headers: { "content-type": "text/plain" } });
        // An API-shaped body under the platform's header: the header decides.
        if (knobs.door === "edge-json-404") {
          return new Response(JSON.stringify({ error: { code: "not_found", message: "edge" } }), {
            status: 404, headers: { "content-type": "application/json", "x-vercel-error": "NOT_FOUND" },
          });
        }
        if (knobs.door !== 200) return json({ error: { code: "refused", message: String(knobs.door) } }, knobs.door);
        return json(mailboxList([hostedMailbox(MB, "me@ohmail.test")]));
      }
      const walled = (): Response => json({ error: { code: "subscription_required", message: "refused" } }, 402);
      if (url.pathname === "/sync/snapshot") {
        return knobs.snapshot === 402 ? walled() : new Response("no snapshot", { status: 404 });
      }
      if (url.pathname === "/sync" && url.searchParams.get("types") === "rule" && knobs.rules === 402) return walled();
      if (url.pathname === "/sync") return json(empty);
      if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  } as unknown as CloudAuth;
  return { auth, knobs, asked };
}

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
const mirrors: CloudMirror[] = [];
const sidecars: CloudSidecar[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await tearDown({ stop: [sidecars, mirrors], close: opens, remove: dirs });
});

async function standUp(pollIntervalMs: number | undefined, wakeLive?: () => boolean) {
  const dataDir = await freshDataDir("ohmail-mirror-walled-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  const cloud = hosted();
  let served = 0;
  const mirror = createCloudMirror({
    db: opened.db, world, auth: cloud.auth, cursorPath: join(dataDir, "cloud-cursor.json"),
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}), ...(wakeLive ? { wakeLive } : {}),
    onServed: () => { served += 1; },
  });
  mirrors.push(mirror);
  return { mirror, cloud, served: (): number => served };
}

describe("a refused account's mirror asks on a flat minute", () => {
  it("a 402 at /mailboxes: the next asks are a minute apart, never the 1-2-4 s ladder", async () => {
    const t = await standUp(3_600_000);
    t.cloud.knobs.door = 402;
    fakeClock();
    void t.mirror.start();
    await advance(4 * WALLED_POLL_MS - 1_000, 250);
    const g = gaps(t.cloud.asked);
    expect(g, "a refused account's pull went on the failure ladder").toHaveLength(3);
    for (const gap of g) within(gap, WALLED_POLL_MS, 500, "a refused account's pull went on the failure ladder");
    expect(t.served(), "a refused pull fired the served hook").toBe(0);
  }, 30_000);

  it("a first import that meets the 402 at the opening window asks again on the flat minute", async () => {
    const t = await standUp(3_600_000);
    t.cloud.knobs.snapshot = 402;
    fakeClock();
    void t.mirror.start();
    await advance(3 * WALLED_POLL_MS - 1_000, 250);
    // The window is asked three times, then given up and the feed is served (`WINDOW_REFUSALS_MAX`).
    const g = gaps(t.cloud.asked);
    expect(g, "a first import's walled window went on the failure ladder").toHaveLength(2);
    for (const gap of g) within(gap, WALLED_POLL_MS, 500, "a first import's walled window went on the failure ladder");
  }, 30_000);

  it("a first import that meets the 402 at the rules-first pass asks again on the flat minute", async () => {
    const t = await standUp(3_600_000);
    t.cloud.knobs.rules = 402;
    fakeClock();
    void t.mirror.start();
    await advance(3 * WALLED_POLL_MS - 1_000, 250);
    const g = gaps(t.cloud.asked);
    expect(g, "a first import's walled rules pass went on the failure ladder").toHaveLength(2);
    for (const gap of g) within(gap, WALLED_POLL_MS, 500, "a first import's walled rules pass went on the failure ladder");
    expect(t.served(), "a refused rules pass fired the served hook").toBe(0);
  }, 30_000);

  it("CONTROL: a 503 keeps the ladder: 1, 2, 4, 8 s", async () => {
    const t = await standUp(3_600_000);
    t.cloud.knobs.door = 503;
    fakeClock();
    void t.mirror.start();
    await advance(16_000, 50);
    const g = gaps(t.cloud.asked);
    [1_000, 2_000, 4_000, 8_000].forEach((ms, i) => within(g[i], ms, 200, `ladder step ${i + 1}`));
  }, 30_000);

  it("the hosting platform's own 402 is not the account's wall: the ladder, 1, 2, 4, 8 s", async () => {
    const t = await standUp(3_600_000);
    t.cloud.knobs.door = "edge-402";
    fakeClock();
    void t.mirror.start();
    await advance(16_000, 50);
    const g = gaps(t.cloud.asked);
    expect(g.length, "a platform 402 put the mirror on the walled minute").toBeGreaterThanOrEqual(4);
    [1_000, 2_000, 4_000, 8_000].forEach((ms, i) => within(g[i], ms, 200, `a platform 402 off the ladder, step ${i + 1}`));
  }, 30_000);

  it("served after the wall: the hook fires once, the 20 s poll follows, and a pull that cannot reach Cloud backs off from 1 s", async () => {
    const t = await standUp(20_000);
    t.cloud.knobs.door = 402;
    fakeClock();
    void t.mirror.start();
    await advance(WALLED_POLL_MS + 1_000, 250);
    expect(t.cloud.asked).toHaveLength(2);
    t.cloud.knobs.door = 200;
    for (let i = 0; i < 20_000 && t.served() === 0; i++) await advance(10);
    expect(t.served(), "the first pull after the payment was not served, or fired nothing").toBe(1);
    expect(t.cloud.asked).toHaveLength(3);
    within(gaps(t.cloud.asked)[1], WALLED_POLL_MS, 500, "the payment's pull was not on the walled minute");
    t.cloud.knobs.door = "unreachable";
    for (let i = 0; i < 10_000 && t.cloud.asked.length < 5; i++) await advance(10);
    const g = gaps(t.cloud.asked);
    within(g[2], 20_000, 10_000, "the served mirror's next ask is the 20 s poll");
    within(g[3], RECONNECT_BASE_MS, 500, "an unreachable Cloud after the lift waited the walled minute");
  }, 30_000);
});

describe("Cloud reached is Cloud refusing: a 4xx keeps the mirror reachable, anything else is offline", () => {
  it("a 402, a 403 and a 404 leave it reachable; a 500, 502, 503, 504 and a 429 keep the offline path", async () => {
    const t = await standUp(3_600_000);
    const answers: Array<[Door, boolean]> = [
      [402, true], [500, false], [403, true], [502, false], [404, true], [503, false], [504, false], [429, false],
    ];
    for (const [door, reachable] of answers) {
      t.cloud.knobs.door = door;
      await expect(t.mirror.pullOnce()).rejects.toThrow(new RegExp(`answered HTTP ${String(door)}`));
      expect(t.mirror.online(), `a ${String(door)} read as ${reachable ? "offline" : "reachable"}`).toBe(reachable);
    }
  }, 30_000);

  it("a pull that meets no answer is offline, and the next refusal Cloud answers makes it reachable again", async () => {
    const t = await standUp(3_600_000);
    t.cloud.knobs.door = "unreachable";
    await expect(t.mirror.pullOnce()).rejects.toThrow(/fetch failed/);
    expect(t.mirror.online(), "a pull Cloud never answered read as online").toBe(false);
    t.cloud.knobs.door = 402;
    await expect(t.mirror.pullOnce()).rejects.toThrow(/answered HTTP 402/);
    expect(t.mirror.online(), "Cloud refused and the mirror stayed offline").toBe(true);
  }, 30_000);

  it("the hosting platform's own 4xx is an outage: its plain-text 404 and 402, a firewall's 403, and any answer under its error header", async () => {
    const t = await standUp(3_600_000);
    // Each platform page follows one of Cloud's own refusals, so every step is a transition.
    const answers: Array<[Door, boolean]> = [
      ["edge-404", false], [404, true], ["edge-402", false], [402, true], ["firewall-403", false], [403, true],
      ["edge-json-404", false],
    ];
    for (const [door, reachable] of answers) {
      t.cloud.knobs.door = door;
      await expect(t.mirror.pullOnce()).rejects.toThrow(new RegExp(`answered HTTP ${statusOf(door)}`));
      expect(t.mirror.online(), `${String(door)} read as ${reachable ? "offline" : "Cloud refusing"}`).toBe(reachable);
    }
  }, 30_000);

  it("an answer this process built is never Cloud's: a built 402 keeps the offline path", async () => {
    const t = await standUp(3_600_000);
    t.cloud.knobs.door = "built-402";
    await expect(t.mirror.pullOnce()).rejects.toThrow(/answered HTTP 402/);
    expect(t.mirror.online(), "an answer built here read as Cloud reached").toBe(false);
  }, 30_000);

  it("CONTROL: an erased account is unchanged: the 410 stops the mirror, offline", async () => {
    const t = await standUp(3_600_000);
    t.cloud.knobs.door = "erased";
    await expect(t.mirror.pullOnce()).resolves.toBe(0);
    expect(t.mirror.accountErased()).toBe(true);
    expect(t.mirror.online(), "an erased account read as online").toBe(false);
  }, 30_000);
});

describe("the served hook is the pull's, not the poll's", () => {
  it("a kicked pull that is served fires it; a kicked pull the account refuses does not", async () => {
    const t = await standUp(3_600_000);
    t.mirror.kick();
    const end = Date.now() + 10_000;
    while (t.served() === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(t.served(), "a kicked pull that was served fired no hook").toBe(1);
    t.cloud.knobs.door = 402;
    const asks = t.cloud.asked.length;
    t.mirror.kick();
    while (t.cloud.asked.length === asks && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 200));
    expect(t.cloud.asked.length, "the premise: the second kick asked").toBe(asks + 1);
    expect(t.served(), "a refused pull fired the hook").toBe(1);
  }, 30_000);
});

/* THE PROXY'S PROBE ASKS THE MIRROR'S QUESTION. The composed door (`createCloudSidecar`) over a fake
   Cloud: a forward that met no answer marks the door offline and owes one probe read, and only an
   answer Cloud itself gave may mark it reachable again. `seen` records every product request. */
type CloudMode = "up" | "unreachable" | "outage" | "renewal-fault" | "edge-404" | "refusing";

function cloudFor(mode: () => CloudMode) {
  const seen: string[] = [];
  let moves = 0;
  const json = (v: unknown, status = 200): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const empty = (): SyncResponse => ({
    changes: { creates: [] as SyncChange[], updates: [], moves: [], deletes: [] },
    cursor: "end", hasMore: false, serverTime: new Date().toISOString(),
  });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const m = mode();
    if (m === "unreachable") throw new TypeError("fetch failed");
    // The wake's stream is off here (a 404 is permanent there), and its dials are not the probe's.
    if (url.pathname === "/events") return json({ error: { code: "not_found", message: "no stream" } }, 404);
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push(`${method} ${url.pathname}`);
    const move = /^\/messages\/([^/]+)\/move$/.exec(url.pathname);
    if (move && method === "POST") moves += 1;
    if (m === "outage") return json({ error: { code: "service_unavailable", message: "down" } }, 503);
    if (m === "edge-404") return platformPage(404, "DEPLOYMENT_NOT_FOUND", "The deployment could not be found.");
    if (m === "refusing") return json({ error: { code: "forbidden", message: "refused" } }, 403);
    if (m === "renewal-fault") {
      // The access token is refused and its renewal faults: the door answers with what it built.
      if (url.pathname === "/auth/refresh") return json({ error: { code: "service_unavailable", message: "down" } }, 503);
      return json({ error: { code: "unauthorized", message: "expired" } }, 401);
    }
    if (move) return json({ id: move[1], folder: "ohmail/News", updatedAt: new Date().toISOString() });
    if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox(MB, "me@ohmail.test")]));
    if (url.pathname === "/sync") return json(empty());
    if (url.pathname === "/sync/snapshot") return json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
    if (url.pathname === "/screener") return json({ items: [] });
    return json({ error: { code: "not_found", message: "not in the stand-in" } }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen, moves: (): number => moves };
}

async function composedDoor(cloud: ReturnType<typeof cloudFor>) {
  const dataDir = await freshDataDir("ohmail-door-probe-");
  dirs.push(dataDir);
  const engine = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" }, fetchImpl: cloud.fetchImpl, pollIntervalMs: 3_600_000,
  });
  sidecars.push(engine);
  const ask = (path: string, init: RequestInit = {}): Promise<Response> => engine.handle(new Request(`http://sidecar${path}`, {
    ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${engine.sessionToken}` },
  }));
  const online = async (): Promise<boolean> => ((await (await ask("/health")).json()) as { online?: unknown }).online === true;
  const answer = async (res: Response): Promise<{ status: number; code: string | null }> => {
    let code: string | null = null;
    try { code = ((await res.json()) as { error?: { code?: string } }).error?.code ?? null; } catch { /* not JSON */ }
    return { status: res.status, code };
  };
  const move = async (key: string) => answer(await ask("/messages/m-1/move", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ folder: "ohmail/News" }),
  }));
  return { engine, ask, online, move, answer };
}

const HELD = { status: 503, code: "offline_read_only" };

/** Served, then one forward meets no answer (the door goes offline, a probe owed), then Cloud is `next` for the probe read. */
async function probeAfterAFailedForward(next: CloudMode) {
  let mode: CloudMode = "up";
  const cloud = cloudFor(() => mode);
  const d = await composedDoor(cloud);
  await d.engine.start();
  expect(await d.online(), "the premise: the first pull was served").toBe(true);
  mode = "unreachable";
  expect(await d.move("k-1"), "the premise: a forward that met no answer is answered offline").toEqual(HELD);
  expect(await d.online(), "the premise: that forward marked the door offline").toBe(false);
  mode = next;
  const before = cloud.seen.length;
  const probe = await d.answer(await d.ask("/screener"));
  // A renewal the probe's 401 starts is the door's own request; the probe is the one product read.
  const asked = cloud.seen.slice(before).filter((r) => !r.startsWith("POST /auth/"));
  expect(asked, "the premise: the probe read was forwarded, and was the one request").toEqual(["GET /screener"]);
  return { d, cloud, probe, setMode: (m: CloudMode): void => { mode = m; } };
}

describe("the proxy's probe asks the mirror's question: only Cloud's own answer makes the door reachable", () => {
  it("a flapping outage: a probe Cloud answers 503 leaves the door offline, and the next move is held, uncounted", async () => {
    const { d, cloud, probe } = await probeAfterAFailedForward("outage");
    expect(probe, "the premise: the probe met Cloud's own 503").toEqual({ status: 503, code: "service_unavailable" });
    expect(await d.online(), "a 503 probe marked the door reachable in an outage").toBe(false);
    expect(await d.move("k-2"), "the next move was not held at the door").toEqual(HELD);
    expect(cloud.moves(), "a move reached Cloud during the outage, a counted failure").toBe(0);
  }, 30_000);

  it("the hosting platform's own 404 as the probe's answer leaves the door offline, and the next move is held", async () => {
    const { d, cloud, probe } = await probeAfterAFailedForward("edge-404");
    expect(probe.status, "the premise: the probe met the platform's page").toBe(404);
    expect(await d.online(), "the platform's 404 marked the door reachable").toBe(false);
    expect(await d.move("k-2"), "the next move was not held at the door").toEqual(HELD);
    expect(cloud.moves(), "a move reached the platform's 404, a final refusal").toBe(0);
  }, 30_000);

  it("a renewal fault: the probe's answer was built here, so the door stays offline", async () => {
    const { d, cloud, probe } = await probeAfterAFailedForward("renewal-fault");
    expect(probe, "the premise: the probe was answered by the door itself").toEqual(HELD);
    expect(await d.online(), "an answer built here marked the door reachable").toBe(false);
    expect(await d.move("k-2"), "the next move was not held at the door").toEqual(HELD);
    expect(cloud.moves(), "a move went out during the renewal fault").toBe(0);
  }, 30_000);

  it("the hosting platform's own 404 at every route: the first pull leaves the door offline, and a move is held", async () => {
    const cloud = cloudFor(() => "edge-404");
    const d = await composedDoor(cloud);
    await d.engine.start();
    expect(await d.online(), "the platform's 404 read as Cloud refusing").toBe(false);
    expect(await d.move("k-1"), "the move was not held at the door").toEqual(HELD);
    expect(cloud.moves(), "a move reached the platform's 404, a final refusal").toBe(0);
  }, 30_000);

  it("CONTROL: a probe Cloud answers, served or refused with our API's error body, makes the door reachable again", async () => {
    const refused = await probeAfterAFailedForward("refusing");
    expect(refused.probe, "the premise: Cloud refused the probe itself").toEqual({ status: 403, code: "forbidden" });
    expect(await refused.d.online(), "Cloud's own refusal left the door offline").toBe(true);
    const served = await probeAfterAFailedForward("up");
    expect(served.probe.status, "the premise: the probe was served").toBe(200);
    expect(await served.d.online(), "a served probe left the door offline").toBe(true);
    expect(await served.d.move("k-2"), "the next move was not forwarded").toEqual({ status: 200, code: null });
    expect(served.cloud.moves()).toBe(1);
  }, 30_000);
});

describe("with no live wake stream the poll follows the window, not a fixed 20 s", () => {
  /* The monotonic clock too: the person's request is measured against the last pull on it. */
  const monotonicClock = (): void => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }); };
  const HOUR_MS = 3_600_000;

  it("an idle hour asks at most 70 times, settling on a minute apart (a fixed 20 s asked 180)", async () => {
    const t = await standUp(undefined);
    monotonicClock();
    void t.mirror.start();
    await advance(HOUR_MS, 1_000);
    expect(t.cloud.asked.length).toBeLessThanOrEqual(70);
    within(gaps(t.cloud.asked).at(-1), 60_000, 2_000, "the idle poll did not settle on a minute");
  }, 60_000);

  it("a person's request after a quiet spell asks within a second, and the next pull is 8 s later", async () => {
    const t = await standUp(undefined);
    monotonicClock();
    void t.mirror.start();
    await advance(5 * 60_000, 1_000);
    const before = t.cloud.asked.length;
    t.mirror.personSeen();
    await advance(1_000, 50);
    expect(t.cloud.asked.length, "the window's request did not ask Cloud").toBe(before + 1);
    await advance(10_000, 250);
    expect(t.cloud.asked.length).toBe(before + 2);
    within(gaps(t.cloud.asked).at(-1), 8_000, 1_000, "the pull after a person's request was not 8 s later");
  }, 60_000);

  it("CONTROL: a live wake keeps the 20 s poll, and a person's request does not speed it up", async () => {
    const t = await standUp(undefined, () => true);
    monotonicClock();
    void t.mirror.start();
    await advance(2 * 60_000, 500);
    t.mirror.personSeen();
    await advance(60_000, 500);
    for (const gap of gaps(t.cloud.asked)) within(gap, DEFAULT_CLOUD_POLL_MS, 1_000, "a live wake's poll left 20 s");
  }, 60_000);
});
