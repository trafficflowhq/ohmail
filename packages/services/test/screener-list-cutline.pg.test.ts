import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import { accounts, accountSettings, mailboxes, messages, folderState, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { brandDialect } from "@trafficflow/db/dialect";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";
import {
  MemoryMirrorStore, consentPartition, presentationReader, screenerSegments,
  type EngineMessage, type Folder, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import { cutlineCounts } from "../src/consent-cutline.js";

/**
 * ═══ THE SCREENER'S LIST AND THE COUNT BESIDE IT ARE ONE RULE ═════════════════════════════
 *
 * ── THE DEFECT, MEASURED (managed plane, read-only, 2026-09-10/11) ─────────────────────────
 *
 * `GET /consent` counted the WAITING senders through the cutline; `GET /screener` listed every
 * sender whose mail sits in the Screener folder and consulted no cutline at all — zero
 * occurrences of baseline, cutline, cutoff or dormancy in its read path. On one account the list
 * answered **far more** senders than the cutline called active: a queue many times
 * the count, and the senders the cutline had already retired included
 * first-contact senders whose newest mail was years old. That is what a person reported as old
 * mail appearing in the Screener out of the blue.
 *
 * ── WHY REAL POSTGRES ─────────────────────────────────────────────────────────────────────
 *
 * The retirement is a correlated aggregate under a `having`, composed into the outer half of a
 * `DISTINCT ON` query beside a row-value keyset. Whether that composes — and whether it agrees
 * with the count's own aggregate over the same rows — is a claim about Postgres, not about a
 * JavaScript array. The fixture is INSERT-only under a fresh `account_id`, so nothing here is
 * visible to another test sharing this database.
 *
 * ── ITS TWIN, AND WHY THIS FILE IS NOT ENOUGH ──────────────────────────────────────────────
 *
 * This is the POSTGRES arm. `packages/db/test/sqlite-cutline.test.ts` runs the same predicate on
 * the device store and asserts the same sender set, because the phone runs this engine too — and
 * a Postgres-only spelling in the shared module passes every case below while failing there.
 *
 * ── MUTATIONS WATCHED (each restored, `cmp`-proven) ────────────────────────────────────────
 *
 *  · drop the `senderIsActiveSql` predicate from `heldSenderPage`
 *      ⇒ "keeps the one active sender" RED (4 senders listed, 1 expected) and
 *        "the list and the count agree" RED (4 against 1).
 *  · `activeSenderExpr`'s window term → `anyUnread` unconditionally
 *      ⇒ "an unread pre-cutline sender stays retired" RED.
 *  · `resolveCutline`'s `allTime` → always false
 *      ⇒ "all_time brings every retired sender back" RED.
 *  · `cutlineInstant` → the `date` column alone
 *      ⇒ "keeps the two active senders" RED, because `undated` arrived yesterday.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-09-11T00:00:00.000Z");
const BASELINE = new Date("2026-08-12T00:00:00.000Z");
/** dormancy 365 ⇒ the cutline sits at 2025-08-12. The reporting account's own numbers. */
const DORMANCY = 365;

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId, userId: null, now: () => NOW, requestId: `cut-${randomUUID().slice(0, 8)}`,
});

/**
 * The reporting account's SHAPE: five held first-contact senders of which the cutline keeps two.
 *
 *  · `ancient`   — read, 2023, arrived 2023. Pre-cutline on every term.
 *  · `unreadold` — UNREAD, 2023, arrived 2023. The discriminating case: with a baseline, unread
 *                  does NOT outrank age, and this sender is the one a mutation of the window
 *                  term revives.
 *  · `undated`   — no `Date:` header at all, a field the SENDER controls, ARRIVED YESTERDAY. The
 *                  cutline dates it by the arrival, so it is one of the two that stay: on the
 *                  header alone the list retired mail the mailbox had just recorded.
 *  · `staleundated` — no header either, ARRIVED IN 2023. The arrival is read, not ignored.
 *  · `fresh`     — post-baseline. The one that stays on its header alone.
 *
 * `arrivedAt` is stated per row: `created_at` defaults to `now()`, and a fixture whose arrival
 * moves with the wall clock cannot pin a cutoff comparison.
 */
