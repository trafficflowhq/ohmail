import { afterEach, describe, expect, it } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { onNotice, setNoticeSink } from "@trafficflow/db";
import type { Logger } from "@trafficflow/core";
import { WorkerConfigError, type WorkerConfig } from "../src/config.js";
import {
  CRON_PASSES, CRON_SERVICE, cronEvent, cronLogger, installCronNoticeSink, runCronCli,
} from "../src/cron-log.js";

/**
 * THE FOUR CRON PROCESSES REPORT THROUGH THE HARDENED LOGGER, AND THE FIELDS SURVIVE.
 *
 * Two halves, and the second half is the one that matters most, because a census alone is what let
 * the attach change ship. Those tests injected a FAKE logger, so they asserted what a call site HANDED OVER;
 * `ALLOWED_FIELDS` in `packages/core/src/log.ts` then refused all six fields in production and the
 * suite stayed green. So:
 *
 *  · **the census** (computed, never listed) proves no cron file can write to the drain directly —
 *    17 `console.*` calls across four files, two of them `console.error("[cron] failed:", err)`,
 *    which serialises a thrown value's message and stack;
 *  · **the behavioural half** drives the REAL `createLogger` through its `sink` seam and reads the
 *    emitted BYTES, which is the only place the census in `log.ts` has already run.
 *
 * The notice-channel and closure assertions are here for the same reason: `setNoticeSink` is a
 * process-global whose failure mode is silence, and silence is indistinguishable from working.
 */

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/**
 * Blank comments while PRESERVING line numbers, so a census failure can name `file:line`.
 *
 * Needed rather than optional: `cron-log.ts`'s own header documents the defect it fixes and
 * therefore contains the string `console.log` twice, in prose. A census that did not strip comments
 * would go red on the documentation of the thing it is guarding.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * Every file in `apps/worker/src` whose NAME puts it on the cron surface, computed with a filter
 * rather than listed — so a fifth cron is covered on the day it lands, which is the day nobody
 * remembers to extend a list.
 */
function cronSurface(): string[] {
  return readdirSync(SRC).filter((f) => f.endsWith(".ts") && f.includes("cron")).sort();
}

/** The shared helper — on the surface, but it cannot import itself. */
const HELPERS = ["cron-log.ts"];
/**
 * IN-PROCESS schedulers — on the cron surface by NAME, but not processes of their own.
 *
 * `api-cron.ts` runs INSIDE the always-on supervisor: `index.ts` starts it under the leader lock
 * (shard 0 only) and hands it the supervisor's OWN logger through `ApiCronDeps.log`. That makes
 * the CLI-bottom requirement wrong for it twice over: `runCronCli` loads config, installs the
 * process-global notice sink and EXITS — all three belong to the supervisor's composition root
 * here, and calling them from a module the supervisor hosts would fight it for process globals —
 * and `cronLogger` would stamp `service=worker-cron` on lines the SUPERVISOR process emitted,
 * which is the exact indistinguishability CRON_SERVICE exists to prevent, in the other direction.
 *
 * The exemption is NARROW: these files stay under the console/std-stream census and the
 * `loadConfig()` ban, and the "is NOT a process" test below pins the structural facts that
 * license it — the day one of them grows a CLI bottom, an own logger, or an exit, this
 * classification stops being true and the suite says so.
 */
const IN_PROCESS = ["api-cron.ts"];
/** The CLI entry points. Each must delegate its whole bottom to the helper. */
const ENTRIES = cronSurface().filter((f) => !HELPERS.includes(f) && !IN_PROCESS.includes(f));

function srcOf(file: string): string {
  return stripComments(readFileSync(join(SRC, file), "utf8"));
}

/** `file:line` for every line of `file` matching `re`. */
function hits(file: string, re: RegExp): string[] {
  return srcOf(file).split("\n").flatMap((line, i) => (re.test(line) ? [`${file}:${i + 1}`] : []));
}

