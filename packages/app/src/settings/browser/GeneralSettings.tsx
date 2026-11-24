"use client";

import { mirrorOwnerOf } from "@ohmail/app-logic/session/sync-scheduler";
import { useResolvedDemoMode } from "@ohmail/app-logic/engine";
import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingsSheet } from "@ohmail/ui/mail";
import { useState } from "react";
import { useTheme } from "@ohmail/ui/theme";
import { useFrame } from "../../frame/index.js";
import { NONE } from "../../host/index.js";
import { useAccountLook } from "../general/boot-face.js";
import { readSubjectDisplay, writeSubjectDisplay } from "../../reader/subject-display.js";
import { readThreadOrder, writeThreadOrder } from "../../reader/thread-order.js";
import type { PaneBodyProps } from "../index.js";
import { GeneralPane, type GeneralModel } from "../general/index.js";
import { useConsent } from "@ohmail/app-logic/consent";
import {
  AFTER_VERB_CHOICES,
  DEFAULT_AFTER_VERB,
  readAfterVerb,
  writeAfterVerb,
} from "@ohmail/app-logic/press/after-verb";
import {
  DEFAULT_IMAGE_QUALITY_LEVEL,
  IMAGE_QUALITY_LEVELS,
  isImageQualityLevel,
  readImageQualityLevel,
  writeImageQualityLevel,
} from "@ohmail/app-logic/write/image-quality";
import { useFaceSettings } from "./face-settings.js";
import { useText } from "../../text/index.js";

export interface GeneralSettingsProps extends Partial<PaneBodyProps> {
  language: GeneralModel["language"];
  textSize: {
    read: () => number;
    set: (value: number) => void;
    choices: readonly number[];
  };
  captureOwner?: (scope: string | null) => () => boolean;
  showMessages?: boolean;
}

/** Each setting uses the host's own device controls or the confirmed account row. */
export function BrowserGeneralPane({ language, textSize, captureOwner, showMessages }: GeneralSettingsProps) {
  const { host, report } = useFrame();
  const demo = useResolvedDemoMode();
  const rail = useText("rail");
  const { surface, desktopDownload } = host.device.build;
  const openLink = host.device.openLink;
  const download = surface === "web" && !demo && desktopDownload && openLink !== NONE;
  const scope = host.session.scope;
  const t = useText("settings");
  const theme = useTheme();
  const consent = useConsent();
  const accountLook = useAccountLook();
  const look = useFaceSettings(
    {
      accountWrite:
        captureOwner && consent.themeFaceKnown && consent.setThemeFace
          ? {
              apply: consent.setThemeFace,
              captureOwner: () => captureOwner(mirrorOwnerOf(host.engine) ?? scope),
            }
          : null,
      holdForAccount: accountLook?.hold,
      edits: accountLook?.edits,
    },
    () => t("faceFailed"),
    report,
  );
  const [size, showSize] = useState(textSize.read);
  const [quality, showQuality] = useState(() =>
    scope === null ? DEFAULT_IMAGE_QUALITY_LEVEL : readImageQualityLevel(scope),
  );
  const [afterVerb, showAfterVerb] = useState(() =>
    scope === null ? DEFAULT_AFTER_VERB : readAfterVerb(scope),
  );
  const [subject, showSubject] = useState(() => readSubjectDisplay(scope));
  const [threadOrder, showThreadOrder] = useState(() => readThreadOrder(scope));
  const canFetchImages = host.wires.images !== NONE;
  const fromComputer = host.capabilities.imagesFrom === "computer";

  const model: GeneralModel = {
    language,
    theme: { value: theme.preference, set: theme.setTheme },
    look,
    textSize: {
      value: size,
      choices: textSize.choices,
      set(next) {
        if (!textSize.choices.includes(next) || size === next) return;
        textSize.set(next);
        showSize(next);
      },
    },
    imageQuality: {
      value: quality,
      choices: IMAGE_QUALITY_LEVELS,
      set(next) {
        if (!isImageQualityLevel(next) || quality === next) return;
        if (scope !== null) writeImageQualityLevel(next, scope);
        showQuality(next);
      },
    },
    afterVerb: {
      value: afterVerb,
      choices: AFTER_VERB_CHOICES,
      set(next) {
        const choice = AFTER_VERB_CHOICES.find((offered) => offered === next);
        if (!choice || choice === afterVerb) return;
        if (scope !== null) writeAfterVerb(choice, scope);
        showAfterVerb(choice);
      },
    },
    subject: {
      value: subject,
      set(next) {
        writeSubjectDisplay(scope, next);
        showSubject(next);
      },
    },
    threadOrder: {
      value: threadOrder,
      set(next) {
        writeThreadOrder(scope, next);
        showThreadOrder(next);
      },
    },
    images:
      canFetchImages && consent.remoteImagesKnown
        ? { blocked: consent.blockRemoteImages, fromComputer, set: consent.setBlockRemoteImages }
        : null,
    pixels:
      canFetchImages && consent.trackingPixelsKnown
        ? { blocked: consent.blockTrackingPixels, fromComputer, set: consent.setBlockTrackingPixels }
        : null,
    defaultMail: null,
  };
  return (
    <>
      <GeneralPane model={model} showMessages={showMessages} />
      {download ? (
        <SettingsSheet>
          <SettingLine label={rail("getDesktop")}>
            <Button kind="two" size="s" onPress={() => openLink(desktopDownload)}>
              {rail("getDesktopOpen")}
            </Button>
          </SettingLine>
        </SettingsSheet>
      ) : null}
    </>
  );
}
