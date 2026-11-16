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
import { useLocale, useTranslations } from "next-intl";
import {
  ApiError, account, apiConfigured, auth, codeOf, createPasskey, mailboxes,
  messageOf, webauthnAvailable,
  type AccountAccess, type MailboxDTO,
} from "../../api-client";
import { neverStarted } from "../../access-verdict";
import { markSessionAlive, sessionIsDead } from "@ohmail/app-logic/session/session-truth";
import { addressSuggestion } from "./address-hint";
import { SELF_HOST_BUILD } from "../../hello";
import { confirmAccountReturn } from "../../account-return";
import { forgetPlanHint, recalledPlanHint, rememberPlanHint, type PlanHint } from "../../plan-hint";
import { readOwnerMarker } from "@ohmail/app-logic/storage/owner-cookie";
import { usePendingSignOut } from "../login/pending-sign-out";
import { registerRefusal, totpRefusal } from "./signup-refusals";
import { useMailboxForm } from "./MailboxStep";
import { awaitHandoff } from "./handoff";
import { refreshSettled } from "../../session-refresh";
import { checkAnswered, revokedWipeSettled } from "../../revoked-door";

export type Step = "invite" | "account" | "sent" | "factor" | "codes" | "verify" | "plan" | "mailbox" | "done";

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
export const RAIL_BASE: Step[] = SELF_HOST_BUILD ? RAIL_SELF_HOST : RAIL;
/** The wizard's own verify step (a failed mail, re-entered by sign-in) comes after the codes, in `RAIL` order. */
export const RAIL_OPEN_LATE_VERIFY: Step[] = RAIL_BASE.filter((s) => s !== "invite");
/**
 * THE OPEN PATH PROVES THE ADDRESS FIRST: the mail is sent from the account step and its link is
 * opened before any factor, so Email is the second station there. Self-host has no Email station.
 */
export const RAIL_OPEN: Step[] = SELF_HOST_BUILD
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
/** The bounded wait after a return, before the screen says "not yet": about two minutes, its reads
 *  1.5 s apart at first and further apart each time, to a 15 s gap. */
const RETURN_WAIT_MS = 120_000;
const RETURN_FIRST_GAP_MS = 1_500;
const RETURN_GAP_GROWTH = 1.5;
const RETURN_MAX_GAP_MS = 15_000;
const RETURN_MAX_READS = 16;

/** Trial words only where the service says this account never started a trial (`neverStarted`). */
const offersTrial = (a: AccountAccess): boolean => a.metered === true && neverStarted(a.lifecycle);

/** What the page hands the ceremony: what `page.tsx` read from the request, on the server. */
export interface JoinProps {
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
}

