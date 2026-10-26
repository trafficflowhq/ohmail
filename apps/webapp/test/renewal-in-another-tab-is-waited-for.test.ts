/** @vitest-environment jsdom */
/**
 * A REQUEST WAITS FOR ANOTHER TAB'S RENEWAL, through the one cross-tab lock and the same 15 s bound.
 *
 * Tab 2 renews: it holds `ohmail:session-refresh` and its rotation replaces the access token at the
 * server before its answer lands. A request tab 1 sends beside it carried the replaced token, was
 * refused once, and its recovery rotated the family again. Two tabs here are two module instances over
 * one jar, one fetch and one FIFO lock; the server refuses an access generation a rotation replaced
 * and a write whose CSRF is not its session's. The invariant: one rotation, every request sent once.
 * A request that left before that renewal, or a second resume over the same jar, takes the renewed
 * jar instead of rotating it again: one rotation, the refused request sent once more.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** The cookies a navigation carried to the edge: what the resume page reads. */
const edge = vi.hoisted(() => ({ cookie: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => new Map(edge.cookie.split("; ").filter(Boolean)
    .map((c) => [c.slice(0, c.indexOf("=")), { value: c.slice(c.indexOf("=") + 1) }])),
}));

process.env.NEXT_PUBLIC_API_BASE = "/api";

const R_ARRIVE = 10;
const ARRIVE = 20;

interface Sent { at: number; url: string; status: number | null }
let sent: Sent[] = [];
let access = 0;
let serverAccess = 0;
let hangRefresh = false;
/** How long an API request takes to be answered. */
let arriveMs = ARRIVE;

const csrfOf = (g: number): string => `csrf-${g}`;
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const later = <T,>(ms: number, fn: () => T): Promise<T> => new Promise((r) => setTimeout(() => r(fn()), ms));

/** A rotation's answer: the account's marker stays as it is. */
function setJar(g: number): void {
  access = g;
  document.cookie = `tf_csrf=${csrfOf(g)}; Path=/`;
}

function serve(url: string, init?: RequestInit): Promise<Response> {
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)
    .map(([k, v]) => [k.toLowerCase(), v]));
  const carried = access;
  const row: Sent = { at: Date.now(), url, status: null };
  sent.push(row);
  if (url === "/auth/refresh") {
    if (hangRefresh) return new Promise<Response>(() => {});
    // The rotation lands at the server first; its answer reaches the jar a moment later.
    return later(R_ARRIVE, () => { serverAccess += 1; return serverAccess; })
      .then((g) => later(R_ARRIVE, () => { setJar(g); row.status = 204; return new Response(null, { status: 204 }); }));
  }
  return later(arriveMs, () => {
    let res: Response;
    if (carried !== serverAccess) res = json(401, { error: { code: "unauthorized", message: "authentication required" } });
    else if ((init?.method ?? "GET") !== "GET" && headers["x-csrf-token"] !== csrfOf(carried)) {
      res = json(403, { error: { code: "csrf_failed", message: "csrf validation failed" } });
    } else res = json(200, {});
    row.status = res.status;
    return res;
  });
}

async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5) {
    await vi.advanceTimersByTimeAsync(Math.min(5, left));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
}

async function openTab() {
  vi.resetModules();
  const truth = await import("../app/shell/session-truth");
  const client = await import("../app/api-client");
  const refresh = await import("../app/session-refresh");
  client.bindApiOwner("acct_A");
  return { truth, client, refresh };
}

const refreshes = (): number => sent.filter((s) => s.url === "/auth/refresh").length;
const asks = (url: string): Sent[] => sent.filter((s) => s.url === url);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-06T08:00:00.000Z"));
  vi.spyOn(Math, "random").mockReturnValue(0);
  sent = [];
  serverAccess = 0;
  hangRefresh = false;
  arriveMs = ARRIVE;
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.cookie = "tf_owner=acct_A; Path=/";
  setJar(0);
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
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => serve(String(input), init)) as unknown as typeof fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  const { resetSessionTruthForTests } = await import("../app/shell/session-truth");
  resetSessionTruthForTests();
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Tab 2 starts its renewal and its request is out; tab 1 then asks. */
async function besideTab2Renewal<T>(ask: (tab1: Awaited<ReturnType<typeof openTab>>) => Promise<T>): Promise<T> {
  const tab2 = await openTab();
  const renewal = tab2.refresh.resumeSession();
  await advance(1);
  expect(refreshes(), "control: tab 2's renewal is out").toBe(1);
  const tab1 = await openTab();
  const answer = ask(tab1);
  await advance(200);
  expect(await renewal).toBe("resumed");
  return answer;
}

