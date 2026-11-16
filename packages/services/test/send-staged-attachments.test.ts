import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import {
  SendService, SEND_ATTACHMENT_MAX_TOTAL_BYTES, SEND_MAX_ATTACHMENT_PARTS,
  dbFor, dedupeStagedIds, sendSurfaceFor, ServiceError,
} from "../src/index.js";
import type {
  ServiceContext, SendAttachment, StagedAttachmentSource,
} from "../src/index.js";

/**
 * ═══ THE SEAM IS THE TRANSPORT, NOT THE COMPOSE SURFACE ════════════════════════════════════
 *
 * Attachment bytes used to ride the send request base64-encoded, so the serverless body
 * limit was a ceiling on the FEATURE: the hosted compose surface promised 3 MB of raw bytes
 * whatever the sender's own submission server announced. Staged bytes reach this service from
 * object storage instead, and a request-body limit is not a statement about them.
 *
 * ## What each guard here is for, and the mutation it was watched against
 *
 *  · **The inline path is byte-identical.** A request carrying `attachments` and nothing else must
 *    produce exactly the send it always did, including the 3 MB refusal. Mutation: make
 *    `sendSurfaceFor` return `null` unconditionally → the inline case's oversize refusal
 *    disappears and the test goes red.
 *
 * ## WHY THE INLINE PATH IS NOT ON A SUNSET CLOCK
 *
 * It reads like a compatibility path for older desktop builds, and it is not one. Both shipping
 * clients emit it today: the browser app stages only ABOVE the inline ceiling, so every send at or
 * under 3 MB is this request, and the desktop app never stages on either door (its source does not
 * contain the wire client's staging option, asserted in that app's own suite). Update uptake is
 * therefore not the question, and it could not be answered anyway — nothing carries a client
 * version to the hosted service.
 *
 * The criterion for reopening the question, so it is not re-derived from scratch: the desktop's
 * Cloud door stages, AND the browser client stages unconditionally rather than above a threshold.
 * Until both hold, the guards below stay "must accept" and inline acceptance is load-bearing.
 *  · **The staged path assembles the REAL bytes.** Mutation: drop the `msg.attachments` merge in
 *    `send` → the adapter receives a message with no files and the assertion on the delivered
 *    bytes goes red.
 *  · **Oversize is refused SERVER-SIDE at the send, on the DECLARED total, before any download.**
 *    Mutation: delete the staged branch from `reserve`'s pre-transaction block → a 40 MB stage
 *    against a 4 MB mailbox is accepted and `fetch` is called, and two assertions go red.
 *  · **A host with no staging capability refuses staged references.** This is the standalone
 *    door's shape. Mutation: fall through instead of throwing → the send succeeds with no files.
 *  · **A missing or expired ticket ends the send.** Mutation: skip the expiry comparison → the
 *    expired case is accepted.
 *  · **A MIXED send keeps the strict surface.** Mutation: make `sendSurfaceFor` uncap whenever any
 *    id is staged → the mixed case's refusal disappears.
 */

const svc = new SendService();
const NOW = new Date("2026-08-13T12:00:00Z");
const MIB = 1024 * 1024;

function fakeAdapter() {
  const state = { sendCalls: 0, sent: [] as OutboundMessage[] };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      state.sent.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() { /* nothing to release */ },
  });
  return { factory, state };
}

function attachment(bytes: number, fill = 0): SendAttachment {
  return {
    filename: "inline.bin",
    contentType: "application/octet-stream",
    content: Buffer.alloc(bytes, fill),
  } as SendAttachment;
}

/**
 * A staging source over an in-memory ticket table, COUNTING its two phases separately.
 *
 * The counts are the point of the fake, not the bytes: the property under test is that an
 * over-cap send is refused after `declare` and BEFORE `fetch` — a one-phase port would have to
 * transfer the bytes to find out, which is the cost hole the "An unverified account must not be able to generate meaningful cost" invariant is about.
 */