async function seed(scope: string): Promise<{ accountId: string; retiredMessageId: string }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `cut-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `cut-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  await db.insert(accountSettings).values({
    accountId, screeningBaselineAt: BASELINE, dormancyDays: DORMANCY, screeningScope: scope,
    updatedAt: NOW,
  });

  let n = 0;
  const held = async (from: string, date: Date | null, unread: boolean, arrivedAt: Date) => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `cut:${randomUUID()}`,
      subject: `Note ${i}`, snippet: `s${i}`, fromAddress: from, date, unread,
      createdAt: arrivedAt,
      nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };

  const ANCIENT = new Date("2023-06-23T00:00:00.000Z");
  const YESTERDAY = new Date("2026-09-10T00:00:00.000Z");
  await held("ancient@ex.test", new Date("2023-06-11T00:00:00.000Z"), false, ANCIENT);
  const retiredMessageId = await held("ancient@ex.test", ANCIENT, false, ANCIENT);
  await held("unreadold@ex.test", new Date("2023-02-01T00:00:00.000Z"), true, ANCIENT);
  await held("undated@ex.test", null, true, YESTERDAY);
  await held("staleundated@ex.test", null, false, ANCIENT);
  await held("fresh@ex.test", new Date("2026-09-09T00:00:00.000Z"), true, YESTERDAY);
  return { accountId, retiredMessageId };
}

const listed = async (accountId: string): Promise<string[]> => {
  const page = await new ScreenerService({}).list(ctx(accountId), { limit: 100 });
  return page.items.map((i) => i.sender.address.toLowerCase()).sort();
};

