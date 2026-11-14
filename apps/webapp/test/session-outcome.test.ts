/** @vitest-environment jsdom */
/**
 * ═══ THE PREDICATE, AS A TABLE ════════════════════════════════════════════════════════════
 *
 * `resolveOwnerOutcome` decides whether the product is allowed to tell somebody they are
 * signed out. Its `none` arm is the verdict, and the whole slice rests on that arm being
 * exactly two facts wide — so it is enumerated here rather than exercised through a shell,
 * where a missing row would be invisible.
 *
 * The rule under test, in one line: **only the server's own answer may be a verdict.** A
 * status code is not an answer, and neither is the absence of one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const { resolveOwnerOutcome } = await import("../app/(product)/session-outcome");
const { resetSessionTruthForTests } = await import("@ohmail/app-logic/session/session-truth");

const ACCOUNT = "acct_predicate_1";
/**
 * `fetch` FORBIDS A BODY on 101, 103, 204, 205 and 304, and `new Response(body, {status})` throws
 * for them. The sweep below built every status with a body, so those five threw inside the
 * harness, were converted to `status: 0` by the client's own catch, and were never swept at all —
 * a hole a reviewer walked straight through with a 304 that rewrote itself into the 401 arm.
 *
 * A status the harness cannot construct is a status the sweep silently skips, which is the same
 * failure as a list somebody recalled.
 */
const BODYLESS = new Set([101, 103, 204, 205, 304]);

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(BODYLESS.has(status) ? null : JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...headers },
  });

