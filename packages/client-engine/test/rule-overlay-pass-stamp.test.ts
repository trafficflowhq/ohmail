import { describe, expect, it } from "vitest";
import { HttpAdapter, MemoryMirrorStore, mutationEffects, type RuleDTO, type SyncChange } from "@ohmail/client-engine";

/**
 * THE OVERLAY STATES THE PASS THE SERVER WILL START, AND NEVER ITS END. A create with past mail,
 * a retarget, or an explicit yes is "asked, not finished"; a create declining past mail is "not
 * asked"; a patch that neither moves the rule nor asks leaves the stamp as it was.
 */
const ctx = { now: () => new Date("2026-09-25T13:00:00.000Z"), uuid: () => "c-1" };
const ISO = "2026-09-25T13:00:00.000Z";
const rule: RuleDTO = {
  id: "r-1", kind: "sender", match: "a@x.example", destination: "INBOX", priority: 0, provenance: "manual", enabled: true,
  subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  retro: { requestedAt: "2026-09-01T00:00:00.000Z", doneAt: "2026-09-01T00:05:00.000Z" },
} as RuleDTO;

async function reader(r: RuleDTO = rule) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{ type: "rule", op: "create", id: r.id, seq: 1, updatedAt: r.updatedAt, entity: r }] as SyncChange[]);
  return store;
}
const retroOf = (effects: ReturnType<typeof mutationEffects>) => (effects[0]!.entity as RuleDTO).retro;

describe("the overlay's pass stamp", () => {
  it("a create asks unless it declines", async () => {
    const r = await reader();
    expect(retroOf(mutationEffects(r, { kind: "rule_create", ruleKind: "sender", match: "b@x.example", destination: "INBOX" }, ctx)))
      .toEqual({ requestedAt: ISO, doneAt: null });
    expect(retroOf(mutationEffects(r, { kind: "rule_create", ruleKind: "sender", match: "b@x.example", destination: "INBOX", applyRetro: false }, ctx)))
      .toEqual({ requestedAt: null, doneAt: null });
  });

  it("a retarget or an explicit yes re-asks; a no or a same-place patch keeps the stamp", async () => {
    const r = await reader();
    expect(retroOf(mutationEffects(r, { kind: "rule_update", ruleId: "r-1", destination: "ohmail/News" }, ctx)))
      .toEqual({ requestedAt: ISO, doneAt: null });
    expect(retroOf(mutationEffects(r, { kind: "rule_update", ruleId: "r-1", destination: "INBOX", applyRetro: true }, ctx)))
      .toEqual({ requestedAt: ISO, doneAt: null });
    expect(retroOf(mutationEffects(r, { kind: "rule_update", ruleId: "r-1", destination: "ohmail/News", applyRetro: false }, ctx)))
      .toEqual(rule.retro);
    expect(retroOf(mutationEffects(r, { kind: "rule_update", ruleId: "r-1", destination: "INBOX" }, ctx))).toEqual(rule.retro);
  });
});

describe("a Rules-page Change's re-filing", () => {
  const change = { kind: "rule_update", ruleId: "r-1", applyRetro: false, refile: true } as const;

  it("asks from the rule's place, or from where a waiting one started; a pause or the same place asks nothing", async () => {
    expect(retroOf(mutationEffects(await reader(), { ...change, destination: "ohmail/News" }, ctx)))
      .toEqual({ requestedAt: ISO, doneAt: null, from: "INBOX" });
    const waiting = { ...rule, destination: "ohmail/News", retro: { requestedAt: ISO, doneAt: null, from: "INBOX" } } as RuleDTO;
    expect(retroOf(mutationEffects(await reader(waiting), { ...change, destination: "ohmail/Receipts" }, ctx)))
      .toEqual({ requestedAt: ISO, doneAt: null, from: "INBOX" });
    expect(retroOf(mutationEffects(await reader({ ...rule, enabled: false }), { ...change, destination: "ohmail/News" }, ctx)))
      .toEqual(rule.retro);
    expect(retroOf(mutationEffects(await reader(), { ...change, destination: "INBOX" }, ctx))).toEqual(rule.retro);
  });

  it("a walk still owed goes to the new place whole: no origin, as the server answers", async () => {
    const owed = { ...rule, retro: { requestedAt: "2026-09-25T12:58:00.000Z", doneAt: null, from: null } } as RuleDTO;
    expect(retroOf(mutationEffects(await reader(owed), { ...change, destination: "ohmail/News" }, ctx)))
      .toEqual({ requestedAt: ISO, doneAt: null, from: null });
  });

  it("travels as refile: true beside the explicit no", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "null")));
      return new Response(JSON.stringify(rule), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const adapter = new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl });
    await adapter.mutate({ ...change, destination: "ohmail/News" }, { idempotencyKey: "k1" }).catch(() => null);
    await adapter.mutate({ kind: "rule_update", ruleId: "r-1", destination: "ohmail/News", applyRetro: false }, { idempotencyKey: "k2" }).catch(() => null);
    expect(bodies).toEqual([
      { destination: "ohmail/News", applyRetro: false, refile: true },
      { destination: "ohmail/News", applyRetro: false },
    ]);
  });
});
