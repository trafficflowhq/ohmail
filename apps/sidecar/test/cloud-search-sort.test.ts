import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, folderState, messageBodies } from "@trafficflow/db";
import { reindexMessageSearch } from "@trafficflow/core/mail";
import { SEARCH_PARTS, SEARCH_SORTS, type ServiceContext } from "@trafficflow/services/mail";
import { matchReadRoute } from "../src/cloud-read.js";

/**
 * ON THE SECOND DOOR — the Cloud-mode local read surface takes `?sort=` too.
 *
 * ── WHY THIS FILE HAS TO EXIST AT ALL ─────────────────────────────────────────────────────
 *
 * There are TWO `/search` handlers in this repository and they cannot share code. `cloud-read.ts`
 * is a hand-curated read table precisely because mounting `packages/api`'s routes would drag the
 * IMAP admission port into the Cloud engine's import graph and turn `cloud-engine-census.test.ts`
 * red. So the two doors are held together by SHAPE, and nothing but a test can hold them there.
 *
 * The failure this guards is quiet in the worst way: the hosted client would sort and the desktop
 * would not, for the same query, with the same control on screen. Nobody would see a crash — they
 * would see a list that ignores them, on one platform, and file it as "sorting is broken" with no
 * way to say which half.
 *
 * Driven through `matchReadRoute` rather than a whole sidecar: this is a claim about the ROUTE's
 * parameter handling, and `cloud-local-surface.test.ts` already proves the same table answers from
 * the mirror without forwarding.
 */

const ACCOUNT = randomUUID();
const NOW = new Date("2026-07-28T12:00:00.000Z");

/** Resolve and invoke the read table's `/search`, exactly as the stdio host does. */
async function search(ctx: ServiceContext, query: string): Promise<Response> {
  const url = `http://sidecar/search?${query}`;
  const hit = matchReadRoute("GET", new URL(url).pathname);
  if (!hit) throw new Error("no /search route in READ_ROUTES");
  return hit.route.handler(new Request(url), ctx, hit.params);
}

async function idsOf(res: Response): Promise<string[]> {
  const body = (await res.json()) as { items: Array<{ id: string }> };
  return body.items.map((m) => m.id);
}

describe("the Cloud-mode read surface honours ?sort=", () => {
  const corpus = async (): Promise<{ ctx: ServiceContext; old: string; mid: string; recent: string }> => {
    const db = await makeTestDb();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: ACCOUNT, provider: "imap", address: "me@ohmail.test" })
      .returning();

    const seed = async (subject: string, date: string, from: string): Promise<string> => {
      const dedup = `mid:${randomUUID()}`;
      const [m] = await db.insert(messages).values({
        accountId: ACCOUNT, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(),
        dedupKey: dedup, subject, fromAddress: from, date: new Date(date),
        nativeLocator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6)}` },
      }).returning();
      await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "the heron stood in the shallows" });
      // As the mirror does: the letter's search document with the letter.
      await reindexMessageSearch(db as never, ACCOUNT, m!.id);
      await db.insert(folderState).values({
        messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX",
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      return m!.id;
    };

    const old = await seed("heron one", "2026-07-01T09:00:00Z", "zoe@late.example");
    const mid = await seed("heron two", "2026-07-10T09:00:00Z", "anna@early.example");
    const recent = await seed("heron three", "2026-07-20T09:00:00Z", "mike@mid.example");

    const ctx: ServiceContext = {
      db, accountId: ACCOUNT, userId: null, now: () => NOW, requestId: "r12-sidecar",
    };
    return { ctx, old, mid, recent };
  };

  it("passes the param through — the two date directions are mirror images", async () => {
    const { ctx, old, mid, recent } = await corpus();

    // THE GUARD. A door that reads `sort` and drops it returns one order for both, and both
    // assertions fail together.
    expect(await idsOf(await search(ctx, "q=heron&sort=date_desc"))).toEqual([recent, mid, old]);
    expect(await idsOf(await search(ctx, "q=heron&sort=date_asc"))).toEqual([old, mid, recent]);
  });

  it("refuses an unknown sort with the SAME 400 the hosted route gives", async () => {
    const { ctx } = await corpus();

    const res = await search(ctx, "q=heron&sort=newest");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    // Same code and same vocabulary as `packages/api/src/routes/search.ts`, so a client cannot
    // tell the two doors apart by how they refuse.
    expect(body.error.code).toBe("validation_failed");
    for (const s of SEARCH_SORTS) expect(body.error.message).toContain(s);
  });

  it("an absent sort is unchanged — relevance, and a 200", async () => {
    const { ctx } = await corpus();
    const absent = await search(ctx, "q=heron");
    const explicit = await search(ctx, "q=heron&sort=relevance");
    expect(absent.status).toBe(200);
    // Byte-identical but for `ms`, the server time each answer reports about itself.
    const same = async (r: Response) => JSON.stringify({ ...(JSON.parse(await r.text()) as object), ms: 0 });
    expect(await same(absent)).toBe(await same(explicit));
  });

  it("every declared sort is accepted here too", async () => {
    const { ctx } = await corpus();
    for (const sort of SEARCH_SORTS) {
      expect((await search(ctx, `q=heron&sort=${sort}`)).status, sort).toBe(200);
    }
  });

  it("every declared part is accepted here too, the estimate answering the summary's count", async () => {
    const { ctx } = await corpus();
    for (const parts of SEARCH_PARTS) expect((await search(ctx, `q=heron&parts=${parts}`)).status, parts).toBe(200);
    const estimate = (await (await search(ctx, "q=heron&parts=estimate")).json()) as { total: number; totalExact: boolean };
    expect(estimate).toMatchObject({ total: 3, totalExact: true });
    expect((await search(ctx, "q=heron&parts=guess")).status).toBe(400);
  });
});
