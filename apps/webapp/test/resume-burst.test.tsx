/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as shell from "./fixtures/cloud-confirm-shell";

/**
 * WEB-RESUME-BURST, THROUGH THE REAL `CloudShell`: every answer takes {@link LATENCY} ms and the
 * stream opens as late, so order and overlap on the wire are visible. A tab that comes back reads
 * the sync delta first and alone, then the rest a few at a time; the mount's burst leads with one
 * read. What is measured is order and concurrency, not instances (that is the platform's routing).
 */

const LATENCY = 400;
/** `resume-lane.ts`'s `LANE_SLOTS`, spelled here so a change to it is a change to this test. */
const SLOTS = 4;
/** perf-026: a fresh `GET /account/access` asks the entitlements program, p50 283 ms; its sibling reads 51-67 ms. */
const ACCESS_MS = 283;
const SIBLING_MS = 60;
/** The reads a delta naming a new letter and a rule rings; slow, they hold the lane's background slots. */
const SCREENER_READS = ["/api/screener", "/api/screener/held-releases", "/api/screener/unscreened", "/api/consent"];
const SLOW_SCREENER_MS = 1_500;

interface Rec { method: string; path: string; query: string; prio: string; start: number; end: number | null }
let log: Rec[] = [];
let dials: number[] = [];
let visibility: DocumentVisibilityState = "visible";
let syncNext: (() => Promise<Response> | Response) | null = null;
let accessAnswer: () => Response;
let syncWall = false;
let seq = 10;
/** How long the API takes to answer `path`; {@link LATENCY} unless a case says otherwise. */
let latencyOf: (path: string) => number = () => LATENCY;
/** The letter the last {@link ohboxDelta} brought. */
let newId = "";

class FakeEventSource {
  readyState = 0;
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(readonly url: string) {
    dials.push(Date.now());
    setTimeout(() => {
      if (this.readyState !== 0) return;
      this.readyState = 1;
      this.fire("open");
      this.fire("ready");
    }, LATENCY);
  }
  addEventListener(type: string, l: () => void): void {
    const set = this.listeners.get(type) ?? new Set<() => void>();
    set.add(l);
    this.listeners.set(type, set);
  }
  close(): void { this.readyState = 2; }
  private fire(type: string): void { for (const l of [...(this.listeners.get(type) ?? [])]) l(); }
}

const OPEN = { metered: true, access: "open", canAddMailbox: true, mailboxes: 1, aiEnabled: true };
const CLOSED = {
  metered: true, access: "refused", canAddMailbox: false, mailboxes: 0, aiEnabled: false,
  lifecycle: {
    state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
    closedAt: "2026-08-25T00:00:00.000Z", erasureAt: "2026-10-23T00:00:00.000Z",
    erasedAt: null, formerlyPaid: false,
  },
  manageUrl: "https://plane.ohmail.app/manage?token=t", exportPath: "/account/export",
};
const jsonOf = (b: unknown, status = 200): Response =>
  new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const refused402 = (): Response => jsonOf({
  error: { code: "subscription_required", message: "not active", details: { reason: "payment_required", lifecycle: CLOSED.lifecycle } },
}, 402);

/** A delta naming a new letter at the gate and a settings change: the surfaces it names re-read. */
function changedDelta(): Response {
  seq += 2;
  const id = `m_new_${seq}`;
  const at = new Date().toISOString();
  return jsonOf({
    changes: {
      creates: [{
        type: "message", op: "create", id, seq, updatedAt: shell.ISO,
        entity: {
          id, accountId: shell.ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
          subject: "new at the gate", from: { name: "Stranger", address: `${id}@example.invalid` },
          to: [], cc: [], date: shell.ISO, folder: "ohmail/Screener", snippet: "s", unread: true,
          hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
          remoteContent: "none", updatedAt: shell.ISO,
        },
      }],
      updates: [{ type: "settings", op: "update", id: "settings", seq: seq + 1, updatedAt: at, entity: { id: "settings", updatedAt: at } }],
      moves: [], deletes: [],
    },
    cursor: `c${seq}`, hasMore: false, serverTime: shell.ISO,
  });
}

