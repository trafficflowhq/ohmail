import { noticeSinkFor, setNoticeSink } from "@trafficflow/db";
import { createLogger, type LogFields, type LogSink, type Logger } from "@trafficflow/core";
import { WorkerConfigError, instanceIdFrom, loadConfig, type WorkerConfig } from "./config.js";
import { flushExit } from "./entry.js";

/**
 * THE COMPOSITION ROOT FOR THE FOUR CRON PROCESSES.
 *
 * Each cron is its own CLI entry point, so each is its own process, and until this file existed
 * each of the four decided independently how to report itself: 17 `console.*` calls across the
 * four and not one `createLogger`. Two of every cron's four were
 *
 *     console.error("[cron] failed:", err)
 *
 * which serialises the WHOLE thrown value — message and stack — into the operator drain. It is
 * established that a hostile mail server chooses the token that lands in an error message, and
 * `packages/core/src/log.ts` exists to reduce `err` to CLASS + CODE for exactly that reason. So
 * these four processes were the one place in the repository where the hardened logger's whole
 * argument did not apply. That is the third instance of the hand-rolled-sink class (after the sidecar's
 * hand-rolled `JSON.stringify` sink and postgres.js's raw `onnotice` default), and the class is
 * always the same shape: N hosts each remembering the grammar.
 *
 * ── WHY A HELPER AND NOT FOUR WIRINGS ────────────────────────────────────────────────────────
 *
 * Because "four hand-rolled copies" IS the defect, not the symptom of it. Everything a cron
 * process decides about its own output — the service name, the bound fields, the event grammar,
 * the notice sink, and how it exits — is decided here, once. What stays in each cron file is only
 * WHICH pass it is, and that is carried in the event NAME (see {@link cronEvent}).
 *
 * ── AND WHY THE NOTICE SINK GOES IN WITH IT ──────────────────────────────────────────────────
 *
 * The notice channel wired `setNoticeSink` into `apps/worker/src/index.ts` and `apps/api-vercel/src/deps.ts` and
 * deliberately skipped these four, because installing a notice handler in a process whose own
 * error path dumps raw objects would be a lock on one door of an open room. This file is the room
 * being closed, so the sink is installed here rather than in a later slice.
 */

/**
 * `worker-cron`, and NOT `worker`.
 *
 * The always-on supervisor owns `worker`. A drain in which a cron's output is indistinguishable
 * from the supervisor's cannot answer the first question an operator asks — "is the loop running,
 * or is only the backstop running?" — which is the diagnostic gap this slice exists to close.
 *
 * The hyphen is legal: `SERVICE_RE` in `packages/core/src/log.ts` is
 * `/^[a-z][a-z0-9_-]{0,31}$/`, so it admits `-`. That is asserted from the emitted bytes
 * rather than read — an invalid `service` does not throw, it silently
 * becomes `invalid_service` on every line this process will ever emit, so it is precisely the
 * kind of claim that has to come from the emitted bytes.
 */
export const CRON_SERVICE = "worker-cron";

/** The four cron passes, spelled as they appear inside an event name. */
export const CRON_PASSES = ["proposals", "workflow", "bubble_up", "reconcile"] as const;
export type CronPass = (typeof CRON_PASSES)[number];

/**
 * WHICH PASS, ENCODED IN THE EVENT NAME — deliberately, instead of in a field.
 *
 * `event` is already a validated grammar (`EVENT_RE`, `/^[a-z][a-z0-9_]{0,63}$/`) with no
 * allowlist behind it, so `cron_proposals_ran` costs nothing. A `pass` field would cost an
 * `ALLOWED_FIELDS` entry — and every new entry is another chance to reproduce a measured miss, where six
 * fields were added at the call site, never to the census, and production answered
 * `droppedFields=[…]` with a green suite behind it. Fewer new names is the whole strategy.
 *
 * `bubble_up` and not `bubble-up`: the event grammar admits `_` and not `-`.
 */
export function cronEvent(pass: CronPass, outcome: string): string {
  return `cron_${pass}_${outcome}`;
}

/**
 * The logger every cron process writes through, built the way `index.ts` builds the worker's.
 *
 * `config` is optional because the bootstrap ordering matters: `loadConfig()` is one of the two
 * things most likely to fail on a fresh deploy, so a logger that cannot exist until the
 * configuration parses is a logger that cannot report a configuration that does not parse. The
 * unbound form is built first; the bound form REPLACES it once the config is in hand.
 *
 * `sink` is a test seam and nothing else. It exists so a guard can read the exact bytes this
 * logger produces — the census in `log.ts` runs BEFORE the sink, so reading the sink is the only
 * way to prove a field survived rather than merely that a call site handed it over.
 */
