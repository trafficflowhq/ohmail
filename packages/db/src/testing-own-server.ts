import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { withPgSocket } from "./pg-socket.js";
import { TEST_SERVICES } from "./test-services.js";

const REQUIRE_PG_ENV = TEST_SERVICES.pg.require;

/**
 * A POSTGRES SERVER THE TEST OWNS WHOLE.
 *
 * A role belongs to the whole server, not to a database, and the lock's proofs make the runtime
 * logins under their real names (`ohmail_api`, `ohmail_worker`, `ohmail_migrator`). So they never
 * run on a server anybody shares: each file starts a container of its own on a loopback port docker
 * picks, by the image digest the tree already pins, with password authentication (a login nobody
 * gave a password cannot sign in, which is only a fact on a server that asks for one). The
 * superuser's password is drawn per server and never printed. A container a killed run leaves ends
 * itself after {@link OWN_SERVER_LIFETIME_S}; nothing here stops a container it did not start.
 *
 * Under `TF_REQUIRE_PG=1` (every CI job) a docker that cannot start one is a failure that names
 * `docker run`; without it the file says so on stderr and its cases are skipped.
 */
export const OWN_SERVER_IMAGES = {
  16: "ghcr.io/trafficflowhq/mirror-postgres:16.15@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94",
  17: "postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929",
} as const;
export type PgMajor = keyof typeof OWN_SERVER_IMAGES;
export const PG_MAJORS: readonly PgMajor[] = [16, 17];

/** The ports the workstation's shared servers listen on: an own server is never one of them. */
const SHARED_PORTS = new Set([5432, 5433, 5440]);
export const OWN_SERVER_LIFETIME_S = 1800;
const PREFIX = "ohmail_own_pg_";
const SUPERUSER = "own_server_super";

/** One docker call; its failure names the call and the last lines docker said. */
function docker(args: string[], timeout = 180_000): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    const err = e as { status?: number | null; stderr?: string; message: string };
    const said = (err.stderr ?? err.message).trim().split("\n").slice(-3).join(" | ");
    throw new Error(`docker ${args.slice(0, 2).join(" ")} failed (rc ${err.status ?? "none"}): ${said}`);
  }
}

/** Whether docker answers here, and why not. */
export function dockerAnswers(env: NodeJS.ProcessEnv = process.env): { up: boolean; why: string } {
  const r = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 30_000, env });
  if (r.error) return { up: false, why: `docker could not be run (${r.error.message})` };
  if (r.status !== 0) return { up: false, why: `docker version answered rc ${r.status}: ${(r.stderr ?? "").trim().split("\n").slice(-1)[0] ?? ""}` };
  return { up: true, why: "" };
}

/**
 * May this file start servers of its own? True when docker answers. Under `TF_REQUIRE_PG=1` an
 * absent docker throws, naming what failed; otherwise the file is named on stderr and skipped.
 */
export function ownServersAvailable(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const d = dockerAnswers(env);
  if (d.up) return true;
  if (env[REQUIRE_PG_ENV] === "1") {
    throw new Error(`${REQUIRE_PG_ENV}=1 but this file starts its own Postgres by docker run, and ${d.why}`);
  }
  process.stderr.write(`[own-pg] ${file}: skipped, it starts its own Postgres by docker run and ${d.why}\n`);
  return false;
}

export interface OwnServer {
  readonly major: PgMajor;
  readonly container: string;
  readonly port: number;
  readonly superuser: string;
  /** A connection URL on this server. Never logged: it carries a password. */
  url(database: string, user?: string, password?: string): string;
  /** A client of its own, one connection; the caller ends it. Notices go to `onnotice`. */
  connect(database: string, user?: string, password?: string, onnotice?: (text: string) => void): postgres.Sql;
  /** `database` dumped by the server's own `pg_dump`, inside its container, as the superuser over the local socket: plain SQL. */
  dump(database: string): string;
  /** `sql` run by the server's own `psql` on `database`, inside its container, as the superuser; the first error stops it and throws. */
  restore(database: string, sql: string): void;
  stop(): void;
}

