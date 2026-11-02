import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeScreenerService } from "@trafficflow/services";
import { rules, folderState, idempotencyKeys, mailboxes, messages, organizerRequests } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { makeDeps, seedSession, seedScreenerHeld, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** The bootstrap /sync buckets (ids + move metas). */
async function syncBuckets(deps: ApiDeps, token: string) {
  const b = await (await H(req("GET", "/sync?since=0", { bearer: token }), deps)).json();
  return {
    creates: b.changes.creates.map((c: { id: string }) => c.id),
    moves: b.changes.moves.map((c: { id: string; move: { from: string | null; to: string } }) => ({ id: c.id, move: c.move })),
  };
}

describe("GET /screener — derived first-contact queue", () => {
  it("lists one entry per held sender", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example", subject: "hi" });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example", subject: "again" }); // same sender → deduped
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "bob@ex.example", subject: "yo" });

    const res = await H(req("GET", "/screener", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(2);
    const senders = body.items.map((i: { sender: { address: string } }) => i.sender.address).sort();
    expect(senders).toEqual(["alice@ex.example", "bob@ex.example"]);
    // Nothing has been bought → no suggestions. this is a READ.
    expect(body.items.every((i: { aiSuggestion: unknown }) => i.aiSuggestion === null)).toBe(true);
  });

  it("carries the SET a control may offer, and no price — the dry run states that", async () => {
    // The figure a person consents to is `POST /screener/suggest`'s dry-run `quotedCredits` over
    // the set they press; a price on the read path would be a second figure beside it.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example" });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "bob@ex.example" });

    const body = await (await H(req("GET", "/screener", { bearer: s.token }), deps)).json();
    expect(body.suggestable.senders.sort()).toEqual(["alice@ex.example", "bob@ex.example"]);
    expect("credits" in body.suggestable).toBe(false);
  });

  it("`GET /screener` is still `cost: read`, and `POST /screener/suggest` is `work`", () => {
    // The census in spend-gate.test.ts is the enforcement; this is the sentence it enforces,
    // stated where the routes are. A GET that spends would have to move between these lists.
    const get = apiRoutes.find((r) => r.method === "GET" && r.pattern === "/screener");
    const suggest = apiRoutes.find((r) => r.method === "POST" && r.pattern === "/screener/suggest");
    expect(get?.cost).toBe("read");
    expect(suggest?.cost).toBe("work");
    expect(suggest?.options?.idempotent).toBe(true);
  });
});

