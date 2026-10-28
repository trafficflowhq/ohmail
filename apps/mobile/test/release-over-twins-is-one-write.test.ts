import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, heldRuleId, pressRules, type EngineMessage, type RuleDTO, type SyncChange } from "@ohmail/client-engine";
import { planHeldRouting, planPhoneRouting, releaseRules, routingReversal, type PhoneMoveIntent } from "../src/state/live";

/**
 * THE PHONE'S RELEASE AND MOVE OVER TWO COPIES OF ONE RULE ARE ONE WRITE (a review
 * finding, the web's mirror). The server converges a key onto the row a PATCH names, so a PATCH per twin
 * named a row the first one deleted: 404, and the press read as refused while the rule had moved.
 */
const ADDR = "lena@atelier.example";

function ruleRow(id: string, provenance: RuleDTO["provenance"]): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination: "ohmail/Screened", priority: 0, provenance, enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T09:00:00.000Z",
  };
}

async function mirror(rules: RuleDTO[], letters: string[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    ...rules.map((r): SyncChange => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
    ...letters.map((id): SyncChange => ({ type: "message", op: "create", id, seq: ++seq, updatedAt: "2026-08-01T09:00:00.000Z", entity: {
      id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: id, from: { name: null, address: ADDR },
      to: [], cc: [], date: "2026-08-01T09:00:00.000Z", folder: "ohmail/Screened", snippet: "", unread: true, hasAttachments: false,
      attachmentCount: 0, sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    } as EngineMessage })),
  ]);
  return store;
}

describe("the phone over two twins holding the sender at Screened", () => {
  it("Allow plans one PATCH, over the twin the router runs", async () => {
    const store = await mirror([ruleRow("a", "promoted"), ruleRow("b", "manual")]);
    expect(releaseRules(store, ADDR, "ohmail/Screened", "INBOX").mutations)
      .toEqual([{ kind: "rule_update", ruleId: "b", destination: "INBOX" }]);
  });

  it("Move's routing commit writes the same one PATCH, the backlog left where it is", async () => {
    const store = await mirror([ruleRow("a", "promoted"), ruleRow("b", "manual")]);
    const writes = planPhoneRouting(store, {
      v: 1, id: "p1", seedId: "m1", address: ADDR, scope: "sender", dest: "ohbox", messageIds: [], from: "ohmail/Screened", at: 0,
    });
    expect(writes).toEqual([{ kind: "rule_update", ruleId: "b", destination: "INBOX", applyRetro: false }]);
  });

  it("a press replayed after a kill moves its letter as the rule's, and a press with no rule as a plain move", async () => {
    const store = await mirror([ruleRow("a", "manual")], ["m1"]);
    const intent: PhoneMoveIntent = { v: 1, id: "p1", seedId: "m1", address: ADDR, scope: "sender", dest: "ohbox",
      messageIds: ["m1"], from: "ohmail/Screened", found: "ohmail/Screened", retro: true, at: 0 };
    expect(planPhoneRouting(store, intent).filter((w) => w.kind === "move"))
      .toEqual([{ kind: "move", messageId: "m1", folder: "INBOX", pressRule: true }]);
    expect(planPhoneRouting(store, { ...intent, holdsRule: false } as PhoneMoveIntent))
      .toEqual([{ kind: "move", messageId: "m1", folder: "INBOX" }]);
  });

  it("a lone rule is one write (the positive arm)", async () => {
    const store = await mirror([ruleRow("a", "manual")]);
    expect(releaseRules(store, ADDR, "ohmail/Screened", "INBOX").mutations).toHaveLength(1);
  });
});

