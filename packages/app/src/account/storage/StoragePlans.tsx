import { ActionPanel, SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import type { StorageFigures, StorageModel, StoragePlan } from "./model.js";
import { refusalSaid } from "./said.js";

type Plans = NonNullable<StorageFigures["plans"]>;

export interface StoragePlansProps {
  readonly model: StorageModel;
  readonly plans: Plans;
  readonly linksOut: boolean;
}

/**
 * The plans with their room, letters and mailboxes, the one that keeps all the mail, the person's own, and the add-on
 * with its unit and its most. Amounts stand only where the build links out, and a price that is not there is no
 * figure. Change plan and Add storage stand only where the build links out and the program offered a change; both
 * open the same page, and both are off while the change is on its way or waits for the factor.
 */
export function StoragePlans({ model, plans, linksOut }: StoragePlansProps) {
  const t = useText("settings");
  const { wants, note } = useStorageChangeFeedback(model);
  return (
    <SettingsSheet title={t("storagePlansHead")} wants={wants}>
      {note}
      {plans.lines.map((plan) => (
        <PlanLines key={plan.plan} t={t} plan={plan} linksOut={linksOut} />
      ))}
      {plans.addon === null ? null : (
        <SettingLine
          label={t("storageAddonName")}
          tag={t("storageTagAddon")}
          value={t("storageAddonFacts", { count: plans.addon.letters })}
          figure={plans.addon.unit}
          description={linksOut ? (plans.addon.price ?? undefined) : undefined}
        />
      )}
    </SettingsSheet>
  );
}

export function useStorageChangeFeedback(model?: Pick<StorageModel, "refusal" | "nothingRan">) {
  const t = useText("settings");
  const own = useText("accountStorage");
  const devices = useText("devices");
  const accessLock = useText("accessLock");
  const refused = !model?.refusal ? null : refusalSaid({ settings: t, accessLock }, model.refusal);
  const nothingRan = model?.nothingRan ? devices("stepUpCancelledNothingRan") : null;
  const said = refused ?? nothingRan;
  return {
    wants: said === null ? undefined : { word: own("notOpened"), line: said },
    note: refused !== null && nothingRan !== null ? <SettingNote warn>{nothingRan}</SettingNote> : null,
  };
}

export function StoragePlanActions({ model, add }: { readonly model: StorageModel; readonly add: boolean }) {
  const t = useText("settings");
  return (
    <ActionPanel
      label={t("storagePlansHead")}
      items={[
        {
          id: "change-plan",
          rank: 0,
          icon: "go",
          label: t("storageChangePlan"),
          kind: "ink",
          disabled: model.changing,
          onPress: model.change,
        },
        ...(add
          ? [
              {
                id: "add-storage",
                rank: 1,
                icon: "plus",
                label: t("storageAddStorage"),
                kind: "soft",
                disabled: model.changing,
                onPress: model.change,
              } as const,
            ]
          : []),
      ]}
    />
  );
}

function PlanLines({
  t,
  plan,
  linksOut,
}: {
  readonly t: Text;
  readonly plan: StoragePlan;
  readonly linksOut: boolean;
}) {
  const tag =
    plan.tag === "yours" ? t("storageTagYours") : plan.tag === "keepsAll" ? t("storageTagFits") : undefined;
  return (
    <SettingLine
      label={t("storagePlanName", { plan: plan.plan })}
      tag={tag}
      value={t("storagePlanFacts", { count: plan.letters, mailboxes: plan.mailboxes })}
      figure={plan.room}
      description={linksOut ? (plan.price ?? undefined) : undefined}
    />
  );
}