describe("POST /screener/suggest — generation is an explicit, priced purchase", () => {
  it("is NOT swallowed by /screener/:id — `suggest` never arrives as a message id", async () => {
    // Both patterns are two segments. `matchRoute` scores the static segment higher, so
    // this resolves to the suggest route; without that it would reach `decide` and try to look
    // up a message whose id is the string "suggest".
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("POST", "/screener/suggest", {
      bearer: s.token, body: JSON.stringify({ senders: ["nobody@ex.example"] }),
    }), deps);
    // 503: this host builds no classifier. The point is that it is not a 404 from `decide`.
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("suggest_unconfigured");
  });

  it("refuses an absent sender set with 400 — it never means 'all'", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example" });

    for (const body of ["{}", JSON.stringify({ senders: [] }), JSON.stringify({ senders: "alice@ex.example" })]) {
      const res = await H(req("POST", "/screener/suggest", { bearer: s.token, body }), deps);
      expect(res.status, body).toBe(400);
      expect((await res.json()).error.code, body).toBe("validation_failed");
    }
  });

  it("refuses more than the cap with 413 rather than buying a prefix of it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const senders = Array.from({ length: 401 }, (_, i) => `s${i}@ex.example`);
    const res = await H(req("POST", "/screener/suggest", {
      bearer: s.token, body: JSON.stringify({ senders }),
    }), deps);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("payload_too_large");
  });

  /** A host WITH a model wired — the state the code has to be correct in, not the one it ships in. */
  async function withClassifier(calls: { n: number }) {
    const { db, deps } = await makeDeps();
    const screener = makeScreenerService({
      classifier: {
        async classify(i) {
          calls.n++;
          return { destination: "INBOX", confidence: 0.8, rationale: `about ${i.from.address}`, spam: false };
        },
      },
    });
    return { db, deps: { ...deps, services: { ...deps.services!, screener } } };
  }

  it("buys for the named senders, and the NEXT GET serves the stored answer without a model call", async () => {
    const calls = { n: 0 };
    const { db, deps } = await withClassifier(calls);
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example" });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "bob@ex.example" });

    const quote = await (await H(req("GET", "/screener", { bearer: s.token }), deps)).json();
    expect(quote.suggestable.senders).toHaveLength(2);

    const res = await H(req("POST", "/screener/suggest", {
      bearer: s.token, body: JSON.stringify({ senders: quote.suggestable.senders }),
    }), deps);
    expect(res.status).toBe(200);
    const bought = await res.json();
    expect(bought).toMatchObject({ dryRun: false, requested: 2, quoted: 2, skipped: [] });
    expect(bought.suggestions).toHaveLength(2);
    expect(calls.n).toBe(2);

    const after = await (await H(req("GET", "/screener", { bearer: s.token }), deps)).json();
    expect(after.items.every((i: { aiSuggestion: unknown }) => i.aiSuggestion !== null)).toBe(true);
    // EXACT SHAPE, and it stays exact: `recommendedPerRequest` joined when the client started
    // reading its request size off the wire instead of hardcoding one. Both numbers are literals
    // rather than the constants that produce them — this is the wire contract two separately
    // deployed artifacts agree on, and a test that imports the value it checks cannot see it move.
    // No `credits` (2026-09-24): the read path states no price; the dry run's quote is the figure.
    expect(after.suggestable).toEqual({
      senders: [], maxPerRequest: 50, recommendedPerRequest: 20,
    });
    expect(calls.n, "the GET called the model").toBe(2);
  });

  it("a DRY RUN over HTTP prices the set and calls nothing", async () => {
    const calls = { n: 0 };
    const { db, deps } = await withClassifier(calls);
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example" });

    const res = await H(req("POST", "/screener/suggest", {
      bearer: s.token, body: JSON.stringify({ senders: ["alice@ex.example"], dryRun: true }),
    }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: true, quoted: 1, charged: 0, suggestions: [] });
    expect(calls.n).toBe(0);
  });

  it("`automatic` over HTTP reaches the rule: a `no_ai` sender is skipped unasked; a bad flag is a 400", async () => {
    // The opt-in's unpressed batch says so on the wire, and the route hands it through untouched.
    const calls = { n: 0 };
    const { db, deps } = await withClassifier(calls);
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example" });
    const flagged = await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "bank@ex.example" });
    await db.update(messages).set({ noAi: true }).where(eq(messages.id, flagged.id));
    const post = (body: unknown) => H(req("POST", "/screener/suggest", { bearer: s.token, body: JSON.stringify(body) }), deps);

    const res = await post({ senders: ["alice@ex.example", "bank@ex.example"], automatic: true });
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toEqual([{ sender: "bank@ex.example", reason: "no_auto_ai" }]);
    expect(calls.n).toBe(1);
    const bad = await post({ senders: ["bank@ex.example"], automatic: "yes" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("validation_failed");
    expect(calls.n, "a malformed flag reached the model").toBe(1);
  });

  it("an Idempotency-Key replay returns the stored response and calls the model ONCE", async () => {
    const calls = { n: 0 };
    const { db, deps } = await withClassifier(calls);
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example" });
    const body = JSON.stringify({ senders: ["alice@ex.example"] });

    const first = await H(req("POST", "/screener/suggest", {
      bearer: s.token, headers: { "idempotency-key": "sg1" }, body,
    }), deps);
    expect(first.status).toBe(200);
    const firstJson = await first.json();

    const replay = await H(req("POST", "/screener/suggest", {
      bearer: s.token, headers: { "idempotency-key": "sg1" }, body,
    }), deps);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstJson);
    expect(calls.n, "the retry bought a second time").toBe(1);

    // Same key, different set → 409, exactly as `decide` answers.
    const conflict = await H(req("POST", "/screener/suggest", {
      bearer: s.token, headers: { "idempotency-key": "sg1" },
      body: JSON.stringify({ senders: ["bob@ex.example"] }),
    }), deps);
    expect(conflict.status).toBe(409);
  });

  it("a same-key retry while the purchase is still running is told to come back, and buys nothing", async () => {
    // The first request is caught inside its model call. Its key is already bound to its body, so
    // the retry of that body is a retryable 409 `idempotency_in_progress` and another body is the
    // ordinary 409 replay refusal — neither reaches the model. Released, the first answers and the
    // retry then replays that answer.
    const calls = { n: 0 };
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const { db, deps: base } = await makeDeps();
    const screener = makeScreenerService({
      classifier: {
        async classify(i) {
          calls.n++; entered(); await gate;
          return { destination: "INBOX", confidence: 0.8, rationale: `about ${i.from.address}`, spam: false };
        },
      },
    });
    const deps = { ...base, services: { ...base.services!, screener } };
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example" });
    const body = JSON.stringify({ senders: ["alice@ex.example"] });
    const send = (b: string) => H(req("POST", "/screener/suggest", {
      bearer: s.token, headers: { "idempotency-key": "sg-live" }, body: b,
    }), deps);

    const first = send(body);
    await inside;
    const retry = await send(body);
    expect(retry.status).toBe(409);
    expect((await retry.json()).error).toMatchObject({ code: "idempotency_in_progress", retryable: true });
    expect(retry.headers.get("retry-after")).toBe("2");
    const other = await send(JSON.stringify({ senders: ["bob@ex.example"] }));
    expect(other.status).toBe(409);
    expect((await other.json()).error.code).toBe("idempotency_replay");
    expect(calls.n, "a retry reached the model while the first request held the key").toBe(1);

    open();
    const done = await first;
    expect(done.status).toBe(200);
    const answer = await done.json();
    const replay = await send(body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(answer);
    expect(calls.n).toBe(1);
  });

  it("the REFUSAL ORDER puts the unreadable body first: a bad set is 400 even with no classifier", async () => {
    // If the 503 came first, a client could never tell a malformed request from an unconfigured
    // host, and the validation would be untestable on every deployment that has no model.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("POST", "/screener/suggest", { bearer: s.token, body: "{}" }), deps);
    expect(res.status).toBe(400);
  });
});

