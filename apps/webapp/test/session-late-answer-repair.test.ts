/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A LATE ANSWER, REPAIRED BY THE LIVE TAB. A page that unloads mid-renewal has its answer stored
 * after the next page presented the same token and stored its own, so the jar holds a row the server
 * killed. The live tab sees a `tf_csrf` no live page recorded and presents it once more, under the
 * name its own renewal went out as, inside the server's 60 s grace. Pages are module instances over
 * one jsdom jar, one fetch and one FIFO lock; a page's reload clears its timers, and the dead page's
 * answer is a bare cookie write.
 */

type Tab = {
  truth: typeof import("../app/shell/session-truth");
  refresh: typeof import("../app/session-refresh");
};

const MIN = 60_000;
/** The SERVER's grace and access window, which the stub below models (the client's are pinned to them). */
const SERVER_GRACE_MS = 60_000;
const SERVER_ACCESS_MS = 15 * MIN;
/** A CSRF value no mark, name or time can contain, so "not stored" is a real reading. */
const MARKED_CSRF = "csrf-value-never-stored";

/**
 * THE SERVER, keyed on the jar's `tf_csrf` (it travels with the refresh cookie) and on fake time:
 * the hot path, the replay of a name inside one access window, convergence inside the grace, and
 * past it a killed row refused plainly, or swept when it was killed under another name.
 */
interface Row { consumedAt: number | null; killed: boolean; by: string | null }
let rows = new Map<string, Row>();
let swept = false;
let names: string[] = [];
let minted = 0;
let loseNext = false;
/** How long the server's answer takes to land after it decided, for the lock's own pin. */
let latencyMs = 0;
let sent: Array<{ name: string; csrf: string | null; answer: string }> = [];

function serve(csrf: string | null, name: string): { csrf: string } | { code: string } {
  const now = Date.now();
  const row = csrf === null ? undefined : rows.get(csrf);
  if (swept || row === undefined) return { code: "refresh_revoked" };
  const mint = (): { csrf: string } => {
    const next = names.shift() ?? `c${(minted += 1)}`;
    rows.set(next, { consumedAt: null, killed: false, by: null });
    return { csrf: next };
  };
  const killLive = (by: string | null): void => {
    for (const r of rows.values()) if (r.consumedAt === null) Object.assign(r, { consumedAt: now, killed: true, by });
  };
  if (row.consumedAt === null) {
    Object.assign(row, { consumedAt: now, by: name });
    return mint();
  }
  const ago = now - row.consumedAt;
  if (!row.killed && row.by === name && ago <= SERVER_ACCESS_MS) { killLive(name); return mint(); }
  if (ago <= SERVER_GRACE_MS) { killLive(null); return mint(); }
  if (row.killed && (row.by === null || row.by === name)) return { code: "refresh_expired" };
  swept = true;
  return { code: "refresh_revoked" };
}

async function openTab(): Promise<Tab> {
  vi.resetModules();
  const truth = await import("../app/shell/session-truth");
  const refresh = await import("../app/session-refresh");
  return { truth, refresh };
}

async function advance(ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 500) {
    await vi.advanceTimersByTimeAsync(Math.min(500, left));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }
}

const jarCsrf = (): string | null => /(?:^|;\s*)tf_csrf=([^;]*)/.exec(document.cookie)?.[1] ?? null;
const tabKeys = (): string[] => Array.from({ length: window.sessionStorage.length }, (_, i) => window.sessionStorage.key(i)!);

/** A page renews and unloads before its answer lands; the next page presents the same token. */
async function race(lateCsrf: string, liveCsrf: string): Promise<{ b: Tab; name: string }> {
  const a = await openTab();
  names.push(lateCsrf);
  loseNext = true;
  expect(await a.refresh.resumeSession(), "the unloading page never hears its answer").toBe("unavailable");
  const b = await openTab();
  names.push(liveCsrf);
  expect(await b.refresh.resumeSession()).toBe("resumed");
  const name = sent.at(-1)!.name;
  expect(name, "the next page went out under the unloaded page's owed name").toBe(sent.at(-2)!.name);
  expect(jarCsrf()).toBe(liveCsrf);
  return { b, name };
}

