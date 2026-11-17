import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { folderState, mailboxes, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { OrganizerRole } from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * OWN MAIL THROUGH THE VISIT BOTH ORGANIZER DOORS RUN (`runSyncCycle`, the desktop engine's loop
 * too): an own-address arrival stays in INBOX, and own mail the old router filed at the gate — this
 * install's or the previous organizer's — is released and MOVED back by the organizer's first
 * visit. A reader releases nothing. The gate state is planted after a READER's ingest, because the
 * release is asked once per mailbox per process. Addresses are `.invalid`.
 */

const GATE = "ohmail/Screener";

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  const me = `me-${accountId.slice(0, 8)}@own.invalid`;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: me }).returning();
  await db.insert(mailboxes).values({ accountId, provider: "imap", address: "second@own-too.invalid" });
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  const cycle = (role: OrganizerRole = "organizer") => runSyncCycle({
    writeAuthority: role === "reader" ? { noLease: "reader" as const } : FIXTURE_LEASE,
    repo: makeDrizzleRepo(db as never), adapter, accountId, mailboxId: mb!.id,
    storageCap: UNMETERED_STORAGE_CAP, role, trustedAuthservIds: new Set<string>(),
  });
  const rowOf = async (from: string) => {
    const [r] = await db.select({ id: messages.id, desired: folderState.desiredFolder, by: folderState.lastSetBy })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.mailboxId, mb!.id), eq(messages.fromAddress, from)));
    return r!;
  };
  const fileAtGate = (id: string, lastSetBy: string) => db.update(folderState)
    .set({ desiredFolder: GATE, observedFolder: GATE, lastSetBy, reconcileStatus: "reconciled" })
    .where(eq(folderState.messageId, id));
  return { db, mb: mb!, me, fleet, cycle, rowOf, fileAtGate };
}

describe("own mail in the organizer's visit", () => {
  it("an own-address arrival stays in INBOX; a stranger's is held", async () => {
    const w = await world();
    w.fleet.behave(w.mb.id, { deliver: [
      { from: w.me, subject: "a note", messageId: `self-${randomUUID()}@own.invalid` },
      { from: "Second@Own-Too.invalid", subject: "from my other box", messageId: `self-${randomUUID()}@own.invalid` },
      { from: "someone@stranger.invalid", subject: "hello", messageId: `x-${randomUUID()}@stranger.invalid` },
    ] });
    await w.cycle();
    expect((await w.rowOf(w.me)).desired).toBe("INBOX");
    expect((await w.rowOf("second@own-too.invalid")).desired).toBe("INBOX");
    expect((await w.rowOf("someone@stranger.invalid")).desired).toBe(GATE);
    expect(w.fleet.movesFor(w.mb.id)).toEqual([GATE]);
  });

  it("own mail the old router filed at the gate is moved back once; a person's placement stays", async () => {
    const w = await world();
    // In the gate folder, where the old router's move and the person's drag left them.
    w.fleet.behave(w.mb.id, { deliver: [
      { from: w.me, subject: "a note", messageId: `self-${randomUUID()}@own.invalid`, folder: GATE },
      { from: "second@own-too.invalid", subject: "filed by hand", messageId: `self-${randomUUID()}@own.invalid`, folder: GATE },
    ] });
    await w.cycle("reader");
    const ours = await w.rowOf(w.me);
    const theirs = await w.rowOf("second@own-too.invalid");
    // The state the pre-fix router left behind, and a person's own drag into the folder.
    await w.fileAtGate(ours.id, "us");
    await w.fileAtGate(theirs.id, "external");

    await w.cycle();
    expect((await w.rowOf(w.me)).desired).toBe("INBOX");
    expect(w.fleet.movesFor(w.mb.id)).toEqual(["INBOX"]);
    const kept = await w.rowOf("second@own-too.invalid");
    expect([kept.desired, kept.by]).toEqual([GATE, "external"]);

    await w.cycle();
    expect(w.fleet.movesFor(w.mb.id), "released once").toEqual(["INBOX"]);
  });

  it("own mail the previous organizer filed at the gate, met by this install as a reader, is moved back", async () => {
    const w = await world();
    w.fleet.behave(w.mb.id, { deliver: [
      { from: w.me, subject: "a note", messageId: `self-${randomUUID()}@own.invalid`, folder: GATE },
    ] });
    await w.cycle("reader");
    // What a reader's first read records for mail another install filed in an organized folder.
    await w.fileAtGate((await w.rowOf(w.me)).id, "peer");
    await w.cycle("reader");
    expect((await w.rowOf(w.me)).desired, "a reader still releases nothing").toBe(GATE);

    await w.cycle();
    expect((await w.rowOf(w.me)).desired).toBe("INBOX");
    expect(w.fleet.movesFor(w.mb.id)).toEqual(["INBOX"]);
  });

  it("a reader releases nothing", async () => {
    const w = await world();
    w.fleet.behave(w.mb.id, { deliver: [
      { from: w.me, subject: "a note", messageId: `self-${randomUUID()}@own.invalid` },
    ] });
    await w.cycle("reader");
    const ours = await w.rowOf(w.me);
    await w.fileAtGate(ours.id, "us");
    await w.cycle("reader");
    expect((await w.rowOf(w.me)).desired).toBe(GATE);
    expect(w.fleet.movesFor(w.mb.id)).toEqual([]);
  });
});
