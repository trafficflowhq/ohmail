import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { runMigrations } from "@trafficflow/db/admin";
import { brandDialect } from "@trafficflow/db/dialect";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, contacts, folderState, mailboxes, messageBodies, messages, rules, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { ScreenerService, type ServiceContext } from "@trafficflow/services";
import { heldReleaseSummary } from "@trafficflow/services/mail";
import { cutlineCounts } from "../src/consent-cutline.js";

/**
 * ═══ THE POSTGRES TWIN OF `screener-known-sender.test.ts` ═════════════════════════════════
 *
 * `senderIsDecidedSql` is a correlated `exists` over two tables, carrying {@link Dialect.domainOf}
 * and a nested `not exists`, composed into the OUTER half of the queue's windowed query beside a
 * row-value keyset, and into the `classified` CTE of a statement with four CTEs above it.
 * Whether it composes there — and whether the server and the device store answer the same sender
 * set — is a claim about a database, so it is run against one. The PGlite sibling carries the
 * product cases; this is the server arm, and `packages/db/test/sqlite-cutline.test.ts` is the
 * device arm.
 *
 * The fixture is INSERT-only under a fresh `account_id`, so nothing here is visible to another
 * test sharing this database.
 */

const PG_UP = await realPgAvailable();
const GATE = "ohmail/Screener";
const NOW = new Date("2026-09-13T12:00:00.000Z");
const RECENT = new Date("2026-09-12T09:11:00.000Z");

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

const ctxOf = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: `ksp-${randomUUID().slice(0, 8)}`,
});

/** The reported account's four senders — the same shape as the PGlite sibling's. */
async function seed(): Promise<string> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ksp-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `ksp-${accountId.slice(0, 8)}@example.test`,
    organizerRole: "organizer",
  }).returning();

  let n = 0;
  const message = async (from: string, folder: string, lastSetBy: string) => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `ksp:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: from, date: RECENT, unread: true,
      createdAt: RECENT, nativeLocator: { folder, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: folder, observedFolder: folder,
      lastSetBy, reconcileStatus: "reconciled", conflict: false,
    });
  };

  await message("known@x.test", GATE, "us");
  await message("known@x.test", "INBOX", "us");
  await message("pal@x.test", GATE, "us");
  await message("someone@corp.test", GATE, "us");
  await message("blocked@x.test", GATE, "us");
  await message("stranger@x.test", GATE, "us");

  await db.insert(rules).values([
    {
      accountId, kind: "sender", match: " Known@X.Test ", destination: "INBOX",
      provenance: "seeded-from-sent", enabled: true, priority: 0, retroRequestedAt: null,
    },
    // The DOMAIN arm, which is the one carrying `domainOf` — `substring … position` here and
    // `substr … instr` on the device.
    {
      accountId, kind: "domain", match: "corp.test", destination: "ohmail/News",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    },
    {
      accountId, kind: "sender", match: "blocked@x.test", destination: "ohmail/Screened",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    },
  ]);
  for (const address of ["known@x.test", "pal@x.test", "blocked@x.test"]) {
    await db.insert(contacts).values({ accountId, address });
  }
  return accountId;
}

const listed = async (accountId: string): Promise<string[]> => {
  const page = await new ScreenerService({}).list(ctxOf(accountId), { limit: 100 });
  return page.items.map((i) => i.sender.address.toLowerCase()).sort();
};

describe.skipIf(!PG_UP)("the decided predicate, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("the queue holds the stranger and nobody else", async () => {
    const accountId = await seed();
    // `known@` (an allow rule stored untrimmed and mixed-case, plus a contact), `pal@` (a contact
    // alone) and `someone@corp.test` (a DOMAIN allow rule) are decided — and since the 2026-09-16
    // ruling so is `blocked@`, whose deny rule is an answer like any other. Only the gate
    // itself means "keep asking me". Their held mail is offered for release, never hidden.
    expect(await listed(accountId)).toEqual(["stranger@x.test"]);
  });

  it("the count drops every sender the queue drops", async () => {
    const accountId = await seed();
    const counts = await cutlineCounts(ctxOf(accountId), { baselineAt: null, dormancyDays: 60 });
    // One: the stranger. `blocked@` is the pre-existing divergence the sibling names — this count
    // has always read any destination off the gate as a decision, deny included.
    expect(counts.activeUndecidedSenders).toBe(1);
  });

  it("the held mail of both excluded rule-senders is offered for release", async () => {
    const accountId = await seed();
    const { groups } = await heldReleaseSummary(db as unknown as Tx, accountId);
    // The group's `match` is the rule's STORED value, untrimmed — the predicate normalizes with
    // `trim(lower(...))` and the screen names the rule as the person wrote it. Pinned as it comes
    // back rather than normalized in the assertion, so a lane that starts trimming on the way out
    // has to say so here.
    expect(groups.map((g) => g.match).sort())
      .toEqual([" Known@X.Test ", "blocked@x.test", "corp.test"]);
  });
});
