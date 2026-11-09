/**
 * ═══ THE WAY BACK FROM A CLOSED ACCOUNT, ON THE PHONE ══════════════════════════════════════════
 *
 * The renew flow's rules, as ratified on 2026-09-26, each held
 * through the modules the phone's wall and shell render — there is no React Native renderer here,
 * so the components are held by a census over their source proving they wire what these answer:
 *
 *  1. THE PRESS MINTS AT THE PRESS — `POST /account/manage-link` with the language; no action
 *     carries an address, and a held `manageUrl` is never opened.
 *  2. THE 403 BY NAME — an unconfirmed address is its own sentence, never the mint-failed one.
 *  3. THE WALL BEFORE MAIL — no stored `open` for the pairing: the verdict is asked before the tabs
 *     paint, a refused answer raises the wall first, and the ask is bounded (fail-open at 3 s).
 *  4. THE LIFT — only `access: "open"` on the fresh read takes the wall down.
 *  5. THE STALE-402 WINDOW — inside a minute of an open verdict a 402 raises nothing.
 *  6. THE SCHEDULE — a read on every return, one a minute, a bounded poll after the press.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCESS_REFUSED_CODE, STALE_REFUSAL_MS, accessLock, clearAccessLock, raiseAccessLock,
  refusalIsStale, resetAccessLockForTests, withAccessLock, type AccessRefusedFacts,
} from "../src/net/access-lock";
import {
  accessOf, mintManageLink, opensTheWall, readAccess, refusedFactsOf,
} from "../src/net/account";
import { isAccessRefusal, SyncRunner, type DrainEngine } from "../src/net/drain";
import type { AppLifecycle, CadenceTimers } from "../src/net/drain-cadence";
import type { ConnectedSession } from "../src/net/pairing";
import {
  ACCESS_VERDICT_KEY, VERDICTS_KEPT, bindAccessVerdicts, recordVerdict, resetAccessVerdictsForTests,
  storedVerdict, verdictsReady, verdictsSettled,
} from "../src/state/access-verdict";
import type { SecureKV } from "../src/state/servers";
import {
  FIRST_PAINT_VERDICT_MS, awaitFirstPaint, paintsAtOnce, type FirstPaintInputs,
} from "../src/ui/first-paint";
import {
  LIFT_POLL_MAX, LIFT_POLL_MS, LIFT_READ_BOUND_MS, RETURN_DEBOUNCE_MS, WALL_READ_MS, wallLift, type WallCheck,
} from "../src/ui/wall-lift";
import { wallSays } from "../src/ui/wall-says";
import { lifecycleOf } from "../src/net/access-lock";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const read = (rel: string): string => fs.readFileSync(path.join(APP, rel), "utf8");

const CLOSED = {
  state: "closed", closedReason: "trial_ended",
  closedAt: "2026-08-25T10:00:00.000Z", erasureAt: "2026-10-23T10:00:00.000Z",
};
const REFUSED_BODY = {
  metered: true, access: "refused", canAddMailbox: false, mailboxes: 0, aiEnabled: false,
  lifecycle: CLOSED, manageUrl: "https://plane.test/manage?token=OLD", exportPath: "/account/export",
};
const OPEN_BODY = { metered: true, access: "open", canAddMailbox: true, mailboxes: 2, aiEnabled: true };
const OLD_TOKEN = "token=OLD";

/** The 402 the gate answers, as the API writes it. */
const refusal402 = (): Response => new Response(JSON.stringify({
  error: { code: ACCESS_REFUSED_CODE, message: "kept", details: { reason: "payment_required", lifecycle: CLOSED } },
}), { status: 402 });

