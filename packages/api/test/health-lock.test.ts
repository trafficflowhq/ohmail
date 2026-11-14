import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { lockHealthLine, type LockReading } from "@trafficflow/db/cloud";
import type { HealthConfig } from "../src/deps.js";
import { makeDeps, req } from "./helpers.js";

/**
 * `/health` publishes the lock's line where the host injects a reader: the verdict, the counts (the
 * account's views among them) and the census, and when the lock is off, since when, by whom and why. Beside the staff faults and on
 * their terms: it never changes the status, and a reading that throws publishes nothing. No host
 * injects it yet; the reader is armed with the runtime logins.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });

const reading = (over: Partial<LockReading> = {}): LockReading => ({
  verdict: "locked", why: [], listed: 101, on: 101, forced: 101, marker: null,
  role: { name: "ohmail_api", bypass: false, owns: 0, member: 0, policies: "equal" }, census: 0, views: 3, ...over,
});

/** The database package's line, typed as the health answer takes it: the two shapes are one. */
const reader = (r: LockReading): NonNullable<HealthConfig["lock"]> => async () => lockHealthLine(r, null);

describe("GET /health — the lock", () => {
  it("publishes the injected line on the healthy answer", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/health"), { ...deps, health: { version: "v", lock: reader(reading()) } });
    expect(res.status).toBe(200);
    expect((await res.json()).lock).toEqual({ verdict: "locked", role: "ohmail_api", listed: 101, forced: 101, census: "equal", policies: "equal", views: 3, reads: "unasked" });
  });

  it("the line says which relations this instance's search reads, beside the store's views: the views, the tables, or not asked yet", async () => {
    const { deps } = await makeDeps();
    const read = async (reads: "views" | "tables" | null): Promise<unknown> => (await (await H(req("GET", "/health"),
      { ...deps, health: { version: "v", lock: async () => lockHealthLine(reading(), reads) } })).json()).lock;
    expect([await read("views"), await read("tables"), await read(null)]).toMatchObject([
      { views: 3, reads: "views" }, { views: 3, reads: "tables" }, { views: 3, reads: "unasked" },
    ]);
  });

  it("a broken lock is published and the status is untouched", async () => {
    const { deps } = await makeDeps();
    const broken = reading({ verdict: "broken", why: ["connected as ohmail_migrator, not ohmail_api"], census: 3, views: 2, role: { name: "ohmail_migrator", bypass: true, owns: 9, member: 0, policies: "differ" } });
    const res = await H(req("GET", "/health"), { ...deps, health: { version: "v", lock: reader(broken) } });
    expect(res.status).toBe(200);
    expect((await res.json()).lock).toEqual({ verdict: "broken", role: "ohmail_migrator", listed: 101, forced: 101, census: "drift", policies: "differ", views: 2, reads: "unasked" });
  });

  it("the lock switched off says since when, by whom and why", async () => {
    const { deps } = await makeDeps();
    const off = reading({ verdict: "off", on: 0, forced: 0, marker: { since: "2026-11-15T10:00:00.000Z", by: "ohmail_migrator", why: "rehearsal" } });
    const body = await (await H(req("GET", "/health"), { ...deps, health: { version: "v", lock: reader(off) } })).json();
    expect(body.lock).toMatchObject({ verdict: "off", forced: 0, since: "2026-11-15T10:00:00.000Z", by: "ohmail_migrator", why: "rehearsal" });
  });

  it("no reader injected: no key", async () => {
    const { deps } = await makeDeps();
    const body = await (await H(req("GET", "/health"), { ...deps, health: { version: "v" } })).json();
    expect("lock" in body).toBe(false);
  });

  it("a reading that throws publishes nothing, and the status is untouched", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/health"), { ...deps, health: { version: "v", lock: async () => { throw new Error("catalog unreadable"); } } });
    expect(res.status).toBe(200);
    expect("lock" in (await res.json())).toBe(false);
  });
});
