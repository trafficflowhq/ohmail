/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";

/**
 * `/approve` — the browser's one confirm for a desktop's sign-in, asserted on RENDERED output: the
 * computer named in its own words with a network class, never an address; one Confirm; a stale
 * factor answered INLINE (a code or a passkey) and the confirm retried the moment it verifies — no
 * password, no `/login`, nothing to copy; a signed-out browser sent through the ordinary sign-in
 * with the request id kept in the tab, never the URL; a busy server a wait with Confirm live; each
 * of the request's endings its own sentence. The page settles whose browser this is BEFORE it asks
 * for the request: the real-client cases drive that through the storage-owner gate, with no mock in front.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const ID = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";
const ACCT = "acct-1";
const OTHER = "acct-2";
const replaced: string[] = [];
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: (to: string) => replaced.push(to), replace: (to: string) => replaced.push(to) }),
}));

type Answer<T> = () => Promise<T>;
let readAnswers: Answer<unknown>[] = [];
let confirmAnswers: Answer<unknown>[] = [];
let confirmCalls = 0;
let denyCalls = 0;
let stepUpTotpCalls = 0;
let stepUpPasskeyCalls = 0;
let enrolled = { webauthn: false, totp: true };
let passkeyBrowser = false;
/** The read goes through the REAL client, over `fetch`, instead of `readAnswers`. */
let realRead = false;
const next = <T,>(list: Answer<T>[]): Promise<T> => (list.length > 1 ? list.shift()! : list[0]!)();

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
    webauthnAvailable: () => passkeyBrowser,
    assertPasskey: () => Promise.resolve({ id: "cred" }),
    auth: {
      desktopApproval: (...a: Parameters<typeof actual.auth.desktopApproval>) =>
        (realRead ? actual.auth.desktopApproval(...a) : next(readAnswers)),
      confirmDesktopApproval: (...a: Parameters<typeof actual.auth.confirmDesktopApproval>) => {
        confirmCalls += 1;
        return realRead ? actual.auth.confirmDesktopApproval(...a) : next(confirmAnswers);
      },
      denyDesktopApproval: (...a: Parameters<typeof actual.auth.denyDesktopApproval>) => {
        denyCalls += 1;
        return realRead ? actual.auth.denyDesktopApproval(...a) : Promise.resolve({ denied: true });
      },
      session: (...a: Parameters<typeof actual.auth.session>) => (realRead
        ? actual.auth.session(...a)
        : Promise.resolve({ user: { accountId: ACCT, email: "m@example.test", twofaEnrolled: enrolled }, scope: "full" })),
      stepUpTotp: (...a: Parameters<typeof actual.auth.stepUpTotp>) => {
        stepUpTotpCalls += 1;
        return realRead ? actual.auth.stepUpTotp(...a) : Promise.resolve({ ok: true as const });
      },
      stepUpWebauthnOptions: () => Promise.resolve({ options: {} }),
      stepUpWebauthnVerify: () => { stepUpPasskeyCalls += 1; return Promise.resolve({ ok: true }); },
    },
  };
});

const { ApiError, apiOwnerBinding, bindApiOwner, blockApiOwner } = await import("../app/api-client");
const { markSessionAlive } = await import("../app/shell/session-truth");
const { takeApprovalReturn } = await import("../app/(product)/approve/approval-return");
const refusal = (status: number, code: string): Error => new ApiError(status, code, `server words for ${code}`);
const busy = (): Error =>
  new ApiError(503, "db_busy", "busy", undefined, { coded: true, retryable: true, retryAfterMs: 20 });
const facts = (over: Record<string, unknown> = {}) => ({
  label: "studio-mac", platform: "Linux", ipClass: "203.0.x.x",
  requestedAt: new Date().toISOString(), expiresIn: 300, approved: false, ...over,
});

