"use client";

/**
 * THE OPTION B OFFER — the one-line invitation a Linux device gets to take its ohmarchy
 * default account-wide (OHMARCHY-PLAN.md §3a).
 *
 * The DETECTION half lives in the ThemeProvider (a Linux device with no explicit choice
 * anywhere defaults to the ohmarchy face, for that device only); this is the half that asks
 * the person. One press writes the account-level setting through the same
 * `PATCH /consent/settings` every knob rides — so it travels to every signed-in surface via
 * the `settings` change row — and the dismiss is remembered on this device.
 *
 * ── WHEN IT MAY APPEAR, AND WHY EACH GATE ──────────────────────────────────────────────────
 *
 *  · `linuxDevice` — the offer is the detection's question; no detection, no question.
 *  · no explicit choice anywhere (`facePreference` and `accountFace` both null) — "an explicit
 *    prior choice always wins over detection", and a person who has chosen is not re-asked.
 *    This is also what makes "never repeats after a choice" STRUCTURAL rather than a flag:
 *    accepting stores an account face, a settings flip stores a pin, and either one keeps
 *    this component unmounted forever after.
 *  · `apply` non-null — the host can actually store an account-wide setting (the shell
 *    passes null on the demo, before consent is known, and on transports without the knob).
 *    An offer whose one tap cannot work is a control that cannot control.
 *  · not previously dismissed — the only case that needs storage, because dismissal changes
 *    no face and stores no choice: the device default deliberately STAYS ohmarchy (the
 *    dismissal answers the offer, not the detection; Settings holds the way out, and the
 *    note says so).
 *
 * ── THE FAILURE IS SAID ────────────────────────────────────────────────────────────────────
 *
 * A refused account write leaves everything as it was — this device keeps its ohmarchy
 * default, the offer stays up, and a toast carries the sentence. Nothing optimistic to
 * revert, `LanguageRow`'s contract.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useTheme, useToast, type FaceName } from "@ohmail/ui";
import { readOwner } from "./owner-cookie";
import type { ApplyFaceAllDevices } from "./FaceRow";

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
    try {
      window.localStorage.setItem(DISMISS_KEY, "done");
    } catch {
      /* private mode refuses writes; the dismissal still holds for this tab */
    }
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
