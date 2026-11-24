import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE WAKE-SIGNING KEY REACHES THE ORGANIZER AND NOTHING ELSE — asserted, not intended
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two claims, and they fail in opposite directions:
 *
 *  1. **The PUBLIC key must reach BOTH services.** The `api` serves it to phones
 *     (`GET /push/vapid-key`) so a connector can register with it; the `organizer` puts it in the
 *     `k=` field of every wake it signs. Set on only one and the failure is silent in the way this
 *     repository has already paid for once with `TF_PUSH_ALLOW_PRIVATE`: a phone registers against
 *     a key the sender is not using, every wake is dropped by the connector, and no status code
 *     anywhere says so.
 *
 *  2. **The PRIVATE key must reach the ORGANIZER ONLY.** This is the direction a parity test
 *     normally cannot see, because it is an ABSENCE — and an absence is exactly what a later tidy-up
 *     removes. Somebody consolidating the two nearly identical env blocks into a YAML anchor, or
 *     copying the organizer's block as a starting point for a third service, would hand a signing
 *     key to the process that faces the internet. Nothing would break, no test would fail, and the
 *     capability would sit there with no caller for as long as nobody looked.
 *
 * ── WHY THE EXISTING PARITY TEST DOES NOT COVER THIS ─────────────────────────────────────────
 *
 * `selfhost-allowance-parity.test.ts` derives its list from `/trimmed\(env, "(TF_\w*ALLOW_PRIVATE)"\)/`
 * — an anchored regex over the allowance switches. `TF_VAPID_*` matches none of it, so that file is
 * green over every mistake this one is about. That is not a criticism of it: its own header
 * documents that `TF_PUSH_ALLOW_PRIVATE` had ALREADY drifted through three of the four places an
 * operator looks before anything was checking, and the lesson taken then was to check the thing in
 * front of you rather than to write a scanner general enough to cover the next variable too.
 */

const r = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

const COMPOSE = r("../deploy/selfhost/docker-compose.yml");
const ENV_EXAMPLE = r("../deploy/selfhost/.env.example");
const SERVER_CONFIG = r("../apps/server/src/config.ts");
const WORKER_SENDER = r("../apps/worker/src/push-wake.ts");
const KEYGEN = r("../scripts/vapid-keygen.mjs");
const DOCS = [
  ["docs/self-host/VPS.md", r("../docs/self-host/VPS.md")],
] as const;

/**
 * The environment ASSIGNMENTS of one compose service, as a map of name → value text.
 *
 * ── WHY ASSIGNMENTS AND NOT THE BLOCK'S TEXT ─────────────────────────────────────────────────
 *
 * The first version of this scanned the raw block for the variable's NAME, and it was red on a
 * correct compose file — because the api's block deliberately says, in a comment,
 * "TF_VAPID_PRIVATE_KEY IS DELIBERATELY ABSENT FROM THIS SERVICE". That comment is the reason the
 * absence survives a future tidy-up, so a check that treats it as a violation is a check that
 * would get the explanation deleted to go green. The same distinction the mobile privacy census
 * makes: prose ABOUT a thing is not the thing.
 *
 * Parsed by indentation rather than with a YAML library, deliberately: the property under test is
 * about the text an operator and a reviewer read, and a boundary found by indentation is what makes
 * a variable MOVED between services visible.
 */
function envAssignments(service: string): Map<string, string> {
  const lines = COMPOSE.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === `  ${service}:`);
  expect(start, `the compose file has no \`${service}\` service`).toBeGreaterThan(-1);

  const out = new Map<string, string>();
  let inEnv = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // A key at TWO spaces is the next service — this one is over. Checked first, so an
    // environment block can never run past its own service.
    if (/^ {2}\S/.test(line)) break;
    if (/^ {4}environment:\s*$/.test(line)) { inEnv = true; continue; }
    if (!inEnv) continue;
    // A key at FOUR spaces ends the environment block (`healthcheck:`, `depends_on:`, …).
    if (/^ {4}\S/.test(line)) break;
    const m = /^ {6}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (m) out.set(m[1]!, m[2]!.trim());
  }
  return out;
}

