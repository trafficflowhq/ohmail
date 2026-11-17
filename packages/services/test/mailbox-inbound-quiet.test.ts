import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { ServiceError, makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * THE FORWARDING-DETECTION NOTICE's service half (mail 0078): the DTO carries the evidence
 * pair, and the dismissal is a per-mailbox write the caller's own account can make and nobody
 * else's can reach.
 *
 * The PREDICATE is not here — `packages/organizer/test/inbound-quiet.test.ts` replays the incident
 * against the pass that owns it. What this file holds is the wire contract the clients build
 * the show rule on: both instants projected unconditionally (a status gate here would be the
 * incident's invisibility restored one layer up), the dismissal stamping the context clock,
 * and the account scoping refusing a foreign mailbox id with the same 404 a missing one gets.
 */

const NOW = new Date("2026-08-29T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
const svc = makeMailboxService({ keyProvider: KP });

type Db = Awaited<ReturnType<typeof makeTestDb>>;

const ctxFor = (db: Db, accountId: string): ServiceContext =>
  ({ db, accountId, userId: null, now: () => NOW, requestId: "r" });

async function seed(db: Db, opts: {
  inboundQuietSince?: Date | null; inboundQuietDismissedAt?: Date | null;
} = {}): Promise<{ accountId: string; mailboxId: string }> {
  const [a] = await db.insert(accounts).values({ name: "quiet" }).returning();
  const [mb] = await db.insert(mailboxes).values({
    accountId: a!.id, provider: "imap", address: `p-${a!.id.slice(0, 8)}@example.test`,
    inboundQuietSince: opts.inboundQuietSince ?? null,
    inboundQuietDismissedAt: opts.inboundQuietDismissedAt ?? null,
  }).returning();
  return { accountId: a!.id, mailboxId: mb!.id };
}

describe("forwarding-detection notice — DTO projection and dismissal (mail 0078)", () => {
  it("projects the pair UNCONDITIONALLY: both instants as ISO on a connected row, both null when nothing stands", async () => {
    const db = await makeTestDb();
    const since = new Date("2026-08-01T00:00:00.000Z");
    const dismissed = new Date("2026-08-05T00:00:00.000Z");
    const stamped = await seed(db, { inboundQuietSince: since, inboundQuietDismissedAt: dismissed });
    const bare = await seed(db);

    const withEpisode = await svc.get(ctxFor(db, stamped.accountId), stamped.mailboxId);
    // `status` is `connected` — the state every episode lives in, which is why a status gate
    // here would reproduce the incident's silence. Both instants ride the wire as ISO.
    expect(withEpisode.status).toBe("connected");
    expect(withEpisode.inboundQuietSince).toBe(since.toISOString());
    expect(withEpisode.inboundQuietDismissedAt).toBe(dismissed.toISOString());

    const clean = await svc.get(ctxFor(db, bare.accountId), bare.mailboxId);
    expect(clean.inboundQuietSince).toBeNull();
    expect(clean.inboundQuietDismissedAt).toBeNull();
  });

  it("dismissal stamps the CONTEXT clock, answers the fresh DTO, and leaves the episode's evidence alone", async () => {
    const db = await makeTestDb();
    const since = new Date("2026-08-01T00:00:00.000Z");
    const { accountId, mailboxId } = await seed(db, { inboundQuietSince: since });

    const dto = await svc.dismissInboundQuiet(ctxFor(db, accountId), mailboxId);
    expect(dto.inboundQuietDismissedAt).toBe(NOW.toISOString());
    // The evidence is the WORKER's; a dismissal must not clear it — the client's comparison
    // (`dismissedAt < since`) is what hides the notice, and clearing `since` here would turn
    // the next pass's re-trip into a "new" episode that un-dismisses itself.
    expect(dto.inboundQuietSince).toBe(since.toISOString());

    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row!.inboundQuietDismissedAt?.toISOString()).toBe(NOW.toISOString());
    expect(row!.inboundQuietSince?.toISOString()).toBe(since.toISOString());
  });

  it("refuses a foreign mailbox with the missing-mailbox 404 and writes nothing", async () => {
    const db = await makeTestDb();
    const victim = await seed(db, { inboundQuietSince: new Date("2026-08-01T00:00:00.000Z") });
    const attacker = await seed(db);

    await expect(svc.dismissInboundQuiet(ctxFor(db, attacker.accountId), victim.mailboxId))
      .rejects.toMatchObject({ httpStatus: 404 });
    await expect(svc.dismissInboundQuiet(ctxFor(db, attacker.accountId), victim.mailboxId))
      .rejects.toBeInstanceOf(ServiceError);

    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, victim.mailboxId));
    expect(row!.inboundQuietDismissedAt).toBeNull();
  });
});
