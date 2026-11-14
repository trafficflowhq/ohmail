import { and, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { bindDb, folderState, mailboxes, messageBodies, organizerRequests, rules, validateRequestPayload } from "@trafficflow/db";
import { makeUnsubscribeService, ScreenerService } from "../src/index.js";
import { makeCtx, otherAccount, seedMessage } from "./helpers.js";

it("files confirmed mail and sends no background requests under the confirmed-press ruling in Difference from today", async () => {
  const now = new Date("2026-07-28T12:00:00Z");
  const { db, accountId, mailboxId, ctx } = await makeCtx(now);
  const subject = "offers" + "@" + "test.example";
  const held = { from: subject, folder: "ohmail/Screener" };
  const confirmed = await seedMessage(db, accountId, mailboxId, held);
  const filedOnly = await seedMessage(db, accountId, mailboxId, held);
  const arrival = await seedMessage(db, accountId, mailboxId, held);
  const alreadyFiled = await seedMessage(db, accountId, mailboxId, { ...held, folder: "INBOX" });
  const other = await otherAccount(db);
  const foreign = await seedMessage(db, other.accountId, other.mailboxId, held);
  const filed = vi.fn(async (_ctx, ids: string[]) => ({ considered: ids.length }));
  const screener = new ScreenerService({ unsubscribe: { onScreenOut: filed } });
  await screener.decide(ctx, confirmed, {
    decision: "no", dest: "ohmail/Quarantine", scope: "confirmed_sender",
    confirmedIds: [confirmed, filedOnly, foreign, alreadyFiled], unsubscribeIds: [confirmed, foreign, alreadyFiled],
  });

  const placeOf = async (id: string) =>
    (await db.select().from(folderState).where(eq(folderState.messageId, id)))[0]!.desiredFolder;
  expect(await placeOf(confirmed)).toBe("ohmail/Quarantine");
  expect(await placeOf(filedOnly)).toBe("ohmail/Quarantine");
  expect(await placeOf(arrival)).toBe("ohmail/Screener");
  expect(await placeOf(foreign)).toBe("ohmail/Screener");
  expect(await placeOf(alreadyFiled)).toBe("INBOX");
  expect(filed.mock.calls.map(([, ids]) => ids)).toEqual([[confirmed]]);
  const [promoted] = await db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.match, subject)));
  expect(promoted).toMatchObject({ destination: "ohmail/Quarantine", enabled: true, retroRequestedAt: null });

  // Future mail follows the published rule, but still has no unsubscribe grant.
  const future = await seedMessage(db, accountId, mailboxId, { ...held, folder: "ohmail/Quarantine" });
  for (const id of [confirmed, filedOnly, future]) {
    await db.update(folderState).set({ updatedAt: now }).where(eq(folderState.messageId, id));
    await db.insert(messageBodies).values({
      messageId: id, accountId, text: "",
      headers: {
        "list-unsubscribe": [`<https://test.example/${id}>`],
        "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
        "authentication-results": ["mx.google.com; dmarc=pass"],
      },
    });
  }
  const post = vi.fn(async (_url: string) => ({ status: 200 }));
  const unsubscribe = makeUnsubscribeService({
    post: { post }, resolver: { resolve: async () => ["93.184.216.34"] },
    trustedAuthservIdsFor: async () => new Set(["mx.google.com"]),
  });
  expect((await unsubscribe.sweepScreenedOut(ctx, { since: new Date(now.getTime() - 1000), limit: 10 })).considered).toBe(0);
  const drained = await unsubscribe.drainScreenedOut(bindDb(db, { account: null }), {
    now: () => now, requestId: "background", accounts: 1, perAccount: 1,
  });
  expect(drained.sweep.considered).toBe(0);
  expect(drained.remaining).toBe(0);
  expect(post).not.toHaveBeenCalled();
});

