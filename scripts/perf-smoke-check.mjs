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
 *                        [--expect-messages <n>] [--fixture-messages <n>]
 *   perf-smoke-check.mjs --sample --pid <pid> --out <tsv> --seconds <n> [--interval <s>]
 *   perf-smoke-check.mjs --perf-smoke-only   the selftest: every arm watched failing and admitting
 *
 * verdict: PERF_SMOKE: GREEN rc 0 - RED rc 1 - REFUSED rc 3.
 */
import { readFileSync, readdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/* ── THE BUDGETS, EACH WITH WHAT IT CAME FROM ─────────────────────────────────────────────────
 *
 * A budget is a number with an origin. A number invented in advance would have every later
 * reading judged against the invention instead of against the product, so each line below says
 * where it comes from and the two that nothing has measured yet say so and redden nothing.
 */
export const BUDGETS = {
  /* The renderer group — the webview's own processes — on a ten-thousand-message mailbox.
   *
   * THE DERIVATION, because 400 MB is not a tenth of anything. The renderer's steady ceiling on a
   * mailbox seven times this size is 600 MB, with 400 MB as the goal; that ceiling is reachable
   * only if the renderer is bounded by the window of mail it is showing rather than by the size
   * of the mailbox behind it. If it is so bounded, ten thousand messages and seventy-five
   * thousand cost the SAME, and a build already over the larger mailbox's goal at this size is a
   * regression in the bound by any reading. If it is not so bounded, this reddens — which is the
   * defect, not a false alarm. Scaling the ceiling down with the message count would assume the
   * opposite of what the budget is for. */
  rendererPeakKb: 400 * 1024,
  /* The mail engine, steady. Measured: 378.8 MB settled on an empty install, and 450 MB settled
   * with five and twenty-five thousand messages. */
  engineRssKb: 450 * 1024,
  /* The engine's own boot, from its `boot_phases.totalReadyMs`. NO MEASUREMENT BEHIND IT YET. */
  engineReadyMs: 4000,
  /* The first import, from `first_sync_finished`. The released build's own line read 33.1 messages
   * a second because its clock began at the END of the drain that found the import open; measured
   * end to end the same mailbox arrived at 24.1, and the reference rig reads 26.0. So this is 2.3
   * times a released build, and it is read only when the import finished inside the run — against
   * a `totalMs` that now covers the drain that found the import open. */
  syncMsgPerS: 60,
  /* Everything below is read from `ui_vitals` and has NO MEASUREMENT BEHIND IT YET. */
  startToListMs: 2000,
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
  for (const [id, field] of Object.entries(UI_VITALS_READS)) fields[id] = bytes.includes(field);
  return { event: bytes.includes(UI_VITALS_EVENT), fields };
}

export function bundleCarriesUiVitals(path) {
  return bundleVocabulary(path)?.event ?? null;
}

/* ── THE ARMS ─────────────────────────────────────────────────────────────────────────────────
 * A DECIDES arm is one that has been watched failing on a real measurement, and only a DECIDES
 * arm can turn the run red. Everything else is printed, and says on its own line that it is.
 */
export function collect({ samples, log, uiInBundle, uiFields, expectMessages, fixtureMessages }) {
  const arms = [];
  const add = (id, kind, status, reading, note) => arms.push({ id, kind, status, reading, note });

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

  /* The one arm with a real measurement behind it on both sides: a released build read far over
   * this line, and a build bounded by its mail window reads far under it. */
  const peak = peakOf(rows, webTotal);
  add("renderer_peak", "DECIDES", peak < BUDGETS.rendererPeakKb ? "PASS" : "FAIL",
    `${peak} kB peak against ${BUDGETS.rendererPeakKb} kB`,
    "the ceiling for a mailbox seven times this size is 600 MB with a 400 MB goal; a renderer bounded by its window costs the same at either size");

  /* A log line that is not there makes its arm UNREAD — printed, deciding nothing. UNREAD is a
   * third state and never a pass, so a run in which nothing decided is refused at the bottom of
   * this function rather than reported as a green with no arms behind it. */
  const readyMs = lastField(log, "boot_phases", "totalReadyMs");
  if (readyMs === null) {
    add("engine_ready", "DECIDES", "UNREAD", "<the log carries no boot_phases line>", "");
  } else {
    add("engine_ready", "DECIDES", readyMs <= BUDGETS.engineReadyMs ? "PASS" : "FAIL",
      `${readyMs} ms against ${BUDGETS.engineReadyMs} ms`, "no measurement behind the budget yet; the reading is real");
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
        `${rate} messages a second against ${BUDGETS.syncMsgPerS}`, "2.3 times a released build's measured 26.0; recorded while the runner's own speed is unmeasured");
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
  /* Two of these four DECIDE and two are printed, and which is which is a fact about what the
   * window can answer rather than a preference. `longFrames` is a COUNT the window took at its
   * own threshold and no ceiling for that count has been measured, so a budget here would be an
   * invented number. `longTasks` comes from an observer WebKit does not have, so the Linux
   * desktop — the one platform this check runs on — writes 0 whether or not a task ran long, and
   * an arm that cannot fail where it runs is an arm nobody can watch fail. */
  const latency = [
    ["start_to_list", "DECIDES", "worst",
      (v) => `${v} ms against ${BUDGETS.startToListMs} ms`, (v) => v <= BUDGETS.startToListMs,
      "the window's own cold start to a usable list; no measurement behind the budget yet"],
    ["open_p95", "DECIDES", "worst",
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
    add(id, kind, within ? (within(value) ? "PASS" : "FAIL") : "READ", reading(value), note);
  }

  /* No "every arm was unread" refusal here, and the absence is deliberate: past the sample-shape
   * refusals above, `renderer_peak` always decides, because this check's own sampler is the
   * instrument for it. A guard for a state that cannot be reached is a line nobody can watch
   * fail — the shapes that CAN leave this check saying nothing are the three refusals above. */
  return { arms };
}

export function render(result) {
  const lines = [];
  if (result.refused) {
    lines.push(`PERF_SMOKE: REFUSED -- ${result.refused}`);
    for (const extra of result.extra ?? []) lines.push(`   ${extra}`);
    return { text: lines.join("\n"), code: 3 };
  }
  lines.push("arms:      DECIDES = it can turn this build red; RECORDED = printed, reddens nothing");
  for (const arm of result.arms) {
    lines.push(`  ${arm.id.padEnd(16)} ${arm.kind.padEnd(9)} ${arm.status.padEnd(7)} ${arm.reading}`);
    if (arm.note) lines.push(`  ${" ".repeat(16)} ${arm.note}`);
  }
  const red = result.arms.filter((a) => a.kind === "DECIDES" && a.status === "FAIL").map((a) => a.id);
  lines.push("");
  if (red.length) {
    lines.push(`PERF_SMOKE: RED -- ${red.join(" ")}`);
    return { text: lines.join("\n"), code: 1 };
  }
  const peak = result.arms.find((a) => a.id === "renderer_peak");
  lines.push(`PERF_SMOKE: GREEN -- ${peak ? peak.reading : "every arm within budget"}`);
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

export function selftest(write) {
  const cases = [
    ["a released build's own shape", releasedShapeSample(), SAMPLE_LOG_SLOW, 1],
    ["a build inside its budgets", withinBudgetSample(), SAMPLE_LOG_OK, 0],
    ["a window too short to read", withinBudgetSample().split("\n").slice(0, 4).join("\n"), SAMPLE_LOG_OK, 3],
    /* The comm-truncation shape: every WebKit process missing at once, because that is how the
       failure arrives — a name list of the full spellings matches none of the truncated names. */
    ["a sampler that saw no renderer", withinBudgetSample().replace(/\trenderer=\d+/g, "").replace(/\tnet=\d+/g, ""), SAMPLE_LOG_OK, 3],
  ];
  let bad = 0;
  for (const [name, samples, log, want] of cases) {
    const { text, code } = render(collect({ samples, log, uiInBundle: false, expectMessages: 10000, fixtureMessages: 10000 }));
    const verdict = text.split("\n").filter((l) => l.startsWith("PERF_SMOKE:")).pop() ?? "<none>";
    const ok = code === want;
    if (!ok) bad++;
    write(`${ok ? "  ok  " : "  BAD "} ${name.padEnd(32)} rc ${code} (wanted ${want})  ${verdict}\n`);
  }
  write(bad === 0
    ? "\nPERF_SMOKE_SELFTEST: GREEN -- every arm refuses the shape it exists for and admits the other\n"
    : `\nPERF_SMOKE_SELFTEST: RED -- ${bad} of ${cases.length} cases answered wrongly\n`);
  return bad === 0 ? 0 : 1;
}

const RUN_AS_SCRIPT = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (RUN_AS_SCRIPT) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : dflt;
  };

  if (args.includes("--perf-smoke-only")) {
    process.exit(selftest((s) => process.stdout.write(s)));
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
    if (!existsSync(samplesPath)) {
      process.stdout.write(`PERF_SMOKE: REFUSED -- no sample file at ${samplesPath}; nothing was sampled\n`);
      process.exit(3);
    }
    if (!existsSync(logPath)) {
      process.stdout.write(`PERF_SMOKE: REFUSED -- the app wrote no log at ${logPath}\n`);
      process.exit(3);
    }
    const expect = Number(opt("expect-messages", "0"));
    const fixture = Number(opt("fixture-messages", String(expect)));
    const vocabulary = bundleVocabulary(opt("bundle", null));
    const { text, code } = render(collect({
      samples: readFileSync(samplesPath, "utf8"),
      log: readFileSync(logPath, "utf8"),
      uiInBundle: vocabulary?.event ?? null,
      uiFields: vocabulary?.fields ?? null,
      expectMessages: expect,
      fixtureMessages: fixture,
    }));
    process.stdout.write(`${text}\n`);
    process.exit(code);
  }
}
