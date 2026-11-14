import type { Ref } from "react";
import "./switch.css";

export interface SwitchProps {
  /** Its name. Shown beside it with `labelled`. */
  label: string;
  on: boolean;
  onChange?: (on: boolean) => void;
  /** Draw the name beside the switch. */
  labelled?: boolean;
  disabled?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** On or off, at once. Never beside a Save button. */
export function Switch({ label, on, onChange, labelled, disabled, ref }: SwitchProps) {
  const control = (
    <button
      ref={ref}
      type="button"
      className="oh-control oh-switch"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
    >
      <i className="oh-switch-knob" />
    </button>
  );
  if (!labelled) return control;
  return (
    <span className="oh-switch-line">
      <span aria-hidden="true">{label}</span>
      {control}
    </span>
  );
}
