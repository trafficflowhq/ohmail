import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeEntitlementsClient, ENTITLEMENTS_CALL_BUDGET_MS, PRICE_PROBE_ACCOUNT, PRICE_PROBE_BUDGET_MS,
  ACCESS_FAULT_HOLD_MS, ACCESS_REFUSED_TTL_MS, ACCESS_STALE_ALLOW_MS, ACCESS_TTL_MS,
  type CallFault, type ContractFault, type EntitlementsFetch, type EntitlementsPath, type UsageUnrecorded,
} from "../src/entitlements-client.js";
import {
  UNMETERED, UNMETERED_ACCESS, accessOf, isMetered, pricingOf, aiUsageLineOf, type AiUsageLine,
} from "../src/entitlements-port.js";
import { DEFAULT_ALERT_THRESHOLDS } from "../src/alerts.js";

/**
 * THE ENTITLEMENTS CLIENT, against the program's OWN contract bodies.
 *
 * The answers below are read from `test/fixtures/entitlements-port/`, which is copied out of the
 * program's `docs/PORT-CONTRACT.md` with its commit recorded beside it. Pinning against a
 * paraphrase would let the two sides drift while this file stayed green — the failure the fixtures
 * exist to make impossible.
 *
 * No test dials anything: `fetchImpl` is injected everywhere.
 */

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "entitlements-port");
/** One body, as the program sends it. Parsed here so a malformed fixture fails loudly. */
const wire = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

const ACC = "11111111-1111-4111-8111-111111111111";

/** A fetch that answers a queued list of exchanges, and records every path it was asked for. */
function fakeFetch(answers: Array<{ status: number; body?: unknown; throws?: boolean }>): {
  impl: EntitlementsFetch; paths: string[]; bodies: string[];
} {
  const paths: string[] = [];
  const bodies: string[] = [];
  let i = 0;
  const impl: EntitlementsFetch = async (url, init) => {
    paths.push(new URL(url).pathname);
    bodies.push(init.body);
    const a = answers[Math.min(i++, answers.length - 1)]!;
    if (a.throws) throw new Error("network down");
    return { status: a.status, json: async () => a.body };
  };
  return { impl, paths, bodies };
}

const client = (
  answers: Array<{ status: number; body?: unknown; throws?: boolean }>,
  over: {
    ttlMs?: number; now?: () => number; budgetsMs?: Partial<Record<EntitlementsPath, number>>;
  } = {},
) => {
  const f = fakeFetch(answers);
  /* Every drift the client meets, recorded — a silent degrade is the failure the report exists
     for, so the cases assert what was reported as well as what was answered. */
  const faults: ContractFault[] = [];
  /* And every call the program did not answer 200 to. Captured rather than left to the default
     `console.warn`, which would otherwise print through the whole of this file. */
  const calls: CallFault[] = [];
  return {
    ...f,
    faults,
    calls,
    port: makeEntitlementsClient({
      baseUrl: "https://entitlements.example/", secret: "x".repeat(24),
      fetchImpl: f.impl, onContractFault: (x) => { faults.push(x); },
      onCallFault: (x) => { calls.push(x); }, ...over,
    }),
  };
};

describe("the client refuses to be constructed without its configuration", () => {
  /* FAIL CLOSED, AND THE REASON IS THE FAIL-OPEN BELOW: a client with an empty base URL would
   * fault on every call and then answer ALLOW by design — an unmetered deployment wearing a
   * metered one's clothes, with nothing in any log to say so. */
  it("no base URL", () => {
    expect(() => makeEntitlementsClient({ onCallFault: "unrecorded", baseUrl: "", secret: "x".repeat(24) }))
      .toThrow(/ENTITLEMENTS_URL is required/);
  });

  it("a relative base URL", () => {
    expect(() => makeEntitlementsClient({ onCallFault: "unrecorded", baseUrl: "/v1", secret: "x".repeat(24) }))
      .toThrow(/absolute http\(s\) URL/);
  });

  it("no secret", () => {
    expect(() => makeEntitlementsClient({ onCallFault: "unrecorded", baseUrl: "https://e.example", secret: "  " }))
      .toThrow(/BILLING_PLANE_SECRET is required/);
  });

  /* THE POSITIVE CONTROL — without it every case above passes for a constructor that refuses
   * everything, and an operator with a correct environment would have no client at all. */
  it("admits a complete configuration, and dials nothing while constructing", () => {
    const f = fakeFetch([]);
    const port = makeEntitlementsClient({
      onCallFault: "unrecorded", baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: f.impl,
    });
    expect(typeof port.access).toBe("function");
    expect(f.paths).toEqual([]);
  });
});

describe("access — the program's own body, and what the open side derives from it", () => {
  it("the contract's active example is a permitted verdict with its four limits", async () => {
    const c = client([{ status: 200, body: wire("access-200-active") }]);
    await expect(c.port.access(ACC)).resolves.toEqual({
      ok: true,
      limits: { mailboxes: 5, storageBytes: 5_000_000_000, canAddMailbox: true, aiEnabled: true },
      lifecycle: {
        state: "active", closedReason: null, trialEndsAt: null, graceUntil: null,
        closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: true,
        lifecycleEpoch: "2026-09-22T00:00:00.000Z",
      },
      prices: { classify_ingest: 1, screener: 1, draft: 15, propose: 20, workflow: 15 },
    });
    expect(c.paths).toEqual(["/v1/access"]);
    expect(JSON.parse(c.bodies[0]!)).toEqual({ accountId: ACC });
    expect(c.faults).toEqual([]);
  });

  it("THE REFUSAL IS `syncEnabled === false`, which is the contract's own derivation", async () => {
    // The program deliberately sends the full entitlement rather than an ok/refused pair, because
    // `reason`, `syncEnabled` and `canAddMailbox` are three different questions. This is the one
    // the access screen is about.
    const body = wire("access-200-active") as { entitlements: Record<string, unknown> };
    body.entitlements.syncEnabled = false;
    body.entitlements.reason = "unpaid";
    const c = client([{ status: 200, body }]);
    const v = await c.port.access(ACC);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toBe("payment_required");
    expect(!v.ok && v.manageUrl).toBe("https://account.ohmail.app/manage?token=…");
  });

  it("a suspension is its own sentence; the other eight reasons are the paying one", async () => {
    for (const [reason, expected] of [
      ["suspended", "suspended"],
      ["no_subscription", "payment_required"], ["past_due", "payment_required"],
      ["unpaid", "payment_required"], ["canceled", "payment_required"],
      ["paused", "payment_required"], ["trialing", "payment_required"],
      ["past_due_grace", "payment_required"], ["ai_disabled", "payment_required"],
    ] as Array<[string, string]>) {
      const body = wire("access-200-active") as { entitlements: Record<string, unknown> };
      body.entitlements.syncEnabled = false;
      body.entitlements.reason = reason;
      const c = client([{ status: 200, body }]);
      const v = await c.port.access(ACC);
      expect(v.ok, reason).toBe(false);
      expect(!v.ok && v.reason, reason).toBe(expected);
    }
  });

  it("`canAddMailbox: false` on a SYNCING account is not a refusal — it is a limit", async () => {
    // The distinction the contract draws by name: an account may keep what it has and be
    // forbidden another. Rendering the lock screen for it would take the mail away too.
    const body = wire("access-200-active") as { entitlements: Record<string, unknown> };
    body.entitlements.canAddMailbox = false;
    const c = client([{ status: 200, body }]);
    const v = await c.port.access(ACC);
    expect(v.ok).toBe(true);
    expect(v.ok && v.limits.canAddMailbox).toBe(false);
  });

  it("an unbounded plan's nulls survive the mapping", async () => {
    const body = wire("access-200-active") as { entitlements: Record<string, unknown> };
    body.entitlements.mailboxLimit = null;
    body.entitlements.storageBytesLimit = null;
    const c = client([{ status: 200, body }]);
    const v = await c.port.access(ACC);
    expect(v.ok && v.limits.mailboxes).toBeNull();
    expect(v.ok && v.limits.storageBytes).toBeNull();
  });

  it("a null `manageUrl` is an ANSWER — no row rather than a dead one", async () => {
    const body = wire("access-200-active") as Record<string, unknown> & { entitlements: Record<string, unknown> };
    body.entitlements.syncEnabled = false;
    body.manageUrl = null;
    const c = client([{ status: 200, body }]);
    const v = await c.port.access(ACC);
    expect(v).toMatchObject({ ok: false, reason: "payment_required" });
    expect(!v.ok && v.manageUrl).toBeUndefined();
    expect(c.faults).toEqual([]);
  });
});

