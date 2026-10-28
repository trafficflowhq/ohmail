import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { changeLog, folderState, messages } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { DECISION_BATCH_MAX } from "@trafficflow/db";
import { FILING_BATCH_MAX } from "@trafficflow/core/adapters/imap-types";
import { ScreenerService } from "../src/index.js";
import { makeCtx } from "./helpers.js";

/**
 * WHAT ONE DOMAIN DECISION COSTS IN STATEMENTS, counted at the store's own client on the real
 * `decide` door, with no adapter, as every production door builds it. A decision moved its held
 * mail one message at a time, eleven statements each, in one transaction holding the account's
 * change counter: a large sender's held letters were eleven statements apiece. The writes now go in sets of
 * DECISION_BATCH_MAX (production's FILING_BATCH_MAX), so two sizes give the slope per SET.
 */

/** Statements one further batch may cost: a ceiling that may only fall. */
const PER_BATCH_CEILING = { no: 5, yes: 5 } as const;

interface Doors { query: (...a: unknown[]) => Promise<unknown>; exec: (...a: unknown[]) => Promise<unknown> }
interface PgliteClient extends Doors { transaction: (cb: (tx: Doors) => Promise<unknown>) => Promise<unknown> }

/** Counts every statement the store is handed while `on` — PGlite's doors, or SQLite's prepare. */
function counter(db: unknown): { on: boolean; n: number; stop: () => void } {
  const c = { on: false, n: 0, stop: () => {} };
  if (dialect(db as never).name === "sqlite") {
    const proto = (createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: { prototype: { prepare: (...a: unknown[]) => unknown } };
    }).DatabaseSync.prototype;
    const prepare = proto.prepare;
    proto.prepare = function (this: unknown, ...a: unknown[]) { if (c.on) c.n += 1; return prepare.apply(this, a); };
    c.stop = () => { proto.prepare = prepare; };
    return c;
  }
  const client = (db as { $client: PgliteClient }).$client;
  const wrap = <T extends Doors>(t: T): T => {
    for (const door of ["query", "exec"] as const) {
      const inner = t[door].bind(t);
      t[door] = (...a: unknown[]) => { if (c.on) c.n += 1; return inner(...a); };
    }
    return t;
  };
  wrap(client);
  const tx = client.transaction.bind(client);
  client.transaction = (cb) => tx((inner) => cb(wrap(inner)));
  return c;
}

/** `held` letters at one domain from distinct senders, seeded in sets; returns one of them. */
async function seed(db: Awaited<ReturnType<typeof makeCtx>>["db"], accountId: string, mailboxId: string, held: number) {
  const ids: string[] = [];
  for (let from = 0; from < held; from += 250) {
    const part = Array.from({ length: Math.min(250, held - from) }, (_x, i) => from + i);
    const rows = part.map((i) => ({
      id: randomUUID(), accountId, mailboxId, bodyHash: `h${i}`, dedupKey: `st:${randomUUID()}`,
      subject: `Note ${i}`, snippet: "", fromAddress: `sender-${i}@corp.test`, unread: i % 2 === 0,
      date: new Date(Date.UTC(2026, 8, 1) + i * 60_000), nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
      // Checked at ingest, as every row since mail 0148; an unchecked row adds its check (one read and
      // one write per batch of rows), which the press-checks case measures apart.
      senderCheck: "none",
    }));
    await db.insert(messages).values(rows as never);
    await db.insert(folderState).values(rows.map((r) => ({
      messageId: r.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    })) as never);
    ids.push(...rows.map((r) => r.id));
  }
  return ids;
}

async function decideCost(held: number, decision: "yes" | "no"): Promise<number> {
  const { db, accountId, mailboxId, ctx } = await makeCtx();
  const ids = await seed(db, accountId, mailboxId, held);
  const c = counter(db);
  c.on = true;
  await new ScreenerService({}).decide(ctx, ids[0]!, { decision, scope: "domain" });
  c.on = false;
  c.stop();
  const moved = await db.select({ id: folderState.messageId }).from(folderState)
    .where(eq(folderState.desiredFolder, decision === "no" ? "ohmail/Screened" : "INBOX"));
  expect(moved).toHaveLength(held);
  const rows = await db.select({ op: changeLog.op }).from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "message")));
  expect(rows, "one move per letter and no read-mark").toHaveLength(held);
  return c.n;
}

const batches = (n: number) => Math.ceil(n / FILING_BATCH_MAX);

describe("a domain decision's statements grow with batches, not with held messages", () => {
  it("the decision's set size is production's filing batch", () => {
    expect(DECISION_BATCH_MAX).toBe(FILING_BATCH_MAX);
  });

  for (const decision of ["no", "yes"] as const) {
    it(`a '${decision}' over a small and a large set of held letters costs at most ${PER_BATCH_CEILING[decision]} statements a batch`, async () => {
      const small = await decideCost(200, decision);
      const large = await decideCost(2000, decision);
      const perBatch = (large - small) / (batches(2000) - batches(200));
      console.log(`decide ${decision}: 200 -> ${small}, 2000 -> ${large}, ${perBatch.toFixed(2)} a batch`);
      expect(perBatch).toBeLessThanOrEqual(PER_BATCH_CEILING[decision]);
    }, 240_000);
  }
});
