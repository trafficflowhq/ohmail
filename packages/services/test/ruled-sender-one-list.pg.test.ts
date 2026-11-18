import type { EngineMessage, Folder, RuleEntity as RuleDTO } from "@ohmail/wire";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState, rules } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { brandDialect } from "@trafficflow/db/dialect";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import type { Change } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import {
  MemoryMirrorStore, consentIndex, consentPartition, decidedDestination, presentationReader,
  screenerSegments, type SyncChange,
} from "@ohmail/client-engine";
import { ScreenerService, type ServiceContext } from "../src/index.js";
import { cutlineCounts } from "../src/consent-cutline.js";

/**
 * ═══ ONE MESSAGE IS NEVER IN THE OHBOX AND BEHIND A WAITING ROW AT ONCE ════════════════════
 *
 * ── THE DEFECT, MEASURED AT THIS LANE'S BASE, THROUGH THE REAL PIPELINE ────────────────────
 *
 * A sender carrying an enabled rule with a subject or body term, and mail from them arriving
 * AFTER the rule was written that the term does not name: `planChange` answered
 * `desired_folder = 'ohmail/Screener'`, `GET /screener` listed one waiting row, and
 * `cutlineCounts` over the same rows answered `decidedSenders: 1, activeUndecidedSenders: 0`.
 * The client's `consentIndex` reads that sender as decided too — its own comment is "terms
 * narrow placement, never admission. Never add a term check here" — so the message was
 * presented in the rule's destination and asked about at the gate at the same time. Both rows
 * (`RULED-SENDERS-MAIL-IS-STILL-BEING-HELD-AT-THE-GATE`,
 * `GATE-HELD-MAIL-IS-IN-TWO-LISTS-ON-THE-PHONE`) are that one fact.
 *
 * The gate now consults the account's standing decision about the sender
 * (`packages/core/src/rules.ts#standingRule`), which is the routing side of the predicate the
 * two consent surfaces already spell.
 *
 * ── WHY REAL POSTGRES, AND WHY BOTH ENDS IN ONE FILE ───────────────────────────────────────
 *
 * The claim is about two readers of ONE set of rows — the server's queue and the count beside
 * it are SQL, and the client partitions the same rows in TypeScript. Two implementations of one
 * question is what produced the defect, and neither can see the disagreement from inside. The
 * mail is INGESTED here rather than seeded: the defect is in what the pipeline DECIDES, and a
 * fixture that writes `folder_state` by hand asserts the fixture. INSERT-only under a fresh
 * `account_id`.
 *
 * ── MUTATIONS WATCHED (each applied, watched RED, restored, `cmp`-proven identical) ────────
 *
 * Named at the case each one reddens.
 */

const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const NOW = new Date("2026-09-12T10:00:00.000Z");
/** The rule is written weeks before the mail arrives — the rig account's own shape. */
const RULE_WRITTEN = new Date("2026-08-20T00:00:00.000Z");

const GATE: Folder = "ohmail/Screener";

interface World { accountId: string; mailboxId: string; own: string }

const ctx = (w: World): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId: w.accountId, userId: null, now: () => NOW, requestId: `rsl-${randomUUID().slice(0, 8)}`,
});

function eml(from: string, subject: string, body: string): Buffer {
  return Buffer.from([
    `Message-ID: <${randomUUID()}@ruled.test>`,
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    `Subject: ${subject}`,
    "Date: Fri, 11 Sep 2026 09:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "", body,
  ].join("\r\n"));
}

