"use client";

/**
 * THE OHBOX SEATED IN THE FRAME, FED FROM TODAY'S COMPOSITION: what stands above the Ohbox's two columns (the seated
 * entry's `panes.Above`), and the upper half of the Ohbox that today's view mounts until the seat.
 *
 * The adapter's part, and nothing more. It feeds the Ohbox's behaviour (`useOhboxList`, called once) from today's
 * composition, stands the model and the shell's words above both columns (`OhboxAbove`), and registers the Ohbox's
 * keys in today's key registry. Seated, the open letter is the address's (`route.open`), the reading column is the
 * frame's and the reader's, and the column is hidden where the frame's plan draws one column. Where two columns stand
 * the cursor row is the open letter's; where one stands the cursor row is the shell's own, moved in the list with no
 * letter shown, and a letter stands over the list only once its row was entered. The composition hands its inputs
 * through one context (`TodaysOhboxFed`), never as a second computation. A file written to be deleted: the Ohbox's own
 * seat takes it when the composition it reads is lifted.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslations } from "next-intl";
import { useOhboxList, type OhboxListInput, type OhboxListModel } from "@ohmail/app-logic/ohbox";
import { NONE } from "@ohmail/app/host";
import { useFrame, useSelectionBar } from "@ohmail/app/frame";
import { OhboxAbove, type OhboxBeside } from "@ohmail/app/ohbox";
import { readingScrollerIn } from "@ohmail/app/reader";
import { TAG_HUES } from "@ohmail/ui";
import { useKeyBindings } from "@ohmail/app-logic/keys/keymap";
import { beginOpen } from "@ohmail/app-logic/session/ui-vitals";
import { useZoneNav } from "@ohmail/app-logic/keys/zone-nav";
import { DEFAULT_AFTER_VERB, readAfterVerb } from "@ohmail/app-logic/press/after-verb";
import { useTodaysScope } from "./todays-scope";
import { useMailState } from "@ohmail/app-logic/mail-state/mail-state-binding";
import type { MessageGoneProps } from "./MessagePane";
import { useSentLabel } from "./row-copy";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { hueOf, rowAddress, rowStamp, senderName, tagsOfMessage } from "./format";
import { go, goFirstRun } from "./routing";
import { useDragToFile, type DragToFile } from "./drag-file";
import { BootSkeleton } from "./BootSkeleton";
import type { PullBinding } from "./PullNewMail";

/** The no-mailbox card's verb where the door has no setup page (the desktop window). */
const SETTINGS_MAILBOXES = "#/settings/mailboxes";

/** Today's rows as shape, where the list's rows will be while it is owed: the silhouette brings its own grace. */
const SHAPE = <BootSkeleton active />;

/** A tag's stored hue name, as the degrees the kit's dot takes: its place on the wheel `TAG_HUES` keeps. */
const hueDegrees = (name: string): number =>
  Math.max(0, TAG_HUES.indexOf(name as (typeof TAG_HUES)[number])) * (360 / TAG_HUES.length);

/** What the mount answers itself: the words, the column, the after-verb choice, and where the list's parts stand. */
type Answered =
  "t" | "columnHidden" | "afterVerb" | "rowSelector" | "avatarSelector" | "anchors" | "readColRef" | "senderName" | "sentLabelOf";
/** What says which letter is open: the shell's state in today's view, the address where the Ohbox is seated. */
type Open = "selectedId" | "onSelect" | "readerId";

/** Today's inputs at the mount of the Ohbox, as the composition computes them, without what says which letter is open. */
export interface OhboxFed extends Omit<OhboxListInput, Answered | Open> {
  /** The open letter was taken away by another mail client: the column says so instead of resting. */
  gone?: MessageGoneProps | null;
  /** The letter a search or a link just took the person to, while the shell marks it. */
  located?: string | null;
  /** Pull new mail, from the list's menu. */
  pull: PullBinding;
}

