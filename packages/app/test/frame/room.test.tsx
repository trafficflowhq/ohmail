/** @vitest-environment jsdom */
/**
 * THE ROOM, WHERE NO READER TURNS IT ON. The mailbox facts have one reader in a frame: a part above the panes that
 * holds them hands them to the room, which then reads the host never. And a host that hands nothing above the panes
 * and no reader has no seam at all: nothing there can press.
 *
 * The press seam's hook is counted where the frame's room calls it.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useCallback, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { takeDeleteIntents } from "@ohmail/app-logic/press/delete-intents";
import type { ShellDispatchInput } from "@ohmail/app-logic/press/shell-dispatch";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import {
  useOwnAddresses,
  usePress,
  useRoomFacts,
  useRoomHolds,
} from "../../src/frame/room.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail, letter, WORDS, type FakeMail } from "../reader/support/mail.js";
import { fakeHost, type FakeHostInput } from "../support/fake-host.js";
import { fakeAddress, type FakeAddress } from "../support/fake-window.js";
import { FRAME_WORDS } from "../support/frame-words.js";

/** The room's own seam: how often it was mounted, and how many stand now. */
const own = vi.hoisted(() => ({ mounts: 0, live: 0 }));
vi.mock("@ohmail/app-logic/press/shell-dispatch", async (load) => {
  const real = await load<typeof import("@ohmail/app-logic/press/shell-dispatch")>();
  const { useEffect: effect } = await import("react");
  return {
    ...real,
    useShellDispatch: (input: ShellDispatchInput) => {
      const made = real.useShellDispatch(input);
      effect(() => {
        own.mounts += 1;
        own.live += 1;
        return () => {
          own.live -= 1;
        };
      }, []);
      return made;
    },
  };
});
const SCOPE = "acct-1";

/** A seated place that names no reader: it presses through the frame's seam, and reads what the room holds. */
function Seated({ route }: PaneProps) {
  const press = usePress();
  const { held } = useRoomHolds();
  const mine = useOwnAddresses();
  return (
    <div>
      <p>{`seated at ${route.place}: held ${[...held].join() || "none"}; own ${mine.join() || "nobody"}`}</p>
      <button type="button" onClick={() => press.deleting.remove({ id: "m1", mailboxId: "mb-1" })}>
        Delete m1
      </button>
    </div>
  );
}
const SEATED: PlaceEntry = {
  id: "search",
  body: "search",
  rail: null,
  panes: { kind: "wide", Wide: Seated },
};

/** A place's body that says what a press through the room answers there. */
function Kept({ route }: PaneProps) {
  let pressed = "the room's seam";
  try {
    usePress();
  } catch (err) {
    pressed = (err as Error).message;
  }
  return <p>{`today at ${route.place}: ${pressed}`}</p>;
}
function framed(input: Partial<FakeHostInput> & Pick<FakeHostInput, "engine">) {
  const { host } = fakeHost({ service: "self", scope: SCOPE, ...input });
  return (
    <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>
  );
}
const visit = (address: FakeAddress, to: string) => act(() => address.visit(to));

