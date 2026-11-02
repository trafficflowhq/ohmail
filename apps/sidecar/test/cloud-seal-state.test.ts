import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticKeyProvider } from "@trafficflow/core";
import { loadSealedTokens } from "../src/cloud-auth.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A SEAL THAT DID NOT LAND IS A STATE, NOT A LOG LINE — and a renewal whose name cannot land is
 * not sent. `/health` carries `sealed` and the refusal's CLASS, so the account pane can say it;
 * and since a rotation the disk does not know about leaves the next launch presenting a spent
 * token under a new name (which the server answers by revoking the family), the refused write
 * withholds the rotation and the saved token stays the live one.
 */

/** Every removal of a seal and every flush, by path, in order: a sign-out's removal must reach the disk. */
const fsOps: string[] = [];
const openedFds = new Map<number, string>();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const removal = (path: import("node:fs").PathLike): void => {
    if (String(path).endsWith("cloud-tokens.seal")) fsOps.push(`remove ${String(path)}`);
  };
  return {
    ...actual,
    openSync: (path: import("node:fs").PathLike, ...rest: unknown[]): number => {
      const fd = (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
      openedFds.set(fd, String(path));
      return fd;
    },
    fsyncSync: (fd: number): void => {
      actual.fsyncSync(fd);
      fsOps.push(`flush ${openedFds.get(fd) ?? `fd ${fd}`}`);
    },
    unlinkSync: (path: import("node:fs").PathLike): void => {
      actual.unlinkSync(path);
      removal(path);
    },
    rmSync: (path: import("node:fs").PathLike, options?: import("node:fs").RmOptions): void => {
      actual.rmSync(path, options);
      removal(path);
    },
  };
});

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOSTED_MAILBOX = hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test");
const aKek = (): Record<number, Buffer> => ({ 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) });
/** Each data directory's ring, kept so a case can open the seal the engine wrote. */
const rings = new Map<string, Record<number, Buffer>>();
const keyProviderOf = (dataDir: string): StaticKeyProvider => new StaticKeyProvider(rings.get(dataDir)!);

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Wire { expired: boolean; rotated: boolean; refreshes: number }

/** The hosted API. `expired` turns the launch access token stale, which is what asks for a rotation. */
function hostedApi(w: Wire): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const send = (v: unknown): Response =>
      new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/auth/refresh") {
      w.rotated = true;
      w.refreshes += 1;
      return send({ tokens: { accessToken: "access-2", refreshToken: "refresh-2" } });
    }
    if (w.expired && new Headers(init?.headers).get("authorization") === "Bearer access-1") {
      return new Response("", { status: 401 });
    }
    if (url.pathname === "/mailboxes") return send(mailboxList([HOSTED_MAILBOX]));
    if (url.pathname === "/sync") return send({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: Buffer.from("1").toString("base64url"), hasMore: false, serverTime: new Date().toISOString(),
    });
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function boot(dataDir: string, w: Wire): Promise<CloudSidecar> {
  const sidecar = await createCloudSidecar({
    dataDir,
    cloudUrl: "https://cloud.test",
    address: "me@ohmail.test",
    tokens: { accessToken: "access-1", refreshToken: "refresh-1" },
    keks: rings.set(dataDir, aKek()).get(dataDir)!,
    fetchImpl: hostedApi(w),
    pollIntervalMs: 40,
  });
  sidecars.push(sidecar);
  await sidecar.start();
  return sidecar;
}

type Health = {
  signedIn: boolean; sealed: boolean; sealFailure: string | null;
  session: { state: string; code: string | null } | null;
};
const health = async (s: CloudSidecar): Promise<Health> =>
  (await s.handle(new Request("http://sidecar/health"))).json() as never;

/** Poll `/health` until `want` holds, or say what never happened. */
async function until(s: CloudSidecar, want: (h: Health) => boolean, what: string): Promise<Health> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const h = await health(s);
    if (want(h)) return h;
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("/health carries whether this install's sign-in reached the disk", () => {
  it("a seal the filesystem refuses reads sealed:false with the refusal's CLASS", { timeout: 40_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-seal-state-refused-");
    dirs.push(dataDir);
    const w: Wire = { expired: false, rotated: false, refreshes: 0 };
    const sidecar = await boot(dataDir, w);
    // The launch seal landed — the fault below is about the ROTATION, not about a first launch.
    expect(existsSync(join(dataDir, "cloud-tokens.seal"))).toBe(true);
    expect(await health(sidecar)).toMatchObject({ sealed: true, sealFailure: null });

    /* THE FAULT IS REAL, not injected: a DIRECTORY at the staging path this process would write.
       `writeAtomic` stages under `<seal>.<pid>.tmp`, and the sidecar runs in this process, so the
       name is known — the write throws before anything can be renamed over the seal. */
    mkdirSync(join(dataDir, `cloud-tokens.seal.${process.pid}.tmp`), { recursive: true });
    w.expired = true;

    const h = await until(sidecar, (x) => !x.sealed, "the engine never reported the refused seal");
    expect(w.refreshes, "a renewal whose name could not be written is NOT sent").toBe(0);
    expect(h.sealFailure ?? "", "the CLASS of the thrown value, never its message").toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(h.session, "a withheld renewal is its own state, never a sign-out").toMatchObject({
      state: "seal_failed", code: "seal_write_failed",
    });
    expect(h.signedIn, "the session stays: the saved token is still the live one").toBe(true);
    expect(await loadSealedTokens(join(dataDir, "cloud-tokens.seal"), keyProviderOf(dataDir)))
      .toMatchObject({ refreshToken: "refresh-1" });
  });

  it("an ordinary rotation seals and reads sealed:true with no reason", { timeout: 40_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-seal-state-ok-");
    dirs.push(dataDir);
    const w: Wire = { expired: false, rotated: false, refreshes: 0 };
    const sidecar = await boot(dataDir, w);
    w.expired = true;
    const deadline = Date.now() + 20_000;
    while (!w.rotated) {
      if (Date.now() > deadline) throw new Error("the rotation never happened");
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await health(sidecar)).toMatchObject({ signedIn: true, sealed: true, sealFailure: null });
    expect(w.refreshes, "the positive control: a seal that lands sends exactly one renewal").toBe(1);
  });

  // Windows cannot flush a directory; there the unlink stands alone.
  it.skipIf(process.platform === "win32")("a sign-out's seal removal is flushed to the disk before it answers", { timeout: 40_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-seal-state-sign-out-");
    dirs.push(dataDir);
    const sidecar = await boot(dataDir, { expired: false, rotated: false, refreshes: 0 });
    const seal = join(dataDir, "cloud-tokens.seal");
    expect(existsSync(seal)).toBe(true);
    fsOps.length = 0;

    const res = await sidecar.handle(new Request("http://sidecar/cloud/session", {
      method: "DELETE", headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    expect(res.status).toBe(200);
    expect(existsSync(seal)).toBe(false);
    const last = fsOps.lastIndexOf(`remove ${seal}`);
    expect(last, "the seal was never removed").toBeGreaterThanOrEqual(0);
    expect(fsOps.slice(last + 1), "a power cut after the answer brings an unflushed seal back")
      .toContain(`flush ${dataDir}`);
    expect(fsOps.indexOf(`flush ${seal}`), "the seal is emptied and flushed before its first removal")
      .toBeGreaterThan(-1);
    expect(fsOps.indexOf(`flush ${seal}`)).toBeLessThan(fsOps.indexOf(`remove ${seal}`));
  });
});
