/**
 * THE PEOPLE THE TEXT MEANS, over the messages: a few of them (all on a press), each a row whose press makes them
 * the question's person. With `from:` or `to:` being typed, the people it names on that side. Nothing stands here
 * once a person is set, for an address typed whole (it is already the search), or where the host keeps no book.
 */
import { useState } from "react";
import type { AddressBookEntry } from "@ohmail/client-engine";
import { peopleFor, type SearchListModel, type TypedOperator } from "@ohmail/app-logic/search";
import { Button } from "@ohmail/ui/base";
import { GroupHeading, Row, Rows } from "@ohmail/ui/mail";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import type { SearchBeside } from "./beside.js";

/** How many stand before All: fewer under typed words, more for a side being typed. */
const FEW_WITH_WORDS = 3;
const FEW = 5;

export function SearchPeople({
  model,
  beside,
  open,
  words,
  onPick,
}: {
  model: SearchListModel;
  beside: SearchBeside;
  /** The operator still being typed at the field's end, or null. */
  open: TypedOperator | null;
  /** The words typed, without the operators. */
  words: string;
  onPick: (p: AddressBookEntry, dir: "any" | "from" | "to") => void;
}) {
  const t = useText("search");
  const [all, setAll] = useState(false);
  const side = open !== null && (open.key === "from" || open.key === "to") ? open.key : null;
  if (model.person !== null || beside.people === NONE || model.addressOnly) return null;
  if (side === null && words === "" && !model.resting) return null;
  const overview = new Map(model.restingPeople.map((entry) => [entry.person.address, entry]));
  const who = model.resting
    ? model.restingPeople
    : peopleFor(side !== null ? open!.value : words, beside.people()).map(
        (person) => overview.get(person.address) ?? { person, from: 0, to: 0 },
      );
  if (who.length === 0) return null;
  const few = model.resting || side !== null ? FEW : FEW_WITH_WORDS;
  const shown = all ? who : who.slice(0, few);
  const heading = side === "from" ? t("facetFrom") : side === "to" ? t("to") : t("people");
  return (
    <>
      <GroupHeading
        count={String(who.length)}
        aside={
          who.length > few ? (
            <Button kind="quiet" size="s" expanded={all} onPress={() => setAll((was) => !was)}>
              {all ? t("fewer") : t("all")}
            </Button>
          ) : undefined
        }
      >
        {heading}
      </GroupHeading>
      <Rows listLabel={heading}>
        {shown.map((entry) => {
          const p = entry.person;
          const name = p.name || p.address;
          const address = p.name === "" ? undefined : p.address;
          const amount =
            entry.from === 0
              ? t("peopleTo", { count: entry.to })
              : entry.to === 0
                ? t("peopleFrom", { count: entry.from })
                : t("peopleBoth", { from: entry.from, to: entry.to });
          return (
            <div role="listitem" key={p.address}>
              <Row
                who={name}
                address={model.resting ? undefined : address}
                preview={model.resting ? address : undefined}
                people={[{ name, address: p.address }]}
                subject=""
                amount={amount}
                onOpen={() => onPick(p, side ?? "any")}
              />
            </div>
          );
        })}
      </Rows>
    </>
  );
}
