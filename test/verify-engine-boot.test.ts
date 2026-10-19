import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ROOT } from "./support/public-root.mjs";

/**
 * VERIFY-ENGINE-BOOT'S OWN BOUND. The script is a layout check, not a timing gate: on the Windows
 * runner a healthy first start read up to 14.6 s against its 15 s kill, so a slow runner failed
 * both attempts with a data dir that held the store half made. The engine here is a stub that
 * serves when told to (or never), from a root laid out like the bundle's.
 */
const SCRIPT = join(ROOT, "scripts", "verify-engine-boot.mjs");

const STUB = `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const log = (o) => process.stderr.write(JSON.stringify({ service: "sidecar", ...o }) + "\\n");
if (!existsSync(join(root, "drizzle"))) {
  log({ event: "start_failed", err: "ENOENT: no such file or directory, the journal" });
  process.exit(1);
}
const pgdata = join(process.env.OHMAIL_DATA_DIR, "pgdata");
mkdirSync(pgdata, { recursive: true });
for (let i = 0; i < 12; i += 1) writeFileSync(join(pgdata, "f" + i), "");
const after = Number(process.env.STUB_SERVE_AFTER_MS);
if (after >= 0) {
  setTimeout(() => {
    log({ event: "boot_phases", totalReadyMs: after });
    log({ event: "serving" });
    process.stdin.on("end", () => process.exit(0));
    process.stdin.resume();
  }, after);
} else {
  setInterval(() => undefined, 1000);
}
`;

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

function stubRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "ohmail-verify-boot-"));
  dirs.push(root);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "drizzle"));
  writeFileSync(join(root, "bin", "ohmail-engine.mjs"), STUB);
  return root;
}

function verify(root: string, env: Record<string, string>): Promise<{ code: number | null; out: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((res) => {
    const child = spawn(process.execPath, [SCRIPT, root], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OHMAIL_BOOT_LOG: "", ...env },
    });
    let out = "";
    child.stdout.on("data", (b) => { out += String(b); });
    child.stderr.on("data", (b) => { out += String(b); });
    child.on("exit", (code) => res({ code, out, ms: Date.now() - t0 }));
  });
}

describe("verify-engine-boot", () => {
  it("admits a healthy first start that serves after 16 s, on the first attempt", async () => {
    const r = await verify(stubRoot(), { STUB_SERVE_AFTER_MS: "16000" });
    expect(r.out).toContain("attempt 1)");
    expect(r.out).toContain("verify-engine-boot: OK");
    expect(r.code).toBe(0);
  }, 90_000);

  it("stops a healthy engine as soon as it serves, not on a timer", async () => {
    const r = await verify(stubRoot(), { STUB_SERVE_AFTER_MS: "0" });
    expect(r.code, r.out).toBe(0);
    expect(r.ms, "the harness waited past the engine's serving line").toBeLessThan(5000);
  }, 30_000);

  it("refuses an engine that never serves, at its bound, after both attempts", async () => {
    const r = await verify(stubRoot(), { STUB_SERVE_AFTER_MS: "-1", OHMAIL_VERIFY_BOOT_BOUND_MS: "1500" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("attempt 2 did not serve either");
    expect(r.out).toContain("did NOT serve with its journal in place on 2 attempts");
  }, 30_000);
});
