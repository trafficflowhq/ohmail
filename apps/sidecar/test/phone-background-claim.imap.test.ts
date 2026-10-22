/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE CLAIM FOLLOWS THE ORGANIZER'S ABILITY TO RUN — the background machine, on a real server
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Dispatcher ruling, 2026-09-12: a background transition gives the mailbox back exactly when the
 * organizer stops running, and not otherwise. With the Android foreground service standing, the
 * app leaving the screen changes nothing — the engine goes on renewing and the claim stands. With
 * no service, or with one the system would not let start, the claim goes back and a foreground
 * resume takes it again with no press.
 *
 * `apps/mobile/test/background-organizing.test.ts` drives every arm of the machine against a
 * recorder. What is measured HERE is the half a recorder cannot answer: the same machine over the
 * REAL engine, with the verdict read out of `ohmail/_meta` by an IMAP client the engine knows
 * nothing about. The two observables are the claim's own stamps:
 *
 *  · `X-Ohmail-Claimed-At` — carried forward by a renew (`priorOwn?.claimedAt ?? now`) and MINTED
 *    fresh by a claim taken after a hand-back. So it is the churn meter: unchanged across a flip
 *    means nothing was released and re-taken, and a new value is a pair of lease writes.
 *  · `X-Ohmail-Heartbeat` — moved by every renew. A heartbeat that advances AFTER the background
 *    transition is the organizer still running, which is the whole of the ruling's first half.
 *
 * The nonce is NOT an observable: a renew mints a new one every cycle (`organizer-lease.ts`).
 *
 * ── WHAT THIS CANNOT SAY, NAMED RATHER THAN IMPLIED ───────────────────────────────────────
 *
 * Under node the timers keep running whatever the app-state edge does, so what these cells prove
 * is that the MACHINE neither released the claim nor stopped the engine. That Android's foreground
 * service plus its headless task keep React Native's timers alive is a platform fact, and it is
 * measured on a device — `PHONE-018-DEVICE-RUN-5`, on the release APK. The engine adapter below is
 * the one `apps/mobile/src/engine/organizer-session-native.ts` composes in the app; a service
 * double supplies the two platform facts (`start`, `running`) a node process cannot have.
 *
 * ── IT RUNS UNDER THE SQLITE PROJECT, AND NAMES A CLOSED PORT ─────────────────────────────
 *
 * `phone-hand-back.imap.test.ts`'s reason verbatim: this composes the whole engine over the DEVICE
 * store, so it needs `vitest.sqlite.config.ts`'s schema substitution. Under the default project it
 * asserts the premise rather than skipping in silence, and a server that is not answering is a
 * named refusal rather than a green run measuring nothing.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { META_FOLDER } from "@trafficflow/core/adapters/organizer-lease";
import {
  createBackgroundOrganizing,
  type BackgroundOrganizing,
  type BackgroundService,
  type OrganizerPlatform,
} from "../../mobile/src/engine/background.js";
import {
  startPhoneEngine,
  type PhoneEngine,
  type PhoneSqlExecutor,
  type PhoneSqlRows,
} from "../src/mobile.js";
import { serviceUp } from "@trafficflow/db/testing";

const sqlite = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    close(): void;
    prepare(sql: string): {
      all(...p: unknown[]): unknown[];
      run(...p: unknown[]): unknown;
      columns?(): { column?: string | null; name?: string }[];
    };
  };
};

/** `phone-hand-back.imap.test.ts`'s rule verbatim: the repo's own defaults, overridable per lane. */
const HOST = process.env.OHMAIL_PHONE_IMAP_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1";
const PORT = Number(process.env.OHMAIL_PHONE_IMAP_PORT ?? process.env.IMAP_PORT ?? 3143);
const SMTP_PORT = Number(process.env.OHMAIL_PHONE_SMTP_PORT ?? process.env.SMTP_PORT ?? 3025);

const EXPECTED_DIALECT = process.env.OHMAIL_EXPECT_DIALECT;
const ON_DEVICE_STORE = EXPECTED_DIALECT === "sqlite";

