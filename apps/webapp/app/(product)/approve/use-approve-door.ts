"use client";

/**
 * "Sign in ohmail on this computer?" — the ceremony in front of a desktop's sign-in, cut from `ApproveScreen` word
 * for word: the settle step first, then the request READ and waited on; the press carries the session's CSRF token,
 * and the route is step-up gated, so a stale factor is asked for in place and the confirm retried the moment it
 * verifies. A browser with no full session goes through the ordinary sign-in and comes back by the request id. A busy
 * server is a wait with Confirm still live. The countdown is the server's `expiresIn`.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { pendApiOwner } from "../../api-client";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { ApiError, SESSION_UNCHECKED, apiConfigured, auth, type DesktopApprovalDTO } from "../../api-client";
import { isBusy, retryBusy } from "../../retry-busy";
import { useRefusalSentence } from "../refusal-sentence";
import { rememberApprovalRequest, type ApprovalEntry } from "./approval-return";
import { isOwnerAbsent, useSettledOwner, type Settled } from "./settle-owner";
import { sessionIsDead } from "@ohmail/app-logic/session/session-truth";

export type Phase = "idle" | "stepUp" | "done" | "denied";

/** What the approval's ceremony holds and does: exactly what its page reads. */
export interface ApproveCeremony {
  settled: Settled;
  asked: DesktopApprovalDTO | null;
  loading: boolean;
  remaining: number;
  phase: Phase;
  busy: boolean;
  error: string | null;
  note: string | null;
  /** The account the confirm binds, while the page is settled on it. */
  named: string | null;
  /** A busy server's wait: when the next ask goes out, and the seconds to it. */
  retryAt: number | null;
  retryIn: number;
  confirm(): void;
  deny(): void;
  settleAgain(): void;
  /** The step-up's three answers: the confirm retried, the prompt closed, a late factor thrown away. */
  stepUpVerified(): void;
  stepUpCancelled(): void;
  stepUpDiscarded(): void;
}

function expiryKey(platform: string | undefined, phone: boolean | undefined) {
  if (platform === "Android" || platform === "iOS" || phone) return "expiredPhone";
  return "expired";
}

export function useApproveDoor(request: string, entry: ApprovalEntry): ApproveCeremony {
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
      if (err.code === "approval_expired") return t(expiryKey(asked?.platform, entry.phone));
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
      rememberApprovalRequest(request, Date.now(), entry);
      router.replace("/login");
      return;
    }
    setError(t("signInUnchecked"));
  };

  /* No full session here, an enrolment-only one included: the ordinary sign-in, and back. */
  useEffect(() => {
    if (settled.kind === "none") {
      rememberApprovalRequest(request, Date.now(), entry);
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
      if (left === 0) { setAsked(null); setError(t(expiryKey(asked.platform, entry.phone))); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [asked, phase, t, entry.phone]);

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

  return {
    settled, asked, loading, remaining, phase, busy, error, note, named, retryAt, retryIn, confirm, deny, settleAgain,
    stepUpVerified: () => { setPhase("idle"); confirm(); },
    stepUpCancelled: () => setPhase("idle"),
    stepUpDiscarded: () => { setPhase("idle"); setNote(t("stepUpDiscarded")); },
  };
}
