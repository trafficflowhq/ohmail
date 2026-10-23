import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { SendNotSubmitted, SentCopyAppendFailed } from "@trafficflow/core/mail";
import { drafts, outboundSends } from "@trafficflow/db";
import { createSidecar, settledWithin, type QuitPlan, type QuitReport, type Sidecar } from "../src/engine.js";
import { LOCK_FILE, STORE_GENERATION_FILE } from "../src/db.js";
import { noteFirstPageServed, resetFirstPageGate } from "../src/first-page-gate.js";
import type { StdioHost } from "../src/host.js";
import {
  localShutdown, QUIT_GOODBYE_MS, QUIT_PASS_MS, QUIT_REQUESTS_MS, QUIT_STORE_CLOSE_RESERVE_MS,
  QUIT_STORE_WAIT_MS, SHUTDOWN_DEADLINE_MS,
} from "../src/main.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

/**
 * A QUIT CLOSES THE STORE INSIDE THE SHELL'S GRACE, however slow the mail server is.
 *
 * The shell kills the engine at `STOP_GRACE` (5 s). The store close used to queue behind every
 * mailbox's stop, each allowed one drain interval (15 s): a pass parked in a server call, an
 * organizer's claim release or a LOGOUT nobody answers each ran the kill first, and the store was
 * left recorded open with its lock behind (a tester's finding, three Closes of three). The quit plan cuts the
 * pass at `QUIT_PASS_MS` and closes the store while the goodbyes run beside it.
 */

vi.setConfig({ testTimeout: 2 * PGLITE_STANDUP_BUDGET_MS + 40_000 });

const plan = (extra: Partial<QuitPlan> = {}): QuitPlan => ({
  passMs: QUIT_PASS_MS, requestsMs: QUIT_REQUESTS_MS, storeWaitMs: QUIT_STORE_WAIT_MS, goodbyeMs: QUIT_GOODBYE_MS,
  ...extra,
});

class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_100; }
  /* The release asks for our records by install id, as the real adapter answers it. */
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
  get count(): number { return this.claims.length; }
}

interface Knobs {
  hangChanges: boolean;
  hangClose: boolean;
  smtpMs?: number;
  /** SMTP accepts the message and the Sent copy's APPEND is refused. */
  appendFails?: boolean;
  /** The mail server refuses the session: nothing was offered, a definite failure. */
  smtpRefuses?: boolean;
  /** The send door's IMAP login (before any SMTP) takes this long: a slow server at the quit. */
  connectMs?: number;
}
interface SendSeen { connectAt?: number | null; sends?: number; startedAt: number | null; doneAt: number | null; closedAt: number | null; forcedAt: number | null; append: string | null }
interface Seen {
  meta: MemoryMeta;
  changesEntered: number;
  closes: number;
  forceCloses: number;
  forceClosedAt: number[];
  dials: number;
  send: SendSeen;
}

/** The send door's own connection: SMTP for `smtpMs`, then the Sent copy on the IMAP login. */
function sendConnection(knobs: Knobs, seen: SendSeen): MailboxAdapter {
  let closed = false;
  return {
    async connect(): Promise<void> {
      seen.connectAt ??= performance.now();
      await sleep(knobs.connectMs ?? 0);
    },
    async send(msg: { messageId?: string }) {
      seen.sends = (seen.sends ?? 0) + 1;
      seen.startedAt = performance.now();
      await sleep(knobs.smtpMs ?? 0);
      seen.doneAt = performance.now();
      if (knobs.smtpRefuses) {
        seen.append = "refused_session";
        throw new SendNotSubmitted("login", { message: "5.7.8 authentication refused", responseCode: 535 });
      }
      if (closed) { seen.append = "logged_out_first"; throw new SentCopyAppendFailed(msg.messageId!, new Error("LOGOUT came first")); }
      if (knobs.appendFails) { seen.append = "append_refused"; throw new SentCopyAppendFailed(msg.messageId!, new Error("APPEND refused")); }
      seen.append = "appended";
      return { providerMessageId: msg.messageId!, sentLocator: null, raw: null };
    },
    async messageInSent(): Promise<boolean> { return false; },
    async close(): Promise<void> { seen.closedAt ??= performance.now(); closed = true; },
    forceClose(): void { seen.forcedAt ??= performance.now(); closed = true; },
    isLive: () => !closed,
  } as never;
}

