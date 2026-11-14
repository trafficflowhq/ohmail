import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, seedSession, seedMailbox, seedMessage, seedSearchDocuments, req, FIXED_NOW } from "./helpers.js";

/**
 * `GET /search?dateFrom=…&dateTo=…` — the two filter values that are CAST rather than compared.
 *
 * `${f.dateFrom}::timestamptz` is parameterized, so nothing here is injectable — but the cast is
 * evaluated by Postgres, and a string that is not an instant raises 22007. That reached
 * `withErrorEnvelope` as an unhandled error and answered **500 `internal`** for a plainly bad
 * request. A 500 is the wrong answer twice over: it tells a client to retry something that will
 * never succeed, and it is the status this repository reserves for its own faults.
 *
 * THE MUTATION THAT MAKES THIS RED is removing the `instantOr400` call from either predicate in
 * `packages/services/src/search-service.ts#whereSql` — the request 500s instead of 400ing.
 * Watched fail and restored.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

// The last two are the NORMALISED non-instants: before the total reader, `2026-02-30T…` bound the
// window at March 2 and the offset-less time at the server's local 00:00 — a 200 over a window
// nobody asked for, which is the same defect with a quieter face.
const BAD = ["notadate", "2026-13-45", "yesterday", "''", "0000-00-00", "NaN",
  "2026-02-30T00:00:00Z", "2026-02-01T00:00:00"];

describe("GET /search — a date bound that is not an instant is a 400, never a 500", () => {
  it("refuses every non-instant dateFrom and dateTo with validation_failed", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", subject: "quarterly report" });

    for (const raw of BAD) {
      for (const field of ["dateFrom", "dateTo"]) {
        const res = await H(
          req("GET", `/search?q=report&${field}=${encodeURIComponent(raw)}`, { bearer: s.token }),
          deps,
        );
        expect(res.status, `${field}=${raw}`).toBe(400);
        const body = await res.json() as { error: { code: string; message: string } };
        expect(body.error.code, `${field}=${raw}`).toBe("validation_failed");
        expect(body.error.message, `${field}=${raw}`).toContain(field);
      }
    }
  });

  it("still honours a real instant on both bounds", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "quarterly report", date: FIXED_NOW,
    });

    await seedSearchDocuments(db, s.accountId);
    const inRange = await H(
      req("GET", "/search?q=report&dateFrom=2026-07-01T00:00:00.000Z&dateTo=2026-08-01T00:00:00.000Z", { bearer: s.token }),
      deps,
    );
    expect(inRange.status).toBe(200);
    const hit = await inRange.json() as { items: unknown[] };
    expect(hit.items.length).toBeGreaterThan(0);

    // The bound is real, not decorative: the same query outside the window finds nothing.
    const outOfRange = await H(
      req("GET", "/search?q=report&dateFrom=2020-01-01T00:00:00.000Z&dateTo=2020-02-01T00:00:00.000Z", { bearer: s.token }),
      deps,
    );
    expect(outOfRange.status).toBe(200);
    const miss = await outOfRange.json() as { items: unknown[] };
    expect(miss.items).toHaveLength(0);
  });
});
