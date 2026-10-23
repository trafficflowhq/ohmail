/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { ThemeProvider, ToastHost, useToast } from "@ohmail/ui";
import type { EngineMutation, OhmailEngine } from "@ohmail/client-engine";
import messages from "../messages/en.json";

/**
 * a press made as the web session's short access lapsed answered 401, the tab
 * renewed (204) and never sent it again; and a `/sync` that met the lapse left the page on the
 * sixty-second refusal cadence after a renewal that took 150 ms.
 *
 * Driven through the REAL engine `createEngine` builds, the REAL api-client and the REAL refresh,
 * with only `fetch` and the cookie jar faked. The rule pinned: a refusal only the lapsed access
 * explains is renewed and sent ONCE more under the press's own key; a renewal the server refused, or
 * a jar that now names another account, keeps the press for its own account (`not_signed_in`) and
 * sends nothing more; a renewed session drains at once.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";
const ENV = { NEXT_PUBLIC_API_BASE: "/api" };

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Sent { method: string; url: string; headers: Record<string, string> }

let sent: Sent[] = [];
/** The access cookie has lapsed: every API request answers the server's own 401. */
let lapsed = false;
/** What `POST /auth/refresh` answers: a renewal, a fault, or the family's end. */
let renewal: "ok" | "unavailable" | "refused" = "ok";
/** The press keeps answering 401 after a renewal — the loop the re-send must not become. */
let pressRefusedAfterRenewal = false;
/** A refusal the lapse does not explain, answered to the press instead. */
let pressAnswer: Response | null = null;
let mints = 0;
/** The jar the renewal writes names this account — a sign-in elsewhere landing mid-renewal. */
let ownerAfterRenewal: string | null = null;
let originalFetch: typeof globalThis.fetch;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const coded = (status: number, code: string, message: string): Response =>
  json(status, { error: { code, message } });

const PRESS = "/api/messages/m1/triage";
const presses = (): Sent[] => sent.filter((s) => s.url === PRESS);
const refreshes = (): Sent[] => sent.filter((s) => s.url === "/auth/refresh");
const syncs = (): Sent[] => sent.filter((s) => s.url.startsWith("/api/sync?"));

function lowered(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) out[k.toLowerCase()] = v;
  return out;
}

function serve(url: string, init?: RequestInit): Response {
  sent.push({ method: init?.method ?? "GET", url, headers: lowered(init) });
  if (url === "/auth/refresh") {
    if (renewal === "unavailable") return coded(503, "db_busy", "busy");
    if (renewal === "refused") return coded(401, "refresh_expired", "refresh token expired");
    mints += 1;
    document.cookie = `tf_csrf=fresh-${mints}; path=/`;
    if (ownerAfterRenewal !== null) document.cookie = `tf_owner=${ownerAfterRenewal}; path=/`;
    const wasLapsed = lapsed;
    lapsed = false;
    if (wasLapsed && pressRefusedAfterRenewal) lapsed = true;
    return new Response(null, { status: 204 });
  }
  if (url === PRESS && pressAnswer !== null) return pressAnswer.clone();
  if (lapsed) return coded(401, "unauthorized", "authentication required");
  if (url === PRESS) return json(200, { messageId: "m1", state: "set_aside" });
  if (url.startsWith("/api/sync/snapshot")) {
    return json(200, { asOfSeq: 1, changes: [], nextCursor: null, window: { days: 0, minRows: 0 } });
  }
  if (url.startsWith("/api/sync?")) {
    return json(200, {
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "c1", hasMore: false, serverTime: new Date().toISOString(),
    });
  }
  return json(200, {});
}

beforeEach(() => {
  sent = [];
  lapsed = false;
  renewal = "ok";
  pressRefusedAfterRenewal = false;
  pressAnswer = null;
  mints = 0;
  ownerAfterRenewal = null;
  document.cookie = "tf_csrf=stale; path=/";
  document.cookie = "tf_owner=; max-age=0; path=/";
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => serve(String(input), init)) as typeof fetch;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  const { bindApiOwner } = await import("../app/api-client.js");
  bindApiOwner(null);
  vi.restoreAllMocks();
});

/** The engine the web shell runs, with the api-client loaded the way `CloudShell` loads it. */
async function liveEngine(): Promise<OhmailEngine> {
  await import("../app/api-client.js");
  const { createEngine } = await import("../app/shell/engine-config.js");
  return createEngine(false, ENV, null);
}

const PARK: EngineMutation = { kind: "triage_set", messageId: "m1", state: "set_aside" };

