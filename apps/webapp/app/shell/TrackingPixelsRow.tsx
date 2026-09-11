"use client";

/**
 * Tracking pixels — the switch over the one refusal the reading pane makes in every images mode. ON
 * (the default): a beacon — a 1×1, a zero-dimension image, a beacon-shaped url — is never fetched,
 * whatever else loads. OFF: it rides the proxy with the pictures; the sender then learns the open
 * and usually WHO opened it (a bulk pixel url carries a per-recipient token), while the proxy still
 * hides the reader's network. It exists because some readers want the open seen — a receipt
 * acknowledged, a colleague's read-tracker — and a product that cannot be told so is deciding for
 * them: the DEFAULT protects, the switch is the control; a plain switch like {@link RemoteImagesRow}.
 */

/**
 * The description may not promise that ON hides the reader's address (the proxy does that in both
 * positions), imply that OFF loads pictures (that is the row above), or describe OFF as an
 * anonymous open — the pixel's url usually identifies the recipient. It writes through
 * `useConsentState().setBlockTrackingPixels` (`AppShell` passes the same hook's value into
 * `useRemoteImages`, so a flip re-sanitizes the open message) and renders the server's answer — a
 * switch drawn OFF over a failed write would say the beacons load while the stored setting refuses
 * them.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, Switch } from "@ohmail/ui";

export function TrackingPixelsRow({
  blocked,
  setBlockTrackingPixels,
}: {
  /** Pixels refused, as the server last answered it. `true` ⇒ the product default. */
  blocked: boolean;
  /** `useConsentState().setBlockTrackingPixels`. Resolves to what the database holds. */
  setBlockTrackingPixels: (blocked: boolean) => Promise<boolean>;
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

  const write = (block: boolean) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        // The switch reads "block", the column stores "load" — inverted once, in the service.
        await setBlockTrackingPixels(block);
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
        label={t("pixels.title")}
        description={blocked ? t("pixels.on") : t("pixels.off")}
        control={
          <Switch
            checked={blocked}
            disabled={pending}
            ariaLabel={t("pixels.title")}
            onChange={write}
          />
        }
      />
      <p className="set-note-inline">{t("pixels.microcopy")}</p>
      {failed ? <span className="scn-sg-note">{t("pixels.failed")}</span> : null}
    </>
  );
}
