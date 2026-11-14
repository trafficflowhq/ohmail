import { accountOfMailbox } from "@trafficflow/db";
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accountSettings, junkRescues, mailboxCredentials, mailboxes } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { ImapAdapter, type FolderPage } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { dismissJunkRescue, listJunk, rescueJunk } from "../src/junk-window.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE JUNK RESCUE'S COMMAND ON BOTH STORES — the statements a phone runs and a server runs.
 *
 * The standalone phone serves `screenerRoutes` through its own local door, so the press below is
 * executed against a SQLite store with no server beside it, and the same module's pass reads it
 * back. Four things differ between the dialects and every one of them is here:
 *
 *  · the UNIQUE UPSERT's conflict target — a four-column `ON CONFLICT` the two query builders
 *    render differently, and the re-press is the whole "one command per locator" rule;
 *  · the 64-BIT EPOCH — `bigint` on the server, `int64` on the device — surviving the round trip
 *    and coming back as the same decimal string the epoch guard compares;
 *  · the DUE PREDICATE's instant, compared against a `timestamptz` on one store and epoch
 *    milliseconds on the other;
 *  · the window's `IN ()` over a page's epochs, where each element goes through the same binder.
 *
 * In the sqlite project's include list because it PASSES on both, which is that list's own rule.
 *
 * ── WATCHED FAIL, AND ONE MUTATION THAT DID NOT ───────────────────────────────────────────
 *
 * With `dueNow` written as a server cast (`${col} <= ${now.toISOString()}::timestamptz`, the exact
 * shape `away-window-dialect.test.ts` records) the device run answers `unrecognized token: ":"` on
 * three cases while the server run stays green. That is the class of defect this file exists for.
 *
 * Binding the device's 64-bit column as a `Number` instead of a decimal string stayed GREEN, and
 * the reason is worth writing down rather than reaching for a bigger number: a UIDVALIDITY is an
 * unsigned 32-bit integer by RFC 3501 and `requireRealEpoch` refuses anything larger, so the
 * double's low-bit loss above 2^53 is UNREACHABLE at this seam. The column is 64-bit for the
 * schema's own consistency with `message_failures.uidvalidity` and `message_instances.uidvalidity`,
 * not because this value can exceed the range — so the claim here is the ROUND TRIP, which is what
 * it asserts, and the binder's low-bit property is pinned where it is load-bearing
 * (`change_log.seq`, the sync cursor) and not here.
 */

const NOW = new Date("2026-08-24T12:00:00.000Z");
const JUNK_PATH = "INBOX/Spamverdacht";
/** The protocol's ceiling (RFC 3501 §2.3.1.1) — an ordinary value, and above 2^31. */
const BIG_EPOCH = "4294967295";

async function world(over: { epoch?: string } = {}) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accountSettings).values({ accountId, foldersEnabledAt: NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `jr-${randomUUID().slice(0, 8)}@example.invalid`,
    junkFolder: JUNK_PATH,
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
  });
  /* THE LOCAL ADMISSION PORT, not the hosted one — `apps/sidecar/src/engine.ts`'s
     `LOCAL_IMAP_ADMISSION`. The hosted counter lives in a per-address table the CLOUD journal
     creates, which a phone's store does not have: wiring it here answers `SQL logic error` on the
     device run and states the mailbox `unreachable`, which is a fixture about the wrong
     composition rather than a finding about this store. */
  const deps = {
    db,
    keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: async () => true, release: async () => {} } },
    now: () => NOW,
  } as unknown as ApiDeps;
  const ctx = { accountId, now: () => NOW } as unknown as Parameters<typeof rescueJunk>[1];
  return { db, deps, ctx, accountId, mailboxId: mb!.id, epoch: over.epoch ?? BIG_EPOCH };
}

