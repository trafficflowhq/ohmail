/** @vitest-environment jsdom */
/**
 * A PRESS THAT MEETS ANOTHER TAB'S SESSION IS KEPT FOR ITS OWN ACCOUNT, and says why in its own words.
 *
 * Through the real api-client transport, sync gate, HttpAdapter and engine; only fetch, the jar and
 * the lock are faked. A press held across a renewal the server refused (the session may come back from
 * another tab); a press held while another tab signed in as B; a press already on the wire when that
 * sign-in lands; a recovery waiting for the lock while it lands. Each is kept, never rolled back, never
 * applied on B and never renews B; applied on A once when A is back. Both sentences read in both catalogues.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAdapter, EngineMutation } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const MIN = 60_000;
const ARRIVE = 20;
const R_ARRIVE = 10;

type Acct = "A" | "B";
let applied: { account: Acct; url: string; key: string | null }[] = [];
let sent: { url: string; method: string; account: Acct | null }[] = [];
let jar: { account: Acct | null; access: number } = { account: "A", access: 0 };
const serverAccess: Record<Acct, number> = { A: 0, B: 0 };
let refreshMode: "ok" | "refused" = "ok";
/** Runs once the next non-refresh request has left with its jar: the other tab's sign-in landing mid-flight. */
let whileInFlight: (() => void) | null = null;

const csrfOf = (a: Acct, g: number): string => `csrf-${a}${g}`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const later = <T,>(ms: number, fn: () => T): Promise<T> => new Promise((r) => setTimeout(() => r(fn()), ms));

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
  const carried = { ...jar };
  sent.push({ url, method, account: carried.account });
  if (url === "/auth/refresh") {
    if (refreshMode === "refused") {
      return later(2 * R_ARRIVE, () => {
        setJar(null, 0);
        return json(401, { error: { code: "refresh_revoked", message: "invalid refresh token" } });
      });
    }
    return later(2 * R_ARRIVE, () => {
      const a = carried.account!;
      serverAccess[a] += 1;
      setJar(a, serverAccess[a]);
      return new Response(null, { status: 204 });
    });
  }
  const mid = whileInFlight;
  whileInFlight = null;
  return later(ARRIVE, () => {
    mid?.();
    if (carried.account === null || carried.access !== serverAccess[carried.account]) {
      return json(401, { error: { code: "unauthorized", message: "authentication required" } });
    }
    if (method !== "GET" && h["x-csrf-token"] !== csrfOf(carried.account, carried.access)) {
      return json(403, { error: { code: "csrf_failed", message: "csrf validation failed" } });
    }
    applied.push({ account: carried.account, url, key: h["idempotency-key"] ?? null });
    return json(200, { id: "tag-1", name: "probe", createdAt: "2026-10-06T08:00:00.000Z" });
  });
}

async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5) {
    await vi.advanceTimersByTimeAsync(Math.min(5, left));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
}

let chain: Promise<unknown> = Promise.resolve();
function otherTabHoldsLock(): () => void {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  chain = chain.then(() => held);
  return release;
}

/** One tab: the real modules, and an engine whose presses leave through the gate, the adapter and the transport. */
async function openTab() {
  vi.resetModules();
  const truth = await import("@ohmail/app-logic/session/session-truth");
  const client = await import("../app/api-client");
  await import("../app/session-refresh");
  const locale = await import("../app/shell/locale");
  const engineMod = await import("@ohmail/client-engine");
  const { FixturesAdapter } = await import("@ohmail/testing/adapter");
  const { erasedAwareFetch } = await import("@ohmail/app-logic/session/account-erased");
  const { createSyncGate } = await import("@ohmail/app-logic/session/sync-scheduler");
  client.bindApiOwner("acct_A");
  const gate = createSyncGate("acct_A");
  gate.confirm("acct_A");
  const guarded = gate.guard(new engineMod.HttpAdapter({
    baseUrl: "/api", stageAttachments: true, mayAsk: truth.sessionMayAsk,
    headers: () => ({}),
    fetch: erasedAwareFetch(truth.sessionFetch, engineMod.sessionEndedResponse),
  }) as never) as unknown as { mutate: EngineAdapter["mutate"] };
  const fixtures = new FixturesAdapter();
  const adapter: EngineAdapter = {
    fetchBody: fixtures.fetchBody.bind(fixtures),
    sync: fixtures.sync.bind(fixtures),
    mutate: (m, o) => guarded.mutate(m, o),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
  };
  const engine = new engineMod.OhmailEngine({ adapter, store: new engineMod.MemoryMirrorStore(), now: () => new Date() });
  await engine.start();
  const refresh = await import("../app/session-refresh");
  return { truth, client, locale, gate, engine, refresh };
}

