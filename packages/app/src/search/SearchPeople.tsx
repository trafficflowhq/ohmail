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
  if (side === null && words === "") return null;
  const who = peopleFor(side !== null ? open!.value : words, beside.people());
  if (who.length === 0) return null;
  const few = side !== null ? FEW : FEW_WITH_WORDS;
  const shown = all ? who : who.slice(0, few);
  const heading = side === "from" ? t("facetFrom") : side === "to" ? t("to") : t("people");
  return (
    <>
      <GroupHeading count={String(who.length)}>{heading}</GroupHeading>
      <Rows>
        {shown.map((p) => (
          <div role="listitem" key={p.address}>
            <Row
              who={p.name === "" ? p.address : p.name}
              address={p.name === "" ? undefined : p.address}
              people={[{ name: p.name === "" ? p.address : p.name, address: p.address }]}
              subject=""
              amount={t("peopleCount", { count: p.count })}
              onOpen={() => onPick(p, side ?? "any")}
            />
          </div>
        ))}
      </Rows>
      {who.length > few ? (
        <Button kind="quiet" size="s" onPress={() => setAll((was) => !was)}>
          {all ? t("fewer") : t("all")}
        </Button>
      ) : null}
    </>
  );
}
