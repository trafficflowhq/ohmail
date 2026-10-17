/** @vitest-environment jsdom */
/**
 * ═══ RECOVERY CODES BELONG TO AN ACCOUNT, SO THE WIZARD ASKS WHICH ONE ════════════════════
 *
 * `POST /auth/2fa/recovery-codes` generates for whatever session the browser holds at that
 * moment, and it DELETES the previous set. Under the wrong session it therefore does two
 * irreversible things at once: it puts somebody else's codes on the screen of whoever is looking
 * at this wizard, and it destroys the codes that account may already have written down.
 *
 * ── WHY THE ACCOUNT BOUNDARY CANNOT REACH THIS SCREEN ──────────────────────────────────────
 *
 * Everything else signed-in is protected by comparing the browser's `tf_owner` marker against
 * the account the client is bound to. An ENROLMENT session sets no marker at all — the server's
 * `enrollmentCookies` writes none — so on this screen there is nothing readable to compare and
 * nothing to bind. Absence here is not the "silence" that gate reasons about; it is the ordinary
 * state of being half signed up.
 *
 * So the question goes to the only party that can answer it: `GET /auth/session`, immediately
 * before the generate, compared against the account the wizard started as. That is a different
 * instrument from a boundary or a lock, and it is different because neither of those can tell
 * that the enrolment session underneath this screen has been replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIXTURE_SHAPES, base32Seed } from "../../../test/support/fixture-credentials.js";
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

const router = { replace: vi.fn(), push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

/** The authenticator seed the setup step answers with, assembled at run time. */
const SEED = base32Seed("join-account-switch");

it("the fixture seed has a TOTP seed's shape", () => {
  expect(SEED).toMatch(FIXTURE_SHAPES.base32);
});

/** Every request, in order — the evidence "nothing was generated" rests on. */
let calls: string[] = [];
/** What each successive `GET /auth/session` answers. The last entry repeats. */
let sessionScript: Array<Record<string, unknown>> = [];
let sessionAt = 0;
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** A full session for `account`, mid-enrolment: everything but the recovery codes. */
const asAccount = (accountId: string, email: string) => ({
  user: {
    userId: `u_${accountId}`, accountId, email, displayName: "Pat",
    emailVerified: true,
    twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: false },
  },
  scope: "full",
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  sessionAt = 0;
  sessionScript = [asAccount("acct_A", "a@example.invalid")];
  router.replace.mockClear();
  router.push.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/auth/session")) {
      sessionAt += 1;
      return json(sessionScript[Math.min(sessionAt, sessionScript.length) - 1]!);
    }
    if (url.includes("/auth/2fa/recovery-codes")) {
      return json({ codes: ["aaaa-bbbb", "cccc-dddd"] });
    }
    if (url.includes("/mailboxes")) return json({ items: [] });
    return json({});
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function mountJoin(props: {
  initialCode?: string; publicSignup?: boolean; billingReturn?: "success" | "cancelled";
} = {}): Promise<HTMLElement> {
  const { JoinScreen } = await import("../app/(product)/join/JoinScreen.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        // `publicSignup` decides the FIRST step: an invite-only server opens on the invite step,
        // an open one on the account form. The registration path needs the latter.
        children: h(JoinScreen, { initialCode: "", publicSignup: false, ...props }),
      }),
    );
    await Promise.resolve();
  });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
  return host;
}

const generated = (): string[] => calls.filter((u) => u.includes("/auth/2fa/recovery-codes"));

