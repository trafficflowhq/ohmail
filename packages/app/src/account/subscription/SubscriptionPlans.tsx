import { Button, RadioLines, Seg } from "@ohmail/ui/base";
import { ActionPanel, SettingLine, SettingsSheet } from "@ohmail/ui/mail";
import { useText } from "../../text/index.js";
import type { PlanInterval, PlanName, PlanPick, PlansAnswer, SubscriptionModel } from "./model.js";

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
type PlanSelection = {
  readonly model: SubscriptionModel;
  readonly selection?: PlanName;
};

function pickedPlan(answer: ReadPlans, selection: PlanName | undefined): PlanName | undefined {
  return answer.plans.find(({ plan }) => plan === selection)?.plan ?? answer.current?.plan;
}

export function SubscriptionPlans({
  model,
  selection,
  select,
}: PlanSelection & { readonly select: (plan: PlanName) => void }) {
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
  const { current } = answer;
  const both =
    answer.plans.some((line) => line.price.month !== null) &&
    answer.plans.some((line) => line.price.year !== null);
  const verb = payingVerb(model, answer);
  const selectable = verb === "subscribe";
  const picked = selectable ? pickedPlan(answer, selection) : current?.plan;
  const options = answer.plans.map((line) => ({
    value: line.plan,
    label: t("storagePlanName", { plan: line.plan }),
    tag: current?.plan === line.plan ? t("storageTagYours") : undefined,
    note:
      line.credits === undefined
        ? own("planFactsWithoutCredits", { mailboxes: line.mailboxes, storage: line.storage })
        : own("planFacts", { mailboxes: line.mailboxes, credits: line.credits, storage: line.storage }),
    figure: line.price[interval] ?? undefined,
  }));
  return (
    <SettingsSheet
      title={t("storagePlansHead")}
      aside={
        both ? (
          <Seg
            label={own("billing")}
            options={[
              { value: "month", label: own("monthly") },
              { value: "year", label: own("yearly") },
            ]}
            value={interval}
            onChange={model.choose}
          />
        ) : undefined
      }
    >
      {selectable && options.length > 0 ? (
        <RadioLines
          kind="sheet"
          label={t("storagePlansHead")}
          options={options}
          value={picked ?? ""}
          onChange={(name) => {
            if (name !== "") select(name);
          }}
        />
      ) : (
        options.map((line) => (
          <SettingLine
            key={line.value}
            label={line.label}
            tag={line.tag}
            value={line.note}
            figure={line.figure}
          />
        ))
      )}
    </SettingsSheet>
  );
}

export function SubscriptionPayment({ model, selection }: PlanSelection) {
  const t = useText("settings");
  const own = useText("accountSubscription");
  const read = readPlansOf(model);
  if (read === null || model.status?.standing.state === "overdue") return null;
  const verb = payingVerb(model, read.answer);
  if (verb === null) return null;
  const picked = pickedPlan(read.answer, selection);
  const pick: PlanPick = picked ? { plan: picked, interval: read.interval } : { interval: read.interval };
  return (
    <ActionPanel
      label={t("storagePlansHead")}
      items={[
        {
          id: "pay",
          kind: "ink",
          icon: verb === "subscribe" ? "check" : undefined,
          rank: 0,
          disabled: model.opening,
          label:
            verb === "fix"
              ? own("fixPayment")
              : picked
                ? own("subscribeTo", { plan: picked })
                : own("subscribe"),
          onPress: () => (verb === "fix" ? model.manage() : model.manage(pick)),
        },
      ]}
    />
  );
}