function stagingSource(tickets: Array<{
  id: string; sizeBytes: number; expiresAt: Date; filename?: string; contentType?: string; bytes?: Buffer;
}>) {
  const calls = { declare: 0, fetch: 0 };
  /** The id LISTS each phase was handed — what the service asked for, not how often it asked. */
  const seen = { declare: [] as string[][], fetch: [] as string[][] };
  const source: StagedAttachmentSource = {
    async declare(_accountId, ids) {
      calls.declare += 1;
      seen.declare.push([...ids]);
      // `filename` and `contentType` are part of what `declare` ANSWERS, and the double must
      // answer them or it measures itself: the send path folds staged files into its duplicate
      // fingerprint by `(filename, contentType, sizeBytes)`, so a double that returns size alone
      // degenerates every staged manifest to size-only and the discrimination case below would
      // pass for the wrong reason. Nothing typechecks this file, so the interface cannot catch it.
      return tickets
        .filter((t) => ids.includes(t.id))
        .map((t) => ({
          id: t.id, sizeBytes: t.sizeBytes, expiresAt: t.expiresAt,
          filename: t.filename ?? `${t.id}.bin`,
          contentType: t.contentType ?? "application/octet-stream",
        }));
    },
    async fetch(_accountId, ids) {
      calls.fetch += 1;
      seen.fetch.push([...ids]);
      return ids.map((id) => {
        const t = tickets.find((x) => x.id === id);
        if (!t) throw new ServiceError("not_found", 404, "an uploaded attachment was not found");
        return {
          filename: t.filename ?? `${id}.bin`,
          contentType: "application/octet-stream",
          content: t.bytes ?? Buffer.alloc(t.sizeBytes, 7),
        };
      });
    },
  };
  return { source, calls, seen };
}

async function setup(smtpMaxSizeBytes: number | null) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "mila@lichtgrat.example", smtpMaxSizeBytes,
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  async function newDraft() {
    const [d] = await db.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "with a file", body: "here",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
    }).returning();
    return d!.id;
  }
  return { db, ctx, newDraft, mailboxId: mb!.id };
}

