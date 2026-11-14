import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, changeLog, folderState, mailboxes, messageBodies, messages,
  rules,
  accountPass, requestPass,
} from "@trafficflow/db";
import { ohboxTidyPass } from "../src/ohbox-tidy.js";
import type { Tx } from "@trafficflow/db";

/**
 * THE KNOWLEDGE A TIDY DECIDES AGAINST IS RE-ASKED PER PAGE.
 *
 * ── THE DEFECT, AND THE COMMENT THAT KEPT IT ────────────────────────────────────────────────
 *
 * `ohbox-tidy.ts` and `rule-retro.ts` re-read their own DECISION per page (the settings row and the
 * owned rule row, both `FOR UPDATE`) and were correct about it. What they did NOT re-read was the
 * KNOWLEDGE the decision is computed from — `listRules` and `knownSenders`, hoisted above the page
 * loop and held for the whole run behind this comment:
 *
 *     Rules, contacts and the account's own addresses — read ONCE. This pass is the only writer of
 *     the state it decides against, so a per-page re-read would cost queries to observe a change
 *     that cannot happen …
 *
 * **It can happen and there are six writers.** `rules` is written by the API's rule editor
 * (`routes/rules.ts`); the `contacts` set behind `knownSenders` by the Screener's decide path
 * (`screener-service.ts`), the Junk window (`junk-window.ts`), the profile import, the consent seed,
 * and the ingest pipeline's own contact learning. So a user who screened somebody IN, or deleted a
 * rule, during a long walk had every later page decided under the world as it stood when the run
 * began — and the comment is why nobody looked. Half-fresh decisions are the hardest kind to see,
 * because the half that IS fresh is the half a reader checks.
 *
 * ── WHY THIS IS PGlite AND NOT A `.pg.test.ts` ──────────────────────────────────────────────
 *
 * There is no concurrency claim here. The transactional claims of these passes — `FOR UPDATE`, the
 * two-driver cursor serialization, the user-move race — genuinely need real Postgres and live in
 * `ohbox-tidy.pg.test.ts`, which says so. What this file asserts is a READ ORDER inside one
 * single-threaded pass: that page 2 asks the database again rather than consulting a variable page 1
 * closed over. An embedded database answers that exactly.
 *
 * The world is changed BETWEEN pages through a `transaction` seam on the handle the pass is given,
 * which is a test-side wrapper and adds nothing to production code. That is deliberate: a pass that
 * had to grow a callback to be testable would be a pass whose seam existed for the test.
 */

/** The db the pass is handed, with a hook that fires before each page transaction opens. */
function pagedDb(real: Tx, onBeforePage: (page: number) => Promise<void>): Tx {
  let page = 0;
  return new Proxy(real as object, {
    get(target, prop, receiver): unknown {
      if (prop === "transaction") {
        return async (fn: unknown): Promise<unknown> => {
          await onBeforePage(page++);
          return (target as { transaction: (f: unknown) => Promise<unknown> }).transaction(fn);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as Tx;
}

const OHBOX = "INBOX";
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
const NOW = new Date("2026-09-01T12:00:00Z");

describe("ohbox-tidy re-asks who is known at every page", () => {
  let db: Awaited<ReturnType<typeof makeTestDb>>;

  beforeAll(async () => {
    db = await makeTestDb();
  });

  async function world(): Promise<{ accountId: string; mailboxId: string }> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `tk-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    }).returning();
    await db.insert(accountSettings).values({ accountId, ohboxPolicy: "people_only" });
    await requestPass(db, accountPass("ohbox_tidy", accountId), new Date("2026-09-01T11:00:00Z"));
    return { accountId, mailboxId: mb!.id };
  }

  /**
   * The demotable shape: obvious bulk from an INFERRED admission.
   *
   * A `seeded-from-sent` allow rule is what the legacy migration wrote for anyone the user had ever
   * sent to, and `people_only` is the posture that says "that was a guess". Bulk headers are what
   * make the engine act on the guess rather than leave the mail for the human. A rule the USER
   * authored (`manual`) is exempt from the posture — writing one is how somebody says "keep this in
   * my Ohbox" — and that exemption is the lever below.
   */
  async function inferredAdmission(
    w: { accountId: string; mailboxId: string }, from: string,
  ): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `tk:${randomUUID()}`,
      subject: "hello there", fromAddress: from,
      nativeLocator: { folder: OHBOX, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, accountId: m!.accountId, text: "", html: null,
      // A List-Unsubscribe is the header class the posture acts on.
      headers: { "list-unsubscribe": ["<https://x.test/u>"] },
    });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: OHBOX, observedFolder: OHBOX,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: from, destination: OHBOX, priority: 0,
      provenance: "seeded-from-sent", enabled: true,
    });
    return m!.id;
  }

  const movedIds = async (accountId: string): Promise<string[]> => {
    const rows = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, accountId), eq(changeLog.op, "move")));
    return rows.map((r) => r.entityId);
  };

  it("the CONTROL: with the rule set unchanged, every inferred admission is tidied out", async () => {
    const w = await world();
    const ids = [];
    for (const who of ["a", "b", "c"]) ids.push(await inferredAdmission(w, `${who}@stranger.test`));

    const res = await ohboxTidyPass(db as unknown as Tx, {
      accountId: w.accountId, trustedAuthservIdsFor: NONE, batch: 1,
    }, NOW);

    // THE GUARD THAT MAKES THE NEXT TEST MEAN ANYTHING. Without it, a pass that moved nothing at all
    // — a broken fixture, a posture that never engaged, a header class that stopped matching — would
    // satisfy "the later two stayed" and the freshness claim would be vacuously green.
    expect(res.ran).toBe(true);
    expect(res.moved).toBe(3);
    expect((await movedIds(w.accountId)).sort()).toEqual([...ids].sort());
  });

  it("a rule the user writes DURING the walk is honoured by the very next page", async () => {
    const w = await world();
    const froms = ["d@stranger.test", "e@stranger.test", "f@stranger.test"];
    for (const from of froms) await inferredAdmission(w, from);

    // One message per page. After the FIRST page commits, the user takes ownership of these
    // admissions — the API's rule editor writing `rules`, which is one of the six writers the old
    // comment said did not exist. A `manual` rule is the documented "keep this in my Ohbox", and the
    // posture is exempt from it.
    let authored = false;
    const handle = pagedDb(db as unknown as Tx, async (page) => {
      if (page === 0 || authored) return;
      authored = true;
      await db.update(rules).set({ provenance: "manual" })
        .where(eq(rules.accountId, w.accountId));
    });

    const res = await ohboxTidyPass(handle, {
      accountId: w.accountId, trustedAuthservIdsFor: NONE, batch: 1,
    }, NOW);

    expect(res.ran).toBe(true);
    expect(authored).toBe(true);
    // EXACTLY ONE moved: the page that ran before the user wrote the rule. Under the cached read all
    // three moved, because `listRules` had been captured before the pass began — mail filed out of
    // somebody's Ohbox under a rule set they had already changed, which is
    // in one sentence.
    expect(res.moved).toBe(1);
    expect(await movedIds(w.accountId)).toHaveLength(1);
  });
});
