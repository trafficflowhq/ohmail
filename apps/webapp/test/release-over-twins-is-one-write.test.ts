/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type ReleaseIntent, type RuleDTO, type SyncChange } from "@ohmail/client-engine";
import { releaseCommit, releaseRules } from "@ohmail/app-logic/press/sender-screening";

/**
 * A RELEASE OVER TWO COPIES OF ONE RULE IS ONE WRITE (H1). The server
 * converges a key onto the row a PATCH names and a DELETE takes every row under its key, so a
 * write per twin sent a second one naming a row already gone: 404, and the page said the sender
 * was still in Screened while the rule already filed them to the Ohbox.
 */
const ADDR = "lena@atelier.example";

function ruleRow(id: string, provenance: RuleDTO["provenance"], over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination: "ohmail/Screened", priority: 0, provenance, enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

async function mirror(rules: RuleDTO[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges(rules.map((r): SyncChange => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })));
  return store;
}

const intent = (dest: ReleaseIntent["dest"]): ReleaseIntent => ({
  v: 4, verb: "release", id: "p1", seedId: "m1", address: ADDR, scope: "sender", from: "ohmail/Screened", dest, messageIds: [], at: 0,
});

describe("a release over two twins holding the sender at Screened", () => {
  it("plans one PATCH, over the twin the router runs", async () => {
    const store = await mirror([ruleRow("a", "promoted"), ruleRow("b", "manual")]);
    const planned = releaseRules(store, ADDR, "ohmail/Screened", "INBOX");
    expect(planned.mutations).toEqual([{ kind: "rule_update", ruleId: "b", destination: "INBOX" }]);
  });

  it("the routing window's commit writes the same one PATCH", async () => {
    const store = await mirror([ruleRow("a", "promoted"), ruleRow("b", "manual")]);
    expect(releaseCommit(store, intent("ohbox"))).toEqual([{ kind: "rule_update", ruleId: "b", destination: "INBOX" }]);
  });

  it("back to Waiting deletes once per key", async () => {
    const store = await mirror([ruleRow("a", "promoted"), ruleRow("b", "manual")]);
    expect(releaseCommit(store, intent("screener"))).toEqual([{ kind: "rule_delete", ruleId: "b" }]);
  });

  it("two spellings of one address are one key, and a lone rule is one write (the positive arm)", async () => {
    const two = await mirror([ruleRow("a", "manual"), ruleRow("d", "manual", { match: ` ${ADDR.toUpperCase()} ` })]);
    expect(releaseRules(two, ADDR, "ohmail/Screened", "INBOX").mutations).toHaveLength(1);
    const one = await mirror([ruleRow("a", "manual")]);
    expect(releaseRules(one, ADDR, "ohmail/Screened", "INBOX").mutations).toEqual([{ kind: "rule_update", ruleId: "a", destination: "INBOX" }]);
  });
});