describe("sendSurfaceFor — the surface belongs to the TRANSPORT, not to the host", () => {
  it("staged-only lifts the host's request-body declaration to EXPLICITLY UNCAPPED", () => {
    expect(sendSurfaceFor(SEND_ATTACHMENT_MAX_TOTAL_BYTES, { stagedAttachmentIds: ["a"] }))
      .toBe(null);
  });

  it("any INLINE attachment keeps the host's declaration — including a mixed send", () => {
    // The conservative direction, deliberately: the inline half of a mixed send really did ride
    // the request body, and lifting the limit for it would let a request through that the
    // platform in front of this handler refuses first, with an error the user cannot act on.
    expect(sendSurfaceFor(SEND_ATTACHMENT_MAX_TOTAL_BYTES, {
      attachments: [attachment(1)], stagedAttachmentIds: ["a"],
    })).toBe(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
    expect(sendSurfaceFor(SEND_ATTACHMENT_MAX_TOTAL_BYTES, { attachments: [attachment(1)] }))
      .toBe(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
  });

  it("no attachments at all keeps the declaration too — one fewer branch, and the total is 0", () => {
    expect(sendSurfaceFor(SEND_ATTACHMENT_MAX_TOTAL_BYTES, {})).toBe(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
    expect(sendSurfaceFor(undefined, {})).toBe(undefined);
    expect(sendSurfaceFor(null, {})).toBe(null);
  });

  it("an EMPTY staged list is not a staged send", () => {
    expect(sendSurfaceFor(SEND_ATTACHMENT_MAX_TOTAL_BYTES, { stagedAttachmentIds: [] }))
      .toBe(SEND_ATTACHMENT_MAX_TOTAL_BYTES);
  });
});

describe("THE INLINE PATH — the live one, and byte-identical to the one it always was", () => {
  it("inline bytes reach the transport and the host's 3 MB ceiling still refuses", async () => {
    // The request shape a shipped desktop's Cloud door forwards verbatim — and ALSO the shape the
    // current browser app sends for every total at or under the ceiling, which is the reason this
    // block is not named after a past release. Staging is wired on this host, and it must change
    // nothing at all about this path.
    const { ctx, newDraft } = await setup(null);
    const { factory, state } = fakeAdapter();
    const { source, calls } = stagingSource([]);

    const ok = await svc.send(
      ctx, await newDraft(), "replay-ok",
      {
        openSendAdapter: factory,
        surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES,
        stagedAttachments: source,
      },
      { attachments: [attachment(1 * MIB, 3)] },
    );
    expect(ok.status).toBe("sent");
    expect(state.sent[0]!.attachments).toHaveLength(1);
    expect(state.sent[0]!.attachments![0]!.content.byteLength).toBe(1 * MIB);
    // The staging port was never consulted: an inline send does not touch it.
    expect(calls).toEqual({ declare: 0, fetch: 0 });

    const err = await svc.send(
      ctx, await newDraft(), "replay-too-big",
      {
        openSendAdapter: factory,
        surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES,
        stagedAttachments: source,
      },
      { attachments: [attachment(4 * MIB)] },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ httpStatus: 413, code: "payload_too_large" });
    expect(String((err as Error).message)).toContain(String(SEND_ATTACHMENT_MAX_TOTAL_BYTES));
    expect(state.sendCalls).toBe(1);
  });
});

describe("THE STAGED PATH — end to end, with the real bytes", () => {
  it("a 6 MB stage against a 25 MB mailbox SENDS, and the message carries those bytes", async () => {
    // The whole point of the slice: 6 MB is impossible inline (the host declares 3 MB and the
    // platform refuses a body that size), and the mailbox announced 25 MB.
    const { ctx, newDraft } = await setup(25 * MIB);
    const { factory, state } = fakeAdapter();
    const id = randomUUID();
    const bytes = Buffer.alloc(6 * MIB, 9);
    const { source, calls } = stagingSource([{
      id, sizeBytes: bytes.byteLength, expiresAt: new Date(NOW.getTime() + 3_600_000),
      filename: "holiday.mov", bytes,
    }]);

    const res = await svc.send(
      ctx, await newDraft(), "staged-ok",
      {
        openSendAdapter: factory,
        surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES,
        stagedAttachments: source,
      },
      { stagedAttachmentIds: [id] },
    );

    expect(res.status).toBe("sent");
    expect(calls).toEqual({ declare: 1, fetch: 1 });
    const sent = state.sent[0]!;
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments![0]!.filename).toBe("holiday.mov");
    expect(sent.attachments![0]!.content.byteLength).toBe(6 * MIB);
    // Not a placeholder — the bytes the ticket resolved to.
    expect(sent.attachments![0]!.content.subarray(0, 4).equals(Buffer.alloc(4, 9))).toBe(true);
  });

  it("inline and staged CONCATENATE, inline first", async () => {
    const { ctx, newDraft } = await setup(25 * MIB);
    const { factory, state } = fakeAdapter();
    const id = randomUUID();
    const { source } = stagingSource([{
      id, sizeBytes: 1024, expiresAt: new Date(NOW.getTime() + 3_600_000), filename: "second.bin",
    }]);

    await svc.send(
      ctx, await newDraft(), "mixed-ok",
      {
        openSendAdapter: factory,
        surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES,
        stagedAttachments: source,
      },
      { attachments: [attachment(2048)], stagedAttachmentIds: [id] },
    );
    const names = state.sent[0]!.attachments!.map((a) => a.filename);
    expect(names).toEqual(["inline.bin", "second.bin"]);
  });
});

describe("OVERSIZE IS REFUSED AT THE SEND, ON THE DECLARED TOTAL, BEFORE ANY TRANSFER", () => {
  it("40 MB of tickets against a 4 MB mailbox is 413 — and `fetch` was never called", async () => {
    const { ctx, newDraft } = await setup(4 * MIB);
    const { factory, state } = fakeAdapter();
    const id = randomUUID();
    const { source, calls } = stagingSource([{
      id, sizeBytes: 40 * MIB, expiresAt: new Date(NOW.getTime() + 3_600_000),
    }]);

    const err = await svc.send(
      ctx, await newDraft(), "staged-too-big",
      {
        openSendAdapter: factory,
        surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES,
        stagedAttachments: source,
      },
      { stagedAttachmentIds: [id] },
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 413, code: "payload_too_large" });
    // The mailbox's number, not the host constant: the surface was uncapped for this send.
    expect(String((err as Error).message)).toContain(String(4 * MIB));
    expect(calls.declare).toBe(1);
    expect(calls.fetch, "the bytes must not be pulled to discover they are too big").toBe(0);
    expect(state.sendCalls).toBe(0);
  });

  it("a MIXED send is capped by the host's request limit, not by the mailbox's", async () => {
    // 2 MB inline + 2 MB staged = 4 MB, under a 25 MB mailbox and over the 3 MB request surface.
    // The inline half really did ride the body, so the strict term is the right one.
    const { ctx, newDraft } = await setup(25 * MIB);
    const { factory } = fakeAdapter();
    const id = randomUUID();
    const { source } = stagingSource([{
      id, sizeBytes: 2 * MIB, expiresAt: new Date(NOW.getTime() + 3_600_000),
    }]);

    const err = await svc.send(
      ctx, await newDraft(), "mixed-too-big",
      {
        openSendAdapter: factory,
        surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES,
        stagedAttachments: source,
      },
      { attachments: [attachment(2 * MIB)], stagedAttachmentIds: [id] },
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 413 });
    expect(String((err as Error).message)).toContain(String(SEND_ATTACHMENT_MAX_TOTAL_BYTES));
  });
});

