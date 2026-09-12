"use client";

/**
 * "Sign the app in?" — the confirmation in front of the native authorization.
 *
 * Nothing is minted on load: the page READS what is being asked for and waits, and the press
 * carries the session's CSRF token, which a request composed somewhere else cannot produce. The
 * address arrives masked — this screen can be shared or photographed. The countdown is the
 * SERVER's number (`expiresIn`); a literal would be a second copy of `oauthAuthorizeRequestTtlMs`
 * that drifts. At zero the buttons go rather than grey out.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Icon } from "@ohmail/ui";
import { pendApiOwner } from "../../api-client";
import { readOwner } from "../../shell/owner-cookie";
import {
  ApiError, apiConfigured, auth, messageOf, type AuthorizeRequestDTO,
} from "../../api-client";

/** The names this deployment has words for. Anything else is shown as the client said it. */
const KNOWN_CLIENTS = new Set(["tf-macos"]);

export function AuthorizeDesktopScreen({ request = "" }: { request?: string }) {
  /**
   * THIS PAGE ACTS ON AN ACCOUNT, so it is not a public surface — `/link-desktop`'s reasoning
   * verbatim: a fresh load left the Cloud client `public`, which permits every request, and the
   * press here authorizes a four-hundred-day credential. `pendApiOwner` during render, because an
   * effect runs after the commit that mounted the button and the press can come first.
   */
  pendApiOwner(readOwner());
  const t = useTranslations("authorizeDesktop");

  const [asked, setAsked] = useState<AuthorizeRequestDTO | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** The page can be navigated away from mid-flight; nothing may set state after that. */
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /* Read what is being asked for. A read and not a claim — it spends nothing, so a reload or a
     restored tab does not destroy the ceremony the person came here for. */
  useEffect(() => {
    if (!request || !apiConfigured()) { setLoading(false); return; }
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
        setError(err instanceof ApiError && err.status === 400 ? t("expired") : messageOf(err));
      } finally {
        if (alive.current) setLoading(false);
      }
    })();
    return () => ctl.abort();
  }, [request, t]);

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

  const confirm = (): void => {
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
        setError(err instanceof ApiError && err.status === 400 ? t("expired") : messageOf(err));
        setAsked(null);
      } finally {
        if (alive.current) setBusy(false);
      }
    })();
  };

  if (!apiConfigured()) {
    return (
      <Shell title={t("unavailableTitle")}>
        <p className="sub">{t("unavailableBody")}</p>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell title={t("doneTitle")}>
        <p className="sub">{t("doneBody")}</p>
      </Shell>
    );
  }

  if (loading) {
    return (
      <Shell title={t("title")}>
        <p className="sub">{t("working")}</p>
      </Shell>
    );
  }

  if (!asked) {
    return (
      <Shell title={t("expiredTitle")}>
        <p className="join-error" role="alert">{error ?? t("expired")}</p>
        <p className="join-hint">{t("expiredHint")}</p>
      </Shell>
    );
  }

  const appName = KNOWN_CLIENTS.has(asked.clientId) ? t(`client.${asked.clientId}`) : asked.clientId;

  return (
    <Shell title={t("title")}>
      <p className="sub">{t("lead", { app: appName })}</p>
      {error ? <p className="join-error" role="alert">{error}</p> : null}

      {/* WHICH ACCOUNT, said once and masked. The person is being asked to hand out access to
          this mailbox, and the one fact they need to check is that it is the right one. */}
      <p className="join-secret" aria-live="polite">{asked.address}</p>

      <ul className="join-hint">
        <li>{t("grantsMail")}</li>
        <li>{t("grantsLong")}</li>
        <li>{t("grantsRevoke")}</li>
      </ul>

      <div className="join-actions">
        <Button variant="primary" onClick={confirm} disabled={busy}>
          {busy ? t("working") : t("confirm")}
        </Button>
      </div>

      <p className="join-hint">{t("expiresIn", { seconds: remaining })}</p>
      <p className="join-hint">{t("safety")}</p>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTranslations("authorizeDesktop");
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
