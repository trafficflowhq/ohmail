/**
 * THE OHBOX AS TODAY'S SHELL MOUNTS IT, for a test that hands it inputs by name, in two ways over the same inputs:
 * - `prepareToday`: today's view, `TodaysOhbox` in a wide pane of the frame (the list beside today's reading column);
 * - `prepareSeated`: the seated place, the Ohbox's own entry with `TodaysOhboxAbove` above its two columns, fed by the
 *   test's inputs through `TodaysOhboxFed` (the stand-in of the composition's provider), the open letter the address's.
 * Both stand over the host a shell builds from today's inputs, under the mail state and the engine a shell stands
 * them in. `TodayOhbox` takes the inputs the old view took, so a case written against that view's inputs reads the
 * same; it fits under the test's own intl and key providers. The engine is an empty mirror: the Ohbox's rows are the
 * inputs, as they were.
 *
 * `prepareSeated({ reading: true })` is the seated place WITH ITS READING COLUMN, for a case that reads the open
 * letter: the reader draws a letter from the engine's mirror, where today's pane was handed it as a prop, so there the
 * mirror holds the letters the inputs name (`lettersOver`).
 */
import type { EngineMessage } from "@ohmail/wire";
import {
  createContext, createElement as h, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { useMessages } from "next-intl";
import type { EntityReader } from "@ohmail/client-engine";
import { NONE, type None, type ReaderEntry } from "@ohmail/app/host";
import { Frame, PLACE_IDS, useFrame, type FramePlaces } from "@ohmail/app/frame";
import { ohboxPlace } from "@ohmail/app/ohbox";
import { readerEntry } from "@ohmail/app/reader";
import { TextProvider } from "@ohmail/app/text";
import { EngineProvider } from "../../app/shell/engine";
import { MailStateProvider } from "@ohmail/app/mail-state";
import type { MailboxProbe } from "@ohmail/app-logic/mail-state/mail-state-binding";
import { PresentedMirrorContext } from "@ohmail/app-logic/reading";
import { TodaysOhbox, type TodaysOhboxProps } from "../../app/shell/TodaysOhbox";
import { TodaysOhboxAbove, TodaysOhboxFed, type TodaysOhboxFeed } from "../../app/shell/TodaysOhboxAbove";
import { useTodaysSupplies } from "../../app/shell/todays-supplies";
import { engineOver, storeWith } from "../_view-shell";
import { hostFromTodaysInputs } from "../_todays-shell";

/** The old view's inputs: `pull` may be left out (no Pull new mail), as may the inputs the Ohbox no longer reads. */
export type TodayOhboxProps = Omit<TodaysOhboxProps, "pull"> & {
  pull?: TodaysOhboxProps["pull"];
  /** The mailboxes the mail state reads; left out, the account's mailboxes are not known. */
  mailboxProbe?: MailboxProbe;
  [unread: string]: unknown;
};

const NO_PULL = { available: false, pulling: false, pull: () => undefined };
const Fed = createContext<TodayOhboxProps | null>(null);

/** The wide pane today's views stand in: the Ohbox, fed the test's inputs. */
function Pane(): ReactNode {
  const props = useContext(Fed)!;
  const { mailboxProbe: _probe, pull, ...rest } = props;
  return h(TodaysOhbox, { ...(rest as unknown as TodaysOhboxProps), pull: pull ?? NO_PULL });
}

const PLACES = Object.fromEntries(
  PLACE_IDS.map((id) => [id, { id, body: "today", rail: null, panes: { kind: "wide", Wide: Pane } }]),
) as unknown as FramePlaces;

let shared: Promise<ReturnType<typeof engineOver>> | null = null;
/** One empty mirror for every mount: nothing here reads it but the mail state. */
export function todayEngine(): Promise<ReturnType<typeof engineOver>> {
  shared ??= storeWith([]).then((s) => engineOver(s));
  return shared;
}

/**
 * The composition's feed, as the test's inputs give it: the row's selection beside the address is the test's own
 * `onSelect`, the header's tenant stands over the list, the standing notice first in it. A test that holds its own
 * selection keeps it as the address: the harness names the test's `selectedId` in the address, as a link does. One
 * moment is the list's: a press of its own moves the address at once and tells the test (`onSelect`), and the
 * inputs the test drew BEFORE that press are no answer to it; the next inputs it draws are.
 */
function SeatedAbove({ children }: { readonly children: ReactNode }): ReactNode {
  const props = useContext(Fed)!;
  const { mailboxProbe: _probe, pull, selectedId, onSelect, readerId: _reader, noticeSection, standingNotice, ...rest } = props;
  const { route, commands } = useFrame();
  /* What the list's last own press told the test, and the inputs the address was last compared with. */
  const told = useRef<string | null | undefined>(undefined);
  const drawn = useRef(props);
  useEffect(() => {
    const drewAgain = drawn.current !== props;
    drawn.current = props;
    if (selectedId === undefined || selectedId === route.open) return;
    if (!drewAgain && told.current === route.open) return;
    commands.open(selectedId);
  }, [props, selectedId, route.open, commands]);
  const feed = useMemo(
    (): TodaysOhboxFeed => ({
      ...(rest as unknown as Omit<TodaysOhboxFeed, "pull" | "onSelectRow" | "cursor" | "over" | "first">),
      pull: pull ?? NO_PULL,
      /* The sender's menu is the shell's, which this harness does not stand: a press on a face is the row's here. */
      onSenderPress: () => {},
      /* The cursor row the composition holds is the test's own selection, which this harness also names in the
         address at every width: on one column the letter of the test's selection stands over the list. */
      cursor: selectedId ?? null,
      onSelectRow: (id) => {
        told.current = id;
        onSelect?.(id);
      },
      over: { ribbon: null, stageCard: null, tenant: noticeSection ?? null },
      first: standingNotice ?? null,
    }),
    [props],
  );
  return h(TodaysOhboxFed.Provider, { value: feed }, h(TodaysOhboxAbove, null, children));
}

/**
 * The seated entry, as the hosts will hand it: the Ohbox's own place with today's composition above its columns. Its
 * rail entry is left out here: on a host the rail is the composition's fed model while it stands, and draws no
 * registered entry, and this harness stands no composition, so a registered entry would ask the model outside it.
 */
const SEATED_OHBOX = { ...ohboxPlace, rail: null, panes: { ...ohboxPlace.panes, Above: SeatedAbove } } as const;
const SEATED_PLACES = { ...PLACES, ohbox: SEATED_OHBOX } as unknown as FramePlaces;

/* The mail state as the shell mounts it: for the scope the host hands, over the frame of that host. */
function Host({ engine, probe, seated, reader }: {
  engine: ReturnType<typeof engineOver>;
  probe?: MailboxProbe;
  seated?: boolean;
  reader?: ReaderEntry | None;
}): ReactNode {
  const frame = useTodaysSupplies(NONE);
  const host = useMemo(
    () => hostFromTodaysInputs(
      { demo: false, engine, ...(reader && reader !== NONE ? { reader } : {}) },
      engine,
      { ...frame, places: seated ? SEATED_PLACES : PLACES },
      NONE,
    ),
    [engine, frame, seated, reader],
  );
  return h(MailStateProvider, { scope: host.session.scope, mirrored: 0, probe } as never, h(Frame, { host }));
}

function Words({ children }: { children: ReactNode }): ReactNode {
  const messages = useMessages();
  return h(TextProvider, { locale: "en", messages: messages as never, timeZone: "UTC", children } as never);
}

let ready: ReturnType<typeof engineOver> | null = null;

/** Today's Ohbox in its frame. One component for every render, so a new render is an update, never a mount. */
function TodayOhbox(props: TodayOhboxProps): ReactNode {
  const engine = ready!;
  return h(Words, null,
    h(EngineProvider, { demo: false, engine } as never,
      h(Fed.Provider, { value: props }, h(Host, { engine, probe: props.mailboxProbe }))));
}

/** Await before the first render (the engine the mail state stands on); every call hands the same component. */
export async function prepareToday(): Promise<(props: TodayOhboxProps) => ReactNode> {
  ready = await todayEngine();
  return TodayOhbox;
}

/* A mount starts at the Ohbox's address: what a test before it left open is no letter of this one's. */
function useOhboxAddressAtMount(selectedId: string | null | undefined): void {
  useState(() => {
    window.location.hash = selectedId ? `#/ohbox/m/${selectedId}` : "#/ohbox";
    return true;
  });
}

/** The seated Ohbox in its frame, at the Ohbox's address (the test's open letter in it). One component, as above. */
function SeatedOhbox(props: TodayOhboxProps): ReactNode {
  const engine = ready!;
  useOhboxAddressAtMount(props.selectedId);
  return h(Words, null,
    h(EngineProvider, { demo: false, engine } as never,
      h(Fed.Provider, { value: props }, h(Host, { engine, probe: props.mailboxProbe, seated: true }))));
}

/** Every letter the inputs name: the rows of the three groups, and each one's conversation where the inputs answer one. */
function lettersOf(props: TodayOhboxProps): EngineMessage[] {
  const rows = [...(props.resurfacedRows ?? []).flatMap((row) => row.members), ...props.newForYou, ...props.previouslySeen];
  const named = new Map<string, EngineMessage>();
  for (const row of rows)
    for (const m of [row, ...(props.conversationOf?.(row.id) ?? [])]) if (!named.has(m.id)) named.set(m.id, m);
  return [...named.values()];
}

/**
 * THE MIRROR OF A SEATED PLACE THAT HOLDS LETTERS. The engine a place stands on, answering the test's own letters:
 * `show` hands it the letters the newest render names, and its mirror (what the lists present, too) holds exactly
 * those; a letter that reads the same keeps its object, as a mirror's row does. Everything else is the empty mirror
 * the engine has: no tag, no body record (a letter's text is its row's `body`, else its snippet, and nothing is
 * fetched), no tombstone, and a verb the list does not take runs over no letter.
 */
function lettersOver(base: ReturnType<typeof engineOver>): {
  readonly engine: ReturnType<typeof engineOver>;
  readonly mirror: EntityReader;
  /** The letters as this render names them; the columns drawn in the same render read them. */
  readonly show: (letters: readonly EngineMessage[]) => void;
  /** After the commit: whoever reads the mirror and was not drawn again hears that it moved. */
  readonly tell: () => void;
} {
  let rows = new Map<string, EngineMessage>();
  let stamp = 0;
  let told = 0;
  const heard = new Set<() => void>();
  const version = (): number => base.read().version() + stamp;
  const mirror: EntityReader = {
    version,
    stampOf: version,
    stampExcept: version,
    get: <T,>(type: string, id: string) => (type === "message" ? (rows.get(id) as T | undefined) : base.read().get<T>(type, id)),
    list: <T,>(type: string) => (type === "message" ? ([...rows.values()] as T[]) : base.read().list<T>(type)),
    entries: <T,>(type: string) =>
      type === "message"
        ? [...rows].map(([id, entity]) => ({ id, entity: entity as T, seq: stamp }))
        : base.read().entries<T>(type),
  };
  const own: Record<string, unknown> = {
    read: () => mirror,
    verbRead: () => mirror,
    subscribe: (listener: () => void) => {
      heard.add(listener);
      const stop = base.subscribe(listener);
      return () => {
        heard.delete(listener);
        stop();
      };
    },
  };
  /* The engine itself but for the three reads above: every other call reaches it as it was made. */
  const engine = new Proxy(base, {
    get(target, key) {
      if (typeof key === "string" && key in own) return own[key];
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return {
    engine,
    mirror,
    show: (letters) => {
      const next = new Map<string, EngineMessage>();
      for (const m of letters) {
        const had = rows.get(m.id);
        next.set(m.id, had !== undefined && JSON.stringify(had) === JSON.stringify(m) ? had : m);
      }
      if (next.size === rows.size && [...next].every(([id, m]) => rows.get(id) === m)) return;
      rows = next;
      stamp += 1;
    },
    tell: () => {
      if (told === stamp) return;
      told = stamp;
      for (const listener of [...heard]) listener();
    },
  };
}

let reading: (ReturnType<typeof lettersOver> & { readonly reader: ReaderEntry }) | null = null;

/** The seated Ohbox with its reading column: the reader over the letters the inputs name. One component, as above. */
function SeatedReading(props: TodayOhboxProps): ReactNode {
  const { engine, mirror, reader, show, tell } = reading!;
  useOhboxAddressAtMount(props.selectedId);
  /* In the render, as a shell's one mirror gives the list and the column the same letters in one commit. */
  show(lettersOf(props));
  useLayoutEffect(tell);
  return h(Words, null,
    h(EngineProvider, { demo: false, engine } as never,
      h(PresentedMirrorContext.Provider, { value: mirror },
        h(Fed.Provider, { value: props }, h(Host, { engine, probe: props.mailboxProbe, seated: true, reader })))));
}

/**
 * The seated place, over the same inputs. Its reading column stays empty (the host hands no reader) unless `reading`
 * is asked: then the column is the reader with the body's own renderer and no other part (no files, no pictures, no
 * look, no reply's sheet, no invitation's note), and the mirror holds the letters the inputs name.
 */
export async function prepareSeated(opts: { reading?: boolean } = {}): Promise<(props: TodayOhboxProps) => ReactNode> {
  const base = await todayEngine();
  if (opts.reading !== true) {
    ready = base;
    return SeatedOhbox;
  }
  if (reading === null) {
    const { letterBody } = await import("@ohmail/app/reader/body");
    const reader = readerEntry({ body: letterBody, files: "none", pictures: "none", look: "none", sentCopy: "none", reply: "none", invitation: "none" });
    reading = { ...lettersOver(base), reader };
  }
  return SeatedReading;
}

export { groupIds, headCount, ohboxRow, ohboxRows, openRow, pickedCount } from "./_finders.js";
