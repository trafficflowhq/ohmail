import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { eq } from "drizzle-orm";
import { mailboxCredentials, mailboxes } from "@trafficflow/db";
import { GOOGLE_AUTH_REFUSAL } from "@trafficflow/services/mail";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * "SIGN IN AGAIN" ON A MAILBOX WITH NO STORED PASSWORD. Two mailboxes, sign out, reconnect only
 * the first: mailbox two's row reads "needs a password", and the press — the password alone —
 * was refused "imap host is required", because its server lived only in the credential rows the
 * sign-out deleted. The sign-out now keeps their non-secret half on the mailbox row (mail 0127),
 * and the press stores the password against it and launches the mailbox it could not launch.
 * Real engine, real store; only the mail server is a double, one login per user.
 */

const ONE = { host: "imap.one.invalid", user: "one@trafficflow.test", pass: "the-first-password" };
const TWO = { host: "imap.two.invalid", user: "two@trafficflow.test", pass: "the-second-password" };
const HOUR = 60 * 60 * 1000;
const EMPTY_CURSOR = { folders: {} };
const kek = (fill: number): Buffer => Buffer.alloc(32, fill);

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
  uidValidity(): number | bigint | null { return 4_200; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(installId)).map((c) => ({ ...c }));
  }
}

/** What the next login for a user does; unscripted, the server takes its one password. */
type Step = "ok" | "auth" | "tls" | "down" | "hang";

interface Wire {
  readonly accept: Map<string, string>;
  readonly script: Map<string, Step[]>;
  readonly connects: Array<{ host: string; user: string; pass: string }>;
  unopened: number;
  /** The first drain waits this long — a large mailbox, as far as a press can tell. */
  drainMs: number;
  /** A `hang` connect waits here until the case lets it go, and then fails as a dead network. */
  readonly hung: Array<() => void>;
}

/** A refusal in the shape imapflow gives it: the flag the engine's two predicates read. */
function refusal(step: Exclude<Step, "ok" | "hang">): Error {
  const err = new Error(`rig: ${step}`) as Error & Record<string, unknown>;
  if (step === "auth") err.authenticationFailed = true;
  if (step === "tls") err.tlsFailed = true;
  if (step === "down") err.code = "ECONNREFUSED";
  return err;
}

function adapterFactory(wire: Wire) {
  const metas = new Map<string, MemoryMeta>();
  return (cfg: ImapConfig): MailboxAdapter & { leaseIo(): LeaseIo; leasePeekIo(): LeasePeekIo } => {
    const user = cfg.auth.user;
    const meta = metas.get(user) ?? new MemoryMeta();
    metas.set(user, meta);
    let live = false;
    const assertLive = (): void => {
      if (live) return;
      wire.unopened += 1;
      throw Object.assign(new Error("Connection not available"), { code: "NoConnection" });
    };
    return {
      leaseIo: () => ({
        ensureMetaFolder: async () => { assertLive(); },
        listClaims: async () => { assertLive(); return meta.listClaims(); },
        appendClaim: async (raw: string) => { assertLive(); await meta.appendClaim(raw); },
        removeClaims: async (refs: readonly unknown[]) => { assertLive(); await meta.removeClaims(refs); },
        uidValidity: () => (live ? meta.uidValidity() : null),
        findOwnRecords: async (id: string) => { assertLive(); return meta.findOwnRecords(id); },
      }),
      leasePeekIo: () => ({ listClaims: async () => { assertLive(); return meta.listClaims(); } }),
      async connect(): Promise<void> {
        const pass = (cfg.auth as { pass?: string }).pass ?? "";
        wire.connects.push({ host: cfg.host, user, pass });
        const step = wire.script.get(user)?.shift() ?? (wire.accept.get(user) === pass ? "ok" : "auth");
        if (step === "hang") {
          await new Promise<void>((r) => { wire.hung.push(r); });
          throw refusal("down");
        }
        if (step !== "ok") throw refusal(step);
        live = true;
      },
      async close(): Promise<void> { live = false; },
      async capabilities(): Promise<ImapCapabilities> {
        assertLive();
        return {
          move: true, uidplus: true, condstore: true, qresync: false,
          idle: true, specialUse: true, sentFolder: null,
        };
      },
      async ensureFolders(): Promise<void> { assertLive(); },
      async changesSince(): Promise<ChangeBatch> {
        assertLive();
        if (wire.drainMs > 0) await new Promise((r) => { setTimeout(r, wire.drainMs); });
        return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: EMPTY_CURSOR };
      },
      async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> {
        assertLive();
        return { folder: toFolder, ref: "7:41" };
      },
      async setFlags(): Promise<void> { assertLive(); },
      async scanSentRecipients(): Promise<string[]> { assertLive(); return []; },
      async watch(): Promise<() => Promise<void>> { assertLive(); return async () => {}; },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
      async send(): Promise<SendResult> { throw new Error("no send in this rig"); },
    };
  };
}

