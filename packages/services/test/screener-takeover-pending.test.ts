import { accountOfMailbox } from "@trafficflow/db";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, folderState, mailboxCredentials, mailboxes, organizerRequests, rules } from "@trafficflow/db";
import { ScreenerService, type ScreenDecisionResult } from "../src/index.js";
import { makeMailboxService } from "../src/mailbox-service.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * THE CLOUD DOOR'S HALF OF THAT CHANGE. Web setup takes a mailbox over through
 * `MailboxService.organizeHere`, which writes consent and the takeover stamp and leaves the role
 * to the gate. A Screener decision pressed before the gate answers is a rule at once, filed under
 * `mailboxes.awaiting`, with no request to the holder the claim displaces. To watch it fail: drop
 * the `takeoverPending` arm of `planAccountFanOut`.
 */

async function readerUnder(holder: { state: "held" | "stopped" | "none" }) {
  const w = await makeCtx();
  await w.db.insert(accounts).values({ id: w.accountId, name: "takeover" }).onConflictDoNothing();
  await w.db.update(mailboxes).set(holder.state === "none"
    /* A mailbox nothing has ever organized: the self-hosted server's first setup. */
    ? { organizerRole: "reader", organizerState: null, organizedByKind: null, organizedByName: null }
    : {
      organizerRole: "reader", organizerState: holder.state, organizedByCapabilities: "requests",
      organizedByKind: "local", organizedByName: "W-old",
    }).where(eq(mailboxes.id, w.mailboxId));
  // A stored login, as the connect wrote it: a claim with no password in the body requires one.
  await w.db.insert(mailboxCredentials).values({
    mailboxId: w.mailboxId, accountId: accountOfMailbox(w.mailboxId), transport: "imap", secretEnc: "sealed", keyVersion: 1,
    meta: { host: "imap.example.test", port: 993, secure: true, user: "u" }, updatedAt: new Date(),
  });
  const held = await seedMessage(w.db, w.accountId, w.mailboxId, { from: "b@b.test" });
  const organize = (intent: "takeover" | "join") => makeMailboxService({ allowance: async () => {} })
    .organizeHere(w.ctx, w.mailboxId, { intent, screening: { scope: "window" } });
  const state = async () => ({
    rules: await w.db.select().from(rules).where(eq(rules.accountId, w.accountId)),
    requests: await w.db.select().from(organizerRequests).where(eq(organizerRequests.accountId, w.accountId)),
    desired: (await w.db.select().from(folderState).where(eq(folderState.messageId, held)))[0]?.desiredFolder,
    role: (await w.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId)))[0]?.organizerRole,
  });
  return { ...w, held, organize, state };
}

describe("ScreenerService.decide on a hosted takeover that has not landed", () => {
  it.each(["stopped", "held"] as const)("holder %s: a rule at the press, the move waits for the claim", async (s) => {
    const w = await readerUnder({ state: s });
    await w.organize("takeover");
    expect((await w.state()).role, "organizeHere leaves the role to the gate").toBe("reader");

    const out = await new ScreenerService({}).decide(w.ctx, w.held, { decision: "yes" }) as ScreenDecisionResult;

    expect(out.mailboxes?.awaiting).toEqual([w.mailboxId]);
    expect(out.mailboxes?.filed).toEqual([]);
    const after = await w.state();
    expect(after.rules.map((r) => [r.match, r.destination])).toEqual([["b@b.test", "INBOX"]]);
    expect(after.rules[0]?.retroRequestedAt, "the rule owes the held mail").not.toBeNull();
    expect(after.requests, "nothing asked of the displaced holder").toEqual([]);
    expect(after.desired, "nothing moves before the claim").toBe("ohmail/Screener");
  });

  it("no holder ever (the self-host first setup): Agree as setup sends it, then a rule at the press", async () => {
    const w = await readerUnder({ state: "none" });
    await w.organize("join");
    const out = await new ScreenerService({}).decide(w.ctx, w.held, { decision: "yes" }) as ScreenDecisionResult;
    expect(out.mailboxes?.awaiting, "refused as 'another organizer has it' with nobody there").toEqual([w.mailboxId]);
    const after = await w.state();
    expect(after.rules.map((r) => r.destination)).toEqual(["INBOX"]);
    /* THE MOVE IS THE FIRST DRAIN'S: the rule is owed its held mail (`retro_requested_at` set,
       `retro_done_at` null), which is what the organizer's `ruleRetroPass` walks once the claim
       lands — the same pass the sidecar harness watches move this bag. */
    expect(after.rules[0]?.retroRequestedAt).not.toBeNull();
    expect(after.rules[0]?.retroDoneAt).toBeNull();
    expect(after.desired).toBe("ohmail/Screener");
    expect(after.requests).toEqual([]);
  });

  it("CONTROL: a join over a live holder is refused, so the decision goes to that holder", async () => {
    const w = await readerUnder({ state: "held" });
    await expect(w.organize("join")).rejects.toMatchObject({ code: "organized_elsewhere", httpStatus: 409 });
    const out = await new ScreenerService({}).decide(w.ctx, w.held, { decision: "yes" });
    expect((out as { pending?: boolean }).pending).toBe(true);
    const after = await w.state();
    expect(after.rules).toEqual([]);
    expect(after.requests).toHaveLength(1);
  });

  it("CONTROL: no takeover asked for, a stopped holder: refused as before", async () => {
    const w = await readerUnder({ state: "stopped" });
    await expect(new ScreenerService({}).decide(w.ctx, w.held, { decision: "yes" }))
      .rejects.toMatchObject({ code: "organized_elsewhere", httpStatus: 409 });
    expect((await w.state()).rules).toEqual([]);
  });
});