describe("POST /screener/:id — decide (defer + idempotency)", () => {
  it("yes → 200, folder_state INBOX pending (NOT reconciled — API opened no IMAP), promoted rule, changes in /sync", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const held = await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example" });

    const item = (await (await H(req("GET", "/screener", { bearer: s.token }), deps)).json()).items[0];
    const res = await H(req("POST", `/screener/${item.id}`, { bearer: s.token, body: JSON.stringify({ decision: "yes" }) }), deps);
    expect(res.status).toBe(200);
    const dto = await res.json();
    expect(dto).toMatchObject({ messageId: held.id, appliedFolder: "INBOX" });
    expect(dto.createdRuleId).toBeTruthy();

    // Defer proof: desired=INBOX but reconcileStatus still 'pending' — the API did NOT reconcile.
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, held.id));
    expect(fs).toMatchObject({ desiredFolder: "INBOX", reconcileStatus: "pending", lastSetBy: "us" });

    // Promoted rule created.
    const promoted = await db.select().from(rules).where(and(eq(rules.accountId, s.accountId), eq(rules.provenance, "promoted")));
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ kind: "sender", match: "alice@ex.example", destination: "INBOX" });

    // Changes visible via /sync: the rule create + the message move to INBOX.
    const buckets = await syncBuckets(deps, s.token);
    expect(buckets.creates).toContain(dto.createdRuleId);
    expect(buckets.moves.find((m) => m.id === held.id)?.move).toEqual({ from: "ohmail/Screener", to: "INBOX" });
  });

  it("idempotent: replay same key+body → verbatim 200 AND exactly ONE promoted rule; different body same key → 409", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example" });
    const item = (await (await H(req("GET", "/screener", { bearer: s.token }), deps)).json()).items[0];
    const body = JSON.stringify({ decision: "yes" });

    const first = await H(req("POST", `/screener/${item.id}`, { bearer: s.token, headers: { "idempotency-key": "sc1" }, body }), deps);
    expect(first.status).toBe(200);
    const firstJson = await first.json();

    // Replay: verbatim, and NO duplicate promoted rule (the in-tx idempotency blocked the dup side effect).
    const replay = await H(req("POST", `/screener/${item.id}`, { bearer: s.token, headers: { "idempotency-key": "sc1" }, body }), deps);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstJson);

    const promoted = await db.select().from(rules).where(and(eq(rules.accountId, s.accountId), eq(rules.provenance, "promoted")));
    expect(promoted).toHaveLength(1);
    const idem = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.accountId, s.accountId));
    expect(idem).toHaveLength(1);

    // Same key, different body → 409.
    const conflict = await H(req("POST", `/screener/${item.id}`, {
      bearer: s.token, headers: { "idempotency-key": "sc1" }, body: JSON.stringify({ decision: "no" }),
    }), deps);
    expect(conflict.status).toBe(409);
  });

  it("unknown screener id → 404", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("POST", "/screener/00000000-0000-0000-0000-000000000000", { bearer: s.token, body: JSON.stringify({ decision: "yes" }) }), deps);
    expect(res.status).toBe(404);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE READER'S DOOR ON THE WIRE — 202, and the excluded set by name (0.14.1)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A mailbox this install READS rather than organizes cannot be written to: a decision made there
 * becomes a request for whoever holds the mailbox (`ScreenerService.requestAsReader`). Two things
 * have to reach the client for that to be renderable at all, and both are asserted here rather
 * than only at the service tier, because a field the service computes and the route drops is
 * indistinguishable — from the client — from a field nobody computed.
 *
 * ── THE HOLDER COLUMN IS SEEDED BY HAND, AND THAT IS NOT A SHORTCUT ──────────────────────────
 *
 * `organized_by_capabilities = 'requests'` is written here directly because NO BUILD WRITES IT
 * TODAY: ruling §(i) containment empties `ORGANIZER_CAPABILITIES`
 * (`apps/worker/src/lease.ts`), so every organizer this tree ships advertises nothing and every
 * reader is refused — which is exactly what
 * an end-to-end worker case proved when it was written, and what production
 * does. These two tests pin the WIRE CONTRACT the channel will answer on when the signature work
 * (§(i).1/3) lands and the capability is advertised again, so that L3 can build the client half
 * against a shape that is already fixed and already tested. They assert the route, not the state
 * of the fleet.
 */
