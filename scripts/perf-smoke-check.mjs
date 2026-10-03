#!/usr/bin/env node
/**
 * perf-smoke-check.mjs — does this build start fast enough, and does it stay inside its memory?
 *
 * The workflow could prove the packaged app opens a window and nothing about what it COSTS: a
 * release that starts in eight seconds, or holds a gigabyte for a ten-thousand-message mailbox, is
 * green through the matrix and slow on every machine it installs onto. This reads two instruments
 * over one run of the packaged app — the process group's resident memory from /proc every few
 * seconds, and the app's own `boot_phases`, `engine_vitals`, `first_sync_finished` and `ui_vitals`
 * lines — and answers in one line.
 */
/**
 * Three rules carried over from the measurements these budgets come from. A missing input REFUSES
 * and is never a pass. A process is classified by its ARGUMENTS, never the kernel's `comm`, which
 * Linux truncates at fifteen characters, so `WebKitWebProces` matches no full spelling and a busy
 * renderer reads as no renderer. Memory is the kernel's own kB (`VmRSS`): `statm` counts PAGES,
 * and multiplying those by a 4096 literal is four times too low on a 16 kB-page machine.
 */
/**
 * usage:
 *   perf-smoke-check.mjs --samples <tsv> --engine-log <log> [--bundle <file>]
 *                        [--expect-messages <n>] [--fixture-messages <n>] [--runner-s <build step s>]
 *                        [--engine-dir <dir>] [--budget-table <file>]   (both derived when absent)
 *   perf-smoke-check.mjs --boot --platform <linux_x64|macos|windows> --engine-log <log> [--runner-s <n>]
 *   perf-smoke-check.mjs --sample --pid <pid> --out <tsv> --seconds <n> [--interval <s>]
 *   perf-smoke-check.mjs --perf-smoke-only   the selftest: every arm watched failing and admitting
 * verdict: PERF_SMOKE: GREEN rc 0 - RED rc 1 - REFUSED rc 3 - CLASSIFY-ASK RUNNER rc 5.
 */
import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/* ── THE TIMING CEILINGS, FROM A DISTRIBUTION ───────────────────────────────────────────────
 *
 * One reading set the old 4 000 ms engine line, under the release runs' own median, so runner
 * speed alone turned two hotfixes red. Every reading below is one the published `build` workflow
 * logged (trafficflowhq/ohmail runs 231-242, 0.25.0-0.25.8, every attempt; an attempt that reused
 * its job is one reading), read 2026-10-02 through the Actions API. The rule and the readings are
 * data and `ceilingFrom` makes the number; a platform under `minReadings` has no ceiling and decides
 * nothing. `buildStepS` is that job's build step, the runner-speed reading taken beside each one.
 */
export const CEILING_RULE = {
  percentile: 0.95, interpolation: "linear", margin: 0.10, roundUpToMs: 100, minReadings: 5,
  // The runner band: a slower-than-median runner widens a timing ceiling by its factor, capped.
  runnerFactorCap: 1.5,
};

export const TIMING_READINGS = {
  linux_x64: {
    instrument: "the perf smoke: the packaged AppImage's first start beside the 5k fixture",
    runnerStep: "Build the engine-bearing app, smoking its bundle",
    columns: ["run", "attempt", "totalReadyMs", "pgliteOpenMs", "migrateMs", "adoptBaselineMs", "searchSetupMs", "listUsableMs", "buildStepS"],
    rows: [
      [231, 1, 4126, 2357, 1507, 43, 116, 7978, 594],
      [232, 1, 3651, 2309, 1102, 42, 113, 6815, 601],
      [232, 2, 3869, 2456, 1167, 45, 115, 6819, 614],
      [233, 1, 4881, 3066, 1506, 49, 149, 8257, 629],
      [234, 1, 4533, 2922, 1318, 46, 135, 8457, 623],
      [235, 1, 5008, 3258, 1455, 55, 125, 8141, 617],
      [237, 1, 4349, 2851, 1251, 48, 118, 8637, 635],
      [238, 1, 3908, 2566, 1117, 37, 102, 6665, 520],
      [239, 1, 3905, 2187, 1353, 167, 113, 6458, 575],
      [240, 1, 3029, 1712, 1054, 124, 78, 4629, 476],
      [241, 1, 6127, 3603, 1996, 277, 146, 9687, 617],
      [241, 2, 4492, 2557, 1534, 199, 108, 7688, 526],
      [241, 3, 3613, 1922, 1218, 165, 177, 5764, 432],
      [242, 1, 4168, 2212, 1339, 175, 134, 6669, 577],
      [242, 2, 3734, 1973, 1346, 160, 85, 5689, 435],
    ],
    /* Runs 243-245 (0.25.9-0.25.11), read 2026-10-03 the same way. They feed ONLY the store-open
     * ceiling, so the two timing ceilings and both medians stay the ones measured over `rows`. */
    laterRows: [
      [243, 1, 3984, 2236, 1344, 160, 113, 6299, 445],
      [244, 1, 4770, 2718, 1645, 181, 125, 7779, 718],
      [245, 1, 5300, 2954, 1886, 196, 145, 9546, 596],
    ],
    /* The store every row above opened: its open time stands for the runner only on these bytes. */
    store: { pglite: "0.2.17", extensions: ["btree_gin", "pg_trgm"] },
  },
  macos: {
    instrument: "The packaged engine starts with no node on PATH: an empty data dir, a dead IMAP port",
    runnerStep: "Build the engine-bearing app (universal), smoking its bundle",
    columns: ["run", "attempt", "totalReadyMs", "pgliteOpenMs", "migrateMs", "adoptBaselineMs", "searchSetupMs", "buildStepS"],
    rows: [
      [231, 1, 2745, 1474, 1077, 32, 72, 485],
      [232, 1, 2361, 1547, 652, 44, 52, 473],
      [233, 1, 1710, 1050, 541, 24, 49, 376],
      [234, 1, 2316, 1483, 678, 34, 66, 485],
      [235, 1, 1789, 1126, 523, 33, 48, 500],
      [237, 1, 2697, 1814, 719, 34, 57, 561],
      [238, 1, 1694, 1046, 523, 24, 49, 325],
      [239, 1, 3350, 1936, 1069, 148, 75, 524],
      [240, 1, 2641, 1342, 1070, 94, 64, 488],
      [241, 1, 3268, 1964, 1034, 110, 81, 492],
      [242, 1, 3578, 2278, 977, 137, 87, 502],
    ],
  },
  windows: {
    // 33 job logs of runs 216-242 carry no boot line: the job printed none until this change.
    instrument: "verify-engine-boot's healthy boot: an empty data dir, a dead IMAP port",
    runnerStep: "Build the engine-bearing app, smoking its bundle",
    columns: ["run", "attempt", "totalReadyMs", "pgliteOpenMs", "migrateMs", "adoptBaselineMs", "searchSetupMs", "buildStepS"],
    rows: [],
  },
};

/** The `p` quantile by linear interpolation between closest ranks. */
export function quantile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return null;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** The ceiling a set of readings earns under the rule, or null with the reason. */
export function ceilingFrom(values, rule = CEILING_RULE) {
  if (values.length < rule.minReadings) {
    return { n: values.length, p95: null, ceilingMs: null, why: `${values.length} of the ${rule.minReadings} readings a ceiling needs` };
  }
  const p95 = quantile(values, rule.percentile);
  const ceilingMs = Math.ceil((p95 * (1 + rule.margin)) / rule.roundUpToMs) * rule.roundUpToMs;
  return { n: values.length, p95: Math.round(p95), ceilingMs, why: null };
}

