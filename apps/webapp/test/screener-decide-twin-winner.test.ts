import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  consentPartition,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import { planScreeningChange, senderScreening } from "@ohmail/app-logic/press/sender-screening";

/**
 * THE WEB SHEET'S DECIDE BESIDE AN OUTRANKING TWIN (SCREENER-DECIDE-PROMOTES-BESIDE-AN-OUTRANKING-TWIN).
 * The sender's mail waits at the gate and a deny rule for them was written meanwhile, so the list
 * shows it in Screened. Pressing Ohbox on the sheet decides the sender (`screener_decide`); the
 * press must not leave the deny deciding. The server half is `packages/db/test/screener-apply-twins`.
 */
const NOW = new Date("2026-09-25T09:00:00.000Z");
const ADDR = "lena@atelier.example";
let seq = 0;

function msg(id: string, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject: id,
    from: { name: null, address: ADDR }, to: [], cc: [], date: "2026-09-24T09:00:00.000Z", folder,
    snippet: id, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-24T09:00:00.000Z",
  };
}

function rule(id: string, destination: Folder): RuleDTO {
  return {
    id, kind: "sender", match: ADDR, destination, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-09-24T10:00:00.000Z", updatedAt: "2026-09-24T10:00:00.000Z",
  };
}

/** A mirror and an engine whose every mutation is answered only when the test says so. */
async function world(rules: RuleDTO[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    { type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: "2026-09-24T09:00:00.000Z", entity: msg("m1", "ohmail/Screener") },
    ...rules.map((r): SyncChange => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ]);
  const answers: Array<() => void> = [];
  const engine = new OhmailEngine({
    adapter: {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => {
        await new Promise<void>((r) => { answers.push(r); });
        return { changes: [], seq: null };
      },
    },
    store,
    now: () => NOW,
  });
  await engine.start();
  const placeOf = () => consentPartition(engine.read(), { now: NOW }).placeOf;
  return { engine, answers, placeOf };
}

async function pressOhbox(w: Awaited<ReturnType<typeof world>>) {
  const plan = planScreeningChange(senderScreening(w.engine.read(), "m1")!, "ohbox");
  const sent = plan.mutations.map((m: EngineMutation) => w.engine.mutate(m));
  await new Promise((r) => { setTimeout(r, 0); });
  return { plan, sent };
}

describe("the sheet's decide beside a deny twin", () => {
  it("the press is a decide, and while it is in flight the list shows the sender in the Ohbox", async () => {
    const w = await world([rule("r-allow", "INBOX"), rule("r-deny", "ohmail/Screened")]);
    expect(w.placeOf().get("m1")).toBe("ohmail/Screened");
    const { plan, sent } = await pressOhbox(w);
    expect(plan.ruleState).toBe("promoted");
    expect(plan.mutations.map((m) => m.kind)).toEqual(["screener_decide"]);
    expect(w.placeOf().get("m1"), "the admitted mail still shows where the deny files it").toBe("INBOX");
    expect(senderScreening(w.engine.read(), "m1", undefined, w.placeOf())!.current).toBe("ohbox");
    for (const a of w.answers) a();
    await Promise.all(sent);
  });

  it("the Screener's own press is the same verb, with the same answer", async () => {
    const w = await world([rule("r-deny", "ohmail/Screened")]);
    const sent = w.engine.mutate({ kind: "screener_decide", senderId: "m1", decision: "yes", dest: "ohbox", read: false, scope: "sender" });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(w.placeOf().get("m1")).toBe("INBOX");
    for (const a of w.answers) a();
    await sent;
  });

  it("the ordinary decide is unchanged: with no rule standing the list shows the Ohbox", async () => {
    const w = await world([]);
    const { sent } = await pressOhbox(w);
    expect(w.placeOf().get("m1")).toBe("INBOX");
    for (const a of w.answers) a();
    await Promise.all(sent);
  });
});
