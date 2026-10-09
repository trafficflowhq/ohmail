"use client";

import { useCallback, useEffect, useState } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { MARKETING_PATHS } from "../../../routes.mjs";
import {
  CONSENT_DENIED, CONSENT_GRANTED, CONSENT_KEY, CONSENT_REOPEN_EVENT, gtagUrl,
} from "../../../analytics.mjs";
import { localStorageDoor } from "../../shell/durable";
import { beginPageView, observeSections, reportPress, reportToggle } from "../site-events";

/**
 * The website's visit statistics: a one-line notice, and Google's tag only after Accept. Mounted by
 * the marketing root only when the build carries an id, and rendered only on `MARKETING_PATHS` (the
 * same list the CSP widens for). Before a choice nothing is loaded and no press is reported; ads
 * signals are denied in every state. What is reported, and with which labels, is `../site-events.ts`.
 */

const DOOR = localStorageDoor("analytics");

type Choice = typeof CONSENT_GRANTED | typeof CONSENT_DENIED;

type Gtag = (...args: unknown[]) => void;
declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

function readChoice(): Choice | null {
  const v = DOOR.get(CONSENT_KEY);
  return v === CONSENT_GRANTED || v === CONSENT_DENIED ? v : null;
}

/** Consent Mode v2, set here and nowhere else: ads always denied, statistics only on Accept. */
function consentState(granted: boolean): Record<string, "granted" | "denied"> {
  return {
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
    analytics_storage: granted ? "granted" : "denied",
  };
}

function startGtag(id: string): void {
  (window as unknown as Record<string, boolean>)[`ga-disable-${id}`] = false;
  if (window.gtag) {
    window.gtag("consent", "update", consentState(true));
    return;
  }
  window.dataLayer = window.dataLayer ?? [];
  // gtag.js reads `arguments` objects off the queue; a rest array is not the same shape.
  window.gtag = function gtag() {
    // eslint-disable-next-line prefer-rest-params
    window.dataLayer!.push(arguments);
  };
  window.gtag("consent", "default", consentState(true));
  window.gtag("js", new Date());
  window.gtag("config", id, {
    allow_google_signals: false,
    allow_ad_personalization_signals: false,
    cookie_domain: "none",
  });
}

/** After a Decline that follows an Accept: stop sending and drop the tag's cookies. */
function stopGtag(id: string): void {
  (window as unknown as Record<string, boolean>)[`ga-disable-${id}`] = true;
  window.gtag?.("consent", "update", consentState(false));
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0]?.trim() ?? "";
    if (name === "_ga" || name.startsWith("_ga_")) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

export function Analytics({ id }: { id: string }) {
  const pathname = usePathname();
  const t = useTranslations("analytics");
  /* "unknown" until mounted: the server render and the first client render both show the
     notice, and the pre-paint stamp in the marketing root hides it for a decided browser. */
  const [choice, setChoice] = useState<Choice | null | "unknown">("unknown");
  const onSite = MARKETING_PATHS.includes(pathname);

  useEffect(() => {
    if (!onSite) return;
    setChoice(readChoice());
    const reopen = () => {
      delete document.documentElement.dataset.analytics;
      setChoice(null);
    };
    window.addEventListener(CONSENT_REOPEN_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_REOPEN_EVENT, reopen);
  }, [onSite]);

  const granted = onSite && choice === CONSENT_GRANTED;
  useEffect(() => {
    if (!granted) return;
    startGtag(id);
    beginPageView();
    const onClick = (e: MouseEvent) => reportPress(e.target);
    const onToggle = (e: Event) => reportToggle(e.target);
    document.addEventListener("click", onClick, true);
    document.addEventListener("toggle", onToggle, true);
    const stopSections = observeSections(document);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("toggle", onToggle, true);
      stopSections();
    };
  }, [granted, id, pathname]);

  const decide = useCallback(
    (next: Choice) => {
      DOOR.set(CONSENT_KEY, next);
      document.documentElement.dataset.analytics = next;
      if (next === CONSENT_DENIED) stopGtag(id);
      setChoice(next);
    },
    [id],
  );

  if (!onSite) return null;
  return (
    <>
      {granted ? <Script id="ohmail-gtag" src={gtagUrl(id)} strategy="afterInteractive" /> : null}
      {choice === null || choice === "unknown" ? (
        <div className="l-consent" role="region" aria-label={t("label")}>
          <p className="l-consent-text">
            {t("notice")}{" "}
            <a href="/privacy#analytics">{t("more")}</a>
          </p>
          <div className="l-consent-actions">
            <button type="button" className="btn primary" onClick={() => decide(CONSENT_GRANTED)}>
              {t("accept")}
            </button>
            <button type="button" className="btn" onClick={() => decide(CONSENT_DENIED)}>
              {t("decline")}
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** "Change your choice": reopens the notice wherever it is mounted on this page. */
export function AnalyticsChoiceButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="l-consent-change"
      onClick={() => window.dispatchEvent(new Event(CONSENT_REOPEN_EVENT))}
    >
      {label}
    </button>
  );
}
