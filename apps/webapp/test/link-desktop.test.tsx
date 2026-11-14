/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

/**
 * `/link-desktop` — the page the DESKTOP APP opens, asserted for the things it can get wrong
 * that nothing else would notice.
 *
 *  1. **A code is not minted by loading the page.** A mint on mount is a mint by a link
 *     prefetch, by a browser restoring tabs, and by every accidental navigation — a live
 *     credential printed on a screen nobody asked to have one on, and no bound on how often.
 *     This is the only assertion here that is about ABSENCE, and it is the most important one.
 *  2. **A dead code leaves the screen.** The TTL is the server's, and when it runs out the
 *     value has to go — a code left visible past its life is one a person keeps retyping into
 *     an app that keeps refusing it, with nothing on either screen saying why.
 *  3. **The countdown is the SERVER's number.** Rendered from `expiresIn`, so a change to
 *     `desktopLinkTtlMs` cannot leave this page confidently stating the old one.
 *  4. **A step-up refusal re-asserts IN PLACE, and the mint is retried — never a trip to
 *     `/login`.** This is the reported loop: `/login` bounces a full session straight
 *     back to the app without re-asserting a factor, so the next mint 403'd on the same stale
 *     step-up, for ever. The cure is the step-up prompt here, on the session the browser holds,
 *     and a retry — no navigation and no sign-in, so there is nowhere for the loop to live and
 *     no new web session per code. Only a browser with no session is sent to `/login`.
 *  5. **The deep link is offered ONLY for a code that is bound to a verifier.** `ohmail://` is
 *     claimed by whichever program on the machine registered it and nothing authenticates that,
 *     so handing an UNBOUND code to the scheme would give an interceptor a code it could spend —
 *     strictly worse than the retype path it replaces. The page therefore shows the button only
 *     when it was opened with a challenge, and the challenge has to reach every mint, including
 *     the one retried after a step-up ceremony.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const CODE = "handoff-code-from-the-server";

/** A challenge of the exact shape the page accepts: 43 characters of base64url. */
const CHALLENGE = "b".repeat(42) + "A";

/** What each mocked call answers with next, and how many times the mint has been asked. */
let mintCalls = 0;
/** Every body the mint was called with, in order — the challenge has to reach ALL of them. */
let mintBodies: Array<{ challenge?: string } | undefined> = [];
let mintAnswer: () => Promise<{ code: string; expiresIn: number }>;
let sessionAnswer: () => Promise<{ user: { email: string; twofaEnrolled?: unknown }; scope: string }>;
let loginAnswer: () => Promise<unknown>;
let factorAnswer: () => Promise<unknown>;
let webauthnOn = false;
let loginCalls = 0;
let stepUpCalls = 0;
/** The mint and the session read go through the REAL client, over `fetch`, instead of the answers above. */
let realRead = false;
const ACCT = "acct-1";
const OTHER = "acct-2";
/** The live session a step-up prompt reads its factors off, and the settle step its account. */
const FULL = {
  user: { accountId: ACCT, email: "mila@lichtgrat.example", twofaEnrolled: { webauthn: false, totp: true } },
  scope: "full",
};

vi.mock("../app/api-client", async () => {
  const actual = await vi.importActual<typeof import("../app/api-client")>("../app/api-client");
  return {
    ...actual,
    apiConfigured: () => true,
    messageOf: (e: unknown) => (e as { message?: string }).message ?? String(e),
    webauthnAvailable: () => webauthnOn,
    assertPasskey: () => Promise.resolve({}),
    auth: {
      desktopLink: (b?: { challenge?: string }) => {
        mintCalls += 1;
        mintBodies.push(b);
        return realRead ? actual.auth.desktopLink(b) : mintAnswer();
      },
      session: (...a: Parameters<typeof actual.auth.session>) => (realRead ? actual.auth.session(...a) : sessionAnswer()),
      login: () => { loginCalls += 1; return loginAnswer(); },
      totpVerify: () => factorAnswer(),
      recoveryVerify: () => factorAnswer(),
      webauthnAssertOptions: () => Promise.resolve({ options: {} }),
      webauthnAssertVerify: () => factorAnswer(),
      stepUpTotp: (...a: Parameters<typeof actual.auth.stepUpTotp>) => {
        stepUpCalls += 1;
        return realRead ? actual.auth.stepUpTotp(...a) : factorAnswer();
      },
      stepUpWebauthnOptions: () => Promise.resolve({ options: {} }),
      stepUpWebauthnVerify: () => factorAnswer(),
    },
  };
});

