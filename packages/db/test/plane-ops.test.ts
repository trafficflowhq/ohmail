import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePlaneOps, looksLikeAnIdentifier, planeOpsReaderOf,
  PLANE_PASS_NAME_RE, PLANE_ALERT_CODE_RE, PLANE_ERROR_CLASS_RE, PLANE_EVENT_TYPE_RE, PLANE_TIME_RE,
  PLANE_ID_PREFIXES, PLANE_STAGES, PLANE_VERDICTS, PLANE_SEVERITIES, PLANE_PASSES_MAX, PLANE_ALERTS_MAX,
} from "../src/plane-ops.js";
import { UNMETERED, type EntitlementsPort, type PlaneOpsReading } from "../src/entitlements-port.js";

/**
 * THE `/v1/ops` READER, held to the program's wire contract: the example answer reads whole, and one
 * string outside a closed rule refuses the whole answer, naming its path and never its value. A
 * stricter reader pages forever about a healthy plane; a looser one puts an identifier in a pager.
 */
const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "entitlements-port");
type Body = {
  v: unknown; observedAt: unknown; alertsTruncated: unknown;
  passes: Array<Record<string, unknown>>; alerts: Array<Record<string, unknown>>;
  [k: string]: unknown;
};
const example = (): Body => JSON.parse(readFileSync(join(FIXTURES, "ops-200.json"), "utf8")) as Body;
const OBSERVED = new Date("2026-10-19T12:00:00.000Z");
const MIN = 60_000;

/** A uuid and a long run, assembled here so no literal reads like an identifier. */
const UUID = ["a1b2c3d4", "e5f6", "4a7b", "8c9d", "0e1f2a3b4c5d"].join("-");
const LONG_RUN = "Q".repeat(20);

const refusedAt = (mutate: (b: Body) => void, now: Date = OBSERVED): unknown => {
  const b = example();
  mutate(b);
  return parsePlaneOps(b, now);
};

describe("the contract's example answer", () => {
  it("reads whole, and the answer is exactly what was sent", () => {
    expect(parsePlaneOps(example(), OBSERVED)).toEqual(example());
  });

  it("an observedAt inside fifteen minutes either way reads", () => {
    expect(parsePlaneOps(example(), new Date(OBSERVED.getTime() + 14 * MIN))).not.toHaveProperty("bad");
    expect(parsePlaneOps(example(), new Date(OBSERVED.getTime() - 14 * MIN))).not.toHaveProperty("bad");
  });

  it("unknown fields are ignored and never copied, at every level", () => {
    const b = example();
    b.extra = "top";
    b.passes[0]!.extra = "pass";
    b.alerts[0]!.extra = "alert";
    const read = parsePlaneOps(b, OBSERVED);
    expect(read).toEqual(example());
    expect(JSON.stringify(read)).not.toContain("extra");
  });
});

