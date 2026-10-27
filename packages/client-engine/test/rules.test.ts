import { describe, expect, it } from "vitest";
import {
  DEMO_NOW,
  FixturesAdapter,
  HttpAdapter,
  MutationRejectedError,
  OhmailEngine,
  messagesIn,
  rulesList,
  storedRuleDestination,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type MutationOutcome,
  type RuleDTO,
  type SyncResponse,
} from "@ohmail/client-engine";
import { PUBLISHED_RULE_ID } from "@trafficflow/core/rule-order";
import { LEGACY_NEWS_FOLDER } from "@trafficflow/core/folder-name";

/**
 * THE RULES SURFACE HAS A WIRE, AND THE WIRE IS THE ASSERTION.
 *
 * `tag_assign` is the cautionary tale this file is written against: it threw
 * `UnsupportedMutationError` for the whole of Stage 2 under a fully-built tag UI, and nothing
 * was red, because `FixturesAdapter` serves every mutation in place and the suite exercised the
 * demo world. A surface can be complete, tested and unreachable on every paying account.
 *
 * So the wire cases below drive `HttpAdapter` directly and watch the HTTP call. The effect
 * cases drive the engine and watch the mirror. Neither can be satisfied by the other.
 */

interface Captured {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function adapterCapturing(into: Captured[], respond: () => Response): HttpAdapter {
  return new HttpAdapter({
    baseUrl: "https://api.test",
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      into.push({
        method: init?.method ?? "GET",
        url: String(url),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return respond();
    }) as unknown as typeof globalThis.fetch,
  });
}

function rule(over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id: "r-1",
    kind: "sender",
    match: "lena@atelier-eichspan.example",
    destination: "INBOX",
    priority: 0,
    provenance: "promoted",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

describe("rule_delete on the wire", () => {
  it("issues DELETE /rules/:id, echoes no changes, and reports the seq", async () => {
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, () =>
      new Response(null, { status: 204, headers: { "X-Sync-Seq": "77" } }),
    );

    const res = await adapter.mutate({ kind: "rule_delete", ruleId: "r-1" }, { idempotencyKey: "idem-d" });

    expect(calls, "the revoke never reached the network").toHaveLength(1);
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url).toBe("https://api.test/rules/r-1");
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers["idempotency-key"]).toBe("idem-d");
    // A 204 has no DTO to echo — `dispatch` pulls the authoritative drain instead.
    expect(res.changes).toEqual([]);
    expect(res.seq).toBe(77);
  });