/** A letter filed to the Ohbox by its sender's rule, which arrives in the same delta and rings the Screener. */
function ohboxDelta(): Response {
  seq += 2;
  const id = `m_new_${seq}`;
  newId = id;
  const address = `known_${seq}@example.invalid`;
  return jsonOf({
    changes: {
      creates: [
        {
          type: "rule", op: "create", id: `rule_${address}`, seq, updatedAt: shell.ISO,
          entity: {
            id: `rule_${address}`, kind: "sender", match: address, destination: "INBOX",
            priority: 0, provenance: "seeded-from-sent", enabled: true,
            stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: shell.ISO, updatedAt: shell.ISO,
          },
        },
        {
          type: "message", op: "create", id, seq: seq + 1, updatedAt: shell.ISO,
          entity: {
            id, accountId: shell.ACCOUNT, mailboxId: "mb_1", threadId: null, messageIdHeader: null,
            subject: "new in the ohbox", from: { name: "Known", address },
            to: [], cc: [], date: new Date().toISOString(), folder: "INBOX", snippet: "s", unread: true,
            hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
            remoteContent: "none", updatedAt: shell.ISO,
          },
        },
      ],
      updates: [], moves: [], deletes: [],
    },
    cursor: `c${seq}`, hasMore: false, serverTime: shell.ISO,
  });
}

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(async () => {
  (await import("../app/api-client")).forgetAccess();
  shell.installConfirmEnv();
  shell.scriptSession(() => shell.sessionFull());
  shell.scriptRefresh(shell.refresh204);
  shell.rememberOwner(shell.ACCOUNT);
  localStorage.clear();
  sessionStorage.clear();
  dials = [];
  log = [];
  syncNext = null;
  syncWall = false;
  newId = "";
  latencyOf = () => LATENCY;
  accessAnswer = () => jsonOf(OPEN);
  vi.stubGlobal("EventSource", FakeEventSource);
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  const base = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input), "https://ohmail.app");
    const rec: Rec = {
      method: init?.method ?? "GET", path: url.pathname, query: url.search,
      prio: String((init as { priority?: string } | undefined)?.priority ?? ""), start: Date.now(), end: null,
    };
    log.push(rec);
    try {
      await new Promise((r) => setTimeout(r, latencyOf(rec.path)));
      const p = rec.path;
      if (p === "/api/messages/bodies") {
        const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
        return jsonOf({ items: ids.map((messageId) => ({ messageId, text: `body of ${messageId}`, html: null })) });
      }
      const one = /^\/api\/messages\/([^/]+)\/body$/.exec(p);
      if (one) return jsonOf({ text: `body of ${decodeURIComponent(one[1]!)}`, html: null });
      if (p.endsWith("/account/access")) return accessAnswer();
      if (p.endsWith("/screener/held-releases")) return jsonOf({ groups: [], senders: [], total: 0, max: 50, fingerprint: "", dismissed: false });
      if (p.endsWith("/screener/unscreened")) return jsonOf({ groups: [], total: 0, max: 50 });
      if (p.endsWith("/screener")) return jsonOf({ items: [], nextCursor: null, total: 0, inFlight: [] });
      if (p.endsWith("/organizer-requests")) return jsonOf({ items: [] });
      if (p.endsWith("/messages/timeline")) return jsonOf({ total: 0, months: [], undated: 0 });
      if (p.endsWith("/away-responder")) return jsonOf({ active: false });
      if (p.endsWith("/account/ai")) return jsonOf({ aiEnabled: true });
      if ((p === "/api/sync" || p === "/api/mailboxes") && syncWall) return refused402();
      if (p === "/api/sync" && syncNext !== null) { const next = syncNext; syncNext = null; return await next(); }
      return await base(input as RequestInfo, init);
    } finally {
      rec.end = Date.now();
    }
  }) as unknown as typeof globalThis.fetch;
}, 60_000);
afterEach(async () => {
  await shell.teardownConfirmEnv();
  vi.unstubAllGlobals();
}, 60_000);

