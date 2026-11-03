import { describe, it, expect } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes } from "@trafficflow/db";
import { StaticKeyProvider } from "@trafficflow/core";
import { makeMailboxService, type ServiceContext, type SmtpProbe } from "@trafficflow/services";

/**
 * THE SERVER'S OWN `SIZE` ANNOUNCEMENT SURVIVES THE CONNECT FLOW AND REACHES THE WIRE.
 *
 * `verifySmtpLogin` reads it out of the EHLO (`packages/core`), the probe carries it on the proven
 * endpoint, and this is the half in between: the connect flow stores it on the mailbox row and the
 * DTO projects it. Without the last two steps the number is measured and discarded, which is
 * indistinguishable from never measuring it — the send path and the compose surface would both go
 * on stating the product constant while the code looked finished.
 */

const NOW = new Date("2026-08-11T12:00:00.000Z");
const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7), 1);
const svc = makeMailboxService({ keyProvider: KP, allowance: async () => { /* unmetered here */ } });
const IMAP = { host: "imap.example", port: 993, secure: true, user: "u", pass: fixturePassword("mailbox-smtp-size") };
const SMTP = { host: "smtp.example", port: 587, secure: false, user: "u", pass: fixturePassword("mailbox-smtp-size") };

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seed(db: Db): Promise<ServiceContext> {
  const [a] = await db.insert(accounts).values({ name: "smtp size" }).returning();
  return { db, accountId: a!.id, userId: null, now: () => NOW, requestId: randomUUID() };
}

/** An SMTP probe that proves the endpoint and announces `maxMessageBytes`. */
const smtpProbeSaying = (maxMessageBytes: number | null): SmtpProbe => async () => ({
  verdict: "ok",
  proven: { host: SMTP.host, port: 587, secure: false, maxMessageBytes },
});

const PROBE_OK = { probe: async () => ({ verdict: "ok" as const }) };

describe("the connect flow records what the submission server said it will accept", () => {
  it("stores the announced ceiling on the mailbox row and projects it on the DTO", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);

    const dto = await svc.create(
      ctx,
      { provider: "imap", address: "mila@lichtgrat.example", imap: IMAP, smtp: SMTP },
      { ...PROBE_OK, smtpProbe: smtpProbeSaying(35_882_577) },
    );

    expect(dto.smtpMaxSizeBytes).toBe(35_882_577);
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, dto.id));
    expect(row!.smtpMaxSizeBytes).toBe(35_882_577);
  });

  it("a server that announced NOTHING stores null — never the product constant", async () => {
    // The statement mail 0055's census refuses, expressed as behaviour: this column means "the
    // SERVER said so". Writing our own 3 MB here would turn a fallback the send path can
    // recognise as absent into a stored fact it cannot.
    const db = await makeTestDb();
    const ctx = await seed(db);

    const dto = await svc.create(
      ctx,
      { provider: "imap", address: "quiet@lichtgrat.example", imap: IMAP, smtp: SMTP },
      { ...PROBE_OK, smtpProbe: smtpProbeSaying(null) },
    );

    expect(dto.smtpMaxSizeBytes).toBeNull();
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, dto.id));
    expect(row!.smtpMaxSizeBytes).toBeNull();
  });

  it("a mailbox connected with no SMTP block at all is null, and the DTO says so", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);

    const dto = await svc.create(
      ctx,
      { provider: "imap", address: "imaponly@lichtgrat.example", imap: IMAP },
      PROBE_OK,
    );

    expect(dto.smtpMaxSizeBytes).toBeNull();
  });

  it("a re-probe REPLACES the recorded number, including back to null", async () => {
    // A server that has stopped announcing a ceiling, or that answered on a different port, has
    // not silently kept yesterday's. Falling back to the strict constant is the safe direction;
    // keeping a stale LARGER number is the one that ends in a bounce.
    const db = await makeTestDb();
    const ctx = await seed(db);

    const dto = await svc.create(
      ctx,
      { provider: "imap", address: "moving@lichtgrat.example", imap: IMAP, smtp: SMTP },
      { ...PROBE_OK, smtpProbe: smtpProbeSaying(20 * 1024 * 1024) },
    );
    expect(dto.smtpMaxSizeBytes).toBe(20 * 1024 * 1024);

    const smaller = await svc.update(ctx, dto.id, { smtp: { ...SMTP, pass: "new-secret-password-password" } }, {
      ...PROBE_OK, smtpProbe: smtpProbeSaying(2 * 1024 * 1024),
    });
    expect(smaller.smtpMaxSizeBytes).toBe(2 * 1024 * 1024);

    const silent = await svc.update(ctx, dto.id, { smtp: { ...SMTP, pass: "newer-secret-password-password" } }, {
      ...PROBE_OK, smtpProbe: smtpProbeSaying(null),
    });
    expect(silent.smtpMaxSizeBytes).toBeNull();
  });

  it("a PATCH that does not dial SMTP leaves the recorded number alone", async () => {
    const db = await makeTestDb();
    const ctx = await seed(db);

    const dto = await svc.create(
      ctx,
      { provider: "imap", address: "renamed@lichtgrat.example", imap: IMAP, smtp: SMTP },
      { ...PROBE_OK, smtpProbe: smtpProbeSaying(12_345_678) },
    );

    const renamed = await svc.update(ctx, dto.id, { displayName: "Work" }, PROBE_OK);
    expect(renamed.smtpMaxSizeBytes).toBe(12_345_678);
  });
});
