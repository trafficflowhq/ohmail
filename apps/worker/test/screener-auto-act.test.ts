import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messages, routingDecisions, rules,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS, type Tx,
} from "@trafficflow/db";
import { applyScreenerDecision, changeLog, contacts } from "@trafficflow/db";
import {
  plannedDecision, screenerActConsentFrom, screenerAutoActPass,
  SCREENER_ACT_ADMIT_BAR, SCREENER_ACT_DENY_BAR, type ScreenerActConsent,
} from "../src/screener-auto-act.js";
import { repoWithFailingMethod } from "./_fault.js";

/**
 * SCREENER AUTO-ACT — the act on its own consent, measured.
 *
 * THE DEFECT THIS FILE PINS (owner report, 0.22.0): the setting was ON, a first-time sender waited
 * in the Screener under a Spam suggestion at 0.95, and nothing ever filed them. Its one reader was
 * `screener-auto.ts`, which judges each held message ITSELF with the strong-bulk floor and can file
 * only to News and Receipts — so a Spam verdict was unreachable at any confidence and at any time.
 *
 * MUTATION-WATCHES held here, each written so dropping the guard turns it red:
 *   (a) the consent decides — the SAME sender under the SAME suggestion is filed with the act's
 *       own consent and waits without it, the no-AI switch (`screener_auto_apply_at`) on or off.
 *   (b) the bar decides — a suggestion below it waits.
 *   (c) the destination predicate — a folder no decision may file to leaves the sender waiting.
 *   (d) a refusal leaves the sender waiting with their suggestion, counted and never claimed;
 *       an erased account is one line about the account, never a failure per sender.
 *   (e) the consent is the column read with the account's AI switch, on this store.
 *   (f) a refused act is recorded on the suggestion row, on this store, and a filing clears it.
 */

const SCREENER = "ohmail/Screener";
const SPAM = "ohmail/Quarantine";
/** A consent that is always given — the pass's mechanics, apart from the column. */
const GIVEN: ScreenerActConsent = { stillGiven: async () => true };

interface World { accountId: string; mailboxId: string }