describe("POST /screener/:id — the READER branch answers 202, live and on replay", () => {
  async function readerWithCapableHolder(db: Awaited<ReturnType<typeof makeDeps>>["db"], accountId: string) {
    const held = await seedScreenerHeld(db, { accountId, fromAddress: "alice@ex.example" });
    await db.update(mailboxes).set({
      organizerRole: "reader", organizerState: "held",
      organizedByKind: "cloud", organizedByName: "ohmail Cloud", organizedByCapabilities: "requests",
    }).where(eq(mailboxes.id, held.mailboxId));
    return held;
  }

  it("202 on the live call — a queued decision is not an applied one, and the body says which", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const held = await readerWithCapableHolder(db, s.accountId);

    const res = await H(req("POST", `/screener/${held.id}`, {
      bearer: s.token, body: JSON.stringify({ decision: "yes" }),
    }), deps);

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.pending).toBe(true);
    expect(typeof body.requestId).toBe("string");
    expect(body.holder).toMatchObject({ kind: "cloud", name: "ohmail Cloud" });

    // Nothing was applied: no promoted rule, and the mail is still at the gate.
    const promoted = await db.select().from(rules).where(and(eq(rules.accountId, s.accountId), eq(rules.provenance, "promoted")));
    expect(promoted).toEqual([]);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, held.id));
    expect(fs?.desiredFolder).toBe("ohmail/Screener");
  });

  it("THE REPLAY ANSWERS 202 TOO — one decision cannot have two status codes", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const held = await readerWithCapableHolder(db, s.accountId);
    const body = JSON.stringify({ decision: "yes" });
    const headers = { "idempotency-key": "rq1" };

    const first = await H(req("POST", `/screener/${held.id}`, { bearer: s.token, headers, body }), deps);
    expect(first.status).toBe(202);
    const firstJson = await first.json();

    const replay = await H(req("POST", `/screener/${held.id}`, { bearer: s.token, headers, body }), deps);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(firstJson);

    // ONE queued request for the two calls — the replay re-served the stored answer, it did not
    // queue a second decision for one press.
    const queued = await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, s.accountId));
    expect(queued).toHaveLength(1);
  });
});

