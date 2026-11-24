/**
 * THE ONE LIST OF RESULTS. The device's first paint is drawn whole: the matches, then the closest words under their
 * heading. Once the store answered, its rows replace them in place, as a window over the walked slots: a result, a
 * place owed until its page lands, or nothing where a row was deleted. Each result is a list item that carries its
 * place in the list (`aria-setsize`, `aria-posinset`) and the marks a reading finds it by (`data-hit`, `data-index`)
 * around the kit's row, which stays a button; the cursor is the item's `aria-current` and the row's own mark.
 */
import { fragmentOf } from "../frame/route.js";
import { Fragment, type ReactNode } from "react";
import type { SearchHit } from "@ohmail/client-engine";
import type { SearchListModel } from "@ohmail/app-logic/search";
import { GroupHeading, ListLine, Row, Rows } from "@ohmail/ui/mail";
import { useText } from "../text/index.js";
import type { SearchBeside } from "./beside.js";
import { hitWho, markedSubject } from "./row-words.js";
import { SearchSort } from "./SearchSort.js";

import type { RowContact } from "../place-list/use-row-contact.js";
import type { RowSelection } from "../place-list/use-row-selection.js";

/** The owed slot's row stands for nobody. */
const OWED_PEOPLE: readonly [] = [];

export function SearchResults({
  model,
  beside,
  openId,
  count,
  selection,
  contact,
}: {
  model: SearchListModel;
  beside: SearchBeside;
  /** The letter open in the reading column, if any. */
  openId: string | null;
  /** The count beside Results, as it is printed. */
  count?: string;
  selection?: RowSelection;
  contact?: RowContact;
}) {
  const t = useText("search");
  const item = (hit: SearchHit, i: number, similar: boolean, placed: boolean): ReactNode => (
    <div
      key={hit.message.id}
      role="listitem"
      className="sr-hit"
      data-hit={hit.message.id}
      data-index={i}
      aria-setsize={placed ? model.setSize : undefined}
      aria-posinset={placed ? i + 1 : undefined}
      aria-current={(openId === null ? i === model.cursor : hit.message.id === openId) ? "true" : undefined}
      data-similar={similar ? "hit" : undefined}
    >
      <SearchHitRow
        hit={hit}
        beside={beside}
        cursor={i === model.cursor}
        open={hit.message.id === openId}
        onOpen={model.open}
        selection={selection}
        contact={contact}
      />
    </div>
  );
  const group = (rows: ReactNode[], similar: boolean, hot: boolean, leading: boolean, placed: boolean) => (
    <Fragment key={similar ? "similar" : "exact"}>
      <GroupHeading
        count={leading ? count : undefined}
        aside={leading ? <SearchSort model={model} /> : undefined}
        hot={hot}
      >
        {similar ? t("similarHead") : t("results")}
      </GroupHeading>
      {similar && model.partsSaid ? <ListLine fine>{t("saidPart")}</ListLine> : null}
      <Rows listLabel={similar && !placed ? t("similarHead") : t("aria")}>
        {placed ? <div aria-hidden data-window-top="" style={{ height: model.window.padTop }} /> : null}
        {rows}
        {placed && model.window.padBottom > 0 ? (
          <div aria-hidden style={{ height: model.window.padBottom }} />
        ) : null}
      </Rows>
    </Fragment>
  );

  if (model.listing === "store") {
    /* THE STORE'S LIST: the walker's slots in the window. */
    const slots: ReactNode[] = [];
    let hot = false;
    for (let i = model.window.start; i < model.window.end; i++) {
      const s = model.slotAt(i);
      if (s.kind === "gone") slots.push(<div key={`g${i}`} data-index={i} className="sr-gone" aria-hidden />);
      else if (s.kind === "owed")
        slots.push(
          <div key={`p${i}`} data-index={i} className="sr-owed" aria-hidden inert>
            <Row who="" people={OWED_PEOPLE} subject="" />
          </div>,
        );
      else {
        hot ||= s.hit.message.unread;
        slots.push(item(s.hit, i, model.similar, true));
      }
    }
    return <>{group(slots, model.similar, hot, true, true)}</>;
  }
  /* THE DEVICE'S PAINT, whole: the matches under Results, then the closest words under their own heading. */
  const exact: ReactNode[] = [];
  const near: ReactNode[] = [];
  let exactHot = false;
  let nearHot = false;
  for (let i = 0; i < model.length; i++) {
    const s = model.slotAt(i);
    if (s.kind !== "hit") continue;
    const after = model.similarFrom !== null && i >= model.similarFrom;
    if (after) nearHot ||= s.hit.message.unread;
    else exactHot ||= s.hit.message.unread;
    (after ? near : exact).push(item(s.hit, i, s.similar, false));
  }
  return (
    <>
      {exact.length > 0 ? group(exact, false, exactHot, true, false) : null}
      {near.length > 0 ? group(near, true, nearHot, exact.length === 0, false) : null}
    </>
  );
}

/** One result on the kit's row: who, the address under the name, the subject with its match marked, where and when. */
export function SearchHitRow({
  hit,
  beside,
  cursor,
  open,
  onOpen,
  selection,
  contact,
}: {
  hit: SearchHit;
  beside: SearchBeside;
  cursor: boolean;
  open: boolean;
  onOpen: (hit: SearchHit) => void;
  selection?: RowSelection;
  contact?: RowContact;
}) {
  const m = hit.message;
  const who = hitWho(hit, beside.words);
  const contactActions = contact?.rowProps(m.from, m.id);
  const cut = markedSubject(m.subject, hit);
  const subject = (
    <>
      {cut === null ? (
        m.subject
      ) : (
        <>
          {cut.before}
          <mark className="sr-match">{cut.marked}</mark>
          {cut.after}
        </>
      )}
    </>
  );
  return (
    <Row
      {...selection?.rowProps(m.id)}
      nameAction={who.address ? contactActions?.nameAction : undefined}
      who={who.who}
      address={who.address}
      people={who.people}
      subject={subject}
      preview={m.snippet || undefined}
      when={beside.words.stamp(m)}
      where={beside.words.place(m)}
      unread={m.unread}
      cursor={cursor}
      open={open}
      onOpen={() => onOpen(hit)}
      contactHref={fragmentOf({ place: "address", sub: m.from.address, open: null, stage: null, words: {} })}
      onContact={contactActions?.addressAction ?? (() => beside.go.address(m.from.address))}
    />
  );
}
