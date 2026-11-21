"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { avatarHue, Button, Switch } from "@ohmail/ui/base";
import { FigureLine, FigureTable, ScaleBar, SettingActs, SettingLine, SettingNote, SettingsSheet, type ScaleBarPart } from "@ohmail/ui/mail";
import { useMailboxFacts } from "@ohmail/app-logic/mail-state/mail-state-binding";
import type { StorageChange } from "./StorageNotice";
import {
  estimatedEmails, formatStorageBytes, formatStoragePrice, storageDayName, storageFitExtraBytes, storageFitIsChange,
  storageMonthName, storagePercent, storageRefillOf, storageRoomLine, type StorageFacts,
} from "./storage-state";

/** The storage mails switch, where the host can write it. */
export interface StorageMailSwitch {
  on: boolean;
  busy: boolean;
  failed: boolean;
  onChange: (on: boolean) => void;
}

/**
 * SETTINGS → STORAGE, shared by the browser and the desktop window: what is stored against the cap
 * and why the cap is what it is, per mailbox and to scale against what the mail is expected to need,
 * from which month text is kept, what counts and why it is limited, and the plans with the one that
 * keeps all the mail marked. Amounts and the change buttons only where `linksOut` and the program
 * offered them; a store build says where the plan is managed instead.
 */