const API = envAssignments("api");
const ORGANIZER = envAssignments("organizer");

describe("the compose parser works at all — otherwise every assertion below is vacuous", () => {
  it("found two distinct, non-empty sets of assignments", () => {
    /**
     * The guard on the guard, and it has already earned its place: an earlier version of the
     * parser over-captured and swallowed the organizer's block into the api's, which would have
     * made the load-bearing ABSENCE assertion below pass for the wrong reason. A parser that
     * returned nothing would do the same. Both are caught here.
     */
    expect(API.size).toBeGreaterThan(10);
    expect(ORGANIZER.size).toBeGreaterThan(10);
    /**
     * Each set really is the service it claims to be, established with a pair of variables that
     * are genuinely DISJOINT between the two — which took measuring rather than guessing:
     * `TF_STORAGE_KIND` looked like an organizer marker and is set on both, so an earlier version
     * of this assertion was red on a correct file. `TF_ALERT_SECRET` (the api arms the alert
     * intake; the organizer only POSTs to the webhook) and `DATABASE_URL_SESSION` (the organizer
     * needs a session-mode connection for LISTEN; the api is on the pooled one) are each on
     * exactly one.
     */
    expect(API.has("TF_ALERT_SECRET"), "the api set is not the api's").toBe(true);
    expect(ORGANIZER.has("DATABASE_URL_SESSION"), "the organizer set is not the organizer's").toBe(true);
    // …and neither swallowed the other, which is the failure that would hide a leaked private key.
    expect(API.has("DATABASE_URL_SESSION"), "the api set ran into the organizer's block").toBe(false);
    expect(ORGANIZER.has("TF_ALERT_SECRET"), "the organizer set ran into the api's block").toBe(false);
  });
});

describe("the PUBLIC key reaches both services", () => {
  it("is passed through to the api, which serves it to phones", () => {
    expect(API.get("TF_VAPID_PUBLIC_KEY")).toBe("${TF_VAPID_PUBLIC_KEY:-}");
  });

  it("is passed through to the organizer, which puts it in every wake it signs", () => {
    expect(ORGANIZER.get("TF_VAPID_PUBLIC_KEY")).toBe("${TF_VAPID_PUBLIC_KEY:-}");
  });

  it("is read by the standalone server's config, so the passthrough is not decorative", () => {
    // A compose variable nothing reads is a variable that does nothing. The api's arm is
    // `apps/server/src/config.ts`; the route reads the config member.
    expect(SERVER_CONFIG).toMatch(/trimmed\(env,\s*"TF_VAPID_PUBLIC_KEY"\)/);
    expect(SERVER_CONFIG).toMatch(/vapidPublicKey/);
  });
});

