import { Button, Tag } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import type { Standing, SubscriptionModel } from "./model.js";
import { readPlansOf, SubscriptionPlans } from "./SubscriptionPlans.js";

export interface SubscriptionPaneProps {
  readonly model: SubscriptionModel;
  /** The way to Storage from the storage line: the place's own way between sections, or `null` where there is none. */
  readonly toStorage: (() => void) | null;
}

/**
 * Settings › Subscription: where the account stands with the service, from the access answer the shell already
 * holds; the plans and what each costs where the server said so; and the one way to the account page, made by the
 * press. Nothing is bought here. It holds no state and reaches nothing: it draws its model, and its verbs are the
 * model's.
 */
export function SubscriptionPane({ model, toStorage }: SubscriptionPaneProps) {
  const t = useText("settings");
  const own = useText("accountSubscription");
  return (
    <>
      <StandingSheet model={model} toStorage={toStorage} />
      <SubscriptionPlans model={model} />
      <SettingsSheet
        wants={model.failed ? { word: own("notOpened"), line: t("subscriptionManageFailed") } : undefined}
      >
        <SettingLine label={t("subscription")}>
          <Button kind="two" size="s" disabled={model.opening} onPress={() => model.manage()}>
            {t("subscriptionManage")}
          </Button>
        </SettingLine>
      </SettingsSheet>
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

/** The day the standing turns, said in the account strip's own sentences; nothing where no day is known. */
function dayLine(standing: Standing, life: Text): string | null {
  if (standing.state === "trial" && standing.ends !== null) return life("trialEnds", { date: standing.ends });
  if (standing.state === "grace" && standing.until !== null)
    return life("graceEnds", { date: standing.until });
  return null;
}

/**
 * Where the account stands: its plan's name where the plans were read, the standing as a word, the day it turns, a
 * payment that failed as what the sheet wants, the mailboxes it may connect, and what is stored with the way to
 * Storage. No figure of money: only the plans' read says one.
 */
function StandingSheet({ model, toStorage }: SubscriptionPaneProps) {
  const t = useText("settings");
  const own = useText("accountSubscription");
  const life = useText("accountLifecycle");
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
  const day = standing === null ? null : dayLine(standing, life);
  const overdue = standing !== null && standing.state === "overdue" ? standing : null;
  const mailboxes = status === null ? null : status.mailboxes;
  const stored = status === null ? null : status.storage;
  return (
    <SettingsSheet
      title={title}
      aside={standing === null ? undefined : <Tag>{own(wordOf(standing))}</Tag>}
      wants={
        overdue === null
          ? undefined
          : {
              word: own("paymentFailed"),
              line:
                overdue.until === null
                  ? own("paymentFailedUndated")
                  : life("paymentFailed", { date: overdue.until }),
            }
      }
    >
      {day === null ? null : <SettingNote>{day}</SettingNote>}
      {mailboxes === null ? null : (
        <SettingLine label={t("mailboxes")} value={own("mailboxesUpTo", { count: mailboxes })} />
      )}
      {stored === null ? null : (
        <SettingLine label={t("storage")} value={stored}>
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