describe("access — the lifecycle block (wire contract v1 + the wall, 2026-09-20)", () => {
  /* The six states the program derives, each read from its own contract body. The block rides
     BOTH verdict arms: grace and past_due are `ok: true` beside their deadline, closed and
     erased ride the refusal beside their dates. */
  it("trialing rides ok:true with its trial end", async () => {
    const c = client([{ status: 200, body: wire("access-200-trialing") }]);
    const v = await c.port.access(ACC);
    expect(v.ok).toBe(true);
    expect(v.lifecycle).toEqual({
      state: "trialing", closedReason: null, trialEndsAt: "2026-09-15T00:00:00.000Z",
      graceUntil: null, closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: false,
      lifecycleEpoch: "2026-09-22T00:00:00.000Z",
    });
    expect(c.faults).toEqual([]);
  });

  it("grace rides ok:true with its deadline — sync still runs", async () => {
    const c = client([{ status: 200, body: wire("access-200-grace") }]);
    const v = await c.port.access(ACC);
    expect(v.ok).toBe(true);
    expect(v.lifecycle?.state).toBe("grace");
    expect(v.lifecycle?.graceUntil).toBe("2026-09-16T00:00:00.000Z");
  });

  it("past_due rides ok:true with dunning's grace_until", async () => {
    const c = client([{ status: 200, body: wire("access-200-past-due") }]);
    const v = await c.port.access(ACC);
    expect(v.ok).toBe(true);
    expect(v.lifecycle?.state).toBe("past_due");
    expect(v.lifecycle?.graceUntil).toBe("2026-09-27T00:00:00.000Z");
  });

  it("active carries the block with every date null", async () => {
    const c = client([{ status: 200, body: wire("access-200-active") }]);
    const v = await c.port.access(ACC);
    expect(v.ok).toBe(true);
    expect(v.lifecycle?.state).toBe("active");
    expect(v.lifecycle?.formerlyPaid).toBe(true);
  });

  it("closed rides the refusal with its closedAt and erasure forecast", async () => {
    const c = client([{ status: 200, body: wire("access-200-closed-trial-ended") }]);
    const v = await c.port.access(ACC);
    expect(v.ok).toBe(false);
    // The contract's own pre-epoch body: closed 2026-09-16 against a program live on 09-22, so
    // the forecast starts at the epoch and `closedAt` is untouched.
    expect(v.lifecycle).toEqual({
      state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
      closedAt: "2026-09-16T00:00:00.000Z", erasureAt: "2026-10-22T00:00:00.000Z",
      erasedAt: null, formerlyPaid: false, lifecycleEpoch: "2026-09-22T00:00:00.000Z",
    });
  });

  it("erased rides the refusal; the forecast is over and erasedAt is the fact", async () => {
    const c = client([{ status: 200, body: wire("access-200-erased") }]);
    const v = await c.port.access(ACC);
    expect(v.ok).toBe(false);
    expect(v.lifecycle?.state).toBe("erased");
    expect(v.lifecycle?.erasureAt).toBeNull();
    expect(v.lifecycle?.erasedAt).toBe("2026-09-14T00:00:00.000Z");
  });

  it("a program that states NO epoch carries no key — absent is not a null here either", async () => {
    // The field is optional on the wire. A program that omits it is an older one, and the open
    // side must be able to tell that apart from a program that stated one: the key is dropped
    // rather than carried as null, so "absent" survives the parse.
    const body = wire("access-200-closed-trial-ended") as { lifecycle: Record<string, unknown> };
    delete body.lifecycle.lifecycleEpoch;
    const c = client([{ status: 200, body }]);
    const v = await c.port.access(ACC);
    expect(v.lifecycle).toBeDefined();
    expect("lifecycleEpoch" in (v.lifecycle as object)).toBe(false);
    expect(v.lifecycle?.erasureAt).toBe("2026-10-22T00:00:00.000Z");
    expect(c.faults).toEqual([]);
  });

  it("an epoch that is not a string is drift, named by field like every other date", async () => {
    const body = wire("access-200-closed-trial-ended") as { lifecycle: Record<string, unknown> };
    body.lifecycle.lifecycleEpoch = 1790000000000;
    const c = client([{ status: 200, body }]);
    const v = await c.port.access(ACC);
    // The existing fault arm: the whole body is refused and the verdict falls back, never a
    // lockout invented from a drift.
    expect(c.faults.map((f) => f.field)).toContain("lifecycle.lifecycleEpoch");
  });

  it("an ABSENT block is an old program: today's verdict, unchanged, no lifecycle key", async () => {
    const body = wire("access-200-active") as Record<string, unknown>;
    delete body.lifecycle;
    const c = client([{ status: 200, body }]);
    const v = await c.port.access(ACC);
    expect(v.ok).toBe(true);
    expect("lifecycle" in v).toBe(false);
    expect(c.faults).toEqual([]);
  });

  it("closed|erased beside syncEnabled:true is the contradiction the truth table pins — " +
     "a NAMED drift through the fault arm, never a lockout invented from it", async () => {
    for (const state of ["closed", "erased"] as const) {
      const body = wire("access-200-closed-trial-ended") as Record<string, unknown> & {
        entitlements: Record<string, unknown>; lifecycle: Record<string, unknown>;
      };
      body.entitlements.syncEnabled = true;
      body.lifecycle.state = state;
      const c = client([{ status: 200, body }]);
      // No held verdict, so the fault arm answers ALLOW — the drift is reported, not obeyed.
      await expect(c.port.access(ACC)).resolves.toEqual(UNMETERED_ACCESS);
      expect(c.faults).toEqual([{ path: "/v1/access", status: 200, field: "lifecycle.state" }]);
    }
  });

  it("an unknown state is the same named drift: last verdict else allow", async () => {
    const good = wire("access-200-active");
    const bad = wire("access-200-active") as Record<string, unknown> & { lifecycle: Record<string, unknown> };
    bad.lifecycle.state = "parked";
    // First a good answer (cached), then the drift: the held verdict is what answers.
    const c = client([{ status: 200, body: good }, { status: 200, body: bad }], { ttlMs: 0 });
    const first = await c.port.access(ACC);
    expect(first.ok).toBe(true);
    const second = await c.port.access(ACC);
    expect(second).toEqual(first);
    expect(c.faults).toEqual([{ path: "/v1/access", status: 200, field: "lifecycle.state" }]);
  });

  it("the block rides the cache entry: one dial, two answers carrying it", async () => {
    const c = client([{ status: 200, body: wire("access-200-grace") }]);
    const first = await c.port.access(ACC);
    const second = await c.port.access(ACC);
    expect(c.paths).toEqual(["/v1/access"]);
    expect(second).toEqual(first);
    expect(second.lifecycle?.state).toBe("grace");
  });
});

describe("A 200 NOBODY CAN PARSE IS A FAULT, REPORTED BY NAME — never a silent allow", () => {
  /* The drift the two sides can grow: a renamed field, a proxy rewriting a body. Reading it as
   * "no verdict, therefore fine" is metering that has stopped applying with nothing in any log. */
  for (const [field, mutate] of [
    ["entitlements", (b: Record<string, unknown>) => { delete b.entitlements; }],
    ["entitlements.syncEnabled", (b: Record<string, unknown>) => {
      delete (b.entitlements as Record<string, unknown>).syncEnabled;
    }],
    ["entitlements.canAddMailbox", (b: Record<string, unknown>) => {
      (b.entitlements as Record<string, unknown>).canAddMailbox = "yes";
    }],
    ["entitlements.aiEnabled", (b: Record<string, unknown>) => {
      delete (b.entitlements as Record<string, unknown>).aiEnabled;
    }],
    ["entitlements.mailboxLimit", (b: Record<string, unknown>) => {
      (b.entitlements as Record<string, unknown>).mailboxLimit = "five";
    }],
    ["entitlements.storageBytesLimit", (b: Record<string, unknown>) => {
      (b.entitlements as Record<string, unknown>).storageBytesLimit = "lots";
    }],
    ["body", () => { /* replaced below */ }],
  ] as Array<[string, (b: Record<string, unknown>) => void]>) {
    it(`names \`${field}\` and takes the fault path`, async () => {
      const body = field === "body" ? ["not", "an", "object"] : wire("access-200-active");
      if (field !== "body") mutate(body as Record<string, unknown>);
      const c = client([{ status: 200, body }]);
      await expect(c.port.access(ACC)).resolves.toEqual(UNMETERED_ACCESS);
      expect(c.faults).toEqual([{ path: "/v1/access", status: 200, field }]);
    });
  }

  it("the fault path after a refusal is the REFUSAL it last knew, not allow", async () => {
    let t = 0;
    const refused = wire("access-200-active") as { entitlements: Record<string, unknown> };
    refused.entitlements.syncEnabled = false;
    const broken = wire("access-200-active") as { entitlements: Record<string, unknown> };
    delete broken.entitlements.syncEnabled;
    const c = client([{ status: 200, body: refused }, { status: 200, body: broken }],
      { ttlMs: 1, now: () => t });
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    t += 10;
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    expect(c.faults.map((f) => f.field)).toEqual(["entitlements.syncEnabled"]);
  });

  it("a refusal a fault holds answers for the hold's length, one call budget, and no longer", async () => {
    let t = 0;
    const refused = wire("access-200-active") as { entitlements: Record<string, unknown> };
    refused.entitlements.syncEnabled = false;
    const c = client([{ status: 200, body: refused }, { status: 503, body: { error: "down" } }], { now: () => t });
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    t += ACCESS_REFUSED_TTL_MS + 1;
    await expect(c.port.access(ACC), "the fault answered something but the held refusal").resolves.toMatchObject({ ok: false });
    expect(c.paths).toHaveLength(2);
    t += 4_000;                                      // the ruled 5 s written out, never read off the constant
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    expect(c.paths, "a read inside the hold dialled the faulting program").toHaveLength(2);
    t += 2_000;
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    expect(c.paths, "the hold outlived one call budget").toHaveLength(3);
  });

  it("400, 401 and 503 are NOT drift — the contract says they are not verdicts", async () => {
    // Reporting them as drift would fire the alarm on an expired secret and a restart, which is
    // how a report that fires on innocent content gets muted.
    for (const status of [400, 401, 503]) {
      const c = client([{ status, body: { error: "whatever" } }]);
      await expect(c.port.access(ACC)).resolves.toEqual(UNMETERED_ACCESS);
      expect(c.faults, String(status)).toEqual([]);
    }
  });

  it("a timeout and a non-JSON body are not drift either", async () => {
    const t = client([{ status: 0, throws: true }]);
    await expect(t.port.access(ACC)).resolves.toEqual(UNMETERED_ACCESS);
    expect(t.faults).toEqual([]);

    const f: EntitlementsFetch = async () => ({
      status: 200, json: async () => { throw new Error("<html>gateway</html>"); },
    });
    const faults: ContractFault[] = [];
    const port = makeEntitlementsClient({
      onCallFault: "unrecorded", baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: f,
      onContractFault: (x) => { faults.push(x); },
    });
    await expect(port.access(ACC)).resolves.toEqual(UNMETERED_ACCESS);
    // A 200 that is not JSON IS drift: the program promised JSON on every answer.
    expect(faults).toEqual([{ path: "/v1/access", status: 200, field: "body" }]);
  });

  it("a reporter that throws does not replace the answer with its own failure", async () => {
    const f = fakeFetch([{ status: 200, body: {} }]);
    const port = makeEntitlementsClient({
      onCallFault: "unrecorded", baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: f.impl,
      onContractFault: () => { throw new Error("the sink is broken"); },
    });
    await expect(port.access(ACC)).resolves.toEqual(UNMETERED_ACCESS);
  });
});

