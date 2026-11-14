/**
 * THE PLAIN COMPOSER: the letter's text as a text box, for a phone whose keyboard the rich editor fails. It
 * reports the words alone (no markup) and offers no marks; Mod+Enter sends, an Escape it does not take leaves. Its
 * placeholder is drawn by the composer around it and said from here.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import { letterText } from "@ohmail/ui/mail";
import type { EditorProps } from "../ports.js";

export function PlainEditor(props: EditorProps) {
  const { value, onChange, label, placeholder, editable, focusAtMount, onSendKey, onLeaveKey, onHandle } =
    props;
  const box = useRef<HTMLTextAreaElement | null>(null);
  const said = useRef(onChange);
  said.current = onChange;
  useEffect(() => {
    onHandle({
      marks: "none",
      focus: () => box.current?.focus({ preventScroll: true }),
      insert: (text, how) => {
        const el = box.current;
        if (el === null) return;
        const next =
          how === "replace"
            ? text.text
            : el.value.slice(0, el.selectionStart) + text.text + el.value.slice(el.selectionEnd);
        said.current({ text: next, html: "" });
      },
    });
    return () => onHandle(null);
  }, [onHandle]);
  useEffect(() => {
    if (focusAtMount) box.current?.focus({ preventScroll: true });
  }, [focusAtMount]);
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (onSendKey && e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSendKey();
    } else if (onLeaveKey && e.key === "Escape" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      onLeaveKey();
    }
  };
  return (
    <textarea
      ref={box}
      className={letterText.plain}
      aria-label={label}
      aria-placeholder={placeholder}
      readOnly={!editable}
      value={value.text}
      onChange={(e) => onChange({ text: e.target.value, html: "" })}
      onKeyDown={onKeyDown}
    />
  );
}
