import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { mailboxes, mailboxCredentials, contacts } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { isCliEntry } from "../src/entry.js";
import { imapCfg } from "./_workerenv.js";
import { prepareIsolatedDb, truncateAll } from "./_isolateddb.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

const WORKER_DIR = fileURLToPath(new URL("..", import.meta.url));
/** A real AES KEK of the production length: the CLI builds its KeyProvider from the ENV, like production. */
const KEK_HEX = "ab".repeat(32);
const KEK = StaticKeyProvider.fromSecret(Buffer.from(KEK_HEX, "hex"), 1);

let DB = "";

describe("the DEPLOYABLE CLI entry point", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_cli"); }, 60000);

  let child: ChildProcessWithoutNullStreams | null = null;
  afterEach(async () => {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); }
    child = null;
  });

  it("matches a module path containing spaces (the template-string guard silently did not)", () => {
    const p = "/Volumes/Macintosh SSD/home/Sites/ohmail-monorepo/apps/worker/src/index.ts";
    // The old idiom. A repo path with a space makes it compare an unencoded string against a
    // percent-encoded URL, so the bootstrap block never ran: `tsx src/index.ts` exited 0
    // having done nothing at all — no health server, no lock, no sync, no error.
    expect(`file://${p}`).not.toBe(pathToFileURL(p).href);
    expect(isCliEntry(pathToFileURL(p).href, p)).toBe(true);
    expect(isCliEntry("file:///somewhere/else.ts", p)).toBe(false);
    expect(isCliEntry(pathToFileURL(p).href, undefined)).toBe(false);
  });

  /**
   * A BOOT THAT DIES BEFORE THE CONFIG PARSES STILL SAYS SO.
   *
   * The crash handlers used to be installed AFTER the dynamic import of `./supervisor.js` and
   * `loadConfig()` — i.e. after the two steps most likely to fail on a fresh deploy — so a
   * malformed environment rejected a discarded async IIFE through Node's default path: no
   * structured event, and because container stdout is a pipe, on a fast exit frequently no
   * output at all. That is exactly the 2026-08-01 deployment whose entire Railway log was
   * "Starting Container".
   *
   * The only honest test of an ORDERING inside a CLI bootstrap is to run the CLI, so this
   * spawns the real thing with one variable wrong. It also pins the redaction half: the
   * `DATABASE_URL_SESSION` in this environment is a real connection string with a password in
   * it, and it must not appear anywhere in what the process printed.
   */
  it("a malformed environment produces a STRUCTURED worker_start_failed, carrying no secret", async () => {
    child = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx/esm", "src/index.ts"], {
      cwd: WORKER_DIR,
      env: {
        ...process.env,
        DATABASE_URL_SESSION: DB,
        [KEY_RING_V1]: KEK_HEX,
        PORT: "0",
        // The malformation. `loadConfig` throws on it, and it throws BEFORE anything the old
        // ordering had installed a handler for.
        TF_SHARDS: "not-a-number",
        TF_ACCOUNT_ID: undefined,
        TF_MAILBOX_ID: undefined,
        IMAP_HOST: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });
    const code = await new Promise<number>((resolve) => {
      child!.on("exit", (c) => resolve(c ?? -1));
    });

    expect(code, `expected a non-zero exit. Output:\n${out}`).not.toBe(0);

    const line = out.split("\n").flatMap((l) => {
      try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; }
    }).find((e) => e.event === "worker_start_failed");

    expect(line, `no structured worker_start_failed on stdout. Output:\n${out}`).toBeDefined();
    expect(line).toMatchObject({
      level: "error",
      service: "worker",
      errorClass: "WorkerConfigError",
      errorCode: "TF_CONFIG_INVALID",
      // The variable's NAME, which we chose — never its value, which we did not.
      configVar: "TF_SHARDS",
    });
    // And the message is absent, along with the connection string it could have carried.
    expect(line).not.toHaveProperty("errorDetail");
    expect(out).not.toContain(new URL(DB).password);
  }, 60000);

  it("boots as leader, serves /health 200 with its mailbox attached, and exits 0 on SIGTERM", async () => {
    await truncateAll(DB);
    const db = makeDb(DB);
    const cfg = imapCfg();
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: cfg.auth.user }).returning();
    await db.insert(contacts).values({ accountId, address: "anna@x.example" });
    const enc = await KEK.encrypt(cfg.auth.pass);
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: cfg.host, port: cfg.port, secure: false, user: cfg.auth.user },
    });

    // `node --import tsx/esm src/index.ts` is the `pnpm --filter @trafficflow/worker start`
    // script's loader path without tsx's CLI wrapper (whose IPC socket needs a writable
    // TMPDIR that sandboxed CI does not always grant). What matters is that a SEPARATE
    // process executes `src/index.ts` as its main module — the exact thing the CLI guard
    // decides, and the exact thing Railway does.
    child = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx/esm", "src/index.ts"], {
      cwd: WORKER_DIR,
      env: {
        ...process.env,
        DATABASE_URL_SESSION: DB,
        [KEY_RING_V1]: KEK_HEX,
        TF_HEALTH_SECRET: "d".repeat(32),
        PORT: "0",                       // an ephemeral port; the CLI logs the resolved one
        POLL_INTERVAL_MS: "1000",
        TF_STANDBY_RETRY_MS: "500",
        TF_ROSTER_INTERVAL_MS: "1000",
        // TF_ACCOUNT_ID / TF_MAILBOX_ID deliberately UNSET: the production shape.
        TF_ACCOUNT_ID: undefined,
        TF_MAILBOX_ID: undefined,
        IMAP_HOST: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let out = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { out += d.toString(); });

    /**
     * the CLI's stdout is JSON LINES, not prose. This helper parses what has arrived so
     * far and is tolerant of a partial trailing line (the stream is chunked, so the last line
     * is routinely half-written when we look). Asserting on the parsed `event` rather than on
     * a substring is also what makes this test a real check of the log CONTRACT: an operator's
     * log-drain rule matches the same field.
     */
    const events = (): Array<Record<string, unknown>> =>
      out.split("\n").flatMap((line) => {
        if (line.trim().length === 0) return [];
        try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
      });
    const eventNamed = (name: string): Record<string, unknown> | undefined =>
      events().find((e) => e.event === name);

    const port = await new Promise<number>((resolve, reject) => {
      // Captured, not read through `child!`: the afterEach hook nulls the binding, and a
      // timer that outlived the test then threw `Cannot read properties of null` as an
      // unhandled exception — which vitest reports as a suite-level error.
      const proc = child!;
      const deadline = setTimeout(() => {
        clearInterval(tick);
        reject(new Error(`CLI never announced a health port. Output:\n${out}`));
      }, 45000);
      const tick = setInterval(() => {
        const up = eventNamed("worker_up");
        if (up && typeof up.healthPort === "number") {
          clearInterval(tick); clearTimeout(deadline); resolve(up.healthPort);
          return;
        }
        if (proc.exitCode !== null) {
          clearInterval(tick); clearTimeout(deadline);
          reject(new Error(`CLI exited with ${proc.exitCode} before serving health. Output:\n${out}`));
        }
      }, 100);
    });

    expect(eventNamed("worker_up")).toMatchObject({ state: "leader", service: "worker" });

    // The health contract, from a genuinely separate PROCESS started the way Railway starts it.
    const start = Date.now();
    let body: Record<string, unknown> = {};
    let status = 0;
    while (Date.now() - start < 30000) {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${"d".repeat(32)}` } });
      status = res.status;
      body = (await res.json()) as Record<string, unknown>;
      if (body.mailboxes === 1) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true, healthy: true, leader: true, standby: false,
      mailboxes: 1, accounts: 1, expected: 1, quarantined: 0, degraded: false,
      shard: { index: 0, shards: 1 },
    });
    // The KEK RING identity the API host compares against (risk 2) — computed
    // independently from the documented construction (`kekRingFingerprint`):
    // sha256("tf-kek-ring/1\n" + "<version>:<hex>\n" ascending), first 8 hex. All three
    // fields are published, because identical bytes under a different active version
    // still mean two hosts that write mutually-unreadable `key_version` rows.
    const { createHash } = await import("node:crypto");
    expect(body.kekFingerprint).toBe(
      createHash("sha256").update("tf-kek-ring/1\n", "ascii")
        .update(`1:${KEK_HEX}\n`, "ascii").digest("hex").slice(0, 8),
    );
    expect(body.kekActiveVersion).toBe(1);
    expect(body.kekVersionCount).toBe(1);
    // The public read, the platform's: the verdict and identities, no count.
    const open = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as Record<string, unknown>;
    expect(open).toMatchObject({ ok: true, healthy: true, leader: true, kekActiveVersion: 1 });
    expect("mailboxes" in open || "accounts" in open, "a count on the public read").toBe(false);

    // A graceful platform stop: SIGTERM ⇒ clean shutdown, exit 0, lock released.
    const exit = new Promise<number>((resolve) => { child!.on("exit", (code) => resolve(code ?? -1)); });
    child.kill("SIGTERM");
    expect(await exit).toBe(0);
    expect(eventNamed("shutdown_requested")).toMatchObject({ signal: "SIGTERM" });
  }, 90000);
});
