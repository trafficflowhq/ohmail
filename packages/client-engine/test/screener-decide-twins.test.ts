import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  mutationEffects,
  type EngineMessage,
  type Folder,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import { SHADOWED_ROWS } from "../src/shadow.js";

/**
 * THE DECIDE'S OVERLAY OVER A SENDER'S RULE TWINS (SCREENER-DECIDE-PROMOTES-BESIDE-AN-OUTRANKING-TWIN).
 * Mail held at the gate beside a deny twin presents in Screened. Admitting the sender promotes an
 * allow the deny outranks, so the overlay went on presenting the decided mail in Screened while
 * the server files it. The server now converges the subject's key onto its ACTING row
 * (`applyScreenerDecision`), and the overlay does the same: that row takes the decision, its twins
 * go (a null entity), and only a key with no row gets the promoted rule.
 */
const NOW = new Date("2026-09-25T09:00:00.000Z");
const ADDR = "lena@atelier.example";
let seq = 0;

function msg(id: string, folder: Folder, from = ADDR): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: id,
    from: { name: null, address: from }, to: [], cc: [], date: "2026-09-24T09:00:00.000Z", folder,
    snippet: id, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-24T09:00:00.000Z",
  };
}

function rule(id: string, destination: Folder, over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-24T10:00:00.000Z", updatedAt: "2026-09-24T10:00:00.000Z", ...over,
  };
}

async function mirror(messages: EngineMessage[], rules: RuleDTO[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r): SyncChange => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ]);
  return store;
}

const ctx = { now: () => NOW, uuid: () => "rule-promoted" };
const ruleEffects = (effects: ReturnType<typeof mutationEffects>) =>
  effects.filter((e) => e.type === "rule").map((e) => [e.id, e.entity === null ? null : (e.entity as RuleDTO).destination]);

describe("the decide's effects over the subject's twins", () => {
  it("admitting a held sender with a deny rule writes that rule: no promoted rule beside it", async () => {
    const store = await mirror([msg("m1", "ohmail/Screener")], [rule("r-deny", "ohmail/Screened")]);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m1", decision: "yes", dest: "ohbox" }, ctx);
    expect(ruleEffects(effects)).toEqual([["r-deny", "INBOX"]]);
  });

  it("screening out over two twins: the acting one takes the decision and the other goes", async () => {
    const store = await mirror([msg("m1", "ohmail/Screener")], [
      rule("r-reads", "ohmail/News"), rule("r-there", "ohmail/Screened"),
    ]);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m1", decision: "no", dest: "screened" }, ctx);
    // The deny acts (deny before allow), so it survives; the News twin collapses into it.
    expect(ruleEffects(effects)).toEqual([["r-there", "ohmail/Screened"], ["r-reads", null]]);
  });

  it("another sender, a term rule and the other kind are other keys: the promoted rule is written", async () => {
    const store = await mirror([msg("m1", "ohmail/Screener")], [
      rule("r-other", "ohmail/Screened", { match: "other@atelier.example" }),
      rule("r-term", "ohmail/Screened", { subjectContains: "invoice" }),
      rule("r-domain", "ohmail/Screened", { kind: "domain", match: "atelier.example" }),
    ]);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m1", decision: "yes" }, ctx);
    expect(ruleEffects(effects)).toEqual([["rule-promoted", "INBOX"]]);
  });

  it("a paused row under the key is the sender's rule: switched on at the decided place", async () => {
    const store = await mirror([msg("m1", "ohmail/Screener")], [rule("r-off", "ohmail/Screened", { enabled: false })]);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m1", decision: "yes" }, ctx);
    expect(effects.filter((e) => e.type === "rule").map((e) => [e.id, (e.entity as RuleDTO).destination, (e.entity as RuleDTO).enabled]))
      .toEqual([["r-off", "INBOX", true]]);
  });

  it("the domain scope reads the domain's twins", async () => {
    const store = await mirror([msg("m1", "ohmail/Screener")], [
      rule("r-domain", "ohmail/Screened", { kind: "domain", match: "atelier.example" }),
      rule("r-address", "ohmail/Screened"),
    ]);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m1", decision: "yes", scope: "domain" }, ctx);
    expect(ruleEffects(effects)).toEqual([["r-domain", "INBOX"]]);
  });

  it("the ordinary decide is unchanged: with no rule standing, the promoted rule is the only rule effect", async () => {
    const store = await mirror([msg("m1", "ohmail/Screener")], []);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m1", decision: "yes" }, ctx);
    expect(ruleEffects(effects)).toEqual([["rule-promoted", "INBOX"]]);
  });

  it("the press is the person's: its rule carries the mark, and a first yes on a domain asks for the walk", async () => {
    // A domain rule no person decided, already at the place: the press makes it theirs, and its walk then
    // takes the domain's letters held for want of confirmation, as the server's press asks.
    const inferred = { kind: "domain" as const, match: "atelier.example", provenance: "promoted" as const };
    const store = await mirror([msg("m1", "ohmail/Screener")], [rule("r-domain", "INBOX", inferred)]);
    const effects = mutationEffects(store, { kind: "screener_decide", senderId: "m1", decision: "yes", scope: "domain" }, ctx);
    expect(effects.find((e) => e.id === "r-domain")?.entity)
      .toMatchObject({ personDecided: true, retro: { requestedAt: NOW.toISOString(), doneAt: null } });
    // Already the person's, at the place: nothing is asked again.
    const decided = await mirror([msg("m2", "ohmail/Screener")], [rule("r-mine", "INBOX", { ...inferred, personDecided: true })]);
    const again = mutationEffects(decided, { kind: "screener_decide", senderId: "m2", decision: "yes", scope: "domain" }, ctx);
    expect((again.find((e) => e.id === "r-mine")?.entity as RuleDTO).retro).toBeUndefined();
    // A new rule is the person's too.
    const fresh = await mirror([msg("m3", "ohmail/Screener")], []);
    const created = mutationEffects(fresh, { kind: "screener_decide", senderId: "m3", decision: "yes" }, ctx);
    expect((created.find((e) => e.type === "rule")?.entity as RuleDTO).personDecided).toBe(true);
  });

  it("a retargeted twin is masked until the mirror agrees, as a rule_update's is", () => {
    expect(SHADOWED_ROWS.screener_decide).toContain("rule");
  });
});

describe("the list while the decide is in flight", () => {
  it("presents the admitted sender's mail in the Ohbox, not on the screened-out shelf", async () => {
    const store = await mirror([msg("m1", "ohmail/Screener")], [rule("r-deny", "ohmail/Screened")]);
    let answer!: () => void;
    const engine = new OhmailEngine({
      adapter: {
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
        mutate: async () => {
          await new Promise<void>((r) => { answer = r; });
          return { changes: [], seq: null };
        },
      },
      store,
      now: () => NOW,
    });
    await engine.start();
    expect(consentPartition(engine.read(), { now: NOW }).placeOf.get("m1")).toBe("ohmail/Screened");

    const pending = engine.mutate({ kind: "screener_decide", senderId: "m1", decision: "yes", dest: "ohbox" });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(consentPartition(engine.read(), { now: NOW }).placeOf.get("m1"), "the decided mail presents where the deny files it")
      .toBe("INBOX");
    answer();
    await pending;
  });
});
