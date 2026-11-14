import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import {
  accounts, folderState, mailboxes, messageStates, messages, rules as rulesTbl, senderIsDecidedSql, threads,
} from "@trafficflow/db";
import { effectForDestination, standingRule, type Rule } from "@trafficflow/core/mail";
import { consentIndex, decidedDestination, ohboxView, type RuleDTO } from "@ohmail/client-engine";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { MessageService, TriageService } from "../src/index.js";
import type { ServiceContext } from "../src/context.js";
import {
  FOLD_MATRIX, OWN, PIN_AT, RULE_SETS, SENDER, foldStore, type FoldCase,
} from "../../client-engine/test/placement-parity/matrix.js";

/* @reads: packages/db/src/ packages/services/src/ apps/worker/src/
   The source census walks those roots by a path built at runtime; no landing pass selects this
   file when a reader there moves, the shape `reads-list.mjs` exists for. */

/**
 * THE SERVER SIDE OF THE PLACEMENT CENSUS, over the client leg's own matrix. Three readers of who
 * is decided must agree term rules included — the queue's SQL (`senderIsDecidedSql`), the
 * router's `standingRule` and the client's `decidedDestination`; the server's "New for you" folds a
 * resurfaced conversation exactly as the Ohbox does; and no SQL predicate evaluates a rule's term,
 * because the claim is `placingRule`'s alone (core `rule-order.ts`).
 */

const asCore = (r: RuleDTO): Rule => ({
  id: r.id, kind: r.kind, match: r.match, destination: r.destination as Rule["destination"],
  effect: effectForDestination(r.destination as Rule["destination"]), priority: r.priority,
  provenance: r.provenance, enabled: r.enabled,
  subjectContains: r.subjectContains ?? null, bodyContains: r.bodyContains ?? null,
});

async function account(db: Awaited<ReturnType<typeof makeTestDb>>) {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `pp-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: OWN, organizerRole: "organizer" }).returning();
  return { accountId, mailboxId: mb!.id };
}

describe("placement census, server leg: who is decided is one answer in three places", () => {
  it.each(Object.entries(RULE_SETS))("%s", async (_name, set) => {
    const db = await makeTestDb();
    const { accountId } = await account(db);
    for (const r of set) {
      await db.insert(rulesTbl).values({
        accountId, kind: r.kind, match: r.match, destination: r.destination, priority: r.priority,
        provenance: r.provenance, enabled: r.enabled, subjectContains: r.subjectContains ?? null, bodyContains: r.bodyContains ?? null,
      });
    }
    const rows = await dialect(db).exec(db, sql`select ${senderIsDecidedSql(dialect(db), accountId, sql`${SENDER}`)}`);
    const sqlSays = rows[0]![0] === true || rows[0]![0] === 1;
    const router = standingRule(set.map(asCore), SENDER) !== null;
    const client = decidedDestination(consentIndex(set), SENDER) !== null;
    expect({ sqlSays, router, client }).toEqual({ sqlSays: router, router, client: router });
    expect(router, "every set decides the sender: a term narrows placement, never admission").toBe(true);
  });
});

async function seedFold(c: FoldCase) {
  const db = await makeTestDb();
  const { accountId, mailboxId } = await account(db);
  const [t] = await db.insert(threads).values({ accountId, subject: "Plans" }).returning();
  const ids = new Map<string, string>();
  for (const m of c.members) {
    const at = new Date(PIN_AT + m.at * 60_000);
    const [row] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: `h-${m.id}`, dedupKey: `pp:${randomUUID()}`, subject: `Re: plans ${m.id}`,
      fromAddress: m.from, date: at, createdAt: at, unread: m.unread, threadId: t!.id,
      nativeLocator: { folder: m.folder, ref: `1:${m.id}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: row!.id, accountId: row!.accountId, desiredFolder: m.folder, observedFolder: m.folder, lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false,
    });
    if (m.state) {
      await db.insert(messageStates).values({
        accountId, messageId: row!.id, state: m.state, setAt: new Date(PIN_AT),
        bubbleUpAt: m.state === "bubbled_up" ? new Date(PIN_AT) : null,
      });
    }
    ids.set(row!.id, m.id);
  }
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(PIN_AT + 3_600_000), requestId: "pp" };
  return { ctx, ids };
}

describe("placement census, server leg: New for you folds a resurfaced conversation as the Ohbox does", () => {
  it.each(FOLD_MATRIX)("$name", async (c) => {
    const { ctx, ids } = await seedFold(c);
    const page = await new MessageService().list(ctx, { view: "new_for_you", limit: 50 });
    const server = page.items.map((m) => ids.get(m.id)!).sort();
    const client = ohboxView(await foldStore(c, "t")).newForYou.filter((m) => m.unread && m.folder === "INBOX").map((m) => m.id).sort();
    expect({ server, client }).toEqual({ server: [...c.newForYou].sort(), client: [...c.newForYou].sort() });
  });

  it.each(FOLD_MATRIX)("Power Through walks the same group: $name", async (c) => {
    const { ctx, ids } = await seedFold(c);
    const walked: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const view = await new TriageService().powerThrough(ctx, cursor ? { cursor } : {});
      if (view.current) walked.push(ids.get(view.current.id)!);
      if (!view.nextCursor) break;
      cursor = view.nextCursor;
    }
    expect(walked.sort()).toEqual([...c.newForYou].sort());
  });
});

