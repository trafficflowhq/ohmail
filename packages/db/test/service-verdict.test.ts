// @services: none — the harness against this file's own listeners
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import {
  PG_TEST_URL, REQUIRE_PG_ENV, SERVICE_VERDICT_ENV, TEST_SERVICES, pgTestUrl, readServiceVerdict, realPgAvailable,
  serviceAddressOf, serviceUp,
} from "../src/testing.js";

/*
 * ONE PROBE PER RUN DECIDES WHETHER A TEST SERVICE IS THERE (test/setup/services.global.ts), and the
 * Postgres harness reads its result: absent skips without dialing and without the shared-box refusal,
 * present-but-broken fails. Every listener here is this file's own; nothing dials a test service.
 */

const FILE = new URL("../../services/test/search-budget.pg.test.ts", import.meta.url).href;
/* No password in a literal: the address is what the verdict keys on, and a credentialed URL
 * literal reads as a credential to the push gate. */
const urlAt = (port: number, db: string) => `postgres://tf@127.0.0.1:${port}/${db}`;

let silent: Server;
let silentPort = 0;
let silentDials = 0;
let mute: Server;
let mutePort = 0;
const held: Socket[] = [];
/* A port nothing listens on: a listener's port, closed again. */
let closedPort = 0;

const listen = async (onSocket: (s: Socket) => void): Promise<[Server, number]> => {
  const srv = createServer(onSocket);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return [srv, (srv.address() as { port: number }).port];
};

beforeAll(async () => {
  [silent, silentPort] = await listen((s) => { silentDials++; s.destroy(); });
  /* Accepts and never answers: something listens, and it is not a Postgres. (One that closes at
   * once makes the client reconnect without end, so the answer would be the test's timeout.) */
  [mute, mutePort] = await listen((s) => { held.push(s); });
  const [gone, port] = await listen((s) => s.destroy());
  await new Promise<void>((r) => gone.close(() => r()));
  closedPort = port;
});
afterAll(async () => {
  await new Promise<void>((r) => silent.close(() => r()));
  for (const s of held) s.destroy();
  await new Promise<void>((r) => mute.close(() => r()));
});

