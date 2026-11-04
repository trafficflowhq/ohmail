import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, changeLog, readRuleRemovals, rules as rulesTbl, type Tx } from "@trafficflow/db";
import { asc, eq } from "drizzle-orm";
import { DEFAULT_OHBOX_POLICY, evaluateRules, type NormalizedMessage } from "@trafficflow/core";
import { compareTwins, effectForDestination } from "@trafficflow/core/rule-order";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { rulesService } from "../src/rules-service.js";
import { mutated } from "./helpers.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * LOCAL-RULE-UPDATE-LEAVES-THE-ACTING-TWIN. Two rows under one sender's key, seeded by insert the
 * way twins arrive (a manual Ohbox row, a Screener-promoted Screened row): the Screened deny acts.
 * A `PATCH /rules/:id` converges the key onto the PRESSED row: the other rows go, one `delete`
 * delta each before the row's own `update`, the row keeps the highest priority among them, and
 * the backlog is re-asked when the place differs from where the ACTING row filed.
 */
const NOW = new Date("2026-10-04T03:00:00Z");
const ADDR = "lena@atelier.example";
const LOW = "00000000-0000-4000-8000-000000000001";
const HIGH = "00000000-0000-4000-8000-000000000002";

async function world(): Promise<{ db: Db; ctx: ServiceContext }> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `upd-${accountId.slice(0, 8)}` });
  return { db, ctx: { db, accountId, now: () => NOW } as unknown as ServiceContext };
}

