import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, auditLog, changeLog, drafts, folderState, mailboxes, messageStates, messages, routingDecisions, rules,
  type Tx,
} from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  type OrganizerProfileDoc, type ProfileRuleEntry,
} from "@trafficflow/core/adapters/organizer-profile";
import { applyOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
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
  sensitivityCategory?: string | null; noAi?: boolean;
}): Promise<string> {
  const dedup = `mid:${randomUUID()}`;
  const folder = o.folder ?? INBOX;
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(),
    dedupKey: dedup, subject: "hello", fromAddress: o.from, nativeLocator: { folder, ref: "1:1" },
    arrivedAt: o.arrivedAt === undefined ? IN_GAP : o.arrivedAt,
    ...(o.takenInAt ? { createdAt: o.takenInAt } : {}),
    sensitivityCategory: o.sensitivityCategory ?? null, noAi: o.noAi ?? false,
  }).returning();
  await w.db.insert(folderState).values({
    messageId: m!.id, desiredFolder: folder, observedFolder: folder,
    lastSetBy: o.lastSetBy ?? "peer", reconcileStatus: "reconciled", conflict: false,
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
  });
};

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
      "unmatched by any rule": await seedArrival(w, { from: "a.person@example.test" }),
    };
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
    await press(w);
    expect(await run(w)).toMatchObject({ moved: 1, completed: 1 });
    expect(await placement(w, control), "the control was not filed — the refusals say nothing").toEqual({ d: NEWS, by: "us" });
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
    await seedArrival(empty, { from: "nobody@else.test" });
    expect(await run(empty)).toEqual({ offered: 0, moved: 0, completed: 1 });
    expect(await offerOf(empty)).toEqual({ since: null, letters: null, pressed: null });

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

    /* CONTROL: the same world, cleared, closes the window — what the pass did before the gate. */
    expect(await run(w, { log })).toEqual({ offered: 0, moved: 0, completed: 1 });
    expect(await offerOf(w)).toEqual({ since: null, letters: null, pressed: null });
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