const saved = { verdict: process.env[SERVICE_VERDICT_ENV], require: process.env[REQUIRE_PG_ENV] };
afterEach(() => {
  for (const [k, v] of [[SERVICE_VERDICT_ENV, saved.verdict], [REQUIRE_PG_ENV, saved.require]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const verdict = (pg: { at: string[]; up: boolean; why: string }) => JSON.stringify({ pg });
const setVerdict = (text: string | null, require: boolean) => {
  if (text === null) delete process.env[SERVICE_VERDICT_ENV]; else process.env[SERVICE_VERDICT_ENV] = text;
  if (require) process.env[REQUIRE_PG_ENV] = "1"; else delete process.env[REQUIRE_PG_ENV];
};
const messageOf = async (p: Promise<unknown>): Promise<string> => {
  try { await p; } catch (e) { return e instanceof Error ? e.message : String(e); }
  return "NO THROW";
};

describe("the probe's result, read by the Postgres harness", () => {
  it("names one require variable and one start command per service", () => {
    expect(Object.keys(TEST_SERVICES).sort()).toEqual(["dovecot", "greenmail", "pg", "rustfs"]);
    expect(TEST_SERVICES.pg.require).toBe("TF_REQUIRE_PG");
    expect(TEST_SERVICES.greenmail.require).toBe("TF_REQUIRE_GREENMAIL");
    expect(TEST_SERVICES.dovecot.require).toBe("TF_REQUIRE_DOVECOT");
    expect(TEST_SERVICES.rustfs.require).toBe("TF_REQUIRE_RUSTFS");
    for (const s of Object.values(TEST_SERVICES)) expect(s.start).toMatch(/^docker compose /);
  });

  it("absent: realPgAvailable answers false without dialing and without the shared-box refusal", async () => {
    const box = urlAt(silentPort, "trafficflow_test");
    setVerdict(verdict({ at: [`127.0.0.1:${silentPort}`], up: false, why: "ECONNREFUSED" }), false);
    const before = silentDials;
    expect(await realPgAvailable(box)).toBe(false);
    expect(silentDials, "the harness dialed a service the probe found absent").toBe(before);
    expect(pgTestUrl(FILE, box, process.env)).toBe(box);
  });

  it("absent and required: realPgAvailable throws, naming the variable, the address and the remedy", async () => {
    const box = urlAt(closedPort, "trafficflow_test");
    setVerdict(verdict({ at: [`127.0.0.1:${closedPort}`], up: false, why: "ECONNREFUSED" }), true);
    const why = await messageOf(realPgAvailable(box));
    expect(why).toContain(`TF_REQUIRE_PG=1 but Postgres is not running at 127.0.0.1:${closedPort} (ECONNREFUSED)`);
    expect(why).toContain("docker compose up -d db");
  });

  it("present but broken: a listener that never answers fails, naming host:port", async () => {
    setVerdict(verdict({ at: [`127.0.0.1:${mutePort}`], up: true, why: "" }), false);
    const why = await messageOf(realPgAvailable(urlAt(mutePort, "nss_lane")));
    expect(why).toContain(`[pg] something listens at 127.0.0.1:${mutePort}`);
    expect(why).not.toBe("NO THROW");
  }, 30_000);

  it("a result for another address, and no result at all, leave today's behaviour", async () => {
    for (const text of [verdict({ at: ["127.0.0.1:1"], up: false, why: "ECONNREFUSED" }), null]) {
      setVerdict(text, false);
      /* The box is refused before anything dials, as it always was. */
      expect(await messageOf(realPgAvailable(urlAt(closedPort, "trafficflow_test")))).toContain("SHARED box database");
      expect(() => pgTestUrl(FILE, urlAt(closedPort, "trafficflow_test"), process.env)).toThrow(/SHARED box database/);
      /* An unreachable or broken non-box database answers false. */
      expect(await realPgAvailable(urlAt(closedPort, "nss_lane"))).toBe(false);
      expect(await realPgAvailable(urlAt(mutePort, "nss_lane"))).toBe(false);
    }
  }, 60_000);

  it("pgTestUrl reads the environment it is handed, never process.env", () => {
    setVerdict(verdict({ at: [`127.0.0.1:${closedPort}`], up: false, why: "ECONNREFUSED" }), false);
    expect(() => pgTestUrl(FILE, urlAt(closedPort, "trafficflow_test"), {})).toThrow(/SHARED box database/);
  });

  it("a malformed result throws by name, from every reader", async () => {
    for (const bad of ["{", "[]", JSON.stringify({ pg: { at: "127.0.0.1:5433", up: false, why: "" } }),
      JSON.stringify({ pg: { at: ["127.0.0.1:5433"], up: "no", why: "" } }), JSON.stringify({ nosuch: { at: [], up: true, why: "" } })]) {
      setVerdict(bad, false);
      expect(() => readServiceVerdict(process.env), bad).toThrow(SERVICE_VERDICT_ENV);
      expect(() => serviceUp("pg"), bad).toThrow(SERVICE_VERDICT_ENV);
      expect(await messageOf(realPgAvailable(urlAt(closedPort, "nss_lane"))), bad).toContain(SERVICE_VERDICT_ENV);
    }
    setVerdict(null, false);
    expect(readServiceVerdict(process.env)).toBeNull();
  });

  it("serviceUp: absent skips with the reason, required throws, present and unprobed run", () => {
    const gm = JSON.stringify({ greenmail: { at: ["127.0.0.1:3143", "127.0.0.1:3025"], up: false, why: "ECONNREFUSED" } });
    expect(serviceUp("greenmail", undefined, { [SERVICE_VERDICT_ENV]: gm })).toEqual({
      up: false, why: "GreenMail is not running at 127.0.0.1:3143, 127.0.0.1:3025 (ECONNREFUSED)",
    });
    expect(() => serviceUp("greenmail", undefined, { [SERVICE_VERDICT_ENV]: gm, TF_REQUIRE_GREENMAIL: "1" }))
      .toThrow("TF_REQUIRE_GREENMAIL=1 but GreenMail is not running at 127.0.0.1:3143, 127.0.0.1:3025 (ECONNREFUSED)");
    /* Another address than the one probed is not known to be absent. */
    expect(serviceUp("greenmail", "127.0.0.1:21000", { [SERVICE_VERDICT_ENV]: gm }).up).toBe(true);
    expect(serviceUp("greenmail", "127.0.0.1:3025", { [SERVICE_VERDICT_ENV]: gm }).up).toBe(false);
    expect(serviceUp("dovecot", undefined, { [SERVICE_VERDICT_ENV]: gm }).up).toBe(true);
    expect(serviceUp("greenmail", undefined, {}).up).toBe(true);
  });

  it("an address carries host and port, never a credential", () => {
    const secret = randomBytes(12).toString("hex");
    const u = new URL("postgres://127.0.0.1:5433/trafficflow_l_0123456789ab");
    u.username = "probe";
    u.password = secret;
    expect(serviceAddressOf(u.href, 5432)).toBe("127.0.0.1:5433");
    expect(serviceAddressOf("postgres://localhost/x", 5432)).toBe("localhost:5432");
    expect(serviceAddressOf("http://[::1]:3902", 80)).toBe("[::1]:3902");
    expect(serviceAddressOf(PG_TEST_URL, 5432)).not.toContain("@");
  });
});
