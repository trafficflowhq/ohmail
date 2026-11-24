import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts, outboundSends } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendNotSubmitted } from "@trafficflow/core";
import {
  SendService, SEND_LOGIN_REFUSED_SENTENCE, SEND_NOT_SECURED_SENTENCE, ServiceError, dbFor,
} from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * A SEND THAT NEVER OFFERED THE MESSAGE IS TOLD AS FAILED, WITH THE STEP — never "couldn't confirm".
 *
 * On a phone whose submission port upgrades with STARTTLS, a session that died securing the
 * connection used to reach this service as an ordinary SMTP throw: probe Sent, miss, `unverified`,
 * and a composer locked over mail that provably never left. `SendNotSubmitted` is the adapter's
 * proof that no envelope was offered; the send finalizes `failed`, names the step, never probes,
 * and the same message may be sent again. Mutation: drop the arm in `send()` → `unverified`.
 */

const svc = new SendService();
const NOW = new Date("2026-09-26T10:00:00Z");

function adapter(throwing: () => Error | null) {
  const state = { sends: 0, probed: 0 };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sends += 1;
      const err = throwing();
      if (err) throw err;
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { state.probed += 1; return false; },
    async close() { /* nothing */ },
  });
  return { factory, state };
}

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: "owner@example.test" }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  const [d] = await db.insert(drafts).values({
    accountId, mailboxId: mb!.id, subject: "Hello", body: "Body",
    to: [{ name: null, address: "you@example.test" }], status: "draft",
  }).returning();
  return { db, ctx, draftId: d!.id };
}

const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe("SendService — a submission that never offered the message", () => {
  it("never secured: failed with its sentence, not retryable, no Sent probe, the draft back to draft", async () => {
    const { db, ctx, draftId } = await setup();
    const { factory, state } = adapter(() => new SendNotSubmitted("secure", new Error("ETLS")));
    const err = await refusal(svc.send(ctx, draftId, "k1", { openSendAdapter: factory }));
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("send_not_secured");
    expect((err as ServiceError).message).toBe(SEND_NOT_SECURED_SENTENCE);
    expect((err as ServiceError).retryable).toBe(false);
    expect(state.probed).toBe(0);
    const [row] = await db.select().from(outboundSends).where(eq(outboundSends.draftId, draftId));
    expect(row!.status).toBe("failed");
    const [d] = await db.select().from(drafts).where(eq(drafts.id, draftId));
    expect(d!.status).toBe("draft");
  });

  it("a refused login: failed with its own sentence", async () => {
    const { ctx, draftId } = await setup();
    const { factory } = adapter(() => new SendNotSubmitted("login", new Error("EAUTH")));
    const err = await refusal(svc.send(ctx, draftId, "k1", { openSendAdapter: factory }));
    expect((err as ServiceError).code).toBe("send_login_refused");
    expect((err as ServiceError).message).toBe(SEND_LOGIN_REFUSED_SENTENCE);
  });

  it("the same message goes on a second press once the first never left", async () => {
    const { ctx, draftId } = await setup();
    let first = true;
    const { factory, state } = adapter(() => (first ? ((first = false), new SendNotSubmitted("secure", new Error("ETLS"))) : null));
    await refusal(svc.send(ctx, draftId, "k1", { openSendAdapter: factory }));
    const res = await svc.send(ctx, draftId, "k2", { openSendAdapter: factory });
    expect(res.status).toBe("sent");
    expect(state.sends).toBe(2);
  });

  it("the ambiguous control: any other SMTP throw still probes Sent and reads unverified", async () => {
    const { ctx, draftId } = await setup();
    const { factory, state } = adapter(() => Object.assign(new Error("reset"), { code: "ECONNECTION" }));
    const res = await svc.send(ctx, draftId, "k1", { openSendAdapter: factory });
    expect(res.status).toBe("unverified");
    expect(state.probed).toBe(1);
  });
});
