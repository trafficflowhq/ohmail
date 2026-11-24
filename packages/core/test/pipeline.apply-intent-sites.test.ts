import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, folderState, workflows, workflowRuns, type Tx } from "@trafficflow/db";
import { WorkflowExecutor, type WorkflowRunRow } from "@trafficflow/core";
import { applyReconcileAction, commitChange, planChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import { FakeRepo, FakeAdapter } from "./fakes.js";
import type { Change, FolderStateRow, NativeLocator } from "../src/ports.js";
import type { Rule } from "../src/rules.js";

/**
 * EVERY APPLY-PATH FOLDER-STATE WRITE, ASKED THE SAME QUESTION
 * (a completion that overwrote a newer intent).
 *
 * The census is `repo.upsertFolderState(` outside the ingest transaction: the two arms of
 * `applyReconcileAction`, the arrival's adoption and the AI workflow's `file_message`. Each writes a folder state derived
 * from a row read EARLIER, so each is asked whether a desire committed since survives it. A table
 * rather than four hand-written cases: the defect was fixed at one arm and left at the others.
 */
const SOURCE = "ohmail/News";
const READ = "INBOX";                 // the desire this pass was computed against
const NEWER = "ohmail/Screener";      // the desire another door committed since
const loc = (folder: string, ref = "1:5"): NativeLocator => ({ folder, ref });
const st = (desiredFolder: string, observedFolder: string, lastSetBy: "us" | "external" = "us"):
  FolderStateRow => ({ desiredFolder, observedFolder, lastSetBy });

/** What one call site must be able to say for itself after a competing decision landed. */
interface Site {
  site: string;
  /** The property the site is on the hook for; a site with no pre-I/O desire says so here. */
  claim: string;
  run(): Promise<{ desired: string; observed: string }>;
  desired: string;
  observed: string;
}

const SITES: Site[] = [
  {
    site: "pipeline.ts case \"none\" — the status repair",
    claim: "the repair echoes a desire read before the pass's network work, so it is conditional",
    async run() {
      const d = { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "a", mailboxId: "m" };
      await d.repo.upsertFolderState("m1", st(READ, READ));
      // The window is the CALLER's: it read the pair, went to the server, and calls with the
      // snapshot. Another door committed `NEWER` in between.
      await d.repo.upsertFolderState("m1", st(NEWER, READ));
      await applyReconcileAction(d, { messageId: "m1", locator: loc(READ), state: st(READ, READ) },
        { type: "none" });
      const row = (await d.repo.getFolderState("m1"))!;
      return { desired: row.desiredFolder, observed: row.observedFolder };
    },
    desired: NEWER, observed: READ,
  },
  {
    site: "pipeline.ts case \"move\" — the landed completion",
    claim: "the landed folder is a fact and the desire is only a witness",
    async run() {
      const d = { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "a", mailboxId: "m" };
      await d.repo.upsertFolderState("m1", st(READ, SOURCE));
      d.adapter.onMove = () => { void d.repo.upsertFolderState("m1", st(NEWER, SOURCE)); };
      await applyReconcileAction(d, { messageId: "m1", locator: loc(SOURCE), state: st(READ, SOURCE) },
        { type: "move", to: READ });
      const row = (await d.repo.getFolderState("m1"))!;
      return { desired: row.desiredFolder, observed: row.observedFolder };
    },
    desired: NEWER, observed: READ,
  },
  {
    site: "pipeline.ts case \"move\" — the declined completion with no row",
    claim: "a row another door created mid-flight is not a missing row and takes the witness arm",
    async run() {
      const d = { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "a", mailboxId: "m" };
      // No row at all when the caller read; one appears while the move is in flight.
      d.adapter.onMove = () => { void d.repo.upsertFolderState("m1", st(NEWER, SOURCE)); };
      await applyReconcileAction(d, { messageId: "m1", locator: loc(SOURCE), state: st(READ, SOURCE) },
        { type: "move", to: READ });
      const row = (await d.repo.getFolderState("m1"))!;
      return { desired: row.desiredFolder, observed: row.observedFolder };
    },
    desired: NEWER, observed: READ,
  },
  {
    // The one adoption there is, the arrival's (`applyReconcileAction` admits none): planned in
    // phase 1, another door commits a desire, then the commit observes the person's move.
    site: "pipeline.ts commitChange case \"adopt_external\" — the person's own placement",
    claim: "the adoption moves the desire only while the desire it was computed against stands",
    async run() {
      const { repo, messageId, planned } = await arrivalPlanned();
      await repo.upsertFolderState(messageId, st(NEWER, READ));
      await commitChange(planned, { storageCap: UNMETERED_STORAGE_CAP, repo, accountId: "a", mailboxId: "m" });
      const row = (await repo.getFolderState(messageId))!;
      return { desired: row.desiredFolder, observed: row.observedFolder };
    },
    desired: NEWER, observed: SOURCE,
  },
];

/** A message the route filed into READ, then planned as the person's move of it to SOURCE. */
async function arrivalPlanned() {
  const repo = new FakeRepo();
  const rule: Rule = {
    id: "r", kind: "sender", match: "digest@anchor.example", destination: READ as Rule["destination"],
    effect: "allow", priority: 0, provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
  };
  repo.rules = [rule];
  const raw = Buffer.from([
    `Message-ID: <adopt-${Math.random().toString(36).slice(2)}@anchor.example>`,
    "From: Anchor <digest@anchor.example>", "To: owner@example.test", "Subject: s",
    "Content-Type: text/plain; charset=utf-8", "", "body",
  ].join("\r\n"));
  const deps = { repo, accountId: "a", mailboxId: "m", readerMode: false };
  const ch = (type: "create" | "move", folder: string, ref: string): Change => ({ type, locator: { folder, ref }, raw, seen: false });
  const first = await commitChange(await planChange(ch("create", READ, "1:1"), deps),
    { storageCap: UNMETERED_STORAGE_CAP, repo, accountId: "a", mailboxId: "m" });
  const planned = await planChange(ch("move", SOURCE, "9:1"), deps);
  return { repo, messageId: first.messageId, planned };
}

describe("the apply path's folder-state writes — a desire committed since the read survives", () => {
  for (const s of SITES) {
    it(`${s.site}: ${s.claim}`, async () => {
      const got = await s.run();
      expect(got.desired, "the newer decision was overwritten by an older one").toBe(s.desired);
      expect(got.observed, "the physical fact was not recorded").toBe(s.observed);
    });
  }

  it("POSITIVE CONTROL — with nothing interleaved every site writes what it was asked to", async () => {
    const mk = () => ({ repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "a", mailboxId: "m" });
    const none = mk();
    await none.repo.upsertFolderState("m1", st(READ, SOURCE));
    await applyReconcileAction(none, { messageId: "m1", locator: loc(READ), state: st(READ, SOURCE) },
      { type: "none" });
    expect(await none.repo.getFolderState("m1")).toMatchObject({ desiredFolder: READ, observedFolder: READ });

    const moved = mk();
    await moved.repo.upsertFolderState("m1", st(READ, SOURCE));
    await applyReconcileAction(moved, { messageId: "m1", locator: loc(SOURCE), state: st(READ, SOURCE) },
      { type: "move", to: READ });
    expect(await moved.repo.getFolderState("m1")).toMatchObject({ desiredFolder: READ, observedFolder: READ });

    const fresh = mk();
    await applyReconcileAction(fresh, { messageId: "m1", locator: loc(SOURCE), state: st(READ, SOURCE) },
      { type: "move", to: READ });
    expect(await fresh.repo.getFolderState("m1")).toMatchObject({ desiredFolder: READ, observedFolder: READ });

    const adopt = await arrivalPlanned();
    await commitChange(adopt.planned, { storageCap: UNMETERED_STORAGE_CAP, repo: adopt.repo, accountId: "a", mailboxId: "m" });
    expect(await adopt.repo.getFolderState(adopt.messageId))
      .toMatchObject({ desiredFolder: SOURCE, observedFolder: SOURCE, lastSetBy: "external" });
  });
});

/**
 * The fourth call site, and why it is asked a different question. `file_message` writes its own
 * intent one statement after reading the row, inside one transaction, with NO network work
 * between — there is no pre-I/O desire for it to put back. What it must not do is invent an
 * observation: the worker's landed folder is on the row and this step is not entitled to replace
 * it with the message's native locator.
 */
describe("the workflow runner's file_message — the observation on the row is not re-derived", () => {
  it("keeps the observed folder the worker recorded", async () => {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: "g@tf.example",
    }).returning();
    const dedup = `mid:${randomUUID()}`;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, messageIdHeader: dedup, bodyHash: randomUUID(), dedupKey: dedup,
      subject: "s", fromAddress: "v@ex.example", nativeLocator: loc("INBOX"),
    }).returning();
    // The worker landed this message in `SOURCE`; the message row still names INBOX.
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: READ, observedFolder: SOURCE,
      lastSetBy: "us", reconcileStatus: "pending", conflict: false,
    });

    const [wf] = await db.insert(workflows).values({
      accountId, name: "wf", enabled: true, trigger: { kind: "manual" },
      steps: [{ tool: "file_message", args: { messageId: m!.id, toFolder: NEWER } }],
    }).returning();
    const [run] = await db.insert(workflowRuns).values({
      accountId, workflowId: wf!.id, status: "running", trigger: { kind: "manual" },
    }).returning();
    const rowRun: WorkflowRunRow = {
      id: run!.id, accountId, workflowId: wf!.id, stepCursor: run!.stepCursor, status: "running",
    };
    const res = await new WorkflowExecutor().runOne(
      {
        db: db as unknown as Tx,
        drafter: { async draft() { return { subject: "", body: "", rationale: "" }; } },
        now: () => new Date(),
      },
      rowRun,
    );
    expect(res.status).toBe("succeeded");

    const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, m!.id));
    expect(fs!.desiredFolder, "the step's own intent did not land").toBe(NEWER);
    expect(fs!.observedFolder, "the landed folder was replaced by the message's stale locator")
      .toBe(SOURCE);
  });
});

