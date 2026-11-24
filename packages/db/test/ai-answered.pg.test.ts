import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "../src/dialect/index.js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accounts, type Tx } from "../src/index.js";
import { getAiAnswer, schema, setAiEnabled } from "../src/cloud.js";
import { runMigrations } from "../src/admin.js";
import { pgTestUrl } from "../src/testing.js";

/**
 * ═══ "HAS ANYBODY BEEN ASKED ABOUT AI?" — the question the switch cannot answer ═════════════
 *
 * ── THE DEFECT, MEASURED RATHER THAN READ ───────────────────────────────────────────────────
 *
 * `OnboardingAi` is a four-state union because "answered no" and "never asked" select opposite
 * screens. The hosted door could supply three, and the note that said so also said `ai_enabled`
 * "rests false" — which is wrong twice over. The column is `NOT NULL DEFAULT true` (0019) and
 * `aiEnabledFor` falls back to `true` for a missing row, so a fresh account reported `on` and
 * `deriveOnboardingStep`'s AI row never fired. Driving the derivation with a fresh hosted account
 * answers `pull`: the question was not asked twice, it was never asked, on an account whose AI
 * was already spending its credits.
 *
 * ── WHY THIS FILE IS ON REAL POSTGRES ───────────────────────────────────────────────────────
 *
 * The write is a conditional UPDATE on a column with a NOT NULL DEFAULT, and the whole point is
 * what happens when the value does NOT change. PGlite green means nothing for that class
 * (AGENTS.md), and the interesting half — the migration's backfill touching only `ai_enabled =
 * false` rows — is a statement, not a function.
 *
 * Mutation-checked, each watched red and restored:
 *  · restore the bare `if (previous === enabled) return …` → the unchanged-value cases;
 *  · drop `aiAnsweredAt` from the changed-value UPDATE     → the switch-moved case;
 *  · `answered: row.aiAnsweredAt === null`                 → every read case.
 */

const URL = pgTestUrl(import.meta.url);
const client = postgres(URL, { max: 2 });
const db = brandDialect(drizzle(client, { schema }), "pg");
const tx = db as unknown as Tx;

beforeAll(async () => { await runMigrations(URL); });
afterAll(async () => { await client.end({ timeout: 5 }); });

/** A fresh account, exactly as the product creates one: AI on by default, nobody asked. */
async function freshAccount(): Promise<string> {
  const id = randomUUID();
  await tx.insert(accounts).values({ id, name: "ai-answered" });
  return id;
}

const rowOf = async (id: string) =>
  (await tx.select().from(accounts).where(eq(accounts.id, id)).limit(1))[0]!;

describe("the answer is recorded even when the switch does not move", () => {
  it("A FRESH ACCOUNT HAS NOT BEEN ASKED, though its AI is already on", async () => {
      const id = await freshAccount();
      const row = await rowOf(id);
      // The resting value, and the whole reason a second column is needed: this `true` is not
      // an answer, and no reading of it can tell that.
      expect(row.aiEnabled, "the switch rests ON").toBe(true);
      expect(row.aiAnsweredAt, "and nobody has been asked").toBeNull();
      expect(await getAiAnswer(tx, id)).toEqual({ enabled: true, answered: false });
  });

  it('"YES" ON A FRESH ACCOUNT IS RECORDED — the case that used to write nothing at all', async () => {
      const id = await freshAccount();
      const at = new Date("2026-09-02T12:00:00.000Z");
      const out = await setAiEnabled(tx, id, true, { userId: null }, at);
      // The switch did NOT move, and that is exactly right: it was already on.
      expect(out).toEqual({ aiEnabled: true, changed: false });
      // …and the ANSWER did. Before this, the most likely answer anybody gives was never
      // recorded and the flow asked again on every resume, for ever.
      expect((await rowOf(id)).aiAnsweredAt).toEqual(at);
      expect(await getAiAnswer(tx, id)).toEqual({ enabled: true, answered: true });
  });

  it('"NO" moves the switch AND records the answer', async () => {
      const id = await freshAccount();
      const at = new Date("2026-09-02T12:00:00.000Z");
      const out = await setAiEnabled(tx, id, false, { userId: null }, at);
      expect(out).toEqual({ aiEnabled: false, changed: true });
      const row = await rowOf(id);
      expect(row.aiEnabled).toBe(false);
      expect(row.aiAnsweredAt).toEqual(at);
      expect(await getAiAnswer(tx, id)).toEqual({ enabled: false, answered: true });
  });

  it("answering the same way twice re-stamps, and still reports the switch unmoved", async () => {
      const id = await freshAccount();
      await setAiEnabled(tx, id, false, { userId: null }, new Date("2026-09-02T12:00:00.000Z"));
      const later = new Date("2026-09-02T13:00:00.000Z");
      const out = await setAiEnabled(tx, id, false, { userId: null }, later);
      expect(out.changed, "the switch did not move").toBe(false);
      // Re-stamping is right: the column records WHEN the question was last answered, and it is
      // read as `IS NOT NULL` anyway, so the instant cannot change any decision.
      expect((await rowOf(id)).aiAnsweredAt).toEqual(later);
  });

  it("CONTROL: the switch still means what it always did, so Settings is unaffected", async () => {
      const id = await freshAccount();
      await setAiEnabled(tx, id, false, { userId: null }, new Date());
      expect((await rowOf(id)).aiEnabled).toBe(false);
      await setAiEnabled(tx, id, true, { userId: null }, new Date());
      expect((await rowOf(id)).aiEnabled).toBe(true);
  });
});

describe("getAiAnswer fails towards ASKING", () => {
  it("a missing row is `enabled, not answered` — the gate's fail-open plus the honest unknown", async () => {
      // `enabled: true` matches `aiEnabledFor`'s fail-open read, which the UI must agree with or
      // it would show a state the spend path does not honour. `answered: false` is the half that
      // matters here: an absent row cannot mean somebody was asked, and failing the other way
      // would walk silently past a consent question about spending credits.
      expect(await getAiAnswer(tx, randomUUID())).toEqual({ enabled: true, answered: false });
  });
});
