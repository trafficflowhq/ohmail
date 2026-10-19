import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts, outboundSends } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendNotSubmitted } from "@trafficflow/core";
import {
  SendService, SEND_LOGIN_REFUSED_SENTENCE, SEND_NOT_SECURED_SENTENCE, ServiceError,
} from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import {
  MailServerBusy, MailServerRefused, MailServerUnreachable, SEND_UNREACHABLE_SENTENCE, mailServerRefusalOf,
} from "../src/send-service.js";

/**
 * A REFUSAL THE PERSON'S MAIL SERVER MADE IS A 424 WITH ITS OWN CODE, AT EVERY EXCHANGE. The
 * classifier reads structure only; the window gives the IMAP dial the SMTP leg's codes, a socket
 * that never connected is unreachable, and a Sent check the mail server failed after an ambiguous
 * SMTP error leaves the reservation for verify-by-Sent. The server's own "not now" is busy, not a
 * refused password. Controls: our own faults stay unclassified.
 */

const svc = new SendService();
const NOW = new Date("2026-09-27T10:00:00Z");
const shaped = (fields: Record<string, unknown>): Error => Object.assign(new Error("dial"), fields);
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

function adapter(send: () => Error | null, probe: () => Promise<boolean> = async () => false) {
  const state = { sends: 0, probed: 0 };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sends += 1;
      const err = send();
      if (err) throw err;
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { state.probed += 1; return probe(); },
    async close() { /* nothing */ },
  });
  return { factory, state };
}

async function setup(scheduledKey?: string) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "owner@example.test" }).returning();
  const ctx: ServiceContext = { db, accountId, userId: null, now: () => NOW, requestId: "r" };
  const [d] = await db.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "Hello", body: "Body",
    to: [{ name: null, address: "you@example.test" }], status: "draft",
    ...(scheduledKey ? { sendAt: NOW, sendKey: scheduledKey } : {}),
  }).returning();
  const row = async () => (await db.select().from(outboundSends).where(eq(outboundSends.draftId, d!.id)))[0]!;
  const draft = async () => (await db.select().from(drafts).where(eq(drafts.id, d!.id)))[0]!;
  return { ctx, draftId: d!.id, row, draft };
}

describe("mailServerRefusalOf — what the person's mail server did to a dial", () => {
  it("names the three refusals by structure", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "GREETING_TIMEOUT", "NoConnection"]) {
      expect(mailServerRefusalOf(shaped({ code })), code).toBe("unreachable");
    }
    for (const code of ["ERR_SSL_WRONG_VERSION_NUMBER", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT"]) {
      expect(mailServerRefusalOf(shaped({ code })), code).toBe("not_secured");
    }
    // imapflow stamps the flag on the TLS failure too; the TLS code is the better evidence.
    expect(mailServerRefusalOf(shaped({ code: "DEPTH_ZERO_SELF_SIGNED_CERT", authenticationFailed: true }))).toBe("not_secured");
    expect(mailServerRefusalOf(shaped({ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }))).toBe("login_refused");
    expect(mailServerRefusalOf(shaped({ authenticationFailed: true }))).toBe("login_refused");
  });

  it("the server's own 'not now' is busy, never a verdict on the password", () => {
    expect(mailServerRefusalOf(shaped({ authenticationFailed: true, serverResponseCode: "UNAVAILABLE" }))).toBe("busy");
    expect(mailServerRefusalOf(shaped({ authenticationFailed: true, serverResponseCode: "LIMIT" }))).toBe("busy");
    expect(mailServerRefusalOf(shaped({ authenticationFailed: true, code: "ETHROTTLE" }))).toBe("busy");
    expect(mailServerRefusalOf(shaped({ responseStatus: "NO" }))).toBe("busy");
  });

  it("CONTROL: our faults and typed refusals stay unclassified", () => {
    expect(mailServerRefusalOf(shaped({ code: "EAUTH" }))).toBeNull();
    expect(mailServerRefusalOf(new TypeError("x is undefined"))).toBeNull();
    expect(mailServerRefusalOf(Object.assign(new ServiceError("x", 502, "y"), { code: "ECONNREFUSED" }))).toBeNull();
    expect(mailServerRefusalOf("ECONNREFUSED")).toBeNull();
    expect(mailServerRefusalOf(null)).toBeNull();
  });
});