/** What the composition feeds the seated Ohbox: today's inputs at the mount of `<TodaysOhbox>`, no more. */
export interface TodaysOhboxFeed extends OhboxFed {
  /** What a row's selection does in the shell BESIDE naming the open letter (today's `selectOhboxRow` without its
   *  own state: the row's seed for Move). The adapter calls it, then `commands.open(id)`. */
  readonly onSelectRow: (id: string | null) => void;
  /** The cursor row where ONE column stands: the shell's own Ohbox selection, which `onSelectRow` writes. There `j`
   *  and `k` move it in the list and name no letter; where two columns stand the address names the cursor row's. */
  readonly cursor: string | null;
  /** A press on a row's face or address: the shell's sender menu, which the stage hears for a view of today's. */
  readonly onSenderPress: (event: MouseEvent) => void;
  /** Over the list's head, in this order: the demo's ribbon, the stage's one card, the header's tenant. */
  readonly over: { readonly ribbon: ReactNode; readonly stageCard: ReactNode; readonly tenant: ReactNode };
  /** The list's first block, inside its scroller: the away line and the storage card. */
  readonly first: ReactNode;
}

/** The composition's one feed of the seated Ohbox. The context itself is provided above the panes, once. */
export const TodaysOhboxFed = createContext<TodaysOhboxFeed | null>(null);

/** The feed, or a mistake said at once: a seated Ohbox with nothing above it has no mail to list. */
export function useTodaysOhboxFed(): TodaysOhboxFeed {
  const fed = useContext(TodaysOhboxFed);
  if (fed === null) throw new Error("the Ohbox was seated with no composition above");
  return fed;
}

/** Where the list's parts stand, as the keyboard's rules find them. */
export interface OhboxAt {
  /** The list's column: its head, its rows, its foot. */
  readonly list: string;
  /** The reading column's focus and scroll target. */
  readonly reading: string;
  /** A layer the list opens over the page (a dialog, a menu): the keyboard comes back from it. */
  readonly layer: string;
}

/** In today's view: the list in today's split, today's reading column, and today's reader sheet among the layers. */
export const TODAYS_VIEW: OhboxAt = {
  list: ".view-ohbox .ob-today-list",
  reading: ".view-ohbox .read-col",
  layer: '.reader, [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"]',
};

/**
 * Seated: the frame's own two sections. The reading column's target is the reading sheet's scroller, which the reader
 * finds by the same name (its `read-dom.ts`) until the kit hands the part out. Today's sheet never opens here: where
 * one column stands, the reading column over the list is the layer a row opened, and gives the keyboard back to it.
 */
const SEATED: OhboxAt = {
  list: "section.fr-list",
  reading: "section.fr-reading .oh-sheet-scroll",
  layer: 'section.fr-reading[data-over], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"]',
};

/** What differs between the two mounts of the upper half: which letter is open, the column, and where things stand. */
export interface OhboxMount {
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  /** The letter up over the list where one column stands (the sheet in today's view, the reading column seated). */
  readonly readerId: string | null;
  /** Is the reading column hidden at this width? Asked at the moment it matters, never cached. */
  readonly columnHidden: () => boolean;
  /** The reading column's scroller, which the read rule observes. */
  readonly readColRef: RefObject<HTMLDivElement | null>;
  readonly at: OhboxAt;
  readonly over?: ReactNode;
  readonly first?: ReactNode;
}

/**
 * THE OHBOX'S UPPER HALF: the model (`useOhboxList`, the tree's one call), its keys, the selection's bar, the zone
 * model, the keyboard's two rules, the drag to a rail place, and the words beside the list. Today's view mounts it
 * until the seat; the seated place mounts it from `TodaysOhboxAbove`. Never both on screen.
 */
