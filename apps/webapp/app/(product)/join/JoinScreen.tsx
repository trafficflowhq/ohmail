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
import { useLocale, useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import {
  ApiError, account, apiConfigured, auth, codeOf, createPasskey, mailboxes,
  messageOf, webauthnAvailable,
  type MailboxDTO,
} from "../../api-client";
import { displayAddress } from "../../shell/idn";
import { QrCode } from "../../shell/QrCode";
import { addressSuggestion } from "./address-hint";
import { useRefusalAtThePress } from "../../shell/refusal-at-the-press";
import { SELF_HOST_BUILD } from "../../hello";
import { JOIN_INVITE_KEY, signupPosture } from "../../invite-posture";
import { confirmAccountReturn } from "../../account-return";
import { PLAN_NAMES, forgetPlanHint, recalledPlanHint, rememberPlanHint, type PlanHint } from "../../plan-hint";
import { readOwnerMarker } from "../../shell/owner-cookie";
import { PendingSignOutSaid, usePendingSignOut } from "../login/pending-sign-out";
import { registerRefusal, totpRefusal } from "./signup-refusals";
import { MailboxStep, useMailboxForm } from "./MailboxStep";

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
/** The wizard's own verify step (a failed mail, re-entered by sign-in) comes after the codes, in `RAIL` order. */
const RAIL_OPEN_LATE_VERIFY: Step[] = RAIL_BASE.filter((s) => s !== "invite");
/**
 * THE OPEN PATH PROVES THE ADDRESS FIRST: the mail is sent from the account step and its link is
 * opened before any factor, so Email is the second station there. Self-host has no Email station.
 */
const RAIL_OPEN: Step[] = SELF_HOST_BUILD
  ? RAIL_OPEN_LATE_VERIFY
  : ["account", "verify", "factor", "codes", "plan", "mailbox"];

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

export function JoinScreen({ initialCode, billingReturn, publicSignup = false, planHint, signedIn = false }: {
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
  /** `?plan` and `?interval` from the site's tier buttons, already read from their closed sets (`page.tsx`). */
  planHint?: PlanHint;
  /** The request carried an owner marker naming an account (`page.tsx`, read on the server so the first paint agrees). */
  signedIn?: boolean;
}) {
  const t = useTranslations("join");
  const to = useTranslations("onboarding");
  const lang = useLocale() === "de" ? "de" : "en";

  /**
   * THE PLAN CHOSEN ON THE SITE. The verification link comes back to `/join` without the query, so a hint
   * that arrives in the URL is kept in this browser and recalled when it does not (read in an effect: the
   * server render has no storage). It names the choice on the plan step and preselects it on the account
   * page; it is forgotten once the trial starts.
   */
  const [hint, setHint] = useState<PlanHint>(planHint ?? {});
  useEffect(() => {
    if (planHint?.plan || planHint?.interval) rememberPlanHint(planHint);
    else setHint(recalledPlanHint());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planHint?.plan, planHint?.interval]);
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
  /** Until the first bootstrap settles a signed-in account's step is unknown, and it must not see the sign-up form. */
  const [resolving, setResolving] = useState(signedIn);
  /** The session or a step read failed with something other than "no session". */
  const [unreachable, setUnreachable] = useState(false);

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

  /** The mailbox step's form (`MailboxStep.tsx`), held here for the same reason. */
  const mailboxForm = useMailboxForm();
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
   * The Checkout return's `?session_id=`, the same way and at mount: whatever step the wizard lands on
   * (an account already entitled goes straight to the mailbox step), it leaves the address bar. The
   * query as it arrived is kept here for the confirm the plan step's poll sends.
   */
  const returnSearch = useRef("");
  useEffect(() => {
    if (billingReturn !== "success" || typeof window === "undefined") return;
    returnSearch.current = window.location.search;
    scrubCheckoutSession();
  }, [billingReturn]);

  /**
   * WHERE AN ENTITLED ACCOUNT LANDS — one rule for the resume and for the paid return: no mailbox
   * is the mailbox step, and an account that has one is set up (the done step names it). `live`
   * is the caller's own cancellation; nothing moves once it answers false.
   */
  const landEntitled = useCallback(async (live: () => boolean = () => true): Promise<void> => {
    const { items } = await mailboxes.list();
    if (!live()) return;
    if (items.length === 0) { setStep("mailbox"); return; }
    setConnected(items[0]!);
    setStep("done");
  }, []);

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
      const may = await account.access({ fresh: true }).then((a) => !a.metered || a.canAddMailbox)
        .catch(() => null);
      /* UNREADABLE FAILS OPEN, like every other unknown in this funnel: sending somebody to an
         account page they may not need is worse than letting the mailbox step's own refusal
         speak. `false` is the only answer that routes to the plan step. */
      if (may === false) { setStep("plan"); return; }
      if (may === true) forgetPlanHint();

      await landEntitled();
    } catch (err) {
      // No session (401) is the normal first visit and the form is right; any other fault leaves the step unknown.
      if (signedIn && !(err instanceof ApiError && err.status === 401)) setUnreachable(true);
    } finally {
      setResolving(false);
    }
  }, [landEntitled, signedIn]);

  /**
   * A SIGN-OUT THIS BROWSER ASKED FOR AND THE SERVER NEVER CONFIRMED (`login/pending-sign-out.tsx`). The jar
   * still carries the previous person's cookies, so the session is not read here at all: its answer is that
   * person's account, and its 401 path refreshes the family they ended. The sign-out is finished at the door
   * behind the form instead, as on the sign-in page one link away, and asked once more before a registration
   * (`submitAccount`). `stopFinish` is how a registration stops the ladder's next attempt.
   */
  const pending = usePendingSignOut();
  const stopFinish = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (apiConfigured() && readOwnerMarker().kind === "signed-out") {
      let cancelled = false;
      stopFinish.current = () => { cancelled = true; };
      setResolving(false);
      void pending.finish(() => cancelled);
      return () => { cancelled = true; };
    }
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pending.finish` is the page's for its life
  }, [bootstrap]);

  /**
   * MINT THE LINK to the page that takes the plan, and — while this step is on screen — keep asking whether the
   * account has become entitled. Whatever happens on that page happens at the service operator's end and races the
   * browser's return, so polling is the honest shape: this client cannot know it landed until the port says the
   * account may add a mailbox, and pretending otherwise would send somebody to the mailbox step to be refused by the
   * allowance gate. The poll is BOUNDED and the bound is the whole of what it promises. When it expires the screen
   * says the account is not entitled YET — never that something failed, because nothing here can know that, and never
   * a plan word.
   */
  useEffect(() => {
    if (step !== "plan") return;
    let cancelled = false;
    let attempts = 0;

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      /**
       * A POLL IS A READ, AND A READ IS AN ACTION HERE: Every button on this wizard asks whose browser this is before
       * it acts. This loop did not, and it is the one thing on the screen that runs WITHOUT a press — repeatedly, for
       * up to a minute, after a return from checkout. A sign-in in another tab between two ticks and the next one
       * reads that account's subscription: if they have one, the line below advances this wizard to the mailbox step
       * on the strength of somebody else's plan; if they do not, their plan state is rendered here. Distinct from the
       * disclosed preflight-to-write window, which is about the gap between an ask and a write. This had no ask at
       * all.
       */

      /**
       * A refusal ENDS the loop rather than retrying: `sameAccount` has already put the account-changed sentence on
       * screen, and a poll that kept running behind it would eventually overwrite that with a plan state for whoever
       * is signed in now.
       */
      if (!await sameAccount()) return;
      if (cancelled) return;
      const may = await account.access({ fresh: true }).then((a) => !a.metered || a.canAddMailbox)
        .catch(() => null);
      if (cancelled) return;
      if (may === true) {
        forgetPlanHint(); // the trial started: the site's choice has done its job
        // An account that already has a mailbox is set up, not asked to connect one.
        await landEntitled(() => !cancelled).catch(() => { if (!cancelled) setStep("mailbox"); });
        return;
      }
      /* KEEP POLLING ONLY ON A RETURN. On a first arrival there is nothing in flight to wait
         for, so one read is the whole of it and the screen shows the link. */
      if (billingReturn !== "success" || ++attempts >= ACCESS_POLL_ATTEMPTS) {
        if (billingReturn === "success") setError(t("planPending"));
        return;
      }
      setTimeout(() => { void tick(); }, ACCESS_POLL_MS);
    };

    // A return from Checkout asks the service to apply the payment first — once, bounded — and the
    // poll below then reads the answer rather than waiting on the program's webhook.
    if (billingReturn === "success") {
      // The return's query as it arrived: the mount took the session id out of the address bar.
      void confirmAccountReturn(returnSearch.current).finally(() => { void tick(); });
    } else void tick();
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
    // The account page opens in this screen's language with the site's choice preselected.
    void account.manageLink({ lang, ...hint })
      .then((link) => {
        if (cancelled) return;
        const u = link?.url;
        if (typeof u === "string" && u.length > 0) setManageUrl(u);
        else setPlanLinkFailed(true);
      })
      .catch(() => { if (!cancelled) setPlanLinkFailed(true); });
    return () => { cancelled = true; };
  }, [step]);

  /** `sentenceOf` puts a step's own words on a refusal it knows; null leaves the server's sentence. */
  const run = async (fn: () => Promise<void>, sentenceOf?: (err: unknown) => string | null): Promise<void> => {
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
        /**
         * The window between the ask and the write: `sameAccount()` asks who this browser holds
         * and then makes the request, and a session that changes between those two is not
         * something this side can see. A live session and a credential that disagree arrive at
         * this arm as a `409 session_conflict`, and what is left here is saying so in the same
         * words the preflight uses, rather than rendering the raw sentence of an error the
         * person cannot act on. No email in this one, deliberately: the refusal happened on the
         * server side and this client was never told whose session it collided with — naming an
         * account we did not read would be inventing the most load-bearing word in the sentence.
         */
        setError(t("accountConflict"));
      } else if (code === "step_up_required") {
        // Reached only when the factor asked for in place did not reopen the window (`connect`
        // asks once, then a second refusal lands here): a fresh sign-in, whose link resumes
        // this wizard, rather than the server's raw sentence or another prompt that would loop.
        setFatal(t("stepUpExpired"));
        setFatalAction("signIn");
      } else if (code === "signup_capacity") {
        // The capacity valve. This is the ONE refusal the wizard cannot retry its way
        // out of, and the remedy is a different surface: the waitlist, which is exactly what
        // it is for once it stops being the front door. Its sentence is the screen's own.
        setFatal(t("refusedFull"));
        setFatalAction("waitlist");
      } else if (code === "payment_required") {
        // The allowance gate refused for payment. With the corrected step order this is only
        // reachable when Checkout's webhook has not landed, or when a subscription lapsed
        // mid-onboarding — either way the remedy is the plan step, not an inline error.
        setStep("plan");
        setError(messageOf(err));
      } else {
        setError(sentenceOf?.(err) ?? messageOf(err));
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
      // No account is made beside a sign-out the server has not confirmed: its family is still live in
      // this jar, and the registration's session would leave it so. Its attempt still out ends first,
      // then the door is asked once more; anything short of a finished sign-out is said.
      stopFinish.current?.();
      if (!await pending.settle()) return;
      // The invite is validated by the SERVER, inside the transaction that creates the
      // account. There is no client-side pre-check, deliberately: a code this component
      // considered valid and the server refused would be two sources of truth about the
      // one thing standing between a stranger and an account.
      //
      // The field is OMITTED when empty rather than sent as `""`. The two are the same
      // to the server today, but "no code offered" and "an empty code" are different facts
      // and only one of them is what an open signup means.
      const offered = code.trim();
      let out: Awaited<ReturnType<typeof auth.register>>;
      try {
        out = await auth.register({
          email: email.trim(), password, displayName: displayName.trim(),
          ...(offered.length > 0 ? { inviteCode: offered } : {}),
          locale: lang, // the verification mail is written in this screen's language
        });
      } catch (err) {
        /* THE DEPLOY-SKEW CASE, and the reason `needsInvite` is state: this webapp is armed for public
           signup and the API is not, so it asks for the one field it never sent. Only a refusal that
           NAMES that field: a refused address shape (`mila@gmailcom` passes the browser's check) or
           any refusal of a later step is said where it happened, never as a missing invite. */
        if (!needsInvite && codeOf(err) === "validation_failed" && err instanceof ApiError && /\binviteCode\b/.test(err.message)) {
          setNeedsInvite(true);
          setStep("invite");
          setError(t(SELF_HOST_BUILD ? "inviteRequiredAfterAllSelfHost" : "inviteRequiredAfterAll"));
          return;
        }
        throw err;
      }
      setPassword("");
      // TWO OUTCOMES, and the wizard must not try to tell them apart beyond this. The PUBLIC path answers
      // `{status:"ok"}` with no session, byte-identically whether or not that address already had an account. There
      // is nothing to continue with in this tab, so the honest next screen is "we sent you a mail" — and its copy
      // says exactly that and no more. Claiming "your account is ready" would be false for half the callers and would
      // also re-open the oracle in the UI, since the wizard would be asserting something the response deliberately
      // does not say. The INVITE path still returns an enrollment session and still goes straight to the passkey
      // step, unchanged from the first build of this wizard.
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
    }, (err) => {
      const key = registerRefusal(err);
      return key === null ? null : t(key);
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
    }, (err) => (totpRefusal(err) === null ? null : t("refusedTotpCode")));
  };

  /**
   * Recovery codes belong to an account, so ask which one first. `POST /auth/2fa/recovery-codes` generates for
   * whatever session the browser holds AT THAT MOMENT, and it DELETES the previous set — under the wrong session it
   * both hands somebody else's codes to whoever is looking at this screen and destroys the codes that account may
   * have written down: the most consequential button in the wizard. Everything else signed-in is protected by the
   * account boundary in `api-client.ts`, but an enrolment session sets no owner marker (`enrollmentCookies` writes
   * none), so there is nothing to compare — absence here is the normal state of being half signed up, not the
   * "silence" the gate reasons about. So the question goes to the only party that can answer: one extra round trip
   * immediately before the generate, compared to the account this wizard started as.
   */

  /**
   * A mismatch STOPS — no codes requested, nothing deleted, and the screen says which account the browser is signed
   * in as now. Deliberately not a boundary and not a lock: those order writes or refuse them, and neither can tell
   * that the enrolment session under this wizard has been replaced.
   */
  /**
   * Is the browser still signed in as the account this wizard is for? Asked immediately before every action that acts
   * on an account, and it FAILS CLOSED: an unknown wizard account refuses rather than waving through — "we never
   * learned who this is" is not evidence it is the right one. That was the hole review found: the comparison was
   * written `wizardAccount !== null && …`, and on the ordinary first signup `wizardAccount` was null, so the guard
   * turned itself off on the one path everybody takes.
   */

  /**
   * Every action and not just the codes, because on an enrolment session the server accepts a passkey registration, a
   * TOTP secret and its activation, a verification resend, a mailbox create and a checkout — each for whatever
   * session the browser holds: under a switched session that is a passkey on somebody else's account, their
   * authenticator secret on this screen, their mail credentials attached, a plan bound to their account.
   */

  /**
   * It cannot be the account boundary: `enrollmentCookies` writes no owner marker, so there is
   * nothing for `pendApiOwner` to bind to or compare — `pending` would refuse every request on
   * this screen. The only party that knows is the server, so it is asked: one round trip per
   * action, on a wizard where each action is a deliberate press. What it does not close: the
   * window between this answer and the request that follows it. That needs the server to carry
   * an expected account on the write itself — the same thing `AF-RESPONSE-NOT-OWNER-BOUND` is
   * waiting for. Stated rather than implied.
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
    await auth.resendVerification(lang);
    setResent(true);
  });

  useEffect(() => {
    if (step === "codes" && recovery === null && !busy) fetchCodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const suggestedAddress = step === "account" ? addressSuggestion(email.trim()) : null;

  /* The authenticator's refusal sits under the code field it is about, the same way. */
  const totpOpen = step === "factor" && totp !== null;
  const totpRefusalAt = useRefusalAtThePress<HTMLParagraphElement>(totpOpen ? error : null);
  const totpRefusalLine = error && totpOpen ? (
    <p ref={totpRefusalAt} className="join-error at-press" role="alert" tabIndex={-1}>{error}</p>
  ) : null;

  /** Copy takes the key whole (no group spaces); a clipboard that refuses says so, the key stays on screen. */
  const [secretCopied, setSecretCopied] = useState<"copied" | "failed" | null>(null);
  useEffect(() => { setSecretCopied(null); }, [totp]);
  const copySecret = (): void => {
    const secret = totp?.secret;
    if (!secret) return;
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip) { setSecretCopied("failed"); return; }
    clip.writeText(secret).then(() => setSecretCopied("copied"), () => setSecretCopied("failed"));
  };
  const [codesCopied, setCodesCopied] = useState<"copied" | "failed" | null>(null);
  const copyCodes = (codes: string[]): void => {
    const clip = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clip) { setCodesCopied("failed"); return; }
    clip.writeText(codes.join("\n")).then(() => setCodesCopied("copied"), () => setCodesCopied("failed"));
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
            <a className="btn primary" href="/#pricing">{t("capacityCta")}</a>
          ) : (
            /* The sign-in continues HERE, on the step the server says the account is on: plain
               `/login` forwards a live session to `/`, which has no mailbox step. A literal, so the
               zone census can read it; `login-next.test` holds `join` to JOIN_ROUTE. */
            <Link className="btn primary" href="/login?next=join">{t("signIn")}</Link>
          )}
        </div>
      </Shell>
    );
  }

  if (unreachable) {
    return (
      <Shell title={to("resumeUnreachableTitle")}>
        <p className="sub" role="alert">{to("resumeUnreachableBody")}</p>
        <div className="join-actions">
          <Button variant="primary" onClick={() => { setUnreachable(false); setResolving(true); void bootstrap(); }}>
            {to("resumeRetry")}
          </Button>
          <Link className="btn" href="/">{to("resumeLeave")}</Link>
        </div>
      </Shell>
    );
  }

  if (resolving) {
    return (
      <Shell title={to("resumeCheckingTitle")}>
        <p className="sub" role="status">{to("resumeChecking")}</p>
      </Shell>
    );
  }

  /* "You're set up" only once somebody agreed: before that the organize decision is still ahead (`#/first-run` opens
     on it), and a person who leaves here believing setup is over has a mailbox nothing screens. */
  const decisionAhead = step === "done" && connected !== null && !connected.organizeConsentedAt;

  return (
    <Shell
      title={t(decisionAhead ? "step_connected_title" : `step_${step}_title`)} step={step}
      rail={needsInvite ? RAIL_BASE : step === "verify" ? RAIL_OPEN_LATE_VERIFY : RAIL_OPEN}
    >
      {error && step !== "mailbox" && !totpOpen && <p className="join-error" role="alert">{error}</p>}
      {/* A sign-out this browser asked for that ended unconfirmed here, and Sign out to ask again. */}
      <PendingSignOutSaid pending={pending} busy={busy} />

      {step === "invite" && (
        <form onSubmit={submitInvite}>
          {/* Three leads, because "ohmail is invite-only during the beta" is a claim about the
              deployment: false on an open one, and false on a self-host box where invitation is
              the permanent design rather than a beta condition. The posture and its key come from
              the one table the login note also reads (`invite-posture.ts`), so a surface cannot
              gain a fourth spelling of the same fact. */}
          <p className="sub">{t(JOIN_INVITE_KEY[signupPosture(SELF_HOST_BUILD, publicSignup)])}</p>
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
          {/* A likely typo in a common mail domain is named, as a button that applies it. */}
          {suggestedAddress ? (
            <button type="button" className="join-alt join-suggest" onClick={() => setEmail(suggestedAddress)}>
              {t("didYouMean", { address: suggestedAddress })}
            </button>
          ) : null}
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
            <Button variant="primary" type="submit" disabled={busy || pending.signingOut}>
              {busy ? t("working") : t("createAccount")}
            </Button>
          </div>
          {/* Somebody who already has an account, sent here by a trial button. */}
          <div className="join-actions join-actions-tight">
            <Link className="join-alt" href="/login">{t("accountSignIn")}</Link>
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
            {/* A typo in the address is mended here: back to the form, the address kept to correct. */}
            <button type="button" className="join-alt" onClick={() => { setError(null); setStep("account"); }}>
              {t("wrongAddress")}
            </button>
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
              {/* A REAL QR of the enrollment URI, from the encoder Settings' invites use (the old
                  "QR" here was the URI printed as 6px text). The key beside it is the path for an
                  app on this same device: in groups of four to read off, with Copy, which copies it
                  whole; the link hands the enrollment to an installed app directly. */}
              <div className="join-qr">
                <QrCode value={totp.otpauthUrl} ariaLabel={t("totpQrAria")} />
              </div>
              <p className="join-secret"><code>{groupedSecret(totp.secret)}</code></p>
              <div className="join-actions join-actions-tight">
                <button type="button" className="join-alt" onClick={copySecret}>
                  {secretCopied === "copied" ? t("totpCopied") : t("totpCopy")}
                </button>
                <a className="join-alt" href={totp.otpauthUrl} rel="noreferrer noopener">{t("totpOpenApp")}</a>
              </div>
              {secretCopied === "failed" ? <p className="join-hint" role="status">{t("totpCopyFailed")}</p> : null}
              <label className="join-label" htmlFor="join-totp">{t("totpLabel")}</label>
              <input
                id="join-totp" className="join-input join-code" inputMode="numeric"
                autoComplete="one-time-code" maxLength={6}
                value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ""))}
              />
              {totpRefusalLine}
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
              {/* Two ways to keep them besides writing them down; neither leaves this device. */}
              <div className="join-actions join-actions-tight">
                <button type="button" className="join-alt" onClick={() => copyCodes(recovery)}>
                  {codesCopied === "copied" ? t("codesCopied") : t("codesCopy")}
                </button>
                <a
                  className="join-alt" download="ohmail-recovery-codes.txt"
                  href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${t("codesFileHeader")}\n\n${recovery.join("\n")}\n`)}`}
                >
                  {t("codesDownload")}
                </a>
              </div>
              {codesCopied === "failed" ? <p className="join-hint" role="status">{t("codesCopyFailed")}</p> : null}
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
        <MailboxStep
          form={mailboxForm} busy={busy} error={error} setError={setError} run={run} sameAccount={sameAccount}
          owner={() => wizardOwner.current} onConnected={(dto) => { setConnected(dto); setStep("done"); }}
        />
      )}

      {step === "plan" && (
        <>
          <p className="sub">{t("step_plan_lead")}</p>
          {/* What the site promised, and the plan picked there; never a price (the account page owns prices). */}
          <p className="join-note" data-testid="join-plan-trial">
            {hint.plan
              ? `${t(hint.interval === "year" ? "planChosenYear" : hint.interval === "month" ? "planChosenMonth" : "planChosen",
                { plan: PLAN_NAMES[hint.plan] })} `
              : null}
            {t("planTrial")}
          </p>
          {/* ONE STEP, ONE CONTROL. The plan cards, the prices, the interval toggle and the
              trial figure were all this app quoting a catalogue it does not own; they live on
              the account page the service operator serves, which is also where the card is
              taken. This screen's job is to get the person there and to notice when they come
              back entitled — see `manageUrl` and the poll above.

              `planLoading` while the link is still being minted: a button that goes nowhere is
              the one control a person on this screen will press. */}
          {manageUrl ? (
            <>
              <div className="join-actions">
                <a className="btn primary" href={manageUrl}>{t("planContinue")}</a>
                {/* The app's front door offers the trial again (the wall's never-started state). */}
                <Link className="join-alt" href="/">{t("planLater")}</Link>
              </div>
              <p className="join-hint">{t("planLaterHint")}</p>
            </>
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
          <p className="sub">{t(decisionAhead ? "step_connected_lead" : "step_done_lead")}</p>
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
            <Link className="btn primary" href="/#/first-run">{t(decisionAhead ? "continue" : "openOhmail")}</Link>
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
                as "todo" on the one screen where all of them are finished. `sent` is not in it
                either: "Check your email" IS the Email station, with the account behind it. */}
            {(() => {
              const shown: Step = step === "sent" && rail.includes("verify") ? "verify" : step;
              const at = shown === "done" ? rail.length : rail.indexOf(shown);
              return rail.map((s) => {
                const state = rail.indexOf(s) < at ? "done" : s === shown ? "now" : "todo";
                return (
                  <li key={s} data-state={state} aria-current={state === "now" ? "step" : undefined}>
                    <span className="join-rail-dot" aria-hidden="true" />
                    <span className="join-rail-label">{t(`rail_${s}`)}</span>
                  </li>
                );
              });
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
/**
 * `?session_id=` out of the address bar once the return has read it, as `?code` is: otherwise it sits in
 * the visible URL, in history and in the `Referer` of the next navigation. `?billing` stays, so a reload
 * still waits for the return.
 */
function scrubCheckoutSession(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("session_id")) return;
  url.searchParams.delete("session_id");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/** A base32 key in groups of four, as authenticator apps print it; Copy takes it whole. */
function groupedSecret(secret: string): string {
  return secret.replace(/\s+/g, "").match(/.{1,4}/g)?.join(" ") ?? secret;
}

function deviceLabel(): string {
  if (typeof navigator === "undefined") return "This browser";
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return os ? `${browser} on ${os}` : browser;
}
