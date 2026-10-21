import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, changeLog, folderState, mailboxes, messageBodies, messages, routingDecisions, rules,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  ScreenerService, autoFiledSummary, materialize, setAutoAct, setAutoSuggest, type ServiceContext,
} from "@trafficflow/services";
import {
  screenerActConsentFrom, screenerAutoActPass, type ScreenerActConsent,
} from "../src/screener-auto-act.js";
import { newScreenerAutoWalk, screenerAutoApplyPass } from "../src/screener-auto.js";
import { repoWithFailingMethod } from "./_fault.js";

/**
 * ═══ THE ACT FILES A SENDER AS THE PRESS FILES THEM, BUT FOR TWO NAMED DIVERGENCES, AND ONLY ON ITS
 *     OWN CONSENT ════════════════════════════════════════════════════════════════════════════════
 *
 * The act is the account's own Apply, taken for them. The control is `ScreenerService`'s `decide` —
 * the function behind the button — on a twin account seeded identically, rows compared. The two
 * divergences, each asserted where it shows: the act stamps no screening baseline; and a deny bought
 * on a letter its provider did not confirm files that letter alone, with no rule and listed under
 * Filed automatically to put back, where the press, a person deciding about the address, files every
 * held letter under their rule. The seeded letters carry the provider's `pass`, as a Gmail-held
 * mailbox's would. The last
 * two arms hold the consent: the no-AI switch (`screener_auto_apply_at`) arms only the
 * deterministic pass, driven on the lane's real Postgres as the worker's cycle tail drives both.
 *
 * MUTATIONS WATCHED (each restored, `cmp`-proven): `stampBaseline: false` → `true` ⇒ the divergence
 * arm; the consent re-ask + `return null` deleted ⇒ the revoke arm; the consent probe deleted ⇒
 * the no-AI switch arm. The last cases drive the consent the cycle tail hands the pass
 * and the refusal the act records on the suggestion row.
 */

const AVAILABLE = realPgAvailable();
const SCREENER = "ohmail/Screener";
const SPAM = "ohmail/Quarantine";
const NOW = new Date("2026-09-22T10:00:00.000Z");
const READS = "ohmail/News";
/** A consent that is always given — the pass's own mechanics, apart from the column. */
const GIVEN: ScreenerActConsent = { stillGiven: async () => true };
/**
 * WHAT THE CYCLE TAIL HANDS THE PASS — `apps/worker/src/index.ts`'s call, pinned by the callers
 * census. At the base every caller handed `null`.
 */
const cycleTailConsent = (accountId: string): ScreenerActConsent | null => screenerActConsentFrom(accountId);

