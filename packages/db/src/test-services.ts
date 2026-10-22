/**
 * THE TEST SERVICES, PROBED ONCE PER RUN. `test/setup/services.global.ts` dials each service's
 * address once (a TCP connect that sends nothing) and writes the result to {@link SERVICE_VERDICT_ENV},
 * which every test worker inherits. A file that needs an absent service is skipped with the reason
 * (`test/setup/service-gate.runner.ts`, or the file's own {@link serviceUp}); under the service's
 * require variable an absent one fails instead, as in CI. A service that answers but is broken stays red.
 *
 * Tests only, and re-exported by `testing.ts`. No import beyond the language: the suite's runner reads
 * this for every file, so it must cost nothing to load.
 */
export const SERVICE_VERDICT_ENV = "OHMAIL_TEST_SERVICES";
export type ServiceName = "pg" | "greenmail" | "dovecot" | "rustfs";
export const TEST_SERVICES: Readonly<Record<ServiceName, { label: string; require: string; start: string }>> = {
  pg: { label: "Postgres", require: "TF_REQUIRE_PG", start: "docker compose up -d db" },
  greenmail: { label: "GreenMail", require: "TF_REQUIRE_GREENMAIL", start: "docker compose up -d greenmail" },
  dovecot: { label: "Dovecot", require: "TF_REQUIRE_DOVECOT", start: "docker compose --profile condstore up -d dovecot" },
  rustfs: { label: "RustFS", require: "TF_REQUIRE_RUSTFS", start: "docker compose up -d rustfs" },
};
/** One service's probe result: the host:port pairs it dialed (never a URL), and whether one accepted. */
export interface ServiceProbe { at: string[]; up: boolean; why: string }
export type ServiceVerdict = Partial<Record<ServiceName, ServiceProbe>>;

/** The probe's result, or `null` when no probe ran. A malformed one throws by name. */
export function readServiceVerdict(env: NodeJS.ProcessEnv = process.env): ServiceVerdict | null {
  const raw = env[SERVICE_VERDICT_ENV];
  if (raw === undefined || raw === "") return null;
  const bad = (why: string) => new Error(`${SERVICE_VERDICT_ENV} is not a probe result (${why}); test/setup/services.global.ts writes it`);
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw bad("not JSON"); }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad("not an object");
  for (const [k, p] of Object.entries(v as Record<string, unknown>)) {
    if (!Object.hasOwn(TEST_SERVICES, k)) throw bad(`no service is called ${k}`);
    const e = p as Partial<ServiceProbe> | null;
    if (e === null || typeof e !== "object" || !Array.isArray(e.at) || !e.at.every((a) => typeof a === "string")
      || typeof e.up !== "boolean" || typeof e.why !== "string") throw bad(`${k} is not {at: string[], up, why}`);
  }
  return v as ServiceVerdict;
}

/** `host:port` of a URL, the port defaulted; no user, password, path or query. */
export function serviceAddressOf(url: string, defaultPort: number): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || defaultPort}`;
}

/** What the probe found for `name` at `at`, or `null` when it says nothing (no probe, another address). */
export function probedService(
  name: ServiceName, at: string | string[] | undefined, env: NodeJS.ProcessEnv = process.env,
): ServiceProbe | null {
  const p = readServiceVerdict(env)?.[name];
  if (p === undefined) return null;
  const want = at === undefined ? [] : Array.isArray(at) ? at : [at];
  if (want.length > 0 && !want.some((a) => p.at.includes(a))) return null;
  return p;
}

/**
 * IS THIS TEST SERVICE THERE, by the run's one probe. `at` narrows the answer to the address the
 * caller dials: a result for another address says nothing, and nothing said is `up` (no probe ran,
 * so the caller dials and finds out). Absent under the service's require variable THROWS; absent
 * otherwise answers `up: false` and the sentence to put in the skipped test's name.
 */
export function serviceUp(
  name: ServiceName, at?: string | string[], env: NodeJS.ProcessEnv = process.env,
): { up: boolean; why: string } {
  const p = probedService(name, at, env);
  if (p === null || p.up) return { up: true, why: "" };
  const s = TEST_SERVICES[name];
  const where = `${s.label} is not running at ${p.at.join(", ")} (${p.why})`;
  if (env[s.require] === "1") throw new Error(`${s.require}=1 but ${where} — ${s.start}, or unset the variable`);
  return { up: false, why: where };
}
