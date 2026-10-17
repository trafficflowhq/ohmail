import { describe, it, expect } from "vitest";
import net from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import postgres from "postgres";
import { withPgSocket } from "../src/pg-socket.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";

/**
 * A TRANSACTION CUT MID-STATEMENT MUST NOT POISON ITS CONNECTION FOR THE NEXT ONE.
 *
 * Unpatched postgres@3.4.9 lets `sql.begin` send its rollback down the connection that just closed: the
 * rollback is queued (or throws from setImmediate(nextWrite)), survives the reconnect, and the next
 * transaction on that connection has every reply paired off by one, so it waits for ever (HUNG 9/9 through
 * withPgSocket, 8/8 plain, and with the worker's server timeouts). patches/postgres@3.4.9.patch refuses a
 * statement on a closed connection and clears what the close left behind. One connection makes it exact.
 */

const PG_UP = await realPgAvailable();
const MARKER = "statement sent after its connection closed";

/** A pass-through in front of Postgres whose cut destroys every socket, a write possibly in flight. */
class Proxy {
  private server: net.Server | null = null;
  private readonly live = new Set<net.Socket>();
  port = 0;
  constructor(private readonly target: number) {}
  async listen(port = 0): Promise<void> {
    const server = net.createServer((client) => {
      const upstream = net.createConnection({ host: "127.0.0.1", port: this.target });
      this.live.add(client); this.live.add(upstream);
      const kill = (): void => { client.destroy(); upstream.destroy(); this.live.delete(client); this.live.delete(upstream); };
      for (const s of [client, upstream]) { s.on("error", kill); s.on("close", kill); }
      client.pipe(upstream); upstream.pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
    const addr = server.address();
    this.port = typeof addr === "object" && addr !== null ? addr.port : port;
    this.server = server;
  }
  cut(): void { this.server?.close(); this.server = null; for (const s of this.live) s.destroy(); this.live.clear(); }
  async restore(): Promise<void> { if (!this.server) await this.listen(this.port); }
  close(): void { this.cut(); }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

describe("the installed postgres.js carries this repository's patch", () => {
  it("in both builds the package ships (run `node scripts/apply-patches.mjs apply` after an npm install)", () => {
    let dir = dirname(createRequire(import.meta.url).resolve("postgres"));
    const named = (d: string): boolean =>
      existsSync(join(d, "package.json")) && JSON.parse(readFileSync(join(d, "package.json"), "utf8")).name === "postgres";
    while (!named(dir) && dirname(dir) !== dir) dir = dirname(dir);
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).toMatchObject({ name: "postgres", version: "3.4.9" });
    for (const file of ["src/connection.js", "cjs/src/connection.js"]) {
      expect(readFileSync(join(dir, file), "utf8"), `${file} is unpatched`).toContain(MARKER);
    }
  });
});

describe.skipIf(!PG_UP)("a transaction cut mid-statement leaves its connection usable", () => {
  for (const mode of ["withPgSocket", "plain"] as const) {
    it(`${mode}: the cut transaction rejects, and the next transaction on that connection answers`, async () => {
      const proxy = new Proxy(Number(new URL(PG_TEST_URL).port || 5432));
      await proxy.listen();
      const url = new URL(PG_TEST_URL);
      url.hostname = "127.0.0.1";
      url.port = String(proxy.port);
      const opts = { max: 1, onnotice: () => { /* quiet */ } };
      const sql = postgres(url.toString(), mode === "withPgSocket" ? withPgSocket(opts) : opts);
      try {
        await sql`select 1`;
        // The statement is in flight when the transport goes, so begin's scope rolls back afterwards.
        const cut = sql.begin(async (tx) => { await tx`select pg_sleep(2)`; })
          .then(() => "committed", (e: { code?: string }) => e.code ?? "rejected");
        await sleep(300);
        proxy.cut();
        expect(await cut).toBe("CONNECTION_CLOSED");
        await sleep(300);
        await proxy.restore();

        const started = Date.now();
        const next = sql.begin(async (tx) => (await tx`select ${7}::int as n`)[0]!.n as number);
        const answer = await Promise.race([next, sleep(10_000).then(() => "no answer in 10 s")]);
        expect(answer, `the next transaction after ${Date.now() - started} ms`).toBe(7);
      } finally {
        await sql.end({ timeout: 1 }).catch(() => undefined);
        proxy.close();
      }
    }, 30_000);
  }
});