describe("Sign in again on a mailbox with no stored password", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  interface Booted {
    s: Sidecar;
    events: Array<{ event: string; detail: Record<string, unknown> }>;
  }

  const newWire = (): Wire => ({
    accept: new Map([[ONE.user, ONE.pass], [TWO.user, TWO.pass]]),
    script: new Map(),
    connects: [],
    unopened: 0,
    drainMs: 0,
    hung: [],
  });

  /** One launch of the seed mailbox; `pass` omitted is a launch with none in the environment. */
  async function launch(
    dataDir: string, wire: Wire, pass?: string,
    timeouts?: { connectionMs: number; greetingMs: number; socketMs: number },
  ): Promise<Booted> {
    const events: Booted["events"] = [];
    const s = await createSidecar({
      dataDir,
      imap: {
        host: ONE.host, port: 993, secure: true,
        auth: { user: ONE.user, ...(pass === undefined ? {} : { pass }) },
        ...(timeouts ? { timeouts } : {}),
      },
      address: ONE.user,
      machineName: "the machine that signed out",
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      keks: { 1: kek(7) },
      adapterFactory: adapterFactory(wire),
      log: (event, detail) => { events.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
    });
    cleanups.push(async () => { await s.stop().catch(() => undefined); });
    return { s, events };
  }

  const auth = (b: Booted): HeadersInit => ({
    authorization: `Bearer ${b.s.sessionToken}`, "content-type": "application/json",
  });
  /** The Settings press: the password alone, to the row it was made on. */
  const press = async (b: Booted, id: string, pass: string): Promise<Response> =>
    b.s.handle(new Request(`http://local/local/mailboxes/${id}`, {
      method: "PATCH", headers: auth(b), body: JSON.stringify({ imap: { pass } }),
    }));
  const connection = async (b: Booted, id: string): Promise<Record<string, unknown>> => {
    const res = await b.s.handle(new Request("http://local/local/mailboxes/connections", {
      method: "GET", headers: auth(b),
    }));
    const body = await res.json() as { items: Array<Record<string, unknown>> };
    return body.items.find((i) => i.mailboxId === id) ?? {};
  };
  const rowsOf = async (b: Booted, id: string) =>
    b.s.db.select({ transport: mailboxCredentials.transport, meta: mailboxCredentials.meta })
      .from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id));
  const keptOf = async (b: Booted, id: string): Promise<unknown> =>
    (await b.s.db.select({ kept: mailboxes.signedOutMeta }).from(mailboxes)
      .where(eq(mailboxes.id, id)))[0]?.kept ?? null;
  const count = (b: Booted, event: string): number => b.events.filter((e) => e.event === event).length;
  const dialsOf = (wire: Wire, user: string, from: number) =>
    wire.connects.slice(from).filter((c) => c.user === user);

  /**
   * Two mailboxes (the second with an outgoing server), sign out, stop; then the first is
   * reconnected — its password in the launch, as a relaunch holds it — and the second is bare.
   * `earlier`: the sign-out an earlier version made — the outgoing row left, password and all,
   * and nothing kept on the mailbox row (mail 0127 is newer than that build).
   */
  async function signedOutTwo(
    wire: Wire = newWire(), opts: { earlier?: boolean; twoHost?: string } = {},
  ): Promise<{ c: Booted; id1: string; id2: string; wire: Wire; dataDir: string }> {
    const dataDir = await freshDataDir("ohmail-bare-signin-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const a = await launch(dataDir, wire, ONE.pass);
    await a.s.start();
    const id1 = a.s.world.mailboxId;
    const added = await a.s.handle(new Request("http://local/local/mailboxes", {
      method: "POST", headers: auth(a),
      body: JSON.stringify({
        provider: "imap", address: TWO.user,
        imap: { host: opts.twoHost ?? TWO.host, port: 993, secure: true, user: TWO.user, pass: TWO.pass },
        smtp: { host: "smtp.two.invalid", port: 465, secure: true, pass: TWO.pass },
      }),
    }));
    expect(added.status, "the rig could not add mailbox two").toBe(201);
    const id2 = ((await added.json()) as { id: string }).id;
    expect((await rowsOf(a, id2)).map((r) => r.transport).sort(), "mailbox two was added "
      + "without both rows, so the sign-out below has nothing to prove").toEqual(["imap", "smtp"]);
    const [leftover] = await a.s.db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, id2));
    const out = await a.s.handle(new Request("http://local/local/stored-login", {
      method: "DELETE", headers: auth(a),
    }));
    expect(out.status).toBe(200);
    if (opts.earlier) await earlierSignOut(a, id2, leftoverSmtp(leftover));
    await a.s.stop();
    const c = await launch(dataDir, wire, ONE.pass);
    await c.s.start();
    return { c, id1, id2, wire, dataDir };
  }

  /** Mailbox two's outgoing row as it stood before the sign-out, rebuilt from the row read then. */
  const leftoverSmtp = (row: unknown): typeof mailboxCredentials.$inferInsert => {
    const r = row as typeof mailboxCredentials.$inferSelect;
    return {
      mailboxId: r.mailboxId, transport: "smtp", secretEnc: r.secretEnc, keyVersion: r.keyVersion,
      meta: { host: "smtp.two.invalid", port: 465, secure: true, user: TWO.user }, updatedAt: new Date(),
    };
  };
  /** What an earlier build's sign-out left: the outgoing row with its password, no kept column. */
  async function earlierSignOut(b: Booted, id: string, row: typeof mailboxCredentials.$inferInsert | null): Promise<void> {
    await b.s.db.update(mailboxes).set({ signedOutMeta: null }).where(eq(mailboxes.id, id));
    if (row) await b.s.db.insert(mailboxCredentials).values(row);
  }

  it("the sign-out removes every transport and keeps only where the mailbox lives", async () => {
    const { c, id2 } = await signedOutTwo();
    expect(await rowsOf(c, id2), "a password outlived the sign-out").toEqual([]);
    /* The allow-list, whole: nothing that is not a server coordinate — no consent marker, no
       witness, and never a password. */
    expect(await keptOf(c, id2)).toEqual({
      imap: { host: TWO.host, port: 993, secure: true, user: TWO.user },
      smtp: { host: "smtp.two.invalid", port: 465, secure: true, user: TWO.user },
    });
    const row = await connection(c, id2);
    expect(row.needsCredential, "the rig did not reach the state the press is for").toBe(true);
  });

  it("the press stores the password against the mailbox's own servers and launches it", async () => {
    const { c, id2, wire } = await signedOutTwo();
    const from = wire.connects.length;
    /* From here: the sign-out above closed mailbox two's login under its first drain, which is
       the sign-out working and not this press's doing. */
    const unopened = wire.unopened;
    const res = await press(c, id2, TWO.pass);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);

    const rows = await rowsOf(c, id2);
    expect(rows.find((r) => r.transport === "imap")?.meta).toMatchObject({ host: TWO.host, user: TWO.user });
    expect(rows.map((r) => r.transport).sort(), "one password, both transports").toEqual(["imap", "smtp"]);
    /* THE PROBE, THEN THE LAUNCH — both to mailbox two's own server, never mailbox one's. */
    expect(dialsOf(wire, TWO.user, from).map((d) => d.host)).toEqual([TWO.host, TWO.host]);
    expect(wire.connects.slice(from).some((d) => d.user === TWO.user && d.host === ONE.host)).toBe(false);
    await vi.waitFor(async () => {
      const row = await connection(c, id2);
      expect(row.needsCredential).toBe(false);
      expect(row.reachable, "the mailbox was stored and never launched").toBe(true);
    }, { timeout: 5_000, interval: 25 });
    expect(wire.unopened - unopened, "a command went down a connection nobody opened").toBe(0);
  });

  it("removing the signed-out mailbox takes its kept location with it", async () => {
    const { c, id2 } = await signedOutTwo();
    const res = await c.s.handle(new Request(`http://local/local/mailboxes/${id2}`, {
      method: "DELETE", headers: auth(c),
    }));
    expect(res.status).toBe(200);
    expect(await keptOf(c, id2), "a removed mailbox kept where it lived").toBeNull();
  });

  it("a mailbox the row says nothing about is still refused, and nothing dials", async () => {
    const { c, id2, wire } = await signedOutTwo();
    await c.s.db.update(mailboxes).set({ signedOutMeta: null }).where(eq(mailboxes.id, id2));
    const from = wire.connects.length;
    const res = await press(c, id2, TWO.pass);
    expect(res.status).toBe(400);
    /* BY NAME, with nothing known: the window reads this code to ask for the server once. */
    expect(((await res.json()) as { error: unknown }).error).toMatchObject({
      code: "mailbox_server_unknown",
      details: { provider: "imap", login: null, outgoingHost: null },
    });
    expect(dialsOf(wire, TWO.user, from), "a host was invented for a mailbox nobody located").toEqual([]);
  });

  it("a wrong password is refused and leaves the mailbox exactly as it was", async () => {
    const { c, id2, wire } = await signedOutTwo();
    const kept = await keptOf(c, id2);
    const res = await press(c, id2, "not-the-password");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("mailbox_probe_failed");
    expect(await rowsOf(c, id2), "a refused password was stored").toEqual([]);
    expect(await keptOf(c, id2), "the refusal cost the mailbox its location").toEqual(kept);
    expect((await press(c, id2, TWO.pass)).status, "the right password did not work next").toBe(200);
  });

  it("a launch the server refuses is the press's refusal, and discards what it stored", async () => {
    const wire = newWire();
    const { c, id2 } = await signedOutTwo(wire);
    wire.script.set(TWO.user, ["ok", "auth"]);
    const res = await press(c, id2, TWO.pass);
    expect(res.status).toBe(400);
    const error = ((await res.json()) as { error: { code: string; details: Record<string, unknown> } }).error;
    expect(error.code).toBe("mailbox_probe_failed");
    // Control for the Google case below: another host's refusal carries no hint.
    expect(error.details).toEqual({ reason: "auth", transport: "imap" });
    expect(await rowsOf(c, id2), "the refused seal was left to win over the next press").toEqual([]);
    expect(count(c, "local_mailbox_launch_refused")).toBe(1);
    expect(await keptOf(c, id2)).toMatchObject({ imap: { host: TWO.host } });
  });

  it("a launch Google refuses says Google's sentence, with the hint", async () => {
    const wire = newWire();
    const { c, id2 } = await signedOutTwo(wire, { twoHost: "imap.gmail.com" });
    wire.script.set(TWO.user, ["ok", "auth"]);
    const res = await press(c, id2, TWO.pass);
    expect(res.status).toBe(400);
    const error = ((await res.json()) as { error: { code: string; message: string; details: Record<string, unknown> } }).error;
    expect(error.code).toBe("mailbox_probe_failed");
    expect(error.details).toEqual({ reason: "auth", transport: "imap", authHint: "invalid" });
    expect(error.message).toBe(GOOGLE_AUTH_REFUSAL.invalid);
    expect(count(c, "local_mailbox_launch_refused")).toBe(1);
  });

  it("an outage at the launch is an outage, not a refusal", async () => {
    const wire = newWire();
    const { c, id2 } = await signedOutTwo(wire);
    wire.script.set(TWO.user, ["ok", "down"]);
    const res = await press(c, id2, TWO.pass);
    expect(res.status, "a server that did not answer was reported as refusing").toBe(200);
    expect((await rowsOf(c, id2)).length, "an outage threw the password away").toBe(2);
    const row = await connection(c, id2);
    expect(row.reachable).toBe(false);
    expect(row.unreachableSince).toEqual(expect.any(String));
    expect(row.signInRefused).toBe(false);
  });

  describe("the seed, before its first seal", () => {
    it("takes the same press against its own configuration", async () => {
      const wire = newWire();
      const dataDir = await freshDataDir("ohmail-bare-seed-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const b = await launch(dataDir, wire);
      await b.s.start();
      const id = b.s.world.mailboxId;
      expect((await connection(b, id)).needsCredential).toBe(true);
      const res = await press(b, id, ONE.pass);
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      expect((await rowsOf(b, id))[0]?.meta).toMatchObject({ host: ONE.host, user: ONE.user });
      expect(count(b, "mailbox_launch_on_press")).toBe(1);
      await vi.waitFor(async () => {
        expect((await connection(b, id)).reachable).toBe(true);
      }, { timeout: 5_000, interval: 25 });
      expect(wire.unopened).toBe(0);
    });

    it("the press waits for the login and not for the first drain", async () => {
      const wire = newWire();
      wire.drainMs = 3_000;
      const dataDir = await freshDataDir("ohmail-bare-seed-drain-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const b = await launch(dataDir, wire, undefined, { connectionMs: 1_000, greetingMs: 1_000, socketMs: 10_000 });
      await b.s.start();
      // On a FAKE clock that stands still: the 3 s drain can only end if the case moves it, so a
      // press that waited for it would never answer.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const t0 = Date.now();
        const res = await press(b, b.s.world.mailboxId, ONE.pass);
        const took = Date.now() - t0;
        expect(res.status).toBe(200);
        expect(took, `the press waited ${took} ms: it held the person through the first drain`)
          .toBeLessThan(1_000);
        await vi.advanceTimersByTimeAsync(3_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("the wait is bounded by the dial's own two deadlines", async () => {
      const wire = newWire();
      const dataDir = await freshDataDir("ohmail-bare-seed-bound-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const b = await launch(dataDir, wire, undefined, { connectionMs: 150, greetingMs: 150, socketMs: 10_000 });
      await b.s.start();
      wire.script.set(ONE.user, ["ok", "hang"]);
      // The two deadlines on a FAKE clock: once the press's dial hangs on the wire only the clock
      // moves it, one tick short of connect + greeting it is still waiting, and at them it answers.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const t0 = Date.now();
        let answered = false;
        const pending = press(b, b.s.world.mailboxId, ONE.pass).finally(() => { answered = true; });
        while (wire.hung.length === 0) await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(299);
        expect(answered, "the press answered inside connect + greeting").toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        const res = await pending;
        const took = Date.now() - t0;
        expect(res.status, "a server still answering was reported as refusing").toBe(200);
        expect(took, `the press answered after ${took} ms`).toBeGreaterThanOrEqual(290);
        expect(took, `the press waited ${took} ms past connect + greeting`).toBeLessThan(1_200);
        expect((await rowsOf(b, b.s.world.mailboxId)).length).toBe(1);
      } finally {
        for (const go of wire.hung.splice(0)) go();
        vi.useRealTimers();
      }
    });

    it("a TLS refusal at the launch reaches the field too", async () => {
      const wire = newWire();
      const dataDir = await freshDataDir("ohmail-bare-seed-tls-");
      cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
      const b = await launch(dataDir, wire);
      await b.s.start();
      wire.script.set(ONE.user, ["ok", "tls"]);
      const res = await press(b, b.s.world.mailboxId, ONE.pass);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("mailbox_probe_failed");
      expect(await rowsOf(b, b.s.world.mailboxId)).toEqual([]);
    });
  });

  it("CONTROL — a mailbox with a stored row keeps today's path, whatever the row kept", async () => {
    const { c, id1, wire } = await signedOutTwo();
    /* A location the sign-out kept that disagrees with the stored row: the row must win. */
    await c.s.db.update(mailboxes)
      .set({ signedOutMeta: { imap: { host: "imap.elsewhere.invalid", port: 143, secure: false, user: "x" } } })
      .where(eq(mailboxes.id, id1));
    const from = wire.connects.length;
    const res = await press(c, id1, ONE.pass);
    expect(res.status).toBe(200);
    expect(dialsOf(wire, ONE.user, from).map((d) => d.host)[0]).toBe(ONE.host);
    expect((await rowsOf(c, id1)).find((r) => r.transport === "imap")?.meta)
      .toMatchObject({ host: ONE.host, port: 993, secure: true });
    expect(count(c, "mailbox_launch_on_press"), "a stored-row press took the bare path").toBe(0);
  });

  /**
   * SIGNED OUT BY AN EARLIER VERSION — the incoming row removed, the outgoing row LEFT with its
   * password, and nothing kept (mail 0127 is newer than that build). The start removes the leftover
   * row with its coordinates moved into `signed_out_meta` first, once; the password-only press
   * is refused by name with what is still known; the ask-once press signs the mailbox in.
   */
  describe("a mailbox an earlier version signed out", () => {
    it("the next start removes the leftover outgoing password and keeps its server, once", async () => {
      const { c, id1, id2, wire, dataDir } = await signedOutTwo(newWire(), { earlier: true });
      expect(await rowsOf(c, id2), "a password outlived the start").toEqual([]);
      expect(await keptOf(c, id2)).toEqual({
        smtp: { host: "smtp.two.invalid", port: 465, secure: true, user: TWO.user },
      });
      const lines = c.events.filter((e) => e.event === "signed_out_residue_removed");
      expect(lines.map((l) => l.detail)).toEqual([expect.objectContaining({ mailboxId: id2, count: 1 })]);
      expect((await rowsOf(c, id1)).map((r) => r.transport), "the signed-in mailbox lost a row")
        .toEqual(["imap"]);
      await c.s.stop();
      const d = await launch(dataDir, wire, ONE.pass);
      await d.s.start();
      expect(count(d, "signed_out_residue_removed"), "the removal was named twice").toBe(0);
    });

    it("CONTROL — a signed-in mailbox keeps its outgoing row, and a row's server wins over the kept one", async () => {
      const { c, id1, id2, dataDir, wire } = await signedOutTwo();
      const [one] = await c.s.db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id1));
      await c.s.db.insert(mailboxCredentials).values({
        ...one!, transport: "smtp", meta: { host: "smtp.one.invalid", port: 587, secure: false, user: ONE.user },
      });
      /* Mailbox two: kept by a 0127 sign-out, then an outgoing row written after it. */
      await c.s.db.insert(mailboxCredentials).values({
        mailboxId: id2, transport: "smtp", secretEnc: one!.secretEnc, keyVersion: one!.keyVersion,
        meta: { host: "smtp.newer.invalid", port: 587, secure: false, user: TWO.user }, updatedAt: new Date(),
      });
      await c.s.stop();
      const d = await launch(dataDir, wire, ONE.pass);
      await d.s.start();
      expect((await rowsOf(d, id1)).map((r) => r.transport).sort()).toEqual(["imap", "smtp"]);
      expect(await rowsOf(d, id2)).toEqual([]);
      expect(await keptOf(d, id2)).toEqual({
        imap: { host: TWO.host, port: 993, secure: true, user: TWO.user },
        smtp: { host: "smtp.newer.invalid", port: 587, secure: false, user: TWO.user },
      });
    });

    it("the password alone is refused by name with what is known, and nothing dials", async () => {
      const { c, id2, wire } = await signedOutTwo(newWire(), { earlier: true });
      const from = wire.connects.length;
      const res = await press(c, id2, TWO.pass);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: unknown }).error).toMatchObject({
        code: "mailbox_server_unknown",
        details: { provider: "imap", login: TWO.user, outgoingHost: "smtp.two.invalid" },
      });
      expect(dialsOf(wire, TWO.user, from)).toEqual([]);
      expect(await rowsOf(c, id2)).toEqual([]);
      expect(count(c, "local_mailbox_server_unknown")).toBe(1);
    });

    it("…read from the leftover row itself where the start has not removed it yet", async () => {
      const { c, id2 } = await signedOutTwo();
      const [one] = await c.s.db.select().from(mailboxCredentials);
      await earlierSignOut(c, id2, leftoverSmtp({ ...one!, mailboxId: id2 }));
      const res = await press(c, id2, TWO.pass);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: unknown }).error).toMatchObject({
        code: "mailbox_server_unknown",
        details: { login: TWO.user, outgoingHost: "smtp.two.invalid" },
      });
    });

    it("the ask-once press signs it in: both transports stored, the mailbox launched", async () => {
      const { c, id2, wire } = await signedOutTwo(newWire(), { earlier: true });
      const from = wire.connects.length;
      const res = await c.s.handle(new Request(`http://local/local/mailboxes/${id2}`, {
        method: "PATCH", headers: auth(c),
        body: JSON.stringify({ imap: { host: TWO.host, port: 993, secure: true, user: TWO.user, pass: TWO.pass } }),
      }));
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      expect((await rowsOf(c, id2)).map((r) => r.transport).sort(), "the kept outgoing server was not restored")
        .toEqual(["imap", "smtp"]);
      expect((await rowsOf(c, id2)).find((r) => r.transport === "smtp")?.meta)
        .toMatchObject({ host: "smtp.two.invalid", user: TWO.user });
      expect(dialsOf(wire, TWO.user, from).map((d) => d.host)).toEqual([TWO.host, TWO.host]);
      await vi.waitFor(async () => {
        expect((await connection(c, id2)).reachable).toBe(true);
      }, { timeout: 5_000, interval: 25 });
    });
  });
});