/** One mailbox whose server can park a drain or never answer LOGOUT; `forceClose` ends both. */
function mailbox(knobs: Knobs, seen: Seen): (cfg: ImapConfig) => MailboxAdapter {
  return (cfg) => {
    if (knobs.smtpMs !== undefined && cfg.smtp && seen.dials > 0) return sendConnection(knobs, seen.send);
    seen.dials += 1;
    const parked: Array<(err: Error) => void> = [];
    const park = <T>(): Promise<T> => new Promise<T>((_resolve, reject) => { parked.push(reject); });
    const adapter: MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } = {
      leaseIo: () => seen.meta,
      leasePeekIo: () => ({ listClaims: () => seen.meta.listClaims() }),
      async connect(): Promise<void> {},
      async close(): Promise<void> {
        seen.closes += 1;
        if (knobs.hangClose) await park<void>();
      },
      forceClose(): void {
        seen.forceCloses += 1;
        seen.forceClosedAt.push(performance.now());
        for (const reject of parked.splice(0)) reject(new Error("socket destroyed"));
      },
      async capabilities(): Promise<ImapCapabilities> {
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince(): Promise<ChangeBatch> {
        seen.changesEntered += 1;
        if (knobs.hangChanges) return park<ChangeBatch>();
        return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
      },
      async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "1:1" }; },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(): Promise<() => Promise<void>> { return async () => {}; },
      async send(): Promise<never> { throw new Error("no send in this rig"); },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    } as never;
    return adapter;
  };
}

interface Line { event: string; at: number; detail: Record<string, unknown> }

interface Rig {
  sidecar: Sidecar;
  dataDir: string;
  seen: Seen;
  lines: Line[];
  started: Promise<unknown>;
}

const storeRecord = (dataDir: string): { open?: boolean } | null => {
  try { return JSON.parse(readFileSync(join(dataDir, STORE_GENERATION_FILE), "utf8")) as { open?: boolean }; } catch { return null; }
};
const lockLeft = (dataDir: string): boolean => existsSync(join(dataDir, LOCK_FILE));
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

