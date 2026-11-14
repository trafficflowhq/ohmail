import type { ScreenRequestResult } from "@ohmail/wire";
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxes, organizerRequests } from "@trafficflow/db";
import { ScreenerService } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * `ScreenerService.decide` — THE READER BRANCH (mail 0088).
 *
 * `makeCtx()` inserts a mailbox with the schema's own default, `organizer_role = 'organizer'`,
 * which is what every OTHER screener test exercises (the organizer path is unchanged by
 * construction — see `screener-service.test.ts`, `screener-domain-scope.pg.test.ts` and the
 * rest, all green against this refactor with zero edits). This file is the READER half: a
 * mailbox this install does not organize, whose decision becomes a request instead of a write.
 */
async function makeReaderCtx(over: {
  organizerState?: string | null; organizedByCapabilities?: string | null;
  organizedByKind?: string | null; organizedByName?: string | null;
} = {}) {
  const ctx = await makeCtx();
  await ctx.db.update(mailboxes).set({
    organizerRole: "reader",
    organizerState: over.organizerState === undefined ? "held" : over.organizerState,
    organizedByCapabilities: over.organizedByCapabilities === undefined ? "requests" : over.organizedByCapabilities,
    organizedByKind: over.organizedByKind === undefined ? "cloud" : over.organizedByKind,
    organizedByName: over.organizedByName === undefined ? "ohmail Cloud" : over.organizedByName,
  }).where(eq(mailboxes.id, ctx.mailboxId));
  return ctx;
}

