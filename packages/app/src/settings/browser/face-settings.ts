"use client";

import { useState } from "react";
import { newFaceEdits, type ApplyFaceAllDevices, type FaceEdits } from "../../mail/ground/boot-face.js";
import type { GeneralModel } from "../general/index.js";
import { useTheme, type FaceName } from "@ohmail/ui/theme";
import { useToast } from "@ohmail/ui/toast";

export interface FaceSettingsProps {
  accountWrite: { apply: ApplyFaceAllDevices; captureOwner: () => () => boolean } | null;
  holdForAccount?: (face: FaceName) => void;
  edits?: FaceEdits;
}

export function useFaceSettings(
  { accountWrite, holdForAccount, edits: shared }: FaceSettingsProps,
  failed: () => string,
): GeneralModel["look"] {
  const toast = useToast();
  const { face, resolved, facePreference, accountFace, setFace, adoptAccountFace } = useTheme();
  /** Local, so a rejection can be reported without any shared flag owning the message. */
  const [saving, setSaving] = useState(false);
  const [localEdits] = useState(newFaceEdits);
  const edits = shared ?? localEdits;

  /* "Applies on all your devices" may only be claimed when the account really governs this
     device: the stored account face matches AND no device pin outranks it. */
  const accountGoverns = accountFace === face && facePreference === null;

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
        if (edits.pending === work) adoptAccountFace(stored);
      } catch {
        if (edits.pending !== work || !stillOwns()) return;
        adoptAccountFace(edits.confirmed);
        setFace(edits.pin);
        toast(failed());
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
      if (accountWrite === null) {
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
          ? { governs: "all" }
          : {
              governs: accountFace === null && facePreference === null ? "default" : "device",
              busy: saving,
              applyAll() {
                if (!saving) writeAccount(accountWrite, face);
              },
            },
  };
}
