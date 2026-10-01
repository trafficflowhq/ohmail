"use client";

/**
 * "Link the desktop app" — mint a one-use code, show it, and let it die on screen. The code is NOT
 * minted on load: a page-load mint is a prefetch mint, a restored-tab mint, an accidental
 * navigation mint — each a live credential nobody asked for; the press is also where the honest
 * sentence goes. The countdown is the SERVER's number (`expiresIn`): a literal here would be a
 * second copy of `desktopLinkTtlMs` that drifts, and a page saying "2 minutes" about a code that
 * died after one is worse than a page saying nothing. At zero the code is REMOVED, not greyed out —
 * a dead credential left visible is something a person keeps trying to type.
 */

/**
 * The step-up is re-asserted here, in place. `POST /auth/desktop-link` is step-up gated (it mints a
 * credential on a rolling four-hundred-day window). The mint is TRIED first; `step_up_required`
 * opens `StepUpPrompt`, which re-stamps the session this browser holds, and the verified factor
 * retries the mint once. Nothing here signs in — each sign-in was one more web session on the
 * account — so a browser with no session, an unfinished enrolment and a second refusal after a
 * verified factor are each told to sign in and open this page again. The page settles whose
 * browser this is before it offers a code (`approve/settle-owner.ts`), so a browser with no
 * session is told that at once rather than after a press.
 */

/**
 * The deep link is offered only for a code that is BOUND: when the app opened this page it appended `?challenge=` —
 * the public half of a PKCE pair whose verifier stays in the app's memory — and the code that comes back is spendable
 * only by a caller producing that verifier. That is the whole licence for the "Open ohmail" button: `ohmail://` is
 * claimed by whichever program registered it, and nothing authenticates that, so an interceptor receives a code it
 * cannot use.
 */

/**
 * With NO challenge there is no button — a deliberate refusal: an unbound code over a scheme anybody can claim is
 * strictly worse than the same code retyped into a window a person is looking at. A visitor who opened this page
 * themselves gets exactly the page that shipped before; the retype path is unchanged.
 */

import { useEffect, useRef, useState } from "react";
import { pendApiOwner } from "../../api-client";
import { readOwner } from "../../shell/owner-cookie";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import { apiConfigured, auth } from "../../api-client";
import { isBusy, retryBusy } from "../../retry-busy";
import { StepUpPrompt } from "../mailbox/StepUpPrompt";
import { gatedRefusal } from "../mailbox/gated-refusal";
import { useRefusalSentence } from "../refusal-sentence";
import { isOwnerAbsent, useSettledOwner } from "../approve/settle-owner";

/** A live code and the moment it stops being one. */
interface Minted {
  code: string;
  expiresAtMs: number;
}

/** `idle` is the mint button (or the code, once one exists); `stepup` is the prompt a closed window opens. */
type Phase = "idle" | "stepup";

/**
 * Where a bound code is handed back to the app. The scheme and the parameter name are a contract
 * with the desktop shell's handler — `code` and nothing else, because a deep link carries the
 * handoff code and never a token.
 */
const deepLink = (code: string): string => `ohmail://link?code=${encodeURIComponent(code)}`;

/**
 * The prop is the PKCE digest the app committed to, bound here as `commitment`: `challenge` names
 * a 2FA challenge everywhere else in this app, and the two mechanisms are unrelated.
 */