// `ApiError` is compared with `instanceof` inside the screen, so the mocked module's class has
// to be the one the test throws. Imported AFTER the mock so the augmented module is in play.
const { ApiError, apiOwnerBinding, bindApiOwner } = await import("../app/api-client");
const { markSessionAlive } = await import("@ohmail/app-logic/session/session-truth");
const apiError = (status: number, code: string, message: string): Error =>
  Object.assign(new ApiError(status, code, message), {});

/** What the real client sent, and what answered it; `cookie` stands in for the answer's `Set-Cookie`. */
type Wire = { status: number; body?: unknown; cookie?: string };
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
      status: w.status, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
const MINT = "/api/auth/desktop-link";
const UNAUTHORIZED: Wire = { status: 401, body: { error: { code: "unauthorized", message: "authentication required" } } };
const REFRESH_MISSING: Wire = { status: 401, body: { error: { code: "refresh_missing", message: "missing refresh token" } } };
const sessionOf = (accountId: string) => ({ user: { ...FULL.user, accountId, userId: `usr-${accountId}` }, scope: "full" });
const mints = (): string[] => sent.filter((s) => s.includes("/auth/desktop-link"));
/** Both spellings of the dead end: the client's literal and the catalogue's. */
const LOST = /lost the name of the account|lost track of which account/;
function clearClientState(): void {
  for (const name of ["tf_owner", "tf_csrf"]) document.cookie = `${name}=; path=/; max-age=0`;
  // AFTER the jar is empty: a revival over a marker arms a renewal that fires in the next case.
  markSessionAlive();
  bindApiOwner(null);
  if (fetchBefore) { globalThis.fetch = fetchBefore; fetchBefore = null; }
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

/** For the real client, whose round trips are more than a few microtasks long. */
async function waitFor(el: HTMLElement, predicate: () => boolean, what: string, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await act(async () => { await new Promise((r) => setTimeout(r, 15)); });
  }
  throw new Error(`timed out waiting for: ${what}; saw: ${el.textContent}`);
}

async function mount(challenge = ""): Promise<HTMLDivElement> {
  await unmount();
  const { LinkDesktopScreen } = await import("../app/(product)/link-desktop/LinkDesktopScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, children: h(LinkDesktopScreen, { challenge }),
    }));
  });
  await settle();
  return host;
}

/** The one anchor that opens the app, or null. Found by SCHEME, not by label. */
const deepLink = (el: HTMLElement): HTMLAnchorElement | null =>
  el.querySelector<HTMLAnchorElement>('a[href^="ohmail://"]');

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

/** Set a controlled input's value the way React sees a keystroke, then let effects run. */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

/** Submit the one form on screen (its onSubmit is what the primary button triggers). */
async function submitForm(el: HTMLElement): Promise<void> {
  const form = el.querySelector("form");
  if (!form) throw new Error("no form on screen to submit");
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

const input = (el: HTMLElement, id: string): HTMLInputElement => {
  const found = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!found) throw new Error(`no input #${id} on screen`);
  return found;
};

beforeEach(() => {
  clearClientState();
  sent = [];
  realRead = false;
  mintCalls = 0;
  mintBodies = [];
  webauthnOn = false;
  loginCalls = 0;
  stepUpCalls = 0;
  mintAnswer = () => Promise.resolve({ code: CODE, expiresIn: 120 });
  sessionAnswer = () => Promise.resolve(FULL);
  loginAnswer = () => Promise.reject(apiError(401, "invalid_credentials", "bad password"));
  factorAnswer = () => Promise.resolve({ ok: true });
  vi.useRealTimers();
});
afterEach(async () => { await unmount(); vi.clearAllMocks(); vi.useRealTimers(); clearClientState(); });

