import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { buildDiagnosticBundle, renderDiagnosticBundle } from "../src/diagnostics/index.js";
import { createLogger, storeFaultOf, StoreStatementFaultError } from "../src/log.js";
import { valueFaultOf } from "../src/statement-fault.js";

/**
 * A device store's refusal is named by its SQLite class, and only by that. The Android line is the
 * one the phone wrote on 2026-10-02 (`app.ohmail.rig`, AVD ohmail-f026-onemsg), verbatim; the iOS
 * one is expo-sqlite 57's `convertSqlLiteErrorToString` format, not yet read off a device.
 */
const ANDROID_CHECK = "Call to function 'NativeStatement.runAsync' has been rejected.\n"
  + "→ Caused by: Error code \u0013: CHECK constraint failed: message_bodies_html_cap";
const expo = (message: string) => Object.assign(new Error(message), { code: "ERR_INTERNAL_SQLITE_ERROR" });

function realSqliteCheckFailure(): unknown {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (html TEXT CHECK (length(html) <= 3))");
  try { db.prepare("INSERT INTO t VALUES (?)").run("four"); return null; } catch (e) { return e; } finally { db.close(); }
}

describe("storeFaultOf", () => {
  it("reads Android's raw code byte: 19 is constraint, 13 is full, 5 is busy", () => {
    expect(storeFaultOf(expo(ANDROID_CHECK))).toBe("constraint");
    expect(storeFaultOf(expo("… Caused by: Error code \r: database or disk is full"))).toBe("full");
    expect(storeFaultOf(expo("… Caused by: Error code \u0005: database is locked"))).toBe("busy");
  });

  it("reads iOS's decimal code", () => {
    expect(storeFaultOf(expo("Error code 19: CHECK constraint failed: x"))).toBe("constraint");
    expect(storeFaultOf(expo("Error code 18: string or blob too big"))).toBe("toobig");
  });

  it("reads node:sqlite's extended errcode by its primary class, from a REAL refusal", () => {
    const err = realSqliteCheckFailure() as { code?: string; errcode?: number };
    expect([err.code, err.errcode]).toEqual(["ERR_SQLITE_ERROR", 275]);
    expect(storeFaultOf(err)).toBe("constraint");
  });

  it("walks a wrapper's cause chain, and stops on a cycle", () => {
    const wrapped = new Error("the database failed at repo.commitChange", { cause: expo(ANDROID_CHECK) });
    expect(storeFaultOf(wrapped)).toBe("constraint");
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b", { cause: a });
    a.cause = b;
    expect(storeFaultOf(a)).toBeNull();
  });

  it("answers other for SQLite's own code with no number in it, and null for anything not SQLite's", () => {
    expect(storeFaultOf(expo("Unable to allocate memory for 12 bytes"))).toBe("other");
    expect(storeFaultOf(Object.assign(new Error("Error code 19: x"), { code: "ECONNREFUSED" }))).toBeNull();
    expect(storeFaultOf(new Error("Error code 19: x"))).toBeNull();
    expect(storeFaultOf("Error code 19: x")).toBeNull();
  });
});

describe("the log line carries the class and never the text", () => {
  const lineOf = (fields: Record<string, unknown>): Record<string, unknown> => {
    const out: string[] = [];
    createLogger({ service: "sidecar", sink: (l) => { out.push(l); } }).warn("sync_message_deferred", fields);
    return JSON.parse(out[0]!) as Record<string, unknown>;
  };

  it("a store refusal logs storeFault: constraint beside the driver's code, and none of its words", () => {
    const line = lineOf({ err: expo(ANDROID_CHECK) });
    expect([line.errorCode, line.storeFault]).toEqual(["ERR_INTERNAL_SQLITE_ERROR", "constraint"]);
    expect(JSON.stringify(line)).not.toContain("message_bodies_html_cap");
  });

  it("a payload cannot supply storeFault, and a non-store error carries none", () => {
    const spoof = lineOf({ err: new Error("x"), storeFault: "full" });
    expect(spoof.storeFault).toBeUndefined();
    expect(spoof.droppedFields).toEqual(["storeFault"]);
  });
});

