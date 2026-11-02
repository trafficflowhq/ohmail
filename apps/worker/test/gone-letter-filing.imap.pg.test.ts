import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import type { NativeLocator } from "@trafficflow/core";
import { MessageGoneError, type MoveManyResult } from "@trafficflow/core/adapters/imap";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, folderState, mailboxes, messageBodies, messageInstances, messages } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable } from "@trafficflow/db/testing";
import { MailboxService, MessageService, SearchService, type ServiceContext } from "@trafficflow/services";
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

function eml(o: { from: string; to: string; subject: string; messageId: string; date?: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`,
    ...(o.date !== undefined ? [`Date: ${o.date}`] : []),
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
    await c.mailboxCreate("Junk").catch(() => undefined);
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
    /** Letters marked Spam and filed into Junk by the cycle: their ids, and the subject word. */
    const spamFiled = async (n: number) => {
      const tag = randomUUID().slice(0, 8);
      const headers = Array.from({ length: n }, (_, i) => `spam${i}-${tag}@x.example`);
      for (const header of headers) {
        await c.append("INBOX", eml({ from: "anna@x.example", to: h.cfg.auth.user, subject: `junkword${tag}`, messageId: header }));
      }
      await runSyncCycle(deps);
      const ids: string[] = [];
      for (const header of headers) ids.push((await idOf(header))!);
      for (const id of ids) await new MessageService().move(ctx, id, { folder: "ohmail/Quarantine" });
      await runSyncCycle(deps);
      for (const header of headers) expect(await uidInFolder(c, "Junk", header), "the precondition: filed into Junk").toHaveLength(1);
      return { ids, headers, word: `junkword${tag}` };
    };
    const history = async () => (await new MessageService().listAll(ctx, { limit: 100 })).items.map((m) => m.id);
    const found = async (q: string) => (await new SearchService().search(ctx, { q, limit: 50 })).items.map((m) => m.id);
    const trashed = async () => (await new MessageService().listTrash(ctx, { view: "trash" })).items.map((t) => t.id);
    const withheld = async (id: string) => (await h.db.select({ w: messageBodies.withheldReason }).from(messageBodies)
      .where(eq(messageBodies.messageId, id)))[0]?.w ?? null;
    const stored = async (id: string) => (await h.db.select({ deletedAt: messages.deletedAt, loc: messages.nativeLocator })
      .from(messages).where(eq(messages.id, id)))[0];
    /** Letters deleted in ohmail whose deletes landed in the server's Trash. */
    const deletedInto = async (n: number) => {
      const tag = randomUUID().slice(0, 8);
      const headers = Array.from({ length: n }, (_, i) => `trash${i}-${tag}@x.example`);
      for (const header of headers) {
        await c.append("INBOX", eml({ from: "anna@x.example", to: h.cfg.auth.user, subject: `trash ${tag}`, messageId: header }));
      }
      await runSyncCycle(deps);
      const ids: string[] = [];
      for (const header of headers) ids.push((await idOf(header))!);
      for (const id of ids) await new MessageService().delete(ctx, id);
      await runSyncCycle(deps);
      for (const header of headers) expect(await uidInFolder(c, special.trash!, header), "the precondition: in Trash").toHaveLength(1);
      return { ids, headers };
    };
    /** A letter in INBOX and in a second watched folder, on a server that drops the second copy when one goes to Trash (Gmail's labels). */
    const twoCopies = async () => {
      const second = (await c.list()).find((f) => /News$/.test(f.path))?.path ?? "ohmail/News";
      const header = `two-${randomUUID().slice(0, 8)}@x.example`;
      const raw = eml({ from: "anna@x.example", to: h.cfg.auth.user, subject: "two copies", messageId: header });
      await c.append("INBOX", raw);
      await c.append(second, raw);
      const dropSecond = async (to: unknown) => {
        if (to !== special.trash || (await uidInFolder(c, second, header)).length === 0) return;
        await expunge(second, header);
      };
      const gmail = new Proxy(h.adapter, {
        get(target, prop) {
          if (prop === "move" || prop === "moveMany") {
            const fn = Reflect.get(target, prop, target) as (...a: unknown[]) => Promise<unknown>;
            return async (...a: unknown[]) => { const out = await fn.apply(target, a); await dropSecond(a[1]); return out; };
          }
          const v = Reflect.get(target, prop, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      const twoDeps = { ...deps, adapter: gmail };
      await runSyncCycle(twoDeps);
      await runSyncCycle(twoDeps);
      const id = (await idOf(header))!;
      expect(await h.db.select().from(messageInstances).where(eq(messageInstances.messageId, id)),
        "the precondition: two watched copies").toHaveLength(2);
      return { id, header, deps: twoDeps };
    };
    return {
      h, c, deps, ctx, idOf, filingOf, auditsOf, facts, expunge, spamFiled, history, found, trashed, withheld, stored,
      deletedInto, twoCopies, trash: special.trash!,
    };
  }

  it("a letter deleted in ohmail and then removed from Trash by another app leaves Trash; one still there stays", async () => {
    const w = await world();
    const { ids: [a, b], headers: [ha, hb] } = await w.deletedInto(2);
    expect(await w.trashed(), "the precondition: both are in Trash").toEqual(expect.arrayContaining([a, b]));
    const before = await w.stored(a!);
    await w.expunge(w.trash, ha!);
    await runSyncCycle(w.deps);

    const svc = new MessageService();
    expect(await w.trashed(), "Trash lists a letter no server holds").not.toContain(a);
    expect(await w.withheld(a!), "the gone letter's text is still kept").toBe("expunged");
    expect(await w.filingOf(a!)).toBeUndefined();
    expect(await w.stored(a!), "the deletion time or the locator changed").toEqual(before);
    await expect(svc.restore(w.ctx, a!)).rejects.toMatchObject({ code: "not_in_trash", httpStatus: 409 });
    expect(await svc.delete(w.ctx, a!)).toMatchObject({ alreadyGone: true });
    // CONTROL — the letter the server still holds stays with its text, and its restore lands.
    expect(await w.trashed()).toContain(b);
    expect(await w.withheld(b!)).toBeNull();
    await svc.restore(w.ctx, b!);
    await runSyncCycle(w.deps);
    expect(await uidInFolder(w.c, "INBOX", hb!), "the held letter's restore did not land").toHaveLength(1);
    expect(await w.history()).toContain(b);
  });

  it("a Restore pressed after another app removed the letter from Trash takes it out of Trash", async () => {
    const w = await world();
    const { ids: [a], headers: [ha] } = await w.deletedInto(1);
    const svc = new MessageService();
    await w.expunge(w.trash, ha!);
    await svc.restore(w.ctx, a!);
    await runSyncCycle(w.deps);
    expect(await w.trashed(), "the gone letter came back to Trash for a visit").not.toContain(a);
    await runSyncCycle(w.deps);

    expect(await w.trashed(), "the gone letter came back to Trash").not.toContain(a);
    expect(await w.withheld(a!)).toBe("expunged");
    expect((await w.facts()).pendingMoves).toBe(0);
    expect(await w.auditsOf(a!)).toContain("reconcile.move.voided");
    await expect(svc.restore(w.ctx, a!)).rejects.toMatchObject({ code: "not_in_trash", httpStatus: 409 });
  });

  it("a Trash folder that cannot be read, is deleted or is re-created drops nothing", async () => {
    const w = await world();
    const first = await w.deletedInto(1);
    await w.expunge(w.trash, first.headers[0]!);
    const deaf = new Proxy(w.h.adapter, {
      get(target, prop) {
        if (prop === "uidsHeld") return async () => ({ k: "unanswered" as const });
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await runSyncCycle({ ...w.deps, adapter: deaf });
    expect(await w.trashed(), "an unanswered Trash read dropped a letter").toContain(first.ids[0]);
    expect(await w.withheld(first.ids[0]!)).toBeNull();

    const second = await w.deletedInto(1);
    await w.c.mailboxDelete(w.trash);
    await runSyncCycle(w.deps);
    expect(await w.trashed(), "a deleted Trash folder dropped a letter").toContain(second.ids[0]);

    await w.c.mailboxCreate(w.trash);
    const st = await w.c.status(w.trash, { uidValidity: true });
    const at = (await w.stored(second.ids[0]!))!.loc as { ref: string };
    expect(String(st.uidValidity), "the precondition: a new UIDVALIDITY").not.toBe(at.ref.split(":")[0]);
    await runSyncCycle(w.deps);
    expect(await w.trashed(), "a re-created Trash folder (new UIDVALIDITY) dropped a letter").toContain(second.ids[0]);
    expect(await w.withheld(second.ids[0]!)).toBeNull();
  });

  it("a letter another app moved out of Trash leaves Trash, then comes back where it went with its text", async () => {
    const w = await world();
    const { ids: [a], headers: [ha] } = await w.deletedInto(1);
    const [uid] = await uidInFolder(w.c, w.trash, ha!);
    const l = await w.c.getMailboxLock(w.trash);
    try { await w.c.messageMove([uid!], "INBOX", { uid: true }); } finally { l.release(); }
    // A walk that does not see the arrival yet, so the Trash check decides first.
    const frozen = new Proxy(w.h.adapter, {
      get(target, prop) {
        if (prop === "changesSince") {
          return async (cursor: Parameters<typeof target.changesSince>[0]) => ({
            ...(await target.changesSince(cursor)), creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} },
          });
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await runSyncCycle({ ...w.deps, adapter: frozen });
    expect(await w.trashed(), "the precondition: the moved letter left Trash").not.toContain(a);
    expect(await w.withheld(a!)).toBe("expunged");

    await runSyncCycle(w.deps);
    expect(await w.history(), "the letter moved to INBOX was not adopted").toContain(a);
    expect(await w.withheld(a!), "its text was not refilled").toBeNull();
    expect(await w.trashed()).not.toContain(a);
  });

  it("a Spam letter deleted in Junk by another app leaves History and Search; one still there stays", async () => {
    const w = await world();
    expect(w.h.adapter.uidsHeld, "the precondition: the adapter can ask Junk").toBeDefined();
    const { ids: [gone, kept], headers, word } = await w.spamFiled(2);
    const oldHeader = `june-${randomUUID().slice(0, 8)}@x.example`;
    await w.c.append("INBOX", eml({
      from: "anna@x.example", to: w.h.cfg.auth.user, subject: "from June", messageId: oldHeader,
      date: "Tue, 02 Jun 2026 09:00:00 +0000",
    }));
    await runSyncCycle(w.deps);
    const old = (await w.idOf(oldHeader))!;
    expect(await w.history(), "the precondition: all three are in History").toEqual(expect.arrayContaining([gone, kept, old]));
    expect(await w.found(word), "the precondition: Search finds both Spam letters").toEqual(expect.arrayContaining([gone, kept]));

    await w.expunge("Junk", headers[0]!);
    await w.expunge("INBOX", oldHeader);
    await runSyncCycle(w.deps);

    const left = await w.history();
    expect(left, "the Spam letter deleted in Junk is still in History").not.toContain(gone);
    expect(left, "the old-dated letter deleted elsewhere is still in History").not.toContain(old);
    expect(left, "the Spam letter still in Junk left History").toContain(kept);
    expect(await w.found(word)).toEqual([kept]);
    const [row] = await w.h.db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.id, gone!));
    expect(row?.deletedAt, "the gone letter was not tombstoned").not.toBeNull();
  });

  it("a Junk folder that cannot be read, is deleted or is re-created deletes nothing", async () => {
    const w = await world();
    const { ids, headers } = await w.spamFiled(1);
    await w.expunge("Junk", headers[0]!);
    const real = w.h.adapter;
    const deaf = new Proxy(real, {
      get(target, prop) {
        if (prop === "uidsHeld") return async () => ({ k: "unanswered" as const });
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    await runSyncCycle({ ...w.deps, adapter: deaf });
    expect(await w.history(), "an unanswered Junk read deleted a letter").toContain(ids[0]);

    const second = await w.spamFiled(1);
    await w.c.mailboxDelete("Junk");
    await runSyncCycle(w.deps);
    expect(await w.history(), "a deleted Junk folder deleted a letter").toContain(second.ids[0]);

    await w.c.mailboxCreate("Junk");
    const [row] = await w.h.db.select({ loc: messages.nativeLocator }).from(messages).where(eq(messages.id, second.ids[0]!));
    const st = await w.c.status("Junk", { uidValidity: true });
    expect(String(st.uidValidity), "the precondition: a new UIDVALIDITY").not.toBe((row!.loc as { ref: string }).ref.split(":")[0]);
    await runSyncCycle(w.deps);
    expect(await w.history(), "a re-created Junk folder (new UIDVALIDITY) deleted a letter").toContain(second.ids[0]);
  });

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
    // The voided delete stays where it was observed and is not listed in Trash; its body is emptied.
    expect(gone?.desiredFolder, "a voided delete still wants Trash").toBe(gone?.observedFolder);
    const trashed = (await svc.listTrash(w.ctx, {})).items.map((t) => t.id);
    expect(trashed, "Trash lists a letter no server holds").not.toContain(sent);
    const [body] = await w.h.db.select({ withheld: messageBodies.withheldReason }).from(messageBodies)
      .where(eq(messageBodies.messageId, sent!));
    expect(body?.withheld).toBe("expunged");
    // CONTROL — the message the server still held filed to Trash.
    expect(trashed, "the held message is missing from Trash").toContain(inbox);
    expect((await w.filingOf(inbox!))?.reconcileStatus).toBe("reconciled");
    expect(await uidInFolder(w.c, w.trash, inboxHeader), "the held message did not reach Trash").toHaveLength(1);
    expect(await uidInFolder(w.c, "INBOX", inboxHeader)).toHaveLength(0);
  });

  it("a deleted two-copy letter stays in Trash with its body when the server drops the second copy", async () => {
    const w = await world();
    const { id, header, deps } = await w.twoCopies();

    const svc = new MessageService();
    await svc.delete(w.ctx, id);
    for (let i = 0; i < 4; i++) await runSyncCycle(deps);

    expect(await uidInFolder(w.c, w.trash, header), "the precondition: the server's Trash holds it").toHaveLength(1);
    expect((await svc.listTrash(w.ctx, {})).items.map((t) => t.id), "Trash dropped a letter the server holds there").toContain(id);
    expect((await w.filingOf(id))?.observedFolder).toBe(w.trash);
    const [b] = await w.h.db.select({ withheld: messageBodies.withheldReason }).from(messageBodies)
      .where(eq(messageBodies.messageId, id));
    expect(b?.withheld ?? null, "the body of a letter in the server's Trash was emptied").toBeNull();
  });

  it("a Restore of a two-copy letter parked at its dropped copy goes back to Trash once, with its text", async () => {
    const w = await world();
    const t = await w.twoCopies();
    const svc = new MessageService();
    await svc.delete(w.ctx, t.id);
    await runSyncCycle(t.deps);
    await runSyncCycle(t.deps);
    expect(((await w.stored(t.id))!.loc as NativeLocator).folder, "the precondition: parked at the dropped copy").not.toBe(w.trash);
    expect(await w.trashed()).toContain(t.id);
    const count = async (action: string) => (await w.auditsOf(t.id)).filter((a) => a === action).length;
    const voided = await count("reconcile.move.voided");

    await svc.restore(w.ctx, t.id);
    await runSyncCycle(t.deps);
    await runSyncCycle(t.deps);

    expect((await w.facts()).pendingMoves, "the Restore never ends").toBe(0);
    expect(await count("reconcile.move.voided") - voided).toBe(1);
    expect(await count("reconcile.move.superseded"), "the Restore was asked again every cycle").toBe(0);
    expect(await w.trashed(), "a letter the server holds in Trash left Trash").toContain(t.id);
    expect(await w.withheld(t.id)).toBeNull();
  });

  it("a Restore whose Trash read does not answer goes back to Trash, and the next visit lets the gone letter go", async () => {
    const w = await world();
    const { ids: [a], headers: [ha] } = await w.deletedInto(1);
    await w.expunge(w.trash, ha!);
    let deaf = true;
    const adapter = new Proxy(w.h.adapter, {
      get(target, prop) {
        if (prop === "uidsHeld" && deaf) return async () => ({ k: "unanswered" as const });
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    await new MessageService().restore(w.ctx, a!);
    await runSyncCycle({ ...w.deps, adapter });
    expect(await w.trashed(), "an unanswered Trash read let a letter go").toContain(a);
    expect(await w.withheld(a!)).toBeNull();

    deaf = false;
    await runSyncCycle({ ...w.deps, adapter });
    expect(await w.trashed(), "the letter put back waited for Trash to change").not.toContain(a);
    expect(await w.withheld(a!)).toBe("expunged");
  });

  it("a deleted two-copy letter leaves Trash once another app removes its Trash copy", async () => {
    const w = await world();
    const t = await w.twoCopies();
    const svc = new MessageService();
    await svc.delete(w.ctx, t.id);
    await runSyncCycle(t.deps);
    await runSyncCycle(t.deps);
    const before = await w.stored(t.id);
    expect((before!.loc as NativeLocator).folder, "the precondition: parked at the dropped copy").not.toBe(w.trash);
    await w.expunge(w.trash, t.header);
    await runSyncCycle(t.deps);

    expect(await w.trashed(), "Trash lists a letter no server holds").not.toContain(t.id);
    expect(await w.withheld(t.id)).toBe("expunged");
    expect(await w.stored(t.id), "the deletion time or the locator changed").toEqual(before);
    await expect(svc.restore(w.ctx, t.id)).rejects.toMatchObject({ code: "not_in_trash", httpStatus: 409 });
  });

  it("a Restore whose move reads a copy Trash still holds as gone keeps the letter; the next Restore lands", async () => {
    const w = await world();
    const { ids: [a] } = await w.deletedInto(1);
    // imapflow answers a FETCH throttled four times in a row as no message: the move reads it gone.
    const throttled = new Proxy(w.h.adapter, {
      get(target, prop) {
        if (prop === "move") return async (l: NativeLocator) => { throw new MessageGoneError(l, true); };
        if (prop === "moveMany") {
          return async (ls: readonly NativeLocator[]): Promise<MoveManyResult> => ({ outcome: "batched", moved: new Map(), gone: [...ls] });
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const svc = new MessageService();
    await svc.restore(w.ctx, a!);
    await runSyncCycle({ ...w.deps, adapter: throttled });

    expect(await w.trashed(), "a letter Trash still holds left Trash").toContain(a);
    expect(await w.withheld(a!)).toBeNull();
    expect((await w.facts()).pendingMoves).toBe(0);
    await svc.restore(w.ctx, a!);
    await runSyncCycle(w.deps);
    expect(await w.history(), "the next Restore did not land").toContain(a);
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
