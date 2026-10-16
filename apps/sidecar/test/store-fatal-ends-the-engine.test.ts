import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { openLocalDb } from "../src/db.js";
import { freshDataDir } from "./_datadir.js";

/**
 * ═══ A STORE WHOSE DATABASE ENDS ENDS ITS ENGINE, BEFORE ANYTHING QUEUED BEHIND IT RUNS ══════
 *
 * A failed sync PANICs Postgres and its WASM traps. A statement already queued behind the failing
 * one still reached the dead module: behind a failed commit it spun at full CPU, so the engine
 * never exited and the shell never restarted it; behind a failed checkpoint it answered an empty
 * success for a write that was gone. The engine is spawned as the shell spawns it (the Cloud door,
 * before sign-in) and `_store-fault.ts` drives its own store from inside it.
 */

const SIDECAR_DIR = fileURLToPath(new URL("..", import.meta.url));
const FAULT = new URL("./_store-fault.ts", import.meta.url).href;
/** `main.ts`'s exit for a store whose database ended; the shell restarts an engine that leaves with it. */
const STORE_FATAL_EXIT = 1;

const children: ChildProcessWithoutNullStreams[] = [];
const clients: StdioClient[] = [];
const servers: Server[] = [];
const sockets: Socket[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const cl of clients.splice(0)) cl.close();
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 50));
});

/** A Cloud server that accepts and never answers: the engine waits for a sign-in with its store open. */
async function silentServer(): Promise<string> {
  const server = createServer((socket) => { sockets.push(socket); });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** The exit code once the engine's output has closed too, or that it was still running at the bound. */
function closed(child: ChildProcessWithoutNullStreams, withinMs: number): Promise<number | "still running"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("still running"), withinMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/** The engine's log events, in order, read off its stderr's JSON lines. */
function eventsOf(stderr: string): string[] {
  return stderr.split("\n").flatMap((line) => {
    try {
      const event = (JSON.parse(line) as { event?: unknown }).event;
      return typeof event === "string" ? [event] : [];
    } catch {
      return [];
    }
  });
}

async function launch(shape: "commit" | "checkpoint"): Promise<{
  child: ChildProcessWithoutNullStreams; dataDir: string; rig: string; stderr: () => string;
}> {
  const dataDir = await freshDataDir("ohmail-store-fatal-");
  const rig = mkdtempSync(join(tmpdir(), "ohmail-store-fault-"));
  dirs.push(dataDir, rig);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OHMAIL_MODE: "cloud",
    OHMAIL_DATA_DIR: dataDir,
    OHMAIL_CLOUD_URL: await silentServer(),
    OHMAIL_MAILBOX_ADDRESS: "me@ohmail.test",
    OHMAIL_KEK: "ab".repeat(32),
    OHMAIL_POLL_MS: "3600000",
    STORE_FAULT_SHAPE: shape,
    STORE_FAULT_TRIGGER: join(rig, "go"),
    STORE_FAULT_OUT: join(rig, "said"),
  };
  for (const k of Object.keys(env)) if (k.startsWith("OHMAIL_IMAP_") || k.startsWith("OHMAIL_CLOUD_ACCESS") || k.startsWith("OHMAIL_CLOUD_REFRESH")) delete env[k];
  const child = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx", "--import", FAULT, "src/main.ts"], {
    cwd: SIDECAR_DIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const client = connectOverStdio({ input: child.stdout, output: child.stdin, baseUrl: "http://sidecar" });
  clients.push(client);
  await client.ready();
  return { child, dataDir, rig, stderr: () => stderr };
}

describe("an engine whose store's database ends", () => {
  for (const shape of ["commit", "checkpoint"] as const) {
    it(`ends on the spot behind a failing ${shape}: nothing queued answers, and the next open keeps what was`, async () => {
      const run = await launch(shape);
      writeFileSync(join(run.rig, "go"), "");
      const code = await closed(run.child, 30_000);
      const said = existsSync(join(run.rig, "said")) ? readFileSync(join(run.rig, "said"), "utf8").trim().split("\n") : [];

      expect(said, "the fault never ran inside the engine").toContain("ISSUED");
      if (shape === "checkpoint") expect(said, "nothing was admitted inside the failing checkpoint").toContain("QUEUED");
      expect(code, "the engine did not end when its store's database did").toBe(STORE_FATAL_EXIT);
      expect(said.filter((line) => line.startsWith("ANSWERED")), "a statement on the dead database answered").toEqual(["ANSWERED kept"]);
      const events = eventsOf(run.stderr());
      expect(events.filter((e) => e === "local_db_fatal"), "the end was not said once").toHaveLength(1);
      expect(events.slice(events.indexOf("local_db_fatal") + 1), "the engine went on after its store's database ended").toEqual([]);

      // The next start recovers the log, and every row the engine acknowledged is there.
      const again = await openLocalDb(run.dataDir);
      try {
        const kept = (await again.db.execute(sql.raw("SELECT match FROM rules WHERE match = 'kept@rig.invalid'"))) as unknown as { rows: unknown[] };
        expect(kept.rows, "an acknowledged row did not survive the end").toHaveLength(1);
      } finally {
        await again.close();
      }
    }, 120_000);
  }
});
