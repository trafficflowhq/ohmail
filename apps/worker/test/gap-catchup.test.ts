import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, approvals, auditLog, changeLog, contacts, drafts, folderState, mailboxFolders, mailboxes, messageBodies,
  messageInstances, messageStates, messageTags, messages, routingDecisions, rules, tags, threads,
  type Tx,
} from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  type OrganizerProfileDoc, type ProfileRuleEntry,
} from "@trafficflow/core/adapters/organizer-profile";
import { applyOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { OHBOX_UNSCREENED_GROUPS_MAX as GROUPS } from "@trafficflow/core/adapters/drizzle-repo";
import type { Logger, SweepClearance } from "@trafficflow/core/mail";
import { gapCatchupPass } from "../src/gap-catchup.js";
import { markMailboxStoodDown } from "../src/mailboxes.js";

/**
 * LETTERS FROM A GAP: COUNTED, AND FILED ONLY ON THE PERSON'S PRESS (review HIGH-1).
 * A reader adopts an INBOX arrival as `'peer'`; the window is the gap it is looking at now
 * (`gap_since`), and a letter belongs to it only if it ARRIVED and was TAKEN IN inside it. The pass
 * counts what the person's rules would file and moves nothing; on the press it files that set when
 * the count still holds. Every refusal sits beside a control that is counted. The transactional
 * half is `gap-catchup.pg.test.ts`.
 */

const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
const INBOX = "INBOX";
const NEWS = "ohmail/News";
const RULE_MADE = new Date("2026-10-01T00:00:00Z");
const BEFORE_GAP = new Date("2026-10-09T09:00:00Z");
const GAP = new Date("2026-10-09T10:00:00Z");
const IN_GAP = new Date("2026-10-09T10:30:00Z");
/** The pass's clock: the Screener's window is read from it, so the dates above stay inside it. */
const NOW = new Date("2026-10-09T12:00:00Z");
const SCREENER = "ohmail/Screener";

interface World { db: Awaited<ReturnType<typeof makeTestDb>>; accountId: string; mailboxId: string }

async function newWorld(o: { role?: "organizer" | "reader"; gapSince?: Date | null } = {}): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `gap-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
    organizerRole: o.role ?? "organizer",
    gapSince: o.gapSince === undefined ? GAP : o.gapSince,
  }).returning();
  return { db, accountId, mailboxId: mb!.id };
}

async function seedRule(w: World, match: string, o: { kind?: string; updatedAt?: Date; personDecidedAt?: Date } = {}): Promise<string> {
  const at = o.updatedAt ?? RULE_MADE;
  const [r] = await w.db.insert(rules).values({
    accountId: w.accountId, kind: o.kind ?? "sender", match, destination: NEWS,
    provenance: "manual", enabled: true, createdAt: at, updatedAt: at, personDecidedAt: o.personDecidedAt ?? null,
  }).returning();
  return r!.id;
}

/** One stored arrival — a reader's INBOX `'peer'` taken in now (inside the window) by default. */
async function seedArrival(w: World, o: {
  from: string; arrivedAt?: Date | null; takenInAt?: Date; folder?: string; lastSetBy?: string;
  sensitivityCategory?: string | null; noAi?: boolean; headers?: Record<string, string[]>; threadId?: string;
  decidedAt?: Date;
}): Promise<string> {
  const dedup = `mid:${randomUUID()}`;
  const folder = o.folder ?? INBOX;
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(),
    dedupKey: dedup, subject: "hello", fromAddress: o.from, nativeLocator: { folder, ref: "1:1" },
    arrivedAt: o.arrivedAt === undefined ? IN_GAP : o.arrivedAt,
    ...(o.takenInAt ? { createdAt: o.takenInAt } : {}),
    sensitivityCategory: o.sensitivityCategory ?? null, noAi: o.noAi ?? false,
    ...(o.threadId ? { threadId: o.threadId } : {}),
  }).returning();
  if (o.headers) await w.db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: o.headers });
  await w.db.insert(folderState).values({
    messageId: m!.id, desiredFolder: folder, observedFolder: folder,
    lastSetBy: o.lastSetBy ?? "peer", reconcileStatus: "reconciled", conflict: false,
    ...(o.decidedAt ? { decidedAt: o.decidedAt } : {}),
  });
  return m!.id;
}

const placement = async (w: World, id: string) =>
  (await w.db.select({ d: folderState.desiredFolder, by: folderState.lastSetBy })
    .from(folderState).where(eq(folderState.messageId, id)))[0]!;
const offerOf = async (w: World) =>
  (await w.db.select({ since: mailboxes.gapSince, letters: mailboxes.gapLetters, pressed: mailboxes.gapPressedAt })
    .from(mailboxes).where(eq(mailboxes.id, w.mailboxId)))[0]!;
const press = (w: World) => w.db.update(mailboxes).set({ gapPressedAt: new Date() }).where(eq(mailboxes.id, w.mailboxId));
const CLEAR: SweepClearance = { kind: "clear" };
const HELD: SweepClearance = { kind: "held" };
const run = (w: World, o: {
  mailboxIds?: readonly string[]; batch?: number; maxPages?: number; clearance?: SweepClearance; log?: Logger;
} = {}) => {
  const { clearance = CLEAR, ...rest } = o;
  return gapCatchupPass(w.db as unknown as Tx, {
    accountId: w.accountId, trustedAuthservIdsFor: NONE, clearanceFor: () => clearance, ...rest,
  }, NOW);
};
/** The whole offer, the stranger count with it. */
const windowOf = async (w: World) =>
  (await w.db.select({
    since: mailboxes.gapSince, letters: mailboxes.gapLetters, strangers: mailboxes.gapStrangers, pressed: mailboxes.gapPressedAt,
  }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId)))[0]!;
const CLOSED = { since: null, letters: null, strangers: null, pressed: null };
/** A sender the account knows: the gate lets them through, so they are nobody's stranger. */
const knowContact = (w: World, address: string) => w.db.insert(contacts).values({ accountId: w.accountId, address });
/** The Screener's audit rows, one per sender group a press moved. */
const sweeps = async (w: World) => (await w.db.select({ action: auditLog.action, payload: auditLog.payload }).from(auditLog)
  .where(eq(auditLog.accountId, w.accountId))).filter((r) => r.action === "screener.unscreened_sweep");

/** A logger that keeps what the pass says. */
function captured(): { log: Logger; lines: Array<{ event: string; fields: Record<string, unknown> }> } {
  const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const keep = (event: string, fields: Record<string, unknown> = {}): void => { lines.push({ event, fields }); };
  const log: Logger = { level: "debug", child: () => log, debug: keep, info: keep, warn: keep, error: keep };
  return { log, lines };
}
const withheld = (lines: ReturnType<typeof captured>["lines"]) => lines.filter((l) => l.event === "gap_catchup_withheld");

describe("letters from a gap are counted for the person and filed only on their press", () => {
  it("counts a true gap's letter, moves nothing unasked, and files exactly it on the press", async () => {
    const w = await newWorld();
    const ruleId = await seedRule(w, "letters@news.test");
    const letter = await seedArrival(w, { from: "letters@news.test" });

    expect(await run(w)).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect(await offerOf(w)).toMatchObject({ letters: 1, pressed: null });
    expect(await placement(w, letter), "a count moved mail").toEqual({ d: INBOX, by: "peer" });
    /* NO MOVE WITHOUT A PRESS: an offer waiting for the person is never walked again. */
    expect(await run(w)).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect(await placement(w, letter)).toEqual({ d: INBOX, by: "peer" });
    expect(await w.db.select().from(routingDecisions)).toHaveLength(0);

    await press(w);
    expect(await run(w)).toEqual({ offered: 0, moved: 1, completed: 1 });
    expect(await placement(w, letter)).toEqual({ d: NEWS, by: "us" });
    const decisions = await w.db.select().from(routingDecisions).where(eq(routingDecisions.messageId, letter));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      inputProvenance: "rule", matchedRuleId: ruleId, destination: NEWS, status: "auto_applied",
    });
    expect(await offerOf(w), "the window stayed open after its letters were filed")
      .toEqual({ since: null, letters: null, pressed: null });
    expect((await w.db.select().from(auditLog)).map((r) => r.action)).toContain("gap_catchup_move");
    expect((await w.db.select().from(changeLog)).some((r) => r.entityId === letter && r.op === "move")).toBe(true);
    expect(await run(w)).toEqual({ offered: 0, moved: 0, completed: 0 });
  });

  it("leaves out a letter first taken in before the window, whatever its arrival, beside one it counts", async () => {
    const w = await newWorld();
    await seedRule(w, "letters@news.test");
    const counted = await seedArrival(w, { from: "letters@news.test" });
    // Taken in while the row said another install held the mailbox, its arrival dated inside the window.
    const heldFirstSeen = await seedArrival(w, { from: "letters@news.test", takenInAt: BEFORE_GAP });
    expect(await run(w)).toMatchObject({ offered: 1 });
    expect((await offerOf(w)).letters, "the held-first-seen letter was counted").toBe(1);
    await press(w);
    expect(await run(w)).toMatchObject({ moved: 1, completed: 1 });
    expect(await placement(w, counted)).toEqual({ d: NEWS, by: "us" });
    expect(await placement(w, heldFirstSeen), "a letter taken in while held was filed").toEqual({ d: INBOX, by: "peer" });
  });

  it("leaves out a letter gone from the server since, beside one it counts", async () => {
    const w = await newWorld();
    await seedRule(w, "letters@news.test");
    const counted = await seedArrival(w, { from: "letters@news.test" });
    const gone = await seedArrival(w, { from: "letters@news.test" });
    const missing = await seedArrival(w, { from: "letters@news.test" });
    await w.db.update(messages).set({ deletedAt: NOW }).where(eq(messages.id, gone));
    await w.db.update(messages).set({ serverMissingAt: NOW }).where(eq(messages.id, missing));
    expect(await run(w)).toMatchObject({ offered: 1 });
    expect((await offerOf(w)).letters, "a letter gone from the server was counted").toBe(1);
    await press(w);
    expect(await run(w)).toMatchObject({ moved: 1 });
    expect(await placement(w, counted)).toEqual({ d: NEWS, by: "us" });
    expect(await placement(w, gone)).toEqual({ d: INBOX, by: "peer" });
  });

  it("counts none of the shapes the ruling excludes, beside a control that is counted and filed", async () => {
    const w = await newWorld();
    await seedRule(w, "letters@news.test");
    await seedRule(w, "news.test", { kind: "domain" });
    await seedRule(w, "young@rules.test", { updatedAt: new Date("2026-10-09T11:00:00Z") });
    const control = await seedArrival(w, { from: "letters@news.test" });
    const untouched: Record<string, string> = {
      "a letter dated before the note": await seedArrival(w, { from: "letters@news.test", arrivedAt: BEFORE_GAP }),
      "a rule younger than the arrival": await seedArrival(w, { from: "young@rules.test" }),
      "sensitivity-flagged": await seedArrival(w, { from: "letters@news.test", sensitivityCategory: "otp" }),
      "no_ai": await seedArrival(w, { from: "letters@news.test", noAi: true }),
      "a delivery report": await seedArrival(w, { from: "mailer-daemon@news.test" }),
      "an arrival with no date": await seedArrival(w, { from: "letters@news.test", arrivedAt: null }),
    };
    // Unmatched by any rule, from a sender nobody knows: the second class, screened on the press.
    const stranger = await seedArrival(w, { from: "a.person@example.test" });
    const flagged = await seedArrival(w, { from: "letters@news.test" });
    await w.db.insert(messageStates).values({ accountId: w.accountId, messageId: flagged, state: "reply_later" });
    untouched["flagged by the person"] = flagged;
    const answered = await seedArrival(w, { from: "letters@news.test" });
    await w.db.insert(drafts).values({ accountId: w.accountId, mailboxId: w.mailboxId, inReplyToMessageId: answered, subject: "re" });
    untouched["answered by the person"] = answered;
    const elsewhere: Record<string, [string, string, string]> = {
      "moved by the person ('external')": [await seedArrival(w, { from: "letters@news.test", lastSetBy: "external" }), INBOX, "external"],
      "'peer' already in News": [await seedArrival(w, { from: "letters@news.test", folder: NEWS }), NEWS, "peer"],
      "this install's own INBOX decision ('us')": [await seedArrival(w, { from: "letters@news.test", lastSetBy: "us" }), INBOX, "us"],
    };

    expect(await run(w)).toMatchObject({ offered: 1 });
    expect((await offerOf(w)).letters, "an excluded shape was counted").toBe(1);
    expect((await windowOf(w)).strangers, "the stranger was not counted").toBe(1);
    await press(w);
    expect(await run(w)).toMatchObject({ moved: 2, completed: 1 });
    expect(await placement(w, control), "the control was not filed — the refusals say nothing").toEqual({ d: NEWS, by: "us" });
    expect(await placement(w, stranger)).toEqual({ d: SCREENER, by: "us" });
    for (const [why, id] of Object.entries(untouched)) {
      expect(await placement(w, id), `${why}: moved`).toEqual({ d: INBOX, by: "peer" });
    }
    for (const [why, [id, d, by]] of Object.entries(elsewhere)) {
      expect(await placement(w, id), `${why}: moved`).toEqual({ d, by });
    }
    expect(await w.db.select().from(routingDecisions), "an excluded row got a decision").toHaveLength(1);
  });

  it("re-offers a new count when the set moved after the person saw it, and files nothing", async () => {
    const w = await newWorld();
    await seedRule(w, "letters@news.test");
    const a = await seedArrival(w, { from: "letters@news.test" });
    const b = await seedArrival(w, { from: "letters@news.test" });
    expect(await run(w)).toMatchObject({ offered: 1 });
    expect((await offerOf(w)).letters).toBe(2);
    // The person moved one themselves, then pressed File for the two they were shown.
    await w.db.update(folderState).set({ lastSetBy: "external" }).where(eq(folderState.messageId, b));
    await press(w);
    expect(await run(w)).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect(await offerOf(w)).toMatchObject({ letters: 1, pressed: null });
    expect(await placement(w, a), "a press for a count that no longer held filed mail").toEqual({ d: INBOX, by: "peer" });
    await press(w);
    expect(await run(w)).toMatchObject({ moved: 1, completed: 1 });
    expect(await placement(w, a)).toEqual({ d: NEWS, by: "us" });
    expect(await placement(w, b)).toEqual({ d: INBOX, by: "external" });
  });

  it("closes a window with nothing to offer, and ends one past its page bound unoffered", async () => {
    const empty = await newWorld();
    await knowContact(empty, "somebody@else.test");
    await seedArrival(empty, { from: "somebody@else.test" });
    expect(await run(empty)).toEqual({ offered: 0, moved: 0, completed: 1 });
    expect(await offerOf(empty)).toEqual({ since: null, letters: null, pressed: null });
    /* A sender nobody knows is something to offer: the Screener's half. */
    const strange = await newWorld();
    await seedArrival(strange, { from: "nobody@else.test" });
    expect(await run(strange)).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect(await windowOf(strange)).toMatchObject({ letters: 0, strangers: 1, pressed: null });

    const big = await newWorld();
    await seedRule(big, "letters@news.test");
    await seedArrival(big, { from: "letters@news.test" });
    await seedArrival(big, { from: "letters@news.test" });
    expect(await run(big, { batch: 1, maxPages: 1 })).toEqual({ offered: 0, moved: 0, completed: 1 });
    expect(await offerOf(big), "a window past its bound stayed open to be walked again")
      .toEqual({ since: null, letters: null, pressed: null });
  });

  it("does not count a reader's window, and does nothing where no window is open", async () => {
    const reader = await newWorld({ role: "reader" });
    await seedRule(reader, "letters@news.test");
    await seedArrival(reader, { from: "letters@news.test" });
    expect(await run(reader)).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect((await offerOf(reader)).since).not.toBeNull();

    const closed = await newWorld({ gapSince: null });
    await seedRule(closed, "letters@news.test");
    await seedArrival(closed, { from: "letters@news.test" });
    expect(await run(closed)).toEqual({ offered: 0, moved: 0, completed: 0 });
  });

  it("a stand-down to another install closes the window and its offer: a held look, by the gate", async () => {
    const w = await newWorld();
    await w.db.update(mailboxes).set({ gapLetters: 2, gapPressedAt: new Date() }).where(eq(mailboxes.id, w.mailboxId));
    expect(await markMailboxStoodDown(w.db as never, w.mailboxId, "organized_elsewhere:local", {
      by: { kind: "local", installId: "the-laptop", displayName: "a laptop", claimedAt: new Date(), state: "held" },
    })).toBe(true);
    expect(await offerOf(w)).toEqual({ since: null, letters: null, pressed: null });
  });

  it("walks only the mailboxes it is handed, when it is handed some", async () => {
    const w = await newWorld();
    await seedRule(w, "letters@news.test");
    await seedArrival(w, { from: "letters@news.test" });
    expect(await run(w, { mailboxIds: [] })).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect(await run(w, { mailboxIds: [randomUUID()] })).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect(await run(w, { mailboxIds: [w.mailboxId] })).toMatchObject({ offered: 1 });
  });
});

/** A settings copy as the mailbox carries it: written by another install, formatted, parsed back. */
function copyOf(entries: ProfileRuleEntry[]): OrganizerProfileDoc {
  const doc = makeProfileDoc({ screener: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null, rules: entries },
    { updatedAt: new Date("2026-10-09T09:30:00.000Z"), producer: { kind: "local", version: "dev" } });
  const parsed = parseProfileMessage(formatProfileMessage(doc, { installId: "the-desktop" }));
  if (parsed === null || isMalformedProfile(parsed) || !parsed.doc) throw new Error("expected a readable copy");
  return parsed.doc;
}
const newsEntry = (more: Partial<ProfileRuleEntry> = {}): ProfileRuleEntry =>
  ({ kind: "sender", match: "letters@news.test", destination: NEWS, priority: 0, enabled: true, provenance: "manual", ...more });
async function importCopy(w: World, doc: OrganizerProfileDoc): Promise<void> {
  await w.db.transaction((tx) => applyOrganizerProfile(carryDialect(w.db, tx) as never, {
    accountId: w.accountId, mailboxId: w.mailboxId, doc, fingerprint: profileFingerprint(doc), now: new Date(),
  }));
}

describe("the gap pass waits for settled rules", () => {
  it("(a) held, no rules, a letter in the window: nothing is counted or closed, and the withheld line is logged once", async () => {
    const w = await newWorld();
    const letter = await seedArrival(w, { from: "letters@news.test" });
    const { log, lines } = captured();
    expect(await run(w, { clearance: HELD, log })).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect(await offerOf(w), "a held mailbox closed its window").toEqual({ since: GAP, letters: null, pressed: null });
    expect(await placement(w, letter)).toEqual({ d: INBOX, by: "peer" });
    expect(withheld(lines)).toEqual([{ event: "gap_catchup_withheld", fields: expect.objectContaining({
      mailboxId: w.mailboxId, accountId: w.accountId, outcome: "held", why: null,
    }) }]);
    expect(await run(w, { clearance: HELD, log })).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect(withheld(lines), "the withheld line repeats every pass").toHaveLength(1);

    /* CONTROL: the same world, cleared, offers the stranger's letter for the Screener. */
    expect(await run(w, { log })).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect(await windowOf(w)).toMatchObject({ letters: 0, strangers: 1, pressed: null });
  });

  it("(a) CONTROL: a sender the account knows, cleared, closes the window — nothing to file or screen", async () => {
    const w = await newWorld();
    await knowContact(w, "letters@news.test");
    const letter = await seedArrival(w, { from: "letters@news.test" });
    expect(await run(w, { clearance: HELD })).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect(await run(w)).toEqual({ offered: 0, moved: 0, completed: 1 });
    expect(await windowOf(w)).toEqual(CLOSED);
    expect(await placement(w, letter)).toEqual({ d: INBOX, by: "peer" });
  });

  it.each(["read_fault", "garbled", "no_folder"] as const)("(b) unread (%s) withholds by name", async (why) => {
    const w = await newWorld();
    await seedArrival(w, { from: "letters@news.test" });
    const { log, lines } = captured();
    expect(await run(w, { clearance: { kind: "unread", why }, log })).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect((await offerOf(w)).since, "an unread clearance closed the window").toEqual(GAP);
    expect(withheld(lines).map((l) => l.fields)).toEqual([expect.objectContaining({ outcome: "unread", why })]);
  });

  it("(c) a press under held files nothing; the press stays and files once cleared", async () => {
    const w = await newWorld();
    await seedRule(w, "letters@news.test");
    const letter = await seedArrival(w, { from: "letters@news.test" });
    expect(await run(w)).toMatchObject({ offered: 1 });
    await press(w);
    expect(await run(w, { clearance: HELD })).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect(await placement(w, letter), "a press under held filed mail").toEqual({ d: INBOX, by: "peer" });
    const row = await offerOf(w);
    expect(row.letters).toBe(1);
    expect(row.pressed, "the press was dropped").not.toBeNull();
    expect(await run(w)).toEqual({ offered: 0, moved: 1, completed: 1 });
    expect(await placement(w, letter)).toEqual({ d: NEWS, by: "us" });
  });

  it("(d) the cross-install case: a fresh install with no rules waits for the import, then offers by the imported rules", async () => {
    const w = await newWorld();
    const letter = await seedArrival(w, { from: "letters@news.test" });
    expect(await run(w, { clearance: HELD })).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect((await offerOf(w)).since, "the open import question closed the window").toEqual(GAP);

    const copy = copyOf([newsEntry({ updatedAt: RULE_MADE.toISOString() })]);
    expect(copy.rules[0]!.updatedAt, "premise: the copy carries the rule's age").toBe(RULE_MADE.toISOString());
    await importCopy(w, copy);
    expect(await run(w)).toEqual({ offered: 1, moved: 0, completed: 0 });
    await press(w);
    expect(await run(w)).toEqual({ offered: 0, moved: 1, completed: 1 });
    expect(await placement(w, letter)).toEqual({ d: NEWS, by: "us" });
  });

  it("(d) CONTROL: the same copy without the age counts nothing and closes", async () => {
    const w = await newWorld();
    await seedArrival(w, { from: "letters@news.test" });
    await importCopy(w, copyOf([newsEntry()]));
    expect(await run(w)).toEqual({ offered: 0, moved: 0, completed: 1 });
  });

  it("(d) CONTROL: a copy that carries the person's stamp only is counted by it", async () => {
    const w = await newWorld();
    await seedArrival(w, { from: "letters@news.test" });
    await importCopy(w, copyOf([newsEntry({ personDecidedAt: RULE_MADE.toISOString() })]));
    expect(await run(w)).toEqual({ offered: 1, moved: 0, completed: 0 });
  });

  it("(e) the person's stamp is the rule's age: an old stamp on a young row is counted, beside a control that is not", async () => {
    const young = new Date("2026-10-09T11:00:00Z");
    const stamped = await newWorld();
    await seedRule(stamped, "letters@news.test", { updatedAt: young, personDecidedAt: RULE_MADE });
    await seedArrival(stamped, { from: "letters@news.test" });
    expect(await run(stamped)).toEqual({ offered: 1, moved: 0, completed: 0 });

    const unstamped = await newWorld();
    await seedRule(unstamped, "letters@news.test", { updatedAt: young });
    await seedArrival(unstamped, { from: "letters@news.test" });
    expect(await run(unstamped)).toEqual({ offered: 0, moved: 0, completed: 1 });
  });
});

describe("letters from new senders in a gap go to the Screener, and only on the person's press", () => {
  it("counts the rules' letters and the strangers' apart, moves nothing unasked, and on File files one and screens three", async () => {
    const w = await newWorld();
    await seedRule(w, "letters@news.test");
    const ruled = await seedArrival(w, { from: "letters@news.test" });
    const first = [await seedArrival(w, { from: "first@stranger.test" }), await seedArrival(w, { from: "First@Stranger.test" })];
    const second = await seedArrival(w, { from: "second@stranger.test" });
    await knowContact(w, "friend@known.test");
    const friend = await seedArrival(w, { from: "friend@known.test" });

    expect(await run(w)).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect(await windowOf(w)).toMatchObject({ letters: 1, strangers: 3, pressed: null });
    expect(await sweeps(w), "a count screened a sender").toEqual([]);
    for (const id of [ruled, ...first, second, friend]) {
      expect(await placement(w, id), "a count moved mail").toEqual({ d: INBOX, by: "peer" });
    }
    expect(await run(w), "an offer waiting for the person was walked again").toEqual({ offered: 0, moved: 0, completed: 0 });

    await press(w);
    expect(await run(w)).toEqual({ offered: 0, moved: 4, completed: 1 });
    expect(await placement(w, ruled)).toEqual({ d: NEWS, by: "us" });
    for (const id of [...first, second]) {
      const [fs] = await w.db.select().from(folderState).where(eq(folderState.messageId, id));
      expect(fs).toMatchObject({ desiredFolder: SCREENER, observedFolder: INBOX, lastSetBy: "us", reconcileStatus: "pending" });
    }
    expect((await sweeps(w)).map((r) => r.payload).sort((a, b) =>
      String((a as { address: string }).address).localeCompare(String((b as { address: string }).address)))).toEqual([
      { address: "first@stranger.test", count: 2, from: INBOX, to: SCREENER, via: "gap" },
      { address: "second@stranger.test", count: 1, from: INBOX, to: SCREENER, via: "gap" },
    ]);
    const moves = (await w.db.select().from(changeLog)).filter((r) => r.op === "move").map((r) => r.entityId);
    expect(moves.sort()).toEqual([ruled, ...first, second].sort());
    expect(await w.db.select().from(routingDecisions), "a screened letter got a rule's decision").toHaveLength(1);
    expect(await windowOf(w)).toEqual(CLOSED);
    expect(await placement(w, friend), "a known sender's letter moved").toEqual({ d: INBOX, by: "peer" });
    expect(await run(w)).toEqual({ offered: 0, moved: 0, completed: 0 });
  });

  it("offers a window of strangers only as {0, K} and screens them on File", async () => {
    const w = await newWorld();
    const a = await seedArrival(w, { from: "new@stranger.test" });
    const b = await seedArrival(w, { from: "new@stranger.test" });
    expect(await run(w)).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect(await windowOf(w)).toMatchObject({ letters: 0, strangers: 2, pressed: null });
    await press(w);
    expect(await run(w)).toEqual({ offered: 0, moved: 2, completed: 1 });
    expect(await placement(w, a)).toEqual({ d: SCREENER, by: "us" });
    expect(await placement(w, b)).toEqual({ d: SCREENER, by: "us" });
    expect(await windowOf(w)).toEqual(CLOSED);
  });

  it("screens none of the shapes the gate or the person already answered, beside a stranger it screens", async () => {
    const w = await newWorld();
    const own = (await w.db.select({ a: mailboxes.address }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId)))[0]!.a;
    // The reply arm's evidence: a Sent copy of the person's own writing, after the mailbox was connected.
    await w.db.update(mailboxes).set({ createdAt: new Date("2026-09-01T00:00:00Z"), sentFolder: "Sent" })
      .where(eq(mailboxes.id, w.mailboxId));
    await w.db.insert(mailboxFolders).values({ mailboxId: w.mailboxId, folder: "Sent" });
    const [plan] = await w.db.insert(threads).values({ accountId: w.accountId, subject: "plan", rootMessageIdHeader: "own-1@rig.test" }).returning();
    const sentAt = new Date("2026-10-08T09:00:00Z");
    const [sent] = await w.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "sent", dedupKey: `sent:${randomUUID()}`, subject: "plan",
      fromAddress: own, date: sentAt, createdAt: sentAt, arrivedAt: sentAt, unread: false, threadId: plan!.id,
      messageIdHeader: "own-1@rig.test", toAddresses: [{ name: null, address: "team@lists.rig.test" }],
      nativeLocator: { folder: "Sent", ref: "1:1" },
    }).returning();
    await w.db.insert(messageBodies).values({ messageId: sent!.id, text: "", html: null, headers: {} });
    await w.db.insert(messageInstances).values({
      accountId: w.accountId, mailboxId: w.mailboxId, messageId: sent!.id, folder: "Sent", uidvalidity: 1n, uid: 1, isPrimary: true,
    });
    await w.db.insert(folderState).values({
      messageId: sent!.id, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "external", reconcileStatus: "reconciled", conflict: false,
    });
    // An answered sender: the person wrote to them in the thread their letter is in.
    const [talk] = await w.db.insert(threads).values({ accountId: w.accountId, subject: "talk" }).returning();
    await w.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "sent2", dedupKey: `sent:${randomUUID()}`, subject: "talk",
      fromAddress: own, date: sentAt, createdAt: sentAt, arrivedAt: sentAt, unread: false, threadId: talk!.id,
      messageIdHeader: "own-2@rig.test", toAddresses: [{ name: null, address: "answered@stranger.test" }],
      nativeLocator: { folder: "Sent", ref: "1:2" },
    });
    const young = new Date("2026-10-09T11:00:00Z");
    await seedRule(w, "denied@stranger.test", { updatedAt: young });
    await w.db.update(rules).set({ destination: "ohmail/Screened" }).where(eq(rules.match, "denied@stranger.test"));
    await seedRule(w, "allowed@stranger.test", { updatedAt: young });
    await w.db.update(rules).set({ destination: INBOX }).where(eq(rules.match, "allowed@stranger.test"));

    const control = await seedArrival(w, { from: "control@stranger.test" });
    const untouched: Record<string, string> = {
      "a correspondent's reply": await seedArrival(w, {
        from: "reply@stranger.test", threadId: plan!.id,
        headers: { "in-reply-to": ["<own-1@rig.test>"], references: ["<own-1@rig.test>"] },
      }),
      "the account's own mail": await seedArrival(w, { from: own }),
      "a decided placement": await seedArrival(w, { from: "decided@stranger.test", decidedAt: IN_GAP }),
      "sensitivity-flagged": await seedArrival(w, { from: "otp@stranger.test", sensitivityCategory: "otp" }),
      "no_ai": await seedArrival(w, { from: "noai@stranger.test", noAi: true }),
      "a delivery report": await seedArrival(w, { from: "mailer-daemon@stranger.test" }),
      "an answered sender": await seedArrival(w, { from: "answered@stranger.test", threadId: talk!.id }),
      "a deny rule": await seedArrival(w, { from: "denied@stranger.test" }),
      "a younger allow rule": await seedArrival(w, { from: "allowed@stranger.test" }),
      "an arrival before the window": await seedArrival(w, { from: "early@stranger.test", arrivedAt: BEFORE_GAP }),
      "an intake before the window": await seedArrival(w, { from: "held@stranger.test", takenInAt: BEFORE_GAP }),
    };
    const tagged = await seedArrival(w, { from: "tagged@stranger.test" });
    const [tag] = await w.db.insert(tags).values({ accountId: w.accountId, name: "keep" }).returning();
    await w.db.insert(messageTags).values({ accountId: w.accountId, messageId: tagged, tagId: tag!.id });
    untouched["a tagged letter"] = tagged;
    const piled = await seedArrival(w, { from: "piled@stranger.test" });
    await w.db.insert(messageStates).values({ accountId: w.accountId, messageId: piled, state: "reply_later" });
    untouched["a triage pile"] = piled;
    const drafted = await seedArrival(w, { from: "drafted@stranger.test" });
    await w.db.insert(drafts).values({ accountId: w.accountId, mailboxId: w.mailboxId, inReplyToMessageId: drafted, subject: "re" });
    untouched["a reply draft"] = drafted;
    const approved = await seedArrival(w, { from: "approved@stranger.test" });
    await w.db.insert(approvals).values({
      accountId: w.accountId, kind: "routing", messageId: approved, action: "move", status: "approved",
    });
    untouched["a decided approval"] = approved;

    expect(await run(w)).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect(await windowOf(w), "an excluded shape was counted").toMatchObject({ letters: 0, strangers: 1 });
    await press(w);
    expect(await run(w)).toEqual({ offered: 0, moved: 1, completed: 1 });
    expect(await placement(w, control), "the control was not screened — the refusals say nothing").toEqual({ d: SCREENER, by: "us" });
    for (const [why, id] of Object.entries(untouched)) {
      expect((await placement(w, id)).d, `${why}: screened`).toBe(INBOX);
    }
    expect((await sweeps(w)).map((r) => (r.payload as { address: string }).address)).toEqual(["control@stranger.test"]);
  });

  it("re-offers when the strangers changed after the person saw them, and screens nothing", async () => {
    const w = await newWorld();
    const a = await seedArrival(w, { from: "a@stranger.test" });
    const b = await seedArrival(w, { from: "b@stranger.test" });
    expect(await run(w)).toMatchObject({ offered: 1 });
    expect(await windowOf(w)).toMatchObject({ letters: 0, strangers: 2 });
    // The person moved one themselves, then pressed File for the two they were shown.
    await w.db.update(folderState).set({ lastSetBy: "external" }).where(eq(folderState.messageId, b));
    await press(w);
    expect(await run(w)).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect(await windowOf(w)).toMatchObject({ letters: 0, strangers: 1, pressed: null });
    expect(await placement(w, a), "a press for a count that no longer held screened mail").toEqual({ d: INBOX, by: "peer" });
    expect(await sweeps(w)).toEqual([]);
    await press(w);
    expect(await run(w)).toEqual({ offered: 0, moved: 1, completed: 1 });
    expect(await placement(w, a)).toEqual({ d: SCREENER, by: "us" });
    expect(await placement(w, b)).toEqual({ d: INBOX, by: "external" });
  });

  it("Leave moves nothing over two passes; CONTROL — File moves them", async () => {
    const left = await newWorld();
    const kept = [await seedArrival(left, { from: "x@stranger.test" }), await seedArrival(left, { from: "y@stranger.test" })];
    expect(await run(left)).toMatchObject({ offered: 1 });
    // The door's Leave: the window and both counts closed, nothing else.
    await left.db.update(mailboxes).set({ gapSince: null, gapLetters: null, gapPressedAt: null, gapStrangers: null })
      .where(eq(mailboxes.id, left.mailboxId));
    expect(await run(left)).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect(await run(left)).toEqual({ offered: 0, moved: 0, completed: 0 });
    for (const id of kept) expect(await placement(left, id)).toEqual({ d: INBOX, by: "peer" });
    expect(await sweeps(left)).toEqual([]);

    const filed = await newWorld();
    const moved = [await seedArrival(filed, { from: "x@stranger.test" }), await seedArrival(filed, { from: "y@stranger.test" })];
    expect(await run(filed)).toMatchObject({ offered: 1 });
    await press(filed);
    expect(await run(filed)).toMatchObject({ moved: 2, completed: 1 });
    for (const id of moved) expect(await placement(filed, id)).toEqual({ d: SCREENER, by: "us" });
  });

  it("a press under held screens nothing; the press stays and screens once cleared", async () => {
    const w = await newWorld();
    const letter = await seedArrival(w, { from: "new@stranger.test" });
    expect(await run(w)).toMatchObject({ offered: 1 });
    await press(w);
    expect(await run(w, { clearance: HELD })).toEqual({ offered: 0, moved: 0, completed: 0 });
    expect(await placement(w, letter), "a press under held screened mail").toEqual({ d: INBOX, by: "peer" });
    const row = await windowOf(w);
    expect(row).toMatchObject({ letters: 0, strangers: 1 });
    expect(row.pressed, "the press was dropped").not.toBeNull();
    expect(await run(w)).toEqual({ offered: 0, moved: 1, completed: 1 });
    expect(await placement(w, letter)).toEqual({ d: SCREENER, by: "us" });
  });

  it("an offer an older build counted, pressed, is offered again with its strangers and never screened unseen", async () => {
    const w = await newWorld();
    await seedRule(w, "letters@news.test");
    const ruled = await seedArrival(w, { from: "letters@news.test" });
    const stranger = await seedArrival(w, { from: "new@stranger.test" });
    // An older build counted the rules' letter only and wrote no stranger count; the person pressed it.
    await w.db.update(mailboxes).set({ gapLetters: 1, gapStrangers: null, gapPressedAt: new Date() })
      .where(eq(mailboxes.id, w.mailboxId));
    expect(await run(w)).toEqual({ offered: 1, moved: 0, completed: 0 });
    expect(await windowOf(w)).toMatchObject({ letters: 1, strangers: 1, pressed: null });
    expect(await placement(w, stranger), "a letter the person never saw counted was screened").toEqual({ d: INBOX, by: "peer" });
    expect(await placement(w, ruled)).toEqual({ d: INBOX, by: "peer" });
    await press(w);
    expect(await run(w)).toEqual({ offered: 0, moved: 2, completed: 1 });
    expect(await placement(w, stranger)).toEqual({ d: SCREENER, by: "us" });
  });

  it("counts and moves the Screener's sender-group bound, no more: one stranger past it stays", async () => {
    const w = await newWorld();
    const senders = Array.from({ length: GROUPS + 1 }, (_, k) => `s${String(k).padStart(4, "0")}@many.test`);
    const made = await w.db.insert(messages).values(senders.map((from, k) => ({
      accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: `many-${k}@rig.test`, bodyHash: randomUUID(),
      dedupKey: `mid:${randomUUID()}`, subject: "hello", fromAddress: from, nativeLocator: { folder: INBOX, ref: `2:${k}` },
      arrivedAt: IN_GAP,
    }))).returning({ id: messages.id, from: messages.fromAddress });
    await w.db.insert(folderState).values(made.map((m) => ({
      messageId: m.id, desiredFolder: INBOX, observedFolder: INBOX, lastSetBy: "peer" as const,
      reconcileStatus: "reconciled" as const, conflict: false,
    })));
    expect(await run(w)).toMatchObject({ offered: 1 });
    expect(await windowOf(w)).toMatchObject({ letters: 0, strangers: GROUPS });
    await press(w);
    expect(await run(w)).toEqual({ offered: 0, moved: GROUPS, completed: 1 });
    const left = [];
    for (const m of made) if ((await placement(w, m.id)).d === INBOX) left.push(m.from);
    expect(left, "past the bound's last sender a letter stays for the Screener's own offer").toEqual([senders[GROUPS]]);
    expect(await sweeps(w)).toHaveLength(GROUPS);
  });
});
