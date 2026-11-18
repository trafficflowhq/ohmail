import type { EngineMutation, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore } from "../src/store.js";
import { mutationEffects } from "../src/mutations.js";

/**
 * THE ENGINE'S OWN REFUSALS FOR A RULE TERM — the third of the three layers (mail 0050/0051).
 *
 * The CHECK refuses a blank term at rest (`rules-{subject,body}.pg.test.ts`), `RulesService`
 * answers 400 at the API (`rules-{subject,body}-term.test.ts`), and THIS is the local layer:
 * `mutationEffects` yields no effects, so the engine rejects with nothing on the wire and — the
 * half that matters here — no OPTIMISTIC ROW. A blank term dropped instead of refused would
 * paint a bare rule covering the sender's whole mail: a different rule from the one the surface
 * requested, on screen until the server's 400 rolls it back. Same shape for a term on a
 * non-`sender` kind, which the server refuses too.
 *
 * Both terms are asserted side by side so the two refusals cannot drift apart, and the
 * legitimate paths (no term at all; a real term, either field or both) are pinned as ACCEPTED —
 * a refusal that overreaches is a sheet whose confirm press does nothing.
 */

const CTX = { now: () => new Date("2026-08-10T12:00:00.000Z"), uuid: () => "u-1" };

async function reader(): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  return store;
}

const create = (over: Partial<Extract<EngineMutation, { kind: "rule_create" }>>): EngineMutation => ({
  kind: "rule_create",
  ruleKind: "sender",
  match: "info@sichersatt.example",
  destination: "ohmail/News",
  ...over,
});

describe("rule_create term refusals, locally", () => {
  it("a blank term — either field — yields NO effects, never a bare optimistic rule", async () => {
    const r = await reader();
    for (const term of ["", "   ", "\t\n"]) {
      expect(mutationEffects(r, create({ subjectContains: term }), CTX),
        `blank subjectContains ${JSON.stringify(term)} produced an effect`).toEqual([]);
      expect(mutationEffects(r, create({ bodyContains: term }), CTX),
        `blank bodyContains ${JSON.stringify(term)} produced an effect`).toEqual([]);
    }
  });

  it("a term on a non-sender kind yields NO effects — the server would answer 400", async () => {
    const r = await reader();
    const domain = { ruleKind: "domain" as const, match: "sichersatt.example" };
    expect(mutationEffects(r, create({ ...domain, subjectContains: "[NF]" }), CTX)).toEqual([]);
    expect(mutationEffects(r, create({ ...domain, bodyContains: "[NF]" }), CTX)).toEqual([]);
    // …while the same domain rule WITHOUT a term is the ordinary accepted case.
    expect(mutationEffects(r, create(domain), CTX)).toHaveLength(1);
  });

  it("a real term is accepted, trimmed, and lands on the right FIELD of the optimistic row", async () => {
    const r = await reader();
    const [subjEffect] = mutationEffects(r, create({ subjectContains: " [NF] " }), CTX);
    expect((subjEffect!.entity as RuleDTO).subjectContains).toBe("[NF]");
    expect((subjEffect!.entity as RuleDTO).bodyContains).toBeNull();

    const [bodyEffect] = mutationEffects(r, create({ bodyContains: " [NF] " }), CTX);
    expect((bodyEffect!.entity as RuleDTO).bodyContains).toBe("[NF]");
    expect((bodyEffect!.entity as RuleDTO).subjectContains).toBeNull();

    // Both terms compose — the optimistic row carries both, exactly as the server will echo.
    const [both] = mutationEffects(
      r, create({ subjectContains: "Alert", bodyContains: "[NF]" }), CTX,
    );
    expect((both!.entity as RuleDTO).subjectContains).toBe("Alert");
    expect((both!.entity as RuleDTO).bodyContains).toBe("[NF]");
  });

  it("an absent term is the ordinary bare rule — the refusals must not overreach", async () => {
    const r = await reader();
    const effects = mutationEffects(r, create({}), CTX);
    expect(effects).toHaveLength(1);
    expect((effects[0]!.entity as RuleDTO).subjectContains).toBeNull();
    expect((effects[0]!.entity as RuleDTO).bodyContains).toBeNull();
  });
});
