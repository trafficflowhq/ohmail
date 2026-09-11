import { noticeSinkFor, setNoticeSink } from "@trafficflow/db";
import { createLogger, type LogFields, type LogSink, type Logger } from "@trafficflow/core";
import { WorkerConfigError, instanceIdFrom, loadConfig, type WorkerConfig } from "./config.js";
import { flushExit } from "./entry.js";

/**
 * THE COMPOSITION ROOT FOR THE FOUR CRON PROCESSES. Each cron is its own CLI entry point and process,
 * and until this file each of the four decided independently how to report itself: 17 `console.*` calls
 * and no `createLogger`. Two per cron were `console.error("[cron] failed:", err)`, which serialises the
 * WHOLE thrown value into the operator drain — and a hostile mail server chooses the token in an error
 * message, which is why `log.ts` reduces `err` to CLASS + CODE. That was the third hand-rolled-sink
 * instance (after the sidecar's `JSON.stringify` sink and postgres.js's `onnotice` default). A helper,
 * not four wirings, because "four hand-rolled copies" IS the defect; what stays per file is WHICH pass
 * (the event NAME, {@link cronEvent}). The notice sink goes in here too — `setNoticeSink` was wired into
 * `apps/worker/src/index.ts` and `apps/api-vercel/src/deps.ts` and skipped these four, and this closes that room. */

/**
 * `worker-cron`, and NOT `worker`. The always-on supervisor owns `worker`, and a drain where a cron's
 * output is indistinguishable from the supervisor's cannot answer the first operator question — "is the
 * loop running, or only the backstop?" — which is the gap this slice closes. The hyphen is legal:
 * `SERVICE_RE` in `packages/core/src/log.ts` is `/^[a-z][a-z0-9_-]{0,31}$/`, so it admits `-`. Asserted
 * from the emitted bytes, not read — an invalid `service` does not throw, it silently becomes
 * `invalid_service` on every line, exactly the claim that has to come from the bytes.
 */
export const CRON_SERVICE = "worker-cron";

/** The four cron passes, spelled as they appear inside an event name. */
export const CRON_PASSES = ["proposals", "workflow", "bubble_up", "reconcile"] as const;
export type CronPass = (typeof CRON_PASSES)[number];

/**
 * WHICH PASS, ENCODED IN THE EVENT NAME — deliberately, not in a field. `event` is already a validated
 * grammar (`EVENT_RE`, `/^[a-z][a-z0-9_]{0,63}$/`) with no allowlist behind it, so `cron_proposals_ran`
 * costs nothing; a `pass` field would cost an `ALLOWED_FIELDS` entry, and every new entry is another
 * chance to reproduce the measured miss where six fields were added at the call site, never to the
 * census, and production answered `droppedFields=[…]` with a green suite. Fewer new names is the whole
 * strategy. `bubble_up`, not `bubble-up`: the event grammar admits `_`, not `-`.
 */
export function cronEvent(pass: CronPass, outcome: string): string {
  return `cron_${pass}_${outcome}`;
}

/**
 * The logger every cron process writes through, built the way `index.ts` builds the worker's. `config` is
 * optional because bootstrap ordering matters: `loadConfig()` is one of the two things most likely to
 * fail on a fresh deploy, so a logger that cannot exist until the config parses cannot report a config
 * that does not parse. The unbound form is built first; the bound form REPLACES it once the config is in
 * hand. `sink` is a test seam only: the census in `log.ts` runs BEFORE the sink, so reading the sink is
 * the only way to prove a field survived rather than merely that a call site handed it over.
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
 * Light the notice channel for this process, reading the logger THROUGH A CLOSURE. `packages/db` drops
 * notices until a host installs a sink, so without this postgres.js's notices are silent (safer than the
 * driver's default of dumping the raw object). The `read` indirection is not ceremony: the logger is
 * REPLACED once the config parses (see {@link cronLogger}), so a sink that captured the value would keep
 * writing through the pre-config logger — no `instanceId`, no `environment` — for the life of the process,
 * on the one channel whose purpose is attributing a driver notice to an instance. `runCronCli` installs
 * this BEFORE `loadConfig()`, which makes the difference observable, and `cron-logging.test.ts` observes it.
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
 * THE WHOLE CLI BOTTOM OF A CRON, ONCE. Ordering is the content, each step here because of a defect:
 * (1) the unbound logger and notice sink come first, before `loadConfig()` — all four crons ran
 * `runProposalCron(loadConfig())` with `loadConfig()` as an ARGUMENT, so a malformed environment threw
 * SYNCHRONOUSLY, outside the promise, past the `.catch`, and Node printed the stack, one of whose
 * `WorkerConfigError` messages quotes `DATABASE_URL_SESSION` — a password leak through an unopened door
 * (`index.ts` fixed the twin, `cli.smoke.test.ts`), so the config load is INSIDE the try. (2) `flushExit`,
 * never bare `process.exit` (which discards undrained `console.log`, i.e. the `*_failed` line); exit codes
 * unchanged (0 ran/skipped, 1 threw). (3) `{ err }`, plus `configVar` when the thrown value carries one —
 * a chosen key (`index.ts:2270`'s pattern), not a string a driver composed. */
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