/** Per platform: each timing arm's ceiling, each boot phase's p95, and the runner's median. */
export function deriveTiming(readings = TIMING_READINGS, rule = CEILING_RULE) {
  const out = {};
  for (const [platform, t] of Object.entries(readings)) {
    const col = (name, rows = t.rows) => {
      const at = t.columns.indexOf(name);
      return at < 0 ? [] : rows.map((r) => r[at]).filter((v) => typeof v === "number");
    };
    const phaseP95 = {};
    for (const name of PHASE_FIELDS) {
      const values = col(name);
      if (values.length >= rule.minReadings) phaseP95[name] = Math.round(quantile(values, rule.percentile));
    }
    const runner = col("buildStepS");
    const pglite = col("pgliteOpenMs");
    out[platform] = {
      engine_ready: ceilingFrom(col("totalReadyMs"), rule),
      start_to_list: ceilingFrom(col("listUsableMs"), rule),
      pglite_open: ceilingFrom([...pglite, ...col("pgliteOpenMs", t.laterRows ?? [])], rule),
      phaseP95,
      runnerStep: t.runnerStep,
      runnerReferenceS: runner.length >= rule.minReadings ? Math.round(quantile(runner, 0.5)) : null,
      pgliteReferenceMs: pglite.length >= rule.minReadings ? Math.round(quantile(pglite, 0.5)) : null,
      store: t.store ?? null,
    };
  }
  return out;
}

/* The boot line's phases, in the order the engine runs them; whatever the total holds beyond
 * their sum is printed as `unattributed`, so the phases always add up to the reading. */
export const PHASE_FIELDS = ["pgliteOpenMs", "adoptBaselineMs", "migrateMs", "compactMs", "searchSetupMs", "worldMs"];

export const PLATFORM_TIMING = deriveTiming();

/**
 * One timing reading against its ceiling and the runner band. PASS at or under the ceiling; over
 * it, CLASSIFY when the runner ran slower than its median by a factor f and the reading is within
 * ceiling x min(f, cap); FAIL otherwise, an unread runner included. `factor` is the store-open
 * form (null with `factorWhy` when refused); without it, the build step's seconds give f.
 */
export function timingVerdict({ readingMs, ceilingMs, runnerS, runnerReferenceS, factor: given, factorWhy, rule = CEILING_RULE }) {
  if (readingMs <= ceilingMs) return { status: "PASS", bandMs: null, factor: null };
  if (given === null) return { status: "FAIL", bandMs: null, factor: null, why: factorWhy };
  if (given === undefined && (!(runnerS > 0) || !(runnerReferenceS > 0))) {
    return { status: "FAIL", bandMs: null, factor: null, why: "the runner's speed is unread, so nothing can widen the ceiling" };
  }
  const factor = given ?? runnerS / runnerReferenceS;
  if (factor <= 1) {
    return { status: "FAIL", bandMs: null, factor, why: "the runner was not slower than its median" };
  }
  const bandMs = Math.ceil(ceilingMs * Math.min(factor, rule.runnerFactorCap));
  return readingMs <= bandMs
    ? { status: "CLASSIFY", bandMs, factor }
    : { status: "FAIL", bandMs, factor, why: "over the runner band as well" };
}

/* ── THE STORE'S OPEN TIME IS THE RUNNER'S READING ON LINUX ─────────────────────────────────
 * pglite's open runs pinned bytes and none of our code, and over the 18 recorded runs it tracks
 * engine_ready at r=0.92 and start_to_list at 0.91, where the build step's seconds read 0.57 and
 * 0.70. So its ratio to its median widens the Linux ceilings; it has its own ceiling, never
 * widened, so a slower open in our code is not divided out; and a different pglite or extension
 * set refuses the comparison by name until the readings are retaken.
 */
export function readStoreIdentity(engineDir) {
  const pkg = join(engineDir, "node_modules", "@electric-sql", "pglite", "package.json");
  const bundle = join(engineDir, "ohmail-engine.mjs");
  if (!existsSync(pkg)) return { unread: `no pglite package at ${pkg}` };
  if (!existsSync(bundle)) return { unread: `no engine bundle at ${bundle}` };
  const version = JSON.parse(readFileSync(pkg, "utf8")).version ?? null;
  const names = readFileSync(bundle, "latin1").matchAll(/@electric-sql\/pglite\/contrib\/([a-z0-9_]+)/g);
  return { pglite: version, extensions: [...new Set([...names].map((m) => m[1]))].sort() };
}

const storeName = (s) => `pglite ${s.pglite} with ${s.extensions.length ? s.extensions.join(", ") : "no extensions"}`;

/** Why the shipped store cannot stand for the runner, or null when it is the recorded one. */
export function storeRefusal(actual, recorded) {
  if (actual === null) return "the shipped store was not read (no --engine-dir and no --bundle)";
  if (actual.unread) return `the shipped store is unread: ${actual.unread}`;
  if (!recorded) return "no recorded store to compare it with";
  if (storeName(actual) === storeName(recorded)) return null;
  return `the shipped store is ${storeName(actual)} and the readings were taken on ${storeName(recorded)}; retake TIMING_READINGS before its open time stands for the runner`;
}

/** The Linux band's factor: this run's store open over its recorded median, or null and why. */
export function storeAllowance(pgliteOpenMs, storeIdentity, timing) {
  const refused = storeRefusal(storeIdentity, timing?.store);
  if (refused) return { factor: null, why: refused };
  if (!(timing?.pgliteReferenceMs > 0)) return { factor: null, why: "no store-open median to compare it with" };
  if (!(pgliteOpenMs > 0)) return { factor: null, why: "the boot line carries no pgliteOpenMs" };
  return { factor: pgliteOpenMs / timing.pgliteReferenceMs, why: null };
}

/** The runner's reading as the verdict line prints it. */
export function runnerLine(runnerS, timing) {
  const ref = timing?.runnerReferenceS;
  if (!(runnerS > 0)) return "runner: build step unread";
  if (!(ref > 0)) return `runner: build step ${runnerS} s, no median to compare it with`;
  return `runner: build step ${runnerS} s against its median ${ref} s (x${(runnerS / ref).toFixed(2)})`;
}

/* ── THE BUDGETS, EACH WITH WHAT IT CAME FROM ─────────────────────────────────────────────────
 *
 * A budget is a number with an origin. A number invented in advance would have every later
 * reading judged against the invention instead of against the product, so each line below says
 * where it comes from, and a budget the perf table rules `records` is printed and reddens nothing.
 */
export const BUDGETS = {
  /* The renderer group — the webview's own processes — at its peak over a first sync: the perf
   * table's ruled `renderer.peak-first-sync` ceiling, the row whose drive is this run's, copied
   * because this file is published and the table is not. */
  rendererPeakKb: 1400 * 1024,
  /* THE GOAL, printed beside it: this check's own derivation, that a renderer bounded by its mail
   * window costs the same at any mailbox size, so the larger mailbox's 400 MB goal holds here too.
   * It is not the ceiling: a hosted runner's EMPTY app read 452 MB in its web group on 2026-09-24,
   * so as a ceiling it could not pass on any build. */
  rendererGoalKb: 400 * 1024,
  /* The mail engine, steady. Measured: 378.8 MB settled on an empty install, and 450 MB settled
   * with five and twenty-five thousand messages. The shell now spawns the engine with a fixed
   * mmap threshold (`allocator_arenas.rs`), so the optimizing compiler's scratch memory is handed
   * back instead of staying resident by an amount that depends on timing: the engine read
   * 368-467 MB at boot without it and 336-338 MB with it. A reading near this ceiling is that
   * retention come back. */
  engineRssKb: 450 * 1024,
  /* The engine's own boot, `boot_phases.totalReadyMs`, on this step's shape: an empty install that
   * makes its store while the 5k fixture waits on the server. Derived from the release runs'
   * distribution below (TIMING_READINGS), never typed here. */
  engineReadyMs: PLATFORM_TIMING.linux_x64.engine_ready.ceilingMs,
  /* The first import, from `first_sync_finished`. The released build's own line read 33.1 messages
   * a second because its clock began at the END of the drain that found the import open; measured
   * end to end the same mailbox arrived at 24.1, and the reference rig reads 26.0. So this is 2.3
   * times a released build, and it is read only when the import finished inside the run — against
   * a `totalMs` that now covers the drain that found the import open. */
  syncMsgPerS: 60,
  /* The window's cold start to a usable list (`ui_vitals.listUsableMs`), derived from the same
   * runs. The plan's 2 000 ms is the goal, printed beside it. */
  startToListMs: PLATFORM_TIMING.linux_x64.start_to_list.ceilingMs,
  startToListGoalMs: 2000,
  /* Everything below is read from `ui_vitals` and has NO MEASUREMENT BEHIND IT YET; the table
   * rules every one of them `records`. */
  frameGapMs: 50,
  longTaskMs: 200,
  longTaskMax: 0,
  openP95Ms: 150,
};