/** The press: a tag made on this account, under the engine's own key. */
const TAG = (name: string): EngineMutation => ({ kind: "tag_create", tagId: `tag-local-${name}`, name });
const onB = (): string[] => applied.filter((a) => a.account === "B").map((a) => `${a.url} key=${a.key}`);
const tagsOnA = (): number => applied.filter((a) => a.account === "A" && a.url === "/api/tags").length;
const SAY = {
  ended: [en.sync.keptSessionEnded, de.sync.keptSessionEnded],
  switched: [en.sync.keptAccountSwitched, de.sync.keptAccountSwitched],
};

/** A's session is back in this browser (a sign-in elsewhere, then this tab's confirm): the kept press goes once. */
async function aIsBack(tab: Awaited<ReturnType<typeof openTab>>): Promise<void> {
  refreshMode = "ok";
  window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
  serverAccess.A += 1;
  setJar("A", serverAccess.A);
  tab.truth.markSessionAlive();
  tab.gate.identity();
  tab.gate.confirm("acct_A");
  const flushed = tab.engine.flushPending();
  await advance(300);
  await flushed;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-06T08:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  applied = [];
  sent = [];
  serverAccess.A = 0;
  serverAccess.B = 0;
  refreshMode = "ok";
  whileInFlight = null;
  window.localStorage.clear();
  window.sessionStorage.clear();
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
  const { resetSessionTruthForTests } = await import("@ohmail/app-logic/session/session-truth");
  resetSessionTruthForTests();
  const { setActiveCatalog } = await import("../app/shell/locale");
  setActiveCatalog("en", null);
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  Reflect.deleteProperty(document as unknown as Record<string, unknown>, "visibilityState");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a press held across a renewal the server refused", () => {
  it("is kept for retry with its own sentence, never rolled back, and applied on A once A is back", async () => {
    refreshMode = "refused";
    const tab = await openTab();
    tab.truth.markSessionAlive();
    const pressed = tab.engine.mutate(TAG("probe"));
    await advance(300);
    const res = await pressed;
    expect(tab.truth.sessionIsDead(), "control: the renewal was refused").toBe(true);
    expect(res.status, "a press held across a refused renewal was rolled back").toBe("queued");
    expect([res.error?.code, res.error?.message]).toEqual(["not_signed_in", SAY.ended[0]]);
    expect(sent.filter((s) => s.url !== "/auth/refresh"), "a held press reached the wire").toEqual([]);
    await aIsBack(tab);
    expect(onB()).toEqual([]);
    expect(tagsOnA(), "the kept press was not applied on A exactly once").toBe(1);
  });

  it("CONTROL: an account erased meanwhile keeps nothing: the held press is refused as the closed door", async () => {
    refreshMode = "refused";
    const tab = await openTab();
    const { markAccountErased, resetAccountErasedForTests } = await import("@ohmail/app-logic/session/account-erased");
    try {
      tab.truth.markSessionAlive();
      const pressed = tab.engine.mutate(TAG("probe"));
      // Held in the transport's wait first, past the adapter's own door; then the erasure, then the refusal.
      await advance(5);
      expect(sent.filter((s) => s.url !== "/auth/refresh"), "control: the press is held, not sent").toEqual([]);
      markAccountErased("acct_A");
      await advance(300);
      const res = await pressed;
      expect([res.status, res.error?.code], "a press for an erased account was kept").toEqual(["rolled_back", "session_ended"]);
    } finally {
      resetAccountErasedForTests();
    }
  });

  it("CONTROL: a press made after the refusal meets the gate's own retryable refusal, kept the same way", async () => {
    refreshMode = "refused";
    const tab = await openTab();
    tab.truth.markSessionAlive();
    await advance(300);
    expect(tab.truth.sessionIsDead()).toBe(true);
    const res = await tab.engine.mutate(TAG("later"));
    expect(res.status).toBe("queued");
    expect(sent.filter((s) => s.url !== "/auth/refresh")).toEqual([]);
  });
});

describe("a press held while another tab signs in as B", () => {
  it("is kept with the account switch's sentence, not the renewal fault's, and applied on A once", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const tab = await openTab();
    tab.truth.markSessionAlive();
    await advance(12 * MIN - 50);
    const releaseTab2 = otherTabHoldsLock();
    await advance(60);
    const pressed = tab.engine.mutate(TAG("probe"));
    await advance(100);
    setJar("B", 0);
    releaseTab2();
    await advance(300);
    const res = await pressed;
    expect(onB(), "a press built for A was applied on B").toEqual([]);
    expect(res.status).toBe("queued");
    expect([res.error?.code, res.error?.message], "the account switch said the renewal fault's sentence")
      .toEqual(["not_signed_in", SAY.switched[0]]);
    await aIsBack(tab);
    expect(onB()).toEqual([]);
    expect(tagsOnA()).toBe(1);
  });
});