describe.skipIf(!AVAILABLE)("screener auto-act — the act and the press write one thing", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  /** One account, one mailbox, `n` held senders each with a confident Spam verdict; the no-AI switch on unless said. */
  async function seed(n: number, opts: { suggest?: boolean; noAiSwitch?: boolean } = {}): Promise<{
    accountId: string; mailboxId: string; ids: string[]; senders: string[];
  }> {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `act-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `act-${tag}@example.test`, status: "connected",
    }).returning();
    const switchAt = opts.noAiSwitch === false ? null : NOW;
    await db.insert(accountSettings).values({
      accountId, screenerAutoApplyAt: switchAt, screeningScope: "all_time",
    }).onConflictDoUpdate({
      target: accountSettings.accountId,
      set: { screenerAutoApplyAt: switchAt, screeningScope: "all_time" },
    });
    const ids: string[] = [];
    const senders: string[] = [];
    for (let i = 0; i < n; i++) {
      const from = `held${i}-${tag}@spam.test`;
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: `act-h-${tag}-${i}`, dedupKey: `act:${tag}:${i}`,
        subject: `offer ${i}`, fromAddress: from, authVerdict: "pass",
        nativeLocator: { folder: SCREENER, ref: `1:${200 + i}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      if (opts.suggest !== false) {
        await db.insert(routingDecisions).values({
          accountId, messageId: m!.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
          destination: SPAM, confidence: 0.95, rationale: "", spam: true,
          status: SCREENER_SUGGESTION_STATUS, senderReason: "none",
        });
      }
      ids.push(m!.id);
      senders.push(from);
    }
    return { accountId, mailboxId: mb!.id, ids, senders };
  }

  /** The folder intent a decision leaves, with the row's own identity stripped. */
  const intentOf = async (id: string) => {
    const [r] = await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1);
    return {
      desired: r!.desiredFolder, observed: r!.observedFolder,
      lastSetBy: r!.lastSetBy, status: r!.reconcileStatus, conflict: r!.conflict,
    };
  };
  /** The promoted rule a decision leaves, likewise. */
  const ruleOf = async (accountId: string, match: string) => {
    const [r] = await db.select().from(rules)
      .where(and(eq(rules.accountId, accountId), eq(rules.match, match))).limit(1);
    return r === undefined ? null : {
      kind: r.kind, destination: r.destination, provenance: r.provenance, enabled: r.enabled,
      retroRequested: r.retroRequestedAt !== null,
    };
  };
  const baselineOf = async (accountId: string) => {
    const [r] = await db.select({ at: accountSettings.screeningBaselineAt })
      .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
    return r!.at;
  };

  it("files the sender the press would file, into the same folder state and the same promoted rule", async () => {
    const acted = await seed(1);
    const pressed = await seed(1);

    const r = await screenerAutoActPass(db as unknown as Tx, { accountId: acted.accountId, consent: GIVEN }, NOW);
    expect(r, "the act filed nothing — every comparison below would be vacuous").toMatchObject({
      ran: true, filed: 1, failed: 0,
    });

    // THE CONTROL: the door behind the button, with the arguments its own validate step derives
    // from a `dest` — `decision: "no"` is what `effectForDestination('ohmail/Quarantine')` forces,
    // and the service refuses the pair if they disagree.
    // No classifier and no credits: `decide` is the read-path service's own method and buys
    // nothing — the deps a suggest would need are absent on purpose.
    const press = new ScreenerService({});
    const ctx: ServiceContext = {
      db: db as unknown as ServiceContext["db"], accountId: pressed.accountId, userId: null,
      now: () => NOW, requestId: randomUUID(),
    };
    await press.decide(ctx, pressed.ids[0]!, { decision: "no", dest: SPAM });

    expect(await intentOf(acted.ids[0]!)).toEqual(await intentOf(pressed.ids[0]!));
    expect(await intentOf(acted.ids[0]!)).toMatchObject({ desired: SPAM, lastSetBy: "us", status: "pending" });

    const actedRule = await ruleOf(acted.accountId, acted.senders[0]!);
    expect(actedRule).toEqual(await ruleOf(pressed.accountId, pressed.senders[0]!));
    expect(actedRule).toMatchObject({ kind: "sender", destination: SPAM, provenance: "promoted", enabled: true });

    // THE ONE DIVERGENCE HERE, NAMED: the press is a person answering, so it stamps the screening
    // baseline the window is measured back from; the act is not a press and must not move an
    // account-wide cutoff nobody asked about. The drain reads `stampBaseline` the same way.
    expect(await baselineOf(pressed.accountId), "the press stopped stamping the baseline").toEqual(NOW);
    expect(await baselineOf(acted.accountId), "the act moved an account-wide cutoff").toBeNull();
  }, 60_000);

  it("stops at the sender the withdrawal reached, and reports the revoke rather than a drained queue", async () => {
    const { accountId, ids } = await seed(8);

    // The consent is asked once before any read, then once per sender inside that sender's
    // transaction under the account's row lock; it answers yes for the probe and the first sender
    // and is then withdrawn, so the walk must stop at the second.
    let asked = 0;
    const withdrawnAfterOne: ScreenerActConsent = { stillGiven: async () => ++asked <= 2 };

    const res = await screenerAutoActPass(db as unknown as Tx, { accountId, consent: withdrawnAfterOne }, NOW);

    expect(res.ran, "the consent was not live — this proves nothing about a WALK").toBe(true);
    expect(res.filed).toBe(1);
    expect(res.revoked, "a withdrawn consent must stop the walk").toBe(true);
    expect(asked, "the consent was not asked again per sender").toBe(3);

    // Every sender it did not reach is still held, still carrying its own suggestion.
    const desired = await Promise.all(ids.map(async (id) => (await intentOf(id)).desired));
    expect(desired.filter((d) => d === SCREENER).length).toBe(ids.length - res.filed);
  }, 60_000);

  it("a sender with no stored advice is left alone, however long the setting has been on", async () => {
    const { accountId, ids } = await seed(2, { suggest: false });
    const r = await screenerAutoActPass(db as unknown as Tx, { accountId, consent: GIVEN }, NOW);
    expect(r).toMatchObject({ ran: true, filed: 0, kept: 2 });
    for (const id of ids) expect((await intentOf(id)).desired).toBe(SCREENER);
  }, 60_000);

  /** Plain strong bulk held at the gate: List-Unsubscribe plus a list marker, the floor's shape. */
  async function bulkHeld(accountId: string, mailboxId: string): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: `bulk-${randomUUID()}`, dedupKey: `bulk:${randomUUID()}`,
      subject: "The weekly roundup", fromAddress: `news-${accountId.slice(0, 8)}@shop.test`,
      nativeLocator: { folder: SCREENER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(messageBodies).values({
      messageId: m!.id, text: "", html: null,
      headers: { "list-unsubscribe": ["<https://shop.test/u>"], "list-id": ["<news.shop.test>"] },
    });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  /* THE NO-AI SWITCH ARMS NO AI. Settings → Screening's "File obvious bulk out of my Screener for
     me" says "Deterministic rules only — no AI" and writes `screener_auto_apply_at`. Driven as the
     worker's cycle tail drives both passes: the deterministic one, then the act with the consent
     every production caller passes (`consent: null`, pinned by the callers census). Red at the
     base, where the act took that switch as its opt-in and filed the stranger into Spam. */
  it("with only the no-AI switch on, the act files nothing and the deterministic pass still files bulk", async () => {
    const w = await seed(1);
    // Buying suggestions is not consent to act on them either.
    await db.update(accountSettings).set({ autoSuggestAt: NOW })
      .where(eq(accountSettings.accountId, w.accountId));
    const bulk = await bulkHeld(w.accountId, w.mailboxId);

    const applied = await screenerAutoApplyPass(
      db as unknown as Tx, { accountId: w.accountId, walk: newScreenerAutoWalk() }, NOW,
    );
    const acted = await screenerAutoActPass(
      db as unknown as Tx, { accountId: w.accountId, consent: cycleTailConsent(w.accountId) }, NOW,
    );

    expect(acted, "the no-AI switch armed the act").toMatchObject({ ran: false, filed: 0 });
    expect((await intentOf(w.ids[0]!)).desired, "a suggestion was acted on").toBe(SCREENER);
    expect(await ruleOf(w.accountId, w.senders[0]!), "the act promoted a rule").toBeNull();
    // CONTROL: the switch still files what it says it files.
    expect(applied).toMatchObject({ ran: true, moved: 1 });
    expect((await intentOf(bulk)).desired).toBe(READS);
  }, 60_000);

  /* CONTROL: the act's own consent, given, still files — with the no-AI switch OFF, so nothing but
     that consent is in play. */
  it("the act's own consent, given, files the confident sender with the switch off", async () => {
    const w = await seed(1, { noAiSwitch: false });
    const r = await screenerAutoActPass(db as unknown as Tx, { accountId: w.accountId, consent: GIVEN }, NOW);
    expect(r).toMatchObject({ ran: true, filed: 1, failed: 0 });
    expect((await intentOf(w.ids[0]!)).desired).toBe(SPAM);
  }, 60_000);

  /** The person's own writers, as `PATCH /consent/settings` runs them. */
  const ctxOf = (accountId: string): ServiceContext => ({
    db: db as unknown as ServiceContext["db"], accountId, userId: null, now: () => NOW, requestId: randomUUID(),
  });
  const actColumn = async (accountId: string) => {
    const [r] = await db.select({ at: accountSettings.screenerAutoActAt })
      .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
    return r?.at ?? null;
  };
  const personDecidedOf = async (accountId: string, match: string) => {
    const [r] = await db.select({ at: rules.personDecidedAt }).from(rules)
      .where(and(eq(rules.accountId, accountId), eq(rules.match, match))).limit(1);
    return r === undefined ? "no rule" : r.at;
  };

  /* ROW 1 — THE ACT HAS ITS OWN CONSENT. Turned on through the person's writers, the consent the
     cycle tail hands the pass files the confident sender and writes the rule as ohmail's. Red at
     the base, where the cycle tail handed `null` and nothing could turn it on. */
  it("with the act turned on, the cycle tail's consent files the confident sender as ohmail's rule", async () => {
    const w = await seed(1, { noAiSwitch: false });
    await setAutoSuggest(ctxOf(w.accountId), true);
    await setAutoAct(ctxOf(w.accountId), true);
    expect(await actColumn(w.accountId), "the writer stored nothing").toEqual(NOW);

    const r = await screenerAutoActPass(
      db as unknown as Tx, { accountId: w.accountId, consent: cycleTailConsent(w.accountId) }, NOW,
    );
    expect(r, "the act's own consent did not arm it").toMatchObject({ ran: true, filed: 1, failed: 0 });
    expect((await intentOf(w.ids[0]!)).desired).toBe(SPAM);
    expect(await ruleOf(w.accountId, w.senders[0]!)).toMatchObject({ provenance: "promoted", destination: SPAM });
    expect(await personDecidedOf(w.accountId, w.senders[0]!), "the rule reads as the person's").toBeNull();
  }, 60_000);

  it("the account's AI switch off outranks the act's consent: nothing is read or filed", async () => {
    const w = await seed(1, { noAiSwitch: false });
    await setAutoSuggest(ctxOf(w.accountId), true);
    await setAutoAct(ctxOf(w.accountId), true);
    await db.update(accounts).set({ aiEnabled: false }).where(eq(accounts.id, w.accountId));
    const r = await screenerAutoActPass(
      db as unknown as Tx, { accountId: w.accountId, consent: cycleTailConsent(w.accountId) }, NOW,
    );
    expect(r).toMatchObject({ ran: false, filed: 0 });
    expect((await intentOf(w.ids[0]!)).desired).toBe(SCREENER);
    expect(await ruleOf(w.accountId, w.senders[0]!)).toBeNull();
  }, 60_000);

  it("turning automatic suggestions off withdraws the act; the act alone is refused", async () => {
    const w = await seed(1, { noAiSwitch: false });
    await expect(setAutoAct(ctxOf(w.accountId), true), "the act turned on without suggestions")
      .rejects.toMatchObject({ code: "auto_suggest_required", httpStatus: 400 });
    expect(await actColumn(w.accountId)).toBeNull();

    await setAutoSuggest(ctxOf(w.accountId), true);
    await setAutoAct(ctxOf(w.accountId), true);
    expect(await setAutoSuggest(ctxOf(w.accountId), false)).toEqual({ autoSuggestAt: null, autoActAt: null });
    expect(await actColumn(w.accountId), "suggestions off left the act on").toBeNull();
    const r = await screenerAutoActPass(
      db as unknown as Tx, { accountId: w.accountId, consent: cycleTailConsent(w.accountId) }, NOW,
    );
    expect(r).toMatchObject({ ran: false, filed: 0 });
  }, 60_000);

  /* ROW 2 — A REFUSED ACT IS TOLD. The apply fails once INSIDE the act's transaction (the rule
     insert, through the handle `transaction` hands its callback); the suggestion row records
     `store_fault`, rides the delta, and the next act that files clears it. */
  it("a refused act records its refusal on the suggestion row and the mirror entity carries it", async () => {
    const w = await seed(1, { noAiSwitch: false });
    const [sug] = await db.select({ id: routingDecisions.id }).from(routingDecisions)
      .where(eq(routingDecisions.messageId, w.ids[0]!)).limit(1);
    let faults = 0;
    const faulty = repoWithFailingMethod(db, "insert", () => {
      faults++;
      throw new Error("injected store fault");
    }, { times: 1, sync: true });

    const r = await screenerAutoActPass(faulty as unknown as Tx, { accountId: w.accountId, consent: GIVEN }, NOW);
    expect(faults, "the fault never fired inside the act").toBe(1);
    expect(r).toMatchObject({ ran: true, filed: 0, failed: 1 });
    expect((await intentOf(w.ids[0]!)).desired, "a failed act moved mail").toBe(SCREENER);
    expect(await ruleOf(w.accountId, w.senders[0]!), "a failed act left a rule").toBeNull();

    const [row] = await db.select({ at: routingDecisions.actRefusedAt, why: routingDecisions.actRefusal })
      .from(routingDecisions).where(eq(routingDecisions.id, sug!.id));
    expect(row).toEqual({ at: NOW, why: "store_fault" });
    const entity = await materialize(db as never, w.accountId, "screener_suggestion", sug!.id);
    expect(entity).toMatchObject({ actRefusal: "store_fault", actRefusedAt: NOW.toISOString() });
    const changes = await db.select({ op: changeLog.op }).from(changeLog).where(and(
      eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "screener_suggestion"),
      eq(changeLog.entityId, sug!.id),
    ));
    expect(changes.map((c) => c.op), "the refusal did not ride the delta").toContain("update");

    // The next act that files clears it.
    const again = await screenerAutoActPass(db as unknown as Tx, { accountId: w.accountId, consent: GIVEN }, NOW);
    expect(again).toMatchObject({ filed: 1, failed: 0 });
    expect(await materialize(db as never, w.accountId, "screener_suggestion", sug!.id))
      .toMatchObject({ actRefusal: null, actRefusedAt: null });
  }, 60_000);

  /** One waiting sender at a brand's own domain, its provider's verdict `verdict`, advised to the Ohbox. */
  async function brandHeld(verdict: string | null): Promise<{ accountId: string; mailboxId: string; id: string; sender: string }> {
    const w = await seed(0, { noAiSwitch: false });
    const sender = "service@paypal.com";
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `brand-${w.accountId}`, dedupKey: `brand:${w.accountId}`,
      subject: "Your receipt", fromAddress: sender, authVerdict: verdict,
      nativeLocator: { folder: SCREENER, ref: "1:900" },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(routingDecisions).values({
      accountId: w.accountId, messageId: m!.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination: "INBOX", confidence: 0.95, rationale: "", spam: false, status: SCREENER_SUGGESTION_STATUS,
    });
    return { accountId: w.accountId, mailboxId: w.mailboxId, id: m!.id, sender };
  }

  it("a brand's own domain its provider did not confirm waits; the same sender confirmed is filed", async () => {
    const unconfirmed = await brandHeld("unavailable");
    const r = await screenerAutoActPass(db as unknown as Tx, { accountId: unconfirmed.accountId, consent: GIVEN }, NOW);
    expect(r).toMatchObject({ ran: true, filed: 0, unverified: 1 });
    expect((await intentOf(unconfirmed.id)).desired).toBe(SCREENER);
    expect(await ruleOf(unconfirmed.accountId, unconfirmed.sender)).toBeNull();

    const confirmed = await brandHeld("pass");
    const ok = await screenerAutoActPass(db as unknown as Tx, { accountId: confirmed.accountId, consent: GIVEN }, NOW);
    expect(ok).toMatchObject({ filed: 1, unverified: 0 });
    expect((await intentOf(confirmed.id)).desired).toBe("INBOX");
  }, 60_000);

  it("a confirmed representative does not carry an unconfirmed letter of the same address held beside it", async () => {
    const w = await brandHeld("pass");
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `forged-${w.accountId}`,
      dedupKey: `forged:${w.accountId}`, subject: "Your receipt", fromAddress: w.sender, authVerdict: "unavailable",
      // Backdated by its own Date header, so the confirmed letter stays the representative.
      date: new Date("2020-01-01T00:00:00Z"), nativeLocator: { folder: SCREENER, ref: "1:901" },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    const r = await screenerAutoActPass(db as unknown as Tx, { accountId: w.accountId, consent: GIVEN }, NOW);
    expect(r).toMatchObject({ filed: 0, unverified: 1 });
    expect((await intentOf(m!.id)).desired).toBe(SCREENER);
    expect(await ruleOf(w.accountId, w.sender)).toBeNull();
  }, 60_000);

  /** Another sender's held letter in the same account, with no advice of its own. */
  async function heldBeside(
    w: { accountId: string; mailboxId: string }, from: string, ref: number,
    facts: { authVerdict: string | null; senderCheck?: "impersonation"; senderCheckBrand?: string },
  ): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `beside-${ref}-${w.accountId}`,
      dedupKey: `beside:${ref}:${w.accountId}`, subject: "hello there", fromAddress: from,
      nativeLocator: { folder: SCREENER, ref: `1:${ref}` }, ...facts,
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  it("each sender's own letters: another sender's unconfirmed letter does not hold a confirmed brand sender", async () => {
    const w = await brandHeld("pass");
    const stranger = await heldBeside(w, "anna@studio-nord.example", 902, { authVerdict: "unavailable" });
    const r = await screenerAutoActPass(db as unknown as Tx, { accountId: w.accountId, consent: GIVEN }, NOW);
    expect(r, "a confirmed sender was held for another sender's letter").toMatchObject({ filed: 1, unverified: 0 });
    expect((await intentOf(w.id)).desired).toBe("INBOX");
    expect((await intentOf(stranger)).desired).toBe(SCREENER);
  }, 60_000);

  it("each sender's own letters: another sender's marked letter does not hold a confirmed brand sender", async () => {
    const w = await brandHeld("pass");
    const phish = await heldBeside(w, "kartenservice@gmail.test", 903, {
      authVerdict: "pass", senderCheck: "impersonation", senderCheckBrand: "PostFinance",
    });
    const r = await screenerAutoActPass(db as unknown as Tx, { accountId: w.accountId, consent: GIVEN }, NOW);
    expect(r, "a sender was held for another sender's claim").toMatchObject({ filed: 1, identity: 0 });
    expect((await intentOf(w.id)).desired).toBe("INBOX");
    expect((await intentOf(phish)).desired).toBe(SCREENER);
  }, 60_000);

  /** A genuine letter (`pass`, backdated by its Date) and a newer one its provider did not confirm, advised to Spam. */
  async function genuineAndForged(): Promise<{
    accountId: string; mailboxId: string; genuine: string; forged: string; sender: string;
  }> {
    const w = await seed(0, { noAiSwitch: false });
    const sender = "service@paypal.com";
    const letter = async (ref: number, authVerdict: string, date: Date): Promise<string> => {
      const [m] = await db.insert(messages).values({
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `mixed-${ref}-${w.accountId}`,
        dedupKey: `mixed:${ref}:${w.accountId}`, subject: "Your receipt", fromAddress: sender, authVerdict, date,
        nativeLocator: { folder: SCREENER, ref: `1:${ref}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      return m!.id;
    };
    const genuine = await letter(910, "pass", new Date("2020-01-01T00:00:00Z"));
    const forged = await letter(911, "unavailable", NOW);
    await db.insert(routingDecisions).values({
      accountId: w.accountId, messageId: forged, inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination: SPAM, confidence: 0.95, rationale: "", spam: true, status: SCREENER_SUGGESTION_STATUS,
    });
    return { accountId: w.accountId, mailboxId: w.mailboxId, genuine, forged, sender };
  }

  it("a deny on a forged letter: the act files that letter as the press does, and diverges on the rest", async () => {
    const acted = await genuineAndForged();
    const pressed = await genuineAndForged();
    const r = await screenerAutoActPass(db as unknown as Tx, { accountId: acted.accountId, consent: GIVEN }, NOW);
    expect(r).toMatchObject({ ran: true, filed: 0, kept: 1, failed: 0, unconfirmedDenies: 1 });
    await new ScreenerService({}).decide(ctxOf(pressed.accountId), pressed.forged, { decision: "no", dest: SPAM });

    expect(await intentOf(acted.forged)).toEqual(await intentOf(pressed.forged));
    expect(await intentOf(acted.forged)).toMatchObject({ desired: SPAM, lastSetBy: "us", status: "pending" });
    // THE DIVERGENCE, NAMED: the press is a person deciding about the address, so every held letter
    // moves under their rule; the act's advice may be about a forgery of it, so the genuine letter
    // waits for a person and no rule is written.
    expect((await intentOf(pressed.genuine)).desired).toBe(SPAM);
    expect(await personDecidedOf(pressed.accountId, pressed.sender)).toEqual(NOW);
    expect((await intentOf(acted.genuine)).desired, "the act filed the genuine letter on a forgery's advice").toBe(SCREENER);
    expect(await ruleOf(acted.accountId, acted.sender), "the act wrote a rule on a forgery's advice").toBeNull();
    // With no rule to undo, the act's filing is listed to put back; the press's undo is its rule.
    expect((await autoFiledSummary(db as unknown as Tx, acted.accountId)).items.map((i) => [i.messageId, i.to]))
      .toEqual([[acted.forged, SPAM]]);
    expect((await autoFiledSummary(db as unknown as Tx, pressed.accountId)).items).toEqual([]);
  }, 60_000);

  it("each sender's own letters: another sender's unconfirmed letter leaves a confirmed sender's deny whole", async () => {
    const w = await seed(1, { noAiSwitch: false });
    const stranger = await heldBeside(w, "anna@studio-nord.example", 904, { authVerdict: "unavailable" });
    const r = await screenerAutoActPass(db as unknown as Tx, { accountId: w.accountId, consent: GIVEN }, NOW);
    expect(await ruleOf(w.accountId, w.senders[0]!), "a confirmed sender's deny was cut for another sender's letter")
      .toMatchObject({ destination: SPAM, provenance: "promoted" });
    expect((await intentOf(w.ids[0]!)).desired).toBe(SPAM);
    expect((await intentOf(stranger)).desired).toBe(SCREENER);
    expect(r).toMatchObject({ filed: 1, unconfirmedDenies: 0 });
  }, 60_000);
});