/* A READER-ONLY PHONE plans over the organizer's published copy (`pressRules`), as the sheet does. */
describe("the phone's release and Move over the organizer's copy", () => {
  const AT = "2026-10-28T09:00:00.000Z";
  const KEY = { kind: "sender" as const, match: ADDR, subjectContains: null, bodyContains: null };
  const copyRule = (id: string, destination: string, over: Partial<RuleDTO> = {}): RuleDTO =>
    ({ ...ruleRow(id, "manual"), destination, ...over }) as RuleDTO;
  let seq = 900;
  const profile = (mailboxId: string, rules: RuleDTO[]): SyncChange => ({
    type: "mailbox_profile", op: "create", id: mailboxId, seq: ++seq, updatedAt: AT,
    entity: { mailboxId, rules, asOf: AT, from: { kind: "local", name: "Laptop", since: null }, updatedAt: AT, applied: [] },
  } as SyncChange);
  async function withCopies(...copies: SyncChange[]): Promise<MemoryMirrorStore> {
    const store = await mirror([], ["m1"]);
    await store.applyChanges(copies);
    return store;
  }
  const overOf = (store: MemoryMirrorStore) =>
    pressRules(store, { travels: true, queued: [], applied: [], unsettled: [], now: new Date(AT) });

  it("a rule only the organizer holds is retargeted by its key, and the window's commit writes it", async () => {
    const store = await withCopies(profile("mb", [copyRule("profile:mb:0", "ohmail/Screened")]));
    const over = overOf(store);
    expect(releaseRules(store, ADDR, "ohmail/Screened", "INBOX"), "over this device's rows").toEqual({ kind: "none", mutations: [] });
    expect(releaseRules(store, ADDR, "ohmail/Screened", "INBOX", over))
      .toEqual({ kind: "retarget", mutations: [{ kind: "rule_update", ruleId: heldRuleId(KEY), destination: "INBOX" }] });
    const intent: PhoneMoveIntent = { v: 1, id: "p1", seedId: "m1", address: ADDR, scope: "sender", dest: "ohbox",
      messageIds: ["m1"], from: "ohmail/Screened", found: "ohmail/Screened", retro: true, at: 0 };
    expect(planHeldRouting(store, intent, undefined, over)).toEqual([
      { kind: "rule_update", ruleId: heldRuleId(KEY), destination: "INBOX" },
      { kind: "move", messageId: "m1", folder: "INBOX", pressRule: true },
    ]);
  });

  it("twins across two copies: Not spam names the key's addressable row, never its #1 twin", async () => {
    const store = await withCopies(
      profile("mb-1", [copyRule("profile:mb-1:0", "ohmail/Quarantine", { provenance: "promoted" })]),
      profile("mb-2", [copyRule("profile:mb-2:0", "ohmail/Screened")]),
    );
    expect(releaseRules(store, ADDR, "ohmail/Quarantine", "INBOX", overOf(store)).mutations)
      .toEqual([{ kind: "rule_update", ruleId: heldRuleId(KEY), destination: "INBOX" }]);
  });

  it("a domain rule in the copy: an address rule, or it stands at a higher priority", async () => {
    const dom = (priority: number) => copyRule("profile:mb:0", "ohmail/Screened", { kind: "domain", match: "atelier.example", priority });
    const low = await withCopies(profile("mb", [dom(0)]));
    expect(releaseRules(low, ADDR, "ohmail/Screened", "INBOX", overOf(low))).toEqual({
      kind: "address", domain: "atelier.example",
      mutations: [{ kind: "rule_create", ruleKind: "sender", match: ADDR, destination: "INBOX", applyRetro: true }],
    });
    const high = await withCopies(profile("mb", [dom(5)]));
    expect(releaseRules(high, ADDR, "ohmail/Screened", "INBOX", overOf(high)).kind).toBe("stands");
  });

  it("a Move's way back after the commit puts the keyed rule back where the organizer filed", async () => {
    const store = await withCopies(profile("mb", [copyRule("profile:mb:0", "ohmail/News", { provenance: "promoted" })]));
    const back = routingReversal(() => store, [{ kind: "rule_update", ruleId: heldRuleId(KEY), destination: "INBOX" }], overOf(store));
    expect(back()).toEqual([{
      kind: "rule_update", ruleId: heldRuleId(KEY), destination: "ohmail/News", priority: 0, applyRetro: false,
      keepProvenance: true, restoreProvenance: "promoted",
    }]);
  });
});
