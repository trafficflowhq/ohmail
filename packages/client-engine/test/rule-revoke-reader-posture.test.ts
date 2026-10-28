import { describe, expect, it } from "vitest";
import { mailboxes, mailboxProfileMirror, organizerRequests } from "@trafficflow/db";
import {
  HttpAdapter, OUTBOX_TYPE, OhmailEngine, heldRuleId, heldRuleKey, planScreenCommit, pressRules,
  type EngineMutation, type RuleDTO, type ScreenIntent,
} from "../src/index.js";
import { verbWorld, type VerbWorld } from "./verb-parity/world.js";

/**
 * A RULE REVOKE ON A READER — the real engine over the real route table (PGlite), the postures
 * `planAccountFanOut` decides between. Where nothing organizes the mailbox (released) the door
 * answers 409 organized_elsewhere with `{ by, reason }`; the surface can only say WHY if that
 * reason reaches the result. "Organize here" pressed and the claim not landed yet is WRITTEN here:
 * an edit made during a takeover belongs to the install taking over.
 */

async function worldWithRule(): Promise<{ w: VerbWorld; ruleId: string }> {
  const w = await verbWorld();
  const made = await w.engine.mutate({
    kind: "rule_create", ruleKind: "sender", match: "lena@atelier.example", destination: "ohmail/News",
  });
  expect(made.status).toBe("confirmed");
  const rule = w.store.list<RuleDTO>("rule").find((r) => r.match === "lena@atelier.example");
  expect(rule, "the rule never reached the mirror").toBeDefined();
  return { w, ruleId: rule!.id };
}

/**
 * The world's ONE mailbox, rewritten. No `where`: this package cannot resolve `drizzle-orm`, and
 * each world is its own in-memory database, so the count is asserted instead.
 */
async function setOnlyMailbox(w: VerbWorld, set: Partial<typeof mailboxes.$inferInsert>): Promise<void> {
  const rows = await w.db.select({ id: mailboxes.id }).from(mailboxes);
  expect(rows.map((r) => r.id)).toEqual([w.mailboxId]);
  await w.db.update(mailboxes).set(set);
}

/** Handed back: a reader nothing holds, carrying the release marker. */
async function released(w: VerbWorld): Promise<void> {
  await setOnlyMailbox(w, {
    organizerRole: "reader", organizedByKind: null, organizedByName: null, organizedSince: null,
    organizerState: null, organizedByCapabilities: null,
    organizeConsentedAt: w.clock.now(), organizerReleasedAt: w.clock.now(),
  });
}

/** "Organize here" pressed, the claim not landed: the standing press, still a reader. */
async function starting(w: VerbWorld): Promise<void> {
  await setOnlyMailbox(w, {
    organizerRole: "reader", organizedByKind: null, organizedByName: null, organizedSince: null,
    organizerState: null, organizedByCapabilities: null, organizerReleasedAt: null,
    organizeConsentedAt: w.clock.now(), takeoverAuthorizedAt: w.clock.now(),
  });
}

describe("a revoke where nothing organizes the mailbox is refused, and the refusal says why", () => {
  for (const [label, posture] of [["handed back", released]] as const) {
    it(`${label}: 409 organized_elsewhere, reason no_organizer on the result, the rule still listed`, async () => {
      const { w, ruleId } = await worldWithRule();
      await posture(w);
      const res = await w.engine.mutate({ kind: "rule_delete", ruleId });
      expect(res.status).toBe("rolled_back");
      expect(res.error?.status).toBe(409);
      expect(res.error?.code).toBe("organized_elsewhere");
      // The reason is the fact a sentence turns on; before the fix the adapter dropped it.
      const details = res.error?.details as { reason?: string; by?: { kind: unknown } } | undefined;
      expect(details?.reason).toBe("no_organizer");
      expect(details?.by?.kind ?? null).toBeNull();
      // …and the server's own sentence claims no holder that does not exist.
      expect(res.error?.message).toMatch(/^nothing organizes this mailbox right now/);
      expect(res.error?.message).not.toContain("another install");
      expect(w.store.list<RuleDTO>("rule").map((r) => r.id)).toContain(ruleId);
    });
  }
});

