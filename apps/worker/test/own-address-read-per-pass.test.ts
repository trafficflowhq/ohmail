import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accountSettings, accounts, folderState, mailboxes, messageBodies, messages, organizerRequests,
  readOwnAddresses, ruleCreatePayload, rules, type Tx,
  accountPass, requestPass,
} from "@trafficflow/db";
import {
  deriveRequestKey, type MetaRecordsList, type RequestReaderIo, type RequestOrganizerIo, type RawMetaMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { ruleRetroPass } from "../src/rule-retro.js";
import { ohboxTidyPass } from "../src/ohbox-tidy.js";
import { applyMetaRequests, driveOutstandingRequests } from "../src/request-drain.js";

/**
 * ONE OWN-ADDRESS READ PER ACCOUNT PER PASS. The rule retro read the
 * router's own set once per OWED RULE and the request drain once per sender decision or
 * `rule.create` record; the tidy read it beside a mailbox read that already held the rows. Counted at
 * the handle by drizzle's own query logger, against the exact text `readOwnAddresses` sends, which
 * the CONTROL reads first. Per account, never across: a second account's rule is decided under its
 * own set. And the set as the pass first read it holds for the rest of that pass (the last describe).
 */
type Db = Awaited<ReturnType<typeof makeTestDb>>;
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();
const NOW = new Date("2026-10-07T12:00:00Z");

/** Every statement the handle sends while `run` runs; a transaction's session shares the options' logger. */
async function statements<T>(db: Db, run: () => Promise<T>): Promise<{ out: T; sent: string[] }> {
  const session = (db as unknown as { session: { logger: unknown; options: { logger?: unknown } } }).session;
  const was = { logger: session.logger, option: session.options.logger };
  const sent: string[] = [];
  const logger = { logQuery: (q: string) => { sent.push(q); } };
  session.logger = logger;
  session.options.logger = logger;
  try {
    return { out: await run(), sent };
  } finally {
    session.logger = was.logger;
    session.options.logger = was.option;
  }
}

/** The text of the one-set read, taken from the read itself. */
async function oneSetText(db: Db): Promise<string> {
  const { sent } = await statements(db, () => readOwnAddresses(db as unknown as Tx, randomUUID()));
  expect(sent, "CONTROL: the one-set read is one statement through the logger").toHaveLength(1);
  return sent[0]!;
}
const count = (sent: string[], text: string) => sent.filter((s) => s === text).length;

async function account(db: Db, ...addresses: string[]): Promise<{ accountId: string; mailboxIds: string[] }> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `own-read-${accountId.slice(0, 8)}` });
  const mailboxIds: string[] = [];
  for (const address of addresses) {
    const [m] = await db.insert(mailboxes).values({ accountId, provider: "imap", address }).returning();
    mailboxIds.push(m!.id);
  }
  return { accountId, mailboxIds };
}

