import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticKeyProvider } from "@trafficflow/core";
import {
  createCloudAuth, loadSealedTokens, openSealedTokens, readSessionMarker, sealTokens,
  RETRY_CAP_MS, type CloudAuth, type CloudAuthConfig, type CloudSessionReading,
} from "../src/cloud-auth.js";
import { readMachineBinding } from "../src/machine-binding.js";

/**
 * A DESKTOP SESSION ENDS ONLY WHEN THE REFRESH DOOR SAYS SO, WITH A CODE.
 *
 * The sign-in dialog was a latch on "401 or 403 at the refresh", so a firewall's challenge page,
 * a busy database or a keychain that would not write signed the desktop out — and a rotation the
 * disk had not recorded made the next launch present a spent token, which revoked the family.
 * Each double below fails the way the real thing fails: an HTML 403, a coded 503 with
 * `Retry-After`, a thrown transport error, a real filesystem refusal.
 */

const dirs: string[] = [];
const auths: CloudAuth[] = [];
afterEach(() => {
  for (const a of auths.splice(0)) a.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

function tmp(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-session-durable-"));
  dirs.push(d);
  return d;
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const aKek = (): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

/** What the refresh door answers, one entry per presentation; the last one repeats. */
type Answer = () => Response | Promise<Response>;

interface Door {
  fetchImpl: typeof fetch;
  refreshes: { refreshToken: string; attemptId: string }[];
}

/** The hosted API: `/sync` takes only the current access token, `/auth/refresh` answers in turn. */
function door(answers: Answer[], live = { access: "fresh" }): Door {
  const refreshes: Door["refreshes"] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(String(url));
    if (u.pathname === "/auth/refresh") {
      refreshes.push(JSON.parse(String(init!.body)) as Door["refreshes"][number]);
      return answers[Math.min(refreshes.length - 1, answers.length - 1)]!();
    }
    const bearer = new Headers(init?.headers).get("authorization");
    if (bearer !== `Bearer ${live.access}`) return json({ error: { code: "unauthorized" } }, 401);
    return json({ ok: true });
  }) as typeof fetch;
  return { fetchImpl, refreshes };
}

const minted = (access = "fresh", refresh = "r2", expiresIn?: number): Answer => () =>
  json({ tokens: { accessToken: access, refreshToken: refresh, tokenType: "Bearer", ...(expiresIn ? { expiresIn } : {}) } });
const firewall403: Answer = () =>
  new Response("<html><body>Checking your browser…</body></html>", { status: 403, headers: { "content-type": "text/html" } });
const dbBusy: Answer = () => json(
  { error: { code: "db_busy", message: "busy", retryable: true } }, 503, { "retry-after": "7" },
);
const refused = (code: string): Answer => () => json({ error: { code, message: "no" } }, 401);
const lost: Answer = () => { throw new TypeError("fetch failed"); };

function auth(d: Door, over: Partial<CloudAuthConfig> = {}): CloudAuth {
  const a = createCloudAuth({
    baseUrl: "https://cloud.test",
    tokens: { accessToken: "stale", refreshToken: "r1" },
    fetchImpl: d.fetchImpl,
    ...over,
  });
  auths.push(a);
  return a;
}

describe("a fault at the refresh door keeps the session", () => {
  it("a firewall's HTML 403: renewing, never refused, the request told offline, the seal kept", async () => {
    const dir = tmp();
    const sealPath = join(dir, "cloud-tokens.seal");
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    await sealTokens(sealPath, keyProvider, { accessToken: "stale", refreshToken: "r1" });
    const d = door([firewall403]);
    const told: string[] = [];
    const a = auth(d, { keyProvider, sealPath, onSessionRefused: (c) => told.push(c) });

    const res = await a.authedFetch("/sync?since=0");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("offline_read_only");
    expect(a.session()).toMatchObject({ state: "renewing", code: "http_403" });
    expect(told, "a 403 is a platform's answer, not a refusal").toEqual([]);
    expect(await loadSealedTokens(sealPath, keyProvider), "the saved session is the live one")
      .toMatchObject({ refreshToken: "r1", refreshAttempt: d.refreshes[0]!.attemptId });
  });

  it("an envelope code that is not a refusal (or any 403) is a fault; the three codes and the legacy one refuse", async () => {
    const cases: [Answer, CloudSessionReading["state"], string][] = [
      [() => json({ error: { code: "step_up_required" } }, 401), "renewing", "step_up_required"],
      [() => json({ error: { code: "refresh_revoked" } }, 403), "renewing", "refresh_revoked"],
      [() => new Response("", { status: 429 }), "renewing", "http_429"],
      [refused("refresh_missing"), "refused", "refresh_missing"],
      [refused("refresh_expired"), "refused", "refresh_expired"],
      [refused("refresh_revoked"), "refused", "refresh_revoked"],
      [refused("unauthorized"), "refused", "unauthorized"],
    ];
    for (const [answer, state, code] of cases) {
      const a = auth(door([answer]));
      await a.authedFetch("/sync");
      expect(a.session(), `${state} for ${code}`).toMatchObject({ state, code });
    }
  });

  it("a busy 503 with Retry-After is retried at exactly the header's value, and requests do not hurry it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const d = door([dbBusy, minted()]);
    const waits: (number | null)[] = [];
    const a = auth(d, { onSessionState: (_r, next) => waits.push(next.retryInMs) });

    expect((await a.authedFetch("/sync")).status).toBe(503);
    expect(a.session()).toMatchObject({ state: "renewing", code: "db_busy" });
    expect(waits).toEqual([7_000]);
    expect((await a.authedFetch("/sync")).status, "a request meeting the wait is told offline").toBe(503);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(d.refreshes, "not before the server's own interval").toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.refreshes, "the retry at the header's value").toHaveLength(2);
    expect(a.session().state).toBe("live");
    expect((await a.authedFetch("/sync")).status).toBe(200);
  });

  it("a network failure is unreachable, retried on a doubling backoff that never passes a minute", async () => {
    const d = door([lost]);
    const waits: (number | null)[] = [];
    const a = auth(d, { random: () => 1, onSessionState: (_r, next) => waits.push(next.retryInMs) });
    await a.authedFetch("/sync");
    for (let i = 0; i < 7; i += 1) await a.renewNow();
    expect(a.session()).toMatchObject({ state: "unreachable", code: "network" });
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, RETRY_CAP_MS, RETRY_CAP_MS]);
    // The jitter's floor: half the step, so a herd of installs does not return at one instant.
    const low: (number | null)[] = [];
    const b = auth(door([lost]), { random: () => 0, onSessionState: (_r, next) => low.push(next.retryInMs) });
    await b.authedFetch("/sync");
    expect(low).toEqual([500]);
  });
});

