/**
 * A PHONE'S SERVER SETTINGS, CHANGED IN PLACE — through the seal door the Settings sheet presses,
 * on the device store, with every dial a double this file records.
 *
 * The rule: a change is dialled before it is kept, a refused half keeps the working settings, and
 * the SAME mailbox on another port or TLS mode keeps its claim in `ohmail/_meta` the whole time —
 * a second install polling the folder across the press never finds it free.
 */
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, MailboxAdapter, NativeLocator,
} from "@trafficflow/core/adapters/imap";
import { formatClaim, type LeaseIo, type RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import type { ImapConfig } from "@trafficflow/core/adapters/imap";
import {
  startPhoneEngine, type PhoneEngine, type PhoneSqlExecutor, type PhoneSqlRows,
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

/** An in-memory `ohmail/_meta`, just enough for the gate to take a claim. */
class MetaFolder implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  /** A server that refuses the append — the candidate claim cannot land here. */
  refuseAppend = false;
  /** Runs once, as the next append lands — what happens elsewhere while a claim is written. */
  onAppend: (() => void) | null = null;
  async appendClaim(raw: string): Promise<void> {
    if (this.refuseAppend) throw Object.assign(new Error("APPEND refused"), { code: "NO" });
    const hook = this.onAppend;
    this.onAppend = null;
    hook?.();
    this.claims.push({ ref: this.nextUid++, raw });
  }
  /** Install ids and nonces standing now — who holds the folder, read as a second install reads it. */
  holders(): { installId: string; nonce: string }[] {
    return this.claims.map((c) => ({
      installId: /X-Ohmail-Install-Id: *(.*)/i.exec(c.raw)?.[1]?.trim() ?? "",
      nonce: /X-Ohmail-Nonce: *(.*)/i.exec(c.raw)?.[1]?.trim() ?? "",
    }));
  }
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

/** An incoming server that answers, and records where each dial went. One folder for every dial. */
function incoming(meta: MetaFolder, dials: { host: string; port: number; secure: boolean }[], o: { unreachable?: boolean } = {}) {
  return (cfg: ImapConfig): MailboxAdapter => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }),
    async connect(): Promise<void> {
      dials.push({ host: cfg.host, port: cfg.port, secure: cfg.secure });
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

/**
 * SERVERS BY HOST: each named host answers from its own folder, and two names may share one — the
 * same account reached as `imap.invalid` and as an alias. A folder with `refuseAppend` refuses the
 * claim, which is the control an absent `adapterFactory` cannot give.
 */
function servers(
  byHost: Record<string, MetaFolder>, dials: { host: string; port: number; secure: boolean }[],
  contexts?: Map<string, { onConnectionError(err: unknown): void }>,
) {
  return (cfg: ImapConfig, ctx?: { onConnectionError(err: unknown): void }): MailboxAdapter => {
    const meta = byHost[cfg.host.toLowerCase()];
    if (meta === undefined) throw new Error(`no server answers at ${cfg.host}`);
    if (ctx !== undefined) contexts?.set(cfg.host.toLowerCase(), ctx);
    return incoming(meta, dials)(cfg);
  };
}

/** A live claim of another install, written as its own renew would write it. */
function foreignClaim(name: string): string {
  return formatClaim({
    authorizedAt: null, capabilities: ["requests"], installId: "install-desktop-elsewhere", kind: "local",
    displayName: name, heartbeat: new Date(), claimedAt: new Date(Date.now() - 60_000), nonce: "theirs",
  });
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

const ON_DEVICE_STORE = process.env.OHMAIL_EXPECT_DIALECT === "sqlite";
const PASS = "settings-change-password";

interface Phone {
  engine: PhoneEngine; id: string; meta: MetaFolder;
  dials: { host: string; port: number; secure: boolean }[];
  lines: { event: string; detail: Record<string, unknown> }[];
  smtpAnswer: { refuse: string | null };
}

/** A phone that opened its mailbox and, unless `organize: false`, claimed it. */
async function openPhone(o: {
  organize?: boolean; others?: Record<string, MetaFolder>; aliases?: string[];
  contexts?: Map<string, { onConnectionError(err: unknown): void }>;
} = {}): Promise<Phone> {
  const meta = new MetaFolder();
  const dials: Phone["dials"] = [];
  const lines: Phone["lines"] = [];
  const smtpAnswer: Phone["smtpAnswer"] = { refuse: null };
  const engine = await startPhoneEngine({
    exec: nodeExecutor(storeFile()),
    imap: {
      host: "imap.invalid", port: 993, secure: true,
      auth: { user: "someone@example.test", pass: PASS },
      smtp: { host: "smtp.invalid", port: 587, secure: false },
    },
    machineName: "ohmail on a phone", installId: "install-server-settings", keks: { 1: "d".repeat(64) },
    adapterFactory: servers({
      "imap.invalid": meta, ...Object.fromEntries((o.aliases ?? []).map((h) => [h, meta])), ...(o.others ?? {}),
    }, dials, o.contexts),
    smtpDial: async () => {
      if (smtpAnswer.refuse !== null) throw Object.assign(new Error("smtp refused"), { code: smtpAnswer.refuse, responseCode: 535 });
      return { maxMessageBytes: null };
    },
    log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
  });
  open.push(engine);
  const id = Object.keys(engine.runtimes().organizer)[0] ?? Object.keys(engine.runtimes().connection)[0]!;
  if (o.organize !== false) {
    expect(await engine.claimHere({ by: "press" }), "the premise is a phone holding its claim").toBe("claimed");
    expect((await meta.listClaims()).length).toBe(1);
  }
  return { engine, id, meta, dials, lines, smtpAnswer };
}

/** The Settings sheet's press: both blocks and the password, on the launch bearer. */
const change = (p: Phone, body: Record<string, unknown>): Promise<Response> => p.engine.handle(
  new Request(`http://engine.invalid/local/mailboxes/${encodeURIComponent(p.id)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${p.engine.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
);

/** A second install's view of the folder, read every millisecond while `during` runs. */
async function pollClaims<T>(meta: MetaFolder, during: () => Promise<T>): Promise<{
  result: T; fewest: number; reads: number; ids: string[];
}> {
  let fewest = Number.POSITIVE_INFINITY;
  let reads = 0;
  let polling = true;
  const ids = new Set<string>();
  const loop = (async () => {
    while (polling) {
      const now = await meta.listClaims();
      fewest = Math.min(fewest, now.length);
      for (const c of now) ids.add(/X-Ohmail-Install-Id: *(.*)/i.exec(c.raw)?.[1]?.trim() ?? "");
      reads += 1;
      await new Promise((r) => setTimeout(r, 1));
    }
  })();
  const result = await during();
  await new Promise((r) => setTimeout(r, 50));
  polling = false;
  await loop;
  return { result, fewest, reads, ids: [...ids] };
}

describe.skipIf(ON_DEVICE_STORE)("the default project does not substitute the device schema", () => {
  it("states the premise, so the composition cases are measured by the sqlite project", () => {
    expect(process.env.OHMAIL_EXPECT_DIALECT).toBe("pg");
  });
});

describe.runIf(ON_DEVICE_STORE)("a phone changes its server settings in place", () => {
  it("the SAME mailbox on another port keeps its claim the whole time, and dials the new port", async () => {
    const p = await openPhone();
    const { result, fewest, reads } = await pollClaims(p.meta, () => change(p, {
      imap: { host: "imap.invalid", port: 143, secure: false, pass: PASS, smtpHost: "smtp.invalid" },
      smtp: { host: "smtp.invalid", port: 465, secure: true, pass: PASS },
    }));
    expect(result.status).toBe(200);
    expect(reads, "the poller really read the folder across the press").toBeGreaterThan(5);
    expect(fewest, "a second install polling ohmail/_meta found the mailbox free").toBe(1);
    expect(await p.engine.serverSettings()).toEqual({
      imap: { host: "imap.invalid", port: 143, secure: false },
      smtp: { host: "smtp.invalid", port: 465, secure: true },
    });
    await expect.poll(() => p.lines.filter((l) => l.event === "mailbox_reconnected").length).toBeGreaterThan(0);
    expect(p.dials.at(-1), "the running mailbox dials the port it was just proved on").toEqual(
      { host: "imap.invalid", port: 143, secure: false });
    expect(p.engine.runtimes().organizer[p.id]?.claimed).toBe(true);
    /* POSITIVE CONTROL for the poller: a hand-back empties the folder, and it sees that. */
    const back = await pollClaims(p.meta, () => p.engine.handBack());
    expect(back.fewest).toBe(0);
  }, 30_000);

  it("a refused outgoing server refuses the whole change and keeps the working settings", async () => {
    const p = await openPhone();
    p.smtpAnswer.refuse = "EAUTH";
    const res = await change(p, {
      imap: { host: "imap.invalid", port: 143, secure: false, pass: PASS, smtpHost: "smtp.invalid" },
      smtp: { host: "smtp.invalid", port: 2525, secure: false, pass: PASS },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json() as { error?: { code?: string; details?: { transport?: string; reason?: string } } };
    expect(body.error?.code).toBe("mailbox_probe_failed");
    expect(body.error?.details).toMatchObject({ transport: "smtp", reason: "auth" });
    expect(await p.engine.serverSettings(), "a refused half changed a working setting").toEqual({
      imap: { host: "imap.invalid", port: 993, secure: true },
      smtp: { host: "smtp.invalid", port: 587, secure: false },
    });
    expect((await p.meta.listClaims()).length).toBe(1);
  }, 30_000);

  /* ── A NEW INCOMING HOST WHILE THIS PHONE ORGANIZES: the runtime claims it first ──────────── */

  const moveTo = (p: Phone, host: string, extra: Record<string, unknown> = {}): Promise<Response> =>
    change(p, { imap: { host, port: 993, secure: true, pass: PASS, ...extra } });

  it("the SAME folder under another name: kept, the claim renewed in place, the folder never free", async () => {
    const p = await openPhone({ aliases: ["alias.invalid"] });
    expect(p.meta.holders().map((h) => h.installId)).toEqual(["install-server-settings"]);
    const before = p.meta.holders()[0]!.nonce;
    p.lines.length = 0;
    const { result, fewest, reads, ids } = await pollClaims(p.meta, () => moveTo(p, "alias.invalid"));
    expect(result.status, "the move was refused").toBe(200);
    expect(reads, "the poller really read the folder across the press").toBeGreaterThan(5);
    expect(fewest, "a second install polling ohmail/_meta found the mailbox free").toBeGreaterThanOrEqual(1);
    expect(ids, "a claim under another id appeared").toEqual(["install-server-settings"]);
    expect(p.lines.filter((l) => /^organizer_(released|claim_released)/.test(l.event)), "the claim was released")
      .toEqual([]);
    const after = p.meta.holders();
    expect(after, "the folder holds this install's claim once").toHaveLength(1);
    expect(after[0]!.nonce, "the claim was not renewed under this runtime's nonce").not.toBe(before);
    expect((await p.engine.serverSettings())?.imap.host).toBe("alias.invalid");
    /* THE RUNTIME'S OWN DIAL MOVED — the probe and the candidate dial the alias too, so the last
       dial alone says nothing about which connection the mailbox now runs on. */
    expect(p.lines.some((l) => l.event === "mailbox_dial_moved"), "the running mailbox did not follow").toBe(true);
    await expect.poll(() => p.lines.some((l) => l.event === "mailbox_reconnected"), { timeout: 5_000 }).toBe(true);
    expect(p.engine.runtimes().organizer[p.id]?.claimed).toBe(true);
  }, 30_000);

  it("ANOTHER SERVER, empty: kept, the claim moves with the mailbox and the old server's goes", async () => {
    const two = new MetaFolder();
    const p = await openPhone({ others: { "other.invalid": two } });
    const res = await moveTo(p, "other.invalid");
    expect(res.status, "the move was refused").toBe(200);
    expect(two.holders().map((h) => h.installId), "the new server holds no claim of this install's")
      .toEqual(["install-server-settings"]);
    expect(p.meta.holders(), "the old server still holds this install's claim").toEqual([]);
    expect((await p.engine.serverSettings())?.imap.host).toBe("other.invalid");
    await expect.poll(() => p.dials.at(-1)?.host, { timeout: 5_000 }).toBe("other.invalid");
    /* AND THE RUNTIME RENEWS IT THERE: a forced cycle writes a fresh nonce on the new server. */
    const nonce = two.holders()[0]!.nonce;
    await p.engine.resume();
    expect(two.holders(), "the new server's claim was not renewed by the runtime").toHaveLength(1);
    expect(two.holders()[0]!.nonce).not.toBe(nonce);
    expect(p.meta.holders(), "the old server was claimed again").toEqual([]);
  }, 30_000);

  it("ANOTHER SERVER, held: refused with the holder named, nothing kept, the running claim stands", async () => {
    const two = new MetaFolder();
    await two.appendClaim(foreignClaim("Office desktop"));
    const p = await openPhone({ others: { "other.invalid": two } });
    const mine = p.meta.holders()[0]!.nonce;
    const res = await moveTo(p, "other.invalid");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; details?: { holder?: { name?: string; kind?: string } } } };
    expect(body.error?.code).toBe("organizer_host_change_refused");
    expect(body.error?.details?.holder, "the refusal did not name the holder").toEqual({ name: "Office desktop", kind: "local" });
    expect(two.holders().map((h) => h.installId), "the new server was claimed").toEqual(["install-desktop-elsewhere"]);
    expect((await p.engine.serverSettings())?.imap.host).toBe("imap.invalid");
    expect(p.meta.holders().map((h) => h.nonce), "the running claim moved").toEqual([mine]);
    await p.engine.resume();
    expect(p.meta.holders(), "the running claim was not renewed on the next gate").toHaveLength(1);
    expect(p.meta.holders()[0]!.nonce).not.toBe(mine);
  }, 30_000);

  it("ANOTHER SERVER that refuses the claim: refused, nothing kept, and nobody is named", async () => {
    const two = new MetaFolder();
    two.refuseAppend = true;
    const p = await openPhone({ others: { "other.invalid": two } });
    const res = await moveTo(p, "other.invalid");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error?: { code?: string; details?: unknown } };
    expect(body.error?.code).toBe("organizer_host_change_refused");
    expect(body.error?.details, "a refusal with nobody to name named somebody").toBeUndefined();
    expect((await p.engine.serverSettings())?.imap.host).toBe("imap.invalid");
    expect(p.meta.holders().map((h) => h.installId)).toEqual(["install-server-settings"]);
    expect(p.lines.some((l) => l.event === "organizer_host_change_failed")).toBe(true);
  }, 30_000);

  it("THE KEEP FAILS after the claim: the new server's claim goes back and the running one stands", async () => {
    const two = new MetaFolder();
    const p = await openPhone({ others: { "other.invalid": two } });
    const mine = p.meta.holders()[0]!.nonce;
    p.smtpAnswer.refuse = "EAUTH";
    const res = await change(p, {
      imap: { host: "other.invalid", port: 993, secure: true, pass: PASS, smtpHost: "smtp.invalid" },
      smtp: { host: "smtp.invalid", port: 587, secure: false, pass: PASS },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("mailbox_probe_failed");
    expect(two.holders(), "the new server kept a claim for a change that was not kept").toEqual([]);
    expect(p.meta.holders().map((h) => h.nonce), "the running claim moved").toEqual([mine]);
    expect((await p.engine.serverSettings())?.imap.host).toBe("imap.invalid");
    expect(p.engine.runtimes().organizer[p.id]?.claimed).toBe(true);
  }, 30_000);

  it("A RE-DIAL ASKED DURING THE MOVE waits: the old server is not claimed again after the keep", async () => {
    /* The old socket dies while the new server's claim is being written, and the wake asks for a
       re-dial. Started then, it dials the OLD server and its gate queues behind the move — and
       after the keep it claims the folder the keep has just emptied. */
    const two = new MetaFolder();
    const contexts = new Map<string, { onConnectionError(err: unknown): void }>();
    const p = await openPhone({ others: { "other.invalid": two }, contexts });
    const ctx = contexts.get("imap.invalid");
    expect(ctx, "the premise: the running socket's own context").toBeDefined();
    two.onAppend = () => {
      ctx!.onConnectionError(Object.assign(new Error("socket reset by peer"), { code: "ECONNRESET" }));
      void p.engine.wake();
    };
    const res = await moveTo(p, "other.invalid");
    expect(res.status, "the move was refused").toBe(200);
    /* The resume queues behind any gate a re-dial left waiting, so the folder is read after it. */
    await p.engine.resume();
    expect(p.meta.holders(), "the old server was claimed again after the move").toEqual([]);
    expect(two.holders().map((h) => h.installId)).toEqual(["install-server-settings"]);
    expect(p.dials.at(-1)?.host, "the runtime stayed on the old server").toBe("other.invalid");
  }, 30_000);

  it("WITHOUT A PASSWORD to try the new server it is refused as before, and nothing dials", async () => {
    const p = await openPhone();
    const before = p.dials.length;
    const res = await change(p, { imap: { host: "other.invalid", port: 993, secure: true } });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: { code?: string } }).error?.code).toBe("organizer_host_change_refused");
    expect(p.dials.length, "the new server was dialled").toBe(before);
    expect((await p.engine.serverSettings())?.imap.host).toBe("imap.invalid");
    expect((await p.meta.listClaims()).length).toBe(1);
  }, 30_000);

  it("KEEPS a new incoming host on a phone that holds no claim, and the mailbox follows it", async () => {
    const p = await openPhone({ organize: false, aliases: ["other.invalid"] });
    const res = await change(p, { imap: { host: "other.invalid", port: 993, secure: true, pass: PASS } });
    expect(res.status).toBe(200);
    expect((await p.engine.serverSettings())?.imap.host).toBe("other.invalid");
    await expect.poll(() => p.dials.at(-1)?.host).toBe("other.invalid");
  }, 30_000);
});