const fullBody = {
  user: {
    userId: "usr_1", accountId: ACCOUNT, email: "p@example.invalid", displayName: "P",
    emailVerified: true, twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
};

let originalFetch: typeof globalThis.fetch;

/**
 * Answer the session read with `session`, and every refresh with `refresh`.
 *
 * The refresh matters even where a test never mentions it: `api()` refreshes-and-retries a
 * 401 before the error ever reaches the classifier, so what `POST /auth/refresh` said is half
 * of what the `none` arm is allowed to conclude.
 */
function wire(session: () => Response | never, refresh: () => Response = () => json({}, 500)): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/auth/refresh")) return refresh();
    return session();
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(async () => {
  resetSessionTruthForTests();
  /*
   * AND THE OWNER BINDING, because the classifier under test SETS it: a confirmed owner binds
   * the Cloud client to that account (`session-outcome.ts`), and nothing here was putting it
   * back. Every case after the first successful one therefore ran against a BOUND client with no
   * `tf_owner` in the jar — which now fails closed, so the request never left and the assertions
   * were reading a client-side refusal instead of the answer they scripted. It looked like seven
   * unrelated regressions in tests nobody had touched.
   *
   * Module state a test drives has to be reset by that test's own harness; `resetSessionTruthForTests`
   * is the same admission one line up.
   */
  const { bindApiOwner } = await import("../app/api-client.js");
  bindApiOwner(null);
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  originalFetch = globalThis.fetch;
});
afterEach(async () => {
  const { bindApiOwner } = await import("../app/api-client.js");
  bindApiOwner(null);
  document.cookie = "tf_owner=; Path=/; Max-Age=0";
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("owner — the server named an account", () => {
  it("200 with scope full and an account id", async () => {
    wire(() => json(fullBody, 200));
    expect(await resolveOwnerOutcome()).toEqual({ kind: "owner", accountId: ACCOUNT });
  });
});

describe("none — the two answers that are verdicts, and only those", () => {
  it("200 with scope enrollment: the password factor alone may not open a mailbox", async () => {
    wire(() => json({ ...fullBody, scope: "enrollment" }, 200));
    expect(await resolveOwnerOutcome()).toEqual({ kind: "none" });
  });

  it("200 with an unrecognised scope fails toward the verdict, not toward the mailbox", async () => {
    // `=== "full"` and not `!== "enrollment"`: a future third scope must not be a silent
    // promotion. Same comparison `session-gate.ts` makes at the edge, for the same reason.
    wire(() => json({ ...fullBody, scope: "delegated" }, 200));
    expect(await resolveOwnerOutcome()).toEqual({ kind: "none" });
  });

  it("a coded 401 whose refresh answers a coded 401: the revoked family", async () => {
    wire(
      () => json({ error: { code: "unauthorized", message: "no session" } }, 401),
      () => json({ error: { code: "unauthorized", message: "refresh family revoked" } }, 401),
    );
    expect(await resolveOwnerOutcome()).toEqual({ kind: "none" });
  });
});

describe("unknown — everything else, enumerated", () => {
  const cases: Array<[string, () => Response, number | null]> = [
    ["503 db_busy with Retry-After: 5", () => json(
      { error: { code: "db_busy", message: "busy", retryable: true } }, 503, { "retry-after": "5" },
    ), 5_000],
    ["500 with our envelope", () => json({ error: { code: "internal", message: "boom" } }, 500), null],
    ["502 from a platform, HTML body, no envelope", () => new Response("<html>502</html>", {
      status: 502, headers: { "content-type": "text/html" },
    }), null],
    ["504 gateway timeout", () => new Response("", { status: 504 }), null],
    ["429 with Retry-After: 2", () => json(
      { error: { code: "rate_limited", message: "slow" } }, 429, { "retry-after": "2" },
    ), 2_000],
    // `/auth/session` is `enrollmentOk`, so no ohmail 403 exists there today. A future one
    // must not become a verdict by DEFAULT — it has to be argued for, in a diff.
    ["403 with our envelope", () => json({ error: { code: "forbidden", message: "no" } }, 403), null],
    ["403 with no envelope", () => new Response("nope", { status: 403 }), null],
    // 419 is not a status this API sends. If one ever arrives, something else produced it.
    ["419 from something that is not our API", () => new Response("", { status: 419 }), null],
    ["a 200 with no scope field — a captive portal, not our server", () => json({ hello: "wifi" }, 200), null],
    ["a 200 with scope full and no account id", () => json({ ...fullBody, user: {} }, 200), null],
    ["a 200 whose body is not JSON at all", () => new Response("<html>portal</html>", {
      status: 200, headers: { "content-type": "text/html" },
    }), null],
  ];

  for (const [name, answer, retryAfterMs] of cases) {
    it(name, async () => {
      wire(answer);
      expect(await resolveOwnerOutcome()).toEqual({ kind: "unknown", retryAfterMs });
    });
  }

  it("a fetch that rejects outright — offline, DNS, a dropped socket", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    expect(await resolveOwnerOutcome()).toEqual({ kind: "unknown", retryAfterMs: null });
  });

  it("an uncoded 401 — a platform interposing, not our server refusing", async () => {
    wire(
      () => new Response("<html>401</html>", { status: 401, headers: { "content-type": "text/html" } }),
      () => new Response("<html>401</html>", { status: 401, headers: { "content-type": "text/html" } }),
    );
    expect(await resolveOwnerOutcome()).toEqual({ kind: "unknown", retryAfterMs: null });
  });

  it("a coded 401 whose refresh could not be MADE is not a revocation", async () => {
    // The failure `sync-scheduler.ts` measured during a deploy window: coded 401s that were
    // not revocations. Nothing was learned, so nothing may be claimed.
    wire(
      () => json({ error: { code: "unauthorized", message: "no session" } }, 401),
      () => json({ error: { code: "db_busy", message: "busy" } }, 503),
    );
    expect(await resolveOwnerOutcome()).toEqual({ kind: "unknown", retryAfterMs: null });
  });

  it("a coded 401 whose refresh MINTED a session is deploy skew, not a revocation", async () => {
    // A server that mints a session and then refuses it disagrees with itself. That is a
    // reason to ask again, never a reason to tell somebody their account is gone.
    wire(
      () => json({ error: { code: "unauthorized", message: "no session" } }, 401),
      () => new Response(null, { status: 204 }),
    );
    expect(await resolveOwnerOutcome()).toEqual({ kind: "unknown", retryAfterMs: null });
  });
});

describe("Retry-After is read only where it can be trusted", () => {
  const header = async (value: string): Promise<number | null> => {
    wire(() => json({ error: { code: "db_busy", message: "busy" } }, 503, { "retry-after": value }));
    const outcome = await resolveOwnerOutcome();
    return outcome.kind === "unknown" ? outcome.retryAfterMs : null;
  };

  it("integer seconds become milliseconds", async () => {
    expect(await header("5")).toBe(5_000);
    expect(await header("60")).toBe(60_000);
  });

  it("an HTTP-date is refused rather than guessed at", async () => {
    // Parsing it would mean trusting the CLIENT clock to subtract it, and this repository's
    // own build host runs ~two minutes slow. A perfectly correct header would yield a
    // negative delay. The caller's own backoff is the honest fallback.
    expect(await header("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  });

  it("zero, negatives and nonsense are refused", async () => {
    expect(await header("0")).toBeNull();
    expect(await header("-3")).toBeNull();
    expect(await header("soon")).toBeNull();
    expect(await header("2.5")).toBeNull();
  });

  it("is NOT clamped here — the ceiling belongs to the consumer", async () => {
    // `confirm-schedule.ts` clamps at CONFIRM_CAP_MS because it is the layer that knows how
    // long a person will look at a blank screen. Clamping in both places would hide which one
    // is the policy.
    expect(await header("3600")).toBe(3_600_000);
  });
});

/**
 * ═══ NO STATUS BUT 401 IS EVER A VERDICT — SWEPT, NOT SPELT ═══════════════════════════════
 *
 * `session-verdict-guard.test.ts` reads the classifier's SOURCE and requires that `err.status`
 * is compared to exactly `0` and `401` and that no other status literal appears. That guard was
 * evaded twice by review, each time with a different spelling — `[418].includes(err.status)`,
 * then a destructured local compared against a hex alias — and each repair taught it one more
 * spelling. A guard that learns spellings is always one spelling behind.
 *
 * So the claim is made behaviourally as well, over EVERY status a server can send. This cannot
 * be evaded by how the code is written, because it does not read the code: it asks the shipped
 * classifier what it answers. The source guard stays beside it — it catches a `retryable` read
 * and a `sessionIsDead` read, which no status sweep can see — but this is the one that owns the
 * rule the ruling actually states.
 *
 * `none` has exactly two arms and neither is reachable from a status alone: a 200 whose scope is
 * not `full`, and a CODED 401 whose refresh came back revoked. Every other status, coded or not,
 * refreshed or not, is an absence of an answer.
 */
/**
 * ═══ A CONFIRMED OWNER BINDS THE CLOUD CLIENT ════════════════════════════════════════════
 *
 * The boundary in `api()` is only as good as the thing that arms it, and arming it is one line
 * inside this classifier — the sort of line a refactor drops without a single suite noticing,
 * because every test of the boundary itself binds explicitly. That is not hypothetical: this
 * case exists because the line WAS lost once, to a careless file restore, and thousands of tests stayed
 * green over a product where the whole settings surface was ungated again.
 *
 * So the wiring is the assertion: after a confirmed owner, a request for a DIFFERENT account is
 * refused with nothing else having been set up.
 */
describe("the classifier commits nothing", () => {
  /**
   * It used to call `bindApiOwner` on its way past. That mutates shared state which in-flight
   * requests are judged against, and it does so before the CALLER has checked cancellation or
   * compared the answer against the mirror on screen — so a warm request that left as A could be
   * re-judged as B and allowed to recover under it. The commitment lives in `EngineProvider`'s
   * session-check arm now (`warm-open.test.tsx` pins both directions of it); this pins that the classifier
   * is the pure function it is documented to be.
   */
  it("answering an owner binds nothing", async () => {
    const client = await import("../app/api-client");
    client.bindApiOwner(null);
    wire(() => json(fullBody, 200));
    expect((await resolveOwnerOutcome()).kind).toBe("owner");
    expect(client.apiOwnerBinding().kind, "the classifier bound the client on its way past")
      .toBe("public");
  });
});

describe("the verdict is not reachable from a status", () => {
  /*
   * EVERY status a server can send, not a list somebody recalled. The list WAS a list, and review
   * evaded it by picking 506 — a status nobody thinks about — with a mutation that also dodged
   * both source scans:
   *
   *     if (err["status"] === 0x1fa) { Object.defineProperty(err, "status", { value: 0x191 }); }
   *
   * No second `err.status` spelling and no decimal three-digit literal, then straight into the
   * 401 branch. A curated list of statuses has exactly the weakness a curated list of spellings
   * has, and this file exists because of the second one.
   *
   * 401 is excluded because it is the one status that CAN be a verdict, and only in company: the
   * control below pins that it still is.
   */
  const STATUSES = Array.from({ length: 500 }, (_, i) => 100 + i).filter((n) => n !== 401);

  /**
   * `lastRefreshOutcome()` PRIMED TO "revoked" FIRST, and without this the sweep proves much less
   * than it looks.
   *
   * The verdict arm needs three facts together: status 401, a CODED envelope, and a refresh this
   * tab performed that came back revoked. A swept status like 506 is not recoverable, so `api()`
   * never refreshes for it — `lastRefreshOutcome()` keeps whatever the last refresh in the module
   * said, and in a fresh run that is `null`. So a status smuggled into the 401 branch met a
   * missing third fact and answered `unknown` for a reason that had nothing to do with the guard.
   * Measured: review's own 506 mutation passed the un-primed sweep.
   *
   * The latch is module state and a real tab reaches "revoked" the ordinary way — visit `/login`
   * signed out and it is set. So each status is swept in the WORST state the client can be in,
   * which is the only state in which the answer is interesting.
   */
  const primeRevoked = async (): Promise<void> => {
    wire(
      () => json({ error: { code: "unauthorized", message: "no" } }, 401),
      () => json({ error: { code: "unauthorized", message: "gone" } }, 401),
    );
    expect((await resolveOwnerOutcome()).kind, "the priming round did not reach the verdict arm")
      .toBe("none");
  };

  it("every status but 401 answers `unknown`, even with a revoked refresh already latched", async () => {
    for (const status of STATUSES) {
      await primeRevoked();
      wire(
        () => json({ error: { code: "nope", message: "no" } }, status),
        () => json({ error: { code: "unauthorized" } }, 401),
      );
      const outcome = await resolveOwnerOutcome();
      expect(outcome.kind, `status ${status} with a revoked refresh became a verdict`).not.toBe("none");
      expect(outcome.kind, `status ${status} with a revoked refresh became an owner`).not.toBe("owner");
    }
  });

  it("…and the same, with a refresh that minted or was unavailable", async () => {
    for (const status of STATUSES) {
      for (const [label, refresh] of [
        ["a minted refresh", () => new Response(null, { status: 204 })],
        ["an unavailable refresh", () => json({ error: { code: "internal" } }, 503)],
      ] as const) {
        wire(() => json({ error: { code: "nope", message: "no" } }, status), refresh);
        const outcome = await resolveOwnerOutcome();
        expect(outcome.kind, `status ${status} with ${label} became a verdict`).not.toBe("none");
        expect(outcome.kind, `status ${status} with ${label} became an owner`).not.toBe("owner");
      }
    }
  });

  /* The control, and without it the sweep above would pass over a classifier that answered
     `unknown` to absolutely everything — including the two facts that ARE verdicts. */
  /**
   * ── AND WHY THE FIVE BODYLESS STATUSES ARE SAFE FOR A REASON THE SWEEP CANNOT SHOW ────────
   *
   * The sweep now reaches 101/103/204/205/304 (it used to throw on them inside the harness and
   * skip them silently). It cannot make them INTERESTING, and that is a fact about the wire
   * rather than a gap: the verdict arm needs `wire.coded`, which is `typeof env?.code === "string"`
   * — an envelope parsed from the body — and these statuses forbid a body. So they answer
   * `unknown` for two independent reasons, and the sweep can only see one of them.
   *
   * That is also why review's 304 example does not reach the verdict branch it claims: rewriting
   * the status to 401 leaves `coded` false, and the arm is a conjunction. Measured, not reasoned:
   * the mutation was planted and the sweep stayed green because the request was never a
   * candidate. The claim is pinned here so the next reader does not re-derive it — and so that a
   * change making `coded` default true fails loudly.
   */
  it("a bodyless status cannot carry a coded envelope, so it cannot be a verdict", async () => {
    const { ApiError } = await import("../app/api-client");
    await primeRevoked();
    wire(() => json({ error: { code: "unauthorized" } }, 304));
    const outcome = await resolveOwnerOutcome();
    expect(outcome.kind).toBe("unknown");
    // The mechanism itself, so this cannot quietly stop being true.
    const err = await api304();
    expect(err, "a 304 stopped surfacing as an ApiError").toBeInstanceOf(ApiError);
    expect((err as InstanceType<typeof ApiError>).wire.coded,
      "a bodyless response produced a coded envelope — the sweep's blind spot is now real")
      .toBe(false);
  });

  /** One 304 through the real client, returned rather than thrown, so it can be inspected. */
  async function api304(): Promise<unknown> {
    const { api } = await import("../app/api-client");
    wire(() => json({ error: { code: "unauthorized" } }, 304));
    return api("/auth/session", { ceremony: true }).then(() => null, (e: unknown) => e);
  }

  it("…and the two arms that ARE verdicts still are", async () => {
    wire(() => json({ ...fullBody, scope: "enrollment" }, 200));
    expect((await resolveOwnerOutcome()).kind, "an enrollment scope stopped being a verdict")
      .toBe("none");
    wire(
      () => json({ error: { code: "unauthorized", message: "no" } }, 401),
      () => json({ error: { code: "unauthorized", message: "gone" } }, 401),
    );
    expect((await resolveOwnerOutcome()).kind, "a confirmed revocation stopped being a verdict")
      .toBe("none");
    wire(() => json(fullBody, 200));
    expect((await resolveOwnerOutcome()).kind, "a live session stopped being an owner")
      .toBe("owner");
  });
});

describe("a broken build is not an auth outcome", () => {
  it("api_unconfigured is rethrown rather than classified", async () => {
    /*
     * Driven through the REAL path rather than by throwing the error at the classifier.
     * `attempt()` raises `api_unconfigured` from its own first line when the bundle has no
     * API base, and it converts every fetch rejection into `OFFLINE_CODE` — so a hand-thrown
     * `ApiError` from the fetch stub is swallowed into `unknown` and would have proven the
     * opposite of what it looked like. `API_BASE` is read at module scope, so the only honest
     * way to unset it is a fresh module registry.
     */
    const previous = process.env.NEXT_PUBLIC_API_BASE;
    process.env.NEXT_PUBLIC_API_BASE = "";
    try {
      vi.resetModules();
      const unarmed = await import("../app/(product)/session-outcome");
      const client = await import("../app/api-client");
      globalThis.fetch = vi.fn(async () => json(fullBody, 200)) as unknown as typeof globalThis.fetch;
      // A bundle wired to no server telling a signed-in person their session expired is the
      // silent lie `EngineUnarmedError` exists to end. It has to escape.
      await expect(unarmed.resolveOwnerOutcome()).rejects.toBeInstanceOf(client.ApiError);
      await expect(unarmed.resolveOwnerOutcome()).rejects.toMatchObject({
        status: 0, code: "api_unconfigured",
      });
    } finally {
      process.env.NEXT_PUBLIC_API_BASE = previous;
      vi.resetModules();
    }
  });
});