const SERVER_UP = ON_DEVICE_STORE ? serviceUp("greenmail", `${HOST}:${PORT}`).up : false;

/** `node:sqlite` behind the phone's statement-runner contract, with a real yield in every call. */
function nodeExecutor(file: string): PhoneSqlExecutor {
  const raw = new sqlite.DatabaseSync(file);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  return {
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        const st = raw.prepare(sql);
        const columns = (st.columns ? st.columns() : []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...params) as Record<string, unknown>[];
        const rows = columns.length > 0
          ? objects.map((o) => columns.map((c) => o[c]))
          : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => { await yielded(); raw.prepare(sql).run(...params); });
    },
    async batch(statements: readonly { sql: string; params?: readonly unknown[] }[]): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...params);
          raw.exec("COMMIT");
        } catch (err) {
          try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
          throw err;
        }
      });
    },
    async close(): Promise<void> { try { raw.close(); } catch { /* already closed */ } },
  };
}

/**
 * THE DIALECT SEAM — `phone-hand-back.imap.test.ts`'s, verbatim in substance and for its reason:
 * the ingest path still carries raw Postgres in this stack, and a drain that dies mid-cycle stops
 * the poll that re-reads the lease. The lease path itself is not rewritten, so no verdict below
 * rests on it.
 */