/* ── THE SQL SOURCE CENSUS ──────────────────────────────────────────────────────────────────── */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const ROOTS = ["packages/db/src", "packages/services/src", "apps/worker/src"];
/** The schema declares the columns; nothing there is a predicate. */
const SCHEMA = new Set(["packages/db/src/schema-mail.ts", "packages/db/src/schema-mail-sqlite.ts"]);
/**
 * A rule-request's KEY lookup — which stored rule is the one the request names, terms included —
 * not a term matched against a message. Allowed by content, never by line.
 */
const KEY_LOOKUP = [
  "key.subjectContains === null ? isNull(rulesTbl.subjectContains) : eq(rulesTbl.subjectContains, key.subjectContains)",
  "key.bodyContains === null ? isNull(rulesTbl.bodyContains) : eq(rulesTbl.bodyContains, key.bodyContains)",
  // A press's delete of a rule and its twins: the same key, read off the row being removed.
  "before.subjectContains === null ? isNull(rules.subjectContains) : eq(rules.subjectContains, before.subjectContains)",
  "before.bodyContains === null ? isNull(rules.bodyContains) : eq(rules.bodyContains, before.bodyContains)",
];

/** Every place a term column is read inside a SQL predicate, classified; the refusals listed. */
export function termPredicates(file: string, src: string): { admitted: string[]; refused: string[] } {
  const code = withoutComments(src);
  const admitted: string[] = [];
  const refused: string[] = [];
  for (const line of code.split("\n")) {
    const at = (why: string) => `${file}: ${line.trim()} (${why})`;
    if (KEY_LOOKUP.some((k) => line.includes(k))) { admitted.push(at("a rule key lookup")); continue; }
    // Raw SQL text: a snake-case term column anywhere but an absence test.
    for (const m of line.matchAll(/\b(\w+\.)?(subject_contains|body_contains)\b(\s+is\s+(not\s+)?null)?/gi)) {
      (m[3] ? admitted : refused).push(at(m[3] ? "an absence test" : "a term in raw SQL"));
    }
    // Drizzle: a term column handed to an operator, or interpolated into a template.
    for (const m of line.matchAll(/\b(eq|ne|like|ilike|notLike|notIlike|gt|gte|lt|lte|inArray|notInArray|isNull|isNotNull)\(\s*\w+\.(subjectContains|bodyContains)\b|\$\{\s*\w+\.(subjectContains|bodyContains)\s*\}/g)) {
      const absence = m[1] === "isNull" || m[1] === "isNotNull";
      (absence ? admitted : refused).push(at(absence ? "an absence test" : "a term column in a predicate"));
    }
  }
  return { admitted, refused };
}

function sources(): Array<{ file: string; src: string }> {
  const out: Array<{ file: string; src: string }> = [];
  const walk = (rel: string) => {
    for (const n of readdirSync(join(ROOT, rel))) {
      const p = `${rel}/${n}`;
      if (statSync(join(ROOT, p)).isDirectory()) walk(p);
      else if (/\.ts$/.test(n) && !SCHEMA.has(p)) out.push({ file: p, src: readFileSync(join(ROOT, p), "utf8") });
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

describe("placement census, source leg: no SQL predicate evaluates a rule's term", () => {
  it("the refusals fire on the forms that would evaluate a term (the positive controls)", () => {
    expect(termPredicates("x.ts", "sql`and m.subject ilike '%' || r.subject_contains || '%'`").refused).toHaveLength(1);
    expect(termPredicates("x.ts", "sql`strpos(lower(b.text), r.body_contains) > 0`").refused).toHaveLength(1);
    expect(termPredicates("x.ts", "filters.push(ilike(rulesTbl.subjectContains, pattern));").refused).toHaveLength(1);
    expect(termPredicates("x.ts", "sql`position(${rulesTbl.bodyContains} in ${messageBodies.text})`").refused).toHaveLength(1);
    // …and admit an absence test in both spellings, and the key lookup by its content.
    expect(termPredicates("x.ts", "isNull(rulesTbl.subjectContains),").refused).toEqual([]);
    expect(termPredicates("x.ts", "sql`and r.body_contains is null`").refused).toEqual([]);
  });

  it("the three roots hold no term evaluation, and the forms they do hold are named", () => {
    const all = sources().map(({ file, src }) => termPredicates(file, src));
    const refused = all.flatMap((x) => x.refused);
    const admitted = all.flatMap((x) => x.admitted);
    expect(refused, refused.join("\n")).toEqual([]);
    // Anti-vacuity: the corpus's own absence tests and the key lookup are read. The Screener
    // decision's twin retarget held one until it converged through the key lookup (`rule-key.ts`).
    expect(admitted.some((a) => a.includes("packages/db/src/rule-key.ts"))).toBe(true);
    expect(admitted.some((a) => a.includes("packages/services/src/sensitive-rescreen.ts"))).toBe(true);
    expect(admitted.filter((a) => a.includes("a rule key lookup"))).toHaveLength(4);
  });
});
