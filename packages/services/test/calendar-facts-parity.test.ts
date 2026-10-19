import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  attachments, invitationWithoutEventWhere, itipReplyHeaderWhere, mailboxes, messageBodies, messages,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import { invitationWithoutEvent, itipReplyByHeaders } from "@trafficflow/core/mail";

/**
 * THE PARITY CONTROL for the two calendar facts. `invitationWithoutEvent` / `itipReplyByHeaders`
 * (core's `mime.ts`) and `invitationWithoutEventWhere` / `itipReplyHeaderWhere` (db's
 * `calendar-facts.ts`) are one definition written twice, because two runtimes ask it: ingest holds
 * the parsed message in Node, the DTO batch asks it in SQL inside a `WHERE`. Neither copy is the
 * definition — THE PAIR IS, and this file is what makes that a fact.
 *
 * Every shape is asserted BOTH WAYS and then for equality, so neither an arm deleted on one side
 * nor the same mistake made on both can pass. Runs on both stores; see the sqlite project.
 */

const OWN = "me@example.test";

interface Shape {
  what: string;
  headers: Record<string, unknown>;
  /** The stored `content_type` of each part, exactly as `toAttachmentMeta` would write it. */
  parts: string[];
  invitation: boolean;
  itipReply: boolean;
}

const SHAPES: readonly Shape[] = [
  // ── the incident's own shape ────────────────────────────────────────────────────────────────
  {
    what: "OWA invitation: calendar content-class, single-part text/html, NO part",
    headers: { "content-class": ["urn:content-classes:calendarmessage"], "content-type": ['text/html; charset="utf-8"'] },
    parts: [], invitation: true, itipReply: false,
  },
  {
    what: "the same, Content-class padded and mixed case",
    headers: { "content-class": ["  URN:Content-Classes:CalendarMessage "] },
    parts: [], invitation: true, itipReply: false,
  },
  {
    what: "OWA stub over IMAP (2026-10-19): Content-class, an Exchange calendar header, text/plain, NO part",
    headers: {
      "content-class": ["urn:content-classes:calendarmessage"],
      "x-ms-exchange-calendar-originator-id": ["00000000-0000-0000-0000-000000000000"],
      "content-type": ['text/plain; charset="us-ascii"'],
    },
    parts: [], invitation: true, itipReply: false,
  },
  {
    // No header arm for X-MS-Exchange-Calendar-*: it rides replies too. The body text's stub decides
    // this shape on the reader (`owaInvitationStub`).
    what: "the same stub WITHOUT Content-class says nothing from headers",
    headers: {
      "x-ms-exchange-calendar-originator-id": ["00000000-0000-0000-0000-000000000000"],
      "content-type": ['text/plain; charset="us-ascii"'],
    },
    parts: [], invitation: false, itipReply: false,
  },
  // ── the positive control on the other arm: a real event, so no line ─────────────────────────
  {
    what: "a real invitation WITH its text/calendar part says nothing",
    headers: { "content-class": ["urn:content-classes:calendarmessage"], "content-type": ['multipart/alternative; boundary="ALT"'] },
    parts: ["text/calendar"], invitation: false, itipReply: false,
  },
  {
    what: "application/ics counts as the event too",
    headers: { "content-class": ["urn:content-classes:calendarmessage"] },
    parts: ["application/ics"], invitation: false, itipReply: false,
  },
  {
    what: "a NON-calendar part does not stand in for the event",
    headers: { "content-class": ["urn:content-classes:calendarmessage"] },
    parts: ["application/pdf"], invitation: true, itipReply: false,
  },
  // ── the top-level method= arm ───────────────────────────────────────────────────────────────
  {
    what: "top-level method=REQUEST with the part stripped in transit",
    headers: { "content-type": ['multipart/mixed; method=REQUEST; boundary="B"'] },
    parts: [], invitation: true, itipReply: false,
  },
  {
    what: "single-part text/calendar; method=REQUEST — the part IS the message, so no line",
    headers: { "content-type": ['text/calendar; charset="utf-8"; method=REQUEST'] },
    parts: ["text/calendar"], invitation: false, itipReply: false,
  },
  {
    what: "top-level method=REPLY — an iTIP acknowledgement by its own header",
    headers: { "content-type": ['text/calendar; charset="utf-8"; method=REPLY'] },
    parts: ["text/calendar"], invitation: false, itipReply: true,
  },
  {
    what: "method=reply lowercased",
    headers: { "content-type": ["text/calendar;method=reply"] },
    parts: ["text/calendar"], invitation: false, itipReply: true,
  },
  // ── the over-match the anchoring exists to shut ─────────────────────────────────────────────
  {
    what: "a parameter merely ENDING in method is not the method parameter",
    headers: { "content-type": ["text/html; x-method=REPLY"] },
    parts: [], invitation: false, itipReply: false,
  },
  // ── ordinary mail says nothing ──────────────────────────────────────────────────────────────
  { what: "no headers at all", headers: {}, parts: [], invitation: false, itipReply: false },
  {
    what: "an ordinary html message with no calendar claim",
    headers: { "content-type": ['text/html; charset="utf-8"'], subject: ["hi"] },
    parts: [], invitation: false, itipReply: false,
  },
  {
    what: "a different content-class is not the calendar one",
    headers: { "content-class": ["urn:content-classes:message"] },
    parts: [], invitation: false, itipReply: false,
  },
  // ── the shapes that trip a naive port ───────────────────────────────────────────────────────
  {
    what: "content-class as a STRING, not an array — no members to test",
    headers: { "content-class": "urn:content-classes:calendarmessage" },
    parts: [], invitation: false, itipReply: false,
  },
  {
    what: "content-class [] — present but empty",
    headers: { "content-class": [] }, parts: [], invitation: false, itipReply: false,
  },
  {
    what: "a NON-STRING member is filtered out on both sides",
    headers: { "content-class": [5], "content-type": [7] },
    parts: [], invitation: false, itipReply: false,
  },
  {
    what: "two content-type lines, the second carrying the method",
    headers: { "content-type": ["text/html", "text/calendar; method=REPLY"] },
    parts: ["text/calendar"], invitation: false, itipReply: true,
  },
  {
    what: "a stored content type carrying parameters still reads as the calendar base type",
    headers: { "content-class": ["urn:content-classes:calendarmessage"] },
    parts: ['text/calendar; charset="utf-8"'], invitation: false, itipReply: false,
  },
  // ── the method a multipart acknowledgement keeps on its calendar PART ───────────────────────
  {
    what: "a multipart reply whose method is on the part's stored type",
    headers: { "content-type": ['multipart/mixed; boundary="B"'] },
    parts: ["text/plain", "text/calendar; method=REPLY"], invitation: false, itipReply: true,
  },
  {
    what: "application/ics carrying method=REPLY",
    headers: {}, parts: ["application/ics; method=REPLY"], invitation: false, itipReply: true,
  },
  {
    what: "a REQUEST on the part is an invitation, not an acknowledgement",
    headers: {}, parts: ["text/calendar; method=REQUEST"], invitation: false, itipReply: false,
  },
  {
    what: "a non-calendar part naming a method is not the calendar part",
    headers: {}, parts: ["text/plain; method=REPLY"], invitation: false, itipReply: false,
  },
  {
    what: "a part parameter merely ENDING in method is not the method parameter",
    headers: {}, parts: ["text/calendar; x-method=REPLY"], invitation: false, itipReply: false,
  },
];

