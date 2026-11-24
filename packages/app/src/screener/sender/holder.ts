/**
 * WHO DECIDES, as the panel's note says it: the one decider of which holder sentence is true (`readerHolder`), and
 * nobody where no install organizes the mailbox. A name is printed only where the decider says there is one.
 */
import type { ScreenerState } from "@ohmail/app-logic/screener";
import type { OrganizerRefusal } from "@ohmail/app-logic/press/organizer-refusal";
import { readerHolder } from "@ohmail/app-logic/reading/reader-holder";
import type { Text } from "../../text/index.js";

export function decidesNote(
  t: Text,
  role: ScreenerState["role"] & { pressRefusal?: OrganizerRefusal | null },
): string {
  /* This install's own organizing has not had its first pass: the model's refusal says the same. */
  if (role.pressRefusal?.kind === "starting") return t("place.starting");
  /* Asked of an install that is no blocked reader only when the press is refused because nothing organizes yet. */
  if (role.reason === "no_organizer" || role.mode !== "blocked") return t("readerBarNoneTitle");
  return readerHolder(role) === "named" ? t("place.decides", { name: role.name }) : t("place.decidesUnknown");
}
