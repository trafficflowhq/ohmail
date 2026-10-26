import { afterAll, describe, expect, it } from "vitest";
import { closePooledDbs, makePooledDb, POOLED_IDLE_TIMEOUT_S } from "../src/client.js";

/**
 * A POOLED CONNECTION CLOSES BEFORE ITS INSTANCE IS SUSPENDED. A suspended instance keeps its idle
 * client connections open at the pooler until it wakes, and on 2026-10-26 those of ~160 cold
 * instances filled the pooler's client cap. Twenty seconds, inside the hosted API's quiet hold
 * (`QUIET_HOLD_MS`); the cost is one dial on the first request after 20 s of quiet. The handle is
 * built without connecting.
 */
afterAll(async () => { await closePooledDbs(); });

describe("the pooled client's idle window", () => {
  it("is twenty seconds, read off the client the hosted API dials with", () => {
    expect(POOLED_IDLE_TIMEOUT_S).toBe(20);
    const db = makePooledDb("postgres://u:p@127.0.0.1:1/idle_timeout_probe") as unknown as { $client: { options: { idle_timeout: number } } };
    expect(db.$client.options.idle_timeout).toBe(POOLED_IDLE_TIMEOUT_S);
  });
});