/* The shape a window has to have before it is read at all. A CI run is minutes rather than the
 * half hour a soak takes, so these are this check's own floors and not a soak's: below them the
 * answer is a refusal naming the shape, never a green. */
export const MIN_SAMPLES = 12;
export const MIN_SPAN_S = 100;

/* An engine memory reading arrives in BYTES and a sampler's in kB, and the two have been read
 * against each other's budget before. The conversion is one place, and it refuses a converted
 * figure outside the magnitudes a mail engine can have — a unit error then names itself instead
 * of passing as a very small or very large process. */
export function engineRssKbFromBytes(bytes) {
  const kb = Math.round(bytes / 1024);
  if (!Number.isFinite(kb) || kb < 8 * 1024 || kb > 16 * 1024 * 1024) {
    return { kb: null, why: `an engine resident size of ${kb} kB is outside what this process can be — the log's own field is BYTES` };
  }
  return { kb, why: null };
}

/* ── THE SAMPLE FILE ──────────────────────────────────────────────────────────────────────────
 * One line per sample: epoch, the group total in kB, then `role=kB` for each role, then
 * `grpswap=kB`. Roles are the canonical ones the sampler writes.
 */
const WEB_ROLES = new Set(["renderer", "gpu", "net"]);

/* The canonical role names, and the ONE place three spellings are reconciled. The sampler in this
 * file writes the canonical names; a sample taken with the kernel's process names — the shape
 * every earlier reading of this app was recorded in — carries the WebKit spellings and their
 * fifteen-character truncations. Reading both is what lets a real recorded run be the control
 * this check is proven against, instead of a fixture written to pass it. */
export function canonRole(key) {
  if (key.startsWith("WebKitWebProces")) return "renderer";
  if (key.startsWith("WebKitGPUProces")) return "gpu";
  if (key.startsWith("WebKitNetworkPr")) return "net";
  if (key === "node") return "engine";
  if (key === "ohmail") return "shell";
  if (key === "ohmailimg") return "launcher";
  return key;
}

export function parseSamples(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    const cells = line.split("\t").filter((c) => c !== "");
    if (cells.length < 2) continue;
    const epoch = Number(cells[0]);
    if (!Number.isFinite(epoch)) continue;
    const roles = new Map();
    for (const cell of cells.slice(2)) {
      const at = cell.indexOf("=");
      if (at < 0) continue;
      const key = canonRole(cell.slice(0, at));
      const value = Number(cell.slice(at + 1));
      if (!Number.isFinite(value)) continue;
      roles.set(key, (roles.get(key) ?? 0) + value);
    }
    rows.push({ epoch, total: Number(cells[1]) || 0, roles });
  }
  return rows;
}

export function webTotal(row) {
  let sum = 0;
  for (const [key, value] of row.roles) if (WEB_ROLES.has(key)) sum += value;
  return sum;
}

export function peakOf(rows, pick) {
  let peak = 0;
  for (const row of rows) peak = Math.max(peak, pick(row));
  return peak;
}

/* ── THE APP'S OWN LINES, BY FIELD ────────────────────────────────────────────────────────────
 * By field and never by JSON.parse: a log captured while the process was stopped ends in a line
 * cut mid-string, and a parser that needs whole JSON throws away the last real reading. Nothing
 * from the log is echoed — these lines carry mailbox identifiers, and this check reads numbers.
 */
export function lastField(log, event, field) {
  let found = null;
  const re = new RegExp(`"${field}":(-?\\d+)`);
  for (const line of log.split("\n")) {
    if (!line.includes(`"event":"${event}"`)) continue;
    const m = re.exec(line);
    if (m) found = Number(m[1]);
  }
  return found;
}


/* ── WHETHER THE FRAME AND LATENCY HALF IS EVEN IN THIS BUILD ─────────────────────────
 *
 * Two conditions measured independently, so the arm turns itself on when the second half of the
 * instrumentation lands rather than when somebody flips a switch: the artifact carries the
 * `ui_vitals` emitter, and the run's log carries `ui_vitals` lines. Present with lines, the arms
 * DECIDE; present with none is RED (the instrument shipped and wrote nothing); absent with none is
 * UNREAD, printed and reddens nothing; absent with lines is RED. A flag would make the third state
 * indistinguishable from somebody forgetting.
 */
export const UI_VITALS_EVENT = "ui_vitals";

/* ── THE VOCABULARY THE WINDOW WRITES, AND THIS CHECK AS ITS FOURTH HOME ──────────────────────
 *
 * The window composes the report, the desktop shell's Rust writes the line from its OWN list of
 * names, and this file reads it back. They did not agree: this file read `startToListMs`,
 * `openMs`, `frameGapMs` and `longTaskMs` under `"service":"shell"`, none of which the window has
 * ever written — so on a build inside every budget three arms answered "wrote none of these
 * marks" and turned the job red while the fourth scored a perfect zero out of nothing.
 * A census in the workspace holds these names equal to the shell's list and to the report's own
 * keys, so a rename reddens there rather than here as a performance verdict.
 */
export const UI_VITALS_SERVICE = "ui";
export const UI_VITALS_READS = {
  start_to_list: "listUsableMs",
  open_p95: "openP95Ms",
  long_frames: "longFrames",
  long_tasks: "longTasks",
};

/* ── THE DERIVATION FIGURES, ON THAT SAME LINE ────────────────────────────────────────────────
 *
 * The window rebuilds what it shows from the mirror on every version bump, on the thread that
 * draws, and reports that pass's cost beside the marks above: the worst pass, the p50 and p95 over
 * the last hundred, and how many bumps paid for them. This check reads all four and budgets only
 * the p95 — the one a ceiling is stated for. The three durations are `null` when the window derived
 * nothing in a window; `deriveCount` is a plain count, and a count of zero is a real reading.
 */
export const UI_VITALS_DERIVE_READS = {
  derive_ms: "deriveMs",
  derive_p50: "deriveP50Ms",
  derive_p95: "deriveP95Ms",
  derive_count: "deriveCount",
};

/** Every `ui_vitals` line, by SERVICE as well as event — the tag is part of the vocabulary. */
export function uiVitalsLines(log) {
  const out = [];
  for (const line of log.split("\n")) {
    if (line.includes(`"event":"${UI_VITALS_EVENT}"`)
      && line.includes(`"service":"${UI_VITALS_SERVICE}"`)) out.push(line);
  }
  return out;
}

/**
 * One field across those lines, in the THREE states the wire format actually has.
 *
 * The shell writes every name it knows on every line and puts `null` where the window did not
 * answer, so a missing KEY and a null VALUE are different facts. Missing means this log and this
 * check no longer share a vocabulary; null means nothing was measured in that window — nobody
 * opens a message during the CI run, so `openP95Ms` is honestly null there. Folding the two into
 * a zero is the reading this whole file exists to refuse.
 */
export function readUiVitalsField(lines, field) {
  const number = new RegExp(`"${field}":(-?\\d+)`);
  const key = new RegExp(`"${field}":`);
  let keyLines = 0;
  const values = [];
  for (const line of lines) {
    if (!key.test(line)) continue;
    keyLines += 1;
    const m = number.exec(line);
    if (m) values.push(Number(m[1]));
  }
  return { keyLines, values };
}

export function uiVitalsState({ inBundle, lineCount }) {
  if (inBundle && lineCount > 0) return { armed: true, state: "measured" };
  if (inBundle && lineCount === 0) {
    return { armed: false, state: "broken", why: "the artifact carries the frame instrument and this run's log has none of its lines" };
  }
  if (!inBundle && lineCount > 0) {
    return { armed: false, state: "impossible", why: "the log carries frame lines the artifact cannot have written" };
  }
  return { armed: false, state: "absent", why: "this build carries no frame instrument, so start, frame and open latency are unread" };
}

