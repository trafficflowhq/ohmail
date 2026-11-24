import type { MessageDTO, SyncResponse } from "@ohmail/wire";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine, StoreSearchWalker, type WindowSearchPhases } from "@ohmail/client-engine";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { createSidecarLog } from "../src/log.js";
import { WINDOW_SEARCH_PHASES_ROUTE, parseWindowSearchPhases } from "../src/window-report.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A PAIRED DESKTOP'S SEARCH IS TIMED IN ITS OWN ENGINE LOG, segment by segment. The relay writes
 * `search_relayed` (who answered, the account's round trip, its own `ms`, the door's total, the
 * arrival instant); the window writes `window_search_phases` through its door (debounce, send,
 * round trip, paint, the two instants). Both read back from the REAL logger over a fake sink, so a
 * field the allowlist drops is a red here and not a silent hole in a walk's table.
 */

const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
/** The fake account's own time for a search, slept before it answers. */
const ACCOUNT_MS = 40;
const iso = (): string => new Date().toISOString();

function dto(id: string): MessageDTO {
  return {
    id, accountId: ACCOUNT, mailboxId: MAILBOX, threadId: null, messageIdHeader: `<${id}@x.test>`, subject: "Heron census",
    from: { name: null, address: "heron@birds.test" }, to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "INBOX", snippet: "", unread: true, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}

const emptyPage = (since: string): SyncResponse => ({
  changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: since, hasMore: false, serverTime: iso(),
});

/** Called when the account is asked for a search page, before it answers: the request is in flight. */
let onPageAsked: (() => void) | null = null;

const hostedFetch = (async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const send = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  if (url.pathname === "/search") {
    if (url.searchParams.get("parts") === "page") onPageAsked?.();
    await new Promise((r) => setTimeout(r, ACCOUNT_MS));
    return url.searchParams.get("parts") === "estimate"
      ? send({ items: [], total: 9, totalExact: true, tier: "exact", ms: 3, nextCursor: null, bounded: false, facets: null })
      : send({ items: [dto(HOSTED)], total: 9, totalExact: true, tier: "exact", ms: 31, nextCursor: null, bounded: false, facets: null });
  }
  if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
  if (url.pathname === "/sync") return send(emptyPage(url.searchParams.get("since") ?? "0"));
  if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const lines: Array<Record<string, unknown>> = [];
const of = (event: string): Array<Record<string, unknown>> => lines.filter((l) => l.event === event);
let sidecar: CloudSidecar;
let dataDir: string;
// A Cloud door stands up in 6 to 9 s here; the 5 s default never fired while its pull held the loop.
beforeAll(async () => {
  dataDir = await freshDataDir("ohmail-search-phases-");
  sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" }, fetchImpl: hostedFetch, pollIntervalMs: 3_600_000,
    log: createSidecarLog({ sink: (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); } }),
  });
  await sidecar.start();
}, 30_000);
afterAll(async () => {
  await sidecar?.stop().catch(() => undefined);
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

const bearer = (): Record<string, string> => ({ authorization: `Bearer ${sidecar.sessionToken}` });
const post = (body: unknown, headers: Record<string, string> = bearer()): Promise<Response> =>
  sidecar.handle(new Request(`http://sidecar${WINDOW_SEARCH_PHASES_ROUTE}`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
  }));

const REPORT: WindowSearchPhases = {
  verdict: "matched", debounceMs: 251, sendMs: 0, roundTripMs: 190, paintMs: 12, totalMs: 453, serverMs: 31,
  sentAtMs: 1_790_000_000_000, answeredAtMs: 1_790_000_000_190,
};

describe("the relay's line: one per relayed search, every field through the real logger", () => {
  it("names the part, the account as the answerer, its round trip, its own ms and the arrival", async () => {
    lines.length = 0;
    const before = Date.now();
    const res = await sidecar.handle(new Request("http://sidecar/search?q=heron&parts=page&limit=50", { headers: bearer() }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: Array<{ id: string }> }).items.map((m) => m.id)).toEqual([HOSTED]);
    const [line] = of("search_relayed");
    expect(of("search_relayed")).toHaveLength(1);
    expect(line).toMatchObject({ level: "info", kind: "page", verdict: "account", status: 200, serverMs: 31 });
    expect(line!.droppedFields).toBeUndefined();
    expect(line!.accountMs as number).toBeGreaterThanOrEqual(ACCOUNT_MS - 5);
    expect(line!.totalMs as number).toBeGreaterThanOrEqual(line!.accountMs as number);
    expect(line!.receivedAtMs as number).toBeGreaterThanOrEqual(before);
    expect(line!.receivedAtMs as number).toBeLessThanOrEqual(Date.now());
    // The query is on no field of the line.
    expect(JSON.stringify(line)).not.toContain("heron");
  });
});

