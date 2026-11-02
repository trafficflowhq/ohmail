import { describe, it, expect, vi } from "vitest";
import { createApp, apiRoutes, type AdminConfig, type ApiDeps } from "@trafficflow/api";
import type { AdminDb } from "@trafficflow/services";
import { STAFF_SESSION_HEADER } from "../src/routes/admin.js";
import { makeDeps, seedStaffSession, req, FIXED_NOW } from "./helpers.js";

/**
 * THE 2026-08-10 DASHBOARD 504, AND ITS FIX (routes/admin.ts `serializeAdminRead` + `withAdminTimeout`).
 *
 * The blind handle is a module-cached `max: 1` pool shared by every request a warm instance serves.
 * The Today dashboard fires `overview` + `billing` + `worker` CONCURRENTLY; when two land on one
 * instance they contend for the single connection, and because a read holds it across an `await`
 * while the next query queues, the wait is circular and rides to the platform's ~60 s limit as a 504.
 * Each read alone returns in well under a second — the fault is purely the interleaving.
 *
 * This file proves the two guarantees that remove it, without a network and without waiting 60 s:
 *   1. concurrent reads are SERIALIZED, so the pool is never entered by more than one at a time; and
 *   2. a read that HANGS returns a bounded 503, not a gateway timeout.
 */

const app = createApp(apiRoutes);
const SECRET = "admin-console-internal-secret-fixture-token";
const ADMIN: AdminConfig = { secret: SECRET, environment: "test" };

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });
// The reads demand a live staff session besides the secret (NEW-ADMIN-READ-NO-SESSION); each
// test seeds this token before driving them.
const STAFF_TOKEN = "staff-session-cookie-fixture-token";
const staffReq = (path: string): Request =>
  req("GET", path, { bearer: SECRET, headers: { [STAFF_SESSION_HEADER]: STAFF_TOKEN } });

describe("admin reads never enter the max:1 blind pool concurrently", () => {
  it("serializes the dashboard's concurrent fan-out through one connection", async () => {
    const { db, deps } = await makeDeps();
    await seedStaffSession(db, { now: FIXED_NOW, token: STAFF_TOKEN });

    // A stand-in blind handle that reports how many reads hold it at once. The real symptom was a
    // deadlock when this count exceeded one; the fix keeps it pinned at one.
    let active = 0;
    let maxActive = 0;
    let signalEntered!: () => void;
    const firstEntered = new Promise<void>((r) => { signalEntered = r; });
    let signalled = false;
    let openGate!: () => void;
    const gate = new Promise<void>((r) => { openGate = r; });

    const staff = async (): Promise<AdminDb> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (!signalled) { signalled = true; signalEntered(); }
      await gate; // hold the "connection" until the test releases it
      active -= 1;
      return db as unknown as AdminDb;
    };
    const d: ApiDeps = { ...deps, admin: ADMIN, adminDb: staff };

    // Exactly what the Today page does: three reads, at once.
    const inflight = Promise.all([
      H(staffReq("/admin/overview"), d),
      H(staffReq("/admin/accounts"), d),
      H(staffReq("/admin/worker"), d),
    ]);

    // Deterministic: wait until the FIRST read has entered the handle, then give the other two a
    // generous window to (wrongly) enter it too. Without serialization all three would be holding
    // it now; with it, only one has.
    await firstEntered;
    await new Promise((r) => setTimeout(r, 40));
    expect(active).toBe(1);

    openGate();
    const [a, b, c] = await inflight;
    expect(maxActive, "the blind pool was entered by more than one read at once").toBe(1);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
  });

  it("returns a bounded 503 when a read hangs, instead of a 60 s gateway timeout", async () => {
    const { db, deps } = await makeDeps();
    await seedStaffSession(db, { now: FIXED_NOW, token: STAFF_TOKEN });
    const neverResolves = new Promise<never>(() => {});
    const d: ApiDeps = {
      ...deps,
      // A tiny timeout stands in for the production `ADMIN_READ_TIMEOUT_MS`, so the bounded-error
      // path is proven in milliseconds rather than at the real duration.
      admin: { secret: SECRET, environment: "test", readTimeoutMs: 60 },
      adminDb: () => neverResolves,
    };

    // The wrapper's own timer decides, on a fake clock: armed, then one tick short of the bound
    // the read is still open, and at the bound it is answered. Real time never enters it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let answered = false;
      const pending = H(staffReq("/admin/worker"), d).finally(() => { answered = true; });
      while (vi.getTimerCount() === 0) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(59);
      expect(answered, "the hung read was answered before its bound").toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(answered, "the hung read outlived its bound").toBe(true);
      const res = await pending;
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: { code: "admin_read_failed" } });
    } finally {
      vi.useRealTimers();
    }
  });
});
