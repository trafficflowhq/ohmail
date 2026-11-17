import { useId, type ReactNode } from "react";
import { Blank, type BlankProps } from "@ohmail/ui/base";

/**
 * A blank in a page's sentence, held by a label as the design holds it. The kit's blank names itself (its `label`);
 * the label around it carries the same name, hidden from the page and from a screen reader alike, bound to the blank
 * by its id: a form finds its blank by the name its label gives it, as it finds a labelled field.
 */
export function SentenceBlank(props: BlankProps): ReactNode {
  const id = useId();
  const { ref, ...blank } = props;
  return (
    <label htmlFor={id}>
      <span hidden>{props.label}</span>
      <Blank
        {...blank}
        ref={(el) => {
          /* The kit's blank takes no id: it is given here, where the label that binds it stands. */
          if (el) el.id = id;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
      />
    </label>
  );
}
