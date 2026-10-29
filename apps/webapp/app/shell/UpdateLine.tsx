"use client";

/**
 * A NEWER OHMAIL, AS ONE QUIET LINE AT THE FOOT OF THE RAIL, above Command: a mark, a sentence, a
 * verb and ×. In a tab the newer thing is a build the origin already serves and the verb reloads;
 * on the desktop it is a release the native process verified, ready, downloading or failed. The
 * line knows neither door: it reads the one offer in `app-update.ts` and calls the callback it
 * carries, so the shared shell can never name a feed, a version or an install.
 */

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { Icon } from "@ohmail/ui";

import {
  currentUpdateOffer,
  currentVersion,
  flushBeforeRestart,
  putUpdateAway,
  restartHold,
  setSendWaits,
  subscribeRestartHold,
  subscribeUpdateOffer,
  subscribeVersion,
  type RestartHold,
  type UpdateOffer,
} from "./app-update";
import { COMPOSE_SEND_KEY, type MailSendApi, type SendLineItem, type SendPhase } from "./mail-send";

/** Follow the one offer: adopt what is standing at mount, then listen. */
export function useUpdateOffer(): UpdateOffer | null {
  /* Not the current value as the initial state: a server render has no offer and adopting one
     during render would be a hydration mismatch. */
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  useEffect(() => {
    setOffer(currentUpdateOffer());
    return subscribeUpdateOffer(setOffer);
  }, []);
  return offer;
}

/** What holds a restart: a waiting send, an editor's files, or nothing (`app-update.ts`). */
export function useRestartHold(): RestartHold {
  return useSyncExternalStore(subscribeRestartHold, restartHold, () => null);
}

/** The version the desktop's shell runs; null in a tab. */
export function useRunningVersion(): string | null {
  return useSyncExternalStore(subscribeVersion, currentVersion, () => null);
}

export function UpdateLine() {
  const t = useTranslations("update");
  const offer = useUpdateOffer();
  const hold = useRestartHold();
  const running = useRunningVersion();
  const tipId = useId();
  const pressing = useRef(false);
  if (offer === null) return null;

  const version = offer.version ?? "";
  // A restart while a send waits or a draft holds files is held by the shell too; the line says
  // which and presses nothing.
  const held = offer.kind === "ready" && hold !== null;
  const [why, whyTitle] =
    hold === "files"
      ? [t("lineAfterFiles"), t("lineAfterFilesTitle")]
      : [t("lineAfterSend"), t("lineAfterSendTitle")];
  const text =
    offer.kind === "reload"
      ? t("lineReload")
      : offer.kind === "downloading"
        ? t("lineDownloading", { version })
        : offer.kind === "failed"
          ? t(offer.failed === "install" ? "lineInstallFailed" : "lineCheckFailed")
          : t("lineReady", { version });
  const verb =
    offer.kind === "reload" ? t("lineReloadAction") : offer.kind === "failed" ? t("lineRetry") : t("lineRestart");
  const mark =
    offer.kind === "downloading" || offer.kind === "failed" ? "upd-mark hollow" : held ? "upd-mark wait" : "upd-mark";

  /* An open editor's unsaved words are written first; its files hold the restart instead. */
  const press = async (act: () => void): Promise<void> => {
    if (pressing.current) return;
    pressing.current = true;
    try {
      await flushBeforeRestart();
      act();
    } finally {
      pressing.current = false;
    }
  };

  return (
    <div className="upd-line" role="status" data-s={held ? "waiting" : offer.kind}>
      <span className="ul-text" title={running !== null ? t("lineVersion", { version: running }) : undefined}>
        <span className={mark} aria-hidden="true" />
        {text}
      </span>
      {offer.kind === "downloading" ? (
        <span className="rs-track upd-track" aria-hidden="true">
          <i />
        </span>
      ) : (
        <span className="ul-acts">
          {offer.act ? (
            <button
              type="button"
              className="ul-do"
              aria-disabled={held || undefined}
              aria-describedby={offer.kind === "ready" && !held ? tipId : undefined}
              title={held ? whyTitle : undefined}
              onClick={held ? undefined : () => void press(offer.act!)}
            >
              {verb}
            </button>
          ) : null}
          <button type="button" className="ul-x" aria-label={t("lineLater")} title={t("lineLater")} onClick={putUpdateAway}>
            <Icon name="x" />
          </button>
        </span>
      )}
      {offer.kind === "ready" && !held ? (
        <span className="ul-tip" id={tipId} role="tooltip">
          {t("lineRestartTip")}
        </span>
      ) : null}
      {held ? <span className="upd-sub">{why}</span> : null}
    </div>
  );
}

/** The ≡'s dot below 1024px: something on the line to press while the drawer is closed. */
export function UpdateDot() {
  const offer = useUpdateOffer();
  if (offer === null || offer.kind === "downloading") return null;
  return <span className="upd-dot" aria-hidden="true" />;
}

/** A send waits: a queued or sending item on the sending line, or the composer's send on its way. */
export function sendWaitsOf(items: readonly SendLineItem[], composePhase: SendPhase): boolean {
  if (composePhase === "sending" || composePhase === "queued") return true;
  return items.some((item) => item.state === "sending" || item.state === "queued");
}

/** Keeps `app-update.ts`'s "a send waits" true to the shell's sends while it is mounted. */
export function SendWaitsRelay({ api }: {
  api: Pick<MailSendApi, "line" | "subscribeLine" | "lineVersion" | "stateOf">;
}) {
  useSyncExternalStore(api.subscribeLine, api.lineVersion, api.lineVersion);
  const waits = sendWaitsOf(api.line(), api.stateOf(COMPOSE_SEND_KEY).phase);
  useEffect(() => {
    setSendWaits(waits);
  }, [waits]);
  useEffect(() => () => setSendWaits(false), []);
  return null;
}
