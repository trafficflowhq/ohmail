import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { AI_PROVIDER_ENV, AI_PROVIDERS, AI_VENDOR_NAMED } from "../packages/core/src/ai/transports/host.js";

/**
 * EVERY AI VARIABLE REACHES BOTH SERVICES, and only from the name .env gives it. The api answers a
 * pressed suggestion and a draft; the organizer screens and drafts on its own schedule, so a
 * variable on one of them only is a stack whose halves run different models. Compose fills `${…}`
 * from the invoking shell before .env, and four of these names are the ones SDKs, gateways and
 * other model tools read: a shell exporting one for them would send the household's mail, and the
 * operator's key, where it points. Those four are read from OHMAIL_ names; ANTHROPIC_API_KEY keeps
 * 0.26.1's. The list is the resolver's own plus the timeout, so a variable added there is red here.
 */
const r = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const COMPOSE = "../deploy/selfhost/docker-compose.yml";
const ENV_EXAMPLE = r("../deploy/selfhost/.env.example");
const VARS = [...AI_PROVIDER_ENV, "TF_AI_TIMEOUT_MS"];
const VENDOR_NAMED: readonly string[] = AI_VENDOR_NAMED;
const outer = (name: string): string => (VENDOR_NAMED.includes(name) ? `OHMAIL_${name}` : name);

type Environment = Record<string, unknown>;
const servicesOf = (path: string): Record<string, { environment?: Environment }> =>
  (parse(r(path)) as { services: Record<string, { environment?: Environment }> }).services;

/** Compose's interpolation of one value, the forms its files use: `${X}`, `${X:-d}`, `${X-d}`,
 *  `${X:?e}`, `${X?e}`, `${X:+a}`, `${X+a}` (defaults nest), `$X` and `$$`. */
function interpolate(value: string, env: Record<string, string>): string {
  let out = "";
  for (let i = 0; i < value.length;) {
    if (value[i] !== "$") { out += value[i]; i += 1; continue; }
    if (value[i + 1] === "$") { out += "$"; i += 2; continue; }
    if (value[i + 1] !== "{") {
      const bare = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(i + 1))?.[0] ?? "";
      out += bare ? env[bare] ?? "" : "$";
      i += 1 + bare.length;
      continue;
    }
    let depth = 1;
    let j = i + 2;
    for (; j < value.length && depth > 0; j += 1) depth += value[j] === "{" ? 1 : value[j] === "}" ? -1 : 0;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-|:\?|\?|:\+|\+)([\s\S]*))?$/.exec(value.slice(i + 2, j - 1));
    if (!m) throw new Error(`an interpolation this reader does not know: ${value.slice(i, j)}`);
    const [, name, op, arg = ""] = m;
    const set = Object.hasOwn(env, name!);
    const full = set && env[name!] !== "";
    if (op === ":-") out += full ? env[name!] : interpolate(arg, env);
    else if (op === "-") out += set ? env[name!] : interpolate(arg, env);
    else if (op === ":+") out += full ? interpolate(arg, env) : "";
    else if (op === "+") out += set ? interpolate(arg, env) : "";
    else out += env[name!] ?? "";
    i = j;
  }
  return out;
}

/** What each service's container receives, given the shell's environment and an empty .env. */
function received(env: Record<string, string>): Record<string, Record<string, string>> {
  return Object.fromEntries(Object.entries(servicesOf(COMPOSE)).map(([svc, s]) => [svc,
    Object.fromEntries(Object.entries(s.environment ?? {}).map(([k, v]) => [k, interpolate(String(v ?? ""), env)]))]));
}

describe("the self-host AI variables", () => {
  for (const name of VARS) {
    it(`${name} reaches the api AND the organizer from ${outer(name)}, and the template names it`, () => {
      const services = servicesOf(COMPOSE);
      for (const svc of ["api", "organizer"]) {
        expect(services[svc]!.environment?.[name], `${svc}: ${name}`).toBe(`\${${outer(name)}:-}`);
      }
      const elsewhere = Object.entries(services).filter(([svc, s]) => !["api", "organizer"].includes(svc) && s.environment?.[name] !== undefined);
      expect(elsewhere.map(([svc]) => svc), `${name} on a service that does not run a model`).toEqual([]);
      expect(ENV_EXAMPLE, `the .env template never names ${outer(name)}`).toMatch(new RegExp(`^#?${outer(name)}=`, "m"));
    });
  }

  it("the template offers no line for a bare vendor name, which compose would never read", () => {
    for (const name of VENDOR_NAMED) expect(ENV_EXAMPLE).not.toMatch(new RegExp(`^#?\\s*${name}=`, "m"));
  });

  it("a shell export of a bare vendor name reaches neither container", () => {
    const shell = Object.fromEntries(VENDOR_NAMED.map((n) => [n, `shell-export-of-${n}`]));
    for (const [svc, envOf] of Object.entries(received(shell))) {
      for (const [k, v] of Object.entries(envOf)) expect(v, `${svc}.${k} took the shell's value`).not.toContain("shell-export-of-");
    }
  });

  it("CONTROL: the OHMAIL_ names do reach both containers, under the names the hosts read", () => {
    const shell = Object.fromEntries(VENDOR_NAMED.map((n) => [`OHMAIL_${n}`, `dotenv-value-of-${n}`]));
    const got = received(shell);
    for (const svc of ["api", "organizer"]) {
      for (const n of VENDOR_NAMED) expect(got[svc]![n], `${svc}.${n}`).toBe(`dotenv-value-of-${n}`);
    }
  });

  it("no compose file in this repository interpolates a bare vendor name", () => {
    const files = ["../docker-compose.yml", COMPOSE, "../deploy/selfhost/docker-compose.ci.yml", "../deploy/umbrel/ohmail/docker-compose.yml"];
    const bare = new RegExp(`\\$\\{?(${VENDOR_NAMED.join("|")})\\b`);
    for (const f of files) expect(r(f), f).not.toMatch(bare);
  });

  it("the template shows every provider TF_AI_PROVIDER takes", () => {
    for (const p of AI_PROVIDERS) expect(ENV_EXAMPLE).toContain(`TF_AI_PROVIDER=${p}`);
  });

  it("the private switch is explained in a self-host guide", () => {
    const guides = ["../docs/self-host/README.md", "../docs/self-host/VPS.md", "../docs/self-host/UMBREL.md"].map(r);
    expect(guides.some((g) => g.includes("TF_AI_ALLOW_PRIVATE"))).toBe(true);
  });
});