describe("one violation refuses the WHOLE answer, by path and never by value", () => {
  const cases: Array<[string, (b: Body) => void, string, string?]> = [
    ["a digit in a pass name", (b) => { b.passes[0]!.name = "reconcile2"; }, "passes[0].name", "reconcile2"],
    ["@ in a code", (b) => { b.alerts[1]!.key = "apply:Billing@Apply"; }, "alerts[1].key", "Billing@Apply"],
    ["a uuid in a code", (b) => { b.alerts[1]!.key = `apply:BillingApplyError:${UUID}`; }, "alerts[1].key", UUID],
    ["a 20-character run in a code", (b) => { b.alerts[1]!.key = `apply:${LONG_RUN}`; }, "alerts[1].key", LONG_RUN],
    ["a Stripe prefix after a colon", (b) => { b.alerts[1]!.key = "apply:BillingApplyError:cus_ab12"; }, "alerts[1].key", "cus_ab12"],
    ["a Stripe prefix at the code's start", (b) => { b.alerts[1]!.key = "link:sub_x9"; }, "alerts[1].key", "sub_x9"],
    ["an uppercase eventType", (b) => { b.alerts[1]!.eventType = "Invoice.paid"; }, "alerts[1].eventType", "Invoice"],
    ["an identifier-shaped eventType", (b) => { b.alerts[1]!.eventType = "evt_abc"; }, "alerts[1].eventType", "evt_abc"],
    ["/ in lastErrorClass", (b) => { b.passes[0]!.lastErrorClass = "Postgres/Error"; }, "passes[0].lastErrorClass", "Postgres/Error"],
    ["a uuid in lastErrorClass", (b) => { b.passes[0]!.lastErrorClass = `PostgresError:${UUID}`; }, "passes[0].lastErrorClass", UUID],
    ["a time without milliseconds", (b) => { b.passes[0]!.lastDoneAt = "2026-10-19T11:39:00Z"; }, "passes[0].lastDoneAt"],
    ["a time that does not parse", (b) => { b.alerts[0]!.firstAt = "2026-13-40T99:00:00.000Z"; }, "alerts[0].firstAt"],
    ["a negative number", (b) => { b.passes[0]!.ageSeconds = -1; }, "passes[0].ageSeconds"],
    ["a fractional number", (b) => { b.alerts[0]!.count = 1.5; }, "alerts[0].count"],
    ["a count past int4", (b) => { b.alerts[0]!.count = 2 ** 31; }, "alerts[0].count"],
    ["a number sent as a string", (b) => { b.passes[0]!.failureStreak = "0"; }, "passes[0].failureStreak"],
    ["v: 2", (b) => { b.v = 2; }, "v"],
    ["an unknown severity", (b) => { b.alerts[0]!.severity = "urgent"; }, "alerts[0].severity"],
    ["an unknown pass severity", (b) => { b.passes[0]!.severity = "info"; }, "passes[0].severity"],
    ["an unknown verdict", (b) => { b.passes[0]!.lastOutcome = "crashed"; }, "passes[0].lastOutcome"],
    ["an unknown stage", (b) => { b.alerts[1]!.key = "settle:unknown_price"; }, "alerts[1].key"],
    ["a key that is neither special nor staged", (b) => { b.alerts[1]!.key = "unknown_price"; }, "alerts[1].key"],
    ["51 alerts", (b) => {
      b.alerts = Array.from({ length: PLANE_ALERTS_MAX + 1 }, (_, i) => ({ ...b.alerts[1]!, key: `apply:code${String.fromCharCode(97 + (i % 26))}${i}` }));
    }, "alerts"],
    ["a duplicate key", (b) => { b.alerts[1]!.key = "events_failed"; }, "alerts[1].key"],
    ["a duplicate pass", (b) => { b.passes.push({ ...b.passes[0]! }); }, "passes[1].name"],
    ["33 passes", (b) => {
      b.passes = Array.from({ length: PLANE_PASSES_MAX + 1 }, (_, i) => ({ ...b.passes[0]!, name: `pass${"abcdefghijklmnopqrstuvwxyzABCDEFGH"[i]}` }));
    }, "passes"],
    ["empty passes", (b) => { b.passes = []; }, "passes"],
    ["passes that are not a list", (b) => { (b as Record<string, unknown>).passes = {}; }, "passes"],
    ["a nullable field that is absent", (b) => { delete b.passes[0]!.lastErrorClass; }, "passes[0].lastErrorClass"],
    ["a boolean sent as a string", (b) => { b.passes[0]!.stale = "false"; }, "passes[0].stale"],
    ["alertsTruncated missing", (b) => { delete b.alertsTruncated; }, "alertsTruncated"],
  ];
  for (const [name, mutate, path, value] of cases) {
    it(name, () => {
      const read = refusedAt(mutate);
      expect(read).toEqual({ bad: path });
      if (value) expect(JSON.stringify(read), "the refusal carries no value").not.toContain(value);
    });
  }

  it("an observedAt twenty minutes old", () => {
    expect(parsePlaneOps(example(), new Date(OBSERVED.getTime() + 20 * MIN))).toEqual({ bad: "observedAt" });
  });

  it("an observedAt twenty minutes ahead", () => {
    expect(parsePlaneOps(example(), new Date(OBSERVED.getTime() - 20 * MIN))).toEqual({ bad: "observedAt" });
  });

  it("a body that is not an object", () => {
    expect(parsePlaneOps([], OBSERVED)).toEqual({ bad: "body" });
    expect(parsePlaneOps(null, OBSERVED)).toEqual({ bad: "body" });
    expect(parsePlaneOps("ok", OBSERVED)).toEqual({ bad: "body" });
  });
});

