/**
 * the operator CLIs must not throw away the line that says why they failed.
 *
 * ── THE MECHANISM, MEASURED RATHER THAN SUSPECTED ────────────────────────────────────────
 *
 * `console.log`/`console.error` QUEUE when the destination is a pipe: the kernel takes what
 * fits in the pipe buffer (64 KiB here) and libuv holds the rest. `process.exit()` does not
 * drain that queue — it discards it. On this platform:
 *
 *     node -e 'console.log("x".repeat(120000)); process.exit(0)' | wc -c   →  65536
 *     node -e 'console.log("x".repeat(120000)); process.exitCode=0'  | wc -c   → 120001
 *
 * On a terminal the writes are effectively synchronous, so nobody has ever seen this. On a pipe
 * the line lost is the one explaining the failure, during a cutover — which is the stake. But it
 * bites only while that pipe is still NON-BLOCKING, and `pnpm db:setup:prod 2>&1 | tee
 * cutover.log` as spelled today is NOT: `tsx` clears the flag on its way past. That is measured
 * below, under ESBUILD_WORKER_THREADS, and it is why this file has to switch the masking off
 * before it can see the defect at all. The fix stays load-bearing everywhere this code runs
 * without esbuild in front of it.
 *
 * ── WHY THIS SPAWNS THE REAL SCRIPTS ─────────────────────────────────────────────────────
 *
 * The defect is not in a function; it is in what the module body does after the function
 * returns. Nothing importable can carry it, so the only honest test runs the entry point the
 * operator runs, through a real pipe, and counts what came out. `TF_PROD_DB_HOST` is the lever:
 * `assertExpectedHost` names BOTH hosts in its refusal, so a long pin produces a
 * failure line six times the pipe buffer, on a path that throws BEFORE any
 * connection is opened, so this needs no database and makes no request.
 *
 * The size is not arbitrary. Truncation is a race with the reader: at a smaller size the reader
 * sometimes wins and the whole line arrives even with a bare `process.exit` (observed 1 run in
 * 4). At this size the bare-exit shape truncated in every one of 8 runs and
 * never once delivered the line. So a bare `process.exit` cannot pass this by luck.
 *
 * ── WHAT THIS FILE DOES NOT COVER, SAID PLAINLY ──────────────────────────────────────────
 *
 * The hosted-storage lockdown script is fixed the same way but has no behavioural case here: with no
 * database reachable its entire output is under 200 bytes, which the pipe buffer swallows
 * whole, and its one large line (a connection error naming the host) is followed by several
 * `await`s that drain it before the exit. Its guard is the structural one at the bottom of this
 * file. Losing its verdict needs a CONGESTED consumer — a slow `tee` — which this harness
 * cannot create.
 *
 * ── HOW THE PIN REACHES THE CLI, AND WHY NOT THROUGH `spawn`'s env ───────────────────────
 *
 * Linux caps a SINGLE argv/env string at MAX_ARG_STRLEN = 32 pages (measured on
 * this machine: a string just under it execs, one a few bytes longer fails as too long). The
 * pin, past it, therefore cannot cross ANY execve boundary — passing it in `spawn`'s `env`
 * fails at spawn with argument-list-too-long before `/bin/sh` even starts, which is how this file spent its life
 * on Linux never once running its two behavioural cases: a guard that cannot run guards nothing.
 * Shrinking the pin to fit is not an option — that is the size band where the header
 * above measured the reader sometimes winning the race, i.e. where a bare `process.exit` can
 * pass by luck. And the CLIs read the pin from `process.env` only, so stdin and argv would test
 * a delivery no operator has.
 *
 * So the pin travels as a FILE: this file writes it to a temp file, hands the child the file's
 * short PATH in `TF_PROD_DB_HOST_FILE`, and a `--import` preamble (`cli-exit-drain.host-pin.mjs`)
 * installs it in the CLI process's view of the environment before the CLI module's body runs.
 * **Not into the real environment block** — writing it there just moves the same too-long failure one level
 * down, onto the `esbuild` service process `tsx` spawns to transform the CLI, which then dies
 * with a `TransformError` at spawn before the CLI prints anything. The preamble's header has
 * the mechanism and the measurement.
 *
 * Everything the drain fix is about is untouched: the CLI reads `process.env.TF_PROD_DB_HOST` exactly as it
 * does when an operator exports it, composes its own refusal line, writes it into a real kernel
 * pipe, and exits by returning a code.
 *
 * ── WHY THE CHILD RUNS WITH `ESBUILD_WORKER_THREADS=0` ───────────────────────────────────
 *
 * Because without it this file is green whatever the CLIs do, and that was measured here, not
 * feared: with `process.exitCode` mutated back to `process.exit` in both CLIs, both behavioural
 * cases below still PASSED and delivered every byte.
 *
 * The queueing this file is about only happens on a NON-BLOCKING fd. Node clears `O_NONBLOCK`
 * from a pipe it is asked to inherit, and the flag lives on the file description, so clearing it
 * in a child clears it for the parent too — permanently, and for `2>&1` on both fds at once.
 * `tsx` transforms the CLI with `esbuild`, whose long-lived service process is spawned
 * `stdio: ["pipe", "pipe", "inherit"]` (`esbuild/lib/main.js`), so by the time the CLI's module
 * body runs, the pipe carrying its output is BLOCKING, every `console.error` completes
 * synchronously, and `process.exit` has nothing left to throw away. Measured on this machine:
 *
 *     /proc/self/fdinfo/2 flags 02004001 (O_NONBLOCK) → the long line truncates to a pipe's worth
 *     /proc/self/fdinfo/2 flags 02000001             → the same line arrives whole
 *
 * `ESBUILD_WORKER_THREADS=0` moves esbuild off that path onto `execFileSync`, which passes its
 * input as a buffer and inherits nothing, so the pipe keeps the semantics the operator's shell
 * gave it. The property under test belongs to the program — set a code, return, let the write
 * finish — not to a side effect of whichever loader happens to start it, and every consumer that
 * runs this code COMPILED (the crons a cron fix covered, the Vercel functions) has no esbuild in front of
 * it at all. Do not drop the variable to tidy the harness; `cli-exit-drain.bare-exit-probe.ts`
 * exists to go red if somebody does.
 *
 * THE LEVER HAS A REACH, and it is worth knowing before debugging a red: it works through
 * esbuild's SYNCHRONOUS transform path, which is the one `tsx` takes when Node offers
 * synchronous module hooks — Node >= 22.22.3 for tsx 4.23. On an older Node 22, tsx transforms
 * through async hooks and esbuild's async service is spawned with stderr inherited whatever this
 * variable says, so the masking returns and the control case below is the thing that fails. That
 * is the designed direction: the file goes red saying the harness cannot see the defect, rather
 * than green saying the CLIs are fine.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DB_DIR = fileURLToPath(new URL("..", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
/** As a file: URL, so a checkout path needing percent-encoding cannot break the `--import`. */
const PIN_SHIM = new URL("./cli-exit-drain.host-pin.mjs", import.meta.url).href;