export function cronLogger(config?: WorkerConfig, sink?: LogSink): Logger {
  return createLogger({
    service: CRON_SERVICE,
    ...(sink === undefined ? {} : { sink }),
    ...(config === undefined ? {} : {
      fields: {
        instanceId: config.instanceId ?? instanceIdFrom(),
        environment: config.environment,
      },
    }),
  });
}

/**
 * Light the notice channel for this process, reading the logger THROUGH A CLOSURE.
 *
 * `packages/db` drops notices until a host installs a sink, so without this call postgres.js's
 * notices are silent rather than structured — safer than the driver's default of dumping the raw
 * notice object, and zero diagnostics.
 *
 * The `read` indirection is not ceremony, and it is not copied from `index.ts` for symmetry: the
 * logger is REPLACED once the config parses (see {@link cronLogger}), so a sink that captured the
 * value would keep writing through the pre-config logger — no `instanceId`, no `environment` — for
 * the life of the process, on the one channel whose whole purpose is attributing a driver notice
 * to an instance. `runCronCli` installs this BEFORE `loadConfig()` runs, which is what makes the
 * difference observable, and `cron-logging.test.ts` observes it.
 */
export function installCronNoticeSink(read: () => Logger): void {
  setNoticeSink(noticeSinkFor({
    warn: (event, fields) => { read().warn(event, fields); },
    info: (event, fields) => { read().info(event, fields); },
  }));
}

/** What a pass did, in the two terms the CLI line needs. `fields` must already be census-safe. */
export interface CronOutcome {
  ran: boolean;
  fields?: LogFields;
}

/**
 * Injected seams. All three are NON-logger on purpose: the logger under test stays REAL, because
 * the defect this slice's guard exists to prevent is a fake logger accepting a field the real
 * census refuses.
 */
export interface CronCliSeams {
  /** Defaults to the real `loadConfig`. Injected so a guard can drive the failure ordering. */
  loadConfig?: () => WorkerConfig;
  /** Defaults to `flushExit`. Injected so a guard does not kill the test runner. */
  exit?: (code: number) => void;
  /** Injected sink, as {@link cronLogger}. */
  sink?: LogSink;
}

/**
 * THE WHOLE CLI BOTTOM OF A CRON, ONCE.
 *
 * Ordering is the content of this function, and each step is here because of a defect:
 *
 *  1. **The unbound logger and the notice sink come first**, before `loadConfig()`. All four crons
 *     used to read `runProposalCron(loadConfig())` — `loadConfig()` evaluated as an ARGUMENT, so a
 *     malformed environment threw SYNCHRONOUSLY, outside the promise, and the `.catch` below it
 *     never applied. Node's default handler then printed the message and the stack; and
 *     `WorkerConfigError`'s own header says several of those messages quote their input, one of
 *     which is `DATABASE_URL_SESSION` — a connection string with a password in it. That is the
 *     credential-in-message leak
 *     through a door nobody had opened yet, and `index.ts` fixed the identical ordering for the
 *     supervisor (`cli.smoke.test.ts`). Here the config load is INSIDE the try.
 *
 *  2. **`flushExit`, never bare `process.exit`.** Established, not assumed, and the measurement is
 *     reproducible: `node -e 'console.log("x".repeat(120000)); process.exit(0)' | wc -c` emits
 *     65536 of 120001 bytes on this platform — `console.log` queues, and `process.exit` discards
 *     what has not drained. The logger's default sink IS `console.log`, and the line at risk is
 *     the `*_failed` line, i.e. the only line that explains why the cron exited 1. Exit CODES are
 *     unchanged: 0 for ran-or-skipped, 1 for threw.
 *
 *  3. **`{ err }`, plus `configVar` when the thrown value carries one.** The logger derives
 *     `errorClass`, `errorCode`, `causeClass` and `causeCode` and drops the prose. `configVar` is
 *     the one addition, and it is `index.ts:2270`'s pattern rather than a new idea: a boot failure
 *     that says only "class WorkerConfigError" is not an operational answer, and the variable's
 *     NAME is a key we chose rather than a string a driver composed.
 */
export async function runCronCli<T>(
  pass: CronPass,
  run: (config: WorkerConfig, log: Logger) => Promise<T>,
  outcome: (result: T) => CronOutcome,
  seams: CronCliSeams = {},
): Promise<void> {
  const exit = seams.exit ?? flushExit;
  const load = seams.loadConfig ?? loadConfig;
  let log = cronLogger(undefined, seams.sink);
  installCronNoticeSink(() => log);
  try {
    const config = load();
    log = cronLogger(config, seams.sink);
    const result = await run(config, log);
    const { ran, fields } = outcome(result);
    log.info(cronEvent(pass, ran ? "ran" : "skipped"), fields);
    exit(0);
  } catch (err) {
    log.error(cronEvent(pass, "failed"), {
      err,
      ...(err instanceof WorkerConfigError ? { configVar: err.configVar } : {}),
    });
    exit(1);
  }
}
