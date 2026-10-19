import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mailboxes, messageBodies, messages } from "@trafficflow/db/mail";
import { materializeMessages, messageService } from "@trafficflow/services/mail";
import type { MailboxDTO, MessageDTO, SnapshotResponse, SyncChange, SyncResponse } from "@trafficflow/services/mail";
import { normalizeMime } from "@trafficflow/core/mail";
import { owaInvitationStub } from "@ohmail/client-engine";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

/**
 * AN OUTLOOK WEB APP INVITATION STUB IS RECOGNIZED FROM WHAT EACH DESKTOP DOOR HOLDS (reported
 * 2026-10-19). A desktop signed in to Cloud mirrors no headers (`storeBodies` writes the text, not
 * `message_bodies.headers`), so the header fact cannot answer there; the body text it serves can.
 * The standalone store keeps the headers, and its header fact answers when Content-class is there.
 */

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OWN = "me@ohmail.test";
const HOSTED_MAILBOXES: readonly MailboxDTO[] = [hostedMailbox(CLOUD_MAILBOX, OWN)];
const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

const OPTS = "https://outlook.office365.com/owa/tenant.example/?path=/options/popandimap";
const HREF = "https://outlook.office365.com/owa/?path=/options/popandimap";
const STUB_TEXT = [
  "Microsoft Outlook Web Access:",
  "https://outlook.office365.com/owa/tenant.example/?itemid=AAMkAD%3D&exvsurl=1&path=/calendar/item",
  "",
  "To receive meeting invitations as .iCalendar attachments instead of Outlook Web App links, go to",
  `${OPTS} and select Send meeting invitations in iCalendar format.`,
].join("\n");

async function standUp(): Promise<{ db: OpenLocalDb["db"]; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-owa-stub-");
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
const NONE = { creates: [], updates: [], moves: [], deletes: [] };

function dto(id: string, extra: Partial<MessageDTO>): MessageDTO {
  return {
    id, accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `${id}@sender.test`, subject: "Think tank",
    from: { name: null, address: "colleague@sender.test" }, to: [{ name: null, address: OWN }], cc: [],
    arrivedAt: "2026-10-16T12:35:00.000Z", date: "2026-10-16T12:35:00.000Z", folder: "INBOX",
    snippet: "Microsoft Outlook Web Access:", unread: true, lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-16T12:35:00.000Z",
    ...extra,
  };
}

function page(ms: MessageDTO[]): SyncResponse {
  const creates: SyncChange[] = ms.map((m, i) => ({ type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: iso(), entity: m }));
  return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c1", hasMore: false, serverTime: iso() };
}

function fakeAuth(p: SyncResponse, bodies: Array<{ messageId: string; text: string }>): CloudAuth {
  let served = false;
  return {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) return json(mailboxList(HOSTED_MAILBOXES));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
      if (path.startsWith("/sync") && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json({ changes: NONE, cursor: "0", hasMore: false, serverTime: iso() });
      }
      if (path.startsWith("/sync")) {
        if (served) return json({ changes: NONE, cursor: "end", hasMore: false, serverTime: iso() });
        served = true;
        return json(p);
      }
      if (path.startsWith("/messages/bodies")) {
        return json({ items: bodies.map((b) => ({ messageId: b.messageId, text: b.text, html: null, loadedRemoteContent: false })), nextCursor: null });
      }
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

describe("a desktop signed in to Cloud", () => {
  it("serves the mirrored stub's text, and the reader recognizes it there", async () => {
    const { db, world, cursorPath } = await standUp();
    const owa = dto(randomUUID(), { invitationWithoutEvent: true, itipReplyHeader: false });
    const plain = dto(randomUUID(), { subject: "Calendar", snippet: "Here is the calendar" });
    const mirror = createCloudMirror({
      db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth(page([owa, plain]), [
        { messageId: owa.id, text: STUB_TEXT },
        { messageId: plain.id, text: `Here is the calendar:\n${OPTS}\nSee you.` },
      ]),
    });
    await mirror.pullOnce();
    await mirror.pullOnce();
    const ctx = { db, accountId: world.accountId } as never;
    const body = await messageService.getBody(ctx, owa.id);
    expect(owaInvitationStub(body.text)).toEqual({ optionsHref: HREF });
    const other = await messageService.getBody(ctx, plain.id);
    expect(owaInvitationStub(other.text)).toBeNull();
  });
});

describe("a standalone desktop store", () => {
  const STUB_EML = (withClass: boolean): string => [
    "Message-ID: <owa-stub@sender.test>",
    "From: A Colleague <colleague@sender.test>",
    `To: ${OWN}`,
    "Subject: Think tank",
    ...(withClass ? ["Content-class: urn:content-classes:calendarmessage"] : []),
    "X-MS-Has-Attach: ",
    "X-MS-Exchange-Calendar-Originator-Id: 00000000-0000-0000-0000-000000000000",
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="us-ascii"',
    "",
    STUB_TEXT,
    "",
  ].join("\r\n");

  for (const withClass of [true, false]) {
    it(`recognizes the stub from its stored text (Content-class ${withClass ? "present" : "absent"})`, async () => {
      const { db, world } = await standUp();
      const mailboxId = randomUUID();
      const at = new Date("2026-10-16T12:35:00.000Z");
      await db.insert(mailboxes).values({ id: mailboxId, accountId: world.accountId, provider: "imap", address: "stub@ohmail.test", status: "connected", createdAt: at });
      const msg = await normalizeMime(STUB_EML(withClass));
      const id = randomUUID();
      await db.insert(messages).values({ id, accountId: world.accountId, mailboxId, bodyHash: "h", dedupKey: id, subject: msg.subject, fromAddress: msg.from.address, date: at, createdAt: at, updatedAt: at });
      // Spread, as `drizzle-repo` does: the store refuses the parser's null-prototype map.
      await db.insert(messageBodies).values({ messageId: id, text: msg.textBody, headers: { ...msg.headers } });
      const got = (await materializeMessages(db, world.accountId, [id])).get(id);
      expect(got?.invitationWithoutEvent).toBe(withClass);
      const body = await messageService.getBody({ db, accountId: world.accountId } as never, id);
      expect(owaInvitationStub(body.text)).toEqual({ optionsHref: HREF });
    });
  }
});