describe("a quit on the plan", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    resetFirstPageGate();
  });

  async function boot(knobs: Knobs, opts: { organize: boolean; pollIntervalMs?: number; dataDir?: string }): Promise<Rig> {
    noteFirstPageServed();
    /* A relaunch reuses the data directory, which the first boot's cleanup removes last. */
    const dataDir = opts.dataDir ?? await freshDataDir("ohmail-quit-grace-");
    const owned = opts.dataDir === undefined;
    const seen: Seen = {
      meta: new MemoryMeta(), changesEntered: 0, closes: 0, forceCloses: 0, forceClosedAt: [], dials: 0,
      send: { startedAt: null, doneAt: null, closedAt: null, forcedAt: null, append: null },
    };
    const lines: Line[] = [];
    const sidecar = await createSidecar({
      dataDir,
      imap: {
        host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" },
        ...(knobs.smtpMs !== undefined ? { smtp: { host: "smtp.invalid", port: 465, secure: true } } : {}),
      },
      ...(knobs.smtpMs !== undefined ? { keks: { 1: Buffer.alloc(32, 7) } } : {}),
      address: "owner@trafficflow.test", machineName: "quit rig", leaseStaleAfterMs: 60_000,
      ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}),
      adapterFactory: mailbox(knobs, seen),
      log: (event, detail) => { lines.push({ event, at: performance.now(), detail: (detail ?? {}) as Record<string, unknown> }); },
    });
    const stops = { asked: false };
    const stop = sidecar.stop.bind(sidecar) as Sidecar["stop"];
    /* Counted, so the cleanup stops only a sidecar the case left running: a second stop over a
       LOGOUT that never answers would wait its whole drain interval again. */
    sidecar.stop = ((p?: QuitPlan) => { stops.asked = true; return p ? stop(p) : stop(); }) as Sidecar["stop"];
    cleanups.push(async () => {
      if (!stops.asked) await stop().catch(() => undefined);
      if (owned) rmSync(dataDir, { recursive: true, force: true });
    });
    if (opts.organize) await grantOrganizeConsent(sidecar);
    const started = sidecar.start().catch(() => undefined);
    if (knobs.hangChanges) {
      const t = performance.now();
      while (seen.changesEntered === 0 && performance.now() - t < 20_000) await sleep(20);
      expect(seen.changesEntered, "the premise: a drain is parked in a server call").toBeGreaterThan(0);
    } else {
      await started;
      await sleep(200);
    }
    return { sidecar, dataDir, seen, lines, started };
  }

  /** Reads the store record and the lock at `atMs` after the stop began, while it may still run. */
  async function stopAndLook(rig: Rig, p: QuitPlan, atMs: number): Promise<{
    began: number; store: { open?: boolean } | null; lock: boolean; endedAt: number; report: QuitReport;
  }> {
    const began = performance.now();
    let endedAt = 0;
    const stopping = rig.sidecar.stop(p).then((r) => { endedAt = performance.now(); return r; });
    await sleep(atMs);
    const store = storeRecord(rig.dataDir);
    const lock = lockLeft(rig.dataDir);
    const finished = await settledWithin(stopping, 30_000);
    expect(finished, "the stop never returned").toBe(true);
    return { began, store, lock, endedAt, report: await stopping };
  }

  it("a pass parked in a server call is cut, and the store is closed and unlocked well inside the grace", async () => {
    const rig = await boot({ hangChanges: true, hangClose: false }, { organize: false });
    expect(storeRecord(rig.dataDir)?.open, "the premise: the store is open while serving").toBe(true);

    const seenAt = 3_500;
    const { began, store, lock, endedAt, report } = await stopAndLook(rig, plan(), seenAt);

    expect(store?.open, `${seenAt} ms into the quit the store was still recorded open`).toBe(false);
    expect(lock, `${seenAt} ms into the quit the data directory was still locked`).toBe(false);
    expect(rig.seen.forceCloses, "the parked pass was not cut").toBe(1);
    expect(rig.seen.forceClosedAt[0]! - began, "the pass was cut before its bound")
      .toBeGreaterThanOrEqual(QUIT_PASS_MS - 50);
    const forced = rig.lines.filter((l) => l.event === "mailbox_detach_forced");
    expect(forced.map((l) => l.detail.phase)).toEqual(["pass"]);
    expect(report.forced).toBe(1);
    expect(endedAt - began, "the quit outran the shell's grace").toBeLessThan(SHUTDOWN_DEADLINE_MS);
  });

  it("a LOGOUT nobody answers does not hold the store: closed first, the socket destroyed at the goodbye bound", async () => {
    const rig = await boot({ hangChanges: false, hangClose: true }, { organize: true });
    expect(rig.seen.meta.count, "the premise: this install holds the claim").toBe(1);

    const { began, store, lock, report } = await stopAndLook(rig, plan(), 1_500);

    expect(store?.open, "the store waited behind the LOGOUT").toBe(false);
    expect(lock, "the lock waited behind the LOGOUT").toBe(false);
    expect(rig.seen.closes, "the polite LOGOUT was never tried").toBe(1);
    expect(rig.seen.forceCloses, "the hung LOGOUT was not ended exactly once").toBe(1);
    const at = rig.seen.forceClosedAt[0]! - began;
    expect(at, "the LOGOUT was destroyed off its bound").toBeGreaterThanOrEqual(QUIT_GOODBYE_MS - 300);
    expect(at).toBeLessThanOrEqual(QUIT_GOODBYE_MS + 300);
    expect(rig.lines.filter((l) => l.event === "mailbox_detach_forced").map((l) => l.detail.phase)).toEqual(["goodbye"]);
    expect(report.storeCloseMs, "the close's own time was not reported").toBeGreaterThan(0);
  });

  it("CONTROL: a healthy organizer gives its claim back, logs out once and forces nothing", async () => {
    const rig = await boot({ hangChanges: false, hangClose: false }, { organize: true });
    expect(rig.seen.meta.count, "the premise: this install holds the claim").toBe(1);

    const began = performance.now();
    await rig.sidecar.stop(plan());
    const took = performance.now() - began;

    expect(rig.seen.meta.count, "the claim was not given back").toBe(0);
    expect(rig.seen.closes).toBe(1);
    expect(rig.seen.forceCloses).toBe(0);
    expect(rig.lines.some((l) => l.event === "local_db_refused_closing"), "a goodbye reached the closed store").toBe(false);
    expect(storeRecord(rig.dataDir)?.open).toBe(false);
    expect(lockLeft(rig.dataDir)).toBe(false);
    // Measured 0.4 s idle, 1.1 s on a loaded machine; nothing was forced, so it ended on its own.
    expect(took, "a healthy quit ran to the goodbye bound").toBeLessThan(QUIT_GOODBYE_MS);
    expect(rig.lines.some((l) => l.event === "mailbox_detach_forced"), "a healthy quit forced a socket").toBe(false);
  });

  it("an organizer whose pass is cut still gives its claim back inside the goodbye window", async () => {
    const rig = await boot({ hangChanges: true, hangClose: false }, { organize: true });
    expect(rig.seen.meta.count, "the premise: this install holds the claim").toBe(1);

    const { began, store, lock } = await stopAndLook(rig, plan(), 3_500);

    expect(rig.lines.filter((l) => l.event === "mailbox_detach_forced").map((l) => l.detail.phase)).toEqual(["pass"]);
    expect(rig.seen.meta.count, "the cut pass left its claim to age out").toBe(0);
    const released = rig.lines.find((l) => l.event === "organizer_claim_released_on_stop");
    expect(released, "the release was not said").toBeDefined();
    expect(released!.at - began, "the release ran past the goodbye bound").toBeLessThan(QUIT_GOODBYE_MS);
    expect(store?.open).toBe(false);
    expect(lock).toBe(false);
  });

  it("a send in flight at the quit keeps its connection and the engine until its Sent copy is out", async () => {
    const SMTP_MS = 2_000;
    const rig = await boot({ hangChanges: false, hangClose: false, smtpMs: SMTP_MS }, { organize: false });
    const call = (path: string, body: unknown, key?: string) => rig.sidecar.handle(new Request(`http://local${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rig.sidecar.sessionToken}`, "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(body),
    }));
    const created = await call("/drafts", {
      mailboxId: rig.sidecar.world.mailboxId, subject: "the list", body: "See below.",
      to: [{ name: null, address: "you@example.test" }],
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const draft = await created.json() as { id: string };
    const sending = call(`/drafts/${draft.id}/send`, {}, "quit-send-1").then((r) => r.status);
    const t = performance.now();
    while (rig.seen.send.startedAt === null && performance.now() - t < 10_000) await sleep(5);
    expect(rig.seen.send.startedAt, "the premise: the SMTP leg is under way").not.toBeNull();
    await sleep(100);

    const began = performance.now();
    const report = await rig.sidecar.stop(plan({ requests: sending }));
    const endedAt = performance.now();

    const s = rig.seen.send;
    expect(s.append, "the send's connection was logged out before its Sent copy").toBe("appended");
    expect(endedAt, "the engine left before the SMTP leg ended").toBeGreaterThan(s.doneAt!);
    expect(s.closedAt!, "the connection closed under the send").toBeGreaterThanOrEqual(s.doneAt!);
    expect(s.forcedAt).toBeNull();
    expect(endedAt - began, "the quit outran the shell's grace").toBeLessThan(SHUTDOWN_DEADLINE_MS);
    expect(storeRecord(rig.dataDir)?.open).toBe(false);
    expect(lockLeft(rig.dataDir)).toBe(false);
    expect(report.storeCloseMs).toBeGreaterThan(0);
  });

  /** Polls the store record while `stopping` runs and says when it first read closed. */
  async function closedAt(rig: Rig, stopping: Promise<unknown>, began: number): Promise<number | null> {
    let done = false;
    void stopping.then(() => { done = true; }, () => { done = true; });
    for (;;) {
      if (storeRecord(rig.dataDir)?.open === false) return performance.now() - began;
      if (done) return null;
      await sleep(20);
    }
  }

  it("the doors' requests hold the store until they end or QUIT_REQUESTS_MS, and the leaving until the goodbye bound", async () => {
    const rig = await boot({ hangChanges: false, hangClose: false }, { organize: false });
    const began = performance.now();
    let storeOpenAtAnswer: boolean | undefined;
    const ENDS_MS = 1_500;                          // past the passes' bound, inside the requests'
    const answered = sleep(ENDS_MS).then(() => { storeOpenAtAnswer = storeRecord(rig.dataDir)?.open; });
    const report = await rig.sidecar.stop(plan({ requests: answered }));
    const took = performance.now() - began;
    expect(storeOpenAtAnswer, "the store closed under a request still running").toBe(true);
    expect(report.requestsMs).toBeGreaterThanOrEqual(ENDS_MS - 50);
    expect(took, "the engine left under a request still running").toBeGreaterThanOrEqual(ENDS_MS - 50);
    expect(took, "a request that ended held the quit").toBeLessThan(SHUTDOWN_DEADLINE_MS);
    expect(storeRecord(rig.dataDir)?.open).toBe(false);

    const again = await boot({ hangChanges: false, hangClose: false }, { organize: false });
    const began2 = performance.now();
    const stopping = again.sidecar.stop(plan({ requests: new Promise<void>(() => undefined) }));
    const closed = await closedAt(again, stopping, began2);
    const report2 = await stopping;
    const took2 = performance.now() - began2;
    expect(report2.requestsMs, "the store waited for a request past its bound").toBeLessThan(QUIT_REQUESTS_MS + 300);
    expect(report2.requestsMs).toBeGreaterThanOrEqual(QUIT_REQUESTS_MS - 50);
    expect(closed, "the store never read closed").not.toBeNull();
    expect(closed!, "the store closed before the requests' bound").toBeGreaterThanOrEqual(QUIT_REQUESTS_MS - 50);
    expect(closed!, "the store closed past the deadline").toBeLessThan(SHUTDOWN_DEADLINE_MS);
    /* The leaving waits for the goodbye bound, or for the store's own close where a loaded
       machine runs that later, and for nothing else. */
    expect(took2, "a request that never ends held the leaving past its bound")
      .toBeLessThan(Math.max(QUIT_GOODBYE_MS, closed!) + 300);
    expect(took2).toBeGreaterThanOrEqual(QUIT_GOODBYE_MS - 300);
    expect(storeRecord(again.dataDir)?.open).toBe(false);
  });

  const SEND_KNOBS: Knobs = { hangChanges: false, hangClose: false, smtpMs: 2_000 };
  /* How long before the quit the 2 s SMTP leg began: it ends 1.4 s into the quit, past the passes'
     1 s and inside the requests' 2 s, with room on both sides for a loaded machine. */
  const PRESSED_BEFORE_MS = 600;
  const post = (rig: Rig, path: string, body: unknown, key?: string): Promise<Response> =>
    rig.sidecar.handle(new Request(`http://local${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rig.sidecar.sessionToken}`, "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(body),
    }));

  /** A draft, and its Send pressed: resolves once the SMTP leg is under way. */
  async function pressSend(rig: Rig, key: string): Promise<{
    draftId: string; sending: Promise<void>; answer: { status?: number; body?: { status?: string } | null };
  }> {
    const created = await post(rig, "/drafts", {
      mailboxId: rig.sidecar.world.mailboxId, subject: "the list", body: "See below.",
      to: [{ name: null, address: "you@example.test" }],
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const draft = await created.json() as { id: string };
    const answer: { status?: number; body?: { status?: string } | null } = {};
    const sending = post(rig, `/drafts/${draft.id}/send`, {}, key).then(async (r) => {
      answer.status = r.status;
      answer.body = await r.json().catch(() => null) as { status?: string } | null;
    });
    const t = performance.now();
    while (rig.seen.send.startedAt === null && performance.now() - t < 10_000) await sleep(5);
    expect(rig.seen.send.startedAt, "the premise: the SMTP leg is under way").not.toBeNull();
    return { draftId: draft.id, sending, answer };
  }

  const sendRows = async (sidecar: Sidecar, draftId: string): Promise<{ sends: string[]; drafts: string[] }> => ({
    sends: (await sidecar.db.select({ status: outboundSends.status }).from(outboundSends)
      .where(eq(outboundSends.draftId, draftId))).map((r) => r.status),
    drafts: (await sidecar.db.select({ status: drafts.status }).from(drafts)
      .where(eq(drafts.id, draftId))).map((r) => r.status),
  });

  /** The desktop's own quit at stdin end (`localShutdown`), with `request` the door request in flight. */
  async function quitDuring(rig: Rig, request: Promise<unknown>): Promise<{ exits: number[]; tookMs: number }> {
    const exits: number[] = [];
    let inFlight = 1;
    void request.finally(() => { inFlight = 0; });
    const host = {
      get inFlight() { return inFlight; },
      stop: () => undefined,
      finished: () => request.then(() => undefined, () => undefined),
    } as unknown as StdioHost;
    const began = performance.now();
    const { shutdown } = localShutdown({
      sidecar: () => rig.sidecar, host: () => host, listeners: () => [],
      log: (event, detail) => { rig.lines.push({ event, at: performance.now(), detail: (detail ?? {}) as Record<string, unknown> }); },
      exit: (code) => { exits.push(code); },
    });
    await shutdown("stdin_closed", 0);
    return { exits, tookMs: performance.now() - began };
  }

  it("a 2 s send pressed just before the quit is recorded sent, and its same-key replay at the next start answers sent", async () => {
    const rig = await boot(SEND_KNOBS, { organize: false });
    const { draftId, sending, answer } = await pressSend(rig, "quit-send-sent");
    await sleep(PRESSED_BEFORE_MS);                 // the SMTP leg ends 1.4 s into the quit
    const { exits, tookMs } = await quitDuring(rig, sending);
    await sending;

    expect(rig.seen.send.append, "the message did not go out").toBe("appended");
    expect(answer.status, "the send's own record was refused under the close").toBe(200);
    expect(answer.body?.status).toBe("sent");
    expect(exits).toEqual([0]);
    expect(tookMs, "the quit outran the shell's grace").toBeLessThan(SHUTDOWN_DEADLINE_MS);
    expect(rig.lines.some((l) => l.event === "local_db_refused_closing"), "a request met the closed store").toBe(false);
    expect(storeRecord(rig.dataDir)?.open).toBe(false);

    const next = await boot(SEND_KNOBS, { organize: false, dataDir: rig.dataDir });
    expect(await sendRows(next.sidecar, draftId), "the next start found the send unrecorded").toEqual({ sends: ["sent"], drafts: ["sent"] });
    const replay = await post(next, `/drafts/${draftId}/send`, {}, "quit-send-sent");
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect((await replay.json() as { status?: string }).status).toBe("sent");
  });

  it("a reply pressed 0.5 s before the quit while the mail server is slow to log in goes out at the next start", async () => {
    const slow: Knobs = { ...SEND_KNOBS, smtpMs: 0, connectMs: 6_000 };
    const rig = await boot(slow, { organize: false });
    const created = await post(rig, "/drafts", {
      mailboxId: rig.sidecar.world.mailboxId, subject: "Re: the list", body: "Yes, Thursday.",
      to: [{ name: null, address: "you@example.test" }],
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const draftId = (await created.json() as { id: string }).id;
    const sending = post(rig, `/drafts/${draftId}/send`, {}, "quit-slow-login").then(() => undefined, () => undefined);
    const t = performance.now();
    while (!rig.seen.send.connectAt && performance.now() - t < 10_000) await sleep(5);
    expect(rig.seen.send.connectAt, "the premise: the send door is logging in").toBeTruthy();
    await sleep(500);
    const { exits } = await quitDuring(rig, sending);
    expect(exits).toEqual([0]);
    expect(rig.seen.send.startedAt, "nothing was offered before the quit").toBeNull();

    const next = await boot({ ...SEND_KNOBS, smtpMs: 0 }, { organize: false, dataDir: rig.dataDir });
    expect(await sendRows(next.sidecar, draftId), "the row was left to the Sent check").toEqual({ sends: [], drafts: ["draft"] });
    expect(next.lines.find((l) => l.event === "inherited_sends_forgotten")?.detail, "the open did not forget it").toEqual({ count: 1 });
    const replay = await post(next, `/drafts/${draftId}/send`, {}, "quit-slow-login");
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect((await replay.json() as { status?: string }).status).toBe("sent");
    /* One process holds both runs here, so the replay may be handed the first run's warm send
       connection (the process-wide keeper); count SMTP over both. */
    expect((rig.seen.send.sends ?? 0) + (next.seen.send.sends ?? 0), "one press, one delivery").toBe(1);
    expect([rig.seen.send.append, next.seen.send.append], "its Sent copy").toContain("appended");
    expect(await sendRows(next.sidecar, draftId)).toEqual({ sends: ["sent"], drafts: ["sent"] });
    await sending;
  });

  it("SMTP accepted and the Sent copy refused, just before the quit: recorded sent, never unverified", async () => {
    const knobs: Knobs = { ...SEND_KNOBS, appendFails: true };
    const rig = await boot(knobs, { organize: false });
    const { draftId, sending, answer } = await pressSend(rig, "quit-send-no-copy");
    await sleep(PRESSED_BEFORE_MS);
    const { exits } = await quitDuring(rig, sending);
    await sending;

    expect(rig.seen.send.append).toBe("append_refused");
    expect(answer.status).toBe(200);
    expect(answer.body?.status).toBe("sent");
    expect(exits).toEqual([0]);
    const next = await boot(knobs, { organize: false, dataDir: rig.dataDir });
    expect(await sendRows(next.sidecar, draftId)).toEqual({ sends: ["sent"], drafts: ["sent"] });
  });

  it("a send the mail server refuses, just before the quit, is recorded failed", async () => {
    const knobs: Knobs = { ...SEND_KNOBS, smtpRefuses: true };
    const rig = await boot(knobs, { organize: false });
    const { draftId, sending, answer } = await pressSend(rig, "quit-send-refused");
    await sleep(PRESSED_BEFORE_MS);
    const { exits } = await quitDuring(rig, sending);
    await sending;

    expect(answer.status, JSON.stringify(answer.body)).toBeGreaterThanOrEqual(400);
    expect(answer.status).toBeLessThan(500);
    expect(exits).toEqual([0]);
    const next = await boot(knobs, { organize: false, dataDir: rig.dataDir });
    expect((await sendRows(next.sidecar, draftId)).sends).toEqual(["failed"]);
  });

  it("CONTROL: with no quit, a sent send and a refused one are recorded as before, and the replay answers sent", async () => {
    const rig = await boot(SEND_KNOBS, { organize: false });
    const { draftId, sending, answer } = await pressSend(rig, "no-quit-sent");
    await sending;
    expect(answer.status).toBe(200);
    await rig.sidecar.stop(plan());
    const next = await boot(SEND_KNOBS, { organize: false, dataDir: rig.dataDir });
    expect(await sendRows(next.sidecar, draftId)).toEqual({ sends: ["sent"], drafts: ["sent"] });
    const replay = await post(next, `/drafts/${draftId}/send`, {}, "no-quit-sent");
    expect(replay.status).toBe(200);
    expect((await replay.json() as { status?: string }).status).toBe("sent");

    const refusing = await boot({ ...SEND_KNOBS, smtpRefuses: true }, { organize: false });
    const refused = await pressSend(refusing, "no-quit-refused");
    await refused.sending;
    expect(refused.answer.status).toBeGreaterThanOrEqual(400);
    expect(refused.answer.status).toBeLessThan(500);
    expect((await sendRows(refusing.sidecar, refused.draftId)).sends).toEqual(["failed"]);
  });

  it("CONTROL: a stop without a plan still waits one drain interval for a parked pass", async () => {
    const DRAIN_MS = 1_500;
    const rig = await boot({ hangChanges: true, hangClose: false }, { organize: false, pollIntervalMs: DRAIN_MS });
    const began = performance.now();
    const stopping = rig.sidecar.stop();
    await sleep(DRAIN_MS - 300);
    expect(rig.seen.forceCloses, "the stop without a plan cut the pass early").toBe(0);
    expect(await settledWithin(stopping, 10_000), "the stop never returned").toBe(true);
    expect(rig.seen.forceClosedAt[0]! - began).toBeGreaterThanOrEqual(DRAIN_MS - 50);
    const forced = rig.lines.filter((l) => l.event === "mailbox_detach_forced");
    expect(forced).toHaveLength(1);
    expect(forced[0]!.detail.pollIntervalMs).toBe(DRAIN_MS);
    expect(forced[0]!.detail.phase, "the drain interval's line took the quit's").toBeUndefined();
  });

  it("CONTROL: a removal (quiesce, then detach) still waits one drain interval for a parked pass", async () => {
    const DRAIN_MS = 1_500;
    const rig = await boot({ hangChanges: true, hangClose: false }, { organize: false, pollIntervalMs: DRAIN_MS });
    const began = performance.now();
    const res = await rig.sidecar.handle(new Request(`http://local/local/mailboxes/${rig.sidecar.world.mailboxId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${rig.sidecar.sessionToken}`, "content-type": "application/json" },
    }));
    const took = performance.now() - began;
    expect(res.status, await res.clone().text()).toBe(200);
    expect(rig.lines.some((l) => l.event === "local_mailbox_pass_not_awaited"), "the removal did not wait on the pass").toBe(true);
    expect(took, "the removal cut the pass before one drain interval").toBeGreaterThanOrEqual(DRAIN_MS - 50);
    expect(rig.seen.forceCloses).toBe(1);
    const forced = rig.lines.filter((l) => l.event === "mailbox_detach_forced");
    expect(forced.map((l) => [l.detail.pollIntervalMs, l.detail.phase])).toEqual([[DRAIN_MS, undefined]]);
  });
});

