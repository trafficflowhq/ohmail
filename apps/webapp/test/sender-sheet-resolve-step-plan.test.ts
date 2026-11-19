import type { EngineMessage, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { planScreeningChange, screeningPath, senderScreening, withResolution } from "@ohmail/app-logic/press/sender-screening";

/**
 * WHICH DOOR A SHEET PRESS GOES THROUGH, IN THE SCREENING PLANNER (moved word for word out of
 * `sender-sheet-resolve-step.test.tsx`, whose other cases draw today's sender sheet, `app/shell/SenderMenu.tsx`,
 * which no host's entry reaches): an address press past the gate that makes a rule is held for the Undo window,
 * and a resolve step's removals ride the press. These cases render nothing; they hold over the planner, which stays.
 */
const ADDR = "alerts@kestrel.example";
let seq = 0;

function msg(id: string, o: Partial<EngineMessage> = {}): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "Invoice ready", from: { name: "Kestrel", address: ADDR }, to: [], cc: [],
    date: "2026-09-24T12:00:00.000Z", folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-24T12:00:00.000Z", ...o,
  } as EngineMessage;
}

async function mirror(messages: EngineMessage[], rules: RuleDTO[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ] as SyncChange[]);
  return store;
}

describe("which door a sheet press goes through", () => {
  it("an address press past the gate that makes a rule is held; a domain press and a move-only go at once", async () => {
    const store = await mirror([msg("m1")], []);
    const s = senderScreening(store, "m1")!;
    expect(screeningPath(s, "sender", true)).toBe("window");
    expect(screeningPath(s, "domain", true)).toBe("immediate");
    expect(screeningPath(s, "sender", false)).toBe("immediate");
    const held = await mirror([msg("h1", { folder: "ohmail/Screener" })], []);
    expect(screeningPath(senderScreening(held, "h1")!, "sender", true)).toBe("decide");
  });

  it("the step's removals ride a decide ahead of it, and a ladder after it", async () => {
    const store = await mirror([msg("h1", { folder: "ohmail/Screener" })], []);
    const plan = planScreeningChange(senderScreening(store, "h1")!, "ohbox", "sender", true, true);
    const del = { kind: "rule_delete" as const, ruleId: "term" };
    const out = withResolution(plan, [del]);
    expect(out.mutations[0]).toBe(del);
    expect(out.ruleMutations).toEqual([del]);
    expect(out.mutations.filter((m) => m.kind === "screener_decide")).toHaveLength(1);
  });
});