async function seed() {
  const db = await makeTestDb();
  const accountId = crypto.randomUUID();
  const mailboxId = crypto.randomUUID();
  const at = new Date("2026-09-16T08:30:10.062Z");
  await db.insert(mailboxes).values({
    id: mailboxId, accountId, provider: "imap", address: OWN, status: "connected", createdAt: at,
  });
  return { db, accountId, mailboxId };
}

type TestDb = Awaited<ReturnType<typeof makeTestDb>>;

/** Both fragments' answers for one message, read positionally so both drivers agree. */
async function sqlVerdicts(db: TestDb, id: string): Promise<{ invitation: boolean; itipReply: boolean }> {
  const d = dialect(db);
  const rows = await d.exec(db, sql`
    select ${invitationWithoutEventWhere(d, { id: sql`m.id`, accountId: sql`m.account_id` })} as invitation,
           ${itipReplyHeaderWhere(d, { id: sql`m.id`, accountId: sql`m.account_id` })} as itip_reply
      from ${messages} m where m.id = ${d.castUuid(sql`${id}`)}`);
  expect(rows.length).toBe(1);
  // One store answers booleans and the other 0/1 integers — a driver difference, not a dialect
  // one, so the answers are normalised here.
  const yes = (v: unknown) => v === true || v === 1;
  return { invitation: yes(rows[0]![0]), itipReply: yes(rows[0]![1]) };
}

