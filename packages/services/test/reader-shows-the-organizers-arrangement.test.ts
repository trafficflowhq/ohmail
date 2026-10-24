import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { changeLog, mailboxes, mailboxProfileMirror, recordMailboxProfileChange, rules } from "@trafficflow/db";
import {
  MemoryMirrorStore, consentPartition, type EngineMessage, type SyncChange,
} from "@ohmail/client-engine";
import { SyncService, materialize } from "../src/index.js";
import { applyProfileRead } from "../../../apps/worker/src/profile.js";
import { makeCtx, otherAccount, seedMessage } from "./helpers.js";

/**
 * A READER SHOWS THE ORGANIZER'S ARRANGEMENT. A reader's split is made by the client over the
 * rule entities, and a reader's own rules table holds none of the organizer's decisions, so a
 * sender the organizer let in waited in the reader's Screener. The organizer's document is
 * already cached here; this file drives it from the table to the partition, server and client.
 */

const NOW = new Date("2026-09-26T08:00:00.000Z");
const LET_IN = "letin@sender.test";
const STRANGER = "stranger@nobody.test";
const svc = new SyncService();
const quiet = (): void => { /* the outcomes are asserted, not the log */ };

type World = Awaited<ReturnType<typeof makeCtx>>;

const DOC = (letIn: string): Record<string, unknown> => ({
  v: 2, updatedAt: "2026-09-26T07:00:00.000Z", producer: { kind: "local", version: "dev" },
  screener: [],
  rules: [{ kind: "sender", match: letIn, destination: "INBOX", priority: 0, enabled: true, provenance: "promoted" }],
  notifyRules: [], awayResponder: null, tagNames: [], signature: null,
});

/** Another install organizes this mailbox; this one reads it. */
async function readsOnly(w: World): Promise<void> {
  await w.db.update(mailboxes).set({
    organizerRole: "reader", organizerState: "held", organizedByKind: "local", organizedByName: "Host",
  }).where(eq(mailboxes.id, w.mailboxId));
}

async function mirrorDoc(w: World, doc: Record<string, unknown>, mailboxId = w.mailboxId): Promise<void> {
  await w.db.insert(mailboxProfileMirror).values({
    mailboxId, accountId: w.accountId, doc, uidvalidity: 7n, uid: 11, readAt: NOW,
  });
}

/** Mail from both senders, as the reader ingests it: in the INBOX, no decision attached. */
async function mail(w: World): Promise<{ letIn: string; stranger: string }> {
  const at = new Date("2026-09-26T07:30:00.000Z");
  return {
    letIn: await seedMessage(w.db, w.accountId, w.mailboxId, { from: LET_IN, folder: "INBOX", date: at }),
    stranger: await seedMessage(w.db, w.accountId, w.mailboxId, { from: STRANGER, folder: "INBOX", date: at }),
  };
}

async function snapshot(w: World): Promise<{ changes: SyncChange[]; store: MemoryMirrorStore }> {
  const page = await svc.getSnapshot(w.ctx, {});
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(page.changes as SyncChange[]);
  return { changes: page.changes as SyncChange[], store };
}

const placeOf = (store: MemoryMirrorStore, id: string) =>
  consentPartition(store, { now: NOW }).placeOf.get(id);

const profileChanges = (changes: readonly SyncChange[]) =>
  changes.filter((c) => (c.type as string) === "mailbox_profile");

