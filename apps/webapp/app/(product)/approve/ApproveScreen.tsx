"use client";

/**
 * "Sign in ohmail on this computer?" — the one confirm in front of a desktop's sign-in.
 *
 * The page READS the request and waits; the press carries the session's CSRF token, and the
 * route is step-up gated, so a stale factor is asked for inline (a passkey or one code) and the
 * confirm retried the moment it verifies — never the password ceremony. A signed-out browser
 * goes through the ordinary sign-in and comes back by the request id. A busy server is a wait
 * with Confirm still live, never a dead end. The countdown is the server's `expiresIn`.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import { pendApiOwner } from "../../api-client";
import { readOwner } from "../../shell/owner-cookie";
import { ApiError, apiConfigured, auth, messageOf, type DesktopApprovalDTO } from "../../api-client";
import { isBusy, retryBusy } from "../../retry-busy";
import { StepUpPrompt } from "../mailbox/StepUpPrompt";
import { rememberApprovalRequest } from "./approval-return";

type Phase = "idle" | "stepUp" | "done" | "denied";

export function ApproveScreen({ request = "" }: { request?: string }) {
  /* THIS PAGE ACTS ON AN ACCOUNT — `/link-desktop`'s reason: the account is pended during render
     so a press that comes before any effect still asks as the account this browser is bound to. */
  pendApiOwner(readOwner());
  const t = useTranslations("approve");
  const router = useRouter();

  const [asked, setAsked] = useState<DesktopApprovalDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [remaining, setRemaining] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
      if (isBusy(err)) return t("busyGaveUp");
    }
    return messageOf(err);
  };

  /** No session in this browser: sign in the ordinary way and come back to this request. */
  const signInFirst = (): void => {
    rememberApprovalRequest(request);
    router.replace("/login");
  };

  useEffect(() => {
    if (!request || !apiConfigured()) { setLoading(false); return; }
    const ctl = new AbortController();
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
        if (err instanceof ApiError && err.status === 401) { signInFirst(); return; }
        setError(sentenceFor(err));
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read per request id
  }, [request]);

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
          signInFirst();
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
        if (err instanceof ApiError && err.status === 401) signInFirst();
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
  if (loading) {
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

      {phase === "stepUp" ? (
        <StepUpPrompt
          onVerified={() => { setPhase("idle"); confirm(); }}
          onCancel={() => setPhase("idle")}
          onDiscarded={() => { setPhase("idle"); setNote(t("stepUpDiscarded")); }}
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

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTranslations("approve");
  return (
    <div className="login">
      <div className="login-card join-card">
        <span className="wordmark"><b><em>oh</em>mail</b></span>
        <h1>{title}</h1>
        {children}
      </div>
      <p className="login-foot"><Icon name="shield" /> {t("footer")}</p>
    </div>
  );
}
