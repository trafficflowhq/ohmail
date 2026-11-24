/** THE STAGE: one body over the whole app. While it stands, the frame behind it is inert. */
import type { ReactNode } from "react";
import { portalRenderer } from "@ohmail/ui/portal-renderer";
import type { StageProps } from "./contract.js";

/* What a stage opens (its questions, the second factor) is drawn inside it: the stage already stands over the whole
   window, and a layer drawn in the body would stand under it. */
const inPlace = (content: ReactNode): ReactNode => content;

export function Stage({ open, label, children }: StageProps) {
  if (!open) return null;
  return (
    <div className="fr-stage" role="dialog" aria-modal="true" aria-label={label}>
      <portalRenderer.Provider value={inPlace}>{children}</portalRenderer.Provider>
    </div>
  );
}