describe("ScreenerService.decide — the reader branch", () => {
  it("a capable reader (held + advertises requests) gets 202 pending, never a direct write", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const svc = new ScreenerService({});

    const result = await svc.decide(ctx, id, { decision: "yes" }) as ScreenRequestResult;
    expect(result.pending).toBe(true);
    expect(typeof result.requestId).toBe("string");
    expect(result.holder).toEqual({ kind: "cloud", name: "ohmail Cloud", since: null });

    // NO direct write happened — no rule, the message is still held.
    const { rules, folderState } = await import("@trafficflow/db");
    const createdRules = await db.select().from(rules).where(eq(rules.accountId, accountId));
    expect(createdRules).toEqual([]);
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs?.desiredFolder).toBe("ohmail/Screener");

    // The row IS a pending organizer_requests entry, with the validated, resolved payload.
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, result.requestId));
    expect(row?.state).toBe("pending");
    expect(row?.mailboxId).toBe(mailboxId);
    expect(row?.kind).toBe("screener.decide");
    // `applyRetro` rides along (0.19): the reader's past-mail answer has to cross the install
    // boundary, or a decline made here becomes consent on the organizer that applies it. Absent
    // from the caller's body ⇒ the default, true, and that is what is recorded.
    expect(row?.payload).toEqual({
      scope: "sender", address: "person@example.com", appliedFolder: "INBOX", decision: "yes",
      match: "person@example.com", applyRetro: true,
    });
  });

  it("the reader's DECLINE of the past-mail apply is what the record carries", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const svc = new ScreenerService({});
    const result = await svc.decide(
      ctx, id, { decision: "yes", applyRetro: false },
    ) as ScreenRequestResult;
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, result.requestId));
    expect(row?.payload).toMatchObject({ applyRetro: false });
  });

  it("a domain-scope reader decision resolves the same match the organizer's own rule would use", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: "a@corp.example" });
    const svc = new ScreenerService({});
    const result = await svc.decide(ctx, id, { decision: "no", scope: "domain" }) as ScreenRequestResult;
    const [row] = await db.select().from(organizerRequests).where(eq(organizerRequests.id, result.requestId));
    expect(row?.payload).toMatchObject({ scope: "domain", match: "corp.example", appliedFolder: "ohmail/Screened" });
  });

  it("validation still runs BEFORE a request is ever queued — a bad decision never reaches organizer_requests", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const svc = new ScreenerService({});
    await expect(svc.decide(ctx, id, { decision: "maybe" as "yes" })).rejects.toMatchObject({ code: "validation_failed" });
    const rows = await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId));
    expect(rows).toEqual([]);
  });

  it("a holder that is held but does NOT advertise requests — 409 organizer_outdated", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx({ organizedByCapabilities: null });
    const id = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const svc = new ScreenerService({});
    await expect(svc.decide(ctx, id, { decision: "yes" })).rejects.toMatchObject({
      code: "organized_elsewhere", httpStatus: 409,
      details: { reason: "organizer_outdated", by: { kind: "cloud", name: "ohmail Cloud" } },
    });
    const rows = await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId));
    expect(rows).toEqual([]);
  });

  it("a holder that STOPPED (organizer_state='stopped') — 409 no_organizer, however capabilities read", async () => {
    // A lapsed lease organizes nothing; this case pinned `organizer_outdated` until the decider.
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx({ organizerState: "stopped" });
    const id = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const svc = new ScreenerService({});
    await expect(svc.decide(ctx, id, { decision: "yes" })).rejects.toMatchObject({
      code: "organized_elsewhere", httpStatus: 409, details: { reason: "no_organizer" },
    });
    void db; void accountId;
  });

  it("a STOPPED target beside a mailbox whose live holder takes decisions — the reader branch says no_organizer", async () => {
    // The fan-out has somewhere to send, so the refusal is the target's own (`requestAsReader`).
    const { db, accountId, ctx } = await makeReaderCtx();
    const [stopped] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "second@lichtgrat.example", organizerRole: "reader",
      organizerState: "stopped", organizedByCapabilities: "requests",
      organizedByKind: "local", organizedByName: "Studio laptop",
    }).returning();
    const id = await seedMessage(db, accountId, stopped!.id, { from: "person@example.com" });
    await expect(new ScreenerService({}).decide(ctx, id, { decision: "yes" })).rejects.toMatchObject({
      code: "organized_elsewhere", details: { reason: "no_organizer", by: { name: "Studio laptop" } },
    });
    expect(await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId))).toEqual([]);
  });

  it("no holder at all (pre-consent / nobody has ever organized) — 409 no_organizer", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx({
      organizerState: null, organizedByCapabilities: null, organizedByKind: null, organizedByName: null,
    });
    const id = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const svc = new ScreenerService({});
    await expect(svc.decide(ctx, id, { decision: "yes" })).rejects.toMatchObject({
      code: "organized_elsewhere", httpStatus: 409,
      details: { reason: "no_organizer", by: { kind: null } },
    });
    void accountId;
  });

  it("a duplicate Idempotency-Key does not queue a second request — the route layer replays the stored 202", async () => {
    // Same contract `screener-ai.test.ts`'s own idempotency test pins for `suggest`: the SERVICE
    // claims the key once and the SECOND raw call throws `IdempotencyRaceLost` — replaying the
    // stored response is the ROUTE layer's job (`withIdempotency`, `packages/api`), which reads
    // the row this transaction wrote rather than calling `decide` again.
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const svc = new ScreenerService({});
    const idem = { key: "idem-1", requestHash: "h" };
    const first = await svc.decide(ctx, id, { decision: "yes" }, { idempotency: idem }) as ScreenRequestResult;
    await expect(svc.decide(ctx, id, { decision: "yes" }, { idempotency: idem }))
      .rejects.toMatchObject({ name: "IdempotencyRaceLost" });

    const rows = await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.requestId);

    const { idempotencyKeys } = await import("@trafficflow/db");
    const [stored] = await db.select().from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, "idem-1"));
    expect(stored?.responseStatus).toBe(202);
    expect(stored?.responseJson).toEqual(first);
  });

  /**
   * A TOMBSTONE IS NOT A READER. A removed mailbox keeps whatever `organizer_role` it had, so it
   * reads `capable: false` and used to fall to the reader branch — which refuses with "another
   * install is organizing this mailbox", names whoever held it before the removal, and offers a
   * takeover of something that no longer exists. Every clause of that is false.
   */
  it("a DISABLED (removed) mailbox answers not-found, never `organized_elsewhere`", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    await db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, mailboxId));
    const svc = new ScreenerService({});
    await expect(svc.decide(ctx, id, { decision: "yes" })).rejects.toMatchObject({
      code: "not_found",
    });
    const rows = await db.select().from(organizerRequests)
      .where(eq(organizerRequests.accountId, accountId));
    expect(rows).toEqual([]);
  });

  /**
   * FENCED — `requestAsReader`'s own transaction now reads `accounts.erasedAt` FOR SHARE as its
   * FIRST statement, exactly like `applyScreenerDecision`'s (`erasure-fence.ts`'s rule for every
   * writer of account-scoped state). Before this the reader branch had no fence at all: a stale
   * page could queue a request row against an account whose erasure had already committed.
   */
  it("refuses to queue a request on an erased account — 410, no organizer_requests row", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const { accounts } = await import("@trafficflow/db");
    await db.insert(accounts).values({ id: accountId, erasedAt: new Date("2026-07-28T12:00:00Z") });

    const svc = new ScreenerService({});
    await expect(svc.decide(ctx, id, { decision: "yes" })).rejects.toMatchObject({
      code: "account_erased", httpStatus: 410,
    });

    const rows = await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId));
    expect(rows).toEqual([]);
  });
});