describe("the desktop link page", () => {
  it("MINTS NOTHING ON LOAD — a credential appears only when somebody asks for one", async () => {
    const el = await mount();
    expect(mintCalls, "the page minted a handoff code just by being opened").toBe(0);
    expect(el.textContent).not.toContain(CODE);
    // …and the way to get one is on screen, so "nothing happened" is not the whole story.
    expect(button(el, "Show me a code")).toBeTruthy();
  });

  it("shows the code on a press, with the SERVER's expiry and not a hard-coded one", async () => {
    mintAnswer = () => Promise.resolve({ code: CODE, expiresIn: 45 });
    const el = await mount();
    await press(button(el, "Show me a code"));

    expect(mintCalls).toBe(1);
    expect(el.textContent).toContain(CODE);
    // 45, from `expiresIn`. A page rendering "120" here would be stating the default TTL
    // rather than this code's, and would keep doing so after the server changed it.
    expect(el.textContent).toMatch(/45 seconds/);
    expect(el.textContent).not.toMatch(/120 seconds/);
  });

  it("TAKES THE CODE OFF THE SCREEN when it expires", async () => {
    vi.useFakeTimers();
    mintAnswer = () => Promise.resolve({ code: CODE, expiresIn: 2 });
    const el = await mount();
    await press(button(el, "Show me a code"));
    expect(el.textContent).toContain(CODE);

    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    // Gone, not greyed out. A dead credential left on screen is one somebody keeps typing.
    expect(el.textContent, "an expired code was left on the page").not.toContain(CODE);
    expect(button(el, "Show me a code")).toBeTruthy();
  });

  it("NO LOOP: a 403 step_up_required re-asserts in place and retries the mint — never /login", async () => {
    // The reproduction. Pre-fix this page answered a step-up refusal with a link to `/login`,
    // which bounced a full session back to the app without re-asserting a factor, so the retry
    // 403'd on the same stale step-up — for ever. The prompt does the factor HERE and retries.
    let minted = 0;
    mintAnswer = () => {
      minted += 1;
      // First press: the stale-step-up refusal. Second press, after a fresh factor: the code.
      return minted === 1
        ? Promise.reject(apiError(403, "step_up_required", "recent 2FA re-assertion required"))
        : Promise.resolve({ code: CODE, expiresIn: 120 });
    };
    sessionAnswer = () => Promise.resolve(FULL);

    const el = await mount();
    await press(button(el, "Show me a code"));

    // The prompt, not a redirect and not a sign-in: no /login, no password field.
    expect(el.querySelector('a[href="/login"]'), "the loop's redirect is back").toBeNull();
    expect(el.querySelector('input[type="password"]'), "the page asked for a password").toBeNull();
    expect(el.textContent).not.toContain(CODE);

    // Factor verified → the mint is retried and the code the visitor came for appears.
    await typeInto(input(el, "stepup-code"), "123456");
    await submitForm(el);
    expect(stepUpCalls, "the factor was never verified").toBe(1);
    expect(mintCalls, "the mint was not retried after the factor").toBe(2);
    expect(el.textContent).toContain(CODE);
    expect(loginCalls, "a confirmation signed in — one more web session per code").toBe(0);
    expect(el.querySelector('a[href="/login"]')).toBeNull();
  });

  it("a 401 says sign in, with the door to /login, and asks for no password here", async () => {
    // A browser with no session cannot be stepped up: a sign-in is the remedy, and it is the
    // sign-in page's, not a second one built into this page.
    mintAnswer = () => Promise.reject(apiError(401, "unauthorized", "authentication required"));
    const el = await mount();
    await press(button(el, "Show me a code"));

    expect(el.textContent).toContain(messages.linkDesktop.signInFirst);
    expect(el.querySelector('a[href="/login"]'), "the sign-in door").toBeTruthy();
    expect(el.querySelector('input[type="password"]')).toBeNull();
    expect(el.querySelector("#stepup-code"), "a factor asked of a browser with no session").toBeNull();
    expect(mintCalls).toBe(1);
    expect(loginCalls).toBe(0);
  });

  it("an unfinished enrolment is told to sign in, not shown a prompt it cannot pass", async () => {
    // Enrolment scope exists only for an account with no factor; the server refuses the mint
    // `enrollment_incomplete`, and the page's `/join` dead end went with the sign-in it followed.
    mintAnswer = () => Promise.reject(apiError(403, "enrollment_incomplete", "finish two-factor enrollment first"));
    const el = await mount();
    await press(button(el, "Show me a code"));

    expect(el.textContent).toContain(messages.linkDesktop.signInFirst);
    expect(el.querySelector("#stepup-code")).toBeNull();
    expect(el.textContent).not.toContain(CODE);
  });

  it("any OTHER refusal is reported in the server's own words, in a live region", async () => {
    // The rule the rest of this app follows: the service that made the decision writes the
    // sentence, and the client displays it. A category invented here is how somebody gets told
    // the wrong thing about why their own account refused them.
    mintAnswer = () => Promise.reject(apiError(503, "unavailable", "ohmail is having a bad minute."));
    const el = await mount();
    await press(button(el, "Show me a code"));

    const alerts = [...el.querySelectorAll('[role="alert"]')].map((n) => n.textContent).join(" | ");
    expect(alerts).toContain("ohmail is having a bad minute.");
    // Not read as a step-up: an unexpected refusal is stated, not turned into a prompt or a sign-in.
    expect(el.querySelector("#stepup-code")).toBeNull();
    expect(el.querySelector('a[href="/login"]')).toBeNull();
  });

  it("NO CHALLENGE, NO DEEP LINK — an unbound code is never handed to the scheme", async () => {
    // The refusal that matters, and it is the one an implementation drifts away from first,
    // because "always show the button" reads like a simplification. `ohmail://` is claimed by
    // whichever program on the machine registered it and nothing authenticates that, so an
    // UNBOUND code sent over it is spendable by an interceptor — strictly worse than the retype
    // path it would be replacing. A visitor who opened this page themselves holds no verifier, so
    // there is nothing to bind to and the honest answer is the page that shipped before.
    const el = await mount();
    await press(button(el, "Show me a code"));
    expect(el.textContent).toContain(CODE);
    expect(deepLink(el), "an unbound code was offered to the ohmail:// scheme").toBeNull();
    // …and the mint was told there was no challenge, rather than being told an empty one.
    expect(mintBodies).toEqual([{ challenge: "" }]);
    // The retype instructions are still the whole route forward.
    expect(el.textContent).toMatch(/Type the code above/);
  });

  it("WITH a challenge: the button carries the CODE and nothing else", async () => {
    const el = await mount(CHALLENGE);
    await press(button(el, "Show me a code"));

    const a = deepLink(el);
    expect(a, "a bound code was not offered to the app").not.toBeNull();
    const url = new URL(a!.href);
    expect(url.protocol).toBe("ohmail:");
    expect(url.searchParams.get("code")).toBe(CODE);
    // NO TOKENS AND NO VERIFIER ON THE WIRE. The deep link carries the one-use handoff code and
    // nothing else — the code is worth a session only to whoever also holds the verifier, and the
    // verifier belongs to the app, which is the party that never had to send it anywhere. A
    // second parameter here would be the whole point of the binding thrown away, so the query is
    // asserted as an exact set rather than by checking one key.
    expect([...url.searchParams.keys()]).toEqual(["code"]);
    expect(a!.href).not.toContain(CHALLENGE);

    // The retype path stays on screen beside it. A scheme handler can be absent, or claimed by
    // something that does nothing visible, and a page whose only route forward is a button that
    // quietly did not work is a dead end.
    expect(el.textContent).toMatch(/Type the code above/);
    expect(el.textContent).toMatch(/If nothing opens/);
  });

  it("the button DIES WITH THE CODE — it is never a stale link to a spent credential", async () => {
    vi.useFakeTimers();
    mintAnswer = () => Promise.resolve({ code: CODE, expiresIn: 2 });
    const el = await mount(CHALLENGE);
    await press(button(el, "Show me a code"));
    expect(deepLink(el)).not.toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    // A link left behind after the code expired opens the app with a value the server refuses,
    // and the person is left reading a refusal about a code they never typed.
    expect(deepLink(el), "an expired code was left in an ohmail:// link").toBeNull();
  });

  it("the challenge reaches the mint RETRIED after a step-up, not just the first", async () => {
    // The silent failure this closes: the first mint 403s, the visitor completes a factor, and
    // the retry drops the challenge. The code that comes back is UNBOUND while the app is still
    // holding a verifier — so the claim is refused and neither screen says why. Worse, the page
    // would then offer the deep link (it has a challenge in its props) for a code the binding
    // does not cover.
    let minted = 0;
    mintAnswer = () => {
      minted += 1;
      return minted === 1
        ? Promise.reject(apiError(403, "step_up_required", "recent 2FA re-assertion required"))
        : Promise.resolve({ code: CODE, expiresIn: 120 });
    };
    sessionAnswer = () => Promise.resolve(FULL);

    const el = await mount(CHALLENGE);
    await press(button(el, "Show me a code"));
    await typeInto(input(el, "stepup-code"), "123456");
    await submitForm(el);

    expect(mintCalls).toBe(2);
    expect(mintBodies, "the retried mint dropped the challenge").toEqual([
      { challenge: CHALLENGE }, { challenge: CHALLENGE },
    ]);
    expect(deepLink(el)).not.toBeNull();
  });

  it("says out loud that nobody will ever ask for the code", async () => {
    // Copy, and it is load-bearing: a one-use code that grants a session on a new machine is
    // exactly the shape a support-desk impersonator asks for, and the page that prints it is
    // the only place that warning is read at the moment it matters.
    const el = await mount();
    expect(el.textContent).toMatch(/Nobody from ohmail will ever ask you for this code/);
  });
});