describe("A HOST WITH NO STAGING CAPABILITY REFUSES STAGED REFERENCES", () => {
  it("the standalone door's shape: no port, so a staged send is 400 and nothing is sent", async () => {
    // This is what the local engine looks like from here — `stagedAttachments` absent because the
    // host composed no storage. The refusal matters more than it looks: sending the message
    // WITHOUT its files would be a wrong send the user cannot see.
    const { ctx, newDraft } = await setup(null);
    const { factory, state } = fakeAdapter();

    const err = await svc.send(
      ctx, await newDraft(), "no-port",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null },
      { stagedAttachmentIds: [randomUUID()] },
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 400 });
    expect(state.sendCalls).toBe(0);
  });
});

describe("A TICKET THAT IS NOT THERE, OR NO LONGER THERE, ENDS THE SEND", () => {
  it("an unknown id is 404 — and a FOREIGN id is the same 404, never an oracle", async () => {
    const { ctx, newDraft } = await setup(25 * MIB);
    const { factory, state } = fakeAdapter();
    // The source is account-scoped, so another account's ticket is simply absent from `declare` —
    // which is why "not yours" and "never existed" reach this code identically.
    const { source } = stagingSource([]);

    const err = await svc.send(
      ctx, await newDraft(), "staged-missing",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: source },
      { stagedAttachmentIds: [randomUUID()] },
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 404 });
    expect(state.sendCalls).toBe(0);
  });

  it("…but a REPLAY of a SUCCEEDED send is not turned into that error", async () => {
    // THE ENDING THIS GUARD EXISTS TO PREVENT: a send goes out, the client loses the answer, and
    // its same-key retry arrives after the tickets have aged out. If the ticket refusal ran on the
    // replay path the user would be told their message failed while the mail sits in their Sent
    // folder — and a user who is told a send failed sends it again.
    //
    // The refusal is held out of the pre-transaction block and raised beside the disabled-mailbox
    // check, which returns before it on a conflict. Mutation: throw where the fault is found → this
    // goes red while every other case in this file stays green.
    const { ctx, newDraft } = await setup(25 * MIB);
    const { factory, state } = fakeAdapter();
    const id = randomUUID();
    const tickets = [{ id, sizeBytes: 1024, expiresAt: new Date(NOW.getTime() + 3_600_000) }];
    const { source } = stagingSource(tickets);
    const draftId = await newDraft();

    const first = await svc.send(
      ctx, draftId, "replay-key",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: source },
      { stagedAttachmentIds: [id] },
    );
    expect(first.status).toBe("sent");

    // …24 hours pass and the sweep takes the bytes. The SAME key arrives again.
    tickets[0]!.expiresAt = new Date(NOW.getTime() - 1);
    const replay = await svc.send(
      ctx, draftId, "replay-key",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: source },
      { stagedAttachmentIds: [id] },
    );
    expect(replay.status).toBe("sent");
    expect(replay.providerMessageId).toBe(first.providerMessageId);
    // ONE DELIVERY. The replay read the stored outcome and never re-opened the transport.
    expect(state.sendCalls).toBe(1);
  });

  it("an EXPIRED ticket is 409 and says to attach the file again", async () => {
    const { ctx, newDraft } = await setup(25 * MIB);
    const { factory, state } = fakeAdapter();
    const id = randomUUID();
    const { source, calls } = stagingSource([{
      id, sizeBytes: 1024, expiresAt: new Date(NOW.getTime() - 1),
    }]);

    const err = await svc.send(
      ctx, await newDraft(), "staged-expired",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: source },
      { stagedAttachmentIds: [id] },
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 409 });
    expect(String((err as Error).message)).toContain("expired");
    expect(calls.fetch).toBe(0);
    expect(state.sendCalls).toBe(0);
  });
});

