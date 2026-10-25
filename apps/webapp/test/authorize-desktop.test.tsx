/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * `/authorize-desktop` — the confirmation in front of the native sign-in, asserted for the things
 * it can get wrong that nothing else would notice.
 *
 *  1. **Loading the page authorizes nothing.** The whole reason this page exists is that the
 *     address it replaced acted on being opened. A confirm on mount would put the defect back on
 *     the other side of the redirect, so the absence of that call is the assertion that matters
 *     most here — a prefetch, a restored tab or an accidental navigation must sign nothing in.
 *  2. **The address is the server's masked one, printed as given.** The page must never
 *     reconstruct or unmask it: this screen is shared, projected and photographed.
 *  3. **The countdown is the SERVER's number**, so a change to `oauthAuthorizeRequestTtlMs`
 *     cannot leave the page confidently stating the old one, and at zero the button GOES — a
 *     dead ceremony left pressable is one a person keeps pressing.
 *  4. **A dead handle is one sentence**, because the server deliberately answers unknown,
 *     expired, spent and another-session's identically.
 *  5. **Both catalogues render it.** A key present in `en.json` and missing from `de.json` is a
 *     raw key on the screen of whoever reads German.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const HANDLE = "a-request-handle-from-the-server";
const MASKED = "g•••@example.com";

let readCalls = 0;
let confirmCalls = 0;
let readAnswer: () => Promise<unknown>;
let confirmAnswer: () => Promise<{ redirect: string }>;
/** The read, the confirm and the session read go through the REAL client, over `fetch`. */
let realRead = false;
const ACCT = "acct-1";
const OTHER = "acct-2";
const sessionOf = (accountId: string) => ({
  user: { userId: `usr-${accountId}`, accountId, email: "g@example.test", twofaEnrolled: { webauthn: false, totp: true } },
  scope: "full",
});

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
    pendApiOwner: () => {},
    auth: {
      authorizeRequest: (...a: Parameters<typeof actual.auth.authorizeRequest>) => {
        readCalls += 1;
        return realRead ? actual.auth.authorizeRequest(...a) : readAnswer();
      },
      confirmAuthorize: (...a: Parameters<typeof actual.auth.confirmAuthorize>) => {
        confirmCalls += 1;
        return realRead ? actual.auth.confirmAuthorize(...a) : confirmAnswer();
      },
      stepUpTotp: async () => ({ ok: true }),
      session: (...a: Parameters<typeof actual.auth.session>) => (realRead
        ? actual.auth.session(...a)
        : Promise.resolve(sessionOf(ACCT))),
    },
  };
});

// `ApiError` is compared with `instanceof` inside the screen, so the mocked module's class has to
// be the one the test throws. Imported AFTER the mock so the augmented module is in play.
const { ApiError, apiOwnerBinding, bindApiOwner } = await import("../app/api-client");
const { markSessionAlive } = await import("../app/shell/session-truth");

/** What the real client sent, and what answered it. */
type Wire = { status: number; body?: unknown; cookie?: string };
let sent: string[] = [];
let fetchBefore: typeof fetch | null = null;
function wire(route: (method: string, url: string) => Wire): void {
  fetchBefore ??= globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push(`${method} ${url}`);
    const w = route(method, url);
    if (w.cookie) document.cookie = w.cookie;
    return new Response(w.body === undefined ? null : JSON.stringify(w.body), {
      status: w.status, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
const UNAUTHORIZED: Wire = { status: 401, body: { error: { code: "unauthorized", message: "authentication required" } } };
const REFRESH_MISSING: Wire = { status: 401, body: { error: { code: "refresh_missing", message: "missing refresh token" } } };
const reads = (): string[] => sent.filter((s) => s.includes("/oauth/authorize"));
const LOST = /lost the name of the account|lost track of which account/;
function clearClientState(): void {
  for (const name of ["tf_owner", "tf_csrf"]) document.cookie = `${name}=; path=/; max-age=0`;
  // AFTER the jar is empty: a revival over a marker arms a renewal that fires in the next case.
  markSessionAlive();
  bindApiOwner(null);
  if (fetchBefore) { globalThis.fetch = fetchBefore; fetchBefore = null; }
}

async function waitFor(el: HTMLElement, predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  }
  throw new Error(`timed out waiting for: ${what}; saw: ${el.textContent}`);
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
}

async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); });
}

async function mount(request = HANDLE, locale: "en" | "de" = "en"): Promise<HTMLDivElement> {
  await unmount();
  const { AuthorizeDesktopScreen } = await import("../app/(product)/authorize-desktop/AuthorizeDesktopScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? de : en, children: h(AuthorizeDesktopScreen, { request }),
    }));
  });
  await settle();
  return host;
}

/** The button whose label starts with `label`. Found by TEXT, the way a person finds it. */
function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").trim().startsWith(label));
  if (!found) {
    throw new Error(
      `no button labelled "${label}"; saw: ${[...el.querySelectorAll("button")]
        .map((b) => `"${(b.textContent ?? "").trim()}"`).join(", ") || "none"}`,
    );
  }
  return found as HTMLButtonElement;
}

const press = async (b: HTMLButtonElement): Promise<void> => {
  await act(async () => { b.click(); });
  await settle();
};

beforeEach(() => {
  clearClientState();
  sent = [];
  realRead = false;
  readCalls = 0;
  confirmCalls = 0;
  readAnswer = () => Promise.resolve({
    clientId: "tf-macos", redirectUri: "trafficflow://auth", scope: "full",
    address: MASKED, expiresIn: 300,
  });
  confirmAnswer = () => Promise.resolve({ redirect: "trafficflow://auth?code=xyz&state=s" });
  vi.useRealTimers();
});

