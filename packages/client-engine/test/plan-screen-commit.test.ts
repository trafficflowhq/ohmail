import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  heldRuleId,
  planScreenCommit,
  pressRules,
  ruleFingerprint,
  type RuleDTO,
  type ScreenIntent,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * A RULE IS REMOVED ONLY AS IT WAS SHOWN. The commit deletes a rule the step listed only while its
 * fingerprint is the one the person saw; one edited or gone inside the window stays and is named in
 * `changed`, and a rule nobody was shown — one made during the window — is never touched.
 */
const ADDR = "alerts@kestrel.example";
let seq = 0;

function rule(o: Partial<RuleDTO> & Pick<RuleDTO, "id" | "destination">): RuleDTO {
  return {
    kind: "sender", match: ADDR, priority: 0, provenance: "manual", enabled: true,
    subjectContains: null, bodyContains: null, stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T08:00:00.000Z", updatedAt: "2026-08-01T08:00:00.000Z", ...o,
  } as RuleDTO;
}

async function mirror(rules: RuleDTO[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })) as SyncChange[]);
  return store;
}

const bare = rule({ id: "bare", destination: "INBOX" });
const term = rule({ id: "term", destination: "ohmail/News", subjectContains: "[Monitor]" });

function intent(o: Partial<ScreenIntent> = {}): ScreenIntent {
  return {
    v: 2, verb: "screen", id: "p1", seedId: "m1", address: ADDR, scope: "sender", dest: "ohbox",
    messageIds: ["m1"], makeRule: true, applyRetro: false, resolution: "remove",
    shown: [{ id: term.id, fp: ruleFingerprint(term) }], at: 0, ...o,
  };
}

describe("planScreenCommit", () => {
  it("removes the shown rule while it is as shown", async () => {
    const out = planScreenCommit(await mirror([bare, term]), intent());
    expect(out).toEqual({ writes: [{ kind: "rule_delete", ruleId: "term" }], changed: [] });
  });

  it("a shown rule edited inside the window stays, and is named", async () => {
    const edited = { ...term, subjectContains: "[Monitor-2]", updatedAt: "2026-09-25T12:00:00.000Z" };
    expect(planScreenCommit(await mirror([bare, edited]), intent())).toEqual({ writes: [], changed: ["term"] });
  });

  it("a shown rule that went is named, and nothing is written for it", async () => {
    expect(planScreenCommit(await mirror([bare]), intent())).toEqual({ writes: [], changed: ["term"] });
  });

  it("a hit counter moving is not a change", async () => {
    const hit = { ...term, stats: { hits: 9, lastHitAt: "2026-09-25T12:00:00.000Z", demotions: 0 }, updatedAt: "2026-09-25T12:00:00.000Z" };
    expect(planScreenCommit(await mirror([bare, hit]), intent()).writes).toEqual([{ kind: "rule_delete", ruleId: "term" }]);
  });

  it("a rule made inside the window is untouched, and keep removes nothing", async () => {
    const late = rule({ id: "late", destination: "ohmail/Receipts", subjectContains: "receipt" });
    expect(planScreenCommit(await mirror([bare, term, late]), intent()).writes).toEqual([{ kind: "rule_delete", ruleId: "term" }]);
    expect(planScreenCommit(await mirror([bare, term]), intent({ resolution: "keep" }))).toEqual({ writes: [], changed: [] });
  });

  it("a shown rule that is not a term rule of this address is never the press's to remove", async () => {
    const wide = rule({ id: "dom", kind: "domain", match: "kestrel.example", destination: "ohmail/Screened", priority: 5 });
    const out = planScreenCommit(await mirror([bare, wide]), intent({ shown: [{ id: "dom", fp: ruleFingerprint(wide) }] }));
    expect(out.writes).toEqual([]);
  });

  it("the ladder still runs: a twin elsewhere is retargeted", async () => {
    const elsewhere = { ...bare, destination: "ohmail/News" as const };
    const out = planScreenCommit(await mirror([elsewhere, term]), intent());
    expect(out.writes).toEqual([
      { kind: "rule_update", ruleId: "bare", destination: "INBOX", applyRetro: false },
      { kind: "rule_delete", ruleId: "term" },
    ]);
  });
});

describe("planScreenCommit over the organizer's copy (reader-only)", () => {
  it("Remove names a shown organizer term rule by its key; over the device's rows it read as changed", async () => {
    const theirs = { ...term, id: "profile:mb:1" };
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{
      type: "mailbox_profile", op: "create", id: "mb", seq: ++seq, updatedAt: term.updatedAt,
      entity: { mailboxId: "mb", rules: [{ ...bare, id: "profile:mb:0" }, theirs], asOf: term.updatedAt, from: { kind: "local", name: "Host", since: null }, updatedAt: term.updatedAt, applied: [] },
    }] as SyncChange[]);
    const shown = intent({ shown: [{ id: theirs.id, fp: ruleFingerprint(theirs) }], makeRule: false });
    expect(planScreenCommit(store, shown)).toEqual({ writes: [], changed: [theirs.id] });
    const over = pressRules(store, { travels: true, queued: [], applied: [], unsettled: [], now: new Date("2026-09-25T12:00:00.000Z") });
    expect(planScreenCommit(store, shown, over)).toEqual({ writes: [{ kind: "rule_delete", ruleId: heldRuleId(term) }], changed: [] });
  });
});