export function LinkDesktopScreen({ challenge: commitment = "" }: { challenge?: string }) {
  /**
   * THIS PAGE ACTS ON AN ACCOUNT, SO IT IS NOT A PUBLIC SURFACE: A fresh `/link-desktop` load left the Cloud client
   * `public`, which permits every request. The sequence review walked: the page is opened under A, another tab
   * establishes B, and pressing the button mints and RENDERS a one-use pairing credential for B — on a screen whose
   * whole job is to show a credential to whoever is looking at it. `pendApiOwner` during render, for `CloudShell`'s
   * reason: an effect runs after the commit that mounted the button, and the press can come first. It never widens,
   * so a confirmed shell keeps its binding and a refused sign-out keeps its block.
   */
  pendApiOwner(readOwner());
  const t = useTranslations("linkDesktop");
  /** The sign-in door's label is `/login`'s own title. */
  const tl = useTranslations("login");
  /** The settle step's could-not-check sentence is the approval page's. */
  const ta = useTranslations("approve");
  const refusalSentence = useRefusalSentence();
  const { settled, resettle } = useSettledOwner(apiConfigured());

  const [minted, setMinted] = useState<Minted | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Whether the step-up prompt is up. `idle` means it is not. */
  const [phase, setPhase] = useState<Phase>("idle");
  /** Signing in is the remedy: the mint was refused with a dead session or after a verified factor. */
  const [signIn, setSignIn] = useState(false);
  /** A factor landed after the prompt's Cancel and was discarded — no code was minted, and it is said. */
  const [discarded, setDiscarded] = useState(false);

  /** The page can be navigated away from mid-flight; nothing may set state after that. */
  const alive = useRef(true);
  /** Ends a busy wait on unmount, so no mint runs for a page nobody is looking at. */
  const gone = useRef(new AbortController());
  useEffect(() => () => { alive.current = false; gone.current.abort(); }, []);

  /**
   * A BUSY SERVER IS A WAIT, NOT A DEAD END. While `retryBusy` waits out a 503 `db_busy`, the page
   * says so with a countdown and keeps its button live: a press ends the wait and retries now.
   * `retryAt` is when the next ask goes out; `wake` ends the current wait early.
   */
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  const wake = useRef<(() => void) | null>(null);
  const sleepOrPress = (ms: number): Promise<void> => new Promise((resolve) => {
    // The wait is over either way: the retry that follows is in flight, so the button is not live.
    const done = (): void => {
      clearTimeout(timer); wake.current = null;
      if (alive.current) setRetryAt(null);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wake.current = done;
  });
  useEffect(() => {
    if (retryAt === null) return;
    const tick = (): void => setRetryIn(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [retryAt]);

  /** `afterFactor`: this is the retry a verified factor runs, so a second closed window is a sentence. */
  const mint = (afterFactor = false): void => {
    setBusy(true);
    setError(null);
    setSignIn(false);
    setDiscarded(false);
    setPhase("idle");
    void (async () => {
      try {
        // The commitment travels with every mint on this page, including the one retried after a
        // step-up ceremony — a retry that dropped it would silently hand back an UNBOUND code to
        // an app that is still holding a verifier, and the handoff would fail with nothing on
        // either screen saying why.
        // `replaySafe`: a busy mint may have written a code nobody saw; it is one-use, bound to
        // the same challenge and expires unspent, so asking again costs nothing.
        const { code: minted, expiresIn } = await retryBusy(
          () => auth.desktopLink({ challenge: commitment }),
          {
            replaySafe: true,
            signal: gone.current.signal,
            sleep: sleepOrPress,
            onWait: (ms) => {
              if (!alive.current) return;
              setPhase("idle");
              setRetryIn(Math.max(1, Math.ceil(ms / 1000)));
              setRetryAt(Date.now() + ms);
            },
          },
        );
        if (!alive.current) return;
        setMinted({ code: minted, expiresAtMs: Date.now() + expiresIn * 1000 });
        setRemaining(expiresIn);
        setPhase("idle");
      } catch (err) {
        if (!alive.current) return;
        if (isOwnerAbsent(err)) { resettle(); return; }
        const why = gatedRefusal(err, afterFactor);
        if (why === "factor") {
          setPhase("stepup");
        } else if (why === "sign-in") {
          setSignIn(true);
        } else if (isBusy(err)) {
          // The server, never the session: the sign-in is fine and the button is still there.
          setError(t("busyGaveUp"));
        } else {
          setError(refusalSentence(err));
        }
      } finally {
        if (alive.current) { setBusy(false); setRetryAt(null); }
      }
    })();
  };

  /* The countdown, and the removal at zero. One interval, cleared on unmount and whenever a new
     code replaces the old one — a leaked interval here would keep writing state into a page
     somebody has left. */
  useEffect(() => {
    if (!minted) return;
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((minted.expiresAtMs - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) setMinted(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [minted]);

  if (!apiConfigured()) {
    return (
      <Shell title={t("unavailableTitle")}>
        <p className="sub">{t("unavailableBody")}</p>
      </Shell>
    );
  }

  /* Before any press: no full session is the sign-in door; a jar naming somebody else, or a check
     that never answered, is said instead of a button. */
  if (settled.kind === "none") {
    return (
      <Shell title={t("title")}>
        <p className="join-error" role="alert">{t("signInFirst")}</p>
        <div className="join-actions"><Link className="btn" href="/login">{tl("title")}</Link></div>
      </Shell>
    );
  }
  if (settled.kind === "refused" || settled.kind === "unchecked") {
    const said = settled.kind === "refused" ? refusalSentence(settled.refusal) : ta("signInUnchecked");
    return <Shell title={t("title")}><p className="join-error" role="alert">{said}</p></Shell>;
  }
  if (settled.kind === "checking") {
    return <Shell title={t("title")}><p className="sub">{t("working")}</p></Shell>;
  }

  if (phase === "stepup") {
    return (
      <Shell title={t("reauthTitle")}>
        {/* The mint is parked behind the prompt; the verified factor retries it, commitment and all. */}
        <StepUpPrompt
          onVerified={() => mint(true)}
          onCancel={() => setPhase("idle")}
          onDiscarded={() => setDiscarded(true)}
        />
      </Shell>
    );
  }

  /** During a busy wait the button stays pressable and retries now; otherwise it mints. */
  const waiting = retryAt !== null;
  const press = (): void => { if (wake.current) wake.current(); else mint(); };

  return (
    <Shell title={t("title")}>
      <p className="sub">{t("lead")}</p>
      {error ? <p className="join-error" role="alert">{error}</p> : null}
      {waiting ? <p className="join-hint" role="status">{t("busyRetrying", { seconds: retryIn })}</p> : null}
      {/* The check came back after Cancel and was thrown away. Said, because this screen looks
          identical whether a code was minted a second ago or never at all. */}
      {discarded ? <p className="join-hint" role="status">{t("cancelledNothingMinted")}</p> : null}
      {/* A dead session, an unfinished enrolment, or a second refusal after a verified factor:
          `/login` is the remedy, and the app opens this page again afterwards. */}
      {signIn ? (
        <>
          <p className="join-error" role="alert">{t("signInFirst")}</p>
          <div className="join-actions">
            <Link className="btn" href="/login">{tl("title")}</Link>
          </div>
        </>
      ) : null}

      {minted ? (
        <>
          {/* `aria-live` so the code is announced when it appears — the whole page is one value
              a person has to read and carry, and it arrives after a press rather than on load. */}
          <p className="join-secret" aria-live="polite">{minted.code}</p>
          <p className="join-hint">{t("expiresIn", { seconds: remaining })}</p>
          {/* Only for a BOUND code — see this file's header. A plain anchor rather than `Link`:
              `next/link` is a client router and a custom scheme is not a route it can take. */}
          {commitment ? (
            <>
              <div className="join-actions">
                <a className="btn primary" href={deepLink(minted.code)}>{t("openApp")}</a>
              </div>
              {/* The retype steps below stay on screen and stay accurate. A scheme handler can
                  be missing, or claimed by something that does nothing visible, and a page whose
                  only route forward is a button that quietly did not work is a dead end. */}
              <p className="join-hint">{t("openAppFallback")}</p>
            </>
          ) : null}
          <ol className="join-hint">
            <li>{t("step1")}</li>
            <li>{t("step2")}</li>
          </ol>
          <div className="join-actions">
            <Button onClick={press} disabled={busy && !waiting}>
              {busy && !waiting ? t("working") : t("again")}
            </Button>
          </div>
        </>
      ) : (
        <div className="join-actions">
          <Button variant="primary" onClick={press} disabled={busy && !waiting}>
            {busy && !waiting ? t("working") : t("mint")}
          </Button>
        </div>
      )}

      <p className="join-hint">{t("safety")}</p>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTranslations("linkDesktop");
  return (
    <div className="login">
      <div className="login-card join-card">
        {/* oh | mail, split so `.wordmark em` can carry accent-ink; the rendered
            text is pinned by a suite. */}
        <span className="wordmark"><b><em>oh</em>mail</b></span>
        <h1>{title}</h1>
        {children}
      </div>
      <p className="login-foot">
        <Icon name="shield" /> {t("footer")}
      </p>
    </div>
  );
}