async function world(): Promise<World> {
  const accountId = randomUUID();
  const own = `rsl-${accountId.slice(0, 8)}@example.test`;
  await db.insert(accounts).values({ id: accountId, name: `rsl-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: own,
  }).returning();
  return { accountId, mailboxId: mb!.id, own };
}

/** A rule as a person's press writes it — `manual`, enabled, weeks before the mail. */
async function writeRule(
  w: World, over: { kind?: string; match: string; destination: string; subjectContains?: string; bodyContains?: string },
): Promise<void> {
  await db.insert(rules).values({
    accountId: w.accountId, kind: over.kind ?? "sender", match: over.match,
    destination: over.destination, enabled: true, provenance: "manual",
    priority: 0, subjectContains: over.subjectContains ?? null, bodyContains: over.bodyContains ?? null,
    createdAt: RULE_WRITTEN, updatedAt: RULE_WRITTEN,
  });
}

/** THE REAL PIPELINE — plan outside the transaction, commit inside one, as the worker does. */
async function ingest(
  w: World, from: string, subject = "the quarterly figures", body = "the numbers are in the attachment",
): Promise<string> {
  const change: Change = {
    type: "create",
    locator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e9)}` },
    raw: eml(from, subject, body),
    internalDate: new Date("2026-09-11T09:00:00.000Z"),
  };
  const repo = makeDrizzleRepo(db as never);
  const plan = await planChange(change, {
    repo, accountId: w.accountId, mailboxId: w.mailboxId, readerMode: false,
  });
  const res = await repo.transaction((tx) => commitChange(plan, {
    repo: tx, accountId: w.accountId, mailboxId: w.mailboxId, storageCap: UNMETERED_STORAGE_CAP,
  }));
  return res.messageId;
}

/** Every row this account holds, as the database has it after ingest. */
async function filed(w: World): Promise<Array<{ id: string; from: string; desired: string }>> {
  return db.select({
    id: messages.id, from: messages.fromAddress, desired: folderState.desiredFolder,
  }).from(messages)
    .innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(eq(messages.accountId, w.accountId));
}

/** The server's queue — one row per sender whose mail is physically held at the gate. */
async function serverQueue(w: World): Promise<string[]> {
  const page = await new ScreenerService({}).list(ctx(w), { limit: 100 });
  return page.items.map((i) => i.sender.address.toLowerCase()).sort();
}

/** The same rows in the mirror the browser, the desktop and the phone partition. */
async function mirrorOf(w: World): Promise<{ store: MemoryMirrorStore; ruleDTOs: RuleDTO[] }> {
  const stored = await filed(w);
  const storedRules = await db.select().from(rules).where(eq(rules.accountId, w.accountId));
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  const ruleDTOs = storedRules.map((r) => ({
    id: r.id, kind: r.kind, match: r.match, destination: r.destination,
    priority: r.priority, provenance: r.provenance, enabled: r.enabled,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: RULE_WRITTEN.toISOString(), updatedAt: RULE_WRITTEN.toISOString(),
  } as unknown as RuleDTO));
  await store.applyChanges([
    ...stored.map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: {
        id: m.id, accountId: w.accountId, mailboxId: w.mailboxId, threadId: null,
        messageIdHeader: null, subject: "", from: { name: null, address: m.from }, to: [], cc: [],
        date: "2026-09-11T09:00:00.000Z", folder: m.desired as Folder, snippet: "", unread: true,
        hasAttachments: false, attachmentCount: 0,
        sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
        triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
      } satisfies EngineMessage,
    })),
    ...ruleDTOs.map((r) => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: NOW.toISOString(), entity: r,
    })),
  ] as SyncChange[]);
  return { store, ruleDTOs };
}

/** The shelves the client renders, through the calls the shells make. */
async function clientShelves(w: World) {
  const { store, ruleDTOs } = await mirrorOf(w);
  const opts = { now: NOW, baselineAt: null, ownAddresses: [w.own] };
  const part = consentPartition(store, opts);
  return { segments: screenerSegments(presentationReader(store, part), NOW), part, store, ruleDTOs };
}

/**
 * THE ACCOUNT, WITH ALL THREE ORDERS AT ONCE.
 *
 *  · `narrow@ex.test`    — a SUBJECT-narrowed rule to Reads, written weeks first; the arriving
 *                          mail does not carry the term. The defect.
 *  · `narrowbody@ex.test`— a DOMAIN rule with a BODY term, same shape, other axis.
 *  · `bare@ex.test`      — an unnarrowed rule to Reads, written first. Worked before, must not move.
 *  · `denied@ex.test`    — a narrowed DENY rule to Quarantine, written first.
 *  · `later@ex.test`     — mail FIRST, rule after: the backlog, which is `rule-retro`'s job.
 *  · `stranger@ex.test`  — no rule at all. The gate's ordinary customer.
 */
