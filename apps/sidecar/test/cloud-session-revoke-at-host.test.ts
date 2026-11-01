import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createCloudSidecar, SIGN_OUT_AT_HOST_MS, type CloudSidecar } from "../src/cloud-engine.js";
import { REVOKE_RESERVE_MS } from "../src/pair-undo.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * SIGNING OUT ENDS THE SESSION HERE, THEN AT ITS SERVER. `DELETE /cloud/session` forgets the session
 * first, then asks the server that issued it to end it with the pair it held: `POST /auth/logout`
 * with the bearer, on a 401 only `POST /auth/refresh/logout`, never a renewal — all inside ONE
 * deadline. A refusing, unreachable or older server still leaves this install signed out.
 */
const dirs: string[] = [];
const sidecars: CloudSidecar[] = [];
const releases: Array<() => void> = [];

afterEach(async () => {
  for (const r of releases.splice(0)) r();
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Asked {
  method: string;
  path: string;
  host: string;
  bearer: string | null;
  body: string;
  at: number;
  abortedAt: number | null;
}
type Script = (path: string, row: Asked, init?: RequestInit) => Promise<Response> | Response | null;

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
/** A request that never answers, records when its own signal gave it up, and is freed after the case. */
const hang = (row: Asked, init?: RequestInit): Promise<Response> => new Promise<Response>((_, reject) => {
  init?.signal?.addEventListener("abort", () => {
    row.abortedAt = Date.now();
    reject(init.signal!.reason);
  });
  releases.push(() => reject(new Error("released by the test")));
});

async function door(opts: { signedIn?: boolean; script?: Script; pollIntervalMs?: number } = {}) {
  const asked: Asked[] = [];
  const lines: { event: string; detail: Record<string, unknown> }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const row: Asked = {
      method: (init?.method ?? "GET").toUpperCase(), path: url.pathname, host: url.host,
      bearer: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : "", at: Date.now(), abortedAt: null,
    };
    asked.push(row);
    const scripted = opts.script?.(url.pathname, row, init);
    if (scripted) return scripted;
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
    if (url.pathname === "/sync") return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
    if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const dataDir = await freshDataDir("ohmail-sign-out-at-host-");
  dirs.push(dataDir);
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://host.test", address: "me@ohmail.test", fetchImpl,
    pollIntervalMs: opts.pollIntervalMs ?? 3_600_000,
    keks: { 1: Buffer.alloc(32, 7) },
    log: (event, detail) => { lines.push({ event, detail }); },
    ...(opts.signedIn === false ? {} : { tokens: { accessToken: "held-access", refreshToken: "held-refresh" } }),
  });
  sidecars.push(sidecar);
  const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
  const signOut = async (query = ""): Promise<{ status: number; body: unknown; ms: number }> => {
    const started = Date.now();
    const res = await sidecar.handle(new Request(`http://sidecar/cloud/session${query}`, { method: "DELETE", headers: auth }));
    return { status: res.status, body: await res.json(), ms: Date.now() - started };
  };
  const read = async (): Promise<number> =>
    (await sidecar.handle(new Request("http://sidecar/mailboxes", { headers: auth }))).status;
  const sealed = (): boolean => existsSync(join(dataDir, "cloud-tokens.seal"));
  const at = (path: string): Asked[] => asked.filter((r) => r.path === path);
  return { sidecar, signOut, read, sealed, at, asked, lines };
}

/** Wait, in real time, until `ok` holds; false when `ms` passes first. */
async function until(ms: number, ok: () => boolean): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return ok();
}

