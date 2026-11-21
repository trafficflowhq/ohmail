"use client";

/**
 * Sign-in, wired. `POST /auth/login` is a union (`LoginResult`) and both arms matter: `twofa_required` — the ordinary
 * path, a single-use login token plus the enrolled methods; `enrollment` — the RE-ENTRY path: a user with zero
 * enrolled factors gets the same enrollment session `register` hands out, because for them the password IS the only
 * factor and the alternative is a permanently unusable account — routed straight to `/join`, which resumes at the
 * passkey step. The password field is not a regression: the password has always been the FIRST factor and the passkey
 * the second (`AuthService.login` verifies a hash before minting a token); "no password to leak" is about the second
 * factor and the scrypt hash, both still true. This file must not store anything: the session is three `HttpOnly`
 * cookies, the login token lives in a local variable for one ceremony, and there is no "remember me".
 */

import { useEffect, useRef, useState } from "react";
import { checkSettingsHandoff } from "../../settings-handoff-client";
import { settingsDestination } from "../../settings-handoff";
import { useRouter } from "next/navigation";
import type { SignInFactor, SignInRefusal } from "@ohmail/app/doors";
import {
  ApiError, apiConfigured, assertPasskey, auth, messageOf, webauthnAvailable,
  type TwofaChallenge,
} from "../../api-client";
import { SELF_HOST_BUILD, serverHello } from "../../hello";
import { CONFIRM_ATTEMPTS, nextConfirmDelay } from "@ohmail/app-logic/session/confirm-schedule";
import { readOwnerMarker } from "@ohmail/app-logic/storage/owner-cookie";
import { refreshSettled } from "../../session-refresh";
import { checkAnswered, revokedWipeSettled } from "../../revoked-door";
import { resolveOwnerOutcome } from "../session-outcome";
import { takeSharedSignedOutNote, takeSignedOutNote, type SignedOutReason } from "../resume/signed-out-note";
import { usePendingSignOut, type PendingSignOut } from "./pending-sign-out";
// The approval page's way back after an ordinary sign-in: a request id, never a URL.
import { approvalReturnKept, takeApprovalReturn } from "../approve/approval-return";
import { whenSignedInElsewhere } from "../approve/signed-in-elsewhere";
import { leaveFor, type Continuation } from "./continuation";

type Stage = "password" | "twofa";
export type Method = "webauthn" | "totp" | "recovery_code";

/**
 * The refusals a person meets at this form get this form's own sentences. `messageOf` renders the
 * server's message verbatim — right for the refusal taxonomy the services write for humans, wrong
 * for the auth ceremony's bare 401s: `AuthService` answers those with lowercase wire strings
 * ("invalid email or password") written as diagnostics, and they rendered raw on this screen. So a
 * 401 here maps to a catalogue sentence keyed by WHICH factor was being tried (the caller knows;
 * the status alone does not say), and everything that is not a bare 401 keeps the server's own
 * sentence — this maps presentation, it re-derives no taxonomy.
 */
type FactorTried = "password" | "code" | "passkey";

function loginRefusal(err: unknown, tried: FactorTried): SignInRefusal {
  // The throttle's two refusals, each its own sentence: a client that renders them as "wrong
  // password" hides the one thing to do next, which is to wait.
  if (err instanceof ApiError && err.code === "sign_in_slowed") return { word: "slowed" };
  if (err instanceof ApiError && err.code === "account_locked") return { word: "locked" };
  if (err instanceof ApiError && err.status === 401) {
    return { word: tried === "password" ? "bad_credentials" : tried === "code" ? "bad_code" : "bad_passkey" };
  }
  return { word: "said", said: messageOf(err) };
}

/** The factor as the page names it. */
export const FACTOR_OF: Readonly<Record<Method, SignInFactor>> = { webauthn: "passkey", totp: "code", recovery_code: "recovery" };
export const METHOD_OF: Readonly<Record<SignInFactor, Method>> = { passkey: "webauthn", code: "totp", recovery: "recovery_code" };

