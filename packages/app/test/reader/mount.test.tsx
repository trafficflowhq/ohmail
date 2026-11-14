/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armDeleteIntent, takeDeleteIntents } from "@ohmail/app-logic/press/delete-intents";
import type { ShellDispatch, ShellDispatchInput } from "@ohmail/app-logic/press/shell-dispatch";
import { Frame } from "../../src/frame/Frame.js";
import {
  useMailboxWord,
  useOwnAddresses,
  usePress,
  useResurfaceTime,
  useRoomHandOver,
  useRoomHolds,
} from "../../src/frame/room.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { NONE, type ReaderEntry } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";
import { ListMeetingContext, type ListMeeting } from "@ohmail/app-logic/reading";
import { readerEntry, readerEntryFrom, readingScrollerIn, type ReaderParts } from "../../src/reader/index.js";
import {
  bodyDouble,
  fakeMail,
  letter,
  mountReader,
  READER_PLACE,
  WORDS,
  type FakeMail,
} from "./support/mail.js";

/**
 * THE READER IS MOUNTED BY THE FRAME ALONE, where a place names it, with the frame's one press seam. The seam is the
 * real `useShellDispatch`, counted live and by its mounts: one per frame, for the frame's life, whatever place is on
 * screen, on a host that hands a reader; none on a host that hands neither a reader nor anything above the panes.
 */

const live = vi.hoisted(() => ({ seams: 0, mounts: 0 }));
vi.mock("@ohmail/app-logic/press/shell-dispatch", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/press/shell-dispatch")>();
  const { useEffect: effect } = await import("react");
  return {
    ...real,
    useShellDispatch: (input: ShellDispatchInput) => {
      const seam = real.useShellDispatch(input);
      effect(() => {
        live.seams += 1;
        live.mounts += 1;
        return () => {
          live.seams -= 1;
        };
      }, []);
      return seam;
    },
  };
});

