/**
 * THE OPEN CONVERSATION, AS THE NEW READER DRAWS IT: share reader-1's helper for the older cases that mounted today's
 * `MessagePane` under a `MessageChromeProvider` (the join folds it). It mounts exactly as the reader's own door does
 * (`packages/app/test/reader/support/mail.tsx`'s `mountReader`: the frame, one place whose reading column is the
 * reader, a fake engine that records every body ask and mutation), with the one difference `NEEDS-DOOR.md` 1 names:
 * the key map's registry stood by the frame's own store, not today's `KeymapProvider`.
 *
 * What today's chrome handed the pane is handed where the new shell hands it: the conversation is the mirror's letters
 * of one thread; each body is a `message_body` row of the mirror (`bodies`); the letter's renderer, the file door and
 * the reply are the reader's parts (`parts`); the account's own addresses and its mailboxes' status are the host's
 * `mailboxes` read; a list's visit (the Ohbox's wiring, previewing or entered) is the list meeting (`meeting`), which
 * the case may hand again (`meet`). Every address is invented.
 */
import type { EngineMessage } from "@ohmail/wire";
import { act, render, renderHook } from "@testing-library/react";
import type { ComponentType, PropsWithChildren, ReactNode } from "react";
import type { EntityReader } from "@ohmail/client-engine";
import {
  ListMeetingContext,
  PresentedMirrorContext,
  useReaderVisit,
  type ListMeeting,
  type ThreadReadWiring,
} from "@ohmail/app-logic/reading";
import { KeymapContext, useKeymapStore } from "@ohmail/app-logic/keys";
import { Frame } from "../../../packages/app/src/frame/Frame.js";
import type { PaneProps, PlaceEntry } from "../../../packages/app/src/frame/contract.js";
import {
  readerEntry,
  type LetterProps,
  type ReaderParts,
} from "../../../packages/app/src/reader/index.js";
import { TextProvider, type Messages } from "../../../packages/app/src/text/index.js";
import { fakeMail, letter } from "../../../packages/app/test/reader/support/fake-mail.js";
import { fakeHost, type FakeHostInput } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { FRAME_WORDS } from "../../../packages/app/test/support/frame-words.js";
import readerEn from "../../../packages/app/messages/reader.en.json" with { type: "json" };
import readerDe from "../../../packages/app/messages/reader.de.json" with { type: "json" };
import sharedEn from "../../../packages/app/messages/shared.en.json" with { type: "json" };
import sharedDe from "../../../packages/app/messages/shared.de.json" with { type: "json" };
import ohboxEn from "../../../packages/app/messages/ohbox.en.json" with { type: "json" };
import ohboxDe from "../../../packages/app/messages/ohbox.de.json" with { type: "json" };

import allEn from "../messages/en.json" with { type: "json" };
import allDe from "../messages/de.json" with { type: "json" };

export { letter };

/** The reader's words over the frame's and the places', as the reader's own cases compose them. */
export const LETTER_WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: {
    ...FRAME_WORDS.en, ...sharedEn, ...ohboxEn, ...readerEn, attachmentPreview: allEn.attachmentPreview,
    screening: allEn.screening, screener: allEn.screener, event: allEn.event,
  } as Messages,
  de: {
    ...FRAME_WORDS.de, ...sharedDe, ...ohboxDe, ...readerDe, attachmentPreview: allDe.attachmentPreview,
    screening: allDe.screening, screener: allDe.screener, event: allDe.event,
  } as Messages,
};

/** The reader's own catalogue, for a case that reads the seated part's sentence by its key. */
export const READER_EN = readerEn;

/** The body double: its text, the end the read rule reads, and every input it was handed, per letter. */
export function bodyDouble(): { body: ReaderParts["body"]; handed: Map<string, LetterProps> } {
  const handed = new Map<string, LetterProps>();
  function Body(props: LetterProps) {
    handed.set(props.messageId, props);
    return (
      <div className="stub-body">
        <p>{props.text}</p>
        <span data-own-end="" />
      </div>
    );
  }
  return { body: Body, handed };
}

