"use client";

/**
 * REMOTE IMAGES — the one switch behind the reading pane's oldest behaviour.
 *
 * ON (the product default) means a message's pictures load when you open it, every time, through
 * ohmail's own proxy. OFF means the per-message "Show images" flow this product shipped with: the
 * bar counts what was blocked and you press to admit it, once per message.
 *
 * ── WHY THIS IS A PLAIN SWITCH AND NOT A CONFIRM ──────────────────────────────────────────────
 *
 * {@link AutoSuggestRow} gates its ON with a priced confirm, because turning it on starts spending
 * the account's credits and a switch that costs money on the way up is a control somebody has to
 * pay to discover. Nothing here spends, moves mail, or sends a byte to a sender: both positions of
 * this switch describe what the reading pane does with content that has already arrived, and both
 * are reversible with a second press.
 *
 * ── WHAT THE DESCRIPTION MAY NOT SAY ──────────────────────────────────────────────────────────
 *
 * It must not promise that turning images ON exposes the reader, and it must not imply that
 * turning them OFF is what stops tracking pixels. Neither is true, and the second is the more
 * damaging: a beacon is refused the proxy inside the sanitizer in BOTH positions, so a reader who
 * left this on has exactly the same protection from open-tracking as one who turned it off. What
 * the switch decides is whether a picture waits for a press. The copy says that and stops.
 *
 * ── IT WRITES THROUGH THE HOOK ────────────────────────────────────────────────────────────────
 *
 * `setBlockRemoteImages` is `useConsentState().setBlockRemoteImages`, never `consentApi` directly,
 * for the reason `DormancyRow` gives: `AppShell` passes the same hook's `blockRemoteImages` into
 * `useRemoteImages`, so writing through it re-renders the open message in the new mode. A
 * component with its own fetch would leave the message the reader is looking at on the old one.
 *
 * The switch renders the value the SERVER last answered with, never the optimistic pick, so a
 * refused write leaves it where it was — and here that matters in one direction more than the
 * other: a switch that drew itself ON over a write that failed would be telling somebody their
 * images load when the stored setting still says they do not.
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
