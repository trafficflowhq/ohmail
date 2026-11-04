import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { createSidecar, LOCAL_CONNECTION_DEAD_AFTER_CYCLES, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE LOCAL DOOR NAMES ITS FAILING MAILBOX — review the control, on the door that had none
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The Windows guest read "Sync failed. Retrying." on the rail while the engine's own log was
 * healthy: the strip's blanket sentence is about the WINDOW's pull loop and names no mailbox,
 * and the standalone store never writes `mailboxes.error_code`, so `GET /mailboxes` served
 * `connected` for a mailbox whose sync had stopped. `discloseLocalSyncFailures` now derives the
 * row's `status`/`errorCode` at read time from the runtime's settled connection state — the one
 * writer pair that already exists — so a healthy mailbox and a failing one stop sharing a
 * sentence: the failing row carries its own reason and the shell's `mailboxError` arm names its
 * address.
 *
 * The rig is the REAL pipeline: a real sidecar over PGlite, two mailboxes through the add door,
 * cycles driven through `syncMailbox`, the verdict taken from the route every surface polls.
 * Only the IMAP socket is a double, with a mutable fault per world.
 *
 * ── MUTATION-WATCH (edit the source, watch, restore via kit/mutate/mutation-control.sh) ────
 *
 *  · drop `outageSince = null` from `noteCycleServed` → "a later successful pull CLEARS it"
 *    reddens: the row stays `error` after a served cycle, which is the stale-indicator defect.
 *  · flip the age comparison in `discloseLocalSyncFailures` (`>=` → `<`) → the blip case
 *    reddens: a fresh outage disclosed before the bound, and the settled one hidden.
 *  · drop the `signInRefused` arm there → the refused-sign-in case reddens on `connected`.
 */

const HOUR = 60 * 60 * 1000;
const SEED_USER = "one@example.test";
const SECOND_USER = "two@example.test";
const HOST_A = "imap-a.invalid";
const HOST_B = "imap-b.invalid";
const EMPTY_CURSOR = { folders: {} };

/** One mailbox's `ohmail/_meta`, in memory — empty: nobody has ever organized it. */
class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

interface World {
  user: string;
  host: string;
  meta: MemoryMeta;
  deliver: number[];
  handed: boolean;
  /** The mail server is gone: every read on the connection dies with a socket-class code. */
  dead: boolean;
  /** The mail server answers and refuses the login — the `signInRefused` state, at the dial. */
  refuseLogin: boolean;
}

const makeWorld = (user: string, host: string, deliver: number[]): World =>
  ({ user, host, meta: new MemoryMeta(), deliver, handed: false, dead: false, refuseLogin: false });

function arrival(uid: number, to: string): Buffer {
  return Buffer.from([
    `Message-ID: <m-${uid}-${to}@stranger.test>`,
    "From: stranger@elsewhere.test",
    `To: ${to}`,
    `Subject: mail ${uid} for ${to}`,
    "Date: Wed, 02 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "hello",
  ].join("\r\n"), "utf8");
}

/** A socket-class death, as `isConnectionFailure` classifies one — a code, never a message. */
const socketDeath = (): Error => Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
/** A refused sign-in, as `credentialsRefused` classifies one. */
const loginRefusal = (): Error =>
  Object.assign(new Error("LOGIN failed"), { authenticationFailed: true });

/** The factory both mailboxes dial through, dispatching on the username the engine resolved. */
function dispatcher(worlds: World[]) {
  return (cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => {
    const w = worlds.find((x) => x.user === cfg.auth.user);
    if (!w) throw new Error(`this engine dialled ${JSON.stringify(cfg.auth.user)}, which is no mailbox here`);
    return {
      leaseIo: () => w.meta,
      leasePeekIo: () => ({ listClaims: () => w.meta.listClaims() }),
      async connect(): Promise<void> {
        if (w.refuseLogin) throw loginRefusal();
        if (w.dead) throw socketDeath();
      },
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        return {
          move: true, uidplus: true, condstore: true, qresync: false,
          idle: true, specialUse: true, sentFolder: null,
        };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince(): Promise<ChangeBatch> {
        if (w.dead) throw socketDeath();
        if (w.handed) return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR };
        w.handed = true;
        return {
          creates: w.deliver.map((uid) => ({
            type: "create" as const,
            locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator,
            raw: arrival(uid, w.user),
          })) as ChangeBatch["creates"],
          moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR,
        };
      },
      async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> {
        return { folder: toFolder, ref: "7:41" };
      },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(): Promise<() => Promise<void>> { return async () => {}; },
      async send(m: OutboundMessage): Promise<SendResult> {
        return {
          providerMessageId: `<sent@${w.user}>`,
          sentLocator: { folder: "Sent", ref: "9:1" } as NativeLocator,
          raw: Buffer.from(`Message-ID: <sent@${w.user}>\r\nSubject: ${m.subject ?? ""}\r\n\r\nbody`, "utf8"),
        } as unknown as SendResult;
      },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    };
  };
}

describe("the local door's per-mailbox sync-failure disclosure", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  /** The injected clock every disclosure age is judged against. */
  let clockMs = Date.parse("2026-09-19T12:00:00.000Z");
  /** The engine's event names, per boot: the launch barrier below reads them. */
  let events: string[] = [];

  async function boot(worlds: World[]): Promise<Sidecar> {
    events = [];
    clockMs = Date.parse("2026-09-19T12:00:00.000Z");
    const dataDir = await freshDataDir("ohmail-outage-");
    const seed = worlds[0]!;
    const s = await createSidecar({
      dataDir,
      imap: {
        host: seed.host, port: 993, secure: true,
        auth: { user: seed.user, pass: "mailbox-unreached-password" },
        smtp: { host: "smtp-a.invalid", port: 587, secure: false },
      },
      address: seed.user,
      machineName: "this machine",
      // Long enough that no timer fires on its own: every cycle is one this file asked for.
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      keks: { 1: Buffer.alloc(32, 7) },
      adapterFactory: dispatcher(worlds),
      now: () => new Date(clockMs),
      log: (event) => { events.push(event); },
    });
    cleanups.push(async () => {
      await s.stop().catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    });
    await s.start();
    return s;
  }

  const auth = (s: Sidecar): HeadersInit => ({
    authorization: `Bearer ${s.sessionToken}`,
    "content-type": "application/json",
  });

  const addSecond = async (s: Sidecar): Promise<string> => {
    const res = await s.handle(new Request("http://local/local/mailboxes", {
      method: "POST", headers: auth(s), body: JSON.stringify({
        provider: "imap", address: SECOND_USER,
        imap: { host: HOST_B, port: 993, secure: true, user: SECOND_USER, pass: "second-password" },
        smtp: { host: "smtp-b.invalid", port: 587, secure: false },
      }),
    }));
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  /**
   * ADD THE SECOND MAILBOX AND WAIT OUT ITS LAUNCH. The add answers at the dial and the launch drains
   * behind it, so a fault injected before that drain lands fails the LAUNCH (a death by event,
   * re-dialled on its ladder) rather than the cycles a case drives. Two drains follow the add: the
   * launch's own and this helper's `syncMailbox`, in either order.
   */
  const addSecondSettled = async (s: Sidecar): Promise<string> => {
    const from = events.length;
    const bId = await addSecond(s);
    await s.syncMailbox(bId);
    const deadline = Date.now() + 10_000;
    while (events.slice(from).filter((e) => e === "sync_drain").length < 2) {
      if (Date.now() > deadline) throw new Error("the added mailbox's launch never drained");
      await new Promise((r) => setTimeout(r, 10));
    }
    return bId;
  };
  /** The rows every surface reads, keyed by address — the DTO after the disclosure overlay. */
  const rows = async (s: Sidecar): Promise<Record<string, { status: string; errorCode: string | null }>> => {
    const res = await s.handle(new Request("http://local/mailboxes", { method: "GET", headers: auth(s) }));
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as {
      items: Array<{ address: string; status: string; errorCode?: string | null }>;
    };
    return Object.fromEntries(items.map((m) => [m.address, { status: m.status, errorCode: m.errorCode ?? null }]));
  };

  /** Each row's outage clock, keyed by address — absent while the runtime has observed none. */
  const outageClock = async (s: Sidecar): Promise<Record<string, string | undefined>> => {
    const res = await s.handle(new Request("http://local/mailboxes", { method: "GET", headers: auth(s) }));
    const { items } = (await res.json()) as { items: Array<{ address: string; unreachableSince?: string }> };
    return Object.fromEntries(items.map((m) => [m.address, m.unreachableSince]));
  };

  /** Drive one settled-and-failed cycle; the throw is the expected shape, not the assertion. */
  const failingCycle = async (s: Sidecar, id: string): Promise<void> => {
    await s.syncMailbox(id).then(
      () => { throw new Error("this cycle was expected to fail and served instead"); },
      () => undefined,
    );
  };

  it("a standing outage is disclosed AFTER the dead bound, named on ITS row, and a served cycle clears it", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21]);
    const s = await boot([a, b]);
    const bId = await addSecondSettled(s);

    // Both healthy: no overlay, which is the positive control for the ordinary case.
    expect((await rows(s))[SECOND_USER]).toEqual({ status: "connected", errorCode: null });
    expect((await outageClock(s))[SECOND_USER]).toBeUndefined();

    // The server goes away; the runtime concludes the connection dead by its own cycle bound.
    b.dead = true;
    for (let i = 0; i < LOCAL_CONNECTION_DEAD_AFTER_CYCLES; i++) await failingCycle(s, bId);

    /* A BLIP NEVER PAINTS: the outage is real but younger than the product's stated bound, so
       the row still claims health — the strip's own streak philosophy, at the DTO. */
    expect((await rows(s))[SECOND_USER],
      "an outage younger than the dead bound was disclosed").toEqual({ status: "connected", errorCode: null });
    /* …but the outage's clock rides at once, on ITS row only: the list's status line and a Pull
       press say "can't reach the mail server" from it, as the Settings pane does. */
    const young = await outageClock(s);
    expect(typeof young[SECOND_USER], "the outage's clock was withheld until the dead bound").toBe("string");
    expect(young[SEED_USER], "the healthy mailbox carried its neighbour's outage clock").toBeUndefined();

    // The outage stands past the bound: the failing row is named, the healthy one untouched.
    clockMs += 121_000;
    const disclosed = await rows(s);
    expect(disclosed[SECOND_USER], "a mailbox whose sync stopped kept claiming health")
      .toEqual({ status: "error", errorCode: "connect" });
    expect(disclosed[SEED_USER], "the HEALTHY mailbox was painted with its neighbour's outage")
      .toEqual({ status: "connected", errorCode: null });

    // fail-then-fail KEEPS the reason.
    await failingCycle(s, bId);
    expect((await rows(s))[SECOND_USER]).toEqual({ status: "error", errorCode: "connect" });

    // fail-then-succeed CLEARS it: the server returns, a cycle serves, the one writer clears.
    b.dead = false;
    await s.syncMailbox(bId);
    expect((await rows(s))[SECOND_USER], "a served cycle did not clear the disclosed outage")
      .toEqual({ status: "connected", errorCode: null });
    expect((await outageClock(s))[SECOND_USER], "a served cycle left the outage clock standing").toBeUndefined();
  });

  it("a refused sign-in is `auth` at once, keeps its reason while it stands, and the password press ends it", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21]);
    const s = await boot([a, b]);
    const bId = await addSecondSettled(s);

    /* The connection dies first (so the next cycle re-dials at all), and the re-dial meets a
       server that ANSWERS and refuses the login — the `signInRefused` path, not an outage. */
    b.dead = true;
    for (let i = 0; i < LOCAL_CONNECTION_DEAD_AFTER_CYCLES; i++) await failingCycle(s, bId);
    b.dead = false;
    b.refuseLogin = true;
    await s.syncMailbox(bId).catch(() => undefined);

    /* `auth` needs NO age: the server's own answer is settled the moment it is given, and the
       generic `connect` here would send somebody to check a network that is working. */
    expect((await rows(s))[SECOND_USER],
      "a refused sign-in was not disclosed, or was disclosed as an outage")
      .toEqual({ status: "error", errorCode: "auth" });

    // Persistent: the refusal suspends re-dials, and the reason stands until the password moves.
    await s.syncMailbox(bId).catch(() => undefined);
    expect((await rows(s))[SECOND_USER]).toEqual({ status: "error", errorCode: "auth" });

    // The one press that ends it: a new password through the seal door, then a served cycle.
    b.refuseLogin = false;
    const sealed = await s.handle(new Request(`http://local/local/mailboxes/${bId}`, {
      method: "PATCH", headers: auth(s), body: JSON.stringify({ imap: { pass: "the-new-password" } }),
    }));
    expect(sealed.status).toBe(200);
    await s.syncMailbox(bId);
    expect((await rows(s))[SECOND_USER], "the replaced password did not clear the refusal")
      .toEqual({ status: "connected", errorCode: null });
  });
});
