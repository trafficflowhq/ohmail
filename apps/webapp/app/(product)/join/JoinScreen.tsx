"use client";

/**
 * Onboarding, end to end, over HTTP only: invite code → register → an enrollment session → a passkey
 * (TOTP fallback) → recovery codes → choose a plan (Stripe Checkout) → connect a mailbox. Most
 * transitions are the server's own: an enrollment session gets 403 `enrollment_incomplete` on
 * `/mailboxes`, recovery codes carry both `enrollmentOk` and `stepUp`, and `POST /mailboxes` is
 * step-up gated. PLAN BEFORE MAILBOX is the rule this file must get right: shipped the other way the
 * two steps were a closed loop — `POST /mailboxes` answers 402 with no `billing_subscriptions` row
 * while the plan step was reachable only after a mailbox existed — and `onboarding-flow.test.ts`
 * walks THIS order and fails if they are swapped back. The wizard never re-derives a refusal.
 */

/**
 * Resumability: the enrollment session lives ~5 minutes with no way to extend it, and a person who
 * walks away must not be locked out — `POST /auth/login` with the same password re-mints an
 * enrollment session for a user with zero factors (the re-entry path), so a stale-session failure
 * routes to sign-in, and `bootstrap()` asks `GET /auth/session` on mount so a reload lands on the
 * step the server thinks you are on. Every step derives from server state, including codes:
 * `user.twofaEnrolled.recoveryCodes` is the only durable record the step happened — without that
 * branch a reload right after the passkey ceremony skipped the codes step silently and for ever.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import {
  ApiError, account, apiConfigured, auth, codeOf, createPasskey, mailboxes,
  messageOf, webauthnAvailable,
  type MailboxDTO,
} from "../../api-client";
import { hostsFor, providerById, type ProviderPreset } from "../../shell/providers";
import { displayAddress } from "../../shell/idn";
import { ProviderPicker } from "../../shell/ProviderPicker";
import { SELF_HOST_BUILD } from "../../hello";

type Step = "invite" | "account" | "sent" | "factor" | "codes" | "verify" | "plan" | "mailbox" | "done";

/**
 * The step order, for the progress rail AND the wizard; `done` is what the rail shows complete, not
 * a step. `plan` precedes `mailbox` — see the header; reordering the two re-creates the deadlock.
 * `invite` drops out of the rail when the deployment does not gate on one — not hidden-but-counted,
 * because "step 2 of 6" for a stranger's first act describes a journey they are not on. `verify`
 * sits between `codes` and `plan`, where `withVerifiedEmail` actually refuses (billing checkout and
 * `POST /mailboxes`, both downstream). `sent` and `done` are not in the rail; `sent` is a terminal
 * screen and the journey resumes on `/verify-email` in another tab. Most people never see `verify`:
 * it exists for a failed verification mail re-entered by sign-in, and for an operator bootstrap.
 */
const RAIL: Step[] = ["invite", "account", "factor", "codes", "verify", "plan", "mailbox"];

/**
 * The self-host journey has neither `verify` nor `plan`, and both absences are the composition's,
 * not this file's guess: no `plan` because the self-host route table carries no billing ("not
 * refused: not built", `routes/self-host.ts`) and the allowance is composed unmetered — a plan step
 * would poll `GET /billing/subscription` into a 404 for ever, the failure `/hello` negotiation
 * exists to prevent; no `verify` because the operator's account arrives verified (the setup token
 * confers it) and family accounts legitimately arrive unverified on a box with no mailer
 * (`requireVerifiedForProduct: false`, obligation 4) — nothing on the server refuses either next
 * step. `SELF_HOST_BUILD` is compile-time (`app/hello.ts`), so the managed bundle is untouched.
 */
const RAIL_SELF_HOST: Step[] = RAIL.filter((s) => s !== "verify" && s !== "plan");
const RAIL_BASE: Step[] = SELF_HOST_BUILD ? RAIL_SELF_HOST : RAIL;
const RAIL_OPEN: Step[] = RAIL_BASE.filter((s) => s !== "invite");

