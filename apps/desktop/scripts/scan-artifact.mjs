#!/usr/bin/env node
/**
 * scan-artifact.mjs — what is in a built bundle, read from the emitted bytes.
 *
 * Two artifacts come out of this directory now: the WINDOW bundle (`--expect engine`, at `dist/`)
 * that ships inside a binary compiled with the Rust `local-engine` feature, and the SERVED host
 * client (`--expect host-client`, at `dist-host/`) the host door hands to a phone. There used to
 * be a third — a fixtures-only "interface preview", retired under the no-demo rule — and its
 * `--expect preview` arm is refused with its own sentence rather than silently repurposed.
 *
 * Tree-shaking and the aliases in `vite.config.ts` are what keep the wrong things out — but they
 * are the MECHANISM and not the evidence. The one time this class of thing was checked by reading
 * the config rather than the output, a shipped Linux binary answered `strings` with a
 * subscription price. So this reads the emitted bytes.
 *
 * ── IT CHECKS BOTH DIRECTIONS, WHICH IS WHY EVERY ABSENCE HAS A PAIRED PRESENCE ─────────────
 *
 * A guard that only proves absence goes green when the feature is deleted, and a guard that only
 * proves presence says nothing about what must not be there. So every "X is absent" below stands
 * beside a "the thing that REPLACED X is present": the sample world must be out of both bundles
 * AND the refusing stub that stands at its module path must be in them — delete the alias and the
 * corpus check fails; delete the demo arm from the shared shell and the stub check fails, which
 * is the day this guard gets rewritten rather than quietly passing.
 *
 * ── AND THE ARTIFACT IS DECLARED, NOT SNIFFED ───────────────────────────────────────────────
 *
 * The first version of this read the bundle for the bridge command and decided for itself which
 * artifact it was looking at. That is wrong in the exact case the script exists for: a leak
 * reaches the bridge, so the bytes that prove the leak also flip the identification. The thing
 * that knows which one it built is the thing that built it, so it passes `--expect`.
 *
 *   node scripts/scan-artifact.mjs --expect engine [--dist dist]
 *   node scripts/scan-artifact.mjs --expect host-client --dist dist-host
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const args = process.argv.slice(2);
const at = args.indexOf("--dist");
const expectAt = args.indexOf("--expect");
const EXPECT = expectAt >= 0 ? args[expectAt + 1] : null;

if (EXPECT === "preview") {
  process.stderr.write(
    "scan: the interface preview is retired — the app has no demo artifact to scan.\n" +
      "  The two artifacts are:  --expect engine (dist/)  and  --expect host-client (dist-host/)\n",
  );
  process.exit(1);
}
if (EXPECT !== "engine" && EXPECT !== "host-client") {
  process.stderr.write("scan: --expect engine|host-client is required\n");
  process.exit(1);
}
const wantsEngine = EXPECT === "engine";
const DIST = path.resolve(APP, at >= 0 ? (args[at + 1] ?? "dist") : wantsEngine ? "dist" : "dist-host");

if (!fs.existsSync(DIST)) {
  process.stderr.write(
    `scan: no bundle at ${DIST}\n  Build one first:  npm run ${wantsEngine ? "ui:build:engine" : "ui:build:host"}\n`,
  );
  process.exit(1);
}

/** Every emitted byte a string could hide in. */
function bundleText(dir) {
  let text = "";
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|css|html)$/.test(e.name)) text += fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return text;
}

const text = bundleText(DIST);

/**
 * The bridge command is in the WINDOW bundle and cannot be in the host client — the served page
 * has no shell to call; its transport is `fetch` in bearer mode against the origin that served
 * it. Checked here as well as by the smoke, because a bundle that disagrees with the flag it was
 * built under makes everything below meaningless.
 */
const hasBridge = text.includes("engine_request");

/**
 * THE LOCAL-MODEL SURFACE, as strings that survive minification — the window's own settings pane
 * for pointing this install at a model, and the Screener control that uses it. Reachable only
 * from the gate, so it belongs to the window bundle alone; the served client renders the shared
 * shell without the gate and must not carry it.
 */
const MARKERS = [
  "local/ai", "anthropic", "ollama", "Set up a model",
  /* The Ohbox-bar editor's own sentence — it has to be THIS string: the route path and the shared
   * editor's copy are compiled into every artifact that carries `AppShell`, so a marker taken from
   * either would be present everywhere and prove nothing. This sentence exists only in
   * `src/DesktopScreeningWords.tsx`, which is reachable only from the gate. */
  "judges them against your sentence",
];

const present = MARKERS.filter((m) => text.toLowerCase().includes(m.toLowerCase()));
const absent = MARKERS.filter((m) => !present.includes(m));

/**
 * THE HOSTED-ACCOUNT SUGGEST TRANSPORT — gate-reachable only, like the local-model surface. Its
 * refusal type exists in `src/cloud-suggest.ts` and nowhere else.
 */
const HOSTED_SUGGEST_MARKER = "SuggestRefused";

/**
 * THE SHELL COMMANDS THIS BUNDLE CAN NAME. Both are armed from the window entry
 * (`src/main.tsx`); the served client's entry never arms them, and a phone page that could name
 * a shell command would be a page claiming a channel it does not have.
 */
const SHELL_COMMAND_MARKERS = ["open_external", "open_attachment"];

/**
 * WHICH SYNC CLIENT IS IN THIS BUNDLE — the check that would have caught the blank window.
 *
 * Both remaining artifacts construct the REAL `HttpAdapter` (the window over the bridge, the
 * served client over `fetch`), so its markers must be present in both — and they come from
 * different parts of the class so a rewording cannot retire the guard: `x-csrf-token` is a header
 * its request builder writes, and `/sync/snapshot` is the cold-start route only its `snapshot`
 * method names. The refusal sentence below is the RETIRED preview stub's; no artifact may carry
 * it, and the check stays because the public mirror once substituted exactly that stub over the
 * real module's path and shipped a window that went blank the moment a mailbox served.
 */
