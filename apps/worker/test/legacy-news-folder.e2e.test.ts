import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { auditLog, contacts, folderState, mailboxFolders, mailboxes, messageInstances, messages } from "@trafficflow/db";
import { serviceUp } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { LEGACY_NEWS_FOLDER, NEWS_FOLDER } from "@trafficflow/core/folder-name";
import { MessageService, SearchService, readMailboxFilings, type ServiceContext } from "@trafficflow/services";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";
import { ORGANIZER_CONSENT } from "./_workerdb.js";
import { greenmailPorts } from "./_greenmail-ports.js";
import { world } from "../../../packages/api/test/_self-check-world.js";
import { selfCheckMailbox } from "../../../packages/api/src/mailbox-self-check.js";

/**
 * THE NEWS RENAME'S TAIL, END TO END: the real adapter over GreenMail, the worker's cycle on this
 * project's store (PGlite; the phone's SQLite in `test:sqlite`) and the API's self-check.
 *
 *  · A store a pre-0.22 build wrote keeps rows labelled `ohmail/Reads` after the server rename.
 *    Asked through the pile resolver the old folder was News, so its row stayed for ever and the
 *    check read News' count against it. Asked by its own name it is gone, and its letters move.
 *  · A physical `ohmail/Reads` re-made beside News (another hand filed letters there) was read by
 *    nothing while the organizer stayed connected. The organizer folds it into News; a reader never.
 */

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

const eml = (id: string) => [
  `Message-ID: <${id}@x>`, "From: news@letters.example", "To: me@x.example", `Subject: rename tail ${id}`,
  "Date: Sun, 27 Sep 2026 04:30:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "a letter",
].join("\r\n");

type Role = "reader" | "organizer";

async function rig() {
  const p = greenmailPorts();
  const user = `t-${randomUUID()}@trafficflow.test`;
  const cfg = { host: p.imapHost, port: p.imapPort, secure: false, auth: { user, pass: "test" } };
  const raw = new ImapFlow({ ...cfg, logger: false });
  await raw.connect();
  closers.push(() => raw.logout());
  const w = await world({ name: "GreenMail", host: cfg.host, port: cfg.port, user: () => user, pass: "test" }, user);
  // A known correspondent, so the organizer leaves the letters where they are.
  await w.db.insert(contacts).values({ accountId: w.accountId, address: "news@letters.example" });
  const repo = makeDrizzleRepo(w.db as never);
  const cycle = (adapter: ImapAdapter, role: Role) => runSyncCycle({
    repo, adapter, accountId: w.accountId, mailboxId: w.mailboxId, role,
    writeAuthority: role === "reader" ? { noLease: "reader" as const } : FIXTURE_LEASE,
    storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(), signatures: null,
  });
  const drain = async (adapter: ImapAdapter, role: Role) => {
    for (let i = 0; i < 10; i++) {
      const out = await cycle(adapter, role);
      if (!out.hasBacklog && !out.owesFiling) return;
    }
    throw new Error("the drain did not settle in ten cycles");
  };
  const open = async (role: Role) => {
    const a = new ImapAdapter(cfg);
    await a.connect();
    closers.push(() => a.close());
    if (role === "organizer") await a.ensureFolders(FIXTURE_DOOR);
    return a;
  };
  const ctx: ServiceContext = { db: w.db as never, accountId: w.accountId, userId: null, now: () => new Date(), requestId: "tail" };
  const live = async () => (await w.db.select({ s: messages.subject, d: messages.deletedAt }).from(messages)
    .where(eq(messages.mailboxId, w.mailboxId))).filter((r) => r.d === null).map((r) => r.s).sort();
  const listed = async () => (await new MessageService().list(ctx, { view: "all", limit: 50 })).items.length;
  const found = async () => (await new SearchService().search(ctx, { q: "tail", limit: 50 })).items.length;
  const folderRows = async () => (await w.db.select({ f: mailboxFolders.folder }).from(mailboxFolders)
    .where(eq(mailboxFolders.mailboxId, w.mailboxId))).map((r) => r.f).sort();
  const legacyRows = async () => (await w.db.select({ id: messageInstances.id }).from(messageInstances)
    .where(and(eq(messageInstances.mailboxId, w.mailboxId), eq(messageInstances.folder, LEGACY_NEWS_FOLDER)))).length;
  const serverOhmail = async () => (await raw.list()).map((f) => f.path).filter((x) => x.startsWith("ohmail")).sort();
  // The desktop engine's admission port: the hosted counter's table is the cloud journal's alone.
  const deps = { ...w.deps, services: { ...w.deps.services, imapAdmission: { acquire: async () => true, release: async () => {} } } };
  const check = () => selfCheckMailbox(deps as typeof w.deps, w.accountId, w.mailboxId);
  /** Label the store the way a pre-0.22 build wrote it; `filed` adds that organizer's folder_state rows. */
  const asPre022 = async (filed = false) => {
    const { db, mailboxId } = w;
    await db.update(messageInstances).set({ folder: LEGACY_NEWS_FOLDER })
      .where(and(eq(messageInstances.mailboxId, mailboxId), eq(messageInstances.folder, NEWS_FOLDER)));
    await db.update(mailboxFolders).set({ folder: LEGACY_NEWS_FOLDER })
      .where(and(eq(mailboxFolders.mailboxId, mailboxId), eq(mailboxFolders.folder, NEWS_FOLDER)));
    for (const m of await db.select({ id: messages.id, loc: messages.nativeLocator }).from(messages).where(eq(messages.mailboxId, mailboxId))) {
      const loc = m.loc as { folder: string; ref: string } | null;
      if (loc?.folder === NEWS_FOLDER) await db.update(messages).set({ nativeLocator: { ...loc, folder: LEGACY_NEWS_FOLDER } }).where(eq(messages.id, m.id));
      if (filed) {
        const row = { desiredFolder: LEGACY_NEWS_FOLDER, observedFolder: LEGACY_NEWS_FOLDER, lastSetBy: "us", reconcileStatus: "reconciled" } as const;
        await db.insert(folderState).values({ messageId: m.id, ...row })
          .onConflictDoUpdate({ target: folderState.messageId, set: row });
      }
    }
  };
  const inNews = async () => (await raw.status("ohmail.News", { messages: true })).messages ?? 0;
  const ctxOf = () => ctx;
  return { raw, w, cycle, drain, open, live, listed, found, folderRows, legacyRows, serverOhmail, check, asPre022, inNews, ctxOf };
}

