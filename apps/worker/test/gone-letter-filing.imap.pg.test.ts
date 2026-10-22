import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, folderState, mailboxes, messageInstances, messages } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable } from "@trafficflow/db/testing";
import { MailboxService, MessageService, type ServiceContext } from "@trafficflow/services";
import { runSyncCycle, type SyncDeps } from "../src/sync.js";
import { makeHarness, rawClient, uidInFolder, DB_URL, ORGANIZER_CONSENT } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A DELETE PRESSED ON A LETTER THE SERVER NO LONGER HOLDS IS CLOSED AT THE NEXT PASS.
 *
 * A real mail server, the worker's own cycle and the lane's Postgres. The Sent reply is deleted in
 * ohmail and then removed by another mail app; its filing must leave the count at the next cycle
 * as `reconcile.move.voided`, never as a refusal. Controls: a message the server still holds files
 * to Trash, and a move the server really refuses keeps its class.
 */

const AVAILABLE = await realPgAvailable(DB_URL);

function eml(o: { from: string; to: string; subject: string; messageId: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`,
    "Content-Type: text/plain; charset=utf-8", "", "the whole text of the message",
  ].join("\r\n");
}

// A harness on GreenMail and Postgres per case, no wait of its own: 1.0-2.7 s each on the CI VMs.
describe.skipIf(!AVAILABLE)("a filing for a letter the server no longer holds (GreenMail + real Postgres)", { timeout: 30_000 }, () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  async function world() {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    await h.db.update(mailboxes).set(ORGANIZER_CONSENT).where(eq(mailboxes.id, h.mailboxId));
    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout().catch(() => undefined); });
    await c.mailboxCreate("Sent").catch(() => undefined);
    await c.mailboxCreate("Trash").catch(() => undefined);
    const special = await h.adapter.findSpecialFolders();
    expect(special.trash, "the precondition: Trash was discovered").toBeTruthy();
    await h.repo.setMailboxSpecialFolders!(h.mailboxId, { junkFolder: special.junk, trashFolder: special.trash, sentFolder: null });
    const deps: SyncDeps = {
      repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId,
      storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    };
    const ctx: ServiceContext = { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "gone" };
    const idOf = async (header: string) => (await h.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.mailboxId, h.mailboxId), eq(messages.messageIdHeader, header))))[0]?.id;
    const filingOf = async (id: string) =>
      (await h.db.select().from(folderState).where(eq(folderState.messageId, id)))[0];
    const auditsOf = async (id: string) => (await h.db.select({ action: auditLog.action, payload: auditLog.payload })
      .from(auditLog).where(eq(auditLog.accountId, h.accountId)))
      .filter((r) => (r.payload as { messageId?: string } | null)?.messageId === id).map((r) => r.action);
    const facts = async () => (await new MailboxService({ signatureChecks: false }).list(ctx, { counts: true }))
      .find((m) => m.id === h.mailboxId)!;
    const expunge = async (folder: string, header: string) => {
      const uids = await uidInFolder(c, folder, header);
      expect(uids, `the precondition: ${folder} holds the message`).toHaveLength(1);
      const l = await c.getMailboxLock(folder);
      try { await c.messageDelete(uids, { uid: true }); } finally { l.release(); }
    };
    return { h, c, deps, ctx, idOf, filingOf, auditsOf, facts, expunge, trash: special.trash! };
  }

  it("the Delete of a Sent reply another app removed is voided at the next cycle; a held message files", async () => {
    const w = await world();
    const tag = randomUUID().slice(0, 8);
    const sentHeader = `sent-${tag}@trafficflow.test`;
    const inboxHeader = `inbox-${tag}@x.example`;
    await w.c.append("Sent", eml({ from: w.h.cfg.auth.user, to: "anna@x.example", subject: `Re: gone ${tag}`, messageId: sentHeader }), ["\\Seen"]);
    await w.c.append("INBOX", eml({ from: "anna@x.example", to: w.h.cfg.auth.user, subject: `gone ${tag}`, messageId: inboxHeader }));
    await runSyncCycle(w.deps);
    await runSyncCycle(w.deps);   // the steady state: the Sent watermark is published
    const sent = await w.idOf(sentHeader);
    const inbox = await w.idOf(inboxHeader);
    expect(sent, "the precondition: the Sent reply was ingested").toBeDefined();
    expect(inbox, "the precondition: the INBOX message was ingested").toBeDefined();

    const svc = new MessageService();
    await svc.delete(w.ctx, sent!);
    await svc.delete(w.ctx, inbox!);
    expect((await w.filingOf(sent!))?.reconcileStatus, "the precondition: the Delete wrote an intent").toBe("pending");
    // Another mail app removes the Sent reply AFTER the intent was written.
    await w.expunge("Sent", sentHeader);

    await runSyncCycle(w.deps);

    const gone = await w.filingOf(sent!);
    expect(gone?.reconcileStatus, "the filing for a letter the server no longer holds is still outstanding").toBe("reconciled");
    expect(gone?.attempts, "a gone letter was counted as a refusal").toBe(0);
    expect(gone?.lastErrorClass ?? null, "a gone letter was blamed on the mail server").toBeNull();
    expect(await w.auditsOf(sent!), "the void is not on record").toContain("reconcile.move.voided");
    const f = await w.facts();
    expect(f.pendingMoves, "the strip still counts the gone letter").toBe(0);
    expect(f.filing?.due, "the gone letter is still due").toBe(0);
    // CONTROL — the message the server still held filed to Trash.
    expect((await w.filingOf(inbox!))?.reconcileStatus).toBe("reconciled");
    expect(await uidInFolder(w.c, w.trash, inboxHeader), "the held message did not reach Trash").toHaveLength(1);
    expect(await uidInFolder(w.c, "INBOX", inboxHeader)).toHaveLength(0);
  });

  it("a gone letter whose delete ingest never reports is closed by the move's own reading", async () => {
    const w = await world();
    const tag = randomUUID().slice(0, 8);
    const header = `blind-${tag}@x.example`;
    await w.c.append("INBOX", eml({ from: "anna@x.example", to: w.h.cfg.auth.user, subject: `blind ${tag}`, messageId: header }));
    await runSyncCycle(w.deps);
    const id = await w.idOf(header);
    expect(id, "the precondition: ingested").toBeDefined();
    await new MessageService().delete(w.ctx, id!);
    await w.expunge("INBOX", header);
    // Ingest that cannot see this delete — the shape 0.25.2's Sent scan had. Everything else is
    // the real adapter against the real server.
    const real = w.h.adapter;
    const blind = new Proxy(real, {
      get(target, prop) {
        if (prop === "changesSince") {
          return async (cursor: Parameters<typeof real.changesSince>[0]) =>
            ({ ...(await target.changesSince(cursor)), deletes: [] });
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });

    await runSyncCycle({ ...w.deps, adapter: blind });

    const row = await w.filingOf(id!);
    expect(row?.reconcileStatus, "the move found no copy and the filing still waits on ingest").toBe("reconciled");
    expect(row?.attempts).toBe(0);
    expect(row?.lastErrorClass ?? null).toBeNull();
    const voided = (await w.h.db.select({ action: auditLog.action, payload: auditLog.payload }).from(auditLog)
      .where(eq(auditLog.accountId, w.h.accountId)))
      .find((r) => r.action === "reconcile.move.voided" && (r.payload as { messageId?: string }).messageId === id);
    expect((voided?.payload as { evidence?: string } | undefined)?.evidence).toBe("absent_at_move");
    expect((await w.facts()).pendingMoves).toBe(0);
    // The disappearance is still ingest's to record: the pass wrote no instance change.
    const instances = await w.h.db.select().from(messageInstances).where(eq(messageInstances.messageId, id!));
    expect(instances, "the move's reading rewrote the instance record").toHaveLength(1);
  });

  it("onlyInstanceAt answers for the recorded copies, and a second copy makes it false", async () => {
    const w = await world();
    const tag = randomUUID().slice(0, 8);
    const header = `copies-${tag}@x.example`;
    await w.c.append("INBOX", eml({ from: "anna@x.example", to: w.h.cfg.auth.user, subject: `copies ${tag}`, messageId: header }));
    await runSyncCycle(w.deps);
    const id = await w.idOf(header);
    const [m] = await w.h.db.select({ loc: messages.nativeLocator }).from(messages).where(eq(messages.id, id!));
    const loc = m!.loc as { folder: string; ref: string };
    expect(await w.h.repo.onlyInstanceAt!(id!, loc), "its one copy").toBe(true);
    expect(await w.h.repo.onlyInstanceAt!(id!, { folder: loc.folder, ref: `${loc.ref}9` }), "a UID it is not at").toBe(false);
    const [epoch, uid] = loc.ref.split(":");
    expect(await w.h.repo.onlyInstanceAt!(id!, { folder: loc.folder, ref: `${BigInt(epoch!) + 1n}:${uid}` }),
      "the same UID under another epoch").toBe(false);
    await w.h.repo.recordInstance(id!, { folder: "ohmail/News", ref: `${loc.ref.split(":")[0]}:999` });
    expect(await w.h.repo.onlyInstanceAt!(id!, loc), "a second recorded copy").toBe(false);
  });

  it("CONTROL — a move the server refuses keeps its class and its schedule", async () => {
    const w = await world();
    const tag = randomUUID().slice(0, 8);
    const header = `refused-${tag}@x.example`;
    await w.c.append("INBOX", eml({ from: "anna@x.example", to: w.h.cfg.auth.user, subject: `refused ${tag}`, messageId: header }));
    await runSyncCycle(w.deps);
    const id = await w.idOf(header);
    expect(id, "the precondition: ingested").toBeDefined();
    // A destination the server does not have: the move is refused, the message is still there.
    await w.h.db.insert(folderState).values({
      messageId: id!, desiredFolder: `Missing-${tag}`, observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    }).onConflictDoUpdate({
      target: folderState.messageId,
      set: { desiredFolder: `Missing-${tag}`, lastSetBy: "us", reconcileStatus: "pending" },
    });

    await runSyncCycle(w.deps);

    const row = await w.filingOf(id!);
    expect(row?.reconcileStatus, "a refused move was closed").toBe("pending");
    expect(row?.attempts, "a refused move earned no attempt").toBe(1);
    expect(row?.lastErrorClass, "a refused move lost its class").not.toBeNull();
    expect(await w.auditsOf(id!)).toContain("reconcile.move.failed");
    expect(await w.auditsOf(id!)).not.toContain("reconcile.move.voided");
    const f = await w.facts();
    expect(f.filing?.lastRefusalClass, "the strip cannot name the refusal").toBe(row?.lastErrorClass);
    expect(f.filing?.stuck, "one refusal a minute old is not stuck").toBe(0);
    // Past five minutes the row is stuck, and the stuck count carries its own class.
    const aged = new Date(Date.now() - 10 * 60_000);
    await w.h.db.update(folderState).set({ updatedAt: aged }).where(eq(folderState.messageId, id!));
    const g = await w.facts();
    expect(g.filing?.stuck).toBe(1);
    expect(g.filing?.stuckSince).toBe(aged.toISOString());
    expect(g.filing?.stuckRefusalClass).toBe(row?.lastErrorClass);
  });
});
