/** @vitest-environment jsdom */
/**
 * ═══ /join/invite — THE INVITE OPENED: FRAGMENT-ONLY TOKEN, ONE SUBMIT, HONEST REFUSALS ═════
 *
 * The link from Settings → Invites is `<origin>/join/invite#<token>`. This screen takes the
 * token out of the FRAGMENT, asks email + name + password, and drives redeem → register →
 * `/join` (the wizard resumes at the second-factor step). Four properties are load-bearing:
 *
 *  1. **The token lives in the fragment and nowhere else.** It is read from `location.hash`,
 *     scrubbed from the address bar the moment it is in state, and the ONLY request that
 *     carries it is the redeem's JSON body — no fetch URL ever contains it. The recorded
 *     mutation: sending the redeem as `/pair/redeem?token=…` turns the URL assertion red.
 *  2. **A query-borne token is REFUSED, not accepted-with-a-shrug.** `?token=` renders the
 *     incomplete-link screen — accepting it would put the credential in access logs and
 *     referrers on every open, and the safe shape must not be regressable by convenience.
 *     Recorded mutation: reading `location.search` as a fallback turns this red.
 *  3. **One submit performs redeem THEN register, threading the minted code** — and a register
 *     refusal after a successful redeem keeps the code, so a retry never re-burns a token that
 *     no longer exists (`SetupScreen`'s proven ceremony, inherited).
 *  4. **A spent or expired token gets THIS form's sentence** — the person holding an invite
 *     link knows exactly one human to ask, so the form says that, instead of the service's
 *     anonymous "whoever minted it".
 *
 * The real route (`InviteRoute`: the invite page over its ceremony), the real `api-client`, only `fetch` and the
 * router stubbed, blanks found by the names their labels give them — the
 * setup suite's exact harness.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const replace = vi.fn();
// ONE router object, stable across renders — a per-render mock refires every [router]-dep effect.
const router = { replace, push: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const TOKEN = "invite-and-pair-link-fixture-token";

type Answer = { status: number; body?: unknown };
let answers: Record<string, Answer> = {};
let calls: Array<{ url: string; body: unknown }> = [];
let originalFetch: typeof globalThis.fetch;
let root: Root | null = null;
let host: HTMLDivElement | null = null;

const coded = (status: number, code: string, message: string): Answer => ({
  status,
  body: { error: { code, message } },
});

const REDEEMED: Answer = {
  status: 200,
  body: {
    grant: "invite",
    invite: { code: "OHMAIL-AAAA-BBBB-CCCC", email: "mara@family.example", expiresAt: "2026-01-01T00:00:00.000Z" },
  },
};
const REGISTERED: Answer = {
  status: 201,
  body: {
    user: {
      userId: "u2", email: "mara@family.example", displayName: "Mara",
      emailVerified: false, twofaEnrolled: { webauthn: false, totp: false, recoveryCodes: false },
    },
    scope: "enrollment",
  },
};

beforeEach(() => {
  answers = {};
  calls = [];
  replace.mockClear();
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = Object.entries(answers).find(([path]) => url.includes(path));
    if (!hit) return new Response("{}", { status: 200 });
    const [, a] = hit;
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  globalThis.fetch = originalFetch;
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

async function mountAt(url?: string): Promise<HTMLElement> {
  if (url !== undefined) window.history.replaceState(null, "", url);
  const { InviteRoute } = await import("../app/(product)/join/invite/InviteRoute.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, { locale: "en", messages, timeZone: "UTC", children: h(InviteRoute) }),
    );
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return host;
}

/** A blank, by the name its label gives it. */
function blank(c: HTMLElement, name: string): HTMLInputElement | null {
  const label = [...c.querySelectorAll("label")].find((l) => l.textContent === name);
  return label ? (document.getElementById(label.htmlFor) as HTMLInputElement | null) : null;
}
const W = messages.joinInvite;

