"use client";

import { useText } from "../../text/index.js";
import { DEFAULT_DORMANCY_DAYS } from "@ohmail/app-logic/consent/consent-state";
import { useConsent } from "@ohmail/app-logic/consent";
import { useDemoMode } from "@ohmail/app-logic/engine";
import { autoUnsubscribeConfirms } from "@ohmail/app-logic/screener";
import { autoUnsubscribeDoor } from "@ohmail/app-logic/press/sender-screening";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { screenerMode } from "@ohmail/app-logic/mail-state/mail-state";
import { useScreenerLearningSettings } from "../screener/useLearningSettings.js";
export { useScreenerLearningSettings } from "../screener/useLearningSettings.js";
import { useFrame } from "../../frame/index.js";
import { useScreenerBeside } from "../../screener/index.js";
import {
  ScreenerPane,
  screenerOffers,
  type ScreenerAct,
  type ScreenerModel,
  type ScreenerSuggest,
} from "../screener/index.js";
import { ruleDate } from "@ohmail/app-logic/press/rule-list";
import { standingNote } from "@ohmail/app-logic/consent/travelled-change";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";

export function useSuggestionSettings(available: boolean, metered: boolean, rulesMarked: boolean) {
  const t = useText("screener");
  const { autoOptIn: control } = useScreenerBeside();
  const c = useConsent();
  const { mailboxes } = useMailState();
  const reader = screenerMode(mailboxes).mode !== "organizer";
  if (!available || !control?.supported) return { suggest: null, act: null };
  const { quote } = control;
  const suggest: ScreenerSuggest = {
    on: c.suggestionConsentKnown ? c.autoSuggest : null,
    phase: control.phase,
    priced: quote !== null,
    open: () => {
      if (c.canChangeSuggestions()) control.open();
    },
    cancel: control.cancel,
    set: c.setAutoSuggest,
    said: {
      title: t("suggest.autoTitle"),
      state:
        c.suggestionConsentKnown && c.autoSuggest && c.autoSuggestAt
          ? t("suggest.autoOn", { when: ruleDate(c.autoSuggestAt) })
          : t("suggest.autoOff"),
      what: t("suggest.autoWhat", { count: control.batchSize }),
      cost: metered ? t("suggest.autoCost") : null,
      decides: t("suggest.autoDecides"),
      quote:
        control.phase === "pricing"
          ? t("suggest.pricing")
          : quote
            ? metered
              ? t("suggest.price", { senders: quote.senders, credits: quote.credits })
              : t("suggest.priceUnmetered", { senders: quote.senders })
            : null,
      notice: control.notice,
      turnOn: t("suggest.autoTurnOn"),
      cancel: t("suggest.cancel"),
      failed: t("suggest.autoFailed"),
    },
  };
  const why = reader ? "reader" : c.autoSuggest ? null : "needsSuggest";
  const act: ScreenerAct | null =
    c.suggestionConsentKnown && c.autoActStorable && c.setAutoAct
      ? {
          on: c.autoAct,
          why,
          set: c.setAutoAct,
          said: {
            title: t("suggest.actTitle"),
            description: t(rulesMarked ? "suggest.actDescription" : "suggest.actDescriptionUnmarked"),
            why:
              why === "reader"
                ? t("suggest.actReader")
                : why === "needsSuggest"
                  ? t("suggest.actNeedsSuggest")
                  : null,
            failed: t("suggest.actFailed"),
          },
        }
      : null;
  return { suggest, act };
}

export function useUnsubscribeSetting() {
  const { host } = useFrame();
  const from = screenerOffers(host).unsubscribe;
  const consent = useConsent();
  const demo = useDemoMode();
  const { mailboxes } = useMailState();
  const { control } = autoUnsubscribeDoor({
    demo,
    known: consent.known,
    on: consent.autoUnsubscribe,
    standalone: consent.standalone,
    confirms: autoUnsubscribeConfirms(mailboxes),
  });
  return from && control
    ? {
        on: consent.autoUnsubscribe,
        from,
        setBlocked: consent.setBlockAutoUnsubscribe,
      }
    : null;
}

export function useScreenerWindowSetting() {
  const { host } = useFrame();
  const consent = useConsent();
  return screenerOffers(host).window && consent.known
    ? {
        days: consent.dormancyDays,
        scope: consent.screeningScope,
        defaultDays: DEFAULT_DORMANCY_DAYS,
        note: standingNote(consent.dormancyChange),
        set: consent.setDormancyDays,
      }
    : null;
}

export function PairedScreenerSettings({
  ohbox = null,
  filed = null,
}: Partial<Pick<ScreenerModel, "ohbox" | "filed">> = {}) {
  const t = useText("screener");
  const consent = useConsent();
  const unsubscribe = useUnsubscribeSetting();
  const learning = useScreenerLearningSettings();
  const since = consent.suggestionConsentKnown ? consent.autoSuggestAt : null;
  return (
    <>
      <SettingsSheet>
        <SettingLine label={t("suggest.autoTitle")} toggle={{ on: since !== null }} off />
        <SettingNote>
          {since ? t("suggest.autoOn", { when: ruleDate(since) }) : t("suggest.autoOff")}
        </SettingNote>
      </SettingsSheet>
      <ScreenerPane
        model={{
          ohbox,
          learning,
          filed,
          suggest: null,
          act: null,
          ownSuggest: null,
          window: null,
          unsubscribe,
          review: null,
        }}
      />
    </>
  );
}