function dialectSeam(exec: PhoneSqlExecutor): PhoneSqlExecutor {
  const rules: [RegExp, (...a: string[]) => string][] = [
    [/(^|[^A-Za-z0-9_.])now\(\)/gi, (_m, pre) => `${pre}CAST(unixepoch('subsec')*1000 AS INTEGER)`],
    [/::\s*(timestamptz|timestamp|uuid|text|jsonb|json|int|integer|bigint|numeric|boolean|date)\b/gi, () => ""],
    [/\bgreatest\s*\(/gi, () => "max("],
    [/\bleast\s*\(/gi, () => "min("],
    [/\s+for\s+update(\s+skip\s+locked)?/gi, () => ""],
  ];
  const rewrite = (sql: string): string => {
    let out = String(sql);
    for (const [re, to] of rules) {
      re.lastIndex = 0;
      out = out.replace(re, to as (substring: string, ...args: unknown[]) => string);
    }
    return out;
  };
  return {
    all: (sql, params) => exec.all(rewrite(sql), params),
    run: (sql, params) => exec.run(rewrite(sql), params),
    batch: (st) => exec.batch(st.map((q) => ({ sql: rewrite(q.sql), params: q.params }))),
    close: () => exec.close(),
  };
}

interface Line { event: string; detail: Record<string, unknown> }
interface Phone { engine: PhoneEngine; lines: Line[]; exec: PhoneSqlExecutor }

const open: PhoneEngine[] = [];
const sessions: BackgroundOrganizing[] = [];
const dirs: string[] = [];

async function bootPhone(o: { user: string; installId: string; file: string }): Promise<Phone> {
  const lines: Line[] = [];
  const exec = dialectSeam(nodeExecutor(o.file));
  const engine = await startPhoneEngine({
    exec,
    imap: {
      host: HOST, port: PORT, secure: false,
      /* GreenMail runs with `-Dgreenmail.auth.disabled` and creates the user at first login, so
         this literal is a fixture constant rather than a credential — the sibling twins' idiom. */
      auth: { user: o.user, pass: "test" },
      smtp: { host: HOST, port: SMTP_PORT, secure: false },
      sentDomain: "trafficflow.test",
    },
    machineName: "the measured phone",
    installId: o.installId,
    keks: { 1: "b".repeat(64) },
    log: (event, detail) => { lines.push({ event, detail }); },
  });
  open.push(engine);
  return { engine, lines, exec };
}

/** What the service double is doing right now. The two facts a node process cannot have. */
interface ServiceState {
  running: boolean;
  /** What a `start` answers — `false` is a refused notification or a refused background start. */
  starts: boolean;
  restricted: boolean;
  calls: string[];
}

function serviceDouble(over: Partial<ServiceState> = {}): { service: BackgroundService; state: ServiceState } {
  const state: ServiceState = { running: false, starts: true, restricted: false, calls: [], ...over };
  const service: BackgroundService = {
    start: async () => {
      state.calls.push("start");
      /* A REFUSED START DOES NOT TAKE A STANDING SERVICE DOWN — the Kotlin answers `false` before
         it reaches `startForegroundService`, so the double fails the way production fails. */
      if (state.starts) state.running = true;
      return state.starts;
    },
    stop: async () => { state.calls.push("stop"); state.running = false; },
    beat: () => state.running,
    beatIntervalMs: () => 20_000,
    running: () => state.running,
    restricted: () => state.restricted,
    canPost: () => true,
    onStopRequested: () => (): void => undefined,
  };
  return { service, state };
}

/**
 * THE MACHINE OVER THE REAL ENGINE — the adapter `organizer-session-native.ts` composes, copied
 * because that file imports `react-native` and cannot be loaded here. `standDown` is the engine's
 * stand-down REASON and not the negation of `organizing`, which is the distinction the claim watch
 * and the stood-down watch turn on.
 */
function machine(p: Phone, platform: OrganizerPlatform, service: BackgroundService | null): {
  live: BackgroundOrganizing; logged: Line[];
} {
  const logged: Line[] = [];
  const live = createBackgroundOrganizing({
    platform,
    service,
    engine: {
      handBack: () => p.engine.handBack(),
      resume: () => p.engine.resume(),
      stopOrganizing: () => p.engine.stopOrganizing(),
      claimHere: (opts) => p.engine.claimHere(opts),
      organizing: () => Object.entries(p.engine.runtimes().organizer).map(([mailboxId, state]) => ({
        mailboxId,
        organizing: state.organizing,
        standDown: state.reason !== null,
        /* THE FACT THE ARMS DECIDE ON, straight from the engine — the window below is the reason
           it is not `organizing`. */
        claimed: state.claimed,
      })),
    },
    notice: () => ({
      channelName: "Organizing", body: "one mailbox", stopLabel: "Stop organizing",
      /* REQUIRED on the notice, so this double carries it: a stop the server would not confirm
         swaps the body for this one, and a fixture without it hides that swap. */
      stopFailedBody: "Could not stop organizing — press again",
    }),
    /* BOTH DECLINE ANNOUNCERS, because the source calls whichever the reason names. This fake
       carried only the first, so `notification_not_showing` reached `deps.announceNotificationsOff`
       and threw "is not a function" — a fixture one field behind the source it doubles. They are
       two sentences a person can act on differently, so they move together. */
    announceRestricted: () => undefined,
    announceNotificationsOff: () => undefined,
    /* A start that did not finish starting has nowhere to render in this fixture. */
    sayStartFailed: () => undefined,
    sayHandBackLate: () => undefined,
    log: (event, detail) => { logged.push({ event, detail: detail ?? {} }); },
  });
  sessions.push(live);
  return { live, logged };
}

function seedMailboxId(p: Phone): string {
  const ids = Object.keys(p.engine.runtimes().organizer);
  expect(ids, "the composition seeds exactly one mailbox from its config").toHaveLength(1);
  return ids[0]!;
}

/** A press on the phone's door; a CONSENT press is the person's Connect, so it carries their marker. */
async function post(p: Phone, path: string): Promise<number> {
  const person = path.endsWith("/organize");
  const res = await p.engine.handle(new Request(`http://sidecar${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${p.engine.sessionToken}`,
      ...(person ? { "content-type": "application/json" } : {}),
    },
    ...(person ? { body: JSON.stringify({ consent: "person" }) } : {}),
  }));
  return res.status;
}

interface Claim { installId: string; kind: string; nonce: string; claimedAt: string; heartbeat: string }

