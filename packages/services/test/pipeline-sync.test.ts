import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, contacts, graduations } from "@trafficflow/db";
import {
  planChange, commitChange, applyReconcileAction,
  fingerprintDedupKey, messageFingerprint, normalizeMime,
  UNMETERED_STORAGE_CAP,
} from "@trafficflow/core";
import type { Change, ClassifierPort, ClassifierInput, ClassifierResult, NativeLocator } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { SyncService, dbFor, type ServiceContext } from "../src/index.js";

/** A deterministic classifier + adapter that record whether they were called while a tx was active. */
class ProbeClassifier implements ClassifierPort {
  calls = 0;
  txCalls = 0;
  constructor(private readonly result: ClassifierResult, private readonly isTxActive: () => boolean) {}
  async classify(_input: ClassifierInput): Promise<ClassifierResult> {
    this.calls++;
    if (this.isTxActive()) this.txCalls++;
    return this.result;
  }
}
class ProbeAdapter {
  moves: Array<{ from: NativeLocator; to: string }> = [];
  txMoves = 0;
  private uid = 5000;
  constructor(private readonly isTxActive: () => boolean) {}
  async move(locator: NativeLocator, to: string): Promise<NativeLocator> {
    if (this.isTxActive()) this.txMoves++;
    this.moves.push({ from: locator, to: String(to) });
    return { folder: String(to), ref: `1:${++this.uid}` };
  }
}

const svc = new SyncService();

function eml(opts: { from?: string; subject?: string; body?: string } = {}): Buffer {
  const { from = "friend@known.example", subject = "lunch?", body = "want to grab lunch this week" } = opts;
  return Buffer.from([
    "Message-ID: <p-1@known.example>",
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "", body,
  ].join("\r\n"));
}
const createChange = (folder: string, raw: Buffer, ref = "1:10"): Change => ({ type: "create", locator: { folder, ref }, raw });

const FEED: ClassifierResult = { destination: "ohmail/News", confidence: 0.95, rationale: "bulk", spam: false };

async function setup(opts: { graduated?: boolean } = {}) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "mila@lichtgrat.example" }).returning();
  await db.insert(contacts).values({ accountId, address: "friend@known.example" }); // KNOWN sender → unclear residue
  if (opts.graduated) {
    await db.insert(graduations).values({ accountId, patternKey: "sender:friend@known.example→ohmail/News", action: "route", graduated: true });
  }
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => new Date("2026-07-28T00:00:00Z"), requestId: "r" };
  return { db, accountId, mailboxId: mb.id, ctx };
}

describe("pipeline → change_log → SyncService (real DrizzleRepo + PGlite)", () => {
  it("no network is awaited inside the persist transaction; commit is pure DB", async () => {
    const { db, accountId, mailboxId } = await setup({ graduated: true });
    let txActive = false;
    const classifier = new ProbeClassifier(FEED, () => txActive);
    const adapter = new ProbeAdapter(() => txActive);
    const repo = makeDrizzleRepo(db);

    // PLAN — reads + classify, OUTSIDE any tx (network allowed here)
    const plan = await planChange(createChange("INBOX", eml()), { repo, accountId, mailboxId, classifier, routing: repo });
    expect(classifier.calls).toBe(1);

    // COMMIT — persist inside ONE transaction; assert nothing networked ran inside it
    txActive = true;
    const res = await repo.transaction((tx) => commitChange(plan, { repo: tx, routing: tx, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP }));
    txActive = false;
    expect(classifier.txCalls).toBe(0);   // classifier was NOT awaited inside the tx
    expect(adapter.txMoves).toBe(0);      // adapter.move was NOT awaited inside the tx

    // The physical IMAP move happens AFTER commit, outside the tx.
    expect(res.action).toEqual({ type: "move", to: "ohmail/News" });
    // DERIVED, not a literal: `dedup_key` is `fp1:<fingerprint>` since that change slice 2, and a hardcoded
    // `mid:` key would have gone on reading as though it asserted the pipeline's identity.
    const key = fingerprintDedupKey(messageFingerprint(await normalizeMime(eml())));
    const stored = (await repo.findByDedupKey(mailboxId, key))!;
    const state = (await repo.getFolderState(stored.id))!;
    // The planner's answer here is a move of ours; an adoption never reaches this writer.
    if (res.action.type === "adopt_external") throw new Error("the plan adopted a move of ours");
    await applyReconcileAction(
      { repo, adapter: adapter as any, accountId, mailboxId },
      { messageId: stored.id, locator: stored.nativeLocator, state }, res.action,
    );
    expect(adapter.moves).toHaveLength(1);
  });

  it("graduated auto-apply surfaces message create + routing_decision create + message move via /sync", async () => {
    const { db, accountId, mailboxId, ctx } = await setup({ graduated: true });
    const classifier = new ProbeClassifier(FEED, () => false);
    const repo = makeDrizzleRepo(db);
    const plan = await planChange(createChange("INBOX", eml()), { repo, accountId, mailboxId, classifier, routing: repo });
    await repo.transaction((tx) => commitChange(plan, { repo: tx, routing: tx, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP }));

    const resp = await svc.getChanges(ctx, {});
    expect(resp.changes.creates.some((c) => c.type === "message")).toBe(true);
    expect(resp.changes.creates.some((c) => c.type === "routing_decision")).toBe(true);
    const move = resp.changes.moves.find((m) => m.type === "message");
    expect(move).toBeDefined();
    expect(move!.move).toEqual({ from: "INBOX", to: "ohmail/News" });
    // the auto-applied message re-materializes in its destination folder
    expect((move!.entity as { folder: string }).folder).toBe("ohmail/News");
  });

  it("unclear + not graduated surfaces an approval create via /sync (and no move)", async () => {
    const { db, accountId, mailboxId, ctx } = await setup({ graduated: false });
    const classifier = new ProbeClassifier({ ...FEED, confidence: 0.9 }, () => false);
    const repo = makeDrizzleRepo(db);
    const plan = await planChange(createChange("INBOX", eml()), { repo, accountId, mailboxId, classifier, routing: repo });
    await repo.transaction((tx) => commitChange(plan, { repo: tx, routing: tx, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP }));

    const resp = await svc.getChanges(ctx, {});
    expect(resp.changes.creates.some((c) => c.type === "approval")).toBe(true);
    expect(resp.changes.creates.some((c) => c.type === "routing_decision")).toBe(true);
    expect(resp.changes.moves).toHaveLength(0); // left in place until approved
  });
});
