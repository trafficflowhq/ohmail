import {
  forwardRef,
  type InputHTMLAttributes,
  type ReactElement,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import "./text-field.css";

/**
 * THE TWO SHAPES, and the rule that decides between them.
 *
 *   box   the default. The field draws its own 1px edge on the canvas ground — present while the
 *         field is EMPTY, which is the whole point: a placeholder and a resize handle are not an
 *         affordance, an edge is.
 *   line  no box of its own, because the CONTAINER already draws the boundary — a compose header
 *         row (`.c-field`, whose hairline runs under label and control alike and turns accent on
 *         focus), a floating card's edge (the tag picker, the command palette, the search pill), a
 *         rail row that happens to accept typing. A second edge inside any of those would turn one
 *         calm object into two stacked widgets. `line` is legal ONLY inside such a container; the
 *         field-treatment census cannot see containers, so this sentence is the rule.
 */
export type TextFieldShape = "box" | "line";

interface TextFieldOwnProps {
  shape?: TextFieldShape;
  /** Monospace value — a host, a port, a code. Letter-spaced a hair so digits read as digits. */
  mono?: boolean;
  className?: string;
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
 * THE ONE TEXT FIELD — every place a person types into this product wears this.
 *
 * It is a thin element: a real `<input>` or `<textarea>` with the treatment's classes, every
 * native attribute passed through, the ref forwarded. There is deliberately no label, hint or
 * error slot here — `SettingsField` composes those around it, the compose header composes its
 * own row, and a primitive that owned the layout of its surroundings would be a second settings
 * grammar. What it owns is the LOOK of the control: the edge, the ground, the focus ring, the
 * read-only and disabled states, in both schemes and on both faces, from the tokens.
 *
 * `multiline` chooses the element. The ref type follows it: pass a `RefObject<HTMLInputElement>`
 * to the input form and a `RefObject<HTMLTextAreaElement>` to the textarea form — the overloads
 * below are what make that a compile-time fact rather than a cast at every call site.
 *
 * A caller's `className` is kept alongside the treatment's, never instead of it: the host
 * stylesheets still size and place these controls (`.rcp-input`'s typeable floor, the subject's
 * heavier type, a settings column's width), and a test that finds a field by its host class
 * still finds it.
 */
const TextFieldBase = forwardRef<HTMLInputElement | HTMLTextAreaElement, TextFieldProps>(
  function TextField(props, ref) {
    if (props.multiline) {
      const { multiline: _multiline, shape, mono, className, ...rest } = props;
      return (
        <textarea
          ref={ref as Ref<HTMLTextAreaElement>}
          className={classes(shape, mono, true, className)}
          {...rest}
        />
      );
    }
    const { multiline: _multiline, shape, mono, className, type = "text", ...rest } = props;
    return (
      <input
        ref={ref as Ref<HTMLInputElement>}
        type={type}
        className={classes(shape, mono, false, className)}
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
