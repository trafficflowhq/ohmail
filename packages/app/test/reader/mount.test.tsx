/** @vitest-environment jsdom */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellDispatchInput } from "@ohmail/app-logic/press/shell-dispatch";
import { Frame } from "../../src/frame/Frame.js";
import { usePress, useRoomHolds } from "../../src/frame/room.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { NONE, type ReaderEntry } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";
import { ListMeetingContext, type ListMeeting } from "@ohmail/app-logic/reading";
import { readerEntry } from "../../src/reader/index.js";
import { bodyDouble, fakeMail, letter, mountReader, READER_PLACE, WORDS } from "./support/mail.js";

/**
 * THE READER IS MOUNTED BY THE FRAME ALONE, where a place names it, with the frame's one press seam. The seam is the
 * real `useShellDispatch`, counted live: once per frame on a reader's place, never on a place that draws its own.
 */

const live = vi.hoisted(() => ({ seams: 0 }));
vi.mock("@ohmail/app-logic/press/shell-dispatch", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/press/shell-dispatch")>();
  const { useEffect: effect } = await import("react");
  return {
    ...real,
    useShellDispatch: (input: ShellDispatchInput) => {
      const seam = real.useShellDispatch(input);
      effect(() => {
        live.seams += 1;
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

describe("the reader in the frame", () => {
  it("a place that names the reader draws it in the reading column, and the letter opens there", () => {
    mountReader({ letters: [letter("m1")], open: "m1" });
    const column = screen.getByRole("region", { name: "Reading" });
    const pane = within(column).getByRole("region", { name: "Open message" });
    expect(within(pane).getByRole("article")).toBeTruthy();
    expect(within(pane).getByText("The text of m1.")).toBeTruthy();
    expect(live.seams).toBe(1);
  });

  it("with no reader handed, the column stays empty, no seam runs and nothing throws", () => {
    const mail = fakeMail([letter("m1")]);
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: { ohbox: READER_PLACE },
      address: fakeAddress("#/ohbox/m/m1"),
    });
    expect(host.features.reader).toBe(NONE);
    render(
      <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>,
    );
    expect(within(screen.getByRole("region", { name: "Reading" })).queryByRole("region")).toBeNull();
    expect(screen.queryByRole("article")).toBeNull();
    /* No reader, no room: the place's name alone never turns the seam on (it would read the engine for nobody). */
    expect(live.seams).toBe(0);
  });

  it("one seam per frame on a reader's place, none on a place that draws its own, and back", () => {
    const mail = fakeMail([letter("m1")]);
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
    expect(live.seams).toBe(1);
    act(() => address.visit("#/reads"));
    expect(screen.getByText("today at news, no seam")).toBeTruthy();
    expect(live.seams).toBe(0);
    act(() => address.visit("#/ohbox"));
    expect(live.seams).toBe(1);
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
    const STREAM: PlaceEntry = {
      id: "news",
      body: "news",
      rail: null,
      panes: { kind: "wide", Wide: Stream },
    };
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: { news: STREAM },
      reader: entry,
      address: fakeAddress("#/reads"),
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
