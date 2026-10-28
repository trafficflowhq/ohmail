/** @vitest-environment jsdom */
/**
 * A WAIT FOR A RENEWAL NEVER CHANGES WHICH ACCOUNT A REQUEST REACHES (HIGH-1).
 *
 * Tab 2 signs in as B while tab 1's renewal queues behind its lock; tab 1's engine requests were
 * held for that renewal and then sent on B's jar, applied on B, and retried on A. Two accounts here:
 * a request carries the jar's session AT SEND, is refused 401 off its access generation, 403 when a
 * write's CSRF is not its session's, and is otherwise APPLIED under that session's account. The real
 * api-client, refresh, transport, sync gate and HttpAdapter; only fetch, the jar and the lock are
 * faked. The invariant: every press is applied on A exactly once and never on B.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const MIN = 60_000;
const ARRIVE = 20;
const R_ARRIVE = 10;

type Acct = "A" | "B";
interface Sent {
  at: number; url: string; method: string; status: number | null; csrf: string | null; key: string | null;
  account: Acct | null; appliedAs?: Acct;
}
let sent: Sent[] = [];
let applied: { account: Acct; url: string; key: string | null; at: number }[] = [];
let jar: { account: Acct | null; access: number } = { account: "A", access: 0 };
const serverAccess: Record<Acct, number> = { A: 0, B: 0 };
let refreshMode: "ok" | "refused" | "hang" = "ok";

const csrfOf = (a: Acct, g: number): string => `csrf-${a}${g}`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function later<T>(ms: number, fn: () => T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(fn()), ms));
}

function setJar(account: Acct | null, access: number): void {
  jar = { account, access };
  if (account === null) {
    document.cookie = "tf_owner=; Path=/; Max-Age=0";
    document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  } else {
    document.cookie = `tf_owner=acct_${account}; Path=/`;
    document.cookie = `tf_csrf=${csrfOf(account, access)}; Path=/`;
  }
}

function serve(url: string, init?: RequestInit): Promise<Response> {
  const h = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)
    .map(([k, v]) => [k.toLowerCase(), v]));
  const method = (init?.method ?? "GET").toUpperCase();
  // The cache purge after a refusal presents nothing: not a request this file counts.
  if (h["x-ohmail-clear"] !== undefined) return Promise.resolve(new Response(null, { status: 202 }));
  const carried = { ...jar };
  const row: Sent = {
    at: Date.now(), url, method, status: null, csrf: h["x-csrf-token"] ?? null, key: h["idempotency-key"] ?? null,
    account: carried.account,
  };
  sent.push(row);
  if (url === "/auth/refresh") {
    if (refreshMode === "hang") return new Promise<Response>(() => {});
    if (refreshMode === "refused") {
      return later(2 * R_ARRIVE, () => {
        setJar(null, 0);
        row.status = 401;
        return json(401, { error: { code: "refresh_revoked", message: "invalid refresh token" } });
      });
    }
    return later(R_ARRIVE, () => {
      const a = carried.account!;
      serverAccess[a] += 1;
      return serverAccess[a];
    }).then((g) => later(R_ARRIVE, () => {
      setJar(carried.account, g);
      row.status = 204;
      return new Response(null, { status: 204 });
    }));
  }
  if (url === "/auth/refresh/logout") {
    return later(ARRIVE, () => {
      setJar(null, 0);
      row.status = 204;
      return new Response(null, { status: 204 });
    });
  }
  return later(ARRIVE, () => {
    let res: Response;
    if (carried.account === null || carried.access !== serverAccess[carried.account]) {
      res = json(401, { error: { code: "unauthorized", message: "authentication required" } });
    } else if (method !== "GET" && row.csrf !== csrfOf(carried.account, carried.access)) {
      res = json(403, { error: { code: "csrf_failed", message: "csrf validation failed" } });
    } else {
      applied.push({ account: carried.account, url, key: row.key, at: Date.now() });
      row.appliedAs = carried.account;
      res = json(200, {});
    }
    row.status = res.status;
    return res;
  }).then((res) => later(ARRIVE, () => res));
}

async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5) {
    await vi.advanceTimersByTimeAsync(Math.min(5, left));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
}

let chain: Promise<unknown> = Promise.resolve();
/** Another tab's cookie-writing ceremony takes the cross-tab lock; returns its release. */
function otherTabHoldsLock(): () => void {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  chain = chain.then(() => held);
  return release;
}