describe("a renewal the disk cannot record is not performed", () => {
  it("the attempt's name will not write: ZERO requests and seal_failed; once it writes, exactly one", async () => {
    const dir = tmp();
    const sealPath = join(dir, "cloud-tokens.seal");
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    await sealTokens(sealPath, keyProvider, { accessToken: "stale", refreshToken: "r1" });
    // A REAL refusal: a directory where the atomic write stages its file.
    const staging = `${sealPath}.${process.pid}.tmp`;
    mkdirSync(staging);
    const d = door([minted()]);
    const lines: string[] = [];
    const a = auth(d, { keyProvider, sealPath, log: (event) => { lines.push(event); } });

    expect((await a.authedFetch("/sync")).status).toBe(503);
    expect(d.refreshes, "a name that is not on disk never goes on the wire").toHaveLength(0);
    expect(a.session()).toMatchObject({ state: "seal_failed", code: "seal_write_failed" });
    expect(a.sealState().sealed).toBe(false);
    await a.renewNow();
    await a.renewNow();
    expect(d.refreshes).toHaveLength(0);
    expect(lines.filter((e) => e === "cloud_refresh_failed"), "a refusing disk is said once, not per retry").toHaveLength(1);
    expect(await loadSealedTokens(sealPath, keyProvider)).toEqual({ accessToken: "stale", refreshToken: "r1" });

    // The positive control: the disk takes writes again (the Try again press) — one request.
    rmSync(staging, { recursive: true });
    expect((await a.renewNow()).state).toBe("live");
    expect(d.refreshes).toHaveLength(1);
    expect(await loadSealedTokens(sealPath, keyProvider)).toEqual({ accessToken: "fresh", refreshToken: "r2" });
  });

  it("refused AFTER the server answered: the disk keeps the spent token beside its name, and no renewal outruns it", async () => {
    const dir = tmp();
    const sealPath = join(dir, "cloud-tokens.seal");
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    await sealTokens(sealPath, keyProvider, { accessToken: "stale", refreshToken: "r1" });
    const staging = `${sealPath}.${process.pid}.tmp`;
    // The disk fails between the mint and the write of what it minted.
    const d = door([() => { mkdirSync(staging); return minted()(); }]);
    const a = auth(d, { keyProvider, sealPath });

    expect((await a.authedFetch("/sync")).status, "this launch goes on with the new pair").toBe(200);
    expect(a.session().state).toBe("live");
    expect(a.sealState().sealed).toBe(false);
    const onDisk = await loadSealedTokens(sealPath, keyProvider);
    expect(onDisk, "the saved pair names the attempt that spent it — a replay, not a stranger")
      .toEqual({ accessToken: "stale", refreshToken: "r1", refreshAttempt: d.refreshes[0]!.attemptId });
    // The next renewal would move the chain on under a name the disk does not hold: withheld.
    expect((await a.renewNow()).state).toBe("seal_failed");
    expect(d.refreshes).toHaveLength(1);

    // THE NEXT LAUNCH, from the seal alone: it presents the saved token under the SAME name.
    rmSync(staging, { recursive: true });
    const d2 = door([minted("fresh", "r3")]);
    const again = auth(d2, { tokens: onDisk!, keyProvider, sealPath });
    expect((await again.authedFetch("/sync")).status).toBe(200);
    expect(d2.refreshes).toEqual([{ refreshToken: "r1", attemptId: d.refreshes[0]!.attemptId }]);
  });
});

