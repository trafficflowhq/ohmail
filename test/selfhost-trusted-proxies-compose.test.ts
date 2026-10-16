import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTlsTerminatorList } from "@trafficflow/core/adapters/http-host";

/**
 * THE BUNDLED STACK NAMES ITS OWN PROXY, AND THE PROXY ALONE DECIDES THE TERMINATOR HOP. The api
 * believes `x-forwarded-for` only from `proxy`; on the external-TLS door Caddy settles the visitor's
 * address and hands the api one hop. The two door inputs reach both containers by identical
 * expressions, so the api can refuse a terminator list Caddy would read differently.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const r = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const COMPOSE = r("deploy/selfhost/docker-compose.yml");
const EXTERNAL_DOOR = r("deploy/selfhost/Caddyfile.external-tls");
const TLS_DOOR = r("deploy/selfhost/Caddyfile");
const ROUTES = r("deploy/selfhost/routes.caddy");
const ENTRYPOINT = "deploy/selfhost/proxy-entrypoint.sh";
const FIXTURES = "test/fixtures/selfhost";

/** A top-level service's block, up to the next service at the same indent. */
const block = (name: string): string => COMPOSE.split(new RegExp(`^ {2}${name}:$`, "m"))[1]?.split(/^ {2}\w/m)[0] ?? "";
const services = [...COMPOSE.matchAll(/^ {2}([a-z][a-z-]*):$/gm)].map((m) => m[1]!);
const valueOf = (blockText: string, key: string): string | undefined =>
  new RegExp(`^ {6}${key}: (.*)$`, "m").exec(blockText)?.[1];

describe("the api believes the proxy and nobody else, on both doors", () => {
  it("TF_TRUSTED_PROXIES defaults to the proxy service alone; an operator's own value still wins", () => {
    expect(valueOf(block("api"), "TF_TRUSTED_PROXIES")).toBe("${TF_TRUSTED_PROXIES:-proxy}");
  });

  it("the default names a service that exists, under that name", () => {
    expect(services).toContain("proxy");
    expect(block("proxy")).toMatch(/image: ghcr\.io\/trafficflowhq\/mirror-caddy/);
  });

  it("no other service carries it", () => {
    for (const name of services.filter((s) => s !== "api")) expect(block(name), name).not.toMatch(/TF_TRUSTED_PROXIES/);
  });
});

describe("the door's two inputs reach the proxy and the api by identical expressions", () => {
  for (const key of ["OHMAIL_EXTERNAL_TLS", "OHMAIL_TLS_TERMINATOR"]) {
    it(`${key}: one expression, on both containers, with no default of its own`, () => {
      expect(valueOf(block("proxy"), key)).toBe(`\${${key}:-}`);
      expect(valueOf(block("api"), key)).toBe(valueOf(block("proxy"), key));
      for (const name of services.filter((s) => s !== "proxy" && s !== "api")) {
        expect(valueOf(block(name), key), `${name} carries ${key}`).toBeUndefined();
      }
    });
  }
});

describe("Caddy alone decides the terminator hop", () => {
  it("the external door trusts OHMAIL_TLS_TERMINATOR with no default, strictly", () => {
    const trust = EXTERNAL_DOOR.split("\n").filter((l) => /^\s*trusted_proxies/.test(l)).map((l) => l.trim());
    expect(trust).toEqual(["trusted_proxies static {$OHMAIL_TLS_TERMINATOR}", "trusted_proxies_strict"]);
    expect(TLS_DOOR).not.toMatch(/trusted_proxies/);
  });

  it("every api block replaces X-Forwarded-For with Caddy's client and names its own peer", () => {
    const apiBlocks = [...ROUTES.matchAll(/reverse_proxy(?: @\w+)? api:8080 \{\n([\s\S]*?)\n\t\}/g)].map((m) => m[1]!);
    expect(apiBlocks).toHaveLength([...ROUTES.matchAll(/reverse_proxy(?: @\w+)? api:8080\b/g)].length);
    expect(apiBlocks).toHaveLength(2);
    // The api's side of the header name is asserted in apps/server/test/config-trusted-proxies.test.ts.
    for (const body of apiBlocks) {
      expect(body).toMatch(/^\s*header_up X-Forwarded-For \{client_ip\}$/m);
      expect(body).toMatch(/^\s*header_up X-Ohmail-Proxy-Peer \{http\.request\.remote\.host\}$/m);
    }
  });
});