describe("SCR-AUTOACT — the Screener acts on a confident suggestion", () => {
  let db: Tx;

  beforeAll(async () => {
    db = (await makeTestDb()) as unknown as Tx;
  });

  async function newWorld(): Promise<World> {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `act-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `act-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    return { accountId, mailboxId: mb!.id };
  }

  /** The settings row, with the no-AI switch (`screener_auto_apply_at`) stamped or NULL. */
  async function settingsRow(w: World, on: boolean): Promise<void> {
    await db.insert(accountSettings).values({
      accountId: w.accountId, screenerAutoApplyAt: on ? new Date() : null,
      // 'all_time' so the cutline admits a fixture message whose date nobody set.
      screeningScope: "all_time",
    }).onConflictDoUpdate({
      target: accountSettings.accountId,
      set: { screenerAutoApplyAt: on ? new Date() : null, screeningScope: "all_time" },
    });
  }

  /** One message held at the gate. */
  async function held(w: World, from: string): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `act:${randomUUID()}`,
      subject: "hello there", fromAddress: from,
      nativeLocator: { folder: SCREENER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  /** The stored advice a producer leaves behind — the row `storeScreenerSuggestion` writes. */
  async function suggest(
    w: World, messageId: string, destination: string, confidence: number,
  ): Promise<void> {
    await db.insert(routingDecisions).values({
      accountId: w.accountId, messageId,
      inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination, confidence, rationale: "", spam: destination === SPAM,
      status: SCREENER_SUGGESTION_STATUS,
    });
  }

  const desiredOf = async (id: string): Promise<string> => {
    const [r] = await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1);
    return r!.desiredFolder;
  };
  const rulesFor = async (w: World, match: string) => db.select().from(rules)
    .where(and(eq(rules.accountId, w.accountId), eq(rules.match, match)));

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (a) THE SETTING DECIDES — the same sender, the same suggestion, both answers
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("MUTATION-WATCH (a): a confident Spam suggestion is filed on the act's own consent, never on the no-AI switch", async () => {
    const off = await newWorld();
    const stranger = "stranger@spam.test";
    const waiting = await held(off, stranger);
    await suggest(off, waiting, SPAM, 0.95);

    // No consent and no `account_settings` row at all — the default, and the shape most accounts
    // are in.
    expect(await screenerAutoActPass(db, { accountId: off.accountId, consent: null })).toMatchObject({ ran: false, filed: 0 });
    expect(await desiredOf(waiting), "a sender was filed with no consent").toBe(SCREENER);

    // The no-AI switch ON is still no consent: it says "Deterministic rules only — no AI".
    await settingsRow(off, true);
    expect(await screenerAutoActPass(db, { accountId: off.accountId, consent: null })).toMatchObject({ ran: false, filed: 0 });
    expect(await desiredOf(waiting), "the no-AI switch armed the act").toBe(SCREENER);
    expect(await rulesFor(off, stranger), "a rule was promoted on the no-AI switch").toHaveLength(0);

    // The act's own consent is the only difference — switch off, same sender, same suggestion.
    await settingsRow(off, false);
    const r = await screenerAutoActPass(db, { accountId: off.accountId, consent: GIVEN });
    expect(r).toMatchObject({ ran: true, filed: 1, failed: 0 });
    expect(r.destinations[SPAM]).toBe(1);
    expect(await desiredOf(waiting), "the confident Spam suggestion was left waiting").toBe(SPAM);

    // THE UNDO: a rule in the rules list, naming the sender and the pile. `screener-auto.ts` writes
    // none, which is why its moves could not be undone there.
    const promoted = await rulesFor(off, stranger);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({ kind: "sender", destination: SPAM, provenance: "promoted", enabled: true });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (b) THE BAR DECIDES
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("MUTATION-WATCH (b): a suggestion below the bar waits, and the same sender above it is filed", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const unsure = await held(w, "unsure@shop.test");
    await suggest(w, unsure, SPAM, SCREENER_ACT_DENY_BAR - 0.01);

    const low = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(low).toMatchObject({ ran: true, filed: 0, kept: 1 });
    expect(await desiredOf(unsure), "a suggestion below the bar was acted on").toBe(SCREENER);

    // The newest verdict wins, which is the read path's own rule: a second, confident row for the
    // same message is what the sender gets judged by.
    await suggest(w, unsure, SPAM, SCREENER_ACT_DENY_BAR);
    expect(await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN })).toMatchObject({ filed: 1 });
    expect(await desiredOf(unsure)).toBe(SPAM);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (c) THE DESTINATION PREDICATE — what a decision may not file to
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("MUTATION-WATCH (c): a destination outside the decidable set leaves the sender waiting", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const gate = await held(w, "loop@shop.test");
    // `ohmail/Screener` is the one a coercing reader would take as a decision — it would promote a
    // rule holding the sender at the gate for ever.
    await suggest(w, gate, SCREENER, 1);
    const invented = await held(w, "invented@shop.test");
    await suggest(w, invented, "ohmail/Nowhere", 1);

    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ ran: true, filed: 0, kept: 2 });
    expect(await desiredOf(gate)).toBe(SCREENER);
    expect(await desiredOf(invented)).toBe(SCREENER);
    expect(await rulesFor(w, "loop@shop.test")).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (d) A REFUSAL IS COUNTED, AND THE SENDER STAYS PRESSABLE
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("MUTATION-WATCH (d): an apply that throws leaves the sender waiting, counted as failed and never as filed", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const first = await held(w, "one@spam.test");
    await suggest(w, first, SPAM, 0.99);
    const second = await held(w, "two@spam.test");
    await suggest(w, second, SPAM, 0.99);

    // A STORE FAULT per sender, on both stores: every write to `rules` the pass's transactions make
    // throws, a retry's included, and nothing else does. (An erased account is one fact: below.)
    type Fn = (...a: unknown[]) => unknown;
    const rulesFault = <H extends object>(h: H): H => new Proxy(h, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv) as unknown;
        if (typeof v !== "function") return v;
        if (prop === "insert" || prop === "update") {
          return (table: unknown, ...a: unknown[]) => {
            if (table === rules) throw new Error("injected store fault");
            return (v as Fn).call(t, table, ...a);
          };
        }
        if (prop === "transaction") return (fn: Fn, ...a: unknown[]) => (v as Fn).call(t, (tx: H) => fn(rulesFault(tx)), ...a);
        return (v as Fn).bind(t);
      },
    }) as H;
    const r = await screenerAutoActPass(rulesFault(db), { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ ran: true, filed: 0, failed: 2 });
    expect(await desiredOf(first), "a sender was moved by a refused act").toBe(SCREENER);
    expect(await desiredOf(second)).toBe(SCREENER);
    expect(await rulesFor(w, "one@spam.test")).toHaveLength(0);
    const refusals = await db.select({ why: routingDecisions.actRefusal }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(refusals.map((x) => x.why)).toEqual(["store_fault", "store_fault"]);
  });

  it("an account erased under the pass is one account-level line: nothing filed, failed or recorded", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const first = await held(w, "one@spam.test");
    await suggest(w, first, SPAM, 0.99);
    await suggest(w, await held(w, "two@spam.test"), SPAM, 0.99);
    // The refusal `applyScreenerDecision` raises first, before it writes anything: a real class.
    await db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, w.accountId));
    const events: string[] = [];
    const put = (event: string): void => { events.push(event); };
    const log = { info: put, warn: put, error: put, debug: put } as never;
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN, log });
    expect(r).toMatchObject({ ran: true, filed: 0, failed: 0 });
    expect(events.filter((e) => e.startsWith("screener_auto_act"))).toEqual(["screener_auto_act_account_erased"]);
    expect(await desiredOf(first)).toBe(SCREENER);
    // The erasure fence holds for the refusal too: nothing is written against an erased account.
    const refusals = await db.select({ why: routingDecisions.actRefusal }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(refusals.map((x) => x.why)).toEqual([null, null]);
  });

  it("MUTATION-WATCH (e): the act's consent is its own column, and the account's AI switch outranks it", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const waiting = await held(w, "column@spam.test");
    await suggest(w, waiting, SPAM, 0.95);
    const run = () => screenerAutoActPass(db, { accountId: w.accountId, consent: screenerActConsentFrom(w.accountId) });

    expect(await run(), "the act ran with its column NULL").toMatchObject({ ran: false, filed: 0 });
    // The column as `setAutoAct` writes it (its own cases are the pg file's and the route's).
    await db.update(accountSettings).set({ autoSuggestAt: new Date(), screenerAutoActAt: new Date() })
      .where(eq(accountSettings.accountId, w.accountId));
    await db.update(accounts).set({ aiEnabled: false }).where(eq(accounts.id, w.accountId));
    expect(await run(), "the act ran with the account's AI off").toMatchObject({ ran: false, filed: 0 });
    await db.update(accounts).set({ aiEnabled: true }).where(eq(accounts.id, w.accountId));
    expect(await run()).toMatchObject({ ran: true, filed: 1, failed: 0 });
    expect(await desiredOf(waiting)).toBe(SPAM);
  });

  it("MUTATION-WATCH (f): a refused act is recorded on its suggestion, and the next filing clears it", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const waiting = await held(w, "refused@spam.test");
    await suggest(w, waiting, SPAM, 0.95);
    const faulty = repoWithFailingMethod(db, "insert", () => { throw new Error("injected store fault"); },
      { times: 1, sync: true });

    expect(await screenerAutoActPass(faulty, { accountId: w.accountId, consent: GIVEN }))
      .toMatchObject({ ran: true, filed: 0, failed: 1 });
    const row = async () => (await db.select({ at: routingDecisions.actRefusedAt, why: routingDecisions.actRefusal })
      .from(routingDecisions).where(eq(routingDecisions.messageId, waiting)))[0]!;
    expect((await row()).why).toBe("store_fault");
    expect((await row()).at).not.toBeNull();

    expect(await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN })).toMatchObject({ filed: 1 });
    expect(await row()).toEqual({ at: null, why: null });
  });

  // The tail's clock: a pass whose clock has run files the one sender it started and stops,
  // capped; the next call files the rest. Without the check all three go in one call.
  it("stops at its clock after the first filed sender, and the next call goes on", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    for (const who of ["a@spam.test", "b@spam.test", "c@spam.test"]) {
      await suggest(w, await held(w, who), SPAM, 0.99);
    }
    const first = await screenerAutoActPass(db, { accountId: w.accountId, until: () => true, consent: GIVEN });
    expect(first, "the clock did not stop the pass").toMatchObject({ ran: true, filed: 1, capped: true });
    const rest = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(rest).toMatchObject({ filed: 2 });
  });


  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (g) THE IDENTITY FACT — the act never lets a marked sender through (mail 0148)
  // ══════════════════════════════════════════════════════════════════════════════════════════

  /** A held message carrying the identity fact as ingest writes it. */
  async function marked(w: World, from: string, brand: string): Promise<string> {
    const id = await held(w, from);
    await db.update(messages).set({ senderCheck: "impersonation", senderCheckBrand: brand })
      .where(eq(messages.id, id));
    return id;
  }

  it("MUTATION-WATCH (g): advice bought on the benign message never admits a sender whose other held mail is marked", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "causmaticstore@gmail.test";
    const old = await marked(w, sender, "PostFinance");
    const benign = await held(w, sender);
    // The newest message is the benign one, and the stored advice was bought on it.
    await db.update(messages).set({ date: new Date(Date.now() + 60_000) }).where(eq(messages.id, benign));
    await suggest(w, benign, "INBOX", 0.95);

    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ ran: true, filed: 0, identity: 1 });
    expect(await desiredOf(old)).toBe(SCREENER);
    expect(await desiredOf(benign)).toBe(SCREENER);
    expect(await rulesFor(w, sender), "no rule is promoted for a marked sender").toHaveLength(0);
    const known = await db.select().from(contacts).where(and(eq(contacts.accountId, w.accountId), eq(contacts.address, sender)));
    expect(known, "no contact is taught for a marked sender").toHaveLength(0);
  });

  it("MUTATION-WATCH (g): held mail the check never reached, claiming a brand, holds the act the same way", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "kundendienst@gmail.test";
    const old = await held(w, sender);
    // Older than the column: NULL, with the name a forger writes.
    await db.update(messages).set({ fromName: "PostFinance", senderCheck: null }).where(eq(messages.id, old));
    const benign = await held(w, sender);
    await db.update(messages).set({ date: new Date(Date.now() + 60_000) }).where(eq(messages.id, benign));
    await suggest(w, benign, "INBOX", 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ ran: true, filed: 0, identity: 1 });
    expect(await rulesFor(w, sender)).toHaveLength(0);
    /* THE REFUSAL IS SAID, NEVER SILENT: the act checked the row as the backfill would, so it is
       marked and one `message` update delta repaints every mirror, whose Screener row then says
       "This message claims to be from PostFinance, …" (the sentence screener-sender-reason.test.tsx renders). */
    const [row] = await db.select({ c: messages.senderCheck, b: messages.senderCheckBrand }).from(messages).where(eq(messages.id, old));
    expect(row).toEqual({ c: "impersonation", b: "PostFinance" });
    const deltas = await db.select({ op: changeLog.op }).from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "message"), eq(changeLog.entityId, old)));
    expect(deltas.map((d) => d.op)).toContain("update");
  });

  it("(g) the door fails closed on a held row the check never reached: a pass's yes over it writes nothing", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "unchecked@shop.test";
    const m = await held(w, sender);
    await db.update(messages).set({ senderCheck: null }).where(eq(messages.id, m));
    type InTx = (f: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
    const inTx = (db as unknown as { transaction: InTx }).transaction.bind(db) as InTx;
    const decide = (decidedBy: "pass" | "person") => inTx((tx) => applyScreenerDecision(tx, {
      accountId: w.accountId, scope: "sender", address: sender, appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:test:${decidedBy}:${m}`, now: new Date(), stampBaseline: false, applyRetro: true,
      overExisting: "converge", liftOverDomain: false, decidedBy,
    })) as Promise<Awaited<ReturnType<typeof applyScreenerDecision>>>;
    expect((await decide("pass")).skipped).toBe("identity");
    expect(await desiredOf(m)).toBe(SCREENER);
    // CONTROL: checked and clean, the same pass decision files it.
    await db.update(messages).set({ senderCheck: "none" }).where(eq(messages.id, m));
    expect((await decide("pass")).skipped).toBeUndefined();
    expect(await desiredOf(m)).toBe("INBOX");
  });

  it("CONTROL (g): unchecked held mail that claims nothing does not hold the act", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "anna@gmail.test";
    const old = await held(w, sender);
    await db.update(messages).set({ fromName: "Anna Brunner", senderCheck: null }).where(eq(messages.id, old));
    const benign = await held(w, sender);
    await db.update(messages).set({ date: new Date(Date.now() + 60_000) }).where(eq(messages.id, benign));
    await suggest(w, benign, "INBOX", 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ ran: true, filed: 1, identity: 0 });
    // The act checked it on the way: clean, `'none'`, and no delta for a DTO that did not change.
    const [row] = await db.select({ c: messages.senderCheck }).from(messages).where(eq(messages.id, old));
    expect(row!.c).toBe("none");
  });

  it("(g) the door itself refuses a pass's yes over a marked sender, writing nothing", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "kartenservice@gmail.test";
    const m = await marked(w, sender, "UBS");
    type InTx = (f: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
    const inTx = (db as unknown as { transaction: InTx }).transaction.bind(db) as InTx;
    const r = await inTx((tx) => applyScreenerDecision(tx, {
      accountId: w.accountId, scope: "sender", address: sender, appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:test:${m}`, now: new Date(), stampBaseline: false, applyRetro: true,
      overExisting: "skip", liftOverDomain: false, decidedBy: "pass",
    })) as Awaited<ReturnType<typeof applyScreenerDecision>>;
    expect(r.skipped).toBe("identity");
    expect(r.rerouted).toHaveLength(0);
    expect(await desiredOf(m)).toBe(SCREENER);
    expect(await rulesFor(w, sender)).toHaveLength(0);
    // A person's press stands: the row has told them.
    const pressed = await inTx((tx) => applyScreenerDecision(tx, {
      accountId: w.accountId, scope: "sender", address: sender, appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:press:${m}`, now: new Date(), stampBaseline: false, applyRetro: true,
      overExisting: "converge", liftOverDomain: true, decidedBy: "person",
    })) as Awaited<ReturnType<typeof applyScreenerDecision>>;
    expect(pressed.skipped).toBeUndefined();
    expect(await desiredOf(m)).toBe("INBOX");
  });

  it("(g) a denying plan on a marked sender still files", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "postfinance-alerts@gmail.test";
    const m = await marked(w, sender, "PostFinance");
    await suggest(w, m, SPAM, 0.97);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ filed: 1, identity: 0 });
    expect(await desiredOf(m)).toBe(SPAM);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (h) THE PROVIDER'S WORD — a brand's own domain is let through only when its provider confirmed
  //      the sender. At a host with no known authserv-id every verdict is `unavailable`, and an
  //      exact-domain forgery reads exactly like the brand's own mail.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  /** A held message whose provider said `verdict` about its author (NULL: nobody asked). */
  async function heldWithVerdict(w: World, from: string, verdict: string | null): Promise<string> {
    const id = await held(w, from);
    await db.update(messages).set({ authVerdict: verdict }).where(eq(messages.id, id));
    return id;
  }

  it("MUTATION-WATCH (h): a brand's own domain its provider did not confirm is not let through on advice", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "service@paypal.com";
    const m = await heldWithVerdict(w, sender, "unavailable");
    await suggest(w, m, "INBOX", 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ ran: true, filed: 0, kept: 1, unverified: 1, identity: 0 });
    expect(await desiredOf(m)).toBe(SCREENER);
    expect(await rulesFor(w, sender), "no rule is promoted for an unconfirmed brand sender").toHaveLength(0);
  });

  it("(h) the same sender its provider confirmed is filed: the verified path is unchanged", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "service@paypal.com";
    const m = await heldWithVerdict(w, sender, "pass");
    await suggest(w, m, "INBOX", 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ filed: 1, unverified: 0 });
    expect(await desiredOf(m)).toBe("INBOX");
    expect(await rulesFor(w, sender)).toHaveLength(1);
  });

  it("(h) NULL is nobody asking, not a confirmation: the brand sender waits", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const m = await heldWithVerdict(w, "news@mail.paypal.com", null);
    await suggest(w, m, "ohmail/News", 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ filed: 0, unverified: 1 });
    expect(await desiredOf(m)).toBe(SCREENER);
  });

  it("(h) a denying plan needs no identity: an unconfirmed brand sender is still filed to Spam", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const m = await heldWithVerdict(w, "service@paypal.com", "unavailable");
    await suggest(w, m, SPAM, 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ filed: 1, unverified: 0 });
    expect(await desiredOf(m)).toBe(SPAM);
  });

  it("(h) a sender at no brand's domain is filed on advice as before, confirmed or not", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const m = await heldWithVerdict(w, "news@shop.test", "unavailable");
    await suggest(w, m, "INBOX", 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ filed: 1, unverified: 0 });
    expect(await desiredOf(m)).toBe("INBOX");
  });

  /* THE WHOLE HELD BAG, NOT THE REPRESENTATIVE: the door moves every held letter of the address, and
     the sender-written Date header picks which one represents them. */
  for (const verdict of ["unavailable", null, "fail"] as const) {
    it(`MUTATION-WATCH (h): a confirmed representative does not carry a held ${String(verdict)} letter of the same address`, async () => {
      const w = await newWorld();
      await settingsRow(w, false);
      const sender = "service@paypal.com";
      const forged = await heldWithVerdict(w, sender, verdict);
      // Backdated by its own Date header, so the confirmed letter is the representative.
      await db.update(messages).set({ date: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, forged));
      const genuine = await heldWithVerdict(w, sender, "pass");
      await suggest(w, genuine, "INBOX", 0.95);
      const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
      expect(r).toMatchObject({ filed: 0, kept: 1, unverified: 1 });
      expect(await desiredOf(forged), "the unconfirmed letter rode the confirmed one's advice").toBe(SCREENER);
      expect(await desiredOf(genuine)).toBe(SCREENER);
      expect(await rulesFor(w, sender)).toHaveLength(0);
    });
  }

  it("(h) an unconfirmed letter held in another mailbox of the account keeps the sender waiting", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const [other] = await db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: `two-${w.accountId.slice(0, 8)}@example.test`,
    }).returning();
    const sender = "noreply@post.ch";
    const forged = await heldWithVerdict({ accountId: w.accountId, mailboxId: other!.id }, sender, "unavailable");
    await suggest(w, forged, "INBOX", 0.95);
    expect(await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN }))
      .toMatchObject({ filed: 0, unverified: 1 });
    // The confirmed letter arrives later in the first mailbox and becomes the representative.
    await heldWithVerdict(w, sender, "pass");
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ filed: 0, unverified: 1 });
    expect(await desiredOf(forged)).toBe(SCREENER);
    expect(await rulesFor(w, sender)).toHaveLength(0);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (i) EACH SENDER'S OWN LETTERS — both held-bag facts are asked of the sender's letters, never
  //      of the account's. The selection reads one table, where the query builder writes a column
  //      without its table, so an unqualified outer address inside the subquery would bind to the
  //      inner row and compare it with itself: any held letter of anyone would hold everyone.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  it("MUTATION-WATCH (i): an unconfirmed letter of another sender holds nobody else; one of the same address still does", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    // Confirmed by its provider, with confident advice: filed, whoever else waits.
    const confirmed = "service@paypal.com";
    const genuine = await heldWithVerdict(w, confirmed, "pass");
    await suggest(w, genuine, "ohmail/Receipts", 0.95);
    // A stranger at no brand's domain, unconfirmed, no advice: waits, and decides nothing for others.
    const stranger = await heldWithVerdict(w, "anna@studio-nord.example", "unavailable");
    // CONTROL in the same account: a brand address whose own older letter is unconfirmed still waits.
    const held2 = "noreply@post.ch";
    const forged = await heldWithVerdict(w, held2, "unavailable");
    await db.update(messages).set({ date: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, forged));
    const rep = await heldWithVerdict(w, held2, "pass");
    await suggest(w, rep, "INBOX", 0.95);

    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r, "a confirmed sender was held for another sender's letter").toMatchObject({
      ran: true, examined: 3, filed: 1, kept: 2, unverified: 1, identity: 0,
    });
    expect(await desiredOf(genuine)).toBe("ohmail/Receipts");
    expect(await rulesFor(w, confirmed)).toHaveLength(1);
    expect(await desiredOf(stranger)).toBe(SCREENER);
    expect(await desiredOf(forged)).toBe(SCREENER);
    expect(await desiredOf(rep)).toBe(SCREENER);
    expect(await rulesFor(w, held2)).toHaveLength(0);
  });

  it("MUTATION-WATCH (i): a marked letter of another sender holds nobody else; the marked sender still waits", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const clean = "anna@studio-nord.example";
    const benign = await held(w, clean);
    await suggest(w, benign, "INBOX", 0.95);
    // CONTROL in the same account: the marked sender, with the same confident admitting advice.
    const phish = "kartenservice@gmail.test";
    const claim = await marked(w, phish, "PostFinance");
    await suggest(w, claim, "INBOX", 0.95);

    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r, "a clean sender was held for another sender's claim").toMatchObject({
      ran: true, examined: 2, filed: 1, kept: 1, identity: 1, unverified: 0,
    });
    expect(await desiredOf(benign)).toBe("INBOX");
    expect(await rulesFor(w, clean)).toHaveLength(1);
    expect(await desiredOf(claim)).toBe(SCREENER);
    expect(await rulesFor(w, phish)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE PREDICATE, ALONE — the one the manual door validates with
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("plannedDecision — advice becomes the decision a press would make, or nothing", () => {
  const bars = { deny: SCREENER_ACT_DENY_BAR, admit: SCREENER_ACT_ADMIT_BAR };
  const plan = (destination: string, confidence: number | null) =>
    plannedDecision("who@x.test", { id: "s1", messageId: "m1", destination, confidence }, bars);

  it("a denying pile becomes decision 'no', an admitting pile becomes 'yes'", () => {
    expect(plan(SPAM, 0.95)).toMatchObject({ decision: "no", appliedFolder: SPAM });
    expect(plan("ohmail/Screened", 0.95)).toMatchObject({ decision: "no" });
    expect(plan("INBOX", 0.95)).toMatchObject({ decision: "yes", appliedFolder: "INBOX" });
    expect(plan("ohmail/News", 0.95)).toMatchObject({ decision: "yes" });
    expect(plan("ohmail/Receipts", 0.95)).toMatchObject({ decision: "yes" });
  });

  it("a pre-0.22 client's News spelling is the same pile, not an unknown one", () => {
    expect(plan("ohmail/Reads", 0.95)).toMatchObject({ decision: "yes", appliedFolder: "ohmail/News" });
  });

  it("refuses the gate itself, an invention, and a confidence that is not a number", () => {
    expect(plan(SCREENER, 1)).toBeNull();
    expect(plan("ohmail/Nowhere", 1)).toBeNull();
    expect(plan(SPAM, null)).toBeNull();
    expect(plan(SPAM, Number.NaN)).toBeNull();
    expect(plannedDecision("who@x.test", undefined, bars)).toBeNull();
  });

  it("the bar is a floor, not a ceiling — exactly at it acts, a hair under it does not", () => {
    expect(plan(SPAM, SCREENER_ACT_DENY_BAR)).not.toBeNull();
    expect(plan(SPAM, SCREENER_ACT_DENY_BAR - 1e-9)).toBeNull();
    expect(plan("INBOX", SCREENER_ACT_ADMIT_BAR)).not.toBeNull();
    expect(plan("INBOX", SCREENER_ACT_ADMIT_BAR - 1e-9)).toBeNull();
  });
});
