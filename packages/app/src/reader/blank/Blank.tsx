/** Nothing open: the column says what the list above it holds, or its own word where no list stands. */
import { Button } from "@ohmail/ui/base";
import { BlankColumn, Sheet, type SheetProps } from "@ohmail/ui/mail";
import { blankOf } from "@ohmail/app-logic/reader";
import { useListBlank } from "@ohmail/app-logic/reading";
import { useLiveTrashEnabled } from "@ohmail/app-logic/trash";
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

export type ReadingBack = Extract<SheetProps, { kind: "reading" }>["back"];

/** A moved or deleted letter can still be in the mail server's Trash. */
export function GoneLetter({ back }: { back: ReadingBack }) {
  const t = useText("reader");
  const { host } = useFrame();
  const trash = host.features.places.trash;
  const canLook = trash !== NONE && trash !== undefined && host.wires.trash !== NONE;
  const blank = <BlankColumn below={canLook ? <GoneTrashWay /> : undefined}>{t("goneShort")}</BlankColumn>;
  return back ? (
    <Sheet kind="reading" label={t("pane")} back={back}>
      {blank}
    </Sheet>
  ) : (
    blank
  );
}

function GoneTrashWay() {
  const t = useText("reader");
  const { commands } = useFrame();
  if (!useLiveTrashEnabled()) return null;
  return (
    <div className="rd-gone-way">
      <Button kind="two" onPress={() => commands.go({ place: "trash" })}>
        {t("goneTrash")}
      </Button>
    </div>
  );
}