/** Every claim in `ohmail/_meta`, read by a client this engine knows nothing about. */
async function claimsOnServer(user: string): Promise<Claim[]> {
  const c = new ImapFlow({
    host: HOST, port: PORT, secure: false, auth: { user, pass: "test" }, logger: false,
  });
  await c.connect();
  try {
    const paths = (await c.list()).map((b) => b.path);
    const meta = paths.find((p) => p.replace(/[./]/g, "/") === META_FOLDER.replace(/[./]/g, "/"));
    if (meta === undefined) return [];
    const lock = await c.getMailboxLock(meta);
    try {
      if ((c.mailbox === false ? 0 : c.mailbox.exists) === 0) return [];
      const out: Claim[] = [];
      for await (const msg of c.fetch("1:*", { uid: true, headers: true })) {
        /* A row with no headers is a message being expunged under us — see the sibling file. */
        if (msg.headers === undefined) continue;
        const h = msg.headers.toString("utf8");
        const pick = (n: string): string =>
          (new RegExp(`^${n}:\\s*(.*)$`, "im").exec(h)?.[1] ?? "").trim();
        if (pick("X-Ohmail-Lease") !== "1") continue;
        out.push({
          installId: pick("X-Ohmail-Install-Id"),
          kind: pick("X-Ohmail-Organizer-Kind"),
          nonce: pick("X-Ohmail-Nonce"),
          claimedAt: pick("X-Ohmail-Claimed-At"),
          heartbeat: pick("X-Ohmail-Heartbeat"),
        });
      }
      return out;
    } finally { lock.release(); }
  } finally { await c.logout().catch(() => undefined); }
}

/** Our claims, newest heartbeat first. Empty means this install holds the mailbox no longer. */
async function ours(user: string, installId: string): Promise<Claim[]> {
  const all = await claimsOnServer(user);
  return all.filter((c) => c.installId === installId)
    .sort((a, b) => Date.parse(b.heartbeat) - Date.parse(a.heartbeat));
}

/** `organizer_role` as the row holds it — the half a hand-back must NOT touch. */
async function organizerRole(p: Phone, mailboxId: string): Promise<string | null> {
  const rows = await p.exec.all("select organizer_role from mailboxes where id = ?", [mailboxId]);
  const first = rows.rows[0];
  return first === undefined ? null : String(first[0]);
}

