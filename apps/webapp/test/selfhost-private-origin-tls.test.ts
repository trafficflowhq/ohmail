import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A PRIVATE SELF-HOST ORIGIN MUST NOT REACH FOR A PUBLIC CERTIFICATE AUTHORITY.
 *
 * Caddy chooses its internal issuer on its own for `localhost` and for IP addresses, and for
 * nothing else. A name only the operator's own DNS knows — `ohmail.test`, `mail.lan`,
 * `ohmail.internal` — therefore goes to ACME exactly as a public domain would. Measured on a
 * fresh stack at `https://ohmail.test` (self-host verification cell, Omarchy guest):
 *
 *   · every request failed with `tlsv1 alert internal error` and nothing said why;
 *   · Caddy registered a real account against Let's Encrypt PRODUCTION and ordered a cert;
 *   · LE refused — "Domain name does not end with a valid public suffix" — and Caddy set
 *     itself to retry for `max_duration`, thirty days.
 *
 * So the default turns one `docker compose up` on a private name into a month of rejected
 * orders against a shared public service, from a machine whose operator was never asked. The
 * switch below is the fix, and these cases are what keep it wired.
 *
 * ── AND THERE ARE TWO FRONT DOORS NOW ───────────────────────────────────────────────────
 *
 * A stack behind a TLS terminator it does not own runs `Caddyfile.external-tls` instead, chosen
 * by the proxy's entrypoint composing the `--config` path out of `OHMAIL_EXTERNAL_TLS`. That makes
 * the containment property two-layered — neither the directive nor the FILE may come from
 * `.env` — and gives the ACME rule a second subject. Cookies stay `Secure` on both doors; that
 * half is proved at the mint, in
 * `packages/api/test/selfhost-external-tls-cookie-secure.test.ts`.
 *
 * ── WHY THIS TEST LIVES UNDER apps/webapp ────────────────────────────────────────────────
 *
 * `deploy/selfhost/` has no test target of its own, and `selfhost-flavor.test.ts` beside this
 * file is already where the repo reasons about which owner performs the self-host origin
 * split — the Caddyfile is the other half of that same decision. This directory is also one
 * of the four whose tests are actually TYPECHECKED (CLAUDE.md), which a guard over deployment
 * text should be.
 */

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, "deploy", "selfhost", p), "utf8");

const CADDYFILE = read("proxy/Caddyfile");
const EXTERNAL = read("proxy/Caddyfile.external-tls");
const ENTRYPOINT = read("proxy/entrypoint.sh");
const COMPOSE = read("docker-compose.yml");
const ENV_EXAMPLE = read(".env.example");

/** The Caddyfile's one site block: everything from the site address to the closing brace. */
const siteBlock = (): string => {
  const start = CADDYFILE.indexOf("{$OHMAIL_ORIGIN} {");
  expect(start, "the Caddyfile no longer opens a site block on {$OHMAIL_ORIGIN}").toBeGreaterThan(-1);
  return CADDYFILE.slice(start);
};

/** The `proxy` service's own block: from its key to the next service's. */
const proxyBlock = (): string => {
  const start = COMPOSE.indexOf("\n  proxy:");
  const end = COMPOSE.indexOf("\n  web:");
  expect(start, "docker-compose.yml no longer declares a `proxy` service").toBeGreaterThan(-1);
  expect(end, "`web` no longer follows `proxy`, so this slice no longer bounds it").toBeGreaterThan(start);
  return COMPOSE.slice(start, end);
};

/**
 * The `--config` path the entrypoint hands Caddy. COMPOSED, not a literal: the entrypoint selects
 * the FILE rather than switching configuration inside Caddy. Captured so the cases below can
 * resolve both arms out of it instead of restating either.
 */
const doorConfigPath = (): string => {
  expect(proxyBlock(), "the proxy does not mount ./proxy at /etc/caddy").toContain("- ./proxy:/etc/caddy:ro");
  const m = /^exec caddy run --config "(\/etc\/caddy\/Caddyfile[^"]*)" --adapter caddyfile$/m.exec(ENTRYPOINT);
  expect(m, "the entrypoint runs no Caddyfile under /etc/caddy — the proxy holds no front door").not.toBeNull();
  return m![1]!;
};

