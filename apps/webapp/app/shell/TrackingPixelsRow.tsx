"use client";

/**
 * TRACKING PIXELS — the switch over the one refusal the reading pane makes in every images mode.
 *
 * ON (the product default) means a beacon — a 1×1, a zero-dimension image, a beacon-shaped url — is
 * never fetched, whatever else in the message loads. OFF means it rides the proxy with the pictures:
 * the sender learns that the message was opened, and still nothing about who opened it or from
 * where, because the proxy's port takes a url and nothing else.
 *
 * ── WHY IT EXISTS AT ALL, GIVEN THE PRODUCT IS NAMED FOR THE REFUSAL ──────────────────────────
 *
 * Some readers want the open seen: a receipt they expect acknowledged, a colleague's read-tracker,
 * a mailing they send themselves. A product that cannot be told so is deciding for them. The
 * DEFAULT protects; the switch is the control. Both positions describe what the pane does with
 * content that has already arrived — nothing here spends, moves mail, or sends a byte from the
 * reader's machine — so it is a plain switch, like {@link RemoteImagesRow}, and not a confirm.
 *
 * ── WHAT THE DESCRIPTION MAY NOT SAY ──────────────────────────────────────────────────────────
 *
 * It must not promise that ON hides the reader's address (the proxy does that in both positions)
 * and it must not imply that OFF loads pictures (that is the row above; in the manual images mode a
 * pixel still waits behind "Show images" with everything else). The copy says what the switch
 * decides — whether a beacon is fetched — and stops.
 *
 * ── IT WRITES THROUGH THE HOOK, AND DRAWS THE SERVER'S ANSWER ─────────────────────────────────
 *
 * `setBlockTrackingPixels` is `useConsentState().setBlockTrackingPixels`, never `consentApi`
 * directly, for `RemoteImagesRow`'s reason: `AppShell` passes the same hook's value into
 * `useRemoteImages`, so a flip re-sanitizes the open message. The switch renders the value the
 * SERVER last answered with — a refused write leaves it where it was, and here the direction that
 * matters is a switch drawn OFF over a write that failed, telling somebody their beacons load when
 * the stored setting still refuses them.
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
