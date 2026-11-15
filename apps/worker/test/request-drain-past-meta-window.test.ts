import { accountOfMessage } from "@trafficflow/db";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, folderState, organizerRequests } from "@trafficflow/db";
import { ScreenerService } from "@trafficflow/services/mail";
import {
  META_RECORDS_MAX_PER_FETCH, deriveRequestKey, makeRequestOrganizerIo, makeRequestReaderIo,
  type LeaseImapClient,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { memoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import { applyMetaRequests, driveOutstandingRequests } from "../src/request-drain.js";

/**
 * A REQUEST PAST THE 500-RECORD WINDOW (REQUEST-DRAIN-REFUSES-PAST-META-WINDOW).
 *
 * `ohmail/_meta` holds more than one window of records that are none of ours (another client's
 * strays). The reader's press must still reach the organizer and come back answered: the drains
 * read the folder through the one enumeration, not the newest window.
 */
const META = "INBOX.ohmail._meta";
const toServer = (canonical: string): string => canonical.replace(/\//g, ".");
const READER_SELF = { installId: "the-desktop", kind: "local" as const };
const t0 = new Date("2026-09-03T12:00:00.000Z");
const at = (s: number): Date => new Date(t0.getTime() + s * 1000);

async function world(strays: number) {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  for (let i = 0; i < strays; i++) server.seed(META, `Subject: stray ${i}\r\nX-Other-Client: 1\r\n\r\nbody`, t0);
  const client = server as unknown as LeaseImapClient;
  const reader = makeRequestReaderIo(client, toServer);
  const organizer = makeRequestOrganizerIo(client, toServer, { installId: "organizer-install", mailboxId: "m" });
  const db = await makeTestDb();
  const accountId = "00000000-0000-0000-0000-000000000901";
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "shared@x.example",
    organizerRole: "reader", organizerState: "held", organizedByCapabilities: "requests",
    organizedByKind: "cloud", organizedByName: "ohmail Cloud",
  }).returning({ id: mailboxes.id });
  const mailboxId = mb!.id;
  const [msg] = await db.insert(messages).values({
    accountId, mailboxId, bodyHash: randomUUID(), dedupKey: `mid:${randomUUID()}`,
    subject: "s", fromAddress: "person@example.com", unread: true,
  }).returning({ id: messages.id });
  await db.insert(folderState).values({
    messageId: msg!.id, accountId: accountOfMessage(msg!.id), desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  const requestKey = deriveRequestKey({ auth: { user: "shared@x.example", pass: "basic-account-password" }, address: "shared@x.example" })!;
  return { server, reader, organizer, db, accountId, mailboxId, msgId: msg!.id, requestKey };
}

describe("a request past the 500-record window of ohmail/_meta", () => {
  for (const strays of [10, META_RECORDS_MAX_PER_FETCH + 20]) {
    it(`is appended, applied and answered with ${strays} foreign records in the folder`, async () => {
      const w = await world(strays);
      const lines: { event: string; detail: Record<string, unknown> }[] = [];
      const log = (event: string, detail: Record<string, unknown>): void => { lines.push({ event, detail }); };
      const svc = new ScreenerService({});
      await svc.decide({ db: w.db, accountId: w.accountId, userId: null, now: () => t0, requestId: "r" }, w.msgId, { decision: "yes" });

      const sent = await driveOutstandingRequests(
        w.db, { mailboxId: w.mailboxId, accountId: w.accountId, installId: READER_SELF.installId, adapter: { requestReaderIo: () => w.reader } as unknown as MailboxAdapter, requestKey: w.requestKey },
        READER_SELF, at(1), log,
      );
      expect(sent.sent, JSON.stringify(lines.map((l) => l.event))).toBe(1);

      await w.db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, w.mailboxId));
      const drained = await applyMetaRequests(
        w.db, { mailboxId: w.mailboxId, accountId: w.accountId, installId: "organizer-install", adapter: { requestOrganizerIo: () => w.organizer } as unknown as MailboxAdapter, requestKey: w.requestKey },
        at(2), log,
      );
      expect(drained.applied, JSON.stringify(lines.map((l) => l.event))).toBe(1);
      await w.db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, w.mailboxId));

      const answered = await driveOutstandingRequests(
        w.db, { mailboxId: w.mailboxId, accountId: w.accountId, installId: READER_SELF.installId, adapter: { requestReaderIo: () => w.reader } as unknown as MailboxAdapter, requestKey: w.requestKey },
        READER_SELF, at(3), log,
      );
      expect(answered.applied, JSON.stringify(lines.map((l) => l.event))).toBe(1);
      const [row] = await w.db.select().from(organizerRequests).where(eq(organizerRequests.mailboxId, w.mailboxId));
      expect(row?.state).toBe("applied");
    });
  }
});

describe("a request the folder grew past after it was appended", () => {
  it("is applied and its answer read with 520 newer foreign records above it", async () => {
    const w = await world(0);
    const lines: { event: string; detail: Record<string, unknown> }[] = [];
    const log = (event: string, detail: Record<string, unknown>): void => { lines.push({ event, detail }); };
    const svc = new ScreenerService({});
    await svc.decide({ db: w.db, accountId: w.accountId, userId: null, now: () => t0, requestId: "r" }, w.msgId, { decision: "yes" });
    const reader = { requestReaderIo: () => w.reader } as unknown as MailboxAdapter;
    expect((await driveOutstandingRequests(w.db, { mailboxId: w.mailboxId, accountId: w.accountId, installId: READER_SELF.installId, adapter: reader, requestKey: w.requestKey }, READER_SELF, at(1), log)).sent).toBe(1);
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 20; i++) w.server.seed(META, `Subject: stray ${i}\r\nX-Other-Client: 1\r\n\r\nbody`, t0);

    await w.db.update(mailboxes).set({ organizerRole: "organizer" }).where(eq(mailboxes.id, w.mailboxId));
    const drained = await applyMetaRequests(
      w.db, { mailboxId: w.mailboxId, accountId: w.accountId, installId: "organizer-install", adapter: { requestOrganizerIo: () => w.organizer } as unknown as MailboxAdapter, requestKey: w.requestKey },
      at(2), log,
    );
    expect(drained.applied, JSON.stringify(lines.map((l) => l.event))).toBe(1);
    await w.db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, w.mailboxId));
    const answered = await driveOutstandingRequests(w.db, { mailboxId: w.mailboxId, accountId: w.accountId, installId: READER_SELF.installId, adapter: reader, requestKey: w.requestKey }, READER_SELF, at(3), log);
    expect(answered.applied, JSON.stringify(lines.map((l) => l.event))).toBe(1);
  });
});