/**
 * THE ARRIVAL'S ADOPTION IS STAMPED WITH A LOWER BOUND OF THE MOVE (mail 0145): the mailbox's
 * `last_sync_at` as this cycle found it, read in the adoption's own transaction — never the clock.
 */
describe("the adopted external move's stamp", () => {
  it("is the mailbox's previous success start, or none before any", async () => {
    for (const lastSyncAt of [new Date("2026-10-01T08:00:00.000Z"), null]) {
      const adopt = await arrivalPlanned();
      (adopt.repo as unknown as { getMailbox: () => Promise<unknown> }).getMailbox = async () => ({
        id: "m", accountId: "a", address: "x@y", kickstartAt: null, foldersOff: false, lastSyncAt,
      });
      await commitChange(adopt.planned, { storageCap: UNMETERED_STORAGE_CAP, repo: adopt.repo, accountId: "a", mailboxId: "m" });
      expect(adopt.repo.adoptionStamps.get(adopt.messageId) ?? null).toEqual(lastSyncAt);
    }
  });

  it("a bound the caller states wins over the read", async () => {
    const adopt = await arrivalPlanned();
    const stated = new Date("2026-10-02T08:00:00.000Z");
    await commitChange(adopt.planned, { storageCap: UNMETERED_STORAGE_CAP, repo: adopt.repo, accountId: "a", mailboxId: "m", observedSince: stated });
    expect(adopt.repo.adoptionStamps.get(adopt.messageId)).toEqual(stated);
  });
});