describe("the ordinary first signup — the path the guard was OFF for", () => {
  /**
   * ═══ THE HOLE THE RELOAD TEST COULD NOT SEE ══════════════════════════════════════════════
   *
   * `wizardAccount` was assigned only by `bootstrap`, and `bootstrap` is the RELOAD path — its
   * `GET /auth/session` 401s on a first signup and is caught. So the ordinary flow reached the
   * codes step with `wizardAccount === null`, and the comparison, written
   * `wizardAccount !== null && …`, turned ITSELF OFF. The guard was present, tested, and not on
   * for the one path everybody takes.
   *
   * Two changes make it real: the account is captured from REGISTRATION, and the comparison fails
   * CLOSED — an unknown wizard account refuses, because "we never learned who this is" is not
   * evidence that it is the right one.
   */
  it("captures the account from registration, so the compare is armed without a reload", async () => {
    // No prior session: the bootstrap 401s exactly as it does for a real first signup.
    sessionScript = [];
    let registered = false;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/auth/register")) {
        registered = true;
        return json({
          status: "enrollment", next: "enroll_2fa", enrollmentToken: "t", expiresIn: 600,
          user: {
            userId: "u_A", accountId: "acct_A", email: "a@example.invalid", displayName: "Pat",
            emailVerified: false,
            twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
          },
        });
      }
      if (url.includes("/auth/session")) {
        // Before registering: no session. After: the browser has become B in another tab.
        if (!registered) return json({ error: { code: "unauthorized" } }, 401);
        return json(asAccount("acct_B", "b@example.invalid"));
      }
      if (url.includes("/auth/2fa/recovery-codes")) return json({ codes: ["aaaa-bbbb"] });
      if (url.includes("/mailboxes")) return json({ items: [] });
      void init;
      return json({});
    }) as unknown as typeof globalThis.fetch;

    try {
      const c = await mountJoin({ publicSignup: true });
      const form = c.querySelector("form");
      expect(form, "the wizard did not render the account step").toBeTruthy();
      const setValue = (el: HTMLInputElement, v: string): void => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => {
        const email = c.querySelector<HTMLInputElement>('input[type="email"]');
        const pw = c.querySelector<HTMLInputElement>('input[type="password"]');
        const name = c.querySelector<HTMLInputElement>('input[type="text"]');
        if (email) setValue(email, "a@example.invalid");
        if (pw) setValue(pw, "hunter2hunter2");
        if (name) setValue(name, "Pat");
      });
      await act(async () => {
        form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });

      expect(registered, "the registration never happened, so nothing was captured").toBe(true);
      expect(c.textContent, "the wizard did not reach the factor step").toContain("passkey");

      /* THE ACTION, and it has to be one actually REACHABLE here. A first draft asserted that no
         recovery codes were generated — which was vacuously true, because registration lands on
         the FACTOR step and the codes step is several presses away. The test passed with the fix
         removed. The authenticator step is the first account-bearing action after registration,
         it DISPLAYS a secret belonging to whatever account answers, and it is one press. */
      const totpButton = [...c.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").toLowerCase().includes("authenticator")
          || (b.textContent ?? "").toLowerCase().includes("totp")
          || b.className.includes("join-alt"));
      expect(totpButton, "the factor step offered no authenticator option to press").toBeTruthy();
      await act(async () => { (totpButton as HTMLButtonElement).click(); });
      for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });

      /* The browser is B by now. Before the fix `wizardAccount` was null on this path and the
         comparison disabled itself, so the secret was enrolled and shown for B. */
      expect(calls.filter((u) => u.includes("/auth/2fa/totp/enroll")),
        "another account's authenticator secret was created on the ordinary signup path")
        .toEqual([]);
      expect(c.textContent, "the person is not told which account the browser now holds")
        .toContain("b@example.invalid");
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  /**
   * ═══ AND THE CONTROL THE CASE ABOVE CANNOT BE WITHOUT ════════════════════════════════════
   *
   * Round eight's review found the case above **mutation-insensitive**, and it was right, and
   * the excuse the previous round gave for it — "a partial revert of a two-part fix is not the
   * defect" — was wrong here. Delete the registration capture alone and the case above still
   * passes: with no captured account the comparison fails CLOSED, so no enrolment happens and
   * the other account's address is still displayed. Both assertions hold for the WRONG reason.
   *
   * What that costs is not cosmetic. With the capture gone, the comparison never has an account
   * to compare, so it refuses on EVERY ordinary signup — the passkey, the authenticator, the
   * mailbox, the plan. The product would be unusable for every new customer and the suite would
   * be green, because every test on this path asserts a refusal.
   *
   * So this is the same journey with the session UNCHANGED, and it asserts the enrolment RUNS.
   * The two together tell the capture apart from the fail-closed default: one needs it present
   * to refuse the right person, the other needs it present to admit the right one.
   */
  it("…and an ordinary signup whose session does not change still enrols", async () => {
    sessionScript = [];
    let registered = false;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/auth/register")) {
        registered = true;
        return json({
          status: "enrollment", next: "enroll_2fa", enrollmentToken: "t", expiresIn: 600,
          user: {
            userId: "u_A", accountId: "acct_A", email: "a@example.invalid", displayName: "Pat",
            emailVerified: false,
            twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
          },
        });
      }
      // No session before registering — the ordinary first signup — and the SAME account after.
      if (url.includes("/auth/session")) {
        if (!registered) return json({ error: { code: "unauthorized" } }, 401);
        return json(asAccount("acct_A", "a@example.invalid"));
      }
      if (url.includes("/auth/2fa/totp/enroll")) {
        return json({ secret: SEED, otpauthUrl: `otpauth://totp/ohmail:fixture?secret=${SEED}&issuer=ohmail` });
      }
      if (url.includes("/mailboxes")) return json({ items: [] });
      return json({});
    }) as unknown as typeof globalThis.fetch;

    try {
      const c = await mountJoin({ publicSignup: true });
      const form = c.querySelector("form");
      expect(form, "the wizard did not render the account step").toBeTruthy();
      const setValue = (el: HTMLInputElement, v: string): void => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => {
        const email = c.querySelector<HTMLInputElement>('input[type="email"]');
        const pw = c.querySelector<HTMLInputElement>('input[type="password"]');
        const name = c.querySelector<HTMLInputElement>('input[type="text"]');
        if (email) setValue(email, "a@example.invalid");
        if (pw) setValue(pw, "hunter2hunter2");
        if (name) setValue(name, "Pat");
      });
      await act(async () => {
        form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });
      expect(registered, "the registration never happened").toBe(true);

      const totpButton = [...c.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").toLowerCase().includes("authenticator")
          || (b.textContent ?? "").toLowerCase().includes("totp")
          || b.className.includes("join-alt"));
      expect(totpButton, "the factor step offered no authenticator option to press").toBeTruthy();
      await act(async () => { (totpButton as HTMLButtonElement).click(); });
      for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });

      expect(calls.filter((u) => u.includes("/auth/2fa/totp/enroll")),
        "the guard refused an ordinary signup — with no captured account it fails closed on the one path everybody takes")
        .toHaveLength(1);
      // Shown in groups of four, as authenticator apps print a setup key.
      expect(c.textContent?.replace(/\s+/g, ""), "the secret was fetched and never shown")
        .toContain(SEED);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});

