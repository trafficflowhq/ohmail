/** @vitest-environment jsdom */
/**
 * THE RESUME LANE AT THE TWO API DOORS: a read the lane held never leaves on another account's
 * jar (#9), whichever door it came through; and every browser request in the web app is a lane
 * door or is named here as exempt, with the reason.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let sent: string[] = [];
let holdLead: (() => void) | null = null;

async function load() {
  vi.resetModules();
  const truth = await import("../app/shell/session-truth");
  const client = await import("../app/api-client");
  await import("../app/session-refresh");
  client.bindApiOwner("acct_A");
  return { truth, client };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-20T08:00:00.000Z"));
  sent = [];
  holdLead = null;
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = "tf_csrf=c0; Path=/";
  window.localStorage.clear();
  // A fresh session: no renewal is due, so nothing but the lane holds a request here.
  window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  let chain: Promise<unknown> = Promise.resolve();
  Object.defineProperty(globalThis.navigator, "locks", {
    configurable: true,
    value: {
      request: (_n: string, _o: unknown, cb: () => Promise<unknown>) => {
        const run = chain.then(() => cb());
        chain = run.then(() => undefined, () => undefined);
        return run;
      },
    },
  });
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    sent.push(url);
    // The first read leads a cold lane; it answers when the case says so.
    if (url === "/api/mailboxes") return new Promise<Response>((r) => { holdLead = () => r(json(200, { items: [] })); });
    return json(200, {});
  }) as unknown as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  const { resetSessionTruthForTests } = await import("../app/shell/session-truth");
  resetSessionTruthForTests();
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  Reflect.deleteProperty(document as unknown as Record<string, unknown>, "visibilityState");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#9: a read held in the lane while another tab signs in as somebody else never leaves", () => {
  it("through `api()` and through the engine's transport", async () => {
    const { truth, client } = await load();
    const lead = client.api("/mailboxes");
    await flush();
    expect(sent, "the premise: the cold lane's first read leads").toEqual(["/api/mailboxes"]);
    const read = client.api("/consent").then(() => "answered", (e: unknown) => e);
    const page = truth.sessionFetch("/api/messages/m1/body");
    await flush();
    expect(sent, "the premise: both reads wait in the lane").toEqual(["/api/mailboxes"]);
    // Another tab signs in to B while they wait.
    document.cookie = "tf_owner=acct_B; Path=/";
    holdLead!();
    await flush();
    await lead.catch(() => undefined);
    const [readOut, pageOut] = await Promise.all([read, page]);
    expect(sent, "a held read left on another account's jar").toEqual(["/api/mailboxes"]);
    expect(readOut).toMatchObject({ code: "owner_mismatch" });
    expect(pageOut.status).not.toBe(200);
  });

  it("CONTROL — the same reads, the jar unchanged: both leave once the lead answers", async () => {
    const { truth, client } = await load();
    const lead = client.api("/mailboxes");
    await flush();
    const read = client.api("/consent");
    const page = truth.sessionFetch("/api/messages/m1/body");
    await flush();
    expect(sent).toEqual(["/api/mailboxes"]);
    holdLead!();
    await lead;
    await read;
    expect((await page).status).toBe(200);
    expect(sent.sort()).toEqual(["/api/consent", "/api/mailboxes", "/api/messages/m1/body"]);
  });
});

describe("a read the person asked for is not held by a full window", () => {
  /** A cold lead, answered; then three background reads that hang fill the slots they may take. */
  async function fullWindow() {
    const loaded = await load();
    const lead = loaded.client.api("/mailboxes");
    await flush();
    holdLead!();
    await lead;
    for (const n of [1, 2, 3, 4]) void loaded.client.api(`/hold/${n}`).catch(() => undefined);
    await flush();
    expect(sent, "the premise: three background reads in flight, the fourth held")
      .toEqual(["/api/mailboxes", "/api/hold/1", "/api/hold/2", "/api/hold/3"]);
    // The kept slot goes to the session read, so every slot is taken.
    void loaded.client.api("/auth/session", { ceremony: true }).catch(() => undefined);
    await flush();
    expect(sent.at(-1)).toBe("/api/auth/session");
    return loaded;
  }

  beforeEach(() => {
    const base = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/hold/") || url === "/api/auth/session") {
        sent.push(url);
        return new Promise<Response>(() => {});
      }
      return base(input as RequestInfo, init);
    }) as unknown as typeof fetch;
  });

  it("through the engine's transport: a read marked high priority (an open, an attachment, a search)", async () => {
    const { truth } = await fullWindow();
    void truth.sessionFetch("/api/messages/m1/body", { priority: "high" });
    await flush();
    expect(sent.at(-1)).toBe("/api/messages/m1/body");
  });

  it("through `api()`: a search of Junk and the settings export", async () => {
    const { client } = await fullWindow();
    void client.screener.junkSearch("invoice");
    void client.account.exportSettings();
    await flush();
    expect(sent.slice(-2)).toEqual(["/api/screener/junk/search?q=invoice", "/api/account/export"]);
  });

  it("CONTROL — the same reads unmarked wait for a slot", async () => {
    const { truth, client } = await fullWindow();
    const before = sent.length;
    void truth.sessionFetch("/api/messages/m1/body");
    void client.api("/consent");
    await flush();
    expect(sent.length).toBe(before);
  });
});