  /**
   * The race this exists for: two tabs, or a retry whose first response was lost. `RulesService`
   * answers 404 for a rule that is already gone, which is the state the user asked for. If that
   * were a rejection the optimistic tombstone would roll back — the revoked rule REAPPEARS —
   * and the next drain would remove it again.
   */
  it("treats 404 as the outcome that was asked for, not a rejection", async () => {
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, () =>
      new Response(JSON.stringify({ error: { code: "not_found", message: "rule not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await adapter.mutate({ kind: "rule_delete", ruleId: "gone" }, { idempotencyKey: "idem-404" });
    expect(res.changes).toEqual([]);
    // Nothing was written this time, so there is no seq to converge on.
    expect(res.seq).toBeNull();
  });

  it("still throws — retryably — on a 500, because the rule may well still be there", async () => {
    const adapter = adapterCapturing([], () =>
      new Response(JSON.stringify({ error: { code: "internal", message: "boom" } }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      adapter.mutate({ kind: "rule_delete", ruleId: "r-1" }, { idempotencyKey: "idem-500" }),
    ).rejects.toMatchObject({ status: 500, retryable: true });
  });

  it("throws non-retryably on a 403 — the user genuinely may not do this", async () => {
    const adapter = adapterCapturing([], () =>
      new Response(JSON.stringify({ error: { code: "forbidden", message: "no" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      adapter.mutate({ kind: "rule_delete", ruleId: "r-1" }, { idempotencyKey: "idem-403" }),
    ).rejects.toMatchObject({ status: 403, retryable: false });
  });
});

describe("rule_update on the wire", () => {
  it("PATCHes only the destination and echoes the returned DTO at its seq", async () => {
    const calls: Captured[] = [];
    const next = rule({ destination: "ohmail/News", updatedAt: "2026-08-04T09:00:00.000Z" });
    const adapter = adapterCapturing(calls, () =>
      new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json", "X-Sync-Seq": "91" },
      }),
    );

    const res = await adapter.mutate(
      { kind: "rule_update", ruleId: "r-1", destination: "ohmail/News" },
      { idempotencyKey: "idem-p" },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.url).toBe("https://api.test/rules/r-1");
    // ONLY the destination. Sending `kind` or `match` would silently re-key the rule.
    expect(calls[0]!.body).toEqual({ destination: "ohmail/News" });
    expect(res.seq).toBe(91);
    expect(res.changes).toEqual([
      { type: "rule", op: "update", id: "r-1", seq: 91, updatedAt: "2026-08-04T09:00:00.000Z", entity: next },
    ]);
  });
});

/**
 * ── `rule_create` ON THE WIRE ─────────────────────────────────────────────────────
 *
 * THIS IS THE GUARD THAT MATTERS. The reason(c) could not be built was that the only
 * rule-creating verb produced no effects for a sender past the gate, and `Engine.mutate` turns
 * zero effects into `rolled_back` WITHOUT SENDING THE REQUEST — a UI painting success over a
 * request that never left the browser. That is `tag_assign`'s failure exactly: an adapter
 * throwing "unsupported" under a finished surface, green against fixtures for a whole stage.
 *
 * So the first assertion here is that the network was touched at all, and it fails first if the
 * verb ever stops reaching it.
 */
describe("a published rule's verbs go to its address with the key in the body", () => {
  const key = { kind: "sender", match: "a@b.test", subjectContains: null, bodyContains: null };
  const queued = () => new Response(JSON.stringify({ pending: true, travel: { appliedLocally: [], pending: [], refused: [] } }), {
    status: 202, headers: { "content-type": "application/json" },
  });
  it("DELETE and PATCH name the nil address, never the held id, and answer queued on 202", async () => {
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, queued);
    const held = `held:${JSON.stringify(["sender", "a@b.test", null, null])}`;
    const del = await adapter.mutate({ kind: "rule_delete", ruleId: held, key }, { idempotencyKey: "k-d" });
    await adapter.mutate({ kind: "rule_update", ruleId: held, key, destination: "INBOX" }, { idempotencyKey: "k-u" });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ["DELETE", `https://api.test/rules/${PUBLISHED_RULE_ID}`, { key }],
      ["PATCH", `https://api.test/rules/${PUBLISHED_RULE_ID}`, { key, destination: "INBOX" }],
    ]);
    expect(del).toMatchObject({ settlement: "queued" });
  });
  it("a held id with no key is refused here and nothing is sent", async () => {
    const calls: Captured[] = [];
    const adapter = adapterCapturing(calls, queued);
    await expect(adapter.mutate({ kind: "rule_delete", ruleId: "held:x" }, { idempotencyKey: "k" }))
      .rejects.toMatchObject({ code: "validation_failed" });
    expect(calls).toEqual([]);
  });
});

describe("rule_create on the wire", () => {
  it("POSTs /rules with kind/match/destination/applyRetro, and echoes the created DTO at its seq", async () => {
    const calls: Captured[] = [];
    const created = rule({ id: "srv-1", kind: "domain", match: "x.example", destination: "ohmail/News", provenance: "manual" });
    const adapter = adapterCapturing(calls, () =>
      new Response(JSON.stringify(created), {
        status: 201,
        headers: { "content-type": "application/json", "X-Sync-Seq": "1019" },
      }),
    );

    const res = await adapter.mutate(
      { kind: "rule_create", ruleKind: "domain", match: "x.example", destination: "ohmail/News" },
      { idempotencyKey: "idem-c" },
    );

    expect(calls, "the rule never reached the network").toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://api.test/rules");
    // FOUR FIELDS, and the fourth is the whole of that change on the wire. `priority` is still
    // absent — that would be the client choosing precedence from a sheet offering no such control
    // (`compareRules` ranks priority first) — and `enabled` is already true by default.
    //
    // `applyRetro` is sent even though the SERVER defaults an absent field to `true`, so that
    // what ships is decided by one constant in the surface rather than by a field's absence.
    // Asserted with `toEqual` so an extra field cannot creep onto this body unnoticed.
    expect(calls[0]!.body).toEqual({
      kind: "domain", match: "x.example", destination: "ohmail/News", applyRetro: true,
    });
    expect(calls[0]!.headers["idempotency-key"]).toBe("idem-c");
    expect(res.seq).toBe(1019);
    expect(res.changes).toEqual([
      { type: "rule", op: "create", id: "srv-1", seq: 1019, updatedAt: created.updatedAt, entity: created },
    ]);
  });

  /**
   * THE OPT-OUT HAS TO REACH THE SERVER. `applyRetro: false` is the user declining to have years
   * of stored mail reorganized; if it were dropped anywhere between the sheet and the body, the
   * server's own default (`true`) would silently overrule them — which is the failure mode the
   * explicit-send design exists to prevent, so it is asserted rather than assumed.
   */
  it("carries a DECLINED retroactive apply to the wire as `false`, never as an omission", async () => {
    const calls: Captured[] = [];
    const created = rule({ id: "srv-2", kind: "sender", match: "a@x.example", destination: "ohmail/News", provenance: "manual" });
    const adapter = adapterCapturing(calls, () =>
      new Response(JSON.stringify(created), {
        status: 201,
        headers: { "content-type": "application/json", "X-Sync-Seq": "1020" },
      }),
    );

    await adapter.mutate(
      { kind: "rule_create", ruleKind: "sender", match: "a@x.example", destination: "ohmail/News", applyRetro: false },
      { idempotencyKey: "idem-d" },
    );

    expect(calls[0]!.body).toEqual({
      kind: "sender", match: "a@x.example", destination: "ohmail/News", applyRetro: false,
    });
  });

  it("degrades to a drain when the seq header is absent, rather than echoing at no seq", async () => {
    const adapter = adapterCapturing([], () =>
      new Response(JSON.stringify(rule({ id: "srv-2" })), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const res = await adapter.mutate(
      { kind: "rule_create", ruleKind: "sender", match: "a@b.example", destination: "INBOX" },
      { idempotencyKey: "idem-noseq" },
    );
    expect(res.seq).toBeNull();
    expect(res.changes).toEqual([]);
  });

  it("throws non-retryably on a 400 — the server refused the rule, and a retry would too", async () => {
    const adapter = adapterCapturing([], () =>
      new Response(JSON.stringify({ error: { code: "validation_failed", message: "match is required" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      adapter.mutate(
        { kind: "rule_create", ruleKind: "sender", match: "a@b.example", destination: "INBOX" },
        { idempotencyKey: "idem-400" },
      ),
    ).rejects.toMatchObject({ status: 400, retryable: false });
  });
});

describe("creating a rule is optimistic, and moves no mail", () => {
  it("shows the rule immediately and leaves every message exactly where it is", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();

    const before = messagesIn(engine.read(), "INBOX").map((m: EngineMessage) => m.id).sort();
    const rulesBefore = rulesList(engine.read()).length;

    const res = await engine.mutate({
      kind: "rule_create", ruleKind: "domain", match: "x.example", destination: "ohmail/News",
    });
    expect(res.status).toBe("confirmed");

    const after = rulesList(engine.read());
    // EXACTLY ONE new row: the optimistic overlay carries a client uuid and the authoritative
    // change carries the world's, and the overlay is dropped as the change lands. Two rows here
    // would mean the mirror is keeping a row no delta can ever update or remove.
    expect(after).toHaveLength(rulesBefore + 1);
    const made = after.find((r) => r.match === "x.example")!;
    expect(made).toMatchObject({ kind: "domain", destination: "ohmail/News", provenance: "manual", enabled: true });

    /**
     * THE LOAD-BEARING ASSERTION, and it is `rule_delete`'s. Rules are consulted when mail
     * ARRIVES, never retroactively, so an effect that re-filed the mirror would paint a sort
     * the server is not going to perform and the next drain would undo all of it.
     */
    expect(messagesIn(engine.read(), "INBOX").map((m: EngineMessage) => m.id).sort()).toEqual(before);
  });

  it("a hard rejection takes the rule back off the screen", async () => {
    const fixtures = new FixturesAdapter();
    let refuse = false;
    const adapter: EngineAdapter = {
      sync: (p) => fixtures.sync(p),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => fixtures.fetchBody(),
      mutate: async (m, o) => {
        if (refuse && m.kind === "rule_create") {
          throw new MutationRejectedError("nope", { status: 403, retryable: false });
        }
        return fixtures.mutate(m, o);
      },
    };
    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();
    const before = rulesList(engine.read()).length;

    refuse = true;
    const res = await engine.mutate({
      kind: "rule_create", ruleKind: "sender", match: "a@b.example", destination: "INBOX",
    });
    expect(res.status).toBe("rolled_back");
    expect(rulesList(engine.read())).toHaveLength(before);
  });

  it("an empty match is refused locally, with nothing on the wire", async () => {
    // The server answers 400, and an empty `domain` match would be compared against the empty
    // domain of every malformed address — one rule ruling on all of them.
    const calls: string[] = [];
    const fixtures = new FixturesAdapter();
    const adapter: EngineAdapter = {
      sync: (p) => fixtures.sync(p),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => fixtures.fetchBody(),
      mutate: async (m, o) => { calls.push(m.kind); return fixtures.mutate(m, o); },
    };
    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();

    const res = await engine.mutate({ kind: "rule_create", ruleKind: "domain", match: "", destination: "INBOX" });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.status).toBe(404);
    expect(calls).toEqual([]);
  });
});

// ── the selector ────────────────────────────────────────────────────────────

/** A mirror holding nothing but rules — enough to drive `rulesList`. */
async function engineWithRules(rules: RuleDTO[], sent: EngineMutation[] = []): Promise<OhmailEngine> {
  let served = false;
  const adapter: EngineAdapter = {
    async sync(): Promise<SyncResponse> {
      const changes = served
        ? []
        : rules.map((r, i) => ({
            type: "rule" as const,
            op: "create" as const,
            id: r.id,
            seq: i + 1,
            updatedAt: r.updatedAt,
            entity: r,
          }));
      served = true;
      return {
        changes: { creates: changes, updates: [], moves: [], deletes: [] },
        cursor: String(rules.length),
        hasMore: false,
        serverTime: DEMO_NOW.toISOString(),
      };
    },
    async mutate(m): Promise<MutationOutcome> {
      sent.push(m);
      return { changes: [], seq: null };
    },
    async withdrawSend() { return { outcome: "unsupported" as const }; },
    async fetchBody() {
      return null;
    },
  };
  const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
  await engine.start();
  return engine;
}

describe("rulesList", () => {
  it("orders newest first, with the id as a deterministic tie-break", async () => {
    const engine = await engineWithRules([
      rule({ id: "b", createdAt: "2026-07-01T00:00:00.000Z" }),
      rule({ id: "c", createdAt: "2026-08-01T00:00:00.000Z" }),
      // Same instant as `c` — a bulk "apply to all" mints several at once.
      rule({ id: "a", createdAt: "2026-08-01T00:00:00.000Z" }),
    ]);

    expect(rulesList(engine.read()).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("reads the mirror, so a rule that predates this client is there after a bootstrap", async () => {
    const engine = await engineWithRules([rule({ id: "old", createdAt: "2025-01-01T00:00:00.000Z" })]);
    expect(rulesList(engine.read())).toHaveLength(1);
    expect(rulesList(engine.read())[0]).toMatchObject({ id: "old", provenance: "promoted" });
  });
});

/**
 * A rule stored before the 0.22 rename says `ohmail/Reads`, and the organizer files it into the one
 * News folder. The read door hands every reader the PLACE, so no surface splits one pile in two; the stored
 * spelling stays in the mirror, and a write that keeps the destination sends that spelling back.
 */
describe("rulesList — a rule reads as the place it files into, in either spelling", () => {
  const LEGACY = LEGACY_NEWS_FOLDER as Folder;

  it("a pre-0.22 News rule reads as the News pile, and the mirror row keeps its spelling", async () => {
    const engine = await engineWithRules([
      rule({ id: "old", destination: LEGACY }),
      rule({ id: "new", destination: "ohmail/News" }),
      rule({ id: "inbox", destination: "INBOX" }),
    ]);
    const read = rulesList(engine.read());
    const at = (id: string) => read.find((r) => r.id === id)!;
    expect(at("old").destination).toBe("ohmail/News");
    expect(at("new").destination).toBe("ohmail/News");
    expect(at("inbox").destination).toBe("INBOX");
    expect(engine.read().get<RuleDTO>("rule", "old")!.destination, "reading rewrote the mirror").toBe(LEGACY);
    expect(storedRuleDestination(at("old"))).toBe(LEGACY);
    expect(storedRuleDestination(at("new"))).toBe("ohmail/News");
    expect(storedRuleDestination(at("inbox"))).toBe("INBOX");
  });

  it("round trip: a write that keeps the place sends the stored spelling, and nothing is rewritten", async () => {
    const sent: EngineMutation[] = [];
    const engine = await engineWithRules([rule({ id: "old", destination: LEGACY })], sent);
    const [r] = rulesList(engine.read());
    const res = await engine.mutate({
      kind: "rule_update", ruleId: r!.id, destination: storedRuleDestination(r!), applyRetro: true,
    });
    expect(res.status).toBe("confirmed");
    expect(sent).toEqual([{ kind: "rule_update", ruleId: "old", destination: LEGACY, applyRetro: true }]);
    expect(engine.read().get<RuleDTO>("rule", "old")!.destination).toBe(LEGACY);
    expect(rulesList(engine.read())[0]!.destination).toBe("ohmail/News");
  });
});

// ── the optimistic effects ──────────────────────────────────────────────────

describe("revoking is optimistic, and moves no mail", () => {
  it("hides the rule immediately and leaves every message where it is", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();

    // Mint a real rule the way the product does — a Screener decision.
    await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes", read: true });
    const created = rulesList(engine.read()).find((r) => r.match === "lena@atelier-eichspan.example");
    expect(created, "the screener decision wrote no rule").toBeDefined();

    const ohboxBefore = messagesIn(engine.read(), "INBOX").map((m: EngineMessage) => m.id).sort();

    const res = await engine.mutate({ kind: "rule_delete", ruleId: created!.id });
    expect(res.status).toBe("confirmed");

    expect(rulesList(engine.read()).some((r) => r.id === created!.id)).toBe(false);
    /**
     * THE LOAD-BEARING ASSERTION. Revoking must not re-file anything: `RulesService.remove`
     * never touches `folder_state`, so an optimistic effect that moved mail would paint a
     * re-sort the server is not going to perform and the next drain would undo it.
     */
    expect(messagesIn(engine.read(), "INBOX").map((m: EngineMessage) => m.id).sort()).toEqual(ohboxBefore);
  });

  it("a hard rejection puts the rule back — the overlay is the only thing that changed", async () => {
    const fixtures = new FixturesAdapter();
    let refuse = false;
    const adapter: EngineAdapter = {
      sync: (p) => fixtures.sync(p),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => fixtures.fetchBody(),
      mutate: async (m, o) => {
        if (refuse && m.kind === "rule_delete") {
          throw new MutationRejectedError("nope", { status: 403, retryable: false });
        }
        return fixtures.mutate(m, o);
      },
    };
    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();

    await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes" });
    const created = rulesList(engine.read()).find((r) => r.match === "lena@atelier-eichspan.example")!;

    refuse = true;
    const res = await engine.mutate({ kind: "rule_delete", ruleId: created.id });
    expect(res.status).toBe("rolled_back");
    expect(rulesList(engine.read()).some((r) => r.id === created.id)).toBe(true);
  });

  it("retargeting rewrites only the destination, and moves no mail either", async () => {
    const engine = new OhmailEngine({ adapter: new FixturesAdapter(), now: () => DEMO_NOW });
    await engine.start();

    await engine.mutate({ kind: "screener_decide", senderId: "lena", decision: "yes" });
    const created = rulesList(engine.read()).find((r) => r.match === "lena@atelier-eichspan.example")!;
    expect(created.destination).toBe("INBOX");
    const ohboxBefore = messagesIn(engine.read(), "INBOX").map((m: EngineMessage) => m.id).sort();

    const res = await engine.mutate({ kind: "rule_update", ruleId: created.id, destination: "ohmail/News" });
    expect(res.status).toBe("confirmed");

    const after = rulesList(engine.read()).find((r) => r.id === created.id)!;
    expect(after.destination).toBe("ohmail/News");
    expect(after.match).toBe(created.match);
    expect(after.kind).toBe(created.kind);
    // A retarget names the place, so the server makes the rule the person's (`RulesService.update`)
    // and the overlay says the same rather than flipping under the echo (REVIEW-026 LOW 1).
    expect(created.provenance).toBe("promoted");
    expect(after.provenance).toBe("manual");
    expect(messagesIn(engine.read(), "INBOX").map((m: EngineMessage) => m.id).sort()).toEqual(ohboxBefore);
  });

  it("revoking a rule the mirror does not have is a local 404, with nothing on the wire", async () => {
    const calls: string[] = [];
    const fixtures = new FixturesAdapter();
    const adapter: EngineAdapter = {
      sync: (p) => fixtures.sync(p),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => fixtures.fetchBody(),
      mutate: async (m, o) => {
        calls.push(m.kind);
        return fixtures.mutate(m, o);
      },
    };
    const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
    await engine.start();

    const res = await engine.mutate({ kind: "rule_delete", ruleId: "no-such-rule" });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
