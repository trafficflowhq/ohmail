import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { UNMETERED_ACCESS, type EntitlementsPort } from "@trafficflow/db";
import { makeDeps } from "./helpers.js";

/**
 * THE NIGHTLY SWEEP'S DOORS (cloud 0040). The sweep takes one keyset position (`?after=`) and
 * answers `next` and `erasureDue`; the erase door takes one account (`?account=`), answers
 * `{skipped}` for one that is not due and never erases on a verdict it did not re-read. Both are
 * the scheduler's shape: 404 unarmed, 401 on a wrong bearer, 400 on anything but a uuid.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });
const SECRET = "s".repeat(32);
const ID = "0a000000-0000-4000-8000-000000000001";

const get = (path: string, secret: string | null = SECRET): Request => new Request(`http://api.test${path}`, {
  method: "GET", headers: secret ? { authorization: `Bearer ${secret}` } : {},
});

function openPort(reads: string[]): EntitlementsPort {
  return {
    async access() { return UNMETERED_ACCESS; },
    async accessOrFault(id: string) { reads.push(id); return UNMETERED_ACCESS; },
    async spend() { return { verdict: "fault" }; },
    async release(): Promise<"settled"> { return "settled"; },
    async manageLink() { return null; },
    async releaseAccount() { throw new Error("nothing may be released on an open verdict"); },
  } as unknown as EntitlementsPort;
}

async function armed(reads: string[] = []): Promise<ApiDeps> {
  const { deps } = await makeDeps();
  return {
    ...deps, alerts: { secret: SECRET, sinks: [] },
    services: { ...deps.services, entitlementsPort: openPort(reads) },
  } as ApiDeps;
}

describe("GET /internal/account-lifecycle/run and /erase", () => {
  it("both are 404 unarmed and 401 on a wrong bearer", async () => {
    const { deps } = await makeDeps();
    for (const path of ["/internal/account-lifecycle/run", `/internal/account-lifecycle/erase?account=${ID}`]) {
      expect((await H(get(path), deps)).status, path).toBe(404);
      expect((await H(get(path, "wrong"), await armed())).status, path).toBe(401);
    }
  });

  it("the sweep answers next and erasureDue, and refuses an after that is not a uuid", async () => {
    const d = await armed();
    const res = await H(get("/internal/account-lifecycle/run"), d);
    expect(res.status).toBe(200);
    const body = await res.json() as { next: unknown; erasureDue: unknown };
    expect(body.next).toBeNull();
    expect(body.erasureDue).toEqual([]);
    expect((await H(get(`/internal/account-lifecycle/run?after=${ID}`), d)).status).toBe(200);
    expect((await H(get("/internal/account-lifecycle/run?after=1%20or%201=1"), d)).status).toBe(400);
  });

  it("the sweep runs the connect reminder log-only unless the host switched it to send, and send only beside its cutoff", async () => {
    const d = await armed();
    const run = async (deps: ApiDeps) =>
      ((await (await H(get("/internal/account-lifecycle/run"), deps)).json()) as { connectReminder: unknown }).connectReminder;
    const since = "2026-10-25T18:00:00Z";
    expect(await run(d)).toEqual({ mode: "log", since: null, owed: 0, owedSince: null });
    expect(await run({ ...d, connectReminderSince: since } as ApiDeps))
      .toEqual({ mode: "log", since: "2026-10-25T18:00:00.000Z", owed: 0, owedSince: 0 });
    expect(await run({ ...d, connectReminder: "send", connectReminderSince: since } as ApiDeps))
      .toEqual({ mode: "send", since: "2026-10-25T18:00:00.000Z", owed: 0, owedSince: null });
    for (const without of [{}, { connectReminderSince: "2026-10-25" }]) {
      expect(await run({ ...d, connectReminder: "send", ...without } as ApiDeps), JSON.stringify(without))
        .toEqual({ mode: "refused", since: null, owed: 0, owedSince: null });
    }
  });

  it("the erase door answers {skipped} for an account that is not due, and 400 without a uuid", async () => {
    const reads: string[] = [];
    const d = await armed(reads);
    const res = await H(get(`/internal/account-lifecycle/erase?account=${ID}`), d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "not_due" });
    expect((await H(get("/internal/account-lifecycle/erase"), d)).status).toBe(400);
    expect((await H(get("/internal/account-lifecycle/erase?account=nope"), d)).status).toBe(400);
  });
});
