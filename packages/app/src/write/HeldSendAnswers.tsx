import type { ReactNode } from "react";
import { useText } from "../text/index.js";

interface Answer {
  readonly id: "again" | "sent";
  readonly label: string;
  readonly onPress: () => void;
}

/** The two decisions every held send offers, drawn in the action panel or the editor's status line. */
export function HeldSendAnswers({
  draftId,
  onResolve,
  onSendAgain,
  sentLabel,
  children,
}: {
  readonly draftId: string;
  readonly onResolve: (draftId: string, outcome: "arrived" | "not_arrived") => void;
  /** Drafts also opens the draft after the account confirms the answer. */
  readonly onSendAgain?: () => void;
  /** Write's status names the dismissal explicitly. */
  readonly sentLabel?: string;
  readonly children: (again: Answer, sent: Answer) => ReactNode;
}) {
  const t = useText("drafts");
  return children(
    { id: "again", label: t("sendAgain"), onPress: onSendAgain ?? (() => onResolve(draftId, "not_arrived")) },
    { id: "sent", label: sentLabel ?? t("heldItWasSent"), onPress: () => onResolve(draftId, "arrived") },
  );
}
