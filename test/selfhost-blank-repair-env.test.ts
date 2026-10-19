import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../apps/worker/src/config.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  OHMAIL_BLANK_REPAIR REACHES THE SELF-HOSTED ORGANIZER
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The organizer runs the blank repair, a pass that moves letters on the mail server, and the
 * variable is its switch: `off` runs nothing, `dry` counts and writes nothing. The organizer
 * service hands its container an explicit `environment:` map and no `env_file`, so a value in the
 * operator's `.env` reaches the process only through a line in that map. Without one, a `.env`
 * saying `dry` started an organizer reading `apply`, which repaired on its first visit — before
 * anyone had counted anything.
 *
 * Parsed by indentation, as `selfhost-alert-env-parity.test.ts` does and for its reason: a comment
 * ABOUT a variable is not an assignment of it.
 *
 * MUTATION WATCHED: delete the `OHMAIL_BLANK_REPAIR:` line from the organizer's block.
 */

const r = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const COMPOSE = r("../deploy/selfhost/docker-compose.yml");
const CI = r("../deploy/selfhost/docker-compose.ci.yml");
const ENV_EXAMPLE = r("../deploy/selfhost/.env.example");

/** One service's `environment:` assignments, name → value text. */
function envAssignments(file: string, service: string): Map<string, string> {
  const lines = file.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === `  ${service}:`);
  expect(start, `no \`${service}\` service`).toBeGreaterThan(-1);
  const out = new Map<string, string>();
  let inEnv = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (!inEnv) continue;
    if (/^ {4}\S/.test(line)) break;
    const m = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

const NAME = "OHMAIL_BLANK_REPAIR";
const ORGANIZER = envAssignments(COMPOSE, "organizer");

describe("the organizer is handed the repair's mode from .env", () => {
  it("the parser read the organizer's own block", () => {
    expect(ORGANIZER.has("DATABASE_URL_SESSION"), "the organizer set is not the organizer's").toBe(true);
  });

  it("OHMAIL_BLANK_REPAIR is passed through, empty when the operator sets nothing", () => {
    expect(ORGANIZER.get(NAME)).toBe(`\${${NAME}:-}`);
  });

  it("an empty value is the organizer's default, apply, and the three words are read as written", () => {
    // What the passthrough above hands an install that sets nothing.
    const base = { DATABASE_URL_SESSION: "postgres://u:p@127.0.0.1:1/none" };
    expect(loadConfig({ ...base, [NAME]: "" }).blankRepair).toBe("apply");
    for (const mode of ["off", "dry", "apply"] as const) {
      expect(loadConfig({ ...base, [NAME]: mode }).blankRepair).toBe(mode);
    }
  });

  it("no other service is handed it: only the organizer runs the repair", () => {
    const services = [...COMPOSE.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]!);
    expect(services).toContain("organizer");
    for (const s of services) {
      if (s === "organizer") continue;
      expect(envAssignments(COMPOSE, s).has(NAME), `the \`${s}\` service was handed ${NAME}`).toBe(false);
    }
    // The CI overlay leaves it to the env file, as an operator's stack does.
    expect(CI).not.toContain(NAME);
  });

  it("an operator can find it in .env.example, with its three values", () => {
    expect(ENV_EXAMPLE).toMatch(new RegExp(`^#?${NAME}=`, "m"));
    const block = ENV_EXAMPLE.split(new RegExp(`^#?${NAME}=`, "m"))[0]!.split("\n\n").at(-1)!;
    for (const word of ["`apply`", "`dry`", "`off`"]) expect(block, word).toContain(word);
  });
});