async function inbox(db: Db, accountId: string, mailboxId: string, from: string): Promise<string> {
  const dedup = `mid:${randomUUID()}`;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
    subject: "hello", fromAddress: from, nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

const owedRule = (db: Db, accountId: string, kind: "sender" | "domain", match: string) => db.insert(rules).values({
  accountId, kind, match, destination: "ohmail/Screened", provenance: "manual", enabled: true,
  retroRequestedAt: new Date("2026-10-07T10:00:00Z"),
});
const desired = async (db: Db, id: string) =>
  (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;

describe("the rule retro reads the own set once per account", () => {
  it("three owed rules that move nothing: one read", async () => {
    const db = await makeTestDb();
    const text = await oneSetText(db);
    const a = await account(db, "me@one.invalid");
    for (const who of ["x", "y", "z"]) await owedRule(db, a.accountId, "sender", `${who}@stranger.invalid`);
    const { out, sent } = await statements(db, () =>
      ruleRetroPass(db as unknown as Tx, { accountId: a.accountId, trustedAuthservIdsFor: NONE }, NOW));
    expect({ rules: out.rules, moved: out.moved, completed: out.completed, reads: count(sent, text) })
      .toEqual({ rules: 3, moved: 0, completed: 3, reads: 1 });
  });

  it("two accounts in one run: one read each, and each rule is decided under its own account's set", async () => {
    const db = await makeTestDb();
    const text = await oneSetText(db);
    // A owns `shared@`; to B it is a stranger, so B's rule about it moves B's mail from it.
    const a = await account(db, "shared@one.invalid");
    const b = await account(db, "b@two.invalid");
    await owedRule(db, a.accountId, "domain", "stranger.invalid");
    await owedRule(db, a.accountId, "sender", "p@stranger.invalid");
    await owedRule(db, b.accountId, "sender", "shared@one.invalid");
    await owedRule(db, b.accountId, "sender", "q@stranger.invalid");
    const fromShared = await inbox(db, b.accountId, b.mailboxIds[0]!, "shared@one.invalid");
    const { out, sent } = await statements(db, () =>
      ruleRetroPass(db as unknown as Tx, { trustedAuthservIdsFor: NONE }, NOW));
    expect({ rules: out.rules, moved: out.moved, reads: count(sent, text), b: await desired(db, fromShared) })
      .toEqual({ rules: 4, moved: 1, reads: 2, b: "ohmail/Screened" });
  });
});

describe("the request drain reads the own set once per drain", () => {
  const ACCT = "00000000-0000-0000-0000-0000000000f6";
  const t0 = new Date("2026-10-07T08:00:00.000Z");
  const at = (m: number): Date => new Date(t0.getTime() + m * 60_000);
  const ADDRESS = "held@drain.example";
  const KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: "the-shared-password" }, address: ADDRESS })!;

  it("two rule.create records and one sender decision: one read, all three applied", async () => {
    const here = await makeTestDb();
    const laptop = await makeTestDb();
    const text = await oneSetText(laptop);
    const store = new Map<number, string>();
    let next = 1;
    const list = async (): Promise<MetaRecordsList> => {
      const records: RawMetaMessage[] = [...store.entries()].map(([ref, raw]) => ({ ref, raw }));
      return { records, count: records.length, bytes: records.reduce((n, r) => n + r.raw.length, 0) };
    };
    const reader = { listMetaRecords: list, async append(raw: string) { store.set(next++, raw); } } as RequestReaderIo;
    const organizer = {
      listMetaRecords: list, uidValidity: () => 7_000,
      async ack(raw: string) { store.set(next++, raw); },
      async remove(refs: readonly unknown[]) { for (const r of refs) if (typeof r === "number") store.delete(r); },
    } as RequestOrganizerIo;
    const held = randomUUID();
    await here.insert(mailboxes).values({
      id: held, accountId: ACCT, provider: "imap", address: ADDRESS, organizerRole: "reader",
      organizerState: "held", organizedByCapabilities: "requests,rules", organizedByKind: "local", organizedByName: "laptop",
    });
    await laptop.insert(accounts).values({ id: ACCT, name: "drain-own-read" });
    await laptop.insert(mailboxes).values({ id: held, accountId: ACCT, provider: "imap", address: ADDRESS });
    const create = (match: string) => ruleCreatePayload({
      key: { kind: "sender", match, subjectContains: null, bodyContains: null }, destination: "screened", enabled: true, applyRetro: false,
    });
    const queue = (kind: string, payload: unknown, decidedAt: Date) => here.insert(organizerRequests)
      .values({ id: randomUUID(), accountId: ACCT, mailboxId: held, kind, payload, decidedAt, state: "pending" });
    await queue("rule.create", create("bob@shop.example"), at(1));
    await queue("rule.create", create("carol@shop.example"), at(2));
    await queue("screener.decide", {
      scope: "sender", address: "dave@shop.example", appliedFolder: "ohmail/Screened", decision: "no", match: "dave@shop.example", applyRetro: false,
    }, at(3));
    await driveOutstandingRequests(here, {
      mailboxId: held, accountId: ACCT, installId: "reader-install",
      adapter: { requestReaderIo: () => reader } as unknown as MailboxAdapter, requestKey: KEY,
    }, { installId: "reader-install", kind: "local" as const }, at(4), () => undefined);
    const { out, sent } = await statements(laptop, () => applyMetaRequests(laptop, {
      mailboxId: held, accountId: ACCT, installId: "laptop-install",
      adapter: { requestOrganizerIo: () => organizer } as unknown as MailboxAdapter, requestKey: KEY,
    }, at(5), () => undefined));
    const made = (await laptop.select({ match: rules.match }).from(rules).where(eq(rules.accountId, ACCT))).map((r) => r.match).sort();
    expect({ applied: out.applied, refused: out.refused, reads: count(sent, text), made })
      .toEqual({ applied: 3, refused: 0, reads: 1, made: ["bob@shop.example", "carol@shop.example", "dave@shop.example"] });
  });
});