const STUB_REFUSAL = "there is no Cloud sync client in this build";
const REAL_CLIENT_MARKERS = ["x-csrf-token", "/sync/snapshot"];

/**
 * THE SAMPLE WORLD, OUT OF EVERY SHIPPED BUNDLE — the no-demo rule, in the bytes.
 *
 * The shared shell keeps a demo arm for the landing page, so the fixtures corpus sits one static
 * import away from every `AppShell` build; `vite.config.ts` aliases the fixtures adapter to a
 * refusing stub in BOTH desktop artifacts, and this is the evidence that the alias held. The
 * sentinels are the corpus's own invented people — names and a domain that exist nowhere else in
 * the tree — and the PAIRED presence is the stub's refusal sentence: delete the alias and the
 * sentinels appear; retire the demo arm upstream and the stub disappears, either way this fails
 * loudly instead of going quietly green.
 */
const FIXTURE_SENTINELS = ["Giulia Ferrari", "Petra Wyss", "terracotta-milano.it"];
const NO_FIXTURES_REFUSAL = "ohmail Desktop carries no sample mail";

const hostedSuggestPresent = text.includes(HOSTED_SUGGEST_MARKER);
const commandsPresent = SHELL_COMMAND_MARKERS.filter((m) => text.includes(m));
const commandsMissing = SHELL_COMMAND_MARKERS.filter((m) => !commandsPresent.includes(m));
const stubPresent = text.includes(STUB_REFUSAL);
const realPresent = REAL_CLIENT_MARKERS.filter((m) => text.toLowerCase().includes(m));
const realMissing = REAL_CLIENT_MARKERS.filter((m) => !realPresent.includes(m));
const fixturesPresent = FIXTURE_SENTINELS.filter((m) => text.includes(m));
const noFixturesStubPresent = text.includes(NO_FIXTURES_REFUSAL);

/* Captured into variables and compared, never piped into a matcher: a producer that dies inside a
   pipe looks exactly like a producer that found nothing, and "found nothing" is the answer half of
   this script is hoping for. */
const failures = [];

/* ── every shipped bundle, both artifacts ── */
if (fixturesPresent.length > 0) {
  failures.push(
    `the sample world is in this bundle: ${fixturesPresent.join(", ")}. The app has no demo ` +
      "surface — check the fixtures-adapter alias in vite.config.ts (src/no-fixtures-adapter.ts).",
  );
}
if (!noFixturesStubPresent) {
  failures.push(
    "the no-fixtures stub's refusal sentence is missing — either the alias in vite.config.ts " +
      "stopped applying (and the corpus check above should have fired), or the shared shell's " +
      "demo arm was restructured and this guard needs rewriting rather than deleting",
  );
}
if (stubPresent) {
  failures.push(
    "this bundle carries the retired preview's sync-client stub, whose constructor throws — " +
      "the window will go blank the moment a mailbox serves. Check that " +
      "packages/client-engine/src/adapters/http-adapter.ts is the real module in the tree this " +
      "was built from (the public mirror used to substitute the stub at that path).",
  );
}
if (realMissing.length > 0) {
  failures.push(
    `this bundle has no real sync client in it — absent: ${realMissing.join(", ")}. ` +
      "Nothing but the protocol client itself puts those strings in a bundle.",
  );
}

/* ── per artifact ── */
if (hasBridge !== wantsEngine) {
  failures.push(
    wantsEngine
      ? "this was built as the window bundle and carries no bridge to an engine"
      : "the served host client carries the window's bridge command — a phone page naming a shell channel",
  );
}
if (wantsEngine) {
  if (absent.length > 0) {
    failures.push(`the window bundle is missing the local-model surface: ${absent.join(", ")}`);
  }
  if (!hostedSuggestPresent) {
    failures.push(
      "the window bundle has no hosted-account suggest transport in it — an install pointed at a " +
        "hosted account would find the Screener's suggest control missing, which is the state " +
        "this feature was added to end",
    );
  }
  if (commandsMissing.length > 0) {
    failures.push(
      `the window bundle names no ${commandsMissing.join(" and no ")} command. Each is armed in ` +
        "src/main.tsx; a missing one means the app it ships in has links or attachments that do " +
        "nothing at all — silently, which is what both of them were added to end.",
    );
  }
} else {
  if (present.length > 0) {
    failures.push(`the served host client carries the local-model surface: ${present.join(", ")}`);
  }
  if (hostedSuggestPresent) {
    failures.push(
      "the served host client carries the hosted-account suggest transport — that module reaches " +
        "the bridge, and this artifact has none",
    );
  }
  if (commandsPresent.length > 0) {
    failures.push(
      `the served host client names a shell command: ${commandsPresent.join(", ")}. A phone page ` +
        "has no shell; check that nothing in the shared frontend reaches the arming modules from " +
        "the host-client entry.",
    );
  }
}

const which = wantsEngine ? "window bundle (engine)" : "served host client";
if (failures.length) {
  process.stderr.write(`\nSCAN FAILED (${which}, ${DIST})\n`);
  for (const f of failures) process.stderr.write(`  x ${f}\n`);
  process.exit(1);
}
process.stdout.write(
  `SCAN OK — ${which}: the sample world is absent (${FIXTURE_SENTINELS.length} sentinels), ` +
    `the local-model surface is ${wantsEngine ? "present" : "absent"} (${MARKERS.length} markers)\n`,
);