describe("POSITIVE CONTROLS — the codes the program publishes are read", () => {
  for (const key of [
    "apply:BillingApplyError:unknown_price", "apply:unnamed", "record:noop_record_failed",
    "apply:BillingApplyError+record_failed", "verify:price_mirror_mismatch", "verify:api_version_mismatch",
    "link:customer_link_conflict", "apply:zero_cash_upgrade_ignored", "events_failed", "unrecorded",
  ]) {
    it(key, () => {
      const b = example();
      b.alerts = [{ ...b.alerts[1]!, key }];
      const read = parsePlaneOps(b, OBSERVED);
      expect(read).not.toHaveProperty("bad");
      expect((read as { alerts: Array<{ key: string }> }).alerts[0]!.key).toBe(key);
    });
  }

  it("the error classes the contract names are read", () => {
    for (const cls of ["PostgresError", "PassBudgetExceeded", "rollup:no_rows", "deadline_exceeded_before_reconcile", "unnamed"]) {
      const b = example();
      b.passes[0]!.lastErrorClass = cls;
      expect(parsePlaneOps(b, OBSERVED), cls).not.toHaveProperty("bad");
    }
  });

  it("every verdict, and null before the first run", () => {
    for (const v of [...PLANE_VERDICTS, null]) {
      const b = example();
      b.passes[0]!.lastOutcome = v;
      expect(parsePlaneOps(b, OBSERVED), String(v)).not.toHaveProperty("bad");
    }
  });

  it("no alerts at all, and a truncated reading", () => {
    const b = example();
    b.alerts = [];
    b.alertsTruncated = true;
    expect(parsePlaneOps(b, OBSERVED)).toMatchObject({ alerts: [], alertsTruncated: true });
  });
});

describe("the closed rules are the contract's own literals", () => {
  it("the four string rules", () => {
    expect(PLANE_PASS_NAME_RE.source).toBe("^[a-zA-Z]{1,40}$");
    expect(PLANE_ALERT_CODE_RE.source).toBe("^[A-Za-z0-9_.:+-]{1,96}$");
    expect(PLANE_ERROR_CLASS_RE.source).toBe("^[A-Za-z0-9_.:-]{1,64}$");
    expect(PLANE_EVENT_TYPE_RE.source).toBe("^[a-z0-9_.]{1,64}$");
    expect(PLANE_TIME_RE.source).toBe("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$");
  });

  it("the id and key prefixes, as the contract lists them", () => {
    expect(PLANE_ID_PREFIXES.join(" ")).toBe(
      "evt_ cus_ sub_ acct_ sk_ rk_ pk_ whsec_ in_ ii_ il_ ch_ pi_ py_ cs_ si_ pm_ re_ dp_ po_ tr_ txn_ src_ tok_ card_ ba_ bpc_ prod_ seti_ cn_");
  });

  it("the closed sets and the bounds", () => {
    expect([...PLANE_STAGES]).toEqual(["verify", "apply", "record", "link"]);
    expect([...PLANE_VERDICTS]).toEqual(["done", "failed", "timed_out", "skipped_locked"]);
    expect([...PLANE_SEVERITIES]).toEqual(["critical", "warning", "signal"]);
    expect(PLANE_ALERTS_MAX).toBe(50);
    expect(PLANE_PASSES_MAX).toBe(32);
  });

  it("an identifier is an address, a uuid, a long run or a prefix at the start or after a non-alphanumeric", () => {
    for (const s of ["a@b", UUID, LONG_RUN, "cus_1", "x:cus_1", "x+sk_1", "x.whsec_1"]) {
      expect(looksLikeAnIdentifier(s), s).toBe(true);
    }
    for (const s of ["BillingApplyError:unknown_price", "noop_record_failed", "price_mirror_mismatch", "Q".repeat(19), "discus_x"]) {
      expect(looksLikeAnIdentifier(s), s).toBe(false);
    }
  });
});

describe("planeOpsReaderOf — a reader only where a metered port can ask", () => {
  it("unmetered: no reader", () => {
    expect(planeOpsReaderOf(UNMETERED)).toBeNull();
  });

  it("a port without readOps: no reader", () => {
    expect(planeOpsReaderOf({} as EntitlementsPort)).toBeNull();
  });

  it("a port with readOps: the reader asks it, once per read", async () => {
    let asked = 0;
    const reading: PlaneOpsReading = { state: "unsupported" };
    const reader = planeOpsReaderOf({ readOps: async () => { asked += 1; return reading; } } as unknown as EntitlementsPort);
    await expect(reader!()).resolves.toEqual(reading);
    expect(asked).toBe(1);
  });
});