describe("renewal runs ahead of expiry, off the request path", () => {
  it("one renewal at 80 % of expiresIn, none from requests before it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const live = { access: "fresh" };
    const d = door([minted("fresh", "r2", 900), () => { live.access = "fresher"; return minted("fresher", "r3", 900)(); }], live);
    const a = auth(d, { random: () => 0.5 });

    expect((await a.authedFetch("/sync")).status).toBe(200);
    expect(d.refreshes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(400_000);
    expect((await a.authedFetch("/sync")).status, "a request inside the window renews nothing").toBe(200);
    await vi.advanceTimersByTimeAsync(719_999 - 400_000);
    expect(d.refreshes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.refreshes, "the renewal fires at 720 s of a 900 s window").toHaveLength(2);
    expect(a.currentTokens().accessToken).toBe("fresher");
    expect((await a.authedFetch("/sync")).status).toBe(200);
  });

  it("a sign-in's pair renews at 80 % of the window it came with, with no request made", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const d = door([minted("fresher", "r2", 900)]);
    const t0 = Date.now();
    const a = auth(d, { tokens: { accessToken: "fresh", refreshToken: "r1", expiresIn: 900 }, random: () => 0.5 });
    // The relative window is read once and never carried; the pair carries its END, which the seal keeps.
    expect(a.currentTokens()).toEqual({ accessToken: "fresh", refreshToken: "r1", expiresAt: new Date(t0 + 900_000).toISOString() });
    await vi.advanceTimersByTimeAsync(719_999);
    expect(d.refreshes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.refreshes, "the sign-in's pair renews on the schedule, not on the first 401").toHaveLength(1);
    expect(a.currentTokens(), "the rotated pair carries the end of ITS window, not the first one's")
      .toEqual({ accessToken: "fresher", refreshToken: "r2", expiresAt: new Date(t0 + 720_000 + 900_000).toISOString() });

    const none = door([minted("fresher", "r2", 900)]);
    auth(none, { random: () => 0.5 });
    await vi.advanceTimersByTimeAsync(2_000_000);
    expect(none.refreshes, "a pair with no window (an older install's seal) arms nothing").toHaveLength(0);
  });

  it("an unreachable Cloud at the sign-in's scheduled renewal backs off and keeps the session", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const seen: CloudSessionReading["state"][] = [];
    const d = door([lost, minted("fresher", "r2", 900)]);
    const a = auth(d, {
      tokens: { accessToken: "fresh", refreshToken: "r1", expiresIn: 900 }, random: () => 0.5,
      onSessionState: (r) => { seen.push(r.state); },
    });
    await vi.advanceTimersByTimeAsync(720_000);
    expect(d.refreshes).toHaveLength(1);
    expect(a.session().state).toBe("unreachable");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(d.refreshes, "the retry follows on the fault's own clock").toHaveLength(2);
    expect(seen).toEqual(["unreachable", "live"]);
  });

  it("the seal holds the pair, the attempt name and the window's END, never the relative window — written and read", async () => {
    const dir = tmp();
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const sealPath = join(dir, "cloud-tokens.seal");
    const opened = async (): Promise<unknown> => {
      const file = JSON.parse(readFileSync(sealPath, "utf8")) as { ciphertext: string; keyVersion: number };
      return JSON.parse(await keyProvider.decrypt(file.ciphertext, file.keyVersion));
    };
    const at = new Date("2026-09-24T12:00:00.000Z");
    await sealTokens(sealPath, keyProvider, { accessToken: "a", refreshToken: "r", refreshAttempt: "rX", expiresIn: 900 }, at);
    expect(await opened(), "the write").toEqual({ accessToken: "a", refreshToken: "r", refreshAttempt: "rX", expiresAt: "2026-09-24T12:15:00.000Z" });
    expect(await loadSealedTokens(sealPath, keyProvider), "the read keeps the end").toEqual({
      accessToken: "a", refreshToken: "r", refreshAttempt: "rX", expiresAt: "2026-09-24T12:15:00.000Z",
    });
    // A seal carrying any other field, or an end that is not an instant, is read back as the pair alone.
    const sealed = await keyProvider.encrypt(JSON.stringify({ accessToken: "a", refreshToken: "r", expiresIn: 900, expiresAt: "soon" }));
    writeFileSync(sealPath, JSON.stringify({ ciphertext: sealed.ciphertext, keyVersion: sealed.keyVersion }));
    expect(await loadSealedTokens(sealPath, keyProvider), "the read").toEqual({ accessToken: "a", refreshToken: "r" });
  });

  it("the jitter stays within ±5 % of the share, and stop() cancels the clock", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const d = door([minted("fresh", "r2", 1_000)]);
    const a = auth(d, { random: () => 0.999 });
    await a.authedFetch("/sync");
    await vi.advanceTimersByTimeAsync(849_000);
    expect(d.refreshes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(d.refreshes, "at most 85 % of the window").toHaveLength(2);

    const d2 = door([minted("fresh", "r2", 1_000)]);
    const b = auth(d2, { random: () => 0.5 });
    await b.authedFetch("/sync");
    b.stop();
    await vi.advanceTimersByTimeAsync(2_000_000);
    expect(d2.refreshes, "a stopped client sends nothing").toHaveLength(1);
  });
});

