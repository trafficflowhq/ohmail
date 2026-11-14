import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messageBodies, messages, rules } from "@trafficflow/db";
import { makeDrizzleRepo } from "../src/adapters/drizzle-repo.js";

/**
 * ═══ A NARROWED RULE RULES ON ITS OWN TERM AND NOTHING ELSE — `listScreenerBacklog`'s copy ═══
 *
 * at the site the ledger row did not name. The Screener
 * backlog query excludes a sender the user has ruled on, and it matched on `kind`/`match` alone.
 * That was right while a sender rule meant *all mail from this sender*; `subject_contains` and
 * `body_contains` (mail 0050, 0052) made a rule a CONJUNCTION — *from this address AND with this
 * term* — and their column comments state the invariant that a present term "can only make a rule
 * fire LESS often than it did". So one narrow rule about `invoice` removed every OTHER message
 * from that sender from the backlog, which is a rule changing an outcome for mail it does not
 * match.
 *
 * ── WHY THIS FILE EXISTS AT ALL, STATED PLAINLY ─────────────────────────────────────────────
 *
 * `listScreenerBacklog` HAS NO PRODUCTION CALLER. Its one caller was the connect-time Screener
 * re-route, retired by the ruling `apps/worker/test/kickstart-retired.test.ts` records. The
 * predicate was corrected anyway — a wrong statement on a live interface is a trap for its next
 * caller — and correcting an uncalled method with no guard is how a fix becomes decorative, which
 * is the failure mode this repository has already paid for once (a test list pointing at a file
 * that was never added, green for its whole life). So the correction is exercised here, directly
 * against the repo, and the file says out loud that it is guarding a seam and not a live path.
 *
 * PGlite is the right engine: the claim is one SQL predicate over committed rows, with no
 * concurrency, no `FOR UPDATE` contention and no planner-dependent behaviour in it.
 *
 * ── MUTATIONS WATCHED (2026-09-01, each restored) ───────────────────────────────────────────
 *
 *  · drop `r.subject_contains is null` from the predicate
 *      ⇒ "a narrowed sender rule" RED — the backlog comes back empty (0 rows, expected 1).
 *  · drop `r.body_contains is null`
 *      ⇒ "a narrowed DOMAIN rule" RED, same shape.
 *  · drop both (the pre-fix predicate)
 *      ⇒ both RED; "a bare rule still excludes the whole sender" stays green, which is what makes
 *        the pair a real discrimination rather than a predicate that stopped filtering.
 */

const SCREENER = "ohmail/Screener";

describe("listScreenerBacklog — the user's rule is as wide as its own terms", () => {
  async function world() {
    const db = await makeTestDb();
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `bl-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    const repo = makeDrizzleRepo(db as never);
    return { db, accountId, mailboxId: mb!.id, repo };
  }

  async function held(
    w: Awaited<ReturnType<typeof world>>, from: string, subject = "hello",
  ): Promise<string> {
    const [m] = await w.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
      dedupKey: `bl:${randomUUID()}`, subject, fromAddress: from,
      nativeLocator: { folder: SCREENER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await w.db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {},
    });
    await w.db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  it("a narrowed sender rule leaves that sender's OTHER mail in the backlog", async () => {
    const w = await world();
    const id = await held(w, "billing@stranger.test", "Your verification code");
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "billing@stranger.test",
      destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
      subjectContains: "invoice",
    });

    const backlog = await w.repo.listScreenerBacklog(w.mailboxId, { limit: 10 });

    // Before the fix this was empty: one narrow rule spoke for every message from the address.
    // Whether the rule fires for a message is `evaluateRules`' question, and it can only ask it
    // about rows this query hands it.
    expect(backlog.map((r) => r.messageId)).toEqual([id]);
  });

  it("a narrowed DOMAIN rule behaves the same — the second arm of the predicate", async () => {
    const w = await world();
    const id = await held(w, "anyone@narrow.test");
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "domain", match: "narrow.test",
      destination: "ohmail/News", priority: 0, provenance: "manual", enabled: true,
      bodyContains: "receipt",
    });

    const backlog = await w.repo.listScreenerBacklog(w.mailboxId, { limit: 10 });

    expect(backlog.map((r) => r.messageId)).toEqual([id]);
  });

  it("a BARE rule still speaks for the whole sender, in SQL", async () => {
    // The other half. Without this the fix would be indistinguishable from a predicate that
    // stopped excluding anything, and the user's actual screener decisions would be re-litigated.
    const w = await world();
    await held(w, "bare@stranger.test");
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "bare@stranger.test",
      destination: "ohmail/Screened", priority: 0, provenance: "promoted", enabled: true,
    });

    expect(await w.repo.listScreenerBacklog(w.mailboxId, { limit: 10 })).toEqual([]);
  });

  it("a DISABLED narrowed rule excludes nothing either — `enabled` still leads", async () => {
    const w = await world();
    const id = await held(w, "off@stranger.test");
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "off@stranger.test",
      destination: "ohmail/News", priority: 0, provenance: "manual", enabled: false,
      subjectContains: "invoice",
    });

    expect((await w.repo.listScreenerBacklog(w.mailboxId, { limit: 10 })).map((r) => r.messageId))
      .toEqual([id]);
  });
});