describe("the diagnostic file a person sends keeps the class", () => {
  const INSTALL = { id: "0123456789abcdef0123456789abcdef", mintedAt: "2026-09-20T00:00:00.000Z" };
  const fileOf = (log: string[]) => {
    const bundle = buildDiagnosticBundle({
      surface: "phone", now: new Date("2026-10-02T05:00:00.000Z"), build: { version: "0.25.10", commit: "dev" },
      platform: { os: "android" }, install: INSTALL, log,
    });
    const section = bundle.sections.find((s) => s.k === "log")!;
    return { file: renderDiagnosticBundle(bundle), first: section.k === "log" ? section.lines[0] : undefined };
  };

  it("the logger's own line reaches the file with storeFault, and none of the driver's words", () => {
    const out: string[] = [];
    createLogger({ service: "sidecar", sink: (l) => { out.push(l); } }).warn("sync_message_deferred", { err: expo(ANDROID_CHECK) });
    const { file, first } = fileOf(out);
    expect(first?.shape === "event" && first.labels.storeFault).toBe("constraint");
    expect(file).toContain('"storeFault": "constraint"');
    expect(file).not.toContain("message_bodies_html_cap");
  });

  it("a value outside the label grammar is dropped, as every label's is", () => {
    const line = JSON.stringify({ ts: "2026-10-02T04:00:00.000Z", level: "warn", service: "sidecar", event: "x", storeFault: "CHECK constraint failed: t" });
    const { first } = fileOf([line]);
    expect(first?.shape === "event" && first.labels).toEqual({});
  });
});

/**
 * WHOSE A REFUSED STATEMENT IS: the value it carried, by its class (a writer may keep a letter
 * without one row for it), or the store's own (never: the letter's transaction must fail). The
 * worker's ingest classifier reads the same classes.
 */
describe("valueFaultOf", () => {
  const pg = (code: string, routine?: string) => Object.assign(new Error(`postgres ${code}`), { code, ...(routine ? { routine } : {}) });

  it("a value Postgres refused names its word: a data exception, a constraint, a limit of one statement", () => {
    expect(valueFaultOf(pg("22021"))).toBe("data_exception");
    expect(valueFaultOf(pg("23505"))).toBe("constraint_violation");
    expect(valueFaultOf(pg("54000", "_bt_check_third_page"))).toBe("data_too_large");
    expect(valueFaultOf(Object.assign(new Error("over the bind limit"), { code: "OHMAIL_BIND_LIMIT" }))).toBe("data_too_large");
  });

  it("the store's own fault is no value's: a lock wait cut short, a deadlock, a cancel, a lost connection, our own code", () => {
    for (const code of ["55P03", "40P01", "40001", "57014", "08006", "53100", "XX000", "CONNECTION_ENDED"]) expect(valueFaultOf(pg(code)), code).toBeNull();
    expect(valueFaultOf(pg("54000", "a routine nobody has seen"))).toBeNull();
    expect(valueFaultOf(new TypeError("x is undefined"))).toBeNull();
    expect(valueFaultOf("a string")).toBeNull();
  });

  it("a device store's refusal by its class, through the store's mark: a constraint is the value's, busy and full are the store's", () => {
    expect(valueFaultOf(realSqliteCheckFailure())).toBe("constraint_violation");
    expect(valueFaultOf(new StoreStatementFaultError("store.run", expo(ANDROID_CHECK)))).toBe("constraint_violation");
    expect(valueFaultOf(new StoreStatementFaultError("store.run", expo("… Caused by: Error code \u0005: database is locked")))).toBeNull();
    expect(valueFaultOf(expo("… Caused by: Error code \r: database or disk is full"))).toBeNull();
    expect(valueFaultOf(new StoreStatementFaultError("store.run", Object.assign(new Error("bad bind"), { code: "ERR_INVALID_ARG_TYPE" })))).toBe("unclassified");
    expect(valueFaultOf(new StoreStatementFaultError("store.run", pg("22P02")))).toBe("data_exception");
  });
});
