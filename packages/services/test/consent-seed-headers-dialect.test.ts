import { accountOfMessage } from "@trafficflow/db";
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { buildSeedReview } from "../src/consent-seed.js";
import type { ServiceContext } from "../src/context.js";

/**
 * THE HEADERS THE SEED READS, ON BOTH STORES — the twin for a declared branch.
 *
 * The scan projects five keys server-side, and the reason is the WIRE: selecting `headers` whole
 * ships every stored header of up to SEED_SCAN_LIMIT messages for a function that reads five of
 * them. `jsonb_strip_nulls(jsonb_build_object(…))` is how that projection is written, and neither
 * function exists on the device store — so the arm branches, and this file is what proves the two
 * arms answer the same question.
 *
 * ── HOW THE CONSTRUCT GOT THERE, AND WHY NOTHING OBJECTED ─────────────────────────────────
 *
 * The dialect census read `sql` templates with a pattern whose opener was `sql(?:<[^<>()]*>)?`,
 * which refuses a nested `<`. The tag here is `sql<Record<string, unknown> | null>`, so the whole
 * template was invisible: a file the phone bundle LOADS carried two server-only functions while
 * the census reported the bundle clean. Reading the tag from the AST is what found it.
 *
 * ── WATCHED FAIL ──────────────────────────────────────────────────────────────────────────
 *
 * With the branch removed and the server's projection restored for both stores, the SQLite run
 * answers `no such function: jsonb_strip_nulls` on every case here while the PGlite run stays
 * green. The census objects to the same edit from the other side, citing `consent-seed.ts:355`.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seeded(): Promise<{ ctx: ServiceContext; own: string }> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const own = `seed-own-${accountId.slice(0, 8)}@example.com`;
  await db.insert(accounts).values({ id: accountId, name: `seed-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: own,
  }).returning({ id: mailboxes.id });

  const sent = async (headers: Record<string, string[]>, at: Date) => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id,
      bodyHash: randomUUID(), dedupKey: randomUUID(),
      fromAddress: own, subject: "a note", date: at,
      nativeLocator: { folder: "Sent Messages", uid: 1 }, snippet: "",
    }).returning({ id: messages.id });
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: accountOfMessage(m!.id), headers });
  };

  // A person, with NO `cc` — the absent-header case the projection has to preserve: an absent
  // header stays absent rather than arriving as an explicit null.
  await sent({ to: ["Lena Roth <lena@atelier.example>"] }, new Date("2026-07-01T09:00:00.000Z"));
  // A machine-written message, declared in the header RFC 3834 gives for it.
  await sent({
    to: ["robot@list.example"], "auto-submitted": ["auto-replied"],
  }, new Date("2026-07-02T09:00:00.000Z"));
  // The user's own address is never a candidate.
  await sent({ to: [own] }, new Date("2026-07-03T09:00:00.000Z"));

  return {
    ctx: { db: db as never, accountId, userId: null, now: () => NOW, requestId: "seed-twin" },
    own,
  };
}

describe("the seed reads the same headers on both stores", () => {
  it("offers the person written to, with the name as transmitted", async () => {
    const { ctx } = await seeded();
    const review = await buildSeedReview(ctx);
    const lena = review.candidates.find((c) => c.address === "lena@atelier.example");
    expect(lena?.name).toBe("Lena Roth");
    expect(lena?.messages).toBe(1);
  });

  it("removes the recipients of a message a machine wrote, and says why", async () => {
    // The three machine markers are exactly three of the five projected keys, so this case is
    // the one that fails first if a store loses them.
    const { ctx } = await seeded();
    const review = await buildSeedReview(ctx);
    expect(review.excluded).toContainEqual({ address: "robot@list.example", reason: "machine-sent" });
    expect(review.candidates.map((c) => c.address)).not.toContain("robot@list.example");
  });

  it("never offers the user their own address", async () => {
    const { ctx, own } = await seeded();
    const review = await buildSeedReview(ctx);
    expect(review.excluded).toContainEqual({ address: own, reason: "own-address" });
  });

  it("reads every seeded message, so an empty projection cannot pass for a clean answer", async () => {
    // The vacuous-green guard: a projection that answered NULL on one store would leave every
    // list empty, which is what three of the assertions above would report as a pass.
    const { ctx } = await seeded();
    const review = await buildSeedReview(ctx);
    expect(review.scannedMessages).toBe(3);
    expect(review.candidates.length + review.excluded.length).toBeGreaterThan(1);
  });
});
