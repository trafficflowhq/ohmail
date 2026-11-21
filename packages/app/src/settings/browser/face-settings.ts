"use client";

import { useState } from "react";
import { newFaceEdits, type ApplyFaceAllDevices, type FaceEdits } from "../general/boot-face.js";
import type { GeneralModel } from "../general/index.js";
import { useTheme, type FaceName } from "@ohmail/ui/theme";
import type { ToastFn } from "@ohmail/app-logic/press/report";

export interface FaceSettingsProps {
  accountWrite: { apply: ApplyFaceAllDevices; captureOwner: () => () => boolean } | null;
  holdForAccount?: (face: FaceName) => void;
  edits?: FaceEdits;
}

export function useFaceSettings(
  { accountWrite, holdForAccount, edits: shared }: FaceSettingsProps,
  failed: () => string,
  report: ToastFn,
): GeneralModel["look"] {
  const { face, resolved, facePreference, deviceFaceExplicit, accountFace, setFace, adoptAccountFace } =
    useTheme();
  /** Local, so a rejection can be reported without any shared flag owning the message. */
  const [saving, setSaving] = useState(false);
  const [localEdits] = useState(newFaceEdits);
  const edits = shared ?? localEdits;

  /* "Applies on all your devices" may only be claimed when the account really governs this
     device: the stored account face matches AND no device pin outranks it. */
  const accountGoverns = accountFace === face && facePreference === null;
  const pin = () => {
    if (!saving && edits.pending === null) setFace(face, true);
  };

  const writeAccount = (
    { apply, captureOwner }: NonNullable<FaceSettingsProps["accountWrite"]>,
    submitted: FaceName,
  ): void => {
    const stillOwns = captureOwner();
    if (!stillOwns()) return;
    const prior = edits.pending;
    if (prior === null) {
      edits.confirmed = accountFace;
      edits.pin = facePreference;
      edits.pinExplicit = deviceFaceExplicit;
    }
    edits.chosen = submitted;
    adoptAccountFace(submitted);
    setFace(null);
    setSaving(true);
    const write = async (): Promise<void> => {
      if (edits.pending === null || !stillOwns()) return;
      try {
        const stored = await apply(submitted);
        if (edits.pending === null || !stillOwns()) return;
        edits.confirmed = stored;
        edits.pin = null;
        edits.pinExplicit = false;
        if (edits.pending === work) adoptAccountFace(stored);
      } catch {
        if (edits.pending !== work || !stillOwns()) return;
        adoptAccountFace(edits.confirmed);
        setFace(edits.pin, edits.pinExplicit);
        report(failed());
      } finally {
        if (edits.pending === work) {
          edits.pending = null;
          edits.chosen = null;
          setSaving(false);
        }
      }
    };
    const work: Promise<void> = (prior ?? Promise.resolve()).then(write);
    edits.pending = work;
  };

  return {
    face,
    scheme: resolved,
    set(next) {
      if (next === face) return;
      if (deviceFaceExplicit) {
        setFace(next, true);
      } else if (accountWrite === null) {
        setFace(next);
        holdForAccount?.(next);
      } else {
        writeAccount(accountWrite, next);
      }
    },
    scope:
      accountWrite === null
        ? null
        : accountGoverns
          ? { governs: "all", busy: saving, pin }
          : {
              governs: accountFace === null && facePreference === null ? "default" : "device",
              busy: saving,
              pin,
              applyAll() {
                if (!saving) writeAccount(accountWrite, face);
              },
            },
  };
}
