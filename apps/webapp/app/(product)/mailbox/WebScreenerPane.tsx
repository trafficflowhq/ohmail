"use client";

import { confirmedAccountForScope } from "@ohmail/app/host";
import { useTranslations } from "next-intl";
import { useConsent } from "@ohmail/app-logic/consent";
import { useMailState } from "@ohmail/app-logic/mail-state";
import { hasLiveMailbox, useSeedOfferHere } from "@ohmail/app-logic/mailboxes/first-run/seed-offer";
import { useFrame } from "@ohmail/app/frame";
import { ScreenerPane, screenerOffers } from "@ohmail/app/settings/screener";
import { useScreenerWindowSetting, useSuggestionSettings, useUnsubscribeSetting } from "@ohmail/app/settings/browser";
import { useOhboxPreference, useFiledLetters } from "./use-screening-preferences";

export function WebScreenerPane() {
  const { host } = useFrame();
  const offers = screenerOffers(host);
  const consent = useConsent();
  const { mailboxes } = useMailState();
  const seed = useSeedOfferHere();
  const unsubscribe = useUnsubscribeSetting();
  const window = useScreenerWindowSetting();
  const t = useTranslations("seed");
  const ohbox = useOhboxPreference(host.wires.screening);
  const filed = useFiledLetters(host.wires.autoFiled);
  const suggestions = useSuggestionSettings(offers.suggest === "priced", host.capabilities.service === "managed", host.capabilities.rulesMarked);
  if (confirmedAccountForScope(host) === null) return null;
  return <ScreenerPane model={{
    ohbox: ohbox && { ...ohbox, holdLeave: (ask) => host.device.address.holdLeave(ask, "#/settings/screener") },
    filed, ...suggestions, ownSuggest: null,
    window,
    unsubscribe,
    review: offers.review && seed && consent.known && hasLiveMailbox(mailboxes) === true ? {
      said: { label: t("settingsLabel"), body: t("reopenBody"), action: t("reopenAction") }, open: seed.reopen,
    } : null,
  }} />;
}
