#!/usr/bin/env node
/**
 * scan-artifact.mjs — what is in the built bundle, and which of the two bundles it is.
 *
 * Two artifacts come out of this directory. The INTERFACE PREVIEW shows an invented mailbox, opens
 * nothing and has no engine behind it. The ENGINE build carries the bridge to a mail engine on this
 * machine, and with it a surface the preview must not contain at all: a pane for pointing this
 * install at a model of your own, and a Screener control that asks that model about waiting
 * senders. Neither means anything without an engine, and shipping either in the preview would put a
 * settings pane for a key nobody can store into a build with nowhere to store it.
 *
 * Tree-shaking is what removes them — everything reachable only from the gate is behind a
 * build-time literal — but tree-shaking is the MECHANISM and not the evidence. The one time this
 * class of thing was checked by reading the config rather than the output, a shipped Linux binary
 * answered `strings` with a subscription price. So this reads the emitted bytes.
 *
 * ── IT CHECKS BOTH DIRECTIONS, WHICH IS WHY IT IS ONE SCRIPT AND NOT TWO ────────────────────
 *
 * A guard that only proves absence goes green when the feature is deleted, and a guard that only
 * proves presence says nothing about the artifact that must not have it. So the caller SAYS which
 * artifact it built, and the surface is required to be present exactly when it should be. Delete
 * the feature and the engine build fails; leak it and the preview fails.
 *
 * ── AND THE ARTIFACT IS DECLARED, NOT SNIFFED ───────────────────────────────────────────────
 *
 * The first version of this read the bundle for the bridge command and decided for itself which of
 * the two it was looking at. That is wrong in the exact case the script exists for: a leak reaches
 * the local settings client, which reaches the bridge, so the bytes that prove the leak also flip
 * the identification — and the preview was reported as an engine build with pieces missing. True,
 * loud, and about the wrong artifact. The thing that knows which one it built is the thing that
 * built it, so it passes `--expect`.
 *
 *   node scripts/scan-artifact.mjs --expect preview|engine [--dist dist]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const args = process.argv.slice(2);
const at = args.indexOf("--dist");
const DIST = path.resolve(APP, at >= 0 ? (args[at + 1] ?? "dist") : "dist");
const expectAt = args.indexOf("--expect");
const EXPECT = expectAt >= 0 ? args[expectAt + 1] : null;

if (EXPECT !== "preview" && EXPECT !== "engine") {
  process.stderr.write("scan: --expect preview|engine is required\n");
  process.exit(1);
}

if (!fs.existsSync(DIST)) {
  process.stderr.write(`scan: no bundle at ${DIST}\n  Build one first:  npm run ui:build\n`);
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

const wantsEngine = EXPECT === "engine";

/**
 * The bridge command is in the engine build and cannot be in the preview — the preview has no
 * shell to call and no commands to call it with. Checked here as well as by the smoke, because a
 * bundle that disagrees with the flag it was built under makes everything below meaningless.
 */
const hasBridge = text.includes("engine_request");

/**
 * THE LOCAL-MODEL SURFACE, as strings that survive minification.
 *
 * Route paths and provider names, because those are what a bundle would have to carry to reach
 * either provider, and one sentence from the control, because copy is the half a reader recognises.
 * Every one of them is absent from the preview today and present in the engine build.
 */
const MARKERS = [
  "local/ai", "anthropic", "ollama", "Set up a model",
  /* The Ohbox-bar editor's own sentence.
   *
   * It has to be THIS string and cannot be the obvious two. The route path `/account/screening` and
   * every word of the shared editor's copy are in the PREVIEW bundle already and legitimately so:
   * the preview compiles the same `AppShell`, which reaches the hosted client's copy of the control
   * through `api-client` — where `API_BASE` is null, so it refuses and the section never draws. So
   * a marker taken from the route or from the shared copy would be present in both artifacts and
   * would prove nothing in either direction. This sentence exists only in
   * `src/DesktopScreeningWords.tsx`, which is reachable only from the gate. */
  "judges them against your sentence",
];

const present = MARKERS.filter((m) => text.toLowerCase().includes(m.toLowerCase()));
const absent = MARKERS.filter((m) => !present.includes(m));

/**
 * WHICH SYNC CLIENT IS IN THIS BUNDLE — the check that would have caught the blank window.
 *
 * The preview aliases `adapters/http-adapter.js` to a stub whose constructor throws; the engine
 * build deliberately does not, because the real class is what runs the mail against the engine on
 * this machine. For a year the public mirror ALSO substituted that stub — it wrote it over the
 * real module's path — so the engine artifact built over there carried a sync client that threw
 * the instant the shell reported a serving mailbox. Inside a React render, with nothing above it
 * to catch: a white window, on a machine that had just signed in successfully. Nothing in the
 * build noticed, because every check ran against the sources, where the real file has always been
 * present, or against the preview, where the stub is correct.
 *
 * ── IT IS ASSERTED POSITIVELY AS WELL AS NEGATIVELY, AND THAT IS THE WHOLE CARE HERE ────────
 *
 * "The refusal sentence is absent" alone is defeated by rewording the stub, which is a one-line
 * edit somebody makes for readability and which would silently retire this guard. So the engine
 * build is also required to contain something ONLY the real client can have, and the two markers
 * come from DIFFERENT parts of the class rather than from one line twice over: `x-csrf-token` is
 * a header its request builder writes, and `/sync/snapshot` is the cold-start route only its
 * `snapshot` method names. The stub has neither a request builder nor a route table.
 *
 * Measured rather than assumed, because the obvious candidates are wrong. `idempotency-key` is in
 * BOTH bundles — the engine mints the key and hands it down, so the string belongs to the client
 * rather than to the adapter — and a marker present in the preview proves nothing in either
 * direction. Both markers below are 0 in the preview and non-zero in the engine build today.
 *
 * The preview is asserted to have the exact inverse, for the reason the whole file is written in
 * both directions: a guard that only proves absence goes green when the feature is deleted.
 */