describe("access — the TTL cache", () => {
  it("a fresh verdict is reused without a second call", async () => {
    let t = 1_000;
    const c = client([{ status: 200, body: wire("access-200-active") }], { ttlMs: 60_000, now: () => t });
    await c.port.access(ACC);
    t += 59_000;
    await c.port.access(ACC);
    expect(c.paths).toEqual(["/v1/access"]);        // one dial, two asks
  });

  it("an expired verdict is re-read", async () => {
    let t = 1_000;
    const c = client([{ status: 200, body: wire("access-200-active") }], { ttlMs: 60_000, now: () => t });
    await c.port.access(ACC);
    t += 60_001;
    await c.port.access(ACC);
    expect(c.paths).toEqual(["/v1/access", "/v1/access"]);
  });

  it("nothing is cached from an unparseable answer — it is held as a fault, then re-asked", async () => {
    let t = 0;
    const c = client([{ status: 200, body: {} }], { ttlMs: 60_000, now: () => t });
    await c.port.access(ACC);
    t += ACCESS_FAULT_HOLD_MS - 1;
    await c.port.access(ACC);
    expect(c.paths).toEqual(["/v1/access"]);
    // Past the hold and far inside the TTL: re-asked, so the answer was never cached.
    t += 1;
    await c.port.access(ACC);
    expect(c.paths).toEqual(["/v1/access", "/v1/access"]);
  });

  it("`fresh` SKIPS the held verdict — a cached refusal must not outlive its cause", async () => {
    // WHY THIS FLAG EXISTS. An account was refused once, the verdict was held, and the refusal
    // went on being served for the rest of its minute — long enough to be turned into a payment
    // demand by a caller asking whether the refusal it had just been handed was trustworthy.
    // That caller is the only one that passes `fresh`, and this is the read it needs.
    let t = 1_000;
    const refused = wire("access-200-active") as { entitlements: Record<string, unknown> };
    refused.entitlements.syncEnabled = false;
    refused.entitlements.reason = "unpaid";
    const c = client(
      [{ status: 200, body: refused }, { status: 200, body: wire("access-200-active") }],
      { ttlMs: 60_000, now: () => t },
    );
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    t += 1_000;                                   // WELL inside the TTL
    // The ordinary read still reuses it — the control on the line below, and the property the
    // cache exists for: this must not become a dial per request on the mail path.
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    expect(c.paths).toEqual(["/v1/access"]);
    // And the one caller that may not read a held refusal asks again, and gets the truth.
    await expect(c.port.access(ACC, { fresh: true })).resolves.toMatchObject({ ok: true });
    expect(c.paths).toEqual(["/v1/access", "/v1/access"]);
  });

  it("a `fresh` read that FAULTS still answers the held verdict — not an invented allow", async () => {
    // `fresh` skips the REUSE, never the fault arm: "we could not ask again" is not evidence
    // that the last answer was wrong, and answering UNMETERED_ACCESS here would clear a refusal
    // with nothing at all.
    let t = 1_000;
    const refused = wire("access-200-active") as { entitlements: Record<string, unknown> };
    refused.entitlements.syncEnabled = false;
    refused.entitlements.reason = "unpaid";
    const c = client([{ status: 200, body: refused }, { throws: true, status: 0 }], { now: () => t });
    await c.port.access(ACC);
    await expect(c.port.access(ACC, { fresh: true })).resolves.toMatchObject({ ok: false });
  });

  it("a REFUSAL is asked again after five seconds, an allow after a minute — the person may have just paid", async () => {
    let t = 1_000;
    const refused = wire("access-200-active") as { entitlements: Record<string, unknown> };
    refused.entitlements.syncEnabled = false;
    refused.entitlements.reason = "canceled";
    const c = client(
      [{ status: 200, body: refused }, { status: 200, body: wire("access-200-active") }],
      { ttlMs: ACCESS_TTL_MS, now: () => t },
    );
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    t += ACCESS_REFUSED_TTL_MS - 1;
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    expect(c.paths, "inside five seconds the refusal is reused").toHaveLength(1);
    t += 1;
    await expect(c.port.access(ACC), "the payment is seen at the next read").resolves.toMatchObject({ ok: true });
    expect(c.paths).toHaveLength(2);
    // …and the ALLOW keeps its minute: the mail path does not dial per request.
    t += ACCESS_TTL_MS - 1;
    await c.port.access(ACC);
    expect(c.paths).toHaveLength(2);
  });

  it("fifty readers of a refused account past its five seconds make ONE call", async () => {
    let t = 1_000;
    const refused = wire("access-200-active") as { entitlements: Record<string, unknown> };
    refused.entitlements.syncEnabled = false;
    refused.entitlements.reason = "canceled";
    const c = client([{ status: 200, body: refused }], { ttlMs: ACCESS_TTL_MS, now: () => t });
    await c.port.access(ACC);
    t += ACCESS_REFUSED_TTL_MS;
    await Promise.all(Array.from({ length: 50 }, () => c.port.access(ACC)));
    expect(c.paths).toHaveLength(2);
  });

  it("the cache is per account", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const c = client([{ status: 200, body: wire("access-200-active") }]);
    await c.port.access(ACC);
    await c.port.access(other);
    expect(c.bodies.map((b) => JSON.parse(b).accountId)).toEqual([ACC, other]);
  });
});

describe("spend — all five of the program's verdicts, from its own bodies", () => {
  it("`ok` carries the attempt a reversal will name", async () => {
    const c = client([{ status: 200, body: wire("spend-200-ok") }]);
    await expect(c.port.spend(ACC, "classify_ingest", "m1")).resolves.toEqual({
      verdict: "ok", charged: true, attempt: "classify:<id>",
    });
    expect(JSON.parse(c.bodies[0]!)).toEqual({
      accountId: ACC, action: "classify_ingest", attemptKey: "m1",
    });
  });

  it("`duplicate` is proceed-and-free, and carries the attempt too", async () => {
    const c = client([{ status: 200, body: wire("spend-200-duplicate") }]);
    await expect(c.port.spend(ACC, "screener", "m1")).resolves.toEqual({
      verdict: "duplicate", charged: false, attempt: "classify:<id>",
    });
  });

  it("`insufficient` and `refused` are DIFFERENT answers, and stay different", async () => {
    // Folded together, a funded account whose owner switched AI off is asked to pay.
    const i = client([{ status: 200, body: wire("spend-200-insufficient") }]);
    await expect(i.port.spend(ACC, "draft", "d1")).resolves.toEqual({
      verdict: "insufficient", reason: "out_of_credits",
    });
    const r = client([{ status: 200, body: wire("spend-200-refused") }]);
    await expect(r.port.spend(ACC, "draft", "d1")).resolves.toEqual({
      verdict: "refused", reason: "past_due",
    });
  });

  it("`inflight` is NOT a duplicate — it is the claim, and the caller must not proceed", async () => {
    // Answering `duplicate` here tells the loser of a race to proceed, buying a second paid model
    // call for one credit. That is the whole purpose of the exclusive claim.
    const c = client([{ status: 200, body: wire("spend-200-inflight") }]);
    const out = await c.port.spend(ACC, "screener", "m1");
    expect(out).toEqual({ verdict: "inflight", source: "classify:<id>" });
    expect(out.verdict).not.toBe("duplicate");
  });

  it("a verdict outside the five, or a missing field, is drift AND a fault", async () => {
    for (const [field, body] of [
      ["verdict", { verdict: "maybe" }],
      ["verdict", {}],
      ["attempt", { verdict: "ok", charged: true }],
      ["reason", { verdict: "insufficient" }],
      ["source", { verdict: "inflight" }],
      ["body", "a string"],
    ] as Array<[string, unknown]>) {
      const c = client([{ status: 200, body }]);
      await expect(c.port.spend(ACC, "draft", "d1")).resolves.toEqual({ verdict: "fault" });
      expect(c.faults.map((f) => f.field), JSON.stringify(body)).toEqual([field]);
    }
  });

  it("a non-200 is a fault and NOT drift — `fault` is never a 200 body", async () => {
    for (const status of [400, 401, 503]) {
      const c = client([{ status, body: wire("spend-200-ok") }]);
      await expect(c.port.spend(ACC, "draft", "d1")).resolves.toEqual({ verdict: "fault" });
      expect(c.faults, String(status)).toEqual([]);
    }
    const dead = client([{ status: 0, throws: true }]);
    await expect(dead.port.spend(ACC, "draft", "d1")).resolves.toEqual({ verdict: "fault" });
  });
});

describe("spend/release — the claim, and the refund, are two different calls", () => {
  it("sends the action, the key, the ATTEMPT and the refund flag", async () => {
    const c = client([{ status: 200, body: wire("spend-release-200") }]);
    await c.port.release(ACC, {
      action: "workflow", attemptKey: "r1:0", attempt: "workflow:r1:0~2", refund: true,
    });
    expect(c.paths).toEqual(["/v1/spend/release"]);
    expect(JSON.parse(c.bodies[0]!)).toEqual({
      accountId: ACC, action: "workflow", attemptKey: "r1:0",
      attempt: "workflow:r1:0~2", refund: true,
    });
  });

  it("`refund: false` is the delivered case — the charge stands", async () => {
    const c = client([{ status: 200, body: wire("spend-release-200") }]);
    // No `attempt`: a delivered release reverses nothing, and the union makes naming one here
    // unrepresentable — the program defaults a missing attempt to the bare source, so sending
    // one would put a neighbour's attempt into a request that must reverse nothing.
    await c.port.release(ACC, { action: "propose", attemptKey: "p1", refund: false });
    expect(JSON.parse(c.bodies[0]!).refund).toBe(false);
  });

  it("never throws, and SAYS whether the program took it", async () => {
    // It used to resolve to `undefined` on all three, which is how a lost refund became
    // invisible: "the credits are back" and "the credits are gone" were one value at every call
    // site. The subject of this case is still that it never THROWS — a rejection here would move
    // the mapping outwards to callers that all have a degrade arm — and the receipt is the part
    // that has a new consumer: the drafting path writes a durable obligation on `unreachable`
    // (cloud 0036) and settles it on `settled`.
    const arms = [
      [{ status: 200 }, "settled"],
      [{ status: 503 }, "unreachable"],
      [{ status: 0, throws: true }, "unreachable"],
    ] as const;
    for (const [a, receipt] of arms) {
      const c = client([a]);
      await expect(c.port.release(ACC, {
        action: "draft", attemptKey: "d1", attempt: "draft:d1", refund: true,
      })).resolves.toBe(receipt);
    }
  });
});

