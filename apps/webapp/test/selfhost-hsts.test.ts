import { afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A SELF-HOSTED INSTALL TELLS THE BROWSER TO KEEP USING HTTPS — AND ONLY WHERE IT CAN.
 *
 * Neither front door sent `Strict-Transport-Security`, so a person who had already signed in over
 * the operator's https origin still sent their NEXT first request in the clear whenever they typed
 * the bare host: Caddy's redirect to https is an answer, and an on-path attacker gets to answer
 * first. HSTS is the header that closes that window, and it closes it for two years — the
 * max-age the managed deployment answers, read live, so the two halves of one product agree.
 *
 * It is also the header that can lock somebody out, because a browser holding an HSTS entry for a
 * host refuses to let anyone click past a certificate warning on it. So it may be sent only where
 * this stack terminates TLS with a PUBLICLY TRUSTED certificate:
 *
 *   · `Caddyfile`, the `{$OHMAIL_ORIGIN}` site — yes, and taken back off by compose on the
 *     `OHMAIL_TLS_INTERNAL` arm, where the certificate comes from this install's own CA;
 *   · `Caddyfile`'s host-less door, `Caddyfile.external-tls`, `routes.caddy` (imported by BOTH
 *     doors) and Umbrel's `:8099` launcher — never; they are plain HTTP or somebody else's TLS.
 *
 * Measured against caddy:2.10.2, the image the compose pins, with a live upstream: the origin door
 * carries the header and the host-less door does not; on the internal-CA arm neither does, on a
 * 200 and on a 502 alike. That last cell is why the set is DEFERRED — a removal applies at write
 * time, so an undeferred set still stamped a proxy error raised before the write.
 */

const ROOT = join(__dirname, "..", "..", "..");
/** The header named on a line that is CONFIGURATION — comments argue about it either way. */
const HSTS = /Strict-Transport-Security/;
const rd = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/** The site blocks of a Caddyfile, address line by address line, with their bodies. Read rather
 *  than grepped: which ADDRESS a directive sits under is the whole question here. */
function siteBlocks(text: string): Array<{ address: string; body: string }> {
  const lines = text.split("\n");
  const out: Array<{ address: string; body: string }> = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith("#")) continue;
    const m = /^(\S.*?)\s*\{\s*$/.exec(line);
    if (!m) continue;
    let depth = 1;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && depth > 0; j += 1) {
      depth += (lines[j]!.match(/\{/g)?.length ?? 0) - (lines[j]!.match(/\}/g)?.length ?? 0);
      if (depth > 0) body.push(lines[j]!);
    }
    out.push({ address: m[1]!, body: body.join("\n") });
  }
  return out;
}

/** A site whose certificate this stack owns and a public authority issued. Every other address —
 *  `http://…`, a bare `:port` — is plain HTTP or somebody else's terminator, and gets nothing. */
const terminatesPublicTls = (address: string): boolean =>
  address === "{$OHMAIL_ORIGIN}" || address.startsWith("https://");