describe("the ohbox tidy answers the own set from its one mailbox read", () => {
  it("adds no statement of its own", async () => {
    const db = await makeTestDb();
    const text = await oneSetText(db);
    const a = await account(db, "me@tidy.invalid");
    await db.insert(accountSettings).values({ accountId: a.accountId, ohboxPolicy: "people_only" });
    await requestPass(db, accountPass("ohbox_tidy", a.accountId), new Date("2026-10-07T11:00:00Z"));
    const id = await inbox(db, a.accountId, a.mailboxIds[0]!, "list@stranger.invalid");
    await db.insert(messageBodies).values({ messageId: id, accountId: a.accountId, text: "", html: null, headers: { "list-unsubscribe": ["<https://x.invalid/u>"] } });
    await db.insert(rules).values({
      accountId: a.accountId, kind: "sender", match: "list@stranger.invalid", destination: "INBOX", priority: 0,
      provenance: "seeded-from-sent", enabled: true,
    });
    const { out, sent } = await statements(db, () =>
      ohboxTidyPass(db as unknown as Tx, { accountId: a.accountId, trustedAuthservIdsFor: NONE }, NOW));
    const mailboxReads = sent.filter((s) => /^select .* from "mailboxes" where /.test(s) && !/ for (update|share)/.test(s));
    expect({ ran: out.ran, moved: out.moved, oneSetReads: count(sent, text), mailboxReads: mailboxReads.length })
      .toEqual({ ran: true, moved: 1, oneSetReads: 0, mailboxReads: 1 });
  });
});

/**
 * A MAILBOX REMOVED DURING A PASS. The set is read once per pass, so a removal that commits mid-pass
 * reads as one committed a moment after the pass began: the removed address stays the person's own
 * mail for the rest of the pass, and own mail is the branch no rule moves. The erased mailbox's own
 * rows are never the own set's to guard: the candidate gate reads its status per page and the
 * erasure fence refuses the write. The next pass reads the set fresh.
 */
describe("a mailbox removed and erased between two owed rules", () => {
  /** The pass's handle, with a hook that fires after each page transaction commits. */
  function pagedDb(real: Tx, onAfterPage: (page: number) => Promise<void>): Tx {
    let page = 0;
    return new Proxy(real as object, {
      get(target, prop, receiver): unknown {
        if (prop === "transaction") {
          return async (fn: unknown): Promise<unknown> => {
            const out = await (target as { transaction: (f: unknown) => Promise<unknown> }).transaction(fn);
            await onAfterPage(page++);
            return out;
          };
        }
        const value = Reflect.get(target, prop, receiver) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Tx;
  }

  async function world(db: Db) {
    const a = await account(db, "main@one.invalid", "old@gone.invalid");
    const [main, old] = a.mailboxIds as [string, string];
    // Rule 1 walks first and decides nothing; rule 2 names the address being removed, which a sender
    // rule may do once it is a stranger's (the router reads such a rule as absent for own mail).
    for (const [match, createdAt] of [["nobody@stranger.invalid", "09:00"], ["old@gone.invalid", "09:01"]] as const) {
      await db.insert(rules).values({
        accountId: a.accountId, kind: "sender", match, destination: "ohmail/Screened", provenance: "manual",
        enabled: true, retroRequestedAt: new Date("2026-10-07T10:00:00Z"), createdAt: new Date(`2026-10-07T${createdAt}:00Z`),
      });
    }
    const fromOld = await inbox(db, a.accountId, main, "old@gone.invalid");
    const inOld = await inbox(db, a.accountId, old, "old@gone.invalid");
    const removeAndErase = () => db.update(mailboxes)
      .set({ status: "disabled", disabledReason: null, erasureDoneAt: NOW })
      .where(and(eq(mailboxes.id, old), eq(mailboxes.accountId, a.accountId)));
    return { ...a, fromOld, inOld, removeAndErase };
  }

  it("the removed address's mail stays own for the rest of the pass; the erased mailbox's rows are not moved", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    let removed = false;
    const handle = pagedDb(db as unknown as Tx, async (page) => {
      // After rule 1's only page, before rule 2 is walked.
      if (page === 0) { removed = true; await w.removeAndErase(); }
    });
    const out = await ruleRetroPass(handle, { accountId: w.accountId, trustedAuthservIdsFor: NONE }, NOW);
    expect({ removed, rules: out.rules, fromOld: await desired(db, w.fromOld), inOld: await desired(db, w.inOld) })
      .toEqual({ removed: true, rules: 2, fromOld: "INBOX", inOld: "INBOX" });
  });

  it("CONTROL: removed before the pass, the same rule moves the old address's mail and still not the erased rows", async () => {
    const db = await makeTestDb();
    const w = await world(db);
    await w.removeAndErase();
    await ruleRetroPass(db as unknown as Tx, { accountId: w.accountId, trustedAuthservIdsFor: NONE }, NOW);
    expect({ fromOld: await desired(db, w.fromOld), inOld: await desired(db, w.inOld) })
      .toEqual({ fromOld: "ohmail/Screened", inOld: "INBOX" });
  });
});
