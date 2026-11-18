import type { MailboxDTO, MessageDTO, SnapshotResponse, SyncChange, SyncResponse } from "@ohmail/wire";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeMessages } from "@trafficflow/services/mail";
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
 * THE OPEN READ SURVIVES THE CLOUD MIRROR (owner 2026-10-07). `MessageDTO.openReadAt` is written
 * into the local row's `open_read_at`, so a paired desktop places a message read on the account's
 * other devices at the top of Earlier too; a later page that clears it (an unread) clears it here —
 * it is in the conflict set. Absent on the wire (an older server) is NULL: arrival.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWN = "me@ohmail.test";
const HOSTED_MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, OWN)];
const READ_AT = "2026-10-07T11:30:00.000Z";

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ db: OpenLocalDb["db"]; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-open-read-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
  return { db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const iso = (): string => new Date().toISOString();
const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const EMPTY_SNAPSHOT: SnapshotResponse = { asOfSeq: 99, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };

function inbound(id: string, openReadAt: string | null | "absent"): MessageDTO {
  return {
    id, accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `${id}@sender.test`, subject: "Hello",
    from: { name: null, address: "someone@x.test" }, to: [{ name: null, address: OWN }], cc: [],
    arrivedAt: "2026-09-26T08:00:00.000Z", date: "2026-09-26T08:00:00.000Z", folder: "INBOX",
    snippet: "", unread: false, lastReadAt: READ_AT, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-26T08:00:00.000Z",
    ...(openReadAt === "absent" ? {} : { openReadAt }),
  };
}

function page(messages: MessageDTO[], from: number, cursor: string): SyncResponse {
  const creates: SyncChange[] = messages.map((m, i) => ({
    type: "message", op: "create", id: m.id, seq: from + i, updatedAt: iso(), entity: m,
  }));
  return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor, hasMore: false, serverTime: iso() };
}

/** Serves the pages in order, one per data pull; the rules-first pass and every later ask read empty. */
function fakeAuth(pages: SyncResponse[]): CloudAuth {
  const queue = [...pages];
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED_MAILBOXES));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
      const none = { creates: [], updates: [], moves: [], deletes: [] };
      if (path.startsWith("/sync") && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json({ changes: none, cursor: "0", hasMore: false, serverTime: iso() });
      }
      if (path.startsWith("/sync")) {
        const next = queue.shift();
        return json(next ?? { changes: none, cursor: "end", hasMore: false, serverTime: iso() });
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

describe("the Cloud mirror carries MessageDTO.openReadAt", () => {
  it("the local door re-emits the open read, absent reads as arrival, and a later clear clears it", async () => {
    const { db, world, cursorPath } = await standUp();
    const stamped = inbound(randomUUID(), READ_AT);
    const plain = inbound(randomUUID(), null);
    const older = inbound(randomUUID(), "absent");
    const pages = [page([stamped, plain, older], 1, "c1"), page([{ ...stamped, unread: true, lastReadAt: null, openReadAt: null }], 10, "c2")];
    const mirror = createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(pages) });
    await mirror.pullOnce();
    // MUTATION WATCHED: cut `openReadAt` from cloud-mirror.ts's display set and the first is null.
    const first = await materializeMessages(db, world.accountId, [stamped.id, plain.id, older.id]);
    expect([stamped.id, plain.id, older.id].map((id) => first.get(id)?.openReadAt)).toEqual([READ_AT, null, null]);
    await mirror.pullOnce();
    const after = await materializeMessages(db, world.accountId, [stamped.id]);
    expect(after.get(stamped.id)?.unread).toBe(true);
    expect(after.get(stamped.id)?.openReadAt, "the conflict set carries the clear").toBeNull();
  });
});
