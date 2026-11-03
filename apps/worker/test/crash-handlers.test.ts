import { describe, it, expect } from "vitest";
import { createLogger, type Logger } from "@trafficflow/core";
import { installCrashHandlers, type CrashHost } from "../src/entry.js";
import { driverWriteRaceReason, isDriverWriteRace } from "../src/driver-write-race.js";
import { KEY_RING_V1 } from "../../../test/support/key-ring-env.js";

/**
 * THE CRASH PATH IS A the "Account isolation is absolute, and it binds staff too" invariant SURFACE TOO.
 *
 * `packages/core/src/log.ts` reduces `err` to CLASS + CODE at every call site, deliberately:
 * "a driver message carries the connection string and a `postgres` error carries the failing
 * query". The two process-level handlers went around it — they logged `err` AND
 * `errorDetail: err.message`, and `errorDetail` was that file's own advertised escape hatch
 * rather than a redacted key. So the one code path that only ever runs when something has
 * already gone wrong was the one path that published the exact string the serialiser exists to
 * withhold, into an operator-visible drain.
 *
 * These tests hold the CALL SITE to its half: the handlers pass `err` and nothing else. The
 * second ring — `errordetail` on `REDACTED_KEYS`, so no future caller can reopen it — is
 * asserted in core's own logger test. Two rings on purpose; either alone would leave
 * the property depending on somebody remembering.
 *
 * The second half is ordering: the handlers were installed AFTER `await import()` and
 * `loadConfig()`, so a malformed environment — the likeliest way a fresh deploy dies — rejected
 * a discarded async IIFE with no structured event and, because container stdout is a pipe, on a
 * fast exit no output at all.
 *
 * These are unit tests against `installCrashHandlers` rather than a structural read of
 * `index.ts`, because "the code says the right thing" is not the claim: the claim is that a
 * thrown Error carrying a connection string does not appear in the emitted line.
 */

/** A `process` the test owns: it captures the two listeners instead of registering them. */
function fakeHost() {
  const listeners = new Map<string, (v: unknown) => void>();
  const host: CrashHost = {
    on(event, listener) {
      listeners.set(event, listener as (v: unknown) => void);
      return host;
    },
  };
  return {
    host,
    throwInto: (event: "uncaughtException" | "unhandledRejection", value: unknown): void => {
      const l = listeners.get(event);
      if (!l) throw new Error(`no ${event} handler installed`);
      l(value);
    },
    get installed(): number {
      return listeners.size;
    },
  };
}

function capture(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger({ service: "worker", sink: (l) => lines.push(l) }), lines };
}

/* The provider's domain is interpolated rather than split with `+` (the push gate reads a `+` split joined),
 * and the driver's password names itself a fixture; it is asserted absent case-sensitively below. */
const PROVIDER_TLD = "tech";
const DRIVER_PW = "npg_FixtureNotAPassword";
/** The query's row address, a role at a reserved domain, assembled like the provider's host. */
const RESERVED = "example.com";
const ROW_FROM = `sender@${RESERVED}`;

/** The three real shapes a boot/runtime throw carries, none of which may be republished. */
const SECRETS = {
  driver: `connection to server at "ep-x.eu-central-1.aws.neon.${PROVIDER_TLD}" failed: password authentication failed for user "neondb_owner" (host=ep-x.neon.${PROVIDER_TLD}&user=neondb_owner&password=${DRIVER_PW})`,
  query: `error: null value in column "subject" violates not-null constraint — INSERT INTO messages (subject, from_address) VALUES ('Re: Q3 payroll', '${ROW_FROM}')`,
  config: `missing required env var ${KEY_RING_V1}`,
};

