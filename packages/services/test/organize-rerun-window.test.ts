import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { accountSettings, accounts, changeLog, mailboxes, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { and, eq } from "drizzle-orm";
import { makeMailboxService } from "../src/mailbox-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * A RE-RUN OF SETUP STORES THE WINDOW — the hosted half of the same defect.
 *
 * ── WHAT WENT WRONG, AS THE PERSON EXPERIENCES IT ───────────────────────────────────────────
 *
 * "Run setup again" from Settings walks the three things somebody comes back to change: what
 * ohmail files, how far back, and AI. The middle one arrives at `POST /mailboxes/:id/organize`
 * carrying `screening`, and on a mailbox this account already organizes `organizeHere` answered
 * `already_organizing` BEFORE writing anything. A 200, no error, and the account kept the window
 * it already had. The control was decorative on the one path people reach it by twice.
 *
 * ── WHY THE PRECONDITION STAYS AND THE WRITE MOVES IN FRONT OF IT ───────────────────────────
 *
 * The refusal is about the MAILBOX ROW and its own comment says why: re-authorising a becoming
 * that has already happened would leave a spendable takeover stamp on a healthy mailbox, and that
 * stamp is what lets a gate seize a mailbox past a live foreign claim. None of that is an argument
 * about `account_settings`. So the stamp is still refused and the two dials — which ARE the answer
 * the person just gave — are written.
 *
 * The baseline cannot move on this path, and that is not a promise, it is the `COALESCE` the
 * upsert has always carried. It is asserted below anyway, because it is the thing that would turn
 * this fix into a worse bug: a baseline slid forward re-screens everything between the two dates.
 *
 * Watched red by restoring the bare `return { outcome: "already_organizing" }`: the first two
 * cases fail, the stamp and baseline controls pass either way.
 */

const NOW = new Date("2026-09-02T09:00:00.000Z");
const CONSENTED = new Date("2026-03-01T10:00:00.000Z");

/** An account whose mailbox this install already organizes, with a window already stored. */
async function organizing(dials: { dormancyDays: number | null; scope: string }) {
  const pglite = await makeTestDb();
  const tx = pglite as unknown as Tx;
  const accountId = randomUUID();
  await tx.insert(accounts).values({ id: accountId, name: "organize-rerun" });
  const [mb] = await tx.insert(mailboxes).values({
    accountId, provider: "imap", address: "mine@example.test",
    // The state a re-run actually arrives in: organizing, consented months ago. Both terms
    // matter — the precondition is a conjunction, and a fixture missing either one would take
    // the first-consent path and prove nothing about this one.
    organizerRole: "organizer",
    organizeConsentedAt: CONSENTED,
  }).returning();
  await tx.insert(accountSettings).values({
    accountId,
    dormancyDays: dials.dormancyDays,
    screeningScope: dials.scope,
    screeningBaselineAt: CONSENTED,
    updatedAt: CONSENTED,
  });
  // The allowance is satisfied rather than exercised — this path must not consult it at all
  // (nothing is being claimed), and a policy that could refuse would end the test early.
  const svc = makeMailboxService({ allowance: async () => { /* permitted */ } });
  const ctx: ServiceContext = {
    db: pglite as unknown as ServiceContext["db"],
    accountId, userId: null, now: () => NOW, requestId: "r",
  };
  const settings = async () =>
    (await tx.select().from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0]!;
  const mailbox = async () =>
    (await tx.select().from(mailboxes).where(eq(mailboxes.id, mb!.id)))[0]!;
  const rings = async () => (await tx.select().from(changeLog).where(and(
    eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings"),
  ))).length;
  return { svc, ctx, mailboxId: mb!.id, settings, mailbox, rings };
}

describe("organizeHere on a mailbox this account already organizes", () => {
  it("STORES THE NEW WINDOW — it answered 200 and wrote nothing", async () => {
    const w = await organizing({ dormancyDays: 30, scope: "window" });

    const out = await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover",
      screening: { dormancyDays: 90, scope: "window" },
    });
    // Still `already_organizing`: this press is not a second becoming and must not claim to be.
    expect(out.outcome).toBe("already_organizing");
    expect((await w.settings()).dormancyDays, "the dial the person just chose was discarded")
      .toBe(90);
  });

  it("carries `all_time` through — the answer people come back to setup to change", async () => {
    const w = await organizing({ dormancyDays: 30, scope: "window" });
    await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover", screening: { scope: "all_time" } });
    const s = await w.settings();
    expect(s.screeningScope).toBe("all_time");
    // …and the dial returns to NULL, because "all time" is a mode rather than a number of days,
    // and NULL is how this table spells "the person did not choose a number".
    expect(s.dormancyDays).toBeNull();
  });

  it("DOES NOT MOVE THE BASELINE — the coalesce is what makes this path safe", async () => {
    const w = await organizing({ dormancyDays: 30, scope: "window" });
    await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover", screening: { dormancyDays: 90 } });
    expect((await w.settings()).screeningBaselineAt,
      "a re-run slid the cutline forward — everything between the two dates would be re-screened")
      .toEqual(CONSENTED);
  });

  it("DOES NOT RE-STAMP THE MAILBOX — the refusal this branch exists for is intact", async () => {
    // The negative control. `takeover_authorized_at` is a one-shot seizure grant; putting one on
    // a healthy mailbox is exactly what the precondition was written to prevent.
    const w = await organizing({ dormancyDays: 30, scope: "window" });
    await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover", screening: { dormancyDays: 90 } });
    const mb = await w.mailbox();
    expect(mb.takeoverAuthorizedAt).toBeNull();
    expect(mb.organizeConsentedAt, "the record of when the person first agreed").toEqual(CONSENTED);
  });

  it("a dial outside 1–365 is REFUSED here too, and leaves the stored answer alone", async () => {
    const w = await organizing({ dormancyDays: 30, scope: "window" });
    await expect(
      w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover", screening: { dormancyDays: 0 } }),
    ).rejects.toThrow(/dormancyDays/);
    expect((await w.settings()).dormancyDays).toBe(30);
  });

  it("a re-run that stores a window rings the settings doorbell (R20-02)", async () => {
    const w = await organizing({ dormancyDays: 90, scope: "window" });
    await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "join", screening: { dormancyDays: 365, scope: "window" } });
    expect(await w.rings(), "the widened window never reached an open window").toBe(1);
  });

  it("CONTROL: a press that writes nothing rings nothing", async () => {
    const w = await organizing({ dormancyDays: 30, scope: "window" });
    await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover" });
    expect(await w.rings()).toBe(0);
  });

  it("a claim-back with NO screening block writes no settings at all", async () => {
    // "Organize here instead" from Settings asks nothing about the window, so it must invent no
    // answer for it — the same rule the standalone door states for its claim-back.
    const w = await organizing({ dormancyDays: 30, scope: "window" });
    const out = await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover" });
    expect(out.outcome).toBe("already_organizing");
    const s = await w.settings();
    expect(s.dormancyDays).toBe(30);
    expect(s.updatedAt, "an empty press touched the row").toEqual(CONSENTED);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  …AND WHERE THERE IS NO SETTINGS RECORD AT ALL, THE PRESS WRITES ONE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The block above settles what a re-run does to a record that EXISTS. The state it never reaches
 * is the one measured on the 0.18.0 release candidate: a consented, organizing mailbox whose account carries no
 * `account_settings` row. The cutline reads `(screeningBaselineAt ?? now()) - dormancyDays`, so
 * with no baseline it is measured from the moment of each READ — the account has no cutoff at
 * all, the mailbox row reads Organized and Up to date, and nothing lands where the person expects.
 *
 * `already_organizing` is about the MAILBOX ROW. Reading it as "everything this press would write
 * is already written" is what left the record unwritten, and the condition below is the narrow
 * repair: write only where none is readable. The "writes no settings at all" case above is the
 * other half of the same rule and stays exactly as it was — a live cutline may not move.
 */
describe("organizeHere over an account with no settings record", () => {
  /** The measured state: organizing, consented, and no `account_settings` row was ever written. */
  async function organizingWithNoSettings(baseline: Date | null | "absent") {
    const pglite = await makeTestDb();
    const tx = pglite as unknown as Tx;
    const accountId = randomUUID();
    await tx.insert(accounts).values({ id: accountId, name: "organize-no-settings" });
    const [mb] = await tx.insert(mailboxes).values({
      accountId, provider: "imap", address: "mine@example.test",
      organizerRole: "organizer", organizeConsentedAt: CONSENTED,
    }).returning();
    if (baseline !== "absent") {
      await tx.insert(accountSettings).values({
        accountId, dormancyDays: 30, screeningScope: "window",
        ...(baseline === null ? {} : { screeningBaselineAt: baseline }),
        updatedAt: CONSENTED,
      });
    }
    const svc = makeMailboxService({ allowance: async () => { /* permitted */ } });
    const ctx: ServiceContext = {
      db: pglite as unknown as ServiceContext["db"],
      accountId, userId: null, now: () => NOW, requestId: "r",
    };
    const settings = async () =>
      (await tx.select().from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0];
    const rings = async () => (await tx.select().from(changeLog).where(and(
      eq(changeLog.accountId, accountId), eq(changeLog.entityType, "settings"),
    ))).length;
    return { svc, ctx, mailboxId: mb!.id, settings, rings };
  }

  it("the baseline it writes there rings the settings doorbell too", async () => {
    const w = await organizingWithNoSettings("absent");
    await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover" });
    expect(await w.rings()).toBe(1);
  });

  it("a press that asks nothing creates the record its consent always implied", async () => {
    const w = await organizingWithNoSettings("absent");
    expect(await w.settings(), "the fixture did not reach the measured state").toBeUndefined();

    const out = await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover" });

    expect(out.outcome, "this press is still not a second becoming").toBe("already_organizing");
    const s = await w.settings();
    expect(s, "a consented mailbox was left with no settings record to measure its window from")
      .toBeDefined();
    expect(s!.screeningBaselineAt).toEqual(NOW);
    expect(s!.dormancyDays, "a press that asked no window stored an answer nobody gave").toBeNull();
  });

  it("a row that exists with a NULL baseline is not a readable record either", async () => {
    /* The same damage under a row that exists: the cutline arithmetic cannot tell the two apart,
     * so neither may this condition. */
    const w = await organizingWithNoSettings(null);

    await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover" });

    expect((await w.settings())!.screeningBaselineAt).toEqual(NOW);
  });

  it("a readable record is still left alone — the dial it holds is not overwritten", async () => {
    /* THE POSITIVE CONTROL FOR THE CONDITION. Without it the arm could stamp unconditionally and
     * every case above would still pass, which is the slid-cutline defect wearing the fix. */
    const w = await organizingWithNoSettings(CONSENTED);

    await w.svc.organizeHere(w.ctx, w.mailboxId, { intent: "takeover" });

    const s = (await w.settings())!;
    expect(s.screeningBaselineAt, "a live account's cutline was slid forward").toEqual(CONSENTED);
    expect(s.updatedAt, "an empty press touched a readable row").toEqual(CONSENTED);
  });
});
