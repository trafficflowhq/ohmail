/**
 * A HAND-BACK OPENS THE GAP AT THE PERSON'S PRESS, ON THE DEVICE STORE. The phone's
 * engine composed over SQLite, an in-memory `ohmail/_meta` and a mail server double: the stop, a
 * letter arriving while it is honoured, the reader taking it in before its first look, then
 * "Organize here". Nothing moves until File; Leave moves nothing; and what the still-active
 * organizer decided between the press and the honouring is never offered (RULING Q1). A fresh phone
 * that organizes next with another install's settings unanswered offers only after the answer
 * (the cross-install case); the settings folder is a real one, since an install that cannot read it withholds.
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import type { ProfileIo, RawProfileMessage } from "@trafficflow/core/adapters/organizer-profile";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import { formatProfileMessage, makeProfileDoc, profileFingerprint } from "@trafficflow/core/adapters/organizer-profile";
import { startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";
import { GAP_CLOCK_ALLOWANCE_MS } from "@trafficflow/worker/gap-catchup";

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

/* The settings folder is a real, empty one: an install that cannot read it withholds the offer. */
class MemoryMetaFolder implements LeaseIo, ProfileIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  private readonly profiles: Array<{ ref: number; raw: string }> = [];
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    return this.profiles.map((p) => ({ ref: p.ref, raw: p.raw, generation: 4_100 }));
  }
  async appendProfile(raw: string): Promise<void> { this.profiles.push({ ref: this.nextUid++, raw }); }
  async removeProfiles(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.profiles.length - 1; i >= 0; i--) if (gone.has(this.profiles[i]!.ref)) this.profiles.splice(i, 1);
  }
  /** Runs when the folder empties: the stop honoured, never a renewal's expunge of an older record. */
  onRemove: (() => void) | null = null;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  /** The server's INTERNALDATE on each appended claim; none when null. */
  stamp: (() => Date) | null = null;
  async appendClaim(raw: string): Promise<void> {
    this.claims.push({ ref: this.nextUid++, raw, ...(this.stamp === null ? {} : { internalDate: this.stamp() }) });
  }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    if (this.claims.length === 0) this.onRemove?.();
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
  get count(): number { return this.claims.length; }
}

let uid = 70;
function letter(internalDate: Date): ChangeBatch["creates"][number] {
  uid += 1;
  const raw = Buffer.from([
    "From: Letters <letters@news.test>", "To: a@b.test", `Subject: letter ${uid}`,
    `Message-ID: <handback-${uid}@news.test>`, "Date: Sun, 11 Oct 2026 04:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8", "", "this week's letter", "",
  ].join("\r\n"));
  return { type: "create", locator: { folder: "INBOX", ref: `1:${uid}` } as NativeLocator, raw, internalDate, seen: false };
}

/** The mail server: what arrives next, every move asked of it, a hand that can hold one read, its doorbell. */
interface Server {
  pending: Array<ChangeBatch["creates"][number]>;
  moves: Array<{ from: string; to: string }>;
  hold: Promise<void> | null;
  ring: (() => void) | null;
  factory: (cfg: ImapConfig) => MailboxAdapter;
}