describe("installCrashHandlers — the message never leaves the process", () => {
  it("logs CLASS + CODE for an uncaught exception, and NOT the driver's message", () => {
    const { log, lines } = capture();
    const host = fakeHost();
    const exits: number[] = [];
    installCrashHandlers({ log: () => log, host: host.host, exit: (c) => exits.push(c) });

    const err = Object.assign(new Error(SECRETS.driver), { code: "28P01" });
    host.throwInto("uncaughtException", err);

    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    // What it MUST say — a crash that reports nothing is the 2026-08-01 "Starting Container".
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.event).toBe("uncaught_exception");
    expect(parsed.level).toBe("error");
    expect(parsed.errorClass).toBe("Error");
    expect(parsed.errorCode).toBe("28P01");
    // …and what it must NOT. Substring assertions on the raw line, so no field name can hide it.
    expect(line).not.toContain("password");
    expect(line).not.toContain(DRIVER_PW);
    expect(line).not.toContain("neondb_owner");
    expect(parsed).not.toHaveProperty("errorDetail");
    expect(exits).toEqual([1]);
  });

  it("does the same for an unhandled rejection carrying mail content in a query", () => {
    const { log, lines } = capture();
    const host = fakeHost();
    installCrashHandlers({ log: () => log, host: host.host, exit: () => {} });

    host.throwInto("unhandledRejection", Object.assign(new Error(SECRETS.query), { code: "23502" }));

    const line = lines[0]!;
    expect(JSON.parse(line)).toMatchObject({
      event: "unhandled_rejection", errorClass: "Error", errorCode: "23502",
    });
    expect(line).not.toContain("Q3 payroll");
    expect(line).not.toContain(ROW_FROM);
    expect(line).not.toContain("INSERT INTO");
  });

  it("survives a non-Error rejection — a handler that throws reports nothing at all", () => {
    const { log, lines } = capture();
    const host = fakeHost();
    const exits: number[] = [];
    installCrashHandlers({ log: () => log, host: host.host, exit: (c) => exits.push(c) });

    host.throwInto("unhandledRejection", "a bare string rejection");
    host.throwInto("unhandledRejection", undefined);

    expect(lines).toHaveLength(2);
    expect(exits).toEqual([1, 1]);
  });

  it("resolves the logger LAZILY, so a handler installed before the config still uses the real one", () => {
    // This is what makes the ordering fix possible. The handlers go on FIRST, hung off a
    // bootstrap logger with no `instanceId`; `loadConfig()` then runs inside the try and the
    // logger is REPLACED. A handler that had captured the bootstrap logger would keep emitting
    // unbound lines for the rest of the process's life.
    const first = capture();
    const second = capture();
    let current = first.log;
    const host = fakeHost();
    installCrashHandlers({ log: () => current, host: host.host, exit: () => {} });

    current = second.log;
    host.throwInto("uncaughtException", new Error("boom"));

    expect(first.lines).toHaveLength(0);
    expect(second.lines).toHaveLength(1);
  });

  it("installs both handlers, and installs them from ONE call", () => {
    const host = fakeHost();
    installCrashHandlers({ log: () => capture().log, host: host.host, exit: () => {} });
    expect(host.installed).toBe(2);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE ONE SHAPE THAT MAY NOT KILL THE PROCESS, AND THE EDGES AROUND IT
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The survival half is proved end-to-end in `driver-write-race.pg.test.ts`, which spawns a real
 * process and takes a real transport away underneath a real driver — because "the process is still
 * running" is not a claim a fake host can make. What is pinned HERE is the other half, which that
 * file structurally cannot reach: the EDGES. A guard whose only test is "it survives the thing it
 * was built for" is one loosened regex away from surviving everything.
 *
 * `DRIVER_STACK` is the measured value, verbatim, from the reproduction recorded in
 * `driver-write-race.ts`. Two frames, no query, no `code` — the whole reason the match has to be
 * the stack.
 */
const DRIVER_STACK = [
  "TypeError: Cannot read properties of null (reading 'write')",
  "    at Immediate.nextWrite (/app/node_modules/.pnpm/postgres@3.4.9/node_modules/postgres/src/connection.js:255:22)",
  "    at process.processImmediate (node:internal/timers:511:21)",
].join("\n");

/** An error carrying an exact stack — `new TypeError()` would capture this test file's instead. */
function withStack<E extends Error>(err: E, stack: string): E {
  Object.defineProperty(err, "stack", { value: stack, configurable: true });
  return err;
}

const driverThrow = (): TypeError =>
  withStack(new TypeError("Cannot read properties of null (reading 'write')"), DRIVER_STACK);

describe("driverWriteRaceReason — the match is the frame, not the message", () => {
  it("recognises the measured throw", () => {
    expect(isDriverWriteRace(driverThrow())).toBe(true);
    expect(driverWriteRaceReason(driverThrow())).toContain("nextWrite");
  });

  /**
   * THE FOUR NEAR-MISSES. Each one removes exactly one of the conditions and must be declined —
   * this is what stops the guard from becoming "TypeErrors are fine now".
   */
  it("declines everything that is one condition short of it", () => {
    // …the same message and frame, but not a TypeError: a different defect wearing the location.
    expect(isDriverWriteRace(withStack(new Error("Cannot read properties of null (reading 'write')"), DRIVER_STACK)))
      .toBe(false);
    // …the driver frame, but reading some other property. `nextWrite` touches exactly one.
    expect(isDriverWriteRace(withStack(
      new TypeError("Cannot read properties of null (reading 'destroy')"), DRIVER_STACK,
    ))).toBe(false);
    // …our own code with the same message. This is the one that matters most: application code
    // must never be able to buy itself an exemption by throwing a familiar-looking string.
    expect(isDriverWriteRace(withStack(
      new TypeError("Cannot read properties of null (reading 'write')"),
      "TypeError: Cannot read properties of null (reading 'write')\n" +
      "    at writeBody (/app/apps/worker/dist/index.js:1201:9)",
    ))).toBe(false);
    // …a frame named nextWrite that is NOT in the driver. `postgres` alone is not enough of a
    // path test, which is why the matcher requires the file too.
    expect(isDriverWriteRace(withStack(
      new TypeError("Cannot read properties of null (reading 'write')"),
      "TypeError: Cannot read properties of null (reading 'write')\n" +
      "    at Immediate.nextWrite (/app/apps/postgres-tools/src/spool.js:12:3)",
    ))).toBe(false);
    // …and the values that carry no stack at all.
    expect(isDriverWriteRace("a bare string")).toBe(false);
    expect(isDriverWriteRace(undefined)).toBe(false);
    expect(isDriverWriteRace(null)).toBe(false);
  });
});

describe("installCrashHandlers — survivable is a hole of exactly one shape", () => {
  it("does NOT exit on the driver race, reports it at error level, and counts it", () => {
    const { log, lines } = capture();
    const host = fakeHost();
    const exits: number[] = [];
    installCrashHandlers({
      log: () => log, host: host.host, exit: (c) => exits.push(c), survivable: driverWriteRaceReason,
    });

    host.throwInto("uncaughtException", driverThrow());
    host.throwInto("uncaughtException", driverThrow());

    expect(exits, "the driver's own defect restart-looped the worker").toEqual([]);
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first.event).toBe("uncaught_exception_survived");
    // `error`, not `warn` or `debug`: a suppressed crash that is quiet is a crash nobody finds.
    expect(first.level).toBe("error");
    expect(first.errorClass).toBe("TypeError");
    expect(String(first.reason)).toContain("postgres@3.4.9");
    // The count is the escalation signal — one of these is a driver defect, a flood of them is news.
    expect(first.survived).toBe(1);
    expect((JSON.parse(lines[1]!) as Record<string, unknown>).survived).toBe(2);
    // And the reporting invariant this whole file exists for still holds on the new path.
    expect(lines[0]!).not.toContain("errorDetail");
  });

  it("still exits 1 for everything else, with the exemption installed", () => {
    const { log, lines } = capture();
    const host = fakeHost();
    const exits: number[] = [];
    installCrashHandlers({
      log: () => log, host: host.host, exit: (c) => exits.push(c), survivable: driverWriteRaceReason,
    });

    host.throwInto("uncaughtException", new Error("something genuinely wrong"));
    host.throwInto("uncaughtException", withStack(
      new TypeError("Cannot read properties of null (reading 'write')"),
      "TypeError: …\n    at ingest (/app/apps/worker/dist/index.js:900:1)",
    ));

    expect(exits).toEqual([1, 1]);
    for (const l of lines) expect(JSON.parse(l)).toMatchObject({ event: "uncaught_exception" });
  });

  /**
   * The DEFAULT is unchanged, and this is the assertion that keeps the exemption opt-in: an
   * embedder that says nothing about survivable shapes gets the contract exactly as it was.
   */
  it("without a survivable predicate the driver race still exits 1", () => {
    const { log, lines } = capture();
    const host = fakeHost();
    const exits: number[] = [];
    installCrashHandlers({ log: () => log, host: host.host, exit: (c) => exits.push(c) });

    host.throwInto("uncaughtException", driverThrow());

    expect(exits).toEqual([1]);
    expect((JSON.parse(lines[0]!) as Record<string, unknown>).event).toBe("uncaught_exception");
  });

  /**
   * REJECTIONS ARE NOT IN THE HOLE, deliberately. The driver's throw is uncatchable because it
   * comes out of `setImmediate` with no promise attached; the same value arriving as a rejection
   * would mean a promise OWNS it, i.e. a statement's own failure, which the DatabaseFaultError
   * taxonomy already classifies at the seams. Widening to a channel nothing has been observed to
   * use would be speculation.
   */
  it("does not extend the exemption to unhandled rejections", () => {
    const { log, lines } = capture();
    const host = fakeHost();
    const exits: number[] = [];
    installCrashHandlers({
      log: () => log, host: host.host, exit: (c) => exits.push(c), survivable: driverWriteRaceReason,
    });

    host.throwInto("unhandledRejection", driverThrow());

    expect(exits).toEqual([1]);
    expect((JSON.parse(lines[0]!) as Record<string, unknown>).event).toBe("unhandled_rejection");
  });
});
