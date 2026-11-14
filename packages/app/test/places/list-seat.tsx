/**
 * THE TESTS' DOOR OF A LIST PLACE'S SEAT: the real registrations of `mailPlaces()` and the real reader through the
 * real `Frame`, over the fake host that hands the mail ground above the panes. No shell is mounted and no context is
 * provided by hand: what a list draws, the ground read; what a press writes, the frame's one seam sent.
 *
 * The fake engine answers what the four list places read beside what the reader's fake answers: the store's pages
 * and address archive (unavailable unless a case provides them), and the device's address index over its letters.
 */
import type { ReactNode } from "react";
import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import type { AddressDirection, OhmailEngine } from "@ohmail/client-engine";
import { fixtureSearchIndex } from "../../../../test/support/engine-fixtures.js";
import type { EngineMessage } from "@ohmail/wire";
import { useEntered, useFrame } from "../../src/frame/commands.js";
import type { PlaceEntry, RouteTarget } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { NONE, type ConsentWire } from "../../src/host/index.js";
import { MailGround, mailPlaces, mailReader } from "../../src/mail/index.js";
import { READER_DOM, scrollerOf } from "../../src/reader/read-dom.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import addressEn from "../../messages/address.en.json" with { type: "json" };
import folderEn from "../../messages/folder.en.json" with { type: "json" };
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import historyEn from "../../messages/history.en.json" with { type: "json" };
import pilesEn from "../../messages/piles.en.json" with { type: "json" };
import tagsEn from "../../messages/tags.en.json" with { type: "json" };
import writeEn from "../../messages/write.en.json" with { type: "json" };
import { bodyDouble, fakeMail, WORDS, type FakeMail } from "../reader/support/mail.js";
import { fakeHost, type FakeHostInput } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../support/fake-window.js";

export const LIST_WORDS = {
  ...WORDS.en,
  ...historyEn,
  ...tagsEn,
  ...folderEn,
  ...addressEn,
  ...pilesEn,
  ...writeEn,
  /* The sentence a cursor placed by a first verb key is said with: the frame's file holds it. */
  cursor: frameEn.cursor,
  rail: frameEn.rail,
} as Messages;

/** The reading column as a host hands it over the mail ground: made once, as a host makes it. */
const READER = mailReader({ body: bodyDouble().body, look: NONE });

/** A consent wire whose row says the account uses folders. */
export const FOLDERS_ON = {
  state: async () => ({
    seedConfirmedAt: "2026-01-01T00:00:00.000Z",
    dormancyDays: 30,
    blockRemoteImagesAt: null,
    loadTrackingPixelsAt: null,
    foldersEnabledAt: "2026-01-01T00:00:00.000Z",
  }),
} as unknown as ConsentWire;

export interface ListSeat {
  readonly mail: FakeMail;
  readonly address: FakeAddress;
}

interface ListSeatOptions {
  scope?: string;
  readonly letters: readonly EngineMessage[];
  /** Any other rows, keyed `<type>:<id>` (a tag, a folder, a rule). */
  readonly more?: Readonly<Record<string, unknown>>;
  readonly first: string;
  readonly room?: "desktop" | "phone";
  readonly consent?: ConsentWire;
  /** The account's mailbox facts as the host reads them; absent, the mail state never learns them. */
  readonly mailboxes?: FakeHostInput["mailboxes"];
  /** What the engine answers beside the fake's own (the store's pages, where a case reads them). */
  readonly engine?: (mail: FakeMail) => Partial<Record<string, unknown>>;
  /** Places handed beside the seated ones, or in a seated one's stead (a place a hit is chosen at). */
  readonly also?: (seated: ReturnType<typeof mailPlaces>) => Readonly<Record<string, PlaceEntry>>;
}

export function listFrame(o: ListSeatOptions) {
  const mail = fakeMail(o.letters, [], {}, o.more ?? {});
  const engine = {
    ...mail.engine,
    storePagesAvailable: () => false,
    serverAddressSearchAvailable: () => false,
    drainsCompleted: () => 0,
    messagesWith: (address: string, direction?: AddressDirection) =>
      fixtureSearchIndex(mail.engine.read()).messagesWith(address, direction),
    storePageRow: (item: EngineMessage) =>
      mail.engine.messageIsGone(item.id)
        ? null
        : (mail.engine.read().get<EngineMessage>("message", item.id) ?? item),
    ...o.engine?.(mail),
  } as unknown as OhmailEngine;
  const address = fakeAddress(o.first);
  const { host } = fakeHost({
    engine,
    service: "self",
    scope: o.scope ?? "acct-1",
    places: { ...mailPlaces(), ...o.also?.(mailPlaces()) },
    above: MailGround,
    reader: READER,
    window: fakeWindow(o.room ?? "desktop"),
    address,
    ...(o.consent ? { wires: { consent: o.consent } } : {}),
    ...(o.mailboxes ? { mailboxes: o.mailboxes } : {}),
  });
  return { host, mail, address };
}

