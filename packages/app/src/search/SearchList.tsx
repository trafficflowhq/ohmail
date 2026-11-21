/**
 * SEARCH'S LIST: its head with the field and what narrows the results, then its own scroller with the people the
 * text means, the one list of results and what was searched, or what an empty answer says. Drawn from the model above
 * it; nothing here decides. Near the scroller's end the next page is asked, and past a walk's bound the person's
 * scroll looks further.
 *
 * Where the host's server takes a person, unread and the days, what is typed as an operator becomes its filter once a
 * space finishes it (`from:` and `to:` a person, `in:` a place the answer counted, `has:` files, `is:unread`) and
 * leaves the field; one met inside the words stays words. Elsewhere it is searched as words, and that is said.
 */
import { useMemo, useRef, type UIEvent } from "react";
import type { AddressBookEntry } from "@ohmail/client-engine";
import { useFocusFollows } from "@ohmail/app-logic/keys";
import {
  justFinished,
  onePersonMeant,
  PAGE_AHEAD_PX,
  parseOperators,
  peopleFor,
  sharesName,
  useSearchModel,
  withoutOperator,
  type SearchListModel,
  type SearchPerson,
  type TypedOperator,
} from "@ohmail/app-logic/search";
import { ListLine, ListHead, Sheet } from "@ohmail/ui/mail";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useLocale, useText } from "../text/index.js";
import { useSearchBeside, type SearchBeside } from "./beside.js";
import { SearchEmpty } from "./SearchEmpty.js";
import { SearchField } from "./SearchField.js";
import { SearchFilters } from "./SearchFilters.js";
import { SearchPersonRow, SearchRefine } from "./SearchNarrow.js";
import { SearchPeople } from "./SearchPeople.js";
import { SearchResults } from "./SearchResults.js";
import { SearchVerdictLine } from "./SearchVerdictLine.js";
import { saidOf } from "./verdict-words.js";
import "./search.css";

import { MailSelectionFoot } from "../place-list/MailSelectionFoot.js";
import { useRowContact } from "../place-list/use-row-contact.js";
import { useRowSelection } from "../place-list/use-row-selection.js";

/** A place as an operator spells it: its name in lower case, its spaces dropped. */
const spelled = (name: string): string => name.toLowerCase().split(" ").join("");

/** What a finished operator does as its filter, or null where it names none (it is then searched as words). */
function actOf(op: TypedOperator, model: SearchListModel, beside: SearchBeside): (() => void) | null {
  const value = op.value.toLowerCase();
  switch (op.key) {
    case "is":
      return value === "unread" ? () => model.setUnread(true) : null;
    case "has": {
      const files = model.facets.find((g) => g.group === "refine")?.items[0];
      if (!files || !["attachment", "attachments", "file", "files"].includes(value)) return null;
      return () => {
        if (!files.pressed) model.pick(files.pick);
      };
    }
    case "in": {
      const place = model.facets
        .find((g) => g.group === "folder")
        ?.items.find(
          (it) => it.pick.group === "folder" && spelled(beside.words.placeOfFolder(it.pick.key)) === value,
        );
      if (!place) return null;
      return () => {
        if (!place.pressed) model.pick(place.pick);
      };
    }
    case "from":
    case "to": {
      if (model.person !== null || beside.people === NONE) return null;
      /* Only where exactly one person is meant: two of one name, or several at the nearest, are listed instead. */
      const p = onePersonMeant(op.value, beside.people());
      if (!p) return null;
      const dir = op.key;
      return () => model.setPerson({ address: p.address, name: p.name === "" ? null : p.name, dir });
    }
  }
}

/**
 * The person set, as their control names them: by address where the book holds another of that name. Read once per
 * person set, never per key.
 */
function useNamed(person: SearchPerson | null, book: SearchBeside["people"]): string | null {
  return useMemo(
    () =>
      person === null
        ? null
        : person.name === null || (book !== NONE && sharesName(person, book()))
          ? person.address
          : person.name,
    [person, book],
  );
}