/**
 * ═══ A REPEATED TICKET IS ONE FILE, IN BOTH PHASES ═════════════════════════════════════════
 *
 * The staged id list arrived from a client and was used verbatim by both halves of this service:
 * `reserve` summed each ticket's DECLARED size once per occurrence, and `send` handed the same
 * array to `fetch`. Two consequences, and they pull in opposite directions, which is why both are
 * asserted here:
 *
 *  · the download side AMPLIFIES — one valid one-byte ticket named N times was N round trips to
 *    object storage for the same object, and N copies of the file on the message that went out;
 *  · the declaration side over-counts — a 1 MB ticket named five times weighs 5 MB against the
 *    cap, so a send comfortably under the limit is refused 413 for bytes nobody was ever going to
 *    transfer twice.
 *
 * Both phases now walk the same DEDUPLICATED list, which is the only arrangement in which the
 * total that is refused and the total that is pulled are the same number.
 *
 * Mutation watched: restore `input.stagedAttachmentIds ?? []` at either call site — the `reserve`
 * one turns the 413 test red (the send is refused), the `send` one turns the fetch-list and
 * attachment-count assertions red.
 */
describe("dedupeStagedIds — first occurrence wins, order preserved", () => {
  it("collapses repeats and keeps the composer's order", () => {
    expect(dedupeStagedIds(["b", "a", "b", "a", "b"])).toEqual(["b", "a"]);
  });

  it("absent is an empty list, so a caller never branches on undefined", () => {
    expect(dedupeStagedIds(undefined)).toEqual([]);
  });
});