describe("GET /screener — pendingDecisions reaches the wire", () => {
  it("a decided sender leaves `items` AND appears in `pendingDecisions`, named", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const alice = await seedScreenerHeld(db, { accountId: s.accountId, fromAddress: "alice@ex.example" });
    await seedScreenerHeld(db, { accountId: s.accountId, mailboxId: alice.mailboxId, fromAddress: "bob@ex.example" });
    await db.update(mailboxes).set({
      organizerRole: "reader", organizerState: "held",
      organizedByKind: "cloud", organizedByName: "ohmail Cloud", organizedByCapabilities: "requests",
    }).where(eq(mailboxes.id, alice.mailboxId));

    // Before: both senders are in the queue and nothing is pending.
    const before = await (await H(req("GET", "/screener", { bearer: s.token }), deps)).json();
    expect(before.items.map((i: { sender: { address: string } }) => i.sender.address).sort())
      .toEqual(["alice@ex.example", "bob@ex.example"]);
    expect(before.pendingDecisions).toEqual([]);

    await H(req("POST", `/screener/${alice.id}`, { bearer: s.token, body: JSON.stringify({ decision: "yes" }) }), deps);

    const after = await (await H(req("GET", "/screener", { bearer: s.token }), deps)).json();
    expect(after.items.map((i: { sender: { address: string } }) => i.sender.address)).toEqual(["bob@ex.example"]);
    // The excluded sender is accounted for by name — this is the field that keeps the row above
    // from being an unexplained disappearance.
    expect(after.pendingDecisions).toHaveLength(1);
    expect(after.pendingDecisions[0]).toMatchObject({ subject: "alice@ex.example", scope: "sender", sent: false });
    expect(typeof after.pendingDecisions[0].decidedAt).toBe("string");
  });
});

/* THE NOTE ON NEWS AND RECEIPTS on the wire (owner report 2026-11-02): `?pile=` asks a pile instead
   of the Ohbox and says the pile back, so a client tells it from an older server's Ohbox answer;
   the press names the pile in its body; anything else is a 400 before a row is read. */
describe("GET/POST /screener/unscreened — a pile's note", () => {
  it("answers the pile and says it back; the Ohbox's answer says none; the press moves the pile's letters", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const cold = await seedMessage(db, { accountId: s.accountId, mailboxId, folder: "ohmail/News", fromAddress: "deals@cold.example", date: new Date("2024-03-01T08:00:00Z") });
    await seedMessage(db, { accountId: s.accountId, mailboxId, folder: "ohmail/Receipts", fromAddress: "shop@cold.example", date: new Date("2024-03-01T08:00:00Z") });

    const news = await H(req("GET", "/screener/unscreened?pile=news", { bearer: s.token }), deps);
    expect(news.status).toBe(200);
    expect(await news.json()).toMatchObject({
      groups: [{ address: "deals@cold.example", count: 1 }], total: 1, complete: true, pile: "news",
    });
    const ohbox = await (await H(req("GET", "/screener/unscreened", { bearer: s.token }), deps)).json();
    expect(ohbox).toMatchObject({ groups: [], total: 0 });
    expect(ohbox, "the Ohbox's answer named a pile").not.toHaveProperty("pile");

    const pressed = await H(req("POST", "/screener/unscreened", {
      bearer: s.token, headers: { "idempotency-key": "pile-1" }, body: JSON.stringify({ pile: "news" }),
    }), deps);
    expect(pressed.status).toBe(200);
    expect(await pressed.json()).toMatchObject({ screened: [{ address: "deals@cold.example", count: 1 }], total: 1 });
    const [fs] = await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, cold.id));
    expect(fs!.d).toBe("ohmail/Screener");
  });

  it("a pile that is neither News nor Receipts is a 400, on the read and on the press", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    for (const pile of ["spam", "News", ""]) {
      const read = await H(req("GET", `/screener/unscreened?pile=${pile}`, { bearer: s.token }), deps);
      expect(read.status, `?pile=${pile}`).toBe(400);
    }
    for (const pile of ["spam", 7, null]) {
      const press = await H(req("POST", "/screener/unscreened", {
        bearer: s.token, headers: { "idempotency-key": `pile-${String(pile)}` }, body: JSON.stringify({ pile }),
      }), deps);
      expect(press.status, JSON.stringify(pile)).toBe(400);
    }
  });
});
