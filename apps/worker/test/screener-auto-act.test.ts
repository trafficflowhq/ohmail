import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messages, routingDecisions, rules,
  SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS, type Tx,
} from "@trafficflow/db";
import { applyScreenerDecision, changeLog, contacts, learningSignals } from "@trafficflow/db";
import { CAP_CONFIDENCE, createLogger } from "@trafficflow/core/mail";
import type { ClassifierPort, ClassifierResult } from "@trafficflow/core";
import { autoFiledSummary, undoAutoFiled, type ServiceContext } from "@trafficflow/services";
import {
  plannedDecision, screenerActConsentFrom, screenerAutoActPass,
  SCREENER_ACT_ADMIT_BAR, SCREENER_ACT_DENY_BAR, type ScreenerActConsent,
} from "../src/screener-auto-act.js";
import { screenerAutoSuggestPass } from "../src/screener-auto-suggest.js";
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
 *   (j) a deny that meets a letter its provider did not confirm writes no rule: a promoted deny
 *       rule wins before authentication is read, so one bought on a forgery's advice would screen
 *       out the real address it names. Advice bought on such a letter files that letter alone,
 *       never the address's other or later mail, and every filing without a rule is listed under
 *       Filed automatically, where Put back returns it for good.
 *   (k) a deny that rests on other senders' mail writes no rule either: the crowd's cap (one subject
 *       from other first-time senders) is no fact about this address, so advice capped by it, or
 *       stored before the reason was, files the advised letter alone, as in (j).
 *   (l) a sender with a sensitive held letter (a code, a reset) is left whole for the person: the
 *       act files none of their mail and writes no rule.
 *
 * The held fixture carries the provider's `pass`, as a Gmail-held mailbox's letter would; the
 * cases about an unconfirmed letter say so, and one says NULL. A stored suggestion's reason is
 * `none` unless a case says otherwise.
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

  /** One message held at the gate, its sender confirmed by the provider (`pass`). */
  async function held(w: World, from: string): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `act:${randomUUID()}`,
      subject: "hello there", fromAddress: from, authVerdict: "pass",
      nativeLocator: { folder: SCREENER, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: SCREENER, observedFolder: SCREENER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }

  /** The stored advice a producer leaves behind — the row `storeScreenerSuggestion` writes, with the
   *  fact that capped it (`none`: none did). NULL is a row stored before the reason was. */
  async function suggest(
    w: World, messageId: string, destination: string, confidence: number, reason: string | null = "none",
  ): Promise<void> {
    await db.insert(routingDecisions).values({
      accountId: w.accountId, messageId,
      inputProvenance: SCREENER_SUGGESTION_PROVENANCE,
      destination, confidence, rationale: "", spam: destination === SPAM,
      status: SCREENER_SUGGESTION_STATUS, senderReason: reason,
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

  it("acts on a sender whose old-dated letter arrived inside the cutline, as the queue lists them", async () => {
    const w = await newWorld();
    const day = 86_400_000;
    await db.insert(accountSettings).values({
      accountId: w.accountId, screeningBaselineAt: new Date(Date.now() - day), screeningScope: "window",
    });
    // Recorded after the first import: an imported letter waits by its Date alone.
    await db.update(mailboxes).set({ initialImportCompletedAt: new Date(Date.now() - 2 * day) }).where(eq(mailboxes.id, w.mailboxId));
    // One header 200 days old each; only the server's receipt differs.
    const old = new Date(Date.now() - 200 * day);
    const ids: Record<string, string> = {};
    for (const [from, receivedAt] of [["arrived@spam.test", new Date(Date.now() - day / 2)], ["received-old@spam.test", old]] as const) {
      const id = await held(w, from);
      await db.update(messages).set({ date: old, arrivedAt: receivedAt }).where(eq(messages.id, id));
      await suggest(w, id, SPAM, 0.95);
      ids[from] = id;
    }
    expect(await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN })).toMatchObject({ ran: true, filed: 1 });
    expect(await desiredOf(ids["arrived@spam.test"]!)).toBe(SPAM);
    expect(await desiredOf(ids["received-old@spam.test"]!)).toBe(SCREENER);
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

  it("(h) a denying plan on an unconfirmed brand sender files the letter to Spam and writes no rule", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const m = await heldWithVerdict(w, "service@paypal.com", "unavailable");
    await suggest(w, m, SPAM, 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(await desiredOf(m)).toBe(SPAM);
    expect(await rulesFor(w, "service@paypal.com"), "a rule was written on an unconfirmed letter").toHaveLength(0);
    expect(r).toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1, unverified: 0 });
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

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (j) A DENY ON A LETTER ITS PROVIDER DID NOT CONFIRM — nothing standing is written. A promoted
  //      deny rule wins before authentication is read, so a rule bought on a forgery's advice would
  //      send the real address's mail to Spam. Advice bought on such a letter files that letter
  //      alone; advice on a confirmed letter files the unconfirmed letters held beside it first. The
  //      rule needs advice on a confirmed letter AND every held letter it would move confirmed.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  /** A genuine letter (`pass`) backdated by its own Date, and a newer one of the same address. */
  async function genuineAndForged(
    w: World, sender: string, forgedVerdict: string | null,
  ): Promise<{ genuine: string; forged: string }> {
    const genuine = await held(w, sender);
    await db.update(messages).set({ date: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, genuine));
    const forged = await heldWithVerdict(w, sender, forgedVerdict);
    await db.update(messages).set({ date: new Date(Date.now() + 60_000) }).where(eq(messages.id, forged));
    return { genuine, forged };
  }
  const accountRules = (w: World) => db.select().from(rules).where(eq(rules.accountId, w.accountId));
  const accountContacts = (w: World) => db.select().from(contacts).where(eq(contacts.accountId, w.accountId));
  const accountSignals = (w: World) => db.select().from(learningSignals).where(eq(learningSignals.accountId, w.accountId));
  const movedIds = async (w: World): Promise<string[]> => (await db.select({ id: changeLog.entityId }).from(changeLog)
    .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "message"), eq(changeLog.op, "move"))))
    .map((r) => r.id);
  const unreadOf = async (id: string): Promise<boolean> =>
    (await db.select({ u: messages.unread }).from(messages).where(eq(messages.id, id)))[0]!.u;
  const act = (w: World) => screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
  /** The person's own request, for Put back. */
  const ctxOf = (w: World): ServiceContext =>
    ({ db: db as never, accountId: w.accountId, userId: null, now: () => new Date(), requestId: "act-put-back" });

  it("MUTATION-WATCH (j): a Spam deny bought on a forged letter files that letter alone and writes no rule", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "service@paypal.com";
    const { genuine, forged } = await genuineAndForged(w, sender, "unavailable");
    await suggest(w, forged, SPAM, 0.95);
    const r = await act(w);
    expect(await desiredOf(genuine), "the genuine letter rode the forgery's deny").toBe(SCREENER);
    expect(await accountRules(w), "a standing rule was written on a forgery's advice").toEqual([]);
    expect(await desiredOf(forged)).toBe(SPAM);
    expect(await unreadOf(forged), "an automatic filing marked a letter read").toBe(true);
    expect(await accountContacts(w)).toEqual([]);
    expect(await accountSignals(w), "the act taught a pattern from a forgery").toEqual([]);
    expect(await movedIds(w)).toEqual([forged]);
    expect(r).toMatchObject({ ran: true, examined: 1, filed: 0, kept: 1, failed: 0, unconfirmedDenies: 1 });
  });

  it("MUTATION-WATCH (j): the next pass on the same advice writes no rule either, and the genuine letter waits", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const { genuine, forged } = await genuineAndForged(w, "service@paypal.com", "unavailable");
    await suggest(w, forged, SPAM, 0.95);
    await act(w);
    // Every held letter is confirmed now, and the stored advice is still the forgery's.
    const again = await act(w);
    expect(await desiredOf(genuine), "the stale advice filed the genuine letter").toBe(SCREENER);
    expect(await accountRules(w), "the stale advice wrote the rule one pass later").toEqual([]);
    expect(await movedIds(w)).toEqual([forged]);
    expect(again).toMatchObject({ examined: 1, filed: 0, kept: 1, unconfirmedDenies: 1 });
  });

  it("(j) a failed letter's advice, capped to Spam, files that letter alone beside a genuine one", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const { genuine, forged } = await genuineAndForged(w, "service@paypal.com", "fail");
    // `capSuggestion` states a failed letter's advice as Spam at CAP_CONFIDENCE, which meets the bar.
    await suggest(w, forged, SPAM, CAP_CONFIDENCE);
    const r = await act(w);
    expect(await desiredOf(genuine), "the genuine letter rode a failed letter's deny").toBe(SCREENER);
    expect(await accountRules(w)).toEqual([]);
    expect(await desiredOf(forged)).toBe(SPAM);
    expect(r).toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1 });
  });

  it("MUTATION-WATCH (j): the same at an address no company owns, screened out", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const { genuine, forged } = await genuineAndForged(w, "anna@studio-nord.example", "unavailable");
    await suggest(w, forged, "ohmail/Screened", 0.95);
    const r = await act(w);
    expect(await desiredOf(genuine), "the genuine letter rode the forgery's screen-out").toBe(SCREENER);
    expect(await accountRules(w), "a screen-out rule was written on a forgery's advice").toEqual([]);
    expect(await desiredOf(forged)).toBe("ohmail/Screened");
    expect(r).toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1, unverified: 0 });
  });

  it("MUTATION-WATCH (j): NULL confirms nothing: a letter older than the column is filed alone", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const { genuine, forged } = await genuineAndForged(w, "offers@shop.test", null);
    await suggest(w, forged, SPAM, 0.95);
    const r = await act(w);
    expect(await desiredOf(forged), "a NULL letter read as confirmed").toBe(SPAM);
    expect(await desiredOf(genuine)).toBe(SCREENER);
    expect(await accountRules(w)).toEqual([]);
    expect(r).toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1 });
  });

  it("CONTROL (j): advice on a confirmed letter, every held letter confirmed, files the sender under the act's rule", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "service@paypal.com";
    const older = await held(w, sender);
    await db.update(messages).set({ date: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, older));
    const newer = await held(w, sender);
    await suggest(w, newer, SPAM, 0.95);
    const r = await act(w);
    expect(await desiredOf(older)).toBe(SPAM);
    expect(await desiredOf(newer)).toBe(SPAM);
    const written = await accountRules(w);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      kind: "sender", match: sender, destination: SPAM, provenance: "promoted", enabled: true, personDecidedAt: null,
    });
    expect(r).toMatchObject({ filed: 1, kept: 0, unconfirmedDenies: 0 });
  });

  it("MUTATION-WATCH (j): every letter unconfirmed, as at a provider whose word ohmail does not read: a forgery's advice files the forgery alone, never the address's other or later mail", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "anna@studio-nord.example";
    const first = await heldWithVerdict(w, sender, "unavailable");
    await db.update(messages).set({ date: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, first));
    const forged = await heldWithVerdict(w, sender, "unavailable");
    await db.update(messages).set({ date: new Date(Date.now() + 60_000) }).where(eq(messages.id, forged));
    await suggest(w, forged, SPAM, 0.95);
    expect(await act(w)).toMatchObject({ examined: 1, filed: 0, kept: 1, unconfirmedDenies: 1 });
    expect(await desiredOf(forged)).toBe(SPAM);
    expect(await desiredOf(first), "a letter rode advice bought on another letter").toBe(SCREENER);
    // Later letters, one per pass: the stored advice is the forgery's, which is gone, so it files none of them.
    const later: string[] = [];
    for (let i = 0; i < 3; i++) {
      later.push(await heldWithVerdict(w, sender, "unavailable"));
      expect(await act(w)).toMatchObject({ examined: 1, filed: 0, kept: 1, unconfirmedDenies: 1 });
    }
    for (const id of [first, ...later]) {
      expect(await desiredOf(id), "the forgery's advice filed the address's other mail").toBe(SCREENER);
      expect(await unreadOf(id)).toBe(true);
    }
    expect(await movedIds(w)).toEqual([forged]);
    expect(await accountRules(w)).toEqual([]);
  });

  it("MUTATION-WATCH (j): advice on a confirmed letter files every unconfirmed letter held beside it first, then the sender under the act's rule", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "service@paypal.com";
    const genuine = await held(w, sender);
    const unconfirmed = [await heldWithVerdict(w, sender, "unavailable"), await heldWithVerdict(w, sender, null)];
    await suggest(w, genuine, SPAM, 0.95);
    expect(await act(w)).toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1 });
    for (const id of unconfirmed) expect(await desiredOf(id), "an unconfirmed letter beside confirmed advice waited").toBe(SPAM);
    expect(await desiredOf(genuine)).toBe(SCREENER);
    expect(await accountRules(w)).toEqual([]);
    // Every held letter confirmed now, and the advice the sender's own: the rule.
    expect(await act(w)).toMatchObject({ filed: 1, unconfirmedDenies: 0 });
    expect(await desiredOf(genuine)).toBe(SPAM);
    expect(await accountRules(w)).toMatchObject([{ kind: "sender", match: sender, destination: SPAM, provenance: "promoted" }]);
  });

  it("MUTATION-WATCH (j): a letter filed with no rule is listed under Filed automatically, and put back it is never filed again", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const { genuine, forged } = await genuineAndForged(w, "anna@studio-nord.example", "unavailable");
    await suggest(w, forged, SPAM, 0.95);
    await act(w);
    expect((await autoFiledSummary(db, w.accountId)).items.map((i) => [i.messageId, i.to]),
      "the filing is not listed, so nothing puts it back").toEqual([[forged, SPAM]]);
    expect(await undoAutoFiled(ctxOf(w), { messageIds: [forged] })).toEqual({ putBack: [forged], requested: [] });
    expect(await desiredOf(forged)).toBe(SCREENER);
    expect((await autoFiledSummary(db, w.accountId)).items).toEqual([]);
    expect(await act(w)).toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1 });
    expect(await desiredOf(forged), "the act filed a letter the person put back").toBe(SCREENER);
    expect(await desiredOf(genuine)).toBe(SCREENER);
    expect(await accountRules(w)).toEqual([]);
  });

  it("(j) a sender whose advised letter the person put back takes no turn under the clock", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const putBack = await heldWithVerdict(w, "anna@studio-nord.example", "unavailable");
    await db.update(folderState).set({ autoFilingUndoneAt: new Date() }).where(eq(folderState.messageId, putBack));
    await suggest(w, putBack, SPAM, 0.95);
    // Waiting since later, so walked second.
    const later = await held(w, "deals@shop.test");
    await db.update(messages).set({ createdAt: new Date(Date.now() + 60_000) }).where(eq(messages.id, later));
    await suggest(w, later, SPAM, 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, until: () => true, consent: GIVEN });
    expect(await desiredOf(putBack)).toBe(SCREENER);
    expect(await desiredOf(later), "the put-back sender took the clock's one turn").toBe(SPAM);
    expect(r).toMatchObject({ examined: 2, filed: 1, capped: false, unconfirmedDenies: 1 });
  });

  it("(j) advice on a confirmed letter whose unconfirmed neighbour the person put back files the sender under the rule, and that letter stays", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "service@paypal.com";
    const genuine = await held(w, sender);
    const putBack = await heldWithVerdict(w, sender, "unavailable");
    await db.update(folderState).set({ autoFilingUndoneAt: new Date() }).where(eq(folderState.messageId, putBack));
    await suggest(w, genuine, SPAM, 0.95);
    expect(await act(w)).toMatchObject({ filed: 1, kept: 0, unconfirmedDenies: 0 });
    expect(await desiredOf(genuine)).toBe(SPAM);
    expect(await desiredOf(putBack), "an automatic decision filed a letter the person put back").toBe(SCREENER);
    expect(await rulesFor(w, sender)).toHaveLength(1);
  });

  it("MUTATION-WATCH (j): another sender's unconfirmed letter leaves a confirmed sender's deny whole; the same address's does not", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    // Confirmed, every held letter confirmed: filed under the act's rule, whoever else waits.
    const whole = "deals@shop.test";
    const wholeOld = await held(w, whole);
    await db.update(messages).set({ date: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, wholeOld));
    const wholeNew = await held(w, whole);
    await suggest(w, wholeNew, SPAM, 0.95);
    // A stranger, unconfirmed, no advice: waits, and decides nothing for anybody else.
    const stranger = await heldWithVerdict(w, "anna@studio-nord.example", "unavailable");
    // CONTROL in the same account: an address with an unconfirmed letter of its own is filed in part.
    const mixed = "service@paypal.com";
    const { genuine, forged } = await genuineAndForged(w, mixed, "unavailable");
    await suggest(w, forged, SPAM, 0.95);

    const r = await act(w);
    expect(await rulesFor(w, whole), "a confirmed sender's deny was cut for another sender's letter").toHaveLength(1);
    expect(await desiredOf(wholeOld)).toBe(SPAM);
    expect(await desiredOf(wholeNew)).toBe(SPAM);
    expect(await desiredOf(stranger)).toBe(SCREENER);
    expect(await desiredOf(genuine)).toBe(SCREENER);
    expect(await desiredOf(forged)).toBe(SPAM);
    expect(await rulesFor(w, mixed)).toHaveLength(0);
    expect(r).toMatchObject({ examined: 3, filed: 1, kept: 2, unconfirmedDenies: 1 });
  });

  it("(j) a letter the person put back stays where they put it; the unconfirmed one beside it is filed", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const { genuine, forged } = await genuineAndForged(w, "service@paypal.com", "unavailable");
    const putBack = await heldWithVerdict(w, "service@paypal.com", "unavailable");
    await db.update(folderState).set({ autoFilingUndoneAt: new Date() }).where(eq(folderState.messageId, putBack));
    await suggest(w, forged, SPAM, 0.95);
    const r = await act(w);
    expect(await desiredOf(putBack), "an automatic filing moved a letter the person put back").toBe(SCREENER);
    expect(await desiredOf(forged)).toBe(SPAM);
    expect(await desiredOf(genuine)).toBe(SCREENER);
    expect(await accountRules(w)).toEqual([]);
    expect(r).toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1 });
  });

  it("(j) a forged letter in the account's other mailbox is filed; the genuine one waits, and no rule is written", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const [other] = await db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: `two-${w.accountId.slice(0, 8)}@example.test`,
    }).returning();
    const sender = "noreply@post.ch";
    const genuine = await held(w, sender);
    await db.update(messages).set({ date: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, genuine));
    const forged = await heldWithVerdict({ accountId: w.accountId, mailboxId: other!.id }, sender, "unavailable");
    await suggest(w, forged, SPAM, 0.95);
    const r = await act(w);
    expect(await desiredOf(forged)).toBe(SPAM);
    expect(await desiredOf(genuine), "the genuine letter rode the other mailbox's forgery").toBe(SCREENER);
    expect(await accountRules(w)).toEqual([]);
    expect(r).toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1 });
  });

  it("(j) a refused filing of unconfirmed letters is counted failed and recorded, and moves nothing", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const { genuine, forged } = await genuineAndForged(w, "service@paypal.com", "unavailable");
    await suggest(w, forged, SPAM, 0.95);
    // A store fault at every held letter's move, on both stores; nothing else throws.
    type Fn = (...a: unknown[]) => unknown;
    const moveFault = <H extends object>(h: H): H => new Proxy(h, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv) as unknown;
        if (typeof v !== "function") return v;
        if (prop === "insert") {
          return (table: unknown, ...a: unknown[]) => {
            if (table === folderState) throw new Error("injected store fault");
            return (v as Fn).call(t, table, ...a);
          };
        }
        if (prop === "transaction") return (fn: Fn, ...a: unknown[]) => (v as Fn).call(t, (tx: H) => fn(moveFault(tx)), ...a);
        return (v as Fn).bind(t);
      },
    }) as H;
    const r = await screenerAutoActPass(moveFault(db), { accountId: w.accountId, consent: GIVEN });
    expect(await desiredOf(forged), "a refused filing moved a letter").toBe(SCREENER);
    expect(await desiredOf(genuine)).toBe(SCREENER);
    expect(await accountRules(w)).toEqual([]);
    const refusals = await db.select({ why: routingDecisions.actRefusal }).from(routingDecisions)
      .where(eq(routingDecisions.accountId, w.accountId));
    expect(refusals.map((x) => x.why)).toEqual(["store_fault"]);
    expect(r).toMatchObject({ ran: true, filed: 0, failed: 1, unconfirmedDenies: 0 });
  });

  it("(j) stale advice, about a letter no longer held, is decided before the clock and takes no turn", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const { genuine, forged } = await genuineAndForged(w, "service@paypal.com", "unavailable");
    await suggest(w, forged, SPAM, 0.95);
    await act(w);
    // Waiting since earlier, so walked first: the stored advice is the forgery's, and only the genuine letter is held.
    const later = await held(w, "deals@shop.test");
    await db.update(messages).set({ createdAt: new Date(Date.now() + 60_000) }).where(eq(messages.id, later));
    await suggest(w, later, SPAM, 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, until: () => true, consent: GIVEN });
    expect(await desiredOf(later), "the stale sender took the clock's one turn").toBe(SPAM);
    expect(await desiredOf(genuine)).toBe(SCREENER);
    expect(r).toMatchObject({ examined: 2, filed: 1, capped: false, unconfirmedDenies: 1 });
  });

  it("(j) the line says how many senders and letters, and the real logger keeps both numbers", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const { forged } = await genuineAndForged(w, "service@paypal.com", "unavailable");
    await suggest(w, forged, SPAM, 0.95);
    const lines: string[] = [];
    const log = createLogger({ service: "worker", level: "info", sink: (line) => { lines.push(line); } });
    await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN, log });
    const line = lines.find((l) => l.includes("screener_auto_act_unconfirmed_denied"));
    expect(line, "the pass said nothing about the senders it filed in part").toBeDefined();
    expect(line, "the logger's census refused a field the line passed").not.toContain("droppedFields");
    expect(JSON.parse(line!)).toMatchObject({ accountId: w.accountId, skipped: 1, moved: 1 });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (k) A DENY THAT RESTS ON OTHER SENDERS' MAIL — nothing standing is written. The suggest pass
  //      caps a first-time sender to Spam at 0.9 or the model's higher number when its subject also
  //      came from another first-time sender's domain, which meets the act's bar. That is no fact
  //      about this address: two shops' receipts share "Your order has shipped". So the advice
  //      files the advised letter alone, like advice on an unconfirmed letter, and a row stored
  //      before the reason was fails the same way. Bought end to end through the suggest pass.
  // ══════════════════════════════════════════════════════════════════════════════════════════

  const SHIPPED = "Your order has shipped";
  /** Automatic suggestions on since long before any letter here, every sender in scope. */
  async function suggestOn(w: World): Promise<void> {
    const since = new Date("2020-01-01T00:00:00Z");
    await db.insert(accountSettings).values({ accountId: w.accountId, screeningScope: "all_time", autoSuggestAt: since })
      .onConflictDoUpdate({ target: accountSettings.accountId, set: { screeningScope: "all_time", autoSuggestAt: since } });
  }
  /** A confirmed letter held under `subject`. */
  async function heldAbout(w: World, from: string, subject: string): Promise<string> {
    const id = await held(w, from);
    await db.update(messages).set({ subject, snippet: "Thanks for shopping with us." }).where(eq(messages.id, id));
    return id;
  }
  /** A model that gives every sender the same answer. */
  const answering = (answer: ClassifierResult): ClassifierPort => ({ classify: async () => answer, screen: async () => answer });
  const RECEIPTS_095: ClassifierResult = { destination: "ohmail/Receipts", confidence: 0.95, rationale: "an order receipt", spam: false };
  const buy = (w: World, model: ClassifierPort) =>
    screenerAutoSuggestPass(db, { accountId: w.accountId, classifier: model, unmetered: true });
  const storedFor = async (id: string) =>
    (await db.select().from(routingDecisions).where(eq(routingDecisions.messageId, id)))[0]!;

  it("MUTATION-WATCH (k): three confirmed shops, one subject, a receipts answer: each advised letter is filed alone, no rule, later mail waits", async () => {
    const w = await newWorld();
    await suggestOn(w);
    // The first shop's older letter, under its own subject, waits beside the advised one.
    const older = await heldAbout(w, "orders@shop-a.test", "Your invoice for March");
    await db.update(messages).set({ date: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, older));
    const advised = [
      await heldAbout(w, "orders@shop-a.test", SHIPPED),
      await heldAbout(w, "orders@shop-b.test", SHIPPED),
      await heldAbout(w, "orders@shop-c.test", SHIPPED),
    ];
    expect(await buy(w, answering(RECEIPTS_095))).toMatchObject({ ran: true, bought: 3 });
    // The crowd's cap, as stored: Spam at the act's bar from a model that said Receipts.
    for (const id of advised) {
      const row = await storedFor(id);
      expect(row).toMatchObject({ destination: SPAM, spam: true });
      expect(row.confidence).toBeGreaterThanOrEqual(SCREENER_ACT_DENY_BAR);
    }

    const r = await act(w);
    expect(await accountRules(w), "a standing rule was written from other senders' mail").toEqual([]);
    for (const id of advised) {
      expect(await desiredOf(id)).toBe(SPAM);
      expect(await unreadOf(id), "an automatic filing marked a letter read").toBe(true);
    }
    expect(await desiredOf(older), "a letter rode advice bought on another").toBe(SCREENER);
    expect(await accountContacts(w)).toEqual([]);
    expect(await accountSignals(w), "the act taught a pattern from the crowd's cap").toEqual([]);
    expect(r).toMatchObject({ examined: 3, filed: 0, kept: 3, failed: 0, crowdDenies: 3, unconfirmedDenies: 0 });
    // Why: each row says the crowd capped it.
    for (const id of advised) expect((await storedFor(id)).senderReason).toBe("campaign");

    // Each filing is listed under Filed automatically, and Put back returns it for good.
    expect((await autoFiledSummary(db, w.accountId)).items.map((i) => [i.messageId, i.to]).sort())
      .toEqual(advised.map((id) => [id, SPAM]).sort());
    expect(await undoAutoFiled(ctxOf(w), { messageIds: [advised[1]] })).toEqual({ putBack: [advised[1]], requested: [] });
    expect(await desiredOf(advised[1]!)).toBe(SCREENER);

    // The first shop writes again; no new advice is bought for an advised sender, and the stored one
    // files nothing more.
    const later = await heldAbout(w, "orders@shop-a.test", "Your parcel is out for delivery");
    await db.update(messages).set({ date: new Date(Date.now() + 60_000) }).where(eq(messages.id, later));
    expect(await buy(w, answering(RECEIPTS_095))).toMatchObject({ bought: 0 });
    const again = await act(w);
    expect(await desiredOf(later), "the crowd's advice filed the address's later mail").toBe(SCREENER);
    expect(await desiredOf(older)).toBe(SCREENER);
    expect(await desiredOf(advised[1]!), "the act filed a letter the person put back").toBe(SCREENER);
    expect(await accountRules(w)).toEqual([]);
    expect(again).toMatchObject({ examined: 2, filed: 0, kept: 2, crowdDenies: 2 });
  });

  it("CONTROL (k): the same shops under their own subjects, the model itself saying Spam: stored none, and each sender is filed under the act's rule", async () => {
    const w = await newWorld();
    await suggestOn(w);
    const letters = [
      await heldAbout(w, "orders@shop-a.test", SHIPPED),
      await heldAbout(w, "orders@shop-b.test", "Welcome to our loyalty club"),
      await heldAbout(w, "orders@shop-c.test", "Password policy update notice"),
    ];
    expect(await buy(w, answering({ destination: SPAM, confidence: 0.95, rationale: "bulk", spam: true })))
      .toMatchObject({ bought: 3 });
    for (const id of letters) expect(await storedFor(id)).toMatchObject({ destination: SPAM, senderReason: "none" });
    const r = await act(w);
    for (const id of letters) expect(await desiredOf(id)).toBe(SPAM);
    expect((await accountRules(w)).map((x) => [x.match, x.destination, x.provenance, x.enabled]).sort()).toEqual([
      ["orders@shop-a.test", SPAM, "promoted", true],
      ["orders@shop-b.test", SPAM, "promoted", true],
      ["orders@shop-c.test", SPAM, "promoted", true],
    ]);
    expect(r).toMatchObject({ filed: 3, kept: 0, crowdDenies: 0, unconfirmedDenies: 0 });
  });

  it("MUTATION-WATCH (k): advice stored before the reason was, on a confirmed letter, files that letter alone and writes no rule", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "deals@shop.test";
    const older = await held(w, sender);
    await db.update(messages).set({ date: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, older));
    const advised = await held(w, sender);
    await suggest(w, advised, SPAM, 0.95, null);
    const r = await act(w);
    expect(await accountRules(w), "a row with no reason wrote a standing rule").toEqual([]);
    expect(await desiredOf(advised)).toBe(SPAM);
    expect(await desiredOf(older), "a letter rode advice stored about another").toBe(SCREENER);
    expect(await movedIds(w)).toEqual([advised]);
    expect(r).toMatchObject({ filed: 0, kept: 1, crowdDenies: 1, unconfirmedDenies: 0 });
  });

  for (const [reason, rules] of [
    ["none", 1], ["impersonation", 1], ["brand_mismatch", 1],
    ["campaign", 0], ["auth_fail", 0], ["correspondent", 0], [null, 0], ["no_such_reason", 0],
  ] as const) {
    it(`(k) a confident deny on a confirmed letter, stored under ${String(reason)}, ${rules ? "writes the sender's rule" : "files that letter alone"}`, async () => {
      const w = await newWorld();
      await settingsRow(w, false);
      const sender = "deals@shop.test";
      const older = await held(w, sender);
      await db.update(messages).set({ date: new Date("2020-01-01T00:00:00Z") }).where(eq(messages.id, older));
      const advised = await held(w, sender);
      await suggest(w, advised, SPAM, 0.95, reason);
      const r = await act(w);
      expect(await accountRules(w)).toHaveLength(rules);
      expect(await desiredOf(advised)).toBe(SPAM);
      expect(await desiredOf(older)).toBe(rules ? SPAM : SCREENER);
      expect(r).toMatchObject(rules ? { filed: 1, crowdDenies: 0 } : { filed: 0, kept: 1, crowdDenies: 1 });
    });
  }

  it("(k) on an unconfirmed letter the stored reason changes nothing: none, campaign and NULL each file that letter alone, as (j)", async () => {
    for (const reason of ["none", "campaign", null]) {
      const w = await newWorld();
      await settingsRow(w, false);
      const { genuine, forged } = await genuineAndForged(w, "anna@studio-nord.example", "unavailable");
      await suggest(w, forged, SPAM, 0.95, reason);
      const r = await act(w);
      expect(await desiredOf(forged), String(reason)).toBe(SPAM);
      expect(await desiredOf(genuine), String(reason)).toBe(SCREENER);
      expect(await accountRules(w)).toEqual([]);
      expect(r, String(reason)).toMatchObject({ filed: 0, kept: 1, unconfirmedDenies: 1, crowdDenies: 0 });
    }
  });

  it("(k) a confirmed advised letter that is sensitive, or put back, is not filed and takes no turn under the clock", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    // Two senders whose crowd-capped advice is about a letter no automatic filing may move.
    const sensitive = await held(w, "codes@shop-a.test");
    const newer = await held(w, "codes@shop-a.test");
    await db.update(messages).set({ sensitivityCategory: "otp" }).where(eq(messages.id, sensitive));
    await db.update(messages).set({ date: new Date(Date.now() + 60_000) }).where(eq(messages.id, newer));
    await suggest(w, sensitive, SPAM, 0.95, "campaign");
    const putBack = await held(w, "orders@shop-b.test");
    await db.update(folderState).set({ autoFilingUndoneAt: new Date() }).where(eq(folderState.messageId, putBack));
    await suggest(w, putBack, SPAM, 0.95, "campaign");
    // Waiting since later, so walked last.
    const last = await held(w, "deals@shop.test");
    await db.update(messages).set({ createdAt: new Date(Date.now() + 60_000) }).where(eq(messages.id, last));
    await suggest(w, last, SPAM, 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, until: () => true, consent: GIVEN });
    expect(await desiredOf(sensitive), "an automatic filing moved a sensitive letter").toBe(SCREENER);
    expect(await desiredOf(newer)).toBe(SCREENER);
    expect(await desiredOf(putBack), "an automatic filing moved a letter the person put back").toBe(SCREENER);
    expect(await desiredOf(last), "a sender with nothing to file took the clock's one turn").toBe(SPAM);
    expect(await rulesFor(w, "codes@shop-a.test")).toHaveLength(0);
    // The sender holding a code is not selected at all (l).
    expect(r).toMatchObject({ examined: 2, filed: 1, capped: false, crowdDenies: 1 });
  });

  it("(k) the line says how many senders and letters, and the real logger keeps both numbers", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    await suggest(w, await held(w, "orders@shop-a.test"), SPAM, 0.95, "campaign");
    const lines: string[] = [];
    const log = createLogger({ service: "worker", level: "info", sink: (line) => { lines.push(line); } });
    await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN, log });
    const line = lines.find((l) => l.includes("screener_auto_act_crowd_denied"));
    expect(line, "the pass said nothing about the senders it filed one letter of").toBeDefined();
    expect(line, "the logger's census refused a field the line passed").not.toContain("droppedFields");
    expect(JSON.parse(line!)).toMatchObject({ accountId: w.accountId, skipped: 1, moved: 1 });
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  (l) SENSITIVE HELD MAIL — a held code or reset stays where the person sees it
  // ══════════════════════════════════════════════════════════════════════════════════════════

  /** A held letter of a sensitive class, as the detector stores it. */
  async function heldSensitive(w: World, from: string, category: string, verdict: string | null = "pass"): Promise<string> {
    const id = await held(w, from);
    await db.update(messages).set({ sensitivityCategory: category, authVerdict: verdict }).where(eq(messages.id, id));
    return id;
  }
  const later = async (id: string) => {
    await db.update(messages).set({ date: new Date(Date.now() + 60_000) }).where(eq(messages.id, id));
  };

  it("MUTATION-WATCH (l): admit advice on a benign newest letter never files the one-time code held beside it", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "login@shop.test";
    const code = await heldSensitive(w, sender, "otp");
    const benign = await held(w, sender);
    await later(benign);
    await suggest(w, benign, "INBOX", 0.95);
    const r = await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
    expect(r).toMatchObject({ ran: true, filed: 0 });
    expect(await desiredOf(code), "the act filed a held one-time code").toBe(SCREENER);
    expect(await desiredOf(benign)).toBe(SCREENER);
    expect(await rulesFor(w, sender)).toHaveLength(0);
  });

  it("MUTATION-WATCH (l): a standing deny leaves an unconfirmed password reset at the gate, pass after pass, and writes no rule", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "accounts@shop.test";
    const reset = await heldSensitive(w, sender, "password_reset", "unavailable");
    const advised = await held(w, sender);
    await later(advised);
    await suggest(w, advised, SPAM, 0.95);
    for (const pass of [1, 2]) {
      await screenerAutoActPass(db, { accountId: w.accountId, consent: GIVEN });
      expect(await desiredOf(reset), `pass ${pass} filed a held password reset`).toBe(SCREENER);
      expect(await rulesFor(w, sender), `pass ${pass} wrote a rule`).toHaveLength(0);
    }
  });

  it("CONTROL (l): a person's press over the same bag files the code", async () => {
    const w = await newWorld();
    await settingsRow(w, false);
    const sender = "login@shop.test";
    const code = await heldSensitive(w, sender, "otp");
    type InTx = (f: (tx: Tx) => Promise<unknown>) => Promise<unknown>;
    const inTx = (db as unknown as { transaction: InTx }).transaction.bind(db) as InTx;
    const pressed = await inTx((tx) => applyScreenerDecision(tx, {
      accountId: w.accountId, scope: "sender", address: sender, appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:press:${code}`, now: new Date(), stampBaseline: false, applyRetro: true,
      overExisting: "converge", liftOverDomain: true, decidedBy: "person",
    })) as Awaited<ReturnType<typeof applyScreenerDecision>>;
    expect(pressed.skipped).toBeUndefined();
    expect(await desiredOf(code)).toBe("INBOX");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  THE PREDICATE, ALONE — the one the manual door validates with
// ══════════════════════════════════════════════════════════════════════════════════════════════

describe("plannedDecision — advice becomes the decision a press would make, or nothing", () => {
  const bars = { deny: SCREENER_ACT_DENY_BAR, admit: SCREENER_ACT_ADMIT_BAR };
  const plan = (
    destination: string, confidence: number | null, authVerdict: string | null = "pass", senderReason: string | null = "none",
  ) => plannedDecision("who@x.test", { id: "s1", messageId: "m1", destination, confidence, authVerdict, senderReason }, bars);

  it("the advice is confirmed only when its letter's provider said pass", () => {
    expect(plan(SPAM, 0.95)).toMatchObject({ decision: "no", confirmed: true });
    for (const verdict of ["unavailable", "unauthenticated", "fail", null]) {
      expect(plan(SPAM, 0.95, verdict), String(verdict)).toMatchObject({ decision: "no", confirmed: false });
    }
  });

  it("a deny stands as a rule only on a confirmed letter and a reason about that letter", () => {
    for (const reason of ["none", "impersonation", "brand_mismatch"]) {
      expect(plan(SPAM, 0.95, "pass", reason), reason).toMatchObject({ decision: "no", standing: true });
      expect(plan(SPAM, 0.95, "unavailable", reason), reason).toMatchObject({ decision: "no", standing: false });
    }
    for (const reason of ["campaign", "auth_fail", "correspondent", null, "unknown"]) {
      expect(plan(SPAM, 0.95, "pass", reason), String(reason)).toMatchObject({ decision: "no", confirmed: true, standing: false });
    }
    // The reason bounds a deny only: an admission is decided by its own gates.
    expect(plan("INBOX", 0.95, "pass", "campaign")).toMatchObject({ decision: "yes" });
  });

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
