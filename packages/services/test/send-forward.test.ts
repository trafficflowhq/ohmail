import { describe, expect, it } from "vitest";
import { accountStorage, attachments, drafts, messages, messageBodies, outboundSends, threads } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { FORWARD_MAX_RAW_BYTES, forwardedDate, sendService } from "@trafficflow/services/mail";
import type { ServiceContext, AttachmentAdapter, OpenAdapter } from "@trafficflow/services/mail";
import { normalizeMime, prepareHtmlForStorage, STORED_HTML_CAP_BYTES } from "@trafficflow/core/mail";
import type { SendAdapter, OutboundMessage, SendOptions } from "@trafficflow/core/mail";
import { MessageGoneError, RawMessageTooLargeError } from "@trafficflow/core/adapters/imap";
import { FIXED_NOW, makeDeps, seedMailbox, seedMessage, seedSession, seedBody } from "../../api/test/helpers.js";

/**
 * FORWARDING, BUILT ON THE SERVER (slice 1b).
 *
 * A forward carries only `forwardOf` from the client; the server reads the original, refuses a
 * `no_forward` one, quotes it into the body, and STREAMS its attachments from IMAP at send —
 * persisting nothing. Driven at the service seam (not the route) because the forwarded-attachment
 * fetch adapter is injected there, and both adapters here are spies: no socket opens.
 *
 * The three assertions that matter, each mutation-watched below:
 *  · a `no_forward` original is REFUSED (the sensitive-leak gate);
 *  · the quoted original and its streamed attachments reach the ONE outgoing message;
 *  · the send reuses the up-front minted Message-ID (the crash-safe idempotency is unchanged).
 */

interface SendSpy {
  delivered: OutboundMessage[];
  openSendAdapter: () => Promise<SendAdapter>;
}
function sendSpy(): SendSpy {
  const spy: SendSpy = {
    delivered: [],
    openSendAdapter: async () => ({
      async send(msg: OutboundMessage) {
        spy.delivered.push(msg);
        return { providerMessageId: msg.messageId ?? "<none>" };
      },
      async messageInSent() { return false; },
      async close() { /* nothing */ },
    }),
  };
  return spy;
}

/** A fetch adapter that returns fixed bytes for any part, recording the parts it was asked for. */
function fetchSpy(parts: Record<string, Uint8Array>): { openFetchAdapter: OpenAdapter; asked: string[] } {
  const asked: string[] = [];
  const openFetchAdapter: OpenAdapter = async (): Promise<AttachmentAdapter> => ({
    async fetchPart(_loc, partId) {
      const key = partId ?? "1";
      asked.push(key);
      return { contentType: "application/octet-stream", filename: `part-${key}.bin`, body: parts[key] ?? new Uint8Array() };
    },
    async close() { /* nothing */ },
  });
  return { openFetchAdapter, asked };
}

async function world(opts: {
  noForward?: boolean;
  withAttachment?: boolean;
  /** The author's own note above the quote. `""` is the note-less forward — see the block below. */
  note?: string;
  /** The forward draft's rich half, when the case under test is a RICH note-less forward. */
  noteHtml?: string;
  /** The ORIGINAL's stored html, so the quote's html arm can be exercised. */
  origHtml?: string;
} = {}) {
  const { db } = await makeDeps(FIXED_NOW);
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: "me@atelier.example" });

  // THE ORIGINAL being forwarded, with a body and (optionally) one attachment part.
  const orig = await seedMessage(db, {
    accountId: s.accountId, mailboxId, subject: "Q3 plan",
    fromAddress: "lena@atelier.example", date: FIXED_NOW,
    nativeLocator: { folder: "INBOX", ref: "42:7" },
  });
  await seedBody(db, {
    messageId: orig.id,
    text: "Here is the plan.\nRegards, Lena",
    html: opts.origHtml ?? null,
  });
  if (opts.noForward) await db.update(messages).set({ noForward: true });
  if (opts.withAttachment) {
    await db.insert(attachments).values({
      accountId: s.accountId, messageId: orig.id, filename: "plan.pdf",
      contentType: "application/pdf", sizeBytes: 12, partId: "2", inline: false,
    });
  }

  // THE FORWARD COMPOSE — a draft the user addressed, with their own note (or none).
  const [draft] = await db.insert(drafts).values({
    accountId: s.accountId, mailboxId, subject: "Fwd: Q3 plan",
    body: opts.note ?? "Passing this along.",
    ...(opts.noteHtml === undefined ? {} : { html: opts.noteHtml }),
    to: [{ name: null, address: "sam@example.test" }],
    cc: [], bcc: [], status: "draft", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
  }).returning();

  const ctx: ServiceContext = {
    db, accountId: s.accountId, userId: s.userId, now: () => FIXED_NOW, requestId: "test-forward",
  };
  return { db, ctx, draftId: draft!.id, originalId: orig.id };
}

