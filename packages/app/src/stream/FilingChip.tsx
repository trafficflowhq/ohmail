import { createContext } from "react";
import { Chip } from "@ohmail/ui";
import { useText } from "../text/index.js";

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
  if (choice === "approved") return <Chip icon="check">{example.approvedLabel}</Chip>;
  if (choice === "corrected") return <Chip icon="route">{example.correctedLabel}</Chip>;
  return (
    <Chip
      variant="ai"
      actions={[
        { label: t("aiApprove"), onPress: () => choose("approved") },
        { label: t("aiCorrect"), onPress: () => choose("corrected") },
      ]}
    >
      <span className="st-filing-label">{example.label}</span>
    </Chip>
  );
}
