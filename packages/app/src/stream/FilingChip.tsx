import { createContext } from "react";
import { Button, Icon } from "@ohmail/ui/base";
import { useText } from "../text/index.js";
import "./filing-chip.css";

/** The filing example supplied in the demo's local mirror. */
export interface FilingChipData {
  readonly afterId: string;
  readonly label: string;
  readonly approvedLabel: string;
  readonly correctedLabel: string;
}

export type FilingChoice = "approved" | "corrected";

export const FilingChoiceContext = createContext<{
  readonly choice: FilingChoice | null;
  readonly choose: (choice: FilingChoice) => void;
} | null>(null);

export function FilingChip({
  example,
  choice,
  choose,
}: {
  example: FilingChipData;
  choice: FilingChoice | null;
  choose: (choice: FilingChoice) => void;
}) {
  const t = useText("reads");
  if (choice) {
    return (
      <span className="st-filing-control" data-chip="rationale">
        <Icon name={choice === "approved" ? "check" : "move"} size={16} />
        {choice === "approved" ? example.approvedLabel : example.correctedLabel}
      </span>
    );
  }
  return (
    <span className="st-filing-control" data-chip="ai">
      <Icon name="spark" size={16} />
      <span className="st-filing-label">{example.label}</span>
      <Button kind="quiet" size="s" onPress={() => choose("approved")}>
        {t("aiApprove")}
      </Button>
      <Button kind="quiet" size="s" onPress={() => choose("corrected")}>
        {t("aiCorrect")}
      </Button>
    </span>
  );
}
