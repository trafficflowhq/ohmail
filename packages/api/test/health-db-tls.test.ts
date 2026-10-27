import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeDeps, req } from "./helpers.js";

/**
 * `/health` publishes the database transport, both hops, on every branch: `dbTls` (this host's
 * hop, from its own verified handshakes) and `dbTlsBackend` (`pg_stat_ssl`, the pooler's hop behind
 * a pooler). The operator's provider-side enforcement waits on `dbTls: true` read twice, so the key
 * must exist wherever the host injects it — and never 503 or darken the host when it faults.
 */
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null });

describe("GET /health — dbTls", () => {
  it("publishes both hops on the healthy branch, and asks for the backend once the probe reached it", async () => {
    const { deps } = await makeDeps();
    const asked: boolean[] = [];
    const res = await H(req("GET", "/health"), {
      ...deps,
      health: { version: "v", dbTls: async (reached) => { asked.push(reached); return { dbTls: true, dbTlsBackend: false }; } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dbTls).toBe(true);
    expect(body.dbTlsBackend).toBe(false);
    expect(asked).toEqual([true]);
  });

  it("publishes the client hop on the unreachable branch without asking the backend", async () => {
    const { deps } = await makeDeps();
    const asked: boolean[] = [];
    const broken = {
      ...deps,
      db: { ...deps.db, execute: async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); } } as unknown as ApiDeps["db"],
      health: { version: "v", dbTls: async (reached: boolean) => { asked.push(reached); return { dbTls: false, dbTlsBackend: null }; } },
    };
    const res = await H(req("GET", "/health"), broken);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.dbTls).toBe(false);
    expect(body.dbTlsBackend).toBeNull();
    expect(asked).toEqual([false]);
  });

  it("a faulting reading is no reading: no keys, and the verdict is untouched", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/health"), {
      ...deps, health: { version: "v", dbTls: async () => { throw new Error("boom"); } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect("dbTls" in body).toBe(false);
    expect("dbTlsBackend" in body).toBe(false);
  });
});

/**
 * A REFUSED FRESH CONNECTION IS NOT HEALTHY. On 2026-10-26 the pooler refused every new client for
 * six minutes while `/health` answered 200 on warm instances, whose probe rode a connection they
 * already held. The host's `freshConnect` opens one of its own, after the probe answered.
 */
describe("GET /health — a fresh connection", () => {
  const unreachableDb = (db: ApiDeps["db"]) => ({
    ...db, execute: async () => { throw Object.assign(new Error("down"), { code: "ECONNREFUSED" }); },
  }) as unknown as ApiDeps["db"];
  const refused = async () => ({ ok: false, ms: 3, code: "db_connection_cap" });

  it("refused: 503 database_refusing_new_connections with the cap's code, keyed as the unreachable answer", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/health"), { ...deps, health: { version: "v", freshConnect: refused } });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, error: "database_refusing_new_connections", errorCode: "db_connection_cap" });
    const unreachable = await (await H(req("GET", "/health"),
      { ...deps, db: unreachableDb(deps.db), health: { version: "v", freshConnect: refused } })).json();
    expect(unreachable.error).toBe("database_unreachable");
    expect(Object.keys(body).sort()).toEqual(Object.keys(unreachable).sort());
  });

  it("opened: the healthy answer carries dbFreshConnectMs", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/health"),
      { ...deps, health: { version: "v", freshConnect: async () => ({ ok: true, ms: 12, code: null }) } });
    expect(res.status).toBe(200);
    expect((await res.json()).dbFreshConnectMs).toBe(12);
  });

  it("a throw is no reading, and nothing is asked when the probe was unreachable", async () => {
    const { deps } = await makeDeps();
    const thrown = await H(req("GET", "/health"),
      { ...deps, health: { version: "v", freshConnect: async () => { throw new Error("boom"); } } });
    expect(thrown.status).toBe(200);
    expect("dbFreshConnectMs" in await thrown.json()).toBe(false);
    let asked = 0;
    const res = await H(req("GET", "/health"), {
      ...deps, db: unreachableDb(deps.db),
      health: { version: "v", freshConnect: async () => { asked += 1; return { ok: true, ms: 1, code: null }; } },
    });
    expect(res.status).toBe(503);
    expect(asked).toBe(0);
  });
});
