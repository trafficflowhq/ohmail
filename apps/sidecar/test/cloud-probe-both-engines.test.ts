import { createServer, type Server } from "node:https";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";

import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { ensureLanIdentity, type LanIdentity } from "../src/host-lan-tls.js";
import * as phoneProbe from "../src/phone/cloud-probe.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * THE PAIRING CHECK ON BOTH ENGINES. A desktop with a door asks its RUNNING engine
 * `POST /cloud/probe`; the local engine answered 404, so no pairing could start from the local
 * door. Both engines mount the one handler, each driven here through its own constructor against a
 * real pinned TLS door, and the local engine refuses the no-origin arm: it has no cloud base.
 */
const dirs: string[] = [];
const servers: Server[] = [];
let local: Sidecar;
let cloud: CloudSidecar;
let id: LanIdentity;
let port: number;
/** What the fake host's `/pair/state` answers, per case; `null` serves no such route (404). */
let stateAnswer: string | null = null;
const stateAsked: unknown[] = [];

const tmp = (): string => {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-probe-both-"));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  const out = ensureLanIdentity(tmp());
  if (out.kind !== "identity") throw new Error("the fixture could not mint a door identity");
  id = out.identity;
  const server = createServer({ key: id.key, cert: id.cert }, (req, res) => {
    if (req.url === "/hello") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ product: "ohmail", flavor: "desktop-host", needsSetup: false, auth: {} }));
      return;
    }
    if (req.url === "/pair/state" && req.method === "POST" && stateAnswer !== null) {
      let raw = "";
      req.on("data", (c: Buffer) => { raw += c.toString("utf8"); });
      req.on("end", () => {
        stateAsked.push(JSON.parse(raw));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ state: stateAnswer }));
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;

  const dir = await freshDataDir("ohmail-probe-local-");
  dirs.push(dir);
  local = await createSidecar({
    dataDir: dir,
    address: "owner@trafficflow.test",
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "owner@trafficflow.test", pass: "mailbox-unreached-password" } },
    pollIntervalMs: 3_600_000,
    vitalsIntervalMs: 3_600_000,
    profileFlushIntervalMs: 3_600_000,
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    searchBackfillTiming: { waitMs: 3_600_000 },
  });
  cloud = await createCloudSidecar({
    dataDir: tmp(),
    cloudUrl: "https://unused.test",
    address: "me@ohmail.test",
    keks: { 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) },
    pollIntervalMs: 3_600_000,
  });
}, PGLITE_STANDUP_BUDGET_MS * 3);

afterAll(async () => {
  await local?.stop().catch(() => undefined);
  await cloud?.stop().catch(() => undefined);
  for (const s of servers.splice(0)) await new Promise<void>((r) => { s.close(() => { r(); }); });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Engine = { handle(req: Request): Promise<Response>; sessionToken: string };
const probe = async (
  engine: Engine, body: Record<string, unknown> | null, bearer = true,
): Promise<{ status: number; body: any }> => {
  const res = await engine.handle(new Request("http://sidecar/cloud/probe", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${engine.sessionToken}` } : {}),
    },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: res.status, body: await res.json().catch(() => null) };
};
const link = (): Record<string, unknown> => ({
  origin: `https://127.0.0.1:${port}`, flavor: "desktop-host", hostPin: id.fingerprint,
});

describe.each([
  ["the local engine", () => local as Engine],
  ["the cloud engine", () => cloud as Engine],
])("POST /cloud/probe on %s", (_name, engine) => {
  it("admits the desktop host the link names, and reports the base that answered", async () => {
    const out = await probe(engine(), link());
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.flavor).toBe("desktop-host");
    expect(out.body.base).toBe(`https://127.0.0.1:${port}`);
  });

  it("refuses a key the link did not name, by kind", async () => {
    const other = ensureLanIdentity(tmp());
    if (other.kind !== "identity") throw new Error("no second identity");
    const out = await probe(engine(), { ...link(), hostPin: other.identity.fingerprint });
    expect(out.status).toBe(502);
    expect(out.body.error.details.kind).toBe("pin_mismatch");
  });
});

describe.each([
  ["the local engine", () => local as Engine],
  ["the cloud engine", () => cloud as Engine],
])("the link's state, asked of the host by its hash, on %s", (_name, engine) => {
  const HASH = "A".repeat(43);

  it.each([
    ["spent", "pair_link_spent"],
    ["expired", "pair_link_expired"],
    ["revoked", "pair_link_revoked"],
  ])("a host answering %s refuses the check by kind, before anything is configured", async (answer, kind) => {
    stateAnswer = answer;
    stateAsked.length = 0;
    const out = await probe(engine(), { ...link(), tokenHash: HASH });
    expect(out.status, JSON.stringify(out.body)).toBe(409);
    expect(out.body.error.details.kind).toBe(kind);
    // The hash, and nothing else: the token is spent once, at the redeem.
    expect(stateAsked).toEqual([{ tokenHash: HASH }]);
  });

  it.each([["live"], ["unknown"]])("a host answering %s admits, as before", async (answer) => {
    stateAnswer = answer;
    const out = await probe(engine(), { ...link(), tokenHash: HASH });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    expect(out.body.base).toBe(`https://127.0.0.1:${port}`);
  });

  it("a host that predates the route (404) admits, and the redeem decides", async () => {
    stateAnswer = null;
    const out = await probe(engine(), { ...link(), tokenHash: HASH });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
  });

  it("no hash, or one of the wrong shape, asks the host nothing", async () => {
    stateAnswer = "spent";
    stateAsked.length = 0;
    expect((await probe(engine(), link())).status).toBe(200);
    expect((await probe(engine(), { ...link(), tokenHash: "not-a-hash" })).status).toBe(200);
    expect(stateAsked).toEqual([]);
  });
});

describe("the local engine's own rules for the route", () => {
  it("is on the launch bearer like its neighbours", async () => {
    const out = await probe(local, link(), false);
    expect(out.status).toBe(401);
  });

  it("refuses the no-origin arm: it has no configured cloud base to fall back on", async () => {
    for (const body of [{}, null]) {
      const out = await probe(local, body);
      expect(out.status, JSON.stringify(out.body)).toBe(400);
      expect(out.body.error.details.kind).toBe("origin_required");
    }
  });
});

describe("the phone's artifact", () => {
  it("carries a twin that refuses the route by name and dials nothing", async () => {
    const res = await phoneProbe.answerCloudProbe(
      new Request("http://sidecar/cloud/probe", { method: "POST", body: JSON.stringify(link()) }),
      { dataDir: "/nowhere", configured: null },
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("does not check");
    expect(phoneProbe.CLOUD_PROBE_ROUTE).toBe("/cloud/probe");
  });
});