export function useOhboxUpper(
  fed: OhboxFed,
  mount: OhboxMount,
): { model: OhboxListModel; beside: OhboxBeside; drag: DragToFile } {
  const { gone: _gone, located = null, pull, ...input } = fed;
  const { selectedId, onSelect, readerId, columnHidden, readColRef, at, over, first } = mount;
  const setupLink = input.setupHref;
  const setupHref = setupLink ?? SETTINGS_MAILBOXES;
  const t = useTranslations("ohbox");
  const sentLabelOf = useSentLabel();
  const { plan } = useFrame();
  const { state: mail, mailboxes } = useMailState();
  /* The after-verb choice, read when a verb has taken the open row: the stored choice of the shell's scope, or the
     default where this list is drawn in no shell. One function for the mount. */
  const scope = useTodaysScope();
  const afterVerb = useCallback(() => (scope === null ? DEFAULT_AFTER_VERB : readAfterVerb(scope)), [scope]);

  const model = useOhboxList({
    ...input,
    selectedId,
    onSelect,
    readerId,
    t,
    columnHidden,
    afterVerb,
    rowSelector: "[data-id]",
    avatarSelector: ".oh-row-face",
    anchors: {
      pickTag: () => document.querySelector<HTMLElement>(`${at.list} .ob-foot`),
      row: (id) => document.querySelector<HTMLElement>(`${at.list} .oh-row[data-id="${CSS.escape(id)}"]`),
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
    reader: { selector: at.reading, ...model.zone.reader },
    listFocusSelector: `${at.list} .oh-row[data-open]`,
  });
  useRowFocusFollow(model.selected?.id ?? null, at);
  useListKeepsKeyboard(at);
  const drag = useDragToFile({ ...model.drag, rowSelector: `${at.list} .oh-row[data-id]` });

  const { now, absoluteTime, onToggleTime, tags, doorbellCount, doorbellSettled = true, notOrganizingYet = null, onDoorbell } = input;
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
    over,
    first,
    go: {
      screener: onDoorbell,
      history: () => go("history"),
      mailboxes: () => window.location.assign(setupHref),
      /* The web's setup page is an address: the empty Ohbox's way on is a link to it. The desktop window has none. */
      ...(setupLink ? { mailboxesHref: setupLink } : {}),
      organize: (mailboxId) => goFirstRun({ rerun: true, mailboxId }),
    },
  }), [sentLabelOf, now, absoluteTime, onToggleTime, located, tags, mailboxes, mail.screenerCandidate, mail.count, doorbellCount,
    doorbellSettled, notOrganizingYet, pull.available, pull.pulling, pull.pull, plan.pointer, onDoorbell, setupHref, setupLink,
    over, first]);
  return { model, beside, drag };
}

/**
 * THE SEATED ENTRY'S `Above`: the Ohbox's upper half over the frame's two columns. The open letter is the address's:
 * a row's selection runs what the shell does beside it (`onSelectRow`), then names the letter (`commands.open`). The
 * column is hidden where the frame's plan draws one column, and a letter open there stands over the list.
 *
 * WHERE ONE COLUMN STANDS THE CURSOR ROW IS THE LIST'S OWN, as it was under today's sheet: a selection there moves the
 * shell's cursor and names no letter, so `j` and `k` walk a list that stays drawn, show nothing and read nothing. The
 * letter is named in the address, and so drawn over the list, only once its row is entered (↵, a press): by the
 * shell's own open (`onEnterReader`), which stood today's sheet there.
 */
