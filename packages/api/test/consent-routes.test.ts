import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { accountSettings, changeLog, contacts, mailboxFolders, rules } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import {
  makeDeps, seedSession, seedMailbox, seedMessage, seedBody, seedRule, req, FIXED_NOW,
} from "./helpers.js";

const app = createApp(apiRoutes);

interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
type Client = Doors & { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> };
/** Every statement text the PGlite client runs from here on, a transaction's included. */
function recordStatements(db: unknown): string[] {
  const client = (db as { $client: Client }).$client;
  const seen: string[] = [];
  const instrument = <T extends Doors>(t: T): T => {
    for (const door of ["query", "exec"] as const) {
      const inner = t[door].bind(t);
      t[door] = (...a: unknown[]) => { if (typeof a[0] === "string") seen.push(a[0]); return inner(...(a as [])); };
    }
    return t;
  };
  instrument(client);
  const innerTx = client.transaction.bind(client);
  client.transaction = (cb) => innerTx((tx) => cb(instrument(tx)));
  return seen;
}
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/**
 * The five onboarding-consent routes.
 *
 * The behaviour behind them is proven against real Postgres in
 * `packages/services/test/consent-seed.pg.test.ts`, `consent-reset.pg.test.ts` and
 * `consent-cutline.pg.test.ts`. What this file owes is the ROUTE: that each one exists, that
 * the gates are the ones `consent.ts` says they are, and that a caller cannot reach another
 * account through any of them.
 */
