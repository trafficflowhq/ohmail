/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellDispatchInput } from "@ohmail/app-logic/press/shell-dispatch";
import { Frame } from "../../src/frame/Frame.js";
import { usePress } from "../../src/frame/room.js";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import type { ReaderEntry } from "../../src/host/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress } from "../support/fake-window.js";
import { fakeMail, letter, READER_PLACE, WORDS } from "../reader/support/mail.js";

/**
 * A PLACE THAT DRAWS ITS OWN READING COLUMN MAY ASK FOR THE ROOM. News, Receipts and Trash draw their own column (their
 * letters are a stream, or not in the mirror), yet their verbs go through the frame's one press seam. `room: true` on
 * their panes asks for it there. Where a reader is handed the room's own seam stands for the frame's life (the mail
 * ground's ruling, S-2), so the place that asks meets that one seam, and so does a place that does not; where no
 * reader is handed no seam stands, and the name alone never starts one.
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

function List() {
  return <p>the list</p>;
}
function OwnReading({ route }: PaneProps) {
  let pressed = "a seam";
  try {
    usePress();
  } catch {
    pressed = "no seam";
  }
  return <p>{`own column at ${route.place}, ${pressed}`}</p>;
}

const ASKS: PlaceEntry = {
  id: "news",
  body: "news",
  rail: null,
  panes: { kind: "columns", List, Reading: OwnReading, room: true },
};
const ASKS_NOT: PlaceEntry = {
  id: "receipts",
  body: "receipts",
  rail: null,
  panes: { kind: "columns", List, Reading: OwnReading },
};
const STUB: ReaderEntry = { Reading: () => <p>the stub reader</p>, Actions: () => null };

function mount(address: string, withReader: boolean) {
  const mail = fakeMail([letter("m1")]);
  const visit = fakeAddress(address);
  const { host } = fakeHost({
    engine: mail.engine,
    service: "self",
    scope: "acct-1",
    places: { ohbox: READER_PLACE, news: ASKS, receipts: ASKS_NOT },
    ...(withReader ? { reader: STUB } : {}),
    address: visit,
  });
  render(
    <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
  return visit;
}

describe("a place's own column asks for the room", () => {
  it("runs the one seam on a place that asks, beside its own column, and the same one on a place that does not: the room's own, for the frame's life", () => {
    const visit = mount("#/reads", true);
    expect(screen.getByText("own column at news, a seam")).toBeTruthy();
    expect(live).toEqual({ seams: 1, mounts: 1 });
    act(() => visit.visit("#/receipts"));
    expect(screen.getByText("own column at receipts, a seam")).toBeTruthy();
    expect(live).toEqual({ seams: 1, mounts: 1 });
    act(() => visit.visit("#/reads"));
    expect(screen.getByText("own column at news, a seam")).toBeTruthy();
    expect(live).toEqual({ seams: 1, mounts: 1 });
  });

  it("never starts the seam where no reader is handed, though the place asks", () => {
    mount("#/reads", false);
    expect(screen.getByText("own column at news, no seam")).toBeTruthy();
    expect(live.seams).toBe(0);
  });
});
