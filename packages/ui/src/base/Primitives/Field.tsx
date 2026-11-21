import { useId, type KeyboardEvent, type Ref } from "react";
import { Icon, type IconName } from "../../icons/Icon.js";
import "./field.css";
import { useBox } from "./secret.js";

interface FieldShared {
  label: string;
  placeholder?: string;
  /** One line under it. A refusal takes its place. */
  hint?: string;
  /** The refusal: one line that names the fix. */
  refusal?: string;
  /** Announce a refusal immediately when it appears. */
  refusalAlert?: boolean;
  /** Off while what it holds is being saved: it takes no keys, and a screen reader hears that it is unavailable. */
  disabled?: boolean;
  /** In a menu: one line, the label beside the field. */
  row?: boolean;
  /** Only its box: the label is not drawn and names it to a screen reader alone (a list's search, whose placeholder says what it finds). */
  bare?: boolean;
  /** A sign inside a bare field's box, before the words: `search` for a list's search. */
  sign?: IconName;
  /** The name it is sent by. Left out: it is sent by none, so a press before the page's script runs sends nothing typed. */
  name?: string;
  /** What the browser may fill it with ("username", "current-password"); off unless the form says. */
  autoComplete?: string;
  /** The keyboard a phone opens for it: `numeric` for a code. */
  inputMode?: "none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url";
  /** At most this many characters. */
  maxLength?: number;
  /** The ids of what else describes it, said after its own hint or refusal. */
  "aria-describedby"?: string;
  /**
   * The keys have left it, by Tab, a press elsewhere or the window: where a form looks at what was typed once
   * the person is done with the field. It is told apart from what is typed, and nothing is handed: the form
   * holds the words, and a password is taken through `ref`.
   */
  onLeave?: () => void;
  /**
   * Enter was pressed in a field of one line, and not to end an input method's composition. The key is not
   * cancelled: a form around the field is still sent by it. A field of several lines never says it: Enter there
   * is a new line.
   */
  onEnter?: () => void;
  id?: string;
  /** The element: a form puts the keys on it, and takes and empties a password through it. */
  ref?: Ref<HTMLInputElement | HTMLTextAreaElement>;
}

/** A field of words: the app hands them in and is handed what is typed. Without `onChange` it is read only. */
interface FieldOfWords extends FieldShared {
  type?: "text" | "email" | "search" | "tel" | "url" | "time" | "date" | "number";
  value: string;
  onChange?: (value: string) => void;
  /** Several lines: how many it starts with. */
  lines?: number;
  /** A date's, a time's or a number's least and last ("2026-11-18"): the browser's own picker offers nothing past them. */
  min?: string;
  max?: string;
}

/**
 * A password. What is typed stands in the field's own box and is written into no attribute of the page, whatever
 * is handed here (`secret.ts`). `value` is not needed: a form takes what was typed through `ref` at its press
 * (`ref.current.value`) and empties it the same way. A form that keeps what is typed may hand it in and is handed
 * every change; the field follows what it holds. It always takes keys: one that should take none is `disabled`.
 */
interface FieldOfSecret extends FieldShared {
  type: "password";
  value?: string;
  onChange?: (value: string) => void;
  lines?: never;
  min?: never;
  max?: never;
}

export type FieldProps = FieldOfWords | FieldOfSecret;

/**
 * A labelled field. The label is bound to it; a refusal is said with it, and said when it appears or changes
 * while the keys are already in the field (the field is a polite live region; what is typed is not its text).
 */
export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
  refusal,
  refusalAlert,
  lines,
  disabled,
  row,
  bare,
  sign,
  name,
  autoComplete = "off",
  inputMode,
  maxLength,
  min,
  max,
  "aria-describedby": describedBy,
  onLeave,
  onEnter,
  id,
  ref,
}: FieldProps) {
  const own = useId();
  const at = id ?? own;
  const secret = type === "password";
  const box = useBox(secret, value, lines ? undefined : (ref as Ref<HTMLInputElement> | undefined));
  const said = (refusal ?? hint) ? `${at}-said` : undefined;
  const described = [said, describedBy].filter(Boolean).join(" ") || undefined;
  const shared = {
    id: at,
    name,
    className: "oh-control oh-field-input",
    placeholder,
    "aria-label": bare ? label : undefined,
    "aria-invalid": refusal ? true : undefined,
    "aria-describedby": described,
    inputMode,
    maxLength,
    readOnly: secret ? undefined : !onChange,
    disabled,
    spellCheck: false,
    onBlur: onLeave,
  } as const;
  const enter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) onEnter?.();
  };
  return (
    <div
      className="oh-field"
      aria-live="polite"
      data-refused={refusal ? "" : undefined}
      data-row={row ? "" : undefined}
      data-sign={sign ? "" : undefined}
    >
      {bare ? null : (
        <label className="oh-field-label" htmlFor={at}>
          {label}
        </label>
      )}
      {sign ? <Icon name={sign} size={18} /> : null}
      {lines ? (
        <textarea
          {...shared}
          value={value}
          ref={ref as Ref<HTMLTextAreaElement>}
          rows={lines}
          data-lines=""
          onChange={(e) => onChange?.(e.currentTarget.value)}
        />
      ) : (
        <input
          {...shared}
          value={box.value}
          ref={box.ref}
          type={type}
          min={min}
          max={max}
          autoComplete={autoComplete}
          onChange={(e) => onChange?.(e.currentTarget.value)}
          onKeyDown={onEnter ? enter : undefined}
        />
      )}
      {refusal ? (
        <p id={said} className="oh-text oh-field-refusal" role={refusalAlert ? "alert" : undefined}>
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