describe("usage — rides a release or its own POST, and never costs the release", () => {
  const REPORT = {
    model: "claude-haiku-4-5-20251001", ok: true, status: 200, latencyMs: 812, attempts: 1,
    requestId: "req_x", inputTokens: 516, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0,
    thinkingTokens: null, costMicroUsd: 766,
  };
  const line = (accountId = ACC): AiUsageLine =>
    aiUsageLineOf(REPORT, { accountId, action: "screener", host: "api" }, new Date("2026-09-28T20:00:00.000Z"));
  const usageClient = (answers: Array<{ status: number; body?: unknown; throws?: boolean }>) => {
    const f = fakeFetch(answers);
    const unrecorded: UsageUnrecorded[] = [];
    const port = makeEntitlementsClient({
      baseUrl: "https://entitlements.example/", secret: "x".repeat(24), fetchImpl: f.impl,
      onContractFault: () => {}, onCallFault: () => {}, onUsageUnrecorded: (x) => { unrecorded.push(x); },
    });
    return { ...f, port, unrecorded };
  };

  it("a line copies the counts and nothing else: no request id, no cost estimate", () => {
    expect(line()).toEqual({
      accountId: ACC, action: "screener", host: "api", model: "claude-haiku-4-5-20251001",
      at: "2026-09-28T20:00:00.000Z", ok: true, attempts: 1, inputTokens: 516, outputTokens: 50,
      cacheReadTokens: 0, cacheWriteTokens: 0, thinkingTokens: null,
    });
  });

  it("a release carries its lines, and a 200 naming `usageRecorded` reports nothing", async () => {
    const c = usageClient([{ status: 200, body: { released: true, refunded: false, usageRecorded: 1 } }]);
    await expect(c.port.release(ACC, { action: "screener", attemptKey: "m1", refund: false, usage: [line()] }))
      .resolves.toBe("settled");
    expect(JSON.parse(c.bodies[0]!).usage).toEqual([line()]);
    expect(c.unrecorded).toEqual([]);
  });

  it("an older program answers 200 without `usageRecorded`: the release settles and the loss is SAID", async () => {
    const c = usageClient([{ status: 200, body: { released: true, refunded: false } }]);
    await expect(c.port.release(ACC, { action: "screener", attemptKey: "m1", refund: false, usage: [line()] }))
      .resolves.toBe("settled");
    expect(c.unrecorded).toEqual([{ path: "/v1/spend/release", lines: 1, why: "no_usage_recorded_field" }]);
  });

  it("another account's line, or more than one work item's, is NOT sent — and the release still is", async () => {
    for (const usage of [[line("22222222-2222-4222-8222-222222222222")], Array.from({ length: 9 }, () => line())]) {
      const c = usageClient([{ status: 200, body: { released: true, refunded: true } }]);
      await expect(c.port.release(ACC, {
        action: "draft", attemptKey: "d1", refund: true, attempt: "draft:d1", usage,
      })).resolves.toBe("settled");
      expect(c.paths).toEqual(["/v1/spend/release"]);
      expect(JSON.parse(c.bodies[0]!)).not.toHaveProperty("usage");
      expect(JSON.parse(c.bodies[0]!).refund).toBe(true);
      expect(c.unrecorded).toEqual([{ path: "/v1/spend/release", lines: usage.length, why: "not_sent" }]);
    }
  });

  it("a release with no usage sends no `usage` key at all", async () => {
    const c = usageClient([{ status: 200, body: {} }]);
    await c.port.release(ACC, { action: "propose", attemptKey: "p1", refund: false, usage: [] });
    expect(JSON.parse(c.bodies[0]!)).not.toHaveProperty("usage");
    expect(c.unrecorded).toEqual([]);
  });

  it("recordUsage POSTs /v1/usage and answers the receipt; an empty batch dials nothing", async () => {
    const ok = usageClient([{ status: 200, body: { usageRecorded: 2 } }]);
    await expect(ok.port.recordUsage!([line(), line()])).resolves.toBe("settled");
    expect(ok.paths).toEqual(["/v1/usage"]);
    expect(JSON.parse(ok.bodies[0]!)).toEqual({ lines: [line(), line()] });
    for (const [a, receipt] of [
      [{ status: 404 }, "no_door"], [{ status: 400 }, "refused"], [{ status: 503 }, "unreachable"],
      [{ status: 0, throws: true }, "unreachable"],
    ] as const) {
      const c = usageClient([a]);
      await expect(c.port.recordUsage!([line()]), JSON.stringify(a)).resolves.toBe(receipt);
    }
    const none = usageClient([{ status: 200, body: { usageRecorded: 0 } }]);
    await expect(none.port.recordUsage!([])).resolves.toBe("settled");
    expect(none.paths).toEqual([]);
  });

  it("a line cut off before its first attempt is dropped ALONE: the rest of the release and the batch still go", async () => {
    const aborted = { ...line(), attempts: 0 };
    const rel = usageClient([{ status: 200, body: { released: true, refunded: true, usageRecorded: 1 } }]);
    await expect(rel.port.release(ACC, {
      action: "draft", attemptKey: "d1", refund: true, attempt: "draft:d1", usage: [aborted, line()],
    })).resolves.toBe("settled");
    expect(JSON.parse(rel.bodies[0]!).usage).toEqual([line()]);
    expect(JSON.parse(rel.bodies[0]!).refund).toBe(true);
    expect(rel.unrecorded).toEqual([{ path: "/v1/spend/release", lines: 1, why: "not_sent" }]);

    const post = usageClient([{ status: 200, body: { usageRecorded: 2 } }]);
    await expect(post.port.recordUsage!([line(), aborted, line()])).resolves.toBe("settled");
    expect(JSON.parse(post.bodies[0]!).lines).toEqual([line(), line()]);
    expect(post.unrecorded).toEqual([{ path: "/v1/usage", lines: 1, why: "not_sent" }]);

    const none = usageClient([{ status: 200, body: { usageRecorded: 0 } }]);
    await expect(none.port.recordUsage!([aborted])).resolves.toBe("settled");
    expect(none.paths).toEqual([]);
  });

  it("recordUsage refuses a batch past the per-POST bound without dialling", async () => {
    const c = usageClient([{ status: 200, body: { usageRecorded: 501 } }]);
    await expect(c.port.recordUsage!(Array.from({ length: 501 }, () => line()))).resolves.toBe("unreachable");
    expect(c.paths).toEqual([]);
    expect(c.unrecorded).toEqual([{ path: "/v1/usage", lines: 501, why: "not_sent" }]);
  });
});

describe("manageLink — the one door, to a first plan as well as an existing one", () => {
  it("answers the program's url", async () => {
    const c = client([{ status: 200, body: wire("manage-link-200") }]);
    await expect(c.port.manageLink(ACC)).resolves
      .toEqual({ url: "https://account.ohmail.app/manage?token=x" });
    expect(c.faults).toEqual([]);
  });

  it("a url comes back for an account with NO subscription — this is the door to a first one", async () => {
    // The contract's changed clause: a known account always gets a URL, whether or not it has
    // ever paid, because refusing one with no customer made this door unreachable for exactly
    // the accounts it exists for. The client asks nothing about a subscription, so the case is
    // the program's answer and the assertion that nothing here filters it.
    const c = client([{ status: 200, body: wire("manage-link-200") }]);
    await expect(c.port.manageLink(ACC)).resolves.not.toBeNull();
    expect(JSON.parse(c.bodies[0]!)).toEqual({ accountId: ACC });
  });

  it("the page's language rides the wire when the caller names one, and only then", async () => {
    // The mint is pressed from a screen in one language; the page it opens is told which.
    const c = client([{ status: 200, body: wire("manage-link-200") }]);
    await c.port.manageLink(ACC, "de");
    await c.port.manageLink(ACC, "en");
    await c.port.manageLink(ACC);
    expect(c.bodies.map((b) => JSON.parse(b))).toEqual([
      { accountId: ACC, lang: "de" }, { accountId: ACC, lang: "en" }, { accountId: ACC },
    ]);
  });

  it("the site's plan and interval ride the wire when named, members of their sets only", async () => {
    // A preselection hint for the page; a program that predates it reads the body field by field.
    const c = client([{ status: 200, body: wire("manage-link-200") }]);
    await c.port.manageLink(ACC, "de", { plan: "pro", interval: "year" });
    await c.port.manageLink(ACC, undefined, { plan: "solo" });
    await c.port.manageLink(ACC, "en", { plan: "gold", interval: "week" } as never);
    await c.port.manageLink(ACC, "en", {});
    expect(c.bodies.map((b) => JSON.parse(b))).toEqual([
      { accountId: ACC, lang: "de", plan: "pro", interval: "year" },
      { accountId: ACC, plan: "solo" },
      { accountId: ACC, lang: "en" },
      { accountId: ACC, lang: "en" },
    ]);
  });

  it("`{url: null}` is an ANSWER, not drift — the program does not know this account", async () => {
    // It used to mean "nothing to manage". Under the current contract that state cannot happen
    // for a known account, so a null here is the program not recognising the id.
    const c = client([{ status: 200, body: wire("manage-link-200-unknown-account") }]);
    await expect(c.port.manageLink(ACC)).resolves.toBeNull();
    expect(c.faults).toEqual([]);
  });

  it("a url that is neither a string nor null IS drift", async () => {
    const c = client([{ status: 200, body: { url: 7 } }]);
    await expect(c.port.manageLink(ACC)).resolves.toBeNull();
    expect(c.faults).toEqual([{ path: "/v1/manage-link", status: 200, field: "url" }]);
  });

  it("a non-200 answers null and never throws", async () => {
    for (const a of [{ status: 404 }, { status: 503 }, { status: 0, throws: true }]) {
      await expect(client([a]).port.manageLink(ACC)).resolves.toBeNull();
    }
  });
});

describe("checkout/confirm — the return from a Checkout, in four words", () => {
  it("relays the account and the session id, and reads the program's two states", async () => {
    for (const state of ["confirmed", "pending"] as const) {
      const c = client([{ status: 200, body: { state } }]);
      await expect(c.port.confirmReturn!(ACC, "cs_test_1")).resolves.toBe(state);
      expect(c.paths).toEqual(["/v1/checkout/confirm"]);
      expect(JSON.parse(c.bodies[0]!)).toEqual({ accountId: ACC, sessionId: "cs_test_1" });
    }
  });

  it("404 is an answer (unknown, another account's, or an older program); anything else is a fault", async () => {
    await expect(client([{ status: 404, body: { error: "not_found" } }]).port.confirmReturn!(ACC, "cs_1"))
      .resolves.toBe("not_found");
    for (const a of [{ status: 502, body: {} }, { status: 0, throws: true }]) {
      await expect(client([a]).port.confirmReturn!(ACC, "cs_1")).resolves.toBe("fault");
    }
    const drift = client([{ status: 200, body: { state: "applied" } }]);
    await expect(drift.port.confirmReturn!(ACC, "cs_1")).resolves.toBe("fault");
    expect(drift.faults.map((f) => f.field)).toEqual(["state"]);
  });

  it("a confirmed payment drops the refusal this process holds, so the next read asks", async () => {
    let t = 1_000;
    const refused = wire("access-200-active") as { entitlements: Record<string, unknown> };
    refused.entitlements.syncEnabled = false;
    refused.entitlements.reason = "canceled";
    const c = client([
      { status: 200, body: refused },
      { status: 200, body: { state: "confirmed" } },
      { status: 200, body: wire("access-200-active") },
    ], { now: () => t });
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    await c.port.confirmReturn!(ACC, "cs_1");
    t += 1;
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: true });
  });
});

describe("account/release — the erasure outcome, one-to-one", () => {
  it("each of the three words comes back as itself", async () => {
    for (const o of ["none", "cancelled", "cancel_failed"] as const) {
      const c = client([{ status: 200, body: wire(`account-release-200-${o}`) }]);
      await expect(c.port.releaseAccount(ACC)).resolves.toBe(o);
      expect(c.faults, o).toEqual([]);
    }
  });

  it("NO ANSWER is `cancel_failed`, never `none`", async () => {
    // "Nothing to cancel" for a call that never landed is a deleted customer still being charged.
    for (const a of [{ status: 503 }, { status: 0, throws: true }, { status: 200, body: undefined }]) {
      await expect(client([a]).port.releaseAccount(ACC)).resolves.toBe("cancel_failed");
    }
  });

  it("an outcome outside the three is drift AND `cancel_failed`", async () => {
    const c = client([{ status: 200, body: { outcome: "sort_of" } }]);
    await expect(c.port.releaseAccount(ACC)).resolves.toBe("cancel_failed");
    expect(c.faults).toEqual([{ path: "/v1/account/release", status: 200, field: "outcome" }]);
  });
});

describe("the unmetered composition dials nothing", () => {
  it("accessOf answers allow with unbounded limits", async () => {
    await expect(accessOf(UNMETERED, ACC)).resolves.toEqual(UNMETERED_ACCESS);
  });

  it("isMetered tells a port from the literal", () => {
    const c = client([]).port;
    expect(isMetered(UNMETERED)).toBe(false);
    expect(isMetered(c)).toBe(true);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE CALL BUDGETS — and what the client says when one is spent
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The incident these cases are written from: one 3 000 ms ceiling over every call, equal to the
 * measured p50 of the far end, fired on every `spend`. The verdict read `fault`, the route
 * answered 503 "AI suggestions are temporarily unavailable" — and the program completed that same
 * spend seconds later and CHARGED for it. Nothing in any log said so.
 */

/** A program that answers after `afterMs`, honouring the abort signal the way a real one does. */
/* The budgets and the slow program on a FAKE clock where a case drives them: the clock is moved by
   exactly the budget, so the shipped numbers are exercised at their size and nothing sleeps. */
const fakeClock = (): void => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] }); };
afterEach(() => { vi.useRealTimers(); });

