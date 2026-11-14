/**
 * THE OPEN LETTER's PANEL, AS THE NEW READER DRAWS IT: share reader-1's helper for the older cases that mounted
 * today's `MessagePane` with an `onAction` seam (the join folds it). The reader is mounted by its own test door
 * (as `packages/app/test/reader/support/mail.tsx`'s `mountReader` mounts it: the frame, one place whose reading
 * column is the reader, a fake engine that records every mutation; the key map's registry stood by the frame's own
 * store, not today's `KeymapProvider`), and the list that opened the letter hands its visit: every
 * verb the panel runs reaches `visit.act`, which this helper records in `actions`, the same seam today's
 * `onAction` was (the list's own path, where the list lands its cursor and answers Undo). Without a visit the
 * reader's own runners write through the press seam, read off `mail.mutations`.
 *
 * A case may declare chords in the key map's registry (`bound`, `disabled`), as today's harness did, to read what a
 * press runs; and may give the panel less room than its verbs (`fold`), as `reader/letters.test.tsx` does, so that
 * what does not fit stands behind More. Every address is invented.
 */
import type { EngineMessage } from "@ohmail/wire";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { vi } from "vitest";
import type { EntityReader } from "@ohmail/client-engine";
import {
  ListMeetingContext,
  PresentedMirrorContext,
  useReaderVisit,
  type ListMeeting,
  type ListVisit,
  type ThreadReadWiring,
} from "@ohmail/app-logic/reading";
import { KeymapContext, useKeymapStore } from "@ohmail/app-logic/keys";
import { useKeyBindings } from "@ohmail/app-logic/keys/keymap";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import { useRoomResurface } from "../../../packages/app/src/frame/room.js";
import type { PaneProps, PlaceEntry } from "../../../packages/app/src/frame/contract.js";
import { readerEntry, type ContactScreeningProps, type LetterProps } from "../../../packages/app/src/reader/index.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import readerEn from "../../../packages/app/messages/reader.en.json" with { type: "json" };
import { fakeMail, letter } from "../../../packages/app/test/reader/support/fake-mail.js";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";

/** The reader's words over the frame's, as the reader's own cases compose them. */
const WORDS = { ...FRAME_WORDS.en, ...readerEn } as Messages;

/** The body: its text and the end the read rule reads. */
function Body(props: LetterProps) {
  return (
    <div className="stub-body">
      <p>{props.text}</p>
      <span data-own-end="" />
    </div>
  );
}
function List({ route }: PaneProps) {
  return <p>the list of {route.place}</p>;
}
const READER_PLACE: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading: "reader" },
};
/** The place that writes, where an answer leads when the shell hands the reader no reply of its own. */
const WRITE_PLACE: PlaceEntry = {
  id: "write",
  body: "write",
  rail: null,
  panes: { kind: "wide", Wide: () => <p>the place that writes</p> },
};

/** The key map's registry above the frame, as a shell stands one: the panel's keys and a case's own chords meet in it. */
function Keys({ children }: { children: ReactNode }) {
  return <KeymapContext.Provider value={useKeymapStore()}>{children}</KeymapContext.Provider>;
}

/** A fresh read record, as a list's visit holds one (made by the column's own visit hook). */
function freshRecord(): ThreadReadWiring["record"] {
  const { result, unmount } = renderHook(() => useReaderVisit({ shown: letter("record"), markSeen: () => true }));
  const record = result.current.wiring!.record;
  unmount();
  return record;
}

export { letter };

export interface PanelMount {
  /** What the panel ran on the list's path, in order (today's `onAction` seam). */
  readonly actions: string[];
  /** Which declared chords ran. */
  readonly ran: string[];
  readonly mail: ReturnType<typeof fakeMail>;
  /** Move the reading column to another letter, as a list's cursor does. */
  readonly openOther: (id: string) => Promise<void>;
  /** Take the open letter out of the mirror (or put it back), and tell the readers. */
  readonly drop: (id: string, dropped: boolean) => Promise<void>;
}