/** Six times the 64 KiB pipe buffer — see the header for why a smaller pad is not enough. */
const PAD = "h".repeat(400_000);
/** Parseable, not a pooler, and never connected to: the host guard throws first. */
const URL_SESSION = "postgres://u:p@localhost:5432/db";

/** The pin's carrier — see "HOW THE PIN REACHES THE CLI" in the header. */
let pinDir: string;
let pinFile: string;
beforeAll(() => {
  pinDir = mkdtempSync(join(tmpdir(), "s45-host-pin-"));
  pinFile = join(pinDir, "host-pin");
  writeFileSync(pinFile, PAD);
});
afterAll(() => {
  rmSync(pinDir, { recursive: true, force: true });
});

interface Ran { code: string | null; out: string }

/**
 * The marker the SHELL prints after the CLI has exited. `| cat` makes the CLI's exit status
 * unreadable from `child.on("close")`, so the status is carried in the stream instead — and it
 * doubles as the terminator that proves the CLI's own last line was complete.
 */
const EXIT_MARK = "___EXIT=";

/**
 * Run an entry point the way an operator does — `tsx <path> 2>&1 | …` — through a REAL PIPE,
 * with two deliberate differences from an operator's shell, both forced and both documented in
 * the header: the pin arrives through a `--import` preamble because no environment block can
 * carry it, and `ESBUILD_WORKER_THREADS=0` keeps the loader's own subprocess from taking the
 * pipe out of non-blocking mode, which is the only state in which the defect exists.
 *
 * THE `| cat` IS THE TEST, and this is the correction that made this file a guard rather than
 * decoration. Spawning node directly from node gives the child a **socketpair**, not a pipe
 * (that is how libuv implements `stdio: "pipe"` on Unix), and a socketpair has different
 * buffering: the first version of this file spawned directly and passed with a bare
 * `process.exit` restored — the mutation came back GREEN once and red the next run, i.e. the
 * assertion was measuring scheduling, not the defect. Under `/bin/sh -c '… | cat'` the CLI
 * writes into a kernel pipe with a 64 KiB buffer, which is the thing the drain fix is about, and the
 * bare-exit shape truncates at exactly 65536 every time.
 */