const slowPlane = (afterMs: number, status: number, body: unknown): EntitlementsFetch =>
  (_url, init) => new Promise((resolve, reject) => {
    const t = setTimeout(() => { resolve({ status, json: async () => body }); }, afterMs);
    init.signal.addEventListener(
      "abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });

describe("one budget, with its origin", () => {
  /** The worst `/v1/access` sample measured on 2026-09-13 with the program beside its database. */
  const WORST_SAMPLE_MS = 390;

  it("it clears the measurement it was sized from, with room, and still fits the caller", () => {
    // The local p50 and max and the production p95 are what it was sized from. A budget that does not clear the
    // WORST sample is the incident again: it refuses the answer the program is about to give.
    expect(ENTITLEMENTS_CALL_BUDGET_MS).toBeGreaterThan(WORST_SAMPLE_MS);
    // Ten times it, at least. The 3 000 ms this replaces sat just above the p50 of a slower
    // deployment, and that margin is exactly how it came to fire on every spend.
    expect(ENTITLEMENTS_CALL_BUDGET_MS).toBeGreaterThanOrEqual(10 * WORST_SAMPLE_MS);
    // And bounded ABOVE by the caller who pays for it: the screener subtracts this from a 60 s
    // invocation that already owes 40 s to the model call and 3 s to the write after it.
    expect(ENTITLEMENTS_CALL_BUDGET_MS).toBeLessThan(60_000 - 40_000 - 3_000);
  });

  /**
   * THE FAILING CASE, AND ITS OWN CONTROL, in one wait: a program answering in 4 s is served at
   * the shipped budgets and was NOT served at the 3 000 ms ceiling that shipped before. Run
   * against the real constants, because a scaled-down pair proves the mechanism and not the
   * number, and the number is what failed.
   */
  it("a program answering in 4 s is served — and was not, at the old ceiling", async () => {
    fakeClock();
    const ok = { verdict: "ok", attempt: "a1" };
    const entitled = {
      entitlements: {
        syncEnabled: true, canAddMailbox: true, aiEnabled: true,
        mailboxLimit: null, storageBytesLimit: null,
      },
    };
    const at4s = (body: unknown): EntitlementsFetch => slowPlane(4_000, 200, body);
    const shipped = {
      spend: makeEntitlementsClient({
        baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: at4s(ok),
        onCallFault: () => { /* asserted below */ },
      }),
      access: makeEntitlementsClient({
        onCallFault: "unrecorded", baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: at4s(entitled),
      }),
    };
    /* The ceiling as it shipped before this change — the same program, the same 4 s. */
    const before = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: at4s(ok),
      budgetsMs: { "/v1/spend": 3_000 }, onCallFault: () => { /* expected here */ },
    });
    const all = Promise.all([
      shipped.spend.spend(ACC, "screener", "m1"),
      shipped.access.access(ACC),
      before.spend(ACC, "screener", "m1"),
    ]);
    await vi.advanceTimersByTimeAsync(4_000);
    const [spent, seen, old] = await all;
    expect(spent).toEqual({ verdict: "ok", charged: true, attempt: "a1" });
    expect(seen.ok).toBe(true);
    expect(old, "the old ceiling served this program, so the budget is not what failed")
      .toEqual({ verdict: "fault" });
  }, 20_000);

  it("an override is read per path, so a case can price one call and not the others", async () => {
    // The budget is one number in production; the OVERRIDE is per path, which is what lets a case
    // spend a 60 ms budget on `access` while leaving the money path alone.
    fakeClock();
    const port = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24),
      fetchImpl: slowPlane(220, 200, { entitlements: {
        syncEnabled: true, canAddMailbox: true, aiEnabled: true,
        mailboxLimit: null, storageBytesLimit: null,
      } }),
      budgetsMs: { "/v1/access": 60, "/v1/spend": 4_000 },
      onCallFault: () => { /* expected */ },
    });
    // Its own budget is spent, so the fault arm answers: allow, with nothing cached.
    const answer = port.access(ACC);
    await vi.advanceTimersByTimeAsync(60);
    await expect(answer).resolves.toEqual({
      ok: true, limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true },
    });
  });
});

describe("a spent budget and a refusal are LOGGED, once, with no body and no account", () => {
  it("a timeout reports the path, no status, the elapsed and the budget", async () => {
    fakeClock();
    const seen: CallFault[] = [];
    const port = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24),
      fetchImpl: slowPlane(5_000, 200, { verdict: "ok", attempt: "a1" }),
      budgetsMs: { "/v1/spend": 120 },
      onCallFault: (f) => { seen.push(f); },
    });
    const answer = port.spend(ACC, "draft", "d1");
    await vi.advanceTimersByTimeAsync(120);
    await expect(answer).resolves.toEqual({ verdict: "fault" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/v1/spend");
    // `null`, not a made-up status: nothing arrived, and 504 would be a number we invented.
    expect(seen[0]!.status).toBeNull();
    expect(seen[0]!.budgetMs).toBe(120);
    expect(seen[0]!.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it("a 503 is a fault AND exactly one line, carrying the status it answered", async () => {
    const c = client([{ status: 503, body: { error: "down" } }]);
    await expect(c.port.spend(ACC, "screener", "m1")).resolves.toEqual({ verdict: "fault" });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.path).toBe("/v1/spend");
    expect(c.calls[0]!.status).toBe(503);
    expect(c.calls[0]!.budgetMs).toBe(ENTITLEMENTS_CALL_BUDGET_MS);
    // A 503 is not DRIFT — the contract's own status table says so, and conflating the two
    // would page somebody about a schema disagreement every time the program restarts.
    expect(c.faults).toEqual([]);
  });

  it("the ACCESS fault arm fails open, and that is exactly why it may not be silent", async () => {
    /* The fault arm answers the last verdict, else allow — refuse-when-unsure would take every
     * inbox dark on one outage. The cost is that an outage UNMETERS every account for its
     * duration and looks, from the outside, like a working deployment. The line is the only
     * thing that tells those two apart. */
    const c = client([{ status: 503 }]);
    await expect(c.port.access(ACC)).resolves.toEqual({
      ok: true, limits: { mailboxes: null, storageBytes: null, canAddMailbox: true, aiEnabled: true },
    });
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.path).toBe("/v1/access");
    expect(c.calls[0]!.budgetMs).toBe(ENTITLEMENTS_CALL_BUDGET_MS);
  });

  it("a 200 the client cannot read is DRIFT and not a call fault", async () => {
    // The two reports answer different questions: "the program is down" and "the two sides
    // disagree about the wire". One line for each, never one line for both.
    const c = client([{ status: 200, body: { verdict: "sideways" } }]);
    await expect(c.port.spend(ACC, "draft", "d1")).resolves.toEqual({ verdict: "fault" });
    expect(c.faults).toEqual([{ path: "/v1/spend", status: 200, field: "verdict" }]);
    expect(c.calls).toEqual([]);
  });

  it("the default line names the path and the numbers, and never the bearer or a body", async () => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    try {
      const port = makeEntitlementsClient({
        onCallFault: "unrecorded", baseUrl: "https://e.example", secret: "sekrit".repeat(4),
        fetchImpl: async () => ({ status: 502, json: async () => ({ upstream: ACC }) }),
      });
      await port.spend(ACC, "screener", "m1");
    } finally { console.warn = warn; }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("/v1/spend");
    expect(lines[0]).toContain("502");
    expect(lines[0]).toContain(String(ENTITLEMENTS_CALL_BUDGET_MS));
    // No credential, no account, no body — an outage is every account at once.
    expect(lines[0]).not.toContain("sekrit");
    expect(lines[0]).not.toContain(ACC);
    expect(lines[0]).not.toContain("upstream");
  });

  it("the sink is AWAITED — a floating write records nothing on serverless", async () => {
    /* The host that writes an `api_faults` row here is killed the moment it answers, so a report
     * left floating is a row that never lands on the one platform the row exists for. The proof
     * is ordering: the write must have completed before `spend` resolved. */
    const written: string[] = [];
    const port = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24),
      fetchImpl: async () => ({ status: 503, json: async () => ({}) }),
      onCallFault: async (f) => {
        await new Promise((r) => { setTimeout(r, 30); });
        written.push(f.path);
      },
    });
    await expect(port.spend(ACC, "draft", "d1")).resolves.toEqual({ verdict: "fault" });
    expect(written, "the report was still in flight when the call answered").toEqual(["/v1/spend"]);
  });

  it("a reporter that REJECTS does not become the answer either", async () => {
    const port = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24),
      fetchImpl: async () => ({ status: 503, json: async () => ({}) }),
      onCallFault: async () => { await Promise.reject(new Error("the board is down too")); },
    });
    await expect(port.spend(ACC, "draft", "d1")).resolves.toEqual({ verdict: "fault" });
  });

  it("a reporter that throws does not become the answer", async () => {
    const port = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24),
      fetchImpl: async () => ({ status: 503, json: async () => ({}) }),
      onCallFault: () => { throw new Error("the board is down too"); },
    });
    await expect(port.spend(ACC, "draft", "d1")).resolves.toEqual({ verdict: "fault" });
  });
});

/**
 * THE RECOVERY PATH, AT THE SEAM — a spend the program completed AFTER this side gave up.
 *
 * The money already moved. What must not happen is a SECOND charge on the retry, and what makes
 * that safe is the program's idempotency by `attemptKey`: the retry reads `duplicate`, which is
 * `charged: false`. This models the program the way it behaves, not the way it answers: the work
 * lands when the request arrives, whatever the caller does with the reply.
 */
describe("a late answer, then a retry, is ONE charge", () => {
  /** Charges on arrival, answers late the first time and `duplicate` for ever after. */
  const idempotentPlane = (answerAfterMs: number) => {
    const charged: string[] = [];
    const impl: EntitlementsFetch = (_url, init) => {
      const key = (JSON.parse(init.body) as { attemptKey: string }).attemptKey;
      const first = !charged.includes(key);
      if (first) charged.push(key);
      const answer = first
        ? { verdict: "ok", attempt: `${key}#1` }
        : { verdict: "duplicate", attempt: `${key}#1` };
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () => { resolve({ status: 200, json: async () => answer }); },
          first ? answerAfterMs : 0);
        init.signal.addEventListener(
          "abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
      });
    };
    return { impl, charged };
  };

  it("the timed-out attempt charged once; the retry reads duplicate and charges nothing", async () => {
    const plane = idempotentPlane(400);
    const calls: CallFault[] = [];
    const port = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: plane.impl,
      budgetsMs: { "/v1/spend": 80 }, onCallFault: (f) => { calls.push(f); },
    });

    // 1. This side gives up. The program has the request and is going to finish it.
    await expect(port.spend(ACC, "screener", "m1")).resolves.toEqual({ verdict: "fault" });
    expect(calls, "the give-up was silent").toHaveLength(1);
    expect(plane.charged, "the program charged, which is the whole problem").toEqual(["m1"]);

    // 2. The retry — the same attempt key, which is what makes it free.
    await expect(port.spend(ACC, "screener", "m1"))
      .resolves.toEqual({ verdict: "duplicate", charged: false, attempt: "m1#1" });

    // 3. EXACTLY ONE CHARGE across both. Not two, and not zero.
    expect(plane.charged).toEqual(["m1"]);
    expect(calls, "the retry answered, so nothing more was reported").toHaveLength(1);
  });

  it("a DIFFERENT attempt key is a different purchase — the control", async () => {
    // Without this, the case above passes for a program that never charges anybody.
    const plane = idempotentPlane(0);
    const port = makeEntitlementsClient({
      onCallFault: "unrecorded", baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: plane.impl,
    });
    await expect(port.spend(ACC, "screener", "m1"))
      .resolves.toEqual({ verdict: "ok", charged: true, attempt: "m1#1" });
    await expect(port.spend(ACC, "screener", "m2"))
      .resolves.toEqual({ verdict: "ok", charged: true, attempt: "m2#1" });
    expect(plane.charged).toEqual(["m1", "m2"]);
  });
});

