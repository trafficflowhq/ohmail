"use client";

/**
 * "Sign in ohmail on this computer?" — the one confirm in front of a desktop's sign-in.
 *
 * The page settles whose browser this is first (`settle-owner.ts`), then READS the request and
 * waits; the press carries the session's CSRF token, and the route is step-up gated, so a stale
 * factor is asked for inline (a passkey or one code) and the confirm retried the moment it
 * verifies — never the password ceremony. A browser with no full session goes through the
 * ordinary sign-in and comes back by the request id. A busy server is a wait with Confirm still
 * live, never a dead end. The countdown is the server's `expiresIn`.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import { pendApiOwner } from "../../api-client";
import { readOwner } from "../../shell/owner-cookie";
import { ApiError, SESSION_UNCHECKED, apiConfigured, auth, type DesktopApprovalDTO } from "../../api-client";
import { isBusy, retryBusy } from "../../retry-busy";
import { StepUpPrompt } from "../mailbox/StepUpPrompt";
import { useRefusalSentence } from "../refusal-sentence";
import { rememberApprovalRequest } from "./approval-return";
import { isOwnerAbsent, useSettledOwner } from "./settle-owner";
import { sessionIsDead } from "../../shell/session-truth";

type Phase = "idle" | "stepUp" | "done" | "denied";

export function ApproveScreen({ request = "" }: { request?: string }) {
  /* THIS PAGE ACTS ON AN ACCOUNT — `/link-desktop`'s reason: the account is pended during render
     so a press that comes before any effect still asks as the account this browser is bound to. */
  pendApiOwner(readOwner());
  const t = useTranslations("approve");
  const router = useRouter();
  const refusalSentence = useRefusalSentence();
  /* Nothing is asked for until this says whose browser it is; see `settle-owner.ts`. */
  const { settled, resettle } = useSettledOwner(Boolean(request) && apiConfigured());

  const [asked, setAsked] = useState<DesktopApprovalDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [remaining, setRemaining] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /* THE ACCOUNT THE CONFIRM BINDS — this browser's own session, shown plainly as Settings shows
     it, and only while the page is settled on that same account. Null until read, and a failed
     read says nothing rather than guessing. */
  const [account, setAccount] = useState<{ accountId: string; email: string } | null>(null);
  const named = settled.kind === "owner" && account?.accountId === settled.accountId ? account.email : null;
  /* Settling again drops the request it read — a read that then fails must not leave it, Confirm and
     all — and a confirm parked behind the step-up prompt, which was pressed for the page before. */
  const settleAgain = (): void => { setPhase("idle"); setAsked(null); resettle(); };

  const alive = useRef(true);
  const gone = useRef(new AbortController());
  useEffect(() => () => { alive.current = false; gone.current.abort(); }, []);

  /* The busy wait, `/link-desktop`'s shape: a countdown, and Confirm stays live — a press ends
     the wait and retries now. */
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [retryIn, setRetryIn] = useState(0);
  const wake = useRef<(() => void) | null>(null);
  const sleepOrPress = (ms: number): Promise<void> => new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer); wake.current = null;
      if (alive.current) setRetryAt(null);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wake.current = done;
  });
  const onWait = (ms: number): void => {
    if (!alive.current) return;
    setRetryIn(Math.max(1, Math.ceil(ms / 1000)));
    setRetryAt(Date.now() + ms);
  };
  useEffect(() => {
    if (retryAt === null) return;
    const tick = (): void => setRetryIn(Math.max(1, Math.ceil((retryAt - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [retryAt]);

  /** The sentence for a refusal: the three request states by code, the server, never the session. */
  const sentenceFor = (err: unknown): string => {
    if (err instanceof ApiError) {
      if (err.code === "approval_expired") return t("expired");
      if (err.code === "approval_used") return t("used");
      if (err.code === "approval_denied") return t("denied");
      if (err.status === 404) return t("notFound");
      // The renewal met a fault: the session is unread, and a reload asks again.
      if (err.code === SESSION_UNCHECKED) return t("signInUnchecked");
      if (isBusy(err)) return t("busyGaveUp");
    }
    return refusalSentence(err);
  };

  /* No session in this browser: sign in the ordinary way and come back to this request — only
     once the refresh door has CONFIRMED the session ended. A refresh that met a busy or
     unreachable server leaves the browser signed in, and the page says so instead. */
  const onUnauthorized = (): void => {
    if (sessionIsDead()) {
      rememberApprovalRequest(request);
      router.replace("/login");
      return;
    }
    setError(t("signInUnchecked"));
  };

  /* No full session here, an enrolment-only one included: the ordinary sign-in, and back. */
  useEffect(() => {
    if (settled.kind === "none") {
      rememberApprovalRequest(request);
      router.replace("/login");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the verdict is the trigger
  }, [settled]);

  useEffect(() => {
    if (!request || !apiConfigured()) { setLoading(false); return; }
    if (settled.kind !== "owner") return;
    const ctl = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const dto = await retryBusy(() => auth.desktopApproval(request, { signal: ctl.signal }), {
          signal: ctl.signal, sleep: sleepOrPress, onWait,
        });
        if (!alive.current) return;
        setAsked(dto);
        setRemaining(dto.expiresIn);
        if (dto.approved) setPhase("done");
      } catch (err) {
        if (!alive.current || ctl.signal.aborted) return;
        if (isOwnerAbsent(err)) { settleAgain(); return; }
        if (err instanceof ApiError && err.status === 401) { onUnauthorized(); return; }
        setError(sentenceFor(err));
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read per request id and per settle
  }, [request, settled]);

  useEffect(() => {
    if (settled.kind !== "owner") return;
    void auth.session().then(
      ({ user }) => { if (alive.current && user.email) setAccount({ accountId: user.accountId, email: user.email }); },
      () => { /* no line: the confirm still binds this session, whatever it is called */ },
    );
  }, [settled]);

  /* The countdown, and the withdrawal at zero — the buttons go rather than grey out. */
  useEffect(() => {
    if (!asked || phase === "done" || phase === "denied") return;
    const ends = Date.now() + asked.expiresIn * 1000;
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) { setAsked(null); setError(t("expired")); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [asked, phase, t]);

  const confirm = (): void => {
    if (wake.current) { wake.current(); return; }
    setBusy(true);
    setError(null);
    setNote(null);
    void (async () => {
      try {
        // A second confirm of one request is the same answer, so a busy retry is harmless.
        await retryBusy(() => auth.confirmDesktopApproval(request), {
          replaySafe: true, signal: gone.current.signal, sleep: sleepOrPress, onWait,
        });
        if (alive.current) setPhase("done");
      } catch (err) {
        if (!alive.current) return;
        if (err instanceof ApiError && err.status === 403 && err.code === "step_up_required") {
          setPhase("stepUp");
        } else if (err instanceof ApiError && err.status === 401) {
          onUnauthorized();
        } else if (isOwnerAbsent(err)) {
          settleAgain();
        } else {
          setError(sentenceFor(err));
          if (err instanceof ApiError && (err.status === 410 || err.status === 404)) setAsked(null);
        }
      } finally {
        if (alive.current) { setBusy(false); setRetryAt(null); }
      }
    })();
  };

  const deny = (): void => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        await retryBusy(() => auth.denyDesktopApproval(request), {
          replaySafe: true, signal: gone.current.signal, sleep: sleepOrPress, onWait,
        });
        if (alive.current) setPhase("denied");
      } catch (err) {
        if (!alive.current) return;
        if (err instanceof ApiError && err.status === 401) onUnauthorized();
        else if (isOwnerAbsent(err)) settleAgain();
        else setError(sentenceFor(err));
      } finally {
        if (alive.current) { setBusy(false); setRetryAt(null); }
      }
    })();
  };

  if (!apiConfigured()) {
    return <Shell title={t("unavailableTitle")}><p className="sub">{t("unavailableBody")}</p></Shell>;
  }
  if (!request) {
    return <Shell title={t("title")}><p className="join-hint">{t("missing")}</p></Shell>;
  }
  if (phase === "done") {
    return <Shell title={t("doneTitle")}><p className="sub">{t("doneBody")}</p></Shell>;
  }
  if (phase === "denied") {
    return <Shell title={t("deniedTitle")}><p className="sub">{t("deniedBody")}</p></Shell>;
  }
  if (settled.kind === "refused" || settled.kind === "unchecked") {
    const said = settled.kind === "refused" ? refusalSentence(settled.refusal) : t("signInUnchecked");
    return <Shell title={t("title")}><p className="join-error" role="alert">{said}</p></Shell>;
  }
  if (loading || settled.kind !== "owner") {
    return (
      <Shell title={t("title")}>
        {retryAt !== null ? <p className="join-hint" role="status">{t("busyRetrying", { seconds: retryIn })}</p> : null}
        <p className="sub">{t("working")}</p>
      </Shell>
    );
  }
  if (!asked) {
    return (
      <Shell title={t("title")}>
        <p className="join-error" role="alert">{error ?? t("expired")}</p>
      </Shell>
    );
  }

  const minutes = Math.floor(Math.max(0, Date.now() - Date.parse(asked.requestedAt)) / 60_000);
  const when = asked.ipClass
    ? (minutes < 1 ? t("requestedJustNow", { network: asked.ipClass }) : t("requestedMinutesAgo", { minutes, network: asked.ipClass }))
    : (minutes < 1 ? t("requestedJustNowNoNetwork") : t("requestedMinutesAgoNoNetwork", { minutes }));
  const waiting = retryAt !== null;

  return (
    <Shell title={t("title")}>
      <p className="sub">{t("lead")}</p>
      {error ? <p className="join-error" role="alert">{error}</p> : null}
      {note ? <p className="join-hint" role="status">{note}</p> : null}
      {waiting ? <p className="join-hint" role="status">{t("busyRetrying", { seconds: retryIn })}</p> : null}

      {/* WHICH COMPUTER, in the words it gave for itself, and where it asked from — a network
          class, never an address — so a request somebody else started reads as foreign. */}
      <p className="join-secret" data-testid="approve-label">{asked.label || t("unnamed")}</p>
      <ul className="join-hint">
        {asked.platform ? <li>{asked.platform}</li> : null}
        <li>{when}</li>
      </ul>
      {/* The server compared the computer's network with this browser's. Only `different` draws the
          line: an unknown or missing answer says nothing rather than guess. */}
      {asked.network === "different" ? (
        <p className="join-note" role="note" data-testid="approve-network">{t("otherNetwork")}</p>
      ) : null}
      {named ? <p className="join-hint" data-testid="approve-account">{t("signsInTo", { email: named })}</p> : null}

      {phase === "stepUp" ? (
        <StepUpPrompt
          onVerified={() => { setPhase("idle"); confirm(); }}
          onCancel={() => setPhase("idle")}
          onDiscarded={() => { setPhase("idle"); setNote(t("stepUpDiscarded")); }}
          onOwnerAbsent={settleAgain}
        />
      ) : (
        <div className="join-actions">
          <Button variant="primary" onClick={confirm} disabled={busy && !waiting}>
            {busy && !waiting ? t("working") : t("confirm")}
          </Button>
          <Button variant="ghost" onClick={deny} disabled={busy}>{t("deny")}</Button>
        </div>
      )}

      <p className="join-hint">{t("expiresIn", { seconds: remaining })}</p>
    </Shell>
  );
}

/**
 * A self-hosted server mounts no browser approval (`routes/desktop-approval.ts` is the hosted
 * table's alone): the desktop asks only the hosted service, so a link here was made by somebody
 * else. The page says so and nothing more: no settle, no read, no kept request, no footer.
 */
export function ApproveNotOffered() {
  const t = useTranslations("approve");
  return <Shell title={t("unavailableTitle")} foot={false}><p className="sub">{t("notOffered")}</p></Shell>;
}

function Shell({ title, children, foot = true }: { title: string; children: React.ReactNode; foot?: boolean }) {
  const t = useTranslations("approve");
  return (
    <div className="login">
      <div className="login-card join-card">
        <span className="wordmark"><b><em>oh</em>mail</b></span>
        <h1>{title}</h1>
        {children}
      </div>
      {foot ? <p className="login-foot"><Icon name="shield" /> {t("footer")}</p> : null}
    </div>
  );
}