describe("the proxy entrypoint", () => {
  const fixture = JSON.parse(r(`${FIXTURES}/caddy-2.10.2-terminator-verdicts.json`)) as {
    image: string; imageEntrypoint: string[] | null; imageCmd: string[];
  };

  it("compose runs it, mounted read-only, and it ends in the image's own command", () => {
    expect(block("proxy")).toMatch(/^ {4}entrypoint: \["\/bin\/sh", "\/etc\/caddy\/entrypoint\.sh"\]$/m);
    expect(block("proxy")).toContain("- ./proxy-entrypoint.sh:/etc/caddy/entrypoint.sh:ro");
    expect(fixture.imageEntrypoint).toBeNull();
    const exec = r(ENTRYPOINT).split("\n").filter((l) => l.startsWith("exec "));
    expect(exec).toEqual([`exec ${fixture.imageCmd.join(" ")}`]);
  });

  /** `sh proxy-entrypoint.sh --resolve` on this host, over a route file recorded in the real image. */
  const resolve = (env: Record<string, string>): { out: string; err: string; rc: number | null } => {
    const p = spawnSync("sh", [join(ROOT, ENTRYPOINT), "--resolve"], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
    return { out: p.stdout.trim(), err: p.stderr.trim(), rc: p.status };
  };
  const route = (name: string): string => join(ROOT, FIXTURES, `proc-net-route.${name}.txt`);

  it("in the pool: the gateway, as /32, said as this network's gateway", () => {
    expect(resolve({ OHMAIL_EXTERNAL_TLS: "1", OHMAIL_PROC_NET_ROUTE: route("in-pool") })).toEqual({
      out: "proxy: external door honours X-Forwarded-For from 172.31.228.1/32 (OHMAIL_TLS_TERMINATOR unset: this network's gateway)",
      err: "", rc: 0,
    });
  });

  it("outside 172.16/12 alike: the gateway is read, not assumed", () => {
    expect(resolve({ OHMAIL_EXTERNAL_TLS: "1", OHMAIL_PROC_NET_ROUTE: route("outside-pool"), OHMAIL_TLS_TERMINATOR: " " }).out)
      .toBe("proxy: external door honours X-Forwarded-For from 10.89.228.1/32 (OHMAIL_TLS_TERMINATOR unset: this network's gateway)");
  });

  it("no default route and nothing set: exit 78, naming both remedies", () => {
    const got = resolve({ OHMAIL_EXTERNAL_TLS: "1", OHMAIL_PROC_NET_ROUTE: route("no-route") });
    expect(got.rc).toBe(78);
    expect(got.out).toBe("");
    expect(got.err).toMatch(/OHMAIL_TLS_TERMINATOR to your terminator's address, or to 0\.0\.0\.0\/32 for a relay that adds no X-Forwarded-For/);
  });

  it("a value that is set is passed on as set, route or none; the TLS door says nothing", () => {
    expect(resolve({ OHMAIL_EXTERNAL_TLS: "1", OHMAIL_TLS_TERMINATOR: "0.0.0.0/32", OHMAIL_PROC_NET_ROUTE: route("no-route") })).toEqual({
      out: "proxy: external door honours X-Forwarded-For from 0.0.0.0/32 (OHMAIL_TLS_TERMINATOR set)", err: "", rc: 0,
    });
    expect(resolve({ OHMAIL_PROC_NET_ROUTE: route("in-pool") })).toEqual({ out: "", err: "", rc: 0 });
  });

  const GATEWAY_LINE = "proxy: external door honours X-Forwarded-For from 172.31.228.1/32 (OHMAIL_TLS_TERMINATOR unset: this network's gateway)";

  it("a multi-line value of nothing but whitespace is unset, as the api reads it", () => {
    expect(resolve({ OHMAIL_EXTERNAL_TLS: "1", OHMAIL_PROC_NET_ROUTE: route("in-pool"), OHMAIL_TLS_TERMINATOR: "\n \n" }).out).toBe(GATEWAY_LINE);
  });

  it("a value of nothing but U+00A0 is unset, as the api reads it", () => {
    expect(resolve({ OHMAIL_EXTERNAL_TLS: "1", OHMAIL_PROC_NET_ROUTE: route("in-pool"), OHMAIL_TLS_TERMINATOR: "\u00a0" }).out).toBe(GATEWAY_LINE);
  });
});

describe("one parser decides: the api admits only what Caddy reads as written", () => {
  type Verdict = {
    form: string; value: string; entrypoint: string;
    caddy: { adapted: boolean; ranges: string[] | null; validates: boolean; error: string | null };
  };
  const recorded = JSON.parse(r(`${FIXTURES}/caddy-2.10.2-terminator-verdicts.json`)) as { image: string; verdicts: Verdict[] };
  const byForm = new Map(recorded.verdicts.map((v) => [v.form, v]));
  /** The api's reading of a recorded value: unset, admitted, or the refusal's name. */
  const api = (v: Verdict): string => {
    const p = parseTlsTerminatorList(v.value);
    return !p.ok ? p.refusal : p.entries.length === 0 ? "unset" : "admitted";
  };
  const formsReading = (kind: string): string[] => recorded.verdicts.filter((v) => api(v) === kind).map((v) => v.form).sort();

  it("the recording is of the image compose pins (re-record with the kit control when it moves)", () => {
    expect(block("proxy")).toContain(`image: ${recorded.image}`);
  });

  it("unset is one reading: the api and the image's own entrypoint agree on every recorded value", () => {
    expect(formsReading("unset")).toEqual(["empty", "multi-line-only", "nbsp-only", "newline-only", "spaces-only"]);
    for (const v of recorded.verdicts) expect(v.entrypoint, v.form).toBe(api(v) === "unset" ? "unset" : "set");
  });

  it("every value the api admits starts Caddy and reads, entry for entry, as written", () => {
    expect(formsReading("admitted")).toEqual([
      "bare-v4", "bare-v6", "plain-v4-cidr", "plain-v6-cidr", "space-list", "trust-nothing", "unmasked-cidr",
    ]);
    for (const form of formsReading("admitted")) {
      const v = byForm.get(form)!;
      expect(v.caddy.validates, form).toBe(true);
      expect(v.caddy.ranges, form).toEqual(v.value.split(" "));
    }
  });

  it("the three ruled forms are refused by name, beside what Caddy recorded for each", () => {
    // A comma: Caddy refuses to start; the api's TF_TRUSTED_PROXIES grammar would have split it.
    for (const form of ["comma", "comma-space"]) {
      expect(api(byForm.get(form)!), form).toBe("comma");
      expect(byForm.get(form)!.caddy.validates).toBe(false);
    }
    // An IPv4 address in IPv6 form: Caddy keeps an IPv6 prefix, the api would have folded it to IPv4.
    for (const form of ["mapped-cidr", "mapped-address"]) {
      expect(api(byForm.get(form)!), form).toBe("mapped");
      expect(byForm.get(form)!.caddy.validates).toBe(true);
      expect(byForm.get(form)!.caddy.ranges![0]).toMatch(/^::ffff:/);
    }
    // A keyword: Caddy expands it to every private range, the api would have looked it up as a name.
    expect(api(byForm.get("private-ranges")!)).toBe("word");
    expect(byForm.get("private-ranges")!.caddy.ranges).toContain("172.16.0.0/12");
  });

  it("a line break is refused, and inside or ahead of an entry it is a new proxy directive", () => {
    expect(formsReading("line")).toEqual(["leading-newline", "multi-line-list", "newline", "trailing-newline"]);
    for (const form of ["leading-newline", "multi-line-list", "newline"]) {
      expect(byForm.get(form)!.caddy.adapted, form).toBe(false);
      expect(byForm.get(form)!.caddy.error, form).toMatch(/unrecognized servers option/);
    }
  });

  it("other whitespace is refused by the one rule both sides can state, single spaces only, though Caddy reads it", () => {
    expect(formsReading("whitespace")).toEqual(["double-space", "leading-space", "nbsp-between", "tab-list", "trailing-space"]);
    for (const form of formsReading("whitespace")) expect(byForm.get(form)!.caddy.validates, form).toBe(true);
  });

  it("a word or a malformed address is one Caddy refuses too, but for a zoned address", () => {
    expect(formsReading("word")).toEqual(["host-name", "private-ranges"]);
    expect(formsReading("malformed")).toEqual(["bracketed", "leading-zero-prefix", "malformed-v4", "prefix-too-long", "zone"]);
    for (const form of ["host-name", "bracketed", "leading-zero-prefix", "malformed-v4", "prefix-too-long"]) {
      expect(byForm.get(form)!.caddy.validates, form).toBe(false);
    }
    // The api's alone: a zone id names an interface, not a terminator, and Caddy would take it.
    expect(byForm.get("zone")!.caddy.ranges).toEqual(["fe80::1%eth0"]);
    expect(recorded.verdicts).toHaveLength(5 + 7 + 2 + 2 + 4 + 5 + 2 + 5);
  });
});

/**
 * THE /12 CENSUS. The external door's default once trusted Docker's whole 172.16.0.0/12 pool, and
 * that sentence lived in six places. Every file under the two operator roots is read; the matcher
 * is shown to see a planted statement, so a zero is a reading.
 */
describe("no operator file states the old pool default", () => {
  const POOL = /172\.16(?:\.0\.0)?\/12|Docker's (?:own )?address pool/g;
  const walk = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });
  const files = [...walk("deploy/selfhost"), ...walk("docs/self-host")];

  it("reads zero over every file of deploy/selfhost and docs/self-host", () => {
    // The thirteen this repository carries (the CI stack's env file stays with the maintainers).
    expect(files.length).toBeGreaterThanOrEqual(13);
    const hits = files.flatMap((f) => [...r(f).matchAll(POOL)].map((m) => `${f}: ${m[0]}`));
    expect(hits).toEqual([]);
  });

  it("CONTROL: the same matcher reads a planted statement in one of those files", () => {
    const planted = `${r("deploy/selfhost/.env.example")}\n#OHMAIL_TLS_TERMINATOR=172.16.0.0/12\n`;
    expect([...planted.matchAll(POOL)]).toHaveLength(1);
  });
});
