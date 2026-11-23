import { useId, type ReactNode } from "react";
import { Blank, type BlankProps } from "@ohmail/ui/base";

/**
 * A blank in a page's sentence, held by a label as the design holds it. The kit's blank names itself (its `label`);
 * the label around it carries the same name, hidden from the page and from a screen reader alike, wrapped around the blank: a form finds its blank by the name its label gives it, as it finds a labelled field.
 */
export function SentenceBlank(props: BlankProps & { id?: string; describedBy?: string }): ReactNode {
  const generated = useId();
  const { ref, id = generated, describedBy, ...blank } = props;
  return (
    <label>
      <span hidden>{props.label}</span>
      <Blank
        {...blank}
        ref={(el) => {
          /* Keep the field IDs used by the door's existing focus and form logic. */
          if (el) {
            el.id = id;
            el.closest("label")?.setAttribute("for", id);
            if (describedBy === undefined) el.removeAttribute("aria-describedby");
            else el.setAttribute("aria-describedby", describedBy);
          }
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
      />
    </label>
  );
}