function List({ route }: PaneProps) {
  return <p>the list of {route.place}</p>;
}
export const READER_PLACE: PlaceEntry = {
  id: "ohbox",
  body: "ohbox",
  rail: { group: "main", icon: "ohbox", label: "title" },
  panes: { kind: "columns", List, Reading: "reader" },
};
const WRITE_PLACE: PlaceEntry = {
  id: "write",
  body: "write",
  rail: null,
  panes: { kind: "wide", Wide: () => <p>the place that writes</p> },
};

function Keys({ children }: { children: ReactNode }) {
  return <KeymapContext.Provider value={useKeymapStore()}>{children}</KeymapContext.Provider>;
}

/** A fresh read record, as a list's visit holds one (made by the column's own visit hook). */
export function freshRecord(): ThreadReadWiring["record"] {
  const { result, unmount } = renderHook(() => useReaderVisit({ shown: letter("record"), markSeen: () => true }));
  const record = result.current.wiring!.record;
  unmount();
  return record;
}

export interface MountLetters {
  readonly letters: readonly EngineMessage[];
  readonly open: string;
  /** Body rows by letter id (a letter without its own `body` reads them). */
  readonly bodies?: Readonly<Record<string, unknown>>;
  readonly parts?: Partial<ReaderParts>;
  readonly host?: Partial<FakeHostInput>;
  /** The list meeting the column reads its visit from; absent, none stands. */
  readonly meeting?: ListMeeting;
  readonly size?: Parameters<typeof fakeWindow>[0];
  readonly lang?: "en" | "de";
  readonly wrapper?: ComponentType<PropsWithChildren>;
}

/** Mount the reader with `open` open over the mirror's `letters`. */
export function mountLetters(o: MountLetters) {
  const mail = fakeMail(o.letters, [], o.bodies ?? {});
  const double = bodyDouble();
  const parts: ReaderParts = {
    body: double.body,
    files: "none",
    pictures: "none",
    look: "none",
    sentCopy: "none",
    reply: "none",
    invitation: "none",
    ...o.parts,
  };
  const address = fakeAddress(`#/ohbox/m/${o.open}`);
  const made = fakeHost({
    engine: mail.engine,
    service: "self",
    scope: "acct-1",
    places: { ohbox: READER_PLACE, write: WRITE_PLACE },
    reader: readerEntry(parts),
    window: fakeWindow(o.size ?? "desktop"),
    address,
    ...o.host,
  });
  const lang = o.lang ?? "en";
  const mirror: EntityReader = mail.engine.read();
  const tree = (meeting: ListMeeting | undefined) => {
    const frame = (
      <PresentedMirrorContext.Provider value={mirror}>
        <Frame host={made.host} />
      </PresentedMirrorContext.Provider>
    );
    return (
      <TextProvider locale={lang} messages={LETTER_WORDS[lang]} timeZone="UTC">
        <Keys>
          {meeting === undefined ? (
            frame
          ) : (
            <ListMeetingContext.Provider value={meeting}>{frame}</ListMeetingContext.Provider>
          )}
        </Keys>
      </TextProvider>
    );
  };
  const view = render(tree(o.meeting), o.wrapper ? { wrapper: o.wrapper } : undefined);
  return {
    ...made,
    mail,
    view,
    handed: double.handed,
    /** Hand the column another list meeting (the same tree drawn again: its state kept). */
    meet: async (meeting: ListMeeting | undefined) => {
      await act(async () => {
        view.rerender(tree(meeting));
      });
    },
  };
}

/** The conversation's letters on screen, in the column's order, by the id each carries. */
export function lettersShown(): string[] {
  return [...document.querySelectorAll<HTMLElement>("[data-conv-id]")].map((e) => e.dataset.convId ?? "");
}
/** One letter of the column, by id: the reader's own letter (its sheet and everything drawn in it). */
export function letterOf(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-conv-id="${id}"]`);
}
