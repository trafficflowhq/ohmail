import type { EngineMutation, MutationOutcome, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { HttpAdapter } from "../src/index.js";

/**
 * THE DECIDE'S CONFIRM CARRIES THE RULES IT WROTE, as `POST /rules` always has: the promoted rule
 * as a create and every twin it retargeted as an update, at the answer's `X-Sync-Seq`. Without
 * them a door whose `/sync` lags the server (the desktop's Cloud mirror mid-pull) settled the
 * press over a copy with no rule, and the sender's mail presented in the Ohbox.
 */

const AT = "2026-10-01T09:00:00.000Z";
const rule = (over: Partial<RuleDTO>): RuleDTO => ({
  id: "srv-rule", kind: "sender", match: "offers@spam.test", destination: "ohmail/Screened", priority: 0,
  provenance: "promoted", enabled: true, subjectContains: null, bodyContains: null,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: AT, updatedAt: AT,
  retro: { requestedAt: AT, doneAt: null }, byOhmail: false, ...over,
});
const CREATED = rule({});
const TWIN = rule({ id: "twin-1", provenance: "manual" });

const decide: EngineMutation = { kind: "screener_decide", senderId: "held", decision: "no", dest: "screened", scope: "sender" };

async function answer(body: unknown, opts: { status?: number; seq?: string | null } = {}): Promise<MutationOutcome> {
  const fetchImpl = (async () => new Response(JSON.stringify(body), {
    status: opts.status ?? 200,
    headers: { "content-type": "application/json", ...(opts.seq === null ? {} : { "x-sync-seq": opts.seq ?? "42" }) },
  })) as unknown as typeof globalThis.fetch;
  return await new HttpAdapter({ baseUrl: "https://door.test", fetch: fetchImpl })
    .mutate(decide, { idempotencyKey: "k" }) as MutationOutcome;
}

const DECIDED = {
  messageId: "held", appliedFolder: "ohmail/Screened", createdRuleId: CREATED.id,
  mailboxes: { filed: ["mb"], requested: [] },
};

describe("POST /screener/:id's confirm, as the adapter hands it to the engine", () => {
  it("echoes the created rule and the retargeted twins at the answer's seq", async () => {
    const out = await answer({ ...DECIDED, createdRule: CREATED, retargetedRules: [TWIN] });
    expect(out.changes.map((c) => [c.type, c.op, c.id, c.seq])).toEqual([
      ["rule", "create", CREATED.id, 42],
      ["rule", "update", TWIN.id, 42],
    ]);
    expect(out.changes[0]!.entity).toEqual(CREATED);
    expect(out.changes[1]!.entity).toEqual(TWIN);
    expect(out.entityId, "the created rule's id names the decision for the engine").toBe(CREATED.id);
    expect(out.partialEcho, "the held mail's moves still come from the drain").toBe(true);
  });

  it("no seq, no echo: the drain carries the rules (the door covered its own echo)", async () => {
    const out = await answer({ ...DECIDED, createdRule: CREATED, retargetedRules: [] }, { seq: null });
    expect(out.changes).toEqual([]);
    expect(out.entityId).toBe(CREATED.id);
  });

  it("an older server names the rule's id alone: nothing is echoed, the id still travels", async () => {
    const out = await answer(DECIDED);
    expect(out.changes).toEqual([]);
    expect(out.entityId).toBe(CREATED.id);
    expect(out.partialEcho).toBeUndefined();
  });

  it("a rule the answer does not name as the one it created is not echoed", async () => {
    for (const createdRule of [rule({ id: "other" }), { ...CREATED, kind: "nonsense" }, { id: CREATED.id }, "x"]) {
      const out = await answer({ ...DECIDED, createdRule, retargetedRules: ["junk", { id: 7 }] });
      expect(out.changes, JSON.stringify(createdRule)).toEqual([]);
    }
  });

  it("a decision with a queued half still echoes the rule the account wrote", async () => {
    const out = await answer({
      ...DECIDED, createdRule: CREATED, retargetedRules: [],
      mailboxes: { filed: [], requested: [{ mailboxId: "mb2", requestId: "r1", holder: { kind: "desktop", name: "Laptop", since: null } }] },
    });
    expect(out.pendingWith).toEqual({ name: "Laptop" });
    expect(out.changes.map((c) => c.id)).toEqual([CREATED.id]);
  });

  it("a 202 is a decision queued: no rule exists, nothing is echoed", async () => {
    const out = await answer({
      pending: true, requestId: "r1", holder: { kind: "desktop", name: "Laptop", since: null },
      createdRule: CREATED,
    }, { status: 202, seq: null });
    expect((out as { settlement?: string }).settlement).toBe("queued");
    expect(out.changes).toEqual([]);
  });
});
