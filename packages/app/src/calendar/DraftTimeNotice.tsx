import { RefusalLine } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

export function DraftTimeNotice({ issue }: { issue: "gap" | "fold" | null }) {
  const t = useText("calendar");
  if (issue === "gap") return <RefusalLine>{t("edit.clockGap")}</RefusalLine>;
  return issue === "fold" ? <p role="status">{t("edit.clockFold")}</p> : null;
}