const gm = greenmailPorts();
const up = serviceUp("greenmail", `${gm.imapHost}:${gm.imapPort}`);
const skip = up.up ? "" : ` (SKIPPED: ${up.why})`;

describe("the News rename's tail, end to end", { timeout: 90_000 }, () => {
  it.skipIf(!up.up)(`a pre-0.22 store after the server rename: the old row goes, every letter stays reachable${skip}`, async () => {
    const r = await rig();
    await r.raw.mailboxCreate("ohmail.Reads");
    for (const id of ["r1", "r2", "r3"]) await r.raw.append("ohmail.Reads", eml(id), ["\\Seen"]);
    // Ingest the pile as it stands, then label the store the way a pre-0.22 build wrote it.
    const reader = await r.open("reader");
    await r.drain(reader, "reader");
    await reader.close();
    await r.asPre022();
    expect(await r.legacyRows()).toBe(3);
    // A 0.22+ organizer attaches (the server rename), drains; two letters arrive in News later.
    const org = await r.open("organizer");
    expect(await r.serverOhmail()).not.toContain("ohmail.Reads");
    await r.drain(org, "organizer");
    for (const id of ["n4", "n5"]) await r.raw.append("ohmail.News", eml(id), ["\\Seen"]);
    await r.drain(org, "organizer");
    await r.drain(org, "organizer");

    expect(await r.folderRows()).not.toContain(LEGACY_NEWS_FOLDER);
    expect(await r.legacyRows()).toBe(0);
    expect(await r.live()).toEqual(["n4", "n5", "r1", "r2", "r3"].map((id) => `rename tail ${id}`));
    expect(await r.listed()).toBe(5);
    expect(await r.found()).toBe(5);
    const c = await r.check();
    expect(c.verdict, JSON.stringify(c.folders)).toBe("in_step");
    expect(c.folders.map((f) => f.folder)).not.toContain(LEGACY_NEWS_FOLDER);
  });

  it.skipIf(!up.up)(`letters a pre-0.22 organizer filed stay on the server through the first pass that retires the old row${skip}`, async () => {
    const r = await rig();
    await r.raw.mailboxCreate("ohmail.Reads");
    for (const id of ["r1", "r2", "r3"]) await r.raw.append("ohmail.Reads", eml(id), ["\\Seen"]);
    const reader = await r.open("reader");
    await r.drain(reader, "reader");
    await reader.close();
    await r.asPre022(true);
    const org = await r.open("organizer");
    await r.drain(org, "organizer");
    await r.drain(org, "organizer");

    expect(await r.inNews()).toBe(3);
    expect(await r.live()).toEqual(["r1", "r2", "r3"].map((id) => `rename tail ${id}`));
    expect(await r.legacyRows()).toBe(0);
    const pending = await r.w.db.select({ s: folderState.reconcileStatus }).from(folderState);
    expect(pending.map((p) => p.s)).toEqual(["reconciled", "reconciled", "reconciled"]);
  });

  it.skipIf(!up.up)(`a move away and its Undo on such a letter, before the organizer files, keep it in News${skip}`, async () => {
    const r = await rig();
    await r.raw.mailboxCreate("ohmail.News");
    for (const id of ["u1", "u2"]) await r.raw.append("ohmail.News", eml(id), ["\\Seen"]);
    const org = await r.open("organizer");
    await r.drain(org, "organizer");
    await r.asPre022(true);
    await r.drain(org, "organizer");
    const [m] = await r.w.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.mailboxId, r.w.mailboxId), eq(messages.subject, "rename tail u1")));
    const svc = new MessageService();
    await svc.move(r.ctxOf(), m!.id, { folder: "ohmail/Receipts" });
    // The Undo names the mirror's folder for the letter: the old spelling.
    await svc.move(r.ctxOf(), m!.id, { folder: LEGACY_NEWS_FOLDER });
    await r.drain(org, "organizer");
    await r.drain(org, "organizer");

    expect(await r.inNews()).toBe(2);
    expect(await r.live()).toEqual(["u1", "u2"].map((id) => `rename tail ${id}`));
  });

  it.skipIf(!up.up)(`ohmail/Reads re-made beside News: the connected organizer folds it in within one LIST refresh${skip}`, async () => {
    const r = await rig();
    await r.raw.mailboxCreate("ohmail.News");
    await r.raw.append("ohmail.News", eml("n1"), ["\\Seen"]);
    const org = await r.open("organizer");
    await r.drain(org, "organizer");
    // Another hand (an older install, another client, a server rule) files two letters there.
    await r.raw.mailboxCreate("ohmail.Reads");
    for (const id of ["r1", "r2"]) await r.raw.append("ohmail.Reads", eml(id), ["\\Seen"]);
    for (let i = 0; i < 25 && (await r.live()).length < 3; i++) await r.cycle(org, "organizer");
    await r.drain(org, "organizer");

    expect(await r.live()).toEqual(["n1", "r1", "r2"].map((id) => `rename tail ${id}`));
    // Swept, never deleted between attaches: a DELETE would take a letter filed there meanwhile.
    expect(await r.serverOhmail()).toContain("ohmail.Reads");
    expect((await r.raw.status("ohmail.Reads", { messages: true })).messages).toBe(0);
    expect(await r.inNews()).toBe(3);
    expect(await r.found()).toBe(3);
    expect((await r.check()).verdict).toBe("in_step");
  });

  it.skipIf(!up.up)(`a reader folds nothing, and the check says where the letters are${skip}`, async () => {
    const r = await rig();
    await r.raw.mailboxCreate("ohmail.News");
    await r.raw.append("ohmail.News", eml("n1"), ["\\Seen"]);
    await r.raw.mailboxCreate("ohmail.Reads");
    for (const id of ["r1", "r2"]) await r.raw.append("ohmail.Reads", eml(id), ["\\Seen"]);
    const reader = await r.open("reader");
    for (let i = 0; i < 3; i++) await r.drain(reader, "reader");

    expect(await r.live()).toEqual(["rename tail n1"]);
    expect(await r.serverOhmail()).toContain("ohmail.Reads");
    const c = await r.check();
    expect(c.folders.find((f) => f.folder === LEGACY_NEWS_FOLDER))
      .toEqual({ folder: LEGACY_NEWS_FOLDER, k: "server_more", server: 2, mirror: 0, predecessorOf: NEWS_FOLDER });
  });
});

