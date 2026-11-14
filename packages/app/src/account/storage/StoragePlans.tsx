import { Button } from "@ohmail/ui/base";
import { SettingLine, SettingNote, SettingsSheet } from "@ohmail/ui/mail";
import { useText, type Text } from "../../text/index.js";
import type { StorageFigures, StorageModel, StoragePlan } from "./model.js";
import { refusalSaid } from "./said.js";

type Plans = NonNullable<StorageFigures["plans"]>;

export interface StoragePlansProps {
  readonly model: StorageModel;
  readonly plans: Plans;
  /** The build links out: amounts are drawn, and the plan can be changed where the program offers it. */
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
  const own = useText("accountStorage");
  const devices = useText("devices");
  const accessLock = useText("accessLock");
  const refused = model.refusal === null ? null : refusalSaid({ settings: t, accessLock }, model.refusal);
  const nothingRan = model.nothingRan ? devices("stepUpCancelledNothingRan") : null;
  const said = refused ?? nothingRan;
  return (
    <SettingsSheet
      title={t("storagePlansHead")}
      wants={said === null ? undefined : { word: own("notOpened"), line: said }}
    >
      {refused !== null && nothingRan !== null ? <SettingNote warn>{nothingRan}</SettingNote> : null}
      {plans.lines.map((plan) => (
        <PlanLines key={plan.plan} t={t} plan={plan} linksOut={linksOut} />
      ))}
      {plans.addon === null ? null : (
        <>
          <SettingLine label={t("storageAddonName")} tag={t("storageTagAddon")} value={plans.addon.unit} />
          {linksOut && plans.addon.price !== null ? <SettingNote>{plans.addon.price}</SettingNote> : null}
          <SettingNote>{t("storageLetters", { count: plans.addon.letters })}</SettingNote>
          <SettingNote>{t("storageAddonEach")}</SettingNote>
          <SettingNote>{t("storageAddonMax", { count: plans.addon.most })}</SettingNote>
        </>
      )}
      {linksOut && plans.mayChange ? (
        <>
          <Button kind="ink" size="s" disabled={model.changing} onPress={model.change}>
            {t("storageChangePlan")}
          </Button>
          {plans.addon === null ? null : (
            <Button kind="two" size="s" disabled={model.changing} onPress={model.change}>
              {t("storageAddStorage")}
            </Button>
          )}
          <SettingNote>{t("storageOpensPage")}</SettingNote>
        </>
      ) : null}
    </SettingsSheet>
  );
}

/** One plan: its name with its tag and its room, then its price where one may be shown, its facts and what it adds. */
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
  const { fit } = plan;
  return (
    <>
      <SettingLine label={t("storagePlanName", { plan: plan.plan })} tag={tag} value={plan.room} />
      {linksOut && plan.price !== null ? <SettingNote>{plan.price}</SettingNote> : null}
      <SettingNote>{t("storageLetters", { count: plan.letters })}</SettingNote>
      <SettingNote>{t("storageMailboxes", { count: plan.mailboxes })}</SettingNote>
      {fit === null ? null : (
        <SettingNote>
          {linksOut && fit.price !== null
            ? t("storageFitWith", { extra: fit.extra, room: fit.room, price: fit.price })
            : t("storageFitWithStore", { extra: fit.extra, room: fit.room })}
        </SettingNote>
      )}
    </>
  );
}
