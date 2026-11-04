/** @vitest-environment jsdom */
/**
 * ═══ `/login`'s "YOU ARE ALREADY SIGNED IN" CHECK — the other half of the same defect ══════
 *
 * The reported symptom had two halves that contradicted each other: the shell said "You are
 * signed out." over a live session, and clicking **Sign in** from that pane SOMETIMES showed
 * the form and SOMETIMES dropped the person straight into their mailbox. Both halves are one
 * design error made twice. This page's bootstrap read:
 *
 *     } catch { }   // "no session, or unreachable — the form below is the right answer"
 *
 * A form IS the right answer for both, but only once the question has been asked. Inside the
 * same `503 db_busy` burst the shell was rendering the verdict for, this check met its own 503
 * and showed the form; ten seconds later it forwarded. Same session, same minute, two answers.
 *
 * So it runs the same ladder from the same module. Three claims:
 *   · a transient is retried and then forwards;
 *   · an ANSWERED refusal stops at once — no ladder behind a form somebody is about to use;
 *   · the ceremony wins: once a password is submitted, a late confirm may not navigate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as {
  act: (cb: () => Promise<void> | void) => Promise<void>;
}).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-09-04T12:40:00.000Z";
const ACCOUNT = "acct_login_1";

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...headers },
  });

const full = (): Response => json({
  user: {
    userId: "usr_login_1", accountId: ACCOUNT, email: "l@example.invalid", displayName: "L",
    emailVerified: true, twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
  },
  scope: "full",
}, 200);

const enrollment = (): Response => json({
  user: {
    userId: "usr_login_1", accountId: ACCOUNT, email: "l@example.invalid", displayName: "L",
    emailVerified: false, twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
  },
  scope: "enrollment",
}, 200);

const db503 = (): Response => json(
  { error: { code: "db_busy", message: "busy", retryable: true } }, 503, { "retry-after": "5" },
);

/** Where `router.replace` was sent, in order. The page's only observable navigation. */
let replaced: string[] = [];
/** Every request, in order, with how it ended — the evidence the ordering claims rest on. */
let wire: string[] = [];
/** Held open until a test releases it, so a request can be genuinely IN FLIGHT. */
let releaseRefresh = () => {};
/** `null` from an entry HOLDS the request open — see the fetch mock. */
let sessionScript: Array<() => Response | null> = [];
let sessionCalls = 0;
let loginCalls = 0;
let roots: Root[] = [];
let originalFetch: typeof globalThis.fetch;

/*
 * ONE router object, hoisted — not a fresh one per call.
 *
 * `useRouter()` in Next returns a stable object, and the bootstrap effect depends on it. A
 * mock that minted a new one per render made the effect re-run on EVERY render and start a
 * fresh ladder each time, which showed up as three navigations where the product makes one.
 * A harness that is less stable than the thing it stands in for measures the harness.
 */
const router = {
  replace: (to: string) => { replaced.push(to); },
  push: (to: string) => { replaced.push(to); },
};
vi.mock("next/navigation", () => ({ useRouter: () => router }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ISO));
  replaced = [];
  sessionScript = [full];
  sessionCalls = 0;
  loginCalls = 0;
  wire = [];
  releaseRefresh = () => {};
  window.location.hash = "";
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    /*
     * THE SIGNAL IS HONOURED, because a mock that ignores `RequestInit` turns every abort
     * assertion into an assertion about the mock. The previous version discarded it, so the
     * "submitting cancels it" case stayed green with signal forwarding removed entirely.
     */
    const signal = init?.signal;
    /* An abort is RECORDED, not merely honoured. Without the record there is nothing to assert
       on: a request that resolves before the submit and one that is cancelled by it look the
       same from outside, which is exactly how the cancellation claim below went unproven. */
    const abortable = (p: Promise<Response>, name: string): Promise<Response> => (
      signal
        ? Promise.race([p, new Promise<Response>((_, rej) => {
          const fire = (): void => {
            wire.push(`${name}:aborted`);
            rej(new DOMException("Aborted", "AbortError"));
          };
          if (signal.aborted) fire();
          else signal.addEventListener("abort", fire);
        })])
        : p
    );
    if (url.includes("/auth/session")) {
      sessionCalls += 1;
      wire.push(`session:${sessionCalls}`);
      const answer = sessionScript[Math.min(sessionCalls, sessionScript.length) - 1]!();
      /* `null` from the script means HOLD THIS OPEN — a session read that is genuinely still on
         the wire when the password is submitted, which is the only state in which "submitting
         aborts the confirm" is a claim about anything. */
      return abortable(
        answer === null ? new Promise<Response>(() => {}) : Promise.resolve(answer),
        "session",
      );
    }
    if (url.includes("/auth/login")) {
      loginCalls += 1;
      wire.push("login");
      return json({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }, 200);
    }
    if (url.includes("/auth/refresh")) {
      wire.push("refresh:start");
      // Deliberately NOT abortable: the refresh is shared single-flight state and the product
      // must never cancel it on one caller's behalf. Held until the test lets it finish.
      return new Promise((resolve) => {
        releaseRefresh = () => {
          wire.push("refresh:end");
          // A renewal's 204 writes the new jar, the readable half of it included.
          document.cookie = "tf_csrf=renewed; Path=/";
          resolve(new Response(null, { status: 204 }));
        };
      });
    }
    if (url.includes("/hello")) return json({ features: { pairing: false } }, 200);
    return json({}, 200);
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots = [];
  document.cookie = "tf_csrf=; Path=/; Max-Age=0";
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function mountLogin(): Promise<HTMLElement> {
  const { LoginScreen } = await import("../app/(product)/login/LoginScreen.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: new Date(ISO),
      children: h(LoginScreen, {}),
    }));
  });
  return container;
}