/** What the sign-in's ceremony holds, and its acts. The login token never leaves it. */
export interface SignInCeremony {
  invalidHandoff: boolean;
  stage: Stage;
  email: string;
  setEmail(v: string): void;
  password: string;
  setPassword(v: string): void;
  methods: readonly Method[];
  method: Method;
  setMethod(v: Method): void;
  code: string;
  setCode(v: string): void;
  busy: boolean;
  refusal: SignInRefusal | null;
  signedOut: SignedOutReason | null;
  pending: PendingSignOut;
  configured: boolean;
  submitPassword(e: { preventDefault(): void }): void;
  /** The password step with the words the page holds. */
  submitWith(email: string, password: string): void;
  finishWithPasskey(): void;
  finishWithCode(e: { preventDefault(): void }): void;
  /** A code step with the code the page holds. */
  finishWith(code: string): void;
  restart(): void;
}

export function useSignInDoor({ next = null, handoff = null }: {
  next?: Continuation | null;
  handoff?: string | null;
}): SignInCeremony {
  const router = useRouter();
  const [invalidHandoff, setInvalidHandoff] = useState(false);

  /** Set when a sign-in elsewhere moved this tab back to its request: a later answer moves nothing. */
  const leftRef = useRef(false);

  /** Once a session exists: the approval page's return, else the named continuation, else the app. */
  const proceed = (fallback: string, how: "push" | "replace"): void => {
    if (leftRef.current) return;
    if (handoff !== null) {
      void checkSettingsHandoff(handoff).then((answer) => {
        if (answer.kind === "ready") router[how](settingsDestination(handoff, answer.pane));
        else if (answer.kind === "invalid") setInvalidHandoff(true);
        else restart();
      });
      return;
    }
    const back = takeApprovalReturn();
    if (back !== null) router[how](back);
    else if (next !== null) leaveFor(next);
    else router[how](fallback);
  };

  const [stage, setStage] = useState<Stage>("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [challenge, setChallenge] = useState<TwofaChallenge | null>(null);
  const [method, setMethod] = useState<Method>("webauthn");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<SignInRefusal | null>(null);
  /**
   * Why this tab is here, read once after mount (never during render): a sign-out this browser asked
   * for that the server never confirmed (`tf_owner`), else the resume splash's note, else another tab's
   * young reason: a tab opened after the refusal emptied the jar is sent here without the splash.
   */
  const [signedOut, setSignedOut] = useState<SignedOutReason | null>(null);
  useEffect(() => {
    const note = takeSignedOutNote() ?? takeSharedSignedOutNote();
    if (readOwnerMarker().kind === "signed-out") setSignedOut("pending");
    else if (note !== null) setSignedOut(note);
  }, []);

  /**
   * HOW THE PENDING SIGN-OUT ENDED, when it did not finish: the server kept refusing, or the wipe did
   * not land. Said in the card with Sign out to ask again, as the splash said it before this page
   * finished sign-outs (`pending-sign-out.tsx`, shared with the sign-up and confirmation pages).
   */
  const pending = usePendingSignOut();

  const configured = apiConfigured();

  /**
   * How the already-signed-in ladder below is stopped from OUTSIDE its own effect.
   *
   * The effect's cleanup covers unmount, and that is not enough: the ladder can still be
   * waiting on a backoff timer when somebody starts typing, and a confirm that lands
   * mid-ceremony would `router.replace` out from under a password already on the wire. The
   * first submit calls this; the effect owns what it does.
   */
  const cancelBootstrapRef = useRef<(() => void) | null>(null);
  /** The ladder's attempt out now, and how its request is stopped: a submit hears it first (`submitPassword`). */
  const checkOutRef = useRef<Promise<void> | null>(null);
  const abortCheckRef = useRef<(() => void) | null>(null);
  /** A check has answered (a session, or none): until one has, a submit asks once more first. */
  const verdictRef = useRef(false);

  /**
   * HAS A CEREMONY STARTED? Latched on the first submit and never cleared.
   *
   * `cancelBootstrapRef` stops the ladder that is running; this stops the NEXT one. They are
   * different guarantees and both are needed: the cancel belongs to one effect run, so any
   * re-run — a `configured` flip, a router identity change — would arm a fresh ladder behind a
   * password already on the wire. A latch on the component answers "this page is a ceremony
   * now", which is the fact that actually matters, and it cannot be undone by a re-render.
   */
  const submittedRef = useRef(false);

  /**
   * Already signed in? Then this page is not what you wanted. `/login` is a plain credential page —
   * middleware does not gate it — so a visitor with a live session was shown a sign-in form
   * (reported from live use). `api()` refreshes and retries on a 401, so the lapsed-but-resumable
   * case goes straight through; only an unrecoverable session falls to the form. `replace`, not
   * `push`, and the fragment rides along so `/login#/settings` lands on Settings. It retries on the
   * same ladder and schedule as the shell's confirm: `unknown` retries up to
   * {@link CONFIRM_ATTEMPTS}, `none` stops, a confirmed `owner` forwards — one 503 no longer
   * produces the form while the shell says "signed out". The form renders throughout.
   */

  /*
   * Cancelled on unmount AND on the first submit. The submit first hears the attempt that is out,
   * within the bound (its 401 may carry a revoke, whose wipe must start before the sign-in leaves),
   * and then it is ABORTED, not ignored. A confirm still in flight when a password is submitted does
   * not merely arrive too late: if it 401s it sends `POST /auth/refresh` with the OLD account's
   * refresh cookie, and that response rewrites the whole jar — landing after the new session's
   * cookies are set, a success overwrites them with the previous account's and a failure clears
   * them, so the person is switched back or signed out seconds after completing a sign-in.
   * Suppressing the promise continuation cannot undo a `Set-Cookie`; only stopping the request
   * before it becomes a refresh can. The ladder made that window wider, so it carries the fix.
   */
  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    cancelBootstrapRef.current = () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    abortCheckRef.current = () => abort.abort();
    // A ceremony already owns this page — see `submittedRef`. Nothing to confirm.
    if (submittedRef.current) return;
    /*
     * A SIGN-OUT THIS BROWSER ASKED FOR AND THE SERVER NEVER CONFIRMED: the edge sends it here, and
     * this page finishes it at the sign-out door behind the form (`finish-sign-out.ts`), and says so
     * if it cannot. INSTEAD of the confirm below, never beside it: the session read refreshes on a
     * 401, which would resume the family the person ended. The submit's cancel stops the next attempt.
     */
    if (readOwnerMarker().kind === "signed-out") {
      void pending.finish(() => cancelled);
      return () => { cancelled = true; };
    }
    const ask = async (attempt: number): Promise<void> => {
      // `resolveOwnerOutcome` answers rather than rejects for every network and server
      // reason; the one thing it rethrows is an unarmed build, which `configured` above has
      // already excluded. Caught anyway, and read as "stop asking": an unhandled rejection
      // from a page whose whole job is to render a form would be a worse outcome than a
      // ladder that ends early.
      const outcome = await resolveOwnerOutcome({ signal: abort.signal }).catch(() => null);
      // Kept after a submit too: the submit hears this attempt, then asks only when it answered nothing.
      if (outcome !== null && outcome.kind !== "unknown") verdictRef.current = true;
      if (cancelled || outcome === null) return;
      if (outcome.kind === "owner") {
        proceed(`/${window.location.hash}`, "replace");
        return;
      }
      // `none` is the server's own answer that there is nothing to forward to, which is
      // exactly what this page is for. Stop asking.
      if (outcome.kind === "none" || attempt >= CONFIRM_ATTEMPTS) return;
      timer = setTimeout(() => { checkOutRef.current = ask(attempt + 1); }, nextConfirmDelay(attempt, outcome.retryAfterMs));
    };
    if (handoff !== null) {
      checkOutRef.current = checkSettingsHandoff(handoff, abort.signal).then((answer) => {
        verdictRef.current = true;
        if (cancelled) return;
        if (answer.kind === "ready") router.replace(settingsDestination(handoff, answer.pane));
        else if (answer.kind === "invalid") setInvalidHandoff(true);
      });
    } else {
      checkOutRef.current = ask(1);
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
      abort.abort();
    };
    // `proceed` is left out: it reads `next`, a server prop, which is listed.
  }, [configured, router, next, handoff]);

  /**
   * A fresh self-host server has nobody to sign in. Self-host builds only (compile-time —
   * `SELF_HOST_BUILD` is false on the managed bundle, so this effect costs it nothing): when
   * `/hello` reports `needsSetup: true` there are zero accounts and every credential this form
   * could take would be refused, so the honest screen is the first-run ceremony at `/setup`.
   * The answer is the server's, asked fresh on every mount — `needsSetup` flips false the
   * moment the first account exists. Any failure to learn the state falls through to the form,
   * which is never wrong.
   */

  /**
   * It belongs to the ceremony too, and it did not: this is a second request off this page, and the ladder above knew
   * nothing about it. Two consequences, one expensive. A refresh nobody ordered — `api()` refreshes and retries on a
   * 401, and a refresh rewrites every session cookie when its response lands, so a delayed 401 here rewrote the jar
   * underneath a sign-in the ceremony had ordered itself behind; fixed where it belongs — `/hello` is in
   * `NEVER_REFRESH` (`session-refresh.ts`) — because this page is not the only asker. And a navigation from behind a
   * password: `router.replace("/setup")` arriving mid-ceremony takes the person off a form they already submitted;
   * the ladder's own guards are the right ones — `submittedRef` refuses to start once a ceremony owns the page, and
   * the signal is aborted when one begins, so a late answer navigates nothing.
   */
  useEffect(() => {
    if (!SELF_HOST_BUILD || !configured) return;
    // A ceremony already owns this page — see `submittedRef`. Nothing to ask.
    if (submittedRef.current) return;
    let cancelled = false;
    const abort = new AbortController();
    const stop = () => { cancelled = true; abort.abort(); };
    // Chained rather than replaced: the confirm ladder above installs its own canceller in the
    // same ref, and a submit has to stop BOTH. The order is immaterial; losing one is not.
    const previous = cancelBootstrapRef.current;
    cancelBootstrapRef.current = () => { previous?.(); stop(); };
    void (async () => {
      const hello = await serverHello({ signal: abort.signal });
      if (!cancelled && hello?.needsSetup === true) router.replace("/setup");
    })();
    return stop;
  }, [configured, router, handoff]);

  /*
   * SIGNED IN IN ANOTHER TAB. A tab `/approve` sent here keeps its request id; while it does, a
   * sign-in in any other tab of this browser makes this tab ask again (`signed-in-elsewhere.ts`),
   * and a full session takes this tab's own kept return and nothing else. A submit stops it as it
   * stops the ladder above, because this page is a ceremony from then on.
   */
  useEffect(() => {
    if (!configured || handoff !== null || !approvalReturnKept()) return;
    const stop = whenSignedInElsewhere(() => {
      const back = takeApprovalReturn();
      if (back === null) return;
      leftRef.current = true;
      router.replace(back);
    });
    const previous = cancelBootstrapRef.current;
    cancelBootstrapRef.current = () => { previous?.(); stop(); };
    return stop;
  }, [configured, router, handoff]);

  const run = async (fn: () => Promise<void>, tried: FactorTried): Promise<void> => {
    setBusy(true);
    setRefusal(null);
    try {
      await fn();
    } catch (err) {
      setRefusal(loginRefusal(err, tried));
    } finally {
      setBusy(false);
    }
  };

  const submitWith = (emailNow: string, passwordNow: string): void => {
    // The ceremony owns the page from here: stop the ladder that is running, and refuse the
    // next one. See `cancelBootstrapRef` and `submittedRef`.
    submittedRef.current = true;
    cancelBootstrapRef.current?.();
    const check = checkOutRef.current;
    void run(async () => {
      /*
       * LET ANY REFRESH ALREADY IN FLIGHT FINISH FIRST, and never cancel it.
       *
       * A refresh the ladder already entered rewrites every session cookie whenever its response
       * arrives. Landing after this ceremony, it restores the previous account or clears the new
       * session. The refresh is shared single-flight state that other callers are awaiting, so the
       * fix is to order the two rather than to cancel one: it writes, then we write. See
       * `refreshSettled`. The session read still out is heard within the same bound, since its 401
       * may carry a revoke; then it is aborted, before it can become a refresh after this ceremony.
       * While no check has answered (a busy server, offline, a portal's page, a ladder run out), the
       * submit asks once more inside that bound; never under a pending sign-out, whose family the
       * read would renew.
       */
      const askOnce = async (signal: AbortSignal): Promise<void> => {
        if (verdictRef.current || readOwnerMarker().kind === "signed-out") return;
        if ((await resolveOwnerOutcome({ signal })).kind !== "unknown") verdictRef.current = true;
      };
      await Promise.all([checkAnswered(check, askOnce), refreshSettled()]);
      abortCheckRef.current?.();
      // A revoke this page's check heard: that account's copy is gone before a sign-in leaves.
      await revokedWipeSettled();
      /*
       * NO SIGN-IN BESIDE A SIGN-OUT THE SERVER HAS NOT CONFIRMED: its family is still live, and in
       * this jar, and a session minted beside it would leave it so. A pending sign-out's attempt still
       * out ends first, then the door is asked once more; anything short of a finished sign-out is
       * said, and the ceremony does not start.
       */
      if (!await pending.settle()) return;
      /**
       * THE ORIGIN-WIDE LOCK IS THE CLIENT'S NOW, NOT THIS SCREEN'S: This call took `withSessionCookieLock`
       * explicitly, which fixed the sign-in and nothing else: registration, first-run, and four in-shell
       * reauthentications write session cookies too and none of them knew. `auth.login` and every other
       * cookie-writing method carries the lock itself now (`api-client.ts`), so this reads as an ordinary call and is
       * ordered against a refresh in any tab whether or not this file remembers why. `refreshSettled` above stays: it
       * is the SAME-tab ordering, and it is what makes the common case wait for a refresh this tab started rather
       * than queue behind it.
       */
      const result = await auth.login({ email: emailNow.trim(), password: passwordNow });
      setPassword("");
      if (result.status === "enrollment") {
        // The re-entry path: registered, never finished 2FA. `/join` reads the live
        // enrollment session from `GET /auth/session` and resumes at the factor step.
        router.push("/join");
        return;
      }
      setChallenge(result);
      // Prefer a passkey when the user has one AND this browser can do the ceremony;
      // otherwise start on whatever they actually enrolled.
      const preferred = result.methods.includes("webauthn") && webauthnAvailable()
        ? "webauthn"
        : result.methods.includes("totp") ? "totp" : result.methods[0]!;
      setMethod(preferred);
      setStage("twofa");
    }, "password");
  };

  const submitPassword = (e: { preventDefault(): void }) => {
    e.preventDefault();
    submitWith(email, password);
  };

  const finishWithPasskey = () => void run(async () => {
    if (!challenge) return;
    const { options } = await auth.webauthnAssertOptions({ loginToken: challenge.loginToken });
    const credential = await assertPasskey(options);
    await auth.webauthnAssertVerify({ loginToken: challenge.loginToken, credential });
    proceed("/", "push");
  }, "passkey");

  const finishWith = (codeNow: string): void => {
    void run(async () => {
      if (!challenge) return;
      // The second factor writes the session cookies and is locked inside the client — see
      // `submitPassword`.
      if (method === "recovery_code") {
        await auth.recoveryVerify({ loginToken: challenge.loginToken, code: codeNow.trim() });
      } else {
        await auth.totpVerify({ loginToken: challenge.loginToken, code: codeNow.trim() });
      }
      proceed("/", "push");
    }, "code");
  };

  const finishWithCode = (e: { preventDefault(): void }) => {
    e.preventDefault();
    finishWith(code);
  };

  /**
   * A login token is SINGLE-USE and short-lived. Once a ceremony has been attempted the
   * safe move is a fresh password step, not a retry against a token that may already be
   * spent — a "try again" that silently 401s is worse than starting over.
   */
  const restart = () => {
    setChallenge(null);
    setCode("");
    setRefusal(null);
    setStage("password");
  };

  return {
    stage, email, setEmail, password, setPassword, methods: challenge?.methods ?? [], method, setMethod, code, setCode,
    busy, refusal, signedOut, pending, configured, invalidHandoff, submitPassword, submitWith, finishWithPasskey, finishWithCode,
    finishWith, restart,
  };
}
