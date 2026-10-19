import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts, outboundSends } from "@trafficflow/db";
import type { OpenSendAdapter } from "@trafficflow/core";
import { SendService, ServiceError, SEND_FAILED_SENTENCE, SEND_TIMEOUT_SENTENCE } from "../src/index.js";
import type { ServiceContext, StagedAttachmentSource } from "../src/index.js";
import {
  MailServerUnreachable, SEND_UNREACHABLE_SENTENCE, mailServerUnreachable,
} from "../src/send-service.js";

/**
 * AN UNREACHABLE MAIL SERVER IS A REFUSAL, AND ONLY THE MAIL SERVER'S DIAL CAN SAY SO. The
 * classifier is an allow-list by code; the refusal is raised at the dial and the forward's reads
 * of the original, never for our own object storage. Mutation watched: an empty allow-list
 * reddens the table and the window case; `atMailServer` bypassed at the dial reddens the window
 * case; the ceiling's status pinned to 504 reddens the dial half of the ceiling case.
 */

const NOW = new Date("2026-09-26T12:00:00Z");
const coded = (code: string): Error => Object.assign(new Error(`dial failed: ${code}`), { code });
const hang = <T,>(): Promise<T> => new Promise<T>(() => { /* never settles */ });

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "u@outage.example",
  }).returning();
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "r" };
  const newDraft = async (scheduledKey?: string): Promise<string> => {
    const [d] = await db.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "Re: hi", body: "Thanks!",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
      ...(scheduledKey ? { sendAt: NOW, sendKey: scheduledKey } : {}),
    }).returning();
    return d!.id;
  };
  return { db, ctx, newDraft };
}

/** Our own object storage, one ticket, whose fetch does what it is told. */
function storage(fetch: () => Promise<never>): StagedAttachmentSource {
  return {
    async declare(_a, ids) {
      return ids.map((id) => ({
        id, sizeBytes: 10, expiresAt: new Date(NOW.getTime() + 60_000),
        filename: "f.bin", contentType: "application/octet-stream",
      }));
    },
    fetch,
  };
}

const refusal = (p: Promise<unknown>): Promise<{ code?: string; httpStatus?: number; message?: string; retryable?: boolean } | null> =>
  p.then(() => null, (e: unknown) => e as never);

describe("mailServerUnreachable — which dial failures mean the server could not be reached", () => {
  it("admits the socket, DNS and imapflow connection codes", () => {
    for (const code of [
      "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET",
      "ETIMEDOUT", "CONNECT_TIMEOUT", "GREETING_TIMEOUT", "ETIMEOUT", "NoConnection",
      "EConnectionClosed", "ClosedAfterConnectText", "ClosedAfterConnectTLS",
    ]) expect(mailServerUnreachable(coded(code)), code).toBe(true);
  });

  it("refuses everything else: TLS, login, our own faults, no code, a primitive, a typed refusal", () => {
    for (const code of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "EAUTH", "ETLS",
      "UPGRADE_TIMEOUT", "ERR_INVALID_ARG_TYPE", "EENVELOPE", "28P01"]) {
      expect(mailServerUnreachable(coded(code)), code).toBe(false);
    }
    expect(mailServerUnreachable(new TypeError("x is undefined"))).toBe(false);
    expect(mailServerUnreachable("ECONNREFUSED")).toBe(false);
    expect(mailServerUnreachable(null)).toBe(false);
    expect(mailServerUnreachable(Object.assign(new ServiceError("x", 502, "y"), { code: "ECONNREFUSED" }))).toBe(false);
  });
});

describe("the pre-SMTP window when the mail server cannot be reached", () => {
  it("a refused dial is the 424 refusal: not retryable, the send failed, the draft kept", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft();
    const dialErr = coded("ECONNREFUSED");
    const openSendAdapter: OpenSendAdapter = async () => { throw dialErr; };
    const e = await refusal(new SendService().send(ctx, draftId, "k-refused", { openSendAdapter }));
    expect(e).toBeInstanceOf(MailServerUnreachable);
    expect({ code: e!.code, httpStatus: e!.httpStatus, retryable: e!.retryable, message: e!.message })
      .toEqual({ code: "send_unreachable", httpStatus: 424, retryable: false, message: SEND_UNREACHABLE_SENTENCE });
    expect((e as { cause?: unknown }).cause, "the dial's own error rides for the log").toBe(dialErr);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status).toBe("failed");
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect({ status: d!.status, sendError: d!.sendError }).toEqual({ status: "draft", sendError: null });
  });

  it("a SCHEDULED send files the unreachable sentence on its row", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft("appt-1");
    const openSendAdapter: OpenSendAdapter = async () => { throw coded("ENOTFOUND"); };
    await refusal(new SendService().send(ctx, draftId, "appt-1", { openSendAdapter }));
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect({ sendError: d!.sendError, sendKey: d!.sendKey }).toEqual({ sendError: SEND_UNREACHABLE_SENTENCE, sendKey: null });
  });

  it("CONTROL: our own storage refusing with the same errno stays OUR fault — the 500, never the refusal", async () => {
    const { db, ctx, newDraft } = await setup();
    const draftId = await newDraft("appt-2");
    let dials = 0;
    const openSendAdapter: OpenSendAdapter = async () => { dials += 1; throw coded("ECONNREFUSED"); };
    const storageErr = coded("ECONNREFUSED");
    const stagedAttachments = storage(async () => { throw storageErr; });
    const e = await refusal(new SendService().send(ctx, draftId, "appt-2",
      { openSendAdapter, stagedAttachments, surfaceMaxTotalBytes: null }, { stagedAttachmentIds: ["t1"] }));
    expect(e).not.toBeInstanceOf(MailServerUnreachable);
    expect({ code: e!.code, httpStatus: e!.httpStatus, retryable: e!.retryable, cause: (e as { cause?: unknown }).cause })
      .toEqual({ code: "internal", httpStatus: 500, retryable: false, cause: storageErr });
    expect(dials, "the storage read failed first; the mail server was never dialled").toBe(0);
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.sendError).toBe(SEND_FAILED_SENTENCE);
  });
});

describe("the attempt ceiling says whose clock ran out", () => {
  it("during the DIAL: send_timeout at 424 — the mail server's", async () => {
    const { ctx, newDraft } = await setup();
    const openSendAdapter: OpenSendAdapter = async () => hang();
    const e = await refusal(new SendService().send(ctx, await newDraft(), "k-dial", { openSendAdapter, attemptCeilingMs: 20 }));
    expect({ code: e!.code, httpStatus: e!.httpStatus, message: e!.message })
      .toEqual({ code: "send_timeout", httpStatus: 424, message: SEND_TIMEOUT_SENTENCE });
  });

  it("CONTROL: during ASSEMBLY (our storage): send_timeout keeps its 504", async () => {
    const { ctx, newDraft } = await setup();
    let dials = 0;
    const openSendAdapter: OpenSendAdapter = async () => { dials += 1; return hang(); };
    const e = await refusal(new SendService().send(ctx, await newDraft(), "k-asm",
      { openSendAdapter, attemptCeilingMs: 20, stagedAttachments: storage(() => hang()), surfaceMaxTotalBytes: null },
      { stagedAttachmentIds: ["t1"] }));
    expect({ code: e!.code, httpStatus: e!.httpStatus }).toEqual({ code: "send_timeout", httpStatus: 504 });
    expect(dials).toBe(0);
  });
});
