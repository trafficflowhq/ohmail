import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, changeLog, contacts, folderState, mailboxes, messageBodies,
  messageStates, messages, rules, type Tx,
  accountPass, readPassProgress,
} from "@trafficflow/db";
import { gateReleasePass } from "../src/gate-release.js";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * ═══ THE ONE-TIME REPAIR FOR AN ACCOUNT THAT ALREADY CONFIRMED ITS SEED ═══════════════════
 *
 * ── WHAT IT IS FOR ────────────────────────────────────────────────────────────────────────
 *
 * 0.19.0 makes the seed confirmation release what the gate is holding from the people it names.
 * That does nothing for an account that confirmed one BEFORE — its rules carry no retro request,
 * a NULL there is not owed work, and the mail imported before the confirmation is behind a
 * decision nothing will ever act on. This pass arms the release licence on those rules, releases
 * what the gate holds from senders who are only `contacts` rows, and stamps the account once.
 *
 * ── THE FIXTURE IS THE REPORTED SHAPE ─────────────────────────────────────────────────────
 *
 *  · `known@`    — a held row at the gate stamped `'us'`, a row in the Ohbox, a row FILED BY HAND
 *                  into Reads, and an enabled `seeded-from-sent` rule with no retro request.
 *  · `pal@`      — a held row, a row they filed BY HAND into Reads, and a `contacts` row. No rule:
 *                  nothing to arm, and no group on the release screen either, so this pass is the
 *                  only thing that reaches them — and the only thing keeping the hand file put.
 *  · `blocked@`  — a held row, a `contacts` row AND an enabled `manual` rule to Screened. A deny
 *                  decision: not armed, and NOT released to the Ohbox on the contact's strength.
 *  · `stranger@` — a held row and nothing else. The control: something must still be at the gate
 *                  afterwards, or every assertion here is satisfied by a pass that empties it.
 *  · `triaged@`  — a held row, a `contacts` row, and a `message_states` row. The person has
 *                  already acted on it, so it is theirs.
 *
 * ── MUTATIONS WATCHED (each restored by `cmp`) ────────────────────────────────────────────
 *
 *  · drop the `contacts` EXISTS from half two      ⇒ 2 RED, "a STRANGER's mail stays at the gate"
 *      among them: two rows released instead of one, and the stranger's is filed into the Ohbox.
 *  · drop the `not ruleClaimsAuthor(any)` arm      ⇒ 4 RED, "a DENY decision is never released"
 *      among them: three rows released, the deny-ruled contact's into the Ohbox.
 *  · drop the two gate equalities from `atTheGate` ⇒ 3 RED, "the contact-only sender's HAND FILE
 *      is untouched" among them: their hand file in Reads is filed into the Ohbox.
 *  · drop the not-already-owed arm                 ⇒ 2 RED: the paging case re-arms the SAME rule
 *      for ever and never advances, and `force` re-arms a rule already in flight.
 */

const GATE = "ohmail/Screener";
const OHBOX = "INBOX";
const READS = "ohmail/News";
const NOW = new Date("2026-09-13T20:00:00.000Z");
const IMPORTED = new Date("2026-08-04T00:18:00.000Z");
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

interface World {
  db: Awaited<ReturnType<typeof makeTestDb>>;
  accountId: string;
  mailboxId: string;
  ids: Record<string, string>;
  ruleIds: Record<string, string>;
}

