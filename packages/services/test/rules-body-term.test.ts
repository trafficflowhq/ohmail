import { describe, it, expect } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, rules } from "@trafficflow/db";
import { MAX_BODY_CONTAINS_CHARS, rulesService } from "../src/rules-service.js";
import { mutated } from "./helpers.js";
import type { Db, ServiceContext } from "../src/context.js";

/* Every case in this file runs as the ORGANIZER, where a rule edit is written locally. `create`
 * and `update` answer a union — that mutation, or a request routed to the install that organizes
 * the mailbox — so the local arm is narrowed once here instead of at each call: `mutated` refuses
 * the routed arm by name, where a cast would leave `rule` reading as `undefined`. */
const createRule = async (...a: Parameters<typeof rulesService.create>) =>
  mutated(await rulesService.create(...a));
const updateRule = async (...a: Parameters<typeof rulesService.update>) =>
  mutated(await rulesService.update(...a));

/**
 * THE THIRD TERM ON A SENDER RULE, AT THE SERVICE BOUNDARY — mail 0052.
 *
 * `rules-subject-term.test.ts` states what a file like this guards and why, and every word of it
 * applies here with "subject" replaced by "body": not the matching (that is
 * `packages/core/test/rules-body{,.pg}.test.ts`) but the BOUNDARY, whose one fatal shape is a
 * term that is present but BLANK — a substring of everything, on a rule the specificity clauses
 * rank ABOVE the user's real rule. For a body term the blast radius is a notch wider than the
 * subject's: a blank subject term matches every subject, a blank body term matches every MESSAGE.
 *
 * The blank is REFUSED, never coerced to `null`, on the sibling file's reasoning: coercion writes
 * a safe rule that is not the rule the caller asked for. An explicit `null` still clears a term.
 */

const NOW = new Date("2026-08-10T12:00:00Z");
const SENDER = "info@sichersatt.example";
const TOKEN = "[NinjaFirewall]";

async function world(): Promise<{ db: Db; ctx: ServiceContext }> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `bodyt-${accountId.slice(0, 8)}` });
  const ctx = { db: dbFor(db, accountId), accountId, now: () => NOW } as unknown as ServiceContext;
  return { db, ctx };
}

const row = async (db: Db, id: string) => {
  const [r] = await db.select().from(rules).where(eq(rules.id, id));
  return r!;
};

const BODY = { kind: "sender", match: SENDER, destination: "ohmail/News" };

describe("creating a rule with a body term", () => {
  it("stores the term verbatim and reports it on the DTO", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, bodyContains: TOKEN });
    expect((await row(db, rule.id)).bodyContains).toBe(TOKEN);
    expect(rule.bodyContains).toBe(TOKEN);
  });

  it("trims surrounding whitespace, so the stored term and the wire agree", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, bodyContains: `  ${TOKEN}\t` });
    expect((await row(db, rule.id)).bodyContains).toBe(TOKEN);
  });

  it("carries NULL when the caller says nothing — every rule written before this column", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    expect((await row(db, rule.id)).bodyContains).toBeNull();
    expect(rule.bodyContains).toBeNull();
  });

  it("REFUSES a blank term instead of quietly writing a broad rule", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Three blank shapes, each a 400 — not a bare rule, and
    // not a 500 from the CHECK. Replacing the throw with `return null` makes all three go red.
    const { ctx } = await world();
    for (const term of ["", "   ", "\t\n"]) {
      await expect(
        createRule(ctx, { ...BODY, bodyContains: term }),
        `a blank term (${JSON.stringify(term)}) was accepted`,
      ).rejects.toThrow(/blank/i);
    }
  });

  it("refuses a non-string rather than coercing it", async () => {
    const { ctx } = await world();
    await expect(
      createRule(ctx, { ...BODY, bodyContains: 0 as unknown as string }),
    ).rejects.toThrow(/string/i);
  });

  it("refuses a term over the ceiling the CHECK enforces, and accepts one at it", async () => {
    // The service limit and the constraint are the SAME number, or the ceiling is a database
    // error dressed as a validated request.
    const { db, ctx } = await world();
    await expect(
      createRule(ctx, { ...BODY, bodyContains: "x".repeat(MAX_BODY_CONTAINS_CHARS + 1) }),
    ).rejects.toThrow(/at most/i);
    const { rule } = await createRule(ctx, {
      ...BODY, bodyContains: "x".repeat(MAX_BODY_CONTAINS_CHARS),
    });
    expect((await row(db, rule.id)).bodyContains).toHaveLength(MAX_BODY_CONTAINS_CHARS);
  });

  it("refuses a term on a domain rule — the one kind combination nothing composes", async () => {
    const { ctx } = await world();
    await expect(
      createRule(ctx, {
        kind: "domain", match: "sichersatt.example", destination: "ohmail/News", bodyContains: TOKEN,
      }),
    ).rejects.toThrow(/sender rule/i);
  });

  it("composes with a subject term in one create — both stored, both verbatim", async () => {
    // The two terms are independent conjuncts and a rule may carry both; the boundary must not
    // make the caller choose. The evaluator's four-state proof is in `rules-body.test.ts`.
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, {
      ...BODY, subjectContains: "Alert", bodyContains: TOKEN,
    });
    const stored = await row(db, rule.id);
    expect(stored.subjectContains).toBe("Alert");
    expect(stored.bodyContains).toBe(TOKEN);
    expect(rule.subjectContains).toBe("Alert");
    expect(rule.bodyContains).toBe(TOKEN);
  });

  it("stamps the retroactive request exactly as a one-term rule does", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, bodyContains: TOKEN });
    const stored = await row(db, rule.id);
    expect(stored.retroRequestedAt).toEqual(NOW);
    expect(stored.retroDoneAt).toBeNull();
  });
});

