"use client";

/**
 * TODAY'S SHELL MOUNTS THE OHBOX: the new list from `@ohmail/app/ohbox` beside today's reading column.
 *
 * The adapter's part, and nothing more. It feeds the Ohbox's behaviour (`useOhboxList`, called once) from today's
 * composition, stands the model and the shell's words above both columns (`OhboxAbove`), lays the list on the
 * kit's list sheet, hands the open letter's visit to today's `MessagePane` as props, and registers the Ohbox's keys
 * in today's key registry. The reading column is today's, whole, the resting arm included: the reader replaces it
 * once the Ohbox is a place of the frame with its own reading column.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { useOhboxList, type OhboxListInput } from "@ohmail/app-logic/ohbox";
import { NONE } from "@ohmail/app/host";
import { useFrame, useSelectionBar } from "@ohmail/app/frame";
import { OhboxAbove, OhboxList, type OhboxBeside } from "@ohmail/app/ohbox";
import { Kbd, ReadColumn, TAG_HUES } from "@ohmail/ui";
import { Sheet } from "@ohmail/ui/mail";
import { useKeyBindings } from "@ohmail/app-logic/keys/keymap";
import { useZoneNav } from "@ohmail/app-logic/keys/zone-nav";
import { readColumnHidden } from "@ohmail/app-logic/layout/narrow";
import { useMailState } from "./MailStateProvider";
import { MessageGone, MessagePane, type MessageGoneProps } from "./MessagePane";
import { useSentLabel } from "./row-copy";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { hueOf, rowAddress, rowStamp, senderName, tagsOfMessage } from "./format";
import { go, goFirstRun, goSettings } from "./routing";
import { useDragToFile } from "./drag-file";
import { BootSkeleton } from "./BootSkeleton";
import type { PullBinding } from "./PullNewMail";
import "./todays-ohbox.css";

export type { OhboxReplyDone } from "@ohmail/app-logic/ohbox";

/** The no-mailbox card's verb where the door has no setup page (the desktop window). */
const SETTINGS_MAILBOXES = "#/settings/mailboxes";

/** A row of the new list, wherever it stands in the list's scroller. */
const ROW = ".view-ohbox .oh-row[data-id]";
/** Where a row stands with its own verbs beside it (the kit's slot). */
const ROW_SLOT = ".view-ohbox .oh-row-slot";
/** The list's own scroller, where the keyboard stands when no row holds it. */
const SCROLLER = ".view-ohbox .ob-scroll";
/** The list's column: its head, its rows, its foot. */
const LIST = ".view-ohbox .ob-today-list";
/** A layer the list opens over the page (the reader's sheet, a dialog, a menu): the keyboard comes back from it. */
const LAYER = '.reader, [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"]';

/** Today's rows as shape, where the list's rows will be while it is owed: the silhouette brings its own grace. */
const SHAPE = <BootSkeleton active />;

/** A tag's stored hue name, as the degrees the kit's dot takes: its place on the wheel `TAG_HUES` keeps. */
const hueDegrees = (name: string): number =>
  Math.max(0, TAG_HUES.indexOf(name as (typeof TAG_HUES)[number])) * (360 / TAG_HUES.length);

type Fed = Omit<OhboxListInput,
  "t" | "columnHidden" | "rowSelector" | "avatarSelector" | "anchors" | "readColRef" | "senderName" | "sentLabelOf">;

export interface TodaysOhboxProps extends Fed {
  /** The header's tenant (the ohmarchy offer): drawn over the list as it is given. */
  noticeSection?: ReactNode;
  /** The away line and the storage card: the list's first block, inside its scroller, as they are given. */
  standingNotice?: ReactNode;
  /** The open letter was taken away by another mail client: the column says so instead of resting. */
  gone?: MessageGoneProps | null;
  /** The letter a search or a link just took the person to, while the shell marks it. */
  located?: string | null;
  /** Pull new mail, from the list's menu. */
  pull: PullBinding;
}

