import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticKeyProvider } from "@trafficflow/core";
import { loadSealedTokens, sealTokens } from "../src/cloud-auth.js";

/**
 * THE SEAL IS THE PREVIOUS COMPLETE FILE OR THE NEW COMPLETE FILE — never a prefix of either.
 *
 * `cloud-tokens.seal` is the only credential a relaunch has. Written in place, a process killed
 * mid-write left half an envelope, which `loadSealedTokens` reads as "this key does not open that
 * file" — a session lost to an interruption rather than to a refusal. `fs-atomic.ts` stages and
 * renames, so the fault below costs the ROTATION and not the session. It also flushes: a power cut
 * that dropped an unflushed seal brought back the pair before it, already spent at the server.
 */

/** Armed only for the seal's own rename, so nothing else in the process can meet it. */
let renameFaultFor: string | null = null;
/** Armed only for the flush of the seal's staging file. */
let flushFaultFor: string | null = null;
/** Each flush, by the path its descriptor was opened on, and each rename, in order. */
const ops: string[] = [];
const opened = new Map<number, string>();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: (path: import("node:fs").PathLike, ...rest: unknown[]): number => {
      const fd = (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
      opened.set(fd, String(path));
      return fd;
    },
    fsyncSync: (fd: number): void => {
      const path = opened.get(fd) ?? `fd ${fd}`;
      if (flushFaultFor !== null && path === flushFaultFor) {
        throw Object.assign(new Error("the test refused this flush"), { code: "EIO" });
      }
      ops.push(`flush ${path}`);
      actual.fsyncSync(fd);
    },
    renameSync: (from: import("node:fs").PathLike, to: import("node:fs").PathLike): void => {
      if (renameFaultFor !== null && String(to) === renameFaultFor) {
        throw Object.assign(new Error("the test refused this rename"), { code: "EIO" });
      }
      ops.push(`rename ${String(from)} -> ${String(to)}`);
      actual.renameSync(from, to);
    },
  };
});

const dirs: string[] = [];
afterEach(() => {
  renameFaultFor = null;
  flushFaultFor = null;
  ops.length = 0;
  opened.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-seal-atomic-"));
  dirs.push(d);
  return d;
}
const aKek = (): Buffer => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

describe("the token seal is written atomically", () => {
  it("a fault between the staging write and the rename leaves the OLD seal whole and readable", async () => {
    const dir = tmp();
    const path = join(dir, "cloud-tokens.seal");
    const kp = new StaticKeyProvider({ 1: aKek() });
    await sealTokens(path, kp, { accessToken: "old-access", refreshToken: "old-refresh" });
    expect(await loadSealedTokens(path, kp)).toEqual({ accessToken: "old-access", refreshToken: "old-refresh" });

    renameFaultFor = path;
    await expect(
      sealTokens(path, kp, { accessToken: "rotated", refreshToken: "new-refresh" }),
      "a seal that cannot land must REFUSE rather than report itself done",
    ).rejects.toThrow();
    renameFaultFor = null;

    // THE WHOLE POINT: the launch that follows this crash still has a credential.
    expect(
      await loadSealedTokens(path, kp),
      "the interrupted rotation must cost the rotation, never the session",
    ).toEqual({ accessToken: "old-access", refreshToken: "old-refresh" });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp")), "the staging file is cleaned up").toEqual([]);
  });

  it("an ordinary seal lands whole, private, and with nothing staged left behind", async () => {
    const dir = tmp();
    const path = join(dir, "cloud-tokens.seal");
    const kp = new StaticKeyProvider({ 1: aKek() });
    await sealTokens(path, kp, { accessToken: "a", refreshToken: "r" });

    const parsed = JSON.parse(readFileSync(path, "utf8")) as { ciphertext: string; keyVersion: number };
    expect(typeof parsed.ciphertext).toBe("string");
    expect(parsed.keyVersion).toBe(1);
    expect(statSync(path).mode & 0o777, "the mode rides the staging file, never a readable window").toBe(0o600);
    expect(readdirSync(dir)).toEqual(["cloud-tokens.seal"]);
    expect(await loadSealedTokens(path, kp)).toEqual({ accessToken: "a", refreshToken: "r" });
  });

  it("a seal is flushed to the disk before its rename, and its directory after it", async () => {
    const dir = tmp();
    const path = join(dir, "cloud-tokens.seal");
    const staging = `${path}.${process.pid}.tmp`;
    await sealTokens(path, new StaticKeyProvider({ 1: aKek() }), { accessToken: "a", refreshToken: "r" });
    expect(ops, "a rename can reach the disk ahead of the bytes it names, and an unflushed rename is undone")
      .toEqual([`flush ${staging}`, `rename ${staging} -> ${path}`, ...(process.platform === "win32" ? [] : [`flush ${dir}`])]);
  });

  it("a seal the disk cannot flush is refused, and the previous one stays whole", async () => {
    const dir = tmp();
    const path = join(dir, "cloud-tokens.seal");
    const kp = new StaticKeyProvider({ 1: aKek() });
    await sealTokens(path, kp, { accessToken: "old-access", refreshToken: "old-refresh" });

    flushFaultFor = `${path}.${process.pid}.tmp`;
    await expect(
      sealTokens(path, kp, { accessToken: "rotated", refreshToken: "new-refresh" }),
      "a seal that may not survive a power cut must refuse, so the renewal it names is not sent",
    ).rejects.toThrow();
    flushFaultFor = null;

    expect(await loadSealedTokens(path, kp)).toEqual({ accessToken: "old-access", refreshToken: "old-refresh" });
    expect(readdirSync(dir), "the staging file is cleaned up").toEqual(["cloud-tokens.seal"]);
  });
});
