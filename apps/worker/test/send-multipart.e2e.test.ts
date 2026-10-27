import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { normalizeMime } from "@trafficflow/core";
import { messages } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import {
  DraftingService, DraftsService, SendService, type ServiceContext,
} from "@trafficflow/services";
import type { DraftPort, OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { makeHarness, rawClient, dbUrlFor } from "./_workerenv.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * WHAT A RECIPIENT ACTUALLY RECEIVES WHEN THE REPLY WAS GENERATED.
 *
 * The unit tests prove the two halves of a stored draft agree and that the send path puts both on
 * the `OutboundMessage`. Neither of them proves the thing that matters, which is the MIME a
 * mail client opens: `html` on an object is not a `multipart/alternative` on the wire, and the
 * defect this closes was invisible for exactly that reason — every layer looked right except the
 * one nobody parsed.
 *
 * So this goes the whole way. A drafter answers, the request path stores what it wrote, the
 * gated send delivers it over real SMTP, and the message is read back out of the recipient's
 * INBOX and PARSED — not string-matched — to assert that it is `multipart/alternative` with both
 * parts, that the plain part is the words the drafter wrote, and that the markup part carries
 * them as paragraphs.
 *
 * The recipient is a fresh per-run address on the test server. Nothing leaves the container.
 */

const drafting = new DraftingService();
const draftsSvc = new DraftsService();
const sendSvc = new SendService();

const MODEL_BODY = "Hi Alice\n\nMonday works. I will send the file first thing.\n\nBest,\nBob";

function mockDrafter(body: string): DraftPort {
  return { async draft() { return { subject: "Re: Monday", body, rationale: "grounded" }; } };
}

describe("a generated reply leaves as multipart/alternative (GreenMail SMTP+IMAP + Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("both parts arrive, the plain one is the drafter's words and the html one is its paragraphs", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const ctx: ServiceContext = {
      db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "r",
    };

    // The message being replied to.
    const [incoming] = await h.db.insert(messages).values({
      accountId: h.accountId,
      mailboxId: h.mailboxId,
      bodyHash: "h",
      dedupKey: `seed:${randomUUID()}`,
      subject: "Can you confirm Monday?",
      fromAddress: "alice@trafficflow.test",
      snippet: "checking on Monday",
      date: new Date(),
    }).returning();

    // The request path: drafter → promotion → stored draft.
    const { draftId } = await drafting.draftFromMessage(ctx, incoming!.id, {
      drafter: mockDrafter(MODEL_BODY),
    });
    const recipient = `r-${randomUUID()}@trafficflow.test`;
    await draftsSvc.update(ctx, draftId, { to: [{ name: null, address: recipient }] });

    const stored = await draftsSvc.get(ctx, draftId);
    expect(stored.html).not.toBeNull();

    // The gated send, over real SMTP. Untouched by any editor in between — this is the draft
    // exactly as it was generated, which is the case the defect was reported against.
    const factory: OpenSendAdapter = async () => ({
      send: (m: OutboundMessage) => h.adapter.send(m),
      messageInSent: (id: string) => h.adapter.messageInSent(id),
      async close() { /* the harness owns the connection */ },
    });
    const res = await sendSvc.send(ctx, draftId, `multipart-${randomUUID()}`, { openSendAdapter: factory });
    expect(res.status).toBe("sent");

    // Read it back from the RECIPIENT's inbox and parse the MIME.
    const inbox = await rawClient({ ...h.cfg, auth: { user: recipient, pass: "test" } });
    closers.push(() => inbox.logout());
    const lock = await inbox.getMailboxLock("INBOX");
    let source: Buffer;
    try {
      const found = await inbox.search({ header: { "message-id": res.providerMessageId! } }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      expect(uids).toHaveLength(1);
      const one = await inbox.fetchOne(String(uids[0]), { source: true }, { uid: true });
      source = (one as { source: Buffer }).source;
    } finally {
      lock.release();
    }

    // THE ASSERTION THE WHOLE SLICE IS FOR.
    expect(source.toString("utf8")).toMatch(/Content-Type:\s*multipart\/alternative/i);

    // PARSED, not grepped — and parsed by the same normalizer our own ingest uses, so what is
    // asserted here is literally what a reader of this message gets. A `text/html` substring
    // found in the raw bytes would also match a boundary declaration or an encoding artefact.
    const parsed = await normalizeMime(source);
    expect(parsed.textBody.trim()).toBe(MODEL_BODY);
    expect(parsed.htmlBody).toBeTruthy();
    expect(parsed.htmlBody!).toContain("<p>Hi Alice</p>");
    expect(parsed.htmlBody!).toContain("<br />");
    // And the markup half is byte-identical to what was stored — the send-time sanitizer pass is
    // a no-op on promoted markup rather than a second, differently-rendered copy.
    expect(parsed.htmlBody!).toBe(stored.html);
  }, 60000);
});
