import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PAGER'S VARIABLES REACH THE SERVICES THAT PAGE ON THEM, AND ONE OF THEM ONLY ONE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Both processes page: the organizer's own alert pass, and the api's (run in-process every minute
 * once `TF_ALERT_SECRET` is set — the only observer of a dead organizer). Three claims:
 *
 *  1. The webhook and the Telegram pair reach BOTH services: both drivers page there.
 *  2. `TF_ALERT_EMAIL` reaches the API ONLY — the load-bearing absence. The api mails through
 *     this stack's SMTP block; the organizer's mail arm speaks one provider's HTTP API, and with
 *     the address set and no `RESEND_API_KEY` it builds an arm that refuses every page: a climbing
 *     failure streak and `alerts_undeliverable` on a healthy stack.
 *  3. `TF_ALERT_SECRET` stays on the api: nothing in the organizer reads it.
 *
 * Every name is in `.env.example`, or an operator cannot find it. Parsed by indentation, as
 * `selfhost-vapid-parity.test.ts` does and for its reason: a comment ABOUT a variable is not an
 * assignment of it.
 */

const r = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const COMPOSE = r("../deploy/selfhost/docker-compose.yml");
const CI = r("../deploy/selfhost/docker-compose.ci.yml");
const ENV_EXAMPLE = r("../deploy/selfhost/.env.example");
const SERVER_CONFIG = r("../apps/server/src/config.ts");
const SMOKE = r("../deploy/selfhost/boot-smoke.mjs");

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

const API = envAssignments(COMPOSE, "api");
const ORGANIZER = envAssignments(COMPOSE, "organizer");
const passthrough = (name: string): string => `\${${name}:-}`;

const BOTH = [
  "TF_ALERT_WEBHOOK_URL", "TF_ALERT_TELEGRAM_BOT_TOKEN", "TF_ALERT_TELEGRAM_CHAT_ID", "TF_ALERT_HEARTBEAT_URL",
] as const;
const API_ONLY = ["TF_ALERT_SECRET", "TF_ALERT_EMAIL"] as const;

describe("the parser reads two distinct services", () => {
  it("found both sets, and neither ran into the other", () => {
    expect(API.size).toBeGreaterThan(10);
    expect(ORGANIZER.size).toBeGreaterThan(10);
    expect(ORGANIZER.has("DATABASE_URL_SESSION"), "the organizer set is not the organizer's").toBe(true);
    expect(API.has("DATABASE_URL_SESSION"), "the api set ran into the organizer's block").toBe(false);
  });
});

describe("the webhook and the Telegram pair reach both services", () => {
  it.each(BOTH)("%s is passed through to the api and to the organizer", (name) => {
    // Red mutation: delete either line from docker-compose.yml.
    expect(API.get(name), `api ${name}`).toBe(passthrough(name));
    expect(ORGANIZER.get(name), `organizer ${name}`).toBe(passthrough(name));
  });
});

describe("the secret and the mail address reach the api alone", () => {
  it.each(API_ONLY)("%s is passed through to the api", (name) => {
    expect(API.get(name)).toBe(passthrough(name));
  });

  it("no other service is handed TF_ALERT_EMAIL — the organizer's arm would refuse every page", () => {
    // Red mutation: add `TF_ALERT_EMAIL` to the organizer's block.
    const services = [...COMPOSE.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]!);
    expect(services).toContain("organizer");
    for (const s of services) {
      if (s === "api") continue;
      for (const name of API_ONLY) {
        expect(envAssignments(COMPOSE, s).has(name), `the \`${s}\` service was handed ${name}`).toBe(false);
      }
    }
  });

  it("the server reads every variable the compose file hands it", () => {
    for (const name of [...BOTH, ...API_ONLY]) {
      expect(SERVER_CONFIG, name).toMatch(new RegExp(`trimmed\\(env,\\s*"${name}"\\)`));
    }
  });
});

describe("an operator can find every one of them", () => {
  it.each([...BOTH, ...API_ONLY])("%s is named in .env.example", (name) => {
    expect(ENV_EXAMPLE).toMatch(new RegExp(`^#?${name}=`, "m"));
  });
});

/** The `.env.example` comment paragraph (split on `#`-only, blank or assignment lines) naming `needle`. */
function envParagraph(needle: string): string {
  const paras: string[][] = [[]];
  for (const line of ENV_EXAMPLE.split("\n")) {
    if (/^# \S|^#\s{2,}\S/.test(line)) paras[paras.length - 1]!.push(line.slice(1).trim());
    else paras.push([]);
  }
  const hit = paras.map((p) => p.join(" ")).filter((p) => p.includes(needle));
  expect(hit, `paragraphs naming ${needle}`).toHaveLength(1);
  return hit[0]!;
}

describe("the env docs promise only the database-down page the code sends", () => {
  // The organizer's leader lock shares the database: it exits with it and runs no pass until it is
  // back, and the api runs no pass (and sends no heartbeat) without TF_ALERT_SECRET.
  it("the alert_db_unreadable page is the api's, behind TF_ALERT_SECRET, not each service's", () => {
    const p = envParagraph("alert_db_unreadable");
    expect(p).not.toMatch(/each service|both services/i);
    expect(p).toContain("TF_ALERT_SECRET");
    expect(p).toMatch(/leader lock/);
    expect(p).toContain("TF_ALERT_HEARTBEAT_URL");
  });

  it("the secret's paragraph says the organizer alone does not page a stopped database", () => {
    expect(envParagraph("Absent means the alert endpoints answer 404")).toMatch(/database/);
  });

  it("the heartbeat paragraph says the api requests it only with the secret", () => {
    expect(envParagraph("dead-man heartbeat")).toContain("TF_ALERT_SECRET");
  });
});

describe("the CI stack runs armed, on a secret minted for the run", () => {
  it("the overlay requires the secret from the env file and holds no value of its own", () => {
    // Red mutation: drop the requirement — a CI run without the secret passes the unarmed branch.
    expect(envAssignments(CI, "api").get("TF_ALERT_SECRET")).toMatch(/^\$\{TF_ALERT_SECRET:\?/);
  });

  it("the boot smoke reads the secret the stack runs on and asks GET /internal/alerts with it", () => {
    expect(SMOKE).toMatch(/process\.env\.TF_ALERT_SECRET \|\| envValues\.TF_ALERT_SECRET/);
    expect(SMOKE).toContain("/internal/alerts");
  });
});
