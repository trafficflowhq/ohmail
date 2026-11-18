/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PressVerdict } from "@ohmail/client-engine";
import { useDraftsList, type DraftsDoor } from "@ohmail/app-logic/drafts";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import type { UndoToastOptions } from "@ohmail/app-logic/press/undo-door";
import { DraftsAbove, DraftsList, DraftsReading, useDiscardWords } from "../../src/drafts/index.js";
import { at, draft, draw, pane, PHONE, stamp } from "../places/lists-world.js";
import { wideWindow } from "../ohbox/setup.js";

interface Seen {
  opened: string[];
  cancelled: string[];
  edited: string[];
  discarded: string[];
  resolved: Array<[string, string]>;
  again: string[];
  said: { message: string; options?: UndoToastOptions }[];
}

function door(seen: Seen, over: Partial<DraftsDoor> = {}): DraftsDoor {
  return {
    open: (d) => seen.opened.push(d.id),
    decide: () => ({ kind: "go" }),
    withdrawWaiting: async () => "none",
    discard: async (id): Promise<PressVerdict> => {
      seen.discarded.push(id);
      return { kind: "applied" };
    },
    cancelSchedule: (id) => seen.cancelled.push(id),
    editScheduled: (d) => seen.edited.push(d.id),
    resolve: (id, outcome) => seen.resolved.push([id, outcome]),
    sendAgain: (d) => seen.again.push(d.id),
    repliesHere: () => false,
    heldHere: new Set(),
    waiting: new Set(),
    notSent: new Map(),
    ...over,
  };
}

function Drafts(props: {
  drafts: EngineDraft[];
  scheduled?: EngineDraft[];
  seen: Seen;
  door?: Partial<DraftsDoor>;
  open?: string | null;
  settled?: boolean;
  phone?: boolean;
}) {
  const model = useDraftsList({
    drafts: props.drafts,
    scheduled: props.scheduled ?? [],
    settled: props.settled ?? true,
    owed: false,
    door: door(props.seen, props.door),
    report: (message, options) => props.seen.said.push({ message, options }),
    words: {
      discarded: "Discarded",
      undo: "Undo",
      notSent: "Discarded. Nothing was sent.",
      refused: (r) => r ?? "Refused",
      queued: (w) => w,
    },
    stamp,
    appointment,
    now: new Date(at(2, 10)),
  });
  const p = pane("drafts", { open: props.open ?? null }, props.phone ? PHONE : undefined);
  return (
    <DraftsAbove model={model}>
      <DraftsList {...p} />
      <DraftsReading {...p} />
    </DraftsAbove>
  );
}

/** The seat's appointment: a time to come, printed apart from a row's past stamp. */
const appointment = (iso: string): string => `due ${iso.slice(5, 16).replace("T", " ")}`;

const fresh = (): Seen => ({
  opened: [],
  cancelled: [],
  edited: [],
  discarded: [],
  resolved: [],
  again: [],
  said: [],
});
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  wideWindow();
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Drafts lists the sends set for later first, then the drafts", () => {
  it("puts the soonest scheduled send first, says when it sends, and offers Cancel send, not Discard", () => {
    const seen = fresh();
    draw(
      <Drafts
        seen={seen}
        drafts={[draft({ id: "d1", subject: "Half a letter" })]}
        scheduled={[
          draft({ id: "s-late", subject: "Later one", status: "scheduled", sendAt: at(9) }),
          draft({ id: "s-soon", subject: "Sooner one", status: "scheduled", sendAt: at(4) }),
        ]}
      />,
    );
    const scheduled = screen.getByRole("listbox", { name: "Scheduled" });
    const rows = scheduled.querySelectorAll("[data-id]");
    expect([...rows].map((r) => r.getAttribute("data-id"))).toEqual(["s-soon", "s-late"]);
    // When it sends is an appointment, printed as one (the shipped list's own form for a time to come).
    expect(scheduled.textContent).toContain(`Sends ${appointment(at(4))}`);
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel send" })[0]!);
    expect(seen.cancelled).toEqual(["s-soon"]);
    expect(scheduled.textContent).not.toContain("Discard");
  });

  it("a row with nobody to send to says so, and a press opens it through the door", () => {
    const seen = fresh();
    draw(<Drafts seen={seen} drafts={[draft({ id: "d1", to: [] })]} />);
    expect(screen.getByText("No recipient yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /No recipient yet/ }));
    expect(seen.opened).toEqual(["d1"]);
  });

  it("says it is loading while the mirror is owed, and empty only once it is read", () => {
    const seen = fresh();
    const view = draw(<Drafts seen={seen} drafts={[]} settled={false} />);
    expect(document.body.textContent).toContain("Loading your drafts");
    expect(document.body.textContent).not.toContain("Nothing half-written");
    view.unmount();
    draw(<Drafts seen={seen} drafts={[]} />);
    expect(document.body.textContent).toContain("Nothing half-written");
  });

  it("speaks German", () => {
    const seen = fresh();
    draw(<Drafts seen={seen} drafts={[draft({ id: "d1" })]} />, "de");
    expect(screen.getByRole("button", { name: "Verwerfen" })).toBeTruthy();
  });
});