it("does not acquire an unsubscribe grant when another rule remains after disabling the scoped rule", async () => {
  const now = new Date("2026-07-28T12:00:00Z");
  const { db, accountId, mailboxId, ctx } = await makeCtx(now);
  const domain = "test.example";
  const original = await seedMessage(db, accountId, mailboxId, {
    from: ["original", domain].join("@"), folder: "ohmail/Screener",
  });
  const screener = new ScreenerService({});
  await screener.decide(ctx, original, { decision: "no", dest: "ohmail/Quarantine", scope: "domain", applyRetro: false });
  const address = ["later", domain].join("@");
  const filedOnly = await seedMessage(db, accountId, mailboxId, { from: address, folder: "ohmail/Screener" });
  await screener.decide(ctx, filedOnly, {
    decision: "no", dest: "ohmail/Quarantine", scope: "confirmed_sender",
    confirmedIds: [filedOnly], unsubscribeIds: [],
  });
  await db.update(rules).set({ enabled: false }).where(and(eq(rules.accountId, accountId), eq(rules.match, address)));
  await db.update(folderState).set({ updatedAt: now }).where(eq(folderState.messageId, filedOnly));
  await db.insert(messageBodies).values({
    messageId: filedOnly, accountId, text: "",
    headers: {
      "list-unsubscribe": [`<https://test.example/${filedOnly}>`],
      "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
      "authentication-results": ["mx.google.com; dmarc=pass"],
    },
  });
  const post = vi.fn(async (_url: string) => ({ status: 200 }));
  const unsubscribe = makeUnsubscribeService({
    post: { post }, resolver: { resolve: async () => ["93.184.216.34"] },
    trustedAuthservIdsFor: async () => new Set(["mx.google.com"]),
  });
  await unsubscribe.sweepScreenedOut(ctx, { since: new Date(now.getTime() - 1000), limit: 10 });
  expect(post.mock.calls.some(([url]) => new URL(url).pathname === `/${filedOnly}`)).toBe(false);
});

it("sends only for the displayed domain recipients while the filing rule covers the domain", async () => {
  const { db, accountId, mailboxId, ctx } = await makeCtx();
  const domain = "mail.example";
  const seed = (name: string) => seedMessage(db, accountId, mailboxId, {
    from: [name, domain].join("@"), folder: "ohmail/Screener",
  });
  const shown = await seed("shown");
  const arrived = await seed("arrived");
  const sent = vi.fn(async (_ctx, ids: string[]) => ({ considered: ids.length }));
  await new ScreenerService({ unsubscribe: { onScreenOut: sent } }).decide(ctx, shown, {
    decision: "no", scope: "domain", unsubscribeIds: [shown], applyRetro: false,
  });
  expect(sent.mock.calls.map(([, ids]) => ids)).toEqual([[shown]]);
  const [later] = await db.select().from(folderState).where(eq(folderState.messageId, arrived));
  expect(later?.desiredFolder).toBe("ohmail/Screened");
  const [rule] = await db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.match, domain)));
  expect(rule).toMatchObject({ kind: "domain", destination: "ohmail/Screened" });
});

it("forwards exactly the confirmed Spam IDs in the existing organizer request", async () => {
  const { db, accountId, mailboxId, ctx } = await makeCtx();
  await db.update(mailboxes).set({
    organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests",
    organizedByKind: "cloud", organizedByName: "ohmail Cloud",
  }).where(eq(mailboxes.id, mailboxId));
  const held = { from: ["offers", "test.example"].join("@"), folder: "ohmail/Screener" };
  const original = await seedMessage(db, accountId, mailboxId, held);
  await seedMessage(db, accountId, mailboxId, held);
  const sent = vi.fn(async () => ({ considered: 1 }));
  const result = await new ScreenerService({ unsubscribe: { onScreenOut: sent } }).decide(ctx, original, {
    decision: "no", dest: "ohmail/Quarantine", scope: "confirmed_sender",
    confirmedIds: [original], unsubscribeIds: [original],
  });
  expect(result).toMatchObject({ pending: true });
  const [request] = await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId));
  expect(request).toMatchObject({ kind: "screener.decide" });
  expect(request?.payload).not.toHaveProperty("unsubscribeIds");
  expect(validateRequestPayload(request?.payload)).toMatchObject({
    confirmedIds: [original], scope: "sender", appliedFolder: "ohmail/Quarantine",
  });
  expect(sent).not.toHaveBeenCalled();
});

it.each([{ name: "omitted", grant: {} }, { name: "empty", grant: { unsubscribeIds: [] } }])(
  "files the sender without posting when the unsubscribe grant is $name", async ({ grant }) => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const message = await seedMessage(db, accountId, mailboxId, {
      from: ["offers", "test.example"].join("@"), folder: "ohmail/Screener",
    });
    await db.insert(messageBodies).values({
      messageId: message, accountId, text: "",
      headers: {
        "list-unsubscribe": ["<https://test.example/leave>"],
        "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
        "authentication-results": ["mx.google.com; dmarc=pass"],
      },
    });
    const post = vi.fn(async (_url: string) => ({ status: 200 }));
    const unsubscribe = makeUnsubscribeService({
      post: { post }, resolver: { resolve: async () => ["93.184.216.34"] },
      trustedAuthservIdsFor: async () => new Set(["mx.google.com"]),
    });
    await new ScreenerService({ unsubscribe }).decide(ctx, message, { decision: "no", scope: "sender", ...grant });
    const [filed] = await db.select().from(folderState).where(eq(folderState.messageId, message));
    expect(filed?.desiredFolder).toBe("ohmail/Screened");
    expect(post).not.toHaveBeenCalled();
});