describe("a launch renews from the window the seal carries, never from a 401", () => {
  /** The door, counting what it refused: a request with anything but the live token is a 401. */
  function counted(answers: Answer[], live = { access: "fresh" }): Door & { refused: () => number } {
    let n = 0;
    const inner = door(answers, live);
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const res = await inner.fetchImpl(url, init);
      if (res.status === 401) n += 1;
      return res;
    }) as typeof fetch;
    return { fetchImpl, refreshes: inner.refreshes, refused: () => n };
  }
  /** What the engine does at launch: read the seal the previous launch wrote, start from it. */
  async function relaunch(d: Door, sealPath: string, keyProvider: StaticKeyProvider, renewed: unknown[]): Promise<CloudAuth> {
    const tokens = await loadSealedTokens(sealPath, keyProvider);
    expect(tokens, "the launch found no seal").not.toBeNull();
    return auth(d, {
      tokens: tokens!, keyProvider, sealPath, random: () => 0.5,
      log: (event, detail) => { if (event === "cloud_session_renewed") renewed.push((detail as { kind?: unknown }).kind); },
    });
  }

  it("a sealed window of 900 s: the first renewal at 0.8 of what is left, with no 401 before it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const sealPath = join(tmp(), "cloud-tokens.seal");
    await sealTokens(sealPath, keyProvider, { accessToken: "fresh", refreshToken: "r1", expiresIn: 900 });
    await vi.advanceTimersByTimeAsync(300_000); // the app was quit and is opened 300 s into the window

    const d = counted([minted("fresher", "r2", 900)]);
    const renewed: unknown[] = [];
    const a = await relaunch(d, sealPath, keyProvider, renewed);
    expect((await a.authedFetch("/sync")).status).toBe(200);
    await vi.advanceTimersByTimeAsync(479_999);
    expect(d.refreshes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(d.refreshes, "the renewal fires at 480 s — 0.8 of the 600 s left").toHaveLength(1);
    expect(d.refused(), "a 401 came before the renewal").toBe(0);
    expect(renewed).toEqual(["scheduled"]);
  });

  it("a sealed window that has passed: one renewal, before the first request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const sealPath = join(tmp(), "cloud-tokens.seal");
    await sealTokens(sealPath, keyProvider, { accessToken: "stale", refreshToken: "r1", expiresIn: 900 });
    await vi.advanceTimersByTimeAsync(3_600_000);

    const live = { access: "fresher" };
    const d = counted([minted("fresher", "r2", 900)], live);
    const renewed: unknown[] = [];
    const a = await relaunch(d, sealPath, keyProvider, renewed);
    expect((await a.authedFetch("/sync")).status).toBe(200);
    expect(d.refreshes, "the passed window renewed once").toHaveLength(1);
    expect(d.refused(), "the first request went out with the passed token").toBe(0);
    expect(renewed).toEqual(["launch"]);
  });

  it("a seal with no window (an older install's): the 401 belt, then the window is written", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const sealPath = join(tmp(), "cloud-tokens.seal");
    const older = await keyProvider.encrypt(JSON.stringify({ accessToken: "stale", refreshToken: "r1" }));
    writeFileSync(sealPath, JSON.stringify({ ciphertext: older.ciphertext, keyVersion: older.keyVersion }));

    const d = counted([minted("fresh", "r2", 900)]);
    const renewed: unknown[] = [];
    const a = await relaunch(d, sealPath, keyProvider, renewed);
    await vi.advanceTimersByTimeAsync(2_000_000);
    expect(d.refreshes, "a seal with no window armed a renewal").toHaveLength(0);
    const renewedAt = Date.now();
    expect((await a.authedFetch("/sync")).status).toBe(200);
    expect(d.refused(), "the belt: the one 401 that renews").toBe(1);
    expect(d.refreshes).toHaveLength(1);
    expect(renewed, "the belt's renewal is logged as the request's").toEqual(["request"]);
    expect((await loadSealedTokens(sealPath, keyProvider))?.expiresAt, "the renewal wrote the window")
      .toBe(new Date(renewedAt + 900_000).toISOString());
  });
});