/**
 * What the artifact's own bytes carry, read once: the event, and each arm's field name.
 *
 * Per FIELD and not per instrument, so the half of the vocabulary that has landed arms its own
 * arms and the half that has not stays UNREAD — the reason the instrument arms itself from the
 * build rather than from a flag, applied one name at a time.
 */
export function bundleVocabulary(path) {
  if (!path || !existsSync(path)) return null;
  const bytes = readFileSync(path);
  const fields = {};
  for (const [id, field] of [...Object.entries(UI_VITALS_READS), ...Object.entries(UI_VITALS_DERIVE_READS)]) {
    fields[id] = bytes.includes(field);
  }
  return { event: bytes.includes(UI_VITALS_EVENT), fields };
}

export function bundleCarriesUiVitals(path) {
  return bundleVocabulary(path)?.event ?? null;
}

/** The shell's own "not started" reason out of the log, or null. Bounded, and the last one wins. */
export function engineNotStarted(log) {
  let reason = null;
  for (const line of log.split("\n")) {
    const m = /engine: not started \u2014 (.*)$/.exec(line);
    if (m) reason = m[1].trim().slice(0, 200);
  }
  return reason;
}

/** The budget row a run is held to — messages, seconds, MB — printed before the verdict. */
export function budgetLine({ fixtureMessages, windowS }) {
  const mb = (kb) => Math.round(kb / 1024);
  return `PERF_SMOKE_BUDGET: ${fixtureMessages} messages, ${windowS} s window, ` +
    `renderer peak ${mb(BUDGETS.rendererPeakKb)} MB (goal ${mb(BUDGETS.rendererGoalKb)} MB), engine ${mb(BUDGETS.engineRssKb)} MB`;
}

/* ── THE DERIVATION p95 BUDGET, READ FROM THE TABLE AND NEVER SPELLED HERE ─────────────────────
 *
 * A budget is a number with an origin, never a literal in the check. The renderer and engine
 * ceilings live in the perf budgets table; the derivation p95's millisecond budget lives in that
 * same table's `latency` block. This reads it the way that table is read everywhere — parse the
 * file, walk to the entry, take the number. A ceiling nobody has ruled yet is `null`, not a zero,
 * and comes back as `null`: the arm then prints UNBUDGETED against the goal rather than inventing a
 * red. A table that cannot be read is the same as an unruled ceiling — never a default.
 */
export function readDeriveP95Budget(tablePath) {
  let table;
  try {
    table = JSON.parse(readFileSync(tablePath, "utf8"));
  } catch (err) {
    return { present: false, ceilingMs: null, goalMs: null, origin: null, status: "unreadable", why: String(err && err.message) };
  }
  const b = table?.latency?.["derive-p95"];
  if (!b) return { present: false, ceilingMs: null, goalMs: null, origin: null, status: "absent" };
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  /* `origin` IS THE BUDGET'S ORIGIN AND NOTHING ELSE, and until 2026-09-16 it held the name of the
   * readings instead — a row whose whole open question was that it has no origin as a budget
   * reported one. The budget's origin is `null` while the table says `no-origin-yet`; the GOAL's
   * origin is a separate fact, and the arm prints that one when there is no ceiling. `status` is
   * read from the table's own word (`state`) with the older field taken as a fallback. */
  const state = typeof b.state === "string" ? b.state : b.status;
  const goalReading = b.goalReading && typeof b.goalReading === "object" ? b.goalReading : null;
  return {
    present: true,
    ceilingMs: num(b.ceilingMs),
    goalMs: num(b.goalMs),
    origin: state === "no-origin-yet" ? null : typeof b.origin === "string" ? b.origin : null,
    goalOrigin: goalReading && typeof goalReading.value === "string" ? goalReading.value : null,
    status:
      state === "no-origin-yet"
        ? "unmeasured"
        : typeof state === "string"
          ? state
          : num(b.ceilingMs) === null
            ? "unmeasured"
            : "ruled",
  };
}

/* The table beside this script, resolved from this file's own location. */
export const DEFAULT_BUDGET_TABLE = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "ohmail", "perf-budgets.json");

/* ── THE BOOT'S PHASES, AND WHERE THE WINDOW SAW IT ─────────────────────────────────────────
 * The last `boot_phases` line by field, so a timing red names its phase: each phase over its own
 * p95 in the distribution is marked. Numbers only; nothing else on the line is echoed.
 */
export function bootPhases(log) {
  let line = null;
  for (const l of log.split("\n")) if (l.includes('"event":"boot_phases"')) line = l;
  if (line === null) return null;
  const num = (k) => {
    const m = new RegExp(`"${k}":(-?\\d+)`).exec(line);
    return m ? Number(m[1]) : null;
  };
  const total = num("totalReadyMs");
  const phases = PHASE_FIELDS.map((k) => [k, num(k)]).filter(([, v]) => v !== null);
  const sum = phases.reduce((a, [, v]) => a + v, 0);
  return { total, phases, unattributed: total === null ? null : total - sum };
}

export function phaseNote(bp, timing, judged) {
  const over = [];
  const parts = bp.phases.map(([k, v]) => {
    const short = k.replace(/Ms$/, "");
    const p95 = timing?.phaseP95?.[k];
    if (p95 !== undefined && v > p95) {
      over.push(short);
      return `${short} ${v} (p95 ${p95})`;
    }
    return `${short} ${v}`;
  });
  parts.push(`unattributed ${bp.unattributed}`);
  let note = `phases ms: ${parts.join(" · ")}`;
  if (judged) note += over.length ? ` — over their p95: ${over.join(", ")}` : " — no single phase over its p95";
  return note;
}

/** One timing arm: the reading, its ceiling, and the band's numbers when the band was asked. */
function timingArm(add, id, readingMs, ceilingMs, runnerS, timing, suffix, note, allowance = null) {
  const v = timingVerdict({ readingMs, ceilingMs, runnerS, runnerReferenceS: timing?.runnerReferenceS,
    ...(allowance ? { factor: allowance.factor, factorWhy: allowance.why } : {}) });
  let reading = `${readingMs} ms against ${ceilingMs} ms${suffix}`;
  const by = allowance ? "pglite open" : "build step";
  if (v.status === "CLASSIFY") reading += `, inside the runner band of ${v.bandMs} ms (${by} x${v.factor.toFixed(2)})`;
  if (v.status === "FAIL" && v.why) reading += ` — ${v.why}${v.bandMs ? ` (band ${v.bandMs} ms)` : ""}`;
  add(id, "DECIDES", v.status, reading, typeof note === "function" ? note(v.status !== "PASS") : note);
}

/* ── THE ARMS ─────────────────────────────────────────────────────────────────────────────────
 * A DECIDES arm is one that has been watched failing on a real measurement, and only a DECIDES
 * arm can turn the run red. Everything else is printed, and says on its own line that it is.
 */
