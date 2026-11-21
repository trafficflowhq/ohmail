import { useEffect, useImperativeHandle, useRef, type ReactNode, type RefObject } from "react";
import { Field } from "@ohmail/ui/base";
import { secretOf } from "@ohmail/app-logic/mailboxes/connect/secret";
import type { PasswordHandle } from "@ohmail/app-logic/mailboxes/connect/use-connect-form";

/**
 * THE ONE PASSWORD FIELD, and the only place a typed password is: the field's own box. No state holds it, here or
 * above; no prop carries it up; when the field is no longer drawn it is gone. The form reaches it through a handle:
 * `take` seals what is typed for one press, `clear` forgets it.
 *
 * The kit's password field, handed no value: what is typed stands in the field's own box, as the browser holds it,
 * and is written into no attribute of the page, where a snapshot, a report or a script that reads markup would find
 * it. The browser is told not to fill it, and it has no name: a press before the page's script has taken the form
 * sends nothing typed.
 */
export function PasswordField({
  label,
  hint,
  handle,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  handle: RefObject<PasswordHandle | null>;
  /** Whether it holds anything now. Never what. */
  onChange(filled: boolean): void;
}): ReactNode {
  const box = useRef<HTMLInputElement | null>(null);
  const filled = useRef(false);
  const told = useRef(onChange);
  told.current = onChange;
  useImperativeHandle(
    handle,
    () => ({
      take: () => secretOf(box.current?.value ?? ""),
      clear: () => {
        if (box.current) box.current.value = "";
        filled.current = false;
      },
    }),
    [],
  );
  /* Removing an empty field changes no password. */
  useEffect(
    () => () => {
      if (filled.current) told.current(false);
    },
    [],
  );
  return (
    <Field
      ref={box}
      label={label}
      type="password"
      autoComplete="off"
      hint={hint}
      onChange={(next) => {
        filled.current = next !== "";
        onChange(filled.current);
      }}
    />
  );
}
