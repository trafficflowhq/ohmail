import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accountPass, accountSettings, onPass, passProgress, writePassProgress, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  getScreeningPreference, setScreeningPreference, requestOhboxTidy, resolveOhboxPolicy,
  DEFAULT_OHBOX_BAR, OHBOX_BAR_MAX_BYTES,
} from "../src/screening-preference.js";
import { ServiceError } from "../src/errors.js";
import type { ServiceContext } from "../src/context.js";

/**
 * The editable Ohbox preference — read/write round-trip, the lenient resolution, and the strict
 * validation. PGlite is enough here: this is a single-writer upsert with no concurrency claim (the
 * race that DOES need real Postgres is `setAutoSuggest`'s, and it is covered in its own pg test).
 */
describe("screening-preference reader/writer", () => {
  let ctx: ServiceContext;

  beforeEach(async () => {
    const db = await makeTestDb();
    ctx = {
      db: db as unknown as ServiceContext["db"],
      accountId: randomUUID(),
      userId: randomUUID(),
      now: () => new Date("2026-08-06T00:00:00.000Z"),
      requestId: "req-1",
    };
  });

  /**
   * THE CUTLINE'S THREE COLUMNS RIDE THIS READ, AND NO WRITER HERE MAY SET ONE.
   *
   * `getScreeningPreference` gained `screeningBaselineAt`, `dormancyDays` and `screeningScope`
   * because the Screener's page resolves the cutline from the `account_settings` read it already
   * makes — one read, so the queue and the count beside it cannot come from different fetches.
   * Every writer in this file names the posture, the bar or the auto-apply flag and nothing else,
   * so no cutline VALUE is ever chosen here.
   *
   * The two shapes below are the asymmetry, and it was measured rather than assumed:
   * `screening_scope` is `NOT NULL DEFAULT 'window'` (migration 0083), so the INSERT that creates
   * the row lands the product default on it, while the other two are nullable and stay NULL. An
   * account with NO ROW reads all three as null. `resolveCutline` absorbs that difference —
   * `'window'` and an absent scope are one mode — and stating it here is what would make a future
   * `NOT NULL DEFAULT` on either of the others come to this file and argue for itself.
   *
   * Whole-object `toEqual`, never `toMatchObject`: the SHAPE is the assertion, so a writer that
   * grows a fourth column or a reader that starts defaulting one of these has to come here.
   */
  const NO_ROW_CUTLINE = {
    screeningBaselineAt: null, dormancyDays: null, screeningScope: null,
  } as const;
  const UNSET_CUTLINE = {
    screeningBaselineAt: null, dormancyDays: null, screeningScope: "window",
  } as const;

  it("an account with no row reads as both-NULL — never an error", async () => {
    expect(await getScreeningPreference(ctx)).toEqual({
      ohboxPolicy: null, ohboxBar: null, impersonationFiling: true, ...NO_ROW_CUTLINE,
    });
  });

  it("resolveOhboxPolicy is absent-config-selects-safe (an allowlist, not a negation)", () => {
    expect(resolveOhboxPolicy(null)).toBe("people_and_replied");
    expect(resolveOhboxPolicy(undefined)).toBe("people_and_replied");
    expect(resolveOhboxPolicy("people_only")).toBe("people_only");
    expect(resolveOhboxPolicy("people_and_replied")).toBe("people_and_replied");
    // Garbage resolves to the LENIENT default, never a third posture — the router's own discipline.
    expect(resolveOhboxPolicy("not-a-real-value")).toBe("people_and_replied");
  });

  it("stores and reads back the posture, and resolves the strict one", async () => {
    const after = await setScreeningPreference(ctx, { ohboxPolicy: "people_only" });
    expect(after.ohboxPolicy).toBe("people_only");
    expect(await getScreeningPreference(ctx)).toEqual({
      ohboxPolicy: "people_only", ohboxBar: null, impersonationFiling: true, ...UNSET_CUTLINE,
    });
    expect(resolveOhboxPolicy((await getScreeningPreference(ctx)).ohboxPolicy)).toBe("people_only");
  });

  it("a PATCH of one axis does not touch the other", async () => {
    await setScreeningPreference(ctx, { ohboxPolicy: "people_only" });
    await setScreeningPreference(ctx, { ohboxBar: "keep it relevant" });
    expect(await getScreeningPreference(ctx)).toEqual({
      ohboxPolicy: "people_only", ohboxBar: "keep it relevant", impersonationFiling: true,
      ...UNSET_CUTLINE,
    });
  });

  it("null on either axis reverts to the default (a legal value, not an error)", async () => {
    await setScreeningPreference(ctx, { ohboxPolicy: "people_only", ohboxBar: "custom" });
    await setScreeningPreference(ctx, { ohboxPolicy: null, ohboxBar: null });
    expect(await getScreeningPreference(ctx)).toEqual({
      ohboxPolicy: null, ohboxBar: null, impersonationFiling: true, ...UNSET_CUTLINE,
    });
  });

  // (The Screener auto-apply switch stood here until mail 0202 dropped its column: the pass it
  // switched was retired, and the preference neither stores nor answers it.)

  it("answers no auto-apply switch, and stores none when an older caller sends one", async () => {
    expect("screenerAutoApply" in (await getScreeningPreference(ctx))).toBe(false);
    const after = await setScreeningPreference(ctx, { ohboxPolicy: "people_only", screenerAutoApply: true } as never);
    expect(after).toEqual({ ohboxPolicy: "people_only", ohboxBar: null, impersonationFiling: true, ...UNSET_CUTLINE });
  });

  // ── FILING A HELD IMPERSONATION TO SPAM — default ON, turned off and on as a boolean (mail 0184) ──

  it("impersonation filing defaults ON, turns off and on, stamps when it was turned off, and leaves the other axes", async () => {
    expect((await getScreeningPreference(ctx)).impersonationFiling).toBe(true);
    const off = await setScreeningPreference(ctx, { impersonationFiling: false });
    expect(off).toEqual({
      ohboxPolicy: null, ohboxBar: null, impersonationFiling: false, ...UNSET_CUTLINE,
    });
    const [row] = await (ctx.db as unknown as Tx).select({ at: accountSettings.impersonationFilingOffAt }).from(accountSettings)
      .where(eq(accountSettings.accountId, ctx.accountId));
    expect(row?.at).toEqual(new Date("2026-08-06T00:00:00.000Z"));
    await setScreeningPreference(ctx, { ohboxPolicy: "people_only" });
    expect((await getScreeningPreference(ctx)).impersonationFiling, "another axis left it off").toBe(false);
    expect((await setScreeningPreference(ctx, { impersonationFiling: true })).impersonationFiling).toBe(true);
    await expect(setScreeningPreference(ctx, { impersonationFiling: "no" as never }))
      .rejects.toMatchObject({ constructor: ServiceError, httpStatus: 400 });
  });

  it("refuses an unknown posture with a 400 (strict, no coercion)", async () => {
    await expect(setScreeningPreference(ctx, { ohboxPolicy: "humans" as never }))
      .rejects.toMatchObject({ constructor: ServiceError, httpStatus: 400 });
  });

  it("refuses an over-cap bar with a 400, measured in BYTES like the CHECK", async () => {
    const overCap = "x".repeat(OHBOX_BAR_MAX_BYTES + 1);
    await expect(setScreeningPreference(ctx, { ohboxBar: overCap }))
      .rejects.toMatchObject({ httpStatus: 400 });
    // …and exactly at the cap is accepted.
    const atCap = "y".repeat(OHBOX_BAR_MAX_BYTES);
    const after = await setScreeningPreference(ctx, { ohboxBar: atCap });
    expect(after.ohboxBar).toBe(atCap);
  });

  it("the default bar is relevance-framed, never 'only real people'", () => {
    expect(DEFAULT_OHBOX_BAR.toLowerCase()).not.toContain("only real people");
    expect(DEFAULT_OHBOX_BAR).toMatch(/relevant|act on|reply/i);
  });

  // ── THE BACKLOG TIDY IS ARMED BY THE FLIP, AND ONLY BY THE FLIP (mail 0043) ──────────────────
  //
  // Risk 1 from the architecture ruling: the worker pass is owed work only when a services-side
  // write stamps the tidy's request mark. If the flip does not stamp it, the pass ships and never
  // runs. These are the LIVE check that it does.

  const tidyMarker = async () => {
    const [row] = await ctx.db.select({ requestedAt: passProgress.requestedAt, cursor: passProgress.cursor })
      .from(passProgress).where(onPass("ohbox_tidy", ctx.accountId)).limit(1);
    return row;
  };

  it("flipping INTO people_only arms the backlog tidy (stamps requested_at, NULLs the cursor)", async () => {
    expect((await tidyMarker())).toBeUndefined();
    await setScreeningPreference(ctx, { ohboxPolicy: "people_only" });
    const m = await tidyMarker();
    expect(m!.requestedAt).toBeInstanceOf(Date);
    expect(m!.cursor).toBeNull();
  });

  it("editing the bar while already people_only does NOT re-arm — only the transition does", async () => {
    await setScreeningPreference(ctx, { ohboxPolicy: "people_only" });
    // Simulate a run in flight: a cursor mid-backlog.
    const midCursor = randomUUID();
    await writePassProgress(ctx.db, accountPass("ohbox_tidy", ctx.accountId), { cursor: midCursor });

    // A bar edit (still people_only, no transition) must leave the cursor alone — re-arming it would
    // restart a run in flight from the top.
    await setScreeningPreference(ctx, { ohboxBar: "keep it relevant" });
    expect((await tidyMarker())!.cursor).toBe(midCursor);

    // …and re-flipping (lenient, then people_only) IS a transition and DOES re-arm (cursor NULLed).
    await setScreeningPreference(ctx, { ohboxPolicy: "people_and_replied" });
    await setScreeningPreference(ctx, { ohboxPolicy: "people_only" });
    expect((await tidyMarker())!.cursor).toBeNull();
  });

  it("requestOhboxTidy arms unconditionally (the 'tidy now' button), even on a lenient account", async () => {
    await requestOhboxTidy(ctx);
    const m = await tidyMarker();
    expect(m!.requestedAt).toBeInstanceOf(Date);
    expect(m!.cursor).toBeNull();
    // It does not change the posture — arming a lenient account is a harmless no-op for the pass.
    expect((await getScreeningPreference(ctx)).ohboxPolicy).toBeNull();
  });
});
