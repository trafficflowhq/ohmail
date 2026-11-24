/**
 * SEARCH'S FIELD: the kit's find field, named Search, in no form and with no name, so what is typed is asked by the
 * app and never kept by the browser. It takes the keyboard when Search opens; Enter asks the whole mailbox at once
 * (the arrows, Enter on a result and Escape are the list's own keys in the registry). The time the search took
 * stands at its end. A person set stands before the words as one control that lets them go, and so does Backspace
 * in an empty field; what is typed then searches their mail.
 */
import { useEffect, useRef, type KeyboardEvent } from "react";
import type { SearchListModel } from "@ohmail/app-logic/search";
import { FindField } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

export function SearchField({
  model,
  onType,
  onEnter,
  named,
  focusOnMount,
}: {
  model: SearchListModel;
  focusOnMount: boolean;
  onType: (q: string) => void;
  /** The person set, as their control names them (their address where another of the name is known); null for none. */
  named: string | null;
  /** Enter: the question asked at once, or the person a `from:` or `to:` being typed names first. */
  onEnter: () => void;
}) {
  const t = useText("search");
  const { boxRef, person } = model;
  const focusInitially = useRef(focusOnMount);
  useEffect(() => {
    if (focusInitially.current) boxRef.current?.focus({ preventScroll: true });
  }, [boxRef]);
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    /* A held Enter asks once: its repeats are not new questions. */
    if (event.key === "Enter") {
      if (!event.repeat) onEnter();
    } else if (event.key === "Backspace" && person !== null && event.currentTarget.value === "") {
      event.preventDefault();
      model.setPerson(null);
    }
  };
  const ms = model.headMs ?? model.tookMs;
  const took = (model.text !== "" || model.narrowed) && ms > 0 ? t("scopeServerMs", { ms }) : undefined;
  const name = person === null ? null : named;
  return (
    <FindField
      ref={boxRef}
      label={t("aria")}
      placeholder={person === null ? t("placeholder") : t("inTheirMail")}
      value={model.query}
      onChange={onType}
      onKeyDown={keys}
      took={took}
      chip={
        person === null || name === null
          ? undefined
          : {
              label: name,
              person: { name: person.name ?? person.address, address: person.address },
              remove: t("removePerson", { name }),
              onRemove: () => {
                model.setPerson(null);
                boxRef.current?.focus();
              },
            }
      }
      /* The clear control leaves with the words: the caret goes back in the field, never to the page. */
      clear={{
        label: t("clear"),
        onPress: () => {
          model.type("");
          boxRef.current?.focus();
        },
      }}
    />
  );
}
