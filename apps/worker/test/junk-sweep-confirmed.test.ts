import { eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { accountSettings, bindDb, folderState, mailboxPass, mailboxes, readJunkSweepCommand, writePassProgress, type Tx } from "@trafficflow/db";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { junkSweepPreview, requestJunkSweep } from "../../../packages/api/src/junk-window.js";
import type { ApiDeps } from "../../../packages/api/src/deps.js";
import { FIXTURE_LEASE } from "../../../packages/organizer/test/_door.js";
import { makeCtx, otherAccount, seedMessage } from "../../../packages/services/test/helpers.js";
import { junkSweepPass } from "../src/junk-sweep.js";

const quarantine = "ohmail/Quarantine";
const junk = "INBOX/Junk";

async function world() {
  const { db, accountId, mailboxId, ctx } = await makeCtx();
  await db.insert(accountSettings).values({ accountId, foldersEnabledAt: ctx.now() });
  await db.update(mailboxes).set({ junkFolder: junk }).where(eq(mailboxes.id, mailboxId));
  const deps = { db: bindDb(db, { account: accountId }) } as ApiDeps;
  const seed = (ref: number) => seedMessage(db, accountId, mailboxId, { folder: quarantine, ref: `1:${ref}` });
  const queued = () => readJunkSweepCommand(db as unknown as Tx, accountId, mailboxId);
  return { db, accountId, mailboxId, ctx, deps, seed, queued };
}

it("rejects a changed or foreign preview even when the counts match", async () => {
  const { db, accountId, ctx, deps, seed, queued } = await world();
  const original = await seed(10);
  const first = await junkSweepPreview(deps, accountId);
  const other = await otherAccount(db);
  await db.insert(accountSettings).values({ accountId: other.accountId, foldersEnabledAt: ctx.now() });
  await db.update(mailboxes).set({ junkFolder: junk }).where(eq(mailboxes.id, other.mailboxId));
  await seedMessage(db, other.accountId, other.mailboxId, { folder: quarantine });
  const foreign = await junkSweepPreview(deps, other.accountId);
  expect(foreign.movable).toBe(first.movable);
  await expect(requestJunkSweep(deps, ctx, foreign.confirmation)).rejects.toMatchObject({ code: "stale_junk_sweep" });

  await db.update(folderState).set({ desiredFolder: "INBOX" }).where(eq(folderState.messageId, original));
  await seed(11);
  const second = await junkSweepPreview(deps, accountId);
  expect(second.movable).toBe(first.movable);
  await expect(requestJunkSweep(deps, ctx, first.confirmation)).rejects.toMatchObject({ code: "stale_junk_sweep" });
  expect(await queued()).toBeNull();
});

it("moves the queued letters when another letter arrives before the worker runs", async () => {
  const { db, accountId, mailboxId, ctx, deps, seed, queued } = await world();
  const original = await seed(12);
  const preview = await junkSweepPreview(deps, accountId);
  await requestJunkSweep(deps, ctx, preview.confirmation);
  const arrival = await seed(13);

  const command = await queued();
  expect(command?.ids).toEqual([original]);
  const move = vi.fn(async () => ({ folder: junk, ref: "9:91" }));
  const adapter = {
    findSpecialFolders: async () => ({ junk, trash: null }), move,
  } as unknown as MailboxAdapter;
  const result = await junkSweepPass({
    db: db as unknown as Tx, repo: makeDrizzleRepo(db as unknown as Tx), adapter, accountId, mailboxId,
    execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    confirmed: command!,
  });
  expect(result.moved).toEqual([original]);
  expect(move).toHaveBeenCalledTimes(1);
  expect((await db.select().from(folderState).where(eq(folderState.messageId, arrival)))[0]!.desiredFolder).toBe(quarantine);
});

it("leaves foreign mail alone even if its ID is in the command", async () => {
  const { db, accountId } = await world();
  const other = await otherAccount(db);
  const foreign = await seedMessage(db, other.accountId, other.mailboxId, { folder: quarantine });
  const move = vi.fn(async () => ({ folder: junk, ref: "9:92" }));
  const adapter = {
    findSpecialFolders: async () => ({ junk, trash: null }), move,
  } as unknown as MailboxAdapter;
  const result = await junkSweepPass({
    db: db as unknown as Tx, repo: makeDrizzleRepo(db as unknown as Tx), adapter, accountId,
    mailboxId: other.mailboxId, execute: true, writeAuthority: { lease: FIXTURE_LEASE },
    confirmed: { folder: junk, ids: [foreign] },
  });
  expect(result.candidates).toEqual([]);
  expect(move).not.toHaveBeenCalled();
  expect((await db.select().from(folderState).where(eq(folderState.messageId, foreign)))[0]!.desiredFolder).toBe(quarantine);
});

it("gives the worker no command for missing, empty or malformed confirmed IDs", async () => {
  const { db, accountId, mailboxId, ctx, seed, queued } = await world();
  const original = await seed(14);
  const pass = mailboxPass("junk_sweep", accountId, mailboxId);
  expect(await queued()).toBeNull();
  for (const ids of [undefined, [], [original, "invalid"]]) {
    await writePassProgress(db as unknown as Tx, pass, {
      requestedAt: ctx.now(), cursor: JSON.stringify({ id: "press", folder: junk, ids }),
    }, { now: ctx.now() });
    expect(await queued()).toBeNull();
  }
  expect((await db.select().from(folderState).where(eq(folderState.messageId, original)))[0]!.desiredFolder).toBe(quarantine);
});