describe("a press made as the access lapses", () => {
  it("is renewed and sent ONCE more under its own key, with the renewed jar's token", async () => {
    const engine = await liveEngine();
    lapsed = true;
    const res = await engine.mutate(PARK);

    expect(res.status, "the press was dropped after the renewal").toBe("confirmed");
    expect(refreshes()).toHaveLength(1);
    expect(presses()).toHaveLength(2);
    const [first, again] = presses();
    expect(first!.headers["idempotency-key"]).toBeTruthy();
    expect(again!.headers["idempotency-key"], "the re-send is a second press").toBe(first!.headers["idempotency-key"]);
    expect(first!.headers["x-csrf-token"]).toBe("stale");
    expect(again!.headers["x-csrf-token"], "the re-send carried the lapsed jar's token").toBe("fresh-1");
  });

  it("a second 401 after the renewal is the answer: no loop, the press is refused", async () => {
    const engine = await liveEngine();
    lapsed = true;
    pressRefusedAfterRenewal = true;
    const res = await engine.mutate(PARK);

    expect(res.status).toBe("rolled_back");
    expect(presses(), "the re-send looped").toHaveLength(2);
    expect(refreshes()).toHaveLength(1);
  });

  /* A RENEWAL THAT MET A FAULT learned nothing about the session, so the press is kept, as the
     desktop's door keeps it (WEB-PRESS-REFUSED-ON-A-RENEWAL-FAULT-WHERE-THE-DESKTOP-KEEPS-IT, ruled:
     one behaviour for both doors). Only a REFUSED renewal refuses the press (the case below). */
  it("a renewal that fails keeps the press queued, sent once", async () => {
    const engine = await liveEngine();
    lapsed = true;
    renewal = "unavailable";
    const res = await engine.mutate(PARK);

    expect(res.status, "a press was refused over a renewal that only met a fault").toBe("queued");
    expect(presses(), "a press was re-sent over a renewal that did not happen").toHaveLength(1);
  });

  it("a renewal the server refuses keeps the press for its account, sent once", async () => {
    const engine = await liveEngine();
    lapsed = true;
    renewal = "refused";
    try {
      const res = await engine.mutate(PARK);
      // The session may come back from another tab: kept under its key, never rolled back.
      expect([res.status, res.error?.code], "a press was rolled back over a refused renewal").toEqual(["queued", "not_signed_in"]);
      expect(res.error?.message).toBe(messages.sync.keptSessionEnded);
      expect(presses()).toHaveLength(1);
    } finally {
      const { resetSessionTruthForTests } = await import("../app/shell/session-truth.js");
      resetSessionTruthForTests();
    }
  });

  it("a stale CSRF token (403 csrf_failed) is the idle tab's other face, and renews the same way", async () => {
    const engine = await liveEngine();
    pressAnswer = coded(403, "csrf_failed", "csrf token mismatch");
    let once = true;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/auth/refresh" && once) { once = false; pressAnswer = null; }
      return serve(url, init);
    }) as typeof fetch;
    const res = await engine.mutate(PARK);

    expect(res.status).toBe("confirmed");
    expect(presses()).toHaveLength(2);
    expect(presses()[1]!.headers["x-csrf-token"]).toBe("fresh-1");
  });

  it("CONTROL: a refusal the lapse does not explain asks for no renewal", async () => {
    const engine = await liveEngine();
    for (const answer of [
      coded(409, "organized_elsewhere", "another install is organizing this mailbox"),
      coded(403, "forbidden", "not yours"),
      coded(404, "not_found", "gone"),
    ]) {
      sent = [];
      pressAnswer = answer;
      const res = await engine.mutate(PARK);
      expect(res.status).toBe("rolled_back");
      expect(refreshes(), `a ${answer.status} started a renewal`).toHaveLength(0);
      expect(presses()).toHaveLength(1);
    }
  });

  it("the jar the renewal wrote must still be this account's, or the press is not sent again", async () => {
    const engine = await liveEngine();
    const { bindApiOwner } = await import("../app/api-client.js");
    document.cookie = "tf_owner=acct-a; path=/";
    bindApiOwner("acct-a");

    // CONTROL first: the same binding, a renewal that stays this account's, is re-sent.
    lapsed = true;
    expect((await engine.mutate(PARK)).status).toBe("confirmed");
    expect(presses()).toHaveLength(2);

    sent = [];
    lapsed = true;
    ownerAfterRenewal = "acct-b";
    const res = await engine.mutate(PARK);
    // Kept for acct-a, never sent on acct-b's jar: the account switch is not this press's verdict.
    expect([res.status, res.error?.code]).toEqual(["queued", "not_signed_in"]);
    expect(res.error?.message).toBe(messages.sync.keptAccountSwitched);
    expect(refreshes()).toHaveLength(1);
    expect(presses(), "a press was re-sent under another account's session").toHaveLength(1);
  });

  it("a jar already naming another account asks for no renewal at all", async () => {
    const engine = await liveEngine();
    const { bindApiOwner } = await import("../app/api-client.js");
    document.cookie = "tf_owner=acct-b; path=/";
    bindApiOwner("acct-a");
    lapsed = true;
    const res = await engine.mutate(PARK);
    expect([res.status, res.error?.code]).toEqual(["queued", "not_signed_in"]);
    expect(refreshes(), "another account's session was renewed from this tab").toHaveLength(0);
    expect(presses(), "a press was re-sent under another account's session").toHaveLength(1);
  });

  it("CONTROL: a signed storage upload is never renewed nor stamped — its URL is its authority", async () => {
    await liveEngine();
    const { sessionFetch } = await import("../app/shell/session-truth.js");
    lapsed = true;
    const upload = "https://storage.example/object/upload/sign/b/p?token=t";
    const res = await sessionFetch(upload, { method: "PUT", headers: { "content-type": "image/png" }, body: "x" });
    expect(res.status).toBe(401);
    expect(refreshes()).toHaveLength(0);
    expect(sent.filter((s) => s.url === upload)).toHaveLength(1);
    expect(sent[0]!.headers["x-csrf-token"]).toBeUndefined();
  });

  it("CONTROL: a press on a live session is sent once and asks nothing else", async () => {
    const engine = await liveEngine();
    const res = await engine.mutate(PARK);
    expect(res.status).toBe("confirmed");
    expect(presses()).toHaveLength(1);
    expect(refreshes()).toHaveLength(0);
  });
});

