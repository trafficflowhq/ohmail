"use client";

/**
 * The Option B offer — the one-line invitation a Linux device gets to take its ohmarchy default account-wide
 * (OHMARCHY-PLAN.md §3a). Detection lives in the ThemeProvider; this is the half that asks: one press writes the
 * account through the same `PATCH /consent/settings` every knob rides, and the dismiss is remembered on this device.
 */

/**
 * The gates: `linuxDevice` (no detection, no question); no explicit choice anywhere (`facePreference` and
 * `accountFace` both null — a person who has chosen is not re-asked, and "never repeats after a choice" is
 * STRUCTURAL: accepting stores an account face, a flip stores a pin, either keeps this unmounted for ever); `apply`
 * non-null (an offer whose one tap cannot work is a control that cannot control); not previously dismissed — the only
 * case needing storage, because a dismissal changes no face: the device default deliberately stays ohmarchy, and
 * Settings holds the way out. A refused write leaves everything as it was, the offer up, a toast carrying the
 * sentence.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useTheme, useToast, type FaceName } from "@ohmail/ui";
import { readOwner } from "./owner-cookie";
import type { ApplyFaceAllDevices } from "./FaceRow";
import { durableSet } from "./durable";

/** Device-local dismissal memory. A read failure means "not dismissed", which only re-offers. */
const DISMISS_KEY = "ohmail.faceOffer";

export function useOhmarchyOffer(apply: ApplyFaceAllDevices | null): {
  /** Render the offer? All gates folded, including the post-mount dismissal read. */
  eligible: boolean;
  dismiss: () => void;
} {
  const { linuxDevice, facePreference, accountFace } = useTheme();
  // Post-mount read, `usePersistedFlag`'s hydration rule: the server render has no storage,
  // and adopting it during render would be a mismatch React resolves against us.
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === "done");
    } catch {
      setDismissed(false);
    }
  }, []);
  const dismiss = useCallback(() => {
    setDismissed(true);
    // The dismissal still holds for this tab; a jar that refused it says so once.
    durableSet(DISMISS_KEY, "done", "ohmarchy.dismissed");
  }, []);
  return {
    eligible:
      apply !== null && linuxDevice && facePreference === null && accountFace === null && !dismissed,
    dismiss,
  };
}

export function OhmarchyOffer({
  apply,
  onDone,
}: {
  apply: ApplyFaceAllDevices;
  /** The hook's `dismiss` — called on the dismiss press AND after a successful apply. */
  onDone: () => void;
}) {
  const t = useTranslations("ohmarchy");
  const toast = useToast();
  const { adoptAccountFace } = useTheme();
  const [saving, setSaving] = useState(false);
  return (
    <div className="ohx-notice" role="status">
      <span>{t("offerLead")}</span>
      <button
        type="button"
        disabled={saving}
        onClick={() => {
          if (saving) return;
          setSaving(true);
          const owner = readOwner();
          apply("ohmarchy" as FaceName)
            .then((stored) => {
              /* A resolve that lands after sign-out applies nothing (review-caught): the
                 sweep cleared the face mirror and the dismissal; recreating either would
                 hand the next account the departed one's state. The server-side write
                 stands regardless. */
              if (readOwner() !== owner) return;
              adoptAccountFace(stored); // the echo, mirrored for the next boot's pre-paint stamp
              onDone();
            })
            .catch(() => {
              toast(t("offerFailed"));
            })
            .finally(() => {
              setSaving(false);
            });
        }}
      >
        {t("offerAction")}
      </button>
      <span>{t("offerNote")}</span>
      <button type="button" onClick={onDone} aria-label={t("offerDismiss")}>
        {t("offerDismissShort")}
      </button>
    </div>
  );
}
