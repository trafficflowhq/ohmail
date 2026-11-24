import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { config as middlewareConfig } from "../middleware.js";
import { OWN_PATHS } from "../next.config.mjs";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, replace() {} }) }));

/**
 * Stage-2 the webapp half of email verification.
 *
 * Every claim here fails SILENTLY if it regresses, which is the only reason a source-reading
 * test earns its place:
 *
 *  1. **The `/verify-email` page is wired into the origin's route tables.** Missing from the
 *     middleware matcher it loses the nonce CSP and the two §7b headers; missing from
 *     `OWN_PATHS` it is a path the split no longer accounts for. Neither breaks a build.
 *  2. **The §7b duties are actually discharged.** `Referrer-Policy: no-referrer` and the
 *     `replaceState` scrub are the price §7b charged for keeping a credential in a query
 *     string. A missing header is invisible until somebody reads a proxy log.
 *  3. **The screen does not auto-submit the token.** This is the security property of the whole
 *     slice at the UI layer: an auto-POST on mount is the account pre-hijack that
 *     `AuthService.verifyEmail`'s password binding exists to prevent, and it is EXACTLY the
 *     "simplification" a future reader will be tempted by.
 *  4. **The copy tells the truth about a constant response.** The post-register screen must not
 *     claim an account was created, because on one of the two branches none was — that claim
 *     would re-open in the UI the oracle the 202 closed on the wire.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

const MESSAGES = JSON.parse(read("../messages/en.json")) as {
  join: Record<string, string>;
  verify: Record<string, string>;
  signup: Record<string, string>;
  ai: Record<string, string>;
  data: Record<string, string>;
  faq: Record<string, string>;
  trial: Record<string, string>;
  pricing: Record<string, string>;
};

describe("`/verify-email` is wired into the origin", () => {
  it("is in the middleware matcher AND in OWN_PATHS", () => {
    expect(middlewareConfig.matcher).toContain("/verify-email");
    expect(OWN_PATHS).toContain("/verify-email");
  });

  it("the page exists and reads its token from the query string only", () => {
    const page = read("../app/(product)/verify-email/page.tsx");
    expect(page).toMatch(/searchParams\?\.token/);
    // A repeated parameter arrives as an array; the FIRST wins, like `/join`'s `?code=`.
    expect(page).toMatch(/Array\.isArray/);
    // Bounded, so an unbounded query parameter cannot make us hash a megabyte.
    expect(page).toMatch(/\.slice\(0,\s*512\)/);
  });

  it("it is NOT proxied to the API — the verification page is served by this app", () => {
    // `/api/:path*` would not match `/verify-email` today, but the reason it must never be
    // proxied is worth pinning: the page is ours, and the token must reach the API in a POST
    // body from our own script rather than in a URL the proxy forwards.
    expect(OWN_PATHS.filter((p: string) => p === "/verify-email")).toHaveLength(1);
  });
});

describe("the credential-page duties are discharged, not merely promised", () => {
  const mw = read("../middleware.ts");

  it("`Referrer-Policy: no-referrer` is set on every page that takes a credential", () => {
    // The app-wide default is `strict-origin-when-cross-origin`, which strips the path only
    // CROSS-origin — and under that change the API is the SAME origin, so the default would let a
    // `?token=` ride in the `Referer` of the page's own `/api/*` calls.
    expect(mw).toMatch(/Referrer-Policy["'\s,]+.*no-referrer/);
    expect(mw).toMatch(/credentialPage/);
    // All three credential pages route through the same helper, so none can be forgotten.
    for (const path of ["/login", "/join", "/verify-email"]) {
      expect(mw, `${path} must be served by credentialPage`).toContain(`"${path}"`);
    }
  });

  it("`Cache-Control: no-store` is set on them too", () => {
    // A disk or shared cache holding `/verify-email?token=…` is a credential at rest that
    // nobody chose to store.
    const helper = mw.slice(mw.indexOf("function credentialPage"));
    expect(helper).toMatch(/Cache-Control["'\s,]+.*no-store/);
  });

  it("the token is scrubbed out of the address bar on load", () => {
    const screen = read("../app/(product)/verify-email/use-verify-door.ts");
    expect(screen).toMatch(/history\.replaceState/);
    expect(screen).toMatch(/searchParams\.delete\("token"\)/);
  });

  it("the page the server draws carries no part of the link's code: the ceremony holds it", async () => {
    process.env.NEXT_PUBLIC_API_BASE = "/api";
    const React = await import("react");
    const { renderToString } = await import("react-dom/server");
    const { NextIntlClientProvider } = await import("next-intl");
    const { VerifyRoute } = await import("../app/(product)/verify-email/VerifyRoute");
    const code = ["link", "code", "a1b2c3d4"].join("-");
    const html = renderToString(React.createElement(NextIntlClientProvider, {
      locale: "en", messages: MESSAGES, timeZone: "UTC",
      children: React.createElement(VerifyRoute, { initialToken: code }),
    }));
    expect(html, "the form was not drawn").toContain(MESSAGES.verify.passwordLabel);
    expect(html, "the page carried the link's code").not.toContain(code);
  });
});

describe("the screen never verifies on a token alone", () => {
  /* The ceremony moved into its hook; the doors' page draws the form over it. */
  const screen = read("../app/(product)/verify-email/use-verify-door.ts") + read("../../../packages/app/src/doors/verify/VerifyPage.tsx");

  it("there is a password field, and it is REQUIRED", () => {
    expect(screen).toMatch(/type="password"/);
    // `verifyEmail` is only ever called with both halves.
    expect(screen).toMatch(/auth\.verifyEmail\(\{\s*token:[^}]*password\s*\}\)/s);
  });

  it("IT DOES NOT AUTO-SUBMIT ON MOUNT — the pre-hijack guard at the UI layer", () => {
    // The one regression this file exists for. An `useEffect` that calls `verifyEmail` would
    // re-create the takeover chain even with the server-side password check intact, because the
    // page would have to obtain the password from somewhere it does not have it — or, worse, a
    // future edit would drop the field and the server check with it. Verification is only ever
    // reachable from a form submit.
    const submits = screen.match(/auth\.verifyEmail\(/g) ?? [];
    expect(submits, "verifyEmail must be called exactly once, from the submit handler")
      .toHaveLength(1);
    // The call site is inside `submit`, not inside any effect.
    const effects = screen.match(/useEffect\([\s\S]*?\n  \}, \[/g) ?? [];
    for (const effect of effects) {
      expect(effect, "an effect must not verify").not.toMatch(/verifyEmail/);
    }
  });

  it("the password hint explains WHY it is being asked for", () => {
    // Asking for a password on a link somebody clicked from an email looks, at a glance, exactly
    // like a phishing page. Explaining it is not decoration — it is what makes the honest flow
    // distinguishable from the dishonest one.
    expect(MESSAGES.verify.line).toMatch(/only you/i);
    expect(MESSAGES.verify.line).toContain("We ask for it here so that only you can confirm this address.");
  });
});