describe("a reader presents the mailbox by the organizer's document", () => {
  it("page 1 carries the arrangement, and the let-in sender presents in the Ohbox", async () => {
    const w = await makeCtx(NOW);
    await readsOnly(w);
    await mirrorDoc(w, DOC(LET_IN));
    const ids = await mail(w);

    const { changes, store } = await snapshot(w);
    const carried = profileChanges(changes);
    expect(carried, "page 1 carried no arrangement for the read mailbox").toHaveLength(1);
    expect(carried[0]!.id).toBe(w.mailboxId);

    // The reader's own rules table is empty — the state the finding measured.
    expect(await w.db.select().from(rules).where(eq(rules.accountId, w.accountId))).toHaveLength(0);
    expect(placeOf(store, ids.letIn), "the organizer let this sender in").toBe("INBOX");
    expect(placeOf(store, ids.stranger), "nobody decided on this sender").toBe("ohmail/Screener");
  });

  it("the rule's own age and the requests the copy includes reach the client; an older copy says neither", async () => {
    const w = await makeCtx(NOW);
    await readsOnly(w);
    const AGE = "2026-09-20T10:00:00.000Z";
    const doc = DOC(LET_IN);
    await mirrorDoc(w, {
      ...doc, applied: ["req-1", "req-2"],
      rules: (doc.rules as Array<Record<string, unknown>>).map((r) => ({ ...r, updatedAt: AGE })),
    });
    const entity = profileChanges((await snapshot(w)).changes)[0]!.entity as { applied: unknown; rules: Array<{ createdAt: string }> };
    expect(entity.applied).toEqual(["req-1", "req-2"]);
    expect(entity.rules[0]!.createdAt).toBe(AGE);

    const older = await makeCtx(NOW);
    await readsOnly(older);
    await mirrorDoc(older, DOC(LET_IN));
    const plain = profileChanges((await snapshot(older)).changes)[0]!.entity as { applied: unknown; rules: Array<{ createdAt: string }> };
    expect(plain.applied).toBeNull();
    expect(plain.rules[0]!.createdAt).toBe(NOW.toISOString());
  });

  it("an organizer's page 1 carries none, and its own rules decide", async () => {
    const w = await makeCtx(NOW);
    // A stale document from before this install took the mailbox over.
    await mirrorDoc(w, DOC(LET_IN));
    const ids = await mail(w);

    const { changes, store } = await snapshot(w);
    expect(profileChanges(changes), "an organizer was served somebody else's document").toHaveLength(0);
    expect(placeOf(store, ids.letIn)).toBe("ohmail/Screener");
  });

  it("another account's mailbox reads nothing, by page and by id", async () => {
    const w = await makeCtx(NOW);
    const other = await otherAccount(w.db);
    await w.db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, other.mailboxId));
    await w.db.insert(mailboxProfileMirror).values({
      mailboxId: other.mailboxId, accountId: other.accountId, doc: DOC(LET_IN), readAt: NOW,
    });

    const { changes } = await snapshot(w);
    expect(profileChanges(changes)).toHaveLength(0);
    expect(await materialize(w.db, w.accountId, "mailbox_profile" as never, other.mailboxId)).toBeNull();
  });

  it("a document read after the snapshot reaches the client on the delta", async () => {
    const w = await makeCtx(NOW);
    await readsOnly(w);
    const ids = await mail(w);
    const { store } = await snapshot(w);
    expect(placeOf(store, ids.letIn)).toBe("ohmail/Screener");
    const cursor = (await svc.getChanges(w.ctx, {})).cursor;

    // The reader's cycle reads the organizer's document.
    const outcome = await applyProfileRead(
      { db: w.db as never, accountId: w.accountId, mailboxId: w.mailboxId, now: NOW, log: quiet },
      { state: "found", doc: DOC(LET_IN) as never, installId: "host", ref: 11, generation: 7, residue: 0 },
    );
    expect(outcome.state).toBe("written");
    const rows = await w.db.select().from(changeLog).where(and(
      eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "mailbox_profile" as never),
    ));
    expect(rows, "the mirror write rang nothing").toHaveLength(1);

    const delta = await svc.getChanges(w.ctx, { since: cursor });
    await store.applyChanges([...delta.changes.creates, ...delta.changes.updates, ...delta.changes.deletes]);
    expect(placeOf(store, ids.letIn), "the delta left the reader's Screener stale").toBe("INBOX");

    // The same document read again at the next cadence rings nothing new.
    await applyProfileRead(
      { db: w.db as never, accountId: w.accountId, mailboxId: w.mailboxId, now: NOW, log: quiet },
      { state: "found", doc: DOC(LET_IN) as never, installId: "host", ref: 11, generation: 7, residue: 0 },
    );
    const again = await w.db.select().from(changeLog).where(and(
      eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "mailbox_profile" as never),
    ));
    expect(again).toHaveLength(1);
  });

  it("a promotion drains the arrangement as a tombstone", async () => {
    const w = await makeCtx(NOW);
    await readsOnly(w);
    await mirrorDoc(w, DOC(LET_IN));
    const ids = await mail(w);
    const { store } = await snapshot(w);
    expect(placeOf(store, ids.letIn)).toBe("INBOX");
    const cursor = (await svc.getChanges(w.ctx, {})).cursor;

    // This install takes the mailbox over; its own (empty) rules are the configuration now.
    await w.db.transaction(async (tx) => {
      await tx.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, w.mailboxId));
      await recordMailboxProfileChange(tx as never, w.accountId, w.mailboxId);
    });
    const delta = await svc.getChanges(w.ctx, { since: cursor });
    expect(delta.changes.deletes.map((c) => c.type as string)).toContain("mailbox_profile");
    await store.applyChanges([...delta.changes.creates, ...delta.changes.updates, ...delta.changes.deletes]);
    expect(placeOf(store, ids.letIn)).toBe("ohmail/Screener");
    expect(store.list<EngineMessage>("mailbox_profile")).toHaveLength(0);
  });
});