async function seed(role: "organizer" | "reader" = "organizer"): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `gr-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    organizerRole: role,
  }).returning();
  const w: World = { db, accountId, mailboxId: mb!.id, ids: {}, ruleIds: {} };

  let n = 0;
  const message = async (key: string, o: {
    from: string; desired: string; lastSetBy: string;
  }): Promise<void> => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: w.mailboxId, bodyHash: `h${i}`, dedupKey: `gr:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: o.from, date: IMPORTED, unread: true,
      createdAt: IMPORTED, nativeLocator: { folder: o.desired, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: o.desired, observedFolder: o.desired,
      lastSetBy: o.lastSetBy, reconcileStatus: "reconciled", conflict: false,
    });
    w.ids[key] = m!.id;
  };

  await message("knownHeld", { from: "known@x.test", desired: GATE, lastSetBy: "us" });
  await message("knownOhbox", { from: "known@x.test", desired: OHBOX, lastSetBy: "us" });
  await message("knownHand", { from: "known@x.test", desired: READS, lastSetBy: "external" });
  await message("palHeld", { from: "pal@x.test", desired: GATE, lastSetBy: "us" });
  // The contact-only sender's OWN past: a message they filed by hand into Reads. Half two has no
  // rule engine behind it, so the two gate equalities are the only thing keeping this row put.
  await message("palHand", { from: "pal@x.test", desired: READS, lastSetBy: "external" });
  await message("blockedHeld", { from: "blocked@x.test", desired: GATE, lastSetBy: "us" });
  await message("strangerHeld", { from: "stranger@x.test", desired: GATE, lastSetBy: "us" });
  await message("triagedHeld", { from: "triaged@x.test", desired: GATE, lastSetBy: "us" });
  await db.insert(messageStates).values({
    messageId: w.ids.triagedHeld!, accountId, state: "bubbled_up",
  });

  const [seeded] = await db.insert(rules).values({
    accountId, kind: "sender", match: "known@x.test", destination: OHBOX,
    provenance: "seeded-from-sent", enabled: true, priority: 0,
    // THE PRE-0.19.0 STATE, and the whole reason this pass exists: nothing is owed for it.
    retroRequestedAt: null, releaseHeldAt: null,
  }).returning();
  w.ruleIds.known = seeded!.id;
  const [deny] = await db.insert(rules).values({
    accountId, kind: "sender", match: "blocked@x.test", destination: "ohmail/Screened",
    provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
  }).returning();
  w.ruleIds.blocked = deny!.id;

  for (const address of ["known@x.test", "pal@x.test", "blocked@x.test", "triaged@x.test"]) {
    await db.insert(contacts).values({ accountId, address });
  }
  return w;
}

const desiredOf = async (w: World, key: string): Promise<string> => {
  const [r] = await w.db.select().from(folderState)
    .where(eq(folderState.messageId, w.ids[key]!));
  return r!.desiredFolder;
};

const movesFor = async (w: World, key: string): Promise<number> =>
  (await w.db.select().from(changeLog).where(and(
    eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, w.ids[key]!),
    eq(changeLog.op, "move"),
  ))).length;

const sweep = (w: World, extra: Record<string, unknown> = {}) =>
  gateReleasePass(w.db as unknown as Tx, { accountId: w.accountId, ...extra }, NOW);

const retro = (w: World) => ruleRetroPass(
  w.db as unknown as Tx,
  { accountId: w.accountId, trustedAuthservIdsFor: NONE },
  new Date("2026-09-13T20:00:01.000Z"),
);