describe("controls: the two postures where a revoke has somewhere to go", () => {
  it("the organizer: confirmed, and the rule is gone", async () => {
    const { w, ruleId } = await worldWithRule();
    const res = await w.engine.mutate({ kind: "rule_delete", ruleId });
    expect(res.status).toBe("confirmed");
    // Server truth: a second engine bootstrapping from nothing.
    const fresh = await w.freshStore();
    expect(fresh.list<RuleDTO>("rule").map((r) => r.id)).not.toContain(ruleId);
  });

  it("organizing not started yet: written here, for the install taking over, and the rule is gone", async () => {
    const { w, ruleId } = await worldWithRule();
    await starting(w);
    const res = await w.engine.mutate({ kind: "rule_delete", ruleId });
    expect(res.status).toBe("confirmed");
    const fresh = await w.freshStore();
    expect(fresh.list<RuleDTO>("rule").map((r) => r.id)).not.toContain(ruleId);
  });

  it("a reader whose holder takes rule requests: awaiting that holder, the rule still listed", async () => {
    const { w, ruleId } = await worldWithRule();
    await setOnlyMailbox(w, {
      organizerRole: "reader", organizerState: "held", organizedByKind: "local",
      organizedByName: "Studio laptop", organizedByCapabilities: "requests,rules",
    });
    const res = await w.engine.mutate({ kind: "rule_delete", ruleId });
    expect(res.status).toBe("awaiting_organizer");
    expect(res.queuedWith?.name).toBe("Studio laptop");
    expect(w.store.list<RuleDTO>("rule").map((r) => r.id)).toContain(ruleId);
  });
});

