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

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useOptionalTheme } from "@ohmail/ui/theme";
import { useConsent } from "@ohmail/app-logic/consent";
import { useFrame, type FrameNotice } from "@ohmail/app/frame";
import { durableSet } from "@ohmail/app-logic/storage/durable";

/** Device-local dismissal memory. A read failure means "not dismissed", which only re-offers. */
const DISMISS_KEY = "ohmail.faceOffer";

export function useOhmarchyNotice(captureOwner: () => () => boolean): FrameNotice | null {
  const theme = useOptionalTheme();
  const consent = useConsent();
  const apply = consent.themeFaceKnown && consent.themeFace === null ? consent.setThemeFace : null;
  const t = useTranslations("ohmarchy");
  const { report } = useFrame();
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
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
  if (!theme?.linuxDevice || theme.facePreference !== null || theme.accountFace !== null || apply === null || dismissed)
    return null;
  return {
    kind: "ohmarchy",
    title: t("offerLead"),
    line: t("offerNote"),
    acts: [
      {
        label: t("offerAction"),
        busy: saving,
        onPress: () => {
          if (writing.current) return;
          writing.current = true;
          setSaving(true);
          const ownerIsCurrent = captureOwner();
          void apply("ohmarchy")
            .then((stored) => {
              /* A resolve that lands after sign-out applies nothing (review-caught): the
                 sweep cleared the face mirror and the dismissal; recreating either would
                 hand the next account the departed one's state. The server-side write
                 stands regardless. */
              if (!ownerIsCurrent()) return;
              theme.adoptAccountFace(stored); // the echo, mirrored for the next boot's pre-paint stamp
              dismiss();
            })
            .catch(() => {
              if (ownerIsCurrent()) report(t("offerFailed"));
            })
            .finally(() => {
              writing.current = false;
              setSaving(false);
            });
        },
      },
      { label: t("offerDismissShort"), onPress: dismiss },
    ],
  };
}