/** Wait until this install's claim is on the server, or say what the engine did instead. */
async function untilOurClaim(p: Phone, user: string, installId: string, deadlineMs = 90_000): Promise<{
  ours: Claim[]; why: string;
}> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const mine = await ours(user, installId);
    if (mine.length > 0 || Date.now() >= until) {
      const decisions = p.lines.filter(
        (l) => l.event === "organizer_stand_down" || l.event.endsWith("_failed"),
      );
      return {
        ours: mine,
        why: decisions.length === 0
          ? `no decision line; events: ${[...new Set(p.lines.map((l) => l.event))].join(", ")}`
          : decisions.map((l) => `${l.event} ${JSON.stringify(l.detail).slice(0, 300)}`).join(" | "),
      };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Wait until our claim's heartbeat has moved past `from`, or answer the last one read. */
async function untilRenewed(user: string, installId: string, from: string, deadlineMs = 90_000): Promise<string | null> {
  const until = Date.now() + deadlineMs;
  let last: string | null = null;
  for (;;) {
    const mine = await ours(user, installId);
    last = mine[0]?.heartbeat ?? last;
    if ((last !== null && Date.parse(last) > Date.parse(from)) || Date.now() >= until) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * IS THIS MAILBOX OURS, as the engine records it — the fact the background arms decide on.
 *
 * This replaces a wait. Three cells below used to WAIT for the runtime to report itself
 * organizing before driving a transition, because the arms read that field and a transition
 * driven any earlier measured the reader arm — the window this lane closes, named as a premise
 * because the machine could not be asked the question it needed. The question exists now, so the
 * premise is an assertion: the claim is in the folder, and the engine already calls it ours.
 */
function ownership(p: Phone, mailboxId: string): { claimed: boolean; organizing: boolean } {
  const state = p.engine.runtimes().organizer[mailboxId];
  expect(state, "the runtime does not carry the mailbox this cell claimed").toBeDefined();
  return { claimed: state!.claimed, organizing: state!.organizing };
}

/** Wait until this install holds no claim at all, or answer what is still there. */
async function untilNoneOfOurs(user: string, installId: string, deadlineMs = 60_000): Promise<Claim[]> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const mine = await ours(user, installId);
    if (mine.length === 0 || Date.now() >= until) return mine;
    await new Promise((r) => setTimeout(r, 300));
  }
}

afterEach(async () => {
  while (sessions.length > 0) sessions.pop()!.dispose();
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-bgclaim-"));
  dirs.push(dir);
  return dir;
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(EXPECTED_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE && !SERVER_UP)("the mail server this file measures against", () => {
  it(`is NOT answering on ${HOST}:${PORT} — the cases below measured nothing in this run`, () => {
    /* Named rather than silent. Start it with `sg docker -c "docker compose up -d greenmail"`, or
       point OHMAIL_PHONE_IMAP_PORT at a private container. */
    expect(SERVER_UP, "the probe says the server answers, so these cases should have RUN").toBe(false);
  });
});

describe.runIf(ON_DEVICE_STORE && SERVER_UP)("the claim follows the organizer's ability to run", () => {
  it("SERVICE UP: leaving the screen gives nothing back and the claim goes on being renewed", async () => {
    /**
     * The ruling's first half, on a server. The service is standing, so the background transition
     * is not a decision about the mailbox at all: no release is written, `X-Ohmail-Claimed-At`
     * stays the value the consent minted, and the heartbeat moves again afterwards — which is the
     * organizer still running rather than a claim somebody forgot to clean up.
     */
    const user = `bgclaim-up-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);

    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).not.toHaveLength(0);
    const before = claimed.ours[0]!;
    /* ASSERTED, NOT WAITED FOR. The claim reaches the folder BEFORE the runtime reports itself
       organizing, and this cell used to wait out that window because the arm read a runtime that
       organizes nothing as a reader. The arm reads ownership now, so the transition happens where
       a person's would — inside the window — and the fact is asserted here. */
    expect(ownership(phone, mailboxId).claimed,
      "the claim is in the mailbox and the engine does not call it ours").toBe(true);

    const { service, state } = serviceDouble();
    const m = machine(phone, "android", service);
    /* The first background is what starts the service; the second meets one already standing,
       which is the arm the ruling is about. */
    await m.live.phaseChanged("background");
    expect(state.running, "the service did not come up, so this cell measured the wrong arm").toBe(true);
    await m.live.phaseChanged("active");
    await m.live.phaseChanged("background");

    const after = await ours(user, installId);
    expect(after, "the claim left the mailbox while the organizer was running").not.toHaveLength(0);
    /* THE CHURN METER. A hand-back and a re-claim would mint a new stamp; a renew carries it. */
    expect(after[0]!.claimedAt).toBe(before.claimedAt);
    expect(m.live.handedBack()).toBe(false);
    expect(m.live.backgrounded()).toBe(true);
    expect(await organizerRole(phone, mailboxId)).toBe("organizer");
    expect(m.logged.map((l) => l.event)).toContain("organizer_background_holds");
    expect(m.logged.map((l) => l.event)).not.toContain("organizer_hand_back");

    /* AND IT IS STILL ORGANIZING, which no flag on this side can settle: the heartbeat is written
       by the engine's own cycle into a folder this test reads with another client. */
    const moved = await untilRenewed(user, installId, before.heartbeat);
    expect(moved, "the claim stopped being renewed after the background transition").not.toBeNull();
    expect(Date.parse(moved!), `heartbeat ${moved} did not pass ${before.heartbeat}`)
      .toBeGreaterThan(Date.parse(before.heartbeat));
  }, 180_000);

  it("THE SERVICE WOULD NOT START: the claim goes back, the ROW stays, and coming back re-takes it", async () => {
    /**
     * A refused notification permission is not a fault and the engine may not go on organizing
     * behind a notification nobody can see — so this is the hand-back arm, reached on Android.
     * Both halves asserted: the claim leaves and the ROW still says organizer, which is what makes
     * the resume automatic. The claim that comes back carries a NEW `X-Ohmail-Claimed-At`, which
     * is the second lease write of the pair and the price this arm pays.
     */
    const user = `bgclaim-refused-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).not.toHaveLength(0);
    const before = claimed.ours[0]!;

    /* ASSERTED, NOT WAITED FOR — the first cell's paragraph. The decline arm sits below the
       ownership check, so what this cell needs is that the mailbox is ours, not that the pass has
       got round to saying it organizes it. */
    expect(ownership(phone, mailboxId).claimed,
      "the claim is in the mailbox and the engine does not call it ours").toBe(true);

    const { service, state } = serviceDouble({ starts: false });
    const m = machine(phone, "android", service);
    await m.live.phaseChanged("background");
    expect(state.running).toBe(false);
    expect(m.logged.map((l) => l.event), "the machine took the reader arm, not the decline")
      .toContain("organizer_hand_back");

    expect(await untilNoneOfOurs(user, installId),
      `the claim stayed in the mailbox over an organizer that could not run — ${m.logged
        .map((l) => `${l.event} ${JSON.stringify(l.detail)}`).join(" | ")}`).toHaveLength(0);
    expect(m.live.handedBack()).toBe(true);
    expect(await organizerRole(phone, mailboxId), "the hand-back demoted the row").toBe("organizer");

    await m.live.phaseChanged("active");
    const back = await untilOurClaim(phone, user, installId);
    expect(back.ours, `the resume did not take the mailbox back — ${back.why}`).not.toHaveLength(0);
    expect(back.ours[0]!.claimedAt,
      "the resume renewed an old claim rather than taking a new one").not.toBe(before.claimedAt);
  }, 180_000);

  it("NO SERVICE — the iPhone answer, and it is the same code", async () => {
    /**
     * `background-native.ts` answers `null` where the native half is absent, which is iOS and any
     * build without the module. Nothing on this phone can run once the app leaves, so the mailbox
     * goes back; the arm is reached by the service being absent, never by the platform name.
     */
    const user = `bgclaim-none-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).not.toHaveLength(0);

    const m = machine(phone, "ios", null);
    await m.live.phaseChanged("background");
    expect(await untilNoneOfOurs(user, installId),
      "an iPhone in a pocket kept the mailbox").toHaveLength(0);
    expect(m.live.handedBack()).toBe(true);
    expect(m.live.backgrounded()).toBe(false);
    expect(await organizerRole(phone, mailboxId)).toBe("organizer");

    await m.live.phaseChanged("active");
    const back = await untilOurClaim(phone, user, installId);
    expect(back.ours, `the resume did not take the mailbox back — ${back.why}`).not.toHaveLength(0);
  }, 180_000);

  it("THE WINDOW: the mailbox reads as OURS before the pass reports itself organizing", async () => {
    /**
     * The row this lane closes, measured rather than assumed — and the reason `organizing` cannot
     * be the fact the background arms decide on. The gate writes this install's claim into
     * `ohmail/_meta` inside the lease read and then takes its permit, a second round trip, before
     * it reports the pass as organizing. Everything in between reads exactly like a phone nobody
     * has consented to, and the Android arm gave the mailbox up in it.
     *
     * Read between the round trips the gate awaits, so the ordering is a fact and not a race: a
     * `setTimeout(0)` poll runs whenever the gate is waiting on the server, and the only way the
     * two flip in ONE turn is for the record to be written beside `organizing` — which is the
     * mutation this cell exists to redden.
     */
    const user = `bgclaim-window-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    expect((await untilOurClaim(phone, user, installId)).ours,
      "no claim was written").not.toHaveLength(0);

    /* GIVE IT BACK FIRST, so the claim below has a beginning this cell can stand at. The row is
       untouched by a hand-back, so the resume is an ordinary gated cycle with no press. */
    await phone.engine.handBack();
    expect(await untilNoneOfOurs(user, installId),
      "the hand-back left a claim in the mailbox").toHaveLength(0);
    expect(ownership(phone, mailboxId).claimed,
      "the mailbox still reads as ours with no claim of ours in it").toBe(false);

    const seen: { claimed: boolean; organizing: boolean }[] = [];
    const until = Date.now() + 60_000;
    const cycle = phone.engine.resume();
    for (;;) {
      const now = ownership(phone, mailboxId);
      seen.push(now);
      if (now.organizing || Date.now() >= until) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    await cycle;
    const first = seen.findIndex((v) => v.claimed);
    expect(first, `the gate never recorded the mailbox as ours in ${seen.length} reads`)
      .toBeGreaterThanOrEqual(0);
    expect(seen[first]!.organizing,
      "the claim and the pass's own answer landed in one turn, so the window is not where this "
        + "install records owning the mailbox").toBe(false);
    expect(seen[seen.length - 1]!.organizing,
      "the forced cycle never reported itself organizing").toBe(true);
  }, 180_000);

  it("CHURN, PRICED ON THE SERVER: three flips cost no lease write while the organizer runs", async () => {
    /**
     * The number the ruling turns on, read off `ohmail/_meta` rather than off a call recorder. A
     * phone whose organizer runs can be pocketed and taken out three times for ONE claim — the
     * stamp the consent minted, carried by every renew. The arm beside it prices the other answer:
     * with no service each flip is a release and a fresh claim, so the stamp is new every time and
     * the mailbox is free in between, which is what a phone that cannot organize owes everybody
     * else.
     */
    const user = `bgclaim-churn-${randomUUID()}@trafficflow.test`;
    const installId = `install-marker-${randomUUID()}`;
    const phone = await bootPhone({ user, installId, file: join(storeDir(), "engine.db") });
    const mailboxId = seedMailboxId(phone);
    expect(await post(phone, `/local/mailboxes/${mailboxId}/organize`)).toBe(200);
    const claimed = await untilOurClaim(phone, user, installId);
    expect(claimed.ours, `no claim was written — ${claimed.why}`).not.toHaveLength(0);
    const minted = claimed.ours[0]!.claimedAt;
    /* The same fact as the first cell, and for its reason. */
    expect(ownership(phone, mailboxId).claimed,
      "the claim is in the mailbox and the engine does not call it ours").toBe(true);

    const up = machine(phone, "android", serviceDouble().service);
    const stamps: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      await up.live.phaseChanged("background");
      await up.live.phaseChanged("active");
      const mine = await ours(user, installId);
      expect(mine, `the claim was absent after flip ${i + 1}`).not.toHaveLength(0);
      stamps.push(mine[0]!.claimedAt);
    }
    expect(new Set([minted, ...stamps]).size,
      `three flips minted ${new Set(stamps).size} claim stamps: ${stamps.join(", ")}`).toBe(1);
    up.live.dispose();

    /* THE OTHER ANSWER, on the same mailbox: with no service every flip is a pair of writes. */
    const bare = machine(phone, "ios", null);
    const paid: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await bare.live.phaseChanged("background");
      expect(await untilNoneOfOurs(user, installId)).toHaveLength(0);
      await bare.live.phaseChanged("active");
      const back = await untilOurClaim(phone, user, installId);
      expect(back.ours, `flip ${i + 1} did not take the mailbox back — ${back.why}`).not.toHaveLength(0);
      paid.push(back.ours[0]!.claimedAt);
    }
    expect(new Set(paid).size, `two flips with no service reused a claim stamp: ${paid.join(", ")}`).toBe(2);
    expect(paid).not.toContain(minted);
    expect(await organizerRole(phone, mailboxId)).toBe("organizer");
  }, 240_000);
});
