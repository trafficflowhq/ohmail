/** THE STAGE: one body over the whole app. While it stands, the frame behind it is inert. */
import type { StageProps } from "./contract.js";

export function Stage({ open, label, children }: StageProps) {
  if (!open) return null;
  return (
    <div className="fr-stage" role="dialog" aria-modal="true" aria-label={label}>
      {children}
    </div>
  );
}