/*
 * THE REAL CLIENT, NO MOCK IN FRONT OF THE OWNER GATE. A browser that never signed in holds no
 * `tf_owner`; the mint's press was refused by the gate before anything was sent, and the page said
 * "Reload the page and it comes back", which was false.
 */
describe("the page settles whose browser this is before it offers a code", () => {
  it("a browser with no marker and no session is shown the sign-in door at once, and no code is asked for", async () => {
    realRead = true;
    wire((_m, url) => (url === "/auth/refresh" ? REFRESH_MISSING : UNAUTHORIZED));
    const el = await mount();
    await waitFor(el, () => el.querySelector('a[href="/login"]') !== null, "the sign-in door");
    expect(el.textContent).toContain(messages.linkDesktop.signInFirst);
    expect(() => button(el, "Show me a code")).toThrow();
    expect(el.textContent).not.toMatch(LOST);
    expect(sent).toContain("GET /api/auth/session");
    expect(mints()).toEqual([]);
  });

  it("control: a signed-in browser asks for a code and gets it", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    document.cookie = "tf_csrf=c1; path=/";
    wire((m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: sessionOf(ACCT) };
      if (m === "POST" && url === MINT) return { status: 200, body: { code: CODE, expiresIn: 120 } };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(el, () => [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Show me a code")), "the button");
    await press(button(el, "Show me a code"));
    await waitFor(el, () => el.textContent!.includes(CODE), "the code");
    expect(mints()).toEqual([`POST ${MINT}`]);
  });

  it("a live session whose marker went missing gets it back from the session read, and the press mints", async () => {
    realRead = true;
    document.cookie = "tf_csrf=c1; path=/";
    wire((m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: sessionOf(ACCT), cookie: `tf_owner=${ACCT}; path=/` };
      if (m === "POST" && url === MINT) return { status: 200, body: { code: CODE, expiresIn: 120 } };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(el, () => [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Show me a code")), "the button");
    await press(button(el, "Show me a code"));
    await waitFor(el, () => el.textContent!.includes(CODE) || LOST.test(el.textContent ?? ""), "the code or the dead end");
    expect(el.textContent).not.toMatch(LOST);
    expect(el.textContent).toContain(CODE);
  });

  it("a marker that goes before the press sends the page back through the settle step, not to a dead end", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    let signedIn = true;
    wire((_m, url) => {
      if (url === "/auth/refresh") return REFRESH_MISSING;
      if (url === "/api/auth/session") return signedIn ? { status: 200, body: sessionOf(ACCT) } : UNAUTHORIZED;
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(el, () => [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Show me a code")), "the button");
    // Another tab signed out: the server ended the session and cleared the jar, marker included.
    signedIn = false;
    document.cookie = "tf_owner=; path=/; max-age=0";
    await press(button(el, "Show me a code"));
    await waitFor(el, () => el.querySelector('a[href="/login"]') !== null, "the sign-in door");
    expect(el.textContent).not.toMatch(LOST);
    expect(mints(), "a mint left with no account named").toEqual([]);
  });

  /* STEP-UP-PROMPT-SAYS-THE-RELOAD-SENTENCE on this page: the factor is refused before it is sent,
     the prompt hands that to the settle step, and the mint it parked does not run by itself. */
  it("a marker that goes before the factor is verified settles the page again, and no code is minted by itself", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    document.cookie = "tf_csrf=c1; path=/";
    wire((m, url) => {
      if (url === "/api/auth/session") return { status: 200, body: sessionOf(ACCT), cookie: `tf_owner=${ACCT}; path=/` };
      if (m === "POST" && url === MINT) {
        return { status: 403, body: { error: { code: "step_up_required", message: "recent 2FA re-assertion required" } } };
      }
      if (m === "POST" && url === "/api/auth/step-up/totp") return { status: 200, body: { ok: true } };
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(el, () => [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Show me a code")), "the button");
    await press(button(el, "Show me a code"));
    await waitFor(el, () => el.querySelector("#stepup-code") !== null, "the inline prompt's code field");
    document.cookie = "tf_owner=; path=/; max-age=0";
    await typeInto(input(el, "stepup-code"), "123456");
    await submitForm(el);
    await waitFor(el, () => el.querySelector("#stepup-code") === null
      && [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Show me a code")), "the page settled again");
    expect(el.textContent).not.toMatch(LOST);
    expect(sent, "the factor went out with no account named").not.toContain("POST /api/auth/step-up/totp");
    expect(mints(), "a code was minted by itself after the settle").toEqual([`POST ${MINT}`]);
  });

  it("a jar that became another account's before the press says so in the catalogue's words", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    wire((_m, url) => (url === "/api/auth/session" ? { status: 200, body: sessionOf(ACCT) } : UNAUTHORIZED));
    const el = await mount();
    await waitFor(el, () => [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Show me a code")), "the button");
    document.cookie = `tf_owner=${OTHER}; path=/`;
    await press(button(el, "Show me a code"));
    await waitFor(el, () => el.textContent!.includes(messages.session.refusedOwnerMismatch), "the mismatch sentence");
    expect(el.textContent).not.toContain("This window is signed in to a different account");
    expect(mints()).toEqual([]);
  });

  it("while the page settles it offers no code to ask for", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    let release!: (w: Wire) => void;
    const answer = new Promise<Wire>((r) => { release = r; });
    wire((_m, url) => (url === "/api/auth/session" ? answer : UNAUTHORIZED));
    const el = await mount();
    await waitFor(el, () => sent.includes("GET /api/auth/session"), "the settle's read");
    expect(el.textContent).toContain(messages.linkDesktop.working);
    expect(() => button(el, "Show me a code"), "a press could come before the page knew whose browser this is").toThrow();
    release({ status: 200, body: sessionOf(ACCT) });
    await waitFor(el, () => [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Show me a code")), "the button after the settle");
  });

  it("a browser whose marker names ANOTHER account says so, binds nothing and offers no code", async () => {
    realRead = true;
    document.cookie = `tf_owner=${OTHER}; path=/`;
    wire((_m, url) => (url === "/api/auth/session" ? { status: 200, body: sessionOf(ACCT) } : UNAUTHORIZED));
    const el = await mount();
    await waitFor(el, () => el.textContent!.includes(messages.session.refusedOwnerMismatch), "the mismatch sentence");
    expect(() => button(el, "Show me a code")).toThrow();
    expect(apiOwnerBinding().kind).not.toBe("bound");
    expect(mints()).toEqual([]);
  });
});

/**
 * A BUSY SERVER IS A WAIT, NOT A DEAD END. The report: the mint answered the API's own
 * 503 `db_busy` and the page printed the refusal above the button, with nothing to do but reload.
 * Now the page waits out the server's `Retry-After` on the shell's retry ladder, says the SERVER
 * is busy with a countdown, keeps its button, and mints on the retry. The busy write is marked
 * `retryable: false` by the server (a mint may have landed); the page asks again anyway, because a
 * second one-use code costs nothing.
 */
describe("the desktop link page under a busy server", () => {
  const busy = (): Error => new ApiError(
    503, "db_busy", "the server's database connection was busy and this request could not be started; retry shortly",
    undefined, { coded: true, retryable: false, retryAfterMs: 5_000 },
  );

  it("waits out a busy answer with a countdown, keeps the button, and mints on the retry", async () => {
    vi.useFakeTimers();
    let answers = 0;
    mintAnswer = () => (answers++ === 0 ? Promise.reject(busy()) : Promise.resolve({ code: CODE, expiresIn: 120 }));
    const el = await mount();
    await press(button(el, "Show me a code"));

    const status = el.querySelector('[role="status"]')?.textContent ?? "";
    expect(status).toMatch(/^The server is busy — retrying in \d+ s\.$/);
    expect(el.querySelector('[role="alert"]'), "a busy answer is not an error on screen").toBeNull();
    expect(el.textContent).not.toMatch(/sign in|session/i);
    expect(button(el, "Show me a code").disabled, "the button stays live during the wait").toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await settle();
    expect(mintCalls).toBe(2);
    expect(el.textContent).toContain(CODE);
    expect(el.querySelector('[role="status"]')).toBeNull();
  });

  it("a press during the wait retries at once", async () => {
    vi.useFakeTimers();
    let answers = 0;
    mintAnswer = () => (answers++ === 0 ? Promise.reject(busy()) : Promise.resolve({ code: CODE, expiresIn: 120 }));
    const el = await mount();
    await press(button(el, "Show me a code"));
    expect(mintCalls).toBe(1);
    await press(button(el, "Show me a code"));
    expect(mintCalls).toBe(2);
    expect(el.textContent).toContain(CODE);
    // …and the retry it started is the only one: no second mint rides along on the timer.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mintCalls).toBe(2);
  });

  it("the button is not live while the retry it started is in flight — one press, one mint", async () => {
    vi.useFakeTimers();
    let release: (v: { code: string; expiresIn: number }) => void = () => {};
    let answers = 0;
    mintAnswer = () => (answers++ === 0
      ? Promise.reject(busy())
      : new Promise((resolve) => { release = resolve; }));
    const el = await mount();
    await press(button(el, "Show me a code"));
    await press(button(el, "Show me a code"));   // ends the wait; the retry is now in flight
    expect(mintCalls).toBe(2);
    expect(button(el, "Working").disabled).toBe(true);
    await act(async () => { release({ code: CODE, expiresIn: 120 }); });
    await settle();
    expect(el.textContent).toContain(CODE);
  });

  it("after four busy answers it says the server is still busy, names no session, and keeps the button", async () => {
    vi.useFakeTimers();
    mintAnswer = () => Promise.reject(busy());
    const el = await mount();
    await press(button(el, "Show me a code"));
    for (let i = 0; i < 3; i += 1) {
      await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
      await settle();
    }
    expect(mintCalls).toBe(4);
    const alerts = [...el.querySelectorAll('[role="alert"]')].map((n) => n.textContent).join(" | ");
    expect(alerts).toBe("The server is still busy. Press the button to try again.");
    expect(el.textContent).not.toMatch(/database connection/);
    expect(button(el, "Show me a code").disabled).toBe(false);
  });

  it("an uncoded 503 is not our busy answer — it is reported, not waited out", async () => {
    mintAnswer = () => Promise.reject(apiError(503, "db_busy", "a platform page"));
    const el = await mount();
    await press(button(el, "Show me a code"));
    expect(mintCalls).toBe(1);
    expect(el.querySelector('[role="status"]')).toBeNull();
  });
});

/**
 * THE ONE PARAMETER THIS PAGE READS FROM ITS URL, validated on the server before it reaches the
 * client component.
 *
 * The page's header argues why a challenge in the query is a commitment rather than a credential
 * — it makes the minted code strictly LESS useful, so a crafted link denies a handoff instead of
 * escalating one. What that argument does NOT license is passing an arbitrary string through: a
 * value that is not a SHA-256 digest cannot bind anything, and it would reach the API only to be
 * refused there. Dropping it here means a junk URL mints an ordinary retypable code and shows no
 * deep link, which is the same page a visitor with no parameter at all gets.
 */
describe("the page reads a challenge from the URL, and only a well-formed one", () => {
  const challengeOf = async (
    searchParams: Record<string, string | string[] | undefined>,
  ): Promise<string> => {
    const { default: LinkDesktopPage } = await import("../app/(product)/link-desktop/page.js");
    const el = await LinkDesktopPage({ searchParams: Promise.resolve(searchParams) });
    return (el as unknown as { props: { challenge: string } }).props.challenge;
  };

  it("passes a 43-character base64url challenge through untouched", async () => {
    expect(await challengeOf({ challenge: CHALLENGE })).toBe(CHALLENGE);
    // Surrounding whitespace survives a copy-paste and is not a malformed value.
    expect(await challengeOf({ challenge: ` ${CHALLENGE}\n` })).toBe(CHALLENGE);
  });

  it("drops anything that is not one — length, alphabet, padding, or the wrong encoding", async () => {
    for (const raw of [
      "b".repeat(42),                              // one too short
      "b".repeat(44),                              // one too long
      `${"b".repeat(42)}=`,                        // padded
      `${"b".repeat(42)}+`,                        // standard base64, not base64url
      `${"b".repeat(42)}/`,
      "0".repeat(64),                              // a hex digest
      "",
    ]) {
      expect(await challengeOf({ challenge: raw }), `"${raw.slice(0, 20)}" was let through`).toBe("");
    }
  });

  it("no parameter at all is the ordinary page, and a repeated one takes the FIRST", async () => {
    expect(await challengeOf({})).toBe("");
    // The same rule `/join` applies to `?code=` and `/verify-email` to `?token=`. Safe direction:
    // the worst outcome is a handoff that has to be retyped.
    expect(await challengeOf({ challenge: [CHALLENGE, "x".repeat(43)] })).toBe(CHALLENGE);
    expect(await challengeOf({ challenge: ["nonsense", CHALLENGE] })).toBe("");
  });
});

/**
 * A FACTOR ALREADY ON ITS WAY when the page settles again mints nothing parked behind the prompt:
 * the prompt's own read answers owner_absent while the code is out, the page settles, and only
 * then does the factor's answer land. The mint that opened the prompt is the only one sent, and no
 * code is shown without a new press.
 */
describe("a factor in flight when /link-desktop settles again mints nothing parked", () => {
  it("the parked mint does not run after the re-settle without a new press", async () => {
    realRead = true;
    document.cookie = `tf_owner=${ACCT}; path=/`;
    document.cookie = "tf_csrf=c1; path=/";
    let stage: "page" | "prompt" | "after" = "page";
    let releasePrompt!: () => void;
    const promptRead = new Promise<void>((r) => { releasePrompt = r; });
    let releaseFactor!: () => void;
    const factor = new Promise<void>((r) => { releaseFactor = r; });
    let mintsSent = 0;
    wire(async (m, url) => {
      if (url === "/api/auth/session") {
        if (stage === "prompt") {
          stage = "after";
          await promptRead;
          document.cookie = "tf_owner=; path=/; max-age=0";
          return { status: 200, body: sessionOf(ACCT) };
        }
        return { status: 200, body: sessionOf(ACCT), cookie: `tf_owner=${ACCT}; path=/` };
      }
      if (m === "POST" && url === MINT) {
        mintsSent += 1;
        if (mintsSent === 1) {
          stage = "prompt";
          return { status: 403, body: { error: { code: "step_up_required", message: "recent 2FA re-assertion required" } } };
        }
        return { status: 200, body: { code: CODE, expiresIn: 120 } };
      }
      if (m === "POST" && url === "/api/auth/step-up/totp") { await factor; return { status: 200, body: { ok: true } }; }
      return UNAUTHORIZED;
    });
    const el = await mount();
    await waitFor(el, () => [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Show me a code")), "the button");
    await press(button(el, "Show me a code"));
    await waitFor(el, () => el.querySelector("#stepup-code") !== null, "the prompt's code field");
    await typeInto(input(el, "stepup-code"), "123456");
    await submitForm(el);
    await waitFor(el, () => sent.includes("POST /api/auth/step-up/totp"), "the factor on the wire");
    releasePrompt();
    await waitFor(el, () => el.querySelector("#stepup-code") === null
      && [...el.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim().startsWith("Show me a code")), "the page settled again");
    const atResettle = { mints: mintsSent, codeShown: el.textContent!.includes(CODE) };
    releaseFactor();
    await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
    expect(mintsSent, JSON.stringify(atResettle)).toBe(1);
    expect(el.textContent).not.toContain(CODE);
  });
});