function run(entry: string, env: NodeJS.ProcessEnv): Promise<Ran> {
  const cmd =
    `{ "${process.execPath}" --conditions=ohmail-source --import tsx/esm --import "${PIN_SHIM}" "${entry}" 2>&1; ` +
    `echo "${EXIT_MARK}$?"; } | cat`;
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: DB_DIR,
      // LAST, so no case can drop it by accident: it is what keeps the pipe non-blocking, and
      // therefore what makes every assertion below capable of failing. See the header.
      env: { ...process.env, ...env, ESBUILD_WORKER_THREADS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => { out += c; });
    child.stderr.on("data", (c: string) => { out += c; });
    child.on("error", reject);
    child.on("close", () => {
      const m = /___EXIT=(\d+)/.exec(out);
      resolve({ code: m ? m[1]! : null, out });
    });
  });
}

describe("a piped operator CLI keeps its last line", () => {
  it("db:mailboxes:dedup delivers the whole refusal, and still exits 1", async () => {
    const { code, out } = await run("src/mailbox-dedup-cli.ts", {
      DATABASE_URL_SESSION: URL_SESSION,
      TF_PROD_DB_HOST_FILE: pinFile,
    });
    // The WHOLE pin, not a prefix of it: a truncated write cuts the tail of this run.
    expect(out).toContain(PAD);
    expect(out).toContain("[db:mailboxes:dedup] FAILED:");
    // …and the line was TERMINATED before the process left: the closing quote, its newline,
    // and only then the shell's marker.
    expect(out.endsWith(`'\n${EXIT_MARK}1\n`)).toBe(true);
    // The fix must not change what the shell sees.
    expect(code).toBe("1");
  }, 60_000);

  it("db:setup:prod delivers the whole refusal, and still exits 1", async () => {
    // `setup-prod-cli.ts`, not `setup-prod.ts`: the executable half was split out so that
    // nothing re-exporting the library could carry a run-directly guard into a bundle. The
    // behaviour under test is unchanged and still belongs to whichever file `pnpm db:setup:prod`
    // actually runs.
    const { code, out } = await run("src/setup-prod-cli.ts", {
      DATABASE_URL_SESSION: URL_SESSION,
      TF_PROD_DB_HOST_FILE: pinFile,
    });
    expect(out).toContain(PAD);
    expect(out).toContain("[db:setup:prod] FAILED:");
    expect(out.endsWith(`'\n${EXIT_MARK}1\n`)).toBe(true);
    expect(code).toBe("1");
  }, 60_000);

  /**
   * THE CONTROL, and the reason the two cases above are evidence rather than decoration: the same
   * pin, the same pipe, the same loader — and `process.exit`, which is the shape the CLIs are
   * forbidden from having. It has to come back TRUNCATED.
   *
   * A red here does NOT mean the probe regressed. It means the harness has stopped being able to
   * see the defect at all — something put the pipe back into blocking mode (the header names the
   * one that already did) — and the two cases above are passing for a reason that has nothing to
   * do with the CLIs. Restore the conditions; never relax the cases.
   *
   * FOUR assertions, not one, because "most of the output is missing" is also what a probe that
   * never ran looks like: a shim throwing on an unreadable pin file, a loader that cannot
   * resolve, a syntax error. Each of those leaves a short body with no pin in it and exits
   * non-zero, and each would have satisfied a bare `not.toContain`. So the probe announces itself
   * before the oversized write and leaves by a code no failure path produces, and this case
   * checks that the body RAN, that the big line STARTED, that its tail was lost, and that the
   * exit was the probe's own.
   */
  it("the harness can still SEE a lost line — a bare process.exit truncates", async () => {
    const { code, out } = await run("test/cli-exit-drain.bare-exit-probe.ts", {
      TF_PROD_DB_HOST_FILE: pinFile,
    });
    // Duplicated from the probe on purpose: importing that module would RUN it, and it ends in
    // `process.exit`, which would take this worker with it.
    const SENTINEL = "___PROBE_RAN";
    const WHY_RED =
      "the harness can no longer observe the drain defect, so the two cases above prove nothing. " +
      "Two causes, and the output distinguishes them. (1) The probe never ran — a loader or shim " +
      "failure; its error is in the output and the exit is 1, not 3. (2) The pipe went back into " +
      "BLOCKING mode, so nothing was pending at the exit and the whole line arrived; the usual " +
      "cause is the loader's own transform subprocess inheriting stderr, and " +
      "ESBUILD_WORKER_THREADS=0 reaches that only on tsx's SYNCHRONOUS-hooks path, which needs " +
      `Node >= 22.22.3 (this run: ${process.version}). ` +
      "Restore the conditions — do not relax the cases.";
    // The body ran at all…
    expect(out, WHY_RED).toContain(SENTINEL);
    // …the oversized line STARTED arriving (a prefix that fits inside the pipe buffer)…
    expect(out, WHY_RED).toContain(PAD.slice(0, 40_000));
    // …and its tail was thrown away. A small part of it in every run measured here; the length
    // bound is loose on purpose — the claim is "most of it was lost", not a pipe-buffer size.
    expect(out, WHY_RED).not.toContain(PAD);
    expect(out.length, WHY_RED).toBeLessThan(PAD.length / 2);
    // …by THIS file's exit, not by a loader failure, which would be 1.
    expect(code, WHY_RED).toBe("3");
  }, 60_000);

  /**
   * A cron fix found this class in the four crons and two later fixes found it elsewhere: the failure mode is
   * N hosts each independently remembering a grammar. Two behavioural cases above cover two
   * hosts; this covers every file in the package, including the next CLI somebody adds.
   */
  it("no file in packages/db/src calls process.exit at all", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(SRC_DIR).filter((n) => n.endsWith(".ts"))) {
      // Comments are stripped first, and that is not a convenience: the notes explaining WHY
      // these files must not call `process.exit` quote the very call they forbid, so a raw grep
      // is red on a correct file — a guard that fires on its own rationale is a guard people
      // delete. `/* … */` state is tracked line by line so line numbers survive.
      let inBlock = false;
      readFileSync(`${SRC_DIR}/${f}`, "utf8").split("\n").forEach((line, i) => {
        const opens = line.includes("/*");
        const closes = line.includes("*/");
        const wasInBlock = inBlock;
        if (opens && !closes) inBlock = true;
        else if (closes) inBlock = false;
        if (wasInBlock || opens) return;
        const code = line.replace(/\/\/.*$/, "");
        if (/process\.exit\s*\(/.test(code)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  /** The other half: a script that sets no code at all would satisfy the rule above. */
  it("every CLI in packages/db/src sets process.exitCode", () => {
    const clis = [
      "mailbox-dedup-cli.ts",
      "setup-prod-cli.ts",
      "supa" + "base-lockdown.ts",
      "provision-staff-role.ts",
    ];
    for (const f of clis) {
      expect(readFileSync(`${SRC_DIR}/${f}`, "utf8")).toContain("process.exitCode =");
    }
  });
});
