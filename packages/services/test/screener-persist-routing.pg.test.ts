import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { eq, inArray } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { evaluateRules, type NormalizedMessage } from "@trafficflow/core/mail";

/**
 * SCR-RULE-PERSIST (#79) — DOES SCREENING A SENDER OUT STICK?
 *
 * ── THE FEARED DEFECT ───────────────────────────────────────────────────────────────────────
 *
 * The flagged risk: a screen-out moves the CURRENT mail but records no durable deny rule, so the
 * NEXT message from that sender is treated as a first contact again and re-queued to the Screener.
 * On a long triage of waiting senders that would make every "Screen out" futile — each stranger
 * you dismiss walks straight back to the gate on their next send.
 *
 * ── WHY THIS IS A `*.pg.test.ts` ────────────────────────────────────────────────────────────
 *
 * The claim is a chain across THREE components, and only the join proves the product:
 *   1. `ScreenerService.decide({decision:"no"})` writes a `rules` row (against real Postgres);
 *   2. `drizzle-repo.ts#listRules` reads that row back and maps its `ohmail/Screened` destination
 *      to `effect:"deny"` — there is no `effect` COLUMN, so the mapping is the load-bearing step;
 *   3. `evaluateRules` sees the deny rule win and files the sender's next message to
 *      `ohmail/Screened`, NOT `ohmail/Screener`.
 * A unit test on any one of the three can be green while the seam between them is broken; and the
 * routing read is exactly the kind of rule-order/effect question CLAUDE.md records PGlite hiding
 * three production bugs behind. So decide runs on :5433 and the routing read comes back through
 * the real adapter.
 *
 * ── THE MUTATION WATCH IS IN THE TEST, ON PURPOSE ───────────────────────────────────────────
 *
 * The guard is the rule the screen-out writes. Rather than mutate shared product code while other
 * lanes may hold it dirty, the SAME inbound message is evaluated three times against the SAME real
 * rule set:
 *   · BEFORE the screen-out (no rule) → `ohmail/Screener` — the stranger baseline;
 *   · AFTER the screen-out (deny rule present) → `ohmail/Screened` — the property under test;
 *   · AFTER deleting the rule (the "rule-write removed" mutation) → `ohmail/Screener` again — the
 *     sender re-appears, which is exactly the #79 failure, and is the red this guard is watched at.
 * The before/after/deleted triple makes the routing outcome a total function of the rule the
 * screen-out promotes: remove that write and the "after" assertion is the "before" state.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `scr-persist-${randomUUID().slice(0, 8)}`,
});

/** A plain first-contact message from `from` — no bulk markers, one usable author. */
function inbound(from: string): NormalizedMessage {
  return {
    canonical: { messageIdHeader: `<${randomUUID()}@ledgerandloom.test>`, bodyHash: "x" },
    subject: "A new note",
    from: { name: null, address: from },
    to: [],
    date: null,
    headers: {},
    textBody: "hello",
    htmlBody: null,
    hasAttachments: false,
    attachments: [],
  };
}

interface World {
  accountId: string;
  held: string[];
  address: string;
}