export function StoragePane({ facts, linksOut, change, mail }: {
  facts: StorageFacts;
  linksOut: boolean;
  change: StorageChange | null;
  mail: StorageMailSwitch | null;
}) {
  const t = useTranslations("settings");
  const locale = useLocale();
  const roster = useMailboxFacts();
  const size = (bytes: number) => formatStorageBytes(bytes, locale, true);
  const num = new Intl.NumberFormat(locale);
  const b = (chunks: ReactNode) => <b>{chunks}</b>;
  const estimate = facts.estimate;
  const expected = estimate?.expectedBytes ?? 0;
  const full = facts.card === "full" || facts.usedBytes >= facts.limitBytes;
  const percent = storagePercent(facts);
  const room = storageRoomLine(facts, locale);
  const offer = facts.offer;

  // To scale: whichever is largest of what is used, the cap and what the mail is expected to need.
  const scale = Math.max(facts.usedBytes, facts.limitBytes, expected, 1);
  const at = (bytes: number) => Math.min(100, (bytes / scale) * 100);
  const addressOf = (id: string): string =>
    roster?.find((m) => m.id === id)?.address ?? roster?.find((m) => m.id === id)?.displayName ?? id;
  const segments: ScaleBarPart[] = facts.mailboxes.length
    ? facts.mailboxes.map((m) => ({ share: at(m.usedBytes), hue: avatarHue(addressOf(m.id)) }))
    : [{ share: at(facts.usedBytes) }];
  const rest = Math.max(0, expected - facts.usedBytes);
  if (rest > 0) segments.push({ from: at(facts.usedBytes), share: at(rest), kind: "rest" });
  const marks = [
    ...(facts.planLimitBytes !== null && facts.planLimitBytes !== facts.limitBytes
      ? [{ at: at(facts.planLimitBytes), label: size(facts.planLimitBytes) }] : []),
    { at: at(facts.limitBytes), label: size(facts.limitBytes) },
    ...(expected > facts.limitBytes ? [{ at: at(expected), label: t("storageBarExpected", { size: size(expected) }) }] : []),
  ];

  const plan = (): ReactNode => {
    if (facts.limitReason === "trial" && facts.planLimitBytes !== null && facts.limitDropsAt === null) {
      return t.rich("storagePlanTrial", { limit: size(facts.limitBytes), cap: size(facts.planLimitBytes), b });
    }
    if (facts.planLimitBytes !== null && facts.limitDropsAt !== null) {
      return t.rich("storagePlanUntil", {
        limit: size(facts.limitBytes), cap: size(facts.planLimitBytes), date: storageDayName(facts.limitDropsAt, locale), b,
      });
    }
    return offer !== null
      ? t.rich("storagePlanKeepsNamed", { plan: t("storagePlanName", { plan: offer.current.plan }), limit: size(facts.limitBytes), b })
      : t.rich("storagePlanKeeps", { limit: size(facts.limitBytes), b });
  };
  const price = (amount: number) => (offer === null ? "" : t(offer.interval === "year" ? "storagePriceYear" : "storagePriceMonth", {
    price: formatStoragePrice(amount, offer.currency, locale),
  }));
  const fitChanges = offer !== null && storageFitIsChange(offer);
  const changes = linksOut && change !== null && offer !== null && offer.canChange;
  const refill = storageRefillOf(roster);

  return (
    <>
      <SettingsSheet title={t("storage")} hot={full || percent >= 80}>
        <FigureLine
          figure={size(facts.usedBytes)}
          of={t("storageOf", { used: "", limit: size(facts.limitBytes) }).trim()}
          tag={full ? t("storageTagFull") : percent >= 80 ? t("storageTagPercent", { percent }) : undefined}
        />
        <SettingNote>{t("storageUsed", { room: t(room.key, room.values) })}</SettingNote>
        <ScaleBar
          label={t("storageOf", { used: size(facts.usedBytes), limit: size(facts.limitBytes) })}
          parts={segments}
          marks={marks}
          scale={[
            { label: "0" },
            ...(rest > 0 ? [{
              label: t(facts.emptiedForSpace > 0 && !facts.importing ? "storageBarOut" : "storageBarImporting"),
              rest: true,
            }] : []),
            { label: size(scale) },
          ]}
        />
        {facts.mailboxes.length > 0 ? (
          <FigureTable
            columns={[t("storageColMailbox"), t("storageColLetters"), t("storageColKept"), t("storageColExpected")]}
            rows={facts.mailboxes.map((m) => ({
              id: m.id,
              name: addressOf(m.id),
              hue: avatarHue(addressOf(m.id)),
              figures: [num.format(m.expectedLetters), size(m.usedBytes), size(m.expectedBytes)],
            }))}
            sum={estimate === null ? undefined : {
              name: t("storageTotal"),
              figures: [num.format(estimate.expectedLetters), size(facts.usedBytes), size(estimate.expectedBytes)],
            }}
          />
        ) : null}
        {estimate !== null ? (
          <p className="oh-text">
            {facts.importing
              ? t.rich("storageImporting", { stored: estimate.storedLetters, expected: estimate.expectedLetters, size: size(expected), b })
              : t.rich("storageNeeds", { letters: estimate.expectedLetters, size: size(expected), b })}
            {" "}
            {estimate.avgMeasured
              ? t("storageAverage", { size: size(estimate.avgLetterBytes) })
              : t("storageAverageDefault", { size: size(estimate.avgLetterBytes) })}
            {estimate.complete ? null : <>{" "}{t("storageIncomplete")}</>}
          </p>
        ) : null}

        {facts.emptiedForSpace > 0 ? (
          <p className="oh-text">
            {facts.keptFrom !== null
              ? t.rich("storageKeptFrom", { month: storageMonthName(facts.keptFrom, locale), b })
              : t.rich("storageKeptSome", { count: facts.emptiedForSpace, b })}
            {refill === "runs" ? <>{" "}{t("storageRefill")}</> : null}
          </p>
        ) : null}

      </SettingsSheet>
      <SettingsSheet title={t("storageWhatCountsHead")}>
        <SettingNote>{t("storageWhatCountsBody")}</SettingNote>
      </SettingsSheet>
      <SettingsSheet title={t("storageWhyHead")}>
        <SettingNote>{t("storageWhyBody")}</SettingNote>
      </SettingsSheet>
      <SettingsSheet title={t("storagePlanHead")}>
        <p className="oh-text">{plan()}</p>
      </SettingsSheet>
      {offer !== null ? (
        <SettingsSheet title={t("storagePlansHead")}>
          {offer.plans.map((p) => {
            const fitted = fitChanges && offer.fit.plan === p.plan;
            const extra = fitted ? storageFitExtraBytes(offer) : null;
            const tag = fitted && offer.fit.keepsAll ? t("storageTagFits") : p.plan === offer.current.plan ? t("storageTagYours") : undefined;
            return (
              <SettingLine
                key={p.plan}
                label={t("storagePlanName", { plan: p.plan })}
                tag={tag}
                value={size(p.roomBytes)}
                figure={linksOut ? price(p.amount) : undefined}
                description={[
                  t("storageLetters", { count: estimatedEmails(p.roomBytes) }),
                  t("storageMailboxes", { count: p.mailboxes }),
                  ...(extra === null ? [] : [linksOut
                    ? t("storageFitWith", { extra: `+${size(extra)}`, room: size(offer.fit.roomBytes), price: price(offer.fit.amount) })
                    : t("storageFitWithStore", { extra: `+${size(extra)}`, room: size(offer.fit.roomBytes) })]),
                ].join(" · ")}
              />
            );
          })}
          {offer.addon !== null ? (
            <SettingLine
              label={t("storageAddonName")}
              tag={t("storageTagAddon")}
              value={`+${size(offer.addon.unitBytes)}`}
              figure={linksOut ? price(offer.addon.amount) : undefined}
              description={[
                t("storageLetters", { count: estimatedEmails(offer.addon.unitBytes) }),
                t("storageAddonEach"),
                t("storageAddonMax", { count: offer.addon.maxUnits }),
              ].join(" · ")}
            />
          ) : null}
          {changes ? (
            <>
              <SettingActs>
                <Button disabled={change.busy} onPress={change.press}>{t("storageChangePlan")}</Button>
                {offer.addon !== null ? (
                  <Button kind="two" disabled={change.busy} onPress={change.press}>{t("storageAddStorage")}</Button>
                ) : null}
              </SettingActs>
              <SettingNote>{t("storageOpensPage")}</SettingNote>
              {change.note}
            </>
          ) : null}
          {!linksOut ? <SettingNote>{t("storageManageAtSite")}</SettingNote> : null}
        </SettingsSheet>
      ) : !linksOut ? (
        <SettingsSheet><SettingNote>{t("storageManageAtSite")}</SettingNote></SettingsSheet>
      ) : null}
      {mail !== null ? (
        <SettingsSheet>
          {mail.failed ? <p role="alert">{t("storageMailFailed")}</p> : null}
          <SettingLine label={t("storageMail")} description={t("storageMailSub")}>
            <Switch on={mail.on} disabled={mail.busy} label={t("storageMail")} onChange={mail.onChange} />
          </SettingLine>
        </SettingsSheet>
      ) : null}
    </>
  );
}