beforeEach(() => {
  live.seams = 0;
  live.mounts = 0;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

function Wide({ route }: PaneProps) {
  let pressed = "a seam";
  try {
    usePress();
  } catch {
    pressed = "no seam";
  }
  return <p>{`today at ${route.place}, ${pressed}`}</p>;
}
const TODAY: PlaceEntry = { id: "news", body: "today", rail: null, panes: { kind: "wide", Wide } };

/** A delete a closed tab left in the journal of `acct-1`, and every delete the engine is then asked to replay. */
function leftInTheJournal(mail: FakeMail): string[] {
  const replayed: string[] = [];
  const replay = mail.engine.replayDelete.bind(mail.engine);
  mail.engine.replayDelete = (messageId, opts) => {
    replayed.push(messageId);
    return replay(messageId, opts);
  };
  armDeleteIntent({ id: "the-press-of-a-closed-tab", messageIds: ["m1"], at: Date.now() }, "acct-1");
  return replayed;
}
const settled = () => act(async () => new Promise((r) => setTimeout(r, 50)));

describe("the reader in the frame", () => {
  it("a place that names the reader draws it in the reading column, and the letter opens there", () => {
    mountReader({ letters: [letter("m1")], open: "m1" });
    const column = screen.getByRole("region", { name: "Reading" });
    const pane = within(column).getByRole("region", { name: "Open message" });
    expect(within(pane).getByRole("article")).toBeTruthy();
    expect(within(pane).getByText("The text of m1.")).toBeTruthy();
    expect(live.seams).toBe(1);
  });

  it("the door names the reading column's scrolling box to a list that walks it: the one the letters scroll in", () => {
    mountReader({ letters: [letter("m1")], open: "m1" });
    const column = screen.getByRole("region", { name: "Reading" });
    const scroller = readingScrollerIn(column);
    const text = within(screen.getByRole("region", { name: "Open message" })).getByText("The text of m1.");
    expect(scroller?.contains(text), "the letter's text stands in the box the door names").toBe(true);
    expect(readingScrollerIn(null)).toBeNull();
  });

  it("an entry over parts read in each render draws them as they stand, and the column is not drawn again", () => {
    const first = ({ messageId }: { readonly messageId: string }) => <p>{`first word on ${messageId}`}</p>;
    const second = ({ messageId }: { readonly messageId: string }) => <p>{`second word on ${messageId}`}</p>;
    let invitation = first;
    const listeners = new Set<() => void>();
    const subscribe = (changed: () => void) => {
      listeners.add(changed);
      return () => void listeners.delete(changed);
    };
    const fixed = {
      body: bodyDouble().body,
      files: "none",
      pictures: "none",
      look: "none",
      sentCopy: "none",
      reply: "none",
    } as const;
    /* A shell's door changes identity while it fetches: the entry reads it again in every render. */
    function useHere(): ReaderParts {
      const now = useSyncExternalStore(subscribe, () => invitation);
      return useMemo(() => ({ ...fixed, invitation: now }), [now]);
    }
    mountReader({ letters: [letter("m1")], open: "m1", host: { reader: readerEntryFrom(useHere) } });
    const pane = screen.getByRole("region", { name: "Open message" });
    expect(within(pane).getByText("first word on m1")).toBeTruthy();
    act(() => {
      invitation = second;
      for (const changed of listeners) changed();
    });
    expect(within(pane).getByText("second word on m1")).toBeTruthy();
    expect(screen.queryByText("first word on m1")).toBeNull();
    const again = screen.getByRole("region", { name: "Open message" });
    expect(again, "the same column, not one drawn again").toBe(pane);
  });

  it("with no reader handed, the column stays empty, no seam runs and nothing throws", async () => {
    const mail = fakeMail([letter("m1")]);
    const replayed = leftInTheJournal(mail);
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: { ohbox: READER_PLACE },
      address: fakeAddress("#/ohbox/m/m1"),
    });
    expect({ reader: host.features.reader, above: host.features.above }).toEqual({
      reader: NONE,
      above: NONE,
    });
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>,
    );
    expect(within(screen.getByRole("region", { name: "Reading" })).queryByRole("region")).toBeNull();
    expect(screen.queryByRole("article")).toBeNull();
    /* No reader and nothing above: nothing on this host can press, and the place's name alone never mounts the seam
       (it would read the engine for nobody). What a closed tab left in the journal waits there for a frame with one. */
    expect(live).toEqual({ seams: 0, mounts: 0 });
    await settled();
    expect(replayed, "a journal was replayed where no seam stands").toEqual([]);
    expect(
      takeDeleteIntents(Date.now(), "acct-1").map((pressed) => pressed.messageIds),
      "the press a closed tab left is no longer in the journal",
    ).toEqual([["m1"]]);
  });

  it("one seam per frame: on a reader's place, on a place of another body and back, the one mount", async () => {
    const mail = fakeMail([letter("m1")]);
    const replayed = leftInTheJournal(mail);
    const mounted: string[] = [];
    function Stub(pane: PaneProps) {
      usePress();
      useEffect(() => {
        mounted.push(pane.route.open ?? "blank");
      }, [pane.route.open]);
      return <p>the stub reader</p>;
    }
    const stub: ReaderEntry = { Reading: Stub, Actions: () => null };
    const address = fakeAddress("#/ohbox");
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: { ohbox: READER_PLACE, news: TODAY },
      reader: stub,
      address,
    });
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>,
    );
    expect(screen.getByText("the stub reader")).toBeTruthy();
    expect(live, "on the reader's place").toEqual({ seams: 1, mounts: 1 });
    act(() => address.visit("#/reads"));
    /* A place of another body mounts no seam and needs none of its own: its press is the room's. */
    expect(screen.getByText("today at news, a seam")).toBeTruthy();
    expect(live, "on a place of another body").toEqual({ seams: 1, mounts: 1 });
    act(() => address.visit("#/ohbox"));
    expect(live, "back on the reader's place").toEqual({ seams: 1, mounts: 1 });
    await waitFor(() => expect(replayed, "the journal was not replayed at the mount").toEqual(["m1"]));
    await settled();
    expect(replayed, "the journal was replayed again on the walk").toEqual(["m1"]);
  });

  it("the room's held deletes are state: a delete inside its window is held, and nothing is off the room", () => {
    const mail = fakeMail([letter("m1")]);
    function Stub() {
      const press = usePress();
      const { held } = useRoomHolds();
      return (
        <button type="button" onClick={() => press.deleting.remove({ id: "m1", mailboxId: "mb-1" })}>
          {`held ${[...held].join(",") || "none"}`}
        </button>
      );
    }
    function Off() {
      return <p>{`off ${useRoomHolds().held.size}`}</p>;
    }
    const address = fakeAddress("#/ohbox/m/m1");
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: { ohbox: READER_PLACE },
      reader: { Reading: Stub, Actions: () => null },
      address,
    });
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Frame host={host} />
        <Off />
      </TextProvider>,
    );
    act(() => screen.getByRole("button", { name: "held none" }).click());
    expect(screen.getByRole("button", { name: "held m1" })).toBeTruthy();
    expect(screen.getByText("off 0")).toBeTruthy();
  });

  it("the room reads the account's mailbox facts: a delete waits for them, and a filing press reads them again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const mail = fakeMail([letter("m1")]);
      let reads = 0;
      let answer: (rows: unknown[]) => void = () => undefined;
      const mailboxes = () =>
        new Promise<unknown[]>((done) => {
          reads += 1;
          answer = done;
        });
      function Stub() {
        const press = usePress();
        const { held } = useRoomHolds();
        return (
          <button type="button" onClick={() => press.deleting.remove({ id: "m1", mailboxId: "mb-1" })}>
            {`held ${held.size}`}
          </button>
        );
      }
      const { host } = fakeHost({
        engine: mail.engine,
        service: "self",
        scope: "acct-1",
        places: { ohbox: READER_PLACE },
        reader: { Reading: Stub, Actions: () => null },
        address: fakeAddress("#/ohbox/m/m1"),
        mailboxes,
      });
      render(
        <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
          <Frame host={host} />
        </TextProvider>,
      );
      expect(reads).toBe(1);
      // Not answered yet: who organizes mb-1 is unknown, and a delete is refused at the press.
      act(() => screen.getByRole("button", { name: "held 0" }).click());
      expect(screen.getByRole("button", { name: "held 0" })).toBeTruthy();
      await act(async () => {
        answer([{ id: "mb-1", status: "active", organizerRole: "organizer" }]);
      });
      act(() => screen.getByRole("button", { name: "held 0" }).click());
      expect(screen.getByRole("button", { name: "held 1" })).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(9000);
      });
      expect(mail.mutations).toContainEqual({ kind: "message_delete", messageId: "m1" });
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the panel drawn in place on a place whose room is off: a list's visit runs it, and with none nothing is drawn", () => {
    const mail = fakeMail([letter("m1"), letter("m2")]);
    const entry = readerEntry({
      body: bodyDouble().body,
      files: "none",
      pictures: "none",
      look: "none",
      sentCopy: "none",
      reply: "none",
      invitation: "none",
    });
    const acted: string[] = [];
    const meeting: ListMeeting = {
      blank: null,
      visit: {
        openId: "m1",
        unread: true,
        readSet: ["m1"],
        act: (a) => acted.push(a),
        wiring: {
          look: "tint",
          record: undefined as never,
          onRead: () => undefined,
          onEnter: () => undefined,
          onMarkUnread: () => undefined,
        },
        step: {
          up: { disabled: true, run: () => undefined, label: "up" },
          down: { disabled: true, run: () => undefined, label: "down" },
        },
      },
    };
    function Stream() {
      return (
        <ListMeetingContext.Provider value={meeting}>
          <section aria-label="first">
            <entry.Actions messageId="m1" />
          </section>
          <section aria-label="second">
            <entry.Actions messageId="m2" />
          </section>
        </ListMeetingContext.Provider>
      );
    }
    /* A room is off in one place alone: over the body the old shell keeps, under the seam that shell hands. */
    const STREAM: PlaceEntry = {
      id: "news",
      body: "news",
      rail: null,
      panes: { kind: "wide", Wide: Stream, kept: true },
    };
    const shell = Object.assign(({ children }: { children: ReactNode }) => <>{children}</>, {
      handsSeam: true as const,
    });
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: { news: STREAM },
      reader: entry,
      address: fakeAddress("#/reads"),
      above: shell,
    });
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>,
    );
    expect(live.seams).toBe(0);
    within(screen.getByRole("region", { name: "first" }))
      .getByRole("button", { name: "Later" })
      .click();
    expect(acted).toEqual(["later"]);
    expect(within(screen.getByRole("region", { name: "second" })).queryByRole("button")).toBeNull();
  });

  it("the room stands over the bare fake host: words it does not hold are nobody's fault", () => {
    expect(() => mountReader({ letters: [letter("m1")], open: null })).not.toThrow();
    expect(live.seams).toBe(1);
  });
});

