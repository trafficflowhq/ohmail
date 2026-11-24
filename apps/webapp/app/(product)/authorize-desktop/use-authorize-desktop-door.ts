"use client";

/**
 * "Sign the app in?" — the ceremony in front of the native authorization, cut from `AuthorizeDesktopScreen` word for
 * word. Nothing is minted on load: the page READS what is being asked for and waits, and the press carries the
 * session's CSRF token. The countdown is the SERVER's number (`expiresIn`); at zero the request goes. It settles whose
 * browser this is first (`approve/settle-owner.ts`); with no session the handle is dead, so the remedy is signing in.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { pendApiOwner } from "../../api-client";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import {
  ApiError, apiConfigured, auth, type AuthorizeRequestDTO,
} from "../../api-client";
import { useRefusalSentence } from "../refusal-sentence";
import { useSettledOwner, type Settled } from "../approve/settle-owner";

/** What the authorization's ceremony holds and does: exactly what its page reads. */
export interface AuthorizeDesktopCeremony {
  settled: Settled;
  asked: AuthorizeRequestDTO | null;
  remaining: number;
  busy: boolean;
  done: boolean;
  error: string | null;
  loading: boolean;
  /** The confirm met a closed step-up window: the factor is asked in place. */
  stepUp: boolean;
  confirm(verified?: boolean): void;
  /** The step-up's answers: the confirm run once more, the prompt closed, a late factor said, the marker gone. */
  stepUpVerified(): void;
  stepUpCancelled(): void;
  stepUpDiscarded(): void;
  stepUpOwnerAbsent(): void;
}

export function useAuthorizeDesktopDoor(request: string): AuthorizeDesktopCeremony {
  /**
   * THIS PAGE ACTS ON AN ACCOUNT, so it is not a public surface — `/link-desktop`'s reasoning
   * verbatim: a fresh load left the Cloud client `public`, which permits every request, and the
   * press here authorizes a four-hundred-day credential. `pendApiOwner` during render, because an
   * effect runs after the commit that mounted the button and the press can come first.
   */
  pendApiOwner(readOwner());
  const t = useTranslations("authorizeDesktop");
  const td = useTranslations("devices");
  const refusalSentence = useRefusalSentence();
  const { settled, resettle } = useSettledOwner(Boolean(request) && apiConfigured());

  const [asked, setAsked] = useState<AuthorizeRequestDTO | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** The confirm met a closed step-up window: the factor is asked in place, and the confirm runs once more. */
  const [stepUp, setStepUp] = useState(false);

  /** The page can be navigated away from mid-flight; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /* Read what is being asked for. A read and not a claim — it spends nothing, so a reload or a
     restored tab does not destroy the ceremony the person came here for. */
  useEffect(() => {
    if (!request || !apiConfigured()) { setLoading(false); return; }
    if (settled.kind !== "owner") return;
    const ctl = new AbortController();
    void (async () => {
      try {
        const dto = await auth.authorizeRequest(request, { signal: ctl.signal });
        if (!alive.current) return;
        setAsked(dto);
        setRemaining(dto.expiresIn);
      } catch (err) {
        if (!alive.current || ctl.signal.aborted) return;
        // 400 is the one answer every dead handle gets — unknown, expired, spent or another
        // session's. They are deliberately the same on the server, so they are one sentence here.
        // Anything else through the one renderer, like the rest of this family.
        setError(err instanceof ApiError && err.status === 400 ? t("expired") : refusalSentence(err));
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
    return () => ctl.abort();
  }, [request, settled, t, refusalSentence]);

  /* The countdown, and the withdrawal at zero. One interval, cleared on unmount — a leaked one
     here would keep writing state into a page somebody has left. */
  useEffect(() => {
    if (!asked || done) return;
    const started = Date.now();
    const ends = started + asked.expiresIn * 1000;
    const tick = (): void => {
      const left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) { setAsked(null); setError(t("expired")); }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [asked, done, t]);

  const confirm = (verified = false): void => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const { redirect } = await auth.confirmAuthorize(request);
        if (!alive.current) return;
        setDone(true);
        // The client's own address, which is a custom scheme — `window.location` and not
        // `next/link`, which is a client router and cannot take one. The server chose this
        // target from its own registry; nothing the browser typed reaches it.
        window.location.href = redirect;
      } catch (err) {
        if (!alive.current) return;
        if (err instanceof ApiError && err.status === 403 && err.code === "step_up_required") {
          if (verified) setError(td("stepUpExpired"));
          else setStepUp(true);
          return;
        }
        setError(err instanceof ApiError && err.status === 400 ? t("expired") : refusalSentence(err));
        setAsked(null);
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  };

  return {
    settled, asked, remaining, busy, done, error, loading, stepUp, confirm,
    stepUpVerified: () => { setStepUp(false); confirm(true); },
    stepUpCancelled: () => setStepUp(false),
    stepUpDiscarded: () => { setStepUp(false); setError(td("stepUpCancelledNothingRan")); },
    stepUpOwnerAbsent: () => { setStepUp(false); resettle(); },
  };
}