describe("a repeated staged id is ONE file — through the whole send", () => {
  it("named five times: `fetch` is asked for it once, and one copy is delivered", async () => {
    const { ctx, newDraft } = await setup(25 * MIB);
    const { factory, state } = fakeAdapter();
    const id = randomUUID();
    const bytes = Buffer.alloc(64, 3);
    const { source, calls, seen } = stagingSource([{
      id, sizeBytes: bytes.byteLength, expiresAt: new Date(NOW.getTime() + 3_600_000),
      filename: "once.bin", bytes,
    }]);

    const res = await svc.send(
      ctx, await newDraft(), "staged-repeat",
      {
        openSendAdapter: factory,
        surfaceMaxTotalBytes: SEND_ATTACHMENT_MAX_TOTAL_BYTES,
        stagedAttachments: source,
      },
      { stagedAttachmentIds: [id, id, id, id, id] },
    );

    expect(res.status).toBe("sent");
    // WHAT THE PORT WAS ASKED FOR, not merely how many times it was called: a single `fetch` over
    // a five-entry list is exactly the defect, and `calls.fetch === 1` cannot tell the two apart.
    expect(seen.fetch).toEqual([[id]]);
    expect(seen.declare).toEqual([[id]]);
    expect(calls).toEqual({ declare: 1, fetch: 1 });
    // The correctness half. The recipient gets the file once, not five times.
    expect(state.sent[0]!.attachments).toHaveLength(1);
    expect(state.sent[0]!.attachments![0]!.filename).toBe("once.bin");
  });

  it("repeats do NOT inflate the declared total — 1 MB named five times is under a 3 MB cap", async () => {
    // The sharp end of the reserve-side dedupe, and the one a download-only fix leaves broken:
    // summing per occurrence makes this 5 MB and answers 413 for a 1 MB message.
    const { ctx, newDraft } = await setup(3 * MIB);
    const { factory, state } = fakeAdapter();
    const id = randomUUID();
    const { source } = stagingSource([{
      id, sizeBytes: MIB, expiresAt: new Date(NOW.getTime() + 3_600_000), filename: "big.bin",
    }]);

    const res = await svc.send(
      ctx, await newDraft(), "staged-repeat-cap",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: source },
      { stagedAttachmentIds: [id, id, id, id, id] },
    );

    expect(res.status).toBe("sent");
    expect(state.sendCalls).toBe(1);
    expect(state.sent[0]!.attachments).toHaveLength(1);
  });

  it("the cap still bites on DISTINCT tickets — dedupe collapses repeats, never the total", async () => {
    // Never weaken the check being fixed: two different 2 MB tickets are 4 MB and still refused.
    const { ctx, newDraft } = await setup(3 * MIB);
    const { factory, state } = fakeAdapter();
    const a = randomUUID();
    const b = randomUUID();
    const expiresAt = new Date(NOW.getTime() + 3_600_000);
    const { source, calls } = stagingSource([
      { id: a, sizeBytes: 2 * MIB, expiresAt }, { id: b, sizeBytes: 2 * MIB, expiresAt },
    ]);

    const err = await svc.send(
      ctx, await newDraft(), "staged-two-big",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: source },
      { stagedAttachmentIds: [a, b, a, b] },
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ httpStatus: 413 });
    expect(calls.fetch).toBe(0);
    expect(state.sendCalls).toBe(0);
  });
});

describe("SEND_MAX_ATTACHMENT_PARTS — the count ceiling, and where its number comes from", () => {
  it("is 100, the same ceiling a forward's re-attached parts already have", async () => {
    // Pinned to `FORWARD_MAX_PARTS` on purpose: that is the other list of attachment parts this
    // same service assembles onto one outgoing message, and two answers to "how many parts may
    // ride one message" would be a distinction with nothing behind it. If one moves, this fails
    // and whoever moved it has to say why the two lists now differ.
    const { FORWARD_MAX_PARTS } = await import("../src/send-service.js");
    expect(SEND_MAX_ATTACHMENT_PARTS).toBe(100);
    expect(SEND_MAX_ATTACHMENT_PARTS).toBe(FORWARD_MAX_PARTS);
  });
});

