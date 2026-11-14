import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, contacts, folderState, mailboxes, messageBodies, messages, rules,
  type Tx,
  accountPass, readPassProgress,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { heldReleaseSummary } from "@trafficflow/services/mail";
import { gateReleasePass } from "../src/gate-release.js";
import { ruleRetroPass } from "../src/rule-retro.js";

/**
 * ═══ THE SWEEP AND THE RELEASE SCREEN ARE ONE SET ═════════════════════════════════════════
 *
 * `gateReleasePass` has to act on exactly the mail `held-release-service.ts#heldAtGate` offers,
 * and the two predicates live on opposite sides of a dependency boundary — the worker may not
 * import the services package (`deps.test.ts`), so the spellings cannot be shared. The tie is
 * therefore behavioural and it is here: one fixture, both readers, the same senders.
 *
 * `.pg.test.ts` and not PGlite for `rule-retro.pg.test.ts`'s reasons: the sweep selects its page
 * `FOR UPDATE OF folder_state` (a no-op under a single-connection engine) and its candidate query
 * is six `NOT EXISTS`/`EXISTS` arms plus a correlated `EXISTS` over `rules` carrying
 * `Dialect.domainOf`, whose counts are the only thing separating a correct predicate from an
 * accidentally always-true one. The fixture is INSERT-only under a fresh `account_id`.
 */

const PG_UP = await realPgAvailable();
const GATE = "ohmail/Screener";
const OHBOX = "INBOX";
const NOW = new Date("2026-09-13T20:00:00.000Z");
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

interface World { accountId: string; ids: Record<string, string> }

async function seed(): Promise<World> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `grp-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `grp-${accountId.slice(0, 8)}@example.test`,
    organizerRole: "organizer",
  }).returning();
  const ids: Record<string, string> = {};

  let n = 0;
  const message = async (key: string, from: string, desired: string, lastSetBy: string) => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `grp:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: from, unread: true,
      nativeLocator: { folder: desired, ref: `1:${i}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: desired, observedFolder: desired,
      lastSetBy, reconcileStatus: "reconciled", conflict: false,
    });
    ids[key] = m!.id;
  };

  await message("knownHeld", "known@x.test", GATE, "us");
  await message("domainHeld", "someone@corp.test", GATE, "us");
  await message("palHeld", "pal@x.test", GATE, "us");
  await message("strangerHeld", "stranger@x.test", GATE, "us");

  await db.insert(rules).values([
    {
      // MIXED CASE and not untrimmed: the SQL predicates normalize with `trim(lower(...))` while
      // `core/rules.ts#namesAuthor` lower-cases WITHOUT trimming, so a stored match with edge
      // whitespace would be armed here and then declined by the router. That asymmetry is not
      // this pass's to fix, and a fixture that leaned on it would be measuring it by accident.
      accountId, kind: "sender", match: "Known@X.Test", destination: OHBOX,
      provenance: "seeded-from-sent", enabled: true, priority: 0, retroRequestedAt: null,
    },
    {
      accountId, kind: "domain", match: "corp.test", destination: "ohmail/News",
      provenance: "manual", enabled: true, priority: 0, retroRequestedAt: null,
    },
  ]);
  await db.insert(contacts).values({ accountId, address: "pal@x.test" });
  return { accountId, ids };
}

const desiredOf = async (id: string): Promise<string> => {
  const [r] = await db.select().from(folderState).where(eq(folderState.messageId, id)).limit(1);
  return r!.desiredFolder;
};

describe.skipIf(!PG_UP)("the gate release sweep, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, { schema }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  it("arms exactly the rules the release screen offers a press for", async () => {
    const w = await seed();
    // What the person would be shown, BEFORE the sweep: one group per rule holding mail at the
    // gate. `pal@` is not on it — no rule, no group — which is why the sweep has a second half.
    const before = await heldReleaseSummary(db as unknown as Tx, w.accountId);
    expect(before.groups.map((g) => g.match).sort()).toEqual(["Known@X.Test", "corp.test"]);

    const out = await gateReleasePass(db as unknown as Tx, { accountId: w.accountId }, NOW);
    expect(out.rulesArmed).toBe(before.groups.length);
    expect(out.contactRowsReleased).toBe(1);
    expect(out.completed).toBe(true);

    // …and the screen is empty afterwards: every armed rule is in flight, which is exactly what
    // `decidedRule` excludes. A second press would find nothing, and so does a second sweep.
    const after = await heldReleaseSummary(db as unknown as Tx, w.accountId);
    expect(after.groups).toEqual([]);
    expect(after.total).toBe(0);
  });

  it("the retro pass then files the armed senders' mail where the RULES send it", async () => {
    const w = await seed();
    await gateReleasePass(db as unknown as Tx, { accountId: w.accountId }, NOW);
    await ruleRetroPass(
      db as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE },
      new Date(NOW.getTime() + 1000),
    );
    expect(await desiredOf(w.ids.knownHeld!)).toBe(OHBOX);
    // The DOMAIN rule's own destination, through the router — not the Ohbox by default.
    expect(await desiredOf(w.ids.domainHeld!)).toBe("ohmail/News");
    // Half two's row, filed by the sweep itself.
    expect(await desiredOf(w.ids.palHeld!)).toBe(OHBOX);
    // And the stranger is still waiting for a person.
    expect(await desiredOf(w.ids.strangerHeld!)).toBe(GATE);
  });

  it("stamps the account, and a second sweep reads the stamp", async () => {
    const w = await seed();
    await gateReleasePass(db as unknown as Tx, { accountId: w.accountId }, NOW);
    const s = await readPassProgress(db as unknown as Tx, accountPass("gate_release", w.accountId));
    expect(s.doneAt?.getTime()).toBe(NOW.getTime());
    const again = await gateReleasePass(db as unknown as Tx, { accountId: w.accountId }, NOW);
    expect(again.ran).toBe(false);
  });
});
