import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { accountSettings, accounts, changeLog, mailboxCredentials, mailboxes, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeMailboxService } from "../src/mailbox-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * ═══ CONSENT IS THE BASELINE, WHETHER OR NOT A WINDOW CAME WITH IT ════════════════════════
 *
 * ── THE DEFECT, MEASURED ON THE MANAGED PLANE (2026-09-10, read-only) ─────────────────────
 *
 * `screening_baseline_at` NULL means "no cutoff", and with no cutoff the gate holds every
 * unruled sender's mail whatever its age — which is what `schema-mail.ts` says in as many
 * words, and what `0056_screening_baseline.sql` shipped on purpose so the column changed
 * nobody's mail on deploy. `organizeHere` was then supposed to stamp it in the consent
 * transaction; the column's own contract already said so. It stamped it only
 * `if (input.screening)`.
 *
 * Consequence, counted: several accounts carried a NULL baseline — every one of them
 * consented after this code shipped — and the accounts that connected before the column's
 * one-off backfill held a great many messages at the gate whose header date was more than a year
 * older than our ingest of them, some very old. Every one written by the ordinary gate
 * on the connect day, with `last_set_by = 'us'`, and none re-ingested since.
 *
 * ── WHAT THIS FILE PINS ───────────────────────────────────────────────────────────────────
 *
 * A first consent that says nothing about a window still establishes one. It is a SEPARATE
 * write from the dials because they answer different questions: the dials are what the person
 * just chose, this is when they first agreed. The `COALESCE` is asserted in the other
 * direction too — a second consent may not slide a live account's cutline.
 *
 * ── MUTATIONS WATCHED (each restored, `cmp`-proven) ───────────────────────────────────────
 *
 *  · restore `if (input.screening)` in front of the stamp
 *      ⇒ "a consent with no window" RED (baseline null), the dials case still green.
 *  · drop the `coalesce` from the upsert's `set`
 *      ⇒ "a second consent does not move it" RED.
 */

const NOW = new Date("2026-09-11T08:00:00.000Z");
const LATER = new Date("2026-10-01T08:00:00.000Z");

async function readerMailbox() {
  const pglite = await makeTestDb();
  const tx = pglite as unknown as Tx;
  const accountId = randomUUID();
  await tx.insert(accounts).values({ id: accountId, name: "consent-baseline" });
  const [mb] = await tx.insert(mailboxes).values({
    accountId, provider: "imap", address: "fresh@example.test",
    // Never consented — the state `POST /mailboxes` creates and the state a fresh connect is in.
    // Both terms matter: with a consent stamp the precondition takes the re-run branch instead.
    organizerRole: "reader",
    organizeConsentedAt: null,
  }).returning();
  // A stored credential, because a claim-back with no password in the body requires one.
  await tx.insert(mailboxCredentials).values({
    mailboxId: mb!.id, transport: "imap", secretEnc: "not-a-real-secret", keyVersion: 1,
  });
  const svc = makeMailboxService({ allowance: async () => { /* permitted */ } });
  const ctxAt = (now: Date): ServiceContext => ({
    db: pglite as unknown as ServiceContext["db"],
    accountId, userId: null, now: () => now, requestId: "r",
  });
  const settings = async () =>
    (await tx.select().from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0];
  const rings = async () => (await tx.select().from(changeLog).where(and(
    eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings"),
  ))).length;
  return { svc, ctxAt, mailboxId: mb!.id, settings, rings };
}

describe("organizeHere — the first consent stamps the screening baseline", () => {
  it("a consent with NO window still establishes a cutoff", async () => {
    const w = await readerMailbox();
    await w.svc.organizeHere(w.ctxAt(NOW), w.mailboxId, { intent: "takeover" });
    expect((await w.settings())?.screeningBaselineAt,
      "no baseline ⇒ no cutoff ⇒ the whole backlog goes to the Screener whatever its age")
      .toEqual(NOW);
  });

  it("a consent that DOES carry a window stamps the same instant and the dials", async () => {
    const w = await readerMailbox();
    await w.svc.organizeHere(w.ctxAt(NOW), w.mailboxId, { intent: "takeover",
      screening: { dormancyDays: 90, scope: "window" },
    });
    const s = await w.settings();
    expect(s?.screeningBaselineAt).toEqual(NOW);
    expect(s?.dormancyDays).toBe(90);
    expect(s?.screeningScope).toBe("window");
  });

  it("a second consent does NOT move it — the coalesce, in the direction that costs mail", async () => {
    const w = await readerMailbox();
    await w.svc.organizeHere(w.ctxAt(NOW), w.mailboxId, { intent: "takeover" });
    // Back to a reader (the worker's demotion write), then consented to again.
    await w.svc.organizeHere(w.ctxAt(LATER), w.mailboxId, { intent: "takeover" });
    expect((await w.settings())?.screeningBaselineAt,
      "a slid cutline re-screens everything between the two dates")
      .toEqual(NOW);
  });

  it("a REFUSED window writes no baseline either — a refusal writes nothing", async () => {
    const w = await readerMailbox();
    await expect(
      w.svc.organizeHere(w.ctxAt(NOW), w.mailboxId, { intent: "takeover", screening: { dormancyDays: 0 } }),
    ).rejects.toThrow(/dormancyDays/);
    expect((await w.settings())?.screeningBaselineAt ?? null).toBeNull();
  });

  it("the first consent rings the settings doorbell once, in its own transaction (R20-02)", async () => {
    const w = await readerMailbox();
    const out = await w.svc.organizeHere(w.ctxAt(NOW), w.mailboxId, { intent: "join",
      screening: { dormancyDays: 90, scope: "window" },
    });
    expect(out.outcome).toBe("authorized");
    expect(await w.rings(), "the window was written and no open window was told").toBe(1);
  });
});