describe("the junk rescue's command, on whichever store this project runs", () => {
  it("records the command with its epoch intact, and reads it back through the pass", async () => {
    const w = await world();
    const out = await rescueJunk(w.deps, w.ctx, {
      mailboxId: w.mailboxId, uid: 42, uidValidity: w.epoch,
    });
    expect(out.status).toBe("queued");

    const [row] = await w.db.select().from(junkRescues).where(eq(junkRescues.accountId, w.accountId));
    expect(String(row!.uidvalidity)).toBe(w.epoch);
    expect({ folder: row!.folder, uid: row!.uid, status: row!.status }).toEqual({
      folder: JUNK_PATH, uid: 42, status: "pending",
    });

    // …and through the worker's own projection, which is where the epoch is compared.
    const repo = makeDrizzleRepo(w.db as never);
    const pending = await repo.listPendingJunkRescues(w.mailboxId);
    expect(pending.map((p) => ({ uidValidity: p.uidValidity, uid: p.uid, foldersOff: p.foldersOff })))
      .toEqual([{ uidValidity: w.epoch, uid: 42, foldersOff: false }]);
  });

  it("a SECOND press on the same locator updates the one command", async () => {
    const w = await world();
    const first = await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 42, uidValidity: w.epoch });
    const repo = makeDrizzleRepo(w.db as never);
    await repo.refuseJunkRescue(first.rescueId, 5, "read_only");
    expect(await repo.listPendingJunkRescues(w.mailboxId)).toEqual([]);

    const again = await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 42, uidValidity: w.epoch });
    expect(again.rescueId).toBe(first.rescueId);
    const rows = await w.db.select().from(junkRescues).where(eq(junkRescues.accountId, w.accountId));
    expect(rows).toHaveLength(1);
    expect({ status: rows[0]!.status, lastErrorClass: rows[0]!.lastErrorClass, attempts: rows[0]!.attempts })
      .toEqual({ status: "pending", lastErrorClass: null, attempts: 5 });
  });

  it("the due predicate hides a deferred row and brings it back", async () => {
    const w = await world();
    const out = await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 7, uidValidity: w.epoch });
    const repo = makeDrizzleRepo(w.db as never);
    await repo.deferJunkRescue(out.rescueId, 1, new Date(Date.now() + 3_600_000), "over_quota");
    expect(await repo.listPendingJunkRescues(w.mailboxId)).toEqual([]);
    await repo.deferJunkRescue(out.rescueId, 2, new Date(Date.now() - 60_000), "over_quota");
    expect((await repo.listPendingJunkRescues(w.mailboxId)).map((p) => p.uid)).toEqual([7]);
  });

  it("the window's attribution matches a standing command through the same binder", async () => {
    // `attributeRescues` asks `uidvalidity IN (…)` over the page's own epochs, so every element
    // goes through the 64-bit binder a second time. A page whose row is not matched renders the
    // verb again for a message already queued — which on the device store is the failure a
    // number-bound epoch produces without any error at all.
    const w = await world();
    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
    vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
    vi.spyOn(ImapAdapter.prototype, "listFolderPage").mockResolvedValue({
      uidValidity: w.epoch, total: 2, nextBeforeSeq: null,
      items: [9, 8].map((uid, i) => ({
        uid, seq: 2 - i, subject: `junk ${uid}`,
        from: { name: null, address: `s${uid}@example.invalid` },
        date: NOW.toISOString(), messageIdHeader: `<mid-${uid}@x>`, seen: false,
      })),
    } as FolderPage);

    await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 9, uidValidity: w.epoch });
    const page = await listJunk(w.deps, w.accountId);
    expect(page.items.find((i) => i.uid === 9)!.rescue).toBe("queued");
    expect(page.items.find((i) => i.uid === 8)!.rescue).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("clearing a refused command deletes it, and a pending one is refused and kept", async () => {
    const w = await world();
    const refused = await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 4, uidValidity: w.epoch });
    const pending = await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 5, uidValidity: w.epoch });
    await makeDrizzleRepo(w.db as never).refuseJunkRescue(refused.rescueId, 5, "read_only");
    expect(await dismissJunkRescue(w.deps, w.ctx, refused.rescueId)).toEqual({ dismissed: true });
    await expect(dismissJunkRescue(w.deps, w.ctx, pending.rescueId)).rejects.toMatchObject({ httpStatus: 409 });
    const rows = await w.db.select({ id: junkRescues.id }).from(junkRescues).where(eq(junkRescues.accountId, w.accountId));
    expect(rows.map((r) => r.id)).toEqual([pending.rescueId]);
  });

  it("the resolve deletes the one row", async () => {
    const w = await world();
    const out = await rescueJunk(w.deps, w.ctx, { mailboxId: w.mailboxId, uid: 3, uidValidity: w.epoch });
    const repo = makeDrizzleRepo(w.db as never);
    await repo.resolveJunkRescue(out.rescueId);
    expect(await w.db.select().from(junkRescues).where(eq(junkRescues.accountId, w.accountId))).toEqual([]);
  });
});
