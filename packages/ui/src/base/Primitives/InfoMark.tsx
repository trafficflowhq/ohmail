import type { MouseEventHandler, Ref } from "react";
import { Icon } from "../../icons/Icon.js";
import "./info-mark.css";

export interface InfoMarkProps {
  /** Its name: what the card is about ("About storage"). */
  label: string;
  /** Whether its card stands open. */
  expanded?: boolean;
  onPress?: MouseEventHandler<HTMLButtonElement>;
  ref?: Ref<HTMLButtonElement>;
}

/** A word that needs saying once gets a small (i); behind it a card of a few short lines. */
export function InfoMark({ label, expanded, onPress, ref }: InfoMarkProps) {
  return (
    <button
      ref={ref}
      type="button"
      className="oh-control oh-infomark"
      aria-haspopup="dialog"
      aria-expanded={expanded ?? false}
      aria-label={label}
      title={label}
      onClick={onPress}
    >
      <Icon name="info" size={18} />
    </button>
  );
}