/** Resolve one state of a `${VAR:+literal}` the way compose and sh do: the literal, or nothing. */
const resolvePlusArms = (raw: string, set: boolean): string =>
  raw.replace(/\$\{[A-Z0-9_]+:\+([^}]*)\}/g, (_all, literal: string) => (set ? literal : ""));

describe("a private self-host origin can be told to use Caddy's own CA", () => {
  it("the site block carries the TLS placeholder", () => {
    // Without this line there is NO way to reach the internal issuer from the operator's .env,
    // which is the state that sent a private name to Let's Encrypt for thirty days.
    expect(siteBlock()).toContain("{$OHMAIL_TLS_DIRECTIVE:}");
  });

  it("the placeholder is INSIDE the site block, not a global option", () => {
    // A `tls` directive above the site address is not a weaker version of this — it is a
    // Caddyfile parse error, so the stack would not start at all.
    const before = CADDYFILE.slice(0, CADDYFILE.indexOf("{$OHMAIL_ORIGIN} {"));
    expect(before).not.toContain("{$OHMAIL_TLS_DIRECTIVE");
  });

  it("the placeholder defaults to EMPTY, so a public domain still uses ACME", () => {
    // `{$VAR:}` — the empty default. `{$VAR}` with no default would make Caddy fail to load
    // whenever the variable is unset, which is every managed-domain install.
    expect(siteBlock()).toContain("{$OHMAIL_TLS_DIRECTIVE:}");
    expect(siteBlock()).not.toMatch(/\{\$OHMAIL_TLS_DIRECTIVE\}/);
  });

  it("and the second front door cannot order a certificate at all", () => {
    // The rule above has two subjects now. `Caddyfile.external-tls` takes the first one's place
    // whenever OHMAIL_EXTERNAL_TLS is set, and Caddy arms automatic HTTPS off the SITE ADDRESS —
    // so a named address here would order for a private name exactly as the default door did,
    // with no placeholder to turn it off. A scheme-and-port address arms nothing.
    expect(EXTERNAL, "the external-TLS door names an origin as its site address")
      .not.toContain("{$OHMAIL_ORIGIN}");
    expect(EXTERNAL, "the external-TLS door no longer opens on an explicit http://:80")
      .toContain("http://:80 {");
    const tls = EXTERNAL.split("\n").filter((l) => /^\s*tls(\s|$)/.test(l));
    expect(tls, "the external-TLS door carries a tls directive of its own").toEqual([]);
  });
});

