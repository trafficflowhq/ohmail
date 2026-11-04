/**
 * "ORGANIZE HERE" AFTER A HAND-BACK CLAIMS AT ONCE ON THE DEVICE STORE (VERIFY-026 L6). The phone's
 * engine over SQLite, an in-memory `ohmail/_meta`: the stop lets go, the person's press through the
 * phone's door asks the gate now rather than at the next poll, and the lease takes the empty folder.
 */
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
  OutboundMessage, SendResult,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";

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

class MemoryMetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  /** Runs when the folder empties: the stop honoured, never a renewal's expunge of an older record. */
  onRemove: (() => void) | null = null;
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
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


function quietServer(meta: MemoryMetaFolder): (cfg: ImapConfig) => MailboxAdapter {
  return (_cfg: ImapConfig) => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } }; },
    async move(locator: NativeLocator): Promise<NativeLocator> { return locator; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(_m: OutboundMessage): Promise<SendResult> { throw new Error("no send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart"); },
  }) as MailboxAdapter;
}

const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";
const open: PhoneEngine[] = [];
afterEach(async () => { while (open.length > 0) await open.pop()!.stop().catch(() => undefined); });

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(process.env.OHMAIL_EXPECT_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("Organize here after a hand-back, on the device store", () => {
  it("the person's press claims within seconds, not at the next poll", async () => {
    const exec = nodeExecutor();
    const meta = new MemoryMetaFolder();
    const engine = await startPhoneEngine({
      exec, imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "idle-fixture-password" } },
      machineName: "ohmail on a phone", installId: "install-orgwake", adapterFactory: quietServer(meta), log: () => {},
    } as Parameters<typeof startPhoneEngine>[0]);
    open.push(engine);
    const id = Object.keys(engine.runtimes().organizer)[0]!;
    exec.direct(`insert or replace into mailbox_credentials (mailbox_id, transport, secret_enc, key_version)
      values (?, 'imap', 'not-a-secret', 1)`, [id]);
    exec.direct(`update mailboxes set organizer_role = 'organizer', organize_consented_at = 1, status = 'connected' where id = ?`, [id]);
    await engine.resume();
    expect(meta.count, "premise: this phone holds its claim").toBe(1);
    await expect(engine.stopOrganizing()).resolves.toBe("released");
    expect(meta.count, "premise: the hand-back let go").toBe(0);

    // The person's press through the phone's door, read without `claimHere`'s own forced cycle.
    const at = Date.now();
    const res = await engine.handle(new Request(`http://engine.invalid/local/mailboxes/${id}/organize`, {
      method: "POST", headers: { authorization: `Bearer ${engine.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ consent: "person" }),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    for (let i = 0; i < 60 && meta.count === 0; i++) await new Promise((r) => setTimeout(r, 50));
    process.stdout.write(`[orgwake] phone: press -> claim ${Date.now() - at} ms\n`);
    expect(meta.count, "the press waited for the poll").toBe(1);
  }, 60_000);
});
