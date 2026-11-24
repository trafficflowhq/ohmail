import type { EngineMessage, HeldReleaseWire } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, consentPartition, heldReleaseGroups, heldReleaseTotalOf,
  presentationReader, screenerSegments, senderKey, type SyncChange,
} from "../src/index.js";

/**
 * A CONTACT'S HELD MAIL REACHES THE OFFER, AND THE CONTACT STAYS UNDECIDED (row 138). The door
 * answers contact-only senders beside the rule groups; the mirror keeps each as its own line
 * (`sender:<address>`), adds its mail to the press's distinct total, and does NOT retire the
 * contact's waiting row — a rule group is an answer the person gave, a contact line is not.
 */

const NOW = new Date("2026-09-25T14:00:00.000Z");
const ANA = "ana@friends.test";

function held(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-25T09:00:00.000Z", folder: "ohmail/Screener", snippet: "", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

async function engineAnswering(answer: HeldReleaseWire) {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([held("m1", ANA), held("m2", "rule@paper.test")]
    .map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: m })));
  const presses: Array<[readonly string[] | undefined, readonly string[] | undefined]> = [];
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      heldReleases: async () => answer,
      releaseHeld: async (ruleIds?: readonly string[], senders?: readonly string[]) => {
        presses.push([ruleIds, senders]);
        return { released: [], releasedSenders: [], total: 0 };
      },
    } as never,
  });
  return { engine, store, presses };
}

const WITH_CONTACT: HeldReleaseWire = {
  groups: [{ ruleId: "r1", kind: "sender", match: "rule@paper.test", destination: "ohmail/News", count: 1 }],
  senders: [{ sender: ANA, count: 1 }],
  total: 1, max: 200, fingerprint: "v1-0000000000000138", dismissed: false,
};

const waiting = (store: MemoryMirrorStore) =>
  screenerSegments(presentationReader(store, consentPartition(store, { now: NOW })), NOW).waiting.map((r) => senderKey(r.from.address));

describe("the contact line in the mirror", () => {
  it("is its own row, beside the rule group, and adds to the press's distinct total", async () => {
    const { engine } = await engineAnswering(WITH_CONTACT);
    await engine.refreshHeldReleases();
    const rows = heldReleaseGroups(engine.read());
    expect(rows.map((g) => [g.id, g.sender ?? null])).toEqual([["r1", null], [`sender:${ANA}`, ANA]]);
    expect(heldReleaseTotalOf(engine.read())).toBe(2);
  });

  it("leaves the contact waiting; the rule group retires its sender (the control)", async () => {
    const { engine, store } = await engineAnswering(WITH_CONTACT);
    await engine.refreshHeldReleases();
    expect(waiting(store)).toEqual([ANA]);
  });

  it("an older door, sending no senders, draws no contact line", async () => {
    const { engine } = await engineAnswering({ ...WITH_CONTACT, senders: undefined });
    await engine.refreshHeldReleases();
    expect(heldReleaseGroups(engine.read()).map((g) => g.id)).toEqual(["r1"]);
    expect(heldReleaseTotalOf(engine.read())).toBe(1);
  });

  it("the press hands the named senders to the door", async () => {
    const { engine, presses } = await engineAnswering(WITH_CONTACT);
    await engine.releaseHeldMail(undefined, [ANA]);
    expect(presses).toEqual([[undefined, [ANA]]]);
  });
});

describe("the http door carries the contact lines both ways", () => {
  it("reads `senders` and `releasedSenders`, and sends `senders` only when named", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "POST") {
        bodies.push(JSON.parse(String(init!.body)));
        return new Response(JSON.stringify({ released: [], releasedSenders: [{ sender: "Ana@Friends.test", count: 1 }], total: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify({ groups: [], senders: [{ sender: ANA, count: 3 }, { sender: "", count: 1 }], total: 0, max: 200 }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl });
    expect((await adapter.heldReleases()).senders, "a line with no address is dropped").toEqual([{ sender: ANA, count: 3 }]);
    expect((await adapter.releaseHeld(undefined, [ANA])).releasedSenders).toEqual([{ sender: ANA, count: 1 }]);
    await adapter.releaseHeld(["r1"]);
    expect(bodies).toEqual([{ senders: [ANA] }, { ruleIds: ["r1"] }]);
  });
});
