/**
 * A REMOVED MAILBOX'S MAIL LEAVES THE DEVICE STORE TOO — the removal route and the start's sweep
 * are `createSidecar`'s, so they run over the phone's SQLite exactly as over the desktop's PGlite
 * (`removal-across-the-quit.test.ts` is that file). Three acts: the wipe runs before the claim is
 * given back, so a refused wipe keeps the claim; a Remove of a removed mailbox with no runtime still
 * wipes; and the next start finishes a wipe that did not.
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows } from "../src/mobile.js";

/* The SQL runner below waits a real `setTimeout(0)` before every statement, as the phone's bridge does. */
vi.setConfig({ testTimeout: 60_000 });

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

interface Executor extends PhoneSqlExecutor {
  direct(sql: string, params?: unknown[]): unknown[];
  /** Refuse the next statement that matches, as a store that fails under the wipe would. */
  refuse: RegExp | null;
}

function nodeExecutor(file: string): Executor {
  const raw = new sqlite.DatabaseSync(file);
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T> | T): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.catch(() => undefined);
    return next;
  };
  const yielded = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const ex: Executor = {
    refuse: null,
    async all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows> {
      return serial(async () => {
        await yielded();
        if (ex.refuse?.test(sql)) { ex.refuse = null; throw new Error("the device store refused the statement"); }
        const st = raw.prepare(sql);
        const columns = (st.columns ? st.columns() : []).map((c) => c.name ?? c.column ?? "");
        const objects = st.all(...(params as unknown[])) as Record<string, unknown>[];
        const rows = columns.length > 0 ? objects.map((o) => columns.map((c) => o[c])) : objects.map((o) => Object.values(o));
        return { columns, rows };
      });
    },
    async run(sql: string, params: readonly unknown[]): Promise<void> {
      return serial(async () => {
        await yielded();
        if (ex.refuse?.test(sql)) { ex.refuse = null; throw new Error("the device store refused the statement"); }
        raw.prepare(sql).run(...(params as unknown[]));
      });
    },
    async batch(statements): Promise<void> {
      return serial(async () => {
        await yielded();
        raw.exec("BEGIN IMMEDIATE");
        try {
          for (const { sql, params = [] } of statements) {
            if (ex.refuse?.test(sql)) { ex.refuse = null; throw new Error("the device store refused the statement"); }
            raw.prepare(sql).run(...(params as unknown[]));
          }
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
  return ex;
}

class MemoryMetaFolder implements LeaseIo {
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
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.claims.filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c }));
  }
  get count(): number { return this.claims.length; }
}

function quietMailbox(meta: MemoryMetaFolder) {
  return (_cfg: ImapConfig): MailboxAdapter => ({
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
    async send(): Promise<never> { throw new Error("this test's mailbox must never be asked to send"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("this mailbox cannot fetchPart"); },
  }) as never;
}

const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";
const INSTALL = "install-phone-removal";

interface Line { event: string; detail: Record<string, unknown> }

const open: PhoneEngine[] = [];
const dirs: string[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.stop().catch(() => undefined);
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function storeFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ohmail-phone-removal-"));
  dirs.push(dir);
  return join(dir, "engine.db");
}

async function phone(file: string, meta = new MemoryMetaFolder()): Promise<{
  engine: PhoneEngine; exec: Executor; meta: MemoryMetaFolder; lines: Line[]; id: string;
}> {
  const exec = nodeExecutor(file);
  const lines: Line[] = [];
  const engine = await startPhoneEngine({
    exec,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "a@b.test", pass: "pw-not-used-password-password" } },
    machineName: "ohmail on a phone",
    installId: INSTALL,
    adapterFactory: quietMailbox(meta),
    log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
  } as Parameters<typeof startPhoneEngine>[0]);
  open.push(engine);
  const id = Object.keys(engine.runtimes().organizer)[0]!;
  return { engine, exec, meta, lines, id };
}

/** A removed mailbox's rows, written straight into the store: an older build's tombstone, never wiped. */
function plantTombstone(exec: Executor, accountId: string, n: number): string {
  const id = randomUUID();
  exec.direct(
    "insert into mailboxes (id, account_id, provider, address, status, disabled_reason) values (?, ?, 'imap', ?, 'disabled', NULL)",
    [id, accountId, `gone-${id.slice(0, 6)}@b.test`],
  );
  exec.direct("insert into mailbox_folders (id, mailbox_id, folder) values (?, ?, 'INBOX')", [randomUUID(), id]);
  plantMessages(exec, accountId, id, n);
  return id;
}