/** What the real client sent, and what answered it; `cookie` stands in for the answer's `Set-Cookie`. */
type Wire = { status: number; body?: unknown; cookie?: string; account?: string };
let sent: string[] = [];
let fetchBefore: typeof fetch | null = null;
function wire(route: (method: string, url: string) => Wire | Promise<Wire>): void {
  fetchBefore ??= globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    sent.push(`${method} ${url}`);
    const w = await route(method, url);
    if (w.cookie) document.cookie = w.cookie;
    return new Response(w.body === undefined ? null : JSON.stringify(w.body), {
      status: w.status,
      headers: { "content-type": "application/json", ...(w.account ? { "x-ohmail-account": w.account } : {}) },
    });
  }) as typeof fetch;
}
const READ = `/api/auth/desktop-approval/${ID}`;
const UNAUTHORIZED: Wire = { status: 401, body: { error: { code: "unauthorized", message: "authentication required" } } };
const REFRESH_MISSING: Wire = { status: 401, body: { error: { code: "refresh_missing", message: "missing refresh token" } } };
const session = (accountId: string, scope = "full") => ({
  user: { userId: `usr-${accountId}`, accountId, email: "m@example.test", displayName: "M", emailVerified: true,
    twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true } },
  scope,
});
const reads = (): string[] => sent.filter((s) => s.includes("/auth/desktop-approval/"));
const sessionAs = (accountId: string, email: string) => ({
  user: { ...session(accountId).user, email },
  scope: "full",
});
const accountLine = (el: HTMLElement): string => el.querySelector('[data-testid="approve-account"]')?.textContent ?? "";
/** An answer the case releases when it chooses: the settle is caught while it is in flight. */
function held<T>(): { promise: Promise<T>; release: (v: T) => void } {
  let release!: (v: T) => void;
  const promise = new Promise<T>((r) => { release = r; });
  return { promise, release };
}
/** Both spellings of the dead end: the client's literal and the catalogue's. */
const LOST = /lost the name of the account|lost track of which account/;
/** Module state the real client keeps between cases: the binding, the jar, the death latch. */
function clearClientState(): void {
  for (const name of ["tf_owner", "tf_csrf"]) document.cookie = `${name}=; path=/; max-age=0`;
  localStorage.removeItem("ohmail.session.mintedAt");
  // AFTER the jar is empty: a revival over a marker arms a renewal that fires in the next case.
  markSessionAlive();
  bindApiOwner(null);
  if (fetchBefore) { globalThis.fetch = fetchBefore; fetchBefore = null; }
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
beforeEach(() => {
  clearClientState();
  sent = [];
  replaced.length = 0;
  readAnswers = [() => Promise.resolve(facts())];
  confirmAnswers = [() => Promise.resolve({ approved: true })];
  confirmCalls = 0; denyCalls = 0; stepUpTotpCalls = 0; stepUpPasskeyCalls = 0;
  enrolled = { webauthn: false, totp: true };
  passkeyBrowser = false;
  realRead = false;
  sessionStorage.clear();
});
afterEach(async () => {
  if (root) { const r = root; await act(async () => { r.unmount(); }); root = null; }
  host?.remove();
  host = null;
  clearClientState();
});

async function waitFor(predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  }
  throw new Error(`timed out waiting for: ${what}; saw: ${host?.textContent}`);
}

async function mount(request = ID, locale: "en" | "de" = "en"): Promise<HTMLDivElement> {
  const { ApproveScreen } = await import("../app/(product)/approve/ApproveScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: locale === "de" ? de : messages, timeZone: "UTC", children: h(ApproveScreen, { request }),
    }));
  });
  return host;
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim().startsWith(label));
  if (found.length !== 1) throw new Error(`expected one "${label}" button, found ${found.length}`);
  return found[0]!;
}
const press = async (b: HTMLButtonElement): Promise<void> => { await act(async () => { b.click(); }); };

describe("the page names the account the confirm signs in to", () => {
  it("shows this browser's own signed-in address beside the computer, as Settings does", async () => {
    const el = await mount();
    await waitFor(() => el.querySelector('[data-testid="approve-account"]') !== null, "the account line");
    expect(el.querySelector('[data-testid="approve-account"]')!.textContent).toBe("Confirm signs it in to m@example.test.");
  });
});

describe("the page names the computer and asks once", () => {
  it("shows the label, the platform and the network class — no address — and one press confirms", async () => {
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    expect(el.textContent).toContain("Sign in ohmail on this computer?");
    expect(el.textContent).toContain("Linux");
    expect(el.textContent).toContain("Requested just now from 203.0.x.x.");
    await press(button(el, "Confirm"));
    await waitFor(() => el.textContent!.includes("Done — look at your computer."), "done");
    expect(confirmCalls).toBe(1);
    expect(replaced).toEqual([]);
  });

  it("Not me ends the request", async () => {
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    await press(button(el, "Not me"));
    await waitFor(() => el.textContent!.includes("Not signed in"), "denied");
    expect(denyCalls).toBe(1);
    expect(confirmCalls).toBe(0);
  });
});

describe("the page says when the computer asked from another network", () => {
  const networkLine = (el: HTMLElement): Element | null => el.querySelector('[data-testid="approve-network"]');

  it("a request from another network shows the line between the facts and the account line", async () => {
    readAnswers = [() => Promise.resolve(facts({ network: "different" }))];
    const el = await mount();
    await waitFor(() => el.querySelector('[data-testid="approve-account"]') !== null, "the account line");
    const line = networkLine(el);
    expect(line, "no line for a request from another network").not.toBeNull();
    expect(line!.textContent).toBe(messages.approve.otherNetwork);
    expect(line!.getAttribute("role")).toBe("note");
    expect(line!.previousElementSibling?.tagName).toBe("UL");
    expect(line!.nextElementSibling?.getAttribute("data-testid")).toBe("approve-account");
  });

  it("says it in German on a German page", async () => {
    readAnswers = [() => Promise.resolve(facts({ network: "different" }))];
    const el = await mount(ID, "de");
    await waitFor(() => networkLine(el) !== null, "the line");
    expect(networkLine(el)!.textContent).toBe(de.approve.otherNetwork);
  });

  it("the line stays on screen while the factor is asked for inline", async () => {
    readAnswers = [() => Promise.resolve(facts({ network: "different" }))];
    confirmAnswers = [() => Promise.reject(refusal(403, "step_up_required")), () => Promise.resolve({ approved: true })];
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    await press(button(el, "Confirm"));
    await waitFor(() => el.querySelector('[data-testid="step-up-prompt"]') !== null, "the inline prompt");
    expect(networkLine(el)?.textContent).toBe(messages.approve.otherNetwork);
  });

  it.each([
    ["the same network", { network: "same" }],
    ["an unknown network", { network: "unknown" }],
    ["an answer without the word", {}],
  ])("%s shows no line", async (_what, over) => {
    readAnswers = [() => Promise.resolve(facts(over))];
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    expect(networkLine(el)).toBeNull();
  });

  it("the line adds no press: one Confirm still confirms", async () => {
    readAnswers = [() => Promise.resolve(facts({ network: "different" }))];
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    await press(button(el, "Confirm"));
    await waitFor(() => el.textContent!.includes("Done — look at your computer."), "done");
    expect(confirmCalls).toBe(1);
  });
});