/** Directive lines only: the files argue about this header in prose, and prose is not config. */
const directiveLines = (body: string): string[] =>
  body.split("\n").filter((l) => !/^\s*#/.test(l) && l.trim() !== "");

const CADDYFILE = rd("deploy/selfhost/proxy/Caddyfile");
const EXTERNAL = rd("deploy/selfhost/proxy/Caddyfile.external-tls");
const ROUTES = rd("deploy/selfhost/proxy/routes.caddy");
const COMPOSE = rd("deploy/selfhost/docker-compose.yml");
const ENV_EXAMPLE = rd("deploy/selfhost/.env.example");

const originSite = (): { address: string; body: string } => {
  const site = siteBlocks(CADDYFILE).find((b) => b.address === "{$OHMAIL_ORIGIN}");
  expect(site, "the TLS-owning door no longer opens a site block on {$OHMAIL_ORIGIN}").toBeDefined();
  return site!;
};

describe("the door that owns TLS sends HSTS", () => {
  it("the origin's site block sets it, for two years, and for this host only", () => {
    const set = directiveLines(originSite().body).join("\n");
    expect(set, "no Strict-Transport-Security on the site that owns the certificate").toMatch(HSTS);
    expect(set, "it is set on a name other than the header itself").toMatch(/header\s*\{/);
    // 63072000 is what the managed deployment answers, read live; the two halves of one product
    // should not disagree about how long a browser remembers the rule.
    expect(set).toMatch(/Strict-Transport-Security\s+"max-age=63072000"/);
  });

  it("and reaches NO name but the origin's — neither includeSubDomains nor preload", () => {
    // Both are defaults chosen for somebody else's domain. `includeSubDomains` on an apex
    // origin takes every OTHER subdomain of it HTTPS-only for the whole max-age, which is a
    // year-long lockout of hosts this file has never seen; preload is irreversible for months
    // and is the domain owner's submission to make. An operator who owns every name under
    // their origin appends `; includeSubDomains` themselves — the Caddyfile says so.
    const set = directiveLines(originSite().body).join("\n");
    expect(set, "includeSubDomains is armed for every operator by default")
      .not.toMatch(/includeSubDomains/);
    expect(set, "a self-host origin must not be preloaded on the operator's behalf")
      .not.toMatch(/preload/);
  });

  it("the set is DEFERRED, which is what lets the internal-CA arm take it off every response", () => {
    // A removal applies at write time. Measured on caddy:2.10.2: with an undeferred set, a 502
    // raised by reverse_proxy before the write still carried the header on the arm that removes
    // it — an HSTS entry stored against a locally issued certificate, which is the lockout.
    const body = originSite().body;
    const block = /header\s*\{([\s\S]*?)\n\t\}/.exec(body);
    expect(block, "the header is no longer set as a block, so `defer` has nowhere to live")
      .not.toBeNull();
    expect(block![1]!, "the Strict-Transport-Security set is not deferred").toMatch(/^\s*defer\s*$/m);
  });

  it("the removal placeholder is present, empty by default, and BEFORE the set", () => {
    // Order is load-bearing: two deferred header handlers apply outermost-last, so the removal
    // has to be the outer one. `{$VAR:}` and not `{$VAR}` — the latter makes Caddy refuse to load
    // whenever the variable is absent, which is every run outside this compose.
    const body = originSite().body;
    expect(body, "nothing can remove the header on an internal certificate")
      .toContain("{$OHMAIL_HSTS_DIRECTIVE:}");
    expect(body, "the placeholder has no empty default").not.toMatch(/\{\$OHMAIL_HSTS_DIRECTIVE\}/);
    expect(body.indexOf("{$OHMAIL_HSTS_DIRECTIVE:}"), "the removal sits after the set it removes")
      .toBeLessThan(body.indexOf("header {"));
  });
});

describe("and no door that is not terminating public TLS sends it", () => {
  for (const [name, text] of [
    ["deploy/selfhost/proxy/Caddyfile", CADDYFILE],
    ["deploy/selfhost/proxy/Caddyfile.external-tls", EXTERNAL],
  ] as const) {
    it(`${name} — every plain-HTTP block is clean`, () => {
      const blocks = siteBlocks(text);
      expect(blocks.length, `no site block parsed out of ${name}`).toBeGreaterThan(0);
      for (const { address, body } of blocks) {
        if (terminatesPublicTls(address)) continue;
        expect(directiveLines(body).join("\n"),
          `${name}: the plain-HTTP site \`${address}\` sends HSTS — a LAN name, a bare IP or a ` +
          `terminator's certificate this stack cannot vouch for would store it`)
          .not.toMatch(HSTS);
      }
    });
  }

  it("the external-TLS door has no such block at all, and says where the header belongs", () => {
    // It holds no certificate, so it cannot know whether the terminator's is publicly trusted.
    expect(directiveLines(EXTERNAL).join("\n")).not.toMatch(HSTS);
    expect(EXTERNAL, "nothing tells the operator to set it at their terminator instead")
      .toContain("Strict-Transport-Security");
  });

  it("the shared route table has none either, because BOTH doors import it", () => {
    // A response header set here would be sent by the plain-HTTP door as well — the one thing
    // that would put HSTS on every address this box is dialled at.
    expect(directiveLines(ROUTES).join("\n"),
      "routes.caddy sets HSTS, so the plain-HTTP door sends it too").not.toMatch(HSTS);
  });
});

describe("the operator's private-name switch is what decides it", () => {
  it("compose maps it with `:+`, so `.env` supplies a boolean and never Caddy configuration", () => {
    // THE CONTAINMENT PROPERTY, the same one OHMAIL_TLS_DIRECTIVE keeps: the Caddyfile
    // substitutes this variable as raw configuration text, so a spelling that forwarded the
    // operator's VALUE would hand `.env` a direct write into the proxy's config.
    expect(COMPOSE).toContain(
      "OHMAIL_HSTS_DIRECTIVE: ${OHMAIL_TLS_INTERNAL:+header -Strict-Transport-Security}");
    expect(COMPOSE).not.toMatch(/OHMAIL_HSTS_DIRECTIVE:\s*\$\{OHMAIL_TLS_INTERNAL(:-[^}]*)?\}/);
  });

  it("and it is the SAME variable as the issuer switch, so the two cannot disagree", () => {
    // A separate knob would let an install pick the local CA and keep HSTS armed, which is
    // exactly the pair that locks a machine out once that CA's root stops validating.
    const issuer = /OHMAIL_TLS_DIRECTIVE:\s*\$\{([A-Z0-9_]+):\+/.exec(COMPOSE);
    const hsts = /OHMAIL_HSTS_DIRECTIVE:\s*\$\{([A-Z0-9_]+):\+/.exec(COMPOSE);
    expect(issuer, "the issuer switch was not found").not.toBeNull();
    expect(hsts, "the HSTS switch was not found").not.toBeNull();
    expect(hsts![1]).toBe(issuer![1]);
  });

  it(".env.example tells the operator that setting it turns the header off", () => {
    const arm = ENV_EXAMPLE.slice(0, ENV_EXAMPLE.indexOf("\nOHMAIL_TLS_INTERNAL="));
    expect(arm, "the private-name switch is documented without its HSTS half").toMatch(/HSTS/);
  });
});

/* ── THE UMBREL FRONT DOOR, RENDERED RATHER THAN READ ──────────────────────────────────────
 * That door is written by hooks/pre-start on every start of the app, so the shipped artifact is
 * the hook's OUTPUT and not a file in the tree. Both arms are rendered here: a configured origin,
 * where the certificate is ACME's over TLS-ALPN and so publicly trusted by construction, and an
 * unconfigured one, which serves only the plain-HTTP setup page. */
const rendered = new Map<string, string>();
const scratch = mkdtempSync(join(tmpdir(), "ohmail-umbrel-hsts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function renderUmbrel(arm: string, origin: string): string {
  const cached = rendered.get(arm);
  if (cached !== undefined) return cached;
  const app = join(scratch, arm);
  mkdirSync(join(app, "data", "env"), { recursive: true });
  writeFileSync(join(app, "data", "env", "settings.env"), `OHMAIL_ORIGIN=${origin}\n`);
  execFileSync("bash", [join(ROOT, "deploy/umbrel/ohmail/hooks/pre-start")], {
    env: { ...process.env, APP_DATA_DIR: app },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const out = readFileSync(join(app, "data", "caddy", "etc", "Caddyfile"), "utf8");
  rendered.set(arm, out);
  return out;
}

describe("the umbrelOS front door the pre-start hook renders", () => {
  it("its TLS site sends HSTS — the origin is validated https and the certificate is ACME's", () => {
    const blocks = siteBlocks(renderUmbrel("configured", "https://mail.example.com"));
    const tls = blocks.filter((b) => terminatesPublicTls(b.address));
    expect(tls.map((b) => b.address), "the rendered door has no https site block").toHaveLength(1);
    expect(directiveLines(tls[0]!.body).join("\n"), "the rendered TLS site sends no HSTS")
      .toMatch(/header\s+Strict-Transport-Security\s+"max-age=63072000"/);
  });

  it("and its plain-HTTP launcher does not", () => {
    // `:8099` is what umbrelOS's own app proxy opens, over plain HTTP on the device. An HSTS
    // header there would be about the device's own hostname, which has no certificate at all.
    for (const { address, body } of siteBlocks(renderUmbrel("configured", "https://mail.example.com"))) {
      if (terminatesPublicTls(address)) continue;
      expect(directiveLines(body).join("\n"), `the plain-HTTP site \`${address}\` sends HSTS`)
        .not.toMatch(HSTS);
    }
  });

  it("nor does the setup page an unconfigured install serves", () => {
    expect(renderUmbrel("unconfigured", ""), "the unconfigured launcher mentions HSTS at all")
      .not.toMatch(/Strict-Transport-Security/);
  });

  it("nor the placeholder committed for a start before the hook has run", () => {
    expect(rd("deploy/umbrel/ohmail/data/caddy/etc/Caddyfile")).not.toMatch(/Strict-Transport-Security/);
  });
});
