import type { DraftDTO, SnapshotResponse } from "@ohmail/wire";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { and, eq } from "drizzle-orm";
import { drafts, mailboxes } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { syncService } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";

/**
 * THE BOOTSTRAP CARRIES A SENT DRAFT'S ROW AND NONE OF ITS TEXT (real Postgres).
 *
 * `GET /sync/snapshot` handed every draft its `body` and `html`. Most are `sent`, and the `draft`
 * entity is outside both eviction policies, so nothing takes one back: for a busy sender's replies,
 * gigabytes downloaded and retained on an ordinary reload. The ROWS stay — read offline — and the
 * TEXT goes, both encodings, with `GET /drafts/:id` the way back. A PG TWIN because the arm is a
 * projection over a real `status` column read through the real keyset walk, with bytes asserted
 * against `octet_length`: a server that "omitted" by shortening would pass a fixture and fail this.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof brandDialect<ReturnType<typeof drizzle<typeof schema>>>>;

const NOW = new Date("2026-09-14T12:00:00.000Z");
/** The reply text. Distinctive, so it can be asked for across the WHOLE serialized page. */
const REPLY = "sent-reply-text ".repeat(64);
const LIVE_TEXT = "still being written ".repeat(64);

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"], accountId, userId: null,
  now: () => NOW, requestId: "sent-draft-text",
});

const draftsOf = (r: SnapshotResponse): DraftDTO[] =>
  r.changes.filter((c) => c.type === "draft").map((c) => c.entity as DraftDTO);

describe.skipIf(!PG_UP)("a sent draft's text never rides the bootstrap (real Postgres)", () => {
  let accountId: string;
  let mailboxId: string;
  let sentIds: string[];
  let liveIds: string[];

  beforeAll(async () => {
    client = postgres(PG_TEST_URL, { max: 4 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    await runMigrations(PG_TEST_URL);

    accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `sent-${accountId}@tf.example`,
    }).returning();
    mailboxId = mb!.id;

    // Forty sent replies and one of each LIVE status beside them, all carrying both encodings.
    const sent = await db.insert(drafts).values(
      Array.from({ length: 40 }, (_, i) => ({
        accountId, mailboxId, subject: `sent ${i}`, body: REPLY, html: `<p>${REPLY}</p>`,
        status: "sent" as const, updatedAt: new Date(NOW.getTime() - i * 60_000),
      })),
    ).returning({ id: drafts.id });
    sentIds = sent.map((r) => r.id);

    const live = await db.insert(drafts).values(
      (["draft", "scheduled", "sending", "unverified"] as const).map((status, i) => ({
        accountId, mailboxId, subject: `live ${status}`, body: LIVE_TEXT,
        html: `<p>${LIVE_TEXT}</p>`, status,
        updatedAt: new Date(NOW.getTime() + (i + 1) * 60_000),
      })),
    ).returning({ id: drafts.id });
    liveIds = live.map((r) => r.id);
  }, 300_000);

  afterAll(async () => {
    if (!client) return;
    await db.delete(drafts).where(eq(drafts.accountId, accountId));
    await db.delete(mailboxes).where(eq(mailboxes.accountId, accountId));
    await client.end({ timeout: 5 });
  }, 120_000);

  /**
   * THE PREMISE, MEASURED RATHER THAN ASSUMED: the rows really do hold the text. Without this the
   * assertions below pass for a fixture that stored nothing.
   */
  it("the stored rows carry the text this page must not", async () => {
    const rows = await db.select().from(drafts).where(eq(drafts.accountId, accountId));
    expect(rows).toHaveLength(44);
    for (const r of rows) {
      expect(r.body, `${r.id}: the fixture stores a body`).not.toBeNull();
      expect(r.html, `${r.id}: and its rich twin`).not.toBeNull();
    }
  });

  /**
   * WATCHED RED by removing the `status === "sent"` arm from `draftRowToSnapshotDTO`: forty rows
   * carrying their body bytes and html bytes, against the zero below.
   */
  it("emits every sent ROW with body and html null, and the reason", async () => {
    const page = await syncService.getSnapshot(ctx(accountId), { limit: 500 });
    const emitted = draftsOf(page);
    expect(emitted).toHaveLength(44);

    const sent = emitted.filter((d) => sentIds.includes(d.id));
    expect(sent, "every sent row still arrives").toHaveLength(40);
    let bytes = 0;
    for (const d of sent) {
      expect(d.body).toBeNull();
      expect(d.html).toBeNull();
      expect(d.bodyOmitted).toBe("sent");
      expect(d.status).toBe("sent");
      bytes += (d.body ?? "").length + (d.html ?? "").length;
    }
    expect(bytes, "the retained text of forty replies").toBe(0);
  });

  /**
   * THE POSITIVE CONTROL, ON THE SERVER SIDE: the four live statuses keep both encodings, so the
   * omission above cannot pass by omitting everything. This is the arm that would cost mail.
   */
  it("keeps the text of every status that is not sent", async () => {
    const page = await syncService.getSnapshot(ctx(accountId), { limit: 500 });
    const live = draftsOf(page).filter((d) => liveIds.includes(d.id));
    expect(live).toHaveLength(4);
    for (const d of live) {
      expect(d.body, `${d.status}: the person's own text`).toBe(LIVE_TEXT);
      expect(d.html, `${d.status}: and its rich twin`).toBe(`<p>${LIVE_TEXT}</p>`);
      expect(d.bodyOmitted).toBeUndefined();
    }
  });

  /** NOT A TRUNCATION: none of the words are anywhere on the page, under any key. */
  it("leaves no fragment of a sent reply anywhere on the page", async () => {
    const page = await syncService.getSnapshot(ctx(accountId), { limit: 500 });
    expect(JSON.stringify(page)).not.toContain("sent-reply-text");
    // …and the live rows prove the needle would have been found if it were there.
    expect(JSON.stringify(page)).toContain("still being written");
  });

  /** THE REPAIR PATH IS UNTOUCHED: the single-row read still answers a sent draft in full. */
  it("the single-row read still holds the text", async () => {
    const [row] = await db.select().from(drafts)
      .where(and(eq(drafts.accountId, accountId), eq(drafts.id, sentIds[0]!)));
    expect(row!.body).toBe(REPLY);
    expect(row!.html).toBe(`<p>${REPLY}</p>`);
  });

  /** The rest of the row is intact, which is what keeps the sent list and the address book. */
  it("keeps the subject, the recipients and the stamps of a sent row", async () => {
    const page = await syncService.getSnapshot(ctx(accountId), { limit: 500 });
    const one = draftsOf(page).find((d) => d.id === sentIds[0])!;
    expect(one.subject).toBe("sent 0");
    expect(one.mailboxId).toBe(mailboxId);
    expect(one.updatedAt).toBe(NOW.toISOString());
  });
});
