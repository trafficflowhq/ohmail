import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine, pressVerdict, rulesAsRun, rulesList,
  type EngineAdapter, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * A RULE VERB THE SERVER REFUSED IS NOT OFFLINE. The server answered a revoke 500
 * every time; the engine kept the verb on its queue (right: a 500 is retried) with the overlay
 * hiding the rule, and the press read as "queued until you're back online" on a browser that was
 * online. The queued result now says the SERVER failed, and the rules surface reads each queued
 * rule verb with the rule as the mirror holds it, so the rule shows while it still runs.
 */

const ruleOf = (id: string, match: string): RuleDTO => ({
  id, kind: "sender", match, destination: "ohmail/News", priority: 0, provenance: "promoted", enabled: true,
  subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-10-13T04:01:00.000Z", updatedAt: "2026-10-13T04:01:00.000Z", retro: { requestedAt: null, doneAt: null },
} as RuleDTO);

const SERVER_500 = (): MutationRejectedError =>
  new MutationRejectedError("internal error", { status: 500, code: "internal", retryable: true });
const OFFLINE = (): MutationRejectedError =>
  new MutationRejectedError("network failure", { code: "network", retryable: true });
const DB_BUSY = (): MutationRejectedError =>
  new MutationRejectedError("database busy", { status: 503, code: "db_busy", retryable: true, retryAfterMs: 2_000 });

async function world(fail: () => MutationRejectedError) {
  const inner = new FixturesAdapter();
  const adapter: EngineAdapter = {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: () => inner.fetchBody(),
    sync: (p) => inner.sync(p),
    async mutate() { throw fail(); },
  };
  const store = new MemoryMirrorStore();
  const engine = new OhmailEngine({ adapter, store });
  await engine.start();
  await store.applyChanges([ruleOf("r34n", "b@r34n.example"), ruleOf("other", "c@other.example")].map((r, i) => ({
    type: "rule", op: "create", id: r.id, seq: 10_000 + i, updatedAt: r.updatedAt, entity: r,
  })) as SyncChange[]);
  return engine;
}

describe("a rule verb the server refused", () => {
  it("is queued as a server failure, and the rule still reads as running", async () => {
    const engine = await world(SERVER_500);
    const res = await engine.mutate({ kind: "rule_delete", ruleId: "r34n" });
    expect(res.status).toBe("queued");
    expect(res.serverFailed, "a 500 was read as an unanswered try").toBe(true);
    expect(pressVerdict(res)).toMatchObject({ kind: "queued", wait: "retry", failed: true });

    // The overlay still hides it from the ordinary read: the verb waits, as designed.
    expect(rulesList(engine.read()).map((r) => r.id)).toEqual(["other"]);
    const queued = engine.queuedRuleWrites();
    expect(queued).toMatchObject([{ verb: "revoke", ruleId: "r34n", serverFailed: true }]);
    expect(queued[0]!.rule?.id, "the mirror's own row").toBe("r34n");
    expect(rulesAsRun(engine.read(), queued).map((r) => r.id).sort()).toEqual(["other", "r34n"]);
  });

  it("a retarget the server refused reads the rule where it still files", async () => {
    const engine = await world(SERVER_500);
    await engine.mutate({ kind: "rule_update", ruleId: "r34n", destination: "INBOX", applyRetro: false });
    expect(rulesList(engine.read()).find((r) => r.id === "r34n")?.destination).toBe("INBOX");
    const queued = engine.queuedRuleWrites();
    expect(queued).toMatchObject([{ verb: "retarget", ruleId: "r34n", serverFailed: true }]);
    expect(rulesAsRun(engine.read(), queued).find((r) => r.id === "r34n")?.destination).toBe("ohmail/News");
  });

  it("an unanswered try (offline) and a server-named wait are not server failures", async () => {
    for (const fail of [OFFLINE, DB_BUSY]) {
      const engine = await world(fail);
      const res = await engine.mutate({ kind: "rule_delete", ruleId: "r34n" });
      expect(res.status).toBe("queued");
      expect(res.serverFailed).toBeUndefined();
      expect(pressVerdict(res)).toEqual({ kind: "queued", wait: "retry", holder: null });
      expect(engine.queuedRuleWrites()).toMatchObject([{ verb: "revoke", ruleId: "r34n", serverFailed: false }]);
    }
  });

  it("nothing queued reads exactly rulesList (the control)", async () => {
    const engine = await world(SERVER_500);
    expect(engine.queuedRuleWrites()).toEqual([]);
    expect(rulesAsRun(engine.read(), [])).toEqual(rulesList(engine.read()));
  });
});
