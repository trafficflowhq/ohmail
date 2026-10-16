import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AN UMBREL INSTALL MADE BEFORE THE OBJECT STORE BECAME RUSTFS STILL STARTS.
 *
 * `hooks/pre-start` writes data/env/secrets.env once and never again, and runs under `set -u`. An
 * install from the MinIO era holds MINIO_ROOT_PASSWORD there and no RUSTFS_ROOT_PASSWORD, so a hook
 * that only READ the new name died half way: api.env and organizer.env were already rewritten
 * without their storage block, and rustfs.env was left empty. The hook appends what is missing,
 * the way it appends TF_ORGANIZER_INSTALL_ID, and keeps every value the install already has.
 *
 * Each case runs the real hook on a scratch app directory shaped the way the previous hook left it.
 */
const HOOK = fileURLToPath(new URL("../deploy/umbrel/ohmail/hooks/pre-start", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "ohmail-umbrel-upgrade-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A dotenv file as a map; the last line for a key wins, as `source` reads it. */
function envOf(path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

function appDir(name: string, secrets?: string): string {
  const app = join(scratch, name);
  mkdirSync(join(app, "data", "env"), { recursive: true });
  writeFileSync(join(app, "data", "env", "settings.env"), "OHMAIL_ORIGIN=https://mail.example.com\n");
  if (secrets !== undefined) writeFileSync(join(app, "data", "env", "secrets.env"), secrets, { mode: 0o600 });
  return app;
}

function runHook(app: string): { rc: number | null; stderr: string } {
  const r = spawnSync("bash", [HOOK], { env: { ...process.env, APP_DATA_DIR: app }, encoding: "utf8" });
  return { rc: r.status, stderr: r.stderr };
}

/** The storage block both the api and the organizer must carry, with the store's own key. */
function expectStorageBlock(file: string, key: string) {
  const env = envOf(file);
  expect(env.get("TF_STORAGE_KIND"), `${file} has no storage block`).toBe("s3");
  expect(env.get("S3_ENDPOINT")).toBe("http://ohmail_rustfs_1:9000");
  expect(env.get("S3_REGION")).toBe("us-east-1");
  expect(env.get("S3_ACCESS_KEY_ID")).toBe("ohmail-staging");
  expect(env.get("S3_SECRET_ACCESS_KEY")).toBe(key);
  expect(env.get("S3_BUCKET")).toBe("ohmail-staging");
}

/**
 * The secrets file as the MinIO-era hook generated it: this hook's own first-start file with the
 * store's line under its old name, which is the one line the two eras' templates differ in.
 */
function minioEraSecrets(): { text: string; values: Map<string, string> } {
  const template = appDir("template");
  expect(runHook(template).rc, "the hook did not write a first-start secrets file").toBe(0);
  const fresh = readFileSync(join(template, "data", "env", "secrets.env"), "utf8");
  const text = fresh.replace(/^RUSTFS_ROOT_PASSWORD=.*$/m, `MINIO_ROOT_PASSWORD=${hex(24)}`);
  expect(text, "the first-start file carries no store line to rename").not.toBe(fresh);
  const path = join(scratch, "minio-era-secrets.env");
  writeFileSync(path, text);
  return { text, values: envOf(path) };
}

describe("an Umbrel install from the MinIO era, started by this hook", () => {
  const old = minioEraSecrets();
  const app = appDir("minio-era", old.text);
  const env = join(app, "data", "env");
  const first = runHook(app);

  it("starts: the hook exits 0 and says nothing about an unbound variable", () => {
    expect(first.stderr).not.toMatch(/unbound variable/);
    expect(first.rc).toBe(0);
  });

  it("appends a store credential and keeps every value the install already had", () => {
    const text = readFileSync(join(env, "secrets.env"), "utf8");
    expect(text.startsWith(old.text), "the existing lines were rewritten, not appended to").toBe(true);
    const key = envOf(join(env, "secrets.env")).get("RUSTFS_ROOT_PASSWORD");
    expect(key).toMatch(/^[0-9a-f]{48}$/);
  });

  it("writes the full storage block into api.env and organizer.env, and a complete rustfs.env", () => {
    const key = envOf(join(env, "secrets.env")).get("RUSTFS_ROOT_PASSWORD")!;
    expectStorageBlock(join(env, "api.env"), key);
    expectStorageBlock(join(env, "organizer.env"), key);
    const store = envOf(join(env, "rustfs.env"));
    expect(store.get("RUSTFS_ACCESS_KEY")).toBe("ohmail-staging");
    expect(store.get("RUSTFS_SECRET_KEY")).toBe(key);
    expect(store.get("RUSTFS_ROOT_USER")).toBe("ohmail-staging");
    expect(store.get("RUSTFS_ROOT_PASSWORD")).toBe(key);
    // The api and organizer keep every value the install was made with: the key ring and the
    // organizer identity under their own names, the database password inside its URL.
    for (const file of ["api.env", "organizer.env"]) {
      const derived = envOf(join(env, file));
      const kept = [...old.values].filter(([k]) => derived.has(k));
      expect(kept.length, `${file} carries none of the install's secrets`).toBeGreaterThan(0);
      for (const [k, v] of kept) expect(derived.get(k), `${file} ${k}`).toBe(v);
    }
    expect(envOf(join(env, "api.env")).get("DATABASE_URL")).toContain(`:${old.values.get("POSTGRES_PASSWORD")}@`);
  });

  it("appends it once: the next start keeps the same credential", () => {
    const before = envOf(join(env, "secrets.env")).get("RUSTFS_ROOT_PASSWORD");
    const again = runHook(app);
    expect(again.rc).toBe(0);
    const text = readFileSync(join(env, "secrets.env"), "utf8");
    expect(text.match(/^RUSTFS_ROOT_PASSWORD=/gm)).toHaveLength(1);
    expect(envOf(join(env, "secrets.env")).get("RUSTFS_ROOT_PASSWORD")).toBe(before);
  });
});

describe("a fresh Umbrel install", () => {
  const app = appDir("fresh");
  const run = runHook(app);

  it("generates the store credential once and hands the same one to the store, the api and the organizer", () => {
    expect(run.rc).toBe(0);
    const env = join(app, "data", "env");
    const key = envOf(join(env, "secrets.env")).get("RUSTFS_ROOT_PASSWORD");
    expect(key).toMatch(/^[0-9a-f]{48}$/);
    expect(readFileSync(join(env, "secrets.env"), "utf8").match(/^RUSTFS_ROOT_PASSWORD=/gm)).toHaveLength(1);
    expectStorageBlock(join(env, "api.env"), key!);
    expectStorageBlock(join(env, "organizer.env"), key!);
    expect(envOf(join(env, "rustfs.env")).get("RUSTFS_SECRET_KEY")).toBe(key);
  });
});