describe("the copy is true under a CONSTANT register response", () => {
  it("the post-register screen never claims an account was created", () => {
    // The branch this screen is shown for may have created nothing (the address was already
    // registered). Every sentence has to hold either way, so none of them may assert a creation.
    const sent = `${MESSAGES.join.openLink} ${MESSAGES.join.sentContinuing}`;
    for (const forbidden of [
      /your account (is|has been) (ready|created)/i,
      /we (have )?created your account/i,
      /account created/i,
      /welcome to ohmail/i,
    ]) {
      expect(sent, `"${forbidden}" would re-open the oracle in the UI`).not.toMatch(forbidden);
    }
    // What it DOES say: a mail went to the address, and what to do with it.
    expect(MESSAGES.join.openLink).toMatch(/\{email\}/);
    expect(MESSAGES.join.openLink).toMatch(/link/i);
  });

  it("the waitlist success copy states the confirmation, now that the mailer is armed", () => {
    // It was deliberately hedged while `MAIL_FROM` was unset and nothing could send
    // (`Signup.tsx`'s header records why). With the mailer armed the hedge is UNDERSTATED, so
    // the old wording is forbidden and the new one has to be definite.
    expect(MESSAGES.signup.successBody).not.toMatch(/if a confirmation arrives/i);
    expect(MESSAGES.signup.successBody).toMatch(/confirmation is on its way/i);
    // …and it still promises nothing else on a schedule.
    expect(MESSAGES.signup.successBody).toMatch(/nothing else/i);
  });

  it("the verify step explains what the address is FOR, not just that we want it", () => {
    expect(MESSAGES.join.step_verify_lead).toMatch(/plan|mailbox/i);
    expect(MESSAGES.join.verifyWhy).toMatch(/recovery codes|passkey/i);
  });

  it("nothing in the new copy promises mail we do not send", () => {
    // The §1 set is closed and none of it is marketing, a receipt, or a password reset.
    const added = [
      ...Object.values(MESSAGES.verify),
      MESSAGES.join.openLink, MESSAGES.join.sentContinuing,
      MESSAGES.join.step_verify_lead, MESSAGES.join.verifyWhy,
      MESSAGES.signup.successBody,
    ].join(" ");
    for (const forbidden of [/reset your password/i, /newsletter/i, /receipt/i, /invoice/i]) {
      expect(added).not.toMatch(forbidden);
    }
  });

  it("THE AI-STATUS KEYS ARE UNTOUCHED — another change owns them, byte for byte", () => {
    // The concurrent AI slice updates these only after observing a real model call succeed in
    // production, so editing them from a verification slice would be two changes writing opposite
    // futures into one file.
    //
    // Asserted against the values as COMMITTED rather than against a wording pattern. The first
    // version of this case forbade `/verif/i` in each value and was a false positive on
    // `data.aiBody` — which is the lesson: a proxy for "unchanged" is a test of something else.
    // `git show HEAD:` is the actual claim, and it needs no maintenance when a change legitimately
    // edits one (the diff then belongs to that change's commit, not to a stale literal in here).
    const committed = JSON.parse(
      execFileSync("git", ["show", "HEAD:apps/webapp/messages/en.json"], {
        cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      }),
    ) as Record<string, Record<string, string>>;
    const now = MESSAGES as unknown as Record<string, Record<string, string>>;

    /**
     * ── FOUR KEYS LEFT THIS LIST WHEN THE TRIAL GAINED A CREDIT ALLOWANCE ──────────────────
     *
     * `faq.a7`, `trial.terms`, `pricing.trialNote` and `join.trialNote` were frozen here because
     * they described what the trial does with managed AI, and at the time the answer was
     * "nothing" — so "unchanged since HEAD" and "true" were the same sentence.
     *
     * They are not the same sentence any more. The trial now carries a fixed grant, which made
     * all four FALSE, and a freeze cannot tell a slice that must not touch them from the slice
     * whose job is to correct them. So they moved to a guard that states the property instead of
     * the bytes: a separate test held each of those four states
     * the figure the ledger actually grants, and that none still carries its retired claim. That
     * is strictly stronger than a freeze — a freeze would have let them go stale silently the day
     * the granted figure changed.
     *
     * What stays frozen is what this case was written for: the AI-STATUS copy, which is edited
     * only after somebody has watched a real model call succeed.
     */
    // `data.aiBody` became `data.aiNote` in the 2026-08-27 tier rework (the data section's
    // three-tier layout); the sentence's claims — Anthropic under commercial terms, ~30-day
    // retention, no zero-retention agreement yet, credential stripping — moved with it and
    // are additionally pinned by landing-mailbox-truth.test.ts, so the freeze follows the key.
    for (const [group, key] of [
      ["ai", "status"], ["data", "aiNote"], ["faq", "a3"], ["pricing", "cloudShared"],
    ] as const) {
      expect(committed[group]?.[key], `${group}.${key} must exist at HEAD`).toBeTruthy();
      expect(now[group]![key], `${group}.${key} is owned elsewhere and must not change here`)
        .toBe(committed[group]![key]);
    }
  });
});
