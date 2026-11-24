import type { ReactNode } from "react";

export interface PhoneDrafterProps {
  body: string;
  subject: string;
  mailboxId: string | null;
  messageId: string | null;
  allowed?: boolean;
  blocked: boolean;
  onChange: (text: string) => void;
  children: (switcher: ReactNode, tool: ReactNode, notice: ReactNode, draftSelected: boolean) => ReactNode;
}

export function PhoneDrafter({ children }: PhoneDrafterProps) {
  return children(null, null, null, false);
}
