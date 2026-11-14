import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { accounts, users, sessions, mailboxes, messages, messageBodies } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import {
  hashToken, generateToken, makeTestAuthDeps, makeAuthService,
  syncService, pushService, makeMailboxService, rulesService, messageService, threadService,
  makeScreenerService, makeApprovalService, triageService, searchService, makePrivacyService,
  contactsService, snippetsService, notifyRulesService, awayResponderService, attachmentsService,
  kbService, tagsService, draftsService, draftingService, sendService, workflowsService, proposalsService,
  type Db,
} from "@trafficflow/services";

/**
 * THE BYTE BUDGET NOW BOUNDS THE TRANSFER, NOT ONLY THE ANSWER.
 *
 * `BODIES_BYTE_BUDGET` used to be spent inside a loop over rows PostgreSQL had already sent and
 * this process had already materialized: `GET /messages/bodies?limit=100` selected that many whole
 * bodies — `text` and sanitized `html`, the full stored originals — and then decided, in JS, to
 * answer with four of them. **The response was correctly bounded and the cost was not**, which is
 * the definition of the class. A sender chooses each body's size (the IMAP raw-message ceiling
 * admits roughly 32 MiB), so one authenticated request could pull gigabytes over the wire on a
 * 60 s lambda and answer with a small page.
 *
 * The fix is byte-aware SELECTION in two queries rather than a chunk loop: pass 1 projects
 * `octet_length(text) + octet_length(html)` for the candidate window — which PostgreSQL answers
 * from the varlena header, WITHOUT detoasting or transferring the value — and pass 2 fetches
 * bodies only for the prefix that fits. Bound: the budget plus one row.
 *
 * ── WHY THIS CANNOT BE A PGlite TEST, AND WHY IT MEASURES THE DRIVER ───────────────────────
 *
 * The thing being bounded is a WIRE TRANSFER between a client and a server. PGlite is in-process:
 * there is no wire, so it is green either way and would prove nothing — the ledger row says so in
 * as many words. So this file counts the bytes THE DRIVER RECEIVED, by tapping `postgres.js`'s
 * `unsafe()` and summing every string value in every row of every statement the request issues.
 * That is upstream of the response, upstream of the DTO, and upstream of the loop the old code
 * spent its budget in.
 *
 * ── THE MUTATION-WATCH ────────────────────────────────────────────────────────────────────
 *
 * Watched fail and restored. In `message-service.ts#getBodies`, collapse the two passes back into
 * the pre-fix single query — select `text`/`html` for the whole `limit + 1` window and accumulate
 * `Buffer.byteLength` in the item loop — and "the driver never receives more than the budget"
 * goes red at many times the ceiling, while every assertion about the RESPONSE stays
 * green. That gap between the two is the entire finding.
 */

const AVAILABLE = await realPgAvailable();
const FIXED_NOW = new Date("2026-09-01T12:00:00.000Z");
const app = createApp(apiRoutes);

/** One body's size, and how many are seeded — 12 MiB total against a 4 MiB budget. */
const ONE_MIB = 1024 * 1024;
const SEEDED = 12;
/**
 * The ceiling this file asserts: the 4 MiB budget, plus the one row that crosses it (the prefix
 * deliberately includes it, so a single oversized body cannot stall pagination), plus 256 KiB for
 * the size probe's own rows, the session/account reads and column names. The unfixed shape
 * transfers 12 MiB, so the two are three megabytes apart and the assertion is not a near-miss.
 */
const TRANSFER_CEILING = 4 * ONE_MIB + ONE_MIB + 256 * 1024;