describe("forward is assembled server-side", () => {
  it("REFUSES a no_forward original — the sensitive body never leaves through a quote", async () => {
    const w = await world({ noForward: true });
    const send = sendSpy();
    const fetch = fetchSpy({});

    const err = await sendService
      .send(w.ctx, w.draftId, "fwd-key-1", { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter }, { forwardOf: w.originalId })
      .catch((e: unknown) => e as { httpStatus?: number; message?: string });

    expect((err as { httpStatus?: number }).httpStatus).toBe(403);
    expect((err as { message?: string }).message).toMatch(/can't be forwarded/i);
    // Nothing was sent, and the draft never left `draft`.
    expect(send.delivered).toHaveLength(0);
    const [row] = await w.db.select().from(drafts);
    expect(row!.status).toBe("draft");
    // No reservation survives a refused forward.
    expect(await w.db.select().from(outboundSends)).toHaveLength(0);
  });

  it("SENDS a no_forward original the person confirmed — `forwardConfirmed` after the client's ask", async () => {
    // Forward is always offered (owner, 2026-09-25): the client asks once, naming why the message
    // was flagged, and a confirmed forward proceeds like any other. Unconfirmed stays refused (above).
    const w = await world({ noForward: true });
    const send = sendSpy();
    const fetch = fetchSpy({});
    const res = await sendService.send(
      w.ctx, w.draftId, "fwd-key-confirmed",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId, forwardConfirmed: true },
    );
    expect(res.status).toBe("sent");
    expect(send.delivered).toHaveLength(1);
    expect(send.delivered[0]!.text).toContain("Here is the plan.");
  });

  it("quotes the original and STREAMS its attachment onto the one outgoing message", async () => {
    const w = await world({ withAttachment: true });
    const send = sendSpy();
    const fetch = fetchSpy({ "2": new Uint8Array([0x25, 0x50, 0x44, 0x46]) }); // "%PDF"

    const res = await sendService.send(
      w.ctx, w.draftId, "fwd-key-2",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );
    expect(res.status).toBe("sent");

    expect(send.delivered).toHaveLength(1);
    const msg = send.delivered[0]!;
    // The user's note, then the quoted original.
    expect(msg.text).toContain("Passing this along.");
    expect(msg.text).toContain("Forwarded message");
    expect(msg.text).toContain("From: lena@atelier.example");
    expect(msg.text).toContain("Here is the plan.");
    // The original's attachment was fetched by its part id and rode the message — bytes intact.
    expect(fetch.asked).toEqual(["2"]);
    expect(msg.attachments).toHaveLength(1);
    expect(Buffer.from(msg.attachments![0]!.content)).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));

    // ZERO AT REST — the streamed bytes are in no table.
    expect(JSON.stringify(await w.db.select().from(drafts)))
      .not.toContain(Buffer.from([0x25, 0x50, 0x44, 0x46]).toString("base64"));
  });

  /**
   * ══ THE PARTS STREAM IN ID ORDER — the capped subset is deterministic ═════════════════════
   *
   * The forward's parts query is `limit(FORWARD_MAX_PARTS)`, and a capped SELECT with no
   * ORDER BY is free to pick any rows. Two things depend on it being the FIRST rows by id:
   * `AttachmentsService.listForMessage` orders by id, and the client's optimistic sent copy
   * projects a forward's inherited parts as the first `FORWARD_MAX_PARTS` of that list — an
   * unordered subset would make the projection name a file the recipient never got while
   * omitting one they did, for any original over the cap.
   *
   * Pinned on the ORDER (observable at any count) rather than on a 101-part seeding: the same
   * missing ORDER BY produces both defects, and insertion order is the wrong order by
   * construction here — the rows are seeded with ids DESCENDING against insertion.
   *
   * Mutation: drop the `orderBy(asc(attachments.id))` from the reservation's parts query. Real
   * failure text (PGlite returns insertion order without one):
   *   AssertionError: the forwarded parts did not stream in id order — a capped subset would be
   *   arbitrary: expected [ '9', '5', '2' ] to deeply equal [ '2', '5', '9' ]
   */
  it("streams the parts in attachment-id order, whatever order they were ingested in", async () => {
    const w = await world();
    // Three parts whose id order is the REVERSE of insertion order.
    const ids = [
      "cccccccc-0000-4000-8000-000000000003",
      "bbbbbbbb-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000001",
    ];
    const partIds = ["9", "5", "2"]; // partId names the MIME position; paired with descending ids
    for (let i = 0; i < ids.length; i += 1) {
      await w.db.insert(attachments).values({
        id: ids[i]!, accountId: w.ctx.accountId, messageId: w.originalId,
        filename: `f-${partIds[i]}.bin`, contentType: "application/octet-stream",
        sizeBytes: 3, partId: partIds[i]!, inline: false,
      });
    }
    const send = sendSpy();
    const fetch = fetchSpy({ "2": new Uint8Array([2]), "5": new Uint8Array([5]), "9": new Uint8Array([9]) });

    const res = await sendService.send(
      w.ctx, w.draftId, "fwd-key-order",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );
    expect(res.status).toBe("sent");

    // Ascending id is ["aaaa…", "bbbb…", "cccc…"] whose partIds are ["2", "5", "9"].
    expect(
      fetch.asked,
      "the forwarded parts did not stream in id order — a capped subset would be arbitrary",
    ).toEqual(["2", "5", "9"]);
  });

  it("reuses the up-front minted Message-ID — a forward is still the crash-safe send", async () => {
    const w = await world();
    const send = sendSpy();
    const fetch = fetchSpy({});

    const res = await sendService.send(
      w.ctx, w.draftId, "fwd-key-3",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );
    expect(res.status).toBe("sent");
    // The delivered id, the reservation's minted id and the finalized providerMessageId are ONE id.
    const [sendRow] = await w.db.select().from(outboundSends);
    expect(send.delivered[0]!.messageId).toBe(sendRow!.mintedMessageId);
    expect(res.providerMessageId).toBe(sendRow!.mintedMessageId);
    expect(sendRow!.status).toBe("sent");
    expect(send.delivered[0]!.messageId).toMatch(/^<.+@.+>$/);
  });
});

/* ══ A NOTE-LESS FORWARD — what the recipient actually reads ════════════════════════════════
 *
 * Reported from real use: *"forwarding a mail enforces a message, a fwd mail must also be able
 * to be sent without a message."* The client's Send lock was one half of that; this is the other,
 * and it is the half that decides what lands in somebody's inbox.
 *
 * `forwardedQuote` prefixes its block with a SEPARATOR — `\n\n` in text, `<br><br><hr>` in html
 * — because it is written to sit under the author's own words. With no author's words there is
 * nothing to separate FROM, so the separator became the first thing in the mail: two blank lines
 * above the forwarded-message banner in text/plain, and a rule floating over nothing in html.
 *
 * So the separator belongs to the JOIN and not to the quote. These assertions are about the FIRST
 * bytes of the message, which is the only place the defect was visible.
 */