describe.skipIf(!PG_UP)("the Screener list consults the cutline", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    // BRANDED, as every factory that opens a handle must: the seam refuses to compose a statement
    // for a handle that does not say which store it is.
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("keeps the two active senders and retires the other three", async () => {
    const { accountId } = await seed("window");
    // `undated` is here because the cutline dates it by its ARRIVAL, which was yesterday. On the
    // header alone the answer was `["fresh@ex.test"]` and the queue dropped mail from a stranger
    // who had just written — the row the phone then rendered under History.
    expect(await listed(accountId)).toEqual(["fresh@ex.test", "undated@ex.test"]);
  });

  it("an UNDATED message that arrived YEARS ago stays retired — the arrival is read, not ignored", async () => {
    const { accountId } = await seed("window");
    expect(await listed(accountId)).not.toContain("staleundated@ex.test");
  });

  it("an UNREAD pre-cutline sender stays retired — a baseline outranks unread", async () => {
    const { accountId } = await seed("window");
    expect(await listed(accountId)).not.toContain("unreadold@ex.test");
  });

  it("THE LIST AND THE COUNT AGREE — one rule, two surfaces", async () => {
    const { accountId } = await seed("window");
    const counts = await cutlineCounts(ctx(accountId), {
      baselineAt: BASELINE, dormancyDays: DORMANCY, scope: "window",
    });
    expect((await listed(accountId)).length).toBe(counts.activeUndecidedSenders);
    expect(counts.activeUndecidedSenders).toBe(2);
  });

  it("a held letter is dated by its ARRIVAL: an old Date received yesterday waits, one received in May does not", async () => {
    const accountId = randomUUID();
    const MAY = new Date("2026-05-02T09:00:00.000Z");
    await db.insert(accounts).values({ id: accountId, name: `arr-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `arr-${accountId.slice(0, 8)}@example.test`,
      initialImportCompletedAt: MAY,
    }).returning();
    // 60 days from the baseline: the cutline sits at 2026-06-13.
    await db.insert(accountSettings).values({
      accountId, screeningBaselineAt: BASELINE, dormancyDays: 60, screeningScope: "window", updatedAt: NOW,
    });
    const YESTERDAY = new Date("2026-09-10T00:00:00.000Z");
    for (const [i, [from, unread, received]] of ([
      ["arrivednow@ex.test", false, YESTERDAY], ["receivedmay@ex.test", true, MAY],
    ] as const).entries()) {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: `a${i}`, dedupKey: `arr:${randomUUID()}`, subject: `A${i}`,
        snippet: "", fromAddress: from, date: MAY, unread, createdAt: YESTERDAY, arrivedAt: received,
        nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
    }
    const page = await new ScreenerService({}).list(ctx(accountId), { limit: 100 });
    expect(page.items.map((i) => i.sender.address)).toEqual(["arrivednow@ex.test"]);
    expect(page.total).toBe(1);
    expect(await new ScreenerService({}).waitingCount(ctx(accountId), mb!.id)).toEqual({ senders: 1 });
    const counts = await cutlineCounts(ctx(accountId), { baselineAt: BASELINE, dormancyDays: 60, scope: "window" });
    expect(counts.activeUndecidedSenders).toBe(1);
  });

  it("`all_time` brings every retired sender back into the list", async () => {
    const { accountId } = await seed("all_time");
    expect(await listed(accountId)).toEqual(
      ["ancient@ex.test", "fresh@ex.test", "staleundated@ex.test", "undated@ex.test",
        "unreadold@ex.test"],
    );
  });

  /**
   * ── THE ONE THAT WOULD STRAND MAIL ──────────────────────────────────────────────────────
   *
   * `decide` reads through `heldRowById`, NOT through the list, and that separation is the whole
   * safety of this change. `heldRows`' own docblock already argues it for the sensitivity filter:
   * narrow the set `decide` reads and "that sender could never be screened at all (404) and their
   * mail would stay stuck in `ohmail/Screener` for ever". A retired sender is still reachable —
   * by search, by a stale open page, by History — so a press on them must still work.
   */
  it("a RETIRED sender is still DECIDABLE — no 404, and the mail moves", async () => {
    const { accountId, retiredMessageId } = await seed("window");
    // Not in the queue…
    expect(await listed(accountId)).not.toContain("ancient@ex.test");
    // …and still answerable.
    const result = await new ScreenerService({}).decide(
      ctx(accountId), retiredMessageId, { decision: "yes" },
    );
    expect("appliedFolder" in result ? result.appliedFolder : null).toBe("INBOX");
    // BOTH of that sender's held messages followed the decision — the whole bag, not the row
    // that was pressed. Read from the database rather than from the result.
    const rows = await db.execute<{ desired: string }>(sql`
      select fs.desired_folder as desired
        from messages m join folder_state fs on fs.message_id = m.id
       where m.account_id = ${accountId} and lower(m.from_address) = 'ancient@ex.test'
    `);
    const desired = [...(Array.isArray(rows) ? rows : (rows as { rows?: Array<{ desired: string }> }).rows ?? [])]
      .map((r) => r.desired);
    expect(desired).toHaveLength(2);
    expect(desired.every((d) => d === "INBOX")).toBe(true);
  });

  it("an account with NO baseline lists what it always listed — unread outranks age", async () => {
    // The positive control for the absent case: no cutline narrowing, so the unread old sender
    // and the undated one are back and only the sender READ in 2023 is dormant. A retirement that
    // fired here would empty a live queue for an account that never decided anything.
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `nb-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `nb-${accountId.slice(0, 8)}@example.test`,
    }).returning();
    const held = async (from: string, date: Date | null, unread: boolean, i: number) => {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: `n${i}`, dedupKey: `nb:${randomUUID()}`,
        subject: `N${i}`, snippet: "", fromAddress: from, date, unread,
        // Both rows arrived when their headers say, so this control measures the HEADER's age.
        createdAt: date ?? new Date("2023-01-01T00:00:00.000Z"),
        nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
    };
    await held("readold@ex.test", new Date("2023-01-01T00:00:00.000Z"), false, 0);
    await held("unreadold@ex.test", new Date("2023-02-01T00:00:00.000Z"), true, 1);
    const got = await listed(accountId);
    expect(got).toContain("unreadold@ex.test");
    expect(got).not.toContain("readold@ex.test");
  });
});