/**
 * A SHELL THAT STANDS ABOVE THE PANES HANDS THE ROOM ITS OWN SEAM. The room then mounts none: on a reader's place the
 * reader presses through the shell's seam, and the room's stores hold what the shell handed.
 */
describe("the room under a shell that hands its own seam", () => {
  /** The shell's seam, as far as these cases read it: what it holds back, and what a press and `z` reach. */
  function seamOf() {
    const remove = vi.fn();
    const runArmedUndo = vi.fn(() => true);
    const seam = {
      deleting: { held: new Set(["m-held"]), remove },
      routing: { places: new Map([["m-moved", "Archive"]]) },
      runArmedUndo,
    } as unknown as ShellDispatch;
    return { seam, remove, runArmedUndo };
  }
  const ROWS = [
    { id: "mb-1", address: "lena@example.invalid", status: "active" },
    { id: "mb-2", address: "office@example.invalid", status: "active" },
  ];
  const store = vi.fn(async () => undefined);
  function Reader() {
    const press = usePress();
    const { held, places } = useRoomHolds();
    const own = useOwnAddresses();
    const word = useMailboxWord();
    const hour = useResurfaceTime();
    return (
      <div>
        <button type="button" onClick={() => press.deleting.remove({ id: "m1", mailboxId: "mb-1" })}>
          Delete
        </button>
        <button type="button" onClick={() => void hour.store?.("08:15")}>
          Keep the hour
        </button>
        <p>{`held ${[...held].join()}; moved ${[...places.keys()].join()}`}</p>
        <p>{`own ${own.join()}; in ${word("mb-1", "short") ?? "one mailbox"}; back at ${hour.stored ?? "its own hour"}`}</p>
      </div>
    );
  }
  function under(above: (props: { children: ReactNode }) => ReactNode, reading = Reader) {
    const mail = fakeMail([letter("m1")]);
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: { ohbox: READER_PLACE },
      reader: { Reading: reading, Actions: () => null },
      address: fakeAddress("#/ohbox/m/m1"),
      above: Object.assign(above, { handsSeam: true as const }),
    });
    return render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>,
    );
  }

  it("mounts no seam of its own: the reader presses through the handed one, and the stores hold what was handed", () => {
    const { seam, remove } = seamOf();
    function Shell({ children }: { children: ReactNode }) {
      useRoomHandOver({ seam, rows: ROWS as never, resurface: { stored: "07:30", store } });
      return <>{children}</>;
    }
    under(Shell);
    expect(live.seams, "the room called the press seam's hook itself").toBe(0);
    expect(screen.getByText("held m-held; moved m-moved")).toBeTruthy();
    expect(
      screen.getByText("own lena@example.invalid,office@example.invalid; in lena; back at 07:30"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(remove.mock.calls).toEqual([[{ id: "m1", mailboxId: "mb-1" }]]);
    fireEvent.click(screen.getByRole("button", { name: "Keep the hour" }));
    expect(store.mock.calls).toEqual([["08:15"]]);
  });

  it("binds no key: z is the shell's, and the handed seam's Undo is not run by the room", () => {
    const { seam, runArmedUndo } = seamOf();
    function Shell({ children }: { children: ReactNode }) {
      useRoomHandOver({ seam, rows: null, resurface: { stored: null, store: null } });
      return <>{children}</>;
    }
    under(Shell);
    fireEvent.keyDown(window, { key: "z" });
    fireEvent.keyDown(document.body, { key: "z" });
    expect(runArmedUndo).not.toHaveBeenCalled();
    expect(screen.getByText("own ; in one mailbox; back at its own hour")).toBeTruthy();
  });

  it("with nothing handed a press throws, and no seam is made in its place", () => {
    const said: string[] = [];
    function Reads() {
      const press = usePress();
      try {
        void press.deleting;
        said.push("a seam");
      } catch (err) {
        said.push((err as Error).message);
      }
      return <p>the reader</p>;
    }
    under(({ children }) => <>{children}</>, Reads);
    expect(screen.getByText("the reader")).toBeTruthy();
    expect(new Set(said)).toEqual(new Set(["usePress: the room's seam is not mounted"]));
    expect(live.seams).toBe(0);
  });

  it("a hand-over into a room that mounts its own seam is refused: two seams would stand", () => {
    const { seam } = seamOf();
    function Hands() {
      useRoomHandOver({ seam, rows: null, resurface: { stored: null, store: null } });
      return <p>handed</p>;
    }
    const mail = fakeMail([letter("m1")]);
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: { ohbox: READER_PLACE },
      reader: { Reading: Hands, Actions: () => null },
      address: fakeAddress("#/ohbox/m/m1"),
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() =>
      render(
        <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
          <Frame host={host} />
        </TextProvider>,
      ),
    ).toThrow("useRoomHandOver: this room mounts its own seam");
    quiet.mockRestore();
  });
});