/**
 * A SEAL STAYS ON THE COMPUTER THAT WROTE IT. A copied or synced home carried the seal to another
 * computer, which presented a token the first one had renewed past, and the server's reuse rule
 * signed every device out. Another computer opens nothing; one that cannot name itself is no mismatch.
 */
describe("a seal stays on the computer that wrote it", () => {
  const pair = { accessToken: "a", refreshToken: "r1", refreshAttempt: "rX", expiresAt: "2026-09-24T12:15:00.000Z" };

  it("sealed under one computer and opened under another: nothing to present; its own computer opens it", async () => {
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const sealPath = join(tmp(), "cloud-tokens.seal");
    await sealTokens(sealPath, keyProvider, pair, new Date(), () => true, "machine-a");
    expect(await loadSealedTokens(sealPath, keyProvider, "machine-b"), "another computer presents nothing").toBeNull();
    expect(await openSealedTokens(sealPath, keyProvider, "machine-b")).toEqual({ kind: "elsewhere" });
    expect(await loadSealedTokens(sealPath, keyProvider, "machine-a")).toEqual(pair);
    expect(await loadSealedTokens(sealPath, keyProvider, null), "a computer that cannot name itself").toEqual(pair);
  });

  it("a renewal's attempt name and its new pair are both sealed for the computer it runs on", async () => {
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const sealPath = join(tmp(), "cloud-tokens.seal");
    await sealTokens(sealPath, keyProvider, { accessToken: "stale", refreshToken: "r1" });
    const atRequest: unknown[] = [];
    const d = door([async () => {
      atRequest.push(await loadSealedTokens(sealPath, keyProvider, "machine-b"));
      return minted("fresh", "r2", 900)();
    }]);
    const a = auth(d, { keyProvider, sealPath, machine: "machine-a" });
    expect((await a.renewNow()).state).toBe("live");
    expect(atRequest, "the attempt's name went down bound").toEqual([null]);
    expect(await loadSealedTokens(sealPath, keyProvider, "machine-b")).toBeNull();
    expect(await loadSealedTokens(sealPath, keyProvider, "machine-a")).toMatchObject({ accessToken: "fresh", refreshToken: "r2" });
  });

  it("an unbound seal (an older install's) opens on any computer, said as unbound", async () => {
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const sealPath = join(tmp(), "cloud-tokens.seal");
    await sealTokens(sealPath, keyProvider, pair);
    expect(await openSealedTokens(sealPath, keyProvider, "machine-b")).toEqual({ kind: "opened", tokens: pair, bound: false });
  });

  it("what a launch reads: none, unreadable, or opened and bound", async () => {
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const sealPath = join(tmp(), "cloud-tokens.seal");
    expect(await openSealedTokens(sealPath, keyProvider, "machine-a")).toEqual({ kind: "none" });
    mkdirSync(sealPath);
    expect(await openSealedTokens(sealPath, keyProvider, "machine-a"), "a read that fails is not an absence").toEqual({ kind: "unreadable" });
    rmSync(sealPath, { recursive: true });
    const unnamed = await keyProvider.encrypt(JSON.stringify({ accessToken: "a", refreshToken: "r1" }));
    writeFileSync(sealPath, JSON.stringify({ v: 2, sealed: unnamed.ciphertext, keyVersion: unnamed.keyVersion }));
    expect(await openSealedTokens(sealPath, keyProvider, "machine-a"), "a bound file naming no computer").toEqual({ kind: "unreadable" });
    await sealTokens(sealPath, keyProvider, pair, new Date(), () => true, "machine-a");
    const bound = JSON.parse(readFileSync(sealPath, "utf8")) as { sealed: string; keyVersion: number };
    expect(await openSealedTokens(sealPath, new StaticKeyProvider({ 1: aKek() }), "machine-a"), "another key").toEqual({ kind: "unreadable" });
    expect(await openSealedTokens(sealPath, keyProvider, "machine-a")).toEqual({ kind: "opened", tokens: pair, bound: true });
    writeFileSync(sealPath, JSON.stringify({ ciphertext: bound.sealed, keyVersion: bound.keyVersion }));
    expect(await openSealedTokens(sealPath, keyProvider, "machine-b"), "rewrapped in the older shape, still not unbound").toEqual({ kind: "unreadable" });
  });

  it("a reader that predates the binding (0.30.12's) opens nothing in a bound seal, and still opens an unbound one", async () => {
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const sealPath = join(tmp(), "cloud-tokens.seal");
    const older = async (): Promise<unknown> => {
      try {
        const file = JSON.parse(readFileSync(sealPath, "utf8")) as { ciphertext: string; keyVersion: number };
        const t = JSON.parse(await keyProvider.decrypt(file.ciphertext, file.keyVersion)) as Record<string, unknown>;
        return typeof t.accessToken === "string" && typeof t.refreshToken === "string" ? t : null;
      } catch {
        return null;
      }
    };
    await sealTokens(sealPath, keyProvider, { accessToken: "a", refreshToken: "r1" }, new Date(), () => true, "machine-a");
    expect(await older()).toBeNull();
    await sealTokens(sealPath, keyProvider, { accessToken: "a", refreshToken: "r1" });
    expect(await older()).toEqual({ accessToken: "a", refreshToken: "r1" });
  });
});