describe("a request beside a renewal another tab is making", () => {
  it("api(): waits for it, leaves on the renewed jar, and is sent once with no second rotation", async () => {
    const res = await besideTab2Renewal((tab1) => tab1.client.api("/consent").then(() => "ok", (e: { status?: number }) => `refused:${e.status}`));
    expect(res).toBe("ok");
    expect(asks("/api/consent").map((s) => s.status), "the request was refused beside the other tab's rotation").toEqual([200]);
    expect(refreshes(), "the request's recovery rotated the family a second time").toBe(1);
  });

  it("the engine's transport: a press waits, carries the renewed CSRF, and is applied once", async () => {
    const res = await besideTab2Renewal((tab1) => tab1.truth.sessionFetch("/api/messages/m1/triage", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k1", "x-csrf-token": csrfOf(0) },
      body: "{}",
    }));
    expect(res.status).toBe(200);
    expect(asks("/api/messages/m1/triage").map((s) => s.status)).toEqual([200]);
    expect(refreshes()).toBe(1);
  });

  it("the wait is bounded: a renewal that never answers holds a request 15 s, then it goes", async () => {
    hangRefresh = true;
    const tab2 = await openTab();
    void tab2.refresh.resumeSession();
    await advance(1);
    const tab1 = await openTab();
    const start = Date.now();
    void tab1.client.api("/consent").catch(() => undefined);
    await advance(14_900);
    expect(asks("/api/consent"), "the request left before the bound").toEqual([]);
    await advance(200);
    const left = asks("/api/consent");
    expect(left, "the request never left").toHaveLength(1);
    expect(left[0]!.at - start).toBeGreaterThanOrEqual(15_000);
  });

  it("CONTROL: with no other tab renewing, a request leaves at once", async () => {
    const tab1 = await openTab();
    const start = Date.now();
    const done = tab1.client.api("/consent");
    await advance(1);
    expect(asks("/api/consent").map((s) => s.at - start)).toEqual([0]);
    await advance(100);
    await done;
    expect(refreshes()).toBe(0);
  });

  it("CONTROL: a renewal name left by an answer that landed long ago holds nothing", async () => {
    window.localStorage.setItem("ohmail.session.refreshAttempt",
      JSON.stringify({ id: "w-old", csrf: "00000000", at: Date.now() - 60_000 }));
    const tab1 = await openTab();
    const start = Date.now();
    void tab1.client.api("/consent").catch(() => undefined);
    await advance(1);
    expect(asks("/api/consent").map((s) => s.at - start)).toEqual([0]);
  });
});

/*
 * Each rotation the browser has not written to disk yet is one more step a crash can take the jar
 * back, and a jar two steps back is swept as a stolen token. So a jar another tab already renewed,
 * for the same account, is taken as it is.
 */
describe("a jar another tab renewed is taken, never rotated again", () => {
  it("two resume splashes over one lapsed jar: one rotation, and both resume", async () => {
    document.cookie = "tf_csrf=; Path=/; Max-Age=0";
    const [tab1, tab2] = [await openTab(), await openTab()];
    const answers = [tab1, tab2].map((t) => t.refresh.resumeSession({ landing: true, mayProceed: () => true }));
    await advance(200);
    expect(await Promise.all(answers)).toEqual(["resumed", "resumed"]);
    expect(refreshes(), "the second splash rotated the jar the first had just renewed").toBe(1);
  });

  // Refused while the other tab's renewal is out (20 ms), or after its answer moved the jar (60 ms).
  it.each([20, 60])("api(): a request that left before another tab's renewal (refused at %i ms) is sent again on its jar", async (ms) => {
    arriveMs = ms;
    const [tab1, tab2] = [await openTab(), await openTab()];
    const res = tab1.client.api("/consent").then(() => "ok", (e: { status?: number }) => `refused:${e.status}`);
    await advance(1);
    const renewal = tab2.refresh.resumeSession();
    await advance(300);
    expect([await renewal, await res]).toEqual(["resumed", "ok"]);
    expect(asks("/api/consent").map((s) => s.status)).toEqual([401, 200]);
    expect(refreshes(), "the request's recovery rotated the jar the other tab had just renewed").toBe(1);
  });

  it.each([20, 60])("the engine's transport: a press that left before another tab's renewal (refused at %i ms) is sent again on its jar", async (ms) => {
    arriveMs = ms;
    const [tab1, tab2] = [await openTab(), await openTab()];
    const res = tab1.truth.sessionFetch("/api/messages/m1/triage", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "k1", "x-csrf-token": csrfOf(0) },
      body: "{}",
    });
    await advance(1);
    const renewal = tab2.refresh.resumeSession();
    await advance(300);
    expect([await renewal, (await res).status]).toEqual(["resumed", 200]);
    expect(asks("/api/messages/m1/triage").map((s) => s.status)).toEqual([401, 200]);
    expect(refreshes(), "the press's recovery rotated the jar the other tab had just renewed").toBe(1);
  });

  it("CONTROL: a jar another tab signed in to as another account is not taken; the resume asks the server", async () => {
    const [tab1, tab2] = [await openTab(), await openTab()];
    let land!: () => void;
    const signIn = tab2.refresh.withSessionCookieLock(() => new Promise<void>((r) => { land = r; }).then(() => {
      document.cookie = "tf_owner=acct_B; Path=/";
      document.cookie = "tf_csrf=csrf-B; Path=/";
    }));
    await advance(1);
    const resume = tab1.refresh.resumeSession();
    await advance(1);
    land();
    await advance(100);
    await signIn;
    expect(await resume).toBe("resumed");
    expect(refreshes(), "acct_B's session was taken for the resume asked over acct_A's").toBe(1);
  });
});