describe("a forward sent with no note of its own", () => {
  it("opens ON the forwarded-message banner — no blank lines, no empty first line", async () => {
    const w = await world({ note: "" });
    const send = sendSpy();
    const fetch = fetchSpy({});

    const res = await sendService.send(
      w.ctx, w.draftId, "fwd-key-empty",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );
    expect(res.status).toBe("sent");
    const msg = send.delivered[0]!;

    // THE CLAIM, stated on the bytes: the text part starts with the banner itself.
    expect(msg.text, "a note-less forward opens with blank lines above the banner")
      .toBe("---------- Forwarded message ----------\n" +
        `From: lena@atelier.example\nDate: ${forwardedDate(FIXED_NOW)}\nSubject: Q3 plan\n\n` +
        "Here is the plan.\nRegards, Lena");
    // …and no html part at all: a plain note-less forward is text/plain, single-part.
    expect(msg.html, "an html part appeared for a plain forward with no note").toBeUndefined();
  });

  it("an EMPTY rich document is no html part at all — the editor's own shape for nothing", async () => {
    // `html: ""` is what `RichEditor` emits for an empty document (`editor.isEmpty ? "" :
    // getHTML()`), and `d.html ? … : null` makes that a PLAIN draft. So the inline dock's
    // note-less forward is single-part text/plain, which is the shape the case above pins.
    const w = await world({ note: "", noteHtml: "" });
    const send = sendSpy();
    const fetch = fetchSpy({});

    await sendService.send(
      w.ctx, w.draftId, "fwd-key-empty-rich",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );
    const msg = send.delivered[0]!;
    expect(msg.html, "an empty rich document produced an html part").toBeUndefined();
    expect(msg.text!.startsWith("---------- Forwarded message ----------")).toBe(true);
  });

  it("a note-less forward that DOES carry markup opens on the banner — no rule over nothing", async () => {
    /**
     * The html arm of the same join, and it is reachable: `PUT /drafts/:id` with html alone
     * DERIVES the plain body from it (`DraftsService.richBody`), so an empty paragraph is a row
     * with `body: ""` and non-empty `html`. The old quote baked `<br><br><hr>` into its own head,
     * which put two line breaks and a horizontal rule at the very top of the message.
     *
     * Asserted on the html's first bytes, and on the ABSENCE of the separator anywhere before the
     * banner — a substring check alone would pass with the rule still in front of it.
     */
    const w = await world({ note: "", noteHtml: "<p></p>", origHtml: "<p>Here is the <b>plan</b>.</p>" });
    const send = sendSpy();
    const fetch = fetchSpy({});

    await sendService.send(
      w.ctx, w.draftId, "fwd-key-empty-markup",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );
    const msg = send.delivered[0]!;
    expect(msg.html, "a note-less rich forward lost its html part entirely").toBeTruthy();
    const beforeBanner = msg.html!.slice(0, msg.html!.indexOf("<div>---------- Forwarded message"));
    expect(beforeBanner, "the note-and-quote separator stands above a note that is not there")
      .not.toContain("<hr>");
    expect(beforeBanner).not.toContain("<br>");
    // The text part agrees: one emptiness, both parts.
    expect(msg.text!.startsWith("---------- Forwarded message ----------")).toBe(true);
  });

  it("a note-less forward with markup in the note field still opens on the note, then the rule", async () => {
    // The guard's other direction: when there IS a note, the separator must still be there —
    // this is the assertion that goes red if the join drops the separator unconditionally.
    const w = await world({ note: "Passing this along.", noteHtml: "<p>Passing this <b>along</b>.</p>" });
    const send = sendSpy();
    const fetch = fetchSpy({});

    await sendService.send(
      w.ctx, w.draftId, "fwd-key-rich-note",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );
    const msg = send.delivered[0]!;
    expect(msg.text).toBe("Passing this along.\n\n---------- Forwarded message ----------\n" +
      `From: lena@atelier.example\nDate: ${forwardedDate(FIXED_NOW)}\nSubject: Q3 plan\n\n` +
      "Here is the plan.\nRegards, Lena");
    expect(msg.html!.startsWith("<p>Passing this <b>along</b>.</p><br><br><hr>")).toBe(true);
  });

  /**
   * THE QUOTED DATE IS THE SENDER'S: both parts named the original's date as a raw
   * UTC instant. With the sender's zone and locale it reads as they read it, in either part; the
   * zone's name rides with it, since the recipient may be elsewhere. Watched red: `forwardedQuote`
   * back on `toISOString()`, and the call dropping the input's clock.
   */
  it("names the original's date in the sender's zone and language, in the text and the html", async () => {
    const w = await world({ note: "", noteHtml: "<p></p>", origHtml: "<p>Here is the plan.</p>" });
    await w.db.update(messages).set({ date: new Date("2026-09-26T06:00:06.000Z") }).where(eq(messages.id, w.originalId));
    const send = sendSpy();
    await sendService.send(
      w.ctx, w.draftId, "fwd-key-clock",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetchSpy({}).openFetchAdapter },
      { forwardOf: w.originalId, forwardZone: "Europe/Zurich", forwardLocale: "de-CH" },
    );
    const msg = send.delivered[0]!;
    const line = /^Date: (.*)$/m.exec(msg.text!)?.[1] ?? "";
    expect(line, "the text part still carries a machine timestamp").not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // 06:00 UTC is 08:00 in Zurich in September; the weekday and month are German.
    expect(line).toContain("08:00");
    expect(line).toMatch(/^Sa/);
    expect(line).toContain("2026");
    expect(msg.html, "the html part names a different date than the text part").toContain(`<div>Date: ${line}</div>`);
  });

  it("an unstated clock reads in UTC and English — never the ISO instant", async () => {
    const w = await world({ note: "" });
    const send = sendSpy();
    await sendService.send(
      w.ctx, w.draftId, "fwd-key-noclock",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetchSpy({}).openFetchAdapter },
      { forwardOf: w.originalId },
    );
    const line = /^Date: (.*)$/m.exec(send.delivered[0]!.text!)?.[1] ?? "";
    expect(line).not.toContain(FIXED_NOW.toISOString());
    expect(line).toContain("12:00");
    expect(line).toContain("UTC");
  });

  it("a WHITESPACE-ONLY note counts as no note — the same emptiness the Send lock allows", async () => {
    // `canSend` exempts `body.trim() === ""`, so the two halves must agree on what empty means:
    // a note of spaces and newlines would otherwise ship as blank lines above the banner.
    const w = await world({ note: "  \n\t " });
    const send = sendSpy();
    const fetch = fetchSpy({});

    await sendService.send(
      w.ctx, w.draftId, "fwd-key-ws",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );
    expect(send.delivered[0]!.text!.startsWith("---------- Forwarded message ----------")).toBe(true);
  });
});

/**
 * A FORWARD THREADS LIKE A REPLY — RFC 5322 §3.6.4 off the ORIGINAL. Without these two headers the
 * forward leaves as a conversation of its own: its history shows nothing, and a recipient's answer
 * lands beside the original instead of under it. Same chain rule as the reply (root + parent,
 * oldest first, no repeat), from the same lookup. Mutation watched red: make the parent id read
 * `d.inReplyToMessageId` alone again — every case here but the last loses both headers.
 */
