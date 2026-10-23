import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type {
  ChangeBatch, FetchedPart, ImapCapabilities, ImapConfig, MailboxAdapter, NativeLocator,
} from "@trafficflow/core/adapters/imap";
import type { LeaseIo, LeasePeekIo, RawClaimMessage } from "@trafficflow/core/adapters/organizer-lease";
import { changeLog, drafts, mailboxCredentials, mailboxFolders, mailboxes, messages } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { STORE_GENERATION_FILE, openLocalDb, type LocalDb } from "../src/db.js";
import type { StdioHost } from "../src/host.js";
import { localShutdown } from "../src/main.js";
import { noteFirstPageServed, resetFirstPageGate } from "../src/first-page-gate.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

/**
 * A REMOVED MAILBOX'S MAIL LEAVES THIS COMPUTER, EVEN WHEN THE APP CLOSES WHILE IT GOES.
 *
 * The removal route used to give the claim back over IMAP (eight or nine answers on a real server)
 * BEFORE it wiped the mirror, and the quit gave the doors' requests one second before it closed
 * the store. A Remove pressed shortly before Close therefore committed the tombstone, released the
 * claim, met the closed store at the wipe and answered 503 — and nothing ever finished it: a
 * tombstone has no runtime at the next launch, and a second Remove wiped only inside the arm that
 * has one. The mail stayed readable, and re-adding the address doubled every message.
 *
 * Three remedies, each with a case that is red without it: the wipe runs before the release; the
 * quit keeps the store open for the doors' requests until they end or `QUIT_REQUESTS_MS`; and the
 * next start (and a Remove of a removed mailbox) finishes a wipe that did not.
 */

vi.setConfig({ testTimeout: 3 * PGLITE_STANDUP_BUDGET_MS + 60_000 });

/* The wipe, refusable on demand: the store refusing it is the one failure that matters here. */
const wipes = vi.hoisted(() => ({ refuse: 0, calls: 0 }));
vi.mock("../src/local-mirror.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/local-mirror.js")>();
  return {
    ...real,
    wipeLocalMirror: async (...args: Parameters<typeof real.wipeLocalMirror>): Promise<void> => {
      wipes.calls += 1;
      if (wipes.refuse > 0) {
        wipes.refuse -= 1;
        throw new Error("the local store refused the wipe");
      }
      return real.wipeLocalMirror(...args);
    },
  };
});

const N = 3;
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/** `ohmail/_meta` in memory, its release reads held `callMs` each — a slow provider's answers. */
class MemoryMeta implements LeaseIo {
  private nextUid = 1;
  private readonly claims: RawClaimMessage[] = [];
  callMs = 0;
  private async lag<T>(work: () => T): Promise<T> {
    if (this.callMs > 0) await sleep(this.callMs);
    return work();
  }
  async ensureMetaFolder(): Promise<void> {}
  async listClaims(): Promise<RawClaimMessage[]> { return this.claims.map((c) => ({ ...c })); }
  async appendClaim(raw: string): Promise<void> { this.claims.push({ ref: this.nextUid++, raw }); }
  async removeClaims(refs: readonly unknown[]): Promise<void> {
    await this.lag(() => {
      const gone = new Set(refs);
      for (let i = this.claims.length - 1; i >= 0; i--) if (gone.has(this.claims[i]!.ref)) this.claims.splice(i, 1);
    });
  }
  uidValidity(): number | bigint | null { return 4_100; }
  async findOwnRecords(installId: string): Promise<RawClaimMessage[] | null> {
    return this.lag(() => this.claims
      .filter((c) => c.raw.includes(`X-Ohmail-Install-Id: ${installId}`)).map((c) => ({ ...c })));
  }
  get count(): number { return this.claims.length; }
}

function arrival(uid: number): Buffer {
  return Buffer.from([
    `Message-ID: <removal-${uid}@stranger.test>`, "From: stranger@elsewhere.test", "To: owner@trafficflow.test",
    `Subject: mail ${uid}`, "Date: Wed, 02 Sep 2026 10:00:00 +0000", "Content-Type: text/plain; charset=utf-8",
    "", "hello",
  ].join("\r\n"), "utf8");
}