/*
 * The edge serves the splash for the jar its navigation carried, and the splash's effect can run after
 * another tab's renewal has landed. So it judges the jar the edge judged: tab 2 here is what
 * `resume/page.tsx` serves for the cookies its navigation carried, mounted with its own modules.
 */
describe("a resume splash judges the jar its navigation carried", () => {
  let reloads = 0;
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  const real = Object.getOwnPropertyDescriptor(window, "location");
  beforeEach(() => {
    reloads = 0;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "https://mail.example", href: "https://mail.example/", replace() {}, reload() { reloads += 1; } },
    });
  });
  afterEach(async () => {
    const r = root;
    root = null;
    if (r) await act(async () => { r.unmount(); });
    host?.remove();
    if (real) Object.defineProperty(window, "location", real);
    else Reflect.deleteProperty(window, "location");
  });

  async function splash(carried: string) {
    edge.cookie = carried;
    vi.resetModules();
    const { default: Page } = await import("../app/(product)/resume/page");
    const refresh = await import("../app/session-refresh");
    const page = await Page();
    host = document.body.appendChild(document.createElement("div"));
    const r = createRoot(host);
    root = r;
    const shell = React.createElement(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: page });
    await act(async () => { r.render(shell); });
    await advance(100);
    return refresh;
  }
  /** The access window lapsed: what both navigations carried. */
  const lapsed = (): string => { document.cookie = "tf_csrf=; Path=/; Max-Age=0"; return document.cookie; };
  /** Tab 1, the first splash: its renewal's answer lands and it records it. */
  async function renewedElsewhere(): Promise<void> {
    const first = (await openTab()).refresh.resumeSession({ landing: true, mayProceed: () => true });
    await advance(100);
    expect(await first).toBe("resumed");
  }

  it("two splashes over one lapsed jar, the second asking after the first's answer: one rotation, both resume", async () => {
    const carried = lapsed();
    await renewedElsewhere();
    await splash(carried);
    expect(reloads, "the second splash did not resume").toBe(1);
    expect(refreshes(), "the second splash rotated the jar the first had just renewed").toBe(1);
  });

  it("CONTROL: a jar moved by an answer no live page recorded is still presented", async () => {
    const carried = lapsed();
    setJar(1); // a closed page's answer, stored after the navigation
    await splash(carried);
    expect([refreshes(), reloads]).toEqual([1, 1]);
  });

  it("CONTROL: a jar another account signed in to is neither taken nor rotated; the splash leaves", async () => {
    const carried = lapsed();
    const tab1 = await openTab();
    await tab1.refresh.withSessionCookieLock(async () => { document.cookie = "tf_owner=acct_B; Path=/"; setJar(1); });
    const tab2 = await splash(carried);
    expect(tab2.lastRefreshReport(), "acct_B's session was taken for acct_A's splash").toBeNull();
    expect([refreshes(), reloads]).toEqual([0, 1]);
  });

  // The edge refused the access token of a jar it saw whole; with no marker (a cross-site navigation)
  // it saw no jar at all, and the splash judges the jar when it asks. Either way it is presented.
  it.each<[string, boolean]>([["the jar the edge saw", true], ["a cross-site navigation", false]])(
    "CONTROL: a jar that has not moved past what the edge saw is presented (%s)", async (_, seen) => {
      await renewedElsewhere();
      await splash(seen ? document.cookie : "");
      expect([refreshes(), reloads]).toEqual([2, 1]);
    });
});
