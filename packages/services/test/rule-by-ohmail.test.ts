import type { RuleDTO } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { applyScreenerDecision, recordLearningSignal, rules, SCREENER_ACT_TRIGGER_PREFIX } from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { materializeRule, syncService } from "../src/index.js";
import { materializeRules } from "../src/dto/materialize.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * THE RULES THE ACT ON SUGGESTIONS WROTE CARRY A MARK, and a person's do not.
 *
 * Settings → Rules listed every promoted rule "from a Screener decision", the act's and a press's
 * alike. The mark is read from the rule and the Screener decisions on record about its sender:
 * the column a press stamps has no backfill, so it cannot decide alone (the pre-0128 case below),
 * and a rescue out of Spam writes a promoted rule without it (the destination case).
 */

const NOW = new Date("2026-09-27T09:00:00Z");
type World = Awaited<ReturnType<typeof makeCtx>>;

async function decide(w: World, from: string, folder: string, by: "person" | "pass"): Promise<string> {
  const id = await seedMessage(w.db, w.accountId, w.mailboxId, { from, folder: "ohmail/Screener" });
  const out = await w.db.transaction((tx) => applyScreenerDecision(carryDialect(w.db, tx), {
    accountId: w.accountId, scope: "sender", address: from, appliedFolder: folder,
    decision: folder === "INBOX" ? "yes" : "no",
    triggeringActionId: by === "pass" ? `${SCREENER_ACT_TRIGGER_PREFIX}${id}` : `screener:${id}`,
    now: NOW, stampBaseline: false, decidedBy: by, overExisting: by === "pass" ? "skip" : "converge",
    ...(by === "pass" ? { liftOverDomain: false } : {}),
  }));
  return out.createdRuleId!;
}

async function snapshotRules(w: World): Promise<Map<string, RuleDTO>> {
  const page = await syncService.getSnapshot(w.ctx, {});
  const out = new Map<string, RuleDTO>();
  for (const c of page.changes) if (c.type === "rule") out.set(c.id, c.entity as RuleDTO);
  return out;
}

describe("RuleDTO.byOhmail", () => {
  it("the act's rule carries it on every emitter, and a press's rule does not", async () => {
    const w = await makeCtx(NOW);
    const act = await decide(w, "news@act.example", "ohmail/Screened", "pass");
    const press = await decide(w, "friend@press.example", "INBOX", "person");

    expect((await materializeRule(w.db, w.accountId, act))!.byOhmail).toBe(true);
    expect((await materializeRule(w.db, w.accountId, press))!.byOhmail).toBe(false);
    const batch = await materializeRules(w.db, w.accountId, [act, press]);
    expect(batch.get(act)!.byOhmail).toBe(true);
    expect(batch.get(press)!.byOhmail).toBe(false);
    const snap = await snapshotRules(w);
    expect(snap.get(act)!.byOhmail, "the bootstrap page drops the mark").toBe(true);
    expect(snap.get(press)!.byOhmail).toBe(false);
  });

  it("a press from before mail 0128 has no stamp and is still a person's", async () => {
    const w = await makeCtx(NOW);
    const press = await decide(w, "old@press.example", "ohmail/Screened", "person");
    await w.db.update(rules).set({ personDecidedAt: null }).where(eq(rules.id, press));
    expect((await materializeRule(w.db, w.accountId, press))!.byOhmail).toBe(false);
  });

  it("a person deciding the same sender afterwards takes the mark off", async () => {
    const w = await makeCtx(NOW);
    const act = await decide(w, "late@act.example", "ohmail/Screened", "pass");
    await decide(w, "late@act.example", "ohmail/Screened", "person");
    expect((await materializeRule(w.db, w.accountId, act))!.byOhmail).toBe(false);
  });

  it("a rescue out of Spam is not the act's, though the act filed the sender there", async () => {
    const w = await makeCtx(NOW);
    await decide(w, "saved@rescue.example", "ohmail/Quarantine", "pass");
    const [rescue] = await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "saved@rescue.example", destination: "INBOX",
      provenance: "promoted", enabled: true,
    }).returning({ id: rules.id });
    expect((await materializeRule(w.db, w.accountId, rescue!.id))!.byOhmail).toBe(false);
  });

  it("a rule a person stamped is theirs, whatever the signals on record say", async () => {
    const w = await makeCtx(NOW);
    const act = await decide(w, "stamped@act.example", "ohmail/Screened", "pass");
    await w.db.update(rules).set({ personDecidedAt: NOW }).where(eq(rules.id, act));
    expect((await materializeRule(w.db, w.accountId, act))!.byOhmail).toBe(false);
  });

  it("a rule the person moved elsewhere is theirs", async () => {
    const w = await makeCtx(NOW);
    const act = await decide(w, "moved@act.example", "ohmail/Screened", "pass");
    await w.db.update(rules).set({ destination: "ohmail/News" }).where(eq(rules.id, act));
    expect((await materializeRule(w.db, w.accountId, act))!.byOhmail).toBe(false);
  });

  it("a sender the act filed through its old folder name still reads as the act's", async () => {
    const w = await makeCtx(NOW);
    const [rule] = await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "digest@act.example", destination: "ohmail/News",
      provenance: "promoted", enabled: true,
    }).returning({ id: rules.id });
    await w.db.transaction((tx) => recordLearningSignal(carryDialect(w.db, tx), w.accountId, {
      triggeringActionId: `${SCREENER_ACT_TRIGGER_PREFIX}legacy`, kind: "screener",
      senderAddress: "digest@act.example", destination: "ohmail/Reads", label: "positive",
    }));
    expect((await materializeRule(w.db, w.accountId, rule!.id))!.byOhmail).toBe(true);
  });
});
