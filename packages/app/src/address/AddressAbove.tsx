/** What stands above an address's columns: its model, and the meeting the reading column reads. */
import type { ReactNode } from "react";
import { AddressModelContext, type AddressModel } from "@ohmail/app-logic/address";
import { PlaceMeeting } from "../place-list/index.js";
import { useText } from "../text/index.js";

export function AddressAbove({ model, children }: { model: AddressModel; children: ReactNode }) {
  const t = useText("address");
  const count = model.counts[model.side];
  const label = model.empty ? t(`empty.${model.side}`) : t("count", { count });
  return (
    <AddressModelContext.Provider value={model}>
      <PlaceMeeting
        visit={model.list.visit}
        blank={model.loading || model.archive?.archive.state === "failed" ? null : { label, hot: false }}
        steps={{ up: t("step.up"), down: t("step.down") }}
      >
        {children}
      </PlaceMeeting>
    </AddressModelContext.Provider>
  );
}