/** One `act` per step — see `fixtures/cloud-confirm-shell.ts` for why a long one cannot work. */
async function tick(ms: number): Promise<void> {
  const STEP = 250;
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };
  await act(flush);
  for (let left = ms; left > 0; left -= STEP) {
    const span = Math.min(STEP, left);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(span);
      await flush();
    });
  }
}

const formIsUp = (el: HTMLElement): boolean => el.querySelector("form") !== null;

describe("the already-signed-in check", () => {
  it("forwards when the server confirms a session", async () => {
    const el = await mountLogin();
    await tick(1_000);
    expect(replaced, "a live session was not forwarded").toEqual(["/"]);
    void el;
  });

  it("a 503 then a 200 forwards — and the FORM is up the whole time", async () => {
    sessionScript = [db503, full];
    const el = await mountLogin();

    // The form renders throughout. A form is not a verdict, and making somebody wait behind a
    // spinner to be told they may type their password would be a worse trade than the one
    // this fixes.
    expect(formIsUp(el), "the page hid its form behind a pending check").toBe(true);
    expect(replaced, "it forwarded before the server had answered").toEqual([]);

    await tick(10_000);
    expect(sessionCalls, "the transient was not retried").toBe(2);
    expect(replaced, "a live session behind one 503 was never found").toEqual(["/"]);
  });

  it("an ANSWERED refusal stops at once: one ask, no ladder, no forward", async () => {
    // `scope: "enrollment"` is the server saying there is nothing to forward to. Retrying it
    // would be three pointless requests behind a form the person is already using.
    sessionScript = [enrollment];
    const el = await mountLogin();
    await tick(30_000);
    expect(sessionCalls, "an answered refusal was retried").toBe(1);
    expect(replaced, "an enrollment session was forwarded to the mailbox").toEqual([]);
    expect(formIsUp(el)).toBe(true);
  });

  it("gives up after the bounded ladder rather than asking for ever", async () => {
    sessionScript = [db503];
    const el = await mountLogin();
    await tick(60_000);
    expect(sessionCalls, "the ladder is not four asks long").toBe(4);
    expect(replaced).toEqual([]);
    expect(formIsUp(el), "the form went away when the check failed").toBe(true);
  });

  /**
   * ── THE ABORT ITSELF, WHICH THE CASE BELOW NEVER MEASURED ─────────────────────────────────
   *
   * That case is titled "submitting cancels the in-flight confirm" and does not show it. By the
   * time it submits, the session read has already RESOLVED (a 401) and the only thing still on
   * the wire is the refresh, which is deliberately not abortable. Its `cancelled` flag suppresses
   * navigation on its own, so the assertions held with signal forwarding removed entirely — the
   * mock did not even record aborts until this case needed it to.
   *
   * Aborting is not a nicety here. A confirm still in flight that 401s enters the shared refresh
   * with the OLD account's cookie, and a refresh rewrites every session cookie whenever it lands:
   * after a completed sign-in that restores the previous account or clears the new one.
   * Suppressing a promise continuation cannot undo a `Set-Cookie`; only stopping the request
   * before it becomes a refresh can. So the request has to actually stop — once its answer has been
   * waited for, within the bound: a revoke it carries wipes the revoked account's copy before the
   * sign-in leaves (`revoked-door.ts`).
   */
  it("a session read still ON THE WIRE is heard until the bound, then aborted before the ceremony goes", async () => {
    sessionScript = [() => null];               // held open — see the fetch mock
    const el = await mountLogin();
    await tick(500);
    expect(wire, "the confirm never left, so there is nothing to abort").toContain("session:1");
    expect(wire, "the held request answered by itself").not.toContain("session:aborted");

    const form = el.querySelector("form")!;
    const setValue = (input: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setValue(el.querySelector<HTMLInputElement>('input[type="email"]')!, "l@example.invalid");
      setValue(el.querySelector<HTMLInputElement>('input[type="password"]')!, fixturePassword("login-bootstrap"));
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const { SETTLE_DEADLINE_MS } = await import("../app/session-refresh.js");
    await tick(SETTLE_DEADLINE_MS - 1_000);
    expect(wire, "the read was stopped before its answer or the bound").not.toContain("session:aborted");
    expect(loginCalls, "the ceremony left before the read's answer or the bound").toBe(0);
    await tick(2_000);

    expect(wire, "the in-flight session read was left running behind the ceremony")
      .toContain("session:aborted");
    // …and the ceremony went ahead, after the read was stopped.
    expect(loginCalls, "the ceremony never ran").toBe(1);
    expect(wire.indexOf("session:aborted"), "the ceremony left beside the read").toBeLessThan(wire.indexOf("login"));
    expect(replaced, "a late confirm navigated out of the ceremony").toEqual([]);
  });

  it("SUBMITTING CANCELS THE IN-FLIGHT CONFIRM, and the refresh is not cancelled but WAITED FOR", async () => {
    /*
     * The race, in order: the bootstrap's confirm 401s and enters the shared refresh with the
     * OLD account's cookie; the person submits a password for a different account; the refresh
     * response lands afterwards and rewrites every session cookie — restoring the previous
     * account or clearing the new session. Ignoring the answer cannot undo a `Set-Cookie`.
     *
     * Two claims, and they pull in opposite directions:
     *   · the refresh must NOT be aborted — it is shared single-flight state and other callers
     *     are awaiting it (a sync drain, a mailbox read, the resume splash);
     *   · the login must not be SENT until it has settled, so the ceremony writes last.
     * The renewal mints, and the read it retries answers the old account: the check has its answer.
     */
    sessionScript = [() => json({ error: { code: "unauthorized", message: "no" } }, 401), full];
    const el = await mountLogin();
    await tick(500);
    expect(wire, "the bootstrap never entered the refresh, so this proves nothing")
      .toContain("refresh:start");
    expect(wire).not.toContain("refresh:end");

    const form = el.querySelector("form")!;
    const setValue = (input: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setValue(el.querySelector<HTMLInputElement>('input[type="email"]')!, "l@example.invalid");
      setValue(el.querySelector<HTMLInputElement>('input[type="password"]')!, fixturePassword("login-bootstrap"));
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await tick(1_000);

    // The ceremony is HELD: the refresh is still in flight, so no login has been sent.
    expect(loginCalls, "the login was sent while a refresh was still rewriting the jar").toBe(0);

    // Release it. Only now may the ceremony proceed, and it must proceed.
    await act(async () => { releaseRefresh(); });
    await tick(1_000);
    expect(loginCalls, "the ceremony never resumed after the refresh settled").toBe(1);
    expect(wire.indexOf("refresh:end"), "the login was sent before the refresh finished")
      .toBeLessThan(wire.indexOf("login"));
    expect(replaced, "a late confirm navigated out of the ceremony").not.toContain("/");
    // And the refresh was never cancelled: it is shared single-flight state, and other callers
    // are awaiting the very same promise. Ordering is the instrument here, not cancellation.
    expect(wire, "the shared refresh was aborted on one caller's behalf")
      .not.toContain("refresh:aborted");
  });

  /* LAST IN THE FILE, and deliberately: it leaves the module-scoped single-flight refresh
     unsettled for the rest of the process, so any case after it would find `inFlight` already
     set and never enter the refresh at all — measured, as a failure in the case above. */
  /**
   * ── AND THE WAIT HAS A FLOOR ──────────────────────────────────────────────────────────────
   *
   * The ordering below is right and it was unbounded. Neither the refresh fetch nor the Web Lock
   * it may be queued behind has an application deadline — both deliberately, so a cold start does
   * not become a sign-out — so a refresh that never settles meant a password submit that waited
   * for ever: no login request, a form busy indefinitely, and nothing on screen saying why.
   *
   * A race the ceremony MAY lose is a better outcome than a sign-in that CANNOT happen, so the
   * wait expires and the ceremony proceeds. The refresh itself is untouched: it is still shared,
   * still single-flight, still uncancelled, and it is still running when the login is sent.
   */
  it("a refresh that never settles does not hold the sign-in for ever", async () => {
    const { SETTLE_DEADLINE_MS } = await import("../app/session-refresh.js");
    sessionScript = [() => json({ error: { code: "unauthorized", message: "no" } }, 401)];
    const el = await mountLogin();
    await tick(500);
    expect(wire, "the bootstrap never entered the refresh").toContain("refresh:start");

    const form = el.querySelector("form")!;
    const setValue = (input: HTMLInputElement, value: string): void => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await act(async () => {
      setValue(el.querySelector<HTMLInputElement>('input[type="email"]')!, "l@example.invalid");
      setValue(el.querySelector<HTMLInputElement>('input[type="password"]')!, fixturePassword("login-bootstrap"));
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    // Just short of the deadline the ordering still holds — the wait is real, not decorative.
    await tick(SETTLE_DEADLINE_MS - 1_000);
    expect(loginCalls, "the ceremony did not wait for the refresh at all").toBe(0);

    await tick(2_000);
    expect(loginCalls, "a hung refresh held the sign-in for ever").toBe(1);
    // The refresh is STILL running. Nothing cancelled it on this caller's behalf.
    expect(wire, "the shared refresh was aborted to get past the wait").not.toContain("refresh:end");
    expect(wire, "the shared refresh was aborted to get past the wait")
      .not.toContain("refresh:aborted");
    void el;
  });
});