describe("editing the body term", () => {
  it("a CHANGED term re-opens the backlog, cursor and marker reset", async () => {
    // `body_contains` decides WHICH mail the rule is about, so editing it is a retroactive event
    // exactly as a destination or subject-term change is — and in both directions. A stale cursor
    // would skip everything before it, hence the full reset rather than a re-stamp.
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, bodyContains: TOKEN });
    await db.update(rules)
      .set({ retroDoneAt: NOW, retroCursor: randomUUID(), retroMoved: 7 })
      .where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, { bodyContains: "[NinjaFirewall] Alert" });

    const after = await row(db, rule.id);
    expect(after.bodyContains).toBe("[NinjaFirewall] Alert");
    expect(after.retroRequestedAt).toEqual(NOW);
    expect(after.retroDoneAt, "the pass was left marked done over a rule that now names other mail")
      .toBeNull();
    expect(after.retroCursor).toBeNull();
    expect(after.retroMoved).toBe(0);
  });

  it("re-sending the SAME term re-applies nothing — a habit-click stays cheap", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, bodyContains: TOKEN });
    await db.update(rules).set({ retroDoneAt: NOW }).where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, { bodyContains: TOKEN });

    expect((await row(db, rule.id)).retroDoneAt, "an unchanged term re-walked the whole backlog")
      .toEqual(NOW);
  });

  it("an explicit NULL clears the term, and THAT re-opens the backlog too", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, bodyContains: TOKEN });
    await db.update(rules).set({ retroDoneAt: NOW }).where(eq(rules.id, rule.id));

    const { rule: after } = await updateRule(ctx, rule.id, { bodyContains: null });

    expect(after.bodyContains).toBeNull();
    expect((await row(db, rule.id)).retroDoneAt).toBeNull();
  });

  it("refuses a blank term on a PATCH as well, and validates the kind from the STORED row", async () => {
    const { ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, bodyContains: TOKEN });
    await expect(
      updateRule(ctx, rule.id, { bodyContains: "  " }),
    ).rejects.toThrow(/blank/i);

    const { rule: domainRule } = await createRule(ctx, {
      kind: "domain", match: "sichersatt.example", destination: "ohmail/News",
    });
    await expect(
      updateRule(ctx, domainRule.id, { bodyContains: TOKEN }),
    ).rejects.toThrow(/sender rule/i);
  });

  it("accepts a term on a rule the SAME patch turns into a sender rule", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, {
      kind: "domain", match: "sichersatt.example", destination: "ohmail/News",
    });
    await updateRule(ctx, rule.id, {
      kind: "sender", match: SENDER, bodyContains: TOKEN,
    });
    const after = await row(db, rule.id);
    expect(after.kind).toBe("sender");
    expect(after.bodyContains).toBe(TOKEN);
  });
});