describe("a forward carries In-Reply-To and References off the original", () => {
  async function forwardOf(opts: { root: string | null; header: string | null }) {
    const w = await world();
    let threadId: string | null = null;
    if (opts.root !== null) {
      const [th] = await w.db.insert(threads)
        .values({ accountId: w.ctx.accountId, subject: "Q3 plan", rootMessageIdHeader: opts.root })
        .returning();
      threadId = th!.id;
    }
    await w.db.update(messages)
      .set({ messageIdHeader: opts.header, ...(threadId ? { threadId } : {}) })
      .where(eq(messages.id, w.originalId));
    const send = sendSpy();
    const fetch = fetchSpy({});
    await sendService.send(
      w.ctx, w.draftId, "fwd-thread-" + opts.root + opts.header,
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );
    expect(send.delivered).toHaveLength(1);
    return send.delivered[0]!;
  }

  it("names the original as parent and leads the chain with the original's thread root", async () => {
    const msg = await forwardOf({ root: "<root@a.invalid>", header: "<orig@a.invalid>" });
    expect(msg.inReplyTo).toBe("<orig@a.invalid>");
    // The References chain is exactly the original's chain plus the original — order asserted.
    expect(msg.references).toBe("<root@a.invalid> <orig@a.invalid>");
  });

  it("does not repeat one id when the original IS the conversation's root", async () => {
    const msg = await forwardOf({ root: "<orig@a.invalid>", header: "<orig@a.invalid>" });
    expect(msg.inReplyTo).toBe("<orig@a.invalid>");
    expect(msg.references).toBe("<orig@a.invalid>");
  });

  it("falls back to the original alone when it has no thread root", async () => {
    const msg = await forwardOf({ root: null, header: "<orig@a.invalid>" });
    expect(msg.references).toBe("<orig@a.invalid>");
  });

  it("invents nothing for an original that carries no Message-ID", async () => {
    const msg = await forwardOf({ root: null, header: null });
    expect(msg.inReplyTo).toBeUndefined();
    expect(msg.references).toBeUndefined();
  });
});

/**
 * THE ORIGINAL MUST BE LOADABLE, AND AN HTML-ONLY ONE IS CARRIED IN BOTH PARTS. Measured
 * 2026-09-21: an HTML-only original (stored text "") forwarded with a text/plain part holding the
 * banner and headers and none of the original's words; a body the store never held would have
 * quoted "" — the note alone, read as "nothing was forwarded". The send refuses that shape and
 * derives the plain part from the html when the stored text is empty.
 * Mutations watched red (kit/mutate/mutation-control.sh): drop `|| body.withheld !== null` from
 * `unloadable` (the marked-with-stub case); replace the `plain` derivation with `originalText`.
 */
describe("a forward whose original cannot be loaded is refused; an html-only one is carried whole", () => {
  type Refusal = { httpStatus?: number; code?: string; message?: string };
  async function refused(w: Awaited<ReturnType<typeof world>>): Promise<Refusal> {
    const send = sendSpy();
    const fetch = fetchSpy({});
    const err: Refusal = await sendService
      .send(w.ctx, w.draftId, `fwd-key-${crypto.randomUUID()}`, { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter }, { forwardOf: w.originalId })
      .then(() => ({}), (e: unknown) => e as Refusal);
    expect(send.delivered, "nothing may leave for an unloadable original").toHaveLength(0);
    const [row] = await w.db.select().from(drafts);
    expect(row!.status).toBe("draft");
    expect(await w.db.select().from(outboundSends)).toHaveLength(0);
    return err;
  }

  it("REFUSES an original with no stored body — the snippet-only row would quote nothing", async () => {
    const w = await world();
    await w.db.delete(messageBodies).where(eq(messageBodies.messageId, w.originalId));
    const err = await refused(w);
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe("forward_original_unavailable");
    expect(err.message).toBe("The original could not be loaded, so it was not forwarded.");
  });

  it("REFUSES a policy-emptied original when its mailbox cannot be read whole — the marker, not the stub, decides", async () => {
    const w = await world();
    // Marker set WITH a text stub left standing: the storage cap writes "" today, but this row
    // gives the marker arm its own hole to fall through — without it the emptiness arm covers
    // the case and a dropped marker check reads green (measured, mutation 2026-09-21).
    await w.db.update(messageBodies)
      .set({ text: "a preview stub the policy left behind", html: null, withheldReason: "storage_cap" })
      .where(eq(messageBodies.messageId, w.originalId));
    // The fetch spy has no `fetchRaw`: the words live only in the mailbox, so the send refuses
    // after the reservation (row `failed`), and the stub is never quoted as the original.
    const send = sendSpy();
    const fetch = fetchSpy({});
    const err: Refusal = await sendService
      .send(w.ctx, w.draftId, "fwd-key-stub", { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter }, { forwardOf: w.originalId })
      .then(() => ({}), (e: unknown) => e as Refusal);
    expect(send.delivered).toHaveLength(0);
    expect(err.httpStatus).toBe(409);
    expect(err.code).toBe("forward_original_unavailable");
    const [row] = await w.db.select().from(outboundSends);
    expect(row!.status).toBe("failed");
    const [d] = await w.db.select().from(drafts);
    expect(d!.status).toBe("draft");
  });

  it("REFUSES a body row with neither text nor html — an empty quote is the same empty mail", async () => {
    const w = await world();
    await w.db.update(messageBodies).set({ text: "   ", html: "" }).where(eq(messageBodies.messageId, w.originalId));
    const err = await refused(w);
    expect(err.code).toBe("forward_original_unavailable");
  });

  it("an HTML-ONLY original is quoted in the text part too — derived from the html, never blank", async () => {
    const w = await world({
      noteHtml: "<p>Passing this along.</p>",
      origHtml: "<div><p>Quarterly <b>numbers</b> attached.</p><p>Regards,<br>Lena</p></div>",
    });
    await w.db.update(messageBodies).set({ text: "" }).where(eq(messageBodies.messageId, w.originalId));
    const send = sendSpy();
    const fetch = fetchSpy({});
    const res = await sendService.send(
      w.ctx, w.draftId, "fwd-key-html-only",
      { openSendAdapter: send.openSendAdapter, openFetchAdapter: fetch.openFetchAdapter },
      { forwardOf: w.originalId },
    );
    expect(res.status).toBe("sent");
    const msg = send.delivered[0]!;
    // The plain alternative carries the original's words below the banner …
    const afterBanner = msg.text.split("---------- Forwarded message ----------")[1] ?? "";
    expect(afterBanner).toContain("Quarterly numbers attached.");
    expect(afterBanner).toContain("Lena");
    // … and the html part quotes the sanitized original inside the blockquote.
    expect(msg.html).toContain("<blockquote>");
    expect(msg.html).toContain("Quarterly <b>numbers</b> attached.");
  });
});

/**
 * THE ORIGINAL IS WHAT ITS MAILBOX HOLDS (FIX-026, measured 2026-09-29 on the web at 390 px and the
 * phone). Two shapes answered 409 `forward_original_unavailable` while the original was readable:
 * an original whose content is ONLY attachments (a scan, a photo, a letter attached as a file) and
 * a body the store let go (`storage_cap`, `junk_filed`). The first forwards from its stored parts;
 * the second reads its words from the original's own mailbox at send and stores nothing.
 */
