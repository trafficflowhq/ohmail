import { useState } from "react";
import { Button, Tag } from "@ohmail/ui/base";
import { SettingLine, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { PaneSheet } from "../../settings/contract.js";
import { StorageInfo } from "../storage/StoragePane.js";
import type { PlanName, Standing, SubscriptionModel } from "./model.js";
import { readPlansOf, SubscriptionPayment, SubscriptionPlans } from "./SubscriptionPlans.js";
import { TrialProgress } from "./TrialProgress.js";

export interface SubscriptionPaneProps {
  readonly model: SubscriptionModel;
  readonly connectedCount?: number;
  readonly sheet?: PaneSheet;
  /** The way to Storage from the storage line: the place's own way between sections, or `null` where there is none. */
  readonly toStorage: (() => void) | null;
}

/**
 * Settings › Subscription: where the account stands with the service, from the access answer the shell already
 * holds; the plans and what each costs where the server said so; and the one way to the account page, made by the
 * press. Nothing is bought here. It holds no state and reaches nothing: it draws its model, and its verbs are the
 * model's.
 */
export function SubscriptionPane({ model, toStorage, connectedCount, sheet }: SubscriptionPaneProps) {
  const t = useText("settings");
  const own = useText("accountSubscription");
  const [selection, select] = useState<PlanName>();
  const body = (
    <>
      <StandingSheet model={model} toStorage={toStorage} connectedCount={connectedCount} />
      <SubscriptionPlans model={model} selection={selection} select={select} />
      <SettingsSheet
        wants={model.failed ? { word: own("notOpened"), line: t("subscriptionManageFailed") } : undefined}
      >
        <SettingLine label={t("paymentInvoices")}>
          <Button kind="two" size="s" icon="go" disabled={model.opening} onPress={() => model.manage()}>
            {t("subscriptionManage")}
          </Button>
        </SettingLine>
      </SettingsSheet>
    </>
  );
  const foot = <SubscriptionPayment model={model} selection={selection} />;
  return sheet ? (
    sheet(body, foot)
  ) : (
    <>
      {body}
      {foot}
    </>
  );
}

/** The word a standing is said by, beside the plan's name. */
const WORD: Readonly<Record<Exclude<Standing["state"], "closed">, string>> = {
  trial: "trial",
  grace: "trialEnded",
  overdue: "overdue",
  active: "active",
};
const CLOSED: Readonly<Record<NonNullable<Extract<Standing, { state: "closed" }>["why"]>, string>> = {
  trialEnded: "trialEnded",
  canceled: "canceled",
  unpaid: "unpaid",
  suspended: "suspended",
};
const wordOf = (standing: Standing): string =>
  standing.state === "closed"
    ? standing.why === null
      ? "closed"
      : CLOSED[standing.why]
    : WORD[standing.state];

/**
 * Where the account stands: its plan's name where the plans were read, the standing as a word, the day it turns, a
 * payment that failed as what the sheet wants, the mailboxes it may connect, and what is stored with the way to
 * Storage. No figure of money: only the plans' read says one.
 */
function StandingSheet({ model, toStorage, connectedCount }: SubscriptionPaneProps) {
  const t = useText("settings");
  const own = useText("accountSubscription");
  const ai = useText("settingsAi");
  const read = readPlansOf(model);
  const { status } = model;
  const current = read === null ? null : read.answer.current;
  const noPlan = read !== null && current === null;
  if (status === null && !noPlan) return null;
  const title =
    current !== null
      ? t("storagePlanName", { plan: current.plan })
      : noPlan
        ? own("noPlan")
        : t("storagePlanHead");
  const standing = status === null ? null : status.standing;
  const progress = status?.trialProgress;
  const runOn = standing?.state === "overdue" || standing?.state === "grace" ? standing : null;
  const paymentFailed = runOn?.state === "overdue";
  const price =
    current && read?.answer.plans.find((plan) => plan.plan === current.plan)?.price[current.interval];
  const interval = current?.interval === "year" ? "storagePriceYear" : "storagePriceMonth";
  const mailboxes = status === null ? null : status.mailboxes;
  const stored = status === null ? null : status.storage;
  return (
    <SettingsSheet
      title={title}
      aside={standing === null ? undefined : <Tag>{own(wordOf(standing))}</Tag>}
      wants={
        runOn
          ? {
              word: own(paymentFailed ? "paymentFailed" : "trialEnded"),
              line:
                runOn.until === null
                  ? paymentFailed
                    ? own("paymentFailedUndated")
                    : undefined
                  : own("organizingUntil", { date: runOn.until }),
              acts:
                paymentFailed || read === null ? (
                  <Button kind="two" size="s" disabled={model.opening} onPress={() => model.manage()}>
                    {own(paymentFailed ? "fixPayment" : "subscribe")}
                  </Button>
                ) : undefined,
            }
          : undefined
      }
    >
      {progress ? <TrialProgress progress={progress} /> : null}
      {standing?.state === "trial" && standing.ends ? (
        <SettingLine label={own("trialEnds")} value={standing.ends} />
      ) : null}
      {price ? (
        <SettingLine
          label={own(standing?.state === "trial" ? "then" : "price")}
          value={t(interval, { price })}
        />
      ) : null}
      {mailboxes === null ? null : (
        <SettingLine
          label={t("mailboxes")}
          value={
            connectedCount === undefined
              ? own("mailboxesUpTo", { count: mailboxes })
              : own("mailboxesConnected", { used: connectedCount, count: mailboxes })
          }
        />
      )}
      {status?.aiCredits ? (
        <SettingLine
          label={ai("budget")}
          value={ai(
            status.aiCredits.total === undefined ? "creditsBalance" : "creditsLeft",
            status.aiCredits,
          )}
        />
      ) : null}
      {stored === null ? null : (
        <SettingLine label={t("storage")} value={stored} info={<StorageInfo />}>
          {toStorage === null ? null : (
            <Button kind="quiet" size="s" onPress={toStorage}>
              {own("openStorage")}
            </Button>
          )}
        </SettingLine>
      )}
    </SettingsSheet>
  );
}
