import { randomUUID } from "node:crypto";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, flagState, mailboxes, messageInstances, messages, upsertDesiredSeen, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { ImapAdapter, type ImapConfig } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { NativeLocator } from "@trafficflow/core";
import { acquireLeasePermit } from "../src/lease.js";
import { reconcileMailbox, type SyncDeps } from "../src/sync.js";
// THE ONE RESOLVER for which GreenMail a run reads — see `_greenmail-ports.ts`'s own refusal.
import { greenmailPorts } from "./_greenmail-ports.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * ═══ ONE REAL STORE, ONE REAL PRESS, ONE REAL SERVER ═══════════════════════════════════════
 *
 * `flag-completion-cas.pg.test.ts` drives the completion against Postgres alone. Here nothing in
 * the path is a double: a real `ImapAdapter` on a real GreenMail mailbox, the worker's own cycle,
 * the real repo on this lane's database, and the person's press written by the product's own
 * intent writer. The press commits when the `\Seen` STORE has LANDED and its bookkeeping has not —
 * the window the defect lives in — and the measurement is the SERVER: the mailbox ends unread,
 * because that was the person's last word.
 */
const PG_UP = await realPgAvailable();

/** A fresh GreenMail user per case → one physical mailbox, isolated from every other case. */
function cfgOf(): ImapConfig {
  const user = `t-${randomUUID()}@trafficflow.test`;
  const p = greenmailPorts();
  return {
    host: p.imapHost, port: p.imapPort, secure: false,
    auth: { user, pass: "test" },
    smtp: { host: p.smtpHost, port: p.smtpPort, secure: false },
    sentDomain: "trafficflow.test",
  };
}

/** `logger: false` on every raw client: a GreenMail wire log prints the fixture's own LOGIN. */
async function raw(cfg: ImapConfig): Promise<ImapFlow> {
  const c = new ImapFlow({
    host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false,
  });
  await c.connect();
  return c;
}

/** One unread message in the INBOX, and the locator the server minted for it. */
async function seedInbox(cfg: ImapConfig): Promise<NativeLocator> {
  const c = await raw(cfg);
  try {
    await c.append("INBOX", [
      "Subject: the race", "From: someone@trafficflow.test", "", "body",
    ].join("\r\n"));
    const box = await c.mailboxOpen("INBOX");
    let loc: NativeLocator | null = null;
    for await (const m of c.fetch("1:*", { uid: true })) {
      loc = { folder: "INBOX", ref: `${box.uidValidity}:${m.uid}` };
    }
    return loc!;
  } finally { await c.logout(); }
}

/** What the server says about `\Seen` for the one message in the INBOX. */
async function serverSeen(cfg: ImapConfig): Promise<boolean> {
  const c = await raw(cfg);
  try {
    await c.mailboxOpen("INBOX");
    for await (const m of c.fetch("1:*", { flags: true })) return m.flags?.has("\\Seen") ?? false;
    throw new Error("the fixture message is gone");
  } finally { await c.logout(); }
}

describe.skipIf(!PG_UP)("a press during a landed STORE reaches the real mailbox", () => {
  const open: ImapAdapter[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((a) => a.close().catch(() => undefined)));
  });

  it("read, then unread while the STORE is on the wire: the server ends UNREAD", async () => {
    await runMigrations(PG_TEST_URL);
    const sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    const pressSql = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
    try {
      const db = brandDialect(drizzle(sql, { schema }), "pg");
      const pressDb = brandDialect(drizzle(pressSql, { schema }), "pg");
      const cfg = cfgOf();
      const locator = await seedInbox(cfg);

      const accountId = randomUUID();
      const tag = accountId.slice(0, 8);
      await db.insert(accounts).values({ id: accountId, name: `flagrace-${tag}` });
      const [mb] = await db.insert(mailboxes).values({
        accountId, provider: "imap", address: cfg.auth.user, status: "connected",
      }).returning();
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id,
        dedupKey: `mid:<flagrace-${tag}@trafficflow.test>`,
        messageIdHeader: `flagrace-${tag}@trafficflow.test`,
        fromAddress: "someone@trafficflow.test", subject: "the race",
        bodyHash: `flagrace-hash-${tag}`, nativeLocator: locator, unread: false,
      }).returning();
      await db.insert(messageInstances).values({
        accountId, messageId: m!.id, mailboxId: mb!.id, folder: "INBOX",
        uid: Number(locator.ref.split(":")[1]), uidvalidity: BigInt(locator.ref.split(":")[0]!),
        isPrimary: true,
      });
      // The person marked it READ: desired ahead of the server, which is the pending row the
      // reconciler picks up.
      await db.insert(flagState).values({
        messageId: m!.id, accountId: m!.accountId, desiredSeen: true, observedSeen: false,
        lastSetBy: "us", reconcileStatus: "pending", conflict: false,
      });

      const repo = makeDrizzleRepo(db as never) as WorkerRepo;
      const adapter = new ImapAdapter(cfg);
      await adapter.connect();
      await adapter.ensureFolders(FIXTURE_DOOR);
      open.push(adapter);
      const self = { installId: "ohmail-cloud:test", kind: "cloud" as const, displayName: "cloud", lastNonce: null };
      const permit = await acquireLeasePermit({
        adapter, self, mailboxId: mb!.id, hasRequestKey: false,
      });

      /* THE WINDOW, OBSERVED RATHER THAN TIMED: the press commits when the real STORE has come
         back from the server and the completion has not run yet. Everything else is untouched. */
      const store = adapter.setFlags.bind(adapter);
      let pressed = false;
      adapter.setFlags = async (loc, flags, door) => {
        const out = await store(loc, flags, door);
        if (!pressed) {
          pressed = true;
          await (pressDb as unknown as Tx).transaction(async (tx) => {
            await upsertDesiredSeen(tx, m!.id, true, false, new Date());
          });
        }
        return out;
      };

      // ANNOTATED: on a bare `const` the unmetered cap's unique symbol widens to `symbol`, which
      // is not a `StorageCap`, and the whole object stops being a `SyncDeps`.
      const deps: SyncDeps = {
        repo, adapter, accountId, mailboxId: mb!.id, role: "organizer",
        trustedAuthservIds: new Set<string>(), storageCap: UNMETERED_STORAGE_CAP,
        writeAuthority: permit,
      };
      await reconcileMailbox(deps);

      // The stale STORE really did land, and the row says so — an observation, not an intent.
      expect(pressed, "the press must fire inside the window").toBe(true);
      expect(await serverSeen(cfg), "the first STORE reached the server").toBe(true);
      const [mid] = await db.select().from(flagState).where(eq(flagState.messageId, m!.id));
      expect(mid!.desiredSeen, "the person's press is not overwritten").toBe(false);
      expect(mid!.observedSeen).toBe(true);
      expect(mid!.reconcileStatus, "and it is owed to the server").toBe("pending");

      // The next cycle owns the reconciliation — this completion re-issued nothing.
      adapter.setFlags = store;
      await reconcileMailbox(deps);

      // ── THE MEASUREMENT: the person's mailbox ─────────────────────────────────────────────
      expect(await serverSeen(cfg), "the person pressed unread, so the mail is unread").toBe(false);
      const [end] = await db.select().from(flagState).where(eq(flagState.messageId, m!.id));
      expect(end!.desiredSeen).toBe(false);
      expect(end!.observedSeen).toBe(false);
      expect(end!.reconcileStatus).toBe("reconciled");
    } finally {
      await sql.end({ timeout: 5 });
      await pressSql.end({ timeout: 5 });
    }
  }, 60_000);
});