describe("the onboarding-consent routes", () => {
  /**
   * An account with mail it sent and mail it received.
   *
   * `wroteTo` is harvested from the account's own messages' `To:`/`Cc:` headers, so the body
   * row is not decoration — a message with no `message_bodies` row yields no candidates at
   * all, which is how the first draft of this fixture silently asserted nothing.
   */
  async function seedAccount(db: Awaited<ReturnType<typeof makeDeps>>["db"], now: Date) {
    const s = await seedSession(db, { now, lastTwofaAt: now });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: "me@lichtgrat.example" });

    // Two messages the user wrote: one to a person (+Cc), one to a robot.
    const sent = await seedMessage(db, {
      accountId: s.accountId, mailboxId, fromAddress: "me@lichtgrat.example",
      subject: "About the roof", date: new Date(now.getTime() - 86_400_000), folder: "INBOX/Sent",
    });
    await seedBody(db, {
      messageId: sent.id,
      headers: { to: ['"Roth, Lena" <lena@example.com>'], cc: ["sam@example.com"] },
    });
    const robot = await seedMessage(db, {
      accountId: s.accountId, mailboxId, fromAddress: "me@lichtgrat.example",
      subject: "Unsubscribe", date: new Date(now.getTime() - 86_400_000), folder: "INBOX/Sent",
    });
    await seedBody(db, { messageId: robot.id, headers: { to: ["no-reply@example.com"] } });

    // Inbound mail, so the cutline has senders to classify: one recent (active), one ancient
    // and read (dormant).
    await seedMessage(db, {
      accountId: s.accountId, mailboxId, fromAddress: "new@example.com",
      date: new Date(now.getTime() - 3_600_000), unread: true, folder: "ohmail/Screener",
    });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId, fromAddress: "old@example.com",
      date: new Date(now.getTime() - 400 * 86_400_000), unread: false, folder: "INBOX",
    });
    return s;
  }

  it("GET /consent places the account in the flow and states the window it counted with", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const res = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.seedConfirmedAt).toBeNull();
    expect(body.screeningResetAt).toBeNull();
    // ALWAYS a number. An account that has never touched the dial gets the product default
    // rather than a null the client would have to invent a window for.
    expect(body.dormancyDays).toBe(60);
    // The sender counts are an opt-in; asked for, they are the cutline's.
    expect(body.counts).toBeUndefined();
    const asked = await (await H(req("GET", "/consent?counts=1", { bearer: s.token }), deps)).json();
    expect(asked.counts.activeUndecidedSenders).toBe(1);
    expect(asked.counts.dormantUndecidedSenders).toBe(1);
    expect(asked.counts.decidedSenders).toBe(0);
  });

  it("GET /consent reads no message and no folder state unless it is asked for the counts", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    const seen = recordStatements(db);
    const mail = (from: number) => seen.slice(from).filter((q) => /"(messages|folder_state)"|\b(messages|folder_state)\b/.test(q));

    for (const url of ["/consent", "/consent?counts=0", "/consent?counts=true"]) {
      const at = seen.length;
      expect((await H(req("GET", url, { bearer: s.token }), deps)).status).toBe(200);
      expect(mail(at), `${url} read the mailbox`).toEqual([]);
    }
    const at = seen.length;
    expect((await H(req("GET", "/consent?counts=1", { bearer: s.token }), deps)).status).toBe(200);
    expect(mail(at).length, "the opt-in no longer counts").toBeGreaterThan(0);
  });

  it("PATCH /consent/settings moves the dormancy dial and GET /consent reflects it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const res = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ dormancyDays: 90 }),
    }), deps);
    expect(res.status).toBe(200);
    // The echo carries only the knob that was written.
    expect(await res.json()).toEqual({ dormancyDays: 90 });

    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.dormancyDays).toBe(90);

    const got = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await got.json()).dormancyDays).toBe(90);
  });

  it("PATCH /consent/settings NEVER stores the default — 60 echoes 60 but stores NULL", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const res = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ dormancyDays: 60 }),
    }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dormancyDays: 60 });
    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    // Storing 60 would freeze the account at 60; the default is persisted as NULL so it tracks.
    expect(row!.dormancyDays).toBeNull();
  });

  /* ── THE MODE: `screeningScope`, the window's other answer (mail 0083) ──────────────────
     The engine has had the column since 0083 and the onboarding flow has written it all along;
     until this route accepted it, Settings could offer a window and nothing wider. What the
     ROUTE owes is the wire contract — the closed set, the field-present rule, and the echo. */

  it("PATCH /consent/settings stores the mode, and GET /consent reflects it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const res = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ screeningScope: "all_time" }),
    }), deps);
    expect(res.status).toBe(200);
    // The echo carries only the half that was written — no window appears beside it.
    expect(await res.json()).toEqual({ screeningScope: "all_time" });

    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.screeningScope).toBe("all_time");
    // The row is CREATED by this write. A fresh install has no settings row at all, so an
    // UPDATE here would match nothing, answer 200 and store nothing.
    expect(row!.dormancyDays).toBeNull();

    const got = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await got.json()).screeningScope).toBe("all_time");
  });

  it("PATCH /consent/settings writes the pair in one request, and each half alone leaves the other", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    // Both named: one request, one upsert, both echoed.
    const both = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ dormancyDays: 180, screeningScope: "window" }),
    }), deps);
    expect(both.status).toBe(200);
    expect(await both.json()).toEqual({ dormancyDays: 180, screeningScope: "window" });

    // Mode alone: the stored window survives, which is what "extend later" promises — widening
    // must not forget the number, or narrowing back would land on a default nobody chose.
    const wide = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ screeningScope: "all_time" }),
    }), deps);
    expect(await wide.json()).toEqual({ screeningScope: "all_time" });
    let [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.dormancyDays).toBe(180);
    expect(row!.screeningScope).toBe("all_time");

    // Window alone: the mode survives. Re-asserting it would silently narrow an account that
    // had asked for all time.
    const narrow = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ dormancyDays: 90 }),
    }), deps);
    expect(await narrow.json()).toEqual({ dormancyDays: 90 });
    [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.screeningScope).toBe("all_time");
    expect(row!.dormancyDays).toBe(90);
  });

  it("PATCH /consent/settings refuses a mode outside the closed set, and never a null", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    for (const bad of ["everything", "", "ALL_TIME", 1, true, null]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ screeningScope: bad }),
      }), deps);
      expect(res.status, `screeningScope=${JSON.stringify(bad)}`).toBe(400);
    }
    // `null` is refused rather than coerced, and that is the direction that matters: coercing it
    // to 'window' would let a garbled request silently undo an explicit "all time".
    // A refusal beside a LEGAL window persists neither — the shared transaction's whole point.
    expect((await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ dormancyDays: 90, screeningScope: "nope" }),
    }), deps)).status).toBe(400);
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  it("PATCH /consent/settings refuses a window outside 1–365, a bad shape, and an empty body", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    for (const bad of [0, 400, 60.5]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ dormancyDays: bad }),
      }), deps);
      expect(res.status, `dormancyDays=${bad}`).toBe(400);
    }
    // A string is not a number — refused at the wire before the service sees it.
    expect((await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ dormancyDays: "90" }),
    }), deps)).status).toBe(400);
    // Empty body: at least one field is required. A PATCH that changed nothing but returned 200 is a
    // control that lies about having acted.
    expect((await H(req("PATCH", "/consent/settings", { bearer: s.token, body: "{}" }), deps)).status)
      .toBe(400);
    // None of the refusals wrote a settings row.
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  it("PATCH /consent/settings carries both knobs, and a null dial reverts without touching auto-suggest", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const both = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ autoSuggest: true, dormancyDays: 120 }),
    }), deps);
    expect(both.status).toBe(200);
    const body = await both.json();
    expect(body.dormancyDays).toBe(120);
    expect(typeof body.autoSuggestAt).toBe("string");

    // A dial-only PATCH reverts the window (field present) and leaves auto-suggest alone (absent).
    const revert = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ dormancyDays: null }),
    }), deps);
    expect(await revert.json()).toEqual({ dormancyDays: 60 });
    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.dormancyDays).toBeNull();
    expect(row!.autoSuggestAt).not.toBeNull();
  });

  it("PATCH /consent/settings persists NOTHING when one field is valid and the other is refused", async () => {
    // The partial-write bug: `autoSuggest` (valid) committed, then `dormancyDays` (out of band) threw
    // 400 — leaving the flag armed under a 400 response. Both upserts now share one transaction, so a
    // refusal of EITHER field rolls the other back. Revert the transaction in `applyConsentSettings`
    // (call the two writers in sequence) and this goes red: a settings row survives with a non-null
    // `autoSuggestAt`.
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const res = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ autoSuggest: true, dormancyDays: 400 }),
    }), deps);
    expect(res.status).toBe(400);

    // Neither column changed: the auto-suggest write rolled back with the dormancy refusal, so no
    // settings row exists at all (rows are created lazily by the first surviving write).
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  /* ── THE ACT ON SUGGESTIONS, ITS OWN CONSENT ─────────────────────────────────────────────
     No new route: `PATCH /consent/settings {autoAct}` writes it, `GET /consent` reads it. ON needs
     automatic suggestions, refused 400 `auto_suggest_required` without them and persisting
     nothing; suggestions OFF withdraws it in the same write, and the echo says so. */
  it("PATCH /consent/settings refuses the act without auto-suggest, stores it with, and GET reads it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    const patch = (body: unknown) => H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify(body),
    }), deps);
    const read = async () => (await (await H(req("GET", "/consent", { bearer: s.token }), deps)).json()) as {
      autoActAt?: string | null;
    };
    expect(await read(), "an account that never answered reads off, with the axis present").toMatchObject({ autoActAt: null });

    const alone = await patch({ autoAct: true });
    expect(alone.status).toBe(400);
    expect(((await alone.json()) as { error: { code: string } }).error.code).toBe("auto_suggest_required");
    expect((await read()).autoActAt).toBeNull();

    const both = await patch({ autoSuggest: true, autoAct: true });
    expect(both.status).toBe(200);
    expect(typeof ((await both.json()) as { autoActAt?: unknown }).autoActAt).toBe("string");
    expect(typeof (await read()).autoActAt).toBe("string");

    const off = await patch({ autoSuggest: false });
    expect(await off.json(), "suggestions off did not say the act went with it").toEqual({
      autoSuggestAt: null, autoActAt: null,
    });
    expect((await read()).autoActAt).toBeNull();

    expect((await patch({ autoAct: "yes" })).status, "a non-boolean was coerced").toBe(400);
    const refused = await patch({ autoSuggest: false, autoAct: true });
    expect(refused.status).toBe(400);
  });

  /**
   * ── mail 0048 — THE REMOTE-IMAGES OPT-OUT, BOTH DIRECTIONS AND BOTH SIDES OF THE WIRE ────
   *
   * The column stores the OPT-OUT, so the interesting assertions are the two nulls: a fresh
   * account reads `null` (⇒ images load, the product default) and turning the setting back off
   * must return the column to `null` rather than leaving a stale instant behind. A stored
   * timestamp that never clears would be an account permanently on the old flow with a switch
   * showing the new one.
   *
   * Mutation: make `setBlockRemoteImages` stamp `ctx.now()` unconditionally. Real failure text:
   *   AssertionError: turning the opt-out off left a stale instant in the column: expected
   *   2026-... to be null
   */
  it("PATCH /consent/settings stores the remote-images opt-out, and clears it again", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    // A fresh account has never chosen: null on the wire, which the client reads as "images load".
    const fresh = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await fresh.json()).blockRemoteImagesAt, "a fresh account is not on the manual flow")
      .toBeNull();

    const off = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ blockRemoteImages: true }),
    }), deps);
    expect(off.status).toBe(200);
    const stored = (await off.json()).blockRemoteImagesAt;
    expect(typeof stored, "the opt-out echoed no instant").toBe("string");

    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.blockRemoteImagesAt).not.toBeNull();

    const got = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await got.json()).blockRemoteImagesAt).toBe(stored);

    const on = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ blockRemoteImages: false }),
    }), deps);
    expect(await on.json()).toEqual({ blockRemoteImagesAt: null });
    const [after] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(after!.blockRemoteImagesAt, "turning the opt-out off left a stale instant in the column")
      .toBeNull();
  });

  /**
   * NOTHING COERCES, and the sign is the point. `autoSuggest` refuses a non-boolean so a
   * malformed body cannot ARM a spender; this one refuses it so a malformed body cannot CLEAR an
   * opt-out. `"false"`, `0` and `null` are all falsy, and any of them coerced would read as
   * "load remote images for this account from now on" — the one transition on this route nobody
   * may reach by accident.
   *
   * Mutation: `blockImages = Boolean(body.blockRemoteImages)`. Real failure text:
   *   AssertionError: blockRemoteImages="false": expected 200 to be 400
   */
  it("PATCH /consent/settings refuses a non-boolean opt-out rather than coercing it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    for (const bad of ["false", 0, null, 1]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ blockRemoteImages: bad }),
      }), deps);
      expect(res.status, `blockRemoteImages=${JSON.stringify(bad)}`).toBe(400);
    }
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  /**
   * THE THIRD KNOB IS COLUMN-SCOPED LIKE THE OTHER TWO. Onboarding runs all of these within a
   * minute on one primary key, and a writer that upserted the whole row would erase whichever
   * setting was written first.
   */
  it("the opt-out does not clobber the dial or the auto-suggest flag", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ autoSuggest: true, dormancyDays: 120 }),
    }), deps);
    await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ blockRemoteImages: true }),
    }), deps);

    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.dormancyDays, "the images write took the dial with it").toBe(120);
    expect(row!.autoSuggestAt, "the images write disarmed auto-suggest").not.toBeNull();
    expect(row!.blockRemoteImagesAt).not.toBeNull();
  });

  /**
   * ── TRACKING PIXELS (mail 0072) — the opt-out of a PROTECTION, so the signs are reversed ──
   *
   * `blockTrackingPixels: true` is the default and NULLs the column; `false` STAMPS it. Every
   * assertion below is the images test with the two positions swapped, and the swap is the point:
   * a reader who confuses the two columns' NULLs would write the permissive instant on the wrong
   * one. The wire echoes `loadTrackingPixelsAt` — the instant the account asked pixels to load.
   *
   * Mutation: swap the ternary in `setBlockTrackingPixels` (`blocked ? ctx.now() : null`). Real
   * failure text:
   *   AssertionError: a fresh account blocks pixels — the default must be NULL: expected
   *   2026-... to be null
   */
  it("PATCH /consent/settings stores the pixel opt-out, and clears it back to blocked", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const fresh = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await fresh.json()).loadTrackingPixelsAt, "a fresh account blocks pixels — the default must be NULL")
      .toBeNull();

    // Saying "keep blocking" on a fresh account stores nothing: the default is the absence.
    const keep = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ blockTrackingPixels: true }),
    }), deps);
    expect(keep.status).toBe(200);
    expect(await keep.json()).toEqual({ loadTrackingPixelsAt: null });

    const load = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ blockTrackingPixels: false }),
    }), deps);
    expect(load.status).toBe(200);
    const stored = (await load.json()).loadTrackingPixelsAt;
    expect(typeof stored, "the opt-out echoed no instant").toBe("string");

    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.loadTrackingPixelsAt).not.toBeNull();
    expect(row!.blockRemoteImagesAt, "the pixel write touched the images column").toBeNull();

    const got = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await got.json()).loadTrackingPixelsAt).toBe(stored);

    const back = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ blockTrackingPixels: true }),
    }), deps);
    expect(await back.json()).toEqual({ loadTrackingPixelsAt: null });
    const [after] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(after!.loadTrackingPixelsAt, "turning blocking back on left a stale instant in the column")
      .toBeNull();
  });

  /**
   * NOTHING COERCES, and here `false` is the permissive position: `"false"`, `0` and `null`
   * coerced would read as "fetch every sender's beacon for this account from now on".
   *
   * Mutation: `blockPixels = Boolean(body.blockTrackingPixels)`. Real failure text:
   *   AssertionError: blockTrackingPixels="false": expected 200 to be 400
   */
  it("PATCH /consent/settings refuses a non-boolean pixel switch rather than coercing it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    for (const bad of ["false", 0, null, 1]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ blockTrackingPixels: bad }),
      }), deps);
      expect(res.status, `blockTrackingPixels=${JSON.stringify(bad)}`).toBe(400);
    }
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  /**
   * ── THE FIFTH KNOB — AUTO-UNSUBSCRIBE ON SCREEN-OUT (mail 0054) ─────────────────────────
   *
   * The switch for the one shipping behaviour that sends something to a stranger on the account
   * owner's behalf. It is spelled as the OPT-OUT for a reason the other four do not share: the
   * behaviour is already running for every account that exists, so an opt-in column would have
   * turned it off for all of them the day it deployed.
   *
   * What the SERVICE does with this row is guarded in
   * `packages/services/test/unsubscribe-auto-trigger.test.ts` — the seam, where the request is
   * actually made. This asserts the route can store it, echo it and clear it, which is what makes
   * the seam's answer reachable from a switch somebody can press.
   *
   * Mutation: make `setBlockAutoUnsubscribe` stamp `ctx.now()` unconditionally, and the clear-back
   * assertion goes red — a stored instant that never clears is an account permanently opted out
   * with a switch showing it on.
   */
  it("PATCH /consent/settings stores the auto-unsubscribe opt-out, and clears it again", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    // A fresh account has never chosen: null on the wire, which every client reads as "a
    // screen-out still unsubscribes" — the product default and the shipped behaviour.
    const fresh = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await fresh.json()).blockAutoUnsubscribeAt, "a fresh account is opted out")
      .toBeNull();

    const off = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ blockAutoUnsubscribe: true }),
    }), deps);
    expect(off.status).toBe(200);
    const stored = (await off.json()).blockAutoUnsubscribeAt;
    expect(typeof stored, "the opt-out echoed no instant").toBe("string");

    const got = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await got.json()).blockAutoUnsubscribeAt).toBe(stored);

    const on = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ blockAutoUnsubscribe: false }),
    }), deps);
    expect(await on.json()).toEqual({ blockAutoUnsubscribeAt: null });
    const [after] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(after!.blockAutoUnsubscribeAt, "turning the opt-out off left a stale instant")
      .toBeNull();
  });

  /**
   * NOTHING COERCES, and here the consequence is worse than the images knob's. `false` is the
   * position in which screening a sender out sends a one-click request to a stranger, and there
   * is no undo for one that has left — so a garbled body may not reach it.
   *
   * Mutation: `blockAutoUnsub = Boolean(body.blockAutoUnsubscribe)`.
   */
  it("PATCH /consent/settings refuses a non-boolean auto-unsubscribe opt-out", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    for (const bad of ["false", 0, null, 1]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ blockAutoUnsubscribe: bad }),
      }), deps);
      expect(res.status, `blockAutoUnsubscribe=${JSON.stringify(bad)}`).toBe(400);
    }
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  it("the auto-unsubscribe write is column-scoped like the other four", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    await H(req("PATCH", "/consent/settings", {
      bearer: s.token,
      body: JSON.stringify({ autoSuggest: true, dormancyDays: 120, blockRemoteImages: true }),
    }), deps);
    await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ blockAutoUnsubscribe: true }),
    }), deps);

    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.dormancyDays, "the unsubscribe write took the dial with it").toBe(120);
    expect(row!.autoSuggestAt, "the unsubscribe write disarmed auto-suggest").not.toBeNull();
    expect(row!.blockRemoteImagesAt, "the unsubscribe write cleared the images opt-out")
      .not.toBeNull();
    expect(row!.blockAutoUnsubscribeAt).not.toBeNull();
  });

  /**
   * THE INTERFACE LANGUAGE — the fourth knob (mail 0053), and the only one whose null is a
   * DEFERRAL rather than a switch position.
   *
   * `null` on the wire means "this account has no preference", which the client reads as "keep the
   * language this device remembered". So the column is nullable, nothing backfills it, and asking
   * for the DEFAULT stores NULL rather than `'en'` — which is what lets an account stop overriding
   * its devices. All three of those are asserted below, because collapsing any of them would make
   * a German-set browser silently reset to English on its next boot.
   *
   * Mutation: `const stored = locale;` in `setLocale` (i.e. store `'en'` verbatim). Real failure text:
   *   AssertionError: asking for the default stored 'en', so the account now OVERRIDES every
   *   device: expected 'en' to be null
   */
  it("PATCH /consent/settings stores the folders flag, GET reflects it, and the flip rides the delta", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    // A user folder in the worker's inventory — what enabling must announce to live mirrors.
    const mailboxRow = await db.query.mailboxes.findFirst();
    const [inv] = await db.insert(mailboxFolders)
      .values({ mailboxId: mailboxRow!.id, accountId: mailboxRow!.accountId, folder: "Projects/Acme", uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n })
      .returning();

    // A fresh account has never chosen: null on the wire, the pre-feature interface.
    const fresh = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await fresh.json()).foldersEnabledAt, "a fresh account has folders off").toBeNull();

    const on = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ foldersEnabled: true }),
    }), deps);
    expect(on.status).toBe(200);
    const stored = (await on.json()).foldersEnabledAt;
    expect(typeof stored, "the flag echoed no instant").toBe("string");

    const got = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await got.json()).foldersEnabledAt).toBe(stored);

    // THE TRANSITION RIDES THE DELTA (FOLDERS-SPEC.md §4): the enable appended a `folder`
    // create for the user folder — and for the user folder ONLY, never the six or the Sent row.
    const changes = await db.select().from(changeLog).where(eq(changeLog.accountId, s.accountId));
    const folderRows = changes.filter((c) => c.entityType === "folder");
    expect(folderRows.map((c) => [c.op, c.entityId])).toEqual([["create", inv!.id]]);

    const off = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ foldersEnabled: false }),
    }), deps);
    expect(await off.json()).toEqual({ foldersEnabledAt: null });
    const after = await db.select().from(changeLog).where(eq(changeLog.accountId, s.accountId));
    expect(after.filter((c) => c.entityType === "folder").map((c) => c.op).sort())
      .toEqual(["create", "delete"]);
  });

  /**
   * The fourth boolean refuses like the other three — one knob accepting `"true"` is how the
   * stricter rules beside it erode. Mutation: `folders = Boolean(body.foldersEnabled)`.
   */
  it("PATCH /consent/settings refuses a non-boolean folders flag rather than coercing it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    for (const bad of ["true", 1, null, 0]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ foldersEnabled: bad }),
      }), deps);
      expect(res.status, `foldersEnabled=${JSON.stringify(bad)}`).toBe(400);
    }
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  it("PATCH /consent/settings switches ONE mailbox's folders off and GET carries the exception (§17)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    const mailboxRow = await db.query.mailboxes.findFirst();
    const [inv] = await db.insert(mailboxFolders)
      .values({ mailboxId: mailboxRow!.id, accountId: mailboxRow!.accountId, folder: "Projects/Acme", uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n })
      .returning();
    await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ foldersEnabled: true }),
    }), deps);

    // A fresh account carries no exceptions — every mailbox participates.
    const fresh = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await fresh.json()).folderMailboxesOff).toEqual({});

    const off = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ folderMailboxes: { [mailboxRow!.id]: false } }),
    }), deps);
    expect(off.status).toBe(200);
    const echoed = (await off.json()).folderMailboxesOff;
    expect(typeof echoed[mailboxRow!.id], "the switch echoed no instant").toBe("string");

    // GET reflects the exception, and the opt-out rode the delta as the folder's tombstone.
    const got = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await got.json()).folderMailboxesOff).toEqual(echoed);
    const changes = await db.select().from(changeLog).where(eq(changeLog.accountId, s.accountId));
    const deletes = changes.filter((c) => c.entityType === "folder" && c.op === "delete");
    expect(deletes.map((c) => c.entityId)).toEqual([inv!.id]);

    // Back on: the exception clears and the folder's create rides again.
    const on = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ folderMailboxes: { [mailboxRow!.id]: true } }),
    }), deps);
    expect((await on.json()).folderMailboxesOff).toEqual({});
  });

  it("PATCH /consent/settings refuses a malformed folderMailboxes map, and a foreign mailbox 404s", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    // Shape refusals — nothing coerces, an array is not a map, an empty map asserts nothing.
    // `not-a-uuid` keys are the codex-round-1 case: a key that could never name a mailbox
    // must be a 400 up front, not a 22P02-turned-500 inside the transaction.
    for (const bad of [true, "off", [], {}, { "not-a-uuid": false },
      { "6c8f8d6a-0000-4000-8000-000000000000": "false" },
      { "6c8f8d6a-0000-4000-8000-000000000000": 1 }]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ folderMailboxes: bad }),
      }), deps);
      expect(res.status, `folderMailboxes=${JSON.stringify(bad)}`).toBe(400);
    }
    // A mailbox id that is not this account's: 404, and nothing persisted.
    const foreign = await H(req("PATCH", "/consent/settings", {
      bearer: s.token,
      body: JSON.stringify({ folderMailboxes: { "6c8f8d6a-0000-4000-8000-000000000000": false } }),
    }), deps);
    expect(foreign.status).toBe(404);
    const got = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await got.json()).folderMailboxesOff).toEqual({});
  });

  it("PATCH /consent/settings stores a mailbox SIGNATURE, GET carries it, null clears it (mail 0075)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    const mailboxRow = await db.query.mailboxes.findFirst();

    // A fresh account signs with nothing — the map is empty, and it is PRESENT (an older
    // client reads absent-means-none, but this server has read the rows and says so).
    const fresh = await H(req("GET", "/consent", { bearer: s.token }), deps);
    const freshBody = await fresh.json();
    expect("signatures" in freshBody, "the route omitted the map rather than sending {}").toBe(true);
    expect(freshBody.signatures).toEqual({});
    /* THE THIRD MAP TRAVELS WITH THE TWO, and it names EVERY mailbox — including this one, which
       has no signature at all. The editor asks whose a row is before it asks whether there is
       one, so a map keyed only on mailboxes that HAVE a signature would leave the commonest row
       unanswered and reading absent, which is the same false state from the other side. */
    expect(freshBody.signatureSources, "the route did not say whose signature each mailbox shows")
      .toEqual({ [mailboxRow!.id]: "local" });

    const text = "Best regards\nAnna";
    const set = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ signatures: { [mailboxRow!.id]: text } }),
    }), deps);
    expect(set.status).toBe(200);
    // The echo is the WHOLE map, server-confirmed — what the Settings pane renders.
    const setBody = await set.json();
    expect(setBody.signatures).toEqual({ [mailboxRow!.id]: text });
    // The echo carries the sources too: a write does not change whose signature is in force.
    expect(setBody.signatureSources).toEqual({ [mailboxRow!.id]: "local" });
    const got = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await got.json()).signatures).toEqual({ [mailboxRow!.id]: text });

    // Clearing: null removes the key; so does a blank string (nobody signs with whitespace).
    const off = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ signatures: { [mailboxRow!.id]: null } }),
    }), deps);
    expect((await off.json()).signatures).toEqual({});
  });

  it("PATCH /consent/settings refuses a malformed signatures map; a foreign mailbox 404s; the ceiling 400s", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    const mailboxRow = await db.query.mailboxes.findFirst();
    // Shape refusals — nothing coerces: an array is not a map, an empty map asserts nothing,
    // a non-uuid key must be a 400 up front (not a 22P02-turned-500), and a value that is not
    // exactly a string or null must never be stored as somebody's words.
    for (const bad of [true, "off", [], {}, { "not-a-uuid": "sig" },
      { "6c8f8d6a-0000-4000-8000-000000000000": 1 },
      { "6c8f8d6a-0000-4000-8000-000000000000": false }]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ signatures: bad }),
      }), deps);
      expect(res.status, `signatures=${JSON.stringify(bad)}`).toBe(400);
    }
    // A mailbox id that is not this account's: 404, and nothing persisted.
    const foreign = await H(req("PATCH", "/consent/settings", {
      bearer: s.token,
      body: JSON.stringify({ signatures: { "6c8f8d6a-0000-4000-8000-000000000000": "theirs" } }),
    }), deps);
    expect(foreign.status).toBe(404);
    // Past the service's ceiling: a 400 in words, and nothing persisted.
    const big = await H(req("PATCH", "/consent/settings", {
      bearer: s.token,
      body: JSON.stringify({ signatures: { [mailboxRow!.id]: "x".repeat(10_001) } }),
    }), deps);
    expect(big.status).toBe(400);
    const got = await H(req("GET", "/consent", { bearer: s.token }), deps);
    expect((await got.json()).signatures).toEqual({});
  });

  it("PATCH /consent/settings stores a signature's MARKUP and echoes both halves (mail 0098)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    const mailboxRow = await db.query.mailboxes.findFirst();

    // A fresh account: BOTH maps present and empty. `signaturesHtml` present-and-empty for
    // `signatures`' own reason — this server read the rows and found no formatting, which a
    // client can tell from a server too old to carry the field at all.
    const fresh = await (await H(req("GET", "/consent", { bearer: s.token }), deps)).json();
    expect("signaturesHtml" in fresh, "the route omitted the markup map rather than sending {}")
      .toBe(true);
    expect(fresh.signaturesHtml).toEqual({});

    const set = await H(req("PATCH", "/consent/settings", {
      bearer: s.token,
      body: JSON.stringify({
        signaturesHtml: { [mailboxRow!.id]: "<p><strong>Anna</strong><br>ohmail</p>" },
      }),
    }), deps);
    expect(set.status).toBe(200);
    const echo = await set.json();
    // BOTH halves come back: the markup as stored (self-closed `<br />` is the sanitizer's own
    // serialization) and the text the server DERIVED from it.
    expect(echo.signaturesHtml).toEqual({
      [mailboxRow!.id]: "<p><strong>Anna</strong><br />ohmail</p>",
    });
    expect(echo.signatures).toEqual({ [mailboxRow!.id]: "Anna\nohmail" });

    const got = await (await H(req("GET", "/consent", { bearer: s.token }), deps)).json();
    expect(got.signaturesHtml).toEqual({
      [mailboxRow!.id]: "<p><strong>Anna</strong><br />ohmail</p>",
    });
    expect(got.signatures).toEqual({ [mailboxRow!.id]: "Anna\nohmail" });

    // A PLAIN write afterwards clears the markup: saving text is saving the whole value.
    const plain = await (await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ signatures: { [mailboxRow!.id]: "just words" } }),
    }), deps)).json();
    expect(plain.signatures).toEqual({ [mailboxRow!.id]: "just words" });
    expect(plain.signaturesHtml).toEqual({});
  });

  it("PATCH /consent/settings refuses a malformed markup map, and a mailbox named in BOTH", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    const mailboxRow = await db.query.mailboxes.findFirst();

    // `signatures`' shape rule, value for value — nothing coerces.
    for (const bad of [true, "off", [], {}, { "not-a-uuid": "<p>x</p>" },
      { "6c8f8d6a-0000-4000-8000-000000000000": 1 },
      { "6c8f8d6a-0000-4000-8000-000000000000": false }]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ signaturesHtml: bad }),
      }), deps);
      expect(res.status, `signaturesHtml=${JSON.stringify(bad)}`).toBe(400);
    }

    // ONE VALUE, ONE DOOR. A request naming a mailbox in both maps is refused rather than
    // reconciled: the two halves would then say different things to different recipients, which
    // is the promise a multipart/alternative makes.
    const both = await H(req("PATCH", "/consent/settings", {
      bearer: s.token,
      body: JSON.stringify({
        signatures: { [mailboxRow!.id]: "Bob" },
        signaturesHtml: { [mailboxRow!.id]: "<p><strong>Anna</strong></p>" },
      }),
    }), deps);
    expect(both.status).toBe(400);

    // Past the ceiling: a 400 in words, nothing persisted.
    const big = await H(req("PATCH", "/consent/settings", {
      bearer: s.token,
      body: JSON.stringify({ signaturesHtml: { [mailboxRow!.id]: `<p>${"x".repeat(10_001)}</p>` } }),
    }), deps);
    expect(big.status).toBe(400);

    const got = await (await H(req("GET", "/consent", { bearer: s.token }), deps)).json();
    expect(got.signatures).toEqual({});
    expect(got.signaturesHtml).toEqual({});
  });

  it("PATCH /consent/settings counts the two signature maps TOGETHER against the entry ceiling", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    // THE DOOR'S WORST LEGAL BODY MUST NOT HAVE DOUBLED. The entry ceiling exists because each
    // entry is one write inside one transaction, and a mailbox takes one write whichever map
    // names it — so the two maps share the ceiling rather than each getting their own. This is
    // also what keeps `body-ceiling.ts`'s arithmetic (and its statement that `POST /drafts` is
    // the largest legal body) true, which is a claim under test rather than a note.
    const uuid = (n: number) => `6c8f8d6a-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const text: Record<string, string> = {};
    const html: Record<string, string> = {};
    for (let i = 0; i < 13; i += 1) text[uuid(i)] = "t";
    for (let i = 13; i < 26; i += 1) html[uuid(i)] = "<p>h</p>";
    // 13 + 13 = 26 distinct mailboxes, one over SETTINGS_MAX_MAILBOX_ENTRIES (25). Each map
    // ALONE is legal; together they are not, and the refusal is the count one (413).
    const over = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ signatures: text, signaturesHtml: html }),
    }), deps);
    expect(over.status).toBe(413);
  });

  it("PATCH /consent/settings stores the interface language, and the DEFAULT stores NULL", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    // A fresh account has no preference. `null`, and deliberately not omitted.
    const fresh = await H(req("GET", "/consent", { bearer: s.token }), deps);
    const freshBody = await fresh.json();
    expect("locale" in freshBody, "the route omitted the field rather than sending null").toBe(true);
    expect(freshBody.locale).toBeNull();

    const de = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ locale: "de" }),
    }), deps);
    expect(de.status).toBe(200);
    expect(await de.json()).toEqual({ locale: "de" });

    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.locale).toBe("de");
    expect((await (await H(req("GET", "/consent", { bearer: s.token }), deps)).json()).locale)
      .toBe("de");

    // ASKING FOR ENGLISH IS ASKING FOR THE DEFAULT, and the default is never stored.
    const en = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ locale: "en" }),
    }), deps);
    expect(await en.json(), "the echo must be the STORED value, not the argument")
      .toEqual({ locale: null });
    const [afterEn] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(afterEn!.locale,
      "asking for the default stored 'en', so the account now OVERRIDES every device").toBeNull();

    // An explicit null is the same request said the other way, and is legal.
    await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ locale: "de" }),
    }), deps);
    const cleared = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ locale: null }),
    }), deps);
    expect(await cleared.json()).toEqual({ locale: null });
    const [afterNull] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(afterNull!.locale).toBeNull();
  });

  /**
   * THE CLOSED SET, AT THE WIRE AND NOTHING COERCED.
   *
   * The column's CHECK is the layer that actually holds, but a 23514 is not a sentence anybody can
   * act on, and a service that let an unsupported value through would produce an account whose
   * language setting silently does not work — every consumer of an unknown locale falls back to
   * English on purpose, so there is no error anywhere to find it by.
   *
   * Mutation: drop the `SUPPORTED_LOCALES.includes(l)` term from the route's check. Real failure
   * text: `AssertionError: locale="fr": expected 200 to be 400`
   */
  it("PATCH /consent/settings refuses a locale it has no catalogue for", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    for (const bad of ["fr", "de-CH", "DE", "", 7, true, {}, []]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ locale: bad }),
      }), deps);
      expect(res.status, `locale=${JSON.stringify(bad)}`).toBe(400);
    }
    // Nothing was persisted by any of them — the row does not even exist.
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  /**
   * THE APPEARANCE FACE (mail 0082) — `locale`'s wire discipline with the ONE inversion the
   * migration's header argues: **'paper' IS stored.** A Linux device with no choice anywhere
   * defaults to the ohmarchy face, so an account-wide 'paper' is the instruction that overrides
   * that detection — collapse it to NULL and the request stores nothing on exactly the class of
   * device it targets.
   *
   * Mutation: `const stored = themeFace === "paper" ? null : themeFace;` in `setThemeFace`
   * (i.e. locale's collapse, transplanted). Real failure text:
   * `expected { themeFace: null } to deeply equal { themeFace: 'paper' }`.
   */
  it("PATCH /consent/settings stores the account-wide face — and 'paper' is stored, not collapsed", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    // A fresh account has no account-wide choice. `null`, and deliberately not omitted.
    const fresh = await H(req("GET", "/consent", { bearer: s.token }), deps);
    const freshBody = await fresh.json();
    expect("themeFace" in freshBody, "the route omitted the field rather than sending null").toBe(true);
    expect(freshBody.themeFace).toBeNull();

    const oh = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ themeFace: "ohmarchy" }),
    }), deps);
    expect(oh.status).toBe(200);
    expect(await oh.json()).toEqual({ themeFace: "ohmarchy" });
    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.themeFace).toBe("ohmarchy");
    expect((await (await H(req("GET", "/consent", { bearer: s.token }), deps)).json()).themeFace)
      .toBe("ohmarchy");

    // THE INVERSION: paper is a real instruction, stored as itself.
    const paper = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ themeFace: "paper" }),
    }), deps);
    expect(await paper.json(),
      "'paper' collapsed to null would make the request unsayable on a Linux device")
      .toEqual({ themeFace: "paper" });
    const [afterPaper] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(afterPaper!.themeFace).toBe("paper");

    // An explicit null drops the account-wide choice; devices resolve their own defaults again.
    const cleared = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ themeFace: null }),
    }), deps);
    expect(await cleared.json()).toEqual({ themeFace: null });
    const [afterNull] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(afterNull!.themeFace).toBeNull();
  });

  /**
   * The closed set at the wire, nothing coerced — `locale`'s reasons: a stored face nothing
   * renders is a setting that silently does not work, and the CHECK's 23514 is not a sentence.
   *
   * Mutation (measured 2026-08-31): dropping the ROUTE's `SUPPORTED_THEME_FACES.includes(f)`
   * alone stays GREEN — the service's own check backs it (defense in depth, same 400). The
   * honest red drops the SERVICE's check in `setThemeFace`: the string then reaches the
   * column and the CHECK answers 23514, surfacing as a 500 — real failure text:
   * `themeFace="tokyo-night": expected 500 to be 400`.
   */
  it("PATCH /consent/settings refuses a face nothing renders", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    for (const bad of ["tokyo-night", "PAPER", "", 7, true, {}, []]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ themeFace: bad }),
      }), deps);
      expect(res.status, `themeFace=${JSON.stringify(bad)}`).toBe(400);
    }
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  /**
   * THE RESURFACE TIME (mail 0110) — a WALL CLOCK, `themeFace`'s wire discipline over a format
   * rather than a closed set, and `null` is sendable: it means "back to the product's 09:00".
   *
   * The fresh read is the stated requirement in its server half — a client cannot show the time
   * before anybody decides unless the wire says, in one field, whether an account has chosen one.
   *
   * Mutation: `resurfaceTime: null` in place of `settings.resurfaceTime` in the GET's body.
   * Real failure text: `expected null to be '14:30'`.
   */
  it("PATCH /consent/settings stores the resurface time, and the read carries it back", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    // A fresh account has chosen no time. `null`, and deliberately not omitted — a client must be
    // able to tell "read the row, found nothing" from "this server predates the field".
    const freshBody = await (await H(req("GET", "/consent", { bearer: s.token }), deps)).json();
    expect("resurfaceTime" in freshBody, "the route omitted the field rather than sending null")
      .toBe(true);
    expect(freshBody.resurfaceTime).toBeNull();

    const set = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ resurfaceTime: "14:30" }),
    }), deps);
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ resurfaceTime: "14:30" });
    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.resurfaceTime).toBe("14:30");
    expect((await (await H(req("GET", "/consent", { bearer: s.token }), deps)).json()).resurfaceTime)
      .toBe("14:30");

    // Midnight is a time, not a falsy value — the one hour a truthiness test would lose.
    const midnight = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ resurfaceTime: "00:00" }),
    }), deps);
    expect(await midnight.json()).toEqual({ resurfaceTime: "00:00" });

    // An explicit null clears it back to the product's 09:00 — a real answer, like `dormancyDays`.
    const cleared = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ resurfaceTime: null }),
    }), deps);
    expect(await cleared.json()).toEqual({ resurfaceTime: null });
    const [afterNull] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(afterNull!.resurfaceTime).toBeNull();
  });

  /**
   * THE FORMAT AT THE WIRE, nothing coerced. `'9:00'` is the case that matters: it is what a
   * hand-written client sends, it is one character from correct, and rounding it into `'09:00'`
   * would mean a garbled body can move the hour somebody's mail comes back at.
   *
   * Mutation: drop the SERVICE's `RESURFACE_TIME_RE` test in `setResurfaceTime` AND the route's
   * — either alone stays green on the other (defense in depth, same 400). With both gone the
   * column has no CHECK, so `'25:00'` is STORED and answered 200 — real failure text:
   * `resurfaceTime="25:00": expected 200 to be 400`.
   */
  it("PATCH /consent/settings refuses anything that is not HH:MM", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    for (const bad of ["25:00", "9:00", "", "14:60", "14:30:00", "2:3", "14-30", " 14:30",
                       "14:30 ", 1430, true, {}, []]) {
      const res = await H(req("PATCH", "/consent/settings", {
        bearer: s.token, body: JSON.stringify({ resurfaceTime: bad }),
      }), deps);
      expect(res.status, `resurfaceTime=${JSON.stringify(bad)}`).toBe(400);
    }
    // Nothing was persisted by any of them — the row does not even exist.
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  /**
   * COLUMN-SCOPED, like the three knobs before it. Onboarding writes several of these on one
   * primary key within a minute, and a writer that upserted the whole row would erase whichever
   * setting was written first.
   */
  it("the language write does not clobber the dial, auto-suggest or the images opt-out", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    await H(req("PATCH", "/consent/settings", {
      bearer: s.token,
      body: JSON.stringify({ autoSuggest: true, dormancyDays: 120, blockRemoteImages: true }),
    }), deps);
    await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ locale: "de" }),
    }), deps);

    const [row] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(row!.dormancyDays, "the language write took the dial with it").toBe(120);
    expect(row!.autoSuggestAt, "the language write disarmed auto-suggest").not.toBeNull();
    expect(row!.blockRemoteImagesAt, "the language write cleared the images opt-out").not.toBeNull();
    expect(row!.locale).toBe("de");
  });

  /**
   * AND THE WHOLE PATCH IS STILL ATOMIC. A refused language must not leave a valid dial persisted:
   * the four writers share one transaction, so a 400 on any field rolls the others back.
   */
  it("a refused language persists NOTHING, including the fields that were valid", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const res = await H(req("PATCH", "/consent/settings", {
      bearer: s.token, body: JSON.stringify({ dormancyDays: 90, locale: "fr" }),
    }), deps);
    expect(res.status).toBe(400);
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId)),
    "a valid dial was committed under a 400").toHaveLength(0);
  });

  it("GET /consent/seed shows the list before anything acts on it, robots disclosed", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const res = await H(req("GET", "/consent/seed", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const review = await res.json();

    expect(review.candidates.map((c: { address: string }) => c.address).sort())
      .toEqual(["lena@example.com", "sam@example.com"]);
    // Cc is consent (owner call): Sam arrived on the Cc line and is a candidate, not an aside.
    expect(review.candidates.find((c: { address: string }) => c.address === "sam@example.com"))
      .toBeDefined();
    // The robot filter DISCLOSES rather than hides.
    expect(review.excluded).toContainEqual({ address: "no-reply@example.com", reason: "robot-recipient" });
    expect(review.scannedMessages).toBe(2);
    expect(review.truncated).toBe(false);

    // Nothing was written. The list is an offer.
    expect(await db.select().from(rules).where(eq(rules.accountId, s.accountId))).toHaveLength(0);
  });

  it("POST /consent/seed writes only what was checked, with seeded-from-sent provenance", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const res = await H(req("POST", "/consent/seed", {
      bearer: s.token, body: JSON.stringify({ addresses: ["lena@example.com"] }),
    }), deps);
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.rulesCreated).toBe(1);
    expect(result.declined).toBe(1);

    const written = await db.select().from(rules).where(eq(rules.accountId, s.accountId));
    expect(written).toHaveLength(1);
    expect(written[0]!.match).toBe("lena@example.com");
    expect(written[0]!.provenance).toBe("seeded-from-sent");
    expect(written[0]!.destination).toBe("INBOX");
    // THE RELEASE SHAPE, not a retro. The two stamps are EQUAL, which is what
    // `rule-retro.ts#isReleaseRun` reads: the pass then walks only rows settled at the screening
    // gate for these senders, so one confirmation still never becomes thousands of moves. It used
    // to be NULL on both, and that was measured leaving a reported account's held mail at the gate
    // for months — a NULL `retro_requested_at` is not owed work, so no pass was ever selected.
    expect(written[0]!.releaseHeldAt).not.toBeNull();
    expect(written[0]!.releaseHeldAt!.getTime()).toBe(written[0]!.retroRequestedAt!.getTime());
    expect(written[0]!.retroDoneAt).toBeNull();

    const [settings] = await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId));
    expect(settings!.seedConfirmedAt).not.toBeNull();
    expect(settings!.seedConfirmedCount).toBe(1);
    expect(settings!.seedDeclinedCount).toBe(1);
  });

  it("POST /consent/seed refuses a body that is not an address list", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    // An absent list is NOT "confirm nothing": the service would record every candidate as
    // declined, which writes a decision the caller never made.
    const missing = await H(req("POST", "/consent/seed", { bearer: s.token, body: "{}" }), deps);
    expect(missing.status).toBe(400);

    const wrongType = await H(req("POST", "/consent/seed", {
      bearer: s.token, body: JSON.stringify({ addresses: ["ok@example.com", 7] }),
    }), deps);
    expect(wrongType.status).toBe(400);

    expect(await db.select().from(rules).where(eq(rules.accountId, s.accountId))).toHaveLength(0);
    expect(await db.select().from(accountSettings)
      .where(eq(accountSettings.accountId, s.accountId))).toHaveLength(0);
  });

  it("POST /consent/seed accepts an EMPTY list — unchecking everybody is an answer", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    const res = await H(req("POST", "/consent/seed", {
      bearer: s.token, body: JSON.stringify({ addresses: [] }),
    }), deps);
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.rulesCreated).toBe(0);
    expect(result.declined).toBe(2);
    expect(await db.select().from(rules).where(eq(rules.accountId, s.accountId))).toHaveLength(0);
  });

  it("a second confirm answers, writes nothing twice, and the review stays re-openable", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);
    const body = JSON.stringify({ addresses: ["lena@example.com"] });

    expect((await H(req("POST", "/consent/seed", { bearer: s.token, body }), deps)).status).toBe(200);

    // THE SECOND PRESS IS NOT AN ERROR. It used to be a 409 — the review was an offer made
    // once in an account's life — and that made "not now" and "already answered" the same
    // dead end for anybody who later connected a mailbox. The endpoint now answers, and the
    // guarantee moved to where it belongs: one rule per person, however often it is pressed.
    const second = await H(req("POST", "/consent/seed", { bearer: s.token, body }), deps);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ rulesCreated: 0, skipped: 1 });
    expect(await db.select().from(rules).where(eq(rules.accountId, s.accountId))).toHaveLength(1);

    // …and the reset, which clears every rule as well as the stamp, still puts the account
    // back to unscreened — so a confirm after it genuinely writes the rule again.
    expect((await H(req("POST", "/consent/reset", { bearer: s.token }), deps)).status).toBe(200);
    const third = await H(req("POST", "/consent/seed", { bearer: s.token, body }), deps);
    expect(third.status).toBe(200);
    expect((await third.json()).rulesCreated).toBe(1);
  });

  it("the seed makes the account's OWN addresses contacts, so self-sent mail is not screened", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedAccount(db, FIXED_NOW);

    await H(req("POST", "/consent/seed", {
      bearer: s.token, body: JSON.stringify({ addresses: [] }),
    }), deps);

    // Written even though NOBODY was checked: this is not consent for a correspondent, it is
    // the account not being a stranger to itself. The connect-time pass that used to write it
    // is retired, and this is its only remaining writer.
    const rows = await db.select().from(contacts).where(eq(contacts.accountId, s.accountId));
    expect(rows.map((c) => c.address)).toContain("me@lichtgrat.example");
  });

  it("GET /consent/reset reports what a reset would leave physically moved", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId, folder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId, folder: "ohmail/News", observedFolder: "INBOX",
    });

    const res = await H(req("GET", "/consent/reset", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const { unmoved } = await res.json();
    expect(unmoved).toContainEqual({ folder: "ohmail/Screener", messages: 1, observed: 1 });
    // Desired ≠ observed: the move was never carried out, so it is counted but not observed.
    expect(unmoved).toContainEqual({ folder: "ohmail/News", messages: 1, observed: 0 });
  });

  it("POST /consent/reset wipes the decisions, keeps the mail, and reports the piles", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    await seedRule(db, { accountId: s.accountId, match: "kept@example.com" });
    const held = await seedMessage(db, {
      accountId: s.accountId, mailboxId, folder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    });

    const res = await H(req("POST", "/consent/reset", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.rulesDeleted).toBe(1);
    expect(result.unmoved).toContainEqual({ folder: "ohmail/Screener", messages: 1, observed: 1 });

    expect(await db.select().from(rules).where(eq(rules.accountId, s.accountId))).toHaveLength(0);
    // THE MAIL IS KEPT. A reset is not an erasure and never moves a message.
    const after = await H(req("GET", `/messages/${held.id}`, { bearer: s.token }), deps);
    expect(after.status).toBe(200);
  });

  it("POST /consent/reset is step-up gated — a stale session cannot wipe an account's rules", async () => {
    const { db, deps } = await makeDeps();
    const stale = new Date(FIXED_NOW.getTime() - 1000 * 60 * 60 * 24);
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: stale });
    await seedRule(db, { accountId: s.accountId, match: "kept@example.com" });

    const res = await H(req("POST", "/consent/reset", { bearer: s.token }), deps);
    expect(res.status).toBe(403);
    expect(await db.select().from(rules).where(eq(rules.accountId, s.accountId))).toHaveLength(1);
  });

  it("every consent route requires a session", async () => {
    const { deps } = await makeDeps();
    for (const [method, path] of [
      ["GET", "/consent"], ["GET", "/consent/seed"], ["POST", "/consent/seed"],
      ["GET", "/consent/reset"], ["POST", "/consent/reset"],
    ] as const) {
      const res = await H(req(method, path, method === "POST" ? { body: "{}" } : {}), deps);
      expect(res.status, `${method} ${path} answered ${res.status} with no session`).toBe(401);
    }
  });

  it("one account's seed never sees another account's sent mail", async () => {
    const { db, deps } = await makeDeps();
    const mine = await seedAccount(db, FIXED_NOW);
    const theirs = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const otherMailbox = await seedMailbox(db, {
      accountId: theirs.accountId, address: "them@elsewhere.test",
    });
    const otherSent = await seedMessage(db, {
      accountId: theirs.accountId, mailboxId: otherMailbox, fromAddress: "them@elsewhere.test",
      date: FIXED_NOW, folder: "INBOX/Sent",
    });
    await seedBody(db, { messageId: otherSent.id, headers: { to: ["secret@elsewhere.test"] } });

    const res = await H(req("GET", "/consent/seed", { bearer: mine.token }), deps);
    const review = await res.json();
    const addresses = review.candidates.map((c: { address: string }) => c.address);
    expect(addresses).not.toContain("secret@elsewhere.test");
  });
});