/**
 * ═══ THE CLIENT'S SHELF AND THE SERVER'S QUEUE ARE ONE SET ════════════════════════════════
 *
 * ── THE DEFECT, MEASURED (phone rig, a real account, 2026-09-11) ──────────────────────────
 *
 * `GET /screener` answered NINE waiting senders, every one of them physically in
 * `ohmail/Screener`. The client showed FOUR. The five missing each carried an ENABLED sender
 * rule to a consenting destination written WEEKS BEFORE their mail arrived: `consentPartition`
 * re-homed a ruled sender's gate mail to the rule's destination and `screenerSegments` groups
 * by folder over that projection, so those senders were no longer at the gate. The server
 * consults no rules at all, so the two ends were answering two different questions and the
 * narrower answer was shown as the mailbox's own count. The browser and the desktop derive
 * their queue from the same call (`apps/webapp/app/shell/screener-state.ts`).
 *
 * ── WHY REAL POSTGRES, AND WHY BOTH IMPLEMENTATIONS IN ONE FILE ───────────────────────────
 *
 * The same argument the cutline's own parity test makes: two implementations of one question
 * is two things that can disagree, and neither can see the disagreement from inside. One set of
 * rows, both readers, one answer. The rows are INSERT-only under a fresh `account_id`.
 *
 * ── THE TWO ADMITTED DIFFERENCES, ASSERTED RATHER THAN ARRANGED OUT ───────────────────────
 *
 * 1. A sender whose mail is only in the INBOX is presented at the gate by the cutline and minted
 *    as a row the commit routes PAST the gate (#116); the server's queue is `desired_folder =
 *    'ohmail/Screener'` and cannot name them. So the equality is over the GATE-PHYSICAL rows.
 * 2. A sender the person SCREENED OUT is on the server's list — it consults no rules — and on the
 *    client's screened-out shelf rather than its waiting one. That is not a drop: the person
 *    answered, their answer decides which shelf, and both shelves are the Screener. An admission
 *    nobody carried out is the asymmetric half, and it is what this fix is about.
 *
 * ── MUTATIONS WATCHED (each applied, restored, `cmp`-proven) ──────────────────────────────
 *
 *  · `consent-cutline.ts`' gate branch back to `if (decided !== null)` — the shape this fixes
 *      ⇒ "the two ends hold the same senders" RED, the address-ruled and the domain-ruled sender
 *        both gone from the client's shelf, and ten more cases RED across the engine and the two
 *        shells.
 *  · `heldAtGate`'s folder half to `=== "INBOX"` — the exemption kept, aimed at the wrong
 *      residence ⇒ the same case RED, and #116's own case ("the INBOX rule flips the sender from
 *      the Screener to the Ohbox") RED with it, which is what says this exemption is about the
 *      GATE and leaves the INBOX projection alone.
 *  · `heldAtGate`'s `consented` term to `decided !== null` — the denial leaking into the
 *      exemption ⇒ both cases here RED, plus the screened-out arms of
 *      `client-engine/test/consent-partition-exclusions.test.ts`. This one was a real defect on
 *      the way to the fix: it re-asked about senders the person had screened out.
 */
const RULED_HELD = new Date("2026-09-09T00:00:00.000Z");
const RULED_RETIRED = new Date("2023-06-11T00:00:00.000Z");

/**
 * Three senders held at the gate — one plain, one with an ADDRESS rule, one with a DOMAIN rule —
 * plus a ruled sender the cutline has retired (excluded on both ends) and an INBOX-only stranger
 * (the admitted difference above). The rules point at the three destinations the rig's five
 * actually carried.
 */
