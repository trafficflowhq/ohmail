import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  contacts as pgContacts, folderState as pgFolderState, mailboxes as pgMailboxes,
  messages as pgMessages, rules as pgRules,
} from "@trafficflow/db";
import {
  contacts as deviceContacts, folderState as deviceFolderState, mailboxes as deviceMailboxes,
  messages as deviceMessages, rules as deviceRules,
} from "../src/schema-mail-sqlite.js";
import { makeTestDb, TEST_DIALECT_ENV } from "../src/testing.js";
import { dialect, dialectOf } from "../src/dialect/index.js";
import {
  resolveCutline, senderIsActiveSql, senderIsDecidedSql, senderIsOwnSql, activeSenderExpr, anyOf,
  CUTLINE_PRESENTED_FOLDERS, CUTLINE_GATE_FOLDER, destinationIsDecision,
} from "../src/screener-cutline.js";

/**
 * ═══ THE CUTLINE ANSWERS THE SAME SENDER SET ON BOTH STORES ═══════════════════════════════
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────────────────────
 *
 * `screener-cutline.ts` is read by three server paths — `GET /consent`'s counts,
 * `GET /screener`'s page and the auto-suggest candidate set — and the phone runs the same engine
 * on the device store. Its first draft was Postgres-only (`::timestamptz`, `bool_or`, `::uuid`),
 * which would have reintroduced at the CALL SITE exactly what `cutlineCounts` had just removed,
 * and NO existing test could have refused it: every cutline test in the tree is a Postgres twin.
 * So the module is the seam's, and this is the run that proves it.
 *
 * Rendering the predicate proves only that it was composed. `jsonHasAny` was composed correctly
 * on both arms and was valid SQL on neither, because nothing had ever run it. This RUNS it, on
 * whichever store the matrix is pointed at, and compares the sender SET.
 *
 * ── THE FIXTURE IS THE REPORTED SHAPE ─────────────────────────────────────────────────────
 *
 * Four held first-contact senders of which the cutline keeps exactly one:
 *
 *  · `ancient`   — read, 2023, arrived 2023. Pre-cutline on every term.
 *  · `unreadold` — UNREAD, 2023, arrived 2023. The discriminating case: with a baseline, unread
 *                  does NOT outrank age, so this is the sender a wrong unread term revives.
 *  · `undated`   — no `Date:` header at all, a field the SENDER controls, ARRIVED YESTERDAY. The
 *                  cutline dates it by the arrival (`cutlineInstant`), so it is one of the two
 *                  that stay: the header alone retired mail the mailbox had just recorded.
 *  · `staleundated` — no header either, but ARRIVED IN 2023. The other arm, so the rule cannot
 *                  be "undated is always active" — which would pin a sender in the queue for
 *                  ever on a header the sender controls.
 *  · `fresh`     — post-baseline. The one that must stay on its header alone.
 *
 * ── MUTATIONS WATCHED (each restored, `cmp`-proven) ───────────────────────────────────────
 *
 *  · `anyOf` → `sql`bool_or(${cond})``            ⇒ the SQLite arm RED (no such function),
 *                                                   the Postgres arm still green. That asymmetry
 *                                                   IS the defect this file exists to catch.
 *  · `d.ts(c.cutoff)` → `${c.cutoff.toISOString()}::timestamptz`
 *                                                 ⇒ the SQLite arm RED, Postgres green.
 *  · `d.castUuid(accountId)` → `${accountId}::uuid` ⇒ the SQLite arm RED, Postgres green.
 *  · the baselined unread term → `anyUnread`      ⇒ BOTH arms RED on `unreadold`.
 *  · `cutlineInstant` → the `date` column alone    ⇒ BOTH arms RED on `undated`, which is mail
 *                                                   the mailbox recorded yesterday.
 */

/**
 * THE FIXTURE'S TABLES, and this is the ONE thing here that knows which store it is on.
 *
 * `makeTestDb()` hands back a handle typed against the SERVER, and the two twins are different
 * objects with different column DEFAULTS — the server's `now()` does not exist on the device. So
 * the INSERTS are addressed to the twin in front of us and the types are the server's, exactly as
 * `sqlite-matrix.test.ts` does it. The claim under test is untouched by this: `senderIsActiveSql`
 * is composed once, from the seam, and both runs execute the same expression.
 */