describe("DELETE /cloud/session", () => {
  it("an ordinary sign-out ends the session at the host with its own bearer", { timeout: 30_000 }, async () => {
    const e = await door();
    expect(e.sealed(), "the launch sealed its session, or the absence below proves nothing").toBe(true);
    const out = await e.signOut();
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(e.at("/auth/logout").map((r) => [r.method, r.bearer, r.body]))
      .toEqual([["POST", "Bearer held-access", "{}"]]);
    expect(e.at("/auth/refresh"), "a sign-out renewed the session it was ending").toEqual([]);
    expect(e.at("/auth/refresh/logout")).toEqual([]);
    expect(e.sealed(), "the seal outlived the sign-out").toBe(false);
    expect(await e.read(), "still signed in here").toBe(409);
    expect(e.lines.filter((l) => l.event === "cloud_signed_out_at_server").map((l) => l.detail.changed)).toEqual([true]);
  });

  it("the pairing undo's spelling, ?revoke=host, is the same request", { timeout: 30_000 }, async () => {
    const e = await door();
    expect((await e.signOut("?revoke=host")).body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(e.at("/auth/logout").map((r) => r.bearer)).toEqual(["Bearer held-access"]);
  });

  it("with no session there is nothing to end and nothing is asked", { timeout: 30_000 }, async () => {
    const e = await door({ signedIn: false });
    expect((await e.signOut()).body).toEqual({ status: "signed_out", queued: 0 });
    expect(e.asked.filter((r) => r.path.startsWith("/auth/"))).toEqual([]);
  });

  it("every door is asked through the door's own transport, at its own server only", { timeout: 30_000 }, async () => {
    const e = await door({ script: (path) => (path === "/auth/logout" ? new Response(null, { status: 401 }) : path === "/auth/refresh/logout" ? new Response(null, { status: 204 }) : null) });
    await e.signOut();
    const doors = e.asked.filter((r) => r.path.startsWith("/auth/"));
    expect(doors.map((r) => r.path)).toEqual(["/auth/logout", "/auth/refresh/logout"]);
    expect(new Set(doors.map((r) => r.host))).toEqual(new Set(["host.test"]));
  });
});

describe("a server that does not end it still leaves this install signed out", () => {
  for (const [name, script] of [
    ["refuses (5xx)", ((path) => (path === "/auth/logout" ? new Response(null, { status: 500 }) : null)) as Script],
    ["is unreachable", ((path) => (path === "/auth/logout" ? Promise.reject(new TypeError("fetch failed")) : null)) as Script],
    ["answers 404 at both doors", ((path) => (path.startsWith("/auth/") ? new Response(null, { status: 404 }) : null)) as Script],
  ] as const) {
    it(`a server that ${name}`, { timeout: 30_000 }, async () => {
      const e = await door({ script });
      expect(e.sealed()).toBe(true);
      const out = await e.signOut();
      expect(out.status).toBe(200);
      expect(out.body).toEqual({ status: "signed_out", revokedAtHost: false, queued: 0 });
      expect(e.sealed(), "the seal outlived a refused sign-out").toBe(false);
      expect(await e.read()).toBe(409);
      expect(e.at("/auth/refresh/logout"), "the refresh door is for a 401 only").toEqual([]);
      expect(e.lines.filter((l) => l.event === "cloud_signed_out_at_server").map((l) => l.detail.changed)).toEqual([false]);
    });
  }
});

describe("an access token that lapsed", () => {
  it("401 at the bearer door, then the refresh door ends the family", { timeout: 30_000 }, async () => {
    const e = await door({
      script: (path) => path === "/auth/logout" ? json({ error: { code: "unauthorized" } }, 401)
        : path === "/auth/refresh/logout" ? new Response(null, { status: 204 }) : null,
    });
    expect((await e.signOut()).body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    const [byRefresh] = e.at("/auth/refresh/logout");
    expect(byRefresh?.bearer, "the refresh door carries no bearer").toBeNull();
    expect(JSON.parse(byRefresh!.body)).toEqual({ refreshToken: "held-refresh" });
    expect(e.at("/auth/refresh")).toEqual([]);
  });

  it("401, then an older server without the refresh door: signed out here, said as not ended", { timeout: 30_000 }, async () => {
    const e = await door({
      script: (path) => path === "/auth/logout" ? json({ error: { code: "unauthorized" } }, 401)
        : path === "/auth/refresh/logout" ? new Response("not found", { status: 404 }) : null,
    });
    expect((await e.signOut()).body).toEqual({ status: "signed_out", revokedAtHost: false, queued: 0 });
    expect(e.at("/auth/refresh/logout")).toHaveLength(1);
    expect(e.sealed()).toBe(false);
    expect(await e.read()).toBe(409);
  });
});

describe("signing in again after a sign-out the server never heard", () => {
  it("names the family this install held, so the server can end it", { timeout: 30_000 }, async () => {
    const e = await door({
      script: (path) => path === "/auth/logout" ? Promise.reject(new TypeError("fetch failed"))
        : path === "/auth/login" ? json({ status: "twofa_required", loginToken: "lt" })
        : path === "/auth/2fa/totp/verify" ? json({ tokens: { accessToken: "next-access", refreshToken: "next-refresh" } })
        : path === "/auth/session" ? json({ user: { email: "me@ohmail.test" } }) : null,
    });
    expect((await e.signOut()).body).toEqual({ status: "signed_out", revokedAtHost: false, queued: 0 });
    const res = await e.sidecar.handle(new Request("http://sidecar/cloud/signin", {
      method: "POST", headers: { authorization: `Bearer ${e.sidecar.sessionToken}` },
      body: JSON.stringify({ email: "me@ohmail.test", password: "pw", totp: "123456" }),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    const [verify] = e.at("/auth/2fa/totp/verify");
    expect(JSON.parse(verify!.body).previousSession, "the server cannot end a family nobody names")
      .toBe(createHash("sha256").update("held-refresh", "utf8").digest("base64url"));
    expect(JSON.parse(e.at("/auth/login")[0]!.body).previousSession, "only the minting step carries it").toBeUndefined();
  });
});

describe("ONE deadline over the whole DELETE", () => {
  const BOUND = SIGN_OUT_AT_HOST_MS + 1_500;
  /** What the deadline gives the window's accepted writes before the revoke takes its reserve. */
  const SHARE = SIGN_OUT_AT_HOST_MS - REVOKE_RESERVE_MS;
  /** The press, or null when it is still out well past the bound — a held press reads as a verdict. */
  const capped = <T>(press: Promise<T>): Promise<T | null> =>
    Promise.race([press, new Promise<null>((r) => setTimeout(() => r(null), BOUND + 4_000))]);

  it("(i) the bearer door never answers: the press is answered at the bound", { timeout: 30_000 }, async () => {
    const e = await door({ script: (path, row, init) => (path === "/auth/logout" ? hang(row, init) : null) });
    const out = await capped(e.signOut());
    expect(out, "the press was held by a server that never answered").not.toBeNull();
    expect(out!.body).toEqual({ status: "signed_out", revokedAtHost: false, queued: 0 });
    expect(out!.ms).toBeLessThan(BOUND);
    expect(e.at("/auth/logout")[0]?.abortedAt, "the hung sign-out was never given up").not.toBeNull();
    expect(e.sealed()).toBe(false);
  });

  it("(ii) 401, then the refresh door never answers: the bound holds and nothing renews", { timeout: 30_000 }, async () => {
    const e = await door({
      script: (path, row, init) => path === "/auth/logout" ? json({ error: { code: "unauthorized" } }, 401)
        : path === "/auth/refresh/logout" ? hang(row, init) : null,
    });
    const out = await capped(e.signOut());
    expect(out, "the press was held by a server that never answered").not.toBeNull();
    expect(out!.body).toEqual({ status: "signed_out", revokedAtHost: false, queued: 0 });
    expect(out!.ms).toBeLessThan(BOUND);
    expect(e.at("/auth/refresh"), "a renewal ran under the sign-out").toEqual([]);
    expect(e.at("/auth/refresh/logout")[0]?.abortedAt).not.toBeNull();
  });

  it("(iii) a pull in flight is ended by the stop, at once, and says nothing about it", { timeout: 30_000 }, async () => {
    const e = await door({ script: (path, row, init) => (path === "/mailboxes" ? hang(row, init) : null) });
    void e.sidecar.start().catch(() => undefined);
    expect(await until(5_000, () => e.at("/mailboxes").length > 0), "the first pull never asked").toBe(true);
    const pressedAt = Date.now();
    const out = await capped(e.signOut());
    expect(out, "the press was held by a pull nobody ended").not.toBeNull();
    expect(out!.body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(out!.ms, "the press waited on a pull the stop should have ended").toBeLessThan(1_500);
    const pull = e.at("/mailboxes")[0]!;
    expect(pull.abortedAt, "the pull's request was never aborted").not.toBeNull();
    expect(pull.abortedAt! - pressedAt).toBeLessThan(1_000);
    /* The pull's rejection lands after the answer; give its catch a turn before reading the log. */
    await new Promise((r) => setTimeout(r, 200));
    expect(e.lines.filter((l) => l.event === "cloud_pull_failed"), "the stop's own abort was logged as a failure").toEqual([]);
  });

  it("(iii) the same for a pull the poll started: its abort is not a failure either", { timeout: 30_000 }, async () => {
    let mailboxLists = 0;
    const e = await door({
      pollIntervalMs: 50,
      script: (path, row, init) => (path === "/mailboxes" && ++mailboxLists > 1 ? hang(row, init) : null),
    });
    void e.sidecar.start().catch(() => undefined);
    expect(await until(10_000, () => e.at("/mailboxes").length > 1), "the poll never asked again").toBe(true);
    const out = await capped(e.signOut());
    expect(out, "the press was held by a pull nobody ended").not.toBeNull();
    expect(out!.ms).toBeLessThan(1_500);
    expect(e.at("/mailboxes")[1]!.abortedAt, "the scheduled pull was never aborted").not.toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    expect(e.lines.filter((l) => l.event === "cloud_pull_failed"), "the stop's own abort was logged as a failure").toEqual([]);
  });

  it("(v) a second sign-out while the first teardown is still out keeps it: the stop waits for both", { timeout: 40_000 }, async () => {
    let finish = (): void => {};
    const e = await door({
      script: (path) => {
        if (path !== "/mailboxes") return null;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            finish = () => { try { controller.error(new Error("released by the test")); } catch { /* closed */ } };
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    releases.push(() => finish());
    void e.sidecar.start().catch(() => undefined);
    expect(await until(5_000, () => e.at("/mailboxes").length > 0)).toBe(true);
    expect(await capped(e.signOut()), "the window's sign-out").not.toBeNull();
    const shells = await capped(e.signOut());
    expect(shells?.body, "the shell's sign-out, with nothing left to hold").toEqual({ status: "signed_out", queued: 0 });
    sidecars.splice(sidecars.indexOf(e.sidecar), 1);
    let stopped = false;
    const stopping = e.sidecar.stop().then(() => { stopped = true; }, () => { stopped = true; });
    await new Promise((r) => setTimeout(r, 1_000));
    expect(stopped, "the stop closed the database under a teardown still out").toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });

  /** A write the window relays through the engine: `PATCH /messages/m1`, as the outbox sends it. */
  const relayWrite = (e: Awaited<ReturnType<typeof door>>): Promise<Response> =>
    e.sidecar.handle(new Request("http://sidecar/messages/m1", {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${e.sidecar.sessionToken}`, "content-type": "application/json",
        "idempotency-key": "a-write-before-the-press",
      },
      body: JSON.stringify({ isRead: true }),
    }));

  it("(vi) a write the window relayed before the press is answered first, once, and the session is ended after it", { timeout: 30_000 }, async () => {
    let completed = 0;
    let completedAt = 0;
    let cutOff = false;
    const e = await door({
      script: (path, row, init) => {
        if (path !== "/messages/m1" || row.method !== "PATCH") return null;
        /* The server answers after 1.5 s, unless the request's own signal ends it first. */
        return new Promise<Response>((resolve, reject) => {
          const t = setTimeout(() => { completed += 1; completedAt = Date.now(); resolve(json({ id: "m1" })); }, 1_500);
          init?.signal?.addEventListener("abort", () => { clearTimeout(t); cutOff = true; reject(init.signal!.reason); });
        });
      },
    });
    const write = relayWrite(e);
    expect(await until(5_000, () => e.at("/messages/m1").length === 1), "the write never reached the server").toBe(true);
    const out = await capped(e.signOut());
    expect(out, "the press was held").not.toBeNull();
    expect(out!.body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(out!.ms, "the press waited past its deadline").toBeLessThan(SIGN_OUT_AT_HOST_MS);
    const answered = await write;
    expect(completedAt, "control: the server answered the write").toBeGreaterThan(0);
    expect(e.at("/auth/logout")[0]!.at, "the session was ended before the write it was carrying").toBeGreaterThanOrEqual(completedAt);
    expect(cutOff, "the sign-out cut off a write the window made").toBe(false);
    expect(answered.status, "the window was told its write did not happen").toBe(200);
    expect(completed, "the account did not receive the write exactly once").toBe(1);
    expect(e.at("/messages/m1")).toHaveLength(1);
  });

  it("(vii) a relayed write that never answers holds the press for its share only, and is not ended by it", { timeout: 30_000 }, async () => {
    const e = await door({
      script: (path, row, init) => (path === "/messages/m1" && row.method === "PATCH" ? hang(row, init) : null),
    });
    void relayWrite(e);
    expect(await until(5_000, () => e.at("/messages/m1").length === 1)).toBe(true);
    const out = await capped(e.signOut());
    expect(out, "the press was held by a write that never answered").not.toBeNull();
    expect(out!.body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(out!.ms, "the revoke did not wait for the write's share").toBeGreaterThanOrEqual(SHARE - 250);
    expect(out!.ms, "the share took the revoke's reserve").toBeLessThan(SIGN_OUT_AT_HOST_MS);
    await new Promise((r) => setTimeout(r, 200));
    expect(e.at("/messages/m1")[0]!.abortedAt, "the press ended a write the window made").toBeNull();
  });

  it("(iv) a page that never finishes applying: the press is answered at the bound anyway", { timeout: 30_000 }, async () => {
    let finish = (): void => {};
    const e = await door({
      script: (path) => {
        if (path !== "/mailboxes") return null;
        /* A body no signal reaches: the fetch has answered, and the work after it ignores the stop. */
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            finish = () => { try { controller.error(new Error("released by the test")); } catch { /* closed */ } };
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    releases.push(() => finish());
    void e.sidecar.start().catch(() => undefined);
    expect(await until(5_000, () => e.at("/mailboxes").length > 0)).toBe(true);
    const out = await capped(e.signOut());
    expect(out, "the press was held by a teardown that never finished").not.toBeNull();
    expect(out!.body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(out!.ms).toBeGreaterThanOrEqual(SIGN_OUT_AT_HOST_MS - 250);
    expect(out!.ms).toBeLessThan(BOUND);
    expect(e.sealed()).toBe(false);
  });
});

/**
 * THE WINDOW'S WRITES LAND BEFORE THE SESSION ENDS, OR WAIT FOR IT. A server with session state:
 * `POST /auth/logout` ends the session the moment it arrives, and a write is judged when IT
 * arrives. The press gives the writes it already accepted the deadline less the revoke's reserve;
 * one still out then meets the ended session and is kept for the next sign-in, never cut off.
 */
describe("a write on its way when Sign out is pressed", () => {
  const MSG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SHARE = SIGN_OUT_AT_HOST_MS - REVOKE_RESERVE_MS;
  interface Session { revoked: boolean; applied: number; refused401: number; logoutAt: number | null; arrivedAt: number | null }
  const pause = (ms: number, signal?: AbortSignal | null): Promise<void> => new Promise<void>((resolve, reject) => {
    if (ms <= 0) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); });
  });
  /** `uploadMs`: still on its way; `processMs`: judged on arrival, then processed. */
  const sessionServer = (shape: { uploadMs?: number; processMs?: number; logoutAnswerMs?: number }) => {
    const state: Session = { revoked: false, applied: 0, refused401: 0, logoutAt: null, arrivedAt: null };
    const script: Script = (path, row, init) => {
      if (path === "/auth/logout") {
        state.revoked = true;
        state.logoutAt = Date.now();
        return pause(shape.logoutAnswerMs ?? 0, init?.signal).then(() => new Response(null, { status: 204 }));
      }
      if (path !== `/messages/${MSG}` || row.method !== "PATCH") return null;
      return (async (): Promise<Response> => {
        await pause(shape.uploadMs ?? 0, init?.signal);
        state.arrivedAt = Date.now();
        if (state.revoked) {
          state.refused401 += 1;
          return json({ error: { code: "unauthorized", message: "authentication required" } }, 401);
        }
        await pause(shape.processMs ?? 0, init?.signal);
        state.applied += 1;
        return json({ id: MSG, unread: false });
      })();
    };
    return { state, script };
  };
  const write = async (e: Awaited<ReturnType<typeof door>>, body: BodyInit = JSON.stringify({ unread: false })) => {
    const res = await e.sidecar.handle(new Request(`http://sidecar/messages/${MSG}`, {
      method: "PATCH", body, duplex: "half",
      headers: {
        authorization: `Bearer ${e.sidecar.sessionToken}`, "content-type": "application/json",
        "idempotency-key": "a-write-on-its-way",
      },
    } as RequestInit));
    const said = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
    return { status: res.status, code: said?.error?.code ?? null };
  };

  for (const [name, shape] of [
    ["judged on arrival, then processed for 1.5 s", { processMs: 1_500 }],
    ["still arriving for 1.5 s", { uploadMs: 1_500 }],
  ] as const) {
    it(`(viii) a write ${name} is applied under the session, which is ended after it`, { timeout: 30_000 }, async () => {
      const server = sessionServer(shape);
      const e = await door({ script: server.script });
      const pending = write(e);
      await new Promise((r) => setTimeout(r, 200));
      const out = await e.signOut();
      const answered = await pending;
      expect(answered, "the window was not told its write was done").toEqual({ status: 200, code: null });
      expect(server.state.applied, "the account did not apply the write once").toBe(1);
      expect(server.state.refused401, "the write met the session the press ended").toBe(0);
      expect(out.body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
      expect(out.ms, "the press waited past its deadline").toBeLessThan(SIGN_OUT_AT_HOST_MS);
      expect(server.state.logoutAt!, "the session ended before the write reached it").toBeGreaterThanOrEqual(server.state.arrivedAt!);
    });
  }

  it("(ix) a write still arriving after the share meets the ended session and is kept, not done", { timeout: 30_000 }, async () => {
    /* The revoke lands at the share (3 s) and is answered 1.5 s later; the write arrives at 4.2 s. */
    const server = sessionServer({ uploadMs: 4_200, logoutAnswerMs: 1_500 });
    const e = await door({ script: server.script });
    const pending = write(e);
    await new Promise((r) => setTimeout(r, 200));
    const out = await e.signOut();
    const answered = await pending;
    expect(out.body, "the revoke was not given its reserve").toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(out.ms, "the press waited past its deadline").toBeLessThan(SIGN_OUT_AT_HOST_MS);
    expect(answered, "a write the ended session refused was not kept").toEqual({ status: 503, code: "offline_read_only" });
    expect(server.state.applied, "a write was applied after the session it was made in ended").toBe(0);
    expect(server.state.refused401).toBe(1);
    expect(server.state.arrivedAt!).toBeGreaterThan(server.state.logoutAt!);
  });

  it("(x) a write whose body never finishes uploading: the press answers at the share and does not end it", { timeout: 30_000 }, async () => {
    const server = sessionServer({});
    const e = await door({ script: server.script });
    let finish = (): void => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"unread":'));
        finish = () => {
          try { controller.enqueue(new TextEncoder().encode("false}")); controller.close(); } catch { /* closed */ }
        };
      },
    });
    releases.push(() => finish());
    const pending = write(e, body);
    await new Promise((r) => setTimeout(r, 200));
    const out = await e.signOut();
    expect(out.body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(out.ms, "the revoke did not wait for the upload's share").toBeGreaterThanOrEqual(SHARE - 450);
    expect(out.ms, "the share took the revoke's reserve").toBeLessThan(SIGN_OUT_AT_HOST_MS);
    const settled = await Promise.race([pending.then(() => "answered"), new Promise((r) => setTimeout(() => r("still out"), 300))]);
    expect(settled, "the press ended a write the window was still sending").toBe("still out");
    finish();
    expect(await pending, "the write, finished after the session ended, was not kept").toEqual({ status: 503, code: "offline_read_only" });
    expect(server.state.applied).toBe(0);
  });

  it("(xi) the answer and /health say how many of the window's changes wait for this account", { timeout: 30_000 }, async () => {
    const e = await door();
    const health = async (): Promise<unknown> =>
      ((await (await e.sidecar.handle(new Request("http://sidecar/health"))).json()) as { queued?: unknown }).queued;
    const outbox = `http://sidecar/local/window/outbox?scope=${encodeURIComponent(e.sidecar.servedMailboxId())}`;
    const put = await e.sidecar.handle(new Request(outbox, {
      method: "POST", headers: { authorization: `Bearer ${e.sidecar.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ puts: [{ type: "outbox_entry", id: "o1", entity: { v: 3, id: "o1", key: "k-o1", n: 1, at: 1 } }] }),
    }));
    expect(put.status, "control: the window's change was recorded").toBe(204);
    expect(await health()).toEqual({ count: 1 });
    const out = await e.signOut();
    expect(out.body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 1 });
    expect(e.lines.filter((l) => l.event === "cloud_sign_out_deferred_writes").map((l) => l.detail)).toEqual([{ count: 1 }]);
    expect(await health(), "signed out, the count is still said for the sign-in card").toEqual({ count: 1 });
  });

  it("(xi) with nothing waiting the answer says 0 and the log says nothing", { timeout: 30_000 }, async () => {
    const e = await door();
    expect((await e.signOut()).body).toEqual({ status: "signed_out", revokedAtHost: true, queued: 0 });
    expect(e.lines.filter((l) => l.event === "cloud_sign_out_deferred_writes")).toEqual([]);
  });
});

describe("after the sign-out, a write is asked to wait and a read is refused", () => {
  it("a write: 409 not_signed_in, retryable, Retry-After 30; a read: the bare 409", { timeout: 30_000 }, async () => {
    const e = await door();
    await e.signOut();
    const auth = { authorization: `Bearer ${e.sidecar.sessionToken}` };
    const w = await e.sidecar.handle(new Request("http://sidecar/messages/m1", {
      method: "PATCH", headers: { ...auth, "content-type": "application/json", "idempotency-key": "after-the-press" },
      body: JSON.stringify({ isRead: true }),
    }));
    expect(w.status).toBe(409);
    expect(w.headers.get("retry-after"), "a write is re-asked on every drive with no named wait").toBe("30");
    expect(((await w.json()) as { error: unknown }).error).toMatchObject({ code: "not_signed_in", retryable: true });
    const r = await e.sidecar.handle(new Request("http://sidecar/mailboxes", { headers: auth }));
    expect(r.status).toBe(409);
    expect(r.headers.get("retry-after")).toBeNull();
    const read = ((await r.json()) as { error: Record<string, unknown> }).error;
    expect(read.code, "the code is spelled the same for a read and a write").toBe("not_signed_in");
    expect(read.retryable, "a read's refusal was widened").toBeUndefined();
    expect(e.at("/messages/m1"), "a write went out with no session").toEqual([]);
  });
});

/**
 * QUIT IS NOT A SIGN-OUT: the shell's shutdown (`main.ts`) releases the held question, waits for
 * every accepted request to be answered, and only then stops the engine, so a write in flight at
 * quit lands. A stop while one is still out does not end it either: it carries its own signal.
 */
describe("a write in flight at quit", () => {
  const server = () => {
    const state = { completed: 0, cutOff: false };
    const script: Script = (path, row, init) => {
      if (path !== "/messages/m1" || row.method !== "PATCH") return null;
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => { state.completed += 1; resolve(json({ id: "m1" })); }, 1_500);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); state.cutOff = true; reject(init.signal!.reason); });
      });
    };
    return { state, script };
  };
  const relay = (e: Awaited<ReturnType<typeof door>>): Promise<Response> =>
    e.sidecar.handle(new Request("http://sidecar/messages/m1", {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${e.sidecar.sessionToken}`, "content-type": "application/json",
        "idempotency-key": "a-write-at-quit",
      },
      body: JSON.stringify({ isRead: true }),
    }));

  it("(11) in the shutdown's order it is answered before the engine stops: applied once, the window told 200", { timeout: 30_000 }, async () => {
    const s = server();
    const e = await door({ script: s.script });
    const write = relay(e);
    expect(await until(5_000, () => e.at("/messages/m1").length === 1)).toBe(true);
    e.sidecar.releaseHeld();
    const answered = await write;
    sidecars.splice(sidecars.indexOf(e.sidecar), 1);
    await e.sidecar.stop();
    expect(answered.status).toBe(200);
    expect(s.state).toEqual({ completed: 1, cutOff: false });
  });

  it("(11) a stop while it is still out does not end it: the account applies it once", { timeout: 30_000 }, async () => {
    const s = server();
    const e = await door({ script: s.script });
    void relay(e).catch(() => undefined);
    expect(await until(5_000, () => e.at("/messages/m1").length === 1)).toBe(true);
    sidecars.splice(sidecars.indexOf(e.sidecar), 1);
    await e.sidecar.stop();
    expect(await until(5_000, () => s.state.completed === 1), "the write the stop met never landed").toBe(true);
    expect(s.state.cutOff, "the stop ended a write the window made").toBe(false);
  });
});