/** One mailbox that hands over `N` messages on its first look and nothing after. */
function mailbox(meta: MemoryMeta): (cfg: ImapConfig) => MailboxAdapter {
  let handed = false;
  return () => ({
    leaseIo: () => meta,
    leasePeekIo: () => ({ listClaims: () => meta.listClaims() }) as LeasePeekIo,
    async connect(): Promise<void> {},
    async close(): Promise<void> {},
    forceClose(): void {},
    async capabilities(): Promise<ImapCapabilities> {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> {
      if (handed) return { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };
      handed = true;
      return {
        creates: Array.from({ length: N }, (_, i) => ({
          type: "create" as const, locator: { folder: "INBOX", ref: `1:${41 + i}` } as NativeLocator,
          raw: arrival(41 + i), internalDate: new Date(),
        })) as ChangeBatch["creates"],
        moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
      };
    },
    async move(_l: NativeLocator, toFolder: string): Promise<NativeLocator> { return { folder: toFolder, ref: "7:41" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
    async send(): Promise<never> { throw new Error("no send in this rig"); },
    async fetchPart(): Promise<FetchedPart> { throw new Error("no fetchPart in this rig"); },
  }) as never;
}

interface Line { event: string; detail: Record<string, unknown> }
interface Rig {
  sidecar: Sidecar;
  dataDir: string;
  meta: MemoryMeta;
  lines: Line[];
  mailboxId: string;
  /** Set once the case stops the engine itself, so the cleanup does not stop it twice. */
  stopped: { value: boolean };
}

const storeRecord = (dataDir: string): { open?: boolean } | null => {
  try { return JSON.parse(readFileSync(join(dataDir, STORE_GENERATION_FILE), "utf8")) as { open?: boolean }; } catch { return null; }
};

/** What the store holds for one mailbox, read back the way the next launch would find it. */
async function heldFor(db: LocalDb, mailboxId: string): Promise<{ messages: number; folders: number; receipts: number }> {
  const msgs = await db.select({ id: messages.id }).from(messages).where(eq(messages.mailboxId, mailboxId));
  const folders = await db.select({ id: mailboxFolders.id }).from(mailboxFolders).where(eq(mailboxFolders.mailboxId, mailboxId));
  const receipts = await db.select({ seq: changeLog.seq }).from(changeLog).where(and(
    eq(changeLog.entityType, "mailbox"), eq(changeLog.entityId, mailboxId), eq(changeLog.op, "delete"),
  ));
  return { messages: msgs.length, folders: folders.length, receipts: receipts.length };
}

async function heldAfterReopen(dataDir: string, mailboxId: string): Promise<{ messages: number; folders: number; receipts: number }> {
  const o = await openLocalDb(dataDir);
  try { return await heldFor(o.db, mailboxId); } finally { await o.close(); }
}

/** A removed mailbox's rows, written straight into the store: an older build's tombstone, never wiped. */
async function plantTombstone(db: LocalDb, accountId: string, address: string, n: number): Promise<string> {
  const [row] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address, status: "disabled", disabledReason: null,
  }).returning({ id: mailboxes.id });
  const id = row!.id;
  await db.insert(mailboxFolders).values({ mailboxId: id, folder: "INBOX" } as never);
  for (let i = 0; i < n; i++) {
    await db.insert(messages).values({
      accountId, mailboxId: id, bodyHash: randomUUID(), dedupKey: randomUUID(),
      subject: `left behind ${i}`, fromAddress: "stranger@elsewhere.test",
      nativeLocator: { folder: "INBOX", ref: `1:${90 + i}` },
    } as never);
  }
  return id;
}

describe("a mailbox removal and the app's own close", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
    resetFirstPageGate();
    wipes.refuse = 0;
  });

  async function boot(dataDir?: string): Promise<Rig> {
    noteFirstPageServed();
    const dir = dataDir ?? await freshDataDir("ohmail-removal-quit-");
    if (dataDir === undefined) cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const meta = new MemoryMeta();
    const lines: Line[] = [];
    const sidecar = await createSidecar({
      dataDir: dir,
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "not-dialled-password-password" } },
      address: "owner@trafficflow.test", machineName: "removal rig", pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 600_000,
      adapterFactory: mailbox(meta),
      log: (event, detail) => { lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
    });
    const stopped = { value: false };
    cleanups.push(async () => { if (!stopped.value) await sidecar.stop().catch(() => undefined); });
    return { sidecar, dataDir: dir, meta, lines, mailboxId: sidecar.world.mailboxId, stopped };
  }

  /** An organizing install with `N` messages mirrored and its claim in `ohmail/_meta`: every case's premise. */
  async function organizing(): Promise<Rig> {
    const rig = await boot();
    await grantOrganizeConsent(rig.sidecar);
    await rig.sidecar.start();
    await rig.sidecar.syncUntilQuiet();
    expect((await heldFor(rig.sidecar.db, rig.mailboxId)).messages, "premise: every message mirrored").toBe(N);
    expect(rig.meta.count, "premise: this install holds the claim").toBe(1);
    return rig;
  }

  const remove = (rig: Rig, id = rig.mailboxId): Promise<{ status: number; code: string | null }> =>
    rig.sidecar.handle(new Request(`http://local/local/mailboxes/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${rig.sidecar.sessionToken}`, "content-type": "application/json" },
    })).then(async (r) => {
      const body = await r.json().catch(() => ({})) as { error?: { code?: string } };
      return { status: r.status, code: body.error?.code ?? null };
    });

  /** The desktop's own quit at stdin end, with `request` the one door request still in flight. */
  async function quitDuring(rig: Rig, request: Promise<unknown>): Promise<number[]> {
    const exits: number[] = [];
    let inFlight = 1;
    void request.finally(() => { inFlight = 0; });
    const host = {
      get inFlight() { return inFlight; },
      stop: () => undefined,
      finished: () => request.then(() => undefined, () => undefined),
    } as unknown as StdioHost;
    rig.stopped.value = true;
    const { shutdown } = localShutdown({
      sidecar: () => rig.sidecar, host: () => host, listeners: () => [],
      log: (event, detail) => { rig.lines.push({ event, detail: (detail ?? {}) as Record<string, unknown> }); },
      exit: (code) => { exits.push(code); },
    });
    await shutdown("stdin_closed", 0);
    return exits;
  }

  it("a removal whose claim release takes 1.2 s, closed 50 ms after the press: answered 200, and its mail is gone", async () => {
    const rig = await organizing();
    rig.meta.callMs = 400;                         // three release reads: about 1.2 s
    const removal = remove(rig);
    await sleep(50);
    const exits = await quitDuring(rig, removal);
    const answer = await removal;

    expect(answer, "the removal was refused under the close").toEqual({ status: 200, code: null });
    expect(exits).toEqual([0]);
    expect(storeRecord(rig.dataDir)?.open, "the store was left open").toBe(false);
    const held = await heldAfterReopen(rig.dataDir, rig.mailboxId);
    expect(held.messages, "the removed mailbox's mail is still on this computer").toBe(0);
    expect(held.receipts, "the window was never told the mailbox went").toBe(1);
  });

  it("a claim release slower than the requests' bound (2.4 s): the mail is gone before the claim is given back", async () => {
    const rig = await organizing();
    rig.meta.callMs = 800;                         // about 2.4 s, past QUIT_REQUESTS_MS
    const removal = remove(rig);
    await sleep(50);
    const exits = await quitDuring(rig, removal);
    const answer = await removal;

    expect(answer).toEqual({ status: 200, code: null });
    expect(exits).toEqual([0]);
    const held = await heldAfterReopen(rig.dataDir, rig.mailboxId);
    expect(held.messages, "the wipe waited behind the network release").toBe(0);
    expect(held.receipts).toBe(1);
  });

  it("CONTROL: a fast removal closed 50 ms after the press, and a slow one with no close, behave as before", async () => {
    const fast = await organizing();
    const removal = remove(fast);
    await sleep(50);
    expect(await quitDuring(fast, removal)).toEqual([0]);
    expect(await removal).toEqual({ status: 200, code: null });
    expect((await heldAfterReopen(fast.dataDir, fast.mailboxId)).messages).toBe(0);

    const slow = await organizing();
    slow.meta.callMs = 400;
    expect(await remove(slow)).toEqual({ status: 200, code: null });
    expect(slow.meta.count, "the claim was not given back").toBe(0);
    expect((await heldFor(slow.sidecar.db, slow.mailboxId)).messages).toBe(0);
    expect(slow.lines.some((l) => l.event === "local_mailbox_removed")).toBe(true);
  });

  it("a wipe the store refuses fails the removal BEFORE the claim goes back; the next press finishes it", async () => {
    const rig = await organizing();
    wipes.refuse = 1;
    expect(await remove(rig)).toEqual({ status: 503, code: "local_mirror_not_cleared" });
    expect(rig.meta.count, "the claim was given back for a removal that was refused").toBe(1);
    expect((await heldFor(rig.sidecar.db, rig.mailboxId)).messages).toBe(N);

    expect(await remove(rig)).toEqual({ status: 200, code: null });
    expect(rig.meta.count).toBe(0);
    const held = await heldFor(rig.sidecar.db, rig.mailboxId);
    expect(held.messages).toBe(0);
    expect(held.receipts).toBe(1);
  });

  it("a wipe cut off by the close is finished at the next start", async () => {
    const rig = await organizing();
    wipes.refuse = 1;                              // the store closed under it
    expect(await remove(rig)).toEqual({ status: 503, code: "local_mirror_not_cleared" });
    await rig.sidecar.stop();
    rig.stopped.value = true;
    expect((await heldAfterReopen(rig.dataDir, rig.mailboxId)).messages, "premise: the mail is still here").toBe(N);
    /* The tombstone is what a close between the removal's commit and its wipe leaves; the next
       start finds it with mail still under it. */
    {
      const o = await openLocalDb(rig.dataDir);
      const [row] = await o.db.select({ status: mailboxes.status, reason: mailboxes.disabledReason })
        .from(mailboxes).where(eq(mailboxes.id, rig.mailboxId));
      await o.close();
      expect(row, "premise: the removal committed its tombstone").toEqual({ status: "disabled", reason: null });
    }

    const next = await boot(rig.dataDir);
    const held = await heldFor(next.sidecar.db, rig.mailboxId);
    expect(held.messages, "the next start left the removed mailbox's mail").toBe(0);
    expect(held.folders).toBe(0);
    expect(held.receipts, "the window was never told").toBe(1);
    expect(next.lines.some((l) => l.event === "local_mirror_wipe_finished" && l.detail.mailboxId === rig.mailboxId)).toBe(true);
  });

  /** One unsent draft on the mailbox, written as the window's verb writes it. */
  const plantDraft = async (rig: Rig): Promise<string> => {
    const [d] = await rig.sidecar.db.insert(drafts).values({
      accountId: rig.sidecar.world.accountId, mailboxId: rig.mailboxId, subject: "unsent", body: "on no server",
    }).returning({ id: drafts.id });
    return d!.id;
  };
  const draftsOn = async (db: LocalDb, mailboxId: string): Promise<string[]> =>
    (await db.select({ id: drafts.id }).from(drafts).where(eq(drafts.mailboxId, mailboxId))).map((r) => r.id);

  it("a wipe cut off by the close and finished at the next start keeps the unsent drafts", async () => {
    const rig = await organizing();
    const draft = await plantDraft(rig);
    wipes.refuse = 1;
    expect(await remove(rig)).toEqual({ status: 503, code: "local_mirror_not_cleared" });
    await rig.sidecar.stop();
    rig.stopped.value = true;

    const next = await boot(rig.dataDir);
    expect((await heldFor(next.sidecar.db, rig.mailboxId)).messages, "premise: the start finished the wipe").toBe(0);
    expect(await draftsOn(next.sidecar.db, rig.mailboxId), "the start's wipe took the unsent draft").toEqual([draft]);
  });

  it("a start after a finished removal that kept drafts writes no second receipt", async () => {
    /* Mutation: count any draft in `mirrorRowsRemain` again and this start re-wipes for ever. */
    const rig = await organizing();
    const draft = await plantDraft(rig);
    expect(await remove(rig)).toEqual({ status: 200, code: null });
    await rig.sidecar.stop();
    rig.stopped.value = true;

    const next = await boot(rig.dataDir);
    expect((await heldFor(next.sidecar.db, rig.mailboxId)).receipts, "the start wiped a finished removal again").toBe(1);
    expect(next.lines.some((l) => l.event === "local_mirror_wipe_finished")).toBe(false);
    expect(await draftsOn(next.sidecar.db, rig.mailboxId)).toEqual([draft]);
  });

  it("a mailbox an older build removed with its mail left under it is cleared at the next start; a paused or switched-off one keeps its mail", async () => {
    const first = await boot();
    const accountId = first.sidecar.world.accountId;
    await first.sidecar.stop();
    first.stopped.value = true;
    let gone = "";
    let paused = "";
    let switchedOff = "";
    {
      const o = await openLocalDb(first.dataDir);
      gone = await plantTombstone(o.db, accountId, "gone@trafficflow.test", 4);
      const oneMessage = (mailboxId: string) => o.db.insert(messages).values({
        accountId, mailboxId, bodyHash: randomUUID(), dedupKey: randomUUID(),
        subject: "kept", fromAddress: "friend@elsewhere.test", nativeLocator: { folder: "INBOX", ref: "1:5" },
      } as never);
      /* A pause superseded by a live row on the same address: `disabled` WITH a reason, which is
         the same mailbox and must keep every message. */
      const [p] = await o.db.insert(mailboxes).values({
        accountId, provider: "imap", address: "owner@trafficflow.test", status: "disabled",
        disabledReason: "organized_elsewhere:local",
      }).returning({ id: mailboxes.id });
      paused = p!.id;
      await oneMessage(paused);
      /* A mailbox switched off by a plain status PATCH: `disabled`, no reason, its credential kept.
         A removal deletes the credential with the tombstone; this is not one. */
      const [off] = await o.db.insert(mailboxes).values({
        accountId, provider: "imap", address: "off@trafficflow.test", status: "disabled", disabledReason: null,
      }).returning({ id: mailboxes.id });
      switchedOff = off!.id;
      await o.db.insert(mailboxCredentials).values({
        mailboxId: switchedOff, transport: "imap", secretEnc: "not-a-secret", keyVersion: 1,
      } as never);
      await oneMessage(switchedOff);
      await o.close();
    }

    const next = await boot(first.dataDir);
    const removed = await heldFor(next.sidecar.db, gone);
    expect(removed.messages, "the older build's removed mailbox kept its mail").toBe(0);
    expect(removed.folders).toBe(0);
    expect(removed.receipts).toBe(1);
    expect((await heldFor(next.sidecar.db, paused)).messages, "a paused mailbox lost its mail").toBe(1);
    expect((await heldFor(next.sidecar.db, switchedOff)).messages, "a switched-off mailbox lost its mail").toBe(1);
    const snap = await next.sidecar.handle(new Request("http://local/sync/snapshot", {
      headers: { authorization: `Bearer ${next.sidecar.sessionToken}` },
    }));
    const body = await snap.json() as { changes?: Array<{ type: string; entity?: { mailboxId?: string } }> };
    expect((body.changes ?? []).filter((c) => c.type === "message" && c.entity?.mailboxId === gone)).toHaveLength(0);

    /* And once is enough: a start with nothing left under the tombstone writes nothing. */
    await next.sidecar.stop();
    next.stopped.value = true;
    const again = await boot(first.dataDir);
    expect((await heldFor(again.sidecar.db, gone)).receipts).toBe(1);
    expect(again.lines.some((l) => l.event === "local_mirror_wipe_finished")).toBe(false);
  });

  it("Remove on a removed mailbox with no runtime still clears what it left", async () => {
    const rig = await organizing();
    const gone = await plantTombstone(rig.sidecar.db, rig.sidecar.world.accountId, "gone@trafficflow.test", 3);
    const credsBefore = (await rig.sidecar.db.select({ id: mailboxCredentials.mailboxId }).from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, rig.mailboxId))).length;

    expect(await remove(rig, gone)).toEqual({ status: 200, code: null });
    const held = await heldFor(rig.sidecar.db, gone);
    expect(held.messages, "the press answered removed and left the mail").toBe(0);
    expect(held.folders).toBe(0);
    expect(held.receipts).toBe(1);
    expect((await heldFor(rig.sidecar.db, rig.mailboxId)).messages, "the live mailbox lost mail").toBe(N);
    expect(rig.meta.count, "the live mailbox's claim was given back").toBe(1);
    const credsAfter = (await rig.sidecar.db.select({ id: mailboxCredentials.mailboxId }).from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, rig.mailboxId))).length;
    expect(credsAfter, "the live mailbox lost its credential").toBe(credsBefore);
  });
});