/* FOLDER-MISSING-FILINGS: another client deletes one of ohmail's own folders while a filing into
   it waits. imapflow keeps the server's `[TRYCREATE]` to its logger, so the organizer read every
   such filing as "your mail server refused it" for good. It makes its own folder again (once, under
   the lease, audited) and files; a folder of the person's is never made, and its reason is named. */
describe("a deleted folder under a waiting filing, end to end", { timeout: 90_000 }, () => {
  const idOf = async (r: Awaited<ReturnType<typeof rig>>, subject: string) => (await r.w.db.select({ id: messages.id })
    .from(messages).where(and(eq(messages.mailboxId, r.w.mailboxId), eq(messages.subject, subject))))[0]!.id;
  const actions = async (r: Awaited<ReturnType<typeof rig>>) => (await r.w.db.select({ a: auditLog.action }).from(auditLog)
    .where(eq(auditLog.accountId, r.w.accountId))).map((x) => x.a);
  const uidsIn = async (r: Awaited<ReturnType<typeof rig>>, path: string) => {
    const l = await r.raw.getMailboxLock(path);
    try { return ((await r.raw.search({ all: true }, { uid: true })) || []).length; } finally { l.release(); }
  };
  const settled = async (r: Awaited<ReturnType<typeof rig>>, role: Role = "organizer") => {
    await r.w.db.update(mailboxes).set(role === "organizer" ? ORGANIZER_CONSENT : { organizerRole: "reader" }).where(eq(mailboxes.id, r.w.mailboxId));
    const a = await r.open(role);
    await r.drain(a, role);
    return a;
  };

  it.skipIf(!up.up)(`ohmail/Screened deleted: the organizer makes it again and files there${skip}`, async () => {
    const r = await rig();
    await r.raw.append("INBOX", eml("s1"), ["\\Seen"]);
    const org = await settled(r);
    await r.raw.mailboxDelete("ohmail.Screened");
    await new MessageService().move(r.ctxOf(), await idOf(r, "rename tail s1"), { folder: "ohmail/Screened" });
    await r.drain(org, "organizer");

    expect(await r.serverOhmail()).toContain("ohmail.Screened");
    expect(await uidsIn(r, "ohmail.Screened")).toBe(1);
    expect(await uidsIn(r, "INBOX")).toBe(0);
    expect((await r.w.db.select({ s: folderState.reconcileStatus }).from(folderState)).map((x) => x.s)).toEqual(["reconciled"]);
    const did = await actions(r);
    expect(did.filter((a) => a === "reconcile.folder.remade")).toHaveLength(1);
    expect(did).not.toContain("reconcile.move.failed");
    await r.drain(org, "organizer");
    expect((await r.check()).verdict).toBe("in_step");
  });

  it.skipIf(!up.up)(`three letters into the deleted folder take one CREATE${skip}`, async () => {
    const r = await rig();
    for (const id of ["t1", "t2", "t3"]) await r.raw.append("INBOX", eml(id), ["\\Seen"]);
    const org = await settled(r);
    await r.raw.mailboxDelete("ohmail.Screened");
    const svc = new MessageService();
    for (const id of ["t1", "t2", "t3"]) await svc.move(r.ctxOf(), await idOf(r, `rename tail ${id}`), { folder: "ohmail/Screened" });
    await r.drain(org, "organizer");

    expect(await uidsIn(r, "ohmail.Screened")).toBe(3);
    expect((await actions(r)).filter((a) => a === "reconcile.folder.remade")).toHaveLength(1);
  });

  it.skipIf(!up.up)(`a deleted folder of the person's is not made again, and its reason is named${skip}`, async () => {
    const r = await rig();
    await r.raw.append("INBOX", eml("p1"), ["\\Seen"]);
    const org = await settled(r);
    // No verb files into a folder of the person's; an intent naming one (an import's) is written as stored.
    const row = { desiredFolder: "Archive", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending" } as const;
    await r.w.db.insert(folderState).values({ messageId: await idOf(r, "rename tail p1"), ...row })
      .onConflictDoUpdate({ target: folderState.messageId, set: row });
    await r.drain(org, "organizer");

    expect((await r.raw.list()).map((f) => f.path)).not.toContain("Archive");
    expect(await uidsIn(r, "INBOX")).toBe(1);
    expect((await r.w.db.select({ c: folderState.lastErrorClass }).from(folderState)).map((x) => x.c)).toEqual(["no_such_folder"]);
    const filings = await readMailboxFilings(r.ctxOf(), r.w.mailboxId);
    expect(filings.groups.map((g) => [g.folder, g.at, g.reasons])).toEqual([["Archive", "INBOX", [{ reason: "no_such_folder", count: 1 }]]]);
    expect(await actions(r)).not.toContain("reconcile.folder.remade");
  });

  it.skipIf(!up.up)(`a reader makes nothing${skip}`, async () => {
    const r = await rig();
    await r.raw.append("INBOX", eml("d1"), ["\\Seen"]);
    const org = await settled(r);
    await org.close();
    await r.raw.mailboxDelete("ohmail.Screened");
    await new MessageService().move(r.ctxOf(), await idOf(r, "rename tail d1"), { folder: "ohmail/Screened" });
    await settled(r, "reader");

    expect(await r.serverOhmail()).not.toContain("ohmail.Screened");
    expect(await actions(r)).not.toContain("reconcile.folder.remade");
  });
});

