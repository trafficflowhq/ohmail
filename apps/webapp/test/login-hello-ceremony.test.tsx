/** @vitest-environment jsdom */
/**
 * ═══ `/login`'s SECOND REQUEST BELONGS TO THE CEREMONY TOO ═════════════════════════════════
 *
 * The sign-in page makes two independent asks on mount. The already-signed-in ladder is one and
 * is covered by `login-bootstrap.test.tsx`. The other is the self-host first-run check: when
 * `/hello` reports `needsSetup: true` there are no accounts yet and the honest screen is the
 * setup ceremony rather than a form that would refuse every credential.
 *
 * The ladder knew nothing about that second request, and it cost two things:
 *
 *  · A REFRESH NOBODY ORDERED. `api()` refreshes and retries on a 401, and a refresh rewrites
 *    every session cookie whenever its response lands. A delayed 401 on `/hello` — an edge gate,
 *    a proxy, a server mid-deploy — therefore sent the OLD account's refresh cookie down a path
 *    the sign-in had carefully ordered itself behind, and its reply could restore the previous
 *    account or clear the session just created. Fixed where it belongs rather than here:
 *    `/hello` is in `NEVER_REFRESH`, so no caller of it can start one. A refresh cannot be the
 *    remedy for a 401 on a route that carries no credential meaning.
 *
 *  · A NAVIGATION FROM BEHIND A PASSWORD. `router.replace("/setup")` arriving mid-ceremony takes
 *    somebody off a form they have already submitted.
 *
 * The flavor is compile-time (`app/hello.ts`), so this is a file of its own: the env var is set
 * before any module under test loads, which is the test-side twin of the build inlining it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
// THE FLAVOR, before any module under test loads — the test-side twin of the build inlining it.
process.env.NEXT_PUBLIC_OHMAIL_FLAVOR = "selfhost";

const h = React.createElement;
const act = (React as unknown as {
  act: (cb: () => Promise<void> | void) => Promise<void>;
}).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ISO = "2026-09-05T12:00:00.000Z";

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every request, in order — the evidence both claims rest on. */
let wire: string[] = [];
let replaced: string[] = [];
let roots: Root[] = [];
let originalFetch: typeof globalThis.fetch;
/** `null` HOLDS `/hello` open, so it is genuinely on the wire when the password is submitted. */
let helloAnswer: () => Response | null = () => json(
  { product: "ohmail", flavor: "selfhost", needsSetup: true, features: { staging: false, ai: false, pairing: false } },
  200,
);
let releaseHello: (r: Response) => void = () => {};

// One STABLE router — a per-render object refires every [router]-dep effect.
const router = {
  replace: (to: string) => { replaced.push(to); },
  push: (to: string) => { replaced.push(to); },
};
vi.mock("next/navigation", () => ({ useRouter: () => router }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(ISO));
  wire = [];
  replaced = [];
  window.location.hash = "";
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const signal = init?.signal;
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
    if (url.includes("/hello")) {
      wire.push("hello");
      const answer = helloAnswer();
      return abortable(
        answer === null ? new Promise<Response>((resolve) => { releaseHello = resolve; }) : Promise.resolve(answer),
        "hello",
      );
    }
    if (url.includes("/auth/session")) {
      wire.push("session");
      /* An ANSWERED refusal, and it has to be this shape rather than a 401: a 401 sends `api()`
         through the refresh on its own, which would put `refresh` in the wire for a reason that
         has nothing to do with `/hello` and make the assertion below vacuous. `scope:
         "enrollment"` is the server saying there is nothing to forward to — the ladder stops at
         once and starts nothing. This file is about the OTHER request. */
      return json({
        user: {
          userId: "usr_h", accountId: "acct_h", email: "l@example.invalid", displayName: "L",
          emailVerified: false, twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
        },
        scope: "enrollment",
      }, 200);
    }
    if (url.includes("/auth/refresh")) {
      wire.push("refresh");
      return new Response(null, { status: 204 });
    }
    if (url.includes("/auth/login")) {
      wire.push("login");
      return json({ status: "twofa_required", loginToken: "tok", methods: ["totp"] }, 200);
    }
    return json({}, 200);
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  for (const root of roots) await act(() => root.unmount());
  roots = [];
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

async function tick(ms: number): Promise<void> {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  };
  await act(flush);
  for (let left = ms; left > 0; left -= 250) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(Math.min(250, left));
      await flush();
    });
  }
}

function submit(el: HTMLElement): Promise<void> {
  const setValue = (input: HTMLInputElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  setValue(el.querySelector<HTMLInputElement>('input[type="email"]')!, "l@example.invalid");
  setValue(el.querySelector<HTMLInputElement>('input[type="password"]')!, fixturePassword("login-hello-ceremony"));
  return act(async () => {
    el.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("the self-host first-run check", () => {
  it("forwards to setup on a fresh server — otherwise nothing below proves anything", async () => {
    await mountLogin();
    await tick(1_000);
    expect(wire, "the page never asked what the server is").toContain("hello");
    expect(replaced, "a server with no accounts left somebody at a form that refuses everything")
      .toEqual(["/setup"]);
  });

  it("a 401 on /hello starts no refresh", async () => {
    helloAnswer = () => json({ error: { code: "unauthorized", message: "no" } }, 401);
    await mountLogin();
    await tick(2_000);
    expect(wire, "the check never ran").toContain("hello");
    expect(wire, "a capability handshake rewrote the whole cookie jar").not.toContain("refresh");
    expect(replaced, "a refused handshake navigated somewhere").toEqual([]);
    helloAnswer = () => json(
      { product: "ohmail", flavor: "selfhost", needsSetup: true, features: { staging: false, ai: false, pairing: false } },
      200,
    );
  });

  it("an answer that lands after a password is submitted navigates nothing", async () => {
    helloAnswer = () => null;                     // held open — see the fetch mock
    const el = await mountLogin();
    await tick(500);
    expect(wire, "the check never left").toContain("hello");
    expect(replaced, "it forwarded before the server had answered").toEqual([]);

    await submit(el);
    await tick(500);
    expect(wire, "the in-flight handshake was left running behind the ceremony")
      .toContain("hello:aborted");

    // …and even if the answer arrives anyway, it may not take the person off their own ceremony.
    await act(async () => {
      releaseHello(json(
        { product: "ohmail", flavor: "selfhost", needsSetup: true, features: { staging: false, ai: false, pairing: false } },
        200,
      ));
    });
    await tick(1_000);
    expect(replaced, "a late first-run answer navigated out of a submitted sign-in").toEqual([]);
    expect(wire, "the ceremony never ran").toContain("login");
    helloAnswer = () => json(
      { product: "ohmail", flavor: "selfhost", needsSetup: true, features: { staging: false, ai: false, pairing: false } },
      200,
    );
  });
});

describe("the route itself can never start a refresh", () => {
  /**
   * The behavioural case above drives one caller. This is the RULE, at the one place that
   * decides it: `/hello` is asked by the setup page, the invites pane, the devices pane and the
   * first-run hook as well, and none of them wants a 401 there answered by rewriting the jar.
   */
  it("/hello is in NEVER_REFRESH", async () => {
    const { mayRefreshFor } = await import("../app/session-refresh.js");
    expect(mayRefreshFor("/hello"), "a 401 on the capability handshake starts a refresh")
      .toBe(false);
    // The control: an ordinary read still recovers, or the entry above would be a blunt
    // instrument that had switched the recovery path off for everything.
    expect(mayRefreshFor("/mailboxes"), "the refresh-and-retry path is off for ordinary reads")
      .toBe(true);
  });
});
