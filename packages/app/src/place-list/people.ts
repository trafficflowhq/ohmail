import type { EngineMessage } from "@ohmail/wire";
import { useOtherThreadPeople } from "@ohmail/app-logic/reading";
import type { RowPerson, RowProps } from "@ohmail/ui/mail";
import { useMemo } from "react";
import { useLocale, useText } from "../text/index.js";

type Faces = Pick<RowProps, "people" | "peopleMore" | "peopleLabel">;

/** List rows share the presented mirror's participant index. The row's own sender stays first. */
export function useRowPeople(): (message: EngineMessage, lead: RowPerson) => Faces {
  const others = useOtherThreadPeople();
  const locale = useLocale();
  const t = useText("ohbox");
  const list = useMemo(() => new Intl.ListFormat(locale === "en" ? "en-GB" : locale), [locale]);
  return (message, lead) => {
    const thread = others(message.threadId, lead.address);
    if (thread.length === 0) return { people: [lead] };
    const people = [lead, ...thread.map(({ name, address }) => ({ name: name?.trim() || address, address }))];
    return {
      people,
      peopleMore: people.length > 2 ? `+${people.length - 1}` : undefined,
      peopleLabel: t("row.people", {
        count: people.length,
        names: list.format(people.map((person) => person.name)),
      }),
    };
  };
}