// ── what the person reads ────────────────────────────────────────────────────────────────────

let roots: Root[] = [];

afterEach(async () => {
  for (const root of roots) await act(() => { root.unmount(); });
  roots = [];
  document.body.innerHTML = "";
});

const said = (needle: string): boolean =>
  [...document.querySelectorAll('[role="status"]')].some((n) => (n.textContent ?? "").includes(needle));

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeout} ms waiting for: ${what}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

/** Mount the shell's one dispatch seam over the live engine and press Park through it. */
async function pressPark(engine: OhmailEngine): Promise<void> {
  const { useShellDispatch } = await import("../app/shell/shell-dispatch.js");
  let press: (() => void) | null = null;
  function Seam(): null {
    const t = useTranslations();
    const toast = useToast();
    const d = useShellDispatch({ engine, reader: engine.read(), toast, t, demo: true, refreshFacts: () => {} });
    press = () => { void d.mutateAndReport(PARK, t("ohbox.toastAside")); };
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC",
      children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, { children: h(Seam) }) }),
    }));
  });
  await act(async () => { press!(); });
}

describe("what the press says", () => {
  it("a press at the lapse is carried out and says so", async () => {
    const engine = await liveEngine();
    lapsed = true;
    await pressPark(engine);
    await waitFor(() => said(messages.ohbox.toastAside), "the press never said it was done");
    expect(said(messages.ohbox.refusedPress)).toBe(false);
  });

  it("a renewal the server refuses keeps the press and says it, never that nothing changed", async () => {
    const engine = await liveEngine();
    lapsed = true;
    renewal = "refused";
    try {
      await pressPark(engine);
      // Kept for its account: the change stands, so the press's own sentence is the true one.
      await waitFor(() => said(messages.ohbox.toastAside), "a kept press was dropped in silence");
      expect(said(messages.ohbox.refusedPress), "a kept press was told as refused").toBe(false);
    } finally {
      const { resetSessionTruthForTests } = await import("../app/shell/session-truth.js");
      resetSessionTruthForTests();
    }
  });

  it("a renewal that fails does not say the press was refused", async () => {
    const engine = await liveEngine();
    lapsed = true;
    renewal = "unavailable";
    await pressPark(engine);
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(said(messages.ohbox.refusedPress), "a kept press was told as refused").toBe(false);
  });
});

// ── the open page after a renewal ────────────────────────────────────────────────────────────