describe("ScreenerService.list — the exclusion and pendingDecisions[]", () => {
  it("a sender with a pending decision leaves the queue immediately and appears in pendingDecisions", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    await seedMessage(db, accountId, mailboxId, { from: "decided@example.com" });
    await seedMessage(db, accountId, mailboxId, { from: "untouched@example.com" });
    const svc = new ScreenerService({});

    const before = await svc.list(ctx, {});
    expect(before.items.map((i) => i.sender.address).sort()).toEqual(["decided@example.com", "untouched@example.com"]);
    expect(before.pendingDecisions).toEqual([]);

    const decidedId = before.items.find((i) => i.sender.address === "decided@example.com")!.messageId;
    await svc.decide(ctx, decidedId, { decision: "yes" });

    const after = await svc.list(ctx, {});
    expect(after.items.map((i) => i.sender.address)).toEqual(["untouched@example.com"]);
    expect(after.pendingDecisions).toHaveLength(1);
    expect(after.pendingDecisions[0]).toMatchObject({
      subject: "decided@example.com", scope: "sender", sent: false,
    });
  });

  it("a domain-scope pending decision excludes every held sender at that domain from the queue", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    const a = await seedMessage(db, accountId, mailboxId, { from: "a@corp.example" });
    await seedMessage(db, accountId, mailboxId, { from: "b@corp.example" });
    await seedMessage(db, accountId, mailboxId, { from: "c@other.example" });
    const svc = new ScreenerService({});
    await svc.decide(ctx, a, { decision: "no", scope: "domain" });

    const after = await svc.list(ctx, {});
    expect(after.items.map((i) => i.sender.address)).toEqual(["c@other.example"]);
    // `toEqual` and not `toMatchObject`, deliberately: the whole SHAPE is the wire contract, so a
    // field appearing or vanishing here has to be a decision somebody made rather than something
    // a client discovers. `sent` is kept beside `state` for exactly that reason — it is what the
    // clients written against the first cut of this DTO read.
    expect(after.pendingDecisions).toEqual([{
      subject: "corp.example", scope: "domain", decidedAt: after.pendingDecisions[0]!.decidedAt,
      sent: false, state: "pending", refusedReason: null,
    }]);
  });

  it("an account-wide decision (one request PER MAILBOX, 0.20) is still ONE pendingDecisions entry", async () => {
    // Two reader mailboxes, both held by a capable install, the same sender held in both: the
    // decide queues one request per mailbox, and the list must merge them — one subject, one
    // entry, `pending` while any request is still travelling. Mutation watched red: map the
    // outstanding rows 1:1 again and this reads two entries for one sender.
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    const [mb2] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "second@example.test",
      organizerRole: "reader", organizerState: "held",
      organizedByCapabilities: "requests", organizedByKind: "cloud", organizedByName: "ohmail Cloud",
    }).returning();
    const id = await seedMessage(db, accountId, mailboxId, { from: "both@example.com" });
    await seedMessage(db, accountId, mb2!.id, { from: "both@example.com" });
    const svc = new ScreenerService({});

    const res = await svc.decide(ctx, id, { decision: "yes" }) as ScreenRequestResult;
    expect(res.mailboxes?.requested.map((r) => r.mailboxId).sort())
      .toEqual([mailboxId, mb2!.id].sort());
    const rows = await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId));
    expect(rows).toHaveLength(2);

    const after = await svc.list(ctx, {});
    expect(after.items).toEqual([]);
    expect(after.pendingDecisions).toEqual([{
      subject: "both@example.com", scope: "sender", decidedAt: after.pendingDecisions[0]!.decidedAt,
      sent: false, state: "pending", refusedReason: null,
    }]);
  });

  it("is invisible on a DIFFERENT install's own database — organizer_requests is per-install bookkeeping", async () => {
    // Simulate a second door by reading through a fresh ctx over the same account/mailbox but a
    // db with no organizer_requests row for it: `makeCtx` always starts empty, so a second
    // `list()` call against an account that never went through THIS process's `decide()` sees no
    // exclusion at all — which is the direct proof of the per-install claim.
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const svc = new ScreenerService({});
    const page = await svc.list(ctx, {});
    expect(page.items).toHaveLength(1);
    expect(page.pendingDecisions).toEqual([]);
    void mailboxId;
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE ORGANIZER'S OWN WRITE IS NEVER GATED ON A CAPABILITY HEADER
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `capable` answers a question a READER asks about the install that HOLDS its mailbox: will that
 * holder take a decision from somewhere else. It says nothing about whether THIS install may write
 * to a mailbox it organizes itself, and it must never be read that way — an organizer's own press
 * is the highest-traffic decide in the product and the standalone desktop's entire Screener.
 *
 * A mailbox carrying the column defaults — `organizer_role = 'organizer'`, and NULL
 * `organized_by_capabilities`, which is what every mailbox has until some cycle peeks a claim into
 * it — is exactly the row where a capability-shaped gate would bite. It decides directly.
 */
describe("ScreenerService.decide — the ORGANIZER branch, on a default row", () => {
  it("a default-role organizer with NULL capabilities writes directly: a rule, and the mail re-routed", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    // The defaults, restated rather than assumed — if a migration ever changes them this fails
    // here and names the reason, instead of silently testing a different row than it claims to.
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row?.organizerRole).toBe("organizer");
    expect(row?.organizedByCapabilities).toBeNull();

    const id = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const out = await new ScreenerService({}).decide(ctx, id, { decision: "yes" });

    // A DIRECT write, not a queued request.
    expect("pending" in out).toBe(false);
    const { rules, folderState } = await import("@trafficflow/db");
    const made = await db.select().from(rules).where(eq(rules.accountId, accountId));
    expect(made).toHaveLength(1);
    expect(made[0]?.match).toBe("person@example.com");
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
    expect(fs?.desiredFolder).toBe("INBOX");
    expect(await db.select().from(organizerRequests).where(eq(organizerRequests.accountId, accountId))).toEqual([]);
  });

  /**
   * THE WHOLE BAG FOR THAT SENDER MOVES, ACCOUNT-WIDE (0.20 — a decision is about the SENDER):
   * every held message in every mailbox this install ORGANIZES. The boundary that stays is the
   * one-organizer rule: a mailbox this install only READS keeps its rows, exactly where they
   * were. Until the 0.20 ruling this case pinned the opposite — the re-route stopped at the
   * decided mailbox — which is the mechanism behind "my decision came back".
   */
  it("re-routes the sender's bag in EVERY organized mailbox, and never in a reader's", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const a = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const b = await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });

    // The same sender, held in a SECOND ORGANIZED mailbox — moves with the decision.
    const [organized] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "second@x.example",
    }).returning({ id: mailboxes.id });
    const alsoMine = await seedMessage(db, accountId, organized!.id, { from: "person@example.com" });

    // And in a READER's mailbox with no capable holder — stays put, visibly held.
    const [foreign] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "theirs@x.example", organizerRole: "reader",
    }).returning({ id: mailboxes.id });
    const theirs = await seedMessage(db, accountId, foreign!.id, { from: "person@example.com" });

    await new ScreenerService({}).decide(ctx, a, { decision: "yes" });

    const { folderState } = await import("@trafficflow/db");
    for (const id of [a, b, alsoMine]) {
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
      expect(fs?.desiredFolder, "every organized mailbox's copy moves").toBe("INBOX");
    }
    const [untouched] = await db.select().from(folderState).where(eq(folderState.messageId, theirs));
    expect(untouched?.desiredFolder, "a reader mailbox's row moved — the one-organizer fence is gone")
      .toBe("ohmail/Screener");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  SUGGEST IS GATED ON WHETHER THE ADVICE COULD EVER BE ACTED ON
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A suggestion is bought so a person can act on it, and the only thing that acts on one is a
 * decision. Where no organizer will take that decision the purchase is money spent, and
 * first-contact subjects sent to a model, for advice nobody can use.
 *
 * The classifier counts its own calls, because "refused" is not the property — "refused WITHOUT
 * spending" is.
 */
