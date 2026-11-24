import { describe, expect, it } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, rules as rulesTbl } from "@trafficflow/db";
import { DEFAULT_OHBOX_POLICY, evaluateRules, type NormalizedMessage } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { rulesService } from "../src/rules-service.js";
import { mutated } from "./helpers.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * WHAT THE SHEET'S VERBS WRITE OVER A SENDER'S RULE TWINS, as the router then reads it
 * (SENDER-SHEET-ALREADY-OVER-AN-OUTRANKING-TWIN). An allow into the Ohbox and a deny into
 * Screened for one address, seeded as rows the way twins still arrive (an older store, a promotion
 * beside a press): the deny wins. `update` converges the key onto the PRESSED row and collapses
 * the other, so a press on either twin decides; `create` over the key reconciles the ACTING twin
 * and collapses the other. Each case asks `evaluateRules` over the repo's own `listRules` where
 * the next message goes, and how many rows the key holds afterwards.
 */
const NOW = new Date("2026-08-04T12:00:00Z");
const ADDR = "lena@atelier.example";

async function world(): Promise<{ db: Db; ctx: ServiceContext }> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `twins-${accountId.slice(0, 8)}` });
  return { db, ctx: { db: dbFor(db, accountId), accountId, now: () => NOW } as unknown as ServiceContext };
}

function next(): NormalizedMessage {
  return {
    canonical: { messageIdHeader: "next@x", bodyHash: "h" },
    subject: "Hello again", from: { name: null, address: ADDR }, to: [], cc: [], date: null,
    headers: {}, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
}

async function nextFiles(ctx: ServiceContext): Promise<string | null> {
  const rules = await makeDrizzleRepo(ctx.db as never).listRules(ctx.accountId);
  return evaluateRules({
    msg: next(), rules, knownSenders: { addresses: new Set(), inferred: new Set<string>(), lists: new Map() }, ownAddresses: new Set<string>(), auth: "unauthenticated",
    ohboxPolicy: DEFAULT_OHBOX_POLICY, identity: null,
  }).destination;
}

async function twins(ctx: ServiceContext) {
  const row = { accountId: ctx.accountId, kind: "sender", match: ADDR, priority: 0, enabled: true, provenance: "manual" };
  const db = ctx.db as unknown as Awaited<ReturnType<typeof makeTestDb>>;
  const [allow, deny] = await db.insert(rulesTbl)
    .values([{ ...row, destination: "INBOX" }, { ...row, destination: "ohmail/Screened" }])
    .returning({ id: rulesTbl.id });
  return { allow: allow!, deny: deny! };
}

describe("the router over an allow twin and an outranking deny twin", () => {
  it("the deny twin decides: the sender's next message is screened", async () => {
    const { ctx } = await world();
    await twins(ctx);
    expect(await nextFiles(ctx)).toBe("ohmail/Screened");
  });

  it("re-arming the allow twin — the old 'already' — collapses the deny: one rule, the Ohbox", async () => {
    const { ctx } = await world();
    const { allow } = await twins(ctx);
    mutated(await rulesService.update(ctx, allow.id, { destination: "INBOX", applyRetro: true }));
    expect(await nextFiles(ctx)).toBe("INBOX");
    const rules = await makeDrizzleRepo(ctx.db as never).listRules(ctx.accountId);
    expect(rules.map((r) => [r.id, r.destination])).toEqual([[allow.id, "INBOX"]]);
  });

  it("a create at the Ohbox reconciles the acting deny twin and collapses the other: one rule, the Ohbox", async () => {
    const { ctx } = await world();
    const { deny } = await twins(ctx);
    const out = mutated(await rulesService.create(ctx, { kind: "sender", match: ADDR, destination: "INBOX" }));
    expect(out.created).toBe(false);
    expect(out.rule.id).toBe(deny.id);
    expect(await nextFiles(ctx)).toBe("INBOX");
    const rules = await makeDrizzleRepo(ctx.db as never).listRules(ctx.accountId);
    expect(rules.map((r) => r.destination)).toEqual(["INBOX"]);
  });

  it("retargeting the deny twin replaces its destination, and their mail files into the Ohbox", async () => {
    const { ctx } = await world();
    const { deny } = await twins(ctx);
    const out = mutated(await rulesService.update(ctx, deny.id, { destination: "INBOX", applyRetro: true })).rule;
    expect(out.destination).toBe("INBOX");
    expect(await nextFiles(ctx)).toBe("INBOX");
    const rules = await makeDrizzleRepo(ctx.db as never).listRules(ctx.accountId);
    expect(rules.map((r) => [r.id, r.destination, r.effect])).toEqual([[deny.id, "INBOX", "allow"]]);
  });
});
