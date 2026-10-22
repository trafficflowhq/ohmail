// @services: none — its child runs dial this file's own listeners and closed ports
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVICE_VERDICT_ENV } from "../packages/db/src/test-services.js";
import { SERVICE_GATE_PREFIX } from "./support/service-needs.mjs";
import { isLoopback, probeServices, serviceAddresses, type ServiceAddresses } from "./support/services.js";

/**
 * THE SERVICE GATE, RUN BY VITEST ITSELF: a fixture tree under the suite's own global setup (the one
 * probe) and runner (the gate), in a child vitest outside this run's environment. A service found
 * absent skips the file that needs it, by name, before the file is even loaded; a service that
 * listens and is broken stays red; absent under its require variable fails. RustFS is the service
 * driven here, because nothing but TF_RUSTFS_URL names its address (a checkout's own lane files
 * name Postgres and GreenMail); the Postgres case hands the probe its URL.
 */

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const VITEST = join(REPO, "node_modules", "vitest", "vitest.mjs");
const GLOBAL = join(REPO, "test", "setup", "services.global.ts");
const RUNNER = join(REPO, "test", "setup", "service-gate.runner.ts");
const href = (p: string) => pathToFileURL(p).href;

let refused = 0; // a port nothing listens on
let slam: Server;
let slamPort = 0;
const held: Socket[] = [];
const roots: string[] = [];

const listen = async (onSocket: (s: Socket) => void): Promise<[Server, number]> => {
  const srv = createServer(onSocket);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return [srv, (srv.address() as { port: number }).port];
};

beforeAll(async () => {
  const [gone, port] = await listen((s) => s.destroy());
  await new Promise<void>((r) => gone.close(() => r()));
  refused = port;
  /* Accepts, then closes: something listens there, and it is not a working service. */
  [slam, slamPort] = await listen((s) => { held.push(s); s.destroy(); });
});
afterAll(async () => {
  for (const s of held) s.destroy();
  await new Promise<void>((r) => slam.close(() => r()));
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const NEEDS = `// @services: rustfs
import { writeFileSync } from "node:fs";
writeFileSync(process.env.FX_SIDE!, "loaded\\n");
describe("the bucket", () => {
  it("answers ready", async () => {
    const res = await fetch(\`\${process.env.TF_RUSTFS_URL}/health/ready\`, { signal: AbortSignal.timeout(3000) });
    expect(res.ok).toBe(true);
  });
});
`;

const SELF_GATED = `import { serviceUp } from ${JSON.stringify(href(join(REPO, "packages/db/src/test-services.ts")))};
const rustfs = serviceUp("rustfs");
describe.skipIf(!rustfs.up)(\`gated (\${rustfs.why})\`, () => {
  it("reads the bucket", async () => { await fetch(\`\${process.env.TF_RUSTFS_URL}/health/ready\`); });
});
describe("pure", () => { it("adds", () => { expect(1 + 1).toBe(2); }); });
`;

const PG_GATED = (url: string) => `import { pgTestUrl, realPgAvailable } from ${JSON.stringify(href(join(REPO, "packages/db/src/testing.ts")))};
const URL = pgTestUrl(import.meta.url, ${JSON.stringify(url)});
const PG_UP = await realPgAvailable(URL);
describe.skipIf(!PG_UP)("on real Postgres", () => { it("selects", () => { expect(PG_UP).toBe(true); }); });
`;

interface Run { status: number | null; out: string; report: Report; side: boolean }
interface Report { testResults: { name: string; status: string; message?: string; assertionResults: { ancestorTitles: string[]; title: string; status: string; failureMessages: string[] }[] }[] }

/** A fixture tree with one test file, run by the repo's vitest outside this run's environment. */
function run(file: string, text: string, opts: { env?: Record<string, string>; globalSetup?: string[] } = {}): Run {
  const root = mkdtempSync(join(tmpdir(), "ohmail-service-gate-"));
  roots.push(root);
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "vitest.config.mjs"), `export default ${JSON.stringify({
    cacheDir: join(root, ".vite"),
    test: {
      globals: true, include: ["test/**/*.test.ts"], fileParallelism: false,
      globalSetup: opts.globalSetup ?? [GLOBAL], runner: RUNNER,
    },
  })};\n`);
  writeFileSync(join(root, "test", file), text);
  const side = join(root, "side.txt");
  const out = join(root, "out.json");
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(VITEST|TEST$|NODE_OPTIONS$|TF_REQUIRE_|IMAP_CONDSTORE$)/.test(k) || k === SERVICE_VERDICT_ENV) continue;
    env[k] = v;
  }
  Object.assign(env, { TF_RUSTFS_URL: `http://127.0.0.1:${refused}`, FX_SIDE: side }, opts.env ?? {});
  const r = spawnSync(process.execPath, [VITEST, "run", "--root", root, "--reporter=json", `--outputFile=${out}`], {
    cwd: root, env, encoding: "utf8", timeout: 120_000,
  });
  expect(r.error, String(r.error)).toBeUndefined();
  expect(existsSync(out), `vitest wrote no report:\n${r.stdout}\n${r.stderr}`).toBe(true);
  return { status: r.status, out: `${r.stdout}\n${r.stderr}`, report: JSON.parse(readFileSync(out, "utf8")) as Report, side: existsSync(side) };
}