async function load() {
  vi.resetModules();
  const truth = await import("../app/shell/session-truth");
  const client = await import("../app/api-client");
  await import("../app/session-refresh");
  client.bindApiOwner("acct_A");
  return { truth, client };
}

const refreshCount = (): number => sent.filter((s) => s.url === "/auth/refresh").length;
const onB = (): string[] => applied.filter((a) => a.account === "B").map((a) => `${a.url} key=${a.key}`);
const onA = (url: string): number => applied.filter((a) => a.account === "A" && a.url === url).length;
/** Tab 2 signs out of B and tab 1's account signs in again: the jar names A, at its current generation. */
const backToA = (): void => setJar("A", serverAccess.A);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-04T08:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  sent = [];
  applied = [];
  serverAccess.A = 0;
  serverAccess.B = 0;
  refreshMode = "ok";
  window.localStorage.clear();
  setJar("A", 0);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  chain = Promise.resolve();
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
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => serve(String(input), init)) as unknown as typeof fetch;
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

const press = (url: string, key: string, body = "{}") => (truth: { sessionFetch: (u: string, i?: RequestInit) => Promise<Response> }) =>
  truth.sessionFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key, "x-csrf-token": csrfOf("A", 0) },
    body,
  });

/**
 * The engine keeps an answer nobody judged (`not_signed_in`) and sends it again under its key once its
 * account holds; a 2xx is final. Kept with the account switch's own sentence, never the renewal fault's.
 */
async function keptAndResent(res: Response, again: () => Promise<Response>): Promise<void> {
  if (res.ok) return;
  const { error } = (await res.json()) as { error: { code: string; message: string; retryable: boolean } };
  expect([res.status, error.code, error.retryable], "a held request was not kept for retry").toEqual([409, "not_signed_in", true]);
  expect(error.message, "the account switch said the renewal fault's sentence").toMatch(/^Another tab signed in to a different account\./);
  backToA();
  const second = again();
  await advance(200);
  expect((await second).status).toBe(200);
}

