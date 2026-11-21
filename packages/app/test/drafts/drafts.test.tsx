/** @vitest-environment jsdom */
import type { EngineDraft } from "@ohmail/wire";
import words from "../../messages/drafts.en.json" with { type: "json" };
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PressVerdict } from "@ohmail/client-engine";
import { useDraftsList, type DraftsDoor } from "@ohmail/app-logic/drafts";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import type { UndoToastOptions } from "@ohmail/app-logic/press/undo-door";
import { PullContext } from "@ohmail/app-logic/session/pull-new-mail";
import { DraftsAbove, DraftsList, DraftsReading, useDiscardWords } from "../../src/drafts/index.js";
import { at, draft, draw, inWords, pane, PHONE, stamp } from "../places/lists-world.js";
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
      changed: "This draft changed and was kept.",
      unsupported: "This server cannot safely discard this draft yet",
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
it("offers the list's Pull new mail action from Drafts More", () => {
  const pull = vi.fn();
  draw(
    <PullContext value={{ available: true, pull, pulling: false }}>
      <Drafts drafts={[]} seen={fresh()} />
    </PullContext>,
  );
  fireEvent.click(screen.getByRole("button", { name: words.drafts.listMenu }));
  fireEvent.click(screen.getByRole("menuitem", { name: /pull new mail/i }));
  expect(pull).toHaveBeenCalledOnce();
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

  it("keeps the body preview and Cancel send when a scheduled draft has no send time", () => {
    const seen = fresh();
    const body = "The revised plans are ready.";
    draw(
      <Drafts
        seen={seen}
        drafts={[]}
        scheduled={[
          draft({ id: "scheduled-without-time", subject: "Revised plans", body, status: "scheduled" }),
        ]}
        phone
      />,
    );
    const scheduled = within(screen.getByRole("region", { name: "Scheduled" }));
    const cancel = scheduled.getByRole("button", { name: "Cancel send" });
    expect(scheduled.getByText(body)).toBeTruthy();
    fireEvent.click(cancel);
    expect(seen.cancelled).toEqual(["scheduled-without-time"]);
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
    expect(document.body.textContent).not.toContain("No drafts");
    view.unmount();
    draw(<Drafts seen={seen} drafts={[]} />);
    expect(
      screen.getAllByRole("paragraph").filter((paragraph) => paragraph.textContent === "No drafts"),
    ).toHaveLength(1);
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
    expect(seen.resolved).toEqual([]);
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
        drafts={[
          draft({ id: "d1", subject: "First held letter", status: "unverified" }),
          draft({ id: "d2", subject: "Second held letter", status: "unverified" }),
        ]}
        door={{ decide: () => ({ kind: "refuse", why: "still-sending" }) }}
      />,
    );
    const first = screen.getByRole("option", { name: /First held letter/ }).closest<HTMLElement>(".dr-row")!;
    const second = screen
      .getByRole("option", { name: /Second held letter/ })
      .closest<HTMLElement>(".dr-row")!;
    const discard = within(second).getByRole("button", { name: "Discard" });
    discard.focus();
    fireEvent.click(discard);
    await flush();
    const refusal = within(second).getByRole("alert");
    expect(refusal.textContent).toBe(words.drafts.discardStillSending);
    expect(document.activeElement).toBe(refusal);
    expect(within(first).queryByRole("alert")).toBeNull();
    expect(seen.discarded).toEqual([]);
  });

  it("leaves focus on the next draft when a delayed refusal arrives", async () => {
    const seen = fresh();
    let refuse!: (result: "unknown") => void;
    const answer = new Promise<"unknown">((resolve) => {
      refuse = resolve;
    });
    draw(
      <Drafts
        seen={seen}
        drafts={[draft({ id: "d1", subject: "First letter" }), draft({ id: "d2", subject: "Next letter" })]}
        door={{ withdrawWaiting: () => answer }}
      />,
    );
    const [discard, next] = screen.getAllByRole("button", { name: "Discard" });
    discard!.focus();
    fireEvent.click(discard!);
    next!.focus();
    await act(async () => {
      refuse("unknown");
    });
    const first = screen.getByRole("option", { name: /First letter/ }).closest<HTMLElement>(".dr-row")!;
    expect(within(first).getByRole("alert").textContent).toBe(words.drafts.discardCancelUnknown);
    expect(document.activeElement).toBe(next);
    expect(seen.discarded).toEqual([]);
  });

  it("keeps the draft when this browser cannot read its own send records and names a way forward", async () => {
    const seen = fresh();
    draw(
      <Drafts
        seen={seen}
        drafts={[draft({ id: "d1", subject: "My letter" })]}
        door={{ decide: () => ({ kind: "refuse", why: "unknown-jar" }) }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(words.drafts.discardUnknownJar);
    expect(screen.getByRole("option", { name: /My letter/ })).toBeTruthy();
    expect(seen.discarded).toEqual([]);
  });
});

describe("a send nobody could confirm", () => {
  function answers(sentence: string): void {
    const panel = screen.getByRole("toolbar", { name: words.drafts.heldActs });
    expect(within(panel).getByText(sentence)).toBeTruthy();
    expect(within(panel).getByRole("button", { name: words.drafts.sendAgain })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: words.drafts.heldItWasSent })).toBeTruthy();
  }

  it("says so on its row, and open, stands Send again and It was sent beside Discard", () => {
    const seen = fresh();
    const drafts = [
      draft({ id: "h1", subject: "Sent or not", status: "unverified", updatedAt: at(1) }),
      draft({ id: "p1", subject: "Ordinary draft" }),
    ];
    const show = (open: string) => <Drafts seen={seen} open={open} drafts={drafts} />;
    const view = draw(show("h1"));
    const panel = screen.getByRole("toolbar", { name: words.drafts.heldActs });
    expect(within(panel).getByText(words.drafts.heldNotInSent)).toBeTruthy();
    expect(
      within(panel)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent),
    ).toEqual([words.drafts.sendAgain, words.drafts.heldItWasSent, words.drafts.discard]);
    fireEvent.click(screen.getByRole("button", { name: "Send again" }));
    expect(seen.again).toEqual(["h1"]);
    expect(seen.resolved).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "It was sent" }));
    expect(seen.resolved).toEqual([["h1", "arrived"]]);
    view.rerender(inWords(show("p1")));
    expect(screen.queryByRole("toolbar", { name: words.drafts.heldActs })).toBeNull();
  });

  it("a row this browser holds by its own record is held too, though the server calls it a draft", () => {
    const seen = fresh();
    const held = draft({ id: "h1", subject: "Sent or not", updatedAt: "2026-08-02T09:55:00.000Z" });
    const ordinary = draft({ id: "h2", subject: "Another letter" });
    const show = (open: string) => (
      <Drafts seen={seen} open={open} drafts={[held, ordinary]} door={{ heldHere: new Set(["h1"]) }} />
    );
    const view = draw(show("h1"));
    expect(screen.getByRole("option", { name: /Sent or not/ }).getAttribute("aria-description")).toBe(
      `Unconfirmed, ${words.drafts.heldChecking}`,
    );
    expect(
      screen.getByRole("option", { name: /Another letter/ }).getAttribute("aria-description"),
    ).toBeNull();
    answers(words.drafts.heldChecking);
    view.rerender(inWords(show("h2")));
    expect(screen.queryByRole("toolbar", { name: words.drafts.heldActs })).toBeNull();
  });

  it("checking Sent ends after twenty minutes, and both answers remain available", () => {
    const seen = fresh();
    const drafts = [
      draft({ id: "recent", subject: "Recent", status: "unverified", updatedAt: "2026-08-02T09:41:00.000Z" }),
      draft({ id: "old", subject: "Earlier", status: "unverified", updatedAt: "2026-08-02T09:39:00.000Z" }),
    ];
    const show = (open: string) => <Drafts seen={seen} drafts={drafts} open={open} />;
    const view = draw(show("recent"));
    expect(screen.getByRole("option", { name: /Recent/ }).getAttribute("aria-description")).toBe(
      `Unconfirmed, ${words.drafts.heldChecking}`,
    );
    expect(screen.getByRole("option", { name: /Earlier/ }).getAttribute("aria-description")).toBe(
      `Unconfirmed, ${words.drafts.heldNotInSent}`,
    );
    answers(words.drafts.heldChecking);
    view.rerender(inWords(show("old")));
    answers(words.drafts.heldNotInSent);
    expect(document.body.textContent).not.toContain("Did this message arrive");
    expect(document.body.textContent).not.toContain("over a week");
  });

  function expectHeldAnswers(status: EngineDraft["status"], updatedAt: string, sentence: string): void {
    const seen = fresh();
    const drafts = [
      draft({ id: "h1", subject: "Held letter", body: "The held letter body", status, updatedAt }),
      draft({ id: "p1", subject: "Ordinary draft" }),
    ];
    const show = (open: string) => <Drafts seen={seen} open={open} drafts={drafts} />;
    const view = draw(show("h1"));
    expect(screen.getByRole("option", { name: /Held letter/ }).getAttribute("aria-description")).toBe(
      `Unconfirmed, ${sentence}`,
    );
    expect(screen.getByRole("article").textContent).toContain("The held letter body");
    answers(sentence);
    fireEvent.click(screen.getByRole("button", { name: words.drafts.sendAgain }));
    expect(seen.again).toEqual(["h1"]);
    expect(seen.resolved).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: words.drafts.heldItWasSent }));
    expect(seen.resolved).toEqual([["h1", "arrived"]]);
    view.rerender(inWords(show("p1")));
    expect(screen.queryByRole("toolbar", { name: words.drafts.heldActs })).toBeNull();
  }

  it("the row and its two answers explain an unreadable time", () => {
    expectHeldAnswers("unverified", "unreadable", words.drafts.heldNotInSent);
  });

  it("the row and its two answers explain an interrupted send", () => {
    expectHeldAnswers("sending", "2026-08-02T09:59:00.000Z", words.drafts.heldInterrupted);
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