describe("a forward is refused only when neither its words nor its files can be read", () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  /** An original as raw MIME — the bytes the fake mailbox serves to `fetchRaw`. */
  const RAW_TEXT_HTML_PDF = [
    "From: Lena <lena@atelier.example>", "To: me@atelier.example", "Subject: Q3 plan",
    "Date: Tue, 01 Sep 2026 08:00:00 +0000", "Message-ID: <q3@atelier.example>", "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="M"', "", "--M",
    'Content-Type: multipart/alternative; boundary="A"', "", "--A",
    "Content-Type: text/plain; charset=utf-8", "", "Here is the plan.", "Regards, Lena", "--A",
    "Content-Type: text/html; charset=utf-8", "",
    '<p>Here is the <b>plan</b>.</p><p><img alt="dot" src="data:image/png;base64,iVBORw0KGgo="></p><p>Regards, Lena</p>',
    "--A--", "--M",
    'Content-Type: application/pdf; name="plan.pdf"', 'Content-Disposition: attachment; filename="plan.pdf"',
    "Content-Transfer-Encoding: base64", "", Buffer.from(PDF).toString("base64"), "--M--", "",
  ].join("\r\n");

  type Opened = { mailboxId: string };
  interface FakeMailbox {
    openFetchAdapter: OpenAdapter;
    opened: Opened[];
    parts: Array<{ ref: string; partId: string | null }>;
    raws: Array<{ ref: string; maxBytes: number | undefined }>;
  }
  /** A mailbox that serves parts by id and, when `raw` is given, the whole message through `fetchRaw`. */
  function fakeMailbox(opts: {
    parts?: Record<string, { filename: string; contentType: string; body: Uint8Array }>;
    raw?: string | ((ref: string) => Promise<Uint8Array>);
  }): FakeMailbox {
    const f: FakeMailbox = { opened: [], parts: [], raws: [], openFetchAdapter: async () => { throw new Error("unset"); } };
    f.openFetchAdapter = async (mailboxId: string): Promise<AttachmentAdapter> => {
      f.opened.push({ mailboxId });
      const adapter: AttachmentAdapter = {
        async fetchPart(loc, partId) {
          f.parts.push({ ref: loc.ref, partId });
          const p = opts.parts?.[partId ?? "1"];
          if (!p) throw new Error(`no part ${partId}`);
          return { contentType: p.contentType, filename: p.filename, body: p.body };
        },
        async close() { /* nothing */ },
      };
      if (opts.raw !== undefined) {
        const raw = opts.raw;
        adapter.fetchRaw = async (loc, o) => {
          f.raws.push({ ref: loc.ref, maxBytes: o?.maxBytes });
          return typeof raw === "string" ? new Uint8Array(Buffer.from(raw)) : raw(loc.ref);
        };
      }
      return adapter;
    };
    return f;
  }

  /** Two mailboxes (X holds the original, Y can be the From), the original with the given parts. */
  async function world2(opts: {
    text?: string; html?: string | null;
    parts?: Array<{ partId: string; filename: string; contentType: string; inline?: boolean; contentId?: string }>;
    fromY?: boolean; note?: string; noteHtml?: string;
  }) {
    const { db } = await makeDeps(FIXED_NOW);
    const s = await seedSession(db, { now: FIXED_NOW });
    const mbX = await seedMailbox(db, { accountId: s.accountId, address: "x@atelier.example" });
    const mbY = await seedMailbox(db, { accountId: s.accountId, address: "y@atelier.example" });
    const orig = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mbX, subject: "Q3 plan",
      fromAddress: "lena@atelier.example", date: FIXED_NOW, nativeLocator: { folder: "INBOX", ref: "12:7" },
    });
    await seedBody(db, { messageId: orig.id, text: opts.text ?? "", html: opts.html ?? null });
    for (const p of opts.parts ?? []) {
      await db.insert(attachments).values({
        accountId: s.accountId, messageId: orig.id, filename: p.filename, contentType: p.contentType,
        sizeBytes: 8, partId: p.partId, inline: p.inline ?? false, contentId: p.contentId ?? null,
      });
    }
    const [draft] = await db.insert(drafts).values({
      accountId: s.accountId, mailboxId: opts.fromY ? mbY : mbX, subject: "Fwd: Q3 plan",
      body: opts.note ?? "", ...(opts.noteHtml === undefined ? {} : { html: opts.noteHtml }),
      to: [{ name: null, address: "sam@example.test" }],
      cc: [], bcc: [], status: "draft", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).returning();
    const ctx: ServiceContext = { db, accountId: s.accountId, userId: s.userId, now: () => FIXED_NOW, requestId: "test-fwd-orig" };
    return { db, ctx, mbX, mbY, draftId: draft!.id, originalId: orig.id };
  }
  type World2 = Awaited<ReturnType<typeof world2>>;

  async function husk(w: World2, reason: "storage_cap" | "junk_filed" | "expunged" | "too_large") {
    // A stub is left standing: the marker, not emptiness, decides whether stored words are read.
    await w.db.update(messageBodies).set({ text: "a stub the policy left behind", html: null, withheldReason: reason })
      .where(eq(messageBodies.messageId, w.originalId));
  }
  function smtpSpy() {
    const spy = { sent: [] as OutboundMessage[], probed: [] as string[],
      openSendAdapter: async (): Promise<SendAdapter> => ({
        async send(msg: OutboundMessage) { spy.sent.push(msg); return { providerMessageId: msg.messageId ?? "<none>" }; },
        async messageInSent(id: string) { spy.probed.push(id); return false; },
        async close() { /* nothing */ },
      }) };
    return spy;
  }
  async function forwardIt(w: World2, mb: FakeMailbox, key = `k-${crypto.randomUUID()}`) {
    const smtp = smtpSpy();
    const out = await sendService.send(
      w.ctx, w.draftId, key, { openSendAdapter: smtp.openSendAdapter, openFetchAdapter: mb.openFetchAdapter },
      { forwardOf: w.originalId },
    ).then((r) => ({ ok: r, err: null as null | { httpStatus?: number; code?: string } }),
      (e: unknown) => ({ ok: null, err: e as { httpStatus?: number; code?: string } }));
    return { ...out, smtp };
  }
  async function storedState(w: World2) {
    const [b] = await w.db.select({ text: messageBodies.text, html: messageBodies.html, withheld: messageBodies.withheldReason })
      .from(messageBodies).where(eq(messageBodies.messageId, w.originalId));
    const storage = await w.db.select().from(accountStorage);
    return JSON.stringify({ b, storage });
  }
  const PARTS = {
    "2": { filename: "scan.pdf", contentType: "application/pdf", body: PDF },
    "3": { filename: "photo.png", contentType: "image/png", body: PNG },
    "4": { filename: "inner.eml", contentType: "message/rfc822", body: new Uint8Array(Buffer.from("Subject: inner\r\n\r\nInner text.\r\n")) },
  };

  // ── an original whose content is only its attachments ─────────────────────────────────
  for (const shape of [
    { name: "a PDF only", parts: [{ partId: "2", filename: "scan.pdf", contentType: "application/pdf" }], files: ["scan.pdf"] },
    { name: "an inline photo only", parts: [{ partId: "3", filename: "photo.png", contentType: "image/png", inline: true, contentId: "<p1@x>" }], files: ["photo.png"] },
    { name: "a letter attached as a file only", parts: [{ partId: "4", filename: "inner.eml", contentType: "message/rfc822" }], files: ["inner.eml"] },
  ]) {
    it(`SENDS ${shape.name}: the banner, every part, read from the ORIGINAL's mailbox`, async () => {
      const w = await world2({ parts: shape.parts });
      const mb = fakeMailbox({ parts: PARTS });
      const r = await forwardIt(w, mb);
      expect(r.err).toBeNull();
      expect(r.ok!.status).toBe("sent");
      const msg = r.smtp.sent[0]!;
      expect(msg.text).toContain("---------- Forwarded message ----------");
      expect(msg.text).toContain("Subject: Q3 plan");
      expect(msg.attachments?.map((a) => a.filename)).toEqual(shape.files);
      expect(mb.opened).toEqual([{ mailboxId: w.mbX }]);
      expect(mb.raws).toEqual([]);
    });
  }

  it("From Y, original in X: the parts are read from X — the original's mailbox, never the draft's", async () => {
    const w = await world2({ text: "Here is the plan.", parts: [{ partId: "2", filename: "scan.pdf", contentType: "application/pdf" }], fromY: true });
    const mb = fakeMailbox({ parts: PARTS });
    const r = await forwardIt(w, mb);
    expect(r.ok!.status).toBe("sent");
    expect(r.smtp.sent[0]!.from).toBe("y@atelier.example");
    expect(r.smtp.sent[0]!.attachments?.map((a) => a.filename)).toEqual(["scan.pdf"]);
    expect(mb.opened).toEqual([{ mailboxId: w.mbX }]);
  });

  // ── the words of a husked body come from the mailbox, and the wire equals the unhusked one ──
  for (const reason of ["storage_cap", "junk_filed"] as const) {
    it(`SENDS a ${reason} husk with the words read from the mailbox — the same wire as never husked, nothing stored`, async () => {
      const parsed = await normalizeMime(RAW_TEXT_HTML_PDF);
      const stored = { text: parsed.textBody, html: prepareHtmlForStorage(parsed.htmlBody) };
      const part = [{ partId: "2", filename: "plan.pdf", contentType: "application/pdf" }];
      const pdfPart = { "2": { filename: "plan.pdf", contentType: "application/pdf", body: PDF } };
      // A RICH note, so the html part carries the quote and the stored-html shape is on the wire.
      const note = "Passing this along.";
      const noteHtml = "<p>Passing this along.</p>";

      const plain = await world2({ ...stored, parts: part, note, noteHtml });
      const plainMb = fakeMailbox({ parts: pdfPart });
      const a = await forwardIt(plain, plainMb);
      expect(a.ok!.status).toBe("sent");

      const w = await world2({ ...stored, parts: part, note, noteHtml });
      await husk(w, reason);
      const before = await storedState(w);
      const mb = fakeMailbox({ parts: pdfPart, raw: RAW_TEXT_HTML_PDF });
      const b = await forwardIt(w, mb);
      expect(b.err).toBeNull();
      expect(b.ok!.status).toBe("sent");

      const wa = a.smtp.sent[0]!, wb = b.smtp.sent[0]!;
      expect(wb.text).toBe(wa.text);
      expect(wb.html).toBe(wa.html);
      expect(wa.html).toContain("<b>plan</b>");
      expect(wa.html).not.toContain("data:image/png");
      expect(wb.attachments?.map((x) => [x.filename, Buffer.from(x.content).toString("hex")]))
        .toEqual(wa.attachments?.map((x) => [x.filename, Buffer.from(x.content).toString("hex")]));
      expect(wb.text).toContain("Here is the plan.");
      expect(wb.text).not.toContain("a stub the policy left behind");
      expect(mb.raws).toEqual([{ ref: "12:7", maxBytes: FORWARD_MAX_RAW_BYTES }]);
      expect(mb.opened).toEqual([{ mailboxId: w.mbX }]);
      expect(await storedState(w)).toBe(before);
    });
  }

  it("an original html past the stored cap: the husked quote is the one the store would have held", async () => {
    // The outbound sanitizer admits no img, so a data: URI never reaches the wire; the cap does.
    const big = "<p>" + "Quarterly figures, line by line. ".repeat(9000) + "</p>";
    const raw = RAW_TEXT_HTML_PDF.replace(/<p>Here is the <b>plan<\/b>.*?<p>Regards, Lena<\/p>/, big);
    const parsed = await normalizeMime(raw);
    expect(Buffer.byteLength(parsed.htmlBody ?? "", "utf8")).toBeGreaterThan(STORED_HTML_CAP_BYTES);
    const stored = { text: parsed.textBody, html: prepareHtmlForStorage(parsed.htmlBody) };
    const noteHtml = "<p>See below.</p>";
    const plain = await world2({ ...stored, parts: [], note: "See below.", noteHtml });
    const a = await forwardIt(plain, fakeMailbox({}));
    const w = await world2({ ...stored, parts: [], note: "See below.", noteHtml });
    await husk(w, "storage_cap");
    const b = await forwardIt(w, fakeMailbox({ raw }));
    expect(b.ok!.status).toBe("sent");
    expect(b.smtp.sent[0]!.html).toBe(a.smtp.sent[0]!.html);
    expect(b.smtp.sent[0]!.text).toBe(a.smtp.sent[0]!.text);
  });

  it("a RICH note over a husk: the html half is joined from the mailbox's words too", async () => {
    const parsed = await normalizeMime(RAW_TEXT_HTML_PDF);
    const w = await world2({ text: parsed.textBody, html: prepareHtmlForStorage(parsed.htmlBody), parts: [] });
    await w.db.update(drafts).set({ body: "See below.", html: "<p>See below.</p>" }).where(eq(drafts.id, w.draftId));
    await husk(w, "storage_cap");
    const r = await forwardIt(w, fakeMailbox({ raw: RAW_TEXT_HTML_PDF }));
    expect(r.ok!.status).toBe("sent");
    expect(r.smtp.sent[0]!.html).toContain("<p>See below.</p>");
    expect(r.smtp.sent[0]!.html).toContain("<blockquote>");
    expect(r.smtp.sent[0]!.html).toContain("<b>plan</b>");
  });

  // ── 7b: what still refuses ──────────────────────────────────────────────────────────────
  async function refusedBefore(w: World2, mb: FakeMailbox) {
    const r = await forwardIt(w, mb);
    expect(r.err?.httpStatus).toBe(409);
    expect(r.err?.code).toBe("forward_original_unavailable");
    expect(r.smtp.sent).toEqual([]);
    expect(r.smtp.probed).toEqual([]);
    const [d] = await w.db.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status).toBe("draft");
    return r;
  }
  it("REFUSES empty words with zero parts — nothing to forward", async () => {
    const w = await world2({ text: "  ", html: "" });
    await refusedBefore(w, fakeMailbox({ raw: RAW_TEXT_HTML_PDF }));
    expect(await w.db.select().from(outboundSends)).toHaveLength(0);
  });
  it("REFUSES no body row, even with parts", async () => {
    const w = await world2({ parts: [{ partId: "2", filename: "scan.pdf", contentType: "application/pdf" }] });
    await w.db.delete(messageBodies).where(eq(messageBodies.messageId, w.originalId));
    await refusedBefore(w, fakeMailbox({ parts: PARTS, raw: RAW_TEXT_HTML_PDF }));
    expect(await w.db.select().from(outboundSends)).toHaveLength(0);
  });
  for (const reason of ["expunged", "too_large"] as const) {
    it(`REFUSES a ${reason} husk — the mailbox is not asked`, async () => {
      const w = await world2({ text: "x", parts: [{ partId: "2", filename: "scan.pdf", contentType: "application/pdf" }] });
      await husk(w, reason);
      const mb = fakeMailbox({ parts: PARTS, raw: RAW_TEXT_HTML_PDF });
      await refusedBefore(w, mb);
      expect(mb.opened).toEqual([]);
      expect(await w.db.select().from(outboundSends)).toHaveLength(0);
    });
  }
  it("REFUSES a husk when the mailbox adapter cannot read a whole message — never a parts-only send", async () => {
    const w = await world2({ text: "x", parts: [{ partId: "2", filename: "scan.pdf", contentType: "application/pdf" }] });
    await husk(w, "storage_cap");
    const mb = fakeMailbox({ parts: PARTS });
    await refusedBefore(w, mb);
    expect(mb.parts).toEqual([]);
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("failed");
  });

  it("REFUSES an attachment-only original when the host supplies no mailbox reader — never the banner without its files", async () => {
    const w = await world2({ parts: [{ partId: "2", filename: "scan.pdf", contentType: "application/pdf" }] });
    const smtp = smtpSpy();
    const err = await sendService.send(w.ctx, w.draftId, "k-no-reader", { openSendAdapter: smtp.openSendAdapter }, { forwardOf: w.originalId })
      .then(() => null, (e: unknown) => e as { httpStatus?: number; code?: string });
    expect(err?.httpStatus).toBe(409);
    expect(err?.code).toBe("forward_original_unavailable");
    expect(smtp.sent).toEqual([]);
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("failed");
  });

  // ── 7d: failures after the reservation ──────────────────────────────────────────────────
  async function failedAfter(w: World2, mb: FakeMailbox, status: number, code: string) {
    const r = await forwardIt(w, mb);
    expect(r.err?.httpStatus).toBe(status);
    expect(r.err?.code).toBe(code);
    expect(r.smtp.sent).toEqual([]);
    const [row] = await w.db.select().from(outboundSends).where(eq(outboundSends.draftId, w.draftId));
    expect(row!.status).toBe("failed");
    const [d] = await w.db.select().from(drafts).where(eq(drafts.id, w.draftId));
    expect(d!.status).toBe("draft");
    return r;
  }
  const huskedWithPdf = async () => {
    const w = await world2({ text: "x", parts: [{ partId: "2", filename: "plan.pdf", contentType: "application/pdf" }] });
    await husk(w, "storage_cap");
    return w;
  };
  it("the original gone and the mirror not caught up: forward_source_moved, one read", async () => {
    const w = await huskedWithPdf();
    const mb = fakeMailbox({ parts: PARTS, raw: async (ref) => { throw new MessageGoneError({ folder: "INBOX", ref }); } });
    await failedAfter(w, mb, 409, "forward_source_moved");
    expect(mb.raws.map((r) => r.ref)).toEqual(["12:7"]);
  });
  it("the original moved and the mirror repointed: ONE retry, then the parts on the same locator", async () => {
    const w = await huskedWithPdf();
    const mb = fakeMailbox({
      parts: { "2": { filename: "plan.pdf", contentType: "application/pdf", body: PDF } },
      raw: async (ref) => {
        if (ref === "12:7") {
          await w.db.update(messages).set({ nativeLocator: { folder: "Archive", ref: "19:3" } }).where(eq(messages.id, w.originalId));
          throw new MessageGoneError({ folder: "INBOX", ref });
        }
        return new Uint8Array(Buffer.from(RAW_TEXT_HTML_PDF));
      },
    });
    const r = await forwardIt(w, mb);
    expect(r.ok!.status).toBe("sent");
    expect(mb.raws.map((x) => x.ref)).toEqual(["12:7", "19:3"]);
    expect(mb.parts).toEqual([{ ref: "19:3", partId: "2" }]);
    expect(r.smtp.sent[0]!.text).toContain("Here is the plan.");
  });
  it("a whole message over the ceiling: 413, never a words-dropped send", async () => {
    const w = await huskedWithPdf();
    const mb = fakeMailbox({ parts: PARTS, raw: async (ref) => { throw new RawMessageTooLargeError({ folder: "INBOX", ref }, FORWARD_MAX_RAW_BYTES, FORWARD_MAX_RAW_BYTES + 1); } });
    await failedAfter(w, mb, 413, "payload_too_large");
    expect(mb.parts).toEqual([]);
  });
  it("any other read failure: 409 forward_original_unavailable", async () => {
    const w = await huskedWithPdf();
    const mb = fakeMailbox({ parts: PARTS, raw: async () => { throw new Error("the driver said something unexpected"); } });
    await failedAfter(w, mb, 409, "forward_original_unavailable");
    expect(mb.parts).toEqual([]);
  });
});