export function collect({ samples, log, uiInBundle, uiFields, expectMessages, fixtureMessages, deriveBudget, runnerS = null, storeIdentity = null }) {
  const arms = [];
  const timing = PLATFORM_TIMING.linux_x64;
  const add = (id, kind, status, reading, note) => arms.push({ id, kind, status, reading, note });

  /* An engine that never started imported nothing. Every CI run of this check until 2026-09-24
   * refused "the mailbox never finished importing" over a shell that had logged, in this same
   * file, that the engine was not started — so the fixture's size took the blame for a missing
   * key. The shell's reason names no mailbox and is echoed. */
  const notStarted = engineNotStarted(log);
  if (notStarted !== null) {
    return { refused: `the engine never started, so nothing was imported: ${notStarted}` };
  }

  const rows = parseSamples(samples);
  if (rows.length < MIN_SAMPLES) {
    return { refused: `only ${rows.length} samples, and this check reads no fewer than ${MIN_SAMPLES}` };
  }
  const span = rows[rows.length - 1].epoch - rows[0].epoch;
  if (span < MIN_SPAN_S) {
    return { refused: `the samples span ${span}s, under this check's ${MIN_SPAN_S}s floor — a short window reads a climbing renderer as flat` };
  }
  /* THE RENDERER ITSELF, not the web group: this check's deciding arm is the renderer's peak, and
   * a window in which the renderer was never seen is not a reading of it. Named for what it is —
   * a sampler that saw only the engine and the shell measured the wrong processes, and reading
   * that as a quiet app is how a check reports nothing as success. */
  const rendererSamples = rows.filter((r) => (r.roles.get("renderer") ?? 0) > 0).length;
  if (rendererSamples === 0) {
    const keys = [...new Set(rows.flatMap((r) => [...r.roles.keys()]))].join(", ");
    return {
      refused: `NO RENDERER SAMPLE among ${rows.length} samples — not "no sample"`,
      extra: [`The roles in this file are: ${keys || "<none>"}.`,
        "A sampler keyed on the kernel's truncated process name cannot see the renderer at all."],
    };
  }

  /* The ruled ceiling decides; this check's own goal is printed beside it. A released build read
   * over both, and the released 0.24.0 read under the ceiling and over the goal. */
  const peak = peakOf(rows, webTotal);
  add("renderer_peak", "DECIDES", peak < BUDGETS.rendererPeakKb ? "PASS" : "FAIL",
    `${peak} kB peak against ${BUDGETS.rendererPeakKb} kB`,
    "the perf table's ruled ceiling for a first sync's peak");
  add("renderer_goal", "RECORDED", peak < BUDGETS.rendererGoalKb ? "PASS" : "FAIL",
    `${peak} kB peak against a ${BUDGETS.rendererGoalKb} kB goal`,
    "a renderer bounded by its mail window costs the same at any mailbox size");

  /* A log line that is not there makes its arm UNREAD — printed, deciding nothing. UNREAD is a
   * third state and never a pass, so a run in which nothing decided is refused at the bottom of
   * this function rather than reported as a green with no arms behind it. */
  const boot = bootPhases(log);
  const readyMs = boot?.total ?? null;
  const pgliteMs = boot?.phases.find(([k]) => k === "pgliteOpenMs")?.[1] ?? null;
  const allowance = storeAllowance(pgliteMs, storeIdentity, timing);
  if (readyMs === null) {
    add("engine_ready", "RECORDED", "UNREAD", "<the log carries no boot_phases line>", "");
  } else {
    timingArm(add, "engine_ready", readyMs, BUDGETS.engineReadyMs, runnerS, timing, "",
      (judged) => phaseNote(boot, timing, judged), allowance);
  }
  /* The store's own ceiling, which the runner band never widens. Unasked (no store read) it is
   * printed; a store that was asked and is unread or not the recorded one reddens by name. */
  const pgCeiling = timing.pglite_open.ceilingMs;
  if (pgliteMs === null) {
    add("pglite_open", "RECORDED", "UNREAD", "<the boot line carries no pgliteOpenMs>", "");
  } else if (storeIdentity === null) {
    add("pglite_open", "RECORDED", "READ", `${pgliteMs} ms against ${pgCeiling} ms, the shipped store unread`, "");
  } else {
    const refused = storeRefusal(storeIdentity, timing.store);
    add("pglite_open", "DECIDES", refused === null && pgliteMs <= pgCeiling ? "PASS" : "FAIL",
      refused ?? `${pgliteMs} ms against ${pgCeiling} ms`,
      "the store's own open, never widened by the runner band");
  }

  const rssBytes = lastField(log, "engine_vitals", "rss");
  if (rssBytes === null) {
    add("engine_rss", "DECIDES", "UNREAD", "<the log carries no engine_vitals line>", "");
  } else {
    const { kb: engineKb, why: unitWhy } = engineRssKbFromBytes(rssBytes);
    if (engineKb === null) return { refused: unitWhy };
    add("engine_rss", "DECIDES", engineKb < BUDGETS.engineRssKb ? "PASS" : "FAIL",
      `${engineKb} kB against ${BUDGETS.engineRssKb} kB`, "measured: 450 MB settled at five and twenty-five thousand messages");
  }

  /* The fixture has to have been imported, or every figure above is a reading of an empty app
   * wearing a full mailbox's budget. Read from the engine's own count, never from the fixture. */
  const imported = lastField(log, "first_sync_finished", "messages");
  const importMs = lastField(log, "first_sync_finished", "totalMs");
  if (expectMessages > 0) {
    if (imported === null) {
      return { refused: `the mailbox of ${fixtureMessages} messages never finished importing, so nothing here is a reading of a full mailbox` };
    }
    if (imported < expectMessages) {
      return { refused: `the engine imported ${imported} messages of the ${expectMessages} this run required` };
    }
    add("mailbox", "DECIDES", "PASS", `${imported} messages imported`, "");
    if (importMs && importMs > 0) {
      const rate = Math.round((imported / importMs) * 1000);
      add("sync_rate", "RECORDED", rate >= BUDGETS.syncMsgPerS ? "PASS" : "FAIL",
        `${rate} messages a second against ${BUDGETS.syncMsgPerS}`, "2.3 times a released build's measured 26.0; recorded, with the runner's build step on the verdict line");
    }
  }

  /* The frame and latency half, armed by the artifact rather than by a flag. */
  const uiLines = uiVitalsLines(log);
  const ui = uiVitalsState({ inBundle: uiInBundle === true, lineCount: uiLines.length });
  if (ui.state === "broken" || ui.state === "impossible") {
    add("ui_vitals", "DECIDES", "FAIL", ui.why, "");
  } else if (ui.state === "absent") {
    add("ui_vitals", "RECORDED", "UNREAD", ui.why, "");
  }
  /* All four are printed and `start_to_list` decides, on its measured ceiling above. The open's
   * p95 has no measurement behind it; `longFrames` is a count no ceiling has been measured for; and
   * `longTasks` comes from an observer WebKit does not have, so the Linux desktop writes 0 whether
   * or not a task ran long. A vocabulary drift still reddens every one of them, below. */
  const latency = [
    ["start_to_list", "DECIDES", "worst",
      (v) => `${v} ms against ${BUDGETS.startToListMs} ms (goal ${BUDGETS.startToListGoalMs} ms)`,
      "timing",
      "the window's cold start to a usable list; the ceiling's readings are in the header"],
    ["open_p95", "RECORDED", "worst",
      (v) => `p95 ${v} ms against ${BUDGETS.openP95Ms} ms`, (v) => v <= BUDGETS.openP95Ms,
      "the window computes this p95 over its last hundred opens; the worst report of the run"],
    ["long_frames", "RECORDED", "sum",
      (v) => `${v} frames over ${BUDGETS.frameGapMs} ms`, null,
      "the window counts these at its own threshold, which the census holds equal to this budget"],
    ["long_tasks", "RECORDED", "sum",
      (v) => `${v} tasks over ${BUDGETS.longTaskMs} ms against ${BUDGETS.longTaskMax}`, null,
      "WebKit has no long-task observer, so a 0 here is not a measurement on the Linux desktop"],
  ];
  for (const [id, kind, fold, reading, within, note] of latency) {
    const field = UI_VITALS_READS[id];
    if (!ui.armed) {
      add(id, "RECORDED", "UNREAD", `<no frame instrument in this build>`, "");
      continue;
    }
    if (uiFields && uiFields[id] === false) {
      add(id, "RECORDED", "UNREAD", `<this build carries no "${field}">`, "");
      continue;
    }
    const { keyLines, values } = readUiVitalsField(uiLines, field);
    /* The drift reddens on EVERY arm, printed ones included: a name this check reads and the log
     * does not carry is the defect itself, not a budget question. */
    if (keyLines === 0) {
      add(id, "DECIDES", "FAIL",
        `the window wrote no "${field}" in ${uiLines.length} ui_vitals lines — this log and this check no longer share one vocabulary`, "");
      continue;
    }
    if (values.length === 0) {
      add(id, "RECORDED", "NOT MEASURED", `"${field}" was null in all ${keyLines} of its lines`, note);
      continue;
    }
    const value = fold === "sum" ? values.reduce((a, b) => a + b, 0) : Math.max(...values);
    if (within === "timing") {
      timingArm(add, id, value, BUDGETS.startToListMs, runnerS, timing, ` (goal ${BUDGETS.startToListGoalMs} ms)`, note, allowance);
      continue;
    }
    add(id, kind, within ? (within(value) ? "PASS" : "FAIL") : "READ", reading(value), note);
  }

  /* The window's own marks from its process start, printed beside the engine's phases. */
  if (ui.armed) {
    const marks = [["shellPaintedMs", "shell painted"], ["engineReadyMs", "engine ready"], ["listUsableMs", "list usable"]]
      .map(([f, label]) => [label, readUiVitalsField(uiLines, f).values])
      .filter(([, v]) => v.length > 0)
      .map(([label, v]) => `${label} ${Math.max(...v)}`);
    if (marks.length) add("window_marks", "RECORDED", "READ", `ms from the process start: ${marks.join(" · ")}`, "");
  }

  /* ── THE FOUR DERIVATION FIGURES ─────────────────────────────────────────────────────────────
   * Read off the same `ui_vitals` lines. Only the p95 has a ceiling; the other three are printed.
   * The three silences are the vocabulary's own: a name an OLDER emitter never carried is UNREAD; a
   * name the emitter version DOES carry (its field is in the bundle) that this run's log never wrote
   * is the drift defect — REFUSED by name, because nothing there was measured; a name present but
   * `null` in every window is NOT MEASURED. Evaluated only when there ARE `ui_vitals` lines — the
   * whole-instrument absence is the `ui_vitals` arm's above, not four copies of it here. */
  if (uiLines.length > 0) {
    for (const [id, field] of Object.entries(UI_VITALS_DERIVE_READS)) {
      if (uiFields && uiFields[id] === false) {
        add(id, "RECORDED", "UNREAD", `<this build's emitter carries no "${field}">`, "");
        continue;
      }
      const { keyLines, values } = readUiVitalsField(uiLines, field);
      if (keyLines === 0) {
        if (uiFields && uiFields[id] === true) {
          return { refused: `the window carries "${field}" and wrote it in none of ${uiLines.length} ui_vitals lines — this log and this check no longer share one vocabulary` };
        }
        add(id, "RECORDED", "UNREAD", `<no "${field}" here, and no bundle to say the emitter carries it>`, "");
        continue;
      }
      if (values.length === 0) {
        add(id, "RECORDED", "NOT MEASURED", `"${field}" was null in all ${keyLines} of its lines`, "a window that derived nothing measured no milliseconds");
        continue;
      }
      if (id === "derive_count") {
        add(id, "RECORDED", "READ", `${values.reduce((a, b) => a + b, 0)} derivations`, "how many version bumps paid for the durations beside it");
        continue;
      }
      /* The worst report of the run, as the latency durations are. */
      const value = Math.max(...values);
      if (id !== "derive_p95") {
        add(id, "RECORDED", "READ", `${value} ms`, "");
        continue;
      }
      /* The p95 is budgeted ONLY where the table rules a ceiling; otherwise it is printed against
       * the goal and reddens nothing — the derivation is expected over the one-frame goal until a
       * fix moves it, and the arm says so rather than calling a measured build red. */
      const ceiling = deriveBudget && typeof deriveBudget.ceilingMs === "number" ? deriveBudget.ceilingMs : null;
      if (ceiling !== null) {
        const origin = (deriveBudget && deriveBudget.origin) || "the table";
        add(id, "DECIDES", value <= ceiling ? "PASS" : "FAIL",
          `p95 ${value} ms against ${ceiling} ms (${origin})`, "");
      } else {
        const goal = deriveBudget && typeof deriveBudget.goalMs === "number" ? deriveBudget.goalMs : null;
        add(id, "RECORDED", "UNBUDGETED",
          goal !== null ? `p95 ${value} ms against a ${goal} ms goal, no ruled ceiling` : `p95 ${value} ms, no ruled ceiling`,
          "the derivation p95 has no ruled ceiling yet; the first run under the goal gives it one");
      }
    }
  }

  /* No "every arm was unread" refusal here, and the absence is deliberate: past the sample-shape
   * refusals above, `renderer_peak` always decides, because this check's own sampler is the
   * instrument for it. A guard for a state that cannot be reached is a line nobody can watch
   * fail — the shapes that CAN leave this check saying nothing are the three refusals above. */
  const store = allowance.factor === null
    ? `runner: pglite open unread (${allowance.why})`
    : `runner: pglite open ${pgliteMs} ms against its median ${timing.pgliteReferenceMs} ms (x${allowance.factor.toFixed(2)})`;
  return { arms, runnerLine: `${store} · ${runnerLine(runnerS, timing).replace(/^runner: /, "")}, recorded` };
}

