/**
 * AN ADDRESS'S SEAT: what stands above its two columns, and the value of its registration's `Above`. It hands the frame's
 * side and what only this package can read to the place's live hook (`useAddressLive`, called here once), and stands
 * the model and the reading column's meeting (`AddressAbove`). Mounted with the place's columns and unmounted with
 * them; it reads the ground through the live hook's readers and mounts no piece of it.
 */
import { useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import type { ReactNode } from "react";
import { useAddressLive } from "@ohmail/app-logic/address";
import { useKeyBindings } from "@ohmail/app-logic/keys";
import { useFrame } from "../frame/commands.js";
import { usePlaceLiveArgs } from "../frame/place-live.js";
import { usePlaceListOwn } from "../place-list/own.js";
import { useText } from "../text/index.js";
import { AddressAbove } from "./AddressAbove.js";

export function AddressSeat({ children }: { readonly children: ReactNode }): ReactNode {
  const { commands } = useFrame();
  const args = usePlaceLiveArgs();
  const own = usePlaceListOwn();
  const back = { label: useText("address")("close"), run: commands.closeAddress };
  const model = useAddressLive(args, { ...own, back });
  useSwitchEnded(args.route, model.list.rows.length > 0 || model.empty);
  useKeyBindings(
    args.plan.columns === 1 && args.route.open !== null
      ? []
      : [{ chord: "Escape", group: "navigate", ...back }],
  );
  return <AddressAbove model={model}>{children}</AddressAbove>;
}
