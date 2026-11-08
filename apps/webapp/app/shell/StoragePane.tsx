"use client";

import type { ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import { SettingsRow, SettingsSection, Switch } from "@ohmail/ui";
import { useMailboxFacts } from "./MailStateProvider";
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

/** Mailbox colours on the bar, from the tag palette's inks; more mailboxes than this repeat them. */
const SWATCHES = 5;

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
  const at = (bytes: number) => `${Math.min(100, (bytes / scale) * 100).toFixed(2)}%`;
  let left = 0;
  // An answer with no per-mailbox figures still draws what is used, as one segment.
  const parts = facts.mailboxes.length > 0 ? facts.mailboxes : [{ id: "all", usedBytes: facts.usedBytes }];
  const segments = parts.map((m, i) => {
    const seg = { id: m.id, left, width: m.usedBytes, swatch: i % SWATCHES };
    left += m.usedBytes;
    return seg;
  });
  const rest = expected > facts.usedBytes ? expected - facts.usedBytes : 0;
  const addressOf = (id: string): string =>
    roster?.find((m) => m.id === id)?.address ?? roster?.find((m) => m.id === id)?.displayName ?? id;

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
    <SettingsSection className="storage">
      <h2 className="storage-title">{t("storage")}</h2>
      <div className="storage-fig">
        <b>{t("storageOf", { used: size(facts.usedBytes), limit: size(facts.limitBytes) })}</b>
        <span>{t("storageUsed", { room: t(room.key, room.values) })}</span>
        {full || percent >= 80 ? (
          <span className={full ? "storage-tag full" : "storage-tag"}>
            {full ? t("storageTagFull") : t("storageTagPercent", { percent })}
          </span>
        ) : null}
      </div>

      <div className="storage-bar" aria-hidden="true">
        <div className="storage-track">
          {segments.map((s) => (
            <div key={s.id} className={`storage-seg m${s.swatch}`} style={{ left: at(s.left), width: at(s.width) }} />
          ))}
          {rest > 0 ? (
            <div className={facts.emptiedForSpace > 0 && !facts.importing ? "storage-seg out" : "storage-seg todo"}
              style={{ left: at(facts.usedBytes), width: at(rest) }} />
          ) : null}
          {facts.planLimitBytes !== null ? (
            <div className="storage-mark soft" style={{ left: at(facts.planLimitBytes) }}><span>{size(facts.planLimitBytes)}</span></div>
          ) : null}
          <div className="storage-mark" style={{ left: at(facts.limitBytes) }}><span>{size(facts.limitBytes)}</span></div>
          {expected > facts.limitBytes ? (
            <div className="storage-mark end" style={{ left: at(expected) }}><span>{t("storageBarExpected", { size: size(expected) })}</span></div>
          ) : null}
        </div>
        <div className="storage-scale">
          <span>0</span>
          {rest > 0 ? <span>{t(facts.emptiedForSpace > 0 && !facts.importing ? "storageBarOut" : "storageBarImporting")}</span> : null}
          <span>{size(scale)}</span>
        </div>
      </div>

      {facts.mailboxes.length > 0 ? (
        <table className="storage-table">
          <thead>
            <tr>
              <th>{t("storageColMailbox")}</th>
              <th className="r">{t("storageColLetters")}</th>
              <th className="r">{t("storageColKept")}</th>
              <th className="r">{t("storageColExpected")}</th>
            </tr>
          </thead>
          <tbody>
            {facts.mailboxes.map((m, i) => (
              <tr key={m.id}>
                <td><span className={`storage-sw m${i % SWATCHES}`} /><span className="storage-who">{addressOf(m.id)}</span></td>
                <td className="r">{num.format(m.expectedLetters)}</td>
                <td className="r">{size(m.usedBytes)}</td>
                <td className="r">{size(m.expectedBytes)}</td>
              </tr>
            ))}
          </tbody>
          {estimate !== null ? (
            <tfoot>
              <tr>
                <td>{t("storageTotal")}</td>
                <td className="r">{num.format(estimate.expectedLetters)}</td>
                <td className="r">{size(facts.usedBytes)}</td>
                <td className="r">{size(estimate.expectedBytes)}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      ) : null}

      {estimate !== null ? (
        <p className="storage-p">
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
        <p className="storage-kept">
          {facts.keptFrom !== null
            ? t.rich("storageKeptFrom", { month: storageMonthName(facts.keptFrom, locale), b })
            : t.rich("storageKeptSome", { count: facts.emptiedForSpace, b })}
          {refill === "runs" ? <>{" "}{t("storageRefill")}</> : null}
        </p>
      ) : null}

      <h3 className="storage-sub">{t("storageWhatCountsHead")}</h3>
      <p className="storage-p">{t("storageWhatCountsBody")}</p>
      <h3 className="storage-sub">{t("storageWhyHead")}</h3>
      <p className="storage-p">{t("storageWhyBody")}</p>
      <h3 className="storage-sub">{t("storagePlanHead")}</h3>
      <p className="storage-p">{plan()}</p>

      {offer !== null ? (
        <>
          <h3 className="storage-sub">{t("storagePlansHead")}</h3>
          <div className="storage-plans">
            {offer.plans.map((p) => {
              const fitted = fitChanges && offer.fit.plan === p.plan;
              const extra = fitted ? storageFitExtraBytes(offer) : null;
              const tag = fitted && offer.fit.keepsAll ? t("storageTagFits") : p.plan === offer.current.plan ? t("storageTagYours") : null;
              return (
                <div key={p.plan} className={fitted ? "storage-plan fitted" : "storage-plan"} data-plan={p.plan}>
                  <span className="storage-plan-tag">{tag}</span>
                  <div className="storage-plan-name">
                    {t("storagePlanName", { plan: p.plan })}
                    {linksOut ? <span className="storage-plan-price">{price(p.amount)}</span> : null}
                  </div>
                  <div className="storage-plan-gb">{size(p.roomBytes)}</div>
                  <div className="storage-plan-facts">
                    {t("storageLetters", { count: estimatedEmails(p.roomBytes) })}
                    <br />
                    {t("storageMailboxes", { count: p.mailboxes })}
                  </div>
                  {extra !== null ? (
                    <div className="storage-plan-fit">
                      {linksOut
                        ? t("storageFitWith", { extra: `+${size(extra)}`, room: size(offer.fit.roomBytes), price: price(offer.fit.amount) })
                        : t("storageFitWithStore", { extra: `+${size(extra)}`, room: size(offer.fit.roomBytes) })}
                    </div>
                  ) : null}
                </div>
              );
            })}
            {offer.addon !== null ? (
              <div className="storage-plan addon">
                <span className="storage-plan-tag">{t("storageTagAddon")}</span>
                <div className="storage-plan-name">
                  {t("storageAddonName")}
                  {linksOut ? <span className="storage-plan-price">{price(offer.addon.amount)}</span> : null}
                </div>
                <div className="storage-plan-gb">+{size(offer.addon.unitBytes)}</div>
                <div className="storage-plan-facts">
                  {t("storageLetters", { count: estimatedEmails(offer.addon.unitBytes) })}
                  <br />
                  {t("storageAddonEach")}
                </div>
                <div className="storage-plan-fit">{t("storageAddonMax", { count: offer.addon.maxUnits })}</div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}

      {changes ? (
        <div className="storage-actions">
          <button type="button" className="btn primary" disabled={change!.busy} onClick={change!.press}>{t("storageChangePlan")}</button>
          {offer!.addon !== null ? (
            <button type="button" className="btn" disabled={change!.busy} onClick={change!.press}>{t("storageAddStorage")}</button>
          ) : null}
          <small>{t("storageOpensPage")}</small>
        </div>
      ) : null}
      {changes ? change!.note : null}
      {!linksOut ? <p className="storage-p storage-manage">{t("storageManageAtSite")}</p> : null}

      {mail !== null ? (
        <>
          {mail.failed ? <p className="acct-warn" role="alert">{t("storageMailFailed")}</p> : null}
          <SettingsRow
            label={t("storageMail")}
            description={t("storageMailSub")}
            control={<Switch checked={mail.on} disabled={mail.busy} ariaLabel={t("storageMail")} onChange={mail.onChange} />}
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