/**
 * ═══ A GUARD THAT RE-ANCHORS ITSELF TO WHATEVER IT IS SHOWN IS NOT A GUARD ════════════════
 *
 * Round eight's HIGH finding. `bootstrap()` assigned the wizard's account unconditionally, and
 * it is not only the mount path: the verification step's "I have confirmed it" button calls it
 * again, by design, because that button is the one thing that re-reads the server.
 *
 * So the wizard could be re-pointed at whoever the browser had become, by a press whose whole
 * purpose is to re-read. After that every comparison compared B with B and passed. Worse, the
 * same bootstrap ROUTES from the server's answer: an account without recovery codes lands on
 * the codes step, whose mount effect generates without a further press. B's codes, minted and
 * rendered in A's window, and B's previous set destroyed by the same call.
 */
describe("a later session read is compared, never applied", () => {
  it("the verification recheck does not re-point the wizard at the account that signed in since", async () => {
    /* A, mid-enrolment, unverified — which is what puts the wizard on the verify step and puts
       the recheck button on screen. Then the browser becomes B, who has no recovery codes
       either: exactly the state that used to route this window into generating them. */
    sessionScript = [
      { user: { userId: "u_A", accountId: "acct_A", email: "a@example.invalid", displayName: "Pat",
                emailVerified: false,
                twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true } },
        scope: "full" },
      asAccount("acct_B", "b@example.invalid"),
    ];
    const c = await mountJoin();

    // The premise: we really are on the verify step, with the recheck button rendered.
    const recheck = [...c.querySelectorAll("button")]
      .find((b) => /confirm|check|refresh|already/i.test(b.textContent ?? ""));
    expect(recheck, "the wizard is not on the verification step, so this proves nothing")
      .toBeTruthy();
    const before = generated().length;
    expect(before, "codes were generated before the press — the sequence is not the cause").toBe(0);

    await act(async () => { (recheck as HTMLButtonElement).click(); });
    for (let i = 0; i < 10; i += 1) await act(async () => { await Promise.resolve(); });

    expect(generated(),
      "the recheck re-anchored the wizard to the account that signed in since, and generated ITS codes")
      .toEqual([]);
    expect(c.textContent, "somebody else's codes were rendered here").not.toContain("aaaa-bbbb");
    expect(c.textContent, "the person is not told which account the browser now holds")
      .toContain("b@example.invalid");
  });
});