function next(): NormalizedMessage {
  return {
    canonical: { messageIdHeader: "next@x", bodyHash: "h" },
    subject: "Hello again", from: { name: null, address: ADDR }, to: [], cc: [], date: null,
    headers: {}, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
}

/** Where the router files the sender's next message, over the repo's own `listRules`. */
async function nextFiles(ctx: ServiceContext): Promise<string | null> {
  const rules = await makeDrizzleRepo(ctx.db as never).listRules(ctx.accountId);
  return evaluateRules({
    msg: next(), rules, knownSenders: { addresses: new Set(), inferred: new Set<string>(), lists: new Map() }, ownAddresses: new Set<string>(), auth: "unauthenticated",
    ohboxPolicy: DEFAULT_OHBOX_POLICY, identity: null,
  }).destination;
}

/** `GET /rules`, and the row the rules page shows for the key (`actingRules`' `compareTwins`). */
async function page(ctx: ServiceContext) {
  const list = await rulesService.list(ctx);
  const ordered = (r: (typeof list)[number]) => ({ ...r, effect: effectForDestination(r.destination) });
  const shown = [...list].sort((a, b) => compareTwins(ordered(a), ordered(b)))[0];
  return { rows: list.map((r) => r.destination).sort(), shows: shown?.destination ?? null };
}

/** The removals this store recorded, as `[match, removedAt, removedBy]`. */
const removals = async (ctx: ServiceContext) =>
  (await readRuleRemovals(ctx.db as unknown as Tx, ctx.accountId)).map((r) => [r.match, r.removedAt.toISOString(), r.removedBy]);

/** The twins: a manual Ohbox row and a promoted Screened row, ids chosen so the tie order is known. */
async function twins(ctx: ServiceContext, ids: { inbox: string; screened: string }) {
  const row = { accountId: ctx.accountId, kind: "sender", match: ADDR, priority: 0, enabled: true };
  await (ctx.db as unknown as Awaited<ReturnType<typeof makeTestDb>>).insert(rulesTbl).values([
    { ...row, id: ids.inbox, destination: "INBOX", provenance: "manual" },
    { ...row, id: ids.screened, destination: "ohmail/Screened", provenance: "promoted" },
  ]);
}

describe("PATCH /rules/:id over a key with a twin", () => {
  it("before the press the Screened twin acts and the page shows it", async () => {
    const { ctx } = await world();
    await twins(ctx, { inbox: LOW, screened: HIGH });
    expect(await nextFiles(ctx)).toBe("ohmail/Screened");
    expect((await page(ctx)).shows).toBe("ohmail/Screened");
  });

  it("changing the acting row to News files the sender's next message to News, one row under the key", async () => {
    const { ctx } = await world();
    await twins(ctx, { inbox: LOW, screened: HIGH });
    const out = mutated(await rulesService.update(ctx, HIGH, { destination: "ohmail/News" }));
    const reading = { answer: out.rule.destination, nextFiles: await nextFiles(ctx), ...(await page(ctx)) };
    expect(reading).toEqual({ answer: "ohmail/News", nextFiles: "ohmail/News", rows: ["ohmail/News"], shows: "ohmail/News" });
    expect(await removals(ctx), "a collapsed twin is no rule removed: the key stays").toEqual([]);
  });

  it("the same press with the tie the other way round (the twins' ids swapped)", async () => {
    const { ctx } = await world();
    await twins(ctx, { inbox: HIGH, screened: LOW });
    const out = mutated(await rulesService.update(ctx, LOW, { destination: "ohmail/News" }));
    const reading = { answer: out.rule.destination, nextFiles: await nextFiles(ctx), ...(await page(ctx)) };
    expect(reading).toEqual({ answer: "ohmail/News", nextFiles: "ohmail/News", rows: ["ohmail/News"], shows: "ohmail/News" });
  });

  it("pausing the acting row leaves no rule filing the sender's mail", async () => {
    const { ctx } = await world();
    await twins(ctx, { inbox: LOW, screened: HIGH });
    mutated(await rulesService.update(ctx, HIGH, { enabled: false }));
    const running = (await rulesService.list(ctx)).filter((r) => r.enabled).map((r) => r.destination);
    expect({ running, nextFiles: await nextFiles(ctx) }).toEqual({ running: [], nextFiles: "ohmail/Screener" });
  });

  it("pressing the losing twin answers that id, one row, and routes by it", async () => {
    const { ctx } = await world();
    await twins(ctx, { inbox: LOW, screened: HIGH });
    const out = mutated(await rulesService.update(ctx, LOW, { destination: "ohmail/News" }));
    expect(out.rule.id).toBe(LOW);
    expect({ nextFiles: await nextFiles(ctx), ...(await page(ctx)) })
      .toEqual({ nextFiles: "ohmail/News", rows: ["ohmail/News"], shows: "ohmail/News" });
  });

  it("the survivor keeps the highest priority among the collapsed rows", async () => {
    const { ctx } = await world();
    const row = { accountId: ctx.accountId, kind: "sender", match: ADDR, enabled: true, provenance: "manual" };
    await (ctx.db as unknown as Awaited<ReturnType<typeof makeTestDb>>).insert(rulesTbl).values([
      { ...row, id: LOW, destination: "INBOX", priority: 0 },
      { ...row, id: HIGH, destination: "ohmail/News", priority: 5, provenance: "promoted" },
    ]);
    const out = mutated(await rulesService.update(ctx, LOW, { destination: "ohmail/Receipts" }));
    expect({ priority: out.rule.priority, rows: (await page(ctx)).rows }).toEqual({ priority: 5, rows: ["ohmail/Receipts"] });
  });

  it("a PATCH naming the pressed row's own place over a twin acting elsewhere re-asks the backlog", async () => {
    const { ctx } = await world();
    await twins(ctx, { inbox: LOW, screened: HIGH });
    mutated(await rulesService.update(ctx, LOW, { destination: "INBOX" }));
    const [r] = await (ctx.db as unknown as Awaited<ReturnType<typeof makeTestDb>>).select().from(rulesTbl).where(eq(rulesTbl.id, LOW));
    expect(r!.retroRequestedAt, "the routing moved from Screened to the Ohbox and nothing re-filed").not.toBeNull();
    expect(await nextFiles(ctx)).toBe("INBOX");
  });

  it("the twin deletes are on the change log before the row's update, and the answer's seq is the update's", async () => {
    const { ctx } = await world();
    await twins(ctx, { inbox: LOW, screened: HIGH });
    const out = mutated(await rulesService.update(ctx, HIGH, { destination: "ohmail/News" }));
    const log = await (ctx.db as unknown as Awaited<ReturnType<typeof makeTestDb>>).select().from(changeLog)
      .where(eq(changeLog.accountId, ctx.accountId)).orderBy(asc(changeLog.seq));
    expect(log.map((c) => [c.op, c.entityId])).toEqual([["delete", LOW], ["update", HIGH]]);
    expect(out.seq).toBe(Number(log[log.length - 1]!.seq));
  });

  it("a PATCH moving the match converges the NEW key onto the moved row and leaves the old key's other row", async () => {
    const { ctx } = await world();
    const OTHER = "max@atelier.example";
    const row = { accountId: ctx.accountId, kind: "sender", priority: 0, enabled: true, provenance: "manual" };
    const C = "00000000-0000-4000-8000-000000000003";
    await (ctx.db as unknown as Awaited<ReturnType<typeof makeTestDb>>).insert(rulesTbl).values([
      { ...row, id: LOW, match: ADDR, destination: "INBOX" },
      { ...row, id: HIGH, match: ADDR, destination: "ohmail/Screened", provenance: "promoted" },
      { ...row, id: C, match: OTHER, destination: "ohmail/News" },
    ]);
    const out = mutated(await rulesService.update(ctx, HIGH, { match: OTHER }));
    const rows = (await rulesService.list(ctx)).map((r) => `${r.id}:${r.match}`).sort();
    expect(out.rule.id).toBe(HIGH);
    expect(rows, "the old key's other row stays; the new key holds the moved row alone").toEqual([`${LOW}:${ADDR}`, `${HIGH}:${OTHER}`]);
    expect(await removals(ctx), "the old key still has a row").toEqual([]);
    mutated(await rulesService.update(ctx, LOW, { match: "Nina@atelier.example" }));
    expect(await removals(ctx), "moved off its last row, the old key is a rule removed").toEqual([[ADDR, NOW.toISOString(), null]]);
    mutated(await rulesService.update(ctx, HIGH, { match: ADDR }));
    expect(await removals(ctx), "a rule moved back onto the removed key ends its removal; the key it left is removed now")
      .toEqual([[OTHER, NOW.toISOString(), null]]);
  });

  it("a key differing only in its subject term, and another account's same key, are untouched", async () => {
    const { db, ctx } = await world();
    await twins(ctx, { inbox: LOW, screened: HIGH });
    const T = "00000000-0000-4000-8000-000000000004";
    await (db as unknown as Awaited<ReturnType<typeof makeTestDb>>).insert(rulesTbl).values({
      id: T, accountId: ctx.accountId, kind: "sender", match: ADDR, destination: "ohmail/Receipts", provenance: "manual", subjectContains: "invoice",
    });
    const otherAccount = randomUUID();
    await db.insert(accounts).values({ id: otherAccount, name: `other-${otherAccount.slice(0, 8)}` });
    const row = { accountId: otherAccount, kind: "sender", match: ADDR, priority: 0, enabled: true, provenance: "manual" };
    await (db as unknown as Awaited<ReturnType<typeof makeTestDb>>).insert(rulesTbl).values([
      { ...row, destination: "INBOX" }, { ...row, destination: "ohmail/Screened" },
    ]);
    mutated(await rulesService.update(ctx, HIGH, { destination: "ohmail/News" }));
    expect((await page(ctx)).rows).toEqual(["ohmail/News", "ohmail/Receipts"]);
    const other = await (db as unknown as Awaited<ReturnType<typeof makeTestDb>>).select().from(rulesTbl).where(eq(rulesTbl.accountId, otherAccount));
    expect(other).toHaveLength(2);
  });

  it("remove over twins still takes every row under the key (the positive arm)", async () => {
    const { ctx } = await world();
    await twins(ctx, { inbox: LOW, screened: HIGH });
    await rulesService.remove(ctx, HIGH);
    expect((await page(ctx)).rows).toEqual([]);
    expect(await removals(ctx), "the person's removal, once, at this clock, by this store").toEqual([[ADDR, NOW.toISOString(), null]]);
  });

  it("a match the store folds differently from JS is still found and converged", async () => {
    // Measured on this store: SQL lower("ΜΑΣ") is "μασ", JS gives the final sigma "μας"; "İ" too.
    const { ctx } = await world();
    const odd = "ΜΑΣ@atelier.example";
    const row = { accountId: ctx.accountId, kind: "sender", match: odd, priority: 0, enabled: true, provenance: "manual" };
    await (ctx.db as unknown as Awaited<ReturnType<typeof makeTestDb>>).insert(rulesTbl).values([
      { ...row, id: LOW, destination: "INBOX" }, { ...row, id: HIGH, destination: "ohmail/Screened" },
    ]);
    const out = mutated(await rulesService.update(ctx, HIGH, { destination: "ohmail/News" }));
    expect(out.rule.destination).toBe("ohmail/News");
    expect((await rulesService.list(ctx)).map((r) => r.id)).toEqual([HIGH]);
    await rulesService.remove(ctx, HIGH);
    expect(await rulesService.list(ctx)).toEqual([]);
  });
});

