/**
 * THE OUTGOING SERVER IS DIALLED AT CONNECT — on the device store, with the submission dial as
 * the only double that can refuse.
 *
 * Measured on a 0.25.1 phone: an SMTP port nothing could reach left the form as connected and the
 * first send was where it failed. The composition now asks the outgoing server's greeting and AUTH
 * beside the incoming dial, refuses keyed to that server, and discards what it sealed.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, MailboxAdapter, NativeLocator,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import {
  startPhoneEngine, startPhoneEngineFromSealed, submissionCertificateOf, submissionRefusalOf,
  type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows,
} from "../src/mobile.js";

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
        const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
        return {
          columns,
          rows: columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o)),
        };
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
  };
}

/** What the store holds after the engine let go of it — read on a fresh handle. */
function transportsIn(file: string): string[] {
  const raw = new sqlite.DatabaseSync(file);
  try {
    return (raw.prepare("select transport from mailbox_credentials order by transport").all() as { transport: string }[])
      .map((r) => r.transport);
  } finally { raw.close(); }
}

/** When the store's mailboxes last finished a sync, on a fresh handle; `null` for never. */
function lastSyncIn(file: string): unknown[] {
  const raw = new sqlite.DatabaseSync(file);
  try {
    return (raw.prepare("select last_sync_at from mailboxes").all() as { last_sync_at: unknown }[]).map((r) => r.last_sync_at);
  } finally { raw.close(); }
}

/** The store as a first sync that never finished leaves it: nothing to paint at a relaunch. */
function neverSynced(file: string): void {
  const raw = new sqlite.DatabaseSync(file);
  try { raw.exec("update mailboxes set last_sync_at = null"); } finally { raw.close(); }
}

