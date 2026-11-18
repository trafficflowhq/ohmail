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
 * THE HOSTED VERDICT ON A CLAIMED AUTHOR SURVIVES THE CLOUD MIRROR. `MessageDTO.authVerdict` is
 * written into the local row's `auth_verdict`, so the local door re-emits what Cloud said and a
 * forged `From` stays a claim on a paired desktop. Absent on the wire (an older server) is NULL.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWN = "me@ohmail.test";
const HOSTED_MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, OWN)];

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ db: OpenLocalDb["db"]; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-auth-verdict-");
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

function inbound(id: string, from: string, verdict: MessageDTO["authVerdict"] | "absent"): MessageDTO {
  return {
    id, accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `${id}@sender.test`, subject: "Hello",
    from: { name: null, address: from }, to: [{ name: null, address: OWN }], cc: [],
    arrivedAt: "2026-09-26T08:00:00.000Z", date: "2026-09-26T08:00:00.000Z", folder: "INBOX",
    snippet: "", unread: true, lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-26T08:00:00.000Z",
    ...(verdict === "absent" ? {} : { authVerdict: verdict }),
  };
}

function page(messages: MessageDTO[]): SyncResponse {
  const creates: SyncChange[] = messages.map((m, i) => ({
    type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: iso(), entity: m,
  }));
  return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c1", hasMore: false, serverTime: iso() };
}

function fakeAuth(sync: SyncResponse): CloudAuth {
  let served = false;
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED_MAILBOXES));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
      const none = { creates: [], updates: [], moves: [], deletes: [] };
      // The bootstrap's rules-first pass: this feed carries no rules.
      if (path.startsWith("/sync") && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json({ ...sync, changes: none, cursor: "0" });
      }
      if (path.startsWith("/sync")) {
        if (served) return json({ ...sync, changes: none, cursor: "end" });
        served = true;
        return json(sync);
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

describe("the Cloud mirror carries MessageDTO.authVerdict", () => {
  it("the local door re-emits the hosted verdict, and absent reads as nobody asked", async () => {
    const { db, world, cursorPath } = await standUp();
    const forged = inbound(randomUUID(), "forged@x.test", "fail");
    const passed = inbound(randomUUID(), "real@x.test", "pass");
    const older = inbound(randomUUID(), "old@x.test", "absent");
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(), auth: fakeAuth(page([forged, passed, older])) }).pullOnce();
    const dtos = await materializeMessages(db, world.accountId, [forged.id, passed.id, older.id]);
    expect([forged.id, passed.id, older.id].map((id) => dtos.get(id)?.authVerdict)).toEqual(["fail", "pass", null]);
  });
});