/**
 * The boot alone, for the jobs that start the engine without the app: macOS's packaged engine and
 * Windows' healthy verify boot. The platform's own distribution decides; a platform without
 * enough readings has no ceiling, so its reading is RECORDED and reddens nothing.
 */
export function collectBoot({ log, platform, runnerS = null }) {
  const timing = PLATFORM_TIMING[platform];
  if (!timing) return { refused: `no platform "${platform}"; this check knows ${Object.keys(PLATFORM_TIMING).join(", ")}`, prefix: "PERF_SMOKE_BOOT" };
  const boot = bootPhases(log);
  if (boot === null || boot.total === null) {
    return { refused: "the log carries no boot_phases line, so the boot was not read", prefix: "PERF_SMOKE_BOOT" };
  }
  const arms = [];
  const add = (id, kind, status, reading, note) => arms.push({ id, kind, status, reading, note });
  const c = timing.engine_ready;
  if (c.ceilingMs === null) {
    add("engine_ready", "RECORDED", "READ", `${boot.total} ms on ${platform}, no ceiling yet: ${c.why}`, phaseNote(boot, timing, false));
  } else {
    timingArm(add, "engine_ready", boot.total, c.ceilingMs, runnerS, timing, ` on ${platform}`,
      (judged) => phaseNote(boot, timing, judged));
  }
  return { arms, runnerLine: runnerLine(runnerS, timing), prefix: "PERF_SMOKE_BOOT" };
}

export function render(result) {
  const lines = [];
  const P = result.prefix ?? "PERF_SMOKE";
  const runner = result.runnerLine ? ` · ${result.runnerLine}` : "";
  if (result.refused) {
    lines.push(`${P}: REFUSED -- ${result.refused}`);
    for (const extra of result.extra ?? []) lines.push(`   ${extra}`);
    return { text: lines.join("\n"), code: 3 };
  }
  lines.push("arms:      DECIDES = it can turn this build red; RECORDED = printed, reddens nothing");
  for (const arm of result.arms) {
    lines.push(`  ${arm.id.padEnd(16)} ${arm.kind.padEnd(9)} ${arm.status.padEnd(7)} ${arm.reading}`);
    if (arm.note) lines.push(`  ${" ".repeat(16)} ${arm.note}`);
  }
  const red = result.arms.filter((a) => a.kind === "DECIDES" && a.status === "FAIL").map((a) => a.id);
  const ask = result.arms.filter((a) => a.kind === "DECIDES" && a.status === "CLASSIFY");
  lines.push("");
  if (red.length) {
    lines.push(`${P}: RED -- ${red.join(" ")}${runner}`);
    return { text: lines.join("\n"), code: 1 };
  }
  /* Over a timing ceiling and inside the runner band: a question for a person, never a bare red,
   * and its own code so the step can tell it from both. Memory arms never land here. */
  if (ask.length) {
    lines.push(`${P}: CLASSIFY-ASK RUNNER -- ${ask.map((a) => `${a.id} ${a.reading}`).join("; ")}${runner}`);
    return { text: lines.join("\n"), code: 5 };
  }
  const decided = result.arms.some((a) => a.kind === "DECIDES");
  const peak = result.arms.find((a) => a.id === "renderer_peak");
  const head = peak ? peak.reading : result.arms.map((a) => `${a.id} ${a.reading}`).join("; ");
  lines.push(`${P}: ${decided ? "GREEN" : "RECORDED"} -- ${head}${runner}`);
  return { text: lines.join("\n"), code: 0 };
}