function mailServer(meta: MemoryMetaFolder): Server {
  const s: Server = {
    pending: [], moves: [], hold: null, ring: null,
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
        if (s.hold !== null) await s.hold;
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

interface Gap { since: number | null; letters: number | null; pressed: number | null }

/** An organizing phone with a consented row, a claim in the folder and a News rule older than any letter. */
async function organizingPhone() {
  const exec = nodeExecutor();
  const meta = new MemoryMetaFolder();
  const server = mailServer(meta);
  const engine = await startPhoneEngine({
    exec, imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
    machineName: "ohmail on a phone", installId: "install-handback-gap", adapterFactory: server.factory, log: () => {},
  } as Parameters<typeof startPhoneEngine>[0]);
  open.push(engine);
  const id = Object.keys(engine.runtimes().organizer)[0]!;
  exec.direct(`insert or replace into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
    values (?, 'imap', 'not-a-secret', 1)`, [id]);
  exec.direct(`update mailboxes set organizer_role = 'organizer', organize_consented_at = 1, status = 'connected' where id = ?`, [id]);
  const ruleMade = Date.now() - 7 * 86_400_000;
  exec.direct(`insert into rules (account_id, kind, match, destination, provenance, enabled, created_at, updated_at)
    values ((select account_id from mailboxes where id = ?), 'sender', 'letters@news.test', 'ohmail/News', 'manual', 1, ?, ?)`,
  [id, ruleMade, ruleMade]);
  await engine.resume();
  expect(meta.count, "premise: this phone holds its claim").toBe(1);
  const gap = (): Gap => (exec.direct(`select gap_since as since, gap_letters as letters, gap_pressed_at as pressed
    from mailboxes where id = ?`, [id]) as Gap[])[0]!;
  /* THE ORDINARY DRAIN, rung by the doorbell: a forced one (`resume`) is not the quiet drain that
     licenses the gap pass, so the offer is driven the way a real arrival drives it. */
  const until = async (done: () => boolean): Promise<boolean> => {
    for (let i = 0; i < 80; i++) {
      if (done()) return true;
      server.ring?.();
      await new Promise((r) => setTimeout(r, 50));
    }
    return done();
  };
  // The look before consent noted a window, as on every fresh mailbox; this phone's tenure closes it.
  expect(await until(() => gap().since === null), "premise: an organizing phone's tenure closed the boot window").toBe(true);
  // Drains are serialized per mailbox: a forced one queues behind any rung drain still running.
  await engine.resume();
  const route = (path: string, body: unknown) => engine.handle(new Request(`http://engine.invalid${path}`, {
    method: "POST", headers: { authorization: `Bearer ${engine.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return {
    engine, meta, server, id, route, exec,
    gap, until,
    pressedAt: (): number | null => (exec.direct("select release_requested_at as p from mailboxes where id = ?", [id]) as { p: number | null }[])[0]!.p,
    through: (): number | null => (exec.direct("select organized_through as t from mailboxes where id = ?", [id]) as { t: number | null }[])[0]!.t,
    refusal: (): string | null => (exec.direct("select release_refusal as r from mailboxes where id = ?", [id]) as { r: string | null }[])[0]!.r,
    letters: () => exec.direct(`select m.id, m.created_at as createdAt, m.arrived_at as arrivedAt, f.last_set_by as lastSetBy,
        f.desired_folder as desired from messages m join folder_state f on f.message_id = m.id order by m.created_at`) as
      Array<{ id: string; createdAt: number; arrivedAt: number; lastSetBy: string; desired: string }>,
    /** The letters the gap pass filed, by its own audit row. */
    gapFiled: () => (exec.direct("select payload from audit_log where action = 'gap_catchup_move'") as { payload: string }[])
      .map((r) => (JSON.parse(r.payload) as { messageId: string }).messageId),
    /** "Organize here", then ordinary drains until the window is counted or closed. */
    organizeHere: async () => {
      expect(await engine.claimHere({ by: "press" })).toBe("claimed");
      await until(() => gap().letters !== null || gap().since === null);
    },
  };
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(process.env.OHMAIL_EXPECT_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("the gap window a hand-back opens, on the device store", () => {
  /** The stop, with one ruled letter arriving while it is honoured: taken in before the first look. */
  async function handedBackWithALetter() {
    const p = await organizingPhone();
    p.meta.onRemove = () => { p.server.pending.push(letter(new Date())); p.meta.onRemove = null; };
    await expect(p.engine.stopOrganizing()).resolves.toBe("released");
    const [taken] = p.letters();
    expect(taken, "the reader did not take the letter in").toMatchObject({ lastSetBy: "peer", desired: "INBOX" });
    await p.engine.resume();
    return p;
  }

  it("the letter is offered after Organize here, nothing moves, and File files it once", async () => {
    const p = await handedBackWithALetter();
    await p.organizeHere();
    expect(p.server.moves, "mail moved without the press").toEqual([]);
    expect(p.gap(), "the offer missed the letter the hand-back let through").toMatchObject({ letters: 1, pressed: null });
    const filed = await p.route(`/mailboxes/${p.id}/gap-letters`, { file: true, count: 1 });
    expect(filed.status, await filed.clone().text()).toBe(202);
    for (let i = 0; i < 100 && p.server.moves.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(p.server.moves).toEqual([{ from: "INBOX", to: "ohmail/News" }]);
    for (let i = 0; i < 3; i++) await p.engine.resume();
    expect(p.server.moves, "the letter was filed more than once").toHaveLength(1);
    expect(p.gap()).toEqual({ since: null, letters: null, pressed: null });
  }, 60_000);

  it("Leave closes the offer and nothing moves", async () => {
    const p = await handedBackWithALetter();
    await p.organizeHere();
    expect(p.gap().letters, "premise: the letter was offered").toBe(1);
    const left = await p.route(`/mailboxes/${p.id}/gap-letters`, { file: false });
    expect(left.status, await left.clone().text()).toBe(200);
    for (let i = 0; i < 3; i++) await p.engine.resume();
    expect(p.server.moves, "Leave moved mail").toEqual([]);
    expect(p.gap()).toEqual({ since: null, letters: null, pressed: null });
  }, 60_000);

  it("a stop refused for a copy of this install opens the window when the copy lets go, never at the press", async () => {
    const p = await organizingPhone();
    // A restored copy took the mailbox over: our record is gone, and the copy renews one under this
    // install's id and a nonce this process never wrote.
    await p.meta.removeClaims((await p.meta.listClaims()).map((c) => c.ref));
    await p.meta.appendClaim(formatClaim({
      installId: "install-handback-gap", kind: "mobile", displayName: "ohmail on a phone", heartbeat: new Date(),
      claimedAt: new Date(), nonce: "a-restored-copy", authorizedAt: null, capabilities: [],
    }));
    await p.engine.stopOrganizing();
    expect(p.refusal(), "premise: the stop was refused for the copy").toBe("sibling_lapse");
    const pressedAt = p.pressedAt();
    expect(pressedAt, "premise: the stop still stands").not.toBeNull();
    // The copy organizes; this install's reader takes in a letter the copy kept in INBOX.
    p.server.pending.push(letter(new Date()));
    await p.engine.resume();
    const [keptByTheCopy] = p.letters();
    expect(keptByTheCopy).toMatchObject({ lastSetBy: "peer", desired: "INBOX" });
    // The copy lets go.
    const copy = (await p.meta.listClaims()).find((c) => c.raw.includes("a-restored-copy"))!;
    await p.meta.removeClaims([copy.ref]);
    const left = Date.now();
    await p.engine.resume();
    const since = p.gap().since;
    expect(since, "the release opened no window").not.toBeNull();
    expect(since!, "the window reached back over the copy's tenure").toBeGreaterThan(pressedAt!);
    expect(since!).toBeGreaterThanOrEqual(left - 1_000);
    p.server.pending.push(letter(new Date()));
    await p.engine.resume();
    await p.organizeHere();
    expect(p.gap(), "a letter the copy kept was counted").toMatchObject({ letters: 1, pressed: null });
  }, 60_000);

  it("RULING Q1: a letter the still-active organizer filed after the press is not offered; a gap letter is", async () => {
    const p = await organizingPhone();
    let letGo!: () => void;
    p.server.hold = new Promise<void>((r) => { letGo = r; });
    const organizing = p.engine.resume();
    // The press lands while the organizer's own read is in flight.
    const stop = await p.route(`/mailboxes/${p.id}/release`, {});
    expect(stop.status, await stop.clone().text()).toBe(202);
    const pressedAt = p.pressedAt();
    expect(pressedAt, "premise: the press is on the row").not.toBeNull();
    p.server.pending.push(letter(new Date()));
    p.server.hold = null;
    letGo();
    await organizing;
    const [decided] = p.letters();
    expect(decided, "premise: the still-active organizer decided its letter").toMatchObject({ lastSetBy: "us", desired: "ohmail/News" });
    await p.engine.resume();
    expect(p.meta.count, "premise: the stop was honoured").toBe(0);
    p.server.pending.push(letter(new Date()));
    await p.engine.resume();
    const since = p.gap().since;
    // No claim here carries the server's stamp, so the window starts at the press less the clock allowance.
    expect(since, "the window did not open at the press").toBe(pressedAt! - GAP_CLOCK_ALLOWANCE_MS);
    // Inside the window by both instants: only the organizer's decision keeps it out.
    expect(decided!.createdAt).toBeGreaterThanOrEqual(since!);
    expect(decided!.arrivedAt).toBeGreaterThanOrEqual(since!);
    const gapLetter = p.letters().find((l) => l.id !== decided!.id);
    expect(gapLetter).toMatchObject({ lastSetBy: "peer", desired: "INBOX" });

    await p.organizeHere();
    expect(p.gap(), "a letter the organizer decided was offered").toMatchObject({ letters: 1, pressed: null });
    const filed = await p.route(`/mailboxes/${p.id}/gap-letters`, { file: true, count: 1 });
    expect(filed.status, await filed.clone().text()).toBe(202);
    await p.until(() => p.gapFiled().length > 0);
    for (let i = 0; i < 3; i++) await p.engine.resume();
    expect(p.gapFiled(), "the gap pass filed a letter the organizer had decided").toEqual([gapLetter!.id]);
    expect(p.gap()).toEqual({ since: null, letters: null, pressed: null });
  }, 60_000);

  it("mail 0169: a drain that took mail in keeps its claim's server stamp; the stop starts there and clears it, a hand-back keeps it, a promotion and a stand-down clear it", async () => {
    const p = await organizingPhone();
    const stamp = new Date(Date.now() - 20_000);
    p.meta.stamp = () => stamp;
    await p.engine.resume();
    expect(p.through(), "a drain that took no mail recorded a start").toBeNull();
    p.server.pending.push(letter(new Date()));
    expect(await p.until(() => p.through() !== null), "the drain that took the letter recorded nothing").toBe(true);
    expect(p.through()).toBe(stamp.getTime());

    expect(await p.engine.handBack()).toEqual([{ mailboxId: p.id, released: 1 }]);
    expect(p.through(), "the hand-back dropped the start").toBe(stamp.getTime());
    await p.engine.resume();
    expect(p.through()).toBe(stamp.getTime());

    await expect(p.engine.stopOrganizing()).resolves.toBe("released");
    expect(p.gap().since, "the stop did not start the window at the last finished drain").toBe(stamp.getTime());
    expect(p.through(), "the stop left this tenure's start").toBeNull();

    p.exec.direct("update mailboxes set organized_through = ? where id = ?", [stamp.getTime(), p.id]);
    expect(await p.engine.claimHere({ by: "press" })).toBe("claimed");
    await p.engine.resume();
    expect(p.through(), "the promotion kept the last tenure's start").toBeNull();

    p.exec.direct("update mailboxes set organized_through = ? where id = ?", [stamp.getTime(), p.id]);
    await p.meta.appendClaim(formatClaim({
      installId: "another-install", kind: "local", displayName: "a laptop", heartbeat: new Date(Date.now() + 1_000),
      claimedAt: new Date(Date.now() + 1_000), nonce: "laptop-take", authorizedAt: new Date(Date.now() + 1_000), capabilities: [],
    }));
    await p.engine.resume();
    expect(p.engine.runtimes().organizer[p.id]?.organizing, "premise: the phone stood down").toBe(false);
    expect(p.through(), "the stand-down kept the start").toBeNull();
  }, 60_000);

  it("the cross-install case: a fresh phone with the other install's settings unanswered waits; the import offers the letter", async () => {
    // THE LAPTOP ORGANIZED and left its settings: a News rule a month old, written by this version.
    const laptop = makeProfileDoc({
      screener: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
      rules: [{
        kind: "sender", match: "letters@news.test", destination: "ohmail/News", priority: 0, enabled: true,
        provenance: "manual", updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      }],
    }, { updatedAt: new Date(Date.now() - 86_400_000), producer: { kind: "local", version: "dev" } });
    const exec = nodeExecutor();
    const meta = new MemoryMetaFolder();
    const server = mailServer(meta);
    await meta.appendClaim(formatClaim({
      installId: "the-laptop", kind: "local", displayName: "a laptop", heartbeat: new Date(), claimedAt: new Date(),
      nonce: "laptop-1", authorizedAt: null, capabilities: ["profile"],
    }));
    await meta.appendProfile(formatProfileMessage(laptop, { installId: "the-laptop" }));
    /* A key ring and a refused port: the password is sealed, the import's own dial fails, and the
       press is handed to the organizer, which reads the settings on this rig's connection. */
    const engine = await startPhoneEngine({
      exec, imap: { host: "127.0.0.1", port: 1, secure: false, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
      machineName: "ohmail on a phone", installId: "install-fresh-phone", adapterFactory: server.factory, log: () => {},
      keks: { 1: "c".repeat(64) },
    } as Parameters<typeof startPhoneEngine>[0]);
    open.push(engine);
    const id = Object.keys(engine.runtimes().organizer)[0]!;
    exec.direct("update mailboxes set organize_consented_at = 1, status = 'connected' where id = ?", [id]);
    const gap = (): Gap => (exec.direct(`select gap_since as since, gap_letters as letters, gap_pressed_at as pressed
      from mailboxes where id = ?`, [id]) as Gap[])[0]!;
    await engine.resume();
    expect(engine.runtimes().organizer[id]?.organizing, "premise: a reader beside the laptop").toBe(false);
    // THE LAPTOP LETS GO; the look opens the window and a News letter arrives, adopted at the inbox.
    await meta.removeClaims((await meta.listClaims()).map((c) => c.ref));
    await engine.resume();
    expect(gap().since, "premise: the gap was noted").not.toBeNull();
    server.pending.push(letter(new Date()));
    await engine.resume();
    expect(exec.direct("select f.last_set_by as by from folder_state f")).toEqual([{ by: "peer" }]);

    // ORGANIZE HERE, with no rules of its own and the laptop's settings unanswered.
    expect(await engine.claimHere({ by: "press" })).toBe("claimed");
    // Ordinary drains, rung as an arrival rings them, for as long as a cleared pass takes to close it.
    for (let i = 0; i < 80 && gap().since !== null; i++) { server.ring?.(); await new Promise((r) => setTimeout(r, 50)); }
    expect(gap().since, "the open import question closed the window").not.toBeNull();
    expect(gap().letters, "the gap was counted by rules about to change").toBeNull();

    const imported = await engine.handle(new Request(`http://engine.invalid/mailboxes/${id}/profile-import`, {
      method: "POST", headers: { authorization: `Bearer ${engine.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: profileFingerprint(laptop) }),
    }));
    expect([200, 202], await imported.clone().text()).toContain(imported.status);
    for (let i = 0; i < 80 && gap().letters === null; i++) { server.ring?.(); await new Promise((r) => setTimeout(r, 50)); }
    expect(gap(), "the imported rule's letter was never offered").toMatchObject({ letters: 1, pressed: null });
    expect(server.moves, "an offer moved mail").toEqual([]);
  }, 60_000);
});