export function TodaysOhbox(props: TodaysOhboxProps) {
  const { noticeSection, standingNotice, gone = null, located = null, pull, ...fed } = props;
  const setupLink = fed.setupHref;
  const setupHref = setupLink ?? SETTINGS_MAILBOXES;
  const t = useTranslations("ohbox");
  const tReader = useTranslations("reader");
  const sentLabelOf = useSentLabel();
  const readColRef = useRef<HTMLDivElement>(null);
  const { route, plan } = useFrame();
  const { state: mail, mailboxes } = useMailState();

  const model = useOhboxList({
    ...fed,
    t,
    columnHidden: readColumnHidden,
    rowSelector: "[data-id]",
    avatarSelector: ".oh-row-face",
    anchors: {
      pickTag: () => document.querySelector<HTMLElement>(".view-ohbox .ob-foot"),
      row: (id) => document.querySelector<HTMLElement>(`.view-ohbox .oh-row[data-id="${CSS.escape(id)}"]`),
    },
    readColRef,
    senderName,
    sentLabelOf,
  });
  useKeyBindings(model.keys);
  /* The selection's bar stands at the list's foot while rows are picked: on a phone the frame draws no dock over it. */
  useSelectionBar(model.pickedRowCount > 0);
  useZoneNav(useTranslations("shortcuts"), {
    list: model.zone.list,
    reader: { selector: ".view-ohbox .read-col", ...model.zone.reader },
    listFocusSelector: ".view-ohbox .oh-row[data-open]",
  });
  useRowFocusFollow(model.selected?.id ?? null);
  useListKeepsKeyboard();
  const drag = useDragToFile({ ...model.drag, rowSelector: ROW });

  const { now, absoluteTime, onToggleTime, tags, doorbellCount, doorbellSettled = true, notOrganizingYet = null, onDoorbell } = fed;
  const beside: OhboxBeside = useMemo(() => ({
    words: {
      name: senderName,
      address: (m) => rowAddress(m),
      stamp: (m) => {
        const s = rowStamp(m, now, absoluteTime);
        return { when: s.time, ...(s.timeTitle ? { title: s.timeTitle } : {}), ...(s.timeSpoken ? { spoken: s.timeSpoken } : {}) };
      },
      sentTo: (m) => sentLabelOf(m),
      mailbox: (a) => displayAddress(a),
      tag: (m) => {
        const tag = tagsOfMessage(m, tags)[0];
        return tag ? { name: tag.name, hue: hueDegrees(hueOf(tag)) } : null;
      },
    },
    mail: { mailboxes: mailboxes === null ? null : mailboxes.length, screenerCandidate: mail.screenerCandidate, arrived: mail.count },
    doorbell: { count: doorbellCount, settled: doorbellSettled },
    notOrganizing: notOrganizingYet,
    pull: pull.available ? { busy: pull.pulling, run: pull.pull } : NONE,
    keysShown: plan.pointer !== "coarse",
    flipTime: onToggleTime,
    located,
    shape: SHAPE,
    go: {
      screener: onDoorbell,
      history: () => go("history"),
      mailboxes: () => window.location.assign(setupHref),
      /* The web's setup page is an address: the empty Ohbox's way on is a link to it. The desktop window has none. */
      ...(setupLink ? { mailboxesHref: setupLink } : {}),
      organize: (mailboxId) => goFirstRun({ rerun: true, mailboxId }),
    },
  }), [sentLabelOf, now, absoluteTime, onToggleTime, located, tags, mailboxes, mail.screenerCandidate, mail.count, doorbellCount,
    doorbellSettled, notOrganizingYet, pull.available, pull.pulling, pull.pull, plan.pointer, onDoorbell, setupHref, setupLink]);

  const selected = model.selected;
  const visit = model.visit;
  /* The list asks today's columns, never the plan: between 600 and 1023 the two disagree. */
  const listPlan = { ...plan, columns: readColumnHidden() ? 1 : 2 } as const;
  const list = <OhboxList route={route} plan={listPlan} keysHere notice={standingNotice} />;
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
          onClose={selected || gone ? () => fed.onSelect(null) : undefined}
          closeLabel={tReader("closeColumn")}
        >
          {selected && visit ? (
            /* The visit is today's hand-over to the pane, spread as props: the letter in its presented state, the
               read rule's wiring, the read set, and the verbs through the list's own path. */
            <MessagePane
              message={visit.unread === selected.unread ? selected : { ...selected, unread: visit.unread }}
              tags={tags}
              now={now}
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

/** The keyboard back on the list: the row the cursor is on, else the list itself. */
function focusTheList(): void {
  const row = document.querySelector<HTMLElement>(".view-ohbox .oh-row[data-open]");
  const to = row ?? document.querySelector<HTMLElement>(SCROLLER);
  to?.focus({ preventScroll: true });
}

/**
 * THE LIST KEEPS THE KEYBOARD (the shell's one focus rule, for the list's own rows, landed in the commit that took
 * them away). While the keyboard was in the list, a verb that takes the focused row away (`e`, `a`, a
 * re-filing `u`) leaves the focus on the row the cursor went to, or on the list where no cursor stands, never on the
 * page. A row's own verb taken away (its Done) is the shell's to land: the row after it, else the row before it. A layer opened from the list or from nothing (the reader's sheet on a phone, a menu) gives the keyboard back
 * when it closes: to the control in the list's column that opened it (the head's menu button, the selection's More,
 * Move or Tag), as the kit's menus do, and to the cursor's row where a row or nothing opened it. Focus that comes
 * back to the opener stays there; it is moved only when it fell to the page or to an element that is not the opener
 * (the foot a menu anchors on), and not once a layer holds the keyboard again (More's Delete opens the ask). A layer
 * opened from that stand-in keeps the opener. A person's own move elsewhere ends it.
 */
function useListKeepsKeyboard(): void {
  const home = useRef(false);
  const layerFromList = useRef(false);
  /* What held the keyboard when a layer opened over the list: where the layer gives it back. */
  const opener = useRef<HTMLElement | null>(null);
  /* What a closing layer gave the keyboard to while it is owed to the opener: it never becomes an opener itself. */
  const standIn = useRef<HTMLElement | null>(null);
  const last = useRef<HTMLElement | null>(null);
  /* A row's own verbs (its Done, its menu button), as they took the keyboard. One taken away is the shell's to land
     (`focus-follows`: the row after it, else the row before it), as it was for today's rows: the keeper stands down. */
  const rowVerbs = useRef(new WeakSet<HTMLElement>());
  const shellLands = (was: HTMLElement | null): boolean =>
    was !== null && !was.isConnected && rowVerbs.current.has(was);
  /* What held the keyboard was taken away, and the list is where it goes back to. */
  const owed = (): boolean => {
    const was = last.current;
    if (was === null || was.isConnected || shellLands(was)) return false;
    return home.current || (was.closest(LAYER) !== null && layerFromList.current);
  };
  /* Where the keyboard goes back to: the opener while a layer just closed and the opener is a control that stands; the
     cursor's row otherwise (a row that opened a layer may no longer be the cursor's). */
  const backTo = (): (() => void) => {
    const was = last.current;
    const to = opener.current;
    const fromLayer = was !== null && !was.isConnected && was.closest(LAYER) !== null;
    if (fromLayer && to !== null && to.isConnected && !to.matches(ROW)) return () => to.focus({ preventScroll: true });
    return focusTheList;
  };
  useEffect(() => {
    const onIn = (event: FocusEvent): void => {
      const el = event.target instanceof HTMLElement && event.target !== document.body ? event.target : null;
      if (el === null) return;
      if (!el.matches(ROW) && el.closest(ROW_SLOT) !== null) rowVerbs.current.add(el);
      if (owed() && !el.closest(LAYER)) {
        const back = backTo();
        const opened = opener.current;
        last.current = el;
        home.current = true;
        if (el === opened) return;
        standIn.current = el;
        /* A layer that opened in the same commit (an ask after its menu) holds the keyboard: the hand-on stands down. */
        queueMicrotask(() => {
          if (document.activeElement?.closest(LAYER) == null) back();
        });
        return;
      }
      const was = last.current;
      last.current = el;
      if (el.closest(LAYER)) {
        const entering = was === null || !was.isConnected || was.closest(LAYER) === null;
        if (entering) layerFromList.current = was === null || home.current;
        /* A layer opened from a layer that has gone (More's Delete opens the ask), or from the stand-in it left the
           keyboard on, keeps the first one's opener. */
        const fromControl = was === null || (was.closest(LAYER) === null && was !== standIn.current);
        if (entering && fromControl) opener.current = was?.isConnected ? was : null;
        return;
      }
      standIn.current = null;
      home.current = el.closest(LIST) !== null;
    };
    /* The keyboard let go (a blur to the page, the element still standing): nothing holds it, and the walk that
       follows moves the cursor only, never the focus. */
    const onOut = (event: FocusEvent): void => {
      const el = event.target;
      if (!(el instanceof HTMLElement) || event.relatedTarget !== null) return;
      queueMicrotask(() => {
        const now = document.activeElement;
        if (!el.isConnected || last.current !== el || (now !== null && now !== document.body)) return;
        last.current = null;
        home.current = false;
        layerFromList.current = false;
      });
    };
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    /* What held the keyboard outside the list was taken away (the capsule's Undo, pressed or its window ended) and
       the focus fell to the page: the shell's rule lands it on the cursor's row, else on the list, as `focus-follows`
       does. Its own return (a surface back to its opener) and a standing modal go first. */
    const lost = new MutationObserver(() => {
      const was = last.current;
      if (was === null || was.isConnected || shellLands(was)) return;
      queueMicrotask(() => {
        const now = document.activeElement;
        if ((now !== null && now !== document.body) || last.current !== was) return;
        if (document.querySelector('[aria-modal="true"]') !== null) return;
        home.current = true;
        focusTheList();
      });
    });
    lost.observe(document.body, { childList: true, subtree: true });
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
      lost.disconnect();
    };
  }, []);
  /* After every commit: a focused row or layer this commit removed left the focus on the page. */
  useLayoutEffect(() => {
    const cur = document.activeElement;
    if (cur instanceof HTMLElement && cur !== document.body && cur.isConnected) return;
    if (shellLands(last.current)) return;
    if (!home.current && !owed()) return;
    const back = backTo();
    home.current = true;
    back();
  });
}

/**
 * FOCUS FOLLOWS THE CURSOR while it stands on a row or on the list: `j` moved the open row, so a focused row (or the
 * list a verb left it on) hands its focus to the new one. Focus elsewhere (a field, the reading column, the body) is
 * never taken.
 */
function useRowFocusFollow(openId: string | null): void {
  useEffect(() => {
    if (openId === null) return;
    const cur = document.activeElement;
    if (!(cur instanceof HTMLElement) || !(cur.matches(ROW) || cur.matches(SCROLLER))) return;
    if (cur.dataset.id === openId) return;
    const next = document.querySelector<HTMLElement>(`.view-ohbox .oh-row[data-id="${CSS.escape(openId)}"]`);
    if (next && next !== cur) next.focus({ preventScroll: true });
  }, [openId]);
}
