import { UNMETERED_STORAGE_CAP, createLogger } from "@trafficflow/core/mail";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import {
  accounts, auditLog, contacts, folderState, mailboxes, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { makeTestDb, serviceUp } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter, type ImapCursor, type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { ImapConfig } from "@trafficflow/core/adapters/imap-types";
import { MessageService, type ServiceContext } from "@trafficflow/services";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";
import { greenmailPorts } from "./_greenmail-ports.js";

/**
 * THE PASS BEFORE THE WALK, ON A REAL SERVER (GreenMail) AND THIS PROJECT'S STORE (PGlite).
 * A pressed Move lands before `changesSince` and the walk then knows the new UID (one row, one
 * instance). A message moved by another mail app after the press is left for the walk, which adopts
 * it by Message-ID: no void, no locator in a folder it is not in, no second row. A failing early
 * pass still lets new mail in.
 */

const p = greenmailPorts();
/* The run's one probe (test/setup/services.global.ts), at the address this file dials. */
const gm = serviceUp("greenmail", `${p.imapHost}:${p.imapPort}`);
const up = gm.up;
const SKIP = up ? "" : ` (SKIPPED: ${gm.why})`;

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

function eml(messageId: string, subject: string, to: string): string {
  return [
    `Message-ID: <${messageId}>`, "From: anna@x.example", `To: ${to}`, `Subject: walk ${subject}`,
    "Date: Sat, 03 Oct 2026 18:00:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "the letter",
  ].join("\r\n");
}

/** Every adapter call the order is about, and the cursor the walk was handed. */
function recording(adapter: ImapAdapter, calls: string[], cursors: ImapCursor[]): MailboxAdapter {
  return new Proxy(adapter, {
    get(target, prop): unknown {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== "function") return v;
      const fn = (v as (...a: unknown[]) => unknown).bind(target);
      if (prop === "changesSince") {
        return (c: ImapCursor) => { calls.push("changesSince"); cursors.push(structuredClone(c)); return fn(c); };
      }
      if (prop === "moveMany" || prop === "move") return (...a: unknown[]) => { calls.push(String(prop)); return fn(...a); };
      return fn;
    },
  }) as unknown as MailboxAdapter;
}

async function world() {
  const user = `walk-${randomUUID()}@trafficflow.test`;
  const cfg: ImapConfig = { host: p.imapHost, port: p.imapPort, secure: false, auth: { user, pass: "test" } };
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
  await c.connect();
  closers.push(() => c.logout());
  await c.mailboxCreate("Projects").catch(() => undefined);
  await c.append("INBOX", eml("pressed@x", "pressed", user));
  await c.append("INBOX", eml("elsewhere@x", "moved elsewhere", user));

  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "move-before-the-walk" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: user }).returning();
  const mailboxId = mb!.id;
  // A known correspondent, so the organizer leaves anna's letters in INBOX.
  await db.insert(contacts).values({ accountId, address: "anna@x.example" });
  const repo = makeDrizzleRepo(db);
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  closers.push(() => adapter.close());
  await adapter.ensureFolders(FIXTURE_DOOR);
  const lines: string[] = [];
  const cycle = (o: { adapter?: MailboxAdapter; repo?: WorkerRepo; fileBeforeWalk?: boolean } = {}) => runSyncCycle({
    repo: o.repo ?? repo, adapter: o.adapter ?? adapter, accountId, mailboxId, role: "organizer",
    writeAuthority: FIXTURE_LEASE, storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
    log: createLogger({ service: "worker", level: "info", sink: (l) => lines.push(l) }),
    ...(o.fileBeforeWalk === undefined ? {} : { fileBeforeWalk: o.fileBeforeWalk }),
  });
  for (let i = 0; i < 5; i++) {
    const out = await cycle();
    if (!out.hasBacklog && !out.owesFiling) break;
  }
  const rowOf = async (h: string) => (await db.select({ id: messages.id, locator: messages.nativeLocator })
    .from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, h), isNull(messages.deletedAt))));
  const instancesOf = async (id: string) => db.select({ folder: messageInstances.folder, uid: messageInstances.uid })
    .from(messageInstances).where(eq(messageInstances.messageId, id));
  const stateOf = async (id: string) => (await db.select().from(folderState).where(eq(folderState.messageId, id)))[0]!;
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(), requestId: "walk" };
  const press = async (id: string, folder: string) => {
    const out = await new MessageService().move(ctx, id, { folder });
    if ("pending" in out) throw new Error("the move became a request; this rig organizes the mailbox");
  };
  const uidIn = async (path: string, h: string): Promise<number[]> => {
    const l = await c.getMailboxLock(path);
    try {
      const r = await c.search({ header: { "message-id": h } }, { uid: true });
      return Array.isArray(r) ? r : [];
    } finally { l.release(); }
  };
  const audits = async (action: string) => (await db.select({ payload: auditLog.payload }).from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, action))));
  return { c, db, user, accountId, mailboxId, repo, adapter, cycle, rowOf, instancesOf, stateOf, press, uidIn, audits, lines };
}

