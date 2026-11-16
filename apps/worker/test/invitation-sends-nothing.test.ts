import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drafts, mailboxes, messageInvitations, outboundSends, passProgress, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";
import { ME, shapeLetters } from "./_invitations.js";

/**
 * AN INVITATION IS ANSWERED ONLY ON A PRESS. Letters asking for an answer (`RSVP=TRUE`) of every
 * provider's shape go through the ingest and, with their rows taken away, through the pass over
 * stored mail, in whole cycles of the worker's visit: rows are kept, and no draft is made and no
 * send is reserved, so nothing can leave. The answer's door is a route the person presses (`sqlite`
 * runs this file too: a standalone phone runs the same cycle).
 */
const ACCOUNT = "00000000-0000-4000-8000-00000000c45e";

describe("ingest and the pass answer nothing", () => {
  it("rows are kept, and no draft and no reservation are made", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: ME }).returning();
    const fleet = new FakeAdapterFleet();
    fleet.behave(mb!.id, { deliver: shapeLetters().map((c) => c.letter) });
    const dial = (): MailboxAdapter => fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
    );
    const cycleWith = (adapter: MailboxAdapter): Promise<unknown> => runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId: ACCOUNT, mailboxId: mb!.id,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(), signatures: null,
    });
    const nothingAnswered = async (): Promise<void> => {
      expect(await db.select().from(drafts).where(eq(drafts.accountId, ACCOUNT))).toEqual([]);
      expect(await db.select().from(outboundSends).where(eq(outboundSends.accountId, ACCOUNT))).toEqual([]);
    };

    // The ingest, by an adapter with no targeted re-read, so the pass waits.
    await cycleWith(dial());
    const kept = await db.select().from(messageInvitations).where(eq(messageInvitations.accountId, ACCOUNT));
    expect(kept.filter((r) => r.method === "REQUEST" && r.invitedAddress !== null).length).toBeGreaterThan(0);
    await nothingAnswered();

    // A store from before the entry: the same letters without rows, given them again by the pass.
    await db.delete(messageInvitations);
    await db.delete(passProgress).where(eq(passProgress.job, "invitation_backfill"));
    fleet.targetedRetry = true;
    const adapter = dial();
    for (let visit = 0; visit < 4; visit++) await cycleWith(adapter);
    expect((await db.select().from(messageInvitations).where(eq(messageInvitations.accountId, ACCOUNT))).length).toBe(kept.length);
    await nothingAnswered();
  });
});
