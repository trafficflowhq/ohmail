import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { attachments, invitationWithoutEventWhere, itipReplyHeaderWhere, mailboxes, messageBodies, messages } from "@trafficflow/db";
import { brandDialect, dialect } from "@trafficflow/db/dialect";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";

/**
 * THE CALENDAR FACTS ON REAL POSTGRES. `calendar-facts-parity.test.ts` runs the SQL on PGlite and
 * on the device store; this is the third reader, the one production runs, for the arm that reads a
 * calendar part's stored `method=` (ITIP-METHOD-HAS-NO-STORED-HOME) beside the invitation arm as
 * the dialect control.
 */

const PG_UP = await realPgAvailable();
const client = postgres(PG_TEST_URL, { max: 2, onnotice: () => {} });
const db = brandDialect(drizzle(client, { schema }), "pg");
const AT = new Date("2026-09-16T08:30:10.062Z");

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 120_000);
afterAll(async () => { await client.end({ timeout: 5 }); });

const SHAPES: { what: string; headers: Record<string, unknown>; parts: string[]; invitation: boolean; itipReply: boolean }[] = [
  { what: "a multipart reply whose method is on the part", headers: { "content-type": ['multipart/mixed; boundary="B"'] }, parts: ["text/plain", "text/calendar; method=REPLY"], invitation: false, itipReply: true },
  { what: "application/ics; method=REPLY", headers: {}, parts: ["application/ics; method=REPLY"], invitation: false, itipReply: true },
  { what: "a REQUEST on the part", headers: {}, parts: ["text/calendar; method=REQUEST"], invitation: false, itipReply: false },
  { what: "a non-calendar part naming a method", headers: {}, parts: ["text/plain; method=REPLY"], invitation: false, itipReply: false },
  { what: "x-method on the part", headers: {}, parts: ["text/calendar; x-method=REPLY"], invitation: false, itipReply: false },
  { what: "top-level method=REPLY", headers: { "content-type": ["text/calendar; method=REPLY"] }, parts: ["text/calendar"], invitation: false, itipReply: true },
  { what: "CONTROL: an OWA invitation with no part", headers: { "content-class": ["urn:content-classes:calendarmessage"] }, parts: [], invitation: true, itipReply: false },
];

describe.skipIf(!PG_UP)("the calendar facts, on the store production runs", () => {
  it(`answers all ${SHAPES.length} shapes`, async () => {
    const accountId = randomUUID();
    const mailboxId = randomUUID();
    await db.insert(mailboxes).values({ id: mailboxId, accountId, provider: "imap", address: `cal-${accountId.slice(0, 8)}@x.test`, status: "connected" });
    const got: string[] = [];
    const want: string[] = [];
    for (const shape of SHAPES) {
      const id = randomUUID();
      await db.insert(messages).values({ id, accountId, mailboxId, bodyHash: "h", dedupKey: id, subject: "", fromAddress: "me@x.test", date: AT });
      await db.insert(messageBodies).values({ messageId: id, accountId, text: "", headers: shape.headers });
      for (const contentType of shape.parts) await db.insert(attachments).values({ accountId, messageId: id, contentType, sizeBytes: 1 });
      const d = dialect(db);
      const rows = await d.exec(db, sql`
        select ${invitationWithoutEventWhere(d, { id: sql`m.id`, accountId: sql`m.account_id` })} as invitation,
               ${itipReplyHeaderWhere(d, { id: sql`m.id`, accountId: sql`m.account_id` })} as itip_reply
          from ${messages} m where m.id = ${d.castUuid(sql`${id}`)}`);
      got.push(`${shape.what}: ${rows[0]![0] === true} ${rows[0]![1] === true}`);
      want.push(`${shape.what}: ${shape.invitation} ${shape.itipReply}`);
    }
    expect(got).toEqual(want);
  });
});
