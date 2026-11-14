import { Row } from "@ohmail/ui/mail";
import type { PaneSummary, SettingsPane } from "./contract.js";

export interface PaneRowProps {
  readonly pane: SettingsPane;
  readonly name: string;
  readonly open: boolean;
  readonly onOpen: () => void;
}

function Entry({
  pane,
  name,
  open,
  onOpen,
  summary,
}: PaneRowProps & { readonly summary: PaneSummary | null }) {
  return (
    <Row
      entry
      who={name}
      people={[]}
      sign={pane.icon}
      subject={summary?.value ?? ""}
      preview={summary?.detail}
      unread={summary?.hot}
      open={open}
      onOpen={onOpen}
      mark={{ id: pane.id }}
    />
  );
}

/** A section that says something beside its name reads it from memory; one with no summary calls no hook. */
function SummedEntry(props: PaneRowProps & { readonly useSummary: NonNullable<SettingsPane["useSummary"]> }) {
  const { useSummary, ...row } = props;
  return <Entry {...row} summary={useSummary()} />;
}

/** One section in the menu: named by its name alone, the current page while it stands. */
export function PaneRow(props: PaneRowProps) {
  const { useSummary } = props.pane;
  return useSummary ? (
    <SummedEntry {...props} useSummary={useSummary} />
  ) : (
    <Entry {...props} summary={null} />
  );
}