function depsOn(db: Db): ApiDeps {
  const authDeps = makeTestAuthDeps({});
  return {
    db,
    now: () => FIXED_NOW,
    requestId: `pg-${randomUUID()}`,
    session: null,
    authConfig: authDeps.config,
    keyProvider: authDeps.keyProvider,
    services: {
      auth: makeAuthService(authDeps),
      sync: syncService,
      push: pushService,
      mailbox: makeMailboxService({ keyProvider: authDeps.keyProvider }),
      rules: rulesService,
      message: messageService,
      thread: threadService,
      screener: makeScreenerService({}),
      approval: makeApprovalService({}),
      triage: triageService,
      search: searchService,
      privacy: makePrivacyService({
        remote: { async fetch() { return { status: 200, contentType: "image/gif", body: new Uint8Array() }; } },
        resolver: { async resolve() { return ["93.184.216.34"]; } },
      }),
      contacts: contactsService,
      snippets: snippetsService,
      notify: notifyRulesService,
      away: awayResponderService,
      attachments: attachmentsService,
      kb: kbService,
      tags: tagsService,
      drafts: draftsService,
      drafting: draftingService,
      sends: sendService,
      workflows: workflowsService,
      proposals: proposalsService,
    },
  };
}

/** Bytes of every string the driver handed back, summed across every statement. */
let received = 0;

/**
 * Sum the UTF-8 bytes of every string value in a result set.
 *
 * Strings only, deliberately: the transfer being bounded is body TEXT, and counting the fixed-width
 * columns beside it would blur the measurement with noise that does not scale with body size.
 */
function tally(rows: unknown): void {
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    for (const v of Object.values(row as Record<string, unknown>)) {
      if (typeof v === "string") received += Buffer.byteLength(v, "utf8");
    }
  }
}