describe("the install's previous family is named beside the seal", () => {
  /** The server's `hashToken`, spelled with node's crypto so the wire encoding is under test. */
  const digest = (token: string): string => createHash("sha256").update(token, "utf8").digest("base64url");

  it("every seal names its family for the computer it was written on, and a renewal moves the name", async () => {
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const dir = tmp();
    const sealPath = join(dir, "cloud-tokens.seal");
    expect(readSessionMarker(dir, "machine-a"), "nothing sealed, nothing named").toBeNull();
    await sealTokens(sealPath, keyProvider, { accessToken: "stale", refreshToken: "r1" }, new Date(), () => true, "machine-a");
    expect(readSessionMarker(dir, "machine-a")).toBe(digest("r1"));
    const a = auth(door([minted("fresh", "r2", 900)]), { keyProvider, sealPath, machine: "machine-a" });
    expect((await a.renewNow()).state).toBe("live");
    expect(readSessionMarker(dir, "machine-a"), "the name follows the renewal").toBe(digest("r2"));
    rmSync(sealPath);
    expect(readSessionMarker(dir, "machine-a"), "the name outlives the seal a sign-out removes").toBe(digest("r2"));
  });

  it("a name written on another computer is not this one's to send; an unnamed computer reads only its own", async () => {
    const keyProvider = new StaticKeyProvider({ 1: aKek() });
    const dir = tmp();
    const sealPath = join(dir, "cloud-tokens.seal");
    await sealTokens(sealPath, keyProvider, { accessToken: "a", refreshToken: "r1" }, new Date(), () => true, "machine-a");
    expect(readSessionMarker(dir, "machine-b")).toBeNull();
    expect(readSessionMarker(dir, null)).toBeNull();
    await sealTokens(sealPath, keyProvider, { accessToken: "a", refreshToken: "r1" });
    expect(readSessionMarker(dir, null)).toBe(digest("r1"));
    expect(readSessionMarker(dir, "machine-a")).toBeNull();
    writeFileSync(join(dir, "cloud-session.marker"), "{not json");
    expect(readSessionMarker(dir, null), "a damaged name names nothing").toBeNull();
  });
});