async function account(): Promise<World> {
  const w = await world();
  await writeRule(w, { match: "narrow@ex.test", destination: "ohmail/News", subjectContains: "invoice" });
  await writeRule(w, { kind: "domain", match: "narrowbody.test", destination: "INBOX", bodyContains: "unsubscribe" });
  await writeRule(w, { match: "bare@ex.test", destination: "ohmail/News" });
  await writeRule(w, { match: "denied@ex.test", destination: "ohmail/Quarantine", subjectContains: "invoice" });

  await ingest(w, "narrow@ex.test");
  await ingest(w, "someone@narrowbody.test");
  await ingest(w, "bare@ex.test");
  await ingest(w, "denied@ex.test");
  await ingest(w, "later@ex.test");
  await ingest(w, "stranger@ex.test");

  // The backlog order: the rule arrives after the mail is already filed at the gate.
  await writeRule(w, { match: "later@ex.test", destination: "ohmail/News" });
  return w;
}

const placed = (rows: Array<{ from: string; desired: string }>, from: string): string =>
  rows.find((r) => r.from.toLowerCase() === from)!.desired;

describe.skipIf(!PG_UP)("a rule is applied to the mail that arrived after it", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 180_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * RULE THEN INGEST — the order that was broken.
   *
   * MUTATION: delete the `standingRule` consult from `evaluateRules` ⇒ both narrowed senders
   * land in `ohmail/Screener` and this case is RED on the first assertion.
   */
  it("a narrowed rule's sender is filed past the gate, and mints no waiting row", async () => {
    const w = await account();
    const rows = await filed(w);
    expect(placed(rows, "narrow@ex.test")).not.toBe(GATE);
    expect(placed(rows, "someone@narrowbody.test")).not.toBe(GATE);

    const queue = await serverQueue(w);
    expect(queue).not.toContain("narrow@ex.test");
    expect(queue).not.toContain("someone@narrowbody.test");
  });

  /** POSITIVE CONTROL: the unnarrowed rule still files exactly where it always did. */
  it("an unnarrowed rule still files its sender's mail at the rule's destination", async () => {
    const w = await account();
    expect(placed(await filed(w), "bare@ex.test")).toBe("ohmail/News");
  });

  /**
   * THE DENIAL IS CARRIED OUT — the deny's destination, and no waiting row.
   *
   * MUTATION: drop the deny arm from the standing branch ⇒ RED (`INBOX` for `ohmail/Quarantine`).
   */
  it("a denied sender's new mail goes where the deny says", async () => {
    const w = await account();
    expect(placed(await filed(w), "denied@ex.test")).toBe("ohmail/Quarantine");
    expect(await serverQueue(w)).not.toContain("denied@ex.test");
  });

  /**
   * INGEST THEN RULE — today's behaviour, kept. Gate-held mail that predates the rule is the
   * backlog, and no ingest path re-files it: `packages/organizer/src/rule-retro.ts` empties it, on the
   * press `applyRuleRequest` stamps or on the licence `gate-release.ts` arms.
   *
   * WHAT CHANGED IN 0.19.0 IS THE LISTING, NOT THE MAIL. The queue no longer ASKS about a sender
   * this account has already decided on, because calling a correspondent of a decade a first-time
   * sender is a false state — and the same release that makes that safe is what empties this
   * backlog. So the mail is still at the gate here, and the queue is silent about it.
   *
   * MUTATION: make the standing consult run for an EXISTING message too (re-plan on
   * re-observation) ⇒ RED, the backlog silently moved by something that is not the retro pass.
   */
  it("mail that predates its rule stays at the gate — the backlog is the retro pass's job", async () => {
    const w = await account();
    expect(placed(await filed(w), "later@ex.test")).toBe(GATE);
    // The MAIL is untouched; the QUEUE has stopped asking. Both halves asserted, because the one
    // that changed is the one a reader would otherwise have to infer.
    expect(await serverQueue(w)).not.toContain("later@ex.test");
  });

  /** CONTROL: the gate's ordinary customer is held exactly as before. */
  it("an unruled stranger is still held at the gate", async () => {
    const w = await account();
    expect(placed(await filed(w), "stranger@ex.test")).toBe(GATE);
    expect(await serverQueue(w)).toContain("stranger@ex.test");
  });

  /**
   * THE TWO SURFACES, ONE ANSWER. `consentIndex` is what every client reads as "this account has
   * decided about this sender"; the queue is what the server still asks about. A sender in both
   * is the defect, and there is now NONE — the backlog sender, whose rule was written after their
   * mail was already filed, was the last one and 0.19.0's `senderIsDecidedSql` takes them out of
   * the queue too. Their mail is still at the gate; `gate-release.ts` is what moves it.
   *
   * The four-against-five reading is gone with it: the queue and the count now answer the same
   * number, which is the property the earlier version could only state about four of the five.
   *
   * MUTATION: delete the `standingRule` consult from `evaluateRules` ⇒ RED, with
   * `narrow@ex.test`, `someone@narrowbody.test` and `denied@ex.test` in the queue.
   */
  it("NO decided sender is left in the queue at all", async () => {
    const w = await account();
    const { ruleDTOs } = await mirrorOf(w);
    const index = consentIndex(ruleDTOs);
    const queue = await serverQueue(w);
    const bothWays = queue.filter((a) => decidedDestination(index, a) !== null);
    expect(bothWays).toEqual([]);

    // The server's own count of decided senders, over the same rows, agrees there are five —
    // the four whose rules came first and the backlog one whose rule came after.
    const counts = await cutlineCounts(ctx(w), {});
    expect(counts.decidedSenders).toBe(5);
    // …and the queue is exactly the senders this account has not answered for. ONE, and the count
    // beside it says one: the list and the number are the same rule now, not two that agree about
    // four senders and differ about the fifth.
    expect(queue).toEqual(["stranger@ex.test"]);
    expect(counts.activeUndecidedSenders).toBe(1);
  });

  /**
   * THE CENSUS, AT THE MESSAGE ID — the row both gap rows describe.
   *
   * Every message the client presents somewhere other than the gate must not be a message the
   * server is holding at the gate, and vice versa. The client-side exemptions that landed in
   * `fix-017-web-screener-ruled-senders` and `fix-018-phone-screener-partition` are what make
   * the recoverable direction true for the BACKLOG; this asserts the server no longer produces
   * the double state in the first place, over all three orders at once.
   *
   * MUTATION: delete the `standingRule` consult ⇒ RED with the two narrowed ids named.
   */
  it("no message id is in the Ohbox and behind a waiting row at the same time", async () => {
    const w = await account();
    const rows = await filed(w);
    const heldIds = rows.filter((r) => r.desired === GATE).map((r) => r.id);

    const { segments, part } = await clientShelves(w);
    // `placeOf` is total over the mirror, so every held id has an answer here. A held message
    // whose place is a PILE is the double state: asked about at the gate, shown as already filed.
    const inBoth = heldIds.filter((id) => {
      const place = part.placeOf.get(id) ?? null;
      return place !== null && place !== GATE;
    });
    expect(inBoth).toEqual([]);

    /* THE SHELF AND THE QUEUE, AND WHERE THEY NOW PART — narrowed to the half still measured true.
     *
     * The server stopped ASKING about a sender this account has decided on (0.19.0); the client's
     * shelf is derived from the mirror and still shows one while their mail sits at the gate. So
     * the queue is a SUBSET of the shelf, and the difference is exactly the decided senders whose
     * backlog `gate-release.ts` empties — after which the mirror has nothing at the gate for them
     * and the two agree again.
     *
     * The direction that matters is unchanged and asserted first: nothing the server asks about is
     * missing from the shelf, so no sender can be waiting on the server and invisible on a client.
     * The other direction is `CLIENT-SHELF-STILL-LISTS-A-DECIDED-SENDER-WHILE-THEIR-MAIL-IS-HELD`,
     * filed by `changes/fix-0190-known-sender-is-never-first-time.md` — the client half of the
     * defect this file's own header describes, which no server change can reach.
     */
    const shelf = segments.waiting
      .filter((r) => r.gatePhysical).map((r) => r.from.address.toLowerCase()).sort();
    const queue = await serverQueue(w);
    for (const a of queue) expect(shelf, "a server-queued sender missing from the shelf").toContain(a);
    expect(shelf.filter((a) => !queue.includes(a)))
      .toEqual(["later@ex.test"]);
  });
});
