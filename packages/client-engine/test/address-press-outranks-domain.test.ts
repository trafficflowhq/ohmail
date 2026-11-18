import type { EngineMessage, EngineMutation, MutationOutcome, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  HttpAdapter,
  OhmailEngine,
  consentIndex,
  consentPartition,
  decidedDestination,
  presentationReader,
  rulesList,
  type EngineAdapter,
  type SyncResponse,
} from "@ohmail/client-engine";

/**
 * A PRESS ON AN ADDRESS UNDER A HIGHER-PRIORITY DOMAIN RULE. The router
 * reads priority before kind, so the domain rule went on filing the address the person had just
 * pressed into the Ohbox. The engine writes the address rule at the domain rule's priority, the
 * wire carries it, and the list presents the address's mail at the pressed place.
 */

const NOW = new Date("2026-09-25T13:00:00.000Z");
const ADDR = "info@shop.example";
const WIDE: RuleDTO = {
  id: "dom-5", kind: "domain", match: "shop.example", destination: "ohmail/News", priority: 5,
  provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
  stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: "2026-08-10T10:00:00.000Z", updatedAt: "2026-08-10T10:00:00.000Z",
} as RuleDTO;
const MAIL = {
  id: "m-1", accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
  subject: "Order fulfilled", from: { name: null, address: ADDR }, to: [], cc: [],
  date: "2026-09-25T12:57:00.000Z", folder: "INBOX", snippet: "", unread: true,
  hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-25T12:57:00.000Z",
} as EngineMessage;

async function engineWith(sent: EngineMutation[], wide: RuleDTO = WIDE): Promise<OhmailEngine> {
  let served = false;
  const adapter: EngineAdapter = {
    async sync(): Promise<SyncResponse> {
      const creates = served ? [] : [
        { type: "rule" as const, op: "create" as const, id: wide.id, seq: 1, updatedAt: wide.updatedAt, entity: wide },
        { type: "message" as const, op: "create" as const, id: MAIL.id, seq: 2, updatedAt: MAIL.updatedAt, entity: MAIL },
      ];
      served = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "2", hasMore: false, serverTime: NOW.toISOString() };
    },
    // The server stores what the wire carried and echoes the row.
    async mutate(m): Promise<MutationOutcome> {
      sent.push(m);
      if (m.kind !== "rule_create") return { changes: [], seq: null };
      const entity = { ...WIDE, id: "srv-1", kind: m.ruleKind, match: m.match, destination: m.destination, priority: m.priority ?? 0 };
      return { changes: [{ type: "rule", op: "create", id: "srv-1", seq: 3, updatedAt: NOW.toISOString(), entity }], seq: 3 } as MutationOutcome;
    },
    async withdrawSend() { return { outcome: "unsupported" as const }; },
    async fetchBody() { return null; },
  };
  const engine = new OhmailEngine({ adapter, now: () => NOW });
  await engine.start();
  return engine;
}

describe("an address pressed under a higher-priority domain rule is presented at the pressed place", () => {
  it("the create carries the domain rule's priority, and the list shows the mail in the Ohbox", async () => {
    const sent: EngineMutation[] = [];
    const engine = await engineWith(sent);
    // INVERTED by ARCH-R902: the letter stays where it is under either rule; which
    // rule wins is the sender's standing, asked of the order itself.
    const before = presentationReader(engine.read(), consentPartition(engine.read(), { now: NOW }));
    expect(before.get<EngineMessage>("message", MAIL.id)!.folder).toBe("INBOX");
    expect(decidedDestination(consentIndex(rulesList(engine.read())), ADDR)).toBe("ohmail/News");

    const res = await engine.mutate({ kind: "rule_create", ruleKind: "sender", match: ADDR, destination: "INBOX", applyRetro: true });
    expect(res.status).not.toBe("rolled_back");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "rule_create", priority: 5 });

    const after = presentationReader(engine.read(), consentPartition(engine.read(), { now: NOW }));
    expect(after.get<EngineMessage>("message", MAIL.id)!.folder).toBe("INBOX");
    expect(decidedDestination(consentIndex(rulesList(engine.read())), ADDR), "the domain rule still decides the pressed address").toBe("INBOX");
  });
});

describe("the lift stays inside the one priority bound", () => {
  it("a domain rule at the bound: the address rule is written at the bound and wins", async () => {
    const sent: EngineMutation[] = [];
    const engine = await engineWith(sent, { ...WIDE, priority: 1000 });
    await engine.mutate({ kind: "rule_create", ruleKind: "sender", match: ADDR, destination: "INBOX", applyRetro: true });
    expect(sent[0]).toMatchObject({ kind: "rule_create", priority: 1000 });
    const after = presentationReader(engine.read(), consentPartition(engine.read(), { now: NOW }));
    expect(after.get<EngineMessage>("message", MAIL.id)!.folder).toBe("INBOX");
  });

  it("a domain rule past the bound: no lift is sent, which every door would refuse", async () => {
    const sent: EngineMutation[] = [];
    const engine = await engineWith(sent, { ...WIDE, priority: 1001 });
    await engine.mutate({ kind: "rule_create", ruleKind: "sender", match: ADDR, destination: "INBOX", applyRetro: true });
    expect(sent[0]).not.toHaveProperty("priority");
    const after = presentationReader(engine.read(), consentPartition(engine.read(), { now: NOW }));
    expect(after.get<EngineMessage>("message", MAIL.id)!.folder).toBe("INBOX");
    expect(decidedDestination(consentIndex(rulesList(engine.read())), ADDR)).toBe("ohmail/News");
  });
});

describe("the wire carries a priority only when one is lifted", () => {
  function door() {
    const bodies: unknown[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "null")));
      return new Response(JSON.stringify({ id: "r1" }), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    return { adapter: new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl }), bodies };
  }

  it("POST /rules and PATCH /rules/:id", async () => {
    const { adapter, bodies } = door();
    await adapter.mutate({ kind: "rule_create", ruleKind: "sender", match: ADDR, destination: "INBOX", priority: 5 }, { idempotencyKey: "k1" }).catch(() => null);
    await adapter.mutate({ kind: "rule_create", ruleKind: "sender", match: ADDR, destination: "INBOX" }, { idempotencyKey: "k2" }).catch(() => null);
    await adapter.mutate({ kind: "rule_update", ruleId: "r1", destination: "INBOX", priority: 5 }, { idempotencyKey: "k3" }).catch(() => null);
    await adapter.mutate({ kind: "rule_update", ruleId: "r1", destination: "INBOX" }, { idempotencyKey: "k4" }).catch(() => null);
    expect(bodies).toHaveLength(4);
    expect(bodies[0]).toMatchObject({ priority: 5 });
    expect(bodies[1]).not.toHaveProperty("priority");
    expect(bodies[2]).toMatchObject({ priority: 5 });
    expect(bodies[3]).not.toHaveProperty("priority");
  });
});