describe("the wizard generates codes only for the account it started as", () => {
  /**
   * THE CONTROL FIRST. Without it every assertion below is green over a wizard that never
   * reached the codes step at all — which is the shape this repository keeps paying for.
   */
  it("generates and renders them when the session has not changed", async () => {
    sessionScript = [asAccount("acct_A", "a@example.invalid")];
    const c = await mountJoin();

    expect(generated().length, "the wizard never asked for codes, so nothing below proves anything")
      .toBe(1);
    expect(c.textContent, "the codes were requested but never rendered").toContain("aaaa-bbbb");
  });

  /**
   * THE SEQUENCE. The wizard starts as A; another tab signs in as B before the generate step —
   * the enrolment session under this screen is replaced, and nothing readable in this browser
   * says so. The re-read is what notices.
   */
  it("stops, generates nothing, and says which account is signed in now", async () => {
    sessionScript = [
      asAccount("acct_A", "a@example.invalid"),   // the wizard's own bootstrap
      asAccount("acct_B", "b@example.invalid"),   // …and the browser has since become B
    ];
    const c = await mountJoin();

    expect(generated(), "codes were generated for an account this wizard did not start as")
      .toEqual([]);
    expect(c.textContent, "the person is not told which account the browser now holds")
      .toContain("b@example.invalid");
    expect(c.textContent, "somebody else's codes were rendered here").not.toContain("aaaa-bbbb");
  });

  /**
   * AND THE ASK ITSELF IS THE POINT: the compare is worth nothing if it reads a cached answer.
   * The wizard must go back to the server immediately before it generates.
   */
  it("re-reads the session immediately before generating, rather than trusting its own state", async () => {
    sessionScript = [asAccount("acct_A", "a@example.invalid")];
    await mountJoin();
    const sessionReads = calls.filter((u) => u.includes("/auth/session")).length;
    expect(sessionReads, "the generate step trusted the account the wizard read at mount")
      .toBeGreaterThanOrEqual(2);
    // …and the order is what matters: the read precedes the generate.
    expect(calls.findIndex((u) => u.includes("/auth/2fa/recovery-codes")))
      .toBeGreaterThan(calls.findIndex((u) => u.includes("/auth/session")));
  });
});

/**
 * ═══ THE WINDOW BETWEEN THE ASK AND THE WRITE ════════════════════════════════════════════
 *
 * `sameAccount()` asks the server who this browser holds, and then makes the request. A session
 * replaced between those two is invisible from here — the same shape as
 * `AF-RESPONSE-NOT-OWNER-BOUND`, and it was filed with it.
 *
 * The server closes it: a request whose live session and credential disagree is refused `409
 * session_conflict` before anything is done. What is left on this side is saying so — in the
 * words the preflight uses, not the raw sentence of an error nobody can act on — and NOT naming
 * an account this client never read.
 */
