import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { formatClaim, isMalformed, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import { randomUUID } from "node:crypto";
import {
  accounts, changeLog, drafts, mailboxCredentials, mailboxes, messages, messageStates,
} from "@trafficflow/db";
import { ScheduleService } from "@trafficflow/services/mail";
import { HttpAdapter, OhmailEngine, draftsList, type EngineMessage } from "@ohmail/client-engine";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { openLocalDb } from "../src/db.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  TWO MAILBOXES, ONE INSTALL — two worlds, and what must never cross between them
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A standalone install used to serve exactly one mailbox, and nearly everything about it was
 * written in that shape: one connection, one lease claim, one poll timer, one submission server
 * taken from the process environment. Every one of those is a place where mailbox two can be
 * given mailbox one's answer, and the failures they produce are quiet — the send succeeds, the
 * sync runs, the row says what you expect, and the wrong server got somebody's password.
 *
 * So the rig is two worlds. Each mailbox has its OWN in-memory `ohmail/_meta` and its own
 * recording adapter, and the factory dispatches on the username the engine dialled with. That
 * dispatch is itself the first assertion: an engine that still resolved one server from the
 * process configuration would hand both mailboxes the same world and every test below would be
 * measuring one mailbox twice.
 *
 * ── WHY IN-PROCESS RATHER THAN A REAL SERVER ────────────────────────────────────────────────
 *
 * The claims, the folders and the flags are all observed at the adapter, which is where the
 * decisions actually leave this process. A real server would add a socket and take away the one
 * thing that matters here — being able to say which of two mailboxes a call was made against.
 * The live half of this (a desktop landing as a READER on a mailbox somebody else organizes) is
 * a different question and is walked against real accounts.
 *
 * ── MUTATION-WATCH (edit the source, watch, restore) ────────────────────────────────────────
 *
 *  · rebind the DELETE arm to `mailboxId === world.mailboxId` → "REMOVING #2" goes red with #2's
 *    mail still in the store and its claim still standing.
 *  · drop the `same_login` guard from the create handler → "THE SAME LOGIN TWICE" goes red with
 *    two live rows and two claims bearing one install id in one folder.
 *  · resolve the dial from `config.imap` instead of the credential row → the dispatch throws,
 *    because mailbox two would be dialled as mailbox one.
 *  · drop `mailboxIds` from the scheduled-send pass → the reader's appointment is claimed.
 */

/** One mailbox's `ohmail/_meta`, in memory. EMPTY at boot: nobody has ever organized it. */
class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> {
    return this.claims.map((c) => ({ ...c }));
  }
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) {
      if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    }
  }

  /** The uid generation, because `makeLeaseIo` always names one — see `lease-io-doubles.test.ts`. */
  uidValidity(): number | bigint | null { return 4_100; }
  /**
   * EVERY RECORD IN THE FOLDER BEARING THIS INSTALL ID, asked of the SERVER — what a RELEASE reads.
   *
   * Present because `makeLeaseIo` defines it, which makes it the only shape production has. A
   * double without it is not a smaller server, it is a different one: `releaseMailboxClaim`
   * answers "the records this install owns could not be enumerated" and throws, so the release
   * this file measures never happens and the claim it asserts gone is still standing. The
   * argument in full is beside the same method in `standalone-consent-and-removal.test.ts`.
   *
   * Matched on the HEADER, as the server matches it, and returned UNPARSED: these are CANDIDATES
   * and not claims, since a settings document in the same folder carries the same header.
   */
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims
      .filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`))
      .map((c) => ({ ...c }));
  }
  get count(): number { return this.claims.length; }
  /**
   * Another organizer arrives and is still checking in — the real way a mailbox is taken away.
   *
   * IT CARRIES A PRESS, and since 0.14.1 it has to. Kind stopped ranking, so a cloud claim that
   * merely ARRIVES loses to the incumbent — which is the correct answer to the folder it describes
   * and is not the scenario this fixture is for. A mailbox is taken from a live organizer exactly
   * one way: somebody pressed "Organize here" on the other door, and the gate wrote that instant
   * onto the claim. The press is stamped at SEED TIME so it is newer than the consent press this
   * install spent when it started organizing.
   */
  async seedForeignClaim(): Promise<void> {
    await this.appendClaim(formatClaim({
      authorizedAt: new Date(), capabilities: ["requests"],
      installId: "ohmail-cloud:production", kind: "cloud", displayName: "ohmail Cloud",
      heartbeat: new Date(), claimedAt: new Date("2026-09-01T09:00:00.000Z"), nonce: "held",
    }));
  }
  /** The install ids standing in this folder right now — the two-organizer question, answered. */
  installIds(): string[] {
    return this.claims
      // A MALFORMED record carries NO install id, and that is not a gap in the parse: it is
      // evidence that somebody claimed, which the election ranks and which produces `available`
      // rather than `organize`. What it is not is an install STANDING here, which is the question
      // this answers. `isMalformed` is the discriminant `ClaimRecord` carries — the union has no
      // tag field, and `parseClaim` returns either member. Runtime behaviour is unchanged: a
      // malformed record produced `undefined` here before and the filter below dropped it.
      .map((c) => {
        const rec = parseClaim(c.raw);
        return rec !== null && !isMalformed(rec) ? rec.installId : undefined;
      })
      .filter((v): v is string => typeof v === "string");
  }
}

const EMPTY_CURSOR = { folders: {} };

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

interface World {
  user: string;
  host: string;
  meta: MemoryMeta;
  deliver: number[];
  /** Every server-facing verb asked of THIS mailbox, so a call can be attributed to one of them. */
  wire: string[];
  /** The SMTP coordinates each send was constructed with — the cross-mailbox dial, observable. */
  dialledSmtp: Array<{ host: string; user: string }>;
  handed: boolean;
  /**
   * A PARK INSIDE THE SERVER CALL, so a pass can be held mid-flight while another door is pressed.
   * Awaited at the top of `changesSince`, which is where a real cycle spends its time; nothing
   * has been planned or committed yet when it settles, so the pass resumes into its ingest. Unset
   * for every case that does not race anything.
   */
  beforeChanges?: () => Promise<void>;
}

function makeWorld(user: string, host: string, deliver: number[]): World {
  return { user, host, meta: new MemoryMeta(), deliver, wire: [], dialledSmtp: [], handed: false };
}

/**
 * The factory both mailboxes are dialled through. It dispatches on the USERNAME the engine
 * resolved, and throws for one it does not know — which is what turns "the engine dialled the
 * wrong mailbox" from a silently passing test into a failure that names the address.
 */
function dispatcher(worlds: World[]) {
  /* THE THREE ACCESSORS THIS DOUBLE OFFERS BESIDE `MailboxAdapter`. None of them is on that
     interface — the real `ImapAdapter` has all three, and callers reach them by duck-typing —
     so each is named here with the shape the real one returns, or the annotation stops
     checking the part of the double the code under test actually uses. */
  return (cfg: ImapConfig): MailboxAdapter & {
    leaseIo(): LeaseIo;
    leasePeekIo(): LeasePeekIo;
    messageInSent(messageId: string): Promise<boolean>;
  } => {
    const user = cfg.auth.user;
    const w = worlds.find((x) => x.user === user);
    if (!w) {
      throw new Error(
        `this engine dialled ${JSON.stringify(user)}, which is no mailbox in this test — `
        + `every mailbox must dial from its own credential, not from the process configuration`,
      );
    }
    /* ONLY A SEND TRANSPORT, and the discriminator is structural rather than a flag: the send
       adapter is the only construction that binds SMTP AUTH, because it is the only one that will
       offer a password to a submission server. A sync adapter can carry submission coordinates it
       never uses — the seed on a first launch is handed the whole process configuration — and
       counting those as dials would make this assertion about the wrong thing. */
    if (cfg.smtp?.auth?.user) w.dialledSmtp.push({ host: cfg.smtp.host, user: cfg.smtp.auth.user });
    return {
      leaseIo: () => w.meta,
      leasePeekIo: () => ({ listClaims: () => w.meta.listClaims() }),
      async connect(): Promise<void> {},
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        return {
          move: true, uidplus: true, condstore: true, qresync: false,
          idle: true, specialUse: true, sentFolder: null,
        };
      },
      async ensureFolders(): Promise<void> { w.wire.push("ensureFolders"); },
      async changesSince(): Promise<ChangeBatch> {
        if (w.beforeChanges) await w.beforeChanges();
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
      async move(locator: NativeLocator, toFolder: string): Promise<NativeLocator> {
        w.wire.push(`move:${toFolder}`);
        return { folder: toFolder, ref: "7:41" };
      },
      async setFlags(locator: NativeLocator, flags: { seen?: boolean }): Promise<void> {
        w.wire.push(`setFlags:${String(flags.seen)}`);
      },
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(): Promise<() => Promise<void>> { return async () => {}; },
      /* THE SEND, RECORDED RATHER THAN REFUSED. What is under test is WHICH SERVER a send was
         constructed against, and against a server that accepts every login that is the only way to
         tell a correct send from one that went out through the other mailbox's submission host
         with this mailbox's password. `dialledSmtp` above captures the coordinates at
         construction; this makes the send itself succeed so the path is actually walked. */
      async send(m: OutboundMessage): Promise<SendResult> {
        w.wire.push("send");
        return {
          providerMessageId: `<sent-${w.wire.length}@${w.user}>`,
          sentLocator: { folder: "Sent", ref: `9:${w.wire.length}` } as NativeLocator,
          raw: Buffer.from(`Message-ID: <sent@${w.user}>\r\nSubject: ${m.subject ?? ""}\r\n\r\nbody`, "utf8"),
        } as unknown as SendResult;
      },
      async messageInSent(): Promise<boolean> { return false; },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
    };
  };
}

const HOUR = 60 * 60 * 1000;
const SEED_USER = "one@example.test";
const SECOND_USER = "two@example.test";
const HOST_A = "imap-a.invalid";
const HOST_B = "imap-b.invalid";

describe("one install, two mailboxes", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  async function boot(
    worlds: World[], reuseDataDir?: string,
    /** Every line this launch writes, for the cases whose subject IS the boot's own record. */
    onLog?: (event: string, detail: Record<string, unknown>) => void,
  ): Promise<{ s: Sidecar; dataDir: string }> {
    const dataDir = reuseDataDir ?? await freshDataDir("ohmail-multi-");
    const seed = worlds[0]!;
    const s = await createSidecar({
      dataDir,
      imap: {
        host: seed.host, port: 993, secure: true,
        auth: { user: seed.user, pass: "not-dialled-password-password" },
        smtp: { host: "smtp-a.invalid", port: 587, secure: false },
      },
      address: seed.user,
      machineName: "this machine",
      // Long enough that no timer fires on its own: every pass is one a test asked for.
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      keks: { 1: Buffer.alloc(32, 7) },
      adapterFactory: dispatcher(worlds),
      log: (event, detail) => { onLog?.(event, (detail ?? {}) as Record<string, unknown>); },
    });
    cleanups.push(async () => {
      await s.stop().catch(() => undefined);
      if (!reuseDataDir) rmSync(dataDir, { recursive: true, force: true });
    });
    await s.start();
    return { s, dataDir };
  }

  /** {@link boot} with the submission server named explicitly — the interrupted change of host. */
  async function bootWithSmtp(worlds: World[], dataDir: string, smtpHost: string): Promise<{ s: Sidecar }> {
    const seed = worlds[0]!;
    const s = await createSidecar({
      dataDir,
      imap: {
        host: seed.host, port: 993, secure: true,
        auth: { user: seed.user, pass: "not-dialled-password-password" },
        smtp: { host: smtpHost, port: 587, secure: false },
      },
      address: seed.user,
      machineName: "this machine",
      pollIntervalMs: 60 * HOUR,
      leaseStaleAfterMs: 60_000,
      keks: { 1: Buffer.alloc(32, 7) },
      adapterFactory: dispatcher(worlds),
      log: () => {},
    });
    cleanups.push(async () => { await s.stop().catch(() => undefined); });
    await s.start();
    return { s };
  }

  const auth = (s: Sidecar): HeadersInit => ({
    authorization: `Bearer ${s.sessionToken}`,
    "content-type": "application/json",
  });

  /** Add a mailbox through the door the Settings pane presses. */
  const add = async (s: Sidecar, body: unknown): Promise<Response> =>
    s.handle(new Request("http://local/local/mailboxes", {
      method: "POST", headers: auth(s), body: JSON.stringify(body),
    }));

  const remove = async (s: Sidecar, id: string): Promise<Response> =>
    s.handle(new Request(`http://local/local/mailboxes/${id}`, { method: "DELETE", headers: auth(s) }));

  const agree = async (s: Sidecar, id: string): Promise<Response> =>
    s.handle(new Request(`http://local/local/mailboxes/${id}/organize`, {
      method: "POST", headers: auth(s), body: JSON.stringify({ screening: { dormancyDays: 365 } }),
    }));

  const liveRows = async (s: Sidecar) =>
    (await s.db.select().from(mailboxes)).filter((r) => r.status !== "disabled");

  const countFor = async (s: Sidecar, mailboxId: string): Promise<number> =>
    (await s.db.select({ id: messages.id }).from(messages)
      .where(eq(messages.mailboxId, mailboxId))).length;

  /** An appointment on one mailbox, already due. The row is written directly, as the scheduled-send
   *  suites do: what is under test is the PASS, not the compose surface. */
  async function scheduleOn(s: Sidecar, mailboxId: string, subject: string): Promise<string> {
    const [d] = await s.db.insert(drafts).values({
      accountId: s.world.accountId, mailboxId, subject,
      body: "the words",
      to: [{ name: null, address: "you@example.test" }],
      status: "draft",
    }).returning();
    /* Scheduled through the SERVICE, so the appointment carries the key the pass claims under —
       the crash-safety hinge — rather than a key this test invented. Then dated into the past, so
       the next drain finds it due without anybody waiting. */
    const ctx = {
      db: s.db as never, accountId: s.world.accountId, userId: null,
      now: () => new Date(), requestId: "test",
    };
    await new ScheduleService().schedule(ctx, d!.id, new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString());
    await s.db.update(drafts).set({ sendAt: new Date(Date.now() - 60_000) }).where(eq(drafts.id, d!.id));
    return d!.id;
  }

  /** An appointment written straight onto the row — a survivor of a close that did not reach it.
   *  The schedule SERVICE refuses a reader in as many words, correctly, so this state cannot be
   *  reached through it and must be written to be tested. */
  async function survivorOn(s: Sidecar, mailboxId: string, subject: string): Promise<string> {
    const [d] = await s.db.insert(drafts).values({
      accountId: s.world.accountId, mailboxId, subject,
      body: "the words",
      to: [{ name: null, address: "you@example.test" }],
      status: "scheduled",
      sendAt: new Date(Date.now() - 60_000),
      sendKey: randomUUID(),
    }).returning();
    return d!.id;
  }

  const secondBody = (user = SECOND_USER, host = HOST_B) => ({
    provider: "imap", address: user,
    imap: { host, port: 993, secure: true, user, pass: "second-password" },
    smtp: { host: "smtp-b.invalid", port: 587, secure: false },
  });

  /* ── ADDING #2 ──────────────────────────────────────────────────────────────────────────── */

  it("ADDS a second mailbox, dials it as ITSELF, and runs it beside the first", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11, 12]);
    const b = makeWorld(SECOND_USER, HOST_B, [21]);
    const { s } = await boot([a, b]);

    const res = await add(s, secondBody());
    expect(res.status).toBe(201);
    const dto = (await res.json()) as { id: string; address: string };
    expect(dto.address).toBe(SECOND_USER);

    // Two live rows, and the roster runs both.
    expect((await liveRows(s)).map((r) => r.address).sort()).toEqual([SEED_USER, SECOND_USER].sort());
    expect(Object.keys(s.organizerStates()).sort()).toEqual([s.world.mailboxId, dto.id].sort());

    /* THE DISPATCH IS THE ASSERTION. `dispatcher` throws for an unknown username, so mailbox two
       reaching mailbox one's world would have failed the add outright. Draining it proves the
       connection is its own rather than merely that a row exists. */
    expect(await s.syncMailbox(dto.id)).toBeGreaterThan(0);
    expect(await countFor(s, dto.id), "mailbox two mirrored nothing of its own").toBe(1);
  });

  it("REFUSES the same login under a different address — 409, and no row is left behind", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21]);
    const { s } = await boot([a, b]);
    expect((await add(s, secondBody())).status).toBe(201);
    const liveBefore = (await liveRows(s)).length;

    /* THE SAME PHYSICAL MAILBOX UNDER ANOTHER ADDRESS — an alias, a plus-tag, the bare login.
       The address index cannot see it; only the pair the probe proved can. */
    const res = await add(s, {
      provider: "imap", address: "alias@example.test",
      imap: { host: HOST_B, port: 993, secure: true, user: SECOND_USER, pass: "second-password" },
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("same_login");

    /* AND NOTHING WAS ADDED. A refusal that left a row would be a refusal that added a mailbox —
       and the row it left would be the second claim in one folder that the guard exists to stop. */
    expect((await liveRows(s)).length, "the refused mailbox was left in the store").toBe(liveBefore);
    expect(b.meta.installIds().length, "a second claim was written into one mailbox").toBeLessThan(2);
  });

  /* ── THE CLAIMS ─────────────────────────────────────────────────────────────────────────── */

  it("writes ONE claim per mailbox, both under the SAME install identity", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21]);
    const { s } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };

    // Agreeing is the becoming, on each mailbox separately — consent is per row.
    expect((await agree(s, s.world.mailboxId)).status).toBe(200);
    expect((await agree(s, dto.id)).status).toBe(200);
    await s.syncUntilQuiet();

    /* EXACTLY ONE CLAIM IN EACH FOLDER. Two would be the clone defence's own trigger: a second
       claim bearing this install's id reads as a copy of this install running, and the two would
       stand each other down in turn until nobody organized the mailbox. */
    expect(a.meta.count, "mailbox one holds more than one claim").toBe(1);
    expect(b.meta.count, "mailbox two holds more than one claim").toBe(1);

    /* AND BOTH SAY THE SAME INSTALL. One install, N claims — an id derived per mailbox would make
       this install look like several, and its own second mailbox would read the first one's claim
       as a stranger's. */
    const ids = [...a.meta.installIds(), ...b.meta.installIds()];
    expect(new Set(ids).size, "the two mailboxes were claimed under different identities").toBe(1);
    expect(ids[0]).toBe(s.world.accountId);

    // …and each mailbox got its OWN folder tree, in its own world.
    expect(a.wire).toContain("ensureFolders");
    expect(b.wire).toContain("ensureFolders");
  });

  /* ── LEAVE ANYTIME, PER MAILBOX ─────────────────────────────────────────────────────────── */

  it("REMOVING #2 releases only its claim and takes only its mail", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11, 12, 13]);
    const b = makeWorld(SECOND_USER, HOST_B, [21, 22]);
    const { s } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };
    await agree(s, s.world.mailboxId);
    await agree(s, dto.id);
    await s.syncUntilQuiet();

    const seedMailBefore = await countFor(s, s.world.mailboxId);
    expect(seedMailBefore).toBe(3);
    expect(await countFor(s, dto.id)).toBe(2);
    expect(a.meta.count).toBe(1);

    expect((await remove(s, dto.id)).status).toBe(200);

    /* #2 IS GONE, ENTIRELY. Its claim released rather than left to age out — a claim nobody holds
       stands the next install down for a whole staleness window — and its mail off this disk,
       because re-adding the address mints a NEW row and both copies would then be served. */
    expect(b.meta.count, "mailbox two's claim was left standing in its mailbox").toBe(0);
    expect(await countFor(s, dto.id), "mailbox two's mail stayed on this machine").toBe(0);
    expect(s.organizerStates()[dto.id], "mailbox two is still on the roster").toBeUndefined();

    /* #1 IS UNTOUCHED — the whole point of leave-anytime being per mailbox. */
    expect(await countFor(s, s.world.mailboxId), "removing one mailbox took another's mail")
      .toBe(seedMailBefore);
    expect(a.meta.count, "removing one mailbox released another's claim").toBe(1);
    expect(a.meta.installIds()[0]).toBe(s.world.accountId);
    expect(s.organizerStates()[s.world.mailboxId]?.organizing).toBe(true);

    // …and the first mailbox still syncs afterwards: the store is the install's, not the row's.
    await expect(s.syncMailbox(s.world.mailboxId)).resolves.toBeGreaterThanOrEqual(0);
  });

  /**
   * REMOVING A MAILBOX WHILE ITS PASS IS STILL READING MAIL.
   *
   * The row above removes a QUIET mailbox. This one removes a busy one: a pass is parked inside
   * the server call with an arrival it has not planned yet, and the person presses Remove. The
   * removal's three acts — tombstone, wipe, stop — used to run straight past the pass, and the
   * pass then committed its messages and their `change_log` creations into a mailbox that had
   * already been removed and emptied. Mail left behind on the machine, and the window told about
   * it AFTER the receipt that said the mailbox was gone.
   */
  it("REMOVING #2 MID-PASS leaves no mail behind and emits nothing after the receipt", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21]);
    const lines: string[] = [];
    const { s } = await boot([a, b], undefined, (event) => { lines.push(event); });
    const dto = (await (await add(s, secondBody())).json()) as { id: string };
    await agree(s, s.world.mailboxId);
    await agree(s, dto.id);
    await s.syncUntilQuiet();
    expect(await countFor(s, dto.id), "the precondition: #2 holds its first message").toBe(1);
    const seedMailBefore = await countFor(s, s.world.mailboxId);

    /* TWO MORE ARRIVALS, and the pass carrying them held at the server call. The gate disarms
       itself, so the drain's later cycles come back empty and the pass ends on its own. */
    let entered!: () => void;
    const atTheDoor = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    b.handed = false;
    b.deliver = [22, 23];
    b.beforeChanges = async () => { b.beforeChanges = undefined; entered(); await held; };
    const pass = s.syncMailbox(dto.id);
    await atTheDoor;

    const removal = remove(s, dto.id);
    /* THE PARK IS RELEASED ON WHICHEVER ORDERING HAPPENS, so nothing here waits on a sleep.
       Either the removal got ahead of the pass — the row goes `disabled` while the pass is still
       parked, which is the defect — or it is waiting for it (`local_mailbox_pass_awaited`). Which
       one is asserted below; releasing on both is what lets the wrong one be MEASURED instead of
       deadlocking the case that is supposed to fail. */
    const tombstoned = async (): Promise<boolean> => (await s.db
      .select({ status: mailboxes.status }).from(mailboxes)
      .where(eq(mailboxes.id, dto.id)))[0]?.status === "disabled";
    let ordering: "removal-went-first" | "removal-waited" | null = null;
    for (let i = 0; i < 200 && ordering === null; i++) {
      if (lines.includes("local_mailbox_pass_awaited")) ordering = "removal-waited";
      else if (await tombstoned()) ordering = "removal-went-first";
      else await new Promise((r) => { setTimeout(r, 25); });
    }
    release();
    const res = await removal;
    await pass;
    /* THE MECHANISM ITSELF: the removal waited. `null` means neither ordering was observed inside
       the bound, which would make everything below vacuous, and `removal-went-first` is the
       defect — the row tombstoned and the mail deleted while the pass was still holding mail. */
    expect(ordering, "the removal did not wait for the pass that was in flight")
      .toBe("removal-waited");

    expect(res.status).toBe(200);

    /* BOTH HALVES OF THE DEFECT IN ONE READING, because they are one event and a run that stops
       on the first says nothing about the second. LEFT is the mail still on this machine; the
       receipt is `recordMailboxRemoved`'s own `mailbox`/`delete` row — the one the window cascades
       on — so EMITTED is mail arriving on screen in a mailbox the person has already been told is
       gone. The parked pass's messages are either committed before the wipe and taken by it, or
       refused; they are never written after it. */
    const log = await s.db.select().from(changeLog)
      .where(eq(changeLog.accountId, s.world.accountId));
    const receipt = log.find((r) => r.entityType === "mailbox" && r.op === "delete"
      && r.entityId === dto.id);
    const receiptSeq = receipt?.seq ?? null;
    expect({
      left: await countFor(s, dto.id),
      receiptWritten: receiptSeq !== null,
      emittedAfterReceipt: receiptSeq === null ? null : log
        .filter((r) => r.entityType === "message" && r.op === "create" && r.seq > receiptSeq).length,
    }, "the removed mailbox kept mail, lost its receipt, or had an arrival emitted after it")
      .toEqual({ left: 0, receiptWritten: true, emittedAfterReceipt: 0 });

    // AND #1 IS UNTOUCHED, as on every other removal row.
    expect(await countFor(s, s.world.mailboxId), "removing one mailbox took another's mail")
      .toBe(seedMailBefore);
    expect(a.meta.count, "removing one mailbox released another's claim").toBe(1);
  });

  it("a REFUSED removal takes the mailbox back off hold", async () => {
    /* The removal holds the mailbox before it asks the service to remove it, so the refusal path
       has to take the hold off again — otherwise a mailbox the person still has keeps no poll
       timer and goes on reporting itself reachable, which is worse than the removal failing.
       The refusal is forced through the service's OWN row check: for one request the row is not
       this account's, which is the one thing `MailboxService.delete` refuses before it writes. */
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21, 22]);
    const { s } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };
    await agree(s, dto.id);
    /* THE REFUSAL IS FORCED BEFORE THE FIRST PASS, while the mailbox still holds no message.
       Nine tables key on (mailbox_id, account_id) since 0118, so a mailbox cannot be lent to
       another account while its mail sits under it — and no product path re-parents a mailbox
       across accounts, so this fixture was the only site that ever did. Lending it empty asks
       the same question of the same row: `MailboxService.delete` reads the row by (id, account)
       and refuses before it writes anything. */
    const stranger = randomUUID();
    await s.db.insert(accounts).values({ id: stranger, name: "somebody else" });
    await s.db.update(mailboxes).set({ accountId: stranger }).where(eq(mailboxes.id, dto.id));
    expect((await remove(s, dto.id)).status, "the service did not refuse — the case measures nothing")
      .toBe(404);
    await s.db.update(mailboxes).set({ accountId: s.world.accountId })
      .where(eq(mailboxes.id, dto.id));
    /* A pass that ran while the row was lent hands its mail to nobody and marks the world handed,
       so the world is given its hand back before the mailbox is asked to read for the first time. */
    b.handed = false;

    await s.syncUntilQuiet();
    expect(await countFor(s, dto.id)).toBe(2);

    /* AND IT STILL POLLS. A held runtime returns 0 cycles without touching the connection, so a
       drain that runs at all is the reading; the new message is what makes it a drain that did
       something rather than one that came back empty. */
    b.handed = false;
    b.deliver = [23];
    expect(await s.syncMailbox(dto.id), "the refused removal left the mailbox stopped")
      .toBeGreaterThan(0);
    expect(await countFor(s, dto.id), "the mailbox is on the roster but no longer reading mail")
      .toBe(3);
    expect(b.meta.count, "a refused removal released the claim anyway").toBe(1);
  });

  /** THE POSITIVE CONTROL for the row above: a removal with no pass in flight waits for nothing
   *  and is the removal it always was — the wait must not become a cost every removal pays. */
  it("REMOVING #2 with nothing in flight waits for no pass", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21, 22]);
    const lines: string[] = [];
    const { s } = await boot([a, b], undefined, (event) => { lines.push(event); });
    const dto = (await (await add(s, secondBody())).json()) as { id: string };
    await agree(s, dto.id);
    await s.syncUntilQuiet();
    expect(await countFor(s, dto.id)).toBe(2);

    expect((await remove(s, dto.id)).status).toBe(200);
    expect(lines.includes("local_mailbox_pass_awaited"),
      "a removal with nothing in flight reported waiting for a pass").toBe(false);
    expect(await countFor(s, dto.id)).toBe(0);
    expect(b.meta.count).toBe(0);
  });

  /** The window's own client, composed as `createLocalEngine()` composes it, over the bridge. */
  function clientEngine(s: Sidecar): OhmailEngine {
    return new OhmailEngine({
      adapter: new HttpAdapter({
        baseUrl: "http://sidecar",
        fetch: ((input: string | URL | Request, init?: RequestInit) => {
          const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          return s.handle(new Request(new URL(href, "http://sidecar"), init));
        }) as unknown as typeof fetch,
        headers: () => ({ authorization: `Bearer ${s.sessionToken}` }),
      }),
      eagerBodies: true,
    });
  }

  it("REMOVING #2 TAKES IT OUT OF THE WINDOW'S MIRROR — rows, bodies and the count", async () => {
    /*
     * THE ROW ABOVE IS ABOUT THE DATABASE; THIS ONE IS ABOUT THE SCREEN. The window runs its own
     * mirror (`packages/client-engine`) and learns what the store holds only through the change
     * log it drains, so a removal that deletes rows without emitting anything leaves the window
     * rendering a mailbox that is gone — messages, cached bodies and the received count.
     */
    const a = makeWorld(SEED_USER, HOST_A, [11, 12, 13]);
    const b = makeWorld(SECOND_USER, HOST_B, [21, 22]);
    const { s } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };
    await agree(s, s.world.mailboxId);
    await agree(s, dto.id);
    await s.syncUntilQuiet();

    const engine = clientEngine(s);
    await engine.start();

    const rowsOf = (mailboxId: string): EngineMessage[] => engine.read()
      .list<EngineMessage>("message").filter((m) => m.mailboxId === mailboxId);
    const bodiesOf = (mailboxId: string): number => rowsOf(mailboxId)
      .filter((m) => engine.read().get("message_body", m.id) !== undefined).length;
    const draftsOf = (mailboxId: string): number => engine.read()
      .list<{ mailboxId: string }>("draft").filter((d) => d.mailboxId === mailboxId).length;

    /* A DRAFT ON EACH, through the window's own verb. Drafts are mailbox-keyed, but unsent words
       are on no server, so the removal keeps them: the one on the removed mailbox
       must still be in the window afterwards, and the one on the mailbox that stays is untouched. */
    for (const id of [dto.id, s.world.mailboxId]) {
      await engine.mutate({
        kind: "draft_save", draftId: null, mailboxId: id, subject: "later",
        body: "the words", to: [{ name: null, address: "you@example.test" }], cc: [], bcc: [],
      });
    }
    await engine.syncOnce();

    expect(rowsOf(dto.id).length, "the precondition: the window holds #2's mail").toBe(2);
    expect(draftsOf(dto.id), "the precondition: the window holds #2's draft").toBe(1);
    /* The bodies are cached the way a reader caches them — by OPENING the messages. The eager
       pass would do it too; this makes the precondition deterministic rather than timed. */
    for (const m of [...rowsOf(dto.id), ...rowsOf(s.world.mailboxId)]) await engine.hydrateBody(m.id);
    await engine.eagerBodiesIdle();
    expect(bodiesOf(dto.id), "the precondition: the window cached #2's bodies").toBe(2);
    const keptRows = rowsOf(s.world.mailboxId).length;
    const keptBodies = bodiesOf(s.world.mailboxId);
    const threadsOf = (mailboxId: string): string[] =>
      [...new Set(rowsOf(mailboxId).map((m) => m.threadId).filter((t): t is string => t !== null))].sort();
    const goneThreads = threadsOf(dto.id);
    const keptThreads = threadsOf(s.world.mailboxId);
    expect(goneThreads.length, "the precondition: #2's mail sits in conversations").toBeGreaterThan(0);
    const countBefore = engine.receivedMessages();

    expect((await remove(s, dto.id)).status).toBe(200);
    await engine.syncOnce();

    /* THE WINDOW NO LONGER HOLDS IT. Not "is told to refresh": the mirror itself is the thing the
       surfaces read, so the removal is complete only once nothing keyed by that mailbox is in it. */
    expect(rowsOf(dto.id).map((m) => m.subject),
      "the window still renders the removed mailbox's messages").toEqual([]);
    expect(bodiesOf(dto.id),
      "the removed mailbox's message text is still cached in the window").toBe(0);
    /* THE UNSENT DRAFT STAYS — in the window's mirror, with its words, and in the Drafts list. */
    expect(draftsOf(dto.id), "the removed mailbox's unsent draft left the window").toBe(1);
    /* The draft was written on the wall clock a moment ago; list Drafts at that same moment. */
    const listedAt = new Date();
    const kept = draftsList(engine.read(), listedAt).filter((d) => d.mailboxId === dto.id);
    expect(kept.map((d) => d.body), "the kept draft is not in Drafts with its words").toEqual(["the words"]);
    expect(engine.receivedMessages(),
      "the received count still counts the removed mailbox's mail").toBe(countBefore - 2);

    /* AND #1 IS UNTOUCHED — the same per-mailbox promise, one layer up. */
    expect(rowsOf(s.world.mailboxId).length, "removing one mailbox emptied another's window")
      .toBe(keptRows);
    expect(bodiesOf(s.world.mailboxId), "removing one mailbox shed another's bodies")
      .toBe(keptBodies);
    expect(draftsOf(s.world.mailboxId), "removing one mailbox discarded another's draft").toBe(1);
    /* #2'S CONVERSATIONS GO TOO: the store deletes a thread no other mailbox is in, and the
       removal writes a `thread` delete for each, so the window drops its subject and participants.
       #1's conversations stay. */
    const live = new Set(engine.read().list<{ id: string }>("thread").map((t) => t.id));
    expect(goneThreads.filter((t) => live.has(t)),
      "the window still holds the removed mailbox's conversations").toEqual([]);
    expect(keptThreads.filter((t) => !live.has(t)),
      "removing one mailbox took another's conversations").toEqual([]);
  });

  it("a kept draft of a removed mailbox, saved the way the paired phone saves it, keeps its new words", async () => {
    /*
     * The paired phone saves an opened draft naming the row's own mailbox. Every mailboxId used
     * to count as a move, so the removed mailbox's refusal rolled the save back and the words
     * typed on the phone went nowhere. A save naming the row's own mailbox is no move; a move TO
     * the removed mailbox is still refused.
     */
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21]);
    const { s } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };
    await agree(s, s.world.mailboxId);
    await agree(s, dto.id);
    await s.syncUntilQuiet();

    const phone = clientEngine(s);
    await phone.start();
    const to = [{ name: null, address: "you@example.test" }];
    const make = async (mailboxId: string) => (await phone.mutate({
      kind: "draft_save", draftId: null, mailboxId, subject: "plan", body: "the words", to, cc: [], bcc: [],
    })).entityId!;
    const onB = await make(dto.id);
    const onA = await make(s.world.mailboxId);
    await phone.syncOnce();

    expect((await remove(s, dto.id)).status).toBe(200);
    await phone.syncOnce();
    expect(phone.read().get<{ mailboxId: string }>("draft", onB)?.mailboxId,
      "the precondition: the phone still holds the kept draft on the removed mailbox").toBe(dto.id);

    const saved = await phone.mutate({
      kind: "draft_save", draftId: onB, mailboxId: dto.id, subject: "plan",
      body: "the words, and more typed on the phone", to, cc: [], bcc: [],
    });
    expect(saved.status, `the phone's save was refused: ${saved.error?.message ?? ""}`).toBe("confirmed");
    const [row] = await s.db.select({ body: drafts.body, mailboxId: drafts.mailboxId })
      .from(drafts).where(eq(drafts.id, onB));
    expect(row).toEqual({ body: "the words, and more typed on the phone", mailboxId: dto.id });
    await phone.syncOnce();
    expect(phone.read().get<{ body: string }>("draft", onB)?.body).toBe("the words, and more typed on the phone");

    /* A MOVE onto the removed mailbox is still refused, and writes nothing. */
    const moved = await phone.mutate({
      kind: "draft_save", draftId: onA, mailboxId: dto.id, subject: "plan", body: "moved", to, cc: [], bcc: [],
    });
    expect(moved.status).toBe("rolled_back");
    expect(moved.error?.code).toBe("validation_failed");
    const [stays] = await s.db.select({ body: drafts.body, mailboxId: drafts.mailboxId })
      .from(drafts).where(eq(drafts.id, onA));
    expect(stays).toEqual({ body: "the words", mailboxId: s.world.mailboxId });
  });

  it("re-adding a removed mailbox leaves ONE copy of its mail, not two", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21, 22]);
    const { s } = await boot([a, b]);
    const first = (await (await add(s, secondBody())).json()) as { id: string };
    await s.syncMailbox(first.id);
    expect(await countFor(s, first.id)).toBe(2);

    expect((await remove(s, first.id)).status).toBe(200);

    // The same address again. A tombstone is correctly not reused, so this is a NEW row — which is
    // exactly the state that served every message twice before the removal took the mail with it.
    b.handed = false;
    const again = (await (await add(s, secondBody())).json()) as { id: string };
    expect(again.id).not.toBe(first.id);
    await s.syncMailbox(again.id);

    const total = (await s.db.select({ id: messages.id }).from(messages)).length;
    expect(await countFor(s, again.id)).toBe(2);
    expect(total, "the store serves two copies of the re-added mailbox's mail").toBe(1 + 2);
  });

  /* ── THE CREDENTIALS ────────────────────────────────────────────────────────────────────── */

  it("gives the second mailbox its OWN credential rows — never the seed's server", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21]);
    const { s } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };

    const creds = await s.db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, dto.id));
    const imap = creds.find((c) => c.transport === "imap");
    const smtp = creds.find((c) => c.transport === "smtp");

    /* THE INCOMING ROW records the server the probe PROVED, and it is mailbox two's. Reading the
       process configuration here would put mailbox one's host on mailbox two's credential, after
       which every launch dials the wrong server with the right password. */
    expect((imap!.meta as { host?: string }).host).toBe(HOST_B);
    expect((imap!.meta as { user?: string }).user).toBe(SECOND_USER);

    /* AND THE OUTGOING ROW EXISTS AND IS ITS OWN. This is the whole of the send defect: without a
       per-mailbox smtp row the shared adapter falls back to the imap host — which is at least the
       right mailbox — but a process-wide submission server would be mailbox ONE's. */
    expect(smtp, "mailbox two has no submission credential of its own").toBeDefined();
    expect((smtp!.meta as { host?: string }).host).toBe("smtp-b.invalid");

    // The seed's rows are untouched by the add.
    const seedCreds = await s.db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, s.world.mailboxId));
    expect((seedCreds.find((c) => c.transport === "imap")!.meta as { host?: string }).host)
      .toBe(HOST_A);
  });

  /* ── THE FIRST LAUNCH, WHICH IS THE ONE THE REPAIRS HAVE TO REACH ──────────────────────── */

  it("a FIRST launch seals the seed's password AND gives it a submission row, in that launch", async () => {
    /* THE ORDERING DEFECT THIS EXISTS FOR, and it is the kind that ships because every later
       launch looks right. The seed's INCOMING credential does not exist when the engine starts on
       a fresh install — it is sealed during the attach, out of the password the process was handed
       — so a submission-row repair placed BEFORE the attach finds no row to copy from and writes
       nothing. The install then cannot send for its entire first session and silently acquires the
       ability on its second launch, which is the shape of fault that gets reported as "it started
       working on its own".

       Asserted on the FIRST boot specifically. A test that only checked a relaunch would have
       passed against the defect. */
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const { s } = await boot([a]);

    const creds = await s.db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, s.world.mailboxId));
    const imap = creds.find((c) => c.transport === "imap");
    const smtp = creds.find((c) => c.transport === "smtp");

    expect(imap, "the password in this launch's own configuration was never sealed").toBeDefined();
    expect(smtp, "a fresh install got no submission credential on the launch that created it")
      .toBeDefined();
    expect((smtp!.meta as { host?: string }).host).toBe("smtp-a.invalid");

    /* THE SECRET IS THE SAME CIPHERTEXT UNDER THE SAME KEY — copied, never decrypted. One mailbox,
       one password; re-encrypting would put the plaintext in this process for nothing, and would
       fail outright on an install whose key can no longer open its own row, turning a state that
       must stay recoverable by re-entering the password into one that breaks a boot. */
    expect(smtp!.secretEnc).toBe(imap!.secretEnc);
    expect(smtp!.keyVersion).toBe(imap!.keyVersion);

    /* AND THE INCOMING ROW RECORDS THE SERVER IT WAS PROVED AGAINST, so the next launch dials from
       the row rather than from the environment. */
    expect((imap!.meta as { host?: string }).host).toBe(HOST_A);
  });

  /* ── EACH MAILBOX'S OWN MEMORY ──────────────────────────────────────────────────────────── */

  it("the SEED's stand-down does not demote the other mailbox", async () => {
    /* Every runtime was built from the SEED's row — `world.standDownReason` and
       `world.takeoverAuthorizedAt` — which was the same statement while an install held one
       mailbox. With several, a stand-down on ONE row is handed to every runtime: the second
       mailbox comes up believing it was demoted, never organizes the mailbox it actually holds,
       and never keeps its own appointments. Nothing errors and the row for that mailbox goes on
       saying `organizer`, so the two halves disagree — the shape this area keeps producing.

       Driven across a RELAUNCH, because the row is what carries the memory from one process to the
       next, and demoting the SEED specifically, because that is the direction the defect travels:
       from the row every runtime was reading to the rows it had no business speaking for.

       `loadLocalRoster` already reads both fields per row, and `identity.ts` says why in as many
       words. They were computed and dropped. */
    const a = makeWorld(SEED_USER, HOST_A, []);
    const b = makeWorld(SECOND_USER, HOST_B, []);
    const { s, dataDir } = await boot([a, b]);
    const secondId = ((await (await add(s, secondBody())).json()) as { id: string }).id;
    await agree(s, s.world.mailboxId);
    await agree(s, secondId);
    await s.syncUntilQuiet();
    expect(s.organizerStates()[s.world.mailboxId]?.organizing).toBe(true);
    expect(s.organizerStates()[secondId]?.organizing).toBe(true);

    /* THE SEED ALONE IS TAKEN AWAY — a foreign claim in ITS folder and nothing in the second
       mailbox's. The demotion is recorded on the seed's row and on no other. */
    await a.meta.seedForeignClaim();
    await s.syncMailbox(s.world.mailboxId);
    expect(s.organizerStates()[s.world.mailboxId]?.organizing, "the seed did not stand down")
      .toBe(false);
    await s.stop();

    /* THE RELAUNCH IS THE TEST. The second mailbox must come up organizing its own mailbox: its
       row was never demoted, its claim is still standing in its own folder, and nothing about the
       seed's misfortune is a fact about it. */
    const a2 = makeWorld(SEED_USER, HOST_A, []);
    const b2 = makeWorld(SECOND_USER, HOST_B, []);
    a2.meta = a.meta;
    b2.meta = b.meta;
    const { s: s2 } = await boot([a2, b2], dataDir);

    expect(s2.organizerStates()[s2.world.mailboxId]?.organizing, "the seed came back organizing")
      .toBe(false);
    expect(s2.organizerStates()[secondId]?.organizing,
      "the second mailbox inherited the seed's stand-down and stopped organizing its own mailbox")
      .toBe(true);

    /* AND IT IS STILL THE CLAIM HOLDER — the assertion that makes the one above mean something,
       because a runtime that believed it had been demoted would have released nothing but would
       also have renewed nothing, and its mailbox would drift out of its own hands. */
    await s2.syncMailbox(secondId);
    expect(b2.meta.installIds(), "the second mailbox stopped holding its own claim")
      .toEqual([s2.world.accountId]);
  });

  /* ── WHAT THE BOOT SAYS ABOUT A MAILBOX IT HOLDS AND DOES NOT RUN ──────────────────────── */

  /**
   * THE BOOT NAMED WHAT IT ATTACHED AND NOTHING IT LEFT OUT.
   *
   * `local_roster_attached` reports a COUNT. `loadLocalRoster` leaves out every `disabled` row —
   * a mailbox somebody removed here, and any a later build pauses — so a row this install HOLDS
   * and does not RUN had no line at all: no skip line, no row state, nothing.
   *
   * ── THE SEED CLAUSE THIS CASE WAS WRITTEN WITH IS RETIRED, AND THAT IS THE FIX ───────────
   *
   * It read *"even when that is the seed"*, and it was true: `ensureLocalWorld`'s lookup is WIDER
   * than the roster's, so a ≤0.13.x PAUSED row (`disabled` WITH an `organized_elsewhere:*`
   * reason) was found, left off the roster, and could be `world.mailboxId` — the id the launch's
   * `serving` line prints. The boot then said `serving <id>` for the one mailbox with no runtime.
   * `endLegacyOrganizerPauses` ends that state before the roster is read, so the paused seed now
   * HAS a runtime and the second case below is that, measured. What is left out today is a
   * TOMBSTONE, which `ensureLocalWorld` excludes from its own lookup and which therefore can never
   * be the seed — so `serving <id>` names a running mailbox again, which is what the incident this
   * line came from could not tell.
   *
   * Both cases watched red, each restored: remove the `loadUnattachedLocalRoster` loop from the
   * attach block and the first goes red with the count line unchanged and no line naming the
   * removed row; remove the `endLegacyOrganizerPauses` call and the second goes red with the
   * paused seed unattached — the state this case used to assert.
   */
  it("the boot NAMES the mailbox it holds and does not run", async () => {
    const a = makeWorld(SEED_USER, HOST_A, []);
    const b = makeWorld(SECOND_USER, HOST_B, []);
    const { s, dataDir } = await boot([a, b]);
    const secondId = ((await (await add(s, secondBody())).json()) as { id: string }).id;
    const seedId = s.world.mailboxId;
    // The person takes the second mailbox off this machine. `DELETE` leaves a tombstone:
    // `disabled`, reason NULL — the row the CURRENT build leaves out, and the only one it does.
    expect((await remove(s, secondId)).status).toBe(200);
    await s.stop();

    const a2 = makeWorld(SEED_USER, HOST_A, []);
    const b2 = makeWorld(SECOND_USER, HOST_B, []);
    a2.meta = a.meta;
    b2.meta = b.meta;
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const { s: s2 } = await boot([a2, b2], dataDir, (event, detail) => { lines.push({ event, detail }); });

    // The seed is a row with a runtime, so the id every later line correlates on names a mailbox
    // this install is actually running.
    expect(s2.world.mailboxId, "the seed moved off the row this install runs").toBe(seedId);
    expect(Object.keys(s2.organizerStates())).toEqual([seedId]);

    const attached = lines.filter((l) => l.event === "local_roster_attached");
    expect(attached.map((l) => l.detail.count), "the count is what it always was").toEqual([1]);
    const named = lines.filter((l) => l.event === "local_mailbox_not_attached");
    expect(named.map((l) => ({ id: l.detail.mailboxId, why: l.detail.disabledReason })),
      "the boot said nothing about the mailbox it holds and does not run")
      .toEqual([{ id: secondId, why: null }]);
  });

  it("…and a PAUSED seed is not a left-out row any more: the boot ends the pause and says so", async () => {
    const a = makeWorld(SEED_USER, HOST_A, []);
    const b = makeWorld(SECOND_USER, HOST_B, []);
    const { s, dataDir } = await boot([a, b]);
    const secondId = ((await (await add(s, secondBody())).json()) as { id: string }).id;
    const seedId = s.world.mailboxId;
    await s.stop();

    /* THE PAUSED SEED, in the shape a stand-down under a build older than mail 0083 leaves — and
       the shape the schema still admits (`disabled` with an `organized_elsewhere:*` reason). The
       role is left alone: that write named none, so a mailbox this install organized keeps
       `organizer` and only a row 0083's backfill had already promoted says `reader`. */
    const opened = await openLocalDb(dataDir, {});
    await opened.db.update(mailboxes)
      .set({ status: "disabled", disabledReason: "organized_elsewhere:cloud" })
      .where(eq(mailboxes.id, seedId));
    await opened.close();

    const a2 = makeWorld(SEED_USER, HOST_A, []);
    const b2 = makeWorld(SECOND_USER, HOST_B, []);
    a2.meta = a.meta;
    b2.meta = b.meta;
    const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const { s: s2 } = await boot([a2, b2], dataDir, (event, detail) => { lines.push({ event, detail }); });

    // BOTH mailboxes run, and the seed is one of them — the state that made `serving <id>` a lie.
    expect(s2.world.mailboxId).toBe(seedId);
    expect(Object.keys(s2.organizerStates()).sort()).toEqual([seedId, secondId].sort());
    expect(lines.filter((l) => l.event === "local_roster_attached").map((l) => l.detail.count))
      .toEqual([2]);
    // The row is named ONCE, by the line that says what was done to it, and not by the other one.
    expect(lines.filter((l) => l.event === "local_mailbox_pause_ended")
      .map((l) => ({ id: l.detail.mailboxId, why: l.detail.disabledReason })))
      .toEqual([{ id: seedId, why: "organized_elsewhere:cloud" }]);
    expect(lines.filter((l) => l.event === "local_mailbox_not_attached"),
      "a row the boot rewrote was also reported as left out")
      .toEqual([]);
    /* A READER. Becoming the organizer again needs the press, and this launch does not have one.
       `organized_by_kind` is NOT asserted here and the omission is deliberate: `boot` calls
       `start()`, so one cycle has run by the time this reads the row, and a reader's peek writes
       the four holder columns NULL when the folder holds no foreign claim — the decay
       `reader-no-auto-resume.test.ts` documents. That the rewrite WRITES the kind is measured
       where the row can be read before any cycle: `local-roster.test.ts` (the roster's own
       stand-down memory) and `reader-no-auto-resume.test.ts` (the column, at the boot). */
    const [row] = await s2.db.select().from(mailboxes).where(eq(mailboxes.id, seedId));
    expect(row!.status).toBe("connected");
    expect(row!.organizerRole).toBe("reader");
    expect(row!.disabledReason).toBeNull();
  });

  it("…and says nothing extra on an install that runs everything it holds", async () => {
    // The positive control: one line per left-out row means ZERO lines on the ordinary install,
    // which is the rule every pass in this engine follows.
    const a = makeWorld(SEED_USER, HOST_A, []);
    const b = makeWorld(SECOND_USER, HOST_B, []);
    const { s, dataDir } = await boot([a, b]);
    await (await add(s, secondBody())).json();
    await s.stop();
    const a2 = makeWorld(SEED_USER, HOST_A, []);
    const b2 = makeWorld(SECOND_USER, HOST_B, []);
    a2.meta = a.meta;
    b2.meta = b.meta;
    const lines: string[] = [];
    await boot([a2, b2], dataDir, (event) => { lines.push(event); });
    expect(lines.filter((e) => e === "local_mailbox_not_attached")).toEqual([]);
    expect(lines.filter((e) => e === "local_roster_attached")).toHaveLength(1);
  });

  /* ── THE UPGRADE'S SUBMISSION ROW, AND WHOSE SERVER IT NAMES ───────────────────────────── */

  it("the upgrade's submission row honours the credential's OWN witness, not the current settings", async () => {
    /* The repair that gives an upgraded install a submission credential took its host from the
       process configuration, and that is wrong in the one direction that matters. The credential
       already records the submission server it was SAVED FOR — the person who typed the password
       typed both servers into the same form — and that record is an authorization. Taking the
       current setting instead lets an install acquire a submission server nobody saved the
       password for, just by being relaunched with a different one: the same defect the send path's
       outgoing refusal used to catch, walked back in through the upgrade.

       Watched red by restoring the old predicate: the row is written for the process's host and
       the assertion below prints it. */
    const a = makeWorld(SEED_USER, HOST_A, []);
    const { s, dataDir } = await boot([a]);

    // The seal recorded the pair this install was launched with.
    const seedId = s.world.mailboxId;
    const before = await s.db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, seedId));
    expect((before.find((c) => c.transport === "imap")!.meta as { smtpHost?: string }).smtpHost)
      .toBe("smtp-a.invalid");

    // Drop the submission row, as an install that predates it has none…
    await s.db.delete(mailboxCredentials).where(and(
      eq(mailboxCredentials.mailboxId, seedId),
      eq(mailboxCredentials.transport, "smtp"),
    ));
    await s.stop();

    // …and relaunch with the settings naming a DIFFERENT submission server.
    const a2 = makeWorld(SEED_USER, HOST_A, []);
    const { s: s2 } = await bootWithSmtp([a2], dataDir, "smtp-elsewhere.invalid");
    const after = await s2.db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, seedId));
    /* NO ROW AT ALL, and that is the conservative answer rather than a missing feature. The
       witness records a HOSTNAME and nothing else — the door writes it as a flat string so that a
       merge cannot erase a stored port — so a witness that disagrees with the configuration has no
       port to pair with. Writing the witness host with the CONFIGURED port would build the row out
       of two different servers, and an install whose password was saved for an implicit-TLS server
       on 465 and now configured for 587 would get a permanent row saying so. Writing the
       CONFIGURED host is the defect this guard is named for. So: nothing is written, sending is
       refused, and entering the password again records the pair the person actually wants — which
       is exactly what the send path's outgoing refusal used to do. */
    expect(after.find((c) => c.transport === "smtp"),
      "the upgrade adopted a submission server the password was never saved for")
      .toBeUndefined();
    await s2.stop();

    /* AND THE AGREEING CASE STILL GETS ITS ROW — otherwise this guard would be satisfied by an
       upgrade that never writes one, which is the failure it is supposed to be the opposite of. */
    const a3 = makeWorld(SEED_USER, HOST_A, []);
    const { s: s3 } = await bootWithSmtp([a3], dataDir, "smtp-a.invalid");
    const settled = (await s3.db.select().from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, seedId))).find((c) => c.transport === "smtp");
    expect(settled, "an upgrade whose settings AGREE with the saved pair wrote no row").toBeDefined();
    expect((settled!.meta as { host?: string }).host).toBe("smtp-a.invalid");
  });

  /* ── THE SEND, AND WHOSE SERVER IT LEAVES BY ───────────────────────────────────────────── */

  it("a scheduled send from #2 leaves by #2's OWN submission server, never the seed's", async () => {
    /* THE DEFECT THIS IS THE WHOLE GUARD FOR. The engine used to build its send transport from the
       process configuration — one outgoing host for the install — because a local install had no
       stored submission row to read. With two mailboxes that is not a smaller version of the right
       answer, it is the wrong one: a reply composed in mailbox two goes out through mailbox ONE's
       submission server, authenticated with mailbox two's password. The send succeeds, the copy
       lands in Sent, and the only trace is in the receiving server's headers.

       Observed at the DIAL rather than at the row, because the row being right is not the claim —
       `makeSendAdapter` reading it is. */
    const a = makeWorld(SEED_USER, HOST_A, []);
    const b = makeWorld(SECOND_USER, HOST_B, []);
    const { s } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };
    await agree(s, dto.id);
    await s.syncMailbox(dto.id);

    await scheduleOn(s, dto.id, "a reply from the second mailbox");
    await s.syncMailbox(dto.id);

    expect(b.wire, "the second mailbox never sent").toContain("send");
    expect(b.dialledSmtp.map((d) => d.host), "the second mailbox dialled the wrong submission server")
      .toEqual(["smtp-b.invalid"]);
    expect(b.dialledSmtp[0]!.user).toBe(SECOND_USER);
    /* AND THE SEED'S TRANSPORT WAS NEVER OPENED AT ALL — not merely "opened with the right host".
       A send that touched mailbox one's server would be this failure whatever it authenticated
       with. */
    expect(a.dialledSmtp, "the seed's submission server was dialled for another mailbox's send")
      .toEqual([]);
    expect(a.wire).not.toContain("send");
  });

  it("a READER mailbox's appointment is never claimed by ANY drain", async () => {
    /* The scheduled-send pass scans the whole store, so an ORGANIZING mailbox's drain would claim
       and deliver a READER mailbox's appointment unless the pass is told which mailboxes it may
       claim for. Its own were closed when it was demoted, but that close is explicitly best-effort,
       so a survivor is not hypothetical — and delivering one is mail leaving from an install the
       mailbox's real organizer knows nothing about, at a time nobody re-chose. */
    const a = makeWorld(SEED_USER, HOST_A, []);
    const b = makeWorld(SECOND_USER, HOST_B, []);
    const { s } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };

    /* THE SEQUENCE THAT PRODUCES A SURVIVOR, which is the only way this row can exist: the
       appointment is made while #2 ORGANIZES — a reader may not schedule one, and the schedule
       service refuses it in as many words — and #2 is demoted afterwards. The close a demotion
       runs is explicitly best-effort and its own log line says a failure leaves the row saying it
       will send, so the survivor is the documented outcome of a failed close rather than an
       invented state. */
    await agree(s, s.world.mailboxId);
    await agree(s, dto.id);
    await s.syncUntilQuiet();

    /* …and now #2 loses the mailbox: another organizer's claim lands in ITS folder, and the next
       gate run stands this install down from that mailbox alone. Driven through the LEASE and not
       by writing the role column, because the role column is not what the runtime reads — a test
       that flipped it would demote the row and leave the runtime believing it still organizes,
       which proves nothing about the pass. */
    await b.meta.seedForeignClaim();
    await s.syncMailbox(dto.id);
    expect(s.organizerStates()[dto.id]?.organizing, "the second mailbox did not stand down")
      .toBe(false);
    expect(s.organizerStates()[s.world.mailboxId]?.organizing, "the seed lost its role too")
      .toBe(true);

    /* THE SURVIVOR IS PLANTED AFTER THE DEMOTION, ON PURPOSE. A stand-down CLOSES the appointments
       it can no longer keep, and here that close runs and succeeds — which is the healthy path and
       is asserted by its own suite. What this test is about is the case the close does not reach:
       it is explicitly best-effort, its failure line says the row still says it will send, and the
       launch catch-up only revisits an install that is STILL stood down. Writing the row directly
       is how that state is reached without breaking the close on purpose. */
    const readerDraft = await survivorOn(s, dto.id, "an appointment the close did not reach");
    const ownDraft = await scheduleOn(s, s.world.mailboxId, "the organizer's own");

    /* ONLY THE ORGANIZER'S DRAIN. This is the exact composition the filter exists for: a mailbox
       that organizes, running a pass whose scan reaches the whole store, beside a mailbox this
       install now only reads. */
    await s.syncMailbox(s.world.mailboxId);

    const statusOf = async (id: string): Promise<string> => {
      const [row] = await s.db.select().from(drafts).where(eq(drafts.id, id));
      return row!.status;
    };
    /* THE ORGANIZER'S OWN STILL SENDS — which is why this is a filter and not a gate. Withholding
       every appointment because one unrelated mailbox was taken over would be a second fault. */
    expect(await statusOf(ownDraft), "the organizing mailbox's own appointment was withheld")
      .toBe("sent");
    /* AND THE READER'S IS UNTOUCHED — not failed, not cancelled. It still says it will send,
       because the mailbox may yet be organized again and closing it here would be this install
       deciding something about a mailbox it does not hold. */
    expect(await statusOf(readerDraft), "a reader mailbox's appointment was claimed and sent")
      .toBe("scheduled");
    expect(b.wire, "the reader mailbox sent mail").not.toContain("send");
  });

  it("a READER mailbox's due resurface is never flipped by the organizing mailbox's drain", async () => {
    /* The resurfacing pass scans the whole store like the scheduled-send pass above, and it was
       scoped by ACCOUNT while the gate that runs it is per MAILBOX: the organizing mailbox's drain
       flipped the handed-over mailbox's due rows too, and mail came back on this device in
       parallel with the organizer that actually holds it — the state that mailbox's owner will
       itself flip at the hour they chose. */
    const a = makeWorld(SEED_USER, HOST_A, []);
    const b = makeWorld(SECOND_USER, HOST_B, []);
    const { s } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };
    await agree(s, s.world.mailboxId);
    await agree(s, dto.id);
    await s.syncUntilQuiet();

    /* #2 loses its mailbox to another organizer, through the LEASE rather than the role column —
       the case above gives the reason: the column is not what the runtime reads. */
    await b.meta.seedForeignClaim();
    await s.syncMailbox(dto.id);
    expect(s.organizerStates()[dto.id]?.organizing, "the second mailbox did not stand down")
      .toBe(false);
    expect(s.organizerStates()[s.world.mailboxId]?.organizing, "the seed lost its role too")
      .toBe(true);

    /** A message in one mailbox, put away until an hour that has already passed. */
    const bookDue = async (mailboxId: string, subject: string): Promise<string> => {
      const dedup = `mid:${subject}@resurface.test`;
      const [m] = await s.db.insert(messages).values({
        accountId: s.world.accountId, mailboxId, messageIdHeader: dedup,
        bodyHash: `hash-${subject}`, dedupKey: dedup, subject,
        fromAddress: "someone@elsewhere.test",
        nativeLocator: { folder: "INBOX", ref: `1:${subject.length}` },
      }).returning();
      const [st] = await s.db.insert(messageStates).values({
        accountId: s.world.accountId, messageId: m!.id, state: "bubbled_up",
        bubbleUpAt: new Date(Date.now() - 60 * 60 * 1000),
      }).returning();
      return st!.id;
    };
    /** The whole row as text: the claim is that nothing about it moved, `updatedAt` included. */
    const rowText = async (stateId: string): Promise<string> => {
      const [row] = await s.db.select().from(messageStates).where(eq(messageStates.id, stateId));
      return JSON.stringify(row, (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v));
    };

    // PLANTED AFTER THE DEMOTION, so the only pass that can have moved either is the drain below.
    const readerRow = await bookDue(dto.id, "the handed-over mailbox's own");
    const ownRow = await bookDue(s.world.mailboxId, "the organizer's own");
    const readerBefore = await rowText(readerRow);

    // ONLY THE ORGANIZER'S DRAIN — one mailbox this install holds, running a pass whose scan
    // reaches the whole store, beside a mailbox it now only reads.
    await s.syncMailbox(s.world.mailboxId);

    const stateOf = async (stateId: string): Promise<string> => {
      const [row] = await s.db.select().from(messageStates).where(eq(messageStates.id, stateId));
      return row!.state;
    };
    /* THE ORGANIZER'S OWN CAME BACK — which is why this is a scope and not a gate: withholding
       every due row because one unrelated mailbox changed hands would be a second fault. */
    expect(await stateOf(ownRow), "the organizing mailbox's own booking was withheld")
      .toBe("resurfaced");
    /* AND THE HANDED-OVER ONE IS UNTOUCHED — not flipped, not restamped. It is still due, and the
       install that holds that mailbox will bring it back at the hour it was given. */
    expect(await rowText(readerRow),
      "a mailbox this install had handed over was resurfaced by the other one's drain")
      .toBe(readerBefore);
  });

  /* ── THE SEED, AND WHAT SURVIVES A RELAUNCH ─────────────────────────────────────────────── */

  it("REMOVING THE SEED while #2 remains does not resurrect it on the next launch", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21]);
    const { s, dataDir } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };
    const seedId = s.world.mailboxId;

    expect((await remove(s, seedId)).status).toBe(200);
    await s.stop();

    /* THE RELAUNCH IS THE TEST. The configuration still names the seed address — removing one
       mailbox of two is not a sign-out, so nothing cleared it — and the old rule would read that
       as "make sure a row exists for this address" and mint a password-less one. */
    const a2 = makeWorld(SEED_USER, HOST_A, []);
    const b2 = makeWorld(SECOND_USER, HOST_B, []);
    b2.meta = b.meta;
    const { s: s2 } = await boot([a2, b2], dataDir);

    const live = await liveRows(s2);
    expect(live.map((r) => r.address), "the removed seed came back").toEqual([SECOND_USER]);
    expect(live[0]!.id).toBe(dto.id);

    /* AND THE SHELL'S SINGLE-MAILBOX SURFACES FALL THROUGH TO THE SURVIVOR rather than reporting
       an install with nothing in it. */
    expect(s2.world.mailboxId).toBe(dto.id);
    expect(Object.keys(s2.organizerStates())).toEqual([dto.id]);
  });

  it("a relaunch attaches every mailbox and writes no new rows — the third launch is a no-op", async () => {
    const a = makeWorld(SEED_USER, HOST_A, [11]);
    const b = makeWorld(SECOND_USER, HOST_B, [21]);
    const { s, dataDir } = await boot([a, b]);
    const dto = (await (await add(s, secondBody())).json()) as { id: string };
    const rowsBefore = (await s.db.select().from(mailboxes)).length;
    const credsBefore = (await s.db.select().from(mailboxCredentials)).length;
    await s.stop();

    const { s: s2 } = await boot([makeWorld(SEED_USER, HOST_A, []), makeWorld(SECOND_USER, HOST_B, [])], dataDir);
    expect(Object.keys(s2.organizerStates()).sort()).toEqual([s.world.mailboxId, dto.id].sort());
    /* IDEMPOTENT. The boot's three writes are each keyed on a predicate that is false once done,
       so a second launch adds no row and no credential — which is the whole claim an in-place
       upgrade makes. */
    expect((await s2.db.select().from(mailboxes)).length).toBe(rowsBefore);
    expect((await s2.db.select().from(mailboxCredentials)).length).toBe(credsBefore);
  });
});