async function seedRuled(): Promise<{ accountId: string; own: string }> {
  const accountId = randomUUID();
  const own = `ruled-${accountId.slice(0, 8)}@example.test`;
  await db.insert(accounts).values({ id: accountId, name: `ruled-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: own,
  }).returning();
  await db.insert(accountSettings).values({
    accountId, screeningBaselineAt: BASELINE, dormancyDays: DORMANCY, screeningScope: "window",
    updatedAt: NOW,
  });

  let n = 0;
  const put = async (from: string, folder: string, date: Date, unread: boolean) => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `r${i}`, dedupKey: `ruled:${randomUUID()}`,
      subject: `Note ${i}`, snippet: `s${i}`, fromAddress: from, date, unread,
      nativeLocator: { folder, ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: folder, observedFolder: folder,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
  };

  await put("plain@ex.test", "ohmail/Screener", RULED_HELD, false);
  await put("ruled@ex.test", "ohmail/Screener", RULED_HELD, false);
  await put("anyone@ruled.example", "ohmail/Screener", RULED_HELD, false);
  await put("retired@ex.test", "ohmail/Screener", RULED_RETIRED, false);
  await put("denied@ex.test", "ohmail/Screener", RULED_HELD, false);
  await put("inboxonly@ex.test", "INBOX", RULED_HELD, true);

  for (const r of [
    { kind: "sender", match: "ruled@ex.test", destination: "INBOX" },
    { kind: "domain", match: "ruled.example", destination: "ohmail/News" },
    { kind: "sender", match: "retired@ex.test", destination: "ohmail/Receipts" },
    { kind: "sender", match: "denied@ex.test", destination: "ohmail/Screened" },
  ]) {
    await db.insert(rules).values({
      accountId, kind: r.kind, match: r.match, destination: r.destination,
      enabled: true, provenance: "manual",
    });
  }
  return { accountId, own };
}

/** The same rows, in the mirror the browser and the desktop partition. */
async function mirrorOf(accountId: string): Promise<MemoryMirrorStore> {
  const stored = await db.select({
    id: messages.id, from: messages.fromAddress, unread: messages.unread,
    date: messages.date, folder: folderState.desiredFolder, mailboxId: messages.mailboxId,
  }).from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(eq(messages.accountId, accountId));
  const storedRules = await db.select().from(rules).where(eq(rules.accountId, accountId));

  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    ...stored.map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: {
        id: m.id, accountId, mailboxId: m.mailboxId, threadId: null, messageIdHeader: null,
        subject: "", from: { name: null, address: m.from }, to: [], cc: [],
        date: m.date ? m.date.toISOString() : null,
        folder: m.folder as Folder, snippet: "", unread: m.unread,
        hasAttachments: false, attachmentCount: 0,
        sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
        triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
      } satisfies EngineMessage,
    })),
    ...storedRules.map((r) => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: {
        id: r.id, kind: r.kind, match: r.match, destination: r.destination,
        priority: r.priority, provenance: r.provenance, enabled: r.enabled,
        stats: { hits: 0, lastHitAt: null, demotions: 0 },
        createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      } as unknown as RuleDTO,
    })),
  ] as SyncChange[]);
  return store;
}

/** The three shelves the web shell renders, read through the calls it makes. */
async function shelves(accountId: string, own: string) {
  const store = await mirrorOf(accountId);
  const opts = {
    now: NOW, baselineAt: BASELINE, dormancyDays: DORMANCY,
    screeningScope: "window" as const, ownAddresses: [own],
  };
  const part = consentPartition(store, opts);
  return screenerSegments(presentationReader(store, part), NOW);
}

const shelf = async (accountId: string, own: string) => (await shelves(accountId, own)).waiting;

describe.skipIf(!PG_UP)("the client's Screener shelf holds the senders the server is holding", () => {
  // A POOL OF ITS OWN. The suite above closes `client` in its `afterAll`, and suites in one file
  // run in order — reusing the handle would hand every query here a pool that is already ended.
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * THE TWO ENDS, AND WHERE 0.19.0 PARTED THEM.
   *
   * Written when the server's queue consulted no rule: it asked about every sender with mail at
   * the gate, and the shelf had to hold the same people or held mail would be invisible. That
   * direction is unchanged, asserted FIRST below. What changed: a sender already DECIDED ON — an
   * enabled rule sending them anywhere but the gate (a DENY destination included, ruled
   * 2026-09-16), or a contact — is no longer asked about, while their mail stays at the gate until
   * `gate-release.ts` empties it (`CLIENT-SHELF-STILL-LISTS-A-DECIDED-SENDER-WHILE-THEIR-MAIL-IS-HELD`).
   */
  it("THE SERVER'S QUEUE IS INSIDE THE CLIENT'S SHELF, and the difference is the decided senders", async () => {
    const { accountId, own } = await seedRuled();

    // The queue: held mail, grouped by sender, cutline applied — and now the decided senders out,
    // `denied@` among them since the ruling: a deny destination is an answer.
    const server = await listed(accountId);
    expect(server).toEqual(["plain@ex.test"]);

    const waiting = await shelf(accountId, own);
    const atTheGate = waiting.filter((w) => w.gatePhysical).map((w) => w.from.address.toLowerCase()).sort();
    // THE DIRECTION THAT MATTERS, unchanged: nothing the server asks about is missing from the
    // shelf.
    for (const a of server) {
      expect(atTheGate, "a server-queued sender missing from the shelf").toContain(a);
    }
    // The ruled-in senders are still on the CLIENT's shelf — their mail has not moved, and that
    // half of the earlier fix is what stops held mail vanishing from every surface at once.
    expect(atTheGate).toContain("ruled@ex.test");
    expect(atTheGate).toContain("anyone@ruled.example");
    // …and they are exactly the difference, named rather than left to subtraction.
    expect(atTheGate.filter((a) => !server.includes(a)))
      .toEqual(["anyone@ruled.example", "ruled@ex.test"]);
  });

  it("a SCREENED-OUT sender is on the screened-out shelf, and their mail has not moved", async () => {
    const { accountId, own } = await seedRuled();
    const seg = await shelves(accountId, own);

    expect(seg.screenedOut.map((r) => r.from.address)).toEqual(["denied@ex.test"]);
    expect(seg.waiting.map((r) => r.from.address)).not.toContain("denied@ex.test");
    // Still physically at the gate — nothing here moves mail, on either end.
    const held = await db.select({ folder: folderState.desiredFolder }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(eq(messages.accountId, accountId));
    expect(held.filter((r) => r.folder === "ohmail/Screener")).toHaveLength(5);
  });

  it("the cutline retires a ruled sender on BOTH ends — the shelf is not the folder", async () => {
    const { accountId, own } = await seedRuled();

    // `retired@` is ruled AND pre-cutline. The server's queue drops them on the cutline; the
    // client presents their gate mail in the rule's destination and the shelf drops them too.
    expect(await listed(accountId)).not.toContain("retired@ex.test");
    expect((await shelf(accountId, own)).map((w) => w.from.address)).not.toContain("retired@ex.test");
  });

  it("the ONE admitted difference is the past-the-gate row, and it says so", async () => {
    const { accountId, own } = await seedRuled();

    // The gate holds nothing for `inboxonly@`, so `GET /screener` cannot name them…
    expect(await listed(accountId)).not.toContain("inboxonly@ex.test");
    // …and the client mints the row anyway, marked so the commit routes past the gate (#116).
    const row = (await shelf(accountId, own)).find((w) => w.from.address === "inboxonly@ex.test");
    expect(row).toBeDefined();
    expect(row!.gatePhysical).toBe(false);
  });
});
