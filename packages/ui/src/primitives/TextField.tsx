import {
  forwardRef,
  useRef,
  type FocusEvent,
  type InputHTMLAttributes,
  type ReactElement,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import "./text-field.css";

/**
 * The two shapes. `box` (default): the field draws its own 1px edge on
 * the canvas ground, present while the field is empty — a placeholder is
 * not an affordance, an edge is. `line`: no box of its own, because the
 * container already draws the boundary (a compose header row's hairline,
 * a floating card's edge, a rail row that accepts typing) — a second edge
 * inside any of those turns one calm object into two stacked widgets.
 * `line` is legal only inside such a container; the field-treatment
 * census cannot see containers, so this sentence is the rule.
 */
export type TextFieldShape = "box" | "line";

interface TextFieldOwnProps {
  shape?: TextFieldShape;
  /** Monospace value — a host, a port, a code. Letter-spaced a hair so digits read as digits. */
  mono?: boolean;
  className?: string;
  /**
   * Focus LEFT the field and did not come back: asked one task after the blur. An assistive
   * tool's focus request on a field that already has focus blurs and refocuses it inside one
   * call, and a field that unmounted on that blur took WebKitGTK's web process with it
   * (2.52.6, measured). A field that closes itself when focus leaves closes here, never in
   * `onBlur`.
   */
  onFocusLeft?: () => void;
}

export type TextFieldInputProps = TextFieldOwnProps & { multiline?: false }
  & Omit<InputHTMLAttributes<HTMLInputElement>, "className">;
export type TextFieldAreaProps = TextFieldOwnProps & { multiline: true }
  & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className">;
export type TextFieldProps = TextFieldInputProps | TextFieldAreaProps;

function classes(shape: TextFieldShape | undefined, mono: boolean | undefined, multiline: boolean, className?: string): string {
  return ["tf", multiline ? "tf-area" : null, shape === "line" ? "tf-line" : null, mono ? "tf-mono" : null, className]
    .filter(Boolean)
    .join(" ");
}

/**
 * The one text field — every place a person types wears this: a real
 * <input> or <textarea> with the treatment's classes, native attributes
 * passed through, the ref forwarded. No label, hint or error slot —
 * `SettingsField` and the compose header compose those; this owns only
 * the look (edge, ground, focus ring, read-only/disabled, both schemes,
 * both faces). `multiline` chooses the element; the overloads make the
 * matching ref type a compile-time fact. A caller's `className` is kept
 * alongside the treatment's: host stylesheets still size these controls.
 */
const TextFieldBase = forwardRef<HTMLInputElement | HTMLTextAreaElement, TextFieldProps>(
  function TextField(props, ref) {
    // The latest callback, read when the deferred check runs: it closes over the render that
    // is current then, not the one the blur happened in.
    const left = useRef(props.onFocusLeft);
    left.current = props.onFocusLeft;
    const withLeave = <E extends HTMLElement>(onBlur?: (e: FocusEvent<E>) => void) =>
      props.onFocusLeft === undefined
        ? onBlur
        : (e: FocusEvent<E>): void => {
            onBlur?.(e);
            const el = e.currentTarget;
            setTimeout(() => {
              if (el.isConnected && el.ownerDocument.activeElement !== el) left.current?.();
            }, 0);
          };
    if (props.multiline) {
      const { multiline: _multiline, shape, mono, className, onFocusLeft: _left, onBlur, ...rest } = props;
      return (
        <textarea
          ref={ref as Ref<HTMLTextAreaElement>}
          className={classes(shape, mono, true, className)}
          onBlur={withLeave(onBlur)}
          {...rest}
        />
      );
    }
    const { multiline: _multiline, shape, mono, className, onFocusLeft: _left, onBlur, type = "text", ...rest } = props;
    return (
      <input
        ref={ref as Ref<HTMLInputElement>}
        type={type}
        className={classes(shape, mono, false, className)}
        onBlur={withLeave(onBlur)}
        {...rest}
      />
    );
  },
);
TextFieldBase.displayName = "TextField";

interface TextFieldComponent {
  (props: TextFieldInputProps & { ref?: Ref<HTMLInputElement> }): ReactElement | null;
  (props: TextFieldAreaProps & { ref?: Ref<HTMLTextAreaElement> }): ReactElement | null;
  displayName?: string;
}

export const TextField = TextFieldBase as unknown as TextFieldComponent;