/**
 * THE PRICE CARD (2026-09-24) — read off the program's own example, and held to the open client's
 * expectation file, the twin of the one the program's suite holds its real answer to.
 */
describe("access — the price card", () => {
  const EXPECTATION = wire("prices-expectation") as { path: string; field: string; actions: string[] };
  const withPrices = (prices: unknown): Record<string, unknown> =>
    ({ ...(wire("access-200-active") as Record<string, unknown>), prices });

  it("the contract's example carries every key the expectation names, and nothing drifts", async () => {
    expect(EXPECTATION).toMatchObject({ path: "/v1/access", field: "prices" });
    const c = client([{ status: 200, body: wire("access-200-active") }]);
    const v = await c.port.access(ACC);
    expect(v.ok && v.prices ? Object.keys(v.prices).sort() : null).toEqual([...EXPECTATION.actions].sort());
    expect(c.faults).toEqual([]);
  });

  it("an ABSENT block is an older program: unpriced, and no drift", async () => {
    const body = wire("access-200-active") as Record<string, unknown>;
    delete body.prices;
    const c = client([{ status: 200, body }]);
    const v = await c.port.access(ACC);
    expect(v.ok).toBe(true);
    expect("prices" in v).toBe(false);
    expect(c.faults).toEqual([]);
  });

  for (const [what, prices, field] of [
    ["a negative price", { classify_ingest: 1, screener: -1, draft: 15, propose: 20, workflow: 15 }, "prices.screener"],
    ["a fractional price", { classify_ingest: 1, screener: 1, draft: 1.5, propose: 20, workflow: 15 }, "prices.draft"],
    ["a string price", { classify_ingest: "1", screener: 1, draft: 15, propose: 20, workflow: 15 }, "prices.classify_ingest"],
    ["a missing action", { classify_ingest: 1, screener: 1, draft: 15, propose: 20 }, "prices.workflow"],
    ["a block that is not an object", [1, 15, 20], "prices"],
  ] as const) {
    it(`${what} is a drift, named, read as UNPRICED — and the access verdict stands`, async () => {
      const c = client([{ status: 200, body: withPrices(prices) }]);
      const v = await c.port.access(ACC);
      expect(v.ok).toBe(true);
      expect(v.ok && v.limits.aiEnabled).toBe(true);
      expect("prices" in v).toBe(false);
      expect(c.faults).toEqual([{ path: "/v1/access", status: 200, field }]);
    });
  }

  it("the port reads the card through the cached verdict; unmetered and refused price nothing", async () => {
    const c = client([{ status: 200, body: wire("access-200-active") }]);
    const pricing = pricingOf(c.port);
    await expect(pricing.priceOf(ACC, "screener")).resolves.toBe(1);
    await expect(pricing.priceOf(ACC, "draft")).resolves.toBe(15);
    expect(c.paths).toEqual(["/v1/access"]);
    await expect(pricingOf(UNMETERED).priceOf(ACC, "screener")).resolves.toBeNull();
    const refused = withPrices({ classify_ingest: 1, screener: 1, draft: 15, propose: 20, workflow: 15 }) as
      Record<string, unknown> & { entitlements: Record<string, unknown> };
    refused.entitlements = { ...refused.entitlements, syncEnabled: false, reason: "unpaid" };
    refused.lifecycle = { ...(refused.lifecycle as Record<string, unknown>), state: "closed", closedReason: "unpaid" };
    const r = client([{ status: 200, body: refused }]);
    await expect(pricingOf(r.port).priceOf(ACC, "screener")).resolves.toBeNull();
  });
});

describe("`aiPricing` — /health's reading of where a quote's price comes from", () => {
  it("probes ONCE, for the nil account, and latches `plane` when the answer carries the card", async () => {
    const c = client([{ status: 200, body: wire("access-200-active") }]);
    await expect(c.port.aiPricing()).resolves.toBe("plane");
    expect(JSON.parse(c.bodies[0]!)).toEqual({ accountId: PRICE_PROBE_ACCOUNT });
    await expect(c.port.aiPricing()).resolves.toBe("plane");
    expect(c.paths).toEqual(["/v1/access"]);
  });

  it("a real access read latches it too, so a warm host probes nothing", async () => {
    const c = client([{ status: 200, body: wire("access-200-active") }]);
    await c.port.access(ACC);
    await expect(c.port.aiPricing()).resolves.toBe("plane");
    expect(c.paths).toEqual(["/v1/access"]);
  });

  it("an answer with no card reads `unpriced`", async () => {
    const body = wire("access-200-active") as Record<string, unknown>;
    delete body.prices;
    const c = client([{ status: 200, body }]);
    await expect(c.port.aiPricing()).resolves.toBe("unpriced");
  });

  it("a program that does not answer costs the probe budget and reads `unpriced`", async () => {
    fakeClock();
    const port = makeEntitlementsClient({
      baseUrl: "https://entitlements.example/", secret: "x".repeat(24),
      fetchImpl: () => new Promise(() => { /* never answers */ }),
      onContractFault: () => {}, onCallFault: () => {},
    });
    const started = Date.now();
    let settled = false;
    const priced = port.aiPricing().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(PRICE_PROBE_BUDGET_MS - 1);
    expect(settled, "the probe gave up before its budget").toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(priced).resolves.toBe("unpriced");
    expect(Date.now() - started).toBeLessThan(PRICE_PROBE_BUDGET_MS + 1_000);
  });
});

/**
 * ONE `/v1/access` CALL PER ACCOUNT, and a failed one held for a moment (2026-09-25). Opening a
 * message with many images sent 40-80 parallel requests; each asked the program on its own, the
 * program queued them past the budget, every call timed out, and the timeout was not cached, so
 * the next burst did it again. The counts below are the program's own reading of a burst.
 */
type PlaneAnswer = { status: number; body?: unknown } | "network-down" | "silent";

/** A program answering the n-th call with `answers[n]` after `afterMs`, honouring the abort. */
function countedPlane(afterMs: number, answers: PlaneAnswer[]): {
  impl: EntitlementsFetch; accounts: string[];
} {
  const accounts: string[] = [];
  const impl: EntitlementsFetch = (_url, init) => new Promise((resolve, reject) => {
    const a = answers[Math.min(accounts.length, answers.length - 1)]!;
    accounts.push((JSON.parse(init.body) as { accountId: string }).accountId);
    const timer = a === "silent" ? undefined : setTimeout(() => {
      if (a === "network-down") reject(new TypeError("fetch failed"));
      else resolve({ status: a.status, json: async () => a.body });
    }, afterMs);
    init.signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
  return { impl, accounts };
}

const onPlane = (impl: EntitlementsFetch, over: {
  ttlMs?: number; now?: () => number; budgetsMs?: Partial<Record<EntitlementsPath, number>>;
  waitUntil?: (work: Promise<unknown>) => void;
} = {}) => {
  const calls: CallFault[] = [];
  return {
    calls,
    port: makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: impl,
      onCallFault: (f) => { calls.push(f); }, onContractFault: () => { /* not under test */ },
      ...over,
    }),
  };
};

const burst = <T>(n: number, read: () => Promise<T>): Promise<T[]> =>
  Promise.all(Array.from({ length: n }, read));

const refusedBody = (): unknown => {
  const b = wire("access-200-active") as { entitlements: Record<string, unknown> };
  b.entitlements.syncEnabled = false;
  b.entitlements.reason = "unpaid";
  return b;
};

/**
 * `askedAfter` — an answer begun since an instant (mail 0135). The worker's roster asks it for an
 * account whose row the reopening door kicked: a refusal from before the kick may predate the
 * door's clear, so neither a held verdict nor a call in flight from before may answer it.
 */
describe("access — askedAfter answers only from a call begun since that instant", () => {
  /** A fetch whose calls wait until the case answers them, in whatever order it chooses. */
  function gatedPlane() {
    const calls: Array<(a: { status: number; body?: unknown }) => void> = [];
    const impl: EntitlementsFetch = () => new Promise((resolve) => {
      calls.push((a) => resolve({ status: a.status, json: async () => a.body }));
    });
    return { impl, calls };
  }
  const refused = () => {
    const b = wire("access-200-active") as { entitlements: Record<string, unknown> };
    b.entitlements.syncEnabled = false;
    b.entitlements.reason = "canceled";
    return b;
  };
  const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

  it("a refusal held from before is asked again; a verdict asked since is reused", async () => {
    let t = 1_000;
    const c = client([
      { status: 200, body: refused() }, { status: 200, body: wire("access-200-active") },
    ], { now: () => t });
    await expect(c.port.access(ACC)).resolves.toMatchObject({ ok: false });
    await expect(c.port.access(ACC, { askedAfter: 1_000 }), "asked at 1000 is asked since 1000")
      .resolves.toMatchObject({ ok: false });
    expect(c.paths).toHaveLength(1);
    t = 1_200;
    await expect(c.port.access(ACC, { askedAfter: 1_100 })).resolves.toMatchObject({ ok: true });
    expect(c.paths).toHaveLength(2);
  });

  it("does not join a call in flight since before it, and that call's late answer replaces nothing", async () => {
    let t = 1_000;
    const plane = gatedPlane();
    const port = makeEntitlementsClient({
      baseUrl: "https://entitlements.example/", secret: "x".repeat(24), fetchImpl: plane.impl,
      now: () => t, onContractFault: () => {}, onCallFault: () => {},
    });
    const early = port.access(ACC);                                   // begun at 1000, still out
    await settle();
    t = 2_000;
    const since = port.access(ACC, { askedAfter: 1_500 });
    await settle();
    expect(plane.calls, "a second call, not a join").toHaveLength(2);
    plane.calls[1]!({ status: 200, body: wire("access-200-active") });
    await expect(since).resolves.toMatchObject({ ok: true });
    plane.calls[0]!({ status: 200, body: refused() });                 // the older answer, late
    await early;
    await expect(port.access(ACC), "the newer verdict stands").resolves.toMatchObject({ ok: true });
    // The control: a call begun at or after the instant IS joined.
    t = 70_000;
    const first = port.access(ACC);
    await settle();
    const joined = port.access(ACC, { askedAfter: 70_000 });
    await settle();
    expect(plane.calls).toHaveLength(3);
    plane.calls[2]!({ status: 200, body: refused() });
    await expect(joined).resolves.toMatchObject({ ok: false });
    await first;
  });

  it("a fault answers allow, never the refusal from before the instant", async () => {
    let t = 1_000;
    const c = client([{ status: 200, body: refused() }, { status: 503, body: {} }], { now: () => t });
    await c.port.access(ACC);
    t = 1_500;
    await expect(c.port.access(ACC, { askedAfter: 1_200 })).resolves.toEqual(UNMETERED_ACCESS);
  });
});

