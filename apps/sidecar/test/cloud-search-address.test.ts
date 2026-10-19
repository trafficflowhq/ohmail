import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, folderState } from "@trafficflow/db";
import type { ServiceContext } from "@trafficflow/services/mail";
import { matchReadRoute } from "../src/cloud-read.js";

/**
 * ═══ `?address=` ON THE SECOND DOOR, AND WHY ITS ABSENCE WOULD HAVE BEEN SILENT ═══════════
 *
 * There are TWO `/search` handlers in this repository and they cannot share code: `cloud-read.ts`
 * is a hand-curated read table precisely because mounting `packages/api`'s routes would drag the
 * IMAP admission port into the Cloud engine's import graph and turn its census red. The two doors
 * are therefore held together by SHAPE, and nothing but a test holds them there — which is what
 * `cloud-search-sort.test.ts` says one file over, for `?sort=`.
 *
 * `?address=` is the sharper case, because the cost of NOT repeating it is not a refused request.
 * An unrecognised `address` falls through to the text search with `q: ""`, and `SearchService.search`
 * answers a blank query with `emptyResult()` — a 200, `items: []`, `total: 0`. So a desktop reading
 * its mirror in Cloud mode would show an EMPTY ARCHIVE for a person it holds mail from, with no
 * error anywhere, while the browser against the hosted API showed the rows. A door that accepts a
 * parameter and ignores it is worse than one that refuses it, and this is what that looks like.
 *
 * So the cases here are: the arm ANSWERS (every direction, with rows), it is never the empty
 * result, it carries the direction on the wire, and it refuses what the hosted door refuses.
 */

const ACCOUNT = randomUUID();
const OTHER = randomUUID();
const NOW = new Date("2026-07-28T12:00:00.000Z");

/** Resolve and invoke the read table's `/search`, exactly as the stdio host does. */
async function search(ctx: ServiceContext, query: string): Promise<Response> {
  const url = `http://sidecar/search?${query}`;
  const hit = matchReadRoute("GET", new URL(url).pathname);
  if (!hit) throw new Error("no /search route in READ_ROUTES");
  return hit.route.handler(new Request(url), ctx, hit.params);
}

interface Corpus {
  ctx: ServiceContext;
  hers: string;
  hersOlder: string;
  his: string;
  theirs: string;
  toHer: string;
}

async function corpus(): Promise<Corpus> {
  const db = await makeTestDb();
  const [mb] = await db.insert(mailboxes)
    .values({ accountId: ACCOUNT, provider: "imap", address: "me@ohmail.test" })
    .returning();
  const [otherMb] = await db.insert(mailboxes)
    .values({ accountId: OTHER, provider: "imap", address: "them@ohmail.test" })
    .returning();

  const seed = async (o: {
    accountId: string; mailboxId: string; subject: string; from: string; date: string;
    to?: Array<{ name: string | null; address: string }>;
  }): Promise<string> => {
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId: o.accountId, mailboxId: o.mailboxId, messageIdHeader: dedup,
      bodyHash: randomUUID(), dedupKey: dedup, subject: o.subject, fromAddress: o.from,
      date: new Date(o.date), snippet: o.subject, unread: false, toAddresses: o.to ?? [],
      nativeLocator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };

  const hersOlder = await seed({
    accountId: ACCOUNT, mailboxId: mb!.id, subject: "First",
    from: "info@acme.test", date: "2026-07-20T09:00:00.000Z",
  });
  const hers = await seed({
    accountId: ACCOUNT, mailboxId: mb!.id, subject: "Second",
    from: "Info@ACME.test", date: "2026-07-27T09:00:00.000Z",
  });
  const his = await seed({
    accountId: ACCOUNT, mailboxId: mb!.id, subject: "Unrelated",
    from: "bob@acme.test", date: "2026-07-27T10:00:00.000Z",
  });
  const theirs = await seed({
    accountId: OTHER, mailboxId: otherMb!.id, subject: "Theirs",
    from: "info@acme.test", date: "2026-07-27T09:30:00.000Z",
  });

  const toHer = await seed({
    accountId: ACCOUNT, mailboxId: mb!.id, subject: "To her",
    from: "carol@acme.test", date: "2026-07-25T09:00:00.000Z", to: [{ name: null, address: "INFO@acme.test" }],
  });
  // Another account's mail TO the same address: never this account's answer.
  await seed({
    accountId: OTHER, mailboxId: otherMb!.id, subject: "Theirs to",
    from: "dan@acme.test", date: "2026-07-26T09:00:00.000Z", to: [{ name: null, address: "info@acme.test" }],
  });

  const ctx: ServiceContext = {
    db, accountId: ACCOUNT, userId: null, now: () => NOW, requestId: "cloud-address",
  };
  return { ctx, hers, hersOlder, his, theirs, toHer };
}

