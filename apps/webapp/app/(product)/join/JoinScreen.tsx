"use client";

/**
 * ONBOARDING, end to end, over HTTP only.
 *
 * invite code → register → an enrollment session → a passkey (TOTP as the fallback) →
 * recovery codes → choose a plan (Stripe Checkout) → connect a mailbox.
 *
 * ── THE STEP ORDER IS THE SERVER'S, NOT THIS FILE'S ─────────────────────────────────────
 *
 * Most transitions here are ones the API would have enforced anyway:
 *
 *  · `register` mints an ENROLLMENT-scoped session. It can do exactly seven things,
 *    and `/mailboxes` is not one of them — an enrollment session gets 403
 *    `enrollment_incomplete` on it. So "passkey before mailbox" is not a wizard rule this
 *    component could get wrong.
 *  · recovery codes carry BOTH `enrollmentOk` and `stepUp`, independently, so
 *    "codes after the factor" is likewise structural: an enrollment session cannot satisfy
 *    step-up, and the first factor is what exchanges it for a full session that can.
 *  · `POST /mailboxes` is step-up gated and runs the allowance gate inside its own
 *    transaction, so the mailbox step can be refused for four different true reasons and
 *    every one of them arrives as a sentence written by `mailbox-allowance.ts`.
 *
 * **PLAN BEFORE MAILBOX, and this one IS a rule this file has to get right.** It shipped the
 * other way round, and the two steps were a closed loop that nobody could get out of:
 * `POST /mailboxes` runs the allowance gate, which answers 402 `no_subscription` for an account with
 * no `billing_subscriptions` row, while the plan step — the only place `billing.checkout` is
 * ever called — was reachable only AFTER a mailbox existed. Subscribing required a mailbox
 * and a mailbox required subscribing. Every invited user would have hit it on their first
 * attempt, `bootstrap()` re-pinned them to the mailbox step on every reload, and the webapp
 * has no other billing surface to escape to. The API-level test that should have caught it
 * seeded the subscription row the wizard had no way to create — which is why
 * `onboarding-flow.test.ts` now walks THIS order and carries a case that fails if the two
 * are swapped back.
 *
 * `trialing` grants `canAddMailbox` (`packages/db/src/billing.ts`), so the 14-day trial
 * Checkout starts is enough to connect the first mailbox — no card, no charge, no wait. It also
 * carries a fixed grant of AI actions now (`TRIAL_GRANT_CREDITS`), which is why the note under
 * the plan cards renders a number the SERVER sent rather than one written into copy.
 *
 * This component's job is otherwise to ASK for the right thing at the right moment and to
 * display what came back. It never re-derives a refusal (see `api-client.ts`).
 *
 * ── RESUMABILITY ────────────────────────────────────────────────────────────────────────
 *
 * The enrollment session lives ~5 minutes and dies with no way to extend it. A person who
 * walks away mid-onboarding must not be locked out, and they are not: `POST /auth/login`
 * with the same password re-mints an enrollment session for a user with zero factors
 * (the re-entry path). So a stale-session failure routes to sign-in rather than to a
 * dead end, and `bootstrap()` asks `GET /auth/session` on mount so a reload lands on the
 * step the SERVER thinks you are on.
 *
 * `bootstrap()` derives EVERY step from server state, including the codes step:
 * `user.twofaEnrolled.recoveryCodes` is "this user holds at least one unused recovery code",
 * which is the only durable record that the step happened. Without that branch a reload right
 * after the passkey ceremony — the most likely moment to reload, because the platform passkey
 * sheet reads like a navigation — skipped the codes step silently and forever, and the user
 * ended up with one factor and no way back to /join to get a recovery path.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import {
  ApiError, apiConfigured, auth, billing, codeOf, createPasskey, mailboxes,
  messageOf, webauthnAvailable,
  type MailboxDTO, type SubscriptionStatus,
} from "../../api-client";
import { providerById, type ProviderPreset } from "../../shell/providers";
import { displayAddress } from "../../shell/idn";
import { ProviderPicker } from "../../shell/ProviderPicker";

type Step = "invite" | "account" | "sent" | "factor" | "codes" | "verify" | "plan" | "mailbox" | "done";

const PLANS = ["solo", "plus", "pro"] as const;
type Plan = (typeof PLANS)[number];

/**
 * The step order, for the progress rail AND for the wizard. `done` is not a step you stand
 * on; it is what the rail shows as complete.
 *
 * `plan` precedes `mailbox` — see the header. Reordering these two re-creates the deadlock.
 *
 * `invite` drops out of the rail when this deployment does not gate on one. It is not
 * "hidden while still counted" — a five-step rail that reads "step 2 of 6" for the first
 * thing a stranger is asked to do would be describing a journey they are not on.
 *
 * `verify` sits between `codes` and `plan`, which is where `withVerifiedEmail` actually
 * refuses — `POST /billing/checkout` and `POST /mailboxes` are the two gated routes, and both
 * are downstream of here. `sent` and `done` are NOT in the rail: neither is a step somebody
 * stands on and works through. `sent` is a terminal "go and read your mail" screen for the
 * public path, and the journey resumes on a different page (`/verify-email`) in whatever tab
 * the mail was opened in.
 *
 * Most people never see `verify` at all. Anyone who arrived through the public path came in
 * via the verification link, so their address was already proven before they had a session;
 * the step exists for the two populations that can hold a session with an unproven address —
 * somebody whose verification mail failed to send and who signed in with the re-entry path,
 * and an account opened with an operator bootstrap code.
 */