describe("access — one call in flight per account, and a failed answer held", () => {
  it("80 parallel reads for one account send ONE call, and every read gets its priced verdict", async () => {
    let t = 1_000;
    const plane = countedPlane(30, [{ status: 200, body: wire("access-200-active") }]);
    const { port } = onPlane(plane.impl, { now: () => t });
    const seen = await burst(80, () => port.access(ACC));
    expect(plane.accounts, "the program was asked once for the whole burst").toHaveLength(1);
    for (const v of seen) expect(v).toEqual(seen[0]);
    expect(seen[0]).toMatchObject({ ok: true, prices: { screener: 1 } });
    // The entry left when the call settled: past the TTL the next burst is ONE new call.
    t += ACCESS_TTL_MS + 1;
    await burst(80, () => port.access(ACC));
    expect(plane.accounts).toHaveLength(2);
  });

  it("two accounts in parallel send two calls, one each", async () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const plane = countedPlane(30, [{ status: 200, body: wire("access-200-active") }]);
    const { port } = onPlane(plane.impl);
    await Promise.all([burst(40, () => port.access(ACC)), burst(40, () => port.access(other))]);
    expect([...plane.accounts].sort()).toEqual([ACC, other].sort());
  });

  it("a timeout, then a burst inside the hold, sends nothing more; at the hold's end one call goes", async () => {
    let t = 1_000;
    const plane = countedPlane(0, ["silent"]);
    const { port, calls } = onPlane(plane.impl, { now: () => t, budgetsMs: { "/v1/access": 40 } });
    const first = await burst(80, () => port.access(ACC));
    for (const v of first) expect(v).toEqual(UNMETERED_ACCESS);
    expect(plane.accounts).toHaveLength(1);
    expect(calls, "one timed-out call is one fault row, not eighty").toHaveLength(1);
    t += ACCESS_FAULT_HOLD_MS - 1;
    const held = await burst(80, () => port.access(ACC));
    for (const v of held) expect(v).toEqual(UNMETERED_ACCESS);
    expect(plane.accounts, "inside the hold nothing is sent").toHaveLength(1);
    t += 1;
    await burst(80, () => port.access(ACC));
    expect(plane.accounts, "the hold ended: one call, not eighty").toHaveLength(2);
    expect(calls).toHaveLength(2);
    // One budget, and never as long as an answer is kept.
    expect(ACCESS_FAULT_HOLD_MS).toBe(ENTITLEMENTS_CALL_BUDGET_MS);
    expect(ACCESS_FAULT_HOLD_MS).toBeLessThan(ACCESS_TTL_MS);
  });

  // The hold's bounds that hold at one budget, one case each. A hold longer than a stream's poll was
  // tried and ruled out: it keeps a refused account's write doors open after the program recovers.
  it("the hold is at least one call budget: a call one budget after a timeout lands behind the backlog", () => {
    expect(ACCESS_FAULT_HOLD_MS).toBeGreaterThanOrEqual(ENTITLEMENTS_CALL_BUDGET_MS);
  });

  it("the hold is at most half the TTL, half the clients' stale-refusal window", () => {
    expect(ACCESS_FAULT_HOLD_MS).toBeLessThanOrEqual(ACCESS_TTL_MS / 2);
  });

  it("one asker still writes twice the fault alarm's per-route floor in its window", () => {
    expect(DEFAULT_ALERT_THRESHOLDS.apiFaultWindowMs / ACCESS_FAULT_HOLD_MS)
      .toBeGreaterThanOrEqual(2 * DEFAULT_ALERT_THRESHOLDS.apiFaultMinPerRoute);
  });

  /**
   * AFTER THE PROGRAM RECOVERS, a refused account is refused within one call budget. The fault arm
   * answers allow while the program is down (it must: an outage may not lock mail away), so the
   * hold is how long that allow outlives the recovery, at every write door the plain read reaches.
   * Asked once a second through a minute of 503s, then the program refuses: the first refusal's lag.
   */
  async function refusalLag(warm: boolean): Promise<number> {
    let t = 0;
    let mode: "up" | "down" | "refusing" = "up";
    const refused = wire("access-200-active") as { entitlements: Record<string, unknown> };
    refused.entitlements.syncEnabled = false;
    const impl: EntitlementsFetch = async () => {
      if (mode === "down") return { status: 503, json: async () => ({ error: "down" }) };
      return { status: 200, json: async () => (mode === "refusing" ? refused : wire("access-200-active")) };
    };
    const port = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: impl, now: () => t,
      onCallFault: () => undefined, onContractFault: () => undefined,
    });
    if (warm) await expect(port.access(ACC)).resolves.toMatchObject({ ok: true });
    mode = "down";
    const from = warm ? ACCESS_TTL_MS + 1_000 : 0;
    for (let s = 0; s <= 60; s += 1) {
      t = from + s * 1_000;
      await expect(port.access(ACC), "an outage locked the account out").resolves.toMatchObject({ ok: true });
    }
    mode = "refusing";
    const recovered = from + 60_500;
    for (let s = 0; s <= 120; s += 1) {
      t = recovered + s * 1_000;
      if (!(await port.access(ACC)).ok) return s * 1_000;
    }
    return Number.POSITIVE_INFINITY;
  }

  it("a refused account asked about for the first time during an outage is refused within one budget of the recovery", async () => {
    expect(await refusalLag(false)).toBeLessThanOrEqual(5_000);
  });

  it("an account whose allow expired during an outage is refused within one budget of the recovery", async () => {
    expect(await refusalLag(true)).toBeLessThanOrEqual(5_000);
  });

  it("the hold answers the fault arm's verdict unchanged: the last one known, not allow", async () => {
    let t = 1_000;
    const plane = countedPlane(0, [{ status: 200, body: refusedBody() }, "silent"]);
    const { port } = onPlane(plane.impl, {
      now: () => t, ttlMs: 10, budgetsMs: { "/v1/access": 40 },
    });
    await expect(port.access(ACC)).resolves.toMatchObject({ ok: false, reason: "payment_required" });
    t += 20;
    const faulted = await burst(80, () => port.access(ACC));
    const inHold = await burst(80, () => port.access(ACC));
    for (const v of [...faulted, ...inHold]) expect(v).toMatchObject({ ok: false, reason: "payment_required" });
    expect(plane.accounts).toHaveLength(2);
  });

  it("a fresh read joins the call already in flight", async () => {
    const plane = countedPlane(40, [{ status: 200, body: wire("access-200-active") }]);
    const { port } = onPlane(plane.impl);
    const [plain, fresh] = await Promise.all([port.access(ACC), port.access(ACC, { fresh: true })]);
    expect(plane.accounts).toHaveLength(1);
    expect(fresh).toEqual(plain);
  });

  it("a fresh read is not held: it asks again inside the hold (the wall, the erasure door)", async () => {
    let t = 1_000;
    const plane = countedPlane(0, ["silent", { status: 200, body: wire("access-200-active") }]);
    const { port } = onPlane(plane.impl, { now: () => t, budgetsMs: { "/v1/access": 40 } });
    await port.access(ACC);
    t += 1;
    await expect(port.access(ACC)).resolves.toEqual(UNMETERED_ACCESS);
    expect(plane.accounts).toHaveLength(1);
    await expect(port.access(ACC, { fresh: true })).resolves.toMatchObject({ ok: true, prices: { screener: 1 } });
    expect(plane.accounts).toHaveLength(2);
  });

  it("a failed shared call answers every waiter what ONE failed call answers", async () => {
    // The control is a lone read on a second client over the same answers.
    for (const answers of [
      ["network-down"],
      [{ status: 200, body: refusedBody() }, "network-down"],
      [{ status: 503, body: { error: "down" } }],
    ] as PlaneAnswer[][]) {
      let t = 1_000;
      const lone = onPlane(countedPlane(0, answers).impl, { now: () => t, ttlMs: 10 });
      const plane = countedPlane(10, answers);
      const shared = onPlane(plane.impl, { now: () => t, ttlMs: 10 });
      if (answers.length > 1) { await lone.port.access(ACC); await shared.port.access(ACC); }
      t += 20;
      const alone = await lone.port.access(ACC);
      const all = await burst(80, () => shared.port.access(ACC));
      for (const v of all) expect(v).toEqual(alone);
      expect(plane.accounts).toHaveLength(answers.length);
    }
  });

  it("a call that REJECTS rejects every waiter with the same error, and leaves no entry behind", async () => {
    // Today's one call rejects when reading the body throws; sharing it must not turn that into
    // an answer, and must not keep the rejected promise for the next read.
    const unreadable = { get entitlements(): never { throw new TypeError("unreadable body"); } };
    const lone = onPlane(countedPlane(0, [{ status: 200, body: unreadable }]).impl);
    const alone = await lone.port.access(ACC).then(() => null, (e: unknown) => e);
    expect(alone).toBeInstanceOf(TypeError);
    const plane = countedPlane(10, [{ status: 200, body: unreadable }]);
    const { port } = onPlane(plane.impl);
    const settled = await Promise.allSettled(Array.from({ length: 80 }, () => port.access(ACC)));
    for (const s of settled) {
      expect(s.status).toBe("rejected");
      const reason = (s as PromiseRejectedResult).reason as Error;
      expect(reason).toBeInstanceOf(TypeError);
      expect(reason.message).toBe((alone as Error).message);
    }
    expect(plane.accounts).toHaveLength(1);
    await expect(port.access(ACC)).rejects.toBeInstanceOf(TypeError);
    expect(plane.accounts, "the settled call was removed; the next read is a new call").toHaveLength(2);
  });
});

describe("accessOrFault — the read that says when it could not ask (the erasure door)", () => {
  it("a 200 is the verdict; every call the program did not answer is `fault`, never the last verdict", async () => {
    let t = 1_000;
    const plane = countedPlane(0, [{ status: 200, body: refusedBody() }, "network-down"]);
    const { port } = onPlane(plane.impl, { now: () => t });
    await expect(port.accessOrFault(ACC)).resolves.toMatchObject({ ok: false, reason: "payment_required" });
    t += 1;
    // `access` answers the held refusal here; this read must not.
    await expect(port.accessOrFault(ACC)).resolves.toBe("fault");
    await expect(port.access(ACC, { fresh: true })).resolves.toMatchObject({ ok: false });
    for (const answers of [[{ status: 503 }], [{ status: 200, body: {} }], ["silent"]] as PlaneAnswer[][]) {
      const q = onPlane(countedPlane(0, answers).impl, { budgetsMs: { "/v1/access": 40 } });
      await expect(q.port.accessOrFault(ACC)).resolves.toBe("fault");
    }
  });

  it("it reads through the cache and the hold, and joins a call already in flight", async () => {
    let t = 1_000;
    const plane = countedPlane(20, [
      { status: 200, body: wire("access-200-active") }, "network-down",
      { status: 200, body: wire("access-200-active") },
    ]);
    const { port } = onPlane(plane.impl, { now: () => t });
    await port.access(ACC);
    await expect(port.accessOrFault(ACC)).resolves.toBe("fault");
    expect(plane.accounts, "a cached 200 is not an answer to this read").toHaveLength(2);
    t += 1;
    const [a, b] = await Promise.all([port.accessOrFault(ACC), port.access(ACC, { fresh: true })]);
    expect(plane.accounts, "inside the hold it still asks, once for both").toHaveLength(3);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
  });
});


