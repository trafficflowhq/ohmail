import type { EngineMessage, MessageBodyWire, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine, type SyncChange,
} from "../src/index.js";

/**
 * A BODY THAT CAN RE-PLACE ITS MESSAGE MOVES THE WINDOW'S DERIVED STAMP, AND NO OTHER BODY DOES.
 * The partition reads the text of a message whose sender a body-term rule names; the window keys
 * its whole-mirror derivations on a stamp that ignores bodies (`useDerivedVersion`) plus
 * `placementStamp`. Without the stamp a body landing leaves the row where the partition put it
 * before the text arrived; with every body moving it, the eager pass re-derives the mailbox per body.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");
let seq = 0;

function msg(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-20T09:00:00.000Z", folder: "INBOX", snippet: "", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}
const bodyRule: RuleDTO = {
  id: "b", kind: "sender", match: "person@shop.example", destination: "ohmail/Screened", priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), subjectContains: null, bodyContains: "unsubscribe",
};

async function engineWith(rules: RuleDTO[]) {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...[msg("ruled", "person@shop.example"), msg("other", "someone@else.example")]
      .map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m })),
    ...rules.map((r) => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: r })),
  ] as SyncChange[]);
  const answer = (id: string): MessageBodyWire => ({
    text: `the text of ${id}, unsubscribe here`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
  });
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async (id: string) => answer(id),
    },
  } as never);
  return { engine, store };
}

describe("the placement stamp", () => {
  it("moves for a body whose sender a body-term rule names", async () => {
    const { engine } = await engineWith([bodyRule]);
    expect(engine.placementStamp()).toBe(0);
    await engine.hydrateBody("ruled");
    expect(engine.placementStamp()).toBeGreaterThan(0);
    expect(engine.placementStamp()).toBe(engine.read().version());
  });

  it("stays for a body no body-term rule reads (the eager pass's case)", async () => {
    const { engine } = await engineWith([bodyRule]);
    await engine.hydrateBody("other");
    expect(engine.placementStamp()).toBe(0);
  });

  it("stays with no body-term rule at all, whoever sent the body (the control)", async () => {
    const { engine } = await engineWith([{ ...bodyRule, bodyContains: null }]);
    await engine.hydrateBody("ruled");
    expect(engine.placementStamp()).toBe(0);
  });
});