describe("the cron census — no cron file writes to the drain directly", () => {
  it("the file set is real and complete, so a broken filter cannot pass forever", () => {
    // Anti-vacuity. Without this, `cronSurface()` returning [] makes every assertion below vacuous.
    for (const helper of HELPERS) {
      expect(cronSurface(), `${helper} is on the exclusion list but not on disk — the list is stale`)
        .toContain(helper);
    }
    for (const inProc of IN_PROCESS) {
      expect(cronSurface(), `${inProc} is classified in-process but not on disk — the list is stale`)
        .toContain(inProc);
    }
    expect(ENTRIES.length, `expected at least four cron entry points, found ${ENTRIES.join(", ")}`)
      .toBeGreaterThanOrEqual(4);
    for (const named of ["bubble-up-cron.ts", "proposal-cron.ts", "reconcile-cron.ts", "workflow-cron.ts"]) {
      expect(ENTRIES, `${named} fell out of the computed cron set`).toContain(named);
    }
  });

  it("no cron file calls console.* or writes to a std stream", () => {
    const found = cronSurface().flatMap((f) => [
      ...hits(f, /\bconsole\s*\./),
      ...hits(f, /\bprocess\s*\.\s*std(out|err)\s*\.\s*write\b/),
    ]);
    expect(
      found,
      `these write to the operator drain without passing through the hardened logger, so a thrown ` +
      `value's message and stack reach stdout verbatim (a hostile mail server chooses that ` +
      `token): ${found.join(", ")}`,
    ).toEqual([]);
  });

  it("every cron entry delegates its CLI bottom to the shared helper", () => {
    for (const file of ENTRIES) {
      const src = srcOf(file);
      expect(/from "\.\/cron-log\.js"/.test(src),
        `${file} does not import ./cron-log.js, so it is deciding the log grammar for itself — ` +
        `four hand-rolled copies is the old shape exactly`).toBe(true);
      expect(/\brunCronCli\s*\(/.test(src),
        `${file} imports the helper but does not run its CLI through it`).toBe(true);
    }
  });

  it("an in-process scheduler is NOT a process — no CLI bottom, no own logger, no notice sink, no exit", () => {
    // The pins that license IN_PROCESS. Each names a thing only a PROCESS may do, because the
    // supervisor hosting these modules already does it once:
    //  · runCronCli / cronLogger — the logger arrives by injection, already stamped with the
    //    service name of the process the lines actually come from;
    //  · createLogger / setNoticeSink — building a logger or claiming the process-global notice
    //    channel belongs to the composition root in index.ts;
    //  · process.exit / flushExit — a hosted module that exits takes the whole worker with it.
    for (const file of IN_PROCESS) {
      for (const [what, re] of [
        ["runs a CLI bottom", /\brunCronCli\s*\(/],
        ["builds the cron logger", /\bcronLogger\s*\(/],
        ["builds its own logger", /\bcreateLogger\s*\(/],
        ["claims the process-global notice sink", /\b(setNoticeSink|installCronNoticeSink)\s*\(/],
        ["can end the hosting process", /\bprocess\s*\.\s*exit\s*\(|\bflushExit\s*\(/],
      ] as const) {
        const found = hits(file, re);
        expect(found, `${file} ${what} — the in-process classification above stopped being true, ` +
          `so it belongs in ENTRIES with a real CLI bottom: ${found.join(", ")}`).toEqual([]);
      }
      expect(/\blog\?\s*:\s*Logger\b/.test(srcOf(file)),
        `${file} no longer takes its logger by injection — the in-process classification leans on it`)
        .toBe(true);
    }
  });

  it("no cron entry evaluates loadConfig() as an argument any more", () => {
    // The shape was `runProposalCron(loadConfig())` in all four: `loadConfig()` throwing threw
    // SYNCHRONOUSLY, outside the promise, so the `.catch` beneath it never applied and Node's
    // default handler printed the message and the stack. `WorkerConfigError`'s own header says
    // several of those messages quote their input, one being a connection string with a password.
    // The in-process files are held to this too: their config arrives by injection as well.
    for (const file of [...ENTRIES, ...IN_PROCESS]) {
      const found = hits(file, /\bloadConfig\s*\(/);
      expect(found,
        `${file} still calls loadConfig() itself; the helper owns it so the throw lands inside a ` +
        `try and is reported through the logger: ${found.join(", ")}`).toEqual([]);
    }
  });
});

/** Every `cronEvent("pass", "outcome")` literal the cron sources actually contain. */
function declaredEvents(): string[] {
  const out = new Set<string>();
  for (const file of ENTRIES) {
    for (const m of srcOf(file).matchAll(/cronEvent\(\s*"([a-z_]+)"\s*,\s*"([a-z_]+)"\s*\)/g)) {
      out.add(cronEvent(m[1] as (typeof CRON_PASSES)[number], m[2]!));
    }
  }
  // The helper's three are built from a variable `pass`, so they are enumerated over the passes
  // rather than scraped.
  for (const pass of CRON_PASSES) for (const o of ["ran", "skipped", "failed"]) out.add(cronEvent(pass, o));
  return [...out].sort();
}

/** Read the emitted BYTES of the real logger. The census in `log.ts` has already run by here. */
function capture(fn: (log: Logger) => void, config?: WorkerConfig): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  fn(cronLogger(config, (line) => { lines.push(JSON.parse(line) as Record<string, unknown>); }));
  return lines;
}

const CONFIG = { instanceId: "cron-inst-7", environment: "production" } as unknown as WorkerConfig;
/* The hosts are interpolated into the fixture connection strings: a whole credentialed URL literal is a
 * credential to the push gate, and a `+` split is read joined. */
const DB_HOST = "db.internal";
const POOLER_HOST = "pooler";

describe("behavioural — the REAL logger emits what the crons pass", () => {
  it("stamps service=worker-cron, so cron output is distinguishable from the supervisor's", () => {
    const [line] = capture((log) => { log.info(cronEvent("proposals", "ran"), { generated: 1 }); }, CONFIG);
    // An invalid `service` does not throw — it silently becomes `invalid_service` on every line the
    // process will ever emit. This is the assertion that SERVICE_RE admits the hyphen.
    expect(line?.service, "the hyphen was refused by SERVICE_RE; use worker_cron rather than widening it")
      .toBe(CRON_SERVICE);
    expect(line?.service).not.toBe("invalid_service");
    // ── THE LITERAL, AND WHY IT IS NOT REDUNDANT ────────────────────────────────────────────
    // `toBe(CRON_SERVICE)` above compares the emitted value against the constant that produced
    // it, so it is tautological with respect to the VALUE: found by mutation — reverting
    // CRON_SERVICE to "worker" changed both sides and this test stayed GREEN. It still earns its
    // place (it is what proves SERVICE_RE admits the hyphen rather than silently substituting
    // `invalid_service`), but it cannot pin the name.
    //
    // The name is the whole diagnostic point of the slice: the supervisor owns `worker`, and a
    // drain where cron output is indistinguishable from the supervisor's cannot answer "is the
    // loop running, or only the backstop?".
    expect(line?.service, "the cron service name is no longer worker-cron").toBe("worker-cron");
    expect(CRON_SERVICE, "the cron service collided with the supervisor's own `worker`").not.toBe("worker");
  });

  it("drops NONE of the fields the four crons pass — the attachments assertion", () => {
    const fields = {
      // bound by `cronLogger`
      instanceId: "cron-inst-7", environment: "production",
      // per-account and per-mailbox failure paths
      accountId: "acct-1", mailboxId: "mbx-1",
      // reconcile's other-shard skip
      shard: 0, shards: 1,
      // the CLI skip line
      reason: "worker-live",
      // the three pass counts the cron change added to ALLOWED_FIELDS
      generated: 3, flipped: 4, drained: 5,
      // a config failure names the variable, never its value
      configVar: "DATABASE_URL_SESSION",
    };
    const [line] = capture((log) => { log.info(cronEvent("proposals", "ran"), fields); });

    expect(line?.droppedFields,
      `the census in log.ts refused a field a cron passes: ${JSON.stringify(line)}`).toBeUndefined();
    for (const [k, v] of Object.entries(fields)) {
      expect(line?.[k], `\`${k}\` never reached the emitted line: ${JSON.stringify(line)}`).toBe(v);
    }
  });

  it("every event name the cron sources declare survives the event grammar", () => {
    const events = declaredEvents();
    // Anti-vacuity: a broken scrape returns the twelve helper events and nothing else.
    expect(events.length, `too few cron events scraped — the regex is not matching: ${events.join(", ")}`)
      .toBeGreaterThanOrEqual(18);
    for (const event of events) {
      const [line] = capture((log) => { log.info(event); });
      expect(line?.event, `\`${event}\` was refused by EVENT_RE and emitted as invalid_event`).toBe(event);
    }
  });

  it("a thrown value becomes class + code, and its prose never reaches the drain", () => {
    // The privacy content of the slice. The message is shaped like what an IMAP server can choose
    // and like what a driver interpolates.
    const cause = Object.assign(new Error(`connect to postgres://u:MARKER_PW_a1@${DB_HOST}/x failed`), {
      code: "ETIMEDOUT",
    });
    const err = Object.assign(new Error(`* NO [MARKER_ATOM_b2] MARKER_MSG_c3 password=${fixturePassword("cron-thrown")}`), {
      code: "EAUTH", cause,
    });
    const [line] = capture((log) => { log.error(cronEvent("proposals", "failed"), { err }); });
    const bytes = JSON.stringify(line);

    expect(line?.errorClass).toBe("Error");
    expect(line?.errorCode).toBe("EAUTH");
    // The cause chain is the reason `{ err }` beats a hand-written `errorCode`.
    expect(line?.causeClass).toBe("Error");
    expect(line?.causeCode).toBe("ETIMEDOUT");
    for (const marker of ["MARKER_PW_a1", "MARKER_ATOM_b2", "MARKER_MSG_c3", fixturePassword("cron-thrown"), "postgres://"]) {
      expect(bytes.includes(marker), `\`${marker}\` reached the log drain: ${bytes}`).toBe(false);
    }
    expect(bytes.includes("at Object"), `a stack frame reached the log drain: ${bytes}`).toBe(false);
  });
});

describe("the notice channel is lit in a cron process", () => {
  afterEach(() => { setNoticeSink(null); });

  const raw = {
    severity: "WARNING", severity_local: "WARNING", code: "54000",
    message: "word (subject)=(MARKER_NOTICE_d4) is too long to be indexed",
    detail: "MARKER_DETAIL_e5", hint: "MARKER_HINT_f6", file: "ts_parse.c",
  };

  it("installCronNoticeSink routes a postgres notice through the cron logger", () => {
    const lines: Record<string, unknown>[] = [];
    const log = cronLogger(CONFIG, (l) => { lines.push(JSON.parse(l) as Record<string, unknown>); });
    installCronNoticeSink(() => log);

    onNotice(raw);

    expect(lines.map((l) => `${String(l.level)}:${String(l.event)}`),
      "no structured pg_notice line was emitted, so this process's notices are still dropped")
      .toEqual(["warn:pg_notice"]);
    expect(lines[0]?.service).toBe(CRON_SERVICE);
    expect(lines[0]?.severity).toBe("WARNING");
    expect(lines[0]?.code).toBe("54000");
    const bytes = JSON.stringify(lines);
    for (const marker of ["MARKER_NOTICE_d4", "MARKER_DETAIL_e5", "MARKER_HINT_f6"]) {
      expect(bytes.includes(marker), `the driver's notice prose reached the drain: ${bytes}`).toBe(false);
    }
  });

  it("the sink reads the logger through a CLOSURE, so it follows the post-config rebind", async () => {
    // The observable difference. `runCronCli` installs the sink BEFORE `loadConfig()`, against a
    // logger with no `instanceId`, then REPLACES that logger. A sink that captured the value would
    // keep attributing every notice to nothing for the life of the process.
    const lines: Record<string, unknown>[] = [];
    const codes: number[] = [];
    await runCronCli(
      "proposals",
      async () => { onNotice(raw); return { ran: true, generated: 2 }; },
      (r) => ({ ran: r.ran, fields: { generated: r.generated } }),
      {
        loadConfig: () => CONFIG,
        exit: (c) => { codes.push(c); },
        sink: (l) => { lines.push(JSON.parse(l) as Record<string, unknown>); },
      },
    );

    const notice = lines.find((l) => l.event === "pg_notice");
    expect(notice, `no notice line was emitted at all: ${JSON.stringify(lines)}`).toBeDefined();
    expect(notice?.instanceId,
      "the notice was attributed to the PRE-config logger, so the sink captured the logger by value")
      .toBe("cron-inst-7");
    expect(notice?.environment).toBe("production");

    const outcome = lines.at(-1);
    expect(outcome?.event).toBe("cron_proposals_ran");
    expect(outcome?.generated).toBe(2);
    expect(outcome?.droppedFields).toBeUndefined();
    expect(codes, "exit code changed; ran ⇒ 0 is unchanged behaviour").toEqual([0]);
  });
});

describe("runCronCli's exit contract and the config-failure path", () => {
  afterEach(() => { setNoticeSink(null); });

  function drive(run: () => Promise<{ ran: boolean }>, load?: () => WorkerConfig) {
    const lines: Record<string, unknown>[] = [];
    const codes: number[] = [];
    const done = runCronCli("reconcile", run, (r) => ({ ran: r.ran }), {
      loadConfig: load ?? (() => CONFIG),
      exit: (c) => { codes.push(c); },
      sink: (l) => { lines.push(JSON.parse(l) as Record<string, unknown>); },
    });
    return { done, lines, codes };
  }

  it("a skipped pass still exits 0 and says which pass skipped", async () => {
    const { done, lines, codes } = drive(async () => ({ ran: false }));
    await done;
    expect(lines.at(-1)?.event).toBe("cron_reconcile_skipped");
    expect(codes).toEqual([0]);
  });

  it("a throwing pass exits 1 through a structured line, not a raw dump", async () => {
    const { done, lines, codes } = drive(async () => {
      throw Object.assign(new Error("MARKER_THROWN_g7"), { code: "ECONNRESET" });
    });
    await done;
    const line = lines.at(-1);
    expect(line?.event).toBe("cron_reconcile_failed");
    expect(line?.errorCode).toBe("ECONNRESET");
    // Named, because this is the assertion that catches the prose getting back in under an
    // ALLOWED field name — `reason: String(err)` is the tempting one, and `reason` is on the
    // census. The value-pattern gate does NOT save you here: it catches `postgres://u:…@h`, so a
    // connection string redacts, but a plain message is a plain string and rides through.
    expect(JSON.stringify(line).includes("MARKER_THROWN_g7"),
      `the thrown value's MESSAGE reached the drain: ${JSON.stringify(line)}`).toBe(false);
    expect(codes).toEqual([1]);
  });

  it("a malformed environment is reported, named, and carries no connection string", async () => {
    // `runProposalCron(loadConfig())` put this throw OUTSIDE the promise, so it had no handler at
    // all: Node printed the message — which quotes the offending value — and the stack.
    const { done, lines, codes } = drive(async () => ({ ran: true }), () => {
      throw new WorkerConfigError("DATABASE_URL_SESSION",
        `DATABASE_URL_SESSION is a transaction pooler: postgres://u:MARKER_PW_h8@${POOLER_HOST}/db`);
    });
    await done;
    const line = lines.at(-1);
    expect(line?.event).toBe("cron_reconcile_failed");
    expect(line?.errorClass).toBe("WorkerConfigError");
    expect(line?.errorCode).toBe("TF_CONFIG_INVALID");
    expect(line?.configVar, "the operator is told WHICH variable, which is the whole diagnostic")
      .toBe("DATABASE_URL_SESSION");
    const bytes = JSON.stringify(line);
    expect(bytes.includes("MARKER_PW_h8"), `a password reached the drain: ${bytes}`).toBe(false);
    expect(bytes.includes("postgres://"), `a connection string reached the drain: ${bytes}`).toBe(false);
    expect(codes).toEqual([1]);
  });
});