/**
 * THE PARTS THE PERSON KEPT (`forwardParts`). Absent: every part, as before. Present: exactly the
 * named parts, selected only among the original's own rows; a name that is not one of them refuses
 * before anything is reserved, and never reaches the fetch.
 */
describe("forwardParts — only the files the person kept leave", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const C = "cccccccc-0000-4000-8000-000000000003";
  async function threeParts(opts: { noForward?: boolean } = {}) {
    const w = await world(opts);
    for (const [id, partId] of [[A, "2"], [B, "3"], [C, "4"]] as const) {
      await w.db.insert(attachments).values({
        id, accountId: w.ctx.accountId, messageId: w.originalId, filename: `f-${partId}.bin`,
        contentType: "application/octet-stream", sizeBytes: 1, partId, inline: false,
      });
    }
    return { w, send: sendSpy(), fetch: fetchSpy({ "2": new Uint8Array([2]), "3": new Uint8Array([3]), "4": new Uint8Array([4]) }) };
  }
  const go = (s: Awaited<ReturnType<typeof threeParts>>, key: string, input: Record<string, unknown>) =>
    sendService.send(s.w.ctx, s.w.draftId, key,
      { openSendAdapter: s.send.openSendAdapter, openFetchAdapter: s.fetch.openFetchAdapter },
      { forwardOf: s.w.originalId, ...input });

  it("sends only the named subset, in id order", async () => {
    const s = await threeParts();
    expect((await go(s, "fp-1", { forwardParts: [C, A] })).status).toBe("sent");
    expect(s.fetch.asked).toEqual(["2", "4"]);
    expect(s.send.delivered[0]!.attachments?.map((a) => a.filename)).toEqual(["part-2.bin", "part-4.bin"]);
  });

  it("an empty list sends the quote with none of the files", async () => {
    const s = await threeParts();
    expect((await go(s, "fp-2", { forwardParts: [] })).status).toBe("sent");
    expect(s.fetch.asked).toEqual([]);
    expect(s.send.delivered[0]!.attachments ?? []).toEqual([]);
    expect(s.send.delivered[0]!.text).toContain("Here is the plan.");
  });

  it("the field absent sends every part, as before", async () => {
    const s = await threeParts();
    expect((await go(s, "fp-3", {})).status).toBe("sent");
    expect(s.fetch.asked).toEqual(["2", "3", "4"]);
  });

  it("a part of another message or another account refuses 409 before anything is reserved or fetched", async () => {
    const s = await threeParts();
    const other = await seedMessage(s.w.db, { accountId: s.w.ctx.accountId, subject: "other" });
    const [mine] = await s.w.db.insert(attachments).values({
      accountId: s.w.ctx.accountId, messageId: other.id, filename: "other.bin",
      contentType: "application/octet-stream", sizeBytes: 1, partId: "2", inline: false,
    }).returning();
    const stranger = await seedSession(s.w.db, { now: FIXED_NOW });
    const theirs = await seedMessage(s.w.db, { accountId: stranger.accountId, subject: "theirs" });
    const [foreign] = await s.w.db.insert(attachments).values({
      accountId: stranger.accountId, messageId: theirs.id, filename: "theirs.bin",
      contentType: "application/octet-stream", sizeBytes: 1, partId: "2", inline: false,
    }).returning();
    for (const [key, id] of [["fp-4a", mine!.id], ["fp-4b", foreign!.id]] as const) {
      const err = await go(s, key, { forwardParts: [A, id] }).catch((e: unknown) => e as { httpStatus?: number; code?: string });
      expect((err as { httpStatus?: number }).httpStatus).toBe(409);
      expect((err as { code?: string }).code).toBe("forward_parts_changed");
    }
    expect(s.fetch.asked).toEqual([]);
    expect(s.send.delivered).toHaveLength(0);
    expect(await s.w.db.select().from(outboundSends)).toHaveLength(0);
    const [row] = await s.w.db.select().from(drafts).where(eq(drafts.id, s.w.draftId));
    expect(row!.status).toBe("draft");
  });

  it("a no_forward original still refuses 403 first, whatever parts are named", async () => {
    const s = await threeParts({ noForward: true });
    const err = await go(s, "fp-5", { forwardParts: ["dddddddd-0000-4000-8000-000000000009"] })
      .catch((e: unknown) => e as { httpStatus?: number });
    expect((err as { httpStatus?: number }).httpStatus).toBe(403);
  });

  it("two forwards of one letter with different selections are two messages, not a duplicate", async () => {
    const s = await threeParts();
    expect((await go(s, "fp-6a", { forwardParts: [A] })).status).toBe("sent");
    const [d2] = await s.w.db.insert(drafts).values({
      accountId: s.w.ctx.accountId, mailboxId: (await s.w.db.select().from(drafts))[0]!.mailboxId,
      subject: "Fwd: Q3 plan", body: "Passing this along.", to: [{ name: null, address: "sam@example.test" }],
      cc: [], bcc: [], status: "draft", createdAt: FIXED_NOW, updatedAt: FIXED_NOW,
    }).returning();
    const res = await sendService.send(s.w.ctx, d2!.id, "fp-6b",
      { openSendAdapter: s.send.openSendAdapter, openFetchAdapter: s.fetch.openFetchAdapter },
      { forwardOf: s.w.originalId, forwardParts: [B] });
    expect(res.status).toBe("sent");
    expect(res.firstSend).toBeUndefined();
    expect(s.send.delivered).toHaveLength(2);
  });

  it("Send again of a held forward that kept some files never sends the removed ones: unmatched, nothing goes", async () => {
    const s = await threeParts();
    // The row names its original, as a phone forward's row does.
    await s.w.db.update(drafts).set({ forwardOfMessageId: s.w.originalId }).where(eq(drafts.id, s.w.draftId));
    let lost = true;
    const taken: OutboundMessage[] = [];
    const deps = {
      openFetchAdapter: s.fetch.openFetchAdapter,
      openSendAdapter: async (): Promise<SendAdapter> => ({
        async send(msg: OutboundMessage, opts?: SendOptions) {
          await opts?.beforeRelease?.();
          taken.push(msg);
          // Taken, and the answer lost: the send is held.
          if (lost) throw Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" });
          return { providerMessageId: msg.messageId ?? "<none>" };
        },
        async messageInSent() { return false; },
        async close() { /* nothing */ },
      }),
    };
    expect((await sendService.send(s.w.ctx, s.w.draftId, "fp-7", deps, { forwardOf: s.w.originalId, forwardParts: [A, C] })).status)
      .toBe("unverified");
    lost = false;
    const again = await sendService.send(s.w.ctx, s.w.draftId, "fp-7-again", deps, { again: true }).catch((e: unknown) => e);
    expect(again).toMatchObject({ code: "send_again_changed", httpStatus: 409 });
    expect(taken.map((m) => m.attachments?.map((a) => a.filename)), "a removed file went").toEqual([["part-2.bin", "part-4.bin"]]);
    expect(s.fetch.asked).toEqual(["2", "4"]);
  });
});
