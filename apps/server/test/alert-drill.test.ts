// @services: none — its Postgres URL is never dialed
import { describe, it, expect } from "vitest";
import { silentLogger } from "@trafficflow/core";
import type { Tx } from "@trafficflow/db";
import type { Alert, AlertSink } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { loadServerConfig, type ServerConfig } from "../src/config.js";
import { buildDeps, type ServerRuntime } from "../src/deps.js";
import { handleServerRequest } from "../src/handler.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * A DRILL ON A SELF-HOSTED SERVER: the self-host route table serves it, behind `TF_ALERT_SECRET`, and
 * the ack link is `OHMAIL_ORIGIN` under `/api` — the path the proxy hands to this server — never the
 * request's own Host.
 */

const SECRET = "a".repeat(32);
const cfg: ServerConfig = loadServerConfig({
  OHMAIL_ORIGIN: "https://mail.example.com",
  // Never dialed.
  DATABASE_URL: "postgres://tf@localhost:5433/never_dialed",
  [KEY_RING_V1]: "ab".repeat(32),
  TF_ALERT_SECRET: SECRET,
} as NodeJS.ProcessEnv);

function runtime(db: unknown, sinks: AlertSink[]): ServerRuntime {
  return {
    cfg, db: db as never, services: {} as never, changeWake: null, oauth: {} as never,
    onSetupTokenMinted: () => {}, logger: silentLogger,
    alertSinks: sinks,
    alertDb: () => Promise.resolve(db as unknown as Tx),
  };
}

describe("an alert drill on a self-hosted server", () => {
  it("composes its ack base from OHMAIL_ORIGIN", () => {
    const deps = buildDeps(new Request("http://elsewhere.example/internal/alerts/drill"), runtime({}, []));
    expect(deps.alerts?.drillAckBase).toBe("https://mail.example.com/api");
  });

  it("is served by the self-host table and links back through the proxy's /api", async () => {
    const db = await makeTestDb();
    const messages: Alert[][] = [];
    const sink: AlertSink = { name: "webhook", async notify(alerts) { messages.push([...alerts]); return true; } };
    const res = await handleServerRequest(new Request("http://localhost:8080/internal/alerts/drill", {
      method: "POST", headers: { authorization: `Bearer ${SECRET}` },
    }), runtime(db, [sink]));
    expect(res.status).toBe(200);
    expect(messages).toHaveLength(1);
    expect(messages[0]![0]!.detail).toMatch(/https:\/\/mail\.example\.com\/api\/internal\/alerts\/drill\/ack\?t=[A-Za-z0-9_-]{43}/);
  });
});