describe("a published rule with no row here is pressed by its key", () => {
  const KEY = { kind: "sender", match: "lena@atelier.example", subjectContains: null, bodyContains: null };
  /** A reader whose holder takes rule requests, and the holder's copy listing one rule. */
  async function readerWithCopy(w: VerbWorld): Promise<void> {
    await setOnlyMailbox(w, {
      organizerRole: "reader", organizerState: "held", organizedByKind: "local",
      organizedByName: "Studio laptop", organizedByCapabilities: "requests,rules",
    });
    await w.db.insert(mailboxProfileMirror).values({
      mailboxId: w.mailboxId, accountId: w.accountId, readAt: w.clock.now(),
      doc: { v: 2, rules: [{ kind: "sender", match: "Lena@atelier.example", destination: "ohmail/News", priority: 0, enabled: true }] },
    });
  }
  const requests = async (w: VerbWorld) =>
    (await w.db.select().from(organizerRequests)).map((r) => [r.kind, r.payload]);

  it("a revoke goes by the key with nothing painted, and waits on the organizer", async () => {
    const w = await verbWorld();
    await readerWithCopy(w);
    const res = await w.engine.mutate({ kind: "rule_delete", ruleId: heldRuleId(KEY) });
    expect(res.status).toBe("awaiting_organizer");
    expect(res.queuedWith?.name).toBe("Studio laptop");
    expect(await requests(w)).toEqual([["rule.delete", { key: { ...KEY, match: "Lena@atelier.example" } }]]);
    expect(w.engine.read().list<RuleDTO>("rule")).toEqual([]);
  });

  it("a change by key is kept with its key through a restart, and the next boot sends it", async () => {
    const w = await verbWorld();
    await readerWithCopy(w);
    const offline = new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: async () => { throw new TypeError("offline"); } }),
      store: w.store, now: () => w.clock.now(),
    });
    const res = await offline.mutate({ kind: "rule_update", ruleId: heldRuleId(KEY), destination: "INBOX" });
    expect(res.status).toBe("queued");
    const kept = w.store.entries<{ mutation: EngineMutation }>(OUTBOX_TYPE).map((e) => e.entity?.mutation);
    expect(kept).toEqual([expect.objectContaining({ kind: "rule_update", key: KEY, destination: "INBOX" })]);

    const next = new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl }), store: w.store, now: () => w.clock.now(),
    });
    await next.hydrate();
    await next.syncOnce();
    expect(await requests(w)).toEqual([[
      "rule.update", { key: { ...KEY, match: "Lena@atelier.example" }, set: { destination: "inbox" } },
    ]]);
  });

  /** A sheet press with past mail off, planned as a reader-only install plans it: over the copy. */
  const press = (e: OhmailEngine, w: VerbWorld, dest: ScreenIntent["dest"]): EngineMutation[] => {
    const over = pressRules(e.read(), {
      travels: true, queued: e.queuedRuleWrites(), applied: e.appliedRuleRequests(), unsettled: e.unsettledRulePresses(), now: w.clock.now(),
    });
    return planScreenCommit(e.read(), {
      v: 2, verb: "screen", id: dest, seedId: "m1", address: KEY.match, scope: "sender", dest,
      messageIds: [], makeRule: true, applyRetro: false, resolution: "keep", shown: [], at: 0,
    }, over).writes;
  };
  const destinations = async (w: VerbWorld) => (await w.db.select().from(organizerRequests))
    .map((r) => [r.kind, (r.payload as { set?: { destination?: string } }).set?.destination]);

  for (const listed of [false, true]) {
    it(`a press back to the copy's place while the first waits on the organizer travels after it${listed ? " (the server lists it)" : ""}`, async () => {
      const w = await verbWorld();
      await readerWithCopy(w);
      await w.engine.syncOnce();
      const one = press(w.engine, w, "ohbox");
      expect(one).toEqual([{ kind: "rule_update", ruleId: heldRuleId(KEY), destination: "INBOX", applyRetro: false }]);
      expect((await w.engine.mutate(one[0]!)).status).toBe("awaiting_organizer");
      if (listed) {
        w.engine.refreshWaitingOnOrganizer();
        await new Promise((r) => setTimeout(r, 30));
        expect(w.engine.waitingOnOrganizer().map((x) => x.state)).toEqual(["pending"]);
      }
      const two = press(w.engine, w, "reads");
      expect(two, "not 'already' over a copy that cannot show the first press yet")
        .toEqual([{ kind: "rule_update", ruleId: heldRuleId(KEY), destination: "ohmail/News", applyRetro: false }]);
      expect((await w.engine.mutate(two[0]!)).status).toBe("awaiting_organizer");
      expect(await destinations(w)).toEqual([["rule.update", "inbox"], ["rule.update", "reads"]]);
    });
  }

  for (const own of [false, true]) {
    it(`a press back while the first is still on the outbox reaches the organizer after it (${own ? "a row here" : "no row here"})`, async () => {
      const w = own ? (await worldWithRule()).w : await verbWorld();
      await readerWithCopy(w);
      await w.engine.syncOnce();
      const offline = new OhmailEngine({
        adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: async () => { throw new TypeError("offline"); } }),
        store: w.store, now: () => w.clock.now(),
      });
      await offline.hydrate();
      const one = press(offline, w, "ohbox");
      expect(one).toHaveLength(1);
      expect((await offline.mutate(one[0]!)).status).toBe("queued");
      const two = press(offline, w, "reads");
      expect(two).toEqual([{ kind: "rule_update", ruleId: one[0]!.kind === "rule_update" ? one[0]!.ruleId : "", destination: "ohmail/News", applyRetro: false }]);
      expect((await offline.mutate(two[0]!)).status).toBe("queued");
      const next = new OhmailEngine({
        adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: w.fetchImpl }), store: w.store, now: () => w.clock.now(),
      });
      await next.hydrate();
      await next.syncOnce();
      expect((await destinations(w)).at(-1)).toEqual(["rule.update", "reads"]);
    });
  }

  it("a twin's id or a garbled held id names no key: refused here, nothing sent", async () => {
    const w = await verbWorld();
    await readerWithCopy(w);
    for (const ruleId of [`${heldRuleId(KEY)}#1`, "held:[\"sender\"", "held:{}"]) {
      const res = await w.engine.mutate({ kind: "rule_delete", ruleId });
      expect(res.status, ruleId).toBe("rolled_back");
      expect(res.error?.code).toBe("not_found");
    }
    expect(heldRuleKey(heldRuleId(KEY))).toEqual(KEY);
    expect(await requests(w)).toEqual([]);
  });
});