const RAIL: Step[] = ["invite", "account", "factor", "codes", "verify", "plan", "mailbox"];
const RAIL_OPEN: Step[] = RAIL.filter((s) => s !== "invite");

/**
 * How long to wait for Stripe's `checkout.session.completed` webhook after Checkout returns.
 *
 * The subscription row is written by the WEBHOOK, not by the redirect, so a user coming back
 * from a successful Checkout can beat their own subscription to /join by a second or two.
 * Without this the plan step would render its buttons again and a second Checkout would 409.
 * Bounded and then given up on: if the webhook is genuinely late the user is told to reload,
 * which is true, rather than spun forever.
 */
const BILLING_POLL_ATTEMPTS = 10;
const BILLING_POLL_MS = 1_500;

export function JoinScreen({ initialCode, billingReturn, publicSignup = false }: {
  initialCode: string;
  /** `?billing=success|cancelled`, the two values Stripe Checkout redirects back with. */
  billingReturn?: "success" | "cancelled";
  /**
   * Does this deployment let a stranger open an account (`TF_PUBLIC_SIGNUP=1`)?
   *
   * It decides ONE thing: where the wizard starts. Every refusal is still the server's, the
   * invite is still validated in the transaction that creates the account, and a code the
   * visitor chooses to type is still consumed exactly as an invited user's is. Defaults to
   * `false` so a caller that forgets it gets the gated behaviour rather than a screen that
   * promises an account this deployment will not create.
   */
  publicSignup?: boolean;
}) {
  const t = useTranslations("join");

  /**
   * The invite step is part of this journey when the deployment gates on a code.
   *
   * It is STATE, not a prop, because of the one case where the client is wrong: if the
   * webapp is armed for public signup and the API is not (a half-finished deploy), the
   * server answers `validation_failed` for the missing `inviteCode` and the honest response
   * is to show the step rather than to loop on an error the visitor cannot act on. See
   * `submitAccount`.
   */
  const [needsInvite, setNeedsInvite] = useState(!publicSignup);
  const [step, setStep] = useState<Step>(initialCode || publicSignup ? "account" : "invite");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A refusal that is not retryable in place — it needs a different screen. */
  const [fatal, setFatal] = useState<string | null>(null);
  /** Which way OUT that screen offers. `"signIn"` is the original default; the capacity valve added the other. */
  const [fatalAction, setFatalAction] = useState<"signIn" | "waitlist">("signIn");

  // ── The form state, kept across steps so a refusal never loses typed input ────────────
  const [code, setCode] = useState(initialCode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const [totp, setTotp] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [codesSaved, setCodesSaved] = useState(false);
  /** Has this tab asked for another verification link? Copy only; never a claim it landed. */
  const [resent, setResent] = useState(false);

  // `null` until the user chooses — choosing the provider is the mailbox step's primary
  // act, so nothing is pre-answered and the credential fields only appear once it is.
  const [provider, setProvider] = useState<ProviderPreset | null>(null);
  const [mbAddress, setMbAddress] = useState("");
  const [mbUser, setMbUser] = useState("");
  const [mbPass, setMbPass] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [connected, setConnected] = useState<MailboxDTO | null>(null);

  const [sub, setSub] = useState<SubscriptionStatus | null>(null);

  const passkeyPossible = useRef(false);
  useEffect(() => { passkeyPossible.current = webauthnAvailable(); }, []);

  /**
   * SCRUB THE INVITE CODE OUT OF THE URL, once it is in component state.
   *
   * `/join?code=…` is how the invite mail links here, so the live beta credential arrives in
   * the address bar — and stays there: in the visible URL for the whole session, in browser
   * history permanently, in the platform access log for the page request, and in the
   * `Referer` of any same-origin navigation off this page (the /login and / links below).
   * `replaceState` costs nothing and removes all of that except the access-log line, which is
   * already written by the time this runs.
   *
   * The exposure is bounded — the code is single-use and worthless after registration — but
   * "bounded" is not "zero", and a code still sitting in the bar of an abandoned tab on a
   * shared machine is exactly the case where it is not yet spent.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !initialCode) return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("code")) return;
    url.searchParams.delete("code");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [initialCode]);

  /**
   * Resume where the SERVER thinks we are.
   *
   * A reload during onboarding is common (the passkey prompt can feel like a navigation),
   * and guessing from client state would be how a user with a live full session lands back
   * on "create your account". `scope` is the introspection field that exists for exactly
   * this (`GET /auth/session` → `{user, scope}`).
   */
  const bootstrap = useCallback(async () => {
    if (!apiConfigured()) return;
    try {
      const s = await auth.session();
      setEmail(s.user.email);
      setDisplayName(s.user.displayName);
      if (s.scope === "enrollment") { setStep("factor"); return; }

      // A full session and no unused recovery code means the codes step never completed —
      // the ONLY durable trace it leaves. Deliberately `!recoveryCodes` rather than "did we
      // show them in this tab": a reload right after the passkey ceremony is common, and
      // guessing from client state is how a user ends up with one factor and no fallback.
      // The reverse guard matters too — a user who HAS codes is never sent back here,
      // because `POST /auth/2fa/recovery-codes` deletes the previous set on every call and
      // would silently invalidate what they wrote down.
      if (!s.user.twofaEnrolled.recoveryCodes) { setStep("codes"); return; }

      // VERIFY BEFORE PLAN, derived from the server exactly like every other step.
      // `withVerifiedEmail` answers 403 `email_unverified` on both `POST /billing/checkout`
      // and `POST /mailboxes`, so an unproven address cannot get past either of the next two
      // steps and showing them would be offering something the server will refuse. Reading
      // `user.emailVerified` rather than remembering whether this tab sent a mail is the same
      // rule the codes step follows: a reload must land where the SERVER thinks you are.
      if (!s.user.emailVerified) { setStep("verify"); return; }

      // PLAN BEFORE MAILBOX. `POST /mailboxes` is refused with 402 `no_subscription` until
      // this account has a `billing_subscriptions` row, so asking for a mailbox first is
      // asking for something the server will not give.
      const status = await billing.subscription().catch(() => null);
      setSub(status);
      if (!status?.subscription) { setStep("plan"); return; }

      const { items } = await mailboxes.list();
      if (items.length === 0) { setStep("mailbox"); return; }
      setConnected(items[0]!);
      setStep("done");
    } catch {
      // No session at all is the normal first visit; anything else means the server said
      // "not you", and starting over is the only honest response.
    }
  }, []);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  /**
   * Refresh the plan card whenever the plan step is on screen, and — when we have just come
   * back from a successful Checkout — keep asking until the webhook has landed.
   *
   * `checkout.session.completed` is what writes the subscription row, and it races the
   * browser redirect. Polling here is the honest shape: the client cannot know the row exists
   * until the server says so, and pretending otherwise would send the user to the mailbox
   * step to be refused by the allowance gate.
   */
  useEffect(() => {
    if (step !== "plan") return;
    let cancelled = false;
    let attempts = 0;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      const status = await billing.subscription().catch(() => null);
      if (cancelled) return;
      setSub(status);
      if (status?.subscription) { setStep("mailbox"); return; }
      if (billingReturn !== "success" || ++attempts >= BILLING_POLL_ATTEMPTS) {
        if (billingReturn === "success") setError(t("planPending"));
        return;
      }
      setTimeout(() => { void tick(); }, BILLING_POLL_MS);
    };

    void tick();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, billingReturn]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      const code = codeOf(err);
      // `enrollment_incomplete` / `unauthorized` mean the 5-minute enrollment session is
      // gone. That is not an error to retry in place — the remedy is the re-entry path.
      if (code === "enrollment_incomplete" || (err instanceof ApiError && err.status === 401)) {
        // The gated copy ends "your invite is already used, so you will not need it
        // again", which is a fact about an invite. Somebody who signed up openly never had
        // one, and telling them theirs is spent is a small lie in the one message whose
        // whole job is to explain what just happened.
        setFatal(t(needsInvite ? "expired" : "expiredOpen"));
        setFatalAction("signIn");
      } else if (code === "step_up_required") {
        // The step-up window (5 minutes since the last second factor) closed while the user
        // was off fetching an app password from their provider — which realistically takes
        // longer than that. There is no way to re-assert a factor on a live session today, so
        // the honest remedy is a fresh sign-in; what must NOT happen is what happened before,
        // which was the server's raw sentence rendered inline with no control on it and no
        // explanation of what to do next.
        setFatal(t("stepUpExpired"));
        setFatalAction("signIn");
      } else if (code === "signup_capacity") {
        // The capacity valve. This is the ONE refusal the wizard cannot retry its way
        // out of, and the remedy is a different surface: the waitlist, which is exactly what
        // it is for once it stops being the front door. The server's sentence is shown
        // verbatim above the control, as everywhere else here.
        setFatal(messageOf(err));
        setFatalAction("waitlist");
      } else if (code === "validation_failed" && !needsInvite) {
        // The deploy-skew case, and the reason `needsInvite` is state.
        //
        // This webapp is armed for public signup and the API is not: the only field the
        // account form can be missing is `inviteCode`, so the honest response is to ask for
        // one rather than to re-show a form the visitor has already filled in correctly. It
        // is deliberately not a silent retry — the step appears, with its own copy, and the
        // typed email and name are still there.
        setNeedsInvite(true);
        setStep("invite");
        setError(t("inviteRequiredAfterAll"));
      } else if (code === "no_subscription") {
        // The allowance gate refused because there is no plan. With the corrected step order this is only
        // reachable when Checkout's webhook has not landed, or when a subscription lapsed
        // mid-onboarding — either way the remedy is the plan step, not an inline error.
        setStep("plan");
        setError(messageOf(err));
      } else {
        setError(messageOf(err));
      }
    } finally {
      setBusy(false);
    }
  };

  // ── Step handlers ─────────────────────────────────────────────────────────────────────

  const submitInvite = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.trim().length === 0) { setError(t("inviteMissing")); return; }
    setError(null);
    setStep("account");
  };

  const submitAccount = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      // The invite is validated by the SERVER, inside the transaction that creates the
      // account. There is no client-side pre-check, deliberately: a code this component
      // considered valid and the server refused would be two sources of truth about the
      // one thing standing between a stranger and an account.
      //
      // The field is OMITTED when empty rather than sent as `""`. The two are the same
      // to the server today, but "no code offered" and "an empty code" are different facts
      // and only one of them is what an open signup means.
      const offered = code.trim();
      const out = await auth.register({
        email: email.trim(), password, displayName: displayName.trim(),
        ...(offered.length > 0 ? { inviteCode: offered } : {}),
      });
      setPassword("");
      // TWO OUTCOMES, and the wizard must not try to tell them apart beyond this.
      //
      // The PUBLIC path answers `{status:"ok"}` with no session, byte-identically whether or not
      // that address already had an account. There is nothing to continue with in this tab, so
      // the honest next screen is "we sent you a mail" — and its copy says exactly that and no
      // more. Claiming "your account is ready" would be false for half the callers and would
      // also re-open the oracle in the UI, since the wizard would be asserting something the
      // response deliberately does not say.
      //
      // The INVITE path still returns an enrollment session and still goes straight to the
      // passkey step, unchanged from the first build of this wizard.
      if (out.status === "ok") { setStep("sent"); return; }
      setStep("factor");
    });
  };

  const enrollPasskey = () => void run(async () => {
    const { options } = await auth.webauthnRegisterOptions();
    const credential = await createPasskey(options);
    await auth.webauthnRegisterVerify({ credential, label: deviceLabel() });
    // The response carries the exchanged FULL session in cookies. Nothing to store.
    setStep("codes");
  });

  const startTotp = () => void run(async () => { setTotp(await auth.totpEnroll()); });

  const activateTotp = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await auth.totpActivate({ code: totpCode.trim() });
      setTotpCode("");
      setStep("codes");
    });
  };

  const fetchCodes = () => void run(async () => {
    const { codes } = await auth.recoveryCodes();
    setRecovery(codes);
  });

  /**
   * Ask for another verification link, for the session's own address.
   *
   * `POST /auth/verify-email/resend` takes no recipient (it reads `users.email` off the session),
   * answers `{ok:true}` whatever happened, and is limited per IP and per recipient. So there is
   * nothing to report except that we asked — which is what `resent` says. A "sent!" claim would
   * be a readout of the mail limiter, and the endpoint deliberately does not tell us.
   */
  const resendVerification = () => void run(async () => {
    await auth.resendVerification();
    setResent(true);
  });

  useEffect(() => {
    if (step === "codes" && recovery === null && !busy) fetchCodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const pickProvider = (id: string) => {
    const p = providerById(id);
    setProvider(p);
    setImapHost(p.imap.host);
    setSmtpHost(p.smtp.host);
  };

  const submitMailbox = (e: React.FormEvent) => {
    e.preventDefault();
    // The credential fields (and with them this form's submit) only render once a
    // provider is chosen, so this guard is structural rather than reachable.
    const chosen = provider;
    if (!chosen) return;
    void run(async () => {
      const address = mbAddress.trim();
      const dto = await mailboxes.create({
        provider: chosen.id,
        address,
        imap: {
          host: imapHost.trim(),
          // A manual provider sends no port/TLS mode — the server's probe walks the standard
          // ladder (993 implicit TLS, then 143 STARTTLS) and stores what it proved. This screen
          // shows the server's own refusal sentence verbatim, which now names certificates,
          // hosts and suggestions precisely; the richer one-press flows live in Settings.
          ...(chosen.manual ? {} : { port: chosen.imap.port, secure: chosen.imap.secure }),
          user: (mbUser.trim() || address), pass: mbPass,
        },
        smtp: {
          host: smtpHost.trim(),
          ...(chosen.manual ? {} : { port: chosen.smtp.port, secure: chosen.smtp.secure }),
          user: (mbUser.trim() || address), pass: mbPass,
        },
      });
      // The password leaves this component's memory the moment the server has it. It is
      // already envelope-encrypted at rest (RC1) and is never echoed back in the DTO.
      setMbPass("");
      setConnected(dto);
      setStep("done");
    });
  };

  const startCheckout = (plan: Plan) => void run(async () => {
    const { url } = await billing.checkout(plan);
    window.location.assign(url);
  });

  // ── Render ────────────────────────────────────────────────────────────────────────────

  if (!apiConfigured()) {
    return (
      <Shell title={t("unavailableTitle")}>
        <p className="sub">{t("unavailableBody")}</p>
        <div className="join-actions">
          <Link className="btn primary" href="/?demo=1">{t("openDemo")}</Link>
        </div>
      </Shell>
    );
  }

  if (fatal) {
    // The fatal screen has two exits now, because it has two causes. An expired
    // enrollment session is fixed by signing in; a full deployment is not fixed by anything
    // the visitor can do here, and offering them "sign in" to an account they do not have
    // would be the wizard's one genuinely useless control.
    const capacity = fatalAction === "waitlist";
    return (
      <Shell title={capacity ? t("capacityTitle") : t("expiredTitle")}>
        <p className="sub" role="alert">{fatal}</p>
        <div className="join-actions">
          {capacity ? (
            <Link className="btn primary" href="/#pricing">{t("capacityCta")}</Link>
          ) : (
            <Link className="btn primary" href="/login">{t("signIn")}</Link>
          )}
        </div>
      </Shell>
    );
  }

  return (
    <Shell title={t(`step_${step}_title`)} step={step} rail={needsInvite ? RAIL : RAIL_OPEN}>
      {error && <p className="join-error" role="alert">{error}</p>}

      {step === "invite" && (
        <form onSubmit={submitInvite}>
          {/* Two leads, because the sentence "ohmail is invite-only" is a claim about
              the deployment and it is false on an open one. The step is still reachable
              there (a deploy-skew fallback, and an invited user who prefers to redeem), so
              it needs copy that is true in both. */}
          <p className="sub">{t(publicSignup ? "step_invite_lead_open" : "step_invite_lead")}</p>
          <label className="join-label" htmlFor="join-code">{t("inviteLabel")}</label>
          <input
            id="join-code"
            className="join-input join-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="OHMAIL-XXXX-XXXX-XXXX"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="join-hint">{t("inviteHint")}</p>
          <div className="join-actions">
            <Button variant="primary" type="submit">{t("continue")}</Button>
          </div>
        </form>
      )}

      {step === "account" && (
        <form onSubmit={submitAccount}>
          <p className="sub">{t("step_account_lead")}</p>
          <label className="join-label" htmlFor="join-email">{t("emailLabel")}</label>
          <input
            id="join-email" className="join-input" type="email" autoComplete="email"
            value={email} onChange={(e) => setEmail(e.target.value)} required
          />
          {/* "use the address your invite was sent to" is an instruction to somebody
              holding an invite. On the open path there is no invite and no such address, so
              the hint says what is actually true of the field. */}
          <p className="join-hint">{t(needsInvite ? "emailHint" : "emailHintOpen")}</p>

          <label className="join-label" htmlFor="join-name">{t("nameLabel")}</label>
          <input
            id="join-name" className="join-input" autoComplete="name"
            value={displayName} onChange={(e) => setDisplayName(e.target.value)} required
          />

          <label className="join-label" htmlFor="join-pw">{t("passwordLabel")}</label>
          <input
            id="join-pw" className="join-input" type="password" autoComplete="new-password"
            minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required
          />
          <p className="join-hint">{t("passwordHint")}</p>

          {/* The invite does not disappear when the gate opens, it becomes OPTIONAL.
              An invited person whose mail is buried, or who lost the `?code=` link, must
              still be able to redeem: the code is a real credential with a real expiry and
              a real revocation, and "you can just sign up instead" silently strips whatever
              an operator attached it to. A `<details>` rather than a field, so the open path
              stays a three-input form. */}
          {!needsInvite && (
            <details className="join-invite-opt" open={code.trim().length > 0}>
              <summary>{t("inviteOptional")}</summary>
              <label className="join-label" htmlFor="join-code-opt">{t("inviteLabel")}</label>
              <input
                id="join-code-opt"
                className="join-input join-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="OHMAIL-XXXX-XXXX-XXXX"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="join-hint">{t("inviteOptionalHint")}</p>
            </details>
          )}

          <div className="join-actions">
            {needsInvite && (
              <button type="button" className="join-alt" onClick={() => setStep("invite")}>{t("back")}</button>
            )}
            <Button variant="primary" type="submit" disabled={busy}>
              {busy ? t("working") : t("createAccount")}
            </Button>
          </div>
        </form>
      )}

      {step === "sent" && (
        <>
          {/* THE TERMINAL SCREEN OF THE PUBLIC PATH, and every sentence on it has to be
              true whether or not that address already had an account. It says a mail was sent to
              the address and what to do with it; it does NOT say an account was created, because
              on one of the two branches none was. This is the copy-level half of closing the
              enumeration oracle — a screen reading "your account is ready, check your mail" would
              re-open in the UI exactly what the constant 202 closed on the wire. */}
          <p className="sub">{t("step_sent_lead", { email: email.trim() })}</p>
          <p className="join-note">{t("sentNote")}</p>
          <div className="join-actions">
            <Link className="join-alt" href="/login">{t("signIn")}</Link>
          </div>
        </>
      )}

      {step === "verify" && (
        <>
          {/* Reached only by somebody holding a session on an UNPROVEN address: a signup whose
              verification mail failed to send and who came back through the re-entry login, or an
              account opened with an operator bootstrap code. Anyone who arrived via the mail link
              was already verified before they had a session and never sees this. */}
          <p className="sub">{t("step_verify_lead", { email })}</p>
          <p className="join-note">{t("verifyWhy")}</p>
          <div className="join-actions">
            <Button variant="primary" onClick={resendVerification} disabled={busy || resent}>
              {busy ? t("working") : resent ? t("verifyResent") : t("verifyResend")}
            </Button>
          </div>
          {/* The button does not re-check on its own. `bootstrap()` is the one thing that reads
              `emailVerified`, so "I have done it" re-derives the whole wizard from the server
              rather than this component guessing that the other tab succeeded. */}
          <button type="button" className="join-alt" onClick={() => void bootstrap()} disabled={busy}>
            {t("verifyRecheck")}
          </button>
        </>
      )}

      {step === "factor" && (
        <>
          <p className="sub">{t("step_factor_lead")}</p>
          {!totp ? (
            <>
              <Button variant="primary" icon="shield" onClick={enrollPasskey} disabled={busy}>
                {busy ? t("working") : t("addPasskey")}
              </Button>
              <p className="join-hint">{t("passkeyNote")}</p>
              <button type="button" className="join-alt" onClick={startTotp} disabled={busy}>
                {t("useTotp")}
              </button>
            </>
          ) : (
            <form onSubmit={activateTotp}>
              <p className="join-hint">{t("totpScan")}</p>
              {/* NO QR, and that is the fix rather than the shortcut. What used to be here was
                  `dangerouslySetInnerHTML` over a server-rendered "QR" that was actually the
                  `otpauth://` URI printed as 6px text in a white box — unscannable, and
                  announced to screen readers as "TOTP QR". This is the fallback for people
                  whose device cannot make a passkey, so it is the last place to put a control
                  that does not do what it says. Manual entry works in every authenticator; the
                  link below hands the enrollment straight to the app on the platform where a
                  camera was never going to help. */}
              <p className="join-secret"><code>{totp.secret}</code></p>
              <p className="join-hint">
                <a href={totp.otpauthUrl} rel="noreferrer noopener">{t("totpOpenApp")}</a>
              </p>
              <label className="join-label" htmlFor="join-totp">{t("totpLabel")}</label>
              <input
                id="join-totp" className="join-input join-code" inputMode="numeric"
                autoComplete="one-time-code" maxLength={6}
                value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
              />
              <div className="join-actions">
                <button type="button" className="join-alt" onClick={() => setTotp(null)}>{t("back")}</button>
                <Button variant="primary" type="submit" disabled={busy || totpCode.length !== 6}>
                  {busy ? t("working") : t("activate")}
                </Button>
              </div>
            </form>
          )}
        </>
      )}

      {step === "codes" && (
        <>
          <p className="sub">{t("step_codes_lead")}</p>
          {recovery ? (
            <>
              <ul className="join-codes">
                {recovery.map((c) => <li key={c}><code>{c}</code></li>)}
              </ul>
              <label className="join-check">
                <input type="checkbox" checked={codesSaved} onChange={(e) => setCodesSaved(e.target.checked)} />
                <span>{t("codesConfirm")}</span>
              </label>
              <div className="join-actions">
                <Button variant="primary" disabled={!codesSaved} onClick={() => setStep("plan")}>
                  {t("continue")}
                </Button>
              </div>
            </>
          ) : (
            <p className="join-hint">{t("working")}</p>
          )}
        </>
      )}

      {step === "mailbox" && (
        <form onSubmit={submitMailbox}>
          <p className="sub">{t("step_mailbox_lead")}</p>
          {/* Said BEFORE the trip to the provider's settings, not after. `POST /mailboxes` is
              step-up gated on a second factor used within `stepUpWindowMs` (5 minutes), and
              fetching an app password from Gmail or Microsoft reliably takes longer than that
              — so the honest thing is to warn while the user can still act on it. The refusal
              itself is handled in `run()`; this is what keeps it rare. */}
          <p className="join-note">{t("appPasswordReady")}</p>

          {/* The picker owns the choice, the provider's note and the help link; the
              credential fields below only exist once a provider is chosen, so the step
              opens on its one real question. */}
          <ProviderPicker value={provider?.id ?? null} onChange={pickProvider} />

          {provider && (
            <>
              <label className="join-label" htmlFor="join-mb-address">{t("mailboxAddress")}</label>
              <input
                id="join-mb-address" className="join-input" type="email" autoComplete="off"
                value={mbAddress} onChange={(e) => setMbAddress(e.target.value)} required
              />

              {provider.manual && (
                <>
                  <label className="join-label" htmlFor="join-imap">{t("imapHost")}</label>
                  <input
                    id="join-imap" className="join-input" autoComplete="off"
                    value={imapHost} onChange={(e) => setImapHost(e.target.value)} required
                  />
                  <label className="join-label" htmlFor="join-smtp">{t("smtpHost")}</label>
                  <input
                    id="join-smtp" className="join-input" autoComplete="off"
                    value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} required
                  />
                </>
              )}

              <label className="join-label" htmlFor="join-mb-user">{t("mailboxUser")}</label>
              <input
                id="join-mb-user" className="join-input" autoComplete="off"
                placeholder={mbAddress || t("mailboxUserPlaceholder")}
                value={mbUser} onChange={(e) => setMbUser(e.target.value)}
              />

              <label className="join-label" htmlFor="join-mb-pass">{t("appPasswordLabel")}</label>
              <input
                id="join-mb-pass" className="join-input" type="password" autoComplete="off"
                value={mbPass} onChange={(e) => setMbPass(e.target.value)} required
              />
              <p className="join-hint">{t("appPasswordHint")}</p>

              <div className="join-actions">
                <Button variant="primary" type="submit" disabled={busy}>
                  {busy ? t("working") : t("connectMailbox")}
                </Button>
              </div>
            </>
          )}
        </form>
      )}

      {step === "plan" && (
        <>
          <p className="sub">{t("step_plan_lead")}</p>

          {sub?.subscription ? (
            // Transient: the effect above advances to the mailbox step as soon as it sees a
            // subscription. Rendering the plan buttons again here would offer a second
            // Checkout, which `createCheckout` answers with 409 `subscription_exists`.
            <p className="join-hint">{t("planConfirmed")}</p>
          ) : (
            <>
              {/* The numbers come from the SERVER's plan card (`PLAN_LIMITS` in
                  packages/db), never from copy. The tiers moved from 2/5/10 mailboxes to
                  5/10/50 while this screen was being written, and a hard-coded string is
                  exactly how a signup page ends up advertising a plan the database will
                  not sell. No card yet ⇒ no buttons, rather than plausible wrong ones. */}
              {sub ? (
                <div className="join-plans">
                  {PLANS.map((p) => {
                    const card = sub.plans[p];
                    if (!card) return null;
                    return (
                      <button
                        key={p} type="button" className="join-plan" disabled={busy}
                        onClick={() => startCheckout(p)}
                      >
                        <b>{t(`plan_${p}`)}</b>
                        {/* The price is CONTEXT, the trial is the ACTION. Owner feedback, from
                            signing up for real: "stripe activates the trial, but … make it clear
                            like 'Start Trial' (no creditcard)". A card whose largest text is
                            "$9/mo" reads as a purchase, so the visitor arrives at a Checkout that
                            does not charge them and cannot tell what just happened. `after` says
                            what the number actually is; the action line says what the click does. */}
                        <span className="num">{t("planPrice", { price: card.priceUsd })}</span>
                        <span className="join-plan-after">{t("planAfter")}</span>
                        <span className="join-plan-sub">
                          {t("planSub", {
                            mailboxes: card.mailboxes,
                            credits: card.monthlyCredits.toLocaleString("en-US"),
                          })}
                        </span>
                        <span className="join-plan-go">{t("planStart")}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="join-hint">{t("planLoading")}</p>
              )}
              {/* THE TRIAL CLAIM, and the number in it comes from the SERVER for the same
                  reason the plan cards above do.
                  The row is `status='trialing'` with `trial_period_days: 14`, and it now carries
                  a fixed bounty of AI actions — so the sentence says what the trial can actually
                  do, which is the whole product plus a real number of AI actions, and says that
                  they run out. Typing the figure into copy here is how a signup page ends up
                  advertising an allowance the ledger does not grant; `trialCredits` is that
                  figure, straight from the policy module. Absent (an older server) ⇒ no
                  sentence, rather than a sentence with a hole or a guess in it. */}
              {sub?.trialCredits !== undefined ? (
                <p className="join-note">{t("trialNote", { credits: sub.trialCredits })}</p>
              ) : null}
              <div className="join-actions">
                <Link className="join-alt" href="/">{t("later")}</Link>
              </div>
            </>
          )}
        </>
      )}

      {step === "done" && (
        <>
          <p className="sub">{t("step_done_lead")}</p>
          {/* Readably: the address the person just typed, said back to them. `connected.address`
              itself is the stored A-label form the connect wrote — see `shell/idn.ts`. */}
          {connected && (
            <p className="join-hint">{t("mailboxConnected", { address: displayAddress(connected.address) })}</p>
          )}
          <div className="join-actions">
            <Link className="btn primary" href="/">{t("openOhmail")}</Link>
          </div>
        </>
      )}
    </Shell>
  );
}

function Shell({ title, step, rail = RAIL, children }: {
  title: string; step?: Step; rail?: Step[]; children: React.ReactNode;
}) {
  const t = useTranslations("join");
  return (
    <div className="login">
      <div className="login-card join-card">
        {/* oh | mail, split so `.wordmark em` can carry accent-ink. The rendered
            text is what the suite asserts, not the markup. */}
        <span className="wordmark"><b><em>oh</em>mail</b></span>
        {step && (
          <ol className="join-rail" aria-label={t("progress")}>
            {/* `done` is not IN the rail, so `indexOf` would answer -1 and paint every step
                as "todo" on the one screen where all of them are finished. */}
            {(() => {
              const at = step === "done" ? rail.length : rail.indexOf(step);
              return rail.map((s) => (
                <li key={s} data-state={rail.indexOf(s) < at ? "done" : s === step ? "now" : "todo"}>
                  <span className="join-rail-dot" aria-hidden="true" />
                  <span className="join-rail-label">{t(`rail_${s}`)}</span>
                </li>
              ));
            })()}
          </ol>
        )}
        <h1>{title}</h1>
        {children}
      </div>
      <p className="login-foot">
        <Icon name="shield" /> {t("footer")}
      </p>
    </div>
  );
}

/**
 * A label for the credential in the device list. Deliberately coarse — a browser and a
 * platform, no fingerprint, no version — because this string is stored, shown to the user
 * later, and is not worth turning into an identifier.
 */
function deviceLabel(): string {
  if (typeof navigator === "undefined") return "This browser";
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return os ? `${browser} on ${os}` : browser;
}
