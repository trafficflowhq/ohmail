/**
 * THE GAP TRAVELS ACROSS INSTALLS (RULING-026 lane A), on both device stores. Two engines, two
 * stores and ONE in-memory `ohmail/_meta`, and nothing else shared: the install that hands back
 * leaves where the gap began in its settings document, and the install that organizes next opens its
 * window there, from its own look. Nothing moves until File; Leave moves nothing; a key-less
 * document is today's behaviour; a stopped claim and a tenure the device never saw both bound the
 * window; an open import question withholds by name. A turn the device slept through is bounded
 * however it ends (RULING-026 lane A, as amended): a hand-back, a quit and a phone leaving
 * the foreground leave the instant they let go; a crash or a closed lid leaves its claim's last stamp.
 * The phone's engine over SQLite first, then the desktop's over PGlite (the default project).
 */
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { mailboxes, rules } from "@trafficflow/db";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  type OrganizerProfileDoc, type ProfileGap, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { requestOrganizerTakeover } from "../src/organize-here.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";

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

/** `phone-stop-then-start.test.ts`'s statement runner: one serial writer, as a device has. */
function nodeExecutor(): PhoneSqlExecutor & { direct: (sql: string, params?: unknown[]) => unknown[] } {
  const raw = new sqlite.DatabaseSync(":memory:");
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
        const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
        const rows = columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => { await yielded(); raw.prepare(sql).run(...(params as unknown[])); });
    },
    async batch(statements): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) raw.prepare(sql).run(...(params as unknown[]));
          raw.exec("COMMIT");
        } catch (err) {
          try { raw.exec("ROLLBACK"); } catch { /* keep the first error */ }
          throw err;
        }
      });
    },
    async close(): Promise<void> { try { raw.close(); } catch { /* already closed */ } },
    direct: (sql, params = []) => raw.prepare(sql).all(...params),
  };
}

/** One `ohmail/_meta` for every install: claims and settings documents in one folder. */
class MemoryMetaFolder implements LeaseIo, ProfileIo {
  private nextUid = 1;
  readonly claims: RawClaimMessage[] = [];
  readonly profiles: Array<{ ref: number; raw: string }> = [];
  /** Every settings document ever appended, by writer. */
  readonly profileAppendsBy: string[] = [];
  /** An install whose settings writes this server refuses from now on, as an APPEND the server answers NO. */
  refuseProfilesBy: string | null = null;
  /** The folder's writes in order: a settings append by its writer, and each claim removal. */
  readonly trace: string[] = [];
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    return this.profiles.map((p) => ({ ref: p.ref, raw: p.raw, generation: 4_100 }));
  }
  async appendProfile(raw: string): Promise<void> {
    const by = /X-Ohmail-Install-Id: (.+)/.exec(raw)?.[1]?.trim() ?? "";
    if (this.refuseProfilesBy !== null && by === this.refuseProfilesBy) throw new Error("APPEND refused by the test server");
    this.profileAppendsBy.push(by);
    this.trace.push(`settings:${by}`);
    this.profiles.push({ ref: this.nextUid++, raw });
  }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.profiles.length - 1; i >= 0; i--) if (gone.has(this.profiles[i]!.ref)) this.profiles.splice(i, 1);
  }
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    if (this.claims.some((c) => gone.has(c.ref))) this.trace.push("claim removed");
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
  /** The newest settings document, by the parser. */
  newest(): { doc: OrganizerProfileDoc; installId: string | null } {
    const docs = this.profiles.flatMap((p) => {
      const r = parseProfileMessage(p.raw);
      return r === null || isMalformedProfile(r) || r.doc === undefined ? [] : [{ doc: r.doc, installId: r.installId }];
    });
    return docs.sort((a, b) => Date.parse(a.doc.updatedAt) - Date.parse(b.doc.updatedAt)).at(-1)!;
  }
  /** Another install publishing: its own document replaces every other, as its first write would. */
  replaceProfiles(doc: OrganizerProfileDoc, installId: string): void {
    this.profiles.splice(0);
    this.profiles.push({ ref: this.nextUid++, raw: formatProfileMessage(doc, { installId }) });
  }
}

let uid = 70;
function letter(internalDate: Date): ChangeBatch["creates"][number] {
  uid += 1;
  const raw = Buffer.from([
    "From: Letters <letters@news.test>", "To: a@b.test", `Subject: letter ${uid}`,
    `Message-ID: <travels-${uid}@news.test>`, "Date: Sun, 11 Oct 2026 04:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8", "", "this week's letter", "",
  ].join("\r\n"));
  return { type: "create", locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator, raw, internalDate, seen: false };
}

interface Server {
  pending: Array<ChangeBatch["creates"][number]>;
  moves: Array<{ from: string; to: string }>;
  ring: (() => void) | null;
  factory: (cfg: ImapConfig) => MailboxAdapter;
}