/** API requests from `from` on; the web host's own `/version` is not one. */
const since = (from: number): Rec[] =>
  log.filter((r) => r.start >= from && (r.path.startsWith("/api/") || r.path.startsWith("/auth/")));
const reads = (rows: Rec[]): Rec[] => rows.filter((r) => r.method === "GET");
const isSync = (r: Rec): boolean => r.method === "GET" && r.path === "/api/sync";

/** The most GETs on the wire at once (the free renewal is not a lane read). */
function peak(rows: Rec[]): number {
  const ev: Array<[number, number]> = [];
  for (const r of reads(rows)) { ev.push([r.start, 1]); ev.push([r.end ?? Number.POSITIVE_INFINITY, -1]); }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let top = 0;
  for (const [, d] of ev) { cur += d; top = Math.max(top, cur); }
  return top;
}

const show = (rows: Rec[], from: number): string =>
  rows.map((r) => `+${r.start - from}..+${(r.end ?? NaN) - from} ${r.method} ${r.path}${r.path.includes("/messages/") ? r.query : ""}`
    + (r.prio ? ` [${r.prio}]` : "")).join("\n");

/** A read of `id`'s body, alone or in a batch. */
const isBodyOf = (r: Rec, id: string): boolean => r.path === `/api/messages/${id}/body`
  || (r.path === "/api/messages/bodies" && (new URLSearchParams(r.query).get("ids") ?? "").split(",").includes(id));

/** Step the clock `step` ms at a time until `seen()`; ms from `from` when seen, or -1 past `max`. */
async function until(seen: () => boolean, from: number, max: number, step = 25): Promise<number> {
  for (let t = 0; t <= max; t += step) {
    if (seen()) return Date.now() - from;
    await shell.act(async () => {
      await vi.advanceTimersByTimeAsync(step);
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    });
  }
  return -1;
}

async function mountAndSettle(): Promise<void> {
  await shell.mountCloudShell();
  await shell.tick(30_000);
  expect(document.body.querySelector(".app-root"), "the premise: the mail opened").not.toBeNull();
}

/** Hide for `ms`, then come back as a browser does: visible, then focus. Returns the return's time. */
async function pauseAndReturn(ms: number, before?: () => void): Promise<number> {
  await shell.act(async () => { setVisibility("hidden"); });
  await shell.tick(ms);
  before?.();
  const back = Date.now();
  await shell.act(async () => {
    setVisibility("visible");
    window.dispatchEvent(new Event("focus"));
  });
  return back;
}

/** The surfaces a delta decides: re-read only when it names a change. */
const DELTA_DRIVEN = ["/api/screener", "/api/screener/held-releases", "/api/screener/unscreened", "/api/consent",
  "/api/organizer-requests", "/api/messages/timeline"];