describe("the Cloud-mode read surface answers ?address=", () => {
  it("returns the from-half — never the empty result a blank `q` would produce", async () => {
    const { ctx, hers, hersOlder, his } = await corpus();
    const res = await search(ctx, "address=info%40acme.test&direction=from");
    expect(res.status).toBe(200);
    const body = await res.json();

    // THE ROWS. This is the assertion the missing arm would have failed, and it would have failed
    // it as an empty list with a 200 — the shape nobody files a bug against.
    expect(body.items.map((m: { id: string }) => m.id)).toEqual([hers, hersOlder]);
    expect(body.items.map((m: { id: string }) => m.id)).not.toContain(his);
    expect(body.total).toBe(2);
    expect(body.direction).toBe("from");

    // …and it is not the TEXT search's shape, which is what a fall-through would have returned:
    // `emptyResult()` carries `facets` and `tier` and no direction.
    expect(body.facets).toBeUndefined();
    expect(body.tier).toBeUndefined();
  });

  it("the fall-through it replaces really does answer empty — the premise, measured", async () => {
    // Without the arm, `address` is an unread parameter and `q` is absent, so this is exactly what
    // the door would have returned for the request above. Asserted rather than asserted-about, so
    // the case above is known to be distinguishing the two rather than merely passing.
    const { ctx } = await corpus();
    const res = await search(ctx, "q=");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    // The tell: a blank text search answers with the text search's envelope.
    expect(body.facets).toBeDefined();
    expect(body.tier).toBe("exact");
  });

  it("folds case and stays an equality, like the hosted door", async () => {
    const { ctx, hers, hersOlder } = await corpus();
    const folded = await search(ctx, "address=INFO%40ACME.TEST&direction=from");
    expect((await folded.json()).items.map((m: { id: string }) => m.id)).toEqual([hers, hersOlder]);

    for (const near of ["info%40acme.tes", "nfo%40acme.test", "acme.test", "info"]) {
      const res = await search(ctx, `address=${near}&direction=from`);
      expect(res.status).toBe(200);
      expect((await res.json()).items).toEqual([]);
    }
  });

  it("is account-scoped — the same address in another account is not returned", async () => {
    const { ctx, hers, hersOlder, theirs } = await corpus();
    const res = await search(ctx, "address=info%40acme.test&direction=from");
    const ids = (await res.json()).items.map((m: { id: string }) => m.id);
    expect(ids).toEqual([hers, hersOlder]);
    expect(ids).not.toContain(theirs);
  });

  it("answers `to` and `any` with the direction echoed, within this account", async () => {
    const { ctx, hers, hersOlder, toHer } = await corpus();
    const to = await (await search(ctx, "address=info%40acme.test&direction=to")).json();
    expect(to.items.map((m: { id: string }) => m.id)).toEqual([toHer]);
    expect(to.total).toBe(1);
    expect(to.direction).toBe("to");
    const any = await (await search(ctx, "address=info%40acme.test&direction=any")).json();
    expect(any.items.map((m: { id: string }) => m.id)).toEqual([hers, toHer, hersOlder]);
    expect(any.total).toBe(3);
    expect(any.direction).toBe("any");
  });

  it("refuses an absent or unknown direction at the door, with a 400 body", async () => {
    // This half IS spelled here, because it is a parameter check rather than a service rule —
    // the same shape `?sort=` already has on this door.
    const { ctx } = await corpus();
    for (const q of [
      "address=info%40acme.test",
      "address=info%40acme.test&direction=From",
      "address=info%40acme.test&direction=",
      "address=info%40acme.test&direction=both",
    ]) {
      const res = await search(ctx, q);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("validation_failed");
    }
  });

  it("`address` wins over a `q` beside it, as on the hosted door", async () => {
    const { ctx, hers, hersOlder } = await corpus();
    const res = await search(ctx, "q=Unrelated&address=info%40acme.test&direction=from");
    expect(res.status).toBe(200);
    const body = await res.json();
    // "Unrelated" is Bob's subject; the address answer must not contain it.
    expect(body.items.map((m: { id: string }) => m.id)).toEqual([hers, hersOlder]);
    expect(body.direction).toBe("from");
  });
});
