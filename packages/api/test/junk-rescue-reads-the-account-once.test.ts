import { accountOfMailbox } from "@trafficflow/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PgSelectQueryBuilderBase } from "drizzle-orm/pg-core";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { accountSettings, mailboxCredentials, mailboxes } from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { rescueJunk } from "../src/junk-window.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * "NOT JUNK" READS THE ACCOUNT ROW ONCE (RESCUE-READS-THE-ACCOUNT-ROW-TWICE). The transaction's
 * opener fences the account; the rescue then asks only its mailbox, and "always allow" asks the
 * account only where its transaction was not fenced already. Counted at the one door every fence
 * read takes, the locking read of `accounts`, so the opener's own read is the positive control.
 */
const NOW = new Date("2026-10-06T03:00:00.000Z");

async function seed() {
  const db = await makeTestDb();
  vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
  const accountId = randomUUID();
  await db.insert(accountSettings).values({ accountId, foldersEnabledAt: NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `junk-${randomUUID().slice(0, 8)}@example.invalid`, junkFolder: "Junk",
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
  });
  const deps = {
    db, keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } }, now: () => NOW,
  } as unknown as ApiDeps;
  const ctx = { accountId, now: () => NOW } as unknown as Parameters<typeof rescueJunk>[1];
  return { deps, ctx, mailboxId: mb!.id };
}

/** Every locking read of the `accounts` row issued while `run` goes. */
async function accountReads(run: () => Promise<unknown>): Promise<number> {
  const lockFor = PgSelectQueryBuilderBase.prototype.for;
  let reads = 0;
  const spy = vi.spyOn(PgSelectQueryBuilderBase.prototype, "for").mockImplementation(function (this: unknown, ...args: unknown[]) {
    const out = (lockFor as (...a: unknown[]) => { toSQL(): { sql: string } }).apply(this, args);
    if (/from "accounts"/.test(out.toSQL().sql)) reads++;
    return out as never;
  });
  try { await run(); } finally { spy.mockRestore(); }
  return reads;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("a Not junk press", () => {
  it("reads the account row once", async () => {
    const s = await seed();
    expect(await accountReads(() => rescueJunk(s.deps, s.ctx, { mailboxId: s.mailboxId, uid: 2, uidValidity: "7" }))).toBe(1);
  });

  it("with always allow, still once", async () => {
    const s = await seed();
    expect(await accountReads(() => rescueJunk(s.deps, s.ctx, {
      mailboxId: s.mailboxId, uid: 2, uidValidity: "7", allow: { sender: "lena@atelier.example" },
    }))).toBe(1);
  });
});