describe("ScreenerService.suggest — gated on whether a decision could ever be applied", () => {
  function countingClassifier(): { calls: number } & Record<string, unknown> {
    const port = {
      calls: 0,
      async classify() {
        port.calls += 1;
        return { destination: "INBOX", confidence: 0.9, rationale: "r", spam: false };
      },
      async screen() {
        port.calls += 1;
        return { destination: "INBOX", confidence: 0.9, rationale: "r", spam: false };
      },
    };
    return port as never;
  }

  it("an OUTDATED holder refuses the purchase, and the model is never called", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx({ organizedByCapabilities: null });
    await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const classifier = countingClassifier();

    await expect(new ScreenerService({ classifier: classifier as never })
      .suggest(ctx, { senders: ["person@example.com"] }))
      .rejects.toMatchObject({ code: "organized_elsewhere", httpStatus: 409 });

    expect(classifier.calls, "the model was called for advice nobody could apply").toBe(0);
  });

  it("a STOPPED holder refuses the purchase as no_organizer, and the model is never called", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx({ organizerState: "stopped" });
    await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const classifier = countingClassifier();
    await expect(new ScreenerService({ classifier: classifier as never })
      .suggest(ctx, { senders: ["person@example.com"] }))
      .rejects.toMatchObject({ code: "organized_elsewhere", details: { reason: "no_organizer" } });
    expect(classifier.calls).toBe(0);
  });

  /**
   * NO HOLDER AT ALL must reach the `no_organizer` arm. It could not: the reason was chosen with
   * `ineligible?.by.kind === null`, which short-circuits to `undefined` when the eligibility read
   * itself returned null — and `undefined === null` is false, so the arm naming this exact case
   * was unreachable from it.
   */
  it("NO holder at all refuses with no_organizer, not organizer_outdated", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx({
      organizerState: null, organizedByCapabilities: null, organizedByKind: null, organizedByName: null,
    });
    await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const classifier = countingClassifier();

    await expect(new ScreenerService({ classifier: classifier as never })
      .suggest(ctx, { senders: ["person@example.com"] }))
      .rejects.toMatchObject({ code: "organized_elsewhere", details: { reason: "no_organizer" } });
    expect(classifier.calls).toBe(0);
  });

  /**
   * A STALE PAGE IS NOT A REFUSAL. When none of the named senders is still held — another tab
   * decided them, or the worker's own pass screened them out — there is simply nothing to buy.
   * Reading the post-filter emptiness alone turned that into a 409 naming an empty mailbox id and
   * a holder of `null`, on a request that used to succeed.
   */
  it("named senders that are no longer held answer normally — never a 409 about the organizer", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    void db; void accountId; void mailboxId;
    const classifier = countingClassifier();

    const out = await new ScreenerService({ classifier: classifier as never })
      .suggest(ctx, { senders: ["nobody-here@example.com"] });
    expect(out).toBeTruthy();
    expect(classifier.calls).toBe(0);
  });

  /** THE OPEN CASE OPENS. Without this, a gate that refused everything would look identical. */
  it("a CAPABLE holder lets the purchase through", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });
    const { accountSettings } = await import("@trafficflow/db");
    await db.insert(accountSettings).values({ accountId, autoSuggestAt: ctx.now() });
    const classifier = countingClassifier();

    const out = await new ScreenerService({ classifier: classifier as never })
      .suggest(ctx, { senders: ["person@example.com"] });
    expect(out).toBeTruthy();
    expect(classifier.calls).toBeGreaterThan(0);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE REFUSAL DESCRIBES ONE MAILBOX — its id AND its holder, from the same mailbox
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `suggest` gates per mailbox, so a set of senders can span several, and when NONE of them can
 * take a decision it has to pick one to name. It picked twice, independently: the id latched onto
 * the first ineligible mailbox, and the holder latched onto the first NON-NULL eligibility — not
 * the same mailbox whenever the first one's eligibility read came back null, because `??=` does
 * not assign over a null and `null` is a legitimate eligibility.
 *
 * The result was a sentence about a mailbox that does not exist: one mailbox's id beside another
 * mailbox's holder, with the choice between "nobody is organizing this" and "that install is too
 * old to apply it" made from the second while pointing at the first. The person is told to go and
 * update an install that has nothing to do with the mailbox named.
 */