const ON_SQLITE = process.env[TEST_DIALECT_ENV] === "sqlite";
const mailboxes = (ON_SQLITE ? deviceMailboxes : pgMailboxes) as unknown as typeof pgMailboxes;
const messages = (ON_SQLITE ? deviceMessages : pgMessages) as unknown as typeof pgMessages;
const folderState = (ON_SQLITE ? deviceFolderState : pgFolderState) as unknown as typeof pgFolderState;
const rules = (ON_SQLITE ? deviceRules : pgRules) as unknown as typeof pgRules;
const contacts = (ON_SQLITE ? deviceContacts : pgContacts) as unknown as typeof pgContacts;

const BASELINE = new Date("2026-08-12T00:00:00.000Z");
const NOW = new Date("2026-09-11T00:00:00.000Z");
const ACCOUNT = "11111111-2222-3333-4444-555555555555";
const MAILBOX = "22222222-3333-4444-5555-666666666666";

/** Ids are opaque text on both stores; the server twin needs them uuid-shaped. */
const MSG = (n: number) => `33333333-4444-5555-6666-77777777770${n}`;

async function seeded(scope: string) {
  const db = await makeTestDb();
  // The mailbox first: `messages.mailbox_id` is a real foreign key on both twins.
  await db.insert(mailboxes).values({
    id: MAILBOX, accountId: ACCOUNT, provider: "imap", address: "cut@example.test",
  } as never);
  let n = 0;
  /**
   * One held message. `arrivedAt` is STATED rather than left to the column default: the default
   * is `now()` on the server twin and a literal on the device twin, and a fixture whose arrival
   * moves with the wall clock would pass for the property on some days and not others.
   */
  const held = async (from: string, date: Date | null, unread: boolean, arrivedAt: Date) => {
    const id = MSG(n++);
    await db.insert(messages).values({
      id, accountId: ACCOUNT, mailboxId: MAILBOX, bodyHash: `h${n}`, dedupKey: `cut:${n}`,
      subject: `Note ${n}`, snippet: "", fromAddress: from, date, unread, createdAt: arrivedAt,
    } as never);
    await db.insert(folderState).values({
      messageId: id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    } as never);
  };
  const ANCIENT = new Date("2023-06-23T00:00:00.000Z");
  const YESTERDAY = new Date("2026-09-10T00:00:00.000Z");
  await held("ancient@ex.test", ANCIENT, false, ANCIENT);
  await held("unreadold@ex.test", new Date("2023-02-01T00:00:00.000Z"), true, ANCIENT);
  await held("undated@ex.test", null, true, YESTERDAY);
  await held("staleundated@ex.test", null, false, ANCIENT);
  await held("fresh@ex.test", new Date("2026-09-09T00:00:00.000Z"), true, YESTERDAY);
  return { db, cutline: resolveCutline({ baselineAt: BASELINE, dormancyDays: 365, scope, now: NOW }) };
}

/** Every held sender this store calls ACTIVE, through the predicate the three readers use. */
async function activeSenders(db: Awaited<ReturnType<typeof makeTestDb>>, c: ReturnType<typeof resolveCutline>) {
  const d = dialect(db);
  const rows = await d.exec(db, sql`
    select distinct lower(m.from_address) as s
      from messages m
      join folder_state fs on fs.message_id = m.id
     where m.account_id = ${d.castUuid(ACCOUNT)}
       and fs.desired_folder = 'ohmail/Screener'
       and ${senderIsActiveSql(d, ACCOUNT, sql`lower(m.from_address)`, c, [])}
     order by 1
  `);
  return rows.map((r) => String(r[0]));
}