async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function fillAndSubmit(c: HTMLElement, email = "mara@family.example"): Promise<void> {
  await type(blank(c, W.emailLabel)!, email);
  await type(blank(c, W.nameLabel)!, "Mara");
  await type(blank(c, W.passwordLabel)!, "correct horse battery staple");
  await act(async () => {
    c.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("the token: fragment in, scrubbed at once, never in any request URL", () => {
  it("a fragment token renders the form and leaves the address bar clean", async () => {
    const c = await mountAt(`/join/invite#${TOKEN}`);
    expect(c.textContent).toContain("You're invited");
    expect(blank(c, W.emailLabel), "the form is up").not.toBeNull();
    // Scrubbed: out of the visible URL, out of an abandoned tab's address bar.
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/join/invite");
    // The page is drawn without the secret: the ceremony holds it, no element or attribute carries it.
    expect(c.innerHTML, "the page carried the link's token").not.toContain(TOKEN);
  });

  it("on reload, asks for the original invitation again and opens it in the same tab", async () => {
    await mountAt(`/join/invite#${TOKEN}`);
    expect(window.location.hash).toBe("");
    expect(JSON.stringify(window.history.state)).not.toContain(TOKEN);
    await act(async () => root!.unmount());
    host?.remove();

    const reloaded = await mountAt();
    expect(reloaded.textContent).toContain("Reopen your invitation");
    expect(reloaded.textContent).not.toContain("This link is incomplete");
    expect(blank(reloaded, W.emailLabel)).toBeNull();

    await act(async () => {
      const hashChanged = new Promise<void>((resolve) =>
        window.addEventListener("hashchange", () => resolve(), { once: true }),
      );
      window.location.hash = TOKEN;
      await hashChanged;
    });
    expect(blank(reloaded, W.emailLabel)).not.toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("the token rides ONLY the redeem's JSON body — no fetch URL ever carries it", async () => {
    answers["/api/pair/redeem"] = REDEEMED;
    answers["/api/auth/register"] = REGISTERED;
    const c = await mountAt(`/join/invite#${TOKEN}`);
    await fillAndSubmit(c);

    const redeem = calls.find((r) => r.url.includes("/api/pair/redeem"));
    expect(redeem, "the redeem left").toBeTruthy();
    expect(redeem!.body).toMatchObject({ grant: "invite", token: TOKEN, email: "mara@family.example" });
    // THE FRAGMENT ASSERTION — the mutation that moves the token into a query string cannot
    // pass this: a URL is what access logs and referrers retain, and none may hold the secret.
    for (const r of calls) {
      expect(r.url, "a fetch URL carried the pairing token").not.toContain(TOKEN);
    }
  });

  it("a QUERY-borne token is refused — the incomplete-link screen, no form", async () => {
    const c = await mountAt(`/join/invite?token=${TOKEN}`);
    expect(blank(c, W.emailLabel), "no form for a token in the query").toBeNull();
    expect(c.textContent).toContain("This link is incomplete");
  });

  it("no token at all is the same honest screen", async () => {
    const c = await mountAt("/join/invite");
    expect(blank(c, W.emailLabel)).toBeNull();
    expect(c.textContent).toContain("This link is incomplete");
  });
});

describe("Strict Mode — the scrub must not eat the token on the replayed mount", () => {
  it("a fragment link still renders the form under a double-invoked mount effect", async () => {
    // React 18 Strict Mode replays the mount effect. The first pass reads the hash and
    // scrubs it; a replay that re-reads `location.hash` finds nothing and overwrites the
    // phase with the incomplete-link screen — every valid invite link broken under
    // `pnpm dev`. Review finding, fixed red-first: the token is captured once, in a ref
    // the replay re-reads.
    window.history.replaceState(null, "", `/join/invite#${TOKEN}`);
    const { InviteRoute } = await import("../app/(product)/join/invite/InviteRoute.js");
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        h(NextIntlClientProvider, {
          locale: "en", messages, timeZone: "UTC",
          children: h(React.StrictMode, null, h(InviteRoute)),
        }),
      );
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(blank(host, W.emailLabel), "the form survives the replay").not.toBeNull();
    expect(host.textContent).not.toContain("This link is incomplete");
    expect(window.location.hash).toBe("");
  });
});

describe("the ceremony — one submit drives redeem, then register with the minted code", () => {
  it("happy path: redeem binds the email, register carries the minted code, and the wizard resumes at /join", async () => {
    answers["/api/pair/redeem"] = REDEEMED;
    answers["/api/auth/register"] = REGISTERED;
    const c = await mountAt(`/join/invite#${TOKEN}`);
    await fillAndSubmit(c);

    const register = calls.find((r) => r.url.includes("/api/auth/register"));
    expect(register, "the register left").toBeTruthy();
    expect(register!.body).toMatchObject({
      email: "mara@family.example", displayName: "Mara", inviteCode: "OHMAIL-AAAA-BBBB-CCCC",
    });
    expect(calls.findIndex((r) => r.url.includes("/pair/redeem")))
      .toBeLessThan(calls.findIndex((r) => r.url.includes("/auth/register")));
    expect(replace).toHaveBeenCalledWith("/join");
  });

  it("a spent or expired token gets THIS form's sentence — the person who invited you, not 'whoever minted it'", async () => {
    answers["/api/pair/redeem"] = coded(400, "pairing_invalid",
      "That pairing token is not valid. Ask whoever minted it for a fresh one.");
    const c = await mountAt(`/join/invite#${TOKEN}`);
    await fillAndSubmit(c);

    const alert = c.querySelector('[role="alert"]');
    expect(alert, "the refusal must be said, not crashed on").not.toBeNull();
    expect(alert!.textContent).not.toContain("whoever minted it");
    expect(alert!.textContent).toContain("person who invited you");
    // No register rode behind the failed redeem, and the form survives for a fresh link.
    expect(calls.some((r) => r.url.includes("/auth/register"))).toBe(false);
    expect(blank(c, W.emailLabel)).not.toBeNull();
  });

  it("a register refusal AFTER a successful redeem keeps the minted code — the retry never re-burns the token", async () => {
    answers["/api/pair/redeem"] = REDEEMED;
    answers["/api/auth/register"] = coded(400, "validation_failed", "password must be at least 12 characters");
    const c = await mountAt(`/join/invite#${TOKEN}`);
    await fillAndSubmit(c);
    expect(c.querySelector('[role="alert"]')!.textContent).toContain("password");

    answers["/api/auth/register"] = REGISTERED;
    await type(blank(c, W.passwordLabel)!, "a much longer correct password");
    await act(async () => {
      c.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(calls.filter((r) => r.url.includes("/pair/redeem")), "one redeem, ever").toHaveLength(1);
    const registers = calls.filter((r) => r.url.includes("/auth/register"));
    expect(registers).toHaveLength(2);
    expect((registers[1]!.body as { inviteCode?: string }).inviteCode).toBe("OHMAIL-AAAA-BBBB-CCCC");
    expect(replace).toHaveBeenCalledWith("/join");
  });

  it("a retry that only changes the address's CASE re-uses the minted code — the server normalized it anyway", async () => {
    // The redeem answers the server's NORMALIZED recipient (trimmed, lowercased). A raw
    // string compare against what the person re-typed reports "spent for a different
    // address" over a capital letter, refusing a retry the server would accept. Review
    // finding, fixed red-first: compare normalized, store the server's own address.
    answers["/api/pair/redeem"] = REDEEMED;
    answers["/api/auth/register"] = coded(400, "validation_failed", "password must be at least 12 characters");
    const c = await mountAt(`/join/invite#${TOKEN}`);
    await fillAndSubmit(c);
    expect(c.querySelector('[role="alert"]')!.textContent).toContain("password");

    answers["/api/auth/register"] = REGISTERED;
    await type(blank(c, W.passwordLabel)!, "a much longer correct password");
    await fillAndSubmit(c, "Mara@Family.example"); // same address, different case

    expect(calls.filter((r) => r.url.includes("/pair/redeem")), "one redeem, ever").toHaveLength(1);
    const registers = calls.filter((r) => r.url.includes("/auth/register"));
    expect(registers, "the register was retried with the kept code").toHaveLength(2);
    expect((registers[1]!.body as { inviteCode?: string }).inviteCode).toBe("OHMAIL-AAAA-BBBB-CCCC");
    expect(replace).toHaveBeenCalledWith("/join");
  });

  it("changing the address after the token is spent is refused with the true remedy", async () => {
    answers["/api/pair/redeem"] = REDEEMED;
    answers["/api/auth/register"] = coded(400, "validation_failed", "password must be at least 12 characters");
    const c = await mountAt(`/join/invite#${TOKEN}`);
    await fillAndSubmit(c);

    // Second attempt with a DIFFERENT address: the invite is bound to the first one and the
    // token is spent — re-redeeming cannot work, so the form says what actually helps.
    await fillAndSubmit(c, "other@family.example");
    const alert = c.querySelector('[role="alert"]');
    expect(alert!.textContent).toContain("mara@family.example");
    expect(calls.filter((r) => r.url.includes("/pair/redeem"))).toHaveLength(1);
  });
});