describe("a switch between the check and the write is the server's refusal, said plainly", () => {
  it("renders the account-changed refusal for a 409 session_conflict, and names no account", async () => {
    let conflicted = false;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      // The preflight still agrees — that is the whole point of the window.
      if (url.includes("/auth/session")) return json(asAccount("acct_A", "a@example.invalid"));
      if (url.includes("/auth/2fa/recovery-codes")) {
        conflicted = true;
        return json({ error: { code: "session_conflict", message: "raw server sentence" } }, 409);
      }
      if (url.includes("/mailboxes")) return json({ items: [] });
      return json({});
    }) as unknown as typeof globalThis.fetch;

    try {
      const c = await mountJoin();
      expect(conflicted, "the generate was never attempted, so the refusal proves nothing").toBe(true);
      expect(c.textContent, "somebody else's codes were rendered here").not.toContain("aaaa-bbbb");
      expect(c.textContent, "the person is told nothing they can act on")
        .toMatch(/another account/i);
      expect(c.textContent, "the server's raw sentence was rendered instead of an explanation")
        .not.toContain("raw server sentence");
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  /**
   * AND THE COPY IS ABOUT THE ACTION THAT WAS REFUSED, NOT ABOUT THE CODES.
   *
   * The message the preflight renders said "Recovery codes were not created" on all seven sites
   * once round seven put the comparison in front of every one of them — so refusing a passkey, an
   * authenticator or a mailbox told the person about codes nobody had asked for. A sentence that
   * names the wrong thing is not a smaller defect than one that names nothing.
   */
  it("the refusal on a NON-codes action does not talk about recovery codes", async () => {
    sessionScript = [];
    let registered = false;
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/auth/register")) {
        registered = true;
        return json({
          status: "enrollment", next: "enroll_2fa", enrollmentToken: "t", expiresIn: 600,
          user: {
            userId: "u_A", accountId: "acct_A", email: "a@example.invalid", displayName: "Pat",
            emailVerified: false,
            twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
          },
        });
      }
      if (url.includes("/auth/session")) {
        if (!registered) return json({ error: { code: "unauthorized" } }, 401);
        return json(asAccount("acct_B", "b@example.invalid"));
      }
      if (url.includes("/mailboxes")) return json({ items: [] });
      return json({});
    }) as unknown as typeof globalThis.fetch;

    try {
      const c = await mountJoin({ publicSignup: true });
      const form = c.querySelector("form");
      const setValue = (el: HTMLInputElement, v: string): void => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      };
      await act(async () => {
        const email = c.querySelector<HTMLInputElement>('input[type="email"]');
        const pw = c.querySelector<HTMLInputElement>('input[type="password"]');
        const name = c.querySelector<HTMLInputElement>('input[type="text"]');
        if (email) setValue(email, "a@example.invalid");
        if (pw) setValue(pw, "hunter2hunter2");
        if (name) setValue(name, "Pat");
      });
      await act(async () => { form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });

      const totpButton = [...c.querySelectorAll("button")]
        .find((b) => (b.textContent ?? "").toLowerCase().includes("authenticator")
          || b.className.includes("join-alt"));
      await act(async () => { (totpButton as HTMLButtonElement).click(); });
      for (let i = 0; i < 8; i += 1) await act(async () => { await Promise.resolve(); });

      expect(c.textContent, "the person is not told which account the browser now holds")
        .toContain("b@example.invalid");
      expect(c.textContent, "refusing an authenticator step told them about recovery codes")
        .not.toMatch(/recovery code/i);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});

/**
 * ═══ THE ONE THING ON THIS SCREEN THAT RUNS WITHOUT A PRESS ═══════════════════════════════
 *
 * Round nine's MEDIUM. Every button here asks whose browser this is before it acts. The plan
 * step's access poll did not, and it is the only thing on the wizard that runs by itself —
 * repeatedly, for up to a minute, after a return from checkout. A sign-in in another tab between
 * two ticks and the next one reads that account's standing: if that account may add a mailbox
 * the wizard
 * advances on the strength of it, and if they do not, their plan state is rendered here.
 *
 * Distinct from the disclosed preflight-to-write window, which is the gap between an ask and a
 * write. This had no ask at all.
 */
