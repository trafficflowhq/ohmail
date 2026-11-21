import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { folderState, mailboxes, messageBodies, bindDb } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  dbFor, makeUnsubscribeService, type HostResolver, type OneClickPost,
} from "../src/index.js";
import { personScreenedOut, seedMessage } from "./helpers.js";

/**
 * THE DRAIN'S CANDIDATE PREDICATE, ASKED ON BOTH STORES.
 *
 * The chunk's eligibility expression spelled `jsonb_exists` twice, so on the device store the
 * pass threw `no such function: jsonb_exists` at its first statement and the standalone phone ran
 * NO unsubscribe pass at all — a false state, since the phone says it handles unsubscribes. The
 * predicate now goes through the seam's `jsonHasAny`, and the flag it produces is read as a
 * VERDICT WORD rather than a driver boolean: this store answers an integer where the server
 * answers `true`, and `=== true` over it is a pass that reads every candidate and acts on none.
 *
 * ── WATCHED FAIL ──────────────────────────────────────────────────────────────────────────
 * With the two `jsonb_exists(…)` calls restored, the device run answers `no such function:
 * jsonb_exists` on both cases while the server run stays green.
 */
const PUBLIC_DNS: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
/**
 * The position a Gmail-held mailbox trusts (`providerAuthservIds`), and that provider confirming a
 * row's sender, which the seed writes: the drain asks a list only for a confirmed sender.
 */
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);
const CONFIRMED = { "authentication-results": ["mx.google.com; dmarc=pass"] };

const ONE_CLICK = {
  "list-unsubscribe": ["<https://sender.example/u?t=abc>"],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
};
/** A route with no `-Post`: the predicate asks for BOTH keys, so this one is not a candidate. */
const NO_POST = { "list-unsubscribe": ["<https://sender.example/u?t=abc>"] };

const NOW = new Date("2026-07-28T12:00:00Z");
type Db = Awaited<ReturnType<typeof makeTestDb>>;

function spy(): OneClickPost & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async post(url: string) { calls.push(url); return { status: 200 }; } };
}

async function seedScreenedOut(headers: Record<string, string[]>): Promise<{
  db: Db; post: ReturnType<typeof spy>; accountId: string; messageId: string;
}> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "mila@lichtgrat.example" }).returning();
  const messageId = await seedMessage(db, accountId, mb!.id, {
    from: "news@sender.example", folder: "ohmail/Screened",
  });
  await db.insert(messageBodies).values({ messageId, accountId, text: "", headers: { ...CONFIRMED, ...headers } });
  await personScreenedOut(db, accountId, "news@sender.example");
  await db.update(folderState)
    .set({ updatedAt: new Date(NOW.getTime() - 60_000) })
    .where(eq(folderState.messageId, messageId));
  return { db, post: spy(), accountId, messageId };
}

const drain = (db: Db, post: OneClickPost) =>
  makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL })
    .drainScreenedOut(bindDb(db, { account: null }), { now: () => NOW, requestId: "d1" });

describe("the unsubscribe drain reads its candidates the same way on both stores", () => {
  it("a confirmed press posts the one message that publishes a route", async () => {
    const { db, post, accountId, messageId } = await seedScreenedOut(ONE_CLICK);
    const tick = await drain(db, post);
    expect(tick.sweep.considered).toBe(0);
    expect(tick.remaining).toBe(0);
    expect(post.calls).toEqual([]);
    const service = makeUnsubscribeService({ post, resolver: PUBLIC_DNS, trustedAuthservIdsFor: async () => GMAIL });
    const ctx = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "press" };
    const run = await service.onScreenOut(ctx, [messageId]);
    expect(run.considered, "the confirmed message is looked at").toBe(1);
    expect(run.posted, "and left").toBe(1);
    expect(post.calls, "one request, to the route the headers published").toHaveLength(1);
    expect(run.remaining).toBe(0);
  });

  it("does not take a message whose headers publish no one-click post", async () => {
    const { db, post } = await seedScreenedOut(NO_POST);
    const run = await drain(db, post);
    expect(run.sweep.considered, "the predicate asks for BOTH keys").toBe(0);
    expect(post.calls, "and nothing is announced on this address").toHaveLength(0);
    expect(run.remaining, "…and it is not owed either").toBe(0);
  });
});