/* ── THE SAMPLER ──────────────────────────────────────────────────────────────────────────────
 * Every process in the app's own tree, classified by its ARGUMENTS. See rule 2 at the top: the
 * kernel's `comm` is truncated at fifteen characters, so classifying by it reads a busy renderer
 * as no renderer. A bare `node` would collect any other Node process on the machine, so the mail
 * engine is identified by its own file name and required to be inside this tree.
 */
export function roleOfArgv(argv, pid, rootPid) {
  /* Ordered, and the order is load-bearing: the engine's own file name contains the app's name,
   * and a launcher that extracts the artifact before running it means the window's process is not
   * always the one this tree was rooted at. */
  if (argv.includes("WebKitWebProcess")) return "renderer";
  if (argv.includes("WebKitGPUProcess")) return "gpu";
  if (argv.includes("WebKitNetworkProcess")) return "net";
  if (argv.includes("ohmail-engine.mjs")) return "engine";
  if (pid === rootPid || argv.includes("ohmail")) return "shell";
  return null;
}

function procRead(root, pid, name) {
  try {
    return readFileSync(join(root, String(pid), name), "utf8");
  } catch {
    return null;
  }
}

export function parseVmRssKb(status) {
  for (const line of status.split("\n")) {
    if (!line.startsWith("VmRSS:")) continue;
    const parts = line.slice(6).trim().split(/\s+/);
    // The unit is stated by the kernel and asserted rather than assumed.
    if (parts[1] !== "kB") return null;
    const kb = Number(parts[0]);
    return Number.isFinite(kb) ? kb : null;
  }
  return null;
}

export function treeOf(procRoot, rootPid) {
  const parent = new Map();
  const pids = [];
  for (const entry of readdirSync(procRoot)) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const stat = procRead(procRoot, pid, "stat");
    if (!stat) continue;
    const close = stat.lastIndexOf(")");
    if (close < 0) continue;
    const after = stat.slice(close + 1).trim().split(/\s+/);
    parent.set(pid, Number(after[1]));
    pids.push(pid);
  }
  const inTree = new Set([rootPid]);
  // Repeated until it settles rather than recursed: /proc is unordered, so a child can be read
  // before its parent is known.
  for (let pass = 0; pass < 12; pass++) {
    let grew = false;
    for (const pid of pids) {
      if (inTree.has(pid)) continue;
      if (inTree.has(parent.get(pid))) { inTree.add(pid); grew = true; }
    }
    if (!grew) break;
  }
  return inTree;
}

export function sampleOnce(procRoot, rootPid, now) {
  const roles = new Map();
  let total = 0;
  for (const pid of treeOf(procRoot, rootPid)) {
    const cmdline = procRead(procRoot, pid, "cmdline");
    if (cmdline === null) continue;
    const role = roleOfArgv(cmdline.replace(/\0/g, " "), pid, rootPid);
    if (!role) continue;
    const status = procRead(procRoot, pid, "status");
    const kb = status ? parseVmRssKb(status) : null;
    if (kb === null) continue;
    roles.set(role, (roles.get(role) ?? 0) + kb);
    total += kb;
  }
  const cells = [...roles.entries()].sort().map(([k, v]) => `${k}=${v}`);
  return `${now}\t${total}\t${cells.join("\t")}\tgrpswap=0`;
}

/* ── THE SELFTEST ─────────────────────────────────────────────────────────────────────────────
 * `--perf-smoke-only` runs the verdict over two samples built here: one shaped like a released
 * build that was measured going wrong, and one shaped like a build inside its budgets. A check
 * nobody has watched refuse is not a check, and this is the arm that proves it refuses.
 */
export function releasedShapeSample() {
  // The released build's own curve, rounded: a renderer climbing past a gigabyte while the engine
  // sits where it is expected to. Twenty samples, thirty seconds apart.
  const lines = [];
  for (let i = 0; i < 20; i++) {
    const renderer = 490000 + i * 53000;
    lines.push(`${1789160000 + i * 30}\t${renderer + 380000}\tengine=670000\tnet=86604\trenderer=${renderer}\tshell=385776\tgrpswap=0`);
  }
  return lines.join("\n");
}

export function withinBudgetSample() {
  const lines = [];
  for (let i = 0; i < 20; i++) {
    const renderer = 210000 + (i % 4) * 3000;
    lines.push(`${1789160000 + i * 30}\t${renderer + 300000}\tengine=300000\tnet=40000\trenderer=${renderer}\tshell=190000\tgrpswap=0`);
  }
  return lines.join("\n");
}

export const SAMPLE_LOG_OK = [
  '{"service":"sidecar","event":"boot_phases","pgliteOpenMs":120,"migrateMs":40,"totalReadyMs":1850}',
  '{"service":"sidecar","event":"engine_vitals","rss":314572800,"heapUsed":80000000,"memoryReading":"process","storeBytes":9000000,"uptimeMs":60000}',
  '{"service":"sidecar","event":"first_sync_finished","messages":10000,"totalMs":140000}',
].join("\n");

export const SAMPLE_LOG_SLOW = [
  '{"service":"sidecar","event":"boot_phases","pgliteOpenMs":900,"migrateMs":400,"totalReadyMs":9400}',
  '{"service":"sidecar","event":"engine_vitals","rss":700448768,"heapUsed":90000000,"memoryReading":"process","storeBytes":200000000,"uptimeMs":300000}',
  '{"service":"sidecar","event":"first_sync_finished","messages":10000,"totalMs":600000}',
].join("\n");

/* The runner-band arms: a normal run, a slow runner, and a product regression on a normal runner,
 * each built from the ok log with only the boot line's total moved. */
export function bootLog(totalReadyMs, pgliteOpenMs = 120) {
  return SAMPLE_LOG_OK.replace('"totalReadyMs":1850', `"totalReadyMs":${totalReadyMs}`)
    .replace('"pgliteOpenMs":120', `"pgliteOpenMs":${pgliteOpenMs}`);
}

/* A recorded Linux reading (a TIMING_READINGS row) as the log the smoke reads: its boot line and
 * its window's list mark, so the ruled controls run on real numbers. */
export function recordedLog(run, attempt) {
  const t = TIMING_READINGS.linux_x64;
  const row = [...t.rows, ...t.laterRows].find((r) => r[0] === run && r[1] === attempt);
  if (!row) throw new Error(`no recorded Linux reading for run ${run} attempt ${attempt}`);
  const v = (name) => row[t.columns.indexOf(name)];
  const boot = `{"service":"sidecar","event":"boot_phases","pgliteOpenMs":${v("pgliteOpenMs")},"adoptBaselineMs":${v("adoptBaselineMs")},"migrateMs":${v("migrateMs")},"searchSetupMs":${v("searchSetupMs")},"totalReadyMs":${v("totalReadyMs")}}`;
  const ui = `{"service":"ui","event":"ui_vitals","listUsableMs":${v("listUsableMs")},"openP95Ms":null,"longFrames":0,"longTasks":0,"deriveMs":null,"deriveP50Ms":null,"deriveP95Ms":null,"deriveCount":0}`;
  return { log: SAMPLE_LOG_OK.replace(/^.*"boot_phases".*$/m, boot) + `\n${ui}`, runnerS: v("buildStepS"), row: Object.fromEntries(t.columns.map((c, i) => [c, row[i]])) };
}

