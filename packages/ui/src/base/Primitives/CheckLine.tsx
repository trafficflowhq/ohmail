import "./switch.css";
import "./check-line.css";

export interface CheckLineProps {
  id: string;
  children: string;
  /** The id of an element off the line that says something about it: read as its description. */
  describedBy?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/** An inline opt-in. The browser owns focus, Space and the label's click target. */
export function CheckLine({ id, children, describedBy, checked, onChange }: CheckLineProps) {
  return (
    <label className="oh-switch-line oh-checkline" htmlFor={id}>
      <span>{children}</span>
      <span className="oh-checkline-control">
        <span className="oh-switch" aria-hidden="true" data-on={checked ? "" : undefined}>
          <span className="oh-switch-knob" />
        </span>
        <input
          className="oh-control oh-checkline-input"
          id={id}
          type="checkbox"
          role="switch"
          aria-describedby={describedBy}
          checked={checked}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
      </span>
    </label>
  );
}
