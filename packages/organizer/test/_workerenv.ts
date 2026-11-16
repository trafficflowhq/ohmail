import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { mailboxes, contacts, rules } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { DB_URL, refuseDriftedSharedDb } from "./_workerdb.js";
/* Its own module because it reaches NOTHING: a guard about environment variables must be drivable
   from a root test without dragging the database and the IMAP client into that file's box class. */
import { greenmailPorts } from "./_greenmail-ports.js";
import { FIXTURE_DOOR } from "./_door.js";

export { greenmailPorts };
/* The Postgres half lives in `_workerdb.ts`, which reaches no mail server; re-exported so every
   importer of this module is unchanged. */
export { DB_URL, dbUrlFor, refuseDriftedSharedDb, repoWithFailingMethod, byMessageId, ORGANIZER_CONSENT } from "./_workerdb.js";

export function imapCfg() {
  const user = `t-${randomUUID()}@trafficflow.test`;
  const p = greenmailPorts();
  return {
    host: p.imapHost, port: p.imapPort, secure: false,
    auth: { user, pass: "test" },
    smtp: { host: p.smtpHost, port: p.smtpPort, secure: false },
    sentDomain: "trafficflow.test",
  };
}

/** Seed a mailbox row + a couple of rules/contacts and return ids + a live adapter/repo. */
export async function makeHarness(cfg = imapCfg()) {
  await refuseDriftedSharedDb();
  const accountId = randomUUID();
  const db = makeDb(DB_URL);
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: cfg.auth.user }).returning();
  await db.insert(contacts).values({ accountId, address: "anna@x.example" });
  await db.insert(rules).values({ accountId, kind: "domain", match: "feed.example", destination: "ohmail/News", priority: 5 });
  const repo = makeDrizzleRepo(db);
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  await adapter.ensureFolders(FIXTURE_DOOR);
  return { accountId, mailboxId: mb.id, repo, adapter, db, cfg };
}

export async function rawClient(cfg: ReturnType<typeof imapCfg>) {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}
export function emlOf(o: { from: string; subject: string; messageId: string }) {
  return [`Message-ID: <${o.messageId}>`, `From: ${o.from}`, "To: mila@lichtgrat.example", `Subject: ${o.subject}`, "Content-Type: text/plain", "", "hi"].join("\r\n");
}
export async function uidInFolder(c: import("imapflow").ImapFlow, serverPath: string, messageId: string): Promise<number[]> {
  const l = await c.getMailboxLock(serverPath);
  try { const r = await c.search({ header: { "message-id": messageId } }, { uid: true }); return Array.isArray(r) ? r : []; }
  finally { l.release(); }
}
