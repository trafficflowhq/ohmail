import type { SyncResponse } from "@ohmail/wire";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { ERASED_ANSWER_HEADER } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A DELETED HOSTED ACCOUNT ENDS THE CLOUD DOOR, SAID ONCE. The hosted API answers an erased
 * account's bearer `410 account_erased` — on a read while the access token is still in its
 * window, at the refresh door after it — to a client that declares it understands the answer.
 * Either answer latches `/health.accountErased`, discards the sealed session (it belongs to an
 * account that no longer exists), and asks the hosted API nothing more: no renewal, no pull.
 * A coded 401 refusal keeps its own meaning (signed out, not deleted). Watched red: the refresh
 * door's 410 read as a fault, the declaration header cut, the any-answer 410 notice cut, the
 * engine's latch cut, `sessionExpired` said for a deleted account.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const iso = (): string => new Date().toISOString();
const emptyPage = (): SyncResponse => ({
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "end", hasMore: false, serverTime: iso(),
});
const send = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string): Response => send({ error: { code, message: code } }, status);

type After = "read-410" | "refresh-410" | "refresh-401";

interface Rig {
  sidecar: CloudSidecar;
  sealPath: string;
  asks: Array<{ path: string; declared: string | null }>;
  erase: () => void;
  health: () => Promise<Record<string, unknown>>;
}

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The hosted API before and after the account is erased, with every ask recorded. */
async function rig(after: After): Promise<Rig> {
  let erased = false;
  const asks: Rig["asks"] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    asks.push({ path: url.pathname, declared: new Headers(init?.headers).get(ERASED_ANSWER_HEADER) });
    if (erased) {
      if (url.pathname === "/auth/refresh") {
        return after === "refresh-401" ? refusal(401, "refresh_revoked") : refusal(410, "account_erased");
      }
      return after === "read-410" ? refusal(410, "account_erased") : refusal(401, "unauthorized");
    }
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")]));
    if (url.pathname === "/sync") return send(emptyPage());
    if (url.pathname === "/sync/snapshot") return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    if (url.pathname === "/auth/refresh") return send({ tokens: { accessToken: "a2", refreshToken: "r2", expiresIn: 900 } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const dataDir = await freshDataDir("ohmail-account-erased-door-");
  dirs.push(dataDir);
  const sidecar = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://cloud.test",
    address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" },
    keks: { 1: randomBytes(32) },
    fetchImpl,
    pollIntervalMs: 40,
  });
  sidecars.push(sidecar);
  await sidecar.start();
  return {
    sidecar,
    sealPath: join(dataDir, "cloud-tokens.seal"),
    asks,
    erase: () => { erased = true; },
    health: async () => (await sidecar.handle(new Request("http://sidecar/health"))).json() as never,
  };
}

async function until(what: string, test: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const quiet = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("the hosted answer that the account was deleted", () => {
  it("on a READ: /health says so, the seal is discarded, and nothing more is asked", { timeout: 30_000 }, async () => {
    const r = await rig("read-410");
    expect(existsSync(r.sealPath), "the fixture never sealed a session").toBe(true);
    r.erase();
    await until("/health.accountErased", async () => (await r.health()).accountErased === true);
    const h = await r.health();
    expect(h.sessionExpired, "a deleted account is not a signed-out one").toBe(false);
    await until("the seal discarded", async () => !existsSync(r.sealPath), 5_000);
    const settled = r.asks.length;
    await quiet(600);
    expect(r.asks.slice(settled).map((a) => a.path), "the door asked again after the verdict").toEqual([]);
    expect((await r.health()).accountErased, "the verdict did not outlive the teardown").toBe(true);
  });

  it("at the REFRESH door: the same ending, and the refresh is asked once", { timeout: 30_000 }, async () => {
    const r = await rig("refresh-410");
    r.erase();
    await until("/health.accountErased", async () => (await r.health()).accountErased === true);
    expect((await r.health()).sessionExpired).toBe(false);
    await until("the seal discarded", async () => !existsSync(r.sealPath), 5_000);
    await quiet(2_500);
    const refreshes = r.asks.filter((a) => a.path === "/auth/refresh").length;
    expect(refreshes, "the renewal retried an answer that will never change").toBe(1);
    expect((await r.health()).accountErased, "the verdict did not outlive the teardown").toBe(true);
  });

  it("every hosted ask, the refresh included, declares that it understands the answer", { timeout: 30_000 }, async () => {
    const r = await rig("refresh-410");
    r.erase();
    await until("/health.accountErased", async () => (await r.health()).accountErased === true);
    const undeclared = r.asks.filter((a) => a.declared !== "account_erased").map((a) => a.path);
    expect(r.asks.length).toBeGreaterThan(3);
    expect(undeclared, "asks without the declaration").toEqual([]);
  });

  it("CONTROL: a coded 401 at the refresh door is still a sign-out, not a deletion", { timeout: 30_000 }, async () => {
    const r = await rig("refresh-401");
    r.erase();
    await until("/health.sessionExpired", async () => (await r.health()).sessionExpired === true);
    expect((await r.health()).accountErased).toBe(false);
  });
});