function fieldActions(model: SearchListModel, beside: SearchBeside, people: boolean) {
  /* Only the operator a space has just finished acts (one token, read back from the end): an operator inside the words,
     a second one pasted with it among them, stays words. */
  const typed = (q: string) => {
    const op = people ? justFinished(q) : null;
    if (op === null) return model.type(q);
    const act = actOf(op, model, beside);
    if (act !== null) {
      model.type(withoutOperator(q, op));
      act();
      return;
    }
    /* A from: or to: that names people, but not exactly one, stays open (its space not taken): they are listed. */
    model.type(meansPeople(op) ? q.trimEnd() : q);
  };
  const meansPeople = (op: TypedOperator): boolean =>
    (op.key === "from" || op.key === "to") &&
    model.person === null &&
    beside.people !== NONE &&
    peopleFor(op.value, beside.people()).length > 0;
  const typing = people ? parseOperators(model.query) : null;
  const pickPerson = (p: AddressBookEntry, dir: "any" | "from" | "to") => {
    model.setPerson({ address: p.address, name: p.name === "" ? null : p.name, dir });
    /* An operator being typed leaves the field; words that meant the person leave with it. */
    model.type(typing?.open ? withoutOperator(model.query, typing.open) : "");
    model.boxRef.current?.focus();
  };
  /* Enter with a `from:` or `to:` being typed takes the first person it names (as the people over the messages list
     them); else it asks the question at once. */
  const enter = () => {
    const open = typing?.open ?? null;
    const side = open !== null && (open.key === "from" || open.key === "to") ? open.key : null;
    const first =
      side !== null && model.person === null && beside.people !== NONE
        ? peopleFor(open!.value, beside.people())[0]
        : undefined;
    if (side !== null && first !== undefined) pickPerson(first, side);
    else model.submit();
  };
  return { typed, pickPerson, enter, typing };
}

export function SearchList({ route, plan }: PaneProps) {
  const model = useSearchModel();
  const beside = useSearchBeside();
  const selection = useRowSelection(beside.selection?.rows ?? [], model.text);
  const contact = useRowContact();
  const t = useText("search");
  const locale = useLocale();
  const { scrollerRef } = model;
  const root = useRef<HTMLDivElement>(null);
  useFocusFollows(root, { enter: false });
  const people = model.searchBy === "people";
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - PAGE_AHEAD_PX) return;
    model.nearEnd();
  };
  const { typed, pickPerson, enter, typing } = fieldActions(model, beside, people);
  const named = useNamed(model.person, beside.people);
  const said = saidOf(model, t, locale);
  const asked = model.text !== "" || model.narrowed;
  const meant =
    typing !== null ? (
      <SearchPeople
        model={model}
        beside={beside}
        open={typing.open}
        words={typing.words}
        key={model.query}
        onPick={pickPerson}
      />
    ) : null;
  const body = !asked ? (
    <div
      className={model.resting ? "sr-resting" : undefined}
      data-address-rows={model.resting ? "" : undefined}
    >
      {meant}
      {model.resting && model.mailboxTotal !== null ? (
        <ListLine>{t("mailboxTotal", { count: model.mailboxTotal })}</ListLine>
      ) : null}
    </div>
  ) : model.length === 0 || model.egg ? (
    <>
      {meant}
      <SearchEmpty model={model} beside={beside} lines={said.lines} />
    </>
  ) : (
    <>
      {meant}
      <SearchVerdictLine model={model} lines={said.lines} />
      <SearchResults
        model={model}
        beside={beside}
        openId={route.open}
        count={said.count}
        selection={beside.selection ? selection : undefined}
        contact={beside.selection ? contact : undefined}
      />
    </>
  );
  return (
    <div className="sr-list" data-filter-list="" data-people={people ? "" : undefined} ref={root}>
      <ListHead
        title={t("title")}
        below={
          <div className="sr-below" data-filter-stack="">
            <SearchField model={model} onType={typed} onEnter={enter} named={named} />
            {people ? <SearchPersonRow model={model} beside={beside} /> : null}
            <SearchFilters
              model={model}
              beside={beside}
              more={people ? <SearchRefine model={model} today={new Date()} /> : null}
            />
            {/* Typed scopes are searched as words where they are no filter: said, rather than an answer of nothing. */}
            {model.operatorsTyped ? <ListLine fine>{t("noOperators")}</ListLine> : null}
          </div>
        }
      />
      <div
        className="sr-scroll"
        ref={(el) => {
          scrollerRef.current = el;
        }}
        tabIndex={-1}
        onScroll={onScroll}
      >
        {plan.device === "phone" ? <Sheet kind="plain">{body}</Sheet> : body}
      </div>
      <MailSelectionFoot selection={selection} verbs={beside.selection?.verbs} />
      {contact.card}
    </div>
  );
}