export function selftest(write) {
  const linux = PLATFORM_TIMING.linux_x64;
  const pg = linux.pgliteReferenceMs;
  const ceiling = BUDGETS.engineReadyMs;
  const bands = [
    ["a normal run on a median runner", bootLog(ceiling - 500, pg), linux.store, 0],
    ["a slow runner over the ceiling", bootLog(ceiling + 300, Math.round(pg * 1.2)), linux.store, 5],
    ["a product regression, median runner", bootLog(ceiling * 2, pg), linux.store, 1],
    ["a product regression, slow runner", bootLog(ceiling * 2, Math.round(pg * 1.2)), linux.store, 1],
    ["over the ceiling, store unread", bootLog(ceiling + 300, Math.round(pg * 1.2)), null, 1],
    ["over the ceiling, another pglite", bootLog(ceiling + 300, Math.round(pg * 1.2)), { ...linux.store, pglite: "0.3.0" }, 1],
    ["a slower store open of our own", bootLog(ceiling + 300, linux.pglite_open.ceilingMs + 400), linux.store, 1],
  ];
  /* The ruled controls over recorded readings: 0.25.7's first red (run 241/1) and 0.25.11 (245/1). */
  const recorded = [["run 241/1, the 0.25.7 red", 241, 1, 5], ["run 245/1, 0.25.11", 245, 1, 0]];
  const cases = [
    ["a released build's own shape", releasedShapeSample(), SAMPLE_LOG_SLOW, 1],
    ["a build inside its budgets", withinBudgetSample(), SAMPLE_LOG_OK, 0],
    ["a window too short to read", withinBudgetSample().split("\n").slice(0, 4).join("\n"), SAMPLE_LOG_OK, 3],
    /* The comm-truncation shape: every WebKit process missing at once, because that is how the
       failure arrives — a name list of the full spellings matches none of the truncated names. */
    ["a sampler that saw no renderer", withinBudgetSample().replace(/\trenderer=\d+/g, "").replace(/\tnet=\d+/g, ""), SAMPLE_LOG_OK, 3],
  ];
  let bad = 0;
  const judge = (name, out, want, prefix) => {
    const verdict = out.text.split("\n").filter((l) => l.startsWith(`${prefix}:`)).pop() ?? "<none>";
    const ok = out.code === want;
    if (!ok) bad++;
    write(`${ok ? "  ok  " : "  BAD "} ${name.padEnd(36)} rc ${out.code} (wanted ${want})  ${verdict}\n`);
  };
  for (const [name, samples, log, want] of cases) {
    judge(name, render(collect({ samples, log, uiInBundle: false, expectMessages: 10000, fixtureMessages: 10000 })), want, "PERF_SMOKE");
  }
  for (const [name, log, storeIdentity, want] of bands) {
    judge(name, render(collect({ samples: withinBudgetSample(), log, uiInBundle: false, expectMessages: 10000, fixtureMessages: 10000, runnerS: linux.runnerReferenceS, storeIdentity })), want, "PERF_SMOKE");
  }
  for (const [name, run, attempt, want] of recorded) {
    const r = recordedLog(run, attempt);
    judge(name, render(collect({ samples: withinBudgetSample(), log: r.log, uiInBundle: true, expectMessages: 10000, fixtureMessages: 10000, runnerS: r.runnerS, storeIdentity: linux.store })), want, "PERF_SMOKE");
  }
  const mac = PLATFORM_TIMING.macos;
  judge("macOS boot inside its ceiling", render(collectBoot({ log: bootLog(mac.engine_ready.ceilingMs - 100), platform: "macos", runnerS: mac.runnerReferenceS })), 0, "PERF_SMOKE_BOOT");
  judge("macOS boot regression", render(collectBoot({ log: bootLog(mac.engine_ready.ceilingMs * 2), platform: "macos", runnerS: mac.runnerReferenceS })), 1, "PERF_SMOKE_BOOT");
  judge("Windows boot, no distribution yet", render(collectBoot({ log: bootLog(9000), platform: "windows", runnerS: null })), 0, "PERF_SMOKE_BOOT");
  const total = cases.length + bands.length + recorded.length + 3;
  write(bad === 0
    ? "\nPERF_SMOKE_SELFTEST: GREEN -- every arm refuses the shape it exists for and admits the other\n"
    : `\nPERF_SMOKE_SELFTEST: RED -- ${bad} of ${total} cases answered wrongly\n`);
  return bad === 0 ? 0 : 1;
}

/* Through realpath: `import.meta.url` is the resolved file, so a checker reached through a
 * symlink compared unequal, ran nothing and exited 0 — a green with no verdict behind it. */
const RUN_AS_SCRIPT = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (RUN_AS_SCRIPT) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : dflt;
  };

  if (args.includes("--perf-smoke-only")) {
    process.exit(selftest((s) => process.stdout.write(s)));
  }

  /* An empty or absent `--runner-s` is an unread runner, never a zero. */
  const runnerArg = opt("runner-s", "");
  const runnerS = /^\d+$/.test(runnerArg ?? "") && Number(runnerArg) > 0 ? Number(runnerArg) : null;

  if (args.includes("--boot")) {
    const logPath = opt("engine-log", null);
    const platform = opt("platform", null);
    if (!logPath || !platform) {
      process.stderr.write("usage: perf-smoke-check.mjs --boot --platform <id> --engine-log <log> [--runner-s <n>]\n");
      process.exit(2);
    }
    if (!existsSync(logPath)) {
      process.stdout.write(`PERF_SMOKE_BOOT: REFUSED -- the engine wrote no log at ${logPath}\n`);
      process.exit(3);
    }
    const { text, code } = render(collectBoot({ log: readFileSync(logPath, "utf8"), platform, runnerS }));
    process.stdout.write(`${text}\n`);
    process.exit(code);
  }

  if (args.includes("--sample")) {
    const pid = Number(opt("pid", "0"));
    const out = opt("out", null);
    const seconds = Number(opt("seconds", "180"));
    const interval = Number(opt("interval", "10"));
    if (!pid || !out) {
      process.stderr.write("--sample needs --pid and --out\n");
      process.exit(2);
    }
    writeFileSync(out, "");
    const deadline = Date.now() + seconds * 1000;
    const tick = () => {
      if (!existsSync(join("/proc", String(pid)))) return finish();
      appendFileSync(out, `${sampleOnce("/proc", pid, Math.floor(Date.now() / 1000))}\n`);
      if (Date.now() >= deadline) return finish();
      setTimeout(tick, interval * 1000);
    };
    const finish = () => {
      const n = readFileSync(out, "utf8").split("\n").filter((l) => l.trim()).length;
      process.stdout.write(`sampled ${n} times into ${out}\n`);
    };
    tick();
  } else {
    const samplesPath = opt("samples", null);
    const logPath = opt("engine-log", null);
    if (!samplesPath || !logPath) {
      process.stderr.write("usage: perf-smoke-check.mjs --samples <tsv> --engine-log <log> [--bundle <file>]\n");
      process.exit(2);
    }
    const expect = Number(opt("expect-messages", "0"));
    const fixture = Number(opt("fixture-messages", String(expect)));
    const windowS = opt("window-s", null);
    if (windowS !== null) process.stdout.write(`${budgetLine({ fixtureMessages: fixture, windowS: Number(windowS) })}\n`);
    if (!existsSync(samplesPath)) {
      process.stdout.write(`PERF_SMOKE: REFUSED -- no sample file at ${samplesPath}; nothing was sampled\n`);
      process.exit(3);
    }
    if (!existsSync(logPath)) {
      process.stdout.write(`PERF_SMOKE: REFUSED -- the app wrote no log at ${logPath}\n`);
      process.exit(3);
    }
    const vocabulary = bundleVocabulary(opt("bundle", null));
    /* The shipped engine beside the AppImage's binary (usr/bin -> usr/lib/ohmail/engine/bin), or
     * --engine-dir; with neither, the store is unasked and its open time widens nothing. */
    const bundleArg = opt("bundle", null);
    const engineDir = opt("engine-dir", null) ?? (bundleArg ? join(dirname(bundleArg), "..", "lib", "ohmail", "engine", "bin") : null);
    const storeIdentity = engineDir === null ? null : readStoreIdentity(engineDir);
    const deriveBudget = readDeriveP95Budget(opt("budget-table", DEFAULT_BUDGET_TABLE));
    const { text, code } = render(collect({
      samples: readFileSync(samplesPath, "utf8"),
      log: readFileSync(logPath, "utf8"),
      uiInBundle: vocabulary?.event ?? null,
      uiFields: vocabulary?.fields ?? null,
      expectMessages: expect,
      fixtureMessages: fixture,
      deriveBudget,
      runnerS,
      storeIdentity,
    }));
    process.stdout.write(`${text}\n`);
    process.exit(code);
  }
}
