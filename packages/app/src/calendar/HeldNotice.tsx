import { Notice } from "@ohmail/ui/base";
import { dayShort, useEarlier, yearOf, type HeldEdge } from "@ohmail/app-logic/calendar";
import { useLocale, useText } from "../text/index.js";

export function HeldNotice({
  edge,
  first,
  today,
  className,
}: {
  edge: HeldEdge;
  first: string;
  today: string;
  className: string;
}) {
  const t = useText("calendar");
  const settings = useText("calsettings");
  const locale = useLocale();
  const earlier = useEarlier(edge, first);
  if (earlier.kind === "none" || earlier.press === null) return null;
  return (
    <div className={className}>
      <Notice
        place="bar"
        title={edge.provider === "microsoft" ? settings("way.microsoft") : t("landmark")}
        line={
          earlier.failed
            ? t("held.failed")
            : t("held.from", { day: dayShort(earlier.from, locale, yearOf(today)) })
        }
        acts={[{ label: t("held.load"), onPress: earlier.press }]}
      />
    </div>
  );
}