/**
 * THE HOSTED-ACCOUNT SUGGEST TRANSPORT — the other surface that belongs to one artifact only.
 *
 * An install pointed at a hosted account can buy AI suggestions for the Screener, and it does it
 * over the same pipe the mail comes down. The control it renders is the SHARED one — the ladder,
 * the quote, the confirm — so nothing in the copy distinguishes the two artifacts: every word of
 * that ladder is in the preview already, legitimately, because the preview compiles the same client
 * and simply never draws it. A marker taken from the copy would be present in both and prove
 * nothing in either direction, which is the trap the local-model markers above already document.
 *
 * This string is the transport's own refusal type. It exists in `src/cloud-suggest.ts` and nowhere
 * else, and that module is reachable only from the gate — so it is in the engine build, where the
 * feature works, and must be absent from the preview, which has no pipe to reach an account
 * through. Checked in both directions for the reason everything else here is: a guard that only
 * proves absence goes green the day the feature is deleted.
 */
const HOSTED_SUGGEST_MARKER = "SuggestRefused";

const STUB_REFUSAL = "there is no Cloud sync client in this build";
const REAL_CLIENT_MARKERS = ["x-csrf-token", "/sync/snapshot"];

const hostedSuggestPresent = text.includes(HOSTED_SUGGEST_MARKER);
const stubPresent = text.includes(STUB_REFUSAL);
const realPresent = REAL_CLIENT_MARKERS.filter((m) => text.toLowerCase().includes(m));
const realMissing = REAL_CLIENT_MARKERS.filter((m) => !realPresent.includes(m));

/* Captured into variables and compared, never piped into a matcher: a producer that dies inside a
   pipe looks exactly like a producer that found nothing, and "found nothing" is the answer half of
   this script is hoping for. */
const failures = [];
if (hasBridge !== wantsEngine) {
  failures.push(
    wantsEngine
      ? "this was built as the engine bundle and carries no bridge to an engine"
      : "the interface preview carries the bridge to a local engine",
  );
}
if (wantsEngine) {
  if (absent.length > 0) {
    failures.push(`the engine bundle is missing the local-model surface: ${absent.join(", ")}`);
  }
  if (!hostedSuggestPresent) {
    failures.push(
      "the engine bundle has no hosted-account suggest transport in it — an install pointed at a " +
        "hosted account would find the Screener's suggest control missing, which is the state " +
        "this feature was added to end",
    );
  }
  if (stubPresent) {
    failures.push(
      "the engine bundle carries the PREVIEW's sync-client stub, whose constructor throws — " +
        "the window will go blank the moment a mailbox serves. Check that " +
        "packages/client-engine/src/adapters/http-adapter.ts is the real module in the tree this " +
        "was built from (the public mirror used to substitute the stub at that path).",
    );
  }
  if (realMissing.length > 0) {
    failures.push(
      `the engine bundle has no real sync client in it — absent: ${realMissing.join(", ")}. ` +
        "Nothing but the protocol client itself puts those strings in a bundle.",
    );
  }
} else {
  if (present.length > 0) {
    failures.push(`the interface preview carries the local-model surface: ${present.join(", ")}`);
  }
  if (hostedSuggestPresent) {
    failures.push(
      "the interface preview carries the hosted-account suggest transport — that module reaches " +
        "the bridge, and this artifact has none",
    );
  }
  if (!stubPresent) {
    failures.push(
      "the interface preview has lost the sync-client stub — either the alias in vite.config.ts " +
        "stopped applying, or the stub's refusal was reworded and this guard needs the new words",
    );
  }
  if (realPresent.length > 0) {
    failures.push(
      `the interface preview carries a real sync client: ${realPresent.join(", ")} is in the bundle`,
    );
  }
}

const which = wantsEngine ? "engine build" : "interface preview";
if (failures.length) {
  process.stderr.write(`\nSCAN FAILED (${which}, ${DIST})\n`);
  for (const f of failures) process.stderr.write(`  x ${f}\n`);
  process.exit(1);
}
process.stdout.write(
  `SCAN OK — ${which}: the local-model surface is ${wantsEngine ? "present" : "absent"} ` +
    `(${MARKERS.length} markers checked)\n`,
);
