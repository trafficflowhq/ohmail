import { useId, type Ref } from "react";
import { Icon } from "../../icons/Icon.js";
import "./field.css";

export interface FieldProps {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  type?: "text" | "password" | "email" | "search" | "tel" | "url" | "time" | "date" | "number";
  placeholder?: string;
  /** One line under it. A refusal takes its place. */
  hint?: string;
  /** The refusal: one line that names the fix. */
  refusal?: string;
  /** Several lines: how many it starts with. */
  lines?: number;
  /** In a menu: one line, the label beside the field. */
  row?: boolean;
  name?: string;
  autoComplete?: string;
  id?: string;
  ref?: Ref<HTMLInputElement | HTMLTextAreaElement>;
}

/** A labelled field. The label is bound to it; a refusal is said with it. */
export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
  refusal,
  lines,
  row,
  name,
  autoComplete = "off",
  id,
  ref,
}: FieldProps) {
  const own = useId();
  const at = id ?? own;
  const said = (refusal ?? hint) ? `${at}-said` : undefined;
  const shared = {
    id: at,
    name,
    className: "oh-control oh-field-input",
    value,
    placeholder,
    "aria-invalid": refusal ? true : undefined,
    "aria-describedby": said,
    readOnly: !onChange,
    spellCheck: false,
  } as const;
  return (
    <div className="oh-field" data-refused={refusal ? "" : undefined} data-row={row ? "" : undefined}>
      <label className="oh-field-label" htmlFor={at}>
        {label}
      </label>
      {lines ? (
        <textarea
          {...shared}
          ref={ref as Ref<HTMLTextAreaElement>}
          rows={lines}
          data-lines=""
          onChange={(e) => onChange?.(e.currentTarget.value)}
        />
      ) : (
        <input
          {...shared}
          ref={ref as Ref<HTMLInputElement>}
          type={type}
          autoComplete={autoComplete}
          onChange={(e) => onChange?.(e.currentTarget.value)}
        />
      )}
      {refusal ? (
        <p id={said} className="oh-text oh-field-refusal">
          <Icon name="warn" size={18} />
          <span>{refusal}</span>
        </p>
      ) : hint ? (
        <p id={said} className="oh-text oh-field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
