/**
 * THE WALK OF A LIST BESIDE THE READING COLUMN: the cursor's row, the two steps by key, Enter, the first letter
 * standing open on arrival, and the cursor a first verb key places. The list's own, not a place's: every place that
 * shows a list of letters walks it this way, after the Ohbox's own (`../ohbox/live-open.ts`).
 *
 * IT TAKES NO VERB. Its input is ids in the order the list draws them, the frame's way to open a letter, how many
 * columns stand and the place's word on arrival: no press seam, no letter and no act on one. A place with no letter's
 * verbs (Trash) walks its list through it and gains none.
 *
 * WHERE THE CURSOR IS. Two columns: the letter the address names, the one beside the list. One column: a row of
 * the list's own, kept here; it names no letter, shows nothing and reads nothing, and the letter the address names
 * (which stands over the list) is the cursor while one is named. The row follows the open letter, so a letter that
 * closes leaves the cursor on the row read.
 *
 * A STEP (`j` and the arrow down, `k` and the arrow up: one pair of closures) with no cursor comes in at the top going
 * down and at the end going up. Beside or over an open letter, and wherever two columns stand, it OPENS the row it
 * lands on as a preview, entered once the cursor rests on it where the place keeps a read rule (`land`). Where one
 * column stands and no letter is over the list it moves the cursor row alone. Enter on the cursor's row, and a press
 * on any row, open the letter and enter it.
 *
 * THE ARRIVAL, once for a list: at the first render in which it holds a row, where two columns stand, the address
 * names no letter and the place's word is `first`, the first row is opened as a preview: nothing is entered and
 * nothing read. A letter the address names already spends the arrival, a person who closes the letter keeps it
 * closed, and a row listed later never takes the column.
 *
 * THE PLACER: a letter's verb pressed while no cursor stands places the cursor on the first row, says so, and does
 * nothing else (`../keys/keymap.ts`, `CursorPlacer`). It answers only where the pressed verb can then act: where two
 * columns stand the first letter opens beside the list and the reading column's verbs are live on it. Where one
 * column stands it declines, since a list binds no verb on its cursor row and a placed cursor would promise a press
 * that cannot work.
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  useCursorPlacer,
  useKeyBindings,
  useZoneNav,
  type CursorPlacer,
  type KeyBinding,
} from "../keys/index.js";
import { queryVisible } from "../lists/visible-dom.js";
import { useStableCallback } from "../press/stable-callback.js";
import type { ListStep } from "../reading/list-meeting.js";
import type { Translator } from "../text/translator.js";

/** Whether a list's first letter stands open on arrival where two columns stand: the place's own word. */
export type ListArrival = "first" | "rest";

/**
 * How long the placer's sentence stands. Shorter than a report's own time: it carries nothing to press, and the
 * second press is meant to follow it at once.
 */
export const CURSOR_HINT_MS = 2400;

/** What the walk reads of the window and the address, and says in the key sheet: the same for every list of a place. */
export interface ListWalkSeat {
  /** The person closed the reading column in this entry. */
  readonly readerClosed?: boolean;
  /** Opens an arrival preview without adding a browser history entry. */
  readonly replacePreview?: (id: string) => void;
  /** How many columns stand. */
  readonly columns: 1 | 2;
  /** Which list the rows are (the place and its word): another list arrives again, and no cursor row is carried into it. */
  readonly list: string;
  /** The walk's keys as the key sheet names them. */
  readonly labels: { readonly next: string; readonly prev: string; readonly open: string };
  /** Says that a cursor was placed, naming the pressed key's own label. */
  readonly say: (label: string) => void;
}

export interface ListWalkInput extends ListWalkSeat {
  /** The rows' ids in the order the list draws them: the walk's stops. */
  readonly order: readonly string[];
  /** The letter the address names in the place, or none. */
  readonly openId: string | null;
  /** Opens a letter in the place beside or over its list: the frame's command. */
  readonly open: (id: string | null) => void;
  readonly arrival: ListArrival;
  /** A row entered (Enter, a press, the step into the column), where the place keeps a read rule. */
  readonly enter?: (id: string) => void;
  /** A row a step landed on: entered once the cursor rests on it, where the place keeps a read rule. */
  readonly land?: (id: string) => void;
  /** The reading column scrolled by an arrow over the cursor's letter, where the place keeps a read rule. */
  readonly scrolled?: (id: string, scroller: HTMLElement | null) => void;
}

export interface ListWalk {
  /** The cursor's row, or none: what the list marks. */
  readonly cursor: string | null;
  /** A press on a row: the cursor goes there, the letter opens and is entered. */
  readonly press: (id: string) => void;
  /** Toward the top of the list, and toward its end. */
  readonly up: ListStep;
  readonly down: ListStep;
  /** `j`, `k` and Enter, as the key registry takes them. */
  readonly keys: KeyBinding[];
  readonly place: CursorPlacer;
  /** What the keyboard's zones read of the list: the arrows' steps, and the step into the reading column. */
  readonly zone: {
    readonly list: { readonly up: ListStep; readonly down: ListStep };
    readonly reader: {
      readonly disabled: boolean;
      readonly onEnter: () => void;
      readonly onHiddenEnter: () => void;
      readonly onScrollKey: (scroller: HTMLElement | null) => void;
    };
  };
}

/** Enter on something a press already answers is that thing's own. */
const notOnAButton = (e: KeyboardEvent): boolean => (e.target as HTMLElement | null)?.tagName !== "BUTTON";