export interface PanelOpts {
  /** Other letters in the mirror (the open one is `m1`). */
  readonly others?: readonly EngineMessage[];
  /** False: no list's visit; the reader's own runners write through the seam. */
  readonly visit?: boolean;
  /** Chords declared in the registry, each recording its run in `ran`. */
  readonly bound?: readonly string[];
  readonly disabled?: readonly string[];
  readonly draft?: (messageId: string) => void;
  /** The account's tags, by id and name (the Tag verb stands only where the account has tags). */
  readonly tags?: Readonly<Record<string, string>>;
  readonly size?: "desktop" | "phone" | "fold";
  /** Room for three verbs and a half (jsdom lays nothing out): what does not fit stands behind More. */
  readonly fold?: boolean;
  /**
   * The account's resurface hour (`HH:MM`), handed above the panes as the mail ground hands the consent row's
   * (`useRoomResurface`); nothing kept. Absent: nothing is handed, and the reader offers the product's hour.
   */
  readonly resurface?: string;
}

/** What stands above the panes where a case hands the account's hour: the ground's hand-over, and nothing else. */
function hourAbove(stored: string) {
  return function HourAbove({ children }: { readonly children: ReactNode }) {
    useRoomResurface({ stored, store: null });
    return <>{children}</>;
  };
}

function Declare({
  bound,
  disabled,
  ran,
}: {
  bound: readonly string[];
  disabled: readonly string[];
  ran: string[];
}): null {
  useKeyBindings(
    bound.map((chord) => ({
      chord,
      group: "message",
      label: `runs ${chord}`,
      disabled: disabled.includes(chord),
      run: () => {
        ran.push(chord);
      },
    })),
  );
  return null;
}

function visitOf(openId: string, actions: string[]): ListVisit {
  return {
    openId,
    unread: false,
    readSet: [],
    act: (action) => {
      actions.push(String(action));
    },
    wiring: {
      look: "tint",
      record: freshRecord(),
      onRead: vi.fn(),
      onEnter: vi.fn(),
      onMarkUnread: vi.fn(),
    },
    step: {
      up: { disabled: false, run: vi.fn(), label: "Previous" },
      down: { disabled: false, run: vi.fn(), label: "Next" },
    },
  };
}

/** jsdom lays nothing out: each shown verb is 100 wide, in a room of 350 (`reader/letters.test.tsx`'s own mocks). */
export function foldRoom(): void {
  const shownVerbs = (el: Element) =>
    [...el.querySelectorAll<HTMLElement>("[data-rank]")].filter((v) => !v.hidden).length;
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.getAttribute("role") === "toolbar" ? shownVerbs(this) * 100 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("oh-actionpanel") ? 350 : 0;
  });
}