/**
 * THE STAGED HALF OF THE DUPLICATE FINGERPRINT — metadata, and the RIGHT metadata.
 *
 * The send path claims a message's content so a second copy cannot be delivered under a fresh key.
 * Staged files are folded into that claim by `(filename, contentType, sizeBytes)` and NEVER by
 * ticket id, and that choice is load-bearing rather than tidy: a re-send under a fresh key
 * RE-STAGES, minting new ids for the same files, so a manifest keyed on ids would differ for an
 * identical message and the guard would miss every send that carries an attachment — which is most
 * of the sends anybody worries about sending twice.
 */
describe("staged files in the duplicate fingerprint", () => {
  it("two sends whose only difference is a staged file's FILENAME both go", async () => {
    const { ctx, newDraft } = await setup(50 * MIB);
    const { factory, state } = fakeAdapter();
    const expiresAt = new Date(NOW.getTime() + 3_600_000);
    const { source } = stagingSource([
      { id: "t-one", sizeBytes: 1024, expiresAt, filename: "report.pdf", contentType: "application/pdf" },
      { id: "t-two", sizeBytes: 1024, expiresAt, filename: "invoice.pdf", contentType: "application/pdf" },
    ]);

    const first = await svc.send(ctx, await newDraft(), "fp-name-1",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: source },
      { stagedAttachmentIds: ["t-one"] });
    expect(first.status).toBe("sent");

    // Same recipients, same subject, same body, same size, same type — a DIFFERENT file.
    const second = await svc.send(ctx, await newDraft(), "fp-name-2",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: source },
      { stagedAttachmentIds: ["t-two"] });
    expect(second.status, "a different attachment is a different message").toBe("sent");
    expect(state.sendCalls).toBe(2);
  });

  /**
   * THE POLICY MOVED BY REVIEW, AND THIS CASE ASSERTED THE OLD ONE.
   *
   * It used to expect a re-staged identical file to be REFUSED as a duplicate — i.e. that staged
   * sends were covered by the content claim. They are not, deliberately, and the reason is measured
   * rather than argued: the claim could only identify a staged file by name, type and size, and a
   * corrected 5 MiB file keeping all three was refused as already sent, with only the original ever
   * delivered. A silently unsent correction is the worst ending this path has.
   *
   * Folding by ticket id instead would cure that and protect nothing, since a re-send under a fresh
   * key re-stages and the ids always differ. So a staged send is excluded outright — and this case
   * now asserts THAT, including the protection it costs, so the limit is written down where somebody
   * changing it will see it.
   *
   * What still guards a staged send: the client's durable key, which now hashes attachment CONTENT,
   * and the refusal of any draft not in `draft` status.
   */
  it("a staged send is NOT covered by the content claim — the cost of excluding it, stated", async () => {
    const { ctx, newDraft } = await setup(50 * MIB);
    const { factory, state } = fakeAdapter();
    const expiresAt = new Date(NOW.getTime() + 3_600_000);
    const { source } = stagingSource([
      { id: "t-first-upload", sizeBytes: 2048, expiresAt, filename: "report.pdf", contentType: "application/pdf" },
      { id: "t-second-upload", sizeBytes: 2048, expiresAt, filename: "report.pdf", contentType: "application/pdf" },
    ]);

    const first = await svc.send(ctx, await newDraft(), "fp-restage-1",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: source },
      { stagedAttachmentIds: ["t-first-upload"] });
    expect(first.status).toBe("sent");

    // The same file, re-staged, under a fresh key: it GOES. That is the protection this exclusion
    // gives up, and it is the direction that costs a duplicate rather than a lost message.
    const second = await svc.send(ctx, await newDraft(), "fp-restage-2",
      { openSendAdapter: factory, surfaceMaxTotalBytes: null, stagedAttachments: source },
      { stagedAttachmentIds: ["t-second-upload"] });
    expect(second.status, "a staged send is not refused by the content claim").toBe("sent");
    expect(state.sendCalls).toBe(2);
  });
});