describe("a press waiting for another tab's renewal, whose lock then passes to a sign-in as B", () => {
  it("is kept for A with the switch's sentence, never sent on B's jar with B's token", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const tab2 = await openTab();
    const tab1 = await openTab();
    tab1.truth.markSessionAlive();
    const renewal = tab2.refresh.resumeSession();
    await advance(1);
    // A sign-in as B in a third tab queues behind tab 2's renewal; tab 1's press then waits behind both.
    const releaseTab3 = otherTabHoldsLock();
    const pressed = tab1.engine.mutate(TAG("probe"));
    await advance(60);
    expect(await renewal, "control: tab 2's renewal went through").toBe("resumed");
    expect(sent.filter((s) => s.url === "/api/tags"), "the press did not wait for the other tab").toEqual([]);
    setJar("B", 0);
    releaseTab3();
    await advance(300);
    const res = await pressed;
    expect(onB(), "a press built for A was applied on B").toEqual([]);
    expect(sent.filter((s) => s.url === "/api/tags"), "the press left on B's jar").toEqual([]);
    expect([res.status, res.error?.code, res.error?.message]).toEqual(["queued", "not_signed_in", SAY.switched[0]]);
  });
});

describe("a press waiting for another tab's renewal while a third tab signs out", () => {
  it("is handed back as it came, not kept, and is sent 0 times once A signs in again", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const tab2 = await openTab();
    const tab1 = await openTab();
    tab1.truth.markSessionAlive();
    const renewal = tab2.refresh.resumeSession();
    await advance(1);
    // A sign-out in a third tab queues behind tab 2's renewal; tab 1's press waits behind both.
    const releaseTab3 = otherTabHoldsLock();
    const pressed = tab1.engine.mutate(TAG("probe"));
    await advance(60);
    expect(await renewal, "control: tab 2's renewal went through").toBe("resumed");
    expect(sent.filter((s) => s.url === "/api/tags"), "control: the press waited for the other tab").toEqual([]);
    setJar(null, 0);
    serverAccess.A += 1;
    releaseTab3();
    await advance(300);
    const res = await pressed;
    expect(applied).toEqual([]);
    expect(res.status, "a press across a sign-out elsewhere was kept for the next sign-in").toBe("rolled_back");
    await aIsBack(tab1);
    expect(tagsOnA(), "the press was sent once A signed in again").toBe(0);
  });

  it("api() in the same wait refuses by its owner question before the network, as it refused at the base", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const tab2 = await openTab();
    const tab1 = await openTab();
    tab1.truth.markSessionAlive();
    const renewal = tab2.refresh.resumeSession();
    await advance(1);
    const releaseTab3 = otherTabHoldsLock();
    const read = tab1.client.api("/consent").then(() => "ok", (e: { code?: string }) => `refused:${e.code}`);
    await advance(60);
    expect(await renewal).toBe("resumed");
    setJar(null, 0);
    serverAccess.A += 1;
    releaseTab3();
    await advance(300);
    expect(await read).toBe("refused:owner_absent");
    expect(sent.filter((s) => s.url === "/api/consent"), "api() sent on a jar naming no account").toEqual([]);
  });
});