function mailServer(meta: MemoryMetaFolder): Server {
  const s: Server = {
    pending: [], moves: [], ring: null,
    factory: (_cfg: ImapConfig) => ({
      leaseIo: () => meta,
      leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
      profileIo: () => meta,
      async connect(): Promise<void> {},
      async close(): Promise<void> {},
      async capabilities(): Promise<ImapCapabilities> {
        return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
      },
      async ensureFolders(): Promise<void> {},
      async changesSince(): Promise<ChangeBatch> {
        return { creates: s.pending.splice(0), moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
      },
      async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
        s.moves.push({ from: locator.folder, to });
        return { ...locator, folder: to };
      },
      async setFlags(): Promise<void> {},
      async scanSentRecipients(): Promise<string[]> { return []; },
      async watch(onChange: () => void): Promise<() => Promise<void>> {
        s.ring = onChange;
        return async () => { if (s.ring === onChange) s.ring = null; };
      },
      async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("no send"); },
      async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart"); },
    }) as MailboxAdapter,
  };
  return s;
}

const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";
const open: PhoneEngine[] = [];
afterEach(async () => { while (open.length > 0) await open.pop()!.stop().catch(() => undefined); });

const RULE_MADE = Date.now() - 7 * 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
interface Gap { since: number | null; letters: number | null; pressed: number | null }

/**
 * One install over the shared folder. `rule`: a News rule older than any letter, as the other
 * install's settings carry it. `sealed`: a key ring and a refused port, so a profile import is
 * handed to the organizer's own connection. The clock can be moved forward (a phone asleep).
 */
