import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { rules, contacts, folderState, graduations, learningSignals } from "@trafficflow/db";
import type { ClassifierPort, ClassifierResult } from "@trafficflow/core";
import { messageBodies } from "@trafficflow/db";
import {
  ScreenerService, makeUnsubscribeService, UNSUB_SYNC_MAX, type HostResolver,
} from "../src/index.js";
import { makeCtx, seedMessage, FakeAdapter, changesFor } from "./helpers.js";

function classifierReturning(result: ClassifierResult): ClassifierPort {
  return { async classify() { return result; } };
}
const YES: ClassifierResult = { destination: "INBOX", confidence: 0.92, rationale: "looks like a real person", spam: false };
const NO: ClassifierResult = { destination: "ohmail/Screened", confidence: 0.8, rationale: "bulk sender", spam: false };

describe("ScreenerService — first-contact queue (derived) + decide", () => {
  it("lists one entry per held sender, and buying a suggestion puts it on the row", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await seedMessage(db, accountId, mailboxId, { from: "alice@ex.example", subject: "hi", date: new Date("2026-07-28T08:00:00Z") });
    await seedMessage(db, accountId, mailboxId, { from: "alice@ex.example", subject: "again", date: new Date("2026-07-28T09:00:00Z") }); // same sender → deduped
    await seedMessage(db, accountId, mailboxId, { from: "bob@ex.example", subject: "yo" });
    // Not in the screener (already in INBOX) → excluded.
    await seedMessage(db, accountId, mailboxId, { from: "known@ex.example", folder: "INBOX", desired: "INBOX" });

    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: classifierReturning(YES) });
    const page = await svc.list(ctx, {});
    expect(page.items).toHaveLength(2);                       // one per distinct held sender
    const alice = page.items.find((i) => i.sender.address === "alice@ex.example")!;
    expect(alice.subject).toBe("again");                      // latest message represents the sender
    // the LIST does not generate. A wired classifier changes nothing here.
    expect(alice.aiSuggestion).toBeNull();

    await svc.suggest(ctx, { senders: ["alice@ex.example"] });
    const after = await svc.list(ctx, {});
    expect(after.items.find((i) => i.sender.address === "alice@ex.example")!.aiSuggestion)
      .toEqual({
        decision: "yes", destination: "INBOX", spam: false,
        confidence: 0.92, rationale: "looks like a real person",
      });
    // …and bob, whom nobody asked about, still has none.
    expect(after.items.find((i) => i.sender.address === "bob@ex.example")!.aiSuggestion).toBeNull();
  });

  /**
   * The queue's ORDER, and the cursor that has to agree with it.
   *
   * `list` used to sort by `messages.id` — `gen_random_uuid()`, i.e. random — so the consent
   * queue was presented in an order uncorrelated with time and paged through that same random
   * order. Dates are chosen here so that date order and id order CANNOT coincide: the seeded
   * ids are random, and the assertion is on the dates, so a re-introduced id sort fails with
   * probability 1 - 1/5! rather than by luck.
   */
  it("lists held senders newest-first, and pages in that same order", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const days = ["2023-03-28", "2026-06-25", "2024-05-09", "2025-01-23", "2022-11-23"];
    for (const [i, d] of days.entries()) {
      await seedMessage(db, accountId, mailboxId, {
        from: `s${i}@ex.example`, subject: d, date: new Date(`${d}${"T"}10:00:00Z`),
      });
    }
    const svc = new ScreenerService({ adapter: new FakeAdapter() });

    const all = await svc.list(ctx, {});
    expect(all.items.map((i) => i.subject))
      .toEqual(["2026-06-25", "2025-01-23", "2024-05-09", "2023-03-28", "2022-11-23"]);

    // The cursor resumes exactly after the page, under the same order — no repeat, no skip.
    const p1 = await svc.list(ctx, { limit: 2 });
    expect(p1.items.map((i) => i.subject)).toEqual(["2026-06-25", "2025-01-23"]);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await svc.list(ctx, { limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((i) => i.subject)).toEqual(["2024-05-09", "2023-03-28"]);
    const p3 = await svc.list(ctx, { limit: 2, cursor: p2.nextCursor! });
    expect(p3.items.map((i) => i.subject)).toEqual(["2022-11-23"]);
    expect(p3.nextCursor).toBeNull();
  });

  /**
   * `decide` re-routes the sender's WHOLE bag, and the bag is keyed case-insensitively.
   *
   * `decide` used to read every held row in the account and filter in JS on
   * `fromAddress.toLowerCase()`; it now asks the database for one sender. The predicate has to
   * carry the same case-folding across that move, or a sender who varies capitalisation between
   * messages gets a promoted "allow" rule while half their mail stays stuck at the gate.
   * Drop the `lower()` from `heldRowsForSender` and this fails on the stranded row.
   */
  it("decide re-routes the sender's held mail regardless of address capitalisation", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const lower = await seedMessage(db, accountId, mailboxId, { from: "casey@ex.example", subject: "one" });
    const upper = await seedMessage(db, accountId, mailboxId, { from: "Casey@Ex.example", subject: "two" });

    const svc = new ScreenerService({ adapter: new FakeAdapter() });
    await svc.decide(ctx, lower, { decision: "yes" });

    for (const id of [lower, upper]) {
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
      expect(fs!.desiredFolder).toBe("INBOX");
    }
  });

  it("decide on a message that is NOT held is a 404, not a second decision", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    // Already through the gate — nothing is holding it, so there is nothing to consent to.
    const id = await seedMessage(db, accountId, mailboxId, { from: "known@ex.example", folder: "INBOX", desired: "INBOX" });
    const svc = new ScreenerService({ adapter: new FakeAdapter() });
    await expect(svc.decide(ctx, id, { decision: "yes" })).rejects.toThrow(/screener item not found/);
  });

  it("aiSuggestion is null when nothing has been bought for the row", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await seedMessage(db, accountId, mailboxId, { from: "alice@ex.example" });
    const svc = new ScreenerService({ adapter: new FakeAdapter() });
    const page = await svc.list(ctx, {});
    expect(page.items[0].aiSuggestion).toBeNull();
    // …and it is still offered for sale — the price is the dry run's, never the page's.
    //
    // AN EXACT-SHAPE ASSERTION, kept exact: `recommendedPerRequest` joined because the client now
    // reads its request size off the wire rather than hardcoding one, and a server that stops
    // publishing it silently sends every client back to the conservative fallback. Both numbers are
    // asserted as literals rather than against the constants that produce them — this is the
    // published CONTRACT, and a test that imports the value it is checking cannot notice it moving.
    expect(page.suggestable).toEqual({
      senders: ["alice@ex.example"], maxPerRequest: 50, recommendedPerRequest: 20,
    });
  });

  it("decide YES → promoted rule + contact + re-routes existing Screener mail to Imbox + learning + change_log", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const m1 = await seedMessage(db, accountId, mailboxId, { from: "alice@ex.example", subject: "first" });
    const m2 = await seedMessage(db, accountId, mailboxId, { from: "alice@ex.example", subject: "second" });
    const adapter = new FakeAdapter();
    const svc = new ScreenerService({ adapter, classifier: classifierReturning(YES) });

    const rep = (await svc.list(ctx, {})).items[0];
    const res = await svc.decide(ctx, rep.id, { decision: "yes" });
    expect(res.appliedFolder).toBe("INBOX");
    expect(res.createdRuleId).not.toBeNull();

    // Promoted rule sender→INBOX.
    const ruleRows = await db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.provenance, "promoted")));
    expect(ruleRows).toHaveLength(1);
    expect(ruleRows[0]).toMatchObject({ kind: "sender", match: "alice@ex.example", destination: "INBOX", enabled: true });

    // Sender marked known.
    const contactRows = await db.select().from(contacts).where(eq(contacts.accountId, accountId));
    expect(contactRows.map((c) => c.address)).toContain("alice@ex.example");

    // BOTH of the sender's held messages re-routed to INBOX (desired) + physically moved.
    for (const id of [m1, m2]) {
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, id));
      expect(fs.desiredFolder).toBe("INBOX");
    }
    expect(adapter.moves.filter((mv) => mv.to === "INBOX")).toHaveLength(2);

    // change_log: rule create + two message moves (INBOX).
    const changes = await changesFor(db, accountId);
    expect(changes.some((c) => c.entityType === "rule" && c.op === "create")).toBe(true);
    const moves = changes.filter((c) => c.entityType === "message" && c.op === "move");
    expect(moves).toHaveLength(2);
    expect((moves[0].meta as any).to).toBe("INBOX");

    // Learning signal (deduped id) + graduation counter for sender→INBOX.
    const signals = await db.select().from(learningSignals).where(eq(learningSignals.accountId, accountId));
    expect(signals).toHaveLength(1);
    expect(signals[0].triggeringActionId).toBe(`screener:${rep.id}`);
    const [g] = await db.select().from(graduations).where(eq(graduations.accountId, accountId));
    expect(g.patternKey).toBe("sender:alice@ex.example→INBOX");
    expect(g.positives).toBe(1);
  });

  it("decide NO → promoted rule to Screened + re-routes their mail to Screened", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const m1 = await seedMessage(db, accountId, mailboxId, { from: "spam@ex.example" });
    const adapter = new FakeAdapter();
    const svc = new ScreenerService({ adapter, classifier: classifierReturning(NO) });

    // The suggestion has to be BOUGHT before the row carries one — and `decide` is
    // deliberately independent of it: a user may screen a sender the model never saw.
    await svc.suggest(ctx, { senders: ["spam@ex.example"] });
    const rep = (await svc.list(ctx, {})).items[0];
    expect(rep.aiSuggestion!.decision).toBe("no");
    const res = await svc.decide(ctx, rep.id, { decision: "no" });
    expect(res.appliedFolder).toBe("ohmail/Screened");

    const ruleRows = await db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.provenance, "promoted")));
    expect(ruleRows[0]).toMatchObject({ kind: "sender", match: "spam@ex.example", destination: "ohmail/Screened" });
    // Not marked as a known contact on a NO.
    const contactRows = await db.select().from(contacts).where(eq(contacts.accountId, accountId));
    expect(contactRows).toHaveLength(0);

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, m1));
    expect(fs.desiredFolder).toBe("ohmail/Screened");
    expect(adapter.moves).toEqual([{ from: "ohmail/Screener", to: "ohmail/Screened" }]);
  });

  it("decide with scope='domain' creates a domain-scoped promoted rule", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    await seedMessage(db, accountId, mailboxId, { from: "person@corp.example" });
    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: classifierReturning(YES) });
    const rep = (await svc.list(ctx, {})).items[0];
    await svc.decide(ctx, rep.id, { decision: "yes", scope: "domain" });
    const [rule] = await db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.provenance, "promoted")));
    expect(rule).toMatchObject({ kind: "domain", match: "corp.example", destination: "INBOX" });
  });

  /**
   * ── A DOMAIN RULE HAS TO MOVE THE DOMAIN'S MAIL ──────────────────────────────────
   *
   * The test above seeds ONE sender, so it cannot see the defect it sits next to: `decide`
   * computed the bag it re-routes with `heldRowsForSender(address)` REGARDLESS of scope. A
   * `scope: "domain"` decision therefore wrote a rule saying "everyone at corp.example is
   * allowed" and then moved exactly one address's mail, leaving every other held sender at
   * that domain stuck at a gate whose own rule already says to let them through — a state
   * nothing else in the product ever repairs, because `rules` is consulted when mail
   * ARRIVES and never retroactively.
   *
   * Two senders at the domain and one at another, so the assertion fails in BOTH directions:
   * revert `heldRowsForScope` to the address-only lookup and the domain's first sender is stranded;
   * widen it to the whole queue and the other domain's sender is moved by a decision nobody
   * made about them.
   */
  it("scope='domain' re-routes EVERY held sender at the domain — and nobody outside it", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const mine = await seedMessage(db, accountId, mailboxId, { from: "person@corp.example" });
    const sibling = await seedMessage(db, accountId, mailboxId, { from: "other@corp.example" });
    const casing = await seedMessage(db, accountId, mailboxId, { from: "Loud@Corp.example" });
    const stranger = await seedMessage(db, accountId, mailboxId, { from: "someone@elsewhere.example" });

    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: classifierReturning(NO) });
    await svc.decide(ctx, mine, { decision: "no", scope: "domain" });

    const desired = async (id: string) =>
      (await db.select().from(folderState).where(eq(folderState.messageId, id)))[0]!.desiredFolder;

    expect(await desired(mine)).toBe("ohmail/Screened");
    expect(await desired(sibling)).toBe("ohmail/Screened");
    // Case-folded on BOTH sides of the `@`, like `heldRowsForSender` already is for the address.
    expect(await desired(casing)).toBe("ohmail/Screened");
    // The blast radius stops at the domain.
    expect(await desired(stranger)).toBe("ohmail/Screener");
  });

  /**
   * The default is unchanged, and that is the half a widening is most likely to break: with no
   * `scope` the decision is about ONE address, so a sibling at the same domain stays waiting.
   */
  it("the default scope still moves one address only — a domain sibling keeps waiting", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const mine = await seedMessage(db, accountId, mailboxId, { from: "person@corp.example" });
    const sibling = await seedMessage(db, accountId, mailboxId, { from: "other@corp.example" });

    const svc = new ScreenerService({ adapter: new FakeAdapter(), classifier: classifierReturning(YES) });
    await svc.decide(ctx, mine, { decision: "yes" });

    const desired = async (id: string) =>
      (await db.select().from(folderState).where(eq(folderState.messageId, id)))[0]!.desiredFolder;
    expect(await desired(mine)).toBe("INBOX");
    expect(await desired(sibling)).toBe("ohmail/Screener");
  });

  /**
   * ── WHAT A DOMAIN REJECT HANDS TO THE UNSUBSCRIBE TRIGGER ───────────────────
   *
   * `decide` calls `unsubscribe.onScreenOut(ctx, senderMail)` after the commit on every `no`
   * (`screener-service.ts`), and production wires that dependency in
   * (`apps/api-vercel/src/deps.ts`). So widening the bag widens the set of strangers this
   * account sends a one-click unsubscribe to — from one address to every sender at the
   * domain. That is a real consequence of scope, not a UI detail, and the number the sheet
   * must state before the click is exactly this list's length.
   *
   * The assertion is on the IDS, not a count: a bag that happened to be the right size but
   * contained the wrong messages would unsubscribe from the wrong lists.
   */
  it("a domain REJECT hands the whole domain's held mail to auto-unsubscribe", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const seen: string[][] = [];
    const mine = await seedMessage(db, accountId, mailboxId, { from: "news@corp.example" });
    const sibling = await seedMessage(db, accountId, mailboxId, { from: "offers@corp.example" });
    await seedMessage(db, accountId, mailboxId, { from: "someone@elsewhere.example" });

    const svc = new ScreenerService({
      adapter: new FakeAdapter(),
      // The double answers the SHAPE production answers — a sweep, not `null`: the caller now
      // reads `considered` to say how much of the fan-out this request finished.
      unsubscribe: {
        async onScreenOut(_c, ids) { seen.push([...ids].sort()); return { considered: ids.length }; },
      },
    });
    await svc.decide(ctx, mine, { decision: "no", scope: "domain" });

    expect(seen).toEqual([[mine, sibling].sort()]);
  });

  /**
   * ── THE FAN-OUT STOPS, AND THE ANSWER SAYS SO ───────────────────
   *
   * The case above is about WHICH messages a domain reject hands over; this one is about how
   * many of them one request may actually post to. Fifty-odd targets at eight seconds each is
   * several times the invocation this runs in, so a decision would commit and the courtesy it
   * started would be cut off mid-way with nothing recording where it stopped.
   *
   * Driven through the REAL unsubscribe service rather than a double, because the ceiling lives
   * there and a double would be measuring the test's own arithmetic.
   */
  it("caps the fan-out at the request's ceiling and reports n of m", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const held: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const id = await seedMessage(db, accountId, mailboxId, { from: `list-${i}@corp.example` });
      held.push(id);
      await db.insert(messageBodies).values({
        messageId: id, text: "", headers: {
          "list-unsubscribe": [`<https://corp.example/u?t=${i}>`],
          "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
          // The mailbox's provider confirming the sender: the automatic arm's licence to ask.
          "authentication-results": ["mx.google.com; dmarc=pass"],
        },
      });
    }

    const posted: string[] = [];
    const resolver: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
    const svc = new ScreenerService({
      adapter: new FakeAdapter(),
      unsubscribe: makeUnsubscribeService({
        post: { async post(url: string) { posted.push(url); return { status: 200 }; } },
        resolver,
        // The position a Gmail-held mailbox trusts (`providerAuthservIds`).
        trustedAuthservIdsFor: async () => new Set(["mx.google.com"]),
      }),
    });

    const result = await svc.decide(ctx, held[0]!, { decision: "no", scope: "domain" });

    // `decide` answers one of two shapes and only the APPLIED one carries a fan-out at all; the
    // route narrows on the same key to choose 200 or 202. Narrowed rather than cast: a queued
    // decision reaching this case would be a different subject, not a typing inconvenience.
    if ("pending" in result) throw new Error("this decision was queued, not applied");

    // The decision itself is untouched — only the fan-out's shape moved.
    expect(result.appliedFolder).toBe("ohmail/Screened");
    expect(posted).toHaveLength(UNSUB_SYNC_MAX);
    expect(result.unsubscribed).toEqual({ done: UNSUB_SYNC_MAX, of: held.length });
  });

  /**
   * ── THE DOMAIN IS AN EXACT MATCH, BECAUSE `core/src/rules.ts` SAYS SO ─────────────────────
   *
   * `matches()` fires a `kind:'domain'` rule when `r.match.toLowerCase() === domainOf(author)`:
   * exact equality on everything after the FIRST `@`. So the mail a domain decision moves has
   * to be exactly the mail that rule will later cover, and the two ways of getting that wrong
   * both ship a promoted rule that disagrees with the move it just made.
   *
   * `mail.corp.example` is the subdomain case a `like '%@' || domain` predicate would wrongly
   * sweep in; `evil-corp.example` is the lookalike a bare `like '%' || domain` would — and that one
   * is chosen by an attacker, not by the user.
   */
  it("a domain decision matches the domain EXACTLY — not subdomains, not lookalikes", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const exact = await seedMessage(db, accountId, mailboxId, { from: "person@corp.example" });
    const sub = await seedMessage(db, accountId, mailboxId, { from: "person@mail.corp.example" });
    const lookalike = await seedMessage(db, accountId, mailboxId, { from: "person@evil-corp.example" });

    const svc = new ScreenerService({ adapter: new FakeAdapter() });
    await svc.decide(ctx, exact, { decision: "no", scope: "domain" });

    const desired = async (id: string) =>
      (await db.select().from(folderState).where(eq(folderState.messageId, id)))[0]!.desiredFolder;
    expect(await desired(exact)).toBe("ohmail/Screened");
    expect(await desired(sub)).toBe("ohmail/Screener");
    expect(await desired(lookalike)).toBe("ohmail/Screener");
  });

  /**
   * `routes/screener.ts` does `readBody<ScreenBody>(req)` — a CAST, not a check — so `scope`
   * arrives as whatever was posted. Before that change an unknown value fell through to a sender rule,
   * which was wrong but narrow; now the same word decides how much mail moves and how many
   * strangers receive an unsubscribe request, so it is refused instead of guessed.
   */
  it("an unknown scope is refused, not silently read as 'sender'", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: "person@corp.example" });
    const svc = new ScreenerService({ adapter: new FakeAdapter() });
    await expect(
      svc.decide(ctx, id, { decision: "yes", scope: "everyone" as unknown as "domain" }),
    ).rejects.toThrow(/scope must be/);

    // …and nothing was written on the way to the refusal.
    const ruleRows = await db.select().from(rules).where(eq(rules.accountId, accountId));
    expect(ruleRows).toHaveLength(0);
  });

  /**
   * An `@`-less `from_address` has no domain, and `match: ""` on a `kind:'domain'` row is not
   * an inert rule — `sensitive-rescreen.ts` and `listScreenerBacklog` compare it against
   * `split_part(…, '@', 2)`, which is also `""` for every other malformed address, so one such
   * rule would quietly claim to have ruled on all of them.
   */
  it("a sender with no domain cannot be ruled on by domain", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const id = await seedMessage(db, accountId, mailboxId, { from: "malformed-no-at-sign" });
    const svc = new ScreenerService({ adapter: new FakeAdapter() });
    await expect(svc.decide(ctx, id, { decision: "no", scope: "domain" }))
      .rejects.toThrow(/no domain to rule on/);

    // The `position('@' …) > 0` guard, from the other side: a REAL domain decision must not
    // sweep this row in either, and `substring(x from 1)` without that guard returns the whole
    // string — so a `from_address` of `corp.example` would match a decision about `corp.example`.
    const real = await seedMessage(db, accountId, mailboxId, { from: "person@corp.example" });
    const bare = await seedMessage(db, accountId, mailboxId, { from: "corp.example" });
    await svc.decide(ctx, real, { decision: "no", scope: "domain" });
    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, bare));
    expect(fs!.desiredFolder).toBe("ohmail/Screener");
    expect(id).toBeTruthy();
  });

  /** A domain ALLOW must never reach the unsubscribe trigger — it is the reject branch only. */
  it("a domain ALLOW arms nothing", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    let called = 0;
    const mine = await seedMessage(db, accountId, mailboxId, { from: "news@corp.example" });
    await seedMessage(db, accountId, mailboxId, { from: "offers@corp.example" });

    const svc = new ScreenerService({
      adapter: new FakeAdapter(),
      unsubscribe: { async onScreenOut() { called += 1; return { considered: 0 }; } },
    });
    await svc.decide(ctx, mine, { decision: "yes", scope: "domain" });
    expect(called).toBe(0);
  });
});