/** A program inside the container, as the superuser over its local socket; its failure names the program and docker's last lines. */
function inContainer(container: string, args: string[], input?: string): string {
  try {
    return execFileSync("docker", ["exec", ...(input === undefined ? [] : ["-i"]), container, ...args], {
      encoding: "utf8", timeout: 180_000, maxBuffer: 1 << 28, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], ...(input === undefined ? {} : { input }),
    });
  } catch (e) {
    const err = e as { status?: number | null; stderr?: string; message: string };
    const said = (err.stderr ?? err.message).trim().split("\n").slice(-3).join(" | ");
    throw new Error(`${args[0]} in ${container} failed (rc ${err.status ?? "none"}): ${said}`);
  }
}

const live = new Map<string, OwnServer>();
process.on("exit", () => { for (const s of live.values()) s.stop(); });

/** Start a Postgres `major` of this file's own; resolves once it answers as that major. */
export async function startOwnServer(major: PgMajor, label: string): Promise<OwnServer> {
  const container = `${PREFIX}${label.replace(/[^a-z0-9_]/gi, "_").slice(0, 30)}_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(18).toString("hex");
  const dir = mkdtempSync(join(tmpdir(), "own-pg-"));
  const envFile = join(dir, "server.env");
  writeFileSync(envFile, `POSTGRES_USER=${SUPERUSER}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_INITDB_ARGS=--auth-host=scram-sha-256\n`, { mode: 0o600 });
  chmodSync(envFile, 0o600);
  try {
    // The entrypoint is wrapped only to give the container an end of its own: SIGINT to postgres is a fast shutdown.
    docker([
      "run", "-d", "--rm", "--name", container, "--label", "ohmail-own-pg", "--env-file", envFile,
      "-p", "127.0.0.1::5432", "--shm-size=256m", "--entrypoint", "bash", OWN_SERVER_IMAGES[major],
      "-c", `(sleep ${OWN_SERVER_LIFETIME_S}; kill -INT 1) & exec docker-entrypoint.sh postgres -c fsync=off -c full_page_writes=off -c max_connections=200`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    live.delete(container);
    try { docker(["stop", "-t", "1", container], 60_000); } catch { /* it ended on its own */ }
  };
  try {
    const mapped = docker(["port", container, "5432/tcp"]).split("\n")[0] ?? "";
    const port = Number(/^127\.0\.0\.1:(\d+)$/.exec(mapped)?.[1]);
    if (!Number.isInteger(port)) throw new Error(`docker port ${container} answered '${mapped}', not a loopback port`);
    if (SHARED_PORTS.has(port)) throw new Error(`port ${port} is a shared server's: an own server never listens there`);
    const url = (database: string, user = SUPERUSER, pw = password): string =>
      `postgres://${encodeURIComponent(user)}${pw === "" ? "" : `:${encodeURIComponent(pw)}`}@127.0.0.1:${port}/${database}?sslmode=disable`;
    const connect = (database: string, user = SUPERUSER, pw = password, onnotice: (text: string) => void = () => {}): postgres.Sql =>
      postgres(withPgSocket({
        host: "127.0.0.1", port, database, username: user, password: pw, max: 1, idle_timeout: 0, connect_timeout: 10,
        onnotice: (n: postgres.Notice) => onnotice(`${n.severity}: ${n.message}`),
      }));
    const dump = (database: string): string => inContainer(container, ["pg_dump", "-U", SUPERUSER, "-d", database]);
    const restore = (database: string, sql: string): void => {
      inContainer(container, ["psql", "-U", SUPERUSER, "-d", database, "-X", "-q", "-v", "ON_ERROR_STOP=1"], sql);
    };
    const server: OwnServer = { major, container, port, superuser: SUPERUSER, url, connect, dump, restore, stop };
    live.set(container, server);
    await ready(server);
    return server;
  } catch (e) {
    stop();
    throw e;
  }
}

/** The server answers over TCP only once initdb's own temporary server has gone, so one answer is enough. */
async function ready(server: OwnServer): Promise<void> {
  const deadline = Date.now() + 90_000;
  let last = "";
  while (Date.now() < deadline) {
    const sql = server.connect("postgres");
    try {
      const [row] = await sql<{ v: number }[]>`select current_setting('server_version_num')::int as v`;
      if (Math.floor((row?.v ?? 0) / 10000) !== server.major) throw new Error(`the image for ${server.major} answers as ${row?.v}`);
      return;
    } catch (e) {
      last = (e as { code?: string; message: string }).code ?? (e as Error).message;
      if (/answers as/.test(last)) throw e;
    } finally {
      await sql.end({ timeout: 2 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the Postgres ${server.major} container ${server.container} did not answer within 90 s (last: ${last})`);
}