/** A paired Cloud session whose transport is a script the case writes. */
function session(answer: (url: string, init?: { method?: string; body?: string }) => Response | Promise<Response>) {
  const seen: { url: string; method: string; body: string | undefined }[] = [];
  const fetch = async (url: string, init?: unknown): Promise<Response> => {
    const i = (init ?? {}) as { method?: string; body?: string };
    seen.push({ url, method: i.method ?? "GET", body: i.body });
    return answer(url, i);
  };
  const s = {
    standalone: false,
    profile: { id: "pairing-1", origin: "https://cloud.test", apiBase: null, flavor: "managed" },
    fetch,
  } as unknown as ConnectedSession;
  return { s, seen };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const facts = (over: Partial<AccessRefusedFacts> = {}): AccessRefusedFacts => ({
  reason: "payment_required",
  manageUrl: "https://plane.test/manage?token=OLD",
  exportPath: "/account/export",
  lifecycle: lifecycleOf(CLOSED)!,
  ...over,
});

/** A clock the test turns: nothing fires until {@link advance}. */
function handClock() {
  let seq = 0;
  let at = 0;
  const due = new Map<number, { when: number; fn: () => void }>();
  const timers: CadenceTimers = {
    set: (fn, ms) => { seq += 1; due.set(seq, { when: at + ms, fn }); return seq; },
    clear: (handle) => { due.delete(handle as number); },
  };
  /* A real macrotask turn drains every microtask the fired timer's work queued. */
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  return {
    timers,
    now: () => at,
    armed: () => due.size,
    /** Move the clock by `ms`, firing each due timer in order and letting its work settle. */
    advance: async (ms: number): Promise<void> => {
      const end = at + ms;
      await flush();
      for (;;) {
        const next = [...due.entries()].filter(([, d]) => d.when <= end).sort((a, b) => a[1].when - b[1].when)[0];
        if (next === undefined) break;
        due.delete(next[0]);
        at = next[1].when;
        next[1].fn();
        await flush();
      }
      at = end;
      await flush();
    },
    flush,
  };
}

function lifecycle(initial = "active") {
  let status = initial;
  const listeners = new Set<(s: string) => void>();
  const source: AppLifecycle = {
    now: () => status,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return { source, move: (next: string) => { status = next; for (const l of listeners) l(next); } };
}

function memoryKV(seed: Record<string, string> = {}, opts: { refuse?: boolean } = {}) {
  const map = new Map(Object.entries(seed));
  const writes: string[] = [];
  const kv: SecureKV = {
    get: async (k) => { if (opts.refuse) throw new Error("locked"); return map.get(k) ?? null; },
    set: async (k, v) => { writes.push(v); map.set(k, v); },
    remove: async (k) => { map.delete(k); },
  };
  return { kv, map, writes };
}

beforeEach(() => {
  resetAccessLockForTests();
  resetAccessVerdictsForTests();
});

/* ── 1. the press mints at the press ─────────────────────────────────────────────────────────── */

describe("the way back mints its link at the press — never a held address", () => {
  it("NO ACTION ON THE WALL CARRIES AN ADDRESS — `manageUrl` only decides the button exists", () => {
    const plan = wallSays(facts(), "sideload");
    const manage = plan.actions.find((a) => a.id === "manage")!;
    const del = plan.actions.find((a) => a.id === "delete")!;
    expect(manage).toBeDefined();
    expect("url" in manage, "the way back holds a link that lives ten minutes and once").toBe(false);
    expect("url" in del).toBe(false);
    expect(JSON.stringify(plan)).not.toContain(OLD_TOKEN);
  });

  it("the press POSTs the manage-link door with the language, and answers ITS link", async () => {
    const { s, seen } = session(() => json({ url: "https://plane.test/manage?token=FRESH&lang=de" }));
    const link = await mintManageLink(s, "de");
    expect(link).toEqual({ kind: "url", url: "https://plane.test/manage?token=FRESH&lang=de" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://cloud.test/account/manage-link");
    expect(seen[0]!.method).toBe("POST");
    expect(JSON.parse(seen[0]!.body!)).toEqual({ lang: "de" });
    expect(JSON.stringify(seen)).not.toContain(OLD_TOKEN);
  });

  it("an answer that is not an https page is no page to open", async () => {
    for (const url of ["http://plane.test/manage", "javascript:alert(1)", "", 7, null]) {
      const { s } = session(() => json({ url }));
      expect(await mintManageLink(s, "en")).toEqual({ kind: "failed" });
    }
  });

  it("THE WALL'S PRESS GOES THROUGH THE MINT and opens only what the mint answered", () => {
    const wall = read("src/ui/AccountWall.tsx");
    expect(wall).toContain("mintManageLink(session, locale)");
    expect(wall).toMatch(/if \(link\.kind === "url"\) \{[\s\S]*?leave\(link\.url\);/);
    // Nothing on the wall opens an address it holds: the only other pages are the guide and the deletion page.
    expect(wall).not.toMatch(/leave\(action\.url\)|facts\.manageUrl/);
    const opened = [...wall.matchAll(/leave\(([^)]*)\)/g)].map((m) => m[1]);
    expect(new Set(opened)).toEqual(new Set(["link.url", "SELF_HOST_GUIDE", "DELETE_ACCOUNT_URL"]));
  });

  it("only the way back arms the poll — a deletion is no payment", () => {
    const wall = read("src/ui/AccountWall.tsx");
    expect(wall).toContain('if (on === "manage") lift.current?.armPoll();');
    expect(wall.match(/armPoll\(\)/g) ?? []).toHaveLength(1);
  });

  it("THE STRIP'S PRESS MINTS TOO — it never reads, let alone keeps, an address from an answer", () => {
    const strip = read("src/ui/LifecycleStrip.tsx");
    expect(strip).not.toContain("setManageUrl");
    // Not even as the fact that decides the press: `stripPress` decides it from the notice.
    expect(strip).not.toContain("manageUrl");
    expect(strip).toContain("mintManageLink(session, locale)");
    expect(strip).toMatch(/Linking\.openURL\(link\.url\)/);
  });
});

/* ── 2. the 403 by name ──────────────────────────────────────────────────────────────────────── */

describe("an unconfirmed address is said by name", () => {
  it("403 email_unverified is its own answer; every other refusal is the mint failing", async () => {
    const answers: [Response | Error, string][] = [
      [json({ error: { code: "email_unverified", message: "x" } }, 403), "unverified"],
      [json({ error: { code: "step_up_required", message: "x" } }, 403), "failed"],
      [json({ error: { code: "no_manage_surface", message: "x" } }, 404), "failed"],
      [new Response("<html>gateway</html>", { status: 502 }), "failed"],
      [new Error("the network went away"), "failed"],
    ];
    for (const [answer, kind] of answers) {
      const { s } = session(() => { if (answer instanceof Error) throw answer; return answer; });
      expect((await mintManageLink(s, "en")).kind).toBe(kind);
    }
  });

  it("both screens render the two refusals as two sentences", () => {
    for (const rel of ["src/ui/AccountWall.tsx", "src/ui/LifecycleStrip.tsx"]) {
      const src = read(rel);
      expect(src).toMatch(/=== "unverified" \? Copy\.wallMintUnverified : Copy\.wallMintFailed/);
    }
    expect(EN.wallMintUnverified).not.toBe(EN.wallMintFailed);
    expect(DE.wallMintUnverified).not.toBe(DE.wallMintFailed);
  });
});

/* ── 3. the wall before mail ─────────────────────────────────────────────────────────────────── */

describe("the tabs wait for the verdict when this pairing has none", () => {
  const inputs = (over: Partial<FirstPaintInputs> = {}): FirstPaintInputs => ({
    refusable: true, ready: () => true, settled: () => Promise.resolve(),
    stored: () => null, ask: () => Promise.resolve(), ...over,
  });

  it("only a stored `open` — or a door that cannot refuse — paints the mirror with nothing asked", () => {
    expect(paintsAtOnce(inputs())).toBe(false);
    expect(paintsAtOnce(inputs({ stored: () => "closed" }))).toBe(false);
    expect(paintsAtOnce(inputs({ stored: () => "open" }))).toBe(true);
    expect(paintsAtOnce(inputs({ stored: () => "open", ready: () => false }))).toBe(false);
    expect(paintsAtOnce(inputs({ refusable: false }))).toBe(true);
  });

  it("A CLOSED ACCOUNT'S FIRST FRAME IS THE WALL: the refusal is up before the mail may paint", async () => {
    const { s, seen } = session(() => json(REFUSED_BODY));
    let lockAtOpen: AccessRefusedFacts | null | undefined;
    await new Promise<void>((done) => {
      awaitFirstPaint(inputs({ ask: () => readAccess(s) }), () => { lockAtOpen = accessLock(); done(); });
    });
    expect(seen.map((r) => r.url)).toEqual(["https://cloud.test/account/access"]);
    expect(lockAtOpen, "the tabs were released with no wall up").not.toBeNull();
    expect(lockAtOpen!.lifecycle?.closedReason).toBe("trial_ended");
    // The held address rides the facts only as the fact that a page exists.
    expect(lockAtOpen!.manageUrl).toBeDefined();
    expect(storedVerdict("pairing-1")).toBe("closed");
  });

  it("an open answer releases the tabs with no wall, and the next launch paints at once", async () => {
    const { s } = session(() => json(OPEN_BODY));
    await new Promise<void>((done) => { awaitFirstPaint(inputs({ ask: () => readAccess(s) }), done); });
    expect(accessLock()).toBeNull();
    expect(paintsAtOnce(inputs({ stored: () => storedVerdict("pairing-1") }))).toBe(true);
  });

  it("FAIL-OPEN AT THE BOUND: a read that never answers releases the tabs at 3 s, not before", async () => {
    const clock = handClock();
    let opened = 0;
    awaitFirstPaint(inputs({ ask: () => new Promise(() => undefined), timers: clock.timers }), () => { opened += 1; });
    await clock.advance(FIRST_PAINT_VERDICT_MS - 1);
    expect(opened).toBe(0);
    await clock.advance(1);
    expect(opened).toBe(1);
    await clock.advance(60_000);
    expect(opened, "released once, not twice").toBe(1);
  });

  it("a row read late that holds `open` releases the tabs with no read", async () => {
    let asked = 0;
    let stored: "open" | null = null;
    let release!: () => void;
    const settled = new Promise<void>((r) => { release = r; });
    let opened = false;
    awaitFirstPaint(inputs({
      ready: () => false, settled: () => settled, stored: () => stored,
      ask: () => { asked += 1; return Promise.resolve(); },
    }), () => { opened = true; });
    stored = "open";
    release();
    await settled;
    await Promise.resolve();
    expect(opened).toBe(true);
    expect(asked).toBe(0);
  });

  it("THE SHELL WIRES IT: the gate frame stands after the wall and before the mail", () => {
    const gated = read("src/ui/Gated.tsx");
    const wall = gated.indexOf('if (verdict.to === "wall")');
    const gate = gated.indexOf("if (!painted) return <AccessGate />;");
    const mail = gated.indexOf("<LifecycleStrip session={session} />");
    expect(wall).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(wall);
    expect(mail).toBeGreaterThan(gate);
    expect(gated).toContain('session.profile.flavor === "managed"');
    expect(gated).toContain("ask: () => readAccess(session)");
    expect(gated).toContain('import "../state/access-verdict-native";');
  });
});

/* ── 4. the lift ─────────────────────────────────────────────────────────────────────────────── */

describe("the wall lifts on the fresh read's `access: \"open\"` and on nothing else", () => {
  it("an open answer takes a standing wall down", async () => {
    raiseAccessLock(facts());
    const { s } = session(() => json(OPEN_BODY));
    await readAccess(s);
    expect(accessLock()).toBeNull();
  });

  it("AN OLDER API — no `access` field — never lifts, whatever else it says", async () => {
    raiseAccessLock(facts());
    const { metered, canAddMailbox, mailboxes, aiEnabled } = OPEN_BODY;
    const { s } = session(() => json({ metered, canAddMailbox, mailboxes, aiEnabled }));
    const a = await readAccess(s);
    expect(a).not.toBeNull();
    expect(opensTheWall(a!)).toBe(false);
    expect(accessLock()).not.toBeNull();
  });

  it("a refused answer keeps the wall, with the newest facts", async () => {
    raiseAccessLock({ reason: "payment_required" });
    const { s } = session(() => json(REFUSED_BODY));
    await readAccess(s);
    expect(accessLock()?.lifecycle?.closedAt).toBe(CLOSED.closedAt);
  });

  it("ANOTHER DOOR'S 200 lifts nothing — the incidental answer is not the verdict", async () => {
    raiseAccessLock(facts());
    const wrapped = withAccessLock(async () => json(OPEN_BODY));
    await wrapped("https://cloud.test/mailboxes");
    await wrapped("https://cloud.test/account/access");
    expect(accessLock()).not.toBeNull();
  });

  it("the predicate is exactly metered AND open", () => {
    expect(opensTheWall(accessOf(OPEN_BODY)!)).toBe(true);
    expect(opensTheWall(accessOf({ metered: false, access: "open" })!)).toBe(false);
    expect(opensTheWall(accessOf({ ...OPEN_BODY, access: "refused" })!)).toBe(false);
    expect(opensTheWall(accessOf({ ...OPEN_BODY, access: "OPEN" })!)).toBe(false);
    expect(refusedFactsOf(accessOf(REFUSED_BODY)!)).toMatchObject({ reason: "payment_required" });
    expect(refusedFactsOf(accessOf(OPEN_BODY)!)).toBeNull();
  });

  it("signing in again still clears it — the shipped gesture is untouched", () => {
    raiseAccessLock(facts());
    clearAccessLock();
    expect(accessLock()).toBeNull();
  });
});

/* ── 5. the stale-402 window ─────────────────────────────────────────────────────────────────── */

describe("a 402 inside a minute of an open verdict is another instance's cache", () => {
  it("the wall that just lifted is not put back by a stale 402", async () => {
    raiseAccessLock(facts());
    const { s } = session(() => json(OPEN_BODY));
    await readAccess(s);
    expect(accessLock()).toBeNull();
    const res = await withAccessLock(async () => refusal402())("https://cloud.test/sync");
    expect(res.status, "the caller still sees what the server sent").toBe(402);
    expect(accessLock(), "a stale 402 re-raised the wall").toBeNull();
  });

  it("past the window a 402 is a closure again", () => {
    const at = Date.now();
    raiseAccessLock(facts());
    clearAccessLock();
    expect(refusalIsStale(at)).toBe(false);
  });

  it("the window is the service's cache life, measured from the open verdict", async () => {
    const { s } = session(() => json(OPEN_BODY));
    const before = Date.now();
    await readAccess(s);
    expect(refusalIsStale(before + STALE_REFUSAL_MS - 1_000)).toBe(true);
    expect(refusalIsStale(Date.now() + STALE_REFUSAL_MS + 1)).toBe(false);
  });

  it("A FRESH REFUSED READ CLOSES THE WINDOW — the service's own word is never stale", async () => {
    let body: unknown = OPEN_BODY;
    const { s } = session(() => json(body));
    await readAccess(s);
    body = REFUSED_BODY;
    // The next read comes on a later return: one inside the debounce joins the first.
    const t = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(t + RETURN_DEBOUNCE_MS);
    await readAccess(s);
    spy.mockRestore();
    expect(accessLock()).not.toBeNull();
    clearAccessLock();
    await withAccessLock(async () => refusal402())("https://cloud.test/sync");
    expect(accessLock(), "a 402 after a fresh refusal must raise").not.toBeNull();
  });

  it("THE DRAIN IS NOT FAILING: a 402 round counts nothing and says nothing; a 503 still does", async () => {
    const errors: unknown[] = [];
    const runner = new SyncRunner({ syncing: () => undefined, error: (e) => { if (e !== null) errors.push(e); } });
    const fail = (err: unknown): DrainEngine => ({
      start: async () => { throw err; }, syncOnce: async () => { throw err; }, hydrate: async () => undefined,
    });
    const refused = Object.assign(new Error("subscription required"), { status: 402, code: ACCESS_REFUSED_CODE });
    await runner.run(fail(refused), false);
    await runner.run(fail(refused), false);
    expect(runner.failures()).toBe(0);
    expect(errors).toEqual([]);
    expect(isAccessRefusal(refused)).toBe(true);
    // The control: an outage is still an outage.
    await runner.run(fail(Object.assign(new Error("unavailable"), { status: 503, code: "db_busy" })), false);
    expect(runner.failures()).toBe(1);
    expect(errors).toHaveLength(1);
    // A 402 carrying another code is not the account's refusal.
    expect(isAccessRefusal(Object.assign(new Error("x"), { status: 402, code: "payment_required" }))).toBe(false);
  });

  it("the cadence stands down while the wall stands, and the lift drains at once", () => {
    const conn = read("src/net/connection.tsx");
    expect(conn).toContain("if (accessLock() !== null) return Promise.resolve(0);");
    expect(conn).toMatch(/onAccessLock\(\(facts\) => \{[\s\S]*?if \(facts !== null \|\| at\.k !== "live"\) return;[\s\S]*?runner\.request\(session\.engine\)/);
  });
});

/* ── 6. the schedule ─────────────────────────────────────────────────────────────────────────── */

describe("when the wall asks", () => {
  function rig(answers: () => boolean) {
    const clock = handClock();
    const life = lifecycle("active");
    const checks: WallCheck[] = [];
    let reads = 0;
    const machine = wallLift({
      opens: async () => { reads += 1; return answers(); },
      lifecycle: life.source,
      onCheck: (c) => checks.push(c),
      timers: clock.timers,
      now: clock.now,
      minute: WALL_READ_MS, // the wall's own call (`AccountWall.tsx`)
    });
    return { clock, life, checks, machine, reads: () => reads };
  }

  it("one read on every return to the foreground, and none on a flicker", async () => {
    const r = rig(() => false);
    r.life.move("background");
    r.life.move("active");
    await r.clock.flush();
    expect(r.reads()).toBe(1);
    r.life.move("background");
    r.life.move("active");
    await r.clock.flush();
    expect(r.reads(), "a return inside the debounce asked again").toBe(1);
    await r.clock.advance(2_000);
    r.life.move("background");
    r.life.move("active");
    await r.clock.flush();
    expect(r.reads()).toBe(2);
    r.machine.stop();
  });

  it("one read a minute while the app is in front, none while it is not", async () => {
    const r = rig(() => false);
    await r.clock.advance(WALL_READ_MS);
    expect(r.reads()).toBe(1);
    await r.clock.advance(WALL_READ_MS);
    expect(r.reads()).toBe(2);
    r.life.move("background");
    await r.clock.advance(WALL_READ_MS);
    expect(r.reads()).toBe(2);
    r.machine.stop();
    expect(r.clock.armed(), "a stopped wall keeps a timer").toBe(0);
  });

  it("AT MOST ONE A MINUTE: a read on the return answers that minute's question", async () => {
    const r = rig(() => false);
    await r.clock.advance(WALL_READ_MS - 5_000);
    r.life.move("background");
    r.life.move("active");
    await r.clock.flush();
    expect(r.reads()).toBe(1);
    await r.clock.advance(5_000);
    expect(r.reads(), "the minute tick asked 5 s after the return did").toBe(1);
    r.machine.stop();
  });

  it("AFTER THE PRESS, the return polls every 2 s — 30 closed answers, then pending", async () => {
    const r = rig(() => false);
    r.machine.armPoll();
    r.life.move("background");
    r.life.move("active");
    await r.clock.flush();
    expect(r.checks).toEqual(["checking"]);
    await r.clock.advance(LIFT_POLL_MS * (LIFT_POLL_MAX - 1));
    expect(r.reads()).toBe(LIFT_POLL_MAX);
    expect(r.checks).toEqual(["checking", "pending"]);
    // The 31st is never asked without a press: the minute read is the only other question.
    await r.clock.advance(WALL_READ_MS - 1);
    expect(r.reads()).toBe(LIFT_POLL_MAX);
    r.machine.stop();
  });

  it("an open answer ends the poll where it lands", async () => {
    let n = 0;
    const r = rig(() => { n += 1; return n === 3; });
    r.machine.armPoll();
    r.life.move("active");
    await r.clock.advance(LIFT_POLL_MS * 10);
    expect(r.reads()).toBe(3);
    expect(r.checks).toEqual(["checking", "idle"]);
    r.machine.stop();
  });

  it("Check again is one more bounded poll", async () => {
    const r = rig(() => false);
    r.machine.checkAgain();
    await r.clock.advance(LIFT_POLL_MS * LIFT_POLL_MAX);
    expect(r.reads()).toBe(LIFT_POLL_MAX);
    r.machine.checkAgain();
    await r.clock.advance(LIFT_POLL_MS * LIFT_POLL_MAX);
    expect(r.reads()).toBe(2 * LIFT_POLL_MAX);
    expect(r.checks).toEqual(["checking", "pending", "checking", "pending"]);
    r.machine.stop();
  });

  it("a read that never answers is no answer — the poll moves on at the bound", async () => {
    const clock = handClock();
    const checks: WallCheck[] = [];
    let reads = 0;
    const machine = wallLift({
      opens: () => { reads += 1; return new Promise<boolean>(() => undefined); },
      lifecycle: lifecycle().source, onCheck: (c) => checks.push(c), timers: clock.timers, now: clock.now,
    });
    machine.checkAgain();
    await clock.advance((LIFT_READ_BOUND_MS + LIFT_POLL_MS) * LIFT_POLL_MAX);
    expect(reads).toBe(LIFT_POLL_MAX);
    expect(checks).toEqual(["checking", "pending"]);
    machine.stop();
  });

  it("the wall renders the three states the schedule answers, and keeps the way off", () => {
    const wall = read("src/ui/AccountWall.tsx");
    expect(wall).toContain('check === "checking"');
    expect(wall).toContain("Copy.wallChecking");
    expect(wall).toContain("Copy.wallPending");
    expect(wall).toContain("Copy.wallCheckAgain");
    expect(wall).toContain('plan.actions.filter((a) => a.id === "servers")');
    expect(wall).toContain("opensTheWall(a)");
  });
});

/* ── the stored verdict ──────────────────────────────────────────────────────────────────────── */

describe("the verdict this phone keeps per pairing", () => {
  it("is read once from the keystore and written whole when it changes", async () => {
    const { kv, writes } = memoryKV({ [ACCESS_VERDICT_KEY]: JSON.stringify({ a: "open", b: "closed", c: "maybe" }) });
    expect(verdictsReady()).toBe(true);
    const load = bindAccessVerdicts(kv);
    expect(verdictsReady()).toBe(false);
    await load;
    expect(verdictsReady()).toBe(true);
    expect(storedVerdict("a")).toBe("open");
    expect(storedVerdict("b")).toBe("closed");
    expect(storedVerdict("c")).toBeNull();
    recordVerdict("a", "open");
    recordVerdict("b", "open");
    await verdictsSettled();
    await new Promise((r) => setTimeout(r, 0));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!)).toEqual({ a: "open", b: "open" });
  });

  it("a locked keystore is no verdicts — every first paint asks, nothing throws", async () => {
    const { kv } = memoryKV({}, { refuse: true });
    await bindAccessVerdicts(kv);
    expect(verdictsReady()).toBe(true);
    expect(storedVerdict("a")).toBeNull();
  });

  it("a verdict recorded while the row is read is newer than the row", async () => {
    const { kv, writes } = memoryKV({ [ACCESS_VERDICT_KEY]: JSON.stringify({ a: "closed" }) });
    const load = bindAccessVerdicts(kv);
    recordVerdict("a", "open");
    await load;
    await new Promise((r) => setTimeout(r, 0));
    expect(storedVerdict("a")).toBe("open");
    expect(JSON.parse(writes.at(-1)!)).toEqual({ a: "open" });
  });

  it("the row is bounded, and names no server and no account", () => {
    for (let i = 0; i < VERDICTS_KEPT + 4; i += 1) recordVerdict(`p${i}`, "open");
    expect(storedVerdict("p0")).toBeNull();
    expect(storedVerdict(`p${VERDICTS_KEPT + 3}`)).toBe("open");
    expect(read("src/ui/Gated.tsx")).toContain("recordVerdict(session.profile.id,");
    expect(read("src/net/account.ts")).not.toMatch(/recordVerdict\(session\.ownerKey/);
  });
});

/* ── the copy ────────────────────────────────────────────────────────────────────────────────── */

describe("the six new sentences", () => {
  const KEYS = ["wallSubscribeHint", "wallMintFailed", "wallMintUnverified", "wallChecking", "wallPending", "wallCheckAgain"] as const;

  it("both decks carry them, the German without eszett, and neither names a processor", () => {
    for (const k of KEYS) {
      for (const deck of [EN, DE]) {
        const v = (deck as unknown as Record<string, unknown>)[k];
        expect(typeof v, `${k} is not a sentence`).toBe("string");
        expect(String(v)).not.toMatch(/stripe/i);
      }
      expect(String((DE as unknown as Record<string, unknown>)[k])).not.toContain("ß");
    }
  });

  it("the hint is said only for a closure somebody undoes by paying", () => {
    expect(wallSays(facts(), "sideload").actions.find((a) => a.id === "manage")).toMatchObject({ hint: EN.wallSubscribeHint });
    const held = facts({ lifecycle: lifecycleOf({ ...CLOSED, closedReason: "suspended" })! });
    expect(wallSays(held, "sideload").actions.find((a) => a.id === "manage")!).not.toHaveProperty("hint");
    expect(wallSays(facts({ lifecycle: undefined }), "sideload").actions.find((a) => a.id === "manage")!).not.toHaveProperty("hint");
  });
});