export function useJoinDoor({ initialCode, billingReturn, publicSignup = false, planHint, signedIn = false }: JoinProps) {
  const t = useTranslations("join");
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
  /** The bootstrap's session read, last one out: a registration hears its answer first (`submitAccount`). */
  const sessionRead = useRef<Promise<unknown> | null>(null);
  const [codesSaved, setCodesSaved] = useState(false);
  /** The read before a generate said this account already has codes (another tab made them): none are made here. */
  const [codesElsewhere, setCodesElsewhere] = useState(false);
  /** The confirming page granted this "Check your email" tab the setup: a failed read is then said, not swallowed. */
  const handedOver = useRef(false);
  const [continuing, setContinuing] = useState(false);
  /** Trial words on the plan step: `null` until an access answer was read, then `offersTrial`. */
  const [trialOffer, setTrialOffer] = useState<boolean | null>(null);
  /** The bounded wait after a return from the account page is running. */
  const [waiting, setWaiting] = useState(false);
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
      /* After a grant this tab may still hold its session as ended: its first read ran before the confirming page
         minted one, and that hold refuses every read below. The front door's read is let out; its answer lifts it. */
      if (handedOver.current && sessionIsDead()) {
        await auth.session({ ceremony: true });
        markSessionAlive();
      }
      const read = auth.session();
      sessionRead.current = read;
      const s = await read;
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
      const may = await account.access({ fresh: true }).then((a) => {
        setTrialOffer(offersTrial(a));
        return !a.metered || a.canAddMailbox;
      }).catch(() => null);
      /* UNREADABLE FAILS OPEN, like every other unknown in this funnel: sending somebody to an
         account page they may not need is worse than letting the mailbox step's own refusal
         speak. `false` is the only answer that routes to the plan step. */
      if (may === false) { setStep("plan"); return; }
      if (may === true) forgetPlanHint();

      await landEntitled();
    } catch (err) {
      // No session (401) is the normal first visit and the form is right; any other fault leaves the step unknown.
      // After a grant there IS a session to read, so its absence is the expired screen, never the form.
      const noSession = err instanceof ApiError && err.status === 401;
      if (handedOver.current && noSession) {
        setFatal(tRef.current("expiredOpen"));
        setFatalAction("signIn");
      } else if ((signedIn || handedOver.current) && !noSession) {
        setUnreachable(true);
      }
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const returning = billingReturn === "success";
    const until = Date.now() + RETURN_WAIT_MS;
    let gap = RETURN_FIRST_GAP_MS;
    let reads = 0;
    if (returning) setWaiting(true);

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      reads += 1;
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
       * is signed in now. A check that could not be asked reads nothing this time (it fails closed) and the wait goes on.
       */
      const same = await sameAccount().catch(() => null);
      if (cancelled) return;
      if (same === false) { setWaiting(false); setTrialOffer((v) => v ?? false); return; }
      const may = same === null ? null : await account.access({ fresh: true }).then((a) => {
        if (!cancelled) setTrialOffer(offersTrial(a));
        return !a.metered || a.canAddMailbox;
      }).catch(() => null);
      if (cancelled) return;
      // No answer read names no trial: the screen shows the account page's own button.
      if (may === null) setTrialOffer((v) => v ?? false);
      if (may === true) {
        setWaiting(false);
        forgetPlanHint(); // the trial started: the site's choice has done its job
        // An account that already has a mailbox is set up, not asked to connect one.
        await landEntitled(() => !cancelled).catch(() => { if (!cancelled) setStep("mailbox"); });
        return;
      }
      /* KEEP POLLING ONLY ON A RETURN. On a first arrival there is nothing in flight to wait
         for, so one read is the whole of it and the screen shows the link. */
      if (!returning) return;
      const left = until - Date.now();
      if (left <= 0 || reads >= RETURN_MAX_READS) {
        setWaiting(false);
        setError(t("planPending"));
        return;
      }
      timer = setTimeout(() => { void tick(); }, Math.min(gap, left));
      gap = Math.min(gap * RETURN_GAP_GROWTH, RETURN_MAX_GAP_MS);
    };

    // A return from Checkout asks the service to apply the payment first — once, bounded — and the
    // poll below then reads the answer rather than waiting on the program's webhook.
    if (returning) {
      // The return's query as it arrived: the mount took the session id out of the address bar.
      void confirmAccountReturn(returnSearch.current).finally(() => { void tick(); });
    } else void tick();
    return () => { cancelled = true; clearTimeout(timer); setWaiting(false); };
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
      // The session read out now and any renewal answer first, within one bound: a revoke they carry
      // is wiped before an account is made here. Then one read more inside it, for a read that met a busy
      // server or none: after any refusal the session is held ended, and it leaves nothing (as under a
      // pending sign-out).
      await Promise.all([checkAnswered(sessionRead.current, (signal) => auth.session({ signal })), refreshSettled()]);
      await revokedWipeSettled();
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
    if (!await enrolling()) return;
    const { options } = await auth.webauthnRegisterOptions();
    const credential = await createPasskey(options);
    await auth.webauthnRegisterVerify({ credential, label: deviceLabel() });
    // The response carries the exchanged FULL session in cookies. Nothing to store.
    setStep("codes");
  });

  const startTotp = () => void run(async () => {
    if (!await enrolling()) return;
    setTotp(await auth.totpEnroll());
  });

  const activateTotp = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!await enrolling()) return;
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
  const sessionIfSame = async (): Promise<Awaited<ReturnType<typeof auth.session>> | null> => {
    const now = await auth.session();
    if (wizardOwner.current !== null && now.user.accountId === wizardOwner.current) return now;
    setError(t("accountChanged", { email: now.user.email }));
    return null;
  };
  const sameAccount = async (): Promise<boolean> => (await sessionIfSame()) !== null;

  /**
   * The factor step's own question: is this still the enrolment session? A second wizard in this browser
   * (a second /join, a reload, the tab the confirming page continued in) may have added the first factor
   * since; then this press adds no second one, the wizard re-reads where the account is instead.
   */
  const enrolling = async (): Promise<boolean> => {
    const now = await sessionIfSame();
    if (now === null) return false;
    if (now.scope === "enrollment") return true;
    await bootstrap();
    return false;
  };

  /**
   * Every generate deletes the account's set, so the read just before it decides: codes that exist were
   * made by another wizard in this browser, or by a generate whose answer was lost, and none are made here.
   */
  const fetchCodes = () => void run(async () => {
    const now = await sessionIfSame();
    if (now === null) return;
    if (now.user.twofaEnrolled.recoveryCodes) { setCodesElsewhere(true); return; }
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

  /**
   * "Check your email" waits for the page that confirms the address to hand the setup over (`handoff.ts`).
   * Only that page's grant moves this tab on, and then it asks the server where the setup stands.
   */
  useEffect(() => {
    if (step !== "sent") return;
    return awaitHandoff(() => {
      handedOver.current = true;
      setContinuing(true);
      void bootstrap().finally(() => setContinuing(false));
    });
  }, [step, bootstrap]);

  const suggestedAddress = step === "account" ? addressSuggestion(email.trim()) : null;

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

  return {
    fatal, fatalAction, unreachable, setUnreachable, resolving, setResolving, bootstrap, step, setStep,
    connected, setConnected, needsInvite, error, setError, pending, busy, code, setCode, submitInvite,
    submitAccount, email, setEmail, suggestedAddress, displayName, setDisplayName, password, setPassword,
    continuing, resendVerification, resent, enrollPasskey, startTotp, totp, setTotp, activateTotp,
    secretCopied, copySecret, totpCode, setTotpCode, codesElsewhere, setCodesElsewhere, recovery, copyCodes,
    codesCopied, codesSaved, setCodesSaved, fetchCodes, mailboxForm, run, sameAccount, wizardOwner,
    trialOffer, hint, waiting, manageUrl, planLinkFailed,
  };
}

/** What the join's ceremony holds, and its acts. */
export type JoinCeremony = ReturnType<typeof useJoinDoor>;

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

function deviceLabel(): string {
  if (typeof navigator === "undefined") return "This browser";
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows"
    : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return os ? `${browser} on ${os}` : browser;
}
