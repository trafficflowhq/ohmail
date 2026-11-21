import { useRef } from "react";
import { SettingsHead, Sheet } from "@ohmail/ui/mail";
import type { LayoutPlan } from "../frame/contract.js";
import { useText } from "../text/index.js";
import type { PaneSheet, PaneSummary, SettingsPane } from "./contract.js";
import { usePaneName } from "./label.js";

export interface PaneColumnProps {
  readonly pane: SettingsPane;
  readonly plan: LayoutPlan;
  readonly keysHere: boolean;
  /** The way back to the menu, where the section stands over it (one column). */
  readonly back: (() => void) | null;
}

function Column({
  pane,
  plan,
  keysHere,
  back,
  summary,
}: PaneColumnProps & { readonly summary: PaneSummary | null }) {
  const t = useText("settings");
  const name = usePaneName()(pane);
  const { Body } = pane;
  const scroller = useRef<HTMLDivElement>(null);
  const sheet: PaneSheet = (body, foot, count) => (
    <Sheet
      kind="reading"
      foot={foot}
      label={t("title")}
      scrollLabel={name}
      scroller={scroller}
      focused={keysHere}
      back={back ? { word: t("title"), label: t("back"), onPress: back } : undefined}
      head={<SettingsHead title={name} hot={summary?.hot} count={count ?? summary?.count} />}
    >
      {body}
    </Sheet>
  );
  return pane.hasFoot ? (
    <Body plan={plan} keysHere={keysHere} scroller={scroller} sheet={sheet} />
  ) : (
    sheet(<Body plan={plan} keysHere={keysHere} scroller={scroller} />)
  );
}

function SummedColumn(
  props: PaneColumnProps & { readonly useSummary: NonNullable<SettingsPane["useSummary"]> },
) {
  const { useSummary, ...column } = props;
  return <Column {...column} summary={useSummary()} />;
}

/** A section under its head: its name, and what it holds where it is a list. */
export function PaneColumn(props: PaneColumnProps) {
  const { useSummary } = props.pane;
  return useSummary ? (
    <SummedColumn key={props.pane.id} {...props} useSummary={useSummary} />
  ) : (
    <Column {...props} summary={null} />
  );
}
