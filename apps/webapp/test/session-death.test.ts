/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * A DEAD SESSION MUST SAY SO, AND SAY IT ONCE, FROM CONFIRMATION.
 *
 * The defect, observed live: a session revoked server-side left the app rendering the mirror as
 * though it were live — rows painted, counts frozen, every failure dressed as a content failure
 * ("Couldn't load this message's files"), no sign-in prompt anywhere. This file drives the whole
 * repaired chain through the REAL provider, the REAL scheduler and the REAL refresh client, with
 * only `fetch` stubbed:
 *
 *   /sync answers a coded 401  →  the scheduler publishes `refused`  →  the shell probes the
 *   session (`POST /auth/refresh`, single-flight)  →  the refresh's own coded 401 confirms the
 *   death  →  the re-auth prompt renders over the shell.
 *
 * And the discipline in the other direction, which is the half `sync-scheduler.ts` earned the
 * hard way: a refresh that SUCCEEDS is a transient — the prompt must never render, because a
 * transient 401 once told a signed-in user they were signed out.
 *
 * Mount/fetch scaffolding follows `sync-liveness-shell.test.ts`, including its two stated
 * accommodations (React published as a global for the classic JSX runtime; the API base set
 * before any dynamic import).
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const emptyPage = (): Response =>
  new Response(
    JSON.stringify({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "c1",
      hasMore: false,
      serverTime: "2026-08-12T00:00:00.000Z",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/** OUR envelope's coded refusal — the only 401 shape either latch may act on. */
const coded401 = (): Response =>
  new Response(JSON.stringify({ error: { code: "unauthorized", message: "authentication required" } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

let syncAnswer: () => Response = emptyPage;
let refreshAnswer: () => Response = coded401;
let refreshCalls = 0;
let originalFetch: typeof globalThis.fetch;
let roots: Root[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  refreshCalls = 0;
  syncAnswer = emptyPage;
  refreshAnswer = coded401;
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/auth/refresh")) {
      refreshCalls += 1;
      return refreshAnswer();
    }
    if (url.includes("/sync/snapshot")) {
      return new Response(JSON.stringify({ error: { code: "not_found", message: "no snapshot here" } }), {
        status: 404, headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/sync")) return syncAnswer();
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(Math, "random").mockReturnValue(0.999999);
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => {
      root.unmount();
    });
  }
  roots = [];
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mountShell(opts: { keepTruth?: boolean } = {}): Promise<HTMLElement> {
  // The truth store is module state by design; every case starts from the resting value —
  // except where the case IS about state carried across a mount (`keepTruth`), which is
  // exactly how a client-side navigation behaves. The REAL wiring is then restored exactly as
  // production arms it: importing the session client re-registers nothing (module init already
  // ran), so the probe is re-registered here the same way `session-refresh.ts`'s module scope
  // does.
  const truth = await import("../app/shell/session-truth.js");
  if (!opts.keepTruth) truth.resetSessionTruthForTests();
  const { resumeSession } = await import("../app/session-refresh.js");
  truth.registerSessionProbe(() => {
    void resumeSession();
  });

  const { EngineProvider } = await import("../app/shell/engine.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        children: h(EngineProvider, {
          demo: false,
          resolveOwner: async () => ({ kind: "owner", accountId: "acct_live_1" }) as const,
          children: null,
        }),
      }),
    );
    await Promise.resolve();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return container;
}

const prompt = (container: HTMLElement): Element | null => container.querySelector(".session-end");

describe("the terminal 401 becomes a re-auth prompt", () => {
  it("a revoked session puts the prompt on screen within one probe, not one minute", async () => {
    syncAnswer = coded401;      // every drain is refused
    refreshAnswer = coded401;   // and the recovery path itself says the family is gone

    const container = await mountShell();
    // The first drain's refusal publishes `refused`; the shell's probe asks /auth/refresh.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(refreshCalls, "the refusal never reached the session probe").toBeGreaterThan(0);
    const dialog = prompt(container);
    expect(dialog, "no re-auth prompt rendered over a session the server confirmed dead").not.toBeNull();
    expect(dialog!.getAttribute("role")).toBe("alertdialog");
    expect(dialog!.textContent).toContain("You are signed out.");
    const signIn = dialog!.querySelector('a[href="/login"]');
    expect(signIn, "the prompt carries no sign-in path").not.toBeNull();
  });

  it("a transient 401 heals silently — refresh succeeds, and no prompt ever renders", async () => {
    let syncCalls = 0;
    // The first drain is refused; once the probe has refreshed, the world answers again.
    syncAnswer = () => (++syncCalls === 1 ? coded401() : emptyPage());
    refreshAnswer = () => new Response(null, { status: 204 });

    const container = await mountShell();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(refreshCalls).toBeGreaterThan(0);
    expect(prompt(container), "a transient refusal was announced as a sign-out").toBeNull();

    // …and stays absent through the scheduler's confirm window and the next healthy drains.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000);
    });
    expect(prompt(container)).toBeNull();
  });

  it("SIGNING IN CLEARS A HELD LATCH — the resolver's confirmed owner disproves the death", async () => {
    /**
     * Found in live verification, not in this file's first draft: visiting `/login` signed out
     * runs `auth.session()`, whose 401 refreshes, whose own coded 401 latches the store — and
     * the sign-in that follows is a CLIENT-SIDE navigation, so the module-state latch rode into
     * the freshly signed-in shell and the prompt rendered over a live session. The store is
     * latched here BEFORE the mount, exactly as that flow leaves it; the shell's own owner
     * confirmation must withdraw it.
     */
    const truth = await import("../app/shell/session-truth.js");
    const container = await mountShell();
    // Latch as the pre-sign-in /login visit does, then let the shell's confirmation land.
    await act(async () => {
      truth.markSessionDead();
    });
    expect(prompt(container), "sanity: the latch alone shows the prompt").not.toBeNull();

    // A fresh mount whose resolveOwner confirms a full session — the post-sign-in shell.
    // `keepTruth`: a sign-in is a client-side navigation, so the latch survives the remount.
    const after = await mountShell({ keepTruth: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(prompt(after), "a stale death latch survived a server-confirmed sign-in").toBeNull();
  });

  it("a platform 401 — no envelope — must NOT latch the death", async () => {
    syncAnswer = coded401;
    // Deployment protection answers 401 with an HTML body and no error envelope.
    refreshAnswer = () => new Response("<html>sign in to vercel</html>", { status: 401 });

    const container = await mountShell();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(refreshCalls).toBeGreaterThan(0);
    expect(prompt(container), "a platform 401 told a signed-in user they were signed out").toBeNull();
  });
});

/**
 * ═══ WHAT THE LAST REFRESH LEARNED — the third answer a boolean cannot carry ═══════════════
 *
 * `resumeSession()` answers `resumed`, `refused` or `unavailable`, and the file above is about the
 * half that is a fact: a coded 401 means the family is revoked. The other half is not a fact at all
 * — an `unavailable` from a 503, an offline tab or a platform 401 means *nothing was learned*, and reading
 * it as "no session" is how a `503 db_busy` came to render "You are signed out." over a live
 * cookie (the project's design notes).
 *
 * `lastRefreshOutcome()` is the report the session classifier reads. These pin it
 * per wire answer, because that predicate's verdict arm depends on the difference between
 * `"revoked"` and `"unavailable"` and nothing else in the app can tell them apart.
 */
describe("lastRefreshOutcome — three answers, never sticky", () => {
  let refreshOnce: () => Promise<"resumed" | "refused" | "unavailable">;
  let outcome: () => "minted" | "revoked" | "unavailable" | "superseded" | null;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../app/session-refresh");
    refreshOnce = mod.resumeSession;
    outcome = mod.lastRefreshOutcome;
  });

  const answerRefreshWith = (make: () => Response | never): void => {
    globalThis.fetch = vi.fn(async () => make()) as unknown as typeof globalThis.fetch;
  };

  it("is null before this tab has ever refreshed", () => {
    expect(outcome()).toBeNull();
  });

  it("204 is `minted` — a session exists again", async () => {
    answerRefreshWith(() => new Response(null, { status: 204 }));
    expect(await refreshOnce()).toBe("resumed");
    expect(outcome()).toBe("minted");
  });

  it("a CODED 401 is `revoked` — the server's own statement, and the only one", async () => {
    answerRefreshWith(() => new Response(
      JSON.stringify({ error: { code: "unauthorized", message: "family revoked" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    expect(await refreshOnce()).toBe("refused");
    expect(outcome()).toBe("revoked");
  });

  it("an UNCODED 401 is `unavailable` — a platform, not our server", async () => {
    // The distinction `session-refresh.ts` already makes for the death latch, reported rather
    // than only acted on. Deployment protection answers exactly this shape.
    answerRefreshWith(() => new Response("<html>sign in</html>", { status: 401 }));
    expect(await refreshOnce()).toBe("unavailable");
    expect(outcome()).toBe("unavailable");
  });

  it("a 503 is `unavailable` — the recovery path could not be walked", async () => {
    answerRefreshWith(() => new Response(
      JSON.stringify({ error: { code: "db_busy", message: "busy" } }),
      { status: 503, headers: { "content-type": "application/json" } },
    ));
    expect(await refreshOnce()).toBe("unavailable");
    expect(outcome()).toBe("unavailable");
  });

  it("a fetch that throws is `unavailable` — offline, DNS, an aborted tab", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    expect(await refreshOnce()).toBe("unavailable");
    expect(outcome()).toBe("unavailable");
  });

  it("is OVERWRITTEN by the next refresh, unlike the death latch", async () => {
    // This is the property that makes it safe to key a verdict on. `sessionIsDead()` is
    // deliberately sticky and survives a client-side sign-in (`engine.tsx`), so a classifier
    // reading THAT would meet one unrelated 503 and reproduce the pane over a live session.
    answerRefreshWith(() => new Response(
      JSON.stringify({ error: { code: "unauthorized", message: "gone" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    await refreshOnce();
    expect(outcome()).toBe("revoked");

    answerRefreshWith(() => new Response(null, { status: 204 }));
    await refreshOnce();
    expect(outcome(), "a revoked verdict outlived the refresh that disproved it").toBe("minted");
  });
});

/**
 * ═══ CLASS AND CODE, WRITTEN DOWN ═══════════════════════════════════════════════════════════
 *
 * The two states the classifier above turns on used to be indistinguishable on the wire: the
 * refresh door's `catch` answered a coded 401 for a revoked family AND for a database blip
 * so a person reporting either produced the same screenshot and the
 * same console. The door now names its refusal and answers a fault as a fault; this is the
 * client half of that — one line per non-minted refresh, carrying what came back.
 *
 * Never the body and never a token: the status, our own error code, and the class of a thrown
 * value (its VALUE too when the class is `String`, because a thrown string is its own message
 * and loses it at every class-only log site).
 */
describe("the refresh reports what it met — class and code", () => {
  let refreshOnce: () => Promise<"resumed" | "refused" | "unavailable">;
  let report: () => {
    outcome: string; status: number; code: string | null; errorClass: string | null; retryAfterMs: number | null;
  } | null;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.resetModules();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("../app/session-refresh");
    refreshOnce = mod.resumeSession;
    report = mod.lastRefreshReport;
  });

  afterEach(() => {
    warn.mockRestore();
  });

  const answerWith = (make: () => Response): void => {
    globalThis.fetch = vi.fn(async () => make()) as unknown as typeof globalThis.fetch;
  };

  it("a REVOKED family reports the server's own code, and says so once", async () => {
    answerWith(() => new Response(
      JSON.stringify({ error: { code: "unauthorized", message: "refresh token reuse detected" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    await refreshOnce();
    expect(report()).toEqual({
      outcome: "revoked", status: 401, code: "unauthorized", errorClass: null, retryAfterMs: null,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![1]).toMatchObject({ outcome: "revoked", status: 401, code: "unauthorized" });
  });

  it("a REUSE SWEEP's own refusal reports why beside its code", async () => {
    answerWith(() => new Response(
      JSON.stringify({ error: { code: "refresh_revoked", message: "refresh token reuse detected", details: { cause: "reuse" } } }),
      { status: 401, headers: { "content-type": "application/json" } },
    ));
    await refreshOnce();
    expect(report()).toEqual({
      outcome: "revoked", status: 401, code: "refresh_revoked", errorClass: null, retryAfterMs: null, cause: "reuse",
    });
  });

  it("a FAULT reports its status and code — the other state, told apart", async () => {
    answerWith(() => new Response(
      JSON.stringify({ error: { code: "db_busy", message: "busy" } }),
      { status: 503, headers: { "content-type": "application/json", "retry-after": "5" } },
    ));
    await refreshOnce();
    // The server's advice rides along: the splash and the renewal seed their backoff from it.
    expect(report()).toEqual({
      outcome: "unavailable", status: 503, code: "db_busy", errorClass: null, retryAfterMs: 5_000,
    });
    expect(warn.mock.calls[0]![1]).toMatchObject({ outcome: "unavailable", status: 503, code: "db_busy" });
  });

  it("a thrown value reports its CLASS — there was no answer to read a code from", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    await refreshOnce();
    expect(report()).toEqual({
      outcome: "unavailable", status: 0, code: null, errorClass: "TypeError", retryAfterMs: null,
    });
  });

  it("a thrown STRING carries its value — a class-only line would lose the whole payload", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw "the bridge is gone";
    }) as unknown as typeof globalThis.fetch;
    await refreshOnce();
    expect(report()!.errorClass).toBe("String: the bridge is gone");
  });

  it("a MINTED refresh says nothing — the log is for what went wrong", async () => {
    answerWith(() => new Response(null, { status: 204 }));
    await refreshOnce();
    expect(report()).toEqual({
      outcome: "minted", status: 204, code: null, errorClass: null, retryAfterMs: null,
    });
    expect(warn, "a healthy refresh wrote a line").not.toHaveBeenCalled();
  });
});