describe("the computer a seal is bound to", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  const UUID = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9";
  const files = (map: Record<string, string>) => async (p: string): Promise<string> => {
    if (p in map) return map[p]!;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  };
  const linux = (map: Record<string, string>): Promise<string | null> => readMachineBinding({ platform: "linux", readText: files(map) });

  it("Linux: /etc/machine-id, else D-Bus's copy; a digest, never the id", async () => {
    const a = await linux({ "/etc/machine-id": `${ID}\n` });
    expect(a).toMatch(/^[\w-]{43}$/);
    expect(a).not.toContain(ID);
    expect(await linux({ "/var/lib/dbus/machine-id": ID })).toBe(a);
    expect(await linux({ "/etc/machine-id": "uninitialized\n", "/var/lib/dbus/machine-id": ID })).toBe(a);
    expect(await linux({ "/etc/machine-id": `1${ID.slice(1)}` })).not.toBe(a);
    expect(await linux({ "/etc/machine-id": "uninitialized\n" }), "no machine named").toBeNull();
    expect(await linux({})).toBeNull();
  });

  it("macOS: IOPlatformUUID from ioreg; Windows: MachineGuid from the registry; a tool that fails names nothing", async () => {
    const asked: string[][] = [];
    const answer = (out: string) => async (file: string, args: readonly string[]): Promise<string> => {
      asked.push([file, ...args]);
      return out;
    };
    const mac = await readMachineBinding({ platform: "darwin", run: answer(`  |   "IOPlatformUUID" = "${UUID}"\n`) });
    const win = await readMachineBinding({
      platform: "win32", run: answer(`\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${UUID.toLowerCase()}\r\n`),
    });
    expect(mac).toMatch(/^[\w-]{43}$/);
    expect(win, "one id, one digest, whichever tool printed it").toBe(mac);
    expect(asked[0]).toEqual(["/usr/sbin/ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]);
    expect(asked[1]![0]).toMatch(/^[A-Za-z]:\\.*\\System32\\reg\.exe$/i);
    expect(asked[1]!.slice(1)).toEqual(["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"]);
    expect(await readMachineBinding({ platform: "darwin", run: async () => { throw new Error("spawn ETIMEDOUT"); } })).toBeNull();
    expect(await readMachineBinding({ platform: "win32", run: answer("ERROR: The system was unable to find the specified registry key or value.") })).toBeNull();
  });
});