describe("the plan poll asks whose account it is reading", () => {
  it("stops when the browser changes hands between ticks, and installs nothing", async () => {
    let sessions = 0;
    let accessReads = 0;
    /* A, fully enrolled and verified, and NOT entitled to a mailbox — exactly the state that
       lands the wizard on the plan step and starts the poll. Getting this wrong is how the first
       version of this case passed without the fix: it left `recoveryCodes: false`, the wizard
       stopped at the codes step, the poll effect never ran, and zero reads looked like a refusal. */
    const ready = (id: string, email: string) => ({
      user: {
        userId: `u_${id}`, accountId: id, email, displayName: "Pat", emailVerified: true,
        twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
      },
      scope: "full",
    });
    const priorFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/auth/session")) {
        sessions += 1;
        // The bootstrap sees A. By the poll's own read — the second — the browser is B.
        return json(sessions <= 1 ? ready("acct_A", "a@example.invalid")
                                  : ready("acct_B", "b@example.invalid"));
      }
      if (url.includes("/account/access")) {
        accessReads += 1;
        // NOT entitled — the state that puts this wizard on the plan step, where the poll runs.
        return json({ metered: true, canAddMailbox: false, mailboxes: 0 });
      }
      // The plan step also mints its link; it is not the read under test.
      if (url.includes("/account/manage-link")) return json({ url: "https://account.example/m" });
      if (url.includes("/mailboxes")) return json({ items: [] });
      return json({});
    }) as unknown as typeof globalThis.fetch;

    try {
      const c = await mountJoin();
      /* THE PREMISE, and it has to be the step and not merely "a session was read": the poll
         effect returns immediately unless the wizard is on the plan step. */
      expect(accessReads,
        "the wizard never reached the plan step, so the poll never ran and this proves nothing")
        .toBeGreaterThan(0);
      expect(sessions, "the poll never asked whose account it was reading").toBeGreaterThan(1);
      expect(accessReads,
        "the poll read another account's standing — an entitled one advances this wizard on the strength of somebody else's account")
        .toBe(1);
      expect(c.textContent, "the person is not told which account the browser now holds")
        .toContain("b@example.invalid");
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  /**
   * `?billing=success` MAY MAKE THE WIZARD WAIT. IT MAY NOT MAKE IT BELIEVE.
   *
   * It is a value a stranger can put in a link — `page.tsx` says so where it parses it — and the
   * only thing it is allowed to influence is whether this step keeps asking. What decides
   * whether the account may go on is the SERVER's answer, read every tick.
   *
   * Without this case the poll can be made to advance on the parameter alone and every other
   * test here stays green: measured by doing exactly that, and this is the arm that reddens.
   */
  it("a `billing=success` return never advances the wizard on its own", async () => {
    const priorFetch = globalThis.fetch;
    let accessReads = 0;
    /* FULLY ENROLLED AND VERIFIED, or the wizard stops earlier and the poll never runs — the
       same fixture trap the case above records. `ready` is that case's local, so it is spelled
       out here rather than shared: a session read that THROWS is swallowed by `bootstrap`'s
       catch and looks exactly like a wizard that chose to stop at step one. */
    const enrolled = {
      user: {
        userId: "u_A", accountId: "acct_A", email: "a@example.invalid", displayName: "Pat",
        emailVerified: true,
        twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
      },
      scope: "full",
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/session")) return json(enrolled);
      if (url.includes("/account/access")) {
        accessReads += 1;
        // The server keeps saying no, for the whole bounded wait.
        return json({ metered: true, canAddMailbox: false, mailboxes: 0 });
      }
      if (url.includes("/account/manage-link")) return json({ url: "https://account.example/m" });
      if (url.includes("/mailboxes")) return json({ items: [] });
      return json({});
    }) as unknown as typeof globalThis.fetch;

    try {
      const c = await mountJoin({ billingReturn: "success" });
      expect(accessReads, "the poll never ran, so this proves nothing").toBeGreaterThan(0);
      // STILL ON THE PLAN STEP: the link is on screen, and the mailbox step's own copy is not.
      expect(c.textContent, "a URL parameter advanced the wizard past an unentitled account")
        .toContain(messages.join.planContinue);
      expect(c.textContent).not.toContain(messages.join.step_mailbox_lead);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });

  it("a `billing=success` return with its session id confirms it ONCE, before the first poll", async () => {
    const priorFetch = globalThis.fetch;
    const priorUrl = window.location.href;
    const calls: string[] = [];
    const enrolled = {
      user: {
        userId: "u_A", accountId: "acct_A", email: "a@example.invalid", displayName: "Pat",
        emailVerified: true,
        twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
      },
      scope: "full",
    };
    window.history.replaceState({}, "", "/join?billing=success&session_id=cs_test_Zz9");
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/session")) return json(enrolled);
      if (url.includes("/account/checkout/confirm")) {
        calls.push(`confirm:${String(init?.body)}`);
        return json({ state: "confirmed" });
      }
      if (url.includes("/account/access")) {
        calls.push("access");
        // Not entitled yet, so the wizard sits on the plan step where the poll runs.
        return json({ metered: true, canAddMailbox: false, mailboxes: 0 });
      }
      if (url.includes("/account/manage-link")) return json({ url: "https://account.example/m" });
      if (url.includes("/mailboxes")) return json({ items: [] });
      return json({});
    }) as unknown as typeof globalThis.fetch;

    try {
      await mountJoin({ billingReturn: "success" });
      const confirms = calls.filter((c) => c.startsWith("confirm:"));
      expect(confirms).toEqual([`confirm:${JSON.stringify({ sessionId: "cs_test_Zz9" })}`]);
      expect(calls.indexOf(confirms[0]!), "the confirm runs before the poll reads access")
        .toBeLessThan(calls.lastIndexOf("access"));
    } finally {
      globalThis.fetch = priorFetch;
      window.history.replaceState({}, "", priorUrl);
    }
  });

  /**
   * A NULL MANAGE LINK IS A STATE, NOT A FAILURE — and it is the state managed runs in until
   * the entitlements client is armed, as well as the permanent state of a host that operates no
   * such program. The step says so and offers no remedy it cannot deliver: the account may not
   * add a mailbox (that is why it is here), so "connect one from Settings" would be false.
   */
  it("no account page to link to ⇒ the step says so, offers no false remedy, and keeps the door out", async () => {
    const priorFetch = globalThis.fetch;
    const enrolled = {
      user: {
        userId: "u_A", accountId: "acct_A", email: "a@example.invalid", displayName: "Pat",
        emailVerified: true,
        twofaEnrolled: { webauthn: true, totp: false, recoveryCodes: true },
      },
      scope: "full",
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/session")) return json(enrolled);
      if (url.includes("/account/access")) {
        return json({ metered: true, canAddMailbox: false, mailboxes: 0 });
      }
      // The seam's interim, and a self-hosted install's permanent answer.
      if (url.includes("/account/manage-link")) {
        return new Response(JSON.stringify({ error: { code: "no_manage_surface" } }), {
          status: 404, headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/mailboxes")) return json({ items: [] });
      return json({});
    }) as unknown as typeof globalThis.fetch;

    try {
      const c = await mountJoin();
      const text = c.textContent ?? "";
      expect(text, "the step said nothing about having nowhere to send them")
        .toContain(messages.join.planUnavailable);
      // No link, and no promise the account could not act on.
      expect(text).not.toContain(messages.join.planContinue);
      expect(messages.join.planUnavailable, "the sentence offers a remedy this state forbids")
        .not.toMatch(/connect a mailbox|settings/i);
      // The way out of the funnel stays.
      expect(text).toContain(messages.join.later);
    } finally {
      globalThis.fetch = priorFetch;
    }
  });
});
