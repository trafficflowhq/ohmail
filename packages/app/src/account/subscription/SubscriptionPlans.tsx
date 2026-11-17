import { Fragment } from "react";
import { Button, Seg } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import type { PlanInterval, PlanPick, PlansAnswer, SubscriptionModel } from "./model.js";

/** The plans' read, where it answered with plans. */
export type ReadPlans = Extract<PlansAnswer, { kind: "plans" }>;

/** The plans' read as the pane draws it: the plans and the interval chosen, or `null` where it holds none. */
export function readPlansOf(
  model: SubscriptionModel,
): { readonly answer: ReadPlans; readonly interval: PlanInterval } | null {
  const { plans } = model;
  return plans.at === "read" && plans.answer.kind === "plans"
    ? { answer: plans.answer, interval: plans.interval }
    : null;
}

/** An amount as the server said it, for the interval it is for; a price it could not confirm is no figure. */
function priced(t: Text, price: string | null, interval: PlanInterval): string | undefined {
  if (price === null) return undefined;
  return t(interval === "year" ? "storagePriceYear" : "storagePriceMonth", { price });
}

/**
 * The verb that pays, where the plans were read: Fix payment where a payment failed, Subscribe where the account has
 * no subscription yet or a trial runs or ran out; none where it is subscribed (its plan is changed in Storage). Both
 * open the account page; nothing is bought here.
 */
function payingVerb(model: SubscriptionModel, read: ReadPlans): "fix" | "subscribe" | null {
  const standing = model.status === null ? null : model.status.standing;
  if (standing !== null) {
    if (standing.state === "overdue" || (standing.state === "closed" && standing.why === "unpaid"))
      return "fix";
    if (standing.state === "trial" || standing.state === "grace") return "subscribe";
    if (standing.state === "closed" && standing.why === "trialEnded") return "subscribe";
  }
  return read.current === null ? "subscribe" : null;
}

/**
 * The plans' sheet. Where the host has no read of the plans, and while it is on its way, nothing is drawn; where the
 * server sells nothing, or its program did not answer, nothing is drawn and nothing false is said. A read that failed
 * says so with Try again, and the verbs stay. A read answered draws every plan as a line with its price for the
 * interval chosen, the person's own marked, and the add-on as its own line.
 */
export function SubscriptionPlans({ model }: { readonly model: SubscriptionModel }) {
  const t = useText("settings");
  const own = useText("accountSubscription");
  if (model.plans.at === "unavailable") {
    return (
      <SettingsSheet
        title={t("storagePlansHead")}
        wants={{
          word: own("notRead"),
          line: own("plansUnavailable"),
          acts: (
            <Button kind="two" size="s" onPress={model.retryPlans}>
              {own("retry")}
            </Button>
          ),
        }}
      />
    );
  }
  const read = readPlansOf(model);
  if (read === null) return null;
  const { answer, interval } = read;
  const { current, addon } = answer;
  const verb = payingVerb(model, answer);
  const pick: PlanPick = current === null ? { interval } : { plan: current.plan, interval };
  return (
    <SettingsSheet
      title={t("storagePlansHead")}
      aside={
        <Seg
          label={own("billing")}
          options={[
            { value: "month", label: own("monthly") },
            { value: "year", label: own("yearly") },
          ]}
          value={interval}
          onChange={model.choose}
        />
      }
    >
      {answer.plans.map((line) => (
        <Fragment key={line.plan}>
          <SettingLine
            label={t("storagePlanName", { plan: line.plan })}
            tag={current !== null && current.plan === line.plan ? t("storageTagYours") : undefined}
            value={priced(t, line.price[interval], interval)}
          />
          <SettingNote>
            {own("planFacts", { mailboxes: line.mailboxes, credits: line.credits, storage: line.storage })}
          </SettingNote>
        </Fragment>
      ))}
      {addon === null ? null : (
        <>
          <SettingLine
            label={t("storageAddonName")}
            tag={t("storageTagAddon")}
            value={priced(t, addon.price, "month")}
          />
          <SettingNote>{addon.unit}</SettingNote>
          <SettingNote>{t("storageAddonEach")}</SettingNote>
          <SettingNote>{t("storageAddonMax", { count: addon.most })}</SettingNote>
        </>
      )}
      {verb === null ? null : (
        <Button
          kind="ink"
          size="s"
          disabled={model.opening}
          onPress={() => (verb === "fix" ? model.manage() : model.manage(pick))}
        >
          {verb === "fix"
            ? own("fixPayment")
            : current === null
              ? own("subscribe")
              : own("subscribeTo", { plan: current.plan })}
        </Button>
      )}
    </SettingsSheet>
  );
}