describe("Discard is one press, with Undo", () => {
  it("hides the row at the press, offers Undo, and sends the delete only when the window closes", async () => {
    const seen = fresh();
    draw(
      <Drafts seen={seen} drafts={[draft({ id: "d1", subject: "Half a letter" }), draft({ id: "d2" })]} />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[0]!);
    await flush();
    expect(screen.queryByText("Half a letter")).toBeNull();
    expect(seen.said.at(-1)?.message).toBe("Discarded");
    expect(seen.discarded).toEqual([]);
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS);
    });
    await flush();
    expect(seen.discarded).toEqual(["d1"]);
  });

  it("Undo brings the row back and nothing is deleted", async () => {
    const seen = fresh();
    draw(<Drafts seen={seen} drafts={[draft({ id: "d1", subject: "Half a letter" })]} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    act(() => seen.said.at(-1)?.options?.onAction?.());
    expect(screen.getByText("Half a letter")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS * 2);
    });
    expect(seen.discarded).toEqual([]);
  });

  it("a refusal stays in the row it was refused for, and hides nothing", async () => {
    const seen = fresh();
    draw(
      <Drafts
        seen={seen}
        drafts={[draft({ id: "d1", subject: "Half a letter" })]}
        door={{ decide: () => ({ kind: "refuse", why: "still-sending" }) }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(screen.getByText("Half a letter")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Not discarded");
  });
});

describe("a send nobody could confirm", () => {
  it("says so on its row, and open, stands Send again and It was sent beside Discard", () => {
    const seen = fresh();
    draw(
      <Drafts
        seen={seen}
        open="h1"
        drafts={[draft({ id: "h1", subject: "Sent or not", status: "unverified", updatedAt: at(1) })]}
      />,
    );
    expect(screen.getAllByText(/It isn't in your Sent folder/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    fireEvent.click(screen.getByRole("button", { name: "It was sent" }));
    expect(seen.again).toEqual(["h1"]);
    expect(seen.resolved).toEqual([["h1", "arrived"]]);
  });

  it("a row this browser holds by its own record is held too, though the server calls it a draft", () => {
    const seen = fresh();
    draw(
      <Drafts
        seen={seen}
        open="h1"
        drafts={[draft({ id: "h1", subject: "Sent or not", updatedAt: "2026-08-02T09:55:00.000Z" })]}
        door={{ heldHere: new Set(["h1"]) }}
      />,
    );
    expect(screen.getAllByText(/checking your Sent folder/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Send again" })).toBeTruthy();
  });

  it("a send waiting to go says so, and is not a held row", () => {
    const seen = fresh();
    draw(<Drafts seen={seen} open="w1" drafts={[draft({ id: "w1" })]} door={{ waiting: new Set(["w1"]) }} />);
    expect(screen.getByText("Waiting to send.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send again" })).toBeNull();
  });
});

describe("the window's words", () => {
  it("are Drafts' own, in both languages, the server's sentence quoted when it names one", () => {
    const said: string[] = [];
    function Words() {
      const w = useDiscardWords();
      said.push(w.discarded, w.undo, w.refused("frozen"), w.refused(null), w.queued("organizer"));
      return null;
    }
    draw(<Words />, "de");
    expect(said[0]).toBe("Verworfen");
    expect(said[1]).toBe("Rückgängig");
    expect(said[2]).toContain("frozen");
    expect(said[3]).not.toContain("frozen");
    expect(said[4]).not.toBe("");
  });
});