describe("a web tab's mount and its return, on the wire", () => {
  it("MOUNT: the first API read goes alone, then at most four at once, and every read still happens", { timeout: 120_000 }, async () => {
    const t0 = Date.now();
    await mountAndSettle();
    const rows = since(t0);
    const first = rows[0]!;
    const beside = rows.slice(1).filter((r) => r.start < first.end!);
    expect(beside, `went beside the first read:\n${show(rows, t0)}`).toEqual([]);
    expect(peak(rows), show(rows, t0)).toBeLessThanOrEqual(SLOTS);
    const paths = new Set(reads(rows).map((r) => r.path));
    for (const p of ["/api/hello", "/api/account/access", "/api/account/ai", "/api/auth/session", "/api/organizer-requests",
      "/api/consent", "/api/screener", "/api/screener/held-releases", "/api/screener/unscreened", "/api/away-responder",
      "/api/mailboxes", "/api/messages/timeline", "/api/sync"]) {
      expect(paths.has(p), `${p} was never read:\n${show(rows, t0)}`).toBe(true);
    }
  });

  it("RETURN AFTER 2 MIN: GET /sync goes first and alone, and the stream is dialled after its answer", { timeout: 120_000 }, async () => {
    await mountAndSettle();
    const back = await pauseAndReturn(2 * 60_000);
    await shell.tick(6_000);
    const rows = since(back);
    expect(rows.length, "the premise: the return read something").toBeGreaterThan(0);
    const first = rows[0]!;
    expect(isSync(first), show(rows, back)).toBe(true);
    expect(rows.slice(1).filter((r) => r.start < first.end!), `went beside the delta:\n${show(rows, back)}`).toEqual([]);
    const dial = dials.filter((d) => d >= back);
    expect(dial.length, "the return dialled no stream").toBe(1);
    expect(dial[0]!, `the stream was dialled before the delta answered:\n${show(rows, back)}`).toBeGreaterThanOrEqual(first.end!);
    expect(peak(rows)).toBeLessThanOrEqual(SLOTS);
  });

  it("RETURN AFTER 20 MIN: the owed renewal goes alone, then at most four reads at once", { timeout: 120_000 }, async () => {
    await mountAndSettle();
    const back = await pauseAndReturn(20 * 60_000);
    await shell.tick(6_000);
    const rows = since(back);
    const first = rows[0]!;
    expect(`${first.method} ${first.path}`, show(rows, back)).toBe("POST /auth/refresh");
    expect(rows.slice(1).filter((r) => r.start < first.end!), `went beside the renewal:\n${show(rows, back)}`).toEqual([]);
    expect(rows.some(isSync), "the return read no delta").toBe(true);
    expect(peak(rows), show(rows, back)).toBeLessThanOrEqual(SLOTS);
  });

  it("an UNCHANGED delta re-reads none of the surfaces a delta decides", { timeout: 120_000 }, async () => {
    await mountAndSettle();
    const back = await pauseAndReturn(2 * 60_000);
    await shell.tick(6_000);
    const rows = since(back);
    expect(rows.some(isSync)).toBe(true);
    expect(rows.filter((r) => DELTA_DRIVEN.includes(r.path)), show(rows, back)).toEqual([]);
  });

  it("CONTROL — a CHANGED delta re-reads what it names, each read after the delta answered", { timeout: 120_000 }, async () => {
    await mountAndSettle();
    const back = await pauseAndReturn(2 * 60_000, () => { syncNext = changedDelta; });
    await shell.tick(6_000);
    const rows = since(back);
    const sync = rows.find(isSync)!;
    const named = rows.filter((r) => DELTA_DRIVEN.includes(r.path));
    expect(named.length, `the changed delta re-read nothing:\n${show(rows, back)}`).toBeGreaterThan(0);
    expect(named.every((r) => r.start >= sync.end!), show(rows, back)).toBe(true);
    expect(peak(rows), show(rows, back)).toBeLessThanOrEqual(SLOTS);
  });

  it("a FAILED delta does not hold the rest", { timeout: 120_000 }, async () => {
    await mountAndSettle();
    const back = await pauseAndReturn(2 * 60_000, () => { syncNext = () => { throw new TypeError("Failed to fetch"); }; });
    await shell.tick(6_000);
    const rows = since(back);
    const session = rows.find((r) => r.path === "/api/auth/session");
    expect(session, show(rows, back)).toBeDefined();
    expect(session!.start - back, show(rows, back)).toBeLessThanOrEqual(LATENCY);
  });

  it("a HUNG delta holds the rest no longer than three seconds", { timeout: 120_000 }, async () => {
    await mountAndSettle();
    const back = await pauseAndReturn(2 * 60_000, () => {
      syncNext = () => new Promise<Response>((r) => setTimeout(() => r(jsonOf({
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c0", hasMore: false, serverTime: shell.ISO,
      })), 20_000));
    });
    await shell.tick(6_000);
    const rows = since(back);
    const session = rows.find((r) => r.path === "/api/auth/session");
    expect(session, show(rows, back)).toBeDefined();
    expect(session!.start - back, show(rows, back)).toBeLessThanOrEqual(3_000);
  });

  it("MOUNT: the session confirm goes with the first wave after the lead, and the first mail shows four answers in", { timeout: 120_000 }, async () => {
    // A fresh session, so no renewal is owed and the chain is the same whatever ran before.
    const { SESSION_MINTED_KEY } = await import("../app/session-refresh");
    localStorage.setItem(SESSION_MINTED_KEY, String(Date.now()));
    syncNext = () => shell.syncPage("First mail on mount");
    const t0 = Date.now();
    await shell.mountCloudShell();
    const seen = await until(() => (document.body.textContent ?? "").includes("First mail on mount"), t0, 10_000);
    const rows = since(t0);
    const lead = rows[0]!;
    const confirm = rows.find((r) => r.path === "/api/auth/session");
    expect(confirm, show(rows, t0)).toBeDefined();
    // The confirm gates the delta: background reads that entered before it must not hold it.
    expect(confirm!.start, `the confirm waited behind background reads:\n${show(rows, t0)}`).toBeLessThanOrEqual(lead.end!);
    expect(seen, "the first mail never showed").toBeGreaterThanOrEqual(0);
    expect(seen, show(rows, t0)).toBeLessThanOrEqual(4 * LATENCY);
  });

  it("a read the person asks for in the window after a return goes on the wire at once", { timeout: 120_000 }, async () => {
    await mountAndSettle();
    const back = await pauseAndReturn(2 * 60_000, () => { syncNext = changedDelta; });
    await until(() => Date.now() - back >= LATENCY + 50, back, 1_000);
    const { sessionFetch } = await import("../app/shell/session-truth");
    const askedAt = Date.now();
    // What the engine sends for an open: `priority: "high"` (`person-read-priority.test.ts`).
    const read = sessionFetch("/api/messages/m_opened/body", { priority: "high" });
    await shell.tick(2_000);
    await read.catch(() => undefined);
    const rows = since(back);
    const rec = rows.find((r) => r.path === "/api/messages/m_opened/body");
    expect(rec, show(rows, back)).toBeDefined();
    expect(rows.filter((r) => r.start < askedAt && r.end! > askedAt).length, `the premise: the window was busy:\n${show(rows, back)}`)
      .toBeGreaterThanOrEqual(SLOTS - 1);
    expect(rec!.start - askedAt, show(rows, back)).toBe(0);
  });

  it("with the account wall up, the access read on return is not held",{ timeout: 120_000 }, async () => {
    const { RETURN_DEBOUNCE_MS } = await import("../app/shell/wall-lift");
    await mountAndSettle();
    syncWall = true;
    accessAnswer = () => jsonOf(CLOSED);
    await shell.tick(75_000);
    expect(document.body.querySelector(".wall-card"), "the premise: the wall stands").not.toBeNull();
    const back = await pauseAndReturn(Math.max(2 * 60_000, RETURN_DEBOUNCE_MS));
    await shell.tick(3_000);
    const rows = since(back);
    const access = rows.find((r) => r.path === "/api/account/access");
    expect(access, show(rows, back)).toBeDefined();
    // No drain under the wall, so no reservation for a delta that never comes: the access read waits
    // at most for the cold lead's one answer, never the lane's three-second bound.
    expect(rows.filter(isSync), show(rows, back)).toEqual([]);
    expect(access!.start - back, show(rows, back)).toBeLessThanOrEqual(LATENCY);
  });

  it("MOUNT WITH A STORED OPEN VERDICT: the session confirm leads; the slow access read holds neither the first mail nor the stream", { timeout: 120_000 }, async () => {
    const { SESSION_MINTED_KEY } = await import("../app/session-refresh");
    localStorage.setItem(SESSION_MINTED_KEY, String(Date.now()));
    // What a reload of an open account finds (`noteVerdict` stores it on every open answer): the
    // first paint asks nothing, and the first read to reach the lane is the subscription offer's.
    localStorage.setItem(`ohmail.access.${shell.ACCOUNT}`, "open");
    latencyOf = (p) => (p === "/api/account/access" ? ACCESS_MS : SIBLING_MS);
    syncNext = () => shell.syncPage("First fresh mail");
    const t0 = Date.now();
    await shell.mountCloudShell();
    const seen = await until(() => (document.body.textContent ?? "").includes("First fresh mail"), t0, 10_000, 10);
    await shell.tick(6_000);
    const rows = since(t0);
    const confirm = rows.find((r) => r.path === "/api/auth/session");
    expect(confirm, show(rows, t0)).toBeDefined();
    expect(confirm!.start - t0, `the confirm waited:\n${show(rows, t0)}`).toBe(0);
    // Main without the lane, same case: the confirm, the snapshot probe and the delta take one sibling
    // answer each, so the first mail shows at +180; the stream is dialled at the confirm's answer, +60.
    expect(seen, "the first mail never showed").toBeGreaterThanOrEqual(0);
    expect(seen, `the first mail waited:\n${show(rows, t0)}`).toBeLessThanOrEqual(3 * SIBLING_MS);
    const dial = dials.find((d) => d >= t0);
    expect(dial, "no stream was dialled").toBeDefined();
    expect(dial! - t0, `the stream waited:\n${show(rows, t0)}`).toBeLessThanOrEqual(SIBLING_MS);
    expect(peak(rows), show(rows, t0)).toBeLessThanOrEqual(SLOTS);
  });

  it("an open of the new letter while the Screener's reads fill the lane: its own read leaves in the same task, priority high", { timeout: 120_000 }, async () => {
    await mountAndSettle();
    const back = await pauseAndReturn(2 * 60_000, () => {
      syncNext = ohboxDelta;
      latencyOf = (p) => (SCREENER_READS.includes(p) ? SLOW_SCREENER_MS : LATENCY);
    });
    const rowOf = (): HTMLElement | null =>
      (newId === "" ? null : document.querySelector<HTMLElement>(`.row[data-id="${newId}"]`));
    expect(await until(() => rowOf() !== null, back, 5_000), "the premise: the new letter is on screen").toBeGreaterThanOrEqual(0);
    // The drain settled and the eager pass asked the new letter's body: a background read.
    await shell.tick(100);
    const clickAt = Date.now();
    const before = since(back);
    const busy = before.filter((r) => r.method === "GET" && !isSync(r) && r.start <= clickAt && (r.end ?? Infinity) > clickAt);
    expect(busy.length, `the premise: background reads fill the lane's slots:\n${show(before, back)}`)
      .toBeGreaterThanOrEqual(SLOTS - 1);
    expect(before.filter((r) => isBodyOf(r, newId) && r.end !== null), "the premise: no read of its body has answered")
      .toEqual([]);
    await shell.act(async () => { rowOf()!.click(); });
    const rows = since(back);
    const own = rows.find((r) => isBodyOf(r, newId) && r.prio === "high");
    expect(own, `the open sent no read of its own:\n${show(rows, back)}`).toBeDefined();
    expect(own!.start, show(rows, back)).toBe(clickAt);
    const shown = await until(() => (document.body.textContent ?? "").includes(`body of ${newId}`), clickAt, 4_000);
    expect(shown, `the body never showed:\n${show(since(back), back)}`).toBeGreaterThanOrEqual(0);
    expect(shown, show(since(back), back)).toBeLessThanOrEqual(LATENCY + 25);
  });
});
