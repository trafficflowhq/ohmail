import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { ATTACHMENT_FILE_TARGET_HEADER } from "../src/attachment-file.js";

/**
 * WHAT A 40 MiB SAVE COSTS THE ENGINE: a chunk, not the file. The message is appended and synced by
 * `rigs/attachment-open-ceiling-setup.mjs` in a process of its own, so this one has held nothing
 * large before it measures; then an engine on the same store saves the part into a file and its
 * peak RSS is read from /proc (VmHWM, reset just before). The buffered read the preview uses is
 * measured after it, as the control that the instrument sees a whole-file allocation.
 *
 * Mutation watched: `sinkReaderFor` buffering the part (`fetchPart`, then one write) → red.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SMTP_HOST = process.env.SMTP_HOST ?? "127.0.0.1";
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);
const MIB = 1024 * 1024;
const ROOT = join(import.meta.dirname, "..", "..", "..");

const dirs: string[] = [];
let sidecar: Sidecar | null = null;
afterAll(async () => {
  await sidecar?.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function peakRss(): number {
  return Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync("/proc/self/status", "utf8"))![1]) * 1024;
}
function resetPeakRss(): number {
  writeFileSync("/proc/self/clear_refs", "5");
  return peakRss();
}

describe.runIf(process.platform === "linux")("the streamed save's memory", () => {
  it("a 40 MiB save grows the engine by a chunk; the buffered read by the file", async () => {
    const dataDir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-sidecar-open-mem-"));
    dirs.push(dataDir);
    const address = `open-${randomUUID()}@trafficflow.test`;
    const kek = randomBytes(32);
    const out = execFileSync(
      join(ROOT, "node_modules", ".bin", "tsx"),
      ["--conditions=ohmail-source", join(ROOT, "apps/sidecar/test/rigs/attachment-open-ceiling-setup.mjs"),
        dataDir, address, kek.toString("hex"), "40"],
      { cwd: ROOT, encoding: "utf8", timeout: 240_000, env: process.env },
    );
    const clip = JSON.parse(out.trim().split("\n").pop()!) as { attachmentId: string; bytes: number; sha256: string };

    const opened = join(dataDir, "shell", "opened");
    mkdirSync(opened, { recursive: true });
    sidecar = await createSidecar({
      dataDir,
      attachmentStagingDir: opened,
      imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user: address, pass: "test" }, smtp: { host: SMTP_HOST, port: SMTP_PORT, secure: false } },
      address, displayName: "This computer", keks: { 1: kek }, pollIntervalMs: 60 * 60 * 1000,
    });
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
    const target = join(opened, `${randomBytes(16).toString("hex")}.part`);

    const before = resetPeakRss();
    const saved = await sidecar.handle(new Request(`http://sidecar/attachments/${clip.attachmentId}/file`, {
      method: "POST", headers: { ...auth, [ATTACHMENT_FILE_TARGET_HEADER]: Buffer.from(target).toString("base64") },
    }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ bytes: clip.bytes, sha256: clip.sha256 });
    const streamed = peakRss() - before;

    const before2 = resetPeakRss();
    const got = await sidecar.handle(new Request(`http://sidecar/attachments/${clip.attachmentId}`, { headers: auth }));
    const body = new Uint8Array(await got.arrayBuffer());
    const buffered = peakRss() - before2;

    expect(createHash("sha256").update(readFileSync(target)).digest("hex")).toBe(clip.sha256);
    expect(createHash("sha256").update(body).digest("hex")).toBe(clip.sha256);
    process.stderr.write(`[open-ceiling] 40 MiB peak RSS growth: streamed save ${(streamed / MIB).toFixed(1)} MiB, buffered read ${(buffered / MIB).toFixed(1)} MiB\n`);
    // Holding the part at any moment costs at least the file (40 MiB); the save's growth is the
    // garbage of 64 KiB IMAP chunks between collections (12-20 MiB measured, the same at 8 MiB).
    expect(buffered, "the instrument did not see a whole-file read").toBeGreaterThan(40 * MIB);
    expect(streamed).toBeLessThan(32 * MIB);
  }, 300_000);
});