describe("the hosted build's page", () => {
  it("is the confirm page for a request id (the self-hosted build's refusal is approve-self-host.test.tsx)", async () => {
    const { default: ApprovePage } = await import("../app/(product)/approve/page.js");
    const page = await ApprovePage({ searchParams: Promise.resolve({ request: ID }) });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: page }));
    });
    await waitFor(() => host!.textContent!.includes("studio-mac"), "the request");
    expect(host!.textContent).toContain(messages.approve.title);
    expect(host!.textContent).not.toContain(messages.approve.notOffered);
    expect(button(host!, "Confirm")).toBeTruthy();
  });
});

describe("a stale factor is asked for inline and the confirm retried", () => {
  it("the six-digit arm: one code, then the confirm runs again by itself", async () => {
    confirmAnswers = [() => Promise.reject(refusal(403, "step_up_required")), () => Promise.resolve({ approved: true })];
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    await press(button(el, "Confirm"));
    await waitFor(() => el.querySelector('[data-testid="step-up-prompt"]') !== null, "the inline prompt");
    expect(el.querySelector('input[type="password"]'), "a password was asked for").toBeNull();
    const input = el.querySelector<HTMLInputElement>("#stepup-code")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "123456"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await waitFor(() => el.textContent!.includes("Done — look at your computer."), "done after the factor");
    expect(stepUpTotpCalls).toBe(1);
    expect(confirmCalls).toBe(2);
    expect(replaced).toEqual([]);
  });

  it("the passkey arm: one touch, then the confirm runs again by itself", async () => {
    enrolled = { webauthn: true, totp: true };
    passkeyBrowser = true;
    confirmAnswers = [() => Promise.reject(refusal(403, "step_up_required")), () => Promise.resolve({ approved: true })];
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    await press(button(el, "Confirm"));
    await waitFor(() => el.querySelector('[data-testid="step-up-prompt"]') !== null, "the inline prompt");
    const passkey = [...el.querySelectorAll("button")].find((b) => /passkey/i.test(b.textContent ?? ""))!;
    await press(passkey);
    await waitFor(() => el.textContent!.includes("Done — look at your computer."), "done after the passkey");
    expect(stepUpPasskeyCalls).toBe(1);
    expect(confirmCalls).toBe(2);
  });
});