function plantMessages(exec: Executor, accountId: string, mailboxId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    exec.direct(
      "insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject) values (?, ?, ?, ?, ?, ?)",
      [randomUUID(), accountId, mailboxId, randomUUID(), randomUUID(), `mail ${i}`],
    );
  }
}

const held = (exec: Executor, mailboxId: string): { messages: number; folders: number; receipts: number } => ({
  messages: (exec.direct("select count(*) as n from messages where mailbox_id = ?", [mailboxId]) as { n: number }[])[0]!.n,
  folders: (exec.direct("select count(*) as n from mailbox_folders where mailbox_id = ?", [mailboxId]) as { n: number }[])[0]!.n,
  receipts: (exec.direct(
    "select count(*) as n from change_log where entity_type = 'mailbox' and entity_id = ? and op = 'delete'", [mailboxId],
  ) as { n: number }[])[0]!.n,
});

const remove = async (engine: PhoneEngine, id: string): Promise<{ status: number; code: string | null }> => {
  const r = await engine.handle(new Request(`http://local/local/mailboxes/${id}`, {
    method: "DELETE", headers: { authorization: `Bearer ${engine.sessionToken}`, "content-type": "application/json" },
  }));
  const body = await r.json().catch(() => ({})) as { error?: { code?: string } };
  return { status: r.status, code: body.error?.code ?? null };
};

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so this file cannot pass here by contributing nothing", () => {
    expect(process.env.OHMAIL_EXPECT_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("a removal, on the device store", () => {
  it("a mailbox an older build removed with its mail left under it is cleared at the next start", async () => {
    const file = storeFile();
    const first = await phone(file);
    const accountId = first.engine.accountId;
    await first.engine.stop();
    open.splice(open.indexOf(first.engine), 1);

    const planting = nodeExecutor(file);
    const gone = plantTombstone(planting, accountId, 4);
    expect(held(planting, gone).messages, "premise: the mail is under the tombstone").toBe(4);
    /* CONTROL: a mailbox switched off by a plain status PATCH keeps its credential, and its mail. */
    const off = plantTombstone(planting, accountId, 2);
    planting.direct(
      "insert into mailbox_credentials (mailbox_id, transport, secret_enc, key_version) values (?, 'imap', 'not-a-secret', 1)",
      [off],
    );
    await planting.close();

    const next = await phone(file);
    expect(held(next.exec, gone), "the next start left the removed mailbox's mail").toEqual({ messages: 0, folders: 0, receipts: 1 });
    expect(next.lines.some((l) => l.event === "local_mirror_wipe_finished" && l.detail.mailboxId === gone)).toBe(true);
    expect(held(next.exec, off).messages, "a switched-off mailbox lost its mail").toBe(2);
  });

  it("Remove on a removed mailbox with no runtime still clears what it left", async () => {
    const p = await phone(storeFile());
    const gone = plantTombstone(p.exec, p.engine.accountId, 3);
    expect(await remove(p.engine, gone)).toEqual({ status: 200, code: null });
    expect(held(p.exec, gone)).toEqual({ messages: 0, folders: 0, receipts: 1 });
  });

  it("a wipe the store refuses fails the removal BEFORE the claim goes back; the next press finishes it", async () => {
    const p = await phone(storeFile());
    /* An organizing phone: the consent and the credential the claim needs, then one gated pass. */
    p.exec.direct(
      "insert or replace into mailbox_credentials (mailbox_id, transport, secret_enc, key_version) values (?, 'imap', 'not-a-secret', 1)",
      [p.id],
    );
    p.exec.direct(
      "update mailboxes set organizer_role = 'organizer', organize_consented_at = 1, status = 'connected' where id = ?",
      [p.id],
    );
    await p.engine.resume();
    expect(p.meta.count, "premise: this phone holds the claim").toBe(1);
    plantMessages(p.exec, p.engine.accountId, p.id, 3);

    p.exec.refuse = /^\s*delete from "messages"/i;
    expect(await remove(p.engine, p.id)).toEqual({ status: 503, code: "local_mirror_not_cleared" });
    expect(p.meta.count, "the claim was given back for a removal that was refused").toBe(1);
    expect(held(p.exec, p.id).messages).toBe(3);

    expect(await remove(p.engine, p.id)).toEqual({ status: 200, code: null });
    expect(p.meta.count).toBe(0);
    expect(held(p.exec, p.id)).toEqual({ messages: 0, folders: 0, receipts: 1 });
  });
});
