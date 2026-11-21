import { RefusalLine } from "@ohmail/ui/base";
import type { HeldEdge, RangeActs, RangeInput } from "@ohmail/app-logic/calendar";
import { useFrame } from "../frame/commands.js";
import type { Route } from "../frame/contract.js";
import type { MonthRun } from "../month/use-month-run.js";
import { useText } from "../text/index.js";
import type { Where } from "./where.js";
import type { CalendarViewProps } from "./view.js";
import { dayView } from "../day/index.js";
import { weekView } from "../week/index.js";
import { MonthView } from "../month/index.js";
import { YearView } from "../year/index.js";
import { AgendaView } from "../agenda/index.js";
import { SearchView } from "../calsearch/index.js";

export function CurrentView({
  where,
  monthRun,
  route,
  keysHere,
  timeProps,
  input,
  acts,
  edge,
}: {
  readonly where: Where;
  readonly monthRun: MonthRun | null;
  readonly route: Route;
  readonly keysHere: boolean;
  readonly timeProps: CalendarViewProps;
  readonly input: RangeInput;
  readonly acts: RangeActs;
  readonly edge: HeldEdge;
}) {
  const { place, agenda, span } = where;
  const { commands } = useFrame();
  const t = useText("calendar");
  return place === "week" ? (
    <weekView.View {...timeProps} />
  ) : place === "day" ? (
    <dayView.View {...timeProps} />
  ) : place === "month" ? (
    <MonthView
      input={input}
      acts={acts}
      edge={edge}
      run={monthRun}
      {...(timeProps.onDrag ? { onDrag: timeProps.onDrag } : {})}
    />
  ) : place === "year" ? (
    <YearView input={input} acts={acts} edge={edge} />
  ) : place === "agenda" ? (
    <AgendaView
      input={input}
      acts={acts}
      edge={edge}
      days={agenda.days}
      onMore={agenda.more}
      keysHere={keysHere && route.open === null}
    />
  ) : place === "calsearch" ? (
    <SearchView
      input={input}
      acts={acts}
      query={route.words.q ?? ""}
      onQuery={(q) => commands.go({ place: "calsearch", words: q === "" ? {} : { q } })}
      held={{ from: span.first, to: span.last }}
    />
  ) : (
    <RefusalLine>{t("notHere")}</RefusalLine>
  );
}
