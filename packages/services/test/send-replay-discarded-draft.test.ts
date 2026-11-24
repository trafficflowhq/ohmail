import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts, outboundSends } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { SendService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";

/**
 * ═══ REPLAYING A KEY WHOSE MESSAGE WAS DISCARDED ═════════════════════════════════════════
 *
 * ── THE STATE THIS IS ABOUT, AND WHY IT IS NEW ───────────────────────────────────────────
 *
 * `outbound_sends.draft_id` is nullable `ON DELETE SET NULL` since mail 0095, so that a person
 * can discard a draft whose send is definitively over while the record of the attempt survives.
 * A terminal reservation with no draft is therefore a state the database can now hold, and
 * `resumeExisting` — the same-key replay branch — is the one reader that meets it.
 *
 * ── WHY THE ANSWER IS A NAMED REFUSAL AND NOT A `draftId` ────────────────────────────────
 *
 * The replay row is found by `(account_id, idempotency_key)` ALONE. The caller's draft id is a
 * separate argument, so the reservation here need not be about the message the caller is
 * holding — which is what makes the obvious answers wrong rather than merely untidy:
 *
 *  · answering with the CALLER's `draftId` tells the client that the draft it currently has
 *    open was already sent. That is a false statement about somebody's mail, on the surface
 *    they are looking at, and the composer would unlock a message that never left.
 *  · widening `SendState.draftId` to `string | null` pushes the same question into a client
 *    that has no branch for it, for a sequence a live client cannot produce: the durable send
 *    key is released on EVERY terminal outcome, so the next press mints a fresh one.
 *
 * So reaching this arm means a STALE client is replaying a key for a message that no longer
 * exists, and the honest answer is to say so and let it start a new send. The adapter maps the
 * code to a terminal rollback by inheritance rather than by a new branch: a 409 carrying an
 * `error.code` is not retryable, so `dispatch` rolls the overlay back instead of replaying the
 * refusal under the same key for ever.
 *
 * ── THE SHAPE OF THESE CASES ─────────────────────────────────────────────────────────────
 *
 * The reservation is SEEDED rather than produced by a real failing send, deliberately: what is
 * under test is how the replay branch reads a terminal row, and seeding states the precondition
 * in one line instead of depending on which path happens to produce a `failed` row today.
 *
 * The second case is the POSITIVE CONTROL and it is the one that fails if the refusal is written
 * too widely — an ordinary same-key replay, whose draft is still there, must keep answering
 * exactly what it answered before this existed.
 */
const svc = new SendService();
const NOW = new Date("2026-09-08T12:00:00Z");

function fakeAdapter() {
  const state = { sendCalls: 0 };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      state.sendCalls += 1;
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() { return false; },
    async close() {},
  });
  return { factory, state };
}

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: "mila@lichtgrat.example",
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  const newDraft = async (): Promise<string> => {
    const [d] = await db.insert(drafts).values({
      accountId, mailboxId: mb!.id, subject: "Re: hi", body: "Thanks!",
      to: [{ name: null, address: "you@example.com" }], status: "draft",
    }).returning();
    return d!.id;
  };
  /** A terminal reservation under `key`, pointing at `draftId` (or at nothing). */
  const seedSend = async (
    key: string, status: "sent" | "failed" | "unverified", draftId: string | null,
  ): Promise<void> => {
    await db.insert(outboundSends).values({
      accountId, idempotencyKey: key, draftId,
      mintedMessageId: `<${randomUUID()}@lichtgrat.example>`, status,
    });
  };
  return { db, ctx, newDraft, seedSend };
}

/** The thrown refusal, or `null` when the call answered. */
async function refusalOf(p: Promise<unknown>): Promise<{ httpStatus?: number; code?: string } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    return e as { httpStatus?: number; code?: string };
  }
}

describe("a same-key replay whose message was discarded is refused by name", () => {
  /**
   * Mutation: delete the `row.draftId === null` arm from `resumeExisting`. Real failure text:
   *   AssertionError: replaying a discarded `sent` key was not refused …
   *     expected null not to be null
   * (with the arm gone, `draftOfTerminalAttempt` throws 500 instead — which is the second half of
   * the pair working: the state is never allowed to become a fabricated `draftId`.)
   */
  /* `unverified` joined the set when the discard of a held row was admitted: the ledger row
     survives with `resolved_by = 'discard'`, and a stale client replaying that key must be told
     the message is gone rather than sent to look in Sent for it. */
  it.each([["sent"], ["failed"], ["unverified"]] as const)(
    "a terminal `%s` reservation whose draft is gone answers 409 send_key_draft_discarded",
    async (status) => {
      const { ctx, newDraft, seedSend } = await setup();
      const { factory, state } = fakeAdapter();
      await seedSend("stale-key", status, null);

      // The dangerous sequence: a stale client replays the old key while composing a NEW message.
      const composing = await newDraft();
      const err = await refusalOf(svc.send(ctx, composing, "stale-key", { openSendAdapter: factory }));

      expect(err, `replaying a discarded \`${status}\` key was not refused`).not.toBeNull();
      expect(err!.httpStatus).toBe(409);
      expect(
        err!.code,
        "the refusal is not the named one, so the client cannot tell it from a send already in "
        + "progress and will keep replaying it",
      ).toBe("send_key_draft_discarded");
      expect(state.sendCalls, "a refused replay opened SMTP").toBe(0);
    },
  );

  /**
   * THE POSITIVE CONTROL. Every other case here is a refusal, and a refusal written one line too
   * wide would break the ordinary same-key retry — the mechanism that stops a double delivery.
   */
  it("an ordinary same-key replay, draft still present, still replays its stored outcome", async () => {
    const { ctx, newDraft, seedSend } = await setup();
    const { factory, state } = fakeAdapter();
    const original = await newDraft();
    await seedSend("live-key", "sent", original);

    const res = await svc.send(ctx, original, "live-key", { openSendAdapter: factory });

    expect(res.status, "the ordinary replay stopped reporting the stored outcome").toBe("sent");
    expect(
      res.draftId,
      "the replay answered about a different row than the reservation names",
    ).toBe(original);
    expect(
      state.sendCalls,
      "the replay DELIVERED AGAIN — the reservation stopped being a replay guard",
    ).toBe(0);
  });

  /** And the `failed` replay still speaks its own terminal answer when the draft is there. */
  it("a `failed` replay with its draft present still answers failed, not the discard refusal", async () => {
    const { ctx, newDraft, seedSend } = await setup();
    const { factory } = fakeAdapter();
    const original = await newDraft();
    await seedSend("failed-key", "failed", original);

    const res = await svc.send(ctx, original, "failed-key", { openSendAdapter: factory });

    expect(res.status).toBe("failed");
    expect(res.draftId).toBe(original);
  });
});