export function useListWalk(input: ListWalkInput): ListWalk {
  const { order, openId, open, columns, arrival, list, enter, land, scrolled, labels, say } = input;
  const one = columns === 1;
  const [row, setRow] = useState<{ readonly list: string; readonly id: string } | null>(null);
  /* The row follows the letter the address names: when that letter closes, the cursor stays on the row read. */
  if (openId !== null && (row === null || row.list !== list || row.id !== openId))
    setRow({ list, id: openId });
  const kept = row !== null && row.list === list ? row.id : null;
  const wanted = one ? (openId ?? kept) : openId;
  const at = wanted === null ? -1 : order.indexOf(wanted);
  const cursor = at < 0 ? null : wanted;

  /* THE ARRIVAL's RECORD: the list that arrived already, so that no later row and no letter closed opens another.
     A step, a press or a placed cursor is the person's own choice of a row, and spends it too: an arrival owed in
     the very commit a row was pressed in never opens another letter over that choice. */
  const arrived = useRef<string | null>(null);
  const stepTo = useStableCallback((id: string) => {
    arrived.current = list;
    setRow({ list, id });
    /* One column and no letter over the list: the cursor row alone moves. */
    if (one && openId === null) return;
    open(id);
    land?.(id);
  });
  const enterRow = useStableCallback((id: string) => {
    arrived.current = list;
    setRow({ list, id });
    /* The open letter pressed again writes the address no second time. */
    if (id !== openId) open(id);
    enter?.(id);
  });
  const last = order.length - 1;
  const stepBy = useStableCallback((by: 1 | -1) => {
    if (by > 0) {
      if (at < last) stepTo(order[at + 1]!);
    } else if (at < 0 && last >= 0) stepTo(order[last]!);
    else if (at > 0) stepTo(order[at - 1]!);
  });
  /* No cursor is the way in: at the top going down (`-1 >= last` holds only for a list with no row), at the end
     going up. The two steps are the same objects while what they say has not moved: the reading column draws them. */
  const downRests = at >= last;
  const upRests = order.length === 0 || at === 0;
  const down = useMemo(
    (): ListStep => ({ disabled: downRests, run: () => stepBy(1), label: labels.next }),
    [downRests, stepBy, labels.next],
  );
  const up = useMemo(
    (): ListStep => ({ disabled: upRests, run: () => stepBy(-1), label: labels.prev }),
    [upRests, stepBy, labels.prev],
  );

  const first = order[0];
  const arrive = useStableCallback((id: string) => (input.replacePreview ?? open)(id));
  /* In the commit that lists the first row, before it is painted: the list never stands a frame beside a blank
     column that the next frame fills. */
  useLayoutEffect(() => {
    if (arrived.current === list) return;
    if (openId === null && first === undefined) return; // no row yet: the arrival waits for the first
    arrived.current = list;
    if (openId === null && first !== undefined && arrival === "first" && !one && !input.readerClosed)
      arrive(first);
  }, [list, openId, first, arrival, one, input.readerClosed, arrive]);

  const place = useStableCallback((label: string): boolean => {
    if (one || openId !== null || first === undefined) return false;
    arrived.current = list;
    setRow({ list, id: first });
    open(first);
    say(label);
    return true;
  });

  const resting = cursor === null ? ({ disabled: true, disabledReason: "no_cursor" } as const) : {};
  const keys: KeyBinding[] = [
    { chord: "j", group: "navigate", label: labels.next, disabled: down.disabled, run: down.run },
    { chord: "k", group: "navigate", label: labels.prev, disabled: up.disabled, run: up.run },
    {
      chord: "Enter",
      group: "message",
      label: labels.open,
      ...resting,
      when: notOnAButton,
      run: () => {
        if (cursor !== null) enterRow(cursor);
      },
    },
  ];
  return {
    cursor,
    press: enterRow,
    up,
    down,
    keys,
    place,
    zone: {
      list: { up, down },
      reader: {
        disabled: cursor === null,
        /* The step into the column enters the letter it shows; where the column is hidden it is the open. */
        onEnter: () => {
          if (cursor !== null) enter?.(cursor);
        },
        onHiddenEnter: () => {
          if (cursor !== null) enterRow(cursor);
        },
        onScrollKey: (scroller: HTMLElement | null) => {
          if (cursor !== null) scrolled?.(cursor, scroller);
        },
      },
    },
  };
}

/** Where the keyboard's zones stand and what the key sheet calls them: what only a seat can read. */
export interface ListZones {
  /** The names the key sheet lists the zones under (`shortcuts`). */
  readonly shortcuts: Translator;
  /** The reading column's focus and scroll target, and the list's own cursor row, as the page finds them. */
  readonly at: { readonly reading: string; readonly openRow: string };
}

/**
 * THE WALK's KEYS, BOUND: `j`, `k` and Enter in the key registry, the arrows through the keyboard's zones (in the
 * list they are the two steps; in the reading column they scroll the letter), and the placer at a view's rank. A
 * place's live hook calls it once, for as long as the place stands.
 */
export function useListWalkKeys(walk: ListWalk, zones: ListZones): void {
  useKeyBindings(walk.keys);
  useCursorPlacer(walk.place, "view");
  useZoneNav(zones.shortcuts, {
    list: walk.zone.list,
    reader: {
      selector: zones.at.reading,
      ...walk.zone.reader,
      onScrollKey: () => walk.zone.reader.onScrollKey(queryVisible<HTMLElement>(zones.at.reading)),
    },
    listFocusSelector: zones.at.openRow,
  });
}