describe("the one-time gate release", () => {
  it("arms the seeded rule and releases the contact-only sender, then stamps the account", async () => {
    const w = await seed();
    const out = await sweep(w);
    expect(out.ran).toBe(true);
    // ONE rule: `known@`'s. The deny rule is not an allow decision and is never armed.
    expect(out.rulesArmed).toBe(1);
    expect(out.contactRowsReleased).toBe(1);
    expect(out.completed).toBe(true);

    const [r] = await w.db.select().from(rules).where(eq(rules.id, w.ruleIds.known!));
    expect(r!.releaseHeldAt).not.toBeNull();
    // The release SHAPE, to the millisecond — `isReleaseRun` compares `getTime()`.
    expect(r!.releaseHeldAt!.getTime()).toBe(r!.retroRequestedAt!.getTime());
    expect(r!.retroDoneAt).toBeNull();

    expect((await readPassProgress(w.db, accountPass("gate_release", w.accountId))).doneAt).not.toBeNull();
  });

  it("the retro pass then files the armed sender's held mail, and ONLY that", async () => {
    const w = await seed();
    await sweep(w);
    const out = await retro(w);
    expect(out.moved).toBe(1);
    expect(await desiredOf(w, "knownHeld")).toBe(OHBOX);
    // The past does not move: a hand file in Reads and a row already in the Ohbox are untouched.
    expect(await desiredOf(w, "knownHand")).toBe(READS);
    expect(await movesFor(w, "knownHand")).toBe(0);
    expect(await desiredOf(w, "knownOhbox")).toBe(OHBOX);
    expect(await movesFor(w, "knownOhbox")).toBe(0);
  });

  it("the contact-only sender's held mail is desired into the Ohbox, with its change row", async () => {
    const w = await seed();
    await sweep(w);
    expect(await desiredOf(w, "palHeld")).toBe(OHBOX);
    expect(await movesFor(w, "palHeld")).toBe(1);
    const [row] = await w.db.select().from(changeLog).where(and(
      eq(changeLog.accountId, w.accountId), eq(changeLog.entityId, w.ids.palHeld!),
      eq(changeLog.op, "move"),
    ));
    // The TRUE previous desired folder rides in `meta.from`, which is what makes an undo possible.
    expect((row!.meta as { from: string; to: string }).from).toBe(GATE);
    expect((row!.meta as { from: string; to: string }).to).toBe(OHBOX);
  });

  it("the contact-only sender's HAND FILE is untouched — this half moves nothing outside the gate", async () => {
    // Half two writes `folder_state` itself, with no rule engine to narrow it afterwards, so the
    // two gate equalities are its whole "must not move the past".
    const w = await seed();
    await sweep(w);
    expect(await desiredOf(w, "palHand")).toBe(READS);
    expect(await movesFor(w, "palHand")).toBe(0);
  });

  it("a DENY decision is never released to the Ohbox, contact row or not", async () => {
    const w = await seed();
    await sweep(w);
    await retro(w);
    expect(await desiredOf(w, "blockedHeld")).toBe(GATE);
    expect(await movesFor(w, "blockedHeld")).toBe(0);
  });

  it("a STRANGER's mail stays at the gate — this is a repair, not an amnesty", async () => {
    const w = await seed();
    await sweep(w);
    await retro(w);
    expect(await desiredOf(w, "strangerHeld")).toBe(GATE);
    expect(await movesFor(w, "strangerHeld")).toBe(0);
  });

  it("a message the person has already acted on is theirs", async () => {
    const w = await seed();
    await sweep(w);
    expect(await desiredOf(w, "triagedHeld")).toBe(GATE);
    expect(await movesFor(w, "triagedHeld")).toBe(0);
  });

  it("runs ONCE — a second sweep reads the marker and does nothing", async () => {
    const w = await seed();
    await sweep(w);
    const again = await sweep(w);
    expect(again.ran).toBe(false);
    expect(again.rulesArmed).toBe(0);
    expect(again.contactRowsReleased).toBe(0);
  });

  it("IDEMPOTENT WITHOUT THE MARKER — `force` over a swept account writes nothing", async () => {
    // The claim the marker rests on, exercised rather than asserted: an armed rule is in flight
    // and drops out of its own selection, and a released row is desired into the Ohbox and is no
    // longer at the gate.
    const w = await seed();
    await sweep(w);
    const forced = await sweep(w, { force: true });
    expect(forced.ran).toBe(true);
    expect(forced.rulesArmed).toBe(0);
    expect(forced.contactRowsReleased).toBe(0);
    expect(await movesFor(w, "palHeld")).toBe(1);
  });

  it("an account this install only READS is not swept and is not stamped", async () => {
    // Stamping it would swallow the repair for ever on the one state a later promotion can honour.
    const w = await seed("reader");
    const out = await sweep(w);
    expect(out.ran).toBe(false);
    expect(out.completed).toBe(false);
    expect((await readPassProgress(w.db, accountPass("gate_release", w.accountId))).doneAt).toBeNull();
    expect(await desiredOf(w, "knownHeld")).toBe(GATE);
  });

  it("A FULL PAGE IS NOT A FINISHED SWEEP — it resumes and stamps on the short one", async () => {
    // With `batch: 1` the first cycle arms one rule and cannot claim completion. The second cycle
    // must select a DIFFERENT rule: a rule already armed is in flight, so it drops out. Without
    // that arm the same rule is re-armed every cycle and the account never finishes.
    const w = await seed();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "pal@x.test", destination: OHBOX,
      provenance: "seeded-from-sent", enabled: true, priority: 0, retroRequestedAt: null,
    });
    const first = await sweep(w, { batch: 1 });
    expect(first.rulesArmed).toBe(1);
    expect(first.completed).toBe(false);

    const second = await sweep(w, { batch: 1 });
    expect(second.rulesArmed).toBe(1);
    expect(second.completed).toBe(false);   // the contact-only half still had a full page of 1

    const third = await sweep(w, { batch: 1 });
    expect(third.rulesArmed).toBe(0);
    expect(third.contactRowsReleased).toBe(0);
    expect(third.completed).toBe(true);

    const armed = await w.db.select().from(rules).where(eq(rules.accountId, w.accountId));
    const withLicence = armed.filter((r) => r.releaseHeldAt !== null);
    expect(withLicence.map((r) => r.match).sort()).toEqual(["known@x.test", "pal@x.test"]);
  });
});