describe("the IMAP dial inside the pre-SMTP window", () => {
  const cases: Array<[string, Error, string, string]> = [
    ["a refused LOGIN", shaped({ authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" }), "send_login_refused", SEND_LOGIN_REFUSED_SENTENCE],
    ["a TLS handshake that failed", shaped({ code: "ERR_SSL_WRONG_VERSION_NUMBER" }), "send_not_secured", SEND_NOT_SECURED_SENTENCE],
  ];
  for (const [what, dialErr, code, sentence] of cases) {
    it(`${what}: 424 ${code}, not retryable, the send failed, the draft kept`, async () => {
      const { ctx, draftId, row, draft } = await setup();
      const openSendAdapter: OpenSendAdapter = async () => { throw dialErr; };
      const e = await refusal(svc.send(ctx, draftId, "k-imap", { openSendAdapter })) as MailServerRefused;
      expect(e).toBeInstanceOf(MailServerRefused);
      expect({ code: e.code, httpStatus: e.httpStatus, retryable: e.retryable, message: e.message })
        .toEqual({ code, httpStatus: 424, retryable: false, message: sentence });
      expect((e as { cause?: unknown }).cause).toBe(dialErr);
      expect((await row()).status).toBe("failed");
      expect((await draft()).status).toBe("draft");
    });
  }

  it("a SCHEDULED send files the refusal's sentence on its row", async () => {
    const { ctx, draftId, draft } = await setup("appt-login");
    const openSendAdapter: OpenSendAdapter = async () => { throw shaped({ authenticationFailed: true }); };
    await refusal(svc.send(ctx, draftId, "appt-login", { openSendAdapter }));
    expect((await draft()).sendError).toBe(SEND_LOGIN_REFUSED_SENTENCE);
  });

  it("a LOGIN the server answered 'not now' is send_busy at 424, final where nothing replays it", async () => {
    const { ctx, draftId, row } = await setup();
    const busy = shaped({ authenticationFailed: true, serverResponseCode: "UNAVAILABLE" });
    const openSendAdapter: OpenSendAdapter = async () => { throw busy; };
    const e = await refusal(svc.send(ctx, draftId, "k-busy", { openSendAdapter })) as MailServerBusy;
    expect(e).toBeInstanceOf(MailServerBusy);
    expect({ code: e.code, httpStatus: e.httpStatus, retryable: e.retryable, cause: (e as { cause?: unknown }).cause })
      .toEqual({ code: "send_busy", httpStatus: 424, retryable: false, cause: busy });
    expect((await row()).status).toBe("failed");
  });
});

describe("the SMTP leg", () => {
  it("a socket that never connected is send_unreachable at 424, never probed, never unverified", async () => {
    const { ctx, draftId, row } = await setup();
    const { factory, state } = adapter(() => new SendNotSubmitted("connect", shaped({ code: "ESOCKET", syscall: "connect" })));
    const e = await refusal(svc.send(ctx, draftId, "k-conn", { openSendAdapter: factory })) as ServiceError;
    expect(e).toBeInstanceOf(MailServerUnreachable);
    expect({ code: e.code, httpStatus: e.httpStatus, message: e.message })
      .toEqual({ code: "send_unreachable", httpStatus: 424, message: SEND_UNREACHABLE_SENTENCE });
    expect(state.probed).toBe(0);
    expect((await row()).status).toBe("failed");
  });

  it("never secured / login refused keep their codes and answer 424", async () => {
    for (const [step, code] of [["secure", "send_not_secured"], ["login", "send_login_refused"]] as const) {
      const { ctx, draftId } = await setup();
      const { factory } = adapter(() => new SendNotSubmitted(step, shaped({})));
      const e = await refusal(svc.send(ctx, draftId, `k-${step}`, { openSendAdapter: factory })) as ServiceError;
      expect({ code: e.code, httpStatus: e.httpStatus, retryable: e.retryable }).toEqual({ code, httpStatus: 424, retryable: false });
    }
  });
});

describe("the Sent check after an ambiguous SMTP error", () => {
  const ambiguous = () => shaped({ code: "ECONNECTION" });

  for (const [what, probeErr] of [
    ["the connection reset", shaped({ code: "ECONNRESET" })],
    ["the read ceiling", shaped({ code: "EIMAPBOUND" })],
  ] as const) {
    it(`${what}: queued, the reservation pending with its key`, async () => {
      const { ctx, draftId, row } = await setup();
      const { factory, state } = adapter(ambiguous, async () => { throw probeErr; });
      const res = await svc.send(ctx, draftId, "k-probe", { openSendAdapter: factory });
      expect(res.status).toBe("queued");
      expect(state.probed).toBe(1);
      expect((await row()).status).toBe("pending");
    });
  }

  it("CONTROL: a probe fault of ours propagates and the reservation stays pending", async () => {
    const { ctx, draftId, row } = await setup();
    const ours = new TypeError("cannot read properties of undefined");
    const { factory } = adapter(ambiguous, async () => { throw ours; });
    expect(await refusal(svc.send(ctx, draftId, "k-ours", { openSendAdapter: factory }))).toBe(ours);
    expect((await row()).status).toBe("pending");
  });
});