describe("the operator's switch is a boolean, never Caddy configuration", () => {
  it("compose maps it with `:+`, so the value is that literal text or nothing", () => {
    // THE CONTAINMENT PROPERTY. The Caddyfile substitutes this variable as raw configuration
    // text, so whatever the operator can put in it, Caddy will execute. `${VAR:+literal}`
    // substitutes the LITERAL when the variable is set and the empty string otherwise — the
    // operator's value itself is never forwarded. A plain `${OHMAIL_TLS_INTERNAL}` here would
    // hand `.env` a direct write into the proxy's configuration.
    expect(COMPOSE).toContain("OHMAIL_TLS_DIRECTIVE: ${OHMAIL_TLS_INTERNAL:+tls internal}");
    expect(COMPOSE).not.toMatch(/OHMAIL_TLS_DIRECTIVE:\s*\$\{OHMAIL_TLS_INTERNAL(:-[^}]*)?\}/);
  });

  it("it is passed to the proxy, which is the container that mounts the front door", () => {
    expect(proxyBlock()).toContain("OHMAIL_TLS_DIRECTIVE:");
    expect(doorConfigPath(), "the door is not a Caddyfile in the mounted directory")
      .toMatch(/^\/etc\/caddy\/Caddyfile/);
  });

  it("the door's PATH is a `:+` literal too, so `.env` cannot name a file", () => {
    // THE SAME CONTAINMENT PROPERTY, one layer out. Whatever file the entrypoint hands Caddy,
    // Caddy executes — so a path the operator's VALUE reaches is a
    // write into the proxy's configuration exactly as a directive would be. `${VAR:+.suffix}`
    // appends a literal on presence; `${VAR}`, `${VAR:-x}` and `${VAR:?x}` all forward the
    // value, and any of them here would let `.env` point the door at a file the operator wrote.
    const raw = doorConfigPath();
    const interpolations = raw.match(/\$\{[^}]*\}/g) ?? [];
    expect(interpolations, "the door's path does not carry exactly one variable")
      .toHaveLength(1);
    expect(interpolations[0]).toMatch(/^\$\{OHMAIL_EXTERNAL_TLS:\+[A-Za-z0-9._-]+\}$/);
    for (const set of [false, true]) {
      expect(resolvePlusArms(raw, set), `a variable survives the ${set ? "set" : "unset"} arm`)
        .not.toContain("${");
    }
  });

  it("and it resolves to one of exactly two files this repository ships", () => {
    // Presence chooses a door; it never supplies one. Both arms must EXIST in ./proxy, which
    // compose mounts at /etc/caddy, or Caddy refuses to start on that door.
    const raw = doorConfigPath();
    expect(resolvePlusArms(raw, false)).toBe("/etc/caddy/Caddyfile");
    expect(resolvePlusArms(raw, true)).toBe("/etc/caddy/Caddyfile.external-tls");
    for (const set of [false, true]) {
      const file = resolvePlusArms(raw, set).replace(/^\/etc\/caddy\//, "");
      expect(existsSync(join(ROOT, "deploy", "selfhost", "proxy", file)), `${file} is not in the tree`)
        .toBe(true);
    }
  });

  it("every door's `import` is mounted, so neither boots on a dangling one", () => {
    // The route table moved out of the Caddyfile when the second door arrived, so "the proxy
    // holds the front door" stopped being the whole requirement: it holds the front door AND
    // whatever that door imports. Read off the doors rather than restated here.
    expect(proxyBlock()).toContain("- ./proxy:/etc/caddy:ro");
    const imports = new Set<string>();
    for (const door of [CADDYFILE, EXTERNAL]) {
      for (const m of door.matchAll(/^\s*import\s+(\S+)\s*$/gm)) imports.add(m[1]!);
    }
    expect(imports.size, "neither door imports anything — has the shared table been inlined?")
      .toBeGreaterThan(0);
    for (const target of imports) {
      expect(target, `${target} is imported from outside the mounted /etc/caddy`).toMatch(/^\/etc\/caddy\/[^/]+$/);
      const file = target.replace(/^\/etc\/caddy\//, "");
      expect(existsSync(join(ROOT, "deploy", "selfhost", "proxy", file)), `${target} is imported by a door and mounted by nothing`)
        .toBe(true);
    }
  });
});

describe(".env.example says when to set it and what it costs not to", () => {
  it("declares the variable", () => {
    expect(ENV_EXAMPLE).toMatch(/^OHMAIL_TLS_INTERNAL=$/m);
  });

  it("names the private-origin case beside OHMAIL_ORIGIN, where the choice is made", () => {
    const origin = ENV_EXAMPLE.slice(0, ENV_EXAMPLE.indexOf("\nOHMAIL_ORIGIN="));
    // An operator reads the sentence next to the value they are filling in. A note about
    // private names filed only under its own variable, forty lines down, is a note they
    // reach after the failure rather than before it.
    expect(origin).toMatch(/OHMAIL_TLS_INTERNAL/);
  });

  it("tells the operator how to trust the resulting root", () => {
    // Selecting the internal issuer fixes the server and leaves every browser refusing it.
    // A switch documented without its second half trades one silent failure for another.
    expect(ENV_EXAMPLE).toContain("pki/authorities/local/root.crt");
  });
});