describe("another tab signs in as B while this tab's requests wait for A's renewal", () => {
  it("80% — a triage press held for the queued renewal is never applied on B, and is applied on A once", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const { truth, client } = await load();
    truth.markSessionAlive();
    await advance(12 * MIN - 50);
    const releaseTab2 = otherTabHoldsLock();
    await advance(60);
    const triage = press("/api/messages/m1/triage", "k1");
    const held = triage(truth);
    const write = client.api("/consent", { method: "POST", body: {} }).then(
      () => "applied", (e: { code?: string }) => `refused:${e.code}`);
    await advance(100);
    setJar("B", 0);
    releaseTab2();
    await advance(300);
    const res = await held;
    expect(onB(), "a request built under A's session was APPLIED on account B").toEqual([]);
    // api() either sent the write before the switch (applied on A) or refused it after: never on B.
    expect(onA("/api/consent")).toBe(await write === "applied" ? 1 : 0);
    await keptAndResent(res, () => triage(truth));
    expect(onB()).toEqual([]);
    expect(onA("/api/messages/m1/triage"), "the press was not applied on A exactly once").toBe(1);
  });

  it("COLD BOOT — the first snapshot and a first POST /drafts held for the at-once renewal never reach B", async () => {
    const { truth } = await load();
    const releaseTab2 = otherTabHoldsLock();
    truth.markSessionAlive();
    const snapshot = truth.sessionFetch("/api/sync/snapshot");
    const draft = press("/api/drafts", "k-draft", JSON.stringify({ subject: "s" }));
    const held = draft(truth);
    await advance(100);
    setJar("B", 0);
    releaseTab2();
    await advance(300);
    const [snap, res] = await Promise.all([snapshot, held]);
    expect(sent.filter((s) => s.url !== "/auth/refresh" && s.account === "B").map((s) => `${s.method} ${s.url}`),
      "a request built under A's session left on B's jar").toEqual([]);
    expect(onB()).toEqual([]);
    expect([200, 503]).toContain(snap.status);
    await keptAndResent(res, () => draft(truth));
    expect(onA("/api/drafts")).toBe(1);
  });

  it("THROUGH THE GATE AND THE ADAPTER — a tag create pressed for A is rejected retryable, never applied on B", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const { truth } = await load();
    const engine = await import("@ohmail/client-engine");
    const { erasedAwareFetch } = await import("../app/shell/account-erased");
    const { createSyncGate } = await import("../app/shell/sync-scheduler");
    const gate = createSyncGate("acct_A");
    gate.confirm("acct_A");
    const adapter = gate.guard(new engine.HttpAdapter({
      baseUrl: "/api", stageAttachments: true, mayAsk: truth.sessionMayAsk,
      headers: () => ({}),
      fetch: erasedAwareFetch(truth.sessionFetch, engine.sessionEndedResponse),
    }) as never) as unknown as { mutate: (m: unknown, o: { idempotencyKey: string }) => Promise<unknown> };
    truth.markSessionAlive();
    await advance(12 * MIN - 50);
    const releaseTab2 = otherTabHoldsLock();
    await advance(60);
    expect(gate.identity()).toBe("holds");
    const outcome = adapter.mutate({ kind: "tag_create", name: "probe" }, { idempotencyKey: "k-tag" })
      .then(() => "resolved", (e: { retryable?: boolean }) => `rejected retryable=${String(e.retryable)}`);
    await advance(100);
    setJar("B", 0);
    releaseTab2();
    await advance(300);
    const settled = await outcome;
    expect(onB(), "the gate let a press built for A be applied on B").toEqual([]);
    // Sent before the switch it is applied on A; held across it, it is kept for A, never refused for good.
    expect(settled === "resolved" ? applied.filter((a) => a.key === "k-tag").map((a) => a.account) : settled)
      .toEqual(settled === "resolved" ? ["A"] : "rejected retryable=true");
  });

  it("CONTROL — no other tab: the held press is sent once on A's renewed jar and applied on A", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const { truth } = await load();
    truth.markSessionAlive();
    await advance(12 * MIN - 50);
    const releaseTab2 = otherTabHoldsLock();
    await advance(60);
    const held = press("/api/messages/m1/triage", "k1")(truth);
    await advance(100);
    releaseTab2();
    await advance(300);
    expect((await held).status).toBe(200);
    expect(onA("/api/messages/m1/triage")).toBe(1);
    expect(refreshCount()).toBe(1);
  });
});

/* A HELD request exists only where requests wait (red at the base by construction: nothing held). */
describe("a renewal the server refuses", () => {
  it("a request the transport held is answered as the closed door before the wire, as api() answers", async () => {
    refreshMode = "refused";
    const { truth, client } = await load();
    truth.markSessionAlive();
    const read = client.api("/consent").then(() => "ok", (e: { status?: number }) => `refused:${e.status}`);
    const snapshot = truth.sessionFetch("/api/sync/snapshot");
    await advance(300);
    expect(await read).toBe("refused:401");
    const snap = await snapshot;
    expect(snap.status).toBe(401);
    expect(((await snap.json()) as { error: { code: string } }).error.code).toBe("session_ended");
    expect(sent.filter((s) => s.url !== "/auth/refresh").map((s) => s.url), "a held request reached the wire").toEqual([]);
    expect(refreshCount()).toBe(1);
  });
});
