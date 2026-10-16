import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { SHUTDOWN_DEADLINE_MS } from "../src/main.js";
import { freshDataDir } from "./_datadir.js";

/**
 * AN ENGINE WHOSE SHELL HAS GONE CLOSES ITS STORE, AND NEVER OUTLIVES ITS BOUND.
 *
 * A restart that did not wait, or a shell that crashed, leaves the engine with its input at EOF and
 * nobody reading its output. The input ending answered the window's held session wait into a closed
 * pipe, the EPIPE went unhandled, and the engine died with its store open. A stuck close had no
 * bound. The child is spawned as the shell spawns it, holds the wait the window always holds, and
 * "the shell goes away" closes the readers before the input — what the kernel does when it exits.
 */

const SIDECAR_DIR = fileURLToPath(new URL("..", import.meta.url));
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

/** A server that accepts and never answers: a request to it stays in flight. Counts its callers. */
async function silentServer(): Promise<{ url: string; accepted: () => number }> {
  let accepted = 0;
  const server = createServer((socket) => {
    accepted += 1;
    sockets.push(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, accepted: () => accepted };
}

/** The cloud engine before sign-in, on a data directory of its own, spawned as the shell spawns it. */
async function launch(
  cloudUrl: string,
): Promise<{ child: ChildProcessWithoutNullStreams; client: StdioClient; dataDir: string; bearer: string }> {
  const dataDir = await freshDataDir("ohmail-orphan-");
  dirs.push(dataDir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OHMAIL_MODE: "cloud",
    OHMAIL_DATA_DIR: dataDir,
    OHMAIL_CLOUD_URL: cloudUrl,
    OHMAIL_MAILBOX_ADDRESS: "me@ohmail.test",
    OHMAIL_KEK: "ab".repeat(32),
    OHMAIL_POLL_MS: "3600000",
  };
  for (const k of Object.keys(env)) if (k.startsWith("OHMAIL_IMAP_") || k.startsWith("OHMAIL_CLOUD_ACCESS") || k.startsWith("OHMAIL_CLOUD_REFRESH")) delete env[k];
  const child = spawn(process.execPath, ["--conditions=ohmail-source", "--import", "tsx", "src/main.ts"], {
    cwd: SIDECAR_DIR,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  children.push(child);
  child.stderr.on("data", () => undefined);
  const client = connectOverStdio({ input: child.stdout, output: child.stdin, baseUrl: "http://sidecar" });
  clients.push(client);
  const ready = await client.ready();
  return { child, client, dataDir, bearer: ready.sessionToken };
}

/** The shell goes away: nobody reads the engine's output by the time its input ends. */
async function theShellGoes(child: ChildProcessWithoutNullStreams, client: StdioClient): Promise<void> {
  client.close();
  child.stdout.destroy();
  child.stderr.destroy();
  await new Promise((r) => setTimeout(r, 100));
  child.stdin.destroy();
}

/** The window's held question, which the engine answers when its input ends. */
function holdTheSessionWait(client: StdioClient, bearer: string): void {
  void client.fetch("http://sidecar/cloud/session/wait", { headers: { authorization: `Bearer ${bearer}` } }).catch(() => undefined);
}

function exited(child: ChildProcessWithoutNullStreams, withinMs: number): Promise<number | "still running"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("still running"), withinMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

const storeRecord = (dataDir: string): { open?: boolean } =>
  JSON.parse(readFileSync(join(dataDir, "store-generation.json"), "utf8")) as { open?: boolean };

describe("an engine whose shell has gone", () => {
  it("finishes closing its store and exits 0", async () => {
    const quiet = await silentServer();
    const { child, client, dataDir, bearer } = await launch(quiet.url);
    expect(storeRecord(dataDir).open, "the store was not open while serving").toBe(true);
    holdTheSessionWait(client, bearer);
    await new Promise((r) => setTimeout(r, 300));

    await theShellGoes(child, client);
    const code = await exited(child, 20_000);

    expect(storeRecord(dataDir).open, `the engine left (exit ${String(code)}) with its store open`).toBe(false);
    expect(code, "the engine did not leave cleanly").toBe(0);
    expect(existsSync(join(dataDir, "sidecar.lock")), "the lock outlived the engine").toBe(false);
  }, 90_000);

  it("leaves on its own bound when a request it cannot finish holds the close", async () => {
    const quiet = await silentServer();
    const { child, client, bearer } = await launch(quiet.url);
    // A sign-in to a server that never answers: in flight, and nothing bounds it this side of minutes.
    void client
      .fetch("http://sidecar/cloud/signin", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify({ email: "me@ohmail.test", password: "not-a-real-one-password-password", totp: "123456" }),
      })
      .catch(() => undefined);
    const deadline = Date.now() + 20_000;
    while (quiet.accepted() === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(quiet.accepted(), "the sign-in never reached the server").toBeGreaterThan(0);

    const began = Date.now();
    await theShellGoes(child, client);
    const code = await exited(child, SHUTDOWN_DEADLINE_MS + 5_000);
    const waited = Date.now() - began;

    expect(code, "the engine outlived its bound with a request in flight").toBe(1);
    expect(waited, "it left before the bound, so the request was not what held it").toBeGreaterThanOrEqual(SHUTDOWN_DEADLINE_MS - 250);
  }, 90_000);
});
