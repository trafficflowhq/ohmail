import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { automaticAiAdmits } from "../src/screener-suggestion.js";
import { messages } from "../src/schema-mail.js";

/**
 * ONE PREDICATE, TWO AUTOMATIC BUYERS — which held mail a model may be asked about with nobody
 * pressing. The always-on pass spelled the rule inline, and the suggest route's automatic batch did
 * not ask it at all, so a sender the pass kept out was sent by the browser's on-open batch
 * (SCREENER-NO-AI-SENDER-STILL-ASKED-ON-A-PURCHASE). Both now call `automaticAiAdmits`, neither
 * re-spells its clauses, and its SQL is pinned here; what each buyer DOES with it is measured where
 * it spends (`screener-ai.test.ts` for the route, `screener-auto-suggest.pg.test.ts` for the pass).
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const read = (p: string): string => withoutComments(readFileSync(`${REPO}/${p}`, "utf8"));

const BUYERS: ReadonlyArray<[string, string]> = [
  ["packages/organizer/src/screener-auto-suggest.ts", "the always-on pass (screenerAutoSuggestPass)"],
  ["packages/services/src/screener-service.ts", "the suggest route's automatic batch (ScreenerService.suggest)"],
];

/** Either clause spelled inline, in query-builder or raw-SQL form. */
const INLINE = /noAi\s*,\s*false|isNull\(\s*[\w.]*sensitivityCategory|no_ai\s*=\s*false|sensitivity_category\s+is\s+null/i;

describe("automatic AI — one predicate at both automatic buyers", () => {
  it.each(BUYERS)("%s calls the shared predicate", (file) => {
    expect(read(file)).toContain("automaticAiAdmits(");
  });

  it.each(BUYERS)("%s does not re-spell its clauses inline", (file) => {
    expect(read(file)).not.toMatch(INLINE);
  });

  it("the scanner finds a copy when there is one, and not one quoted in a comment", () => {
    // THE POSITIVE CONTROL: the two shapes the pass used to carry, and the raw-SQL twin.
    expect(withoutComments("and(eq(reps.noAi, false), x)")).toMatch(INLINE);
    expect(withoutComments("isNull(reps.sensitivityCategory),")).toMatch(INLINE);
    expect(withoutComments("sql`m.no_ai = false and m.sensitivity_category is null`")).toMatch(INLINE);
    expect(withoutComments("automaticAiAdmits({ noAi: reps.noAi, sensitivityCategory: c })")).not.toMatch(INLINE);
    expect(withoutComments("// eq(reps.noAi, false) is what this used to say\nconst a = 1;\n")).not.toMatch(INLINE);
  });

  it("is both columns, the stricter reading of each, and admits rather than excludes", () => {
    const q = new PgDialect().sqlToQuery(automaticAiAdmits(messages));
    expect(q.sql).toBe('("messages"."no_ai" = $1 and "messages"."sensitivity_category" is null)');
    expect(q.params).toEqual([false]);
  });
});