/** One waiting first-contact sender, `each` messages held in the Screener, NOT a known contact. */
async function newWorld(each = 3): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `scr-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `scr-${accountId.slice(0, 8)}@example.test`,
  }).returning();

  const address = `post@ledgerandloom.test`;
  const held: string[] = [];
  for (let i = 0; i < each; i += 1) {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `scr:${randomUUID()}`,
      subject: `Bulletin ${i}`, fromAddress: address,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    held.push(m!.id);
  }
  return { accountId, held, address };
}

/** Route one fresh inbound message from `address` through the REAL rule set for `accountId`. */
async function routeNext(accountId: string, address: string) {
  const repo = makeDrizzleRepo(db as never);
  const rulesForAccount = await repo.listRules(accountId);
  const knownSenders = await repo.knownSenders(accountId);
  return {
    rules: rulesForAccount,
    decision: evaluateRules({
      msg: inbound(address),
      rules: rulesForAccount,
      knownSenders, ownAddresses: new Set<string>(),
      auth: "unauthenticated",
      ohboxPolicy: "people_and_replied", identity: null,
    }),
  };
}

describe.skipIf(!PG_UP)("SCR-RULE-PERSIST — a screen-out durably screens the sender's next message", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("screen-out writes a deny rule and the next message routes to Screened, not the Screener", async () => {
    const w = await newWorld(3);

    // ── CONTROL: an unruled stranger's next message is a first contact → the Screener. ──────────
    const before = await routeNext(w.accountId, w.address);
    expect(before.rules, "a held stranger must carry no rule yet").toHaveLength(0);
    expect(
      before.decision.destination,
      "baseline: with no rule the sender's mail is a first contact and belongs at the gate",
    ).toBe("ohmail/Screener");

    // ── THE ACTION: screen the sender OUT. No `dest` ⇒ the two-folder default `ohmail/Screened`. ─
    const result = await new ScreenerService({}).decide(ctx(w.accountId), w.held[0]!, { decision: "no" });
    expect(result.appliedFolder).toBe("ohmail/Screened");

    // The held mail is filed out of the gate (pending, for the worker to move on IMAP).
    const state = await db.select({
      desired: folderState.desiredFolder, status: folderState.reconcileStatus,
    }).from(folderState).where(inArray(folderState.messageId, w.held));
    expect(state.every((r) => r.desired === "ohmail/Screened")).toBe(true);
    expect(state.every((r) => r.status === "pending")).toBe(true);

    // ── THE DURABLE FACT: a deny rule the adapter reads back as deny. ───────────────────────────
    const after = await routeNext(w.accountId, w.address);
    expect(after.rules, "the screen-out must persist exactly one rule").toHaveLength(1);
    expect(after.rules[0]).toMatchObject({
      kind: "sender", match: w.address, destination: "ohmail/Screened",
      effect: "deny", enabled: true,
    });

    // THE PROPERTY #79 IS ABOUT: the sender's NEXT message is screened out, never re-queued.
    expect(
      after.decision.destination,
      "a screened-out sender's next message must file to Screened, not re-appear at the gate",
    ).toBe("ohmail/Screened");
    expect(after.decision.source).toBe("rule");
    expect(after.decision.matchedRuleId).toBe(after.rules[0]!.id);

    // ── MUTATION WATCH: remove the rule the screen-out wrote → the sender re-appears. ───────────
    // This is the #79 failure made concrete. If `decide` had NOT written the rule (the feared
    // defect), the "after" state above would already read like this line, and the assertion on it
    // would be red.
    await db.delete(rules).where(eq(rules.accountId, w.accountId));
    const reverted = await routeNext(w.accountId, w.address);
    expect(
      reverted.decision.destination,
      "without the deny rule the sender is a first contact again — this is the guard biting",
    ).toBe("ohmail/Screener");
  });

  /**
   * A deny rule is ABSOLUTE against the seed's admission — the triage case exactly.
   *
   * The re-screen that fed the reported sender queue can hold senders the onboarding seed already wrote
   * an `INBOX` allow rule for. Screening such a sender OUT must win: `compareRules` ranks
   * deny-over-allow ABOVE provenance, so a `promoted` deny beats a `seeded-from-sent` allow at the
   * same priority without depending on which provenance the screen-out records.
   */
  it("a screen-out deny wins over a pre-existing seeded INBOX allow for the same sender", async () => {
    const w = await newWorld(1);
    // The seed's admission: an allow rule to the Ohbox for this very sender.
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: w.address,
      destination: "INBOX", provenance: "seeded-from-sent", enabled: true,
    });

    await new ScreenerService({}).decide(ctx(w.accountId), w.held[0]!, { decision: "no" });

    const { rules: ruleSet, decision } = await routeNext(w.accountId, w.address);
    // One rule per key: the screen-out converges onto the seeded row, which becomes the decision's.
    expect(ruleSet.map((r) => [r.destination, r.provenance]), "the seed's row takes the screen-out")
      .toEqual([["ohmail/Screened", "promoted"]]);
    expect(
      decision.destination,
      "the user's explicit screen-out must beat the inferred seed admission",
    ).toBe("ohmail/Screened");
    expect(decision.source).toBe("rule");
  });
});