async function insertShape(
  db: TestDb, accountId: string, mailboxId: string, shape: Shape,
): Promise<string> {
  const id = crypto.randomUUID();
  // Every `defaultNow()` column is given a value: this file runs on BOTH stores, and the device
  // store has no `now()` — a default left to the server is `no such function: now` there.
  const at = new Date("2026-09-16T08:30:10.062Z");
  await db.insert(messages).values({
    id, accountId, mailboxId, bodyHash: "h", dedupKey: id, subject: "",
    fromAddress: OWN, date: at, createdAt: at, updatedAt: at,
  });
  await db.insert(messageBodies).values({ messageId: id, text: "", headers: shape.headers });
  for (const contentType of shape.parts) {
    await db.insert(attachments).values({
      accountId, messageId: id, contentType, sizeBytes: 1, createdAt: at,
    });
  }
  return id;
}

/** The TS half takes the parsed shape the parser hands it. */
function tsVerdicts(shape: Shape): { invitation: boolean; itipReply: boolean } {
  const facts = {
    headers: shape.headers as Record<string, string[]>,
    attachments: shape.parts.map((contentType) => ({ contentType })),
  };
  return { invitation: invitationWithoutEvent(facts), itipReply: itipReplyByHeaders(facts) };
}

describe("the calendar facts: the TS predicates and the SQL fragments agree", () => {
  it(`agrees on all ${SHAPES.length} shapes, and each verdict is asserted outright`, async () => {
    const { db, accountId, mailboxId } = await seed();
    const wrong: string[] = [];
    const disagreed: string[] = [];
    for (const shape of SHAPES) {
      const ts = tsVerdicts(shape);
      const id = await insertShape(db, accountId, mailboxId, shape);
      const pg = await sqlVerdicts(db, id);
      // The verdicts themselves, so deleting an arm on BOTH sides cannot pass.
      if (ts.invitation !== shape.invitation) wrong.push(`TS invitation ${shape.what}: expected ${shape.invitation}, got ${ts.invitation}`);
      if (pg.invitation !== shape.invitation) wrong.push(`SQL invitation ${shape.what}: expected ${shape.invitation}, got ${pg.invitation}`);
      if (ts.itipReply !== shape.itipReply) wrong.push(`TS itipReply ${shape.what}: expected ${shape.itipReply}, got ${ts.itipReply}`);
      if (pg.itipReply !== shape.itipReply) wrong.push(`SQL itipReply ${shape.what}: expected ${shape.itipReply}, got ${pg.itipReply}`);
      // And the parity, so an arm deleted on ONE side cannot pass either.
      if (ts.invitation !== pg.invitation) disagreed.push(`${shape.what}: invitation TS ${ts.invitation} vs SQL ${pg.invitation}`);
      if (ts.itipReply !== pg.itipReply) disagreed.push(`${shape.what}: itipReply TS ${ts.itipReply} vs SQL ${pg.itipReply}`);
    }
    expect(wrong).toEqual([]);
    expect(disagreed).toEqual([]);
  });
});