/**
 * How long to wait for Stripe's `checkout.session.completed` webhook after Checkout returns.
 *
 * The subscription row is written by the WEBHOOK, not by the redirect, so a user coming back
 * from a successful Checkout can beat their own subscription to /join by a second or two.
 * Without this the plan step would render its buttons again and a second Checkout would 409.
 * Bounded and then given up on: if the webhook is genuinely late the user is told to reload,
 * which is true, rather than spun forever.
 */
/** The bounded wait after a return, before the screen says "not yet". */
const ACCESS_POLL_ATTEMPTS = 10;
const ACCESS_POLL_MS = 1_500;

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
  /* `bootstrap` is a `useCallback([])` — its identity drives the mount effect, so a translator
     in its dependency list would re-run it on every render. The ref is the same device
     `remote-images.ts` uses for `onFailed`, and for the same reason. */
  const tRef = useRef(t);
  tRef.current = t;

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
  /**
   * Which account this wizard is for — learned once and NEVER rewritten. A ref, first-write-only:
   * `bootstrap()` used to assign it unconditionally, and it is not only the mount path — the verify
   * step's "I have confirmed it" button calls it again. A wizard that began as A, left open while
   * another tab signed in as B, re-anchored to B on that press; B lacking recovery codes landed on
   * the codes step, whose mount effect generates without another press — B's codes minted in A's
   * window, B's previous set destroyed. The first read wins and every later one is CHECKED against
   * it ({@link sameAccount}). It cannot be a cookie: an enrolment session sets no readable owner
   * marker (`enrollmentCookies` writes none) — only the server knows, asked again.
   */
  const wizardOwner = useRef<string | null>(null);
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


  const passkeyPossible = useRef(false);
  useEffect(() => { passkeyPossible.current = webauthnAvailable(); }, []);

  /**
   * Scrub the invite code out of the URL once it is in component state. `/join?code=…` is how the
   * invite mail links here, so the live beta credential arrives in the address bar — and stays: in
   * the visible URL, in browser history permanently, in the platform access log, and in the
   * `Referer` of any same-origin navigation off this page. `replaceState` removes all of that
   * except the access-log line, already written. The exposure is bounded — single-use, worthless
   * after registration — but a code still in the bar of an abandoned tab on a shared machine is
   * exactly the case where it is not yet spent.
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
      /*
       * ── THE FIRST READ FIXES THE OWNER; A LATER ONE IS COMPARED, NEVER APPLIED ────────────
       *
       * Everything below this line is account-derived — the address on screen, the step, the
       * subscription, the mailbox — so a bootstrap that answers for a different account must
       * not reach any of it. Refusing HERE rather than at each action is what makes the
       * comparison in {@link sameAccount} meaningful: a guard that re-anchors itself to
       * whatever it is shown is not a guard, and this one did.
       */
      if (wizardOwner.current === null) {
        wizardOwner.current = s.user.accountId;
      } else if (wizardOwner.current !== s.user.accountId) {
        setError(tRef.current("accountChanged", { email: s.user.email }));
        return;
      }
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

      // THE SELF-HOST JOURNEY SKIPS VERIFY AND PLAN — see RAIL_SELF_HOST for why both absences
      // are the server composition's own. From codes the next question is the mailbox, asked of
      // the server exactly like the managed path below asks it.
      if (SELF_HOST_BUILD) {
        const { items } = await mailboxes.list();
        if (items.length === 0) { setStep("mailbox"); return; }
        setConnected(items[0]!);
        setStep("done");
        return;
      }

      // VERIFY BEFORE PLAN, derived from the server exactly like every other step.
      // `withVerifiedEmail` answers 403 `email_unverified` on both `POST /billing/checkout`
      // and `POST /mailboxes`, so an unproven address cannot get past either of the next two
      // steps and showing them would be offering something the server will refuse. Reading
      // `user.emailVerified` rather than remembering whether this tab sent a mail is the same
      // rule the codes step follows: a reload must land where the SERVER thinks you are.
      if (!s.user.emailVerified) { setStep("verify"); return; }

      // PLAN BEFORE MAILBOX. `POST /mailboxes` is refused until the account is entitled to
      // one, so asking for a mailbox first is asking for something the server will not give.
      // The port's own verdict is the question — `canAddMailbox`, not a row somewhere.
      const may = await account.access().then((a) => !a.metered || a.canAddMailbox)
        .catch(() => null);
      /* UNREADABLE FAILS OPEN, like every other unknown in this funnel: sending somebody to an
         account page they may not need is worse than letting the mailbox step's own refusal
         speak. `false` is the only answer that routes to the plan step. */
      if (may === false) { setStep("plan"); return; }

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
   * MINT THE LINK to the page that takes the plan, and — while this step is on screen — keep
   * asking whether the account has become entitled.
   *
   * Whatever happens on that page happens at the service operator's end and races the
   * browser's return, so polling is the honest shape: this client cannot know it landed until
   * the port says the account may add a mailbox, and pretending otherwise would send somebody
   * to the mailbox step to be refused by the allowance gate.
   *
   * The poll is BOUNDED and the bound is the whole of what it promises. When it expires the
   * screen says the account is not entitled YET — never that something failed, because nothing
   * here can know that, and never a plan word.
   */
  useEffect(() => {
    if (step !== "plan") return;
    let cancelled = false;
    let attempts = 0;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      /*
       * ── A POLL IS A READ, AND A READ IS AN ACTION HERE ──────────────────────────────────
       *
       * Every button on this wizard asks whose browser this is before it acts. This loop did
       * not, and it is the one thing on the screen that runs WITHOUT a press — repeatedly, for
       * up to a minute, after a return from checkout. A sign-in in another tab between two
       * ticks and the next one reads that account's subscription: if they have one, the line
       * below advances this wizard to the mailbox step on the strength of somebody else's
       * plan; if they do not, their plan state is rendered here.
       *
       * Distinct from the disclosed preflight-to-write window, which is about the gap between
       * an ask and a write. This had no ask at all.
       *
       * A refusal ENDS the loop rather than retrying: `sameAccount` has already put the
       * account-changed sentence on screen, and a poll that kept running behind it would
       * eventually overwrite that with a plan state for whoever is signed in now.
       */
      if (!await sameAccount()) return;
      if (cancelled) return;
      const may = await account.access().then((a) => !a.metered || a.canAddMailbox)
        .catch(() => null);
      if (cancelled) return;
      if (may === true) { setStep("mailbox"); return; }
      /* KEEP POLLING ONLY ON A RETURN. On a first arrival there is nothing in flight to wait
         for, so one read is the whole of it and the screen shows the link. */
      if (billingReturn !== "success" || ++attempts >= ACCESS_POLL_ATTEMPTS) {
        if (billingReturn === "success") setError(t("planPending"));
        return;
      }
      setTimeout(() => { void tick(); }, ACCESS_POLL_MS);
    };

    void tick();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, billingReturn]);

  /**
   * The link to the account page, minted once the plan step is reached.
   *
   * `planLinkFailed` and a `null` link are two states and the screen says different things
   * about them: not asked yet is a spinner, asked and answered nowhere is a sentence. A single
   * nullable would have made "still minting" and "this deployment has no such page" the same
   * screen, which is the one distinction a person on this step needs.
   */
  const [manageUrl, setManageUrl] = useState<string | null>(null);
  const [planLinkFailed, setPlanLinkFailed] = useState(false);
  useEffect(() => {
    if (step !== "plan") return;
    let cancelled = false;
    void account.manageLink()
      .then((link) => {
        if (cancelled) return;
        const u = link?.url;
        if (typeof u === "string" && u.length > 0) setManageUrl(u);
        else setPlanLinkFailed(true);
      })
      .catch(() => { if (!cancelled) setPlanLinkFailed(true); });
    return () => { cancelled = true; };
  }, [step]);

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
      } else if (code === "session_conflict") {
        /*
         * ── THE WINDOW BETWEEN THE ASK AND THE WRITE, CLOSED ON THE SERVER ──────────────────
         *
         * `sameAccount()` asks who this browser holds and then makes the request, and a session
         * that changes between those two is not something this side can see. The server refuses
         * that request outright — a live session and a credential that disagree are a `409
         * session_conflict` — so what is left here is saying so in the same words the preflight
         * uses, rather than rendering the raw sentence of an error the person cannot act on.
         *
         * No email in this one, deliberately: the refusal happened on the server and this client
         * was never told whose session it collided with. Naming an account we did not read would
         * be inventing the most load-bearing word in the sentence.
         */
        setError(t("accountConflict"));
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
      } else if (code === "payment_required") {
        // The allowance gate refused for payment. With the corrected step order this is only
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
      /*
       * THE ACCOUNT THIS WIZARD IS FOR, on the path that actually creates one.
       *
       * `wizardAccount` was assigned only by `bootstrap`, which is the RELOAD path. The ordinary
       * first signup never runs it — its `GET /auth/session` 401s and is caught — so the wizard
       * reached the codes step with `wizardAccount === null` and the comparison below disabled
       * itself. The guard existed and, on the one path everybody takes, was not on.
       */
      // `??=`, not `=`: first-write-only holds on this path as well. A wizard that already knew
      // its account cannot be re-pointed by a registration, and the ordinary signup — whose
      // bootstrap 401s and leaves this null — is where the value comes from.
      wizardOwner.current ??= out.user.accountId;
      setStep("factor");
    });
  };

  const enrollPasskey = () => void run(async () => {
    if (!await sameAccount()) return;
    const { options } = await auth.webauthnRegisterOptions();
    const credential = await createPasskey(options);
    await auth.webauthnRegisterVerify({ credential, label: deviceLabel() });
    // The response carries the exchanged FULL session in cookies. Nothing to store.
    setStep("codes");
  });

  const startTotp = () => void run(async () => {
    if (!await sameAccount()) return;
    setTotp(await auth.totpEnroll());
  });

  const activateTotp = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!await sameAccount()) return;
      await auth.totpActivate({ code: totpCode.trim() });
      setTotpCode("");
      setStep("codes");
    });
  };

  /**
   * ═══ RECOVERY CODES BELONG TO AN ACCOUNT, SO ASK WHICH ONE FIRST ══════════════════════════
   *
   * `POST /auth/2fa/recovery-codes` generates for whatever session the browser holds AT THAT
   * MOMENT, and it DELETES the previous set — so under the wrong session it both hands somebody
   * else's codes to whoever is looking at this screen and destroys the codes that account may
   * already have written down. It is the most consequential button in the wizard.
   *
   * Everything else signed-in is protected by the account boundary in `api-client.ts`, which
   * compares the browser's owner marker against the account the client is bound to. This screen
   * is outside it by construction: an ENROLMENT session sets no marker at all
   * (`enrollmentCookies` writes none), so there is nothing readable to compare and nothing to
   * bind. Absence here is not the "silence" the gate reasons about — it is the normal state of
   * being half signed up.
   *
   * So the question goes to the only party that can answer it. One extra round trip, immediately
   * before the generate, and the answer is compared to the account this wizard started as. A
   * mismatch STOPS: no codes are requested, nothing is deleted, and the screen says which account
   * the browser is signed in as now, because that is the fact the person needs in order to act.
   *
   * Deliberately not a boundary and not a lock: those order writes or refuse them, and neither
   * can tell that the enrolment session under this wizard has been replaced.
   */
  /**
   * ═══ IS THE BROWSER STILL SIGNED IN AS THE ACCOUNT THIS WIZARD IS FOR? ════════════════════
   *
   * Asked immediately before every action that acts on an account, and it FAILS CLOSED: an
   * unknown wizard account refuses rather than waving through, because "we never learned who
   * this is" is not evidence that it is the right one. That was the hole review found — the
   * comparison was written `wizardAccount !== null && …`, and on the ordinary first signup
   * `wizardAccount` was null, so the guard turned itself off on the one path everybody takes.
   *
   * ── WHY EVERY ACTION AND NOT JUST THE CODES ───────────────────────────────────────────────
   *
   * The codes step is the worst of them and it is not the only one. On an enrolment session the
   * server accepts a passkey registration, a TOTP secret and its activation, a verification
   * resend, a mailbox create and a checkout — each for whatever session the browser holds. Under
   * a switched session that is a passkey enrolled on somebody else's account, their authenticator
   * secret on this screen, their mail credentials attached, a plan and a payment customer
 * bound to their account.
   *
   * ── WHY IT CANNOT BE THE ACCOUNT BOUNDARY ─────────────────────────────────────────────────
   *
   * `enrollmentCookies` writes no owner marker, so there is nothing readable for `pendApiOwner`
   * to bind to and nothing for it to compare — `pending` would refuse every request on this
   * screen. The only party that knows is the server, so it is asked. One round trip per action,
   * on a wizard where each action is a deliberate press.
   *
   * WHAT IT DOES NOT CLOSE: the window between this answer and the request that follows it. That
   * needs the server to carry an expected account on the write itself, which is the same thing
   * `AF-RESPONSE-NOT-OWNER-BOUND` is waiting for. Stated rather than implied.
   */
  const sameAccount = async (): Promise<boolean> => {
    const now = await auth.session();
    if (wizardOwner.current !== null && now.user.accountId === wizardOwner.current) return true;
    setError(t("accountChanged", { email: now.user.email }));
    return false;
  };

  const fetchCodes = () => void run(async () => {
    if (!await sameAccount()) return;
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
    if (!await sameAccount()) return;
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
    // The generic entry has no hosts to impose, and writing its emptiness over a typed one is how
    // this form used to lose it — but a NAMED preset's host must never survive into a manual
    // attempt either, so the previous choice goes in too. `providers.ts` carries both reasons.
    setImapHost((cur) => hostsFor(p, { imapHost: cur, smtpHost: "" }, provider).imapHost);
    setSmtpHost((cur) => hostsFor(p, { imapHost: "", smtpHost: cur }, provider).smtpHost);
  };

  const submitMailbox = (e: React.FormEvent) => {
    e.preventDefault();
    // The credential fields (and with them this form's submit) only render once a
    // provider is chosen, so this guard is structural rather than reachable.
    const chosen = provider;
    if (!chosen) return;
    void run(async () => {
      // Mail credentials typed for one account must not be attached to another.
      if (!await sameAccount()) return;
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
    <Shell title={t(`step_${step}_title`)} step={step} rail={needsInvite ? RAIL_BASE : RAIL_OPEN}>
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
                {/* Self-host has no plan to choose — the mailbox is the next real question. */}
                <Button
                  variant="primary" disabled={!codesSaved}
                  onClick={() => setStep(SELF_HOST_BUILD ? "mailbox" : "plan")}
                >
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
          {/* ONE STEP, ONE CONTROL. The plan cards, the prices, the interval toggle and the
              trial figure were all this app quoting a catalogue it does not own; they live on
              the account page the service operator serves, which is also where the card is
              taken. This screen's job is to get the person there and to notice when they come
              back entitled — see `manageUrl` and the poll above.

              `planLoading` while the link is still being minted: a button that goes nowhere is
              the one control a person on this screen will press. */}
          {manageUrl ? (
            <div className="join-actions">
              <a className="btn primary" href={manageUrl}>{t("planContinue")}</a>
              <Link className="join-alt" href="/">{t("later")}</Link>
            </div>
          ) : planLinkFailed ? (
            /* NOWHERE TO SEND THEM, and two different deployments arrive here: one that operates
               no entitlements program at all, and one whose program is reachable but has no
               account page yet. Neither is something a person can act on, and the sentence
               promises no remedy — this step is reached precisely because the account may NOT
               add a mailbox, so telling them to go and connect one would be false. The door out
               stays open. */
            <>
              <p className="join-hint">{t("planUnavailable")}</p>
              <div className="join-actions">
                <Link className="join-alt" href="/">{t("later")}</Link>
              </div>
            </>
          ) : (
            <p className="join-hint">{t("planLoading")}</p>
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
            {/* Into the first-run flow, not into a cold mail client. The funnel proves an address,
             * takes a plan and connects a mailbox; what ohmail is about to DO to that mailbox, how
             * far back it screens, and whether a model should help are asked at `#/first-run` — it
             * opens on the consent statement when a mailbox was connected here and on the mailbox
             * step when not, reading what is stored rather than what this screen thinks happened.
             * Never earlier than this screen on this door: both routes behind the flow's first real
             * act are refused for an unverified address, so opening it earlier is a ceremony whose
             * every button answers 403; reaching `done` means verification is behind us. The
             * FRAGMENT survives the rewrite of `/` to the mail client — it never leaves the
             * browser, the mechanism `/login#/settings` already relies on. */}
            <Link className="btn primary" href="/#/first-run">{t("openOhmail")}</Link>
          </div>
        </>
      )}
    </Shell>
  );
}

function Shell({ title, step, rail = RAIL_BASE, children }: {
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