export function listSeat(o: ListSeatOptions): ListSeat {
  const { host, mail, address } = listFrame(o);
  render(
    <TextProvider locale="en" messages={LIST_WORDS} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
  return { mail, address };
}

/** What the seam sent, by kind and what it names, in order; a read by how it was made (a glance: the rule's). */
export const sent = (mail: FakeMail): string[] =>
  mail.mutations.map((m) => {
    const r = m as Record<string, unknown>;
    const ids =
      (r.messageId as string | undefined) ?? (r.messageIds as string[] | undefined)?.join(",") ?? "";
    const what = r.tagId ?? r.state ?? r.folder ?? "";
    const name = r.name ?? "";
    const read = r.kind === "mark_seen" ? [r.unread === true ? "unread" : "read", r.via ?? ""] : [];
    return [r.kind, ids, what, name, ...read].filter(Boolean).join(" ");
  });

/** A place a hit is chosen at: its button opens a letter INTO another place as entered, as Search's hit does. */
export function hitAt(to: RouteTarget): PlaceEntry {
  function Hit() {
    const { commands } = useFrame();
    return (
      <button type="button" onClick={() => commands.go(to, { entered: true })}>
        Open the hit
      </button>
    );
  }
  return { id: "search", body: "search", rail: null, panes: { kind: "wide", Wide: Hit } };
}

/**
 * A seated place with the frame's one-shot said beside it: the letter that was opened into the place as entered,
 * for as long as the place has not taken it.
 */
export function withTheHitSaid(place: PlaceEntry | undefined): PlaceEntry {
  if (place === undefined) throw new Error("the place is not seated");
  const { panes } = place;
  if (panes.kind !== "columns" || panes.Above === undefined) throw new Error("the place has no seat");
  const Seat = panes.Above;
  function Said({ children }: { children: ReactNode }) {
    const { letter } = useEntered();
    return (
      <>
        <p>{`the hit: ${letter ?? "none"}`}</p>
        <Seat>{children}</Seat>
      </>
    );
  }
  return { ...place, panes: { ...panes, Above: Said } };
}

/* jsdom lays nothing out: the open letter stands in the reading column as a browser would lay it, whole on screen. */
const box = (top: number, bottom: number) => ({
  top,
  bottom,
  left: 0,
  right: 600,
  width: 600,
  height: bottom - top,
  x: 0,
  y: top,
  toJSON: () => ({}),
});
const boxed = (el: Element | null, top: number, bottom: number): void => {
  if (!el) throw new Error("no element to lay out");
  (el as HTMLElement).getBoundingClientRect = () => box(top, bottom) as DOMRect;
};

/** The letter open in the reader's column, as a browser lays it out: its sender line, its first lines and its end. */
export function layOutLetter(id: string): void {
  const scroller = scrollerOf(document.querySelector(READER_DOM.stopsRoot!))!;
  boxed(scroller, 0, 800);
  Object.defineProperty(scroller, "clientHeight", { value: 800, configurable: true });
  boxed(document.querySelector(READER_DOM.stops), 700, 760);
  const panel = [...document.querySelectorAll<HTMLElement>("[data-conv-id]")].find(
    (el) => el.dataset.convId === id,
  );
  if (!panel) throw new Error(`the letter ${id} is not open`);
  boxed(panel, 10, 400);
  boxed(panel.querySelector(READER_DOM.from), 10, 50);
  boxed(panel.querySelector(READER_DOM.body), 60, 400);
  boxed(panel.querySelector("[data-own-end]"), 380, 380);
  act(() => void window.dispatchEvent(new Event("resize")));
}

/** The read rule's clock in the test's hand, on a page that has the person's eye. Undone by `vi.useRealTimers()`. */
export function readerTime(): void {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame", "cancelAnimationFrame"],
  });
  vi.setSystemTime(new Date(Date.UTC(2026, 10, 20, 12)));
  document.hasFocus = () => true;
}

/** The rule's dwell on a letter that stands on screen, and the write it makes. */
export async function dwell(ms = 900): Promise<void> {
  act(() => void vi.advanceTimersByTime(ms));
  await act(async () => undefined);
}