/** Mount the reader with letter `m1` open (`over` its fields), the list's visit handed unless `visit: false`. */
export function mountPanel(over: Partial<EngineMessage> = {}, opts: PanelOpts = {}): PanelMount {
  if (opts.fold) foldRoom();
  const actions: string[] = [];
  const ran: string[] = [];
  const letters = [letter("m1", { unread: false, ...over }), ...(opts.others ?? [])];
  const rows = Object.fromEntries(
    Object.entries(opts.tags ?? {}).map(([id, name]) => [`tag:${id}`, { id, name, hue: "moss" }]),
  );
  const mail = fakeMail(letters, [], {}, rows);
  const hidden = new Set<string>();
  const raw = mail.engine.read();
  const hiding: EntityReader = {
    ...raw,
    get: <T,>(type: string, id: string) => (type === "message" && hidden.has(id) ? undefined : raw.get<T>(type, id)),
    list: <T,>(type: string) =>
      raw.list<T>(type).filter((m) => !(type === "message" && hidden.has((m as { id: string }).id))),
  } as EntityReader;
  const engine = { ...mail.engine, read: () => hiding, verbRead: () => hiding } as typeof mail.engine;
  const visits = new Map<string, ListVisit>();
  const visitFor = (id: string) => {
    if (!visits.has(id)) visits.set(id, visitOf(id, actions));
    return visits.get(id)!;
  };
  const meetingOf = (id: string) => (opts.visit === false ? undefined : { visit: visitFor(id), blank: null });
  const address = fakeAddress("#/ohbox/m/m1");
  function Screening({ direct, children }: ContactScreeningProps) {
    useEffect(() => { if (direct) actions.push("screen"); }, [direct]);
    return children();
  }
  const entry = { ...readerEntry({
    body: Body,
    files: "none",
    pictures: "none",
    look: "none",
    sentCopy: "none",
    reply: opts.draft === undefined ? "none" : {
      Sheet: () => null,
      useOpen: () => () => undefined,
      useVerbs: () => null,
      useDraft: () => opts.draft ?? null,
    },
    invitation: "none",
  }), Screening };
  const made = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    places: { ohbox: READER_PLACE, write: WRITE_PLACE },
    reader: opts.bound === undefined ? entry : {
      ...entry,
      // Cases supplying a registry exercise exactly its declarations.
      Reading: (pane) => <entry.Reading {...pane} keysHere={false} />,
    },
    window: fakeWindow(opts.size ?? "desktop"),
    address,
    ...(opts.resurface === undefined ? {} : { above: hourAbove(opts.resurface) }),
  });
  const meeting: ListMeeting | undefined = meetingOf("m1");
  /* The presented mirror over this engine's own rows: the column reads its letters there. */
  const frame = (
    <PresentedMirrorContext.Provider value={hiding}>
      <Frame host={made.host} />
    </PresentedMirrorContext.Provider>
  );
  render(
    <TextProvider locale="en" messages={WORDS} timeZone="Europe/Zurich">
      <Keys>
        {meeting === undefined ? frame : <ListMeetingContext.Provider value={meeting}>{frame}</ListMeetingContext.Provider>}
        {opts.bound === undefined ? null : <Declare bound={opts.bound} disabled={opts.disabled ?? []} ran={ran} />}
      </Keys>
    </TextProvider>,
  );
  return {
    actions,
    ran,
    mail,
    openOther: async (id) => {
      await act(async () => {
        address.visit(`#/ohbox/m/${id}`);
      });
    },
    drop: async (id, dropped) => {
      if (dropped) hidden.add(id);
      else hidden.delete(id);
      await act(async () => {
        mail.patch(id, {});
      });
    },
  };
}

/** The panel: the toolbar named Actions. */
export const panel = (): HTMLElement => screen.getByRole("toolbar", { name: "Actions" });
/** The panel's verbs as it shows them, by name (a verb folded behind More is hidden, not shown). */
export const shown = (): string[] =>
  within(panel())
    .getAllByRole("button")
    .filter((b) => !b.hidden && b.getAttribute("aria-label") !== "More")
    .map((b) => b.getAttribute("aria-label") ?? "");
export const verb = (name: string): HTMLButtonElement | null =>
  (within(panel())
    .queryAllByRole("button", { name })
    .find((b) => !b.hidden) ?? null) as HTMLButtonElement | null;
export const moreButton = (): HTMLButtonElement => within(panel()).getByRole("button", { name: "More" });
export const menu = (name: string): HTMLElement | null => screen.queryByRole("menu", { name });
export const items = (name: string): string[] =>
  within(screen.getByRole("menu", { name }))
    .getAllByRole("menuitem")
    .map((i) => (i.textContent ?? "").trim());
export async function press(el: Element): Promise<void> {
  await act(async () => {
    fireEvent.click(el);
  });
}
export async function pressVerb(name: string): Promise<void> {
  const b = verb(name);
  if (b === null) throw new Error(`no panel verb named "${name}": have ${shown().join(" | ")}`);
  await press(b);
}
export async function openMore(): Promise<void> {
  await press(moreButton());
}
export async function pressItem(menuName: string, name: string | RegExp): Promise<void> {
  await press(within(screen.getByRole("menu", { name: menuName })).getByRole("menuitem", { name }));
}
export async function key(el: Element, k: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(el, { key: k });
  });
}
