import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { messageInvitations } from "@trafficflow/db/mail";
import { materializeMessages } from "@trafficflow/services/mail";
import type { MailboxDTO, MessageDTO, SnapshotResponse, SyncChange, SyncResponse } from "@trafficflow/services/mail";
import type { MessageInvitationDTO } from "@ohmail/wire";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * A DESKTOP SIGNED IN TO CLOUD SHOWS THE INVITATION CLOUD SHOWS (mail 0204). The field rides the
 * message record, so the copy's message arm writes its row from the field and drops it when a later
 * record carries none; the local door then serves the same field. A record that gains the field
 * later (the pass over stored mail, an answer recorded) reaches the copy as an update.
 */
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
const OWN = "mila@lichtgrat.example";
const HOSTED_MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, OWN)];

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ db: OpenLocalDb["db"]; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-invitation-copy-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
  return { db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const iso = (): string => new Date().toISOString();
const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const page = (changes: SyncChange[], cursor: string): SyncResponse => ({
  changes: { creates: changes.filter((c) => c.op === "create"), updates: changes.filter((c) => c.op === "update"), moves: [], deletes: [] },
  cursor, hasMore: false, serverTime: iso(),
});
const EMPTY_SNAPSHOT: SnapshotResponse = { asOfSeq: 99, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };

const INVITATION: MessageInvitationDTO = {
  method: "REQUEST", uid: "kickoff-17@studio.example", recurrenceId: "", sequence: 2, start: "20261201T100000Z",
  startsAt: "2026-12-01T10:00:00.000Z", organizer: "tobias@studio.example", invitedAddress: OWN, answer: null, answeredAt: null,
};

function letter(id: string, invitation?: MessageInvitationDTO): MessageDTO {
  return {
    id, accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `${id}@studio.example`, subject: "Invitation: Kickoff",
    from: { name: null, address: "tobias@studio.example" }, to: [{ name: null, address: OWN }], cc: [],
    arrivedAt: "2026-11-10T08:00:00.000Z", date: "2026-11-10T08:00:00.000Z", folder: "INBOX",
    snippet: "", unread: true, lastReadAt: null, hasAttachments: true, attachmentCount: 1,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
    ...(invitation === undefined ? {} : { invitation }),
  };
}
const change = (m: MessageDTO, op: SyncChange["op"], seq: number): SyncChange => ({ type: "message", op, id: m.id, seq, updatedAt: iso(), entity: m });

function fakeAuth(sync: SyncResponse[]): CloudAuth {
  let s = 0;
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED_MAILBOXES));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
      if (path.startsWith("/sync")) return json(sync[s++] ?? page([], "end"));
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

describe("the copy of a Cloud account keeps each letter's invitation", () => {
  it("a record with the field writes the row and the local door serves it; one without removes it", async () => {
    const { db, world, cursorPath } = await standUp();
    const id = randomUUID();
    const plain = randomUUID();
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([page([change(letter(id, INVITATION), "create", 1), change(letter(plain), "create", 2)], "c1")]),
    }).pullOnce();
    const local = await materializeMessages(db, world.accountId, [id, plain]);
    expect(local.get(id)?.invitation).toEqual(INVITATION);
    expect("invitation" in local.get(plain)!).toBe(false);

    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(), auth: fakeAuth([page([change(letter(id), "update", 3)], "c2")]),
    }).pullOnce();
    expect(await db.select().from(messageInvitations).where(eq(messageInvitations.messageId, id))).toEqual([]);
    expect("invitation" in (await materializeMessages(db, world.accountId, [id])).get(id)!).toBe(false);
  });

  it("a letter that gains its invitation later, or an answer, shows it after the update", async () => {
    const { db, world, cursorPath } = await standUp();
    const id = randomUUID();
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(), auth: fakeAuth([page([change(letter(id), "create", 1)], "c1")]),
    }).pullOnce();
    expect("invitation" in (await materializeMessages(db, world.accountId, [id])).get(id)!).toBe(false);
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(), auth: fakeAuth([page([change(letter(id, INVITATION), "update", 2)], "c2")]),
    }).pullOnce();
    expect((await materializeMessages(db, world.accountId, [id])).get(id)?.invitation).toEqual(INVITATION);
    const answered: MessageInvitationDTO = { ...INVITATION, answer: "accepted", answeredAt: "2026-11-11T09:00:00.000Z" };
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(), auth: fakeAuth([page([change(letter(id, answered), "update", 3)], "c3")]),
    }).pullOnce();
    expect((await materializeMessages(db, world.accountId, [id])).get(id)?.invitation).toEqual(answered);
  });

  it("a field past the door's bounds keeps no row on the copy either", async () => {
    const { db, world, cursorPath } = await standUp();
    const id = randomUUID();
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth([page([change(letter(id, { ...INVITATION, uid: "u".repeat(1025) }), "create", 1)], "c1")]),
    }).pullOnce();
    expect(await db.select().from(messageInvitations).where(eq(messageInvitations.messageId, id))).toEqual([]);
  });
});
