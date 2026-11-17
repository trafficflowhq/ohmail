/**
 * A PASSWORD IS NEVER HANDED TO REACT AS A VALUE. An input that React is handed a value for has that value written
 * into its `value` attribute on every key, and so into the page's markup: where a snapshot of the page, a report
 * tool or any script that reads `outerHTML` finds it. What is typed into a password field of the kit stands in the
 * field's own box and in no attribute, whatever a form hands the kit.
 *
 * A form that keeps what is typed may still hand it in: the box is kept in step with it through the element's own
 * property, which writes no attribute, so the form can empty the field and a field drawn again shows what the form
 * still holds. A form that hands nothing has the password in the field alone, and takes and empties it through `ref`.
 *
 * The rule holds for the element's life: a field that was a password once is handed no value while a form shows it
 * as text either, and what a draw as text wrote before it became a password is taken out of the attribute.
 */
import { useCallback, useLayoutEffect, useRef, useState, type Ref } from "react";

/** What an `<input>` of the kit is handed: its ref, and its value where it may have one. */
export interface Box {
  /** For the `<input>`: the kit's own ref and the form's in one, the same function while the form's ref is the same. */
  ref: (el: HTMLInputElement | null) => void;
  /** The element, for the part's own use. */
  own: { readonly current: HTMLInputElement | null };
  /** For the `<input>`: nothing for a password, nor for a field that was one; the value itself for every other. */
  value: string | undefined;
}

/**
 * The box of an `<input>` of the kit. For a password, and for a field that was one, React is handed no value, and
 * the box follows `value` by the element's own property each time the part draws; for every other kind the value
 * goes to React as it came.
 */
export function useBox(
  secret: boolean,
  value: string | undefined,
  form: Ref<HTMLInputElement> | undefined,
): Box {
  const own = useRef<HTMLInputElement | null>(null);
  const [was, setWas] = useState(secret);
  if (secret && !was) setWas(true);
  const kept = secret || was;
  const ref = useCallback(
    (el: HTMLInputElement | null) => {
      own.current = el;
      if (typeof form === "function") form(el);
      else if (form) form.current = el;
    },
    [form],
  );
  useLayoutEffect(() => {
    const el = own.current;
    if (!kept || !el) return;
    if (el.hasAttribute("value")) el.removeAttribute("value");
    if (value !== undefined && el.value !== value) el.value = value;
  });
  return { ref, own, value: kept ? undefined : value };
}
