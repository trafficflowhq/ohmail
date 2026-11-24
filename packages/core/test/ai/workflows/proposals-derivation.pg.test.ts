import type { WorkflowPattern } from "@ohmail/wire";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, bindDb, learningSignals, rules, workflowProposals, type Tx } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { generateProposals } from "../../../src/ai/workflows/proposals.js";
import { makeOpusProposer } from "../../../src/ai/workflows/propose.js";
import type { AnthropicLike } from "../../../src/ai/classify.js";

/**
 * WHAT A PROPOSAL STORES, ON POSTGRES. The real port over a canned client: every stored row's
 * `source_pattern` is the pattern its answer named (by index, out of the order the model was sent),
 * its `trigger` is an `event` on that pattern's own sender or domain, and every step's `args` is
 * `{toFolder:<canonical>}` or `{}`. A pattern routed outside the six is never in the user turn.
 */
const PG_UP = await realPgAvailable();
const NOW = new Date("2026-10-12T12:00:00.000Z");
let owned: OwnedDb;

beforeAll(async () => {
  if (!PG_UP) return;
  await runMigrations(PG_TEST_URL);
  owned = makeOwnedDb(PG_TEST_URL);
}, 120_000);

afterAll(async () => { await owned?.close(); }, 60_000);

/** Answers every pattern it was sent, LAST FIRST, so a positional alignment would mis-store. */
function cannedClient(): AnthropicLike & { userTurn: () => string } {
  let userTurn = "";
  return {
    userTurn: () => userTurn,
    messages: {
      async create(params: unknown) {
        userTurn = (params as { messages: Array<{ content: string }> }).messages[0]!.content;
        const sent = (JSON.parse(userTurn) as { patterns: WorkflowPattern[] }).patterns;
        const proposals = sent.map((p, i) => ({
          pattern: i, name: `p-${p.senderAddress ?? p.senderDomain}`, rationale: "recurring",
          steps: p.provenance === "rule" ? [{ tool: "file_message" }, { tool: "draft_reply" }] : [{ tool: "file_message" }],
        })).reverse();
        return { content: [{ type: "text", text: JSON.stringify({ proposals }) }] };
      },
    },
  };
}

describe.skipIf(!PG_UP)("generateProposals on Postgres: the stored row is derived, never authored", () => {
  it("stores source_pattern, trigger and args exactly as ruled; a non-canonical destination is never sent", async () => {
    const [a] = await owned.db.insert(accounts).values({ name: `prop-${randomUUID().slice(0, 8)}` }).returning();
    const accountId = a!.id;
    try {
      const signal = async (sender: string, destination: string): Promise<void> => {
        for (let i = 0; i < 4; i++) {
          await owned.db.insert(learningSignals).values({
            accountId, triggeringActionId: `sig:${sender}:${i}:${randomUUID()}`, kind: "external_move",
            senderAddress: sender, senderDomain: sender.split("@")[1]!, destination, label: "positive",
          });
        }
      };
      await signal("news@acme.test", "ohmail/News");
      await signal("hidden@junk.test", "Junk");
      await signal("kept@own.test", "Archive/Projects");
      await owned.db.insert(rules).values({ accountId, kind: "domain", match: "billing.test", destination: "ohmail/Receipts", hits: 9 });

      const client = cannedClient();
      // The account's own pass: its handle bound to the account, as the proposal pass's is.
      const stored = await generateProposals(bindDb(owned.db, { account: accountId }) as unknown as Tx, accountId, {
        port: makeOpusProposer(client), now: () => NOW,
      });

      const turn = client.userTurn();
      expect(turn, "the port was never asked").toContain("news@acme.test");
      for (const never of ["Junk", "Archive/Projects", "hidden@junk.test", "kept@own.test"]) expect(turn).not.toContain(never);
      const sent = (JSON.parse(turn) as { patterns: WorkflowPattern[] }).patterns;
      expect(sent).toHaveLength(2);

      const rows = await owned.db.select().from(workflowProposals).where(eq(workflowProposals.accountId, accountId));
      expect(rows).toHaveLength(2);
      expect(stored).toHaveLength(2);
      for (const row of rows) {
        const named = sent.find((p) => row.name === `p-${p.senderAddress ?? p.senderDomain}`)!;
        expect(row.sourcePattern, "source_pattern is not the pattern the answer named").toEqual(named);
        expect(row.trigger).toEqual(named.kind === "sender"
          ? { kind: "event", match: { senderAddress: named.senderAddress } }
          : { kind: "event", match: { senderDomain: named.senderDomain } });
        const steps = row.steps as Array<{ tool: string; args: Record<string, unknown> }>;
        for (const step of steps) {
          expect(step.args).toEqual(step.tool === "file_message" ? { toFolder: named.destination } : {});
        }
      }
      const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
      expect(byName["p-news@acme.test"]!.steps).toEqual([{ tool: "file_message", args: { toFolder: "ohmail/News" } }]);
      expect(byName["p-billing.test"]!.trigger).toEqual({ kind: "event", match: { senderDomain: "billing.test" } });
    } finally {
      await owned.db.delete(workflowProposals).where(eq(workflowProposals.accountId, accountId));
      await owned.db.delete(learningSignals).where(eq(learningSignals.accountId, accountId));
      await owned.db.delete(rules).where(eq(rules.accountId, accountId));
      await owned.db.delete(accounts).where(eq(accounts.id, accountId));
    }
  });
});
