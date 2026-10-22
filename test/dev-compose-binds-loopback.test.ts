// @services: none — reads docker-compose.yml as text
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const rd = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/**
 * THE DEVELOPMENT STACK IS NOT FOR THE ROOM IT IS IN.
 *
 * The root compose is this workspace's test services, and what is behind its ports is a database
 * whose password is in the file, a mail server with authentication switched off and an object store
 * with a known key. A `ports:` entry with no address binds `0.0.0.0` AND `[::]` — every interface
 * the machine has — so every one of those was reachable from whatever network the laptop was on.
 *
 * The operator stack learned this already (`OHMAIL_BIND`, defaulting to loopback); this is the same
 * decision for the file that runs on a developer's own machine. `OHMAIL_DEV_BIND` is the escape
 * hatch for a rig that genuinely needs another machine to reach these — set explicitly, never by a
 * port line that forgot.
 */

/** Every published port in a compose file, as written. */
function publishedPorts(text: string): string[] {
  return [...text.matchAll(/^\s*-\s*"([^"]+)"\s*(?:#.*)?$/gm)]
    .map((m) => m[1]!)
    /* A `ports:` value is `[addr:]host:container`; a volume or a command entry is not. Selected by
       SHAPE rather than by section, so a port moved into a new service is still read. */
    .filter((v) => /^[^\s]*:?\d+:\d+$/.test(v));
}

describe("the development stack listens on this machine only", () => {
  const compose = rd("docker-compose.yml");
  const ports = publishedPorts(compose);

  it("found the port lines — an empty list would pass every case below", () => {
    expect(ports.length, "no published ports parsed out of the root compose").toBeGreaterThanOrEqual(5);
    expect(ports.some((p) => p.endsWith(":5433:5432")), "the Postgres publish was not found").toBe(true);
  });

  for (const port of ports) {
    it(`${port} names an address`, () => {
      /* The whole rule: a publish with no address ahead of the host port is the wide one. The
         address has to be the shared variable rather than a literal, so ONE decision moves them
         all — five literals is how four of them stay right and the fifth does not. */
      expect(port, `${port} publishes on every interface`).toMatch(/^\$\{OHMAIL_DEV_BIND:-127\.0\.0\.1\}:/);
    });
  }

  it("and the default in that variable is loopback, said once", () => {
    /* A default written five times is five things to correct. This counts the spelling rather than
       trusting the loop above, because a file could satisfy the loop with five different defaults. */
    const defaults = new Set(
      [...compose.matchAll(/\$\{OHMAIL_DEV_BIND:-([^}]+)\}/g)].map((m) => m[1]!),
    );
    expect(defaults).toEqual(new Set(["127.0.0.1"]));
  });

  it("the operator stack's own bind is still loopback too — the rule this follows", () => {
    /* The pair: if the deployable stack stopped defaulting to loopback, the sentence in the root
       compose's header would be citing a rule that no longer exists. */
    const operator = rd("deploy/selfhost/docker-compose.yml");
    expect(operator).toContain("${OHMAIL_BIND:-127.0.0.1}:443:443");
  });
});