/** An in-memory `ohmail/_meta`, just enough for the gate to take a claim. */
class MetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    const gone = new Set(refs);
    for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
  }
  uidValidity(): number { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[]> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`));
  }
}

const EMPTY: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

/** An incoming server that answers, or — `unreachable` — one whose connect is refused. */
function incoming(o: { unreachable?: boolean } = {}) {
  const meta = new MetaFolder();
  return (): MailboxAdapter => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> {
      if (o.unreachable) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    },
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY }; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(): Promise<never> { throw new Error("never asked to send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("never asked to fetch"); },
  }) as unknown as MailboxAdapter;
}

type Dial = NonNullable<Parameters<typeof startPhoneEngine>[0]["smtpDial"]>;
const refusing = (code: string, extra: Record<string, unknown> = {}): Dial =>
  async () => { throw Object.assign(new Error(`smtp ${code}`), { code, ...extra }); };

const open: PhoneEngine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-submission-"));
  dirs.push(dir);
  return join(dir, "engine.db");
}

/* The composition runs on the DEVICE store, which only the sqlite project substitutes; the default
   project states its premise instead of passing by contributing nothing. */
const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";

const KEKS = { 1: "b".repeat(64) };
const IDENTITY = { machineName: "ohmail on a phone", installId: "install-submission-at-connect", keks: KEKS };

function connect(file: string, o: { dial: Dial; incomingDown?: boolean; dialled?: unknown[] }) {
  return startPhoneEngine({
    exec: nodeExecutor(file),
    imap: {
      host: "imap.invalid", port: 993, secure: true,
      auth: { user: "someone@example.test", pass: "pw-submission-case-password-password" },
      smtp: { host: "smtp.invalid", port: 587, secure: false },
    },
    ...IDENTITY,
    adapterFactory: incoming({ unreachable: o.incomingDown === true }),
    smtpDial: async (smtp) => { o.dialled?.push({ host: smtp.host, port: smtp.port }); return o.dial(smtp); },
  });
}

describe("which submission answers refuse a Connect", () => {
  it("a server that said no always does; not reaching it only where the incoming one answered", () => {
    expect(submissionRefusalOf({ verdict: "refuse", code: "auth" }, false)).toBe("auth");
    expect(submissionRefusalOf({ verdict: "refuse", code: "tls" }, false)).toBe("tls");
    for (const code of ["connect", "timeout", "unknown"] as const) {
      expect(submissionRefusalOf({ verdict: "refuse", code }, true), code).toBe("unreachable");
      expect(submissionRefusalOf({ verdict: "refuse", code }, false), `${code} offline`).toBeNull();
    }
    expect(submissionRefusalOf({ verdict: "ok" }, true)).toBeNull();
    expect(submissionRefusalOf({ verdict: "store_unverified", code: "connect" }, true)).toBeNull();
  });

  it("a refused certificate is told from a server without encryption, by kind where the probe read one", () => {
    const tls = (kind?: string) => ({ verdict: "refuse", code: "tls", ...(kind ? { tls: { kind } } : {}) }) as never;
    expect(["untrusted", "self_signed", "hostname_mismatch", "expired", "not_yet_valid", "generic"].map((k) => submissionCertificateOf(tls(k))))
      .toEqual(["untrusted", "untrusted", "hostname_mismatch", "expired", "not_yet_valid", "refused"]);
    // No TLS on the port, or no detail at all: no certificate was shown.
    expect(submissionCertificateOf(tls("tls_unavailable"))).toBeNull();
    expect(submissionCertificateOf(tls())).toBeNull();
    expect(submissionCertificateOf({ verdict: "refuse", code: "auth" })).toBeNull();
  });
});

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so the composition cases are measured by the sqlite project", () => {
    expect(process.env.OHMAIL_EXPECT_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("the phone's Connect dials the outgoing server", () => {
  it("REFUSES a submission server that rejects the sign-in, and discards the seal", async () => {
    const file = storeFile();
    const dialled: unknown[] = [];
    const err = await connect(file, { dial: refusing("EAUTH", { responseCode: 535 }), dialled })
      .then(() => null, (e: unknown) => e);
    expect(dialled, "the outgoing server was asked at Connect").toEqual([{ host: "smtp.invalid", port: 587 }]);
    expect((err as { submissionRefused?: unknown } | null)?.submissionRefused).toBe("auth");
    expect(transportsIn(file), "nothing sealed is left to win over the next press").toEqual([]);
  }, 30_000);

  it("REFUSES an outgoing server whose certificate was refused, and says it was the certificate", async () => {
    const file = storeFile();
    const err = await connect(file, { dial: refusing("ETLS", { message: "certificate has expired" }) })
      .then(() => null, (e: unknown) => e);
    expect((err as { submissionRefused?: unknown } | null)?.submissionRefused).toBe("tls");
    expect((err as { submissionCertificate?: unknown } | null)?.submissionCertificate).toBe("expired");
    expect(transportsIn(file)).toEqual([]);
  }, 30_000);

  it("REFUSES an outgoing server nothing answers on while the incoming one did", async () => {
    const file = storeFile();
    const err = await connect(file, { dial: refusing("ECONNREFUSED") }).then(() => null, (e: unknown) => e);
    expect((err as { submissionRefused?: unknown } | null)?.submissionRefused).toBe("unreachable");
    expect(transportsIn(file)).toEqual([]);
  }, 30_000);

  /* Connect opens a mailbox only over a login: the incoming server nothing answers
     on is refused before the outgoing one is asked, and what was sealed goes with the refusal. */
  it("REFUSES an incoming server nothing answers on, asks the outgoing one nothing, and discards the seal", async () => {
    const file = storeFile();
    const dialled: unknown[] = [];
    const err = await connect(file, { dial: refusing("ECONNREFUSED"), incomingDown: true, dialled })
      .then((engine) => { open.push(engine); return null; }, (e: unknown) => e);
    expect((err as { incomingUnreachable?: unknown } | null)?.incomingUnreachable, "an unreachable server opened a mailbox")
      .toBe("unreachable");
    expect((err as { submissionRefused?: unknown }).submissionRefused, "worded about the outgoing server").toBeUndefined();
    expect(dialled, "the outgoing server was asked after the incoming one could not be reached").toEqual([]);
    expect(transportsIn(file), "nothing sealed is left to win over the next press").toEqual([]);
  }, 30_000);

  it("CONTROL — a relaunch still opens over an outage, on a store holding mail and on one that never synced", async () => {
    const file = storeFile();
    const engine = await connect(file, { dial: async () => ({ maxMessageBytes: null }) });
    await engine.stop();
    expect(lastSyncIn(file).some((at) => at !== null), "the first launch's drain stamped the mailbox").toBe(true);
    const held = await startPhoneEngineFromSealed({
      exec: nodeExecutor(file), ...IDENTITY, adapterFactory: incoming({ unreachable: true }),
    });
    expect(held.kind, "a store holding mail opens over an outage").toBe("started");
    if (held.kind === "started") await held.engine.stop();
    expect(transportsIn(file), "the relaunch kept its seal").toEqual(["imap", "smtp"]);

    neverSynced(file);
    const empty = await startPhoneEngineFromSealed({
      exec: nodeExecutor(file), ...IDENTITY, adapterFactory: incoming({ unreachable: true }),
    });
    expect(empty.kind, "an empty store opens over an outage").toBe("started");
    if (empty.kind === "started") open.push(empty.engine);
  }, 60_000);

  it("ADMITS the ordinary case, keeps both credentials, and a relaunch does not dial it again", async () => {
    const file = storeFile();
    const engine = await connect(file, { dial: async () => ({ maxMessageBytes: null }) });
    await engine.stop();
    expect(transportsIn(file)).toEqual(["imap", "smtp"]);
    const dialled: unknown[] = [];
    const again = await startPhoneEngineFromSealed({
      exec: nodeExecutor(file), ...IDENTITY, adapterFactory: incoming(),
      smtpDial: async (smtp) => { dialled.push(smtp.host); return { maxMessageBytes: null }; },
    });
    expect(again.kind).toBe("started");
    if (again.kind === "started") open.push(again.engine);
    expect(dialled, "a relaunch has no typed password and asks nothing of the outgoing server").toEqual([]);
  }, 30_000);
});