describe("a /sync that meets the lapse", () => {
  const started: Array<() => void> = [];
  afterEach(() => { for (const stop of started.splice(0)) stop(); });

  async function schedule(engine: OhmailEngine): Promise<{ refused: () => boolean; failures: () => number }> {
    const { startSyncScheduler } = await import("../app/shell/sync-scheduler.js");
    let refused = false;
    let failures = 0;
    started.push(startSyncScheduler(engine, {
      pollMs: 40, visibility: null, online: null, wake: null, random: () => 0,
      report: () => {},
      onStatus: (s) => { refused = s.refused; failures = s.failures; },
    }));
    await waitFor(() => sent.some((s) => s.url.startsWith("/api/sync")), "the first drain");
    await waitFor(() => syncs().length > 0, "a delta drain");
    return { refused: () => refused, failures: () => failures };
  }

  it("a press kept over a renewal fault is sent again after the next renewal, under its own key", async () => {
    const engine = await liveEngine();
    await schedule(engine);
    lapsed = true;
    renewal = "unavailable";
    const res = await engine.mutate(PARK);
    expect(res.status).toBe("queued");
    renewal = "ok";
    await waitFor(() => presses().length >= 2, "the kept press was never sent again", 3000);
    const keys = new Set(presses().map((p) => p.headers["idempotency-key"]));
    expect(keys.size, "the replay was a second press").toBe(1);
  });

  /* CONTROL for the accepted reading (every renewal FAULT answers offline): a REFUSED renewal — the
     refresh door's coded 401 — still signs the page out, and the drain still reads the refusal. */
  it("CONTROL: a refused renewal on /sync still reaches the signed-out state", async () => {
    const engine = await liveEngine();
    const loop = await schedule(engine);
    renewal = "refused";
    lapsed = true;
    const { resetSessionTruthForTests, sessionIsDead } = await import("../app/shell/session-truth.js");
    await waitFor(() => sessionIsDead(), "a refused renewal never reached the signed-out state");
    await waitFor(() => loop.refused(), "a refused renewal was read as a fault by the drain");
    resetSessionTruthForTests();
  });

  it("drains again at once when its own renewal answers, never at the refusal cadence", async () => {
    const engine = await liveEngine();
    const loop = await schedule(engine);
    lapsed = true;
    const before = syncs().length;
    await waitFor(() => refreshes().length === 1, "the lapse was never met");
    const at = Date.now();
    await waitFor(() => syncs().length >= before + 2 && !lapsed, "no /sync followed the renewal");
    expect(Date.now() - at).toBeLessThan(1000);
    expect(loop.refused(), "the renewed session was left on the refusal cadence").toBe(false);
  });

  /* Its own renewal met a fault, which the transport answers as the desktop's door does — offline,
     never a refusal (ruled, WEB-PRESS-REFUSED-ON-A-RENEWAL-FAULT-WHERE-THE-DESKTOP-KEEPS-IT). */
  it("drains at once on a renewal made elsewhere after its own one failed", async () => {
    const engine = await liveEngine();
    const loop = await schedule(engine);
    renewal = "unavailable";
    lapsed = true;
    await waitFor(() => loop.failures() > 0, "the lapse's failed renewal was never read");
    expect(loop.refused(), "a renewal fault was read as a refusal").toBe(false);
    const count = syncs().length;
    // The shell's probe (`SessionEnded`) is what asked live; here the renewal is asked directly.
    renewal = "ok";
    const { resumeSession } = await import("../app/session-refresh.js");
    expect(await resumeSession()).toBe("resumed");
    await waitFor(() => syncs().length > count && !loop.refused(), "the page waited out the refusal cadence", 1500);
  });
});

// ── a plain api() call, which keeps nothing ──────────────────────────────────────────────────

/* THE OFFLINE ANSWER IS THE ENGINE TRANSPORT'S ALONE (HIGH-1). Its outbox keeps
   a press over a renewal fault; `api()` keeps nothing, so its caller is told the sign-in could not be
   checked and nothing says the call is sent again. Mutation watched red: api() answering offline. */
describe("a plain api() call over a renewal fault", () => {
  const RESYNC = "/api/mailboxes/m1/resync";
  it("says the sign-in could not be checked, promises no re-send, and is sent once", async () => {
    const { mailboxes, messageOf, ApiError } = await import("../app/api-client.js");
    lapsed = true;
    renewal = "unavailable";
    const caught = await mailboxes.resync("m1").then(() => null, (e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as InstanceType<typeof ApiError>).code).toBe("session_unchecked");
    expect(messageOf(caught)).not.toMatch(/sent again|waits/);
    renewal = "ok";
    const { resumeSession } = await import("../app/session-refresh.js");
    expect(await resumeSession()).toBe("resumed");
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(sent.filter((s) => s.url === RESYNC), "a call nothing kept was sent again").toHaveLength(1);
  });

  it("CONTROL: a refused renewal leaves the server's own refusal", async () => {
    const { mailboxes, ApiError } = await import("../app/api-client.js");
    lapsed = true;
    renewal = "refused";
    const caught = await mailboxes.resync("m1").then(() => null, (e: unknown) => e);
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as InstanceType<typeof ApiError>).status).toBe(401);
    const { resetSessionTruthForTests } = await import("../app/shell/session-truth.js");
    resetSessionTruthForTests();
  });
});