beforeEach(() => {
  own.mounts = 0;
  own.live = 0;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** What the part above holds of the mailbox facts, as a test moves it. */
const held = { rows: (_: unknown[] | null): void => undefined, asked: 0 };
/** A part above the panes that holds the mailbox facts and hands them to the room, as the mail ground does. */
function Holds({ children }: { children: ReactNode }) {
  const [rows, setRows] = useState<unknown[] | null>(null);
  held.rows = setRows;
  const refresh = useCallback(() => {
    held.asked += 1;
  }, []);
  useRoomFacts({ rows: rows as never, refresh });
  return <>{children}</>;
}

describe("the mailbox facts have one reader in a frame", () => {
  /** The host's own read of them, counted. */
  function probe() {
    const read = {
      times: 0,
      mailboxes: (): Promise<unknown[]> => {
        read.times += 1;
        return Promise.resolve([]);
      },
    };
    return read;
  }

  beforeEach(() => {
    held.asked = 0;
  });

  it("handed by a part above the panes they are the room's: a delete waits for them, a filing press asks their re-read, and the host is read never", async () => {
    const mail = fakeMail([letter("m1")]);
    const host = probe();
    render(
      framed({
        engine: mail.engine,
        places: { search: SEATED },
        above: Holds,
        address: fakeAddress("#/search"),
        mailboxes: host.mailboxes,
      }),
    );
    /* Not answered yet: who organizes mb-1 is unknown, and a delete is refused at the press. */
    fireEvent.click(screen.getByRole("button", { name: "Delete m1" }));
    expect(screen.getByText("seated at search: held none; own nobody")).toBeTruthy();
    act(() =>
      held.rows([
        { id: "mb-1", address: "lena@example.invalid", status: "active", organizerRole: "organizer" },
      ]),
    );
    expect(screen.getByText("seated at search: held none; own lena@example.invalid")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete m1" }));
    expect(screen.getByText("seated at search: held m1; own lena@example.invalid")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(mail.mutations).toContainEqual({ kind: "message_delete", messageId: "m1" });
    expect(held.asked, "the filing press did not ask the handed re-read once").toBe(1);
    expect(host.times, "the room read the host's mailbox facts itself").toBe(0);
    expect(own).toEqual({ mounts: 1, live: 1 });
  });

  it("with nothing handed the room reads the host itself, once at its mount, also under a part that hands none", async () => {
    const mail = fakeMail([letter("m1")]);
    const host = probe();
    render(
      framed({
        engine: mail.engine,
        places: { search: SEATED },
        above: ({ children }) => <>{children}</>,
        address: fakeAddress("#/search"),
        mailboxes: host.mailboxes,
      }),
    );
    await act(async () => undefined);
    expect(host.times).toBe(1);
  });

});

describe("a host that hands nothing above the panes and no reader", () => {
  /** A place of a body of its own that asks for the press seam and says what it was answered. */
  const plain = (id: PlaceEntry["id"]): PlaceEntry => ({
    id,
    body: id,
    rail: null,
    panes: { kind: "wide", Wide: Kept },
  });
  /** The frame's own two namespaces alone, as the phone's page carries them today: none of the press seam's. */
  const OWN_WORDS = { frame: FRAME_WORDS.en.frame, mailboxes: FRAME_WORDS.en.mailboxes };
  const bare = (input: Partial<FakeHostInput> & Pick<FakeHostInput, "engine">) => (
    <TextProvider locale="en" messages={OWN_WORDS} timeZone="Europe/Zurich">
      <Frame host={fakeHost({ service: "self", scope: SCOPE, ...input }).host} />
    </TextProvider>
  );

  it("mounts no seam at any place, a press there throws at the hook, and the text reader is asked no sentence of a seam", () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const address = fakeAddress("#/ohbox");
    render(
      bare({
        engine: fakeMail([letter("m1")]).engine,
        places: { ohbox: plain("ohbox"), search: plain("search") },
        address,
      }),
    );
    const answered = [screen.getByText(/^today at ohbox: /).textContent];
    visit(address, "#/search");
    answered.push(screen.getByText(/^today at search: /).textContent);
    const missing = said.mock.calls.map(([line]) => String(line)).filter((line) => line.startsWith("text: "));
    said.mockRestore();
    expect({ ...own, missing, answered }).toEqual({
      mounts: 0,
      live: 0,
      missing: [],
      answered: [
        "today at ohbox: usePress: no room is on here",
        "today at search: usePress: no room is on here",
      ],
    });
  });

  it("reads nothing of the host's engine", () => {
    const unread = new Proxy({} as FakeHostInput["engine"], {
      get(_, key) {
        if (key === "then") return undefined;
        throw new Error(`the frame read the engine's ${String(key)}`);
      },
    });
    render(bare({ engine: unread, places: { ohbox: plain("ohbox") }, address: fakeAddress("#/ohbox") }));
    expect(screen.getByText("today at ohbox: usePress: no room is on here")).toBeTruthy();
  });

  it("refuses facts handed in: its record names nobody who could", () => {
    const mail = fakeMail([letter("m1")]);
    function HandsFacts() {
      useRoomFacts({ rows: null, refresh: () => undefined });
      return null;
    }
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [Wide, refusal] of [
      [
        HandsFacts,
        "useRoomFacts: this room has no seam: its host hands nothing above the panes and no reader",
      ],
    ] as const) {
      const place: PlaceEntry = { id: "ohbox", body: "plain", rail: null, panes: { kind: "wide", Wide } };
      /* The refusal is a throw in the place's render: the frame's boundary takes it to the place's pane and reports it
         (`place-boundary.tsx`), so the refusal is read where it is reported. */
      quiet.mockClear();
      render(bare({ engine: mail.engine, places: { ohbox: place }, address: fakeAddress("#/ohbox") }));
      const refused = quiet.mock.calls.filter(
        (call: unknown[]) =>
          call[0] === "[view] render failed" && (call[2] as Error | undefined)?.message === refusal,
      );
      expect(refused.length, refusal).toBeGreaterThan(0);
      cleanup();
    }
    quiet.mockRestore();
  });
});