afterEach(async () => {
  await unmount();
  vi.useRealTimers();
  clearClientState();
});

describe("/authorize-desktop — the confirmation", () => {
  it("LOADING IT AUTHORIZES NOTHING — the read happens, the confirm does not", async () => {
    const el = await mount();
    expect(readCalls).toBe(1);
    // The assertion this page exists for.
    expect(confirmCalls).toBe(0);
    // …and the press is there to be pressed.
    expect(button(el, "Yes, sign it in")).toBeTruthy();
  });

  it("shows the app, the account masked as the server masked it, and what it grants", async () => {
    const el = await mount();
    const text = el.textContent ?? "";
    expect(text).toContain("ohmail for Mac");
    // Printed as given — the page neither reconstructs nor unmasks it.
    expect(text).toContain(MASKED);
    expect(text).toContain("read and send your mail");
    expect(text).toContain("Settings");
  });

  it("the countdown is the SERVER's number, and at zero the press is gone", async () => {
    readAnswer = () => Promise.resolve({
      clientId: "tf-macos", redirectUri: "trafficflow://auth", scope: "full",
      address: MASKED, expiresIn: 7,
    });
    vi.useFakeTimers();
    const el = await mount();
    expect(el.textContent ?? "").toContain("7 seconds");

    // Past the server's window. `advanceTimersByTimeAsync`, so the interval's own work settles —
    // the synchronous form would leave the state it sets unpainted and this would pass for nothing.
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    await settle();
    expect(() => button(el, "Yes, sign it in")).toThrow();
    expect(el.textContent ?? "").toContain("no longer open");
  });

  it("the press confirms exactly once and follows the server's redirect", async () => {
    const el = await mount();
    await press(button(el, "Yes, sign it in"));
    expect(confirmCalls).toBe(1);
    expect(el.textContent ?? "").toContain("Done");
  });

  it("a closed step-up window asks for the factor in place and confirms once more", async () => {
    let refusals = 1;
    confirmAnswer = () => (refusals-- > 0
      ? Promise.reject(new ApiError(403, "step_up_required", "recent two-factor authentication required"))
      : Promise.resolve({ redirect: "trafficflow://auth?code=xyz&state=s" }));
    const el = await mount();
    await press(button(el, "Yes, sign it in"));
    await waitFor(el, () => el.querySelector("#stepup-code") != null, "the step-up prompt");
    expect(el.textContent ?? "", "the ask left the screen").toContain(MASKED);

    const code = el.querySelector<HTMLInputElement>("#stepup-code")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(code, "123456");
      code.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { code.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await waitFor(el, () => (el.textContent ?? "").includes("Done"), "the retried confirm");
    expect(confirmCalls).toBe(2);
  });

  it("a dead handle is ONE sentence, whatever killed it", async () => {
    readAnswer = () => Promise.reject(new ApiError(400, "invalid_grant", "that authorization request is no longer open"));
    const el = await mount();
    expect(el.textContent ?? "").toContain("no longer open");
    expect(confirmCalls).toBe(0);
  });

  it("a handle the page never received asks the server nothing", async () => {
    const el = await mount("");
    expect(readCalls).toBe(0);
    expect(confirmCalls).toBe(0);
    expect(el.textContent ?? "").toContain("no longer open");
  });

  it("a browser with no marker and no session is shown the sign-in door, and the request is not read", async () => {
    realRead = true;
    wire((_m, url) => (url === "/auth/refresh" ? REFRESH_MISSING : UNAUTHORIZED));
    const el = await mount();
    await waitFor(el, () => el.querySelector('a[href="/login"]') !== null, "the sign-in door");
    expect(el.textContent).toContain(en.linkDesktop.signInFirst);
    expect(el.textContent).not.toMatch(LOST);
    expect(sent).toContain("GET /api/auth/session");
    expect(reads()).toEqual([]);
    expect(() => button(el, "Yes, sign it in")).toThrow();
  });

  it("control: a signed-in browser reads the request through the real client", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    wire((_m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: sessionOf(ACCT) };
      if (url === `/api/oauth/authorize/request?request=${HANDLE}`) {
        return { status: 200, body: { clientId: "tf-macos", redirectUri: "trafficflow://auth", scope: "full", address: MASKED, expiresIn: 300 } };
      }
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(el, () => (el.textContent ?? "").includes(MASKED), "the request");
    expect(button(el, "Yes, sign it in")).toBeTruthy();
    expect(confirmCalls).toBe(0);
  });

  it("a browser whose marker names ANOTHER account says so, binds nothing and reads nothing", async () => {
    realRead = true;
    document.cookie = `tf_owner=${OTHER}; path=/`;
    wire((_m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: sessionOf(ACCT) };
      if (url.startsWith("/api/oauth/authorize/request")) {
        return { status: 200, body: { clientId: "tf-macos", redirectUri: "trafficflow://auth", scope: "full", address: MASKED, expiresIn: 300 } };
      }
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(el, () => (el.textContent ?? "").includes(en.session.refusedOwnerMismatch), "the mismatch sentence");
    expect(reads()).toEqual([]);
    expect(apiOwnerBinding().kind).not.toBe("bound");
    expect(() => button(el, "Yes, sign it in")).toThrow();
  });

  it("renders in German from the German catalogue — no raw keys on either screen", async () => {
    const el = await mount(HANDLE, "de");
    const text = el.textContent ?? "";
    expect(text).toContain("Die App anmelden?");
    expect(text).toContain("Ja, anmelden");
    expect(text).toContain(MASKED);
    // A missing key renders as `authorizeDesktop.<key>`; nothing on the screen may look like one.
    expect(text).not.toMatch(/authorizeDesktop\./);
  });
});