describe("the window's door: a closed record in, one line out", () => {
  it("a report is 204 and one window_search_phases line carrying every span and both instants", async () => {
    lines.length = 0;
    const res = await post(REPORT);
    expect(res.status).toBe(204);
    const [line] = of("window_search_phases");
    expect(line).toMatchObject({ level: "info", ...REPORT });
    expect(line!.droppedFields).toBeUndefined();
  });

  it("CONTROL: a field the door does not take refuses the whole body, and the line carries no content", async () => {
    lines.length = 0;
    const res = await post({ ...REPORT, query: "heron" });
    expect(res.status).toBe(400);
    expect(of("window_search_phases")).toHaveLength(0);
    expect(of("window_search_report_refused")).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain("heron");
  });

  it("CONTROL: without the launch bearer the door answers 401 and writes nothing", async () => {
    lines.length = 0;
    const res = await post(REPORT, {});
    expect(res.status).toBe(401);
    expect(of("window_search_phases")).toHaveLength(0);
  });

  it("the parser admits the ordinary report and refuses a span out of bound, a verdict it does not know, a clock that is not one", () => {
    expect(parseWindowSearchPhases(REPORT)).toEqual(REPORT);
    expect(parseWindowSearchPhases({ ...REPORT, serverMs: null })).toEqual({ ...REPORT, serverMs: null });
    expect(parseWindowSearchPhases({ ...REPORT, roundTripMs: -1 })).toHaveProperty("refused");
    expect(parseWindowSearchPhases({ ...REPORT, paintMs: 1.5 })).toHaveProperty("refused");
    expect(parseWindowSearchPhases({ ...REPORT, verdict: "found" })).toHaveProperty("refused");
    expect(parseWindowSearchPhases({ ...REPORT, sentAtMs: 5 })).toHaveProperty("refused");
  });
});

describe("the window measures one question and hands it to the door once", () => {
  it("through the window's own adapter, engine and walker: the debounce, the round trip, the account's ms", async () => {
    lines.length = 0;
    const adapter = new HttpAdapter({
      baseUrl: "http://sidecar",
      fetch: (url: string, init?: RequestInit) => sidecar.handle(new Request(url, {
        ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...bearer() },
      })),
      searchPhasesSink: async (record) => {
        const res = await post(record);
        expect(res.status).toBe(204);
      },
    });
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({ adapter, store });
    const walker = new StoreSearchWalker(engine);
    const inFlight = new Promise<void>((resolve) => { onPageAsked = resolve; });
    walker.start({ query: "heron" }, () => [], 30);
    walker.painted(); // before the debounce: nothing to report yet
    await inFlight;
    walker.painted(); // the page asked and not yet answered: still nothing
    onPageAsked = null;
    for (let i = 0; i < 300 && walker.info() === null; i++) await new Promise((r) => setTimeout(r, 5));
    expect(walker.info()).not.toBeNull();
    walker.painted();
    walker.painted(); // once per question
    for (let i = 0; i < 100 && of("window_search_phases").length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const phases = of("window_search_phases");
    expect(phases).toHaveLength(1);
    const p = phases[0]!;
    expect(p).toMatchObject({ verdict: "matched", serverMs: 31 });
    expect(p.debounceMs as number).toBeGreaterThanOrEqual(25);
    expect(p.roundTripMs as number).toBeGreaterThanOrEqual(ACCOUNT_MS - 5);
    expect(p.totalMs as number).toBeGreaterThanOrEqual((p.debounceMs as number) + (p.roundTripMs as number));
    // The two lines join: the relay received the page after the window sent it and before it answered.
    // A report taken before the answer would have carried no marks and been refused at the door.
    expect(of("window_search_report_refused")).toHaveLength(0);
    const relayed = of("search_relayed").find((l) => l.kind === "page")!;
    expect(relayed.receivedAtMs as number).toBeGreaterThanOrEqual(p.sentAtMs as number);
    expect(relayed.receivedAtMs as number).toBeLessThanOrEqual(p.answeredAtMs as number);
    walker.clear();
  });
});
