"use client";

/**
 * Remote images — the one switch behind the reading pane's oldest behaviour. ON (the default): pictures load on open,
 * through ohmail's proxy. OFF: the per-message "Show images" flow — the bar counts what was blocked and you press to
 * admit it. A plain switch, not a confirm: nothing here spends, moves mail, or sends a byte to a sender — both
 * positions describe what the pane does with content that already arrived, both reversible.
 */

/**
 * The description may not promise that ON exposes the reader, nor imply OFF is what stops tracking pixels — a beacon
 * is refused the proxy inside the sanitizer in BOTH positions; the switch decides whether a picture waits for a
 * press, and the copy says that and stops. It writes through `useConsentState().setBlockRemoteImages` (`AppShell`
 * passes the same hook's value into `useRemoteImages`, so the open message re-renders in the new mode) and renders
 * the server's answer, never the optimistic pick.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, Switch } from "@ohmail/ui";

export function RemoteImagesRow({
  blocked,
  setBlockRemoteImages,
}: {
  /** The STORED opt-out, as the server last answered it. `true` ⇒ the per-message flow. */
  blocked: boolean;
  /** `useConsentState().setBlockRemoteImages`. Resolves to what the database holds. */
  setBlockRemoteImages: (blocked: boolean) => Promise<boolean>;
}) {
  const t = useTranslations("settings");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  /** Unmounted-after-await guard — the pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const write = (loadImages: boolean) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        // The switch reads "load images", the column stores "block them" — inverted exactly once,
        // here, at the seam between the two vocabularies.
        await setBlockRemoteImages(!loadImages);
      } catch {
        if (alive.current) setFailed(true);
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  return (
    <>
      <SettingsRow
        label={t("images.title")}
        description={blocked ? t("images.off") : t("images.on")}
        control={
          <Switch
            checked={!blocked}
            disabled={pending}
            ariaLabel={t("images.title")}
            onChange={write}
          />
        }
      />
      <p className="set-note-inline">{t("images.microcopy")}</p>
      {failed ? <span className="scn-sg-note">{t("images.failed")}</span> : null}
    </>
  );
}