const titles = (r: Run) => r.report.testResults.flatMap((f) => f.assertionResults.map((a) => [...a.ancestorTitles, a.title].join(" > ")));
const statuses = (r: Run) => r.report.testResults.flatMap((f) => f.assertionResults.map((a) => a.status));

describe("the service gate, under the suite's own global setup and runner", () => {
  it("a: a closed port skips the file that needs it, by name, without loading it", () => {
    const r = run("needs.test.ts", NEEDS);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain(`[services] RustFS is not running at 127.0.0.1:${refused} (ECONNREFUSED)`);
    expect(statuses(r)).toEqual(["skipped"]);
    expect(titles(r)[0]).toBe(`${SERVICE_GATE_PREFIX}RustFS is not running at 127.0.0.1:${refused} (ECONNREFUSED) > not run here`);
    expect(r.side, "the skipped file's top level ran").toBe(false);
  }, 150_000);

  it("b: a listener that accepts and closes is there: the file runs, and fails", () => {
    const r = run("needs.test.ts", NEEDS, { env: { TF_RUSTFS_URL: `http://127.0.0.1:${slamPort}` } });
    expect(r.status, r.out).not.toBe(0);
    expect(statuses(r)).toEqual(["failed"]);
    expect(r.side).toBe(true);
  }, 150_000);

  it("c: absent under TF_REQUIRE_RUSTFS=1 fails the file with the reason", () => {
    const r = run("needs.test.ts", NEEDS, { env: { TF_REQUIRE_RUSTFS: "1" } });
    expect(r.status, r.out).not.toBe(0);
    expect(r.report.testResults[0]!.status).toBe("failed");
    expect(JSON.stringify(r.report)).toContain(`TF_REQUIRE_RUSTFS=1 but RustFS is not running at 127.0.0.1:${refused} (ECONNREFUSED)`);
    expect(r.side).toBe(false);
  }, 150_000);

  it("d: without the probe the gate stands aside: the file runs, and fails", () => {
    const r = run("needs.test.ts", NEEDS, { globalSetup: [] });
    expect(r.status, r.out).not.toBe(0);
    expect(statuses(r)).toEqual(["failed"]);
    expect(r.side).toBe(true);
  }, 150_000);

  it("e: a file that checks for itself keeps its own gate, and its pure cases run", () => {
    const r = run("self.test.ts", SELF_GATED);
    expect(r.status, r.out).toBe(0);
    const t = titles(r);
    expect(t).toContain(`gated (RustFS is not running at 127.0.0.1:${refused} (ECONNREFUSED)) > reads the bucket`);
    expect(t).toContain("pure > adds");
    expect(statuses(r).sort()).toEqual(["passed", "skipped"]);
  }, 150_000);

  it("f: a Postgres file that checks with realPgAvailable, on a closed port: skipped, never refused", () => {
    /* The box's database name, at a port nothing listens on: the refusal would fire if the gate did not. */
    const url = `postgres://tf@127.0.0.1:${refused}/trafficflow_test`;
    const root = mkdtempSync(join(tmpdir(), "ohmail-service-gate-setup-"));
    roots.push(root);
    const setup = join(root, "pg-probe.global.ts");
    writeFileSync(setup, `import { probeServices, serviceAddresses } from ${JSON.stringify(href(join(REPO, "test/support/services.ts")))};
export async function setup() {
  const v = await probeServices(process.env, serviceAddresses(process.env, ${JSON.stringify(REPO)}, ${JSON.stringify(url)}));
  process.env.${SERVICE_VERDICT_ENV} = JSON.stringify(v);
}
`);
    const r = run("box.pg.test.ts", PG_GATED(url), { globalSetup: [setup] });
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toContain("SHARED box database");
    expect(statuses(r)).toEqual(["skipped"]);
  }, 150_000);
});

