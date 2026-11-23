import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { ModelDeclinedError, type DraftPort } from "@trafficflow/core/mail";
import { drafts, type AccessVerdict } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { DraftingService } from "@trafficflow/services";
import { fakeSpendPort } from "../../services/test/helpers/spend-port-fake.js";
import { makeDeps, seedSession, seedMessage, seedMailbox, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const pgUp = await realPgAvailable();

describe.skipIf(!pgUp)("paid draft receipts", () => {
  let owned: OwnedDb;
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 60_000);
  afterAll(async () => { await owned?.close(); });

  async function setup(drafter: DraftPort, timed: boolean, accessExpiresAt?: Date) {
    const db = owned.db;
    const { deps, clock } = await makeDeps(FIXED_NOW, {}, { db, drafter });
    const session = await seedSession(db, { now: FIXED_NOW, accessExpiresAt });
    const mailboxId = await seedMailbox(db, { accountId: session.accountId });
    const { id } = await seedMessage(db, { accountId: session.accountId, mailboxId });
    const credits = fakeSpendPort();
    credits.exclusive();
    const access = async (): Promise<AccessVerdict> => ({
      ok: true, limits: { mailboxes: 5, storageBytes: 1_000, canAddMailbox: true, aiEnabled: true },
    });
    const metered: ApiDeps = {
      ...deps,
      services: {
        ...deps.services!,
        entitlementsPort: {
          ...credits, access, accessOrFault: access, manageLink: async () => null, releaseAccount: async () => "none",
        },
        drafting: new DraftingService(undefined, undefined, timed ? {
          invocationBudgetMs: 1_500,
          admission: { spendCallCeilingMs: 0, minModelMs: 0, closeReserveMs: 500 },
        } : {}),
      },
      refundObligations: { async owe() {}, async settle() {} },
    };
    return { db, clock, session, mailboxId, id, credits, metered };
  }

  it.each([
    ["max_tokens", 422, "ai_draft_declined"],
    ["timeout", 503, "ai_draft_failed"],
  ] as const)("replays a paid %s after preview without another model call or hold", async (stop, status, code) => {
    let calls = 0;
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => { finish = resolve; });
    const drafter: DraftPort = {
      async draft(_input, options) {
        calls++;
        options?.onPreview?.("Hello");
        if (calls > 1) return { body: "A new draft.", subject: "Re: Hello", rationale: "" };
        if (stop === "timeout") return new Promise<never>(() => {});
        await writing;
        throw new ModelDeclinedError("max_tokens", null);
      },
    };
    const { db, session, mailboxId, id, credits, metered } = await setup(drafter, stop === "timeout");
    const fromText = stop === "timeout";
    const buy = (key: string, accept = "application/x-ndjson") => app.handle(req(
      "POST", fromText ? "/drafts/from-text" : `/messages/${id}/draft`, {
        bearer: session.token, headers: { Accept: accept, "Idempotency-Key": key },
        ...(fromText ? { body: JSON.stringify({ mailboxId, text: "Write a welcome note." }) } : {}),
      },
    ), { ...metered, session: null, idempotency: null });

    const first = await buy("same-draft");
    try {
      expect(first.headers.get("content-type")).toBe("application/x-ndjson");
      if (!fromText) {
        const concurrent = await buy("same-draft", "application/json");
        expect(concurrent.status).toBe(409);
        expect((await concurrent.json()).error.code).toBe("idempotency_in_progress");
      }
    } finally {
      finish();
    }
    const frames = (await first.text()).trim().split("\n").map((line) => JSON.parse(line));
    const replay = await buy("same-draft", "application/json");
    expect(calls).toBe(1);
    expect(credits.spends).toHaveLength(1);
    expect(credits.releases).toEqual([expect.objectContaining({ refund: false })]);
    expect(frames[0]).toEqual({ type: "preview", text: "Hello" });
    const body = await replay.json();
    expect(replay.status).toBe(status);
    expect(body.error).toMatchObject({ code, details: { credits: "used" }, retryable: false });
    expect(frames[1]).toMatchObject({ type: "result", status, body });
    expect(await db.select({ id: drafts.id }).from(drafts)
      .where(eq(drafts.accountId, session.accountId))).toEqual([]);

    const next = await buy("new-draft", "application/json");
    expect(next.status).toBe(202);
    const saved = await buy("new-draft", "application/json");
    expect(saved.status).toBe(202);
    expect(saved.headers.get("x-sync-seq")).toBe(next.headers.get("x-sync-seq"));
    expect(await saved.json()).toEqual(await next.json());
    expect(calls).toBe(2);
    expect(credits.spends.map(({ outcome }) => outcome.verdict)).toEqual(["ok", "ok"]);
  });

  it("recovers an expired pending receipt after a failed save without charging again", async () => {
    let calls = 0;
    const { db, clock, session, id, credits, metered } = await setup({
      async draft(_input, options) {
        if (++calls === 1) {
          options?.onPreview?.("Hello");
          throw new ModelDeclinedError("max_tokens", null);
        }
        return { body: "Hello again.", subject: "Re: Hello", rationale: "" };
      },
    }, true, new Date(FIXED_NOW.getTime() + 25 * 60 * 60_000));
    const buy = (accept = "application/json") => app.handle(req("POST", `/messages/${id}/draft`, {
      bearer: session.token, headers: { Accept: accept, "Idempotency-Key": "pending-draft" },
    }), { ...metered, session: null, idempotency: null });

    // Simulate losing the final receipt while the pending claim stays durable.
    await db.execute(sql`ALTER TABLE idempotency_keys ADD CONSTRAINT draft_receipt_unavailable
      CHECK (response_status <> 422) NOT VALID`);
    try {
      const response = await buy("application/x-ndjson");
      expect(response.headers.get("content-type")).toBe("application/x-ndjson");
      const frames = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
      expect(frames[0]).toEqual({ type: "preview", text: "Hello" });
      expect(frames[1]).toMatchObject({ type: "result", status: 500 });
    } finally {
      await db.execute(sql`ALTER TABLE idempotency_keys DROP CONSTRAINT draft_receipt_unavailable`);
    }

    const pending = await buy();
    expect(pending.status).toBe(409);
    expect((await pending.json()).error.code).toBe("idempotency_in_progress");
    expect(credits.releases).toEqual([expect.objectContaining({ refund: false })]);

    clock.advance(30_000);
    const recovered = await buy();
    expect(recovered.status).toBe(202);
    expect(credits.spends.map(({ outcome }) => outcome.verdict)).toEqual(["ok", "duplicate"]);

    clock.advance(23 * 60 * 60_000);
    const replay = await buy();
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(await recovered.json());
    expect(calls).toBe(2);
    expect(credits.spends).toHaveLength(2);
  });
});
