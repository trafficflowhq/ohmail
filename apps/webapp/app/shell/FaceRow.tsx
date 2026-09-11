"use client";

/**
 * Settings → General → Look — the paper/ohmarchy face, with its scope (OHMARCHY-PLAN.md §3a). A `SegmentedControl`
 * beside the theme's and the language's: the same class of decision, how the app is drawn. Drawn by the shared file
 * like `LanguageRow`: both surfaces have a face (a standalone install has no account but it still has eyes), and what
 * differs per host arrives as {@link applyAllDevices} — null where no transport can store one, withholding the
 * affordance structurally.
 */

/**
 * The segmented control is "only this device": it writes the DEVICE PIN through the ThemeProvider, instantly, no
 * server — identical on the demo, the desktop and a broken connection. The quiet line under it is "apply for all
 * devices": one press PATCHes the account, adopts the echo, and CLEARS the pin; a pinned device deliberately ignores
 * account changes made elsewhere, and the scope line says which state this device is in. The device flip cannot fail;
 * the account write rejects into a toast with the control still showing the device's real face.
 */

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow, useTheme, useToast, type FaceName } from "@ohmail/ui";
import { readOwner } from "./owner-cookie";

/** The account write — `useConsentState().setThemeFace`, or null where no wire can store one. */
export type ApplyFaceAllDevices = (face: FaceName) => Promise<FaceName | null>;

export function FaceRow({ applyAllDevices }: { applyAllDevices: ApplyFaceAllDevices | null }) {
  const t = useTranslations("settings");
  const toast = useToast();
  const { face, facePreference, accountFace, setFace, adoptAccountFace } = useTheme();
  /** Local, so a rejection can be reported without any shared flag owning the message. */
  const [saving, setSaving] = useState(false);
  /* The CURRENT pin, readable at completion time (review-caught): the success handler runs
     whenever the PATCH resolves, and the closure's `face` is the value at press time — a
     newer segmented-control choice or a sign-out may have moved the world since. */
  const pinNow = useRef<FaceName | null>(facePreference);
  pinNow.current = facePreference;

  /* "Applies on all your devices" may only be claimed when the account really governs this
     device: the stored account face matches AND no device pin outranks it. A pin equal to the
     account's value still pins — an account change made elsewhere would not reach here — so it
     keeps the apply-all affordance, which normalises the redundancy away. */
  const accountGoverns = accountFace === face && facePreference === null;

  return (
    <>
      <SettingsRow
        label={t("face")}
        description={t("faceHint")}
        control={
          <SegmentedControl<FaceName>
            ariaLabel={t("faceAria")}
            value={face}
            /* Device-local and instant — the "only this device" scope. Never the account. */
            onChange={(next) => {
              if (next === face) return;
              setFace(next);
            }}
            className="face-seg"
            options={[
              { id: "paper", label: t("facePaper") },
              { id: "ohmarchy", label: t("faceOhmarchy") },
            ]}
          />
        }
      />
      {applyAllDevices === null ? null : accountGoverns ? (
        <div className="face-scope">
          <span>{t("faceScopeAll")}</span>
        </div>
      ) : (
        <div className="face-scope">
          <span>{t("faceScopeDevice")}</span>
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              if (saving) return;
              setSaving(true);
              const submitted = face;
              const owner = readOwner();
              applyAllDevices(submitted)
                .then((stored) => {
                  /* STALE COMPLETIONS APPLY NOTHING (review-caught). Two ways this resolve
                     can be late: the person signed out (the sweep already cleared the face
                     mirror — recreating it would hand the next account the departed one's
                     answer), or they made a NEWER device choice while the PATCH flew (a
                     `setFace(null)` now would erase a choice this write knows nothing
                     about). The write itself happened on the server either way; only this
                     device's state refuses the echo. */
                  if (readOwner() !== owner) return;
                  /* The ECHO, then the pin: adopt what the database now holds (also mirrored
                     for the next boot's pre-paint stamp), and clear the pin so the account
                     governs here too — but only the pin this press was made under. */
                  adoptAccountFace(stored);
                  if (pinNow.current === submitted || pinNow.current === null) setFace(null);
                })
                .catch(() => {
                  toast(t("faceFailed"));
                })
                .finally(() => {
                  setSaving(false);
                });
            }}
          >
            {t("faceApplyAll")}
          </button>
        </div>
      )}
    </>
  );
}