describe("the cutline, ANSWERED by whichever store the matrix is pointed at", () => {
  it("keeps the two active senders and retires the other three", async () => {
    const { db, cutline } = await seeded("window");
    // `undated` is here because the cutline dates it by its ARRIVAL. RED before the fallback:
    // the answer was `["fresh@ex.test"]` alone, and mail recorded yesterday retired its sender.
    expect(await activeSenders(db, cutline)).toEqual(["fresh@ex.test", "undated@ex.test"]);
  });

  it("an UNDATED message that arrived YEARS ago still retires — the arrival is read, not ignored", async () => {
    const { db, cutline } = await seeded("window");
    expect(await activeSenders(db, cutline)).not.toContain("staleundated@ex.test");
  });

  it("a sender with NO datable mail at all is not active — the null arm of the shared expression", async () => {
    // `activeSenderExpr` does not own `newest`; a caller can hand it one that answers NULL, and
    // the guard must refuse rather than compare against nothing. Driven here because no fixture
    // row can produce it any more: `created_at` is NOT NULL on both stores.
    const db = await makeTestDb();
    const d = dialect(db);
    const c = resolveCutline({ baselineAt: BASELINE, dormancyDays: 365, now: NOW });
    const expr = activeSenderExpr(d, c, {
      anyUnread: sql`false`, anyUnreadInWindow: sql`false`, newest: sql`null`,
    });
    const [row] = await d.exec(db, sql`select ${expr} as v`);
    expect(Boolean(row?.[0]), `on ${dialectOf(db)}`).toBe(false);
  });

  it("an UNREAD pre-cutline sender stays retired — a baseline outranks unread", async () => {
    const { db, cutline } = await seeded("window");
    expect(await activeSenders(db, cutline)).not.toContain("unreadold@ex.test");
  });

  it("`all_time` brings every retired sender back", async () => {
    const { db, cutline } = await seeded("all_time");
    expect(await activeSenders(db, cutline)).toEqual(
      ["ancient@ex.test", "fresh@ex.test", "staleundated@ex.test", "undated@ex.test",
        "unreadold@ex.test"],
    );
  });

  it("`anyOf` is a boolean aggregate on BOTH stores, and it is the answer that proves it", async () => {
    // Rendered it looks portable on either arm; only running it says so. `true`/`false` come back
    // as the store's own boolean, so the comparison is on the ANSWER rather than on its spelling.
    const db = await makeTestDb();
    const d = dialect(db);
    const [any1] = await d.exec(db, sql`select ${anyOf(sql`1 = 1`)} as v`);
    const [none] = await d.exec(db, sql`select ${anyOf(sql`1 = 0`)} as v`);
    expect(Boolean(any1?.[0])).toBe(true);
    expect(Boolean(none?.[0])).toBe(false);
  });

  /**
   * ── THE DECIDED PREDICATE, ON WHICHEVER STORE THE MATRIX IS POINTED AT ───────────────────
   *
   * `senderIsDecidedSql` reaches two tables `senderIsActiveSql` never touches (`rules`,
   * `contacts`) plus {@link Dialect.domainOf}, `substring … position` on the server and
   * `substr … instr` on the device — and the phone runs both. So it is answered here, not read.
   * Every arm has a row: an allow rule, a DOMAIN allow rule, a contact with no rule, a contact the
   * GATE defeats, a deny rule alone, a DISABLED allow rule, a stranger. RULED 2026-09-16: a DENY
   * destination IS a decision, and two arms changed sides with it.
   */
  it("a sender the account already decided is decided, the gate alone is not", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const rule = async (kind: string, match: string, destination: string, enabled = true) => {
      await db.insert(rules).values({
        accountId: ACCOUNT, kind, match, destination, enabled, priority: 0,
        provenance: "seeded-from-sent",
      } as never);
    };
    await rule("sender", "Known@Ex.Test ", "INBOX");       // stored untrimmed and mixed-case
    await rule("domain", "corp.test", "ohmail/News");
    await rule("sender", "blocked@ex.test", "ohmail/Screened");
    await rule("sender", "denied@ex.test", "ohmail/Quarantine");
    await rule("sender", "asked@ex.test", "ohmail/Screener");
    await rule("sender", "odd@ex.test", "ohmail/NobodyClassifiedThis");
    await rule("sender", "off@ex.test", "INBOX", false);
    for (const address of ["known@ex.test", "pal@ex.test", "blocked@ex.test", "asked@ex.test"]) {
      await db.insert(contacts).values({ accountId: ACCOUNT, address } as never);
    }

    const decided = async (address: string): Promise<boolean> => {
      const [row] = await d.exec(db, sql`
        select ${senderIsDecidedSql(d, ACCOUNT, sql`lower(${address})`)} as v
      `);
      return Boolean(row?.[0]);
    };

    // An allow rule, matched through `trim(lower(match))` — the rule row is stored with a
    // trailing space and a capital, exactly as `matchPredicate` normalizes it.
    expect(await decided("known@ex.test"), `on ${dialectOf(db)}`).toBe(true);
    // The DOMAIN arm, which is the one that carries `domainOf`.
    expect(await decided("someone@corp.test"), `on ${dialectOf(db)}`).toBe(true);
    // A contact with no rule at all — the arm `cutlineCounts` did not have.
    expect(await decided("pal@ex.test"), `on ${dialectOf(db)}`).toBe(true);
    // A contact WITH a deny rule: answered twice, and the second answer is still an answer.
    expect(await decided("blocked@ex.test"), `on ${dialectOf(db)}`).toBe(true);
    // A deny rule alone decides — the arm the ruling moved.
    expect(await decided("denied@ex.test"), `on ${dialectOf(db)}`).toBe(true);
    // A contact the GATE defeats: a rule sending them to the Screener is "keep asking me", and it
    // is the only destination that survives a `contacts` row. Without the `not exists` arm this
    // reads true and a sender the person asked to keep screening vanishes from the queue.
    expect(await decided("asked@ex.test"), `on ${dialectOf(db)}`).toBe(false);
    // A string outside the six is nobody's answer — the release screen no longer counts it either.
    expect(await decided("odd@ex.test"), `on ${dialectOf(db)}`).toBe(false);
    // A rule switched off is not a standing decision.
    expect(await decided("off@ex.test"), `on ${dialectOf(db)}`).toBe(false);
    expect(await decided("stranger@ex.test"), `on ${dialectOf(db)}`).toBe(false);
    // A domain rule does not reach a LOOK-ALIKE domain — the `like '%@corp.test'` spelling
    // `domainOf` exists to refuse would match this one.
    expect(await decided("someone@evil-corp.test"), `on ${dialectOf(db)}`).toBe(false);
  });

  /**
   * ── THE TABLE: ALL SIX DESTINATIONS, ONE ANSWER ──────────────────────────────────────────
   *
   * The predicate in the database and the exported `destinationIsDecision` a surface reads must
   * give the same verdict for every folder the product presents, or the two screens disagree
   * again — which is the defect, not a detail of it. Driven off `CUTLINE_PRESENTED_FOLDERS`, so a
   * seventh folder arrives here by existing rather than by somebody remembering.
   */
  it("agrees with `destinationIsDecision` on every presented destination", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const decided = async (address: string): Promise<boolean> => {
      const [row] = await d.exec(db, sql`
        select ${senderIsDecidedSql(d, ACCOUNT, sql`lower(${address})`)} as v
      `);
      return Boolean(row?.[0]);
    };
    // The premise: seven folders — the six the product presents plus the News pile's pre-0.22
    // spelling, which these lists carry because they reach SQL membership over STORED rows — and
    // at least one on each side of the answer. The count is here so the loop below cannot pass by
    // iterating an empty or halved list.
    expect(CUTLINE_PRESENTED_FOLDERS.length).toBe(7);
    expect(CUTLINE_PRESENTED_FOLDERS.filter((f) => !destinationIsDecision(f))).toEqual([CUTLINE_GATE_FOLDER]);

    for (const [i, destination] of CUTLINE_PRESENTED_FOLDERS.entries()) {
      const address = `t${i}@ex.test`;
      await db.insert(rules).values({
        accountId: ACCOUNT, kind: "sender", match: address, destination, enabled: true,
        priority: 0, provenance: "promoted",
      } as never);
      expect(await decided(address), `${destination} on ${dialectOf(db)}`)
        .toBe(destinationIsDecision(destination));
    }
  });

  /** THE ACCOUNT ITSELF (ruling 2026-09-25): its own mailbox address, folded, and nobody else's. */
  it("a sender who is one of the account's own mailboxes is own, on both stores", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const OTHER = "99999999-8888-7777-6666-555555555555";
    await db.insert(mailboxes).values([
      { id: MAILBOX, accountId: ACCOUNT, provider: "imap", address: "Me@Example.test" },
      { id: "44444444-3333-2222-1111-000000000000", accountId: OTHER, provider: "imap", address: "them@example.test" },
    ] as never);
    const own = async (address: string): Promise<boolean> => {
      const [row] = await d.exec(db, sql`
        select case when ${senderIsOwnSql(d, ACCOUNT, sql`lower(${address})`)} then 1 else 0 end as v
      `);
      return Number(row?.[0]) === 1;
    };
    expect(await own("me@example.test"), `on ${dialectOf(db)}`).toBe(true);
    expect(await own("ME@EXAMPLE.TEST"), `on ${dialectOf(db)}`).toBe(true);
    // Another account's mailbox is not this account, and a stranger is nobody's.
    expect(await own("them@example.test"), `on ${dialectOf(db)}`).toBe(false);
    expect(await own("stranger@ex.test"), `on ${dialectOf(db)}`).toBe(false);
  });

  it("the ACTIVE expression composes and runs with no store-only construct in it", async () => {
    const db = await makeTestDb();
    const d = dialect(db);
    const c = resolveCutline({ baselineAt: BASELINE, dormancyDays: 365, now: NOW });
    const expr = activeSenderExpr(d, c, {
      anyUnread: sql`false`, anyUnreadInWindow: sql`false`, newest: d.ts(NOW),
    });
    const [row] = await d.exec(db, sql`select ${expr} as v`);
    expect(Boolean(row?.[0]), `on ${dialectOf(db)}`).toBe(true);
  });
});
