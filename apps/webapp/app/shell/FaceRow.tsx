"use client";

/**
 * Settings → General → Look — the paper/ohmarchy face, with its scope (OHMARCHY-PLAN.md §3a). A `SegmentedControl`
 * beside the theme's and the language's: the same class of decision, how the app is drawn. Drawn by the shared file
 * like `LanguageRow`: both surfaces have a face (a standalone install has no account but it still has eyes), and what
 * differs per host arrives as {@link applyAllDevices} — null where no transport can store one, withholding the
 * affordance structurally.
 */

/**
 * Signed in, the segmented control writes the ACCOUNT (one PATCH): the choice shows at once, the device pin is
 * cleared, and every device of the account adopts it at start and on the settings doorbell, so the newest choice
 * wins. A refused write puts the previous look back and says so. With no account wire (demo, standalone) the
 * control is the device pin, as before. The one per-device behaviour left is the default before anybody chose
 * (ohmarchy on Linux), and the scope line says so.
 */

import { useCallback, useEffect, useRef } from "react";
import type { ApplyFaceAllDevices } from "@ohmail/app/mail";
import { useTranslations } from "next-intl";
import { SegmentedControl, SettingsRow, useTheme, useToast, type FaceName } from "@ohmail/ui";
import { readOwner } from "@ohmail/app-logic/storage/owner-cookie";
import { useFaceSettings, type FaceSettingsProps } from "../(product)/mailbox/general-preferences";

/** What the shell's consent read says about the look. */
type ConsentFace = { themeFace: FaceName | null; themeFaceKnown: boolean; standalone: boolean };

/**
 * The account's face, adopted from the `GET /consent` the shell already makes (and re-makes on
 * the settings doorbell) into `adoptAccountFace`, which mirrors it for the next boot's pre-paint
 * stamp. Never a write: PATCHing back a value read from the account is the loop `adoptLocale`
 * warns about. Null IS adopted once known — it clears the mirror of a revoked choice. Where the
 * account holds a look and this device can write it, the account governs: a pin an older build's
 * control left retires. A press made before the account answered is the newest choice, so it is
 * written to the account once it can be (a refused write keeps it as this device's pin). Returns
 * the hold FaceRow reports such a press to.
 */
export function useFaceFollowsAccount(
  consent: ConsentFace, apply: ApplyFaceAllDevices | null,
): (face: FaceName) => void {
  const t = useTranslations("settings");
  const toast = useToast();
  const { adoptAccountFace, accountFace, facePreference, setFace } = useTheme();
  const { themeFace, themeFaceKnown, standalone } = consent;
  useEffect(() => {
    /* A STANDALONE door has no account, so it may not wear one (review-caught, desktop): the
       provider outlives the desktop's door switch, and the departed account's face would skin
       the standalone mailbox. `themeFaceKnown`, NOT `known` (review-caught): the boot cache can
       make `known` true with the face still resting null, and adopting that null would wipe the
       mirror on every warm boot whose live read is slow. */
    if (standalone) adoptAccountFace(null);
    else if (themeFaceKnown) adoptAccountFace(themeFace);
  }, [adoptAccountFace, themeFace, themeFaceKnown, standalone]);
  /** A press while the account could not be written, owed to it. */
  const held = useRef<FaceName | null>(null);
  /** That press after its write was refused: a pin that stays. */
  const kept = useRef<FaceName | null>(null);
  const latestAccount = useRef(accountFace);
  latestAccount.current = accountFace;
  const standaloneRef = useRef(standalone);
  standaloneRef.current = standalone;
  const hold = useCallback((face: FaceName) => {
    held.current = standaloneRef.current ? null : face;
  }, []);
  useEffect(() => {
    if (apply === null) return;
    const owed = held.current;
    held.current = null;
    if (owed !== null && owed === facePreference) {
      setFace(null);
      if (owed === themeFace) return;
      const owner = readOwner();
      adoptAccountFace(owed);
      apply(owed).catch(() => {
        // A sign-out or a newer press since makes this refusal stale.
        if (readOwner() !== owner || latestAccount.current !== owed) return;
        adoptAccountFace(themeFace);
        kept.current = owed;
        setFace(owed);
        toast(t("faceFailed"));
      });
      return;
    }
    if (facePreference === null) kept.current = null;
    else if (themeFace !== null && facePreference !== kept.current) setFace(null);
  }, [apply, themeFace, facePreference, setFace, adoptAccountFace, toast, t]);
  return hold;
}

export function FaceRow({ applyAllDevices, ...local }: Omit<FaceSettingsProps, "accountWrite"> & {
  applyAllDevices: ApplyFaceAllDevices | null;
}) {
  const t = useTranslations("settings");
  const look = useFaceSettings({
    ...local,
    accountWrite: applyAllDevices === null ? null : {
      apply: applyAllDevices,
      captureOwner: () => {
        const owner = readOwner();
        return () => readOwner() === owner;
      },
    },
  });
  return (
    <>
      <SettingsRow
        label={t("face")}
        description={t("faceHint")}
        control={
          <SegmentedControl<FaceName>
            ariaLabel={t("faceAria")}
            value={look.face}
            onChange={look.set}
            className="face-seg"
            options={[
              { id: "paper", label: t("facePaper") },
              { id: "ohmarchy", label: t("faceOhmarchy") },
            ]}
          />
        }
      />
      {look.scope === null ? null : look.scope.governs === "all" ? (
        <div className="face-scope">
          <span>{t("faceScopeAll")}</span>
        </div>
      ) : (
        <div className="face-scope">
          <span>{t(look.scope.governs === "default" ? "faceScopeDefault" : "faceScopeDevice")}</span>
          <button
            type="button"
            disabled={look.scope.busy}
            onClick={look.scope.applyAll}
          >
            {t("faceApplyAll")}
          </button>
        </div>
      )}
    </>
  );
}