describe("the quit plan's numbers", () => {
  it("fit inside the shell's grace, with room for the store's own shutdown", () => {
    const engineRs = readFileSync(fileURLToPath(new URL("../../desktop/src-tauri/src/engine.rs", import.meta.url)), "utf8");
    const grace = /pub const STOP_GRACE: Duration = Duration::from_secs\((\d+)\);/.exec(engineRs);
    expect(grace, "STOP_GRACE is no longer where this reads it").not.toBeNull();
    expect(SHUTDOWN_DEADLINE_MS, "the engine's deadline is not the shell's grace").toBe(Number(grace![1]) * 1_000);
    expect(QUIT_PASS_MS).toBeLessThan(QUIT_STORE_WAIT_MS);
    expect(QUIT_STORE_WAIT_MS + QUIT_STORE_CLOSE_RESERVE_MS).toBeLessThanOrEqual(QUIT_GOODBYE_MS);
    expect(QUIT_GOODBYE_MS).toBeLessThanOrEqual(SHUTDOWN_DEADLINE_MS - 500);
    /* The doors' requests keep the store until the latest instant that still leaves the measured
       close before the deadline, and never less than the passes get. */
    expect(QUIT_REQUESTS_MS).toBe(SHUTDOWN_DEADLINE_MS - QUIT_STORE_CLOSE_RESERVE_MS);
    expect(QUIT_REQUESTS_MS).toBeGreaterThan(QUIT_PASS_MS);
    expect(QUIT_REQUESTS_MS).toBeLessThan(QUIT_GOODBYE_MS);
  });
});