describe.skipIf(!AVAILABLE)("GET /messages/bodies bounds the TRANSFER, not just the response (real Postgres)", () => {
  let owned: OwnedDb;
  let db: Db;

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    db = owned.db as unknown as Db;

    // ── THE TAP ──────────────────────────────────────────────────────────────────────────────
    // drizzle-orm/postgres-js issues every statement as `client.unsafe(sql, params)`
    // (`postgres-js/session.cjs:84`), so wrapping that one method sees every row the driver
    // decodes. The lookup THROWS rather than degrading: a tap that silently stopped firing would
    // make this file pass by measuring nothing, which is the failure mode the repo's own rules
    // name — a guard whose exit code does not come from reality. The `transferred > 1 MiB`
    // self-check in each case is the second half of the same defence, and it is not theoretical:
    // the first version of the sibling tap in `account-deletion.pg.test.ts` measured zero,
    // because a TRANSACTION's statements go through a different handle (below).
    const client = (owned.db as unknown as { session?: { client?: Record<string, unknown> } }).session?.client;
    if (!client || typeof client.unsafe !== "function") {
      throw new Error("cannot reach the postgres.js client to measure the transfer — the tap must not be silently skipped");
    }
    /**
     * The wrapper is a PROXY and not an `async` function, and that distinction cost a red run.
     *
     * `client.unsafe(...)` returns postgres.js's `PendingQuery` — a thenable that ALSO carries
     * `.values()`, `.raw()`, `.execute()`. drizzle calls `.values()` for an `INSERT … RETURNING`
     * (`postgres-js/session.ts:54`), so an `async` wrapper — which awaits and hands back a plain
     * Promise — deleted that method and every seeding insert died with
     * `client.unsafe(...).values is not a function`. The proxy forwards everything, taps `then`,
     * and re-wraps `.values()` so a row-array result is counted too.
     */
    const wrap = (pq: object): object => new Proxy(pq, {
      get(target, prop) {
        if (prop === "then") {
          return (ok?: (r: unknown) => unknown, err?: (e: unknown) => unknown) =>
            (target as PromiseLike<unknown>).then((rows) => {
              tally(rows);
              return ok ? ok(rows) : rows;
            }, err);
        }
        const v = Reflect.get(target, prop, target);
        if (typeof v !== "function") return v;
        if (prop === "values" || prop === "raw" || prop === "execute") {
          return (...a: unknown[]) => {
            const next = (v as (...x: unknown[]) => unknown).apply(target, a);
            return next !== null && typeof next === "object" ? wrap(next as object) : next;
          };
        }
        return (v as (...x: unknown[]) => unknown).bind(target);
      },
    });

    const arm = (handle: Record<string, unknown>): void => {
      const inner = (handle.unsafe as (...a: unknown[]) => object).bind(handle);
      handle.unsafe = (...args: unknown[]) => wrap(inner(...args));
    };
    // `begin` hands its callback a DIFFERENT `sql` handle bound to the reserved connection, so a
    // transaction's statements bypass the outer tap entirely. The reads under test are not in a
    // transaction, but arming both means the measurement stays honest if one ever is.
    const origBegin = (client.begin as (...a: unknown[]) => unknown).bind(client);
    client.begin = (...args: unknown[]) => {
      const i = args.findIndex((a) => typeof a === "function");
      if (i < 0) return origBegin(...args);
      const fn = args[i] as (h: Record<string, unknown>) => unknown;
      const next = [...args];
      next[i] = (handle: Record<string, unknown>) => { arm(handle); return fn(handle); };
      return origBegin(...next);
    };
    arm(client);
  }, 180_000);

  afterAll(async () => { await owned?.close().catch(() => {}); });

  /** An account holding {@link SEEDED} bodies of {@link ONE_MIB} each. */
  async function world(): Promise<{ token: string; ids: string[] }> {
    const token = generateToken();
    const [acct] = await db.insert(accounts).values({ name: `bb-${randomUUID().slice(0, 8)}` }).returning();
    const [user] = await db.insert(users).values({
      accountId: acct!.id, email: `bb-${randomUUID()}@example.com`, displayName: "BB",
      emailVerifiedAt: FIXED_NOW,
    }).returning();
    await db.insert(sessions).values({
      accountId: acct!.id, userId: user!.id, familyId: randomUUID(),
      accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
      refreshExpiresAt: new Date(FIXED_NOW.getTime() + 7_200_000),
    });
    const [mb] = await db.insert(mailboxes).values({
      accountId: acct!.id, provider: "imap", address: `bb-${randomUUID().slice(0, 8)}@tf.example`,
    }).returning();

    // NOT a repeated character: PostgreSQL TOAST-compresses `text`, and a compressible body would
    // make the wire far smaller than the value, so the measurement would be of the compression
    // and not of the bound. Random hex is incompressible.
    const ids: string[] = [];
    for (let i = 0; i < SEEDED; i++) {
      const [m] = await db.insert(messages).values({
        accountId: acct!.id, mailboxId: mb!.id,
        bodyHash: `bb-${i}`, dedupKey: `bb:${randomUUID()}`,
        subject: `big ${i}`, fromAddress: "bulk@sender.example",
        date: new Date(FIXED_NOW.getTime() - i * 60_000),
      }).returning();
      await db.insert(messageBodies).values({
        messageId: m!.id, accountId: m!.accountId,
        text: randomBytesHex(ONE_MIB),
        html: null,
      });
      ids.push(m!.id);
    }
    return { token, ids: ids.sort() };
  }

  function get(path: string, token: string): Request {
    return new Request(`http://localhost${path}`, {
      method: "GET", headers: { authorization: `Bearer ${token}` },
    });
  }

  it("the driver never receives more than the budget plus one row, whatever ?limit= asks for", async () => {
    const { token } = await world();

    received = 0;
    const res = await app.handle(get("/messages/bodies?limit=100", token), depsOn(db));
    const transferred = received;
    expect(res.status).toBe(200);
    const body = await res.json() as { items: { text: string }[]; nextCursor: string | null };

    // The tap really fired. Without this the whole file would pass by measuring nothing.
    expect(transferred, "the transfer measurement must not be zero").toBeGreaterThan(ONE_MIB);

    // THE FINDING. A caller asking for a page of large bodies gets a bounded TRANSFER, not a bounded
    // answer over an unbounded read. Unfixed this is ~12 MiB.
    expect(transferred, `driver received ${(transferred / ONE_MIB).toFixed(1)} MiB`)
      .toBeLessThanOrEqual(TRANSFER_CEILING);

    // …and the response contract is untouched: a short page with a cursor for the rest.
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.length).toBeLessThan(SEEDED);
    expect(body.nextCursor, "a budget-shortened page must carry the cursor for the remainder").toBeTruthy();
    const answered = body.items.reduce((n, i) => n + Buffer.byteLength(i.text, "utf8"), 0);
    expect(answered).toBeLessThanOrEqual(4 * ONE_MIB + ONE_MIB);
  }, 180_000);

  it("the ids mode is bounded the same way — a thread of twenty newsletters is real", async () => {
    const { token, ids } = await world();

    received = 0;
    const res = await app.handle(get(`/messages/bodies?ids=${ids.join(",")}`, token), depsOn(db));
    const transferred = received;
    expect(res.status).toBe(200);
    const body = await res.json() as { items: { messageId: string }[]; nextCursor: string | null };

    expect(transferred, "the transfer measurement must not be zero").toBeGreaterThan(ONE_MIB);
    expect(transferred, `driver received ${(transferred / ONE_MIB).toFixed(1)} MiB`)
      .toBeLessThanOrEqual(TRANSFER_CEILING);

    // This mode does not page, so a shortened answer is simply a short one — and it must be a
    // PREFIX of the requested ids in the answer's own order, so the client can tell what is
    // missing and ask per message.
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.length).toBeLessThan(SEEDED);
    expect(body.items.map((i) => i.messageId)).toEqual(ids.slice(0, body.items.length));
    expect(body.nextCursor).toBeNull();
  }, 180_000);

  it("a page well inside the budget still answers in full — the bound is a ceiling, not a page size", async () => {
    // The other direction, so the fix cannot pass by simply returning less. Four small bodies are
    // nowhere near 4 MiB and all four must come back in one page with no cursor.
    const token = generateToken();
    const [acct] = await db.insert(accounts).values({ name: `bb-small-${randomUUID().slice(0, 8)}` }).returning();
    const [user] = await db.insert(users).values({
      accountId: acct!.id, email: `bbs-${randomUUID()}@example.com`, displayName: "BBS",
      emailVerifiedAt: FIXED_NOW,
    }).returning();
    await db.insert(sessions).values({
      accountId: acct!.id, userId: user!.id, familyId: randomUUID(),
      accessTokenHash: hashToken(token),
      accessExpiresAt: new Date(FIXED_NOW.getTime() + 3_600_000),
      refreshExpiresAt: new Date(FIXED_NOW.getTime() + 7_200_000),
    });
    const [mb] = await db.insert(mailboxes).values({
      accountId: acct!.id, provider: "imap", address: `bbs-${randomUUID().slice(0, 8)}@tf.example`,
    }).returning();
    for (let i = 0; i < 4; i++) {
      const [m] = await db.insert(messages).values({
        accountId: acct!.id, mailboxId: mb!.id,
        bodyHash: `bbs-${i}`, dedupKey: `bbs:${randomUUID()}`,
        subject: `small ${i}`, fromAddress: "friend@example.com",
      }).returning();
      await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: `hello ${i}`, html: `<p>hello ${i}</p>` });
    }

    const body = await (await app.handle(get("/messages/bodies?limit=100", token), depsOn(db))).json() as
      { items: { text: string; html: string | null }[]; nextCursor: string | null };
    expect(body.items).toHaveLength(4);
    expect(body.nextCursor).toBeNull();
    // Verbatim, both columns — the two-pass selection must not have dropped a projection.
    expect(body.items.map((i) => i.text).sort()).toEqual(["hello 0", "hello 1", "hello 2", "hello 3"]);
    expect(body.items.every((i) => i.html !== null)).toBe(true);
  }, 180_000);
});

/** `n` bytes of incompressible ASCII — see the seeding note about TOAST. */
function randomBytesHex(n: number): string {
  const chunk = 64 * 1024;
  let out = "";
  while (out.length < n) {
    out += Array.from({ length: chunk / 32 }, () => randomUUID().replace(/-/g, "")).join("");
  }
  return out.slice(0, n);
}