describe("the probe", () => {
  const at = (host: string, port: number) => [{ host, port }];
  const addresses = (o: Partial<ServiceAddresses>): ServiceAddresses => ({
    pg: at("127.0.0.1", refused), greenmail: at("127.0.0.1", refused), dovecot: at("127.0.0.1", refused), rustfs: at("127.0.0.1", refused), ...o,
  });

  it("dials this machine only: another host is recorded as there, never dialed", async () => {
    const dialed: string[] = [];
    const v = await probeServices({}, addresses({ pg: at("db.example", 5432), greenmail: [{ host: "127.0.0.1", port: refused }, { host: "mail.example", port: 25 }] }),
      500, (o) => { dialed.push(o.host); return connect(o); });
    expect(dialed.every(isLoopback), dialed.join(",")).toBe(true);
    expect(v.pg).toEqual({ at: ["db.example:5432"], up: true, why: "not probed: db.example is not this machine" });
    expect(v.greenmail?.up).toBe(true);
    expect(isLoopback("localhost") && isLoopback("127.1.2.3") && isLoopback("::1")).toBe(true);
    expect(isLoopback("10.0.0.1") || isLoopback("127.example") || isLoopback("localhost.example")).toBe(false);
  });

  it("a service is there when any of its addresses accepts; refused everywhere is absent, with the reason", async () => {
    const v = await probeServices({}, addresses({ greenmail: [{ host: "127.0.0.1", port: refused }, { host: "127.0.0.1", port: slamPort }] }));
    expect(v.greenmail).toEqual({ at: [`127.0.0.1:${refused}`, `127.0.0.1:${slamPort}`], up: true, why: "" });
    expect(v.pg).toEqual({ at: [`127.0.0.1:${refused}`], up: false, why: "ECONNREFUSED" });
  });

  it("IMAP_CONDSTORE forces Dovecot on; an address that is no port cannot be probed and throws", async () => {
    expect((await probeServices({ IMAP_CONDSTORE: "1" }, addresses({}))).dovecot?.up).toBe(true);
    await expect(probeServices({}, addresses({ rustfs: at("127.0.0.1", Number.NaN) }))).rejects.toThrow("cannot run");
  });

  it("reads each address from the resolver its tests dial through, and keeps no credential", () => {
    const pg = new URL("postgres://localhost:5433/trafficflow_l_0123456789ab");
    pg.username = "tf";
    pg.password = "x".repeat(8);
    const a = serviceAddresses({ IMAP_HOST: "127.0.0.1", IMAP_PORT: "21001", SMTP_HOST: "127.0.0.1", SMTP_PORT: "23001",
      IMAP_CONDSTORE_PORT: "3145", TF_RUSTFS_URL: "http://127.0.0.1:3903" }, join(tmpdir(), "no-such-checkout"),
      pg.href);
    expect(a).toEqual({
      pg: [{ host: "localhost", port: 5433 }],
      greenmail: [{ host: "127.0.0.1", port: 21001 }, { host: "127.0.0.1", port: 23001 }],
      dovecot: [{ host: "127.0.0.1", port: 3145 }],
      rustfs: [{ host: "127.0.0.1", port: 3903 }],
    });
    expect(JSON.stringify(a)).not.toContain("xxxxxxxx");
  });
});