describe("ScreenerService.suggest — the refusal describes ONE mailbox", () => {
  /**
   * A classifier that would answer if it were ever asked. The gate runs before any model call, so
   * every case here refuses without spending one — but `suggest` refuses a deployment with NO
   * classifier at all one step earlier, which would make these pass for the wrong reason.
   */
  function silentClassifier(): { calls: number } & Record<string, unknown> {
    const port = {
      calls: 0,
      async classify() {
        port.calls += 1;
        return { destination: "INBOX", confidence: 0.9, rationale: "r", spam: false };
      },
      async screen() {
        port.calls += 1;
        return { destination: "INBOX", confidence: 0.9, rationale: "r", spam: false };
      },
    };
    return port as never;
  }

  /**
   * A mailbox whose eligibility read comes back NULL. `readRequestEligibility` scopes its read by
   * account, so a mailbox row this account does not own answers "no such mailbox" — while the held
   * message, scoped by `messages.account_id`, is still in the set. That is the one shape that
   * produces a null eligibility, and it is the shape the two latches diverge on.
   */
  /* A mailbox of THIS account carrying no organizer facts at all — no role, no holder, no reason.
     It used to be a mailbox of ANOTHER account with this account's messages seeded into it, which
     mail 0118's `messages_mailbox_id_account_fk` now refuses and which was never the property
     under test: what the case needs is an ineligible mailbox with nothing to name, and that is
     representable in the account's own world. */
  async function mailboxWithNoEligibility(
    db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string,
  ): Promise<string> {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${randomUUID()}@x.example`,
      // A READER nobody is known to hold: ineligible, and with no holder and no reason to name.
      organizerRole: "reader", organizerState: null,
    }).returning({ id: mailboxes.id });
    return mb!.id;
  }

  /**
   * MUTATION WATCHED RED: split the capture back into two independent `??=`
   * (`ineligibleMailboxId ??= row.mailboxId; ineligible ??= e;`) and this reports
   * `organizer_outdated` carrying the SECOND mailbox's holder while naming the FIRST mailbox's id.
   */
  it("takes the id and the holder from the SAME mailbox when the first has no eligibility at all", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx();
    // The SECOND mailbox in the set — held, a reader, and its holder advertises no requests, so it
    // is ineligible WITH a perfectly good holder to name. That holder is the wrong answer here.
    await db.update(mailboxes).set({
      organizerRole: "reader", organizerState: "held", organizedByCapabilities: null,
      organizedByKind: "cloud", organizedByName: "ohmail Cloud",
    }).where(eq(mailboxes.id, mailboxId));

    const foreign = await mailboxWithNoEligibility(db, accountId);

    // `heldRows` orders by date descending, so the newer message decides which mailbox the loop
    // meets first.
    await seedMessage(db, accountId, foreign, {
      from: "first@example.com", date: new Date("2026-07-28T11:00:00Z"),
    });
    await seedMessage(db, accountId, mailboxId, {
      from: "second@example.com", date: new Date("2026-07-28T09:00:00Z"),
    });

    const err = await new ScreenerService({ classifier: silentClassifier() as never })
      .suggest(ctx, { senders: ["first@example.com", "second@example.com"] })
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const refusal = err as { mailboxId: string; details: { by: { kind: string | null }; reason?: string } };
    // The mailbox it NAMES is the first ineligible one…
    expect(refusal.mailboxId).toBe(foreign);
    // …and the holder and the reason come from THAT mailbox, which has neither — never from the
    // second mailbox's live "ohmail Cloud" holder.
    expect(refusal.details.by.kind).toBeNull();
    expect(refusal.details.reason).toBe("no_organizer");
  });

  /**
   * And the ordinary case is unchanged: one ineligible mailbox with a holder is described by its
   * own holder, which is the sentence the person can actually act on.
   */
  it("names the holder when the first ineligible mailbox has one", async () => {
    const { db, accountId, mailboxId, ctx } = await makeReaderCtx({ organizedByCapabilities: null });
    await seedMessage(db, accountId, mailboxId, { from: "person@example.com" });

    const err = await new ScreenerService({ classifier: silentClassifier() as never })
      .suggest(ctx, { senders: ["person@example.com"] })
      .then(() => null, (e: unknown) => e);

    const refusal = err as { mailboxId: string; details: { by: { kind: string | null }; reason?: string } };
    expect(refusal.mailboxId).toBe(mailboxId);
    expect(refusal.details.by.kind).toBe("cloud");
    expect(refusal.details.reason).toBe("organizer_outdated");
  });
});