describe("the ways a request ends, and the ways the server says wait", () => {
  it("a signed-out browser goes to the ordinary sign-in with the request kept in this tab", async () => {
    // Signed out = the refresh door's coded refusal, which the real client writes before the 401
    // reaches the page (`resumeSession` → `markSessionDead`).
    const truth = await import("../app/shell/session-truth.js");
    readAnswers = [() => { truth.markSessionDead(); return Promise.reject(refusal(401, "unauthorized")); }];
    await mount();
    await waitFor(() => replaced.length > 0, "the sign-in");
    expect(replaced).toEqual(["/login"]);
    const { takeApprovalReturn } = await import("../app/(product)/approve/approval-return.js");
    expect(takeApprovalReturn()).toBe(`/approve?request=${ID}`);
    expect(takeApprovalReturn(), "the return is one-shot").toBeNull();
  });

  /* THE REAL CLIENT over a lapsed access and a renewal that meets a fault (a high review
     finding): the double this replaced answered a 401 the client no longer produces for a fault.
     Mutation watched red: `session_unchecked` not mapped to the reload sentence. */
  it("a renewal that met a fault keeps the browser here, and says to reload", async () => {
    realRead = true;
    const original = globalThis.fetch;
    const sent: string[] = [];
    document.cookie = "tf_csrf=stale; path=/";
    document.cookie = "tf_owner=acct-1; path=/";
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      sent.push(`${init?.method ?? "GET"} ${url}`);
      const body = url === "/auth/refresh"
        ? { status: 503, error: { code: "db_busy", message: "busy" } }
        : { status: 401, error: { code: "unauthorized", message: "authentication required" } };
      return new Response(JSON.stringify({ error: body.error }), { status: body.status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const el = await mount();
      await waitFor(() => el.textContent!.includes("Reload this page to try again."), "the reload sentence", 8000);
      expect(sent, "the renewal was never asked").toContain("POST /auth/refresh");
      expect(el.textContent).not.toMatch(/sent again/);
      expect(replaced).toEqual([]);
    } finally {
      globalThis.fetch = original;
      document.cookie = "tf_owner=; max-age=0; path=/";
    }
    // The client's own renewal retries before the sentence (3.7 s on the CI VMs), under the 8 s waitFor.
  }, 15_000);

  it("a busy read is retried and the page renders; a busy confirm keeps Confirm live", async () => {
    readAnswers = [() => Promise.reject(busy()), () => Promise.resolve(facts())];
    confirmAnswers = [() => Promise.reject(busy()), () => Promise.resolve({ approved: true })];
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request after a busy read");
    await press(button(el, "Confirm"));
    await waitFor(() => el.textContent!.includes("Done — look at your computer."), "done after a busy confirm");
    expect(confirmCalls).toBe(2);
  });

  it("a server busy past the ladder names the server and leaves Confirm on screen", async () => {
    confirmAnswers = [() => Promise.reject(busy())];
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    await press(button(el, "Confirm"));
    await waitFor(() => el.textContent!.includes("The server is still busy. Press Confirm to try again."), "the gave-up line", 6000);
    expect(button(el, "Confirm").disabled).toBe(false);
  });

  it.each([
    ["approval_expired", 410, "This request has expired. Start again from your computer."],
    ["approval_used", 410, "This request was already used."],
    ["approval_denied", 410, "This request was declined in the browser."],
    ["not_found", 404, "There is no sign-in request here for this account."],
  ] as const)("a %s refusal at the read renders its sentence", async (code, status, sentence) => {
    readAnswers = [() => Promise.reject(refusal(status, code))];
    const el = await mount();
    await waitFor(() => el.textContent!.includes(sentence), sentence);
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("an already-confirmed request reads as done", async () => {
    readAnswers = [() => Promise.resolve(facts({ approved: true }))];
    const el = await mount();
    await waitFor(() => el.textContent!.includes("Done — look at your computer."), "done");
  });

  it("no request in the URL says where the page opens from", async () => {
    const el = await mount("");
    await waitFor(() => el.textContent!.includes("This page opens from the ohmail app on your computer."), "missing");
  });
});

/*
 * THE REAL CLIENT, NO MOCK IN FRONT OF THE OWNER GATE. A browser that never signed in holds no
 * `tf_owner`, and the gate refused the page's first read before anything was sent, so the signed-out
 * branch was unreachable and the page said "Reload the page and it comes back", which was false.
 */
describe("the page settles whose browser this is before it asks for the request", () => {
  it("a browser with no marker and no session goes to /login and comes back to this request", async () => {
    realRead = true;
    wire((_m, url) => (url === "/auth/refresh" ? REFRESH_MISSING : UNAUTHORIZED));
    const el = await mount();
    await waitFor(() => replaced.length > 0, "the sign-in");
    expect(replaced).toEqual(["/login"]);
    expect(takeApprovalReturn()).toBe(`/approve?request=${ID}`);
    expect(el.textContent).not.toMatch(LOST);
    expect(sent).toContain("GET /api/auth/session");
    expect(reads(), "the request was asked for before the page knew whose browser this is").toEqual([]);
  });

  it("an enrollment-only session is no sign-in: /login runs the second factor and comes back", async () => {
    realRead = true;
    wire((_m, url) => (url === "/api/auth/session" ? { status: 200, body: session(ACCT, "enrollment") } : UNAUTHORIZED));
    await mount();
    await waitFor(() => replaced.length > 0, "the sign-in");
    expect(replaced).toEqual(["/login"]);
    expect(takeApprovalReturn()).toBe(`/approve?request=${ID}`);
    expect(reads()).toEqual([]);
  });

  it("a live session whose marker went missing gets it back from the session read, and the page renders", async () => {
    realRead = true;
    wire((_m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: session(ACCT), cookie: `tf_owner=${ACCT}; path=/` };
      if (url === READ) return { status: 200, body: facts() };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac")
      && el.querySelector('[data-testid="approve-account"]') !== null, "the request and the account line");
    expect(el.textContent).not.toMatch(LOST);
    expect(replaced).toEqual([]);
  });

  it("control: a signed-in browser reads the request and one press confirms it", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    document.cookie = "tf_csrf=c1; path=/";
    wire((m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: session(ACCT) };
      if (url === READ) return { status: 200, body: facts() };
      if (m === "POST" && url === `${READ}/confirm`) return { status: 200, body: { approved: true } };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    await press(button(el, "Confirm"));
    await waitFor(() => el.textContent!.includes("Done — look at your computer."), "done");
    expect(sent).toContain(`POST ${READ}/confirm`);
    expect(replaced).toEqual([]);
  });

  it("a browser whose marker names ANOTHER account says so, binds nothing and asks for no request", async () => {
    realRead = true;
    document.cookie = `tf_owner=${OTHER}; path=/`;
    wire((_m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: session(ACCT) };
      if (url === READ) return { status: 200, body: facts() };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes(messages.session.refusedOwnerMismatch), "the mismatch sentence");
    expect(reads()).toEqual([]);
    expect(sent.filter((s) => s === "GET /api/auth/session"), "only the classifier asked who this is").toHaveLength(1);
    expect(apiOwnerBinding().kind).not.toBe("bound");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("a sign-out this browser asked for and the server never confirmed is said, and nothing is bound", async () => {
    realRead = true;
    document.cookie = "tf_owner=signed_out_pending; path=/";
    wire((_m, url) => (url === "/api/auth/session" ? { status: 200, body: session(ACCT) } : UNAUTHORIZED));
    const el = await mount();
    await waitFor(() => el.textContent!.includes(messages.session.refusedOwnerSignedOut), "the sign-in-again sentence");
    expect(reads()).toEqual([]);
    expect(apiOwnerBinding().kind).not.toBe("bound");
  });

  it("control: a signed-in browser's expired request reads its own sentence", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    wire((_m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: session(ACCT) };
      if (url === READ) return { status: 410, body: { error: { code: "approval_expired", message: "server words" } } };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("This request has expired. Start again from your computer."), "expired");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("control: a read that meets a renewal fault says to reload, after the session read named the account", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    wire((_m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: session(ACCT) };
      if (url === "/auth/refresh") return { status: 503, body: { error: { code: "db_busy", message: "busy" } } };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("Reload this page to try again."), "the reload sentence");
    expect(reads(), "one read, no busy retry: a renewal fault is not a busy server").toEqual([`GET ${READ}`]);
    expect(replaced).toEqual([]);
  });

  it("a marker that goes before the press sends the page back through the settle step, not to a dead end", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    let signedIn = true;
    wire((_m, url) => {
      if (url === "/auth/refresh") return REFRESH_MISSING;
      if (url === "/api/auth/session") return signedIn ? { status: 200, body: session(ACCT) } : UNAUTHORIZED;
      if (url === READ) return { status: 200, body: facts() };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac")
      && el.querySelector('[data-testid="approve-account"]') !== null, "the request and the account line");
    // Another tab signed out: the server ended the session and cleared the jar, marker included.
    signedIn = false;
    document.cookie = "tf_owner=; path=/; max-age=0";
    await press(button(el, "Confirm"));
    await waitFor(() => replaced.length > 0, "the sign-in");
    expect(replaced).toEqual(["/login"]);
    expect(takeApprovalReturn()).toBe(`/approve?request=${ID}`);
    expect(el.textContent).not.toMatch(LOST);
    expect(sent.filter((s) => s.endsWith("/confirm")), "a confirm left with no account named").toEqual([]);
  });

  it("a tab latched dead with a live session in the jar reads the request once the settle names the account", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    // The mint is now, so the renewal the revival arms is minutes away rather than due.
    localStorage.setItem("ohmail.session.mintedAt", String(Date.now()));
    const truth = await import("../app/shell/session-truth.js");
    truth.markSessionDead();
    wire((_m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: session(ACCT) };
      if (url === READ) return { status: 200, body: facts() };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac") || replaced.length > 0, "the request");
    expect(replaced, "a live session was sent to sign in again: /login forwards it straight back").toEqual([]);
    expect(el.textContent).toContain("studio-mac");
    expect(truth.sessionIsDead()).toBe(false);
  });

  it("a tab whose own sign-out was never confirmed says sign in again, and nothing is bound", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    blockApiOwner();
    wire((_m, url) => (url === "/api/auth/session" ? { status: 200, body: session(ACCT) } : UNAUTHORIZED));
    const el = await mount();
    await waitFor(() => el.textContent!.includes(messages.session.refusedOwnerSignedOut), "the sign-in-again sentence");
    expect(reads()).toEqual([]);
    expect(apiOwnerBinding().kind).toBe("blocked");
  });

  it("after the settle, an answer naming another account is refused", async () => {
    realRead = true;
    wire((_m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: session(ACCT), cookie: `tf_owner=${ACCT}; path=/` };
      if (url === READ) return { status: 200, body: facts(), account: OTHER };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => reads().length > 0 && !el.textContent!.includes(messages.approve.working), "the read's answer");
    expect(el.textContent, "another account's request rendered").not.toContain("studio-mac");
    expect(apiOwnerBinding()).toEqual({ kind: "pending", owner: ACCT });
  });

  it("a session read that meets a busy server is asked again on the ladder, and the page renders", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    let asked = 0;
    wire((_m, url) => {
      if (url === "/api/auth/session") {
        asked += 1;
        return asked === 1
          ? { status: 503, body: { error: { code: "db_busy", message: "busy", retryable: true } } }
          : { status: 200, body: session(ACCT) };
      }
      if (url === READ) return { status: 200, body: facts() };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request after a busy session read");
    expect(el.textContent).not.toContain(messages.approve.signInUnchecked);
  });

  it("Not me with the marker gone goes back through the settle step too", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    let signedIn = true;
    wire((_m, url) => {
      if (url === "/auth/refresh") return REFRESH_MISSING;
      if (url === "/api/auth/session") return signedIn ? { status: 200, body: session(ACCT) } : UNAUTHORIZED;
      if (url === READ) return { status: 200, body: facts() };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac")
      && el.querySelector('[data-testid="approve-account"]') !== null, "the request and the account line");
    signedIn = false;
    document.cookie = "tf_owner=; path=/; max-age=0";
    await press(button(el, "Not me"));
    await waitFor(() => replaced.length > 0, "the sign-in");
    expect(replaced).toEqual(["/login"]);
    expect(el.textContent).not.toMatch(LOST);
    expect(sent.filter((s) => s.endsWith("/deny")), "a deny left with no account named").toEqual([]);
  });

  it("a jar that became another account's before the press says so in the reader's language", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    wire((_m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: session(ACCT) };
      if (url === READ) return { status: 200, body: facts() };
      return UNAUTHORIZED;
    });
    const el = await mount(ID, "de");
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    document.cookie = `tf_owner=${OTHER}; path=/`;
    // A countdown tick renders the page again: the settled binding must not follow the jar.
    await act(async () => { await new Promise((r) => setTimeout(r, 1100)); });
    expect(apiOwnerBinding(), "a render re-pended the page to the jar's new account").toEqual({ kind: "bound", owner: ACCT });
    await press(button(el, "Bestätigen"));
    await waitFor(() => el.textContent!.includes(de.session.refusedOwnerMismatch), "the German mismatch sentence");
    expect(el.textContent).not.toContain("This window is signed in to a different account");
    expect(sent.filter((s) => s.endsWith("/confirm"))).toEqual([]);
  });

  /* The reviewer's PROBE A: the jar held another account's session and no marker, the press settled
     again onto that account, and the page kept naming the first one over a Confirm bound to the second. */
  it("a settle again that lands on another account never names the first account", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    document.cookie = "tf_csrf=c1; path=/";
    let phase = 1;
    let later = 0;
    wire((_m, url) => {
      if (url === "/api/auth/session") {
        if (phase === 1) return { status: 200, body: sessionAs(ACCT, "first@example.test") };
        later += 1;
        return later === 1
          ? { status: 200, body: sessionAs(OTHER, "second@example.test"), cookie: `tf_owner=${OTHER}; path=/` }
          : { status: 500, body: { error: { code: "internal", message: "fault" } } };
      }
      if (url === READ) return { status: 200, body: facts(), account: phase === 1 ? ACCT : OTHER };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => accountLine(el).includes("first@example.test"), "the first account line");
    phase = 2;
    document.cookie = "tf_owner=; path=/; max-age=0";
    await press(button(el, "Confirm"));
    await waitFor(() => reads().length >= 2 && later >= 2
      && [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Confirm")), "the page settled again");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(apiOwnerBinding()).toEqual({ kind: "bound", owner: OTHER });
    expect(el.textContent, "the page names the account the confirm no longer binds").not.toContain("first@example.test");
    expect(sent.filter((s) => s.endsWith("/confirm"))).toEqual([]);
  });

  it("control: after that settle the line names the second account once its own read lands", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    let phase = 1;
    let later = 0;
    wire((_m, url) => {
      if (url === "/api/auth/session") {
        if (phase === 1) return { status: 200, body: sessionAs(ACCT, "first@example.test") };
        later += 1;
        return { status: 200, body: sessionAs(OTHER, "second@example.test"), ...(later === 1 ? { cookie: `tf_owner=${OTHER}; path=/` } : {}) };
      }
      if (url === READ) return { status: 200, body: facts() };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => accountLine(el).includes("first@example.test"), "the first account line");
    phase = 2;
    document.cookie = "tf_owner=; path=/; max-age=0";
    await press(button(el, "Confirm"));
    await waitFor(() => accountLine(el).includes("second@example.test"), "the second account line");
    expect(el.textContent).not.toContain("first@example.test");
  });

  it("a settle again whose request read fails leaves no earlier request and no Confirm on screen", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    let phase = 1;
    wire((_m, url) => {
      if (url === "/api/auth/session") {
        return { status: 200, body: session(ACCT), ...(phase === 2 ? { cookie: `tf_owner=${ACCT}; path=/` } : {}) };
      }
      if (url === READ) {
        return phase === 1
          ? { status: 200, body: facts() }
          : { status: 410, body: { error: { code: "approval_expired", message: "server words" } } };
      }
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    phase = 2;
    document.cookie = "tf_owner=; path=/; max-age=0";
    await press(button(el, "Confirm"));
    await waitFor(() => el.textContent!.includes("This request has expired. Start again from your computer."), "the expired sentence");
    expect(el.textContent).not.toContain("studio-mac");
    expect(el.querySelectorAll("button")).toHaveLength(0);
  });

  it("while the page settles again it says so and offers nothing to press", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    let phase = 1;
    const answer = held<Wire>();
    wire((_m, url) => {
      if (url === "/api/auth/session") return phase === 1 ? { status: 200, body: session(ACCT) } : answer.promise;
      if (url === READ) return { status: 200, body: facts() };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    phase = 2;
    document.cookie = "tf_owner=; path=/; max-age=0";
    await press(button(el, "Confirm"));
    await waitFor(() => el.textContent!.includes(messages.approve.working), "the working line");
    expect(el.querySelectorAll("button")).toHaveLength(0);
    expect(el.textContent).not.toContain(messages.approve.expired);
    answer.release({ status: 200, body: session(ACCT), cookie: `tf_owner=${ACCT}; path=/` });
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request after the settle");
  });

  it("a settle the page abandoned binds nothing when its answer lands late", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    const answer = held<Wire>();
    wire((_m, url) => (url === "/api/auth/session" ? answer.promise : UNAUTHORIZED));
    await mount();
    await waitFor(() => sent.includes("GET /api/auth/session"), "the settle's read");
    const r = root!;
    await act(async () => { r.unmount(); });
    root = null;
    answer.release({ status: 200, body: session(ACCT) });
    await act(async () => { await new Promise((res) => setTimeout(res, 60)); });
    expect(apiOwnerBinding(), "a page that is gone bound the client").toEqual({ kind: "pending", owner: ACCT });
  });

  /* STEP-UP-PROMPT-SAYS-THE-RELOAD-SENTENCE: the marker goes while the inline prompt is up. The
     prompt hands the refusal to the page's settle step; it never says either reload sentence, and
     the confirm it parked does not run by itself after the page settled again. */
  it("a marker that goes under the step-up prompt's own read settles the page again, never the reload sentence", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    document.cookie = "tf_csrf=c1; path=/";
    let stage: "page" | "prompt" | "after" = "page";
    wire((m, url) => {
      if (url === "/api/auth/session") {
        if (stage !== "prompt") return { status: 200, body: session(ACCT), cookie: `tf_owner=${ACCT}; path=/` };
        // The prompt's read: another tab's sign-out takes the marker under it, and nothing writes it back.
        stage = "after";
        document.cookie = "tf_owner=; path=/; max-age=0";
        return { status: 200, body: session(ACCT) };
      }
      if (url === READ) return { status: 200, body: facts() };
      if (m === "POST" && url === `${READ}/confirm`) {
        stage = "prompt";
        return { status: 403, body: { error: { code: "step_up_required", message: "recent 2FA re-assertion required" } } };
      }
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    await press(button(el, "Confirm"));
    await waitFor(() => stage === "after" && reads().length >= 2
      && el.querySelector('[data-testid="step-up-prompt"]') === null
      && [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Confirm")), "the page settled again");
    expect(el.textContent).not.toMatch(LOST);
    expect(sent.filter((s) => s.endsWith("/confirm")), "the parked confirm ran by itself").toHaveLength(1);
    expect(apiOwnerBinding()).toEqual({ kind: "bound", owner: ACCT });
  });

  it("a marker that goes before the factor is verified settles the page again, and the parked confirm does not run", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    document.cookie = "tf_csrf=c1; path=/";
    wire((m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: session(ACCT), cookie: `tf_owner=${ACCT}; path=/` };
      if (url === READ) return { status: 200, body: facts() };
      if (m === "POST" && url === `${READ}/confirm`) {
        return { status: 403, body: { error: { code: "step_up_required", message: "recent 2FA re-assertion required" } } };
      }
      if (m === "POST" && url === "/api/auth/step-up/totp") return { status: 200, body: { ok: true } };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
    await press(button(el, "Confirm"));
    await waitFor(() => el.querySelector("#stepup-code") !== null, "the inline prompt's code field");
    document.cookie = "tf_owner=; path=/; max-age=0";
    const input = el.querySelector<HTMLInputElement>("#stepup-code")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => { setter.call(input, "123456"); input.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => { input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await waitFor(() => el.querySelector('[data-testid="step-up-prompt"]') === null
      && [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Confirm")), "the page settled again");
    expect(el.textContent).not.toMatch(LOST);
    expect(sent, "the factor went out with no account named").not.toContain("POST /api/auth/step-up/totp");
    expect(sent.filter((s) => s.endsWith("/confirm")), "the parked confirm ran by itself").toHaveLength(1);
  });

  it("a marker that cannot be read back ends on 'could not be checked' after one more settle, never a loop", async () => {
    realRead = true;
    // Not id-shaped, so it reads as absent; the server sees a marker and writes none back.
    document.cookie = "tf_owner=acct%2F1; path=/";
    wire((_m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: session(ACCT) };
      if (url === READ) return { status: 200, body: facts() };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes(messages.approve.signInUnchecked), "the could-not-be-checked sentence");
    expect(el.textContent).not.toMatch(LOST);
    expect(sent.filter((s) => s === "GET /api/auth/session")).toHaveLength(2);
    expect(reads()).toEqual([]);
  });
});

describe("the sign-in's way back is an id, never a URL", () => {
  it("keeps only a request id, once, and not past ten minutes", async () => {
    const { rememberApprovalRequest, takeApprovalReturn } = await import("../app/(product)/approve/approval-return.js");
    rememberApprovalRequest("https://elsewhere.test/");
    expect(takeApprovalReturn()).toBeNull();
    rememberApprovalRequest(ID, 1_000);
    expect(takeApprovalReturn(1_000 + 10 * 60_000 + 1)).toBeNull();
    rememberApprovalRequest(ID, 1_000);
    expect(takeApprovalReturn(2_000)).toBe(`/approve?request=${ID}`);
    sessionStorage.setItem("ohmail.approve.request", JSON.stringify({ id: `${ID}&next=x`, at: 1 }));
    expect(takeApprovalReturn(2)).toBeNull();
  });
});

/**
 * A FACTOR ALREADY ON ITS WAY when the page settles again runs nothing parked behind the prompt.
 * The prompt's own read answers owner_absent while the code is out, the page settles and the
 * prompt goes, and only then does the factor's answer land. The confirm that opened the prompt is
 * the only one sent: none may follow without a press on the settled page, whichever account it
 * now names and whether or not the factor's answer names one.
 */
const STEP_UP = "/api/auth/step-up/totp";
const STEP_UP_REQUIRED = { error: { code: "step_up_required", message: "recent 2FA re-assertion required" } };

/** One interleaving: the prompt's own read is held, the factor goes out, the read answers after the
 *  marker went (owner_absent -> the page settles again), and ONLY THEN the factor's answer lands. */
async function inflight(opts: { resettleAs: string; factorHeader: string | null }): Promise<Record<string, unknown>> {
  realRead = true;
  document.cookie = `tf_owner=${ACCT}; path=/`;
  document.cookie = "tf_csrf=c1; path=/";
  let jar = ACCT;
  let stage: "page" | "prompt" | "after" = "page";
  const promptRead = held<void>();
  const factor = held<void>();
  let confirms = 0;
  const confirmBinding: string[] = [];
  const { apiOwnerBinding: binding } = await import("../app/api-client");
  wire(async (m, url) => {
    if (url === "/api/auth/session") {
      if (stage === "prompt") {
        stage = "after";
        await promptRead.promise;
        document.cookie = "tf_owner=; path=/; max-age=0";
        jar = opts.resettleAs;
        return { status: 200, body: session(ACCT), account: ACCT };
      }
      return { status: 200, body: sessionAs(jar, `${jar}@example.test`), cookie: `tf_owner=${jar}; path=/`, account: jar };
    }
    if (url === READ) return { status: 200, body: facts(), account: jar };
    if (m === "POST" && url === `${READ}/confirm`) {
      confirms += 1;
      confirmBinding.push(JSON.stringify(binding()));
      if (confirms === 1) { stage = "prompt"; return { status: 403, body: STEP_UP_REQUIRED, account: jar }; }
      return { status: 200, body: { approved: true }, account: jar };
    }
    if (m === "POST" && url === STEP_UP) {
      await factor.promise;
      return opts.factorHeader === null ? { status: 200, body: { ok: true } } : { status: 200, body: { ok: true }, account: opts.factorHeader };
    }
    return UNAUTHORIZED;
  });
  const el = await mount();
  await waitFor(() => el.textContent!.includes("studio-mac"), "the request");
  await press(button(el, "Confirm"));
  await waitFor(() => el.querySelector("#stepup-code") !== null, "the prompt's code field");
  const input = el.querySelector<HTMLInputElement>("#stepup-code")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, "123456"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { input.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await waitFor(() => sent.includes(`POST ${STEP_UP}`), "the factor on the wire");
  promptRead.release();
  await waitFor(() => el.querySelector('[data-testid="step-up-prompt"]') === null
    && [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Confirm"))
    && accountLine(el) !== "", "the page settled again, naming its account");
  const atResettle = { confirms, line: accountLine(el), binding: JSON.stringify(binding()) };
  factor.release();
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  return {
    atResettle,
    confirmsAfterFactor: confirms,
    confirmBinding,
    done: el.textContent!.includes(messages.approve.doneTitle),
    bindingAfter: JSON.stringify(binding()),
    sentTail: sent.slice(-6),
  };
}

describe("a factor in flight when the page settles again runs no parked confirm", () => {
  it("the page settles on the same account: the first confirm is the only one", async () => {
    const r = await inflight({ resettleAs: ACCT, factorHeader: ACCT });
    expect(r.confirmsAfterFactor, JSON.stringify(r)).toBe(1);
    expect(r.done).toBe(false);
  });
  it("the page settles on another account and the factor's answer names the first", async () => {
    const r = await inflight({ resettleAs: OTHER, factorHeader: ACCT });
    expect(r.confirmsAfterFactor, JSON.stringify(r)).toBe(1);
    expect(r.done).toBe(false);
  });
  it("the factor's answer names no account: still no second confirm", async () => {
    const r = await inflight({ resettleAs: OTHER, factorHeader: null });
    expect(r.confirmsAfterFactor, JSON.stringify(r)).toBe(1);
    expect(r.done).toBe(false);
  });
  it("a return onto a binding another account left names whom it signs in, and confirms nothing", async () => {
    realRead = true;
    bindApiOwner(ACCT);
    document.cookie = `tf_owner=${OTHER}; path=/`;
    document.cookie = "tf_csrf=c2; path=/";
    wire((m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: sessionAs(OTHER, "b@example.test"), cookie: `tf_owner=${OTHER}; path=/`, account: OTHER };
      if (url === READ) return { status: 200, body: facts(), account: OTHER };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(() => el.textContent!.includes("studio-mac") && accountLine(el) !== "", "the request and its account line");
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    const r = { line: accountLine(el), binding: JSON.stringify(apiOwnerBinding()),
      confirmsSent: sent.filter((s) => s.endsWith("/confirm")).length, sent };
    expect(r.confirmsSent, JSON.stringify(r)).toBe(0);
    expect(r.line).toContain("b@example.test");
  });
});