describe("the local shutdown", () => {
  it("starts the quit at once and hands the requests in flight to it, then says how it left", async () => {
    const lines: Line[] = [];
    const exits: number[] = [];
    let stoppedWith: QuitPlan | null = null;
    let hostStopped = false;
    const host = {
      inFlight: 1,
      stop: () => { hostStopped = true; },
      finished: () => new Promise<void>(() => undefined),     // a request that never finishes
    } as unknown as StdioHost;
    const report: QuitReport = { requestsMs: 2_000, passesMs: 3, storeWaitMs: 4, storeCloseMs: 150, goodbyesMs: 160, forced: 0 };
    const { shutdown } = localShutdown({
      sidecar: () => ({ stop: (async (p?: QuitPlan) => { stoppedWith = p ?? null; return report; }) as Sidecar["stop"] }),
      host: () => host,
      listeners: () => [null],
      log: (event, detail) => { lines.push({ event, at: performance.now(), detail: (detail ?? {}) as Record<string, unknown> }); },
      exit: (code) => { exits.push(code); },
    });

    expect(await settledWithin(shutdown("stdin_closed", 0), 1_000), "the shutdown waited for the request").toBe(true);

    expect(hostStopped).toBe(true);
    expect(stoppedWith, "the engine was stopped without the plan").not.toBeNull();
    const p = stoppedWith as unknown as QuitPlan;
    expect(p.requests, "the requests in flight were not handed to the quit").toBeInstanceOf(Promise);
    expect(p.passMs).toBeGreaterThan(QUIT_PASS_MS - 100);
    expect(p.passMs).toBeLessThanOrEqual(QUIT_PASS_MS);
    expect(p.goodbyeMs).toBeLessThanOrEqual(QUIT_GOODBYE_MS);
    expect(p.requestsMs, "the requests in flight were given the passes' bound").toBeGreaterThan(QUIT_REQUESTS_MS - 100);
    expect(p.requestsMs).toBeLessThanOrEqual(QUIT_REQUESTS_MS);
    expect(exits).toEqual([0]);
    const left = lines.find((l) => l.event === "engine_left");
    expect(left?.detail).toMatchObject({ reason: "stdin_closed", outcome: "closed", storeCloseMs: 150, forced: 0 });
  });

  it("a store that did not close exits 1 and says it was left open", async () => {
    const lines: Line[] = [];
    const exits: number[] = [];
    const { shutdown } = localShutdown({
      sidecar: () => ({ stop: (async () => { throw new Error("the store would not close"); }) as Sidecar["stop"] }),
      host: () => null,
      listeners: () => [],
      log: (event, detail) => { lines.push({ event, at: 0, detail: (detail ?? {}) as Record<string, unknown> }); },
      exit: (code) => { exits.push(code); },
    });
    await shutdown("SIGTERM", 0);
    expect(exits).toEqual([1]);
    expect(lines.map((l) => l.event)).toEqual(["shutdown", "shutdown_failed", "engine_left"]);
    expect(lines.at(-1)!.detail.outcome).toBe("left_open");
  });
});