// ── a press the outbox's ceiling ended while its renewal was out ─────────────────────────────

/* A SLOW LINK AFTER A WAKE: the press is refused late and its renewal lands past the press's
   75 s ceiling, after the engine ended that attempt and moved on (a newer press about the same
   field, or a Discard). The server commits the older key 0.2 s slower, so an older press sent
   again beside the newer one lands last. Mutation watched red: the re-send without its check. */
describe("a press the outbox's ceiling ended while its renewal was out", () => {
  let pace = { refusalMs: 20_000, renewalMs: 60_000 };
  let committed: string | null = null;
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const onM1 = (url: string) => /^\/api\/messages\/m1\/(move|triage)$/.test(url);
  const pressesUnder = (key: string) => sent.filter((s) => onM1(s.url) && s.headers["idempotency-key"] === key);
  const move = (folder: string) => ({ kind: "move", messageId: "m1", folder }) as unknown as EngineMutation;
  const triage = (state: string) => ({ kind: "triage_set", messageId: "m1", state }) as unknown as EngineMutation;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    committed = null;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url === "/auth/refresh") await wait(pace.renewalMs);
      else if (onM1(url) && lapsed) await wait(pace.refusalMs);
      else if (onM1(url)) {
        const older = sent.find((s) => onM1(s.url))?.headers["idempotency-key"];
        await wait(older === lowered(init)["idempotency-key"] ? 2_200 : 2_000);
        const body = JSON.parse(String(init?.body)) as { folder?: string; state?: string };
        committed = body.folder ?? body.state ?? null;
      }
      return serve(url, init);
    }) as typeof fetch;
  });
  afterEach(() => { vi.useRealTimers(); });

  for (const [older, newer, last] of [
    [move("ohmail/Archive"), move("INBOX"), "INBOX"],
    [triage("set_aside"), triage("none"), "none"],
  ] as const) {
    it(`${older.kind}: the ended press is not sent again beside the newer one, which stays the last word`, async () => {
      pace = { refusalMs: 20_000, renewalMs: 60_000 };
      const engine = await liveEngine();
      lapsed = true;
      const first = engine.mutate(older);
      await vi.advanceTimersByTimeAsync(3_000);
      const second = engine.mutate(newer);
      await vi.advanceTimersByTimeAsync(200_000);
      const [a] = await Promise.all([first, second]);
      expect(pressesUnder(a.key), "the press the ceiling ended was sent again when the renewal landed").toHaveLength(1);
      expect(committed, "the older press landed over the newer one").toBe(last);
    });
  }

  it("CONTROL: a renewal that lands inside the ceiling still sends the press again, and the newer one after it", async () => {
    pace = { refusalMs: 20_000, renewalMs: 30_000 };
    const engine = await liveEngine();
    lapsed = true;
    const first = engine.mutate(move("ohmail/Archive"));
    await vi.advanceTimersByTimeAsync(3_000);
    const second = engine.mutate(move("INBOX"));
    await vi.advanceTimersByTimeAsync(200_000);
    const [a] = await Promise.all([first, second]);
    expect(pressesUnder(a.key), "a press the engine still waited on was dropped after its renewal").toHaveLength(2);
    expect(committed).toBe("INBOX");
  });

  it("Discard after the ceiling is true: the press it withdrew is never sent when the renewal lands", async () => {
    pace = { refusalMs: 2_000, renewalMs: 74_000 };
    const engine = await liveEngine();
    lapsed = true;
    void engine.mutate(PARK);
    await vi.advanceTimersByTimeAsync(70_000);
    void engine.syncOnce().catch(() => undefined); // a drain waits on the same renewal past the ceiling
    await vi.advanceTimersByTimeAsync(5_500);
    const [row] = engine.queuedChanges();
    expect(await engine.withdrawQueued(row!.key), "Discard did not withdraw the waiting press").toBe("withdrawn");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pressesUnder(row!.key), "the withdrawn press reached the server when the renewal landed").toHaveLength(1);
    expect(committed).toBeNull();
  });
});
