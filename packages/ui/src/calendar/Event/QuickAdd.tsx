import type { KeyboardEvent, MouseEventHandler, ReactNode, Ref } from "react";
import { Button } from "../../base/index.js";
import { cx, toneOf, toneStyle, type CalendarTone } from "../tone.js";
import "./quick-add.css";

export interface QuickAddProps {
  /** Its name: "New event". */
  label: string;
  /** The calendar the draft goes to: the line stands on its colour. */
  tone: CalendarTone;
  line: {
    value: string;
    /** The line's name, and what it shows while it is empty. */
    label: string;
    placeholder: string;
    /** The typed words that filled a field, as places in `value`: from, and to (not included). */
    found?: readonly (readonly [number, number])[];
    onChange?: (value: string) => void;
    ref?: Ref<HTMLInputElement>;
  };
  close: { label: string; onPress?: MouseEventHandler<HTMLButtonElement> };
  /** Enter in the line or in a field of the form adds the event. In the notes it is a new line; on a control it presses the control. */
  onAdd?: () => void;
  busy?: boolean;
  /** The form under the line, with what can still be added and Add. */
  children: ReactNode;
  /** It stood already: it does not arrive again. */
  still?: boolean;
}

/** The line cut where the found words stand, so each can be marked behind the typed text. */
function marked(value: string, found: readonly (readonly [number, number])[]): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  [...found]
    .sort((a, b) => a[0] - b[0])
    .forEach(([from, to], i) => {
      if (from < at || to <= from) return;
      out.push(value.slice(at, from));
      out.push(
        <u key={i} className="oh-qa-mark">
          {value.slice(from, to)}
        </u>,
      );
      at = to;
    });
  out.push(value.slice(at));
  return out;
}

/**
 * A new event from one typed line, with the form under it. The line and the form write to the
 * same draft; the words that filled a field are marked in the line. Esc and the close leave it;
 * what becomes of the typed words is the app's to say.
 */
export function QuickAdd({ label, tone, line, close, onAdd, children, still, busy }: QuickAddProps) {
  const own = toneOf(tone);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close.onPress?.(event as never);
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.nativeEvent.isComposing
    )
      return;
    const on = event.target as HTMLElement;
    if (on.tagName !== "INPUT") return;
    event.preventDefault();
    onAdd?.();
  };
  return (
    <div className="oh-qa-wrap">
      <div
        className={cx("oh-qa", own.className)}
        data-tone={own["data-tone"]}
        data-still={still ? "" : undefined}
        style={toneStyle(tone)}
        role="dialog"
        aria-label={label}
        aria-busy={busy || undefined}
        onKeyDown={keys}
      >
        <div className="oh-display oh-qa-line">
          <div className="oh-qa-found" aria-hidden="true">
            {marked(line.value, line.found ?? [])}
          </div>
          <input
            ref={line.ref}
            className="oh-control oh-qa-input"
            type="text"
            readOnly={busy}
            value={line.value}
            placeholder={line.placeholder}
            aria-label={line.label}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => line.onChange?.(e.target.value)}
          />
          <span className="oh-qa-close">
            <Button kind="quiet" size="s" icon="x" label={close.label} onPress={close.onPress} />
          </span>
        </div>
        {busy ? <div inert>{children}</div> : children}
      </div>
    </div>
  );
}