describe("a pending move before the folder walk, on a real server", () => {
  it.skipIf(!up)(`the pressed move reaches the server first, and the walk knows its new UID${SKIP}`, async () => {
    const w = await world();
    const [row] = await w.rowOf("pressed@x");
    expect(row, "the precondition: the letter was ingested").toBeTruthy();
    const before = (await w.db.select({ id: messages.id }).from(messages)).length;
    await w.press(row!.id, "ohmail/News");

    const calls: string[] = [];
    const cursors: ImapCursor[] = [];
    await w.cycle({ adapter: recording(w.adapter, calls, cursors), fileBeforeWalk: true });

    expect(calls[0], `the order was ${calls.join(",")}`).toBe("moveMany");
    expect(calls.indexOf("moveMany")).toBeLessThan(calls.indexOf("changesSince"));
    const [newUid] = await w.uidIn("ohmail.News", "pressed@x");
    expect(newUid, "the server holds the letter in News").toBeGreaterThan(0);
    expect(await w.uidIn("INBOX", "pressed@x")).toEqual([]);
    // THE WALK WAS HANDED THE NEW UID AS KNOWN, and the old one no more — so it reported neither.
    const known = (f: string) => (cursors[0]!.folders[f]?.known ?? []).map((k) => k.uid);
    expect(known("ohmail/News")).toContain(newUid);
    const oldUid = Number((row!.locator as { ref: string }).ref.split(":").pop());
    expect(oldUid).toBeGreaterThan(0);
    expect(known("INBOX")).not.toContain(oldUid);
    // ONE ROW, ONE INSTANCE, at the new locator: nothing ingested twice.
    expect((await w.db.select({ id: messages.id }).from(messages)).length).toBe(before);
    expect(await w.instancesOf(row!.id)).toEqual([{ folder: "ohmail/News", uid: newUid }]);
    expect(await w.stateOf(row!.id)).toMatchObject({ desiredFolder: "ohmail/News", observedFolder: "ohmail/News", reconcileStatus: "reconciled" });
  }, 60_000);

  it.skipIf(!up)(`a letter moved by another mail app after the press is adopted by the walk, never voided${SKIP}`, async () => {
    const w = await world();
    const [row] = await w.rowOf("elsewhere@x");
    await w.press(row!.id, "ohmail/News");
    // Another mail app files it into Projects: the locator the press was recorded against is stale.
    const [uid] = await w.uidIn("INBOX", "elsewhere@x");
    const l = await w.c.getMailboxLock("INBOX");
    try { await w.c.messageMove(String(uid), "Projects", { uid: true }); } finally { l.release(); }

    const calls: string[] = [];
    await expect(w.cycle({ adapter: recording(w.adapter, calls, []), fileBeforeWalk: true })).resolves.toBeDefined();

    expect(calls.indexOf("moveMany"), "the early pass did not ask the server").toBeGreaterThan(-1);
    expect(calls.indexOf("moveMany")).toBeLessThan(calls.indexOf("changesSince"));
    // Nothing moved it to News, and nothing says it is there.
    expect(await w.uidIn("ohmail.News", "elsewhere@x")).toEqual([]);
    const [projectsUid] = await w.uidIn("Projects", "elsewhere@x");
    const rows = await w.rowOf("elsewhere@x");
    expect(rows.map((r) => r.id), "the letter became a second row, or left").toEqual([row!.id]);
    expect(rows[0]!.locator).toMatchObject({ folder: "Projects" });
    expect(await w.instancesOf(row!.id)).toEqual([{ folder: "Projects", uid: projectsUid }]);
    const st = await w.stateOf(row!.id);
    expect(st.observedFolder).toBe("Projects");
    expect(st.reconcileStatus).not.toBe("pending");
    expect((await w.audits("reconcile.move.voided")).length, "the early pass voided a move the walk adopts").toBe(0);
  }, 60_000);

  it.skipIf(!up)(`an early pass that fails still lets new mail in, and the tail files the move${SKIP}`, async () => {
    const w = await world();
    const [row] = await w.rowOf("pressed@x");
    await w.press(row!.id, "ohmail/News");
    await w.c.append("INBOX", eml("arrives@x", "arrives", w.user));
    // The FIRST pending read fails (a database hiccup, not a refusal); the tail's read succeeds.
    let failures = 1;
    const flaky = new Proxy(w.repo, {
      get(target, prop): unknown {
        const v = Reflect.get(target, prop, target) as unknown;
        if (prop === "listPendingFolderStates") {
          return async (...a: unknown[]) => {
            if (failures-- > 0) throw new Error("the store did not answer");
            return (v as (...x: unknown[]) => unknown).apply(target, a);
          };
        }
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    }) as WorkerRepo;
    const calls: string[] = [];
    await w.cycle({ adapter: recording(w.adapter, calls, []), repo: flaky, fileBeforeWalk: true });

    expect(w.lines.some((l) => l.includes("\"filing_before_walk_failed\""))).toBe(true);
    expect((await w.rowOf("arrives@x")).length, "the new letter was not ingested").toBe(1);
    expect(calls.indexOf("changesSince")).toBeLessThan(calls.indexOf("moveMany"));
    expect((await w.uidIn("ohmail.News", "pressed@x")).length).toBe(1);
  }, 60_000);
});