/** The page reloads: its timers die with it, and the next page confirms the session on load. */
async function reload(): Promise<Tab> {
  // `clearAllTimers` also rewinds the fake clock to its install time; the reload keeps the clock.
  const now = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(now);
  const next = await openTab();
  next.truth.markSessionAlive();
  return next;
}

function resetWorld(): void {
  rows = new Map([["c0", { consumedAt: null, killed: false, by: null }]]);
  swept = false;
  names = [];
  loseNext = false;
  latencyMs = 0;
  sent = [];
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.cookie = "tf_owner=acct_A; Path=/";
  document.cookie = "tf_csrf=c0; Path=/";
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-05T08:00:00.000Z"));
  // Jitter at zero: a renewal is due exactly twelve minutes after its mint.
  vi.spyOn(Math, "random").mockReturnValue(0);
  minted = 0;
  resetWorld();
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
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (!String(input).includes("/auth/refresh")) return new Response("{}", { status: 200 });
    const csrf = new Headers(init?.headers as HeadersInit).get("x-csrf-token");
    const name = String(JSON.parse(String(init?.body ?? "{}")).attemptId);
    const verdict = serve(csrf, name);
    if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
    if ("code" in verdict) {
      sent.push({ name, csrf, answer: `401/${verdict.code}` });
      document.cookie = "tf_csrf=; Path=/; Max-Age=0";
      return new Response(JSON.stringify({ error: { code: verdict.code, message: "refused" } }),
        { status: 401, headers: { "content-type": "application/json" } });
    }
    if (loseNext) {
      loseNext = false;
      sent.push({ name, csrf, answer: "lost" });
      throw new TypeError("Failed to fetch");
    }
    sent.push({ name, csrf, answer: "204" });
    document.cookie = `tf_csrf=${verdict.csrf}; Path=/`;
    return new Response(null, { status: 204 });
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator as unknown as Record<string, unknown>, "locks");
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a late renewal answer, repaired by the live tab", () => {
  it("(1) a dead page's answer over this tab's is presented once, under this tab's own name, and the session stays", async () => {
    const { b, name } = await race("cX", "cT");
    document.cookie = "tf_csrf=cX; Path=/";
    names.push("cT2");
    await advance(1_000);
    expect(sent, "exactly one repair within a second").toHaveLength(3);
    expect(sent[2], "the late answer, under the name this tab's renewal went out as").toEqual(
      { name, csrf: "cX", answer: "204" });
    expect(jarCsrf()).toBe("cT2");
    expect(b.truth.sessionIsDead()).toBe(false);
    await advance(12 * MIN);
    expect(sent.slice(3).map((s) => `${s.csrf} ${s.answer}`), "the 12-minute renewal on the repaired jar")
      .toEqual(["cT2 204"]);
    expect(b.truth.sessionIsDead()).toBe(false);
  });

  it("(2) a sibling tab's renewal moves the jar and nothing is presented: its answer was recorded", async () => {
    const b = await openTab();
    expect(await b.refresh.resumeSession()).toBe("resumed");
    const c = await openTab();
    expect(await c.refresh.resumeSession()).toBe("resumed");
    await advance(2 * MIN);
    expect(sent.map((s) => s.answer), "a recorded rotation fired a repair").toEqual(["204", "204"]);
    expect(b.truth.sessionIsDead() || c.truth.sessionIsDead()).toBe(false);
  });

  it("(3) THE RESIDUAL: an answer landing after the watch is not repaired, and the renewal signs out", async () => {
    const { b } = await race("cX", "cT");
    await advance(b.refresh.LATE_ANSWER_WATCH_MS + 1_000);
    document.cookie = "tf_csrf=cX; Path=/";
    await advance(4_000);
    expect(sent, "the watch presented past its bound").toHaveLength(2);
    await advance(12 * MIN);
    // After it, the death's own heal schedule asks on a cleared jar: today's sign-out, unchanged.
    expect(`${sent[2]?.csrf} ${sent[2]?.answer}`, "the renewal presents the killed row past the grace")
      .toBe("cX 401/refresh_revoked");
    expect(b.truth.sessionIsDead()).toBe(true);
  });

  it("(4) a repair's own answer arms no watch: two tabs refused storage settle in at most two repairs", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("refused", "QuotaExceededError");
    });
    const b = await openTab();
    expect(await b.refresh.resumeSession()).toBe("resumed");
    const c = await openTab();
    expect(await c.refresh.resumeSession()).toBe("resumed");
    await advance(5 * MIN);
    expect(sent.length - 2, "repairs answering repairs: a storm").toBeLessThanOrEqual(2);
    expect(sent.every((s) => s.answer === "204"), "every presentation was a live row").toBe(true);
  });

  it("(5) a cleared jar ends the watch; the control, a watch still running, repairs under its own name", async () => {
    await race("cX", "cT");
    document.cookie = "tf_csrf=; Path=/; Max-Age=0";
    await advance(1_000);
    document.cookie = "tf_csrf=cX; Path=/";
    await advance(60_000);
    expect(sent, "a watch ended by a cleared jar presented what landed after").toHaveLength(2);

    resetWorld();
    const { name } = await race("cY", "cU");
    document.cookie = "tf_csrf=cY; Path=/";
    await advance(1_000);
    expect(sent.slice(2), "the control: the same late answer under a running watch").toEqual(
      [{ name, csrf: "cY", answer: "204" }]);
  });

  it("(6) two tabs watching one late answer send ONE repair: the second, asked again in the lock, finds it repaired", async () => {
    const { name } = await race("cX", "cT");
    const c = await openTab();
    expect(await c.refresh.resumeSession()).toBe("resumed");
    // Another holder of the origin's lock, so both watches fire before either repair can leave.
    let open: (() => void) | null = null;
    void navigator.locks.request("ohmail:session-refresh", { mode: "exclusive" },
      () => new Promise<void>((r) => { open = r; }));
    document.cookie = "tf_csrf=cX; Path=/";
    await advance(1_000);
    expect(sent, "a repair left past the lock").toHaveLength(3);
    open!();
    await advance(1_000);
    expect(sent.slice(3), "one repair, under the name of the presentation that killed the late row").toEqual(
      [{ name, csrf: "cX", answer: "204" }]);
  });

  it("(7) a sign-in's mint in another tab is a recorded answer: nothing is presented", async () => {
    const b = await openTab();
    expect(await b.refresh.resumeSession()).toBe("resumed");
    const c = await openTab();
    rows.set("cS", { consumedAt: null, killed: false, by: null });
    await c.refresh.withSessionCookieLock(async () => { document.cookie = "tf_csrf=cS; Path=/"; });
    await advance(2 * MIN);
    expect(sent, "a sign-in elsewhere read as a dead page's answer").toHaveLength(1);
    expect(b.truth.sessionIsDead()).toBe(false);
  });

  it("(8) the resume splash reloads just after its 204: the tab's next page continues the watch under the splash's name", async () => {
    const { name } = await race("cX", "cT");
    const app = await reload();
    document.cookie = "tf_csrf=cX; Path=/";
    names.push("cT2");
    await advance(1_000);
    expect(sent.slice(2), "the late answer, repaired by the page the splash reloaded into").toEqual(
      [{ name, csrf: "cX", answer: "204" }]);
    expect(app.truth.sessionIsDead()).toBe(false);
  });

  it("(9) another account's session in the same tab: the note goes and nothing is armed", async () => {
    const { b } = await race("cX", "cT");
    const key = `${b.refresh.SESSION_WATCH_PREFIX}acct_A`;
    expect(window.sessionStorage.getItem(key), "the control: the note was written").not.toBeNull();
    document.cookie = "tf_owner=acct_B; Path=/";
    rows.set("cB", { consumedAt: null, killed: false, by: null });
    document.cookie = "tf_csrf=cB; Path=/";
    const app = await reload();
    expect(window.sessionStorage.getItem(key), "the other account's note survived the switch").toBeNull();
    document.cookie = "tf_csrf=cX; Path=/";
    await advance(app.refresh.LATE_ANSWER_WATCH_MS);
    expect(sent, "a watch armed for another account's session").toHaveLength(2);
  });

  it("(10) a note naming another account than the session's arms nothing, even under this account's key, and goes", async () => {
    const b = await openTab();
    expect(await b.refresh.resumeSession()).toBe("resumed");
    const key = `${b.refresh.SESSION_WATCH_PREFIX}acct_A`;
    const note = JSON.parse(window.sessionStorage.getItem(key)!) as Record<string, unknown>;
    window.sessionStorage.setItem(key, JSON.stringify({ ...note, account: "acct_B" }));
    const app = await reload();
    expect(window.sessionStorage.getItem(key), "a note naming another account was kept").toBeNull();
    document.cookie = "tf_csrf=cX; Path=/";
    await advance(app.refresh.LATE_ANSWER_WATCH_MS);
    expect(sent, "a watch armed from a note naming another account").toHaveLength(1);
  });

  it("(11) the note sits under its account's key and holds the mark, the name, the time and the account, never a CSRF value", async () => {
    names.push(MARKED_CSRF);
    const b = await openTab();
    expect(await b.refresh.resumeSession()).toBe("resumed");
    expect(jarCsrf(), "the control: the answer's CSRF value is in the jar").toBe(MARKED_CSRF);
    expect(tabKeys()).toEqual([`${b.refresh.SESSION_WATCH_PREFIX}acct_A`]);
    const raw = window.sessionStorage.getItem(tabKeys()[0]!)!;
    expect(raw, "the note holds a CSRF value").not.toContain(MARKED_CSRF);
    const note = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(note).sort()).toEqual(["account", "at", "mark", "name"]);
    expect(note.account).toBe("acct_A");
    expect(note.name).toBe(sent[0]!.name);
  });

  it("(12) a repair's answer takes the note with it: the tab's next page does not watch again", async () => {
    const { b } = await race("cX", "cT");
    document.cookie = "tf_csrf=cX; Path=/";
    names.push("cT2");
    await advance(1_000);
    expect(sent, "the control: the repair went out").toHaveLength(3);
    expect(window.sessionStorage.getItem(`${b.refresh.SESSION_WATCH_PREFIX}acct_A`)).toBeNull();
    const app = await reload();
    document.cookie = "tf_csrf=cY; Path=/";
    await advance(app.refresh.LATE_ANSWER_WATCH_MS);
    expect(sent, "the next page watched again after a repair").toHaveLength(3);
  });

  /** Another account's sign-in landed in this jar and left no record this tab can read. */
  const anotherAccountsJar = (): void => {
    document.cookie = "tf_owner=acct_B; Path=/";
    rows.set("cB", { consumedAt: null, killed: false, by: null });
    document.cookie = "tf_csrf=cB; Path=/";
  };

  it("(13) a running watch meets another account's jar: nothing is presented, the watch and its note end", async () => {
    const { b } = await race("cX", "cT");
    const key = `${b.refresh.SESSION_WATCH_PREFIX}acct_A`;
    expect(window.sessionStorage.getItem(key), "the control: the note was written").not.toBeNull();
    anotherAccountsJar();
    await advance(1_000);
    expect(sent, "another account's jar presented under this account's renewal name").toHaveLength(2);
    expect(window.sessionStorage.getItem(key), "the note outlived the account it was written for").toBeNull();
    document.cookie = "tf_csrf=cX; Path=/";
    await advance(b.refresh.LATE_ANSWER_WATCH_MS);
    expect(sent, "the watch went on after the account changed").toHaveLength(2);
  });

  it("(14) the account changes while the repair waits for the lock: asked inside it, nothing goes out", async () => {
    const { b } = await race("cX", "cT");
    let open: (() => void) | null = null;
    void navigator.locks.request("ohmail:session-refresh", { mode: "exclusive" },
      () => new Promise<void>((r) => { open = r; }));
    document.cookie = "tf_csrf=cX; Path=/";
    await advance(1_000);
    expect(b.refresh.refreshInFlight(), "the control: the repair fired and waits for the lock").toBe(true);
    anotherAccountsJar();
    open!();
    await advance(1_000);
    expect(sent, "another account's jar presented under this account's renewal name").toHaveLength(2);
    expect(window.sessionStorage.getItem(`${b.refresh.SESSION_WATCH_PREFIX}acct_A`)).toBeNull();
  });

  it("(15) a resume that JOINS a repair the lock refuses asks for itself, as with no repair in flight", async () => {
    const { b } = await race("cX", "cT");
    const c = await openTab();
    let open: (() => void) | null = null;
    void navigator.locks.request("ohmail:session-refresh", { mode: "exclusive" },
      () => new Promise<void>((r) => { open = r; }));
    // The sibling's own resume, queued first, presents the late answer and converges it.
    const cResume = c.refresh.resumeSession();
    document.cookie = "tf_csrf=cX; Path=/";
    names.push("cT2");
    await advance(1_000);
    expect(b.refresh.refreshInFlight(), "the control: B's repair is in flight").toBe(true);
    // B's api() recovery joins B's repair, which its own question inside the lock then refuses.
    const bJoin = b.refresh.resumeSession();
    open!();
    await advance(1_000);
    expect(await cResume).toBe("resumed");
    expect(await bJoin, "a joined caller inherited a repair that did not happen").toBe("resumed");
    expect(sent.slice(2).map((s) => `${s.csrf} ${s.answer}`)).toEqual(["cX 204", "cT2 204"]);
    expect(b.truth.sessionIsDead()).toBe(false);
  });

  it("(16) THE RESIDUAL the claims name: an idle open tab does not repair once the renewing tab is gone", async () => {
    window.localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const idle = await openTab();
    // An open tab, its renewal armed twelve minutes out, its own tab's note already read.
    idle.truth.markSessionAlive();
    const { b } = await race("cX", "cT");
    b.refresh.forgetLateAnswerWatch();
    document.cookie = "tf_csrf=cX; Path=/";
    await advance(2_000);
    expect(sent, "an idle tab repaired: the changelog says only a tab that renewed within that minute does this").toHaveLength(2);
    await advance(30 * MIN);
    expect(idle.truth.sessionIsDead(), "the open idle tab is signed out at its renewal, as before").toBe(true);
  });
});

