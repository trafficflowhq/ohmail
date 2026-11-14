/** Nothing open: the column says what the list above it holds, or its own word where no list stands. */
import { BlankColumn } from "@ohmail/ui/mail";
import { blankOf } from "@ohmail/app-logic/reader";
import { useListBlank } from "@ohmail/app-logic/reading";
import { TodayBeside } from "../../calmail/index.js";
import { useFrame } from "../../frame/commands.js";
import { NONE } from "../../host/index.js";
import { useText } from "../../text/index.js";

export function Blank() {
  const t = useText("reader");
  const blank = blankOf(useListBlank(), t("blank.none"));
  const { host, route, plan } = useFrame();
  const mayShowToday =
    route.place === "ohbox" &&
    plan.columns === 2 &&
    host.capabilities.products === "both" &&
    host.wires.calendar !== NONE;
  const today = mayShowToday ? <TodayBeside /> : null;
  if (blank === null) return today;
  return (
    <BlankColumn hot={blank.hot} below={today}>
      {blank.label}
    </BlankColumn>
  );
}
