"use client";

/**
 * THE UPDATE NOTICE: a newer ohmail, said in the one notice slot with its one press. Moved word for word from the
 * web shell's feed (`todays-feeds.tsx`, `UpdateLine.tsx`): in a tab the newer thing is a build the origin already
 * serves and the verb reloads; on the desktop it is a release the native process verified. The notice knows neither
 * door: it reads the one offer in `app-update` and calls the callback it carries.
 *
 * TWO RULES OF THE PRESS, which are the whole of what it guards. An open editor's unsaved words are WRITTEN FIRST
 * (`flushBeforeRestart`): a restart or a reload would drop what lives in memory only. And it PRESSES NOTHING WHILE A
 * HOLD STANDS (a send that waits, a draft's files): then the notice says which, and offers no verb; a hold that
 * began while the words were written stops the press too.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  currentUpdateOffer,
  flushBeforeRestart,
  putUpdateAway,
  restartHold,
  subscribeRestartHold,
  subscribeUpdateOffer,
  type RestartHold,
  type UpdateOffer,
} from "@ohmail/app-logic/doors/app-update";
import type { FrameNotice } from "../../frame/index.js";
import type { Text } from "../../text/index.js";

/** Follow the one offer: adopt what is standing at mount, then listen. */
export function useUpdateOffer(): UpdateOffer | null {
  /* Not the current value as the initial state: a server render has no offer and adopting one during render would
     be a hydration mismatch. */
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  useEffect(() => {
    setOffer(currentUpdateOffer());
    return subscribeUpdateOffer(setOffer);
  }, []);
  return offer;
}

/** What holds a restart: a waiting send, an editor's files, or nothing (`app-update`). */
export function useRestartHold(): RestartHold {
  return useSyncExternalStore(subscribeRestartHold, restartHold, () => null);
}

/** The notice's sentence, by what is offered. `t` is the `update` namespace. */
function titleOf(t: Text, offer: UpdateOffer): string {
  const version = offer.version ?? "";
  switch (offer.kind) {
    case "reload":
      return t("lineReload");
    case "downloading":
      return t("lineDownloading", { version });
    case "failed":
      return t(offer.failed === "install" ? "lineInstallFailed" : "lineCheckFailed");
    case "tooOld":
      return t("lineTooOld");
    case "serverUpdating":
      return t("lineServerUpdating");
    default:
      return t("lineReady", { version });
  }
}

/** The verb of the notice's press, by what is offered. */
function verbOf(t: Text, offer: UpdateOffer): string {
  switch (offer.kind) {
    case "reload":
      return t("lineReloadAction");
    case "tooOld":
      return t(offer.verb === "update" ? "lineUpdateAction" : "lineReloadAction");
    case "failed":
      return t("lineRetry");
    default:
      return t("lineRestart");
  }
}

/** The update notice for the offer that stands, under the hold that stands. `t` is the `update` namespace. */
export function updateNotice(t: Text, offer: UpdateOffer, hold: RestartHold): FrameNotice {
  const holds = offer.kind === "ready" || offer.kind === "reload";
  const held = holds && hold !== null;
  const reload = offer.kind === "reload";
  const act = offer.act;
  const later = { label: t("lineLater"), onPress: putUpdateAway };
  /* An open editor's unsaved words are written first; a hold that began meanwhile stops the press. */
  const press = async (): Promise<void> => {
    await flushBeforeRestart();
    if (holds && restartHold() !== null) return;
    act?.();
  };
  return {
    kind: "update",
    title: titleOf(t, offer),
    ...(held ? { line: t(hold === "files" ? "lineAfterFiles" : "lineAfterSend") } : {}),
    acts:
      act && !held && offer.kind !== "downloading"
        ? [{ label: verbOf(t, offer), onPress: () => void press() }, later]
        : [later],
    ...(reload && !held ? { hot: true } : {}),
  };
}