export function TodaysOhboxAbove({ children }: { readonly children: ReactNode }): ReactElement {
  const fed = useTodaysOhboxFed();
  const { onSelectRow, cursor, over: overs, first, onEnterReader, onSenderPress, ...today } = fed;
  const { route, plan, commands } = useFrame();
  const oneColumn = useRef(plan.columns === 1);
  oneColumn.current = plan.columns === 1;
  const columnHidden = useCallback(() => oneColumn.current, []);
  const openNow = useRef(route.open);
  openNow.current = route.open;
  const onSelect = useCallback(
    (id: string | null) => {
      onSelectRow(id);
      if (oneColumn.current) return;
      /* The open's measure begins at the press that names another letter, as the shell's own open began it. */
      if (id !== null && id !== openNow.current) beginOpen(id);
      commands.open(id);
    },
    [onSelectRow, commands],
  );
  /* ON ONE COLUMN THE LETTER STANDS OVER THE LIST: a row entered there (↵, a press) hands the keyboard to the reading
     column once the letter stands, as today's sheet took it. A walk by `j` enters nothing and keeps the keyboard; the
     keyboard's rule below gives it back to the list when the letter closes. */
  const entered = useRef<string | null>(null);
  const enter = useCallback(
    (id: string) => {
      onEnterReader(id);
      if (oneColumn.current) entered.current = id;
    },
    [onEnterReader],
  );
  useEffect(() => {
    const id = entered.current;
    if (id === null || route.open !== id) return;
    const column = readingScrollerIn(document.querySelector("section.fr-reading"));
    if (column === null) return;
    entered.current = null;
    column.focus({ preventScroll: true });
  });
  /* The reading column's scroller, read at the moment it is asked: the reader's sheet mounts and goes under it. */
  const readColRef = useMemo<RefObject<HTMLDivElement | null>>(
    () => ({
      get current() {
        return document.querySelector<HTMLDivElement>(SEATED.reading);
      },
    }),
    [],
  );
  const { ribbon, stageCard, tenant } = overs;
  const over = useMemo(
    () => (ribbon || stageCard || tenant ? <>{ribbon}{stageCard}{tenant}</> : null),
    [ribbon, stageCard, tenant],
  );
  const { model, beside, drag } = useOhboxUpper({ ...today, onEnterReader: enter }, {
    /* One column: the cursor row; a letter the address names before the shell's cursor has followed it (a link, a
       reload) is the cursor row meanwhile. Two columns: the letter beside the list. */
    selectedId: plan.columns === 1 ? (cursor ?? route.open) : route.open,
    onSelect,
    readerId: plan.columns === 1 ? route.open : null,
    columnHidden,
    readColRef,
    at: SEATED,
    over,
    first,
  });
  useDragFromTheList(drag);
  useSenderPressFromTheList(onSenderPress);
  return (
    <OhboxAbove model={model} beside={beside}>
      {children}
    </OhboxAbove>
  );
}

/** The drag's press, watched in the capture phase: the frame's list section is no element of the place's own. */
function useDragFromTheList(drag: DragToFile): void {
  const latest = useRef(drag);
  latest.current = drag;
  useEffect(() => {
    const down = (event: PointerEvent): void => latest.current.onPointerDown(event);
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, []);
}

/**
 * A press on a sender's face or address in the seated list, heard in the capture phase as the stage hears it for a
 * view of today's: the sender's menu opens instead of the row. The frame's list section stands outside the stage.
 */
function useSenderPressFromTheList(onSenderPress: (event: MouseEvent) => void): void {
  const latest = useRef(onSenderPress);
  latest.current = onSenderPress;
  useEffect(() => {
    const click = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest(SEATED.list) !== null) latest.current(event);
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, []);
}

/** The keyboard back on the list: the row the cursor is on, else the list itself. */
function focusTheList(at: OhboxAt): void {
  const row = document.querySelector<HTMLElement>(`${at.list} .oh-row[data-open]`);
  const to = row ?? document.querySelector<HTMLElement>(`${at.list} .ob-scroll`);
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
function useListKeepsKeyboard(at: OhboxAt): void {
  const ROW = `${at.list} .oh-row[data-id]`;
  const ROW_SLOT = `${at.list} .oh-row-slot`;
  const LIST = at.list;
  const LAYER = at.layer;
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
    return () => focusTheList(at);
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
        focusTheList(at);
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
function useRowFocusFollow(openId: string | null, at: OhboxAt): void {
  useEffect(() => {
    if (openId === null) return;
    const cur = document.activeElement;
    if (!(cur instanceof HTMLElement) || !(cur.matches(`${at.list} .oh-row[data-id]`) || cur.matches(`${at.list} .ob-scroll`)))
      return;
    if (cur.dataset.id === openId) return;
    const next = document.querySelector<HTMLElement>(`${at.list} .oh-row[data-id="${CSS.escape(openId)}"]`);
    if (next && next !== cur) next.focus({ preventScroll: true });
  }, [openId, at]);
}