/**
 * A READ ROUTE ANSWERS ON A HELD ALLOW (2026-09-25). The first read after the 60 s verdict expired
 * waited ~500 ms on the program; a read route now answers on an allow younger than the bound and
 * the refresh runs behind it, through the one call in flight. The program here answers only when
 * the test opens it, so "at once" is a fact about the promise, not a timing.
 */
function gatedPlane(answers: PlaneAnswer[]): {
  impl: EntitlementsFetch; accounts: string[]; open(): void; close(): void;
} {
  const accounts: string[] = [];
  let closed = false;
  let waiting: Array<() => void> = [];
  const impl: EntitlementsFetch = async (_url, init) => {
    const a = answers[Math.min(accounts.length, answers.length - 1)]!;
    accounts.push((JSON.parse(init.body) as { accountId: string }).accountId);
    if (closed) await new Promise<void>((resolve) => { waiting.push(resolve); });
    if (a === "network-down" || a === "silent") throw new TypeError("fetch failed");
    return { status: a.status, json: async () => a.body };
  };
  const open = (): void => {
    closed = false;
    const run = waiting;
    waiting = [];
    for (const go of run) go();
  };
  return { impl, accounts, open, close: () => { closed = true; } };
}

/** One macrotask: every microtask chain a settled promise would run has run. */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

const allowed = (): PlaneAnswer => ({ status: 200, body: wire("access-200-active") });

describe("access — a READ route answers on a held allow and refreshes it behind", () => {
  it("an expired allow inside the bound answers AT ONCE, with ONE refresh behind the burst", async () => {
    let t = 1_000;
    const plane = gatedPlane([allowed(), { status: 200, body: refusedBody() }]);
    const { port } = onPlane(plane.impl, { now: () => t });
    const held = await port.access(ACC);
    plane.close();
    t += ACCESS_TTL_MS + 1;
    let answered = 0;
    const reads = burst(40, () => port.access(ACC, { staleAllow: true }).then((v) => {
      answered += 1;
      return v;
    }));
    await tick();
    expect(answered, "a read route waited on the program").toBe(40);
    expect(plane.accounts, "one refresh behind the whole burst").toHaveLength(2);
    for (const v of await reads) expect(v).toEqual(held);
    plane.open();
    await tick();
    // The refresh landed a refusal: the next read reads IT, from the cache, and asks nothing.
    await expect(port.access(ACC, { staleAllow: true }))
      .resolves.toMatchObject({ ok: false, reason: "payment_required" });
    expect(plane.accounts).toHaveLength(2);
  });

  it("a WRITE still waits for the answer, and joins the refresh a read started", async () => {
    let t = 1_000;
    const plane = gatedPlane([allowed(), { status: 200, body: refusedBody() }]);
    const { port } = onPlane(plane.impl, { now: () => t });
    await port.access(ACC);
    plane.close();
    t += ACCESS_TTL_MS + 1;
    let wrote: unknown = "pending";
    const read = port.access(ACC, { staleAllow: true });
    const write = port.access(ACC).then((v) => { wrote = v; return v; });
    await tick();
    expect(wrote, "a write answered before the program did").toBe("pending");
    expect(plane.accounts, "the write sent nothing of its own").toHaveLength(2);
    plane.open();
    await expect(write).resolves.toMatchObject({ ok: false, reason: "payment_required" });
    await read;
  });

  it("a held REFUSAL is never served stale: the read route asks first and reads the reopening", async () => {
    let t = 1_000;
    const plane = gatedPlane([{ status: 200, body: refusedBody() }, allowed()]);
    const { port } = onPlane(plane.impl, { now: () => t });
    await expect(port.access(ACC)).resolves.toMatchObject({ ok: false });
    plane.close();
    t += ACCESS_TTL_MS + 1;
    let seen: unknown = "pending";
    const read = port.access(ACC, { staleAllow: true }).then((v) => { seen = v; return v; });
    await tick();
    expect(seen, "a held refusal answered without asking").toBe("pending");
    expect(plane.accounts).toHaveLength(2);
    plane.open();
    await expect(read).resolves.toMatchObject({ ok: true, prices: { screener: 1 } });
  });

  it("the bound: one ms inside it answers at once; at the bound the read asks first", async () => {
    expect(ACCESS_STALE_ALLOW_MS).toBe(10 * 60_000);
    expect(ACCESS_STALE_ALLOW_MS).toBeGreaterThan(ACCESS_TTL_MS);
    for (const [age, answersAtOnce] of [
      [ACCESS_STALE_ALLOW_MS - 1, true], [ACCESS_STALE_ALLOW_MS, false],
    ] as const) {
      let t = 1_000;
      const plane = gatedPlane([allowed()]);
      const { port } = onPlane(plane.impl, { now: () => t });
      await port.access(ACC);
      plane.close();
      t += age;
      let answered = false;
      const read = port.access(ACC, { staleAllow: true }).then((v) => { answered = true; return v; });
      await tick();
      expect(answered, `a held allow ${String(age)} ms old`).toBe(answersAtOnce);
      expect(plane.accounts).toHaveLength(2);
      plane.open();
      await expect(read).resolves.toMatchObject({ ok: true });
    }
  });

  it("a refresh behind a read that faults or rejects is nobody's error; the held allow stands", async () => {
    const unreadable = { get entitlements(): never { throw new TypeError("unreadable body"); } };
    for (const behind of ["network-down", { status: 200, body: unreadable }] as PlaneAnswer[]) {
      let t = 1_000;
      const plane = gatedPlane([allowed(), behind]);
      const { port } = onPlane(plane.impl, { now: () => t });
      const held = await port.access(ACC);
      plane.close();
      t += ACCESS_TTL_MS + 1;
      await expect(port.access(ACC, { staleAllow: true })).resolves.toEqual(held);
      plane.open();
      await tick();
      // An unhandled rejection from the refresh fails this run; the answer stays the held allow.
      await expect(port.access(ACC, { staleAllow: true })).resolves.toEqual(held);
    }
  });

  it("without the option nothing changes: an expired verdict is asked for, as before", async () => {
    let t = 1_000;
    const plane = gatedPlane([allowed()]);
    const { port } = onPlane(plane.impl, { now: () => t });
    await port.access(ACC);
    plane.close();
    t += ACCESS_TTL_MS + 1;
    let answered = false;
    const plain = port.access(ACC).then((v) => { answered = true; return v; });
    await tick();
    expect(answered).toBe(false);
    plane.open();
    await plain;
    expect(plane.accounts).toHaveLength(2);
  });
});

/**
 * THE REFRESH BEHIND A READ, AND THE HOST THAT FREEZES (2026-09-28). A serverless host freezes an
 * instance once it answers, so a refresh behind a response ran only until then and its abort
 * fired on thaw. The host hands the client its keep-alive, and a call no request waited on says so.
 */
describe("access — the refresh behind a read is handed to the host", () => {
  const armed = (answers: PlaneAnswer[]) => {
    let t = 1_000;
    const handed: Array<Promise<unknown>> = [];
    const plane = gatedPlane(answers);
    const q = onPlane(plane.impl, {
      now: () => t, budgetsMs: { "/v1/access": 40 },
      waitUntil: (work) => { handed.push(work); },
    });
    return { ...q, plane, handed, advance: (ms: number) => { t += ms; } };
  };

  it("one refresh, one hand-off, and the handed work settles when the refresh does", async () => {
    const h = armed([allowed(), allowed()]);
    await h.port.access(ACC);
    expect(h.handed, "a read that waited hands nothing over").toHaveLength(0);
    h.plane.close();
    h.advance(ACCESS_TTL_MS + 1);
    await burst(5, () => h.port.access(ACC, { staleAllow: true }));
    expect(h.handed, "one refresh behind the burst, handed over once").toHaveLength(1);
    let settled = false;
    void h.handed[0]!.then(() => { settled = true; });
    await tick();
    expect(settled, "the host must keep it alive until the program answers").toBe(false);
    h.plane.open();
    await h.handed[0];
    expect(h.calls).toEqual([]);
  });

  it("a refresh nobody waited on that gets no answer is reported as having outlived its request", async () => {
    const h = armed([allowed()]);
    await h.port.access(ACC);
    h.plane.close();
    h.advance(ACCESS_TTL_MS + 1);
    await h.port.access(ACC, { staleAllow: true });
    await h.handed[0];
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ path: "/v1/access", status: null, outlivedRequest: true });
    expect(h.calls[0]!.elapsedMs).toBeGreaterThanOrEqual(35);
  });

  it("a write that joins the refresh makes it a call a request waited on", async () => {
    const h = armed([allowed()]);
    await h.port.access(ACC);
    h.plane.close();
    h.advance(ACCESS_TTL_MS + 1);
    await h.port.access(ACC, { staleAllow: true });
    await h.port.access(ACC);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ status: null, outlivedRequest: false });
  });

  it("reads behind a response that share the refresh leave it unwaited, so its fault outlived them", async () => {
    const h = armed([allowed()]);
    await h.port.access(ACC);
    h.plane.close();
    h.advance(ACCESS_TTL_MS + 1);
    await burst(5, () => h.port.access(ACC, { staleAllow: true }));
    await h.handed[0];
    expect(h.plane.accounts, "one refresh for the five").toHaveLength(2);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ status: null, outlivedRequest: true });
  });

  it("an askedAfter read that joins a refresh begun since its instant waits on it", async () => {
    const h = armed([allowed()]);
    await h.port.access(ACC);
    h.plane.close();
    h.advance(ACCESS_TTL_MS + 1);
    await h.port.access(ACC, { staleAllow: true });
    const since = 1_000 + ACCESS_TTL_MS + 1;
    await expect(h.port.access(ACC, { askedAfter: since }), "a fault since the instant is allow")
      .resolves.toEqual(UNMETERED_ACCESS);
    expect(h.plane.accounts, "it joined the refresh rather than asking again").toHaveLength(2);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ status: null, outlivedRequest: false });
  });

  it("control: a read that asks and waits reports outlivedRequest false", async () => {
    const h = armed(["silent"]);
    await h.port.access(ACC);
    expect(h.calls[0]).toMatchObject({ status: null, outlivedRequest: false });
    expect(h.handed).toHaveLength(0);
  });

  it("a host port that throws costs the hand-off, never the read's answer", async () => {
    let t = 1_000;
    const plane = gatedPlane([allowed(), allowed()]);
    const { port } = onPlane(plane.impl, {
      now: () => t, waitUntil: () => { throw new Error("no request context"); },
    });
    const held = await port.access(ACC);
    t += ACCESS_TTL_MS + 1;
    await expect(port.access(ACC, { staleAllow: true })).resolves.toEqual(held);
  });

  it("the price probe can outlive /health, so it is handed over too", async () => {
    const handed: Array<Promise<unknown>> = [];
    const plane = gatedPlane([allowed()]);
    plane.close();
    const { port } = onPlane(plane.impl, { waitUntil: (w) => { handed.push(w); } });
    const marker = port.aiPricing();
    await tick();
    expect(handed, "the probe's call is kept alive past the probe budget").toHaveLength(1);
    plane.open();
    await expect(marker).resolves.toBe("plane");
  });
});