describe("the PRIVATE key reaches the ORGANIZER ONLY", () => {
  it("is passed through to the organizer, which is the only process that signs", () => {
    expect(ORGANIZER.get("TF_VAPID_PRIVATE_KEY")).toBe("${TF_VAPID_PRIVATE_KEY:-}");
    // The optional `sub` rides with it, on the same service and no other.
    expect(ORGANIZER.get("TF_VAPID_SUBJECT")).toBe("${TF_VAPID_SUBJECT:-}");
  });

  it("is NOT assigned to the api — the load-bearing absence", () => {
    /**
     * The whole point of this file. A copy-paste of the organizer's block, or a YAML anchor
     * consolidating the two, would hand a signing key to the process that faces the internet, and
     * nothing else in the repository would notice: no test would fail, no route would change, and
     * the capability would sit there with no caller until somebody looked.
     */
    expect(API.has("TF_VAPID_PRIVATE_KEY"), "the api service was handed the wake-signing private key")
      .toBe(false);
    expect(API.has("TF_VAPID_SUBJECT"), "the api has no use for the signing subject").toBe(false);
  });

  it("no OTHER service in the compose file gets it either", () => {
    // Not just the api: `web`, `proxy`, `db` and anything added later. Derived from the file's own
    // service list so a new service is covered the day it is added rather than the day someone
    // remembers this test.
    const services = [...COMPOSE.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]!);
    expect(services, "the service list was not found").toContain("organizer");
    for (const s of services) {
      if (s === "organizer") continue;
      expect(
        envAssignments(s).has("TF_VAPID_PRIVATE_KEY"),
        `the \`${s}\` service was handed the wake-signing private key`,
      ).toBe(false);
    }
  });

  it("is read ONLY by the organizer's code — no request handler can sign a wake", () => {
    /**
     * The other half of the same property, one layer down: the compose file could be right and the
     * API could still read the variable straight out of `process.env`. So the whole server and API
     * source is swept, and the sender is asserted to be the one place the name appears.
     */
    expect(WORKER_SENDER).toContain("TF_VAPID_PRIVATE_KEY");

    // Every place the name must NOT be. `apps/server` and `apps/api-vercel` are the two
    // request-handling composition roots; `packages/api` is the route table they mount.
    // The roots are read whole: the API program reads its settings in more files than the three
    // this named (`settings.ts`, `settings/managed.ts`), and a new one is covered the day it is added.
    const roots = ["../apps/server/src", "../apps/api-vercel/src"].flatMap((dir) =>
      readdirSync(fileURLToPath(new URL(dir, import.meta.url)), { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".ts")).map((f) => `${dir}/${f.replace(/\\/g, "/")}`));
    expect(roots, "the settings' own file was not read").toContain("../apps/server/src/settings.ts");
    for (const path of [
      ...roots,
      "../packages/api/src/deps.ts",
      "../packages/api/src/routes/push.ts",
    ]) {
      const body = r(path);
      // The docblocks explain WHY the private key is not here, so the code is what is scanned:
      // a comment saying "TF_VAPID_PRIVATE_KEY is deliberately not read" must not fail this.
      const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${path} reads the wake-signing private key`)
        .not.toContain("TF_VAPID_PRIVATE_KEY");
    }
  });
});

describe("an operator can find and generate the keypair", () => {
  it("both halves are named in .env.example", () => {
    expect(ENV_EXAMPLE).toContain("TF_VAPID_PUBLIC_KEY");
    expect(ENV_EXAMPLE).toContain("TF_VAPID_PRIVATE_KEY");
  });

  it("the generator exists, is named in the template, and is named in a guide", () => {
    // A variable an operator cannot produce a value for is not configurable. The keypair is not
    // something anyone can invent by hand, so the template and the guide both have to point at the
    // command — and the command has to exist under the name they use.
    expect(KEYGEN).toContain("TF_VAPID_PUBLIC_KEY");
    expect(ENV_EXAMPLE).toContain("scripts/vapid-keygen.mjs");
    const where = DOCS.filter(([, body]) => body.includes("scripts/vapid-keygen.mjs")).map(([p]) => p);
    expect(where, "no self-host guide tells an operator how to generate a keypair").not.toEqual([]);
  });

  it("the template and the guides say the pair must be this install's OWN", () => {
    // The substantive claim, not a spelling check. Copying another install's private key is the
    // one misuse that is both easy and silently harmful, so every place that introduces the
    // variables has to say not to.
    expect(ENV_EXAMPLE.toLowerCase()).toMatch(/never copy|your own|generate your own/);
    for (const [path, body] of DOCS) {
      if (!body.includes("TF_VAPID_PRIVATE_KEY")) continue;
      expect(body.toLowerCase(), `${path} introduces the private key without warning against reuse`)
        .toMatch(/never copy|generate your own/);
    }
  });

  it("the docs do NOT promise a wake reaches a phone that has been swiped away", () => {
    /**
     * Claims are contracts. A wake that arrives while the app's process is dead currently renders
     * nothing on the device, so no operator-facing sentence may say the phone is woken
     * unconditionally. Checked as a shape rather than a wording, over every sentence that mentions
     * waking at all.
     */
    for (const [path, body] of DOCS) {
      const lower = body.toLowerCase();
      expect(lower, `${path} claims a wake works with the app closed`)
        .not.toMatch(/even when (the app is )?closed|app is not running|works when closed/);
    }
  });
});