async function install(meta: MemoryMetaFolder, installId: string, o: { rule?: boolean; sealed?: boolean } = {}) {
  const exec = nodeExecutor();
  const server = mailServer(meta);
  const clock = { skewMs: 0 };
  const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const engine = await startPhoneEngine({
    exec,
    imap: o.sealed
      ? { host: "127.0.0.1", port: 1, secure: false, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } }
      : { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
    machineName: `ohmail ${installId}`, installId, adapterFactory: server.factory,
    log: (event: string, detail: Record<string, unknown>) => { lines.push({ event, detail }); },
    now: () => new Date(Date.now() + clock.skewMs),
    ...(o.sealed ? { keks: { 1: "c".repeat(64) } } : {}),
  } as Parameters<typeof startPhoneEngine>[0]);
  open.push(engine);
  const id = Object.keys(engine.runtimes().organizer)[0]!;
  if (!o.sealed) {
    exec.direct(`insert or replace into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
      values (?, 'imap', 'not-a-secret', 1)`, [id]);
  }
  if (o.rule !== false) {
    exec.direct(`insert into rules (account_id, kind, match, destination, provenance, enabled, created_at, updated_at)
      values ((select account_id from mailboxes where id = ?), 'sender', 'letters@news.test', 'ohmail/News', 'manual', 1, ?, ?)`,
    [id, RULE_MADE, RULE_MADE]);
  }
  exec.direct(`update mailboxes set status = 'connected' where id = ?`, [id]);
  const gap = (): Gap => (exec.direct(`select gap_since as since, gap_letters as letters, gap_pressed_at as pressed
    from mailboxes where id = ?`, [id]) as Gap[])[0]!;
  /* THE ORDINARY DRAIN, rung by the doorbell: a forced one is not the quiet drain that licenses the pass. */
  const until = async (done: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 80; i++) {
      if (done()) return true;
      server.ring?.();
      await sleep(50);
    }
    return done();
  };
  const route = (path: string, body: unknown) => engine.handle(new Request(`http://engine.invalid${path}`, {
    method: "POST", headers: { authorization: `Bearer ${engine.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return {
    exec, server, engine, id, gap, until, route, clock, lines,
    /** Organize here, then ordinary drains until the window is counted or closed. */
    organizeHere: async () => {
      expect(await engine.claimHere({ by: "press" })).toBe("claimed");
      await until(() => gap().letters !== null || gap().since === null);
    },
    /** This install starts organizing on its own consent, and its tenure closes the boot window. */
    organizing: async () => {
      exec.direct(`update mailboxes set organizer_role = 'organizer', organize_consented_at = 1 where id = ?`, [id]);
      await engine.resume();
      await until(() => gap().since === null);
      await engine.resume();
    },
  };
}

/** A claim another install left, taken at `claimedAt`, renewed last at `heartbeat`. */
function claimOf(installId: string, heartbeat: Date, claimedAt: Date = heartbeat): string {
  return formatClaim({
    installId, kind: "local", displayName: `ohmail ${installId}`, heartbeat, claimedAt,
    nonce: `${installId}-1`, authorizedAt: null, capabilities: ["profile"],
  });
}

/** Another install's first publish: the newest settings under its own id, no key. */
function publishAs(meta: MemoryMetaFolder, installId: string, at: Date): void {
  const { gap: _g, ...settings } = meta.newest().doc;
  meta.replaceProfiles(makeProfileDoc(settings, { updatedAt: at, producer: { kind: "local", version: "dev" } }), installId);
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(process.env.OHMAIL_EXPECT_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("the gap travels across installs, two stores and one _meta", () => {
  /** A organizes and hands back; a letter arrives after A's press, before B's first look. */
  async function handBack(o: { keyless?: boolean } = {}) {
    const meta = new MemoryMetaFolder();
    const a = await install(meta, "install-a");
    await a.organizing();
    expect(meta.claims.length, "premise: A holds the mailbox").toBe(1);
    expect(meta.profiles.length, "premise: A published its settings").toBe(1);
    const b = await install(meta, "install-b");
    await b.engine.resume();
    expect(b.engine.runtimes().organizer[b.id]?.organizing, "premise: B reads beside A").toBe(false);
    const appendsBeforeStop = meta.profileAppendsBy.length;
    await expect(a.engine.stopOrganizing()).resolves.toBe("released");
    const pressedAt = (a.exec.direct("select organizer_released_at as at from mailboxes where id = ?", [a.id]) as { at: number }[])[0]!.at;
    expect(meta.claims, "premise: A's claim left").toEqual([]);
    if (o.keyless) {
      // An older A: the same settings, no key.
      const { gap: _g, ...doc } = meta.newest().doc;
      meta.replaceProfiles(doc as OrganizerProfileDoc, "install-a");
    }
    await sleep(30);
    b.server.pending.push(letter(new Date()));
    await sleep(30);
    await b.engine.resume();
    const [taken] = b.exec.direct("select f.last_set_by as by, f.desired_folder as desired from folder_state f") as Array<{ by: string; desired: string }>;
    expect(taken, "premise: B took the letter in").toEqual({ by: "peer", desired: "INBOX" });
    return { meta, a, b, pressedAt, appendsBeforeStop };
  }

  it("(a) B opens its window at A's press: the letter is offered, and File files it once", async () => {
    const { meta, b, appendsBeforeStop } = await handBack();
    const left = meta.newest();
    expect(left.installId).toBe("install-a");
    expect(meta.profileAppendsBy.slice(appendsBeforeStop), "the release wrote no settings").toEqual(["install-a"]);
    expect(left.doc.gap?.by).toBe("install-a");
    expect(b.gap().since, "B's window did not open at A's press").toBe(Date.parse(left.doc.gap!.since));
    // B is a reader: it wrote nothing into the folder.
    expect(meta.profileAppendsBy.filter((w) => w === "install-b")).toEqual([]);
    await b.organizeHere();
    expect(b.server.moves, "mail moved without the press").toEqual([]);
    expect(b.gap(), "the letter the hand-back let through was not offered").toMatchObject({ letters: 1, pressed: null });
    const filed = await b.route(`/mailboxes/${b.id}/gap-letters`, { file: true, count: 1 });
    expect(filed.status, await filed.clone().text()).toBe(202);
    for (let i = 0; i < 100 && b.server.moves.length === 0; i++) await sleep(50);
    expect(b.server.moves).toEqual([{ from: "INBOX", to: "ohmail/News" }]);
    for (let i = 0; i < 3; i++) await b.engine.resume();
    expect(b.server.moves, "the letter was filed more than once").toHaveLength(1);
    expect(b.gap()).toEqual({ since: null, letters: null, pressed: null });
    // B's first publish as organizer leaves the key out.
    await b.until(() => meta.newest().installId === "install-b");
    expect(meta.newest().doc.gap, "the key was carried into B's tenure").toBeUndefined();
  }, 60_000);

  it("(a) Leave closes the offer and nothing moves", async () => {
    const { b } = await handBack();
    await b.organizeHere();
    expect(b.gap().letters, "premise: the letter was offered").toBe(1);
    const left = await b.route(`/mailboxes/${b.id}/gap-letters`, { file: false });
    expect(left.status, await left.clone().text()).toBe(200);
    for (let i = 0; i < 3; i++) await b.engine.resume();
    expect(b.server.moves, "Leave moved mail").toEqual([]);
    expect(b.gap()).toEqual({ since: null, letters: null, pressed: null });
  }, 60_000);

  it("(a) CONTROL: a document without the key is today's behaviour, the window opens at B's look", async () => {
    const { b } = await handBack({ keyless: true });
    await b.organizeHere();
    expect(b.gap(), "a key-less document reached back").toEqual({ since: null, letters: null, pressed: null });
    expect(b.server.moves).toEqual([]);
  }, 60_000);

  it("(b) a stopped organizer: the window opens at its last stamp, not at B's look", async () => {
    const meta = new MemoryMetaFolder();
    const heartbeat = new Date(Date.now() - 15 * 60_000);
    await meta.appendClaim(claimOf("install-gone", heartbeat));
    const b = await install(meta, "install-b");
    b.server.pending.push(letter(new Date(Date.now() - 5 * 60_000)));
    await b.engine.resume();
    expect(b.gap().since, "the window did not open at the stopped claim's stamp").toBe(heartbeat.getTime());
    await b.organizeHere();
    expect(b.gap(), "a letter after the organizer stopped was not offered").toMatchObject({ letters: 1, pressed: null });
    expect(b.server.moves).toEqual([]);
  }, 60_000);

  it("(c) a hand-back, then another install organizes and stops unseen: its last stamp bounds the window, not the key", async () => {
    const meta = new MemoryMetaFolder();
    const a = await install(meta, "install-a");
    await a.organizing();
    const b = await install(meta, "install-b");
    await b.engine.resume();
    expect(b.gap().since, "premise: B saw A hold the mailbox").toBeNull();
    await expect(a.engine.stopOrganizing()).resolves.toBe("released");
    const key = meta.newest().doc.gap!;
    expect(key.by, "premise: A left its gap").toBe("install-a");
    // Before B looks again, C takes the mailbox, keeps a letter in the inbox, and stops without a release.
    b.server.pending.push(letter(new Date(Date.parse(key.since) + 5)));
    await sleep(30);
    const heartbeat = new Date();
    await meta.appendClaim(claimOf("install-c", heartbeat));
    await sleep(30);
    b.server.pending.push(letter(new Date()));
    // B's next look is past every window: C's claim reads stopped.
    b.clock.skewMs = 15 * 60_000;
    await b.engine.resume();
    expect(b.gap().since, "the key beat a stopped claim").toBe(heartbeat.getTime());
    await b.organizeHere();
    expect(b.gap(), "a letter of C's tenure was counted").toMatchObject({ letters: 1, pressed: null });
    expect(b.server.moves).toEqual([]);
  }, 60_000);

  it("(d) a tenure the device never saw: the window opens at that tenure's release, and only the later letter is offered", async () => {
    const meta = new MemoryMetaFolder();
    const b = await install(meta, "install-b");
    await b.organizing();
    await expect(b.engine.stopOrganizing()).resolves.toBe("released");
    const own = b.gap().since;
    expect(own, "premise: B's own hand-back opened its window").not.toBeNull();
    await b.engine.resume();
    expect(b.gap().since, "premise: B's own key keeps its open window").toBe(own);

    // B sleeps. X organizes; a letter arrives in X's tenure and X keeps it in the inbox.
    await sleep(20);
    const xFrom = new Date();
    await meta.appendClaim(claimOf("install-x", xFrom));
    b.server.pending.push(letter(new Date()));
    await sleep(20);
    // X hands back, leaving where its gap began; its settings are B's.
    const xs = new Date();
    await sleep(20);
    const xr = new Date();
    await meta.removeClaims(meta.claims.map((c) => c.ref));
    const { gap: _g, ...settings } = meta.newest().doc;
    const gap: ProfileGap = { since: xs.toISOString(), by: "install-x", at: xr.toISOString() };
    meta.replaceProfiles(makeProfileDoc(settings, {
      updatedAt: xr, producer: { kind: "local", version: "dev" }, gap,
    }), "install-x");
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    // B wakes after a quiet stretch and looks.
    b.clock.skewMs = 5 * 60_000;
    await b.engine.resume();
    expect(b.gap().since, "the window reached over a tenure B never saw").toBe(xs.getTime());
    // (e) idempotent: more looks after more quiet stretches leave it where it is.
    b.clock.skewMs = 10 * 60_000;
    await b.engine.resume();
    b.clock.skewMs = 15 * 60_000;
    await b.engine.resume();
    expect(b.gap().since).toBe(xs.getTime());
    b.clock.skewMs = 0;
    await b.organizeHere();
    expect(b.gap(), "the letter of X's tenure was counted").toMatchObject({ letters: 1, pressed: null });
    expect(b.server.moves).toEqual([]);
  }, 60_000);

  /** B organizes, hands back and looks: its window is open at its own press. */
  async function ownWindowOpen(meta: MemoryMetaFolder) {
    const b = await install(meta, "install-b");
    await b.organizing();
    await expect(b.engine.stopOrganizing()).resolves.toBe("released");
    await b.engine.resume();
    expect(b.gap().since, "premise: B's own hand-back opened its window").not.toBeNull();
    return b;
  }

  /** File the offer; every move it made. */
  const file = async (b: Awaited<ReturnType<typeof install>>, count: number) => {
    const filed = await b.route(`/mailboxes/${b.id}/gap-letters`, { file: true, count });
    expect(filed.status, await filed.clone().text()).toBe(202);
    for (let i = 0; i < 100 && b.server.moves.length === 0; i++) await sleep(50);
    for (let i = 0; i < 3; i++) await b.engine.resume();
    return b.server.moves;
  };

  it("(g) a stale claim: an open window from before a tenure B slept through moves to the claim's last stamp", async () => {
    const meta = new MemoryMetaFolder();
    const b = await ownWindowOpen(meta);
    // B sleeps. X claims, publishes, keeps a letter in the inbox, and dies holding its claim.
    await sleep(20);
    const xFrom = new Date();
    publishAs(meta, "install-x", xFrom);
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await sleep(20);
    const heartbeat = new Date();
    await meta.appendClaim(claimOf("install-x", heartbeat, xFrom));
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    b.clock.skewMs = 15 * 60_000;
    await b.engine.resume();
    expect(b.gap().since, "the window reached over X's tenure").toBe(heartbeat.getTime());
    await b.organizeHere();
    expect(b.gap(), "the letter X kept in the inbox was counted").toMatchObject({ letters: 1, pressed: null });
    expect(await file(b, 1), "File moved the letter X kept").toEqual([{ from: "INBOX", to: "ohmail/News" }]);
  }, 60_000);

  it("(h) a window opened at a key, then a tenure that crashed unseen: its last stamp replaces the key's start", async () => {
    const meta = new MemoryMetaFolder();
    const a = await install(meta, "install-a");
    await a.organizing();
    const b = await install(meta, "install-b");
    await b.engine.resume();
    await expect(a.engine.stopOrganizing()).resolves.toBe("released");
    await b.engine.resume();
    const key = meta.newest().doc.gap!;
    expect(b.gap().since, "premise: B opened its window at A's key").toBe(Date.parse(key.since));
    await sleep(20);
    const cFrom = new Date();
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await sleep(20);
    const heartbeat = new Date();
    await meta.appendClaim(claimOf("install-c", heartbeat, cFrom));
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    b.clock.skewMs = 15 * 60_000;
    await b.engine.resume();
    expect(b.gap().since, "the window reached over C's tenure").toBe(heartbeat.getTime());
    await b.organizeHere();
    expect(b.gap(), "a letter of C's tenure was counted").toMatchObject({ letters: 1, pressed: null });
  }, 60_000);

  it("(i) the claim gone and the newest document key-less: the count starts at B's look, not at its own press", async () => {
    const meta = new MemoryMetaFolder();
    const b = await ownWindowOpen(meta);
    // B sleeps. X claims, publishes, keeps a letter in the inbox, and hands back to the background.
    await sleep(20);
    const xFrom = new Date();
    await meta.appendClaim(claimOf("install-x", xFrom));
    publishAs(meta, "install-x", xFrom);
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await sleep(20);
    await meta.removeClaims(meta.claims.map((c) => c.ref));
    b.clock.skewMs = 5 * 60_000;
    const lookedAt = Date.now();
    await b.engine.resume();
    expect(b.gap().since, "the window reached over X's tenure").toBeGreaterThanOrEqual(lookedAt);
    const since = b.gap().since;
    // A letter after B's look, taken in while B still reads.
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await b.engine.resume();
    expect(b.gap().since, "premise: the next look kept the window").toBe(since);
    b.clock.skewMs = 0;
    await b.organizeHere();
    expect(b.gap(), "the letter X kept in the inbox was counted").toMatchObject({ letters: 1, pressed: null });
  }, 60_000);

  it("(i) CONTROL: B's own key-less document keeps its open window", async () => {
    const meta = new MemoryMetaFolder();
    const b = await ownWindowOpen(meta);
    const own = b.gap().since;
    publishAs(meta, "install-b", new Date());
    b.clock.skewMs = 5 * 60_000;
    await b.engine.resume();
    expect(b.gap().since, "its own document moved the window").toBe(own);
  }, 60_000);

  /* ── A TURN B SLEPT THROUGH ENDS WITHOUT A PRESS (RULING-026 lane A, as amended) ─────────────────
     X organizes after B's own hand-back while B sleeps, keeps a letter in the inbox, and lets go the
     way an install ordinarily does: the app quits, or the phone leaves the foreground. Each exit
     leaves the instant it let go in X's settings document, the document before the claim, and B
     counts from there: only the letter after X let go is offered, and File moves that one. */
  async function xTurnWhileBSleeps() {
    const meta = new MemoryMetaFolder();
    const b = await ownWindowOpen(meta);
    const x = await install(meta, "install-x");
    await x.organizing();
    expect(x.engine.runtimes().organizer[x.id]?.organizing, "premise: X organizes").toBe(true);
    expect(meta.newest().installId, "premise: X published its settings").toBe("install-x");
    // A letter of X's turn that X keeps in the inbox: B takes it in only when it wakes.
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await sleep(20);
    return { meta, b, x };
  }

  /** X lets go the way the exit does: the app quits, or the phone leaves the foreground. */
  const exitBy = async (x: Awaited<ReturnType<typeof install>>, exit: "quit" | "background"): Promise<void> => {
    if (exit === "quit") await x.engine.stop();
    else expect(await x.engine.handBack(), "premise: the hand-back gave the claim back").toEqual([{ mailboxId: x.id, released: 1 }]);
  };

  it.each(["quit", "background"] as const)("(j) %s: B counts from the instant X let go, and File moves only the later letter", async (exit) => {
    const { meta, b, x } = await xTurnWhileBSleeps();
    const mark = meta.trace.length;
    const before = Date.now();
    await exitBy(x, exit);
    const after = Date.now();
    expect(meta.claims, "premise: X's claim went back").toEqual([]);
    expect(meta.trace.slice(mark), "the settings did not go into the mailbox before the claim left")
      .toEqual(["settings:install-x", "claim removed"]);
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    // B wakes after a quiet stretch and looks.
    b.clock.skewMs = 15 * 60_000;
    await b.engine.resume();
    const since = b.gap().since!;
    expect(since, "B's window reached back over X's turn").toBeGreaterThanOrEqual(before);
    const key = meta.newest().doc.gap;
    expect(key, `the ${exit} left no moment in the settings`).toMatchObject({ by: "install-x" });
    expect(key!.since, "the moment is not the instant X let go").toBe(key!.at);
    expect(Date.parse(key!.at)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(key!.at)).toBeLessThanOrEqual(after);
    expect(since, "B counted from its own look, not from the instant X let go").toBe(Date.parse(key!.since));
    b.clock.skewMs = 0;
    await b.organizeHere();
    expect(b.gap(), "the letter X kept was counted, or the later one was not").toMatchObject({ letters: 1, pressed: null });
    expect(await file(b, 1), "File moved other than the later letter").toEqual([{ from: "INBOX", to: "ohmail/News" }]);
  }, 60_000);

  it.each(["quit", "background"] as const)("(l) %s: a settings write the mailbox refuses is said once, the claim still goes back, and B counts from its own look", async (exit) => {
    const { meta, b, x } = await xTurnWhileBSleeps();
    meta.refuseProfilesBy = "install-x";
    await exitBy(x, exit);
    expect(meta.claims, "the refused write held the claim").toEqual([]);
    expect(x.lines.filter((l) => l.event === "organizer_settings_leave_failed").map((l) => l.detail),
      "the refused write was not said exactly once").toEqual([expect.objectContaining({ phase: exit, outcome: "not_saved" })]);
    expect(meta.newest().doc.gap, "premise: X's last document carries no moment").toBeUndefined();
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    b.clock.skewMs = 15 * 60_000;
    const lookedAt = Date.now();
    await b.engine.resume();
    expect(b.gap().since, "B's window reached back over X's turn").toBeGreaterThanOrEqual(lookedAt);
    // A letter after B's look, taken in while B still reads: the only one inside the window.
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await b.engine.resume();
    b.clock.skewMs = 0;
    await b.organizeHere();
    expect(b.gap(), "a letter from before B's look was counted").toMatchObject({ letters: 1, pressed: null });
  }, 60_000);

  it("(m) CONTROL: B saw X hold, then X's lid closed: the window opens at X's last stamp", async () => {
    const meta = new MemoryMetaFolder();
    const b = await ownWindowOpen(meta);
    // X takes the mailbox while B is awake: B sees it hold, and its window closes.
    const xFrom = new Date();
    await meta.appendClaim(claimOf("install-x", xFrom));
    await b.engine.resume();
    expect(b.gap().since, "premise: B saw X hold").toBeNull();
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await sleep(20);
    // X renews once more, and then its lid closes.
    const last = new Date();
    await meta.removeClaims(meta.claims.map((c) => c.ref));
    await meta.appendClaim(claimOf("install-x", last, xFrom));
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    b.clock.skewMs = 15 * 60_000;
    await b.engine.resume();
    expect(b.gap().since, "the window did not open at X's last stamp").toBe(last.getTime());
    await b.organizeHere();
    expect(b.gap(), "the letter X kept was counted").toMatchObject({ letters: 1, pressed: null });
  }, 60_000);

  it("(n) a holder B saw stop, back unseen and stopped again: the window moves to its newest stamp", async () => {
    const meta = new MemoryMetaFolder();
    const b = await ownWindowOpen(meta);
    const xFrom = new Date();
    await meta.appendClaim(claimOf("install-x", xFrom));
    await b.engine.resume();
    expect(b.gap().since, "premise: B saw X hold").toBeNull();
    // X's lid closes: B sees the claim stopped and opens its window at the claim's last stamp.
    b.clock.skewMs = 15 * 60_000;
    await b.engine.resume();
    expect(b.gap().since, "premise: the window opened at X's last stamp").toBe(xFrom.getTime());
    // B sleeps. X wakes, renews its claim (the same `claimedAt`), keeps a letter, and its lid closes again.
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await sleep(20);
    const again = new Date();
    await meta.removeClaims(meta.claims.map((c) => c.ref));
    await meta.appendClaim(claimOf("install-x", again, xFrom));
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    b.clock.skewMs = 35 * 60_000;
    await b.engine.resume();
    expect(b.gap().since, "the window reached over X's second turn").toBe(again.getTime());
    await b.organizeHere();
    expect(b.gap(), "the letter X kept in its second turn was counted").toMatchObject({ letters: 1, pressed: null });
  }, 60_000);

  it("(o) CONTROL: a stale claim older than B's open window, left in the folder, never moves it earlier", async () => {
    const meta = new MemoryMetaFolder();
    const b = await ownWindowOpen(meta);
    const own = b.gap().since;
    // A claim an earlier tenure left behind (its removal failed), last renewed an hour ago.
    const old = new Date(Date.now() - 60 * 60_000);
    await meta.appendClaim(claimOf("install-old", old, new Date(old.getTime() - 60_000)));
    b.clock.skewMs = 5 * 60_000;
    await b.engine.resume();
    expect(b.engine.runtimes().organizer[b.id]?.holderState, "premise: B saw the old claim stopped").toBe("stopped");
    expect(b.gap().since, "an older stale claim moved the window back over B's own tenure").toBe(own);
  }, 60_000);

  it("(f) an open import question withholds the travelled window by name, and the import offers the letter", async () => {
    const meta = new MemoryMetaFolder();
    const a = await install(meta, "install-a");
    await a.organizing();
    // A fresh phone with no rules of its own: A's settings are a question for it.
    const b = await install(meta, "install-b", { rule: false, sealed: true });
    await b.engine.resume();
    await expect(a.engine.stopOrganizing()).resolves.toBe("released");
    const left = meta.newest().doc;
    expect(left.gap?.by, "premise: A left its gap").toBe("install-a");
    await sleep(30);
    b.server.pending.push(letter(new Date()));
    await sleep(30);
    await b.engine.resume();
    expect(b.gap().since).toBe(Date.parse(left.gap!.since));
    expect(await b.engine.claimHere({ by: "press" })).toBe("claimed");
    for (let i = 0; i < 40; i++) { b.server.ring?.(); await sleep(50); }
    expect(b.gap(), "the open question closed or counted the window").toMatchObject({ since: Date.parse(left.gap!.since), letters: null });
    expect(b.lines.find((l) => l.event === "gap_catchup_withheld")?.detail, "the wait was not said by name")
      .toMatchObject({ outcome: "held" });

    const imported = await b.engine.handle(new Request(`http://engine.invalid/mailboxes/${b.id}/profile-import`, {
      method: "POST", headers: { authorization: `Bearer ${b.engine.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: profileFingerprint(left) }),
    }));
    expect([200, 202], await imported.clone().text()).toContain(imported.status);
    for (let i = 0; i < 80 && b.gap().letters === null; i++) { b.server.ring?.(); await sleep(50); }
    expect(b.gap(), "the imported rule's letter was never offered").toMatchObject({ letters: 1, pressed: null });
    expect(b.server.moves, "an offer moved mail").toEqual([]);
  }, 60_000);
});

/* ── THE DESKTOP'S ENGINE OVER PGLITE (the default project) ────────────────────────────────────────
   The same rule on the other device store, through the composition `main.ts` runs: a stale claim, the
   claim gone with a key-less newest document, and the two exits that let go without a press, each
   counted exactly. Two installs, two stores, one `_meta`. */
describe.skipIf(ON_DEVICE_STORE)("the gap travels across installs, on the desktop store", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  /** One desktop install over the shared folder: consented, the News rule, organizing if the folder is free. */
  async function desktop(meta: MemoryMetaFolder, installId: string) {
    const server = mailServer(meta);
    const clock = { skewMs: 0 };
    const dataDir = await freshDataDir("ohmail-gap-travels-");
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const s: Sidecar = await createSidecar({
      dataDir, installId, machineName: `ohmail ${installId}`,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
      address: "a@b.test", pollIntervalMs: 60 * 60 * 1000, adapterFactory: server.factory, log: () => {},
      now: () => new Date(Date.now() + clock.skewMs),
    });
    cleanups.push(() => s.stop().catch(() => undefined));
    const id = s.world.mailboxId;
    await s.db.insert(rules).values({
      accountId: s.world.accountId, kind: "sender", match: "letters@news.test", destination: "ohmail/News",
      provenance: "manual", enabled: true, createdAt: new Date(RULE_MADE), updatedAt: new Date(RULE_MADE),
    });
    await grantOrganizeConsent(s);
    await s.start();
    await s.syncUntilQuiet();
    const gap = async (): Promise<Gap> => {
      const [r] = await s.db.select({ since: mailboxes.gapSince, letters: mailboxes.gapLetters, pressed: mailboxes.gapPressedAt })
        .from(mailboxes).where(eq(mailboxes.id, id));
      return { since: r!.since?.getTime() ?? null, letters: r!.letters, pressed: r!.pressed?.getTime() ?? null };
    };
    const route = (path: string, body: unknown) => s.handle(new Request(`http://local${path}`, {
      method: "POST", headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    return {
      s, server, clock, id, gap,
      /** The person's hand-back, honoured by the cycle it rings; then a look as a reader. */
      handBackHere: async () => {
        const res = await route(`/mailboxes/${id}/release`, {});
        expect(res.status, await res.clone().text()).toBe(202);
        await s.syncUntilQuiet();
        expect(s.organizerState().organizing, "premise: the hand-back was honoured").toBe(false);
        await s.syncUntilQuiet();
      },
      /** Organize here, then the quiet organizing drain that licenses the count. */
      organizeHere: async () => {
        await requestOrganizerTakeover(s.db, { mailboxId: id, now: new Date(Date.now() + clock.skewMs), intent: "takeover" });
        await s.syncUntilQuiet();
        expect(s.organizerState().organizing, "the press did not promote this install").toBe(true);
        for (let i = 0; i < 4; i++) await s.syncUntilQuiet();
      },
      /** File the offer; every move it made. */
      file: async (count: number) => {
        const filed = await route(`/mailboxes/${id}/gap-letters`, { file: true, count });
        expect(filed.status, await filed.clone().text()).toBe(202);
        for (let i = 0; i < 100 && server.moves.length === 0; i++) await sleep(50);
        for (let i = 0; i < 3; i++) await s.syncUntilQuiet();
        return server.moves;
      },
    };
  }

  /** B organizes, hands back and looks: its window is open at its own press. */
  async function bWindowOpen(meta: MemoryMetaFolder) {
    const b = await desktop(meta, "install-b");
    expect(b.s.organizerState().organizing, "premise: B organizes").toBe(true);
    await b.handBackHere();
    expect((await b.gap()).since, "premise: B's own hand-back opened its window").not.toBeNull();
    return b;
  }

  it("a stale claim: the window moves from B's own press to the claim's last stamp", async () => {
    const meta = new MemoryMetaFolder();
    const b = await bWindowOpen(meta);
    // B sleeps. X claims, keeps a letter in the inbox, and dies holding its claim.
    await sleep(20);
    const xFrom = new Date();
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await sleep(20);
    const heartbeat = new Date();
    await meta.appendClaim(claimOf("install-x", heartbeat, xFrom));
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    b.clock.skewMs = 15 * 60_000;
    await b.s.syncUntilQuiet();
    expect((await b.gap()).since, "the window reached over X's tenure").toBe(heartbeat.getTime());
    await b.organizeHere();
    expect(await b.gap(), "the letter X kept was counted").toMatchObject({ letters: 1, pressed: null });
    expect(await b.file(1), "File moved other than the later letter").toEqual([{ from: "INBOX", to: "ohmail/News" }]);
  }, 120_000);

  it("the claim gone and the newest document key-less: the count starts at B's look", async () => {
    const meta = new MemoryMetaFolder();
    const b = await bWindowOpen(meta);
    // B sleeps. X claims, publishes, keeps a letter in the inbox, and lets go without a key.
    await sleep(20);
    const xFrom = new Date();
    await meta.appendClaim(claimOf("install-x", xFrom));
    publishAs(meta, "install-x", xFrom);
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await sleep(20);
    await meta.removeClaims(meta.claims.map((c) => c.ref));
    b.clock.skewMs = 5 * 60_000;
    const lookedAt = Date.now();
    await b.s.syncUntilQuiet();
    expect((await b.gap()).since, "the window reached over X's tenure").toBeGreaterThanOrEqual(lookedAt);
    // A letter after B's look, taken in while B still reads.
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await b.s.syncUntilQuiet();
    b.clock.skewMs = 0;
    await b.organizeHere();
    expect(await b.gap(), "the letter X kept was counted").toMatchObject({ letters: 1, pressed: null });
  }, 120_000);

  it.each(["quit", "background"] as const)("%s: B counts from the instant X let go, and File moves only the later letter", async (exit) => {
    const meta = new MemoryMetaFolder();
    const b = await bWindowOpen(meta);
    const x = await desktop(meta, "install-x");
    expect(x.s.organizerState().organizing, "premise: X organizes").toBe(true);
    expect(meta.newest().installId, "premise: X published its settings").toBe("install-x");
    // B sleeps through X's turn; a letter of it stays in the inbox.
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    await sleep(20);
    const mark = meta.trace.length;
    const before = Date.now();
    if (exit === "quit") await x.s.stop();
    else expect(await x.s.handBack(), "premise: the hand-back gave the claim back").toEqual([{ mailboxId: x.id, released: 1 }]);
    const after = Date.now();
    expect(meta.claims, "premise: X's claim went back").toEqual([]);
    expect(meta.trace.slice(mark), "the settings did not go into the mailbox before the claim left")
      .toEqual(["settings:install-x", "claim removed"]);
    await sleep(20);
    b.server.pending.push(letter(new Date()));
    b.clock.skewMs = 15 * 60_000;
    await b.s.syncUntilQuiet();
    const since = (await b.gap()).since!;
    expect(since, "B's window reached back over X's turn").toBeGreaterThanOrEqual(before);
    const key = meta.newest().doc.gap;
    expect(key, `the ${exit} left no moment in the settings`).toMatchObject({ by: "install-x" });
    expect(key!.since, "the moment is not the instant X let go").toBe(key!.at);
    expect(Date.parse(key!.at)).toBeLessThanOrEqual(after);
    expect(since, "B counted from its own look, not from the instant X let go").toBe(Date.parse(key!.since));
    b.clock.skewMs = 0;
    await b.organizeHere();
    expect(await b.gap(), "the letter X kept was counted, or the later one was not").toMatchObject({ letters: 1, pressed: null });
    expect(await b.file(1), "File moved other than the later letter").toEqual([{ from: "INBOX", to: "ohmail/News" }]);
  }, 120_000);

  it("CONTROL: removing the mailbox writes no settings; only the install's own quit leaves them", async () => {
    const meta = new MemoryMetaFolder();
    const x = await desktop(meta, "install-x");
    expect(x.s.organizerState().organizing, "premise: X organizes").toBe(true);
    const mark = meta.trace.length;
    // The removal route releases the claim and wipes this install's copy before its detach runs.
    const res = await x.s.handle(new Request(`http://local/local/mailboxes/${x.id}`, {
      method: "DELETE", headers: { authorization: `Bearer ${x.s.sessionToken}` },
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(meta.trace.slice(mark), "the removal wrote settings into the mailbox it was leaving").toEqual(["claim removed"]);
  }, 120_000);
});
