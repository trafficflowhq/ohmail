import type { ReactNode } from "react";
import type { Run } from "../compose/formatting";

export interface PhoneDrafterProps {
  body: string;
  bodyRuns?: Run[] | null;
  subject: string;
  mailboxId: string | null;
  messageId: string | null;
  allowed?: boolean;
  blocked: boolean;
  offerDraftReply?: true;
  onChange: (text: string, runs?: Run[] | null) => void;
  children: (switcher: ReactNode, tool: ReactNode, notice: ReactNode, draftSelected: boolean, fullTool?: ReactNode) => ReactNode;
}

export function PhoneDrafter({ children }: PhoneDrafterProps) {
  return children(null, null, null, false);
}