describe("a write already on the wire when another tab signs in as B", () => {
  it("comes back refused, is kept for A rather than rolled back, and is applied on A once", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const tab = await openTab();
    tab.truth.markSessionAlive();
    await advance(MIN);
    // B's sign-in lands while the press is out: the server ended A's session in that mint.
    whileInFlight = () => {
      serverAccess.A += 1;
      setJar("B", 0);
    };
    const pressed = tab.engine.mutate(TAG("probe"));
    await advance(300);
    const res = await pressed;
    expect(onB()).toEqual([]);
    expect(res.status, "the in-flight write was rolled back across the account switch").toBe("queued");
    expect([res.error?.code, res.error?.message]).toEqual(["not_signed_in", SAY.switched[0]]);
    await aIsBack(tab);
    expect(onB()).toEqual([]);
    expect(tagsOnA()).toBe(1);
  });

  it("a write sent on B's jar with A's token is kept the same way (403 csrf_failed)", async () => {
    const { truth } = await openTab();
    setJar("B", 0);
    const pending = truth.sessionFetch("/api/tags", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k-403", "x-csrf-token": csrfOf("A", 0) },
      body: JSON.stringify({ name: "probe" }),
    });
    await advance(100);
    const res = await pending;
    expect(onB()).toEqual([]);
    expect(res.status, "a write refused for B's jar was handed back as a refusal").toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string; retryable: boolean } };
    expect([body.error.code, body.error.message, body.error.retryable]).toEqual(["not_signed_in", SAY.switched[0], true]);
  });

  it("a READ refused for B's jar is handed back as it came: only a press is kept", async () => {
    const { truth } = await openTab();
    // B's session in the jar, its access already replaced at the server: the read is refused 401.
    setJar("B", 0);
    serverAccess.B = 1;
    const pending = truth.sessionFetch("/api/messages/m1/body");
    await advance(100);
    const res = await pending;
    const body = (await res.json()) as { error: { code: string } };
    expect([res.status, body.error.code], "a read was answered as a kept press").toEqual([401, "unauthorized"]);
    expect(sent.filter((s) => s.url === "/auth/refresh"), "B's session was renewed from this tab").toEqual([]);
  });

  it("CONTROL: across a sign-out in another tab (no account in the jar) the refusal is handed back as before", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const tab = await openTab();
    tab.truth.markSessionAlive();
    await advance(MIN);
    whileInFlight = () => {
      serverAccess.A += 1;
      setJar(null, 0);
    };
    const res = await (async () => {
      const pressed = tab.engine.mutate(TAG("probe"));
      await advance(300);
      return pressed;
    })();
    expect(res.status).toBe("rolled_back");
    expect(applied).toEqual([]);
  });
});

/* API-CLIENT-READS-THE-OWNER-BEFORE-THE-LOCK: the recovery asked whose jar it was, then waited for the
   lock, and a sign-in as B landing in that wait had B's session renewed from this tab. */
describe("a recovery that waits for the lock while another tab signs in as B", () => {
  /** A's access has lapsed; its recovery queues behind tab 2's sign-in as B, which lands first. */
  async function lapsedThenB(ask: () => Promise<unknown>) {
    serverAccess.A += 1;
    const releaseTab2 = otherTabHoldsLock();
    const asked = ask();
    await advance(100);
    setJar("B", 0);
    releaseTab2();
    await advance(300);
    return asked;
  }
  const renewedB = () => sent.filter((s) => s.url === "/auth/refresh" && s.account === "B");

  it("api(): renews nothing on B's jar and says the account moved", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const tab = await openTab();
    tab.truth.markSessionAlive();
    const read = await lapsedThenB(() => tab.client.api("/consent").then(() => "ok", (e: { code?: string }) => `refused:${e.code}`));
    expect(renewedB(), "this tab renewed another account's session").toEqual([]);
    expect(read).toBe("refused:owner_mismatch");
    expect(onB()).toEqual([]);
  });

  it("the engine's transport: renews nothing on B's jar, and the press is kept for A", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const tab = await openTab();
    tab.truth.markSessionAlive();
    const pressed = await lapsedThenB(() => tab.engine.mutate(TAG("probe"))) as
      Awaited<ReturnType<typeof tab.engine.mutate>>;
    expect(renewedB(), "this tab renewed another account's session").toEqual([]);
    expect([pressed.status, pressed.error?.code, pressed.error?.message]).toEqual(["queued", "not_signed_in", SAY.switched[0]]);
    expect(onB()).toEqual([]);
  });
});

describe("the two sentences, in the reader's language", () => {
  it("the kept answers say the session catalogue's words in German", async () => {
    refreshMode = "refused";
    const tab = await openTab();
    tab.locale.setActiveCatalog("de", de as never);
    tab.truth.markSessionAlive();
    const pressed = tab.engine.mutate(TAG("probe"));
    await advance(300);
    expect((await pressed).error?.message).toBe(SAY.ended[1]);
    setJar("B", 0);
    const pending = tab.truth.sessionFetch("/api/tags", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k-de", "x-csrf-token": csrfOf("A", 0) },
      body: "{}",
    });
    await advance(100);
    const res = await pending;
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(SAY.switched[1]);
    for (const [say, lang] of [[SAY.ended, "ended"], [SAY.switched, "switched"]] as const) {
      expect(say.every((s) => typeof s === "string" && s.length > 0), `${lang} is missing from a catalogue`).toBe(true);
      expect(say[0], `${lang}: the German says the English`).not.toBe(say[1]);
    }
  });
});