/**
 * THE CENSUS. Every place browser code in `apps/webapp/app` starts a request or a stream, by file
 * and count. A new one fails here until it is a lane door or named exempt with its reason.
 */
const DOORS: Record<string, { count: number; why: string }> = {
  "api-client.ts": { count: 3, why: "the two lane doors: `api()`'s attempt and the transport's first send; the transport's retry after a renewal is not admitted again" },
  "session-refresh.ts": { count: 2, why: "exempt: the renewal writes the session cookies, so it never waits; its answer is reported (`noteAnswer`). And the cache purge after a refusal, a confirmed sign-out or an erase (`purgeSiteCache`): it reads no session, and nothing waits for it" },
  "shell/session-truth.ts": { count: 1, why: "exempt: the fallback when no transport is registered (no `api-client` loaded, the desktop)" },
  "shell/engine-config.ts": { count: 1, why: "exempt: the wake stream; on a return the scheduler dials it after the delta's lead (`afterLead`)" },
  "shell/build-watch.ts": { count: 1, why: "exempt: `/version` is the web host's own, off the API base" },
  "shell/lazy-view.tsx": { count: 1, why: "exempt: a HEAD on the web host's own build chunk (/_next/static/, same origin, off the API base) to tell a replaced build from a dropped connection; it reads no session and nothing waits for it beyond its 5 s timeout" },
  "session-gate.ts": { count: 1, why: "exempt: server side (the sign-in gate's route)" },
  "manage-handoff.ts": { count: 1, why: "exempt: server side (the manage route's handoff)" },
};

const APP = join(__dirname, "../app");
const REQUEST = /(?<![\w.$])fetch\s*\(|\?\?\s*fetch\b|\?\s*fetch\s*:|globalThis\.fetch\s*\(|window\.fetch\s*\(|new\s+EventSource\s*\(|new\s+XMLHttpRequest\s*\(|new\s+WebSocket\s*\(|sendBeacon\s*\(/g;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

describe("the lane census", () => {
  it("every browser request in the web app is a lane door or named exempt", () => {
    const found: Record<string, number> = {};
    for (const file of sources(APP)) {
      const n = (code(readFileSync(file, "utf8")).match(REQUEST) ?? []).length;
      if (n > 0) found[relative(APP, file).split("\\").join("/")] = n;
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(DOORS).map(([f, d]) => [f, d.count])));
  });

  it("CONTROL — the scan finds a request it was not told about", () => {
    const planted = "const r = await fetch(`/api/x`); const s = new EventSource('/e');";
    expect((code(planted).match(REQUEST) ?? []).length).toBe(2);
  });
});
