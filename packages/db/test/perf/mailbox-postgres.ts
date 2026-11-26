import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { join } from "node:path";
import postgres from "postgres";

export { drizzle } from "drizzle-orm/postgres-js";
export type { Sql, TransactionSql } from "postgres";

export const LOOPBACK = "127.0.0.1";

async function localPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP port");
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return address.port;
}

export async function startPostgres(root: string, state: string, bin: string, template?: string, signal?: AbortSignal) {
  // The directory stays short enough for sockaddr_un and private to this OS user.
  const databaseSocket = await mkdtemp(join(root, ".pg-"));
  if (!/^[/a-zA-Z0-9_.-]+$/.test(databaseSocket) || Buffer.byteLength(databaseSocket) > 92) {
    throw new Error("output path cannot be used for the PostgreSQL socket");
  }
  const databasePort = await localPort();
  const databaseUser = userInfo().username;
  const databaseName = "postgres";
  const directory = join(state, "postgres");
  const secretFile = join(state, "postgres-setup");
  const password = randomBytes(36).toString("base64url");
  const childEnv = {
    PATH: "/usr/bin:/bin",
    HOME: state,
    TMPDIR: state,
    LANG: "C",
    ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
  };
  const execute = (command: string, args: string[]) => {
    const executable = command === "cp" ? "/usr/bin/cp" : join(bin, command);
    const result = spawnSync(executable, args, { stdio: "ignore", timeout: 120_000, env: childEnv });
    if (result.status !== 0) throw new Error(`local ${command} failed`);
  };
  if (template) {
    const source = join(template, "postgres");
    const live = await lstat(join(source, "postmaster.pid")).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return false;
      },
    );
    if (live) throw new Error("template PostgreSQL must be stopped");
    execute("cp", ["--reflink=auto", "--recursive", "--preserve=mode", "--", source, directory]);
  } else {
    await writeFile(secretFile, password + "\n", { mode: 0o600, flag: "wx" });
    try {
      execute("initdb", [
        "-D",
        directory,
        "--username",
        databaseUser,
        "--auth-local=peer",
        "--auth-host=scram-sha-256",
        "--pwfile",
        secretFile,
        "--encoding=UTF8",
        "--no-locale",
      ]);
    } finally {
      await unlink(secretFile);
    }
  }
  // Migrations take a URL. This separate loopback door uses a freshly generated password;
  // every runtime and witness connection uses the private peer-authenticated socket.
  const url = new URL(`postgres://${LOOPBACK}:${databasePort}/${databaseName}?sslmode=disable`);
  url.username = databaseUser;
  url.password = password;
  const runOptions = [
    `-h ${LOOPBACK}`,
    `-p ${databasePort}`,
    `-k ${databaseSocket}`,
    "-c unix_socket_permissions=0700",
    "-c log_min_error_statement=panic",
    "-c log_error_verbosity=terse",
  ].join(" ");
  signal?.throwIfAborted();
  execute("pg_ctl", ["-D", directory, "-l", "/dev/null", "-o", runOptions, "-w", "start"]);
  const stop = () => execute("pg_ctl", ["-D", directory, "-w", "stop", "-m", "fast"]);
  try {
    const postgresPid = Number.parseInt(await readFile(join(directory, "postmaster.pid"), "utf8"), 10);
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(postgresPid) || postgresPid < 1) throw new Error("no local PostgreSQL process");
    const connect = (options: postgres.Options<Record<string, never>> = {}) =>
      postgres({
        host: databaseSocket,
        port: databasePort,
        database: databaseName,
        user: databaseUser,
        ssl: false,
        max: 1,
        connect_timeout: 5,
        fetch_types: false,
        onnotice: () => {},
        ...options,
      });
    if (template) {
      const local = connect();
      try {
        await local`alter role ${local(databaseUser)} password ${local.unsafe(`'${password}'`)}`;
      } finally {
        await local.end({ timeout: 2 });
      }
    }
    const databaseVersion = spawnSync(join(bin, "postgres"), ["-V"], {
      encoding: "utf8",
      env: childEnv,
    }).stdout?.trim();
    signal?.throwIfAborted();
    return {
      databaseSocket,
      databasePort,
      databaseUser,
      databaseName,
      databaseVersion,
      postgresPid,
      url,
      connect,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
