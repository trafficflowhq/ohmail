import { describe, it, expect } from "vitest";
import { dbFor } from "../src/context.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, rules } from "@trafficflow/db";
import { MAX_SUBJECT_CONTAINS_CHARS, rulesService } from "../src/rules-service.js";
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
 * THE SECOND TERM ON A SENDER RULE, AT THE SERVICE BOUNDARY — mail 0050.
 *
 * `rules.subject_contains` lets one sender be split by subject: `info@` sends the invoice AND the
 * nightly `[NinjaFirewall]` alert, and a one-term rule files them together.
 *
 * ── WHAT THIS FILE IS ACTUALLY GUARDING ─────────────────────────────────────────────────────
 *
 * Not the matching — that is `packages/core/test/rules-subject{,.pg}.test.ts`. This is the
 * BOUNDARY, and there is exactly one shape that must never get through it: a term that is present
 * but BLANK.
 *
 * `""` is a substring of every string, so a blank term stored literally is a rule that matches
 * EVERY subject while its row reads as specific — and because a subject-carrying rule OUTRANKS a
 * bare one (`compareRules`' specificity clause), such a row would beat the user's real rule for that
 * sender and then file all of their mail. The migration's CHECK refuses it, and so must this: a
 * constraint violation surfacing as a 500 is not a validated request, and the two layers agreeing is
 * what makes "no term" have one representation.
 *
 * The tempting alternative — coerce a blank to `null` and create a BARE rule — is refused, and the
 * reason is worth stating because it is not the dangerous-looking option. It produces a rule that is
 * safe (the pre-column behaviour) and WRONG: the subject sheet says "file just the ones whose subject
 * matches", so the account would silently get a rule covering all of that sender's mail. Refusing is
 * the only answer that cannot surprise anybody. An explicit `null` remains the way to say "no term",
 * so nothing legitimate becomes unreachable — which the clear-the-term case below asserts.
 */

const NOW = new Date("2026-08-10T12:00:00Z");
const SENDER = "info@sichersatt.example";
const TOKEN = "[NinjaFirewall]";

async function world(): Promise<{ db: Db; ctx: ServiceContext }> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `subj-${accountId.slice(0, 8)}` });
  const ctx = { db: dbFor(db, accountId), accountId, now: () => NOW } as unknown as ServiceContext;
  return { db, ctx };
}

const row = async (db: Db, id: string) => {
  const [r] = await db.select().from(rules).where(eq(rules.id, id));
  return r!;
};

const BODY = { kind: "sender", match: SENDER, destination: "ohmail/News" };

describe("creating a rule with a subject term", () => {
  it("stores the term verbatim and reports it on the DTO", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, subjectContains: TOKEN });

    // VERBATIM — the case the user typed. Both surfaces quote it back at somebody who read it off
    // their own mail, so folding at rest would show them `[ninjafirewall]`.
    expect((await row(db, rule.id)).subjectContains).toBe(TOKEN);
    expect(rule.subjectContains).toBe(TOKEN);
  });

  it("trims surrounding whitespace, so the stored term and the wire agree", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, subjectContains: `  ${TOKEN}\t` });
    expect((await row(db, rule.id)).subjectContains).toBe(TOKEN);
  });

  it("carries NULL when the caller says nothing — every rule written before this column", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY });
    expect((await row(db, rule.id)).subjectContains).toBeNull();
    expect(rule.subjectContains).toBeNull();
  });

  it("REFUSES a blank term instead of quietly writing a broad rule", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Three blank shapes, each a 400 — not a bare rule, and not a
    // 500 from the CHECK. Replacing the throw with `return null` makes all three go red.
    const { ctx } = await world();
    for (const term of ["", "   ", "\t\n"]) {
      await expect(
        createRule(ctx, { ...BODY, subjectContains: term }),
        `a blank term (${JSON.stringify(term)}) was accepted`,
      ).rejects.toThrow(/blank/i);
    }
  });

  it("refuses a non-string rather than coercing it", async () => {
    // `subjectContains: 0` stringified to `"0"` is a rule matching every subject containing a zero.
    const { ctx } = await world();
    await expect(
      createRule(ctx, { ...BODY, subjectContains: 0 as unknown as string }),
    ).rejects.toThrow(/string/i);
  });

  it("refuses a term over the ceiling the CHECK enforces, and accepts one at it", async () => {
    // The service limit and the constraint have to be the SAME number: a service limit above the
    // CHECK is a database error dressed as a validated request.
    const { db, ctx } = await world();
    await expect(
      createRule(ctx, { ...BODY, subjectContains: "x".repeat(MAX_SUBJECT_CONTAINS_CHARS + 1) }),
    ).rejects.toThrow(/at most/i);
    const { rule } = await createRule(ctx, {
      ...BODY, subjectContains: "x".repeat(MAX_SUBJECT_CONTAINS_CHARS),
    });
    expect((await row(db, rule.id)).subjectContains).toHaveLength(MAX_SUBJECT_CONTAINS_CHARS);
  });

  it("refuses a term on a domain rule — the one kind combination nothing composes", async () => {
    // Refused rather than dropped: silently discarding a field the caller sent is how a client ends
    // up believing it wrote a narrow rule and getting a broad one.
    const { ctx } = await world();
    await expect(
      createRule(ctx, {
        kind: "domain", match: "sichersatt.example", destination: "ohmail/News", subjectContains: TOKEN,
      }),
    ).rejects.toThrow(/sender rule/i);
  });

  it("stamps the retroactive request exactly as a one-term rule does", async () => {
    // The subject rule rides the existing `retro_requested_at` machinery unchanged; the worker pass
    // over it is proven in `packages/organizer/test/rule-retro-subject.pg.test.ts`.
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, subjectContains: TOKEN });
    const stored = await row(db, rule.id);
    expect(stored.retroRequestedAt).toEqual(NOW);
    expect(stored.retroDoneAt).toBeNull();
  });
});

