import { describe, it, expect, vi } from "vitest";
import { createApp, apiRoutes } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedMessage, req, FIXED_NOW } from "./helpers.js";

/**
 * POWER THROUGH MUST NOT READ THE PILE IT EXISTS TO CLEAR.
 *
 * `GET /views/power-through` answers one message and a count. It used to produce that answer
 * from a query with NO `limit`: every unread INBOX id for the account was ordered, sent to the
 * process, and then used for exactly two things — `rows[0]` for the message on screen and
 * `rows.length` for `remaining`. So the user with the most unread mail, who is the user this
 * feature is for, paid the most for every screen — and advancing repeated it: N ids, then N-1,
 * then N-2, one full transfer per message dismissed.
 *
 * A CORRECTNESS TEST CANNOT SEE THIS. The old code returned exactly the same three values, so
 * every assertion about `current`, `remaining` and `nextCursor` passes either way — which is why
 * `triage.test.ts` was green throughout. What distinguishes them is how many rows the driver
 * hands back, so this measures result sets at the database client and compares the largest
 * single result set with the pile.
 *
 * THE MUTATION THAT MAKES THIS RED is deleting `.limit(2)` from the page query in
 * `packages/services/src/triage-service.ts#powerThrough`. Watched fail and restored.
 */
const app = createApp(apiRoutes);
const PILE = 40;

type Query = (...args: unknown[]) => Promise<{ rows: unknown[] }>;

describe("GET /views/power-through is bounded by the screen, not by the pile", () => {
  it(`counts ${PILE} unread without any query handing back ${PILE} rows`, async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    for (let i = 0; i < PILE; i++) {
      await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", unread: true });
    }

    // Spy after seeding, below the binder, so only the request's reads are measured.
    const client = (db as { $client: { query: Query } }).$client;
    const real = client.query.bind(client);
    const sizes: number[] = [];
    const query = vi.spyOn(client, "query").mockImplementation(async (...args) => {
      const result = await real(...args);
      sizes.push(result.rows.length);
      return result;
    });
    const res = await app.handle(
      req("GET", "/views/power-through", { bearer: s.token }),
      { ...deps, session: null, idempotency: null },
    ).finally(() => query.mockRestore());
    expect(res.status).toBe(200);
    const body = await res.json() as { current: unknown; remaining: number; nextCursor: string | null };

    // The answer is unchanged: the count is still the whole pile.
    expect(body.remaining).toBe(PILE);
    expect(body.current).not.toBeNull();
    expect(body.nextCursor).toBeTruthy();

    // …and producing it did not transfer the pile.
    expect(sizes.length).toBeGreaterThan(0);
    const largest = Math.max(...sizes);
    expect(
      largest,
      `largest result set was ${largest} rows for a ${PILE}-message pile (all sizes: ${sizes.join(",")})`,
    ).toBeLessThan(PILE);
  });

  it("an empty pile answers nothing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await app.handle(
      req("GET", "/views/power-through", { bearer: s.token }),
      { ...deps, session: null, idempotency: null },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ current: null, remaining: 0, nextCursor: null });
  });
});
