/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Profiler, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PictureSeam } from "@ohmail/app-logic/reader";
import { PresentedMirrorContext, presentedOver, usePresentedMirror } from "@ohmail/app-logic/reading";
import type { ConsentPartition } from "@ohmail/client-engine";
import type { PlaceEntry } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { useRoomHolds, type RoomHolds } from "../../src/frame/room.js";
import { readerEntry, type LetterProps, type ReaderParts } from "../../src/reader/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";
import { fakeMail, letter, READER_PLACE, WORDS } from "./support/mail.js";

/**
 * A LETTER INSIDE ITS OWN DELETE WINDOW draws as absent: the opened id is in the room's held set, so the column draws
 * the sheet with nothing on it, no panel, and nothing of the thread, until Undo gives it back. The presented mirror is
 * composed as the frame's slot is to compose it: over the room's own holds, anew on every change of them.
 */

const WAITING = "ohmail/Screener";
const THREAD = [
  letter("a-let-in", { threadId: "t1", date: "2026-11-10T09:00:00.000Z" }),
  letter("b-waiting", {
    threadId: "t1",
    date: "2026-11-11T09:00:00.000Z",
    from: { name: "Stranger", address: "x@stranger.example" },
  }),
];

/** The shell's consent partition: Ben's letter is let in, the stranger's reply waits at the gate. */
const partition = {
  placeOf: new Map([["b-waiting", WAITING]]),
  history: [],
  activity: new Map(),
  retiredDecided: new Set(),
  sentInHistory: new Set(),
  counts: { consentedSenders: 1, activeUndecidedSenders: 1, dormantUndecidedSenders: 0, historyMessages: 0 },
} as unknown as ConsentPartition;

const seam = (): PictureSeam => ({
  proxyFor: (id) => (url) => `/img?mid=${id}&u=${encodeURIComponent(url)}`,
  consented: () => false,
  consent: () => {},
  auto: true,
  loadPixels: false,
  resolvedFor: () => new Map(),
  needRemote: () => {},
});

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

function mount() {
  /* Every letter the body is handed, in order. */
  const drawn: string[] = [];
  function Body(props: LetterProps) {
    drawn.push(props.messageId);
    return <p>{props.text}</p>;
  }
  const parts: ReaderParts = {
    body: Body,
    files: "none",
    pictures: seam(),
    look: "none",
    sentCopy: "none",
    reply: "none",
    invitation: "none",
  };
  const mail = fakeMail(THREAD);
  let holds: RoomHolds = { held: new Set(), places: new Map() };
  const listeners = new Set<() => void>();
  /* The list reads the room's holds, as the Ohbox's does, and hands them to the slot. */
  function List() {
    const h = useRoomHolds();
    useEffect(() => {
      holds = h;
      for (const l of [...listeners]) l();
    }, [h]);
    return <p>the list</p>;
  }
  function Slot({ children }: { children: ReactNode }) {
    const h = useSyncExternalStore(
      (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      () => holds,
    );
    const raw = mail.engine.read();
    const presented = useMemo(() => presentedOver(raw, partition, h.held, h.places), [raw, h]);
    return <PresentedMirrorContext.Provider value={presented}>{children}</PresentedMirrorContext.Provider>;
  }
  const place: PlaceEntry = { ...READER_PLACE, panes: { kind: "columns", List, Reading: "reader" } };
  const address = fakeAddress("#/ohbox/m/a-let-in");
  const made = fakeHost({
    engine: mail.engine,
    service: "self",
    scope: "acct-1",
    places: { ohbox: place },
    reader: readerEntry(parts),
    window: fakeWindow("desktop"),
    address,
  });
  render(
    <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
      <Slot>
        <Frame host={made.host} />
      </Slot>
    </TextProvider>,
  );
  return { drawn, address };
}

const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

describe("an opened letter inside the room's delete window", () => {
  it("draws as absent: a walk back to it draws nothing of its thread, and Undo gives it back", async () => {
    const { drawn, address } = mount();
    const panel = () => screen.queryByRole("toolbar", { name: "Actions" });
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.every((id) => id === "a-let-in")).toBe(true);
    await act(async () => {
      fireEvent.click(within(panel()!).getByRole("button", { name: "More" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    });
    await waitFor(() => expect(address.read()).toBe("#/ohbox"));
    drawn.length = 0;
    /* The browser's Back, to the letter while it is inside its delete window. */
    await act(async () => {
      address.visit("#/ohbox/m/a-let-in");
    });
    await settle();
    expect(drawn, "no letter of the thread is drawn inside the window").toEqual([]);
    expect(panel()).toBeNull();
    expect(screen.getByRole("region", { name: "Open message" })).toBeTruthy();
    expect(screen.queryByText(/moved or deleted elsewhere/i)).toBeNull();
    await act(async () => {
      address.visit("#/ohbox");
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    });
    await act(async () => {
      address.visit("#/ohbox/m/a-let-in");
    });
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(drawn).toContain("a-let-in");
    expect(drawn).not.toContain("b-waiting");
  });
});

/**
 * THE SAME RENDER. A list drawn off the presented mirror, which is composed over the room's holds where they are
 * read: above the place's two columns. Every commit under the frame is looked at as it stood on the page: in none of
 * them is a letter's row on screen together with the report of its delete.
 */
describe("the presented mirror and the report of a delete", () => {
  it("at no committed render holds a letter whose delete the report already says", async () => {
    const mail = fakeMail(THREAD);
    const parts: ReaderParts = {
      body: (props) => <p>{props.text}</p>,
      files: "none",
      pictures: seam(),
      look: "none",
      sentCopy: "none",
      reply: "none",
      invitation: "none",
    };
    function Composed({ children }: { children: ReactNode }) {
      const holds = useRoomHolds();
      const raw = mail.engine.read();
      const presented = useMemo(() => presentedOver(raw, partition, holds.held, holds.places), [raw, holds]);
      return <PresentedMirrorContext.Provider value={presented}>{children}</PresentedMirrorContext.Provider>;
    }
    function Rows() {
      const presented = usePresentedMirror();
      const held = THREAD.filter((m) => presented?.get("message", m.id) !== undefined);
      return (
        <ul>
          {held.map((m) => (
            <li key={m.id}>{`row ${m.id}`}</li>
          ))}
        </ul>
      );
    }
    const place: PlaceEntry = {
      ...READER_PLACE,
      panes: { kind: "columns", List: Rows, Reading: "reader", Above: Composed },
    };
    const made = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: { ohbox: place },
      reader: readerEntry(parts),
      window: fakeWindow("desktop"),
      address: fakeAddress("#/ohbox/m/a-let-in"),
    });
    const row = () => screen.queryByText("row a-let-in") !== null;
    const said = () => screen.queryByRole("button", { name: /Undo/ }) !== null;
    const commits: { row: boolean; said: boolean }[] = [];
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Profiler id="frame" onRender={() => void commits.push({ row: row(), said: said() })}>
          <Frame host={made.host} />
        </Profiler>
      </TextProvider>,
    );
    const panel = () => screen.queryByRole("toolbar", { name: "Actions" });
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(row()).toBe(true);
    await act(async () => {
      fireEvent.click(within(panel()!).getByRole("button", { name: "More" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    });
    await waitFor(() => expect(row()).toBe(false));
    expect(said()).toBe(true);
    expect(
      commits.some((c) => c.said),
      "no commit was seen with the report on the page",
    ).toBe(true);
    expect(
      commits.filter((c) => c.row && c.said),
      "a commit drew the letter's row under the report of its delete",
    ).toEqual([]);
  });
});
