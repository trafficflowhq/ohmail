import type { Text } from "../../text/index.js";
import type { TravelledNote } from "./model.js";

/** The sentence for where a change went, from the `settings` namespace, as the shipped note says it. */
export function travelledSaid(note: TravelledNote, t: Text): string {
  if (note.kind === "asked") return t("screening.asked");
  if (note.kind === "applied") return t("screening.applied");
  const unreadable = note.refusal !== "other";
  return note.holder
    ? t(unreadable ? "screening.refusedUnreadable" : "screening.refusedOther", { name: note.holder })
    : t(unreadable ? "screening.refusedUnreadableUnknown" : "screening.refusedOtherUnknown");
}
