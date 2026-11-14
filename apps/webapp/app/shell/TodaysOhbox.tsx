"use client";

/**
 * TODAY'S SHELL MOUNTS THE OHBOX: the new list from `@ohmail/app/ohbox` beside today's reading column.
 *
 * The adapter's lower half, until the Ohbox is seated. Its upper half (the model, `useOhboxList` called once, the
 * keys, the keyboard's rules, the words beside the list) is `useOhboxUpper` of `TodaysOhboxAbove.tsx`, mounted here
 * with today's selection, today's column rule and today's selectors. This file stands the model and the shell's words
 * above both columns (`OhboxAbove`), lays the list on the kit's list sheet and hands the open letter's visit to
 * today's `MessagePane` as props. The reading column is today's, whole, the resting arm included: the reader replaces
 * it once the Ohbox is a place of the frame with its own reading column.
 */
import { useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useFrame } from "@ohmail/app/frame";
import { OhboxAbove, OhboxList } from "@ohmail/app/ohbox";
import { Kbd, ReadColumn } from "@ohmail/ui";
import { Sheet } from "@ohmail/ui/mail";
import { readColumnHidden } from "@ohmail/app-logic/layout/narrow";
import { MessageGone, MessagePane } from "./MessagePane";
import { TODAYS_VIEW, useOhboxUpper, type OhboxFed } from "./TodaysOhboxAbove";
import "./todays-ohbox.css";

export type { OhboxReplyDone } from "@ohmail/app-logic/ohbox";

export interface TodaysOhboxProps extends OhboxFed {
  /** The open row, the shell's own state in today's view. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** The letter up in today's reader sheet over the list. */
  readerId: string | null;
  /** The header's tenant (the ohmarchy offer): drawn over the list as it is given. */
  noticeSection?: ReactNode;
  /** The away line and the storage card: the list's first block, inside its scroller, as they are given. */
  standingNotice?: ReactNode;
}

export function TodaysOhbox(props: TodaysOhboxProps) {
  const { noticeSection, standingNotice, selectedId, onSelect, readerId, ...fed } = props;
  const { gone = null } = fed;
  const tReader = useTranslations("reader");
  const readColRef = useRef<HTMLDivElement>(null);
  const { route, plan } = useFrame();
  const { model, beside, drag } = useOhboxUpper(fed, {
    selectedId,
    onSelect,
    readerId,
    columnHidden: readColumnHidden,
    readColRef,
    at: TODAYS_VIEW,
    first: standingNotice,
  });

  const selected = model.selected;
  const visit = model.visit;
  /* The list asks today's columns, never the plan: between 600 and 1023 the two disagree. */
  const listPlan = { ...plan, columns: readColumnHidden() ? 1 : 2 } as const;
  const list = <OhboxList route={route} plan={listPlan} keysHere />;
  return (
    <OhboxAbove model={model} beside={beside}>
      <section className="view split view-ohbox">
        <div className="ob-today" onPointerDownCapture={drag.onPointerDown}>
          {noticeSection}
          <div className="oh-root ob-today-list">
            {plan.device === "phone" ? list : <Sheet kind="list">{list}</Sheet>}
          </div>
        </div>
        <ReadColumn
          scrollerRef={readColRef}
          regionLabel={tReader("pane")}
          onClose={selected || gone ? () => onSelect(null) : undefined}
          closeLabel={tReader("closeColumn")}
        >
          {selected && visit ? (
            /* The visit is today's hand-over to the pane, spread as props: the letter in its presented state, the
               read rule's wiring, the read set, and the verbs through the list's own path. */
            <MessagePane
              message={visit.unread === selected.unread ? selected : { ...selected, unread: visit.unread }}
              tags={fed.tags}
              now={fed.now}
              onAction={visit.act}
              onAddTag={fed.onAddTag}
              readSet={[...visit.readSet]}
              scroller={readColRef}
              threadRead={visit.wiring}
            />
          ) : gone ? (
            /* Before the resting panel: "the letter you had open was removed elsewhere" is not "nothing open". */
            <MessageGone openTrash={gone.openTrash} />
          ) : model.all.length > 0 ? (
            <Resting />
          ) : null}
        </ReadColumn>
      </section>
    </OhboxAbove>
  );
}

/** What today's reading column says while nothing is open, and only while the list has rows. */
function Resting() {
  const t = useTranslations("ohbox");
  return (
    <div className="empty">
      <span className="glyph" aria-hidden="true">✉</span>
      <b>{t("emptyRestTitle")}</b>
      {/* The keycap names `j`, which a coarse pointer does not have: `app.css` swaps in the touch twin. */}
      <span className="empty-hint-keys">{t.rich("emptyRestHint", { kbd: (chunks) => <Kbd>{chunks}</Kbd> })}</span>
      <span className="empty-hint-touch">{t("emptyRestHintTouch")}</span>
    </div>
  );
}