describe("the cross-tab lock serializes two tabs' refreshes", () => {
  it("(17) two tabs refresh at once, the answer 300 ms late: the second takes the first's answer and presents nothing", async () => {
    latencyMs = 300;
    const a = await openTab();
    const b = await openTab();
    const ra = a.refresh.resumeSession();
    const rb = b.refresh.resumeSession();
    await advance(2_000);
    expect(await ra).toBe("resumed");
    expect(await rb).toBe("resumed");
    // Not ["c0", "c1"]: a second rotation of a jar just renewed is one more step a crash can take it back.
    expect(sent.map((s) => s.csrf), "the second tab rotated the jar the first had just renewed").toEqual(["c0"]);
  });
});

describe("a jar another tab renewed, taken without presenting it", () => {
  it("(18) taking it leaves a renewal name still owed for that jar: its retry replays, nothing is swept", async () => {
    const a = await openTab();
    const staleJar = a.refresh.jarMark();
    const b = await openTab();
    expect(await b.refresh.resumeSession()).toBe("resumed");
    // A third tab presents the renewed jar and its answer is lost: that name is owed for this jar.
    const c = await openTab();
    loseNext = true;
    expect(await c.refresh.resumeSession()).toBe("unavailable");
    expect(await a.refresh.resumeSession({ staleJar }), "the caller that judged the old jar takes the new one").toBe("resumed");
    expect(sent.map((s) => s.answer)).toEqual(["204", "lost"]);
    await advance(2 * MIN);
    expect(await b.refresh.resumeSession(), "the next renewal of the taken jar was swept").toBe("resumed");
    expect(sent[2], "the owed name was dropped: past the grace, a new name is swept").toEqual(
      { name: sent[1]!.name, csrf: "c1", answer: "204" });
  });
});
