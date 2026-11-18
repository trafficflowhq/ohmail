import type { EngineMessage, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { effectForDestination, evaluateRules, type NormalizedMessage, type Rule } from "@trafficflow/core/mail";
import {
  MemoryMirrorStore, consentIndex, consentPartition, messagePlacement, ohboxView, presentationReader,
  pressOutcome, rulesList, stayVerdict, type SyncChange,
} from "../src/index.js";
import {
  FOLD_MATRIX, NOW, PLACEMENT_MATRIX, SENDER, foldStore, type PlacementCase,
} from "./placement-parity/matrix.js";

/**
 * THE CLIENT PLACES AS THE ORGANIZER FILES — the placement census, client leg. The organizer's
 * `evaluateRules`, handed the same rules, the same message and the same text, is the oracle; the
 * client's partition asks the one claim (`placingRule`, core `rule-order.ts`) with the text its
 * mirror holds. With the text held the two agree: a denial projects the row onto its shelf, and
 * anything else leaves it at the wire's folder. Without it a body rule that would outrank the
 * winner is `undecided` and the row stays where the wire has it — never a guess either way.
 */

let seq = 0;
const asCore = (r: RuleDTO): Rule => ({
  id: r.id, kind: r.kind, match: r.match, destination: r.destination as Rule["destination"],
  effect: effectForDestination(r.destination as Rule["destination"]), priority: r.priority,
  provenance: r.provenance, enabled: r.enabled,
  subjectContains: r.subjectContains ?? null, bodyContains: r.bodyContains ?? null,
});

function organizerFiles(c: PlacementCase): string {
  const msg: NormalizedMessage = {
    canonical: { messageIdHeader: null, bodyHash: c.message.id }, subject: c.message.subject,
    from: { name: null, address: SENDER }, to: [], cc: [], date: null, headers: { from: [SENDER] },
    textBody: c.text, htmlBody: null, hasAttachments: false, attachments: [],
  };
  const d = evaluateRules({
    msg, rules: c.rules.map(asCore), ownAddresses: new Set<string>(), knownSenders: { addresses: new Set(), inferred: new Set<string>(), lists: new Map() },
    auth: "unauthenticated", ohboxPolicy: "people_and_replied", identity: null,
  });
  return d.destination ?? c.message.folder;
}

async function storeOf(rules: RuleDTO[], messages: EngineMessage[], bodies: Record<string, string> = {}) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  for (const [id, text] of Object.entries(bodies)) {
    await store.putLocal("message_body", id, { messageId: id, state: "ready", text, html: null, withheld: null });
  }
  return store;
}

/** Where the list shows the row: the organizer's denial on its shelf, else where the wire has it. */
const expectedShown = (c: PlacementCase): string => {
  const filed = organizerFiles(c);
  return effectForDestination(filed as Rule["destination"]) === "deny" ? filed : c.message.folder;
};

describe("placement census: the partition and the organizer over one matrix", () => {
  it("the matrix has a subject, and a body rule decides somewhere in it", () => {
    expect(PLACEMENT_MATRIX.length).toBeGreaterThanOrEqual(40);
    expect(PLACEMENT_MATRIX.some((c) => c.rules.some((r) => r.bodyContains) && organizerFiles(c) !== "INBOX")).toBe(true);
  });

  it.each(PLACEMENT_MATRIX)("text held: $name", async (c) => {
    const store = await storeOf(c.rules, [c.message], { [c.message.id]: c.text });
    expect(consentPartition(store, { now: NOW }).placeOf.get(c.message.id)).toBe(expectedShown(c));
    expect(messagePlacement(consentIndex(rulesList(store)), c.message, store).undecided).toBeNull();
  });

  it.each(PLACEMENT_MATRIX)("text not held: $name", async (c) => {
    const store = await storeOf(c.rules, [c.message]);
    const placed = messagePlacement(consentIndex(rulesList(store)), c.message, store);
    const shown = consentPartition(store, { now: NOW }).placeOf.get(c.message.id);
    if (placed.undecided === null) expect(shown, "no body rule decides it: the same as with the text").toBe(expectedShown(c));
    else expect(shown, "an undecided row is where the wire has it").toBe(c.message.folder);
  });

  it("the undecided rule is the body rule that would outrank the winner, and only that one", async () => {
    const at = (set: string, key: string) => PLACEMENT_MATRIX.find((c) => c.set === set && c.message.id === `m-${key}`)!;
    const undecided = async (c: PlacementCase) =>
      messagePlacement(consentIndex(rulesList(await storeOf(c.rules, [c.message]))), c.message, null).undecided?.id ?? null;
    expect(await undecided(at("bodyDeny", "unsub"))).toBe("b-deny");
    expect(await undecided(at("bodyAllowOverDomainDeny", "invoice"))).toBe("b-news");
    expect(await undecided(at("bareAllowOutranksBody", "unsub")), "a higher-priority bare rule wins without the text").toBeNull();
    expect(await undecided(at("subjectDeny", "alert")), "a subject term needs no text").toBeNull();
  });
});

describe("placement census: the read-back names the rule the placement names", () => {
  it("text held: a body rule keeping the row elsewhere is named as kept, by its body term", async () => {
    const c = PLACEMENT_MATRIX.find((x) => x.set === "bodyDeny" && x.message.id === "m-unsub")!;
    const row = { ...c.message, folder: "ohmail/Screened" as const };
    const store = await storeOf(c.rules, [row], { [row.id]: c.text });
    const presented = presentationReader(store, consentPartition(store, { now: NOW }));
    const v = stayVerdict(pressOutcome({ presented, subject: [row], rules: rulesList(store), profiles: [], wanted: "INBOX", retro: false }), store);
    expect(v).toMatchObject({ key: "kept", field: "body", term: "unsubscribe", keptPlace: "ohmail/Screened" });
  });

  it("text not held: the row is undecided, named by its rule, and Move stays on offer", async () => {
    const c = PLACEMENT_MATRIX.find((x) => x.set === "bodyDeny" && x.message.id === "m-unsub")!;
    const row = { ...c.message, folder: "ohmail/Screened" as const };
    const store = await storeOf(c.rules, [row]);
    const presented = presentationReader(store, consentPartition(store, { now: NOW }));
    const v = stayVerdict(pressOutcome({ presented, subject: [row], rules: rulesList(store), profiles: [], wanted: "INBOX", retro: false }), store);
    expect(v).toMatchObject({ key: "undecided", still: 1, term: "unsubscribe", ids: [row.id] });
  });
});

describe("placement census: the resurfaced pin folds its conversation out of New for you", () => {
  it.each(FOLD_MATRIX)("$name", async (c) => {
    const store = await foldStore(c, `t-${c.members[0]!.id}`);
    const unreadInbox = ohboxView(store).newForYou.filter((m) => m.unread && m.folder === "INBOX").map((m) => m.id);
    expect(unreadInbox.sort()).toEqual([...c.newForYou].sort());
  });
});
