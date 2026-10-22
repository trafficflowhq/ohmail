// @services: none — reads the selfhost files as text
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { MAIL_DIAL_PORTS } from "@trafficflow/core/net";

/**
 * AN UPDATE THAT EDITS THE PROXY'S CONFIGURATION REACHES A RUNNING PROXY. `git pull` writes a
 * changed file as a new inode, which a single-file bind mount never shows, and `docker compose up
 * -d` recreates a service only when its definition changes. So the proxy mounts its configuration
 * as a directory, and its definition carries a digest of that directory (self-host) or of the
 * rendered Caddyfile (Umbrel), which changes whenever the configuration does.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const rd = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

type Service = { image?: string; volumes?: string[]; labels?: Record<string, string>; env_file?: string[]; environment?: Record<string, string> };
const services = (rel: string): Record<string, Service> => (parse(rd(rel), { logLevel: "error" }) as { services: Record<string, Service> }).services;

const SELFHOST = "deploy/selfhost";
const UMBREL = "deploy/umbrel/ohmail";
const PROXY_DIR = `${SELFHOST}/proxy`;

/** sha256 over each file's name and text, by name, CRLF read as LF so a Windows checkout agrees. */
function proxyDigest(): string {
  const h = createHash("sha256");
  for (const name of readdirSync(join(ROOT, PROXY_DIR)).sort()) {
    const path = join(ROOT, PROXY_DIR, name);
    expect(statSync(path).isFile(), `${PROXY_DIR}/${name} is not a file`).toBe(true);
    h.update(`${name}\0${readFileSync(path, "utf8").replace(/\r\n/g, "\n")}\0`);
  }
  return `sha256:${h.digest("hex")}`;
}

/** The caddy service's mounts into /etc/caddy, with each source resolved to a path in this tree. */
function caddyMounts(composeDir: string): { source: string; target: string; path: string }[] {
  const proxy = Object.values(services(`${composeDir}/docker-compose.yml`)).find((s) => /\/mirror-caddy:/.test(s.image ?? ""));
  expect(proxy, `${composeDir} runs no caddy service`).toBeDefined();
  return (proxy!.volumes ?? [])
    .map((v) => v.split(":"))
    .filter(([, target]) => target === "/etc/caddy" || target!.startsWith("/etc/caddy/"))
    .map(([source, target]) => ({
      source: source!, target: target!,
      path: join(ROOT, composeDir, source!.replace(/^\$\{APP_DATA_DIR\}\//, "").replace(/^\.\//, "")),
    }));
}

describe("the proxy mounts its configuration as a directory, never a single file", () => {
  for (const dir of [SELFHOST, UMBREL]) {
    it(`${dir}: one read-only mount at /etc/caddy, of a directory in this tree`, () => {
      const mounts = caddyMounts(dir);
      expect(mounts.map((m) => m.target)).toEqual(["/etc/caddy"]);
      for (const m of mounts) {
        expect(statSync(m.path).isDirectory(), `${m.source} is a single-file bind mount`).toBe(true);
        expect(m.source).not.toMatch(/\$\{(?!APP_DATA_DIR\})/);
      }
      expect(rd(`${dir}/docker-compose.yml`)).toMatch(/:\/etc\/caddy:ro$/m);
    });
  }

  it("the self-host directory holds the proxy's configuration and nothing else", () => {
    expect(readdirSync(join(ROOT, PROXY_DIR)).sort()).toEqual(["Caddyfile", "Caddyfile.external-tls", "entrypoint.sh", "routes.caddy"]);
  });
});

describe("a change to the self-host proxy's configuration changes the proxy's definition", () => {
  it("the ohmail.proxy-config label is the digest of deploy/selfhost/proxy", () => {
    const label = services(`${SELFHOST}/docker-compose.yml`).proxy?.labels?.["ohmail.proxy-config"];
    expect(label, `deploy/selfhost/proxy changed: set the proxy's label to ohmail.proxy-config: ${proxyDigest()}`)
      .toBe(proxyDigest());
  });
});

describe("the Umbrel proxy is recreated when its rendered Caddyfile changes", () => {
  const scratch = mkdtempSync(join(tmpdir(), "ohmail-umbrel-proxy-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** Run the pre-start hook in a fresh app directory; return proxy.env and the rendered door. */
  const start = (arm: string, origin: string): { env: string; door: string } => {
    const app = join(scratch, arm);
    mkdirSync(join(app, "data", "env"), { recursive: true });
    writeFileSync(join(app, "data", "env", "settings.env"), `OHMAIL_ORIGIN=${origin}\n`);
    execFileSync("bash", [join(ROOT, UMBREL, "hooks/pre-start")], { env: { ...process.env, APP_DATA_DIR: app }, stdio: ["ignore", "ignore", "pipe"] });
    return {
      env: readFileSync(join(app, "data", "env", "proxy.env"), "utf8"),
      door: readFileSync(join(app, "data", "caddy", "etc", "Caddyfile"), "utf8"),
    };
  };

  it("the proxy reads proxy.env", () => {
    expect(services(`${UMBREL}/docker-compose.yml`).proxy?.env_file).toEqual(["${APP_DATA_DIR}/data/env/proxy.env"]);
  });

  it("proxy.env names the render: equal for an equal render, different for a changed one", () => {
    const a = start("a", "https://mail.example.com");
    const again = start("again", "https://mail.example.com");
    const b = start("b", "https://other.example.com");
    const none = start("none", "");
    expect(a.env).toMatch(/^OHMAIL_PROXY_CONFIG_CKSUM=\d+-\d+\n$/);
    expect(again.door).toBe(a.door);
    expect(again.env).toBe(a.env);
    expect(b.door).not.toBe(a.door);
    expect(b.env).not.toBe(a.env);
    expect(none.env).not.toBe(a.env);
  });
});

describe("the boot smoke's mail server is one the api and the organizer dial", () => {
  const smoke = rd(`${SELFHOST}/boot-smoke.mjs`);
  const ci = services(`${SELFHOST}/docker-compose.ci.yml`);
  const knob = (name: string): string => {
    const m = new RegExp(`process\\.env\\.${name} \\?\\? (?:"([^"]+)"|(\\d+))\\)?;`).exec(smoke);
    expect(m, `boot-smoke.mjs has no default for ${name}`).not.toBeNull();
    return m![1] ?? m![2]!;
  };

  it("SMOKE_MAIL_PORT defaults to an IMAP port the dial policy admits, and GreenMail serves IMAP there", () => {
    const port = Number(knob("SMOKE_MAIL_PORT"));
    expect([...MAIL_DIAL_PORTS.imap]).toContain(port);
    const opts = ci.greenmail?.environment?.GREENMAIL_OPTS ?? "";
    expect(/-Dgreenmail\.imap\.port=(\d+)/.exec(opts)?.[1], "GreenMail's IMAP port").toBe(String(port));
    expect(opts, "a test.all/test.imap setup also opens IMAP on 3143").not.toMatch(/greenmail\.setup\.(all|test\.all|test\.imap)\b/);
  });

  it("SMOKE_MAIL_HOST defaults to the overlay's GreenMail, a private host both dialers are told to admit", () => {
    expect(ci[knob("SMOKE_MAIL_HOST")]?.image).toMatch(/^greenmail\/standalone:/);
    for (const name of ["api", "organizer"]) {
      expect(ci[name]?.environment?.TF_PROBE_ALLOW_PRIVATE, `${name} refuses GreenMail's private address`).toBe("1");
    }
  });
});