describe("editing the term", () => {
  it("a CHANGED term re-opens the backlog, cursor and marker reset", async () => {
    // `subject_contains` decides WHICH mail the rule is about, so editing it is a retroactive event
    // exactly as a destination change is — and in both directions. A stale cursor would skip
    // everything before it, which is why the whole retro state is reset rather than re-stamped.
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, subjectContains: TOKEN });
    await db.update(rules)
      .set({ retroDoneAt: NOW, retroCursor: randomUUID(), retroMoved: 7 })
      .where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, { subjectContains: "[NinjaFirewall] Alert" });

    const after = await row(db, rule.id);
    expect(after.subjectContains).toBe("[NinjaFirewall] Alert");
    expect(after.retroRequestedAt).toEqual(NOW);
    expect(after.retroDoneAt, "the pass was left marked done over a rule that now names other mail")
      .toBeNull();
    expect(after.retroCursor).toBeNull();
    expect(after.retroMoved).toBe(0);
  });

  it("re-sending the SAME term re-applies nothing — a habit-click stays cheap", async () => {
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, subjectContains: TOKEN });
    await db.update(rules).set({ retroDoneAt: NOW }).where(eq(rules.id, rule.id));

    await updateRule(ctx, rule.id, { subjectContains: TOKEN });

    expect((await row(db, rule.id)).retroDoneAt, "an unchanged term re-walked the whole backlog")
      .toEqual(NOW);
  });

  it("an explicit NULL clears the term, and THAT re-opens the backlog too", async () => {
    // Clearing is a legitimate edit and the only way to widen a narrow rule back to its whole
    // sender. It is a WIDENING, so mail the pass has never examined comes into scope — the same
    // reason a narrowing does, in the other direction.
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, subjectContains: TOKEN });
    await db.update(rules).set({ retroDoneAt: NOW }).where(eq(rules.id, rule.id));

    const { rule: after } = await updateRule(ctx, rule.id, { subjectContains: null });

    expect(after.subjectContains).toBeNull();
    expect((await row(db, rule.id)).retroDoneAt).toBeNull();
  });

  it("refuses a blank term on a PATCH as well, and validates the kind from the STORED row", async () => {
    // A PATCH need not carry the kind, so validating against the caller's absent field instead of the
    // row is how a domain rule acquires a term the API says it will not accept.
    const { ctx } = await world();
    const { rule } = await createRule(ctx, { ...BODY, subjectContains: TOKEN });
    await expect(
      updateRule(ctx, rule.id, { subjectContains: "  " }),
    ).rejects.toThrow(/blank/i);

    const { rule: domainRule } = await createRule(ctx, {
      kind: "domain", match: "sichersatt.example", destination: "ohmail/News",
    });
    await expect(
      updateRule(ctx, domainRule.id, { subjectContains: TOKEN }),
    ).rejects.toThrow(/sender rule/i);
  });

  it("accepts a term on a rule the SAME patch turns into a sender rule", async () => {
    // The kind validated is the kind the row will HAVE afterwards: one request may legally move a
    // rule from `domain` to `sender` and give it a term in the same breath.
    const { db, ctx } = await world();
    const { rule } = await createRule(ctx, {
      kind: "domain", match: "sichersatt.example", destination: "ohmail/News",
    });
    await updateRule(ctx, rule.id, {
      kind: "sender", match: SENDER, subjectContains: TOKEN,
    });
    const after = await row(db, rule.id);
    expect(after.kind).toBe("sender");
    expect(after.subjectContains).toBe(TOKEN);
  });
});
