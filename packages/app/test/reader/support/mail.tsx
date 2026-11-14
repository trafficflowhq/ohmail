/**
 * THE READER OVER A FAKE ENGINE AND THE FAKE HOST: a mirror of hand-made letters, an engine that answers the press
 * seam and records every mutation and body ask, the frame with one place whose reading column is the reader, and the
 * shell's three parts as doubles that record what they were handed. Every address is invented.
 */
import { render, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { EngineMessage, EntityReader } from "@ohmail/client-engine";
import {
  ListMeetingContext,
  PresentedMirrorContext,
  useReaderVisit,
  type ListMeeting,
  type ThreadReadWiring,
} from "@ohmail/app-logic/reading";
import type { PictureSeam } from "@ohmail/app-logic/reader";
import { Frame } from "../../../src/frame/Frame.js";
import type { LayoutPlan, PaneProps, PlaceEntry } from "../../../src/frame/contract.js";
import { KeymapProvider } from "../../../src/keys/index.js";
import {
  readerEntry,
  type LetterProps,
  type ReaderFiles,
  type ReaderParts,
} from "../../../src/reader/index.js";
import { TextProvider, type Messages } from "../../../src/text/index.js";
import { fakeHost, type FakeHostInput } from "../../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../support/fake-window.js";
import { FRAME_WORDS } from "../../support/frame-words.js";
import readerEn from "../../../messages/reader.en.json" with { type: "json" };
import readerDe from "../../../messages/reader.de.json" with { type: "json" };
import sharedEn from "../../../messages/shared.en.json" with { type: "json" };
import sharedDe from "../../../messages/shared.de.json" with { type: "json" };
import ohboxEn from "../../../messages/ohbox.en.json" with { type: "json" };
import ohboxDe from "../../../messages/ohbox.de.json" with { type: "json" };
import screenerEn from "../../../messages/screener.en.json" with { type: "json" };
import screenerDe from "../../../messages/screener.de.json" with { type: "json" };
import trashEn from "../../../messages/trash.en.json" with { type: "json" };
import trashDe from "../../../messages/trash.de.json" with { type: "json" };
import doorsEn from "../../../messages/doors.en.json" with { type: "json" };
import doorsDe from "../../../messages/doors.de.json" with { type: "json" };
import searchEn from "../../../messages/search.en.json" with { type: "json" };
import searchDe from "../../../messages/search.de.json" with { type: "json" };

import { fakeMail, letter } from "./fake-mail.js";

export { fakeMail, letter, type FakeMail } from "./fake-mail.js";

export const WORDS: Readonly<Record<"en" | "de", Messages>> = {
  en: {
    ...FRAME_WORDS.en,
    ...sharedEn,
    ...ohboxEn,
    ...screenerEn,
    ...trashEn,
    ...doorsEn,
    ...searchEn,
    ...readerEn,
  } as Messages,
  de: {
    ...FRAME_WORDS.de,
    ...sharedDe,
    ...ohboxDe,
    ...screenerDe,
    ...trashDe,
    ...doorsDe,
    ...searchDe,
    ...readerDe,
  } as Messages,
};

/** A fresh read record, as a list's visit holds one (made by the column's own visit hook: the engine's own kind). */
export function freshRecord(): ThreadReadWiring["record"] {
  const { result, unmount } = renderHook(() =>
    useReaderVisit({ shown: letter("record"), markSeen: () => true }),
  );
  const record = result.current.wiring!.record;
  unmount();
  return record;
}

/** The body double: its text, the end marker the read rule reads, and every input it was handed, per letter. */
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

export interface MountReader {
  readonly letters: readonly EngineMessage[];
  readonly open: string | null;
  readonly meeting?: ListMeeting | null;
  readonly parts?: Partial<ReaderParts>;
  readonly lang?: "en" | "de";
  readonly size?: Parameters<typeof fakeWindow>[0];
  readonly host?: Partial<FakeHostInput>;
  readonly children?: ReactNode;
  /**
   * The presented mirror the shell hands, built over the raw one; null hands none. The default presents the raw
   * mirror as it stands (no hold).
   */
  readonly presented?: ((raw: EntityReader) => EntityReader) | null;
  /** Ids the engine has tombstoned. */
  readonly gone?: readonly string[];
  /** Body records by letter id (a letter without its own `body` reads them). */
  readonly bodies?: Readonly<Record<string, unknown>>;
  /** Other rows of the mirror, keyed `<type>:<id>`. */
  readonly rows?: Readonly<Record<string, unknown>>;
  /** The catalogue the shell hands, in place of the reader's and the room's whole. */
  readonly words?: Messages;
}

export function mountReader(o: MountReader) {
  const mail = fakeMail(o.letters, o.gone, o.bodies, o.rows);
  const double = bodyDouble();
  const parts: ReaderParts = {
    body: double.body,
    files: "none",
    pictures: "none",
    look: "none",
    sentCopy: "none",
    ...o.parts,
  };
  const address = fakeAddress(o.open === null ? "#/ohbox" : `#/ohbox/m/${o.open}`);
  const made = fakeHost({
    engine: mail.engine,
    service: "self",
    scope: "acct-1",
    places: { ohbox: READER_PLACE },
    reader: readerEntry(parts),
    window: fakeWindow(o.size ?? "desktop"),
    address,
    ...o.host,
  });
  const lang = o.lang ?? "en";
  const presented = o.presented === undefined ? (raw: EntityReader) => raw : o.presented;
  const frame = (
    <PresentedMirrorContext.Provider value={presented === null ? null : presented(mail.engine.read())}>
      <Frame host={made.host} />
    </PresentedMirrorContext.Provider>
  );
  /* The key map's registry stands above the frame, as a shell's does: the column declares its keys into it. */
  const view = render(
    <TextProvider locale={lang} messages={o.words ?? WORDS[lang]} timeZone="Europe/Zurich">
      <KeymapProvider>
        {o.meeting === undefined ? (
          frame
        ) : (
          <ListMeetingContext.Provider value={o.meeting}>{frame}</ListMeetingContext.Provider>
        )}
        {o.children}
      </KeymapProvider>
    </TextProvider>,
  );
  return { ...made, mail, view, handed: double.handed, parts };
}

export type { LayoutPlan, PictureSeam, ReaderFiles };
