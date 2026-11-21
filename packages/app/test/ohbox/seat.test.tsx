/** @vitest-environment jsdom */
/**
 * THE OHBOX'S OWN SEAT, over the tests' door of a mount: the real registrations of `mailPlaces()` and the real
 * reader through the real `Frame`, over the fake host that hands the mail ground above the panes. No shell is
 * mounted and no context is provided by hand: what the list draws, the ground read; what a press writes, the frame's
 * one seam sent.
 */
import type { EngineMessage } from "@ohmail/wire";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UNDO_MS } from "@ohmail/app-logic/press/undo-window";
import { resetUiVitalsForTest, takeUiVitals } from "@ohmail/app-logic/session/ui-vitals";
import { Frame } from "../../src/frame/Frame.js";
import { NONE } from "../../src/host/index.js";
import { MailGround, mailPlaces, mailReader } from "../../src/mail/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import searchEn from "../../messages/search.en.json" with { type: "json" };
import tagsEn from "../../messages/tags.en.json" with { type: "json" };
import { bodyDouble, fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow } from "../support/fake-window.js";

/** The letters' sender, admitted by a rule: the partition presents a decided sender's mail in the Ohbox. */
const ADMITTED = {
  "rule:r1": {
    id: "r1",
    kind: "sender",
    match: "ben@kiln.example",
    destination: "INBOX",
    priority: 0,
    provenance: "manual",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};
/** The host's reader over the ground, made once as a host makes it: its doors are the ground's. */
const READER = mailReader({ body: bodyDouble().body, look: NONE });
const MESSAGES = { ...WORDS.en, ...tagsEn, cursor: frameEn.cursor } as Messages;
/** A letter's day in November 2026, at nine in the morning by the world's clock. */
const at = (day: number, over: Partial<EngineMessage> = {}): Partial<EngineMessage> => {
  const instant = new Date(Date.UTC(2026, 10, day, 9)).toISOString();
  return { date: instant, arrivedAt: instant, ...over };
};
/** Three letters of one admitted sender, newest first as the list draws them: c, b, a. */
const THREE = [
  letter("a", at(10, { subject: "Kiln schedule" })),
  letter("b", at(11, { subject: "Glaze order" })),
  letter("c", at(12, { subject: "Studio keys" })),
];

function seat(o: { letters?: readonly EngineMessage[]; room?: "desktop" | "phone"; first?: string } = {}) {
  const mail = fakeMail(o.letters ?? THREE, [], {}, ADMITTED);
  const address = fakeAddress(o.first ?? "#/ohbox");
  const { host } = fakeHost({
    engine: mail.engine,
    service: "self",
    scope: "acct-1",
    places: mailPlaces(),
    above: MailGround,
    reader: READER,
    window: fakeWindow(o.room ?? "desktop"),
    address,
  });
  render(
    <TextProvider locale="en" messages={MESSAGES} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
  return { mail, address };
}
const rows = (): HTMLElement[] => screen.getAllByRole("option");
const press = (key: string, more: KeyboardEventInit = {}): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...more });
};

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** What the seam sent, by kind and letter, in order. */
const sent = (mail: ReturnType<typeof seat>["mail"]): string[] =>
  mail.mutations.map((m) => {
    const r = m as {
      kind: string;
      messageId?: string;
      messageIds?: string[];
      state?: string;
      folder?: string;
      unread?: boolean;
    };
    const ids = r.messageId ?? r.messageIds?.join(",") ?? "";
    const how = r.state ?? r.folder ?? (r.unread === undefined ? "" : r.unread ? "unread" : "read");
    return [r.kind, ids, how].filter(Boolean).join(" ");
  });
const cursorRow = (): string | null => rows().find((r) => r.hasAttribute("data-open"))?.dataset.id ?? null;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
/** The sentence the frame's one report slot says now. */
const said = (): string => screen.getByRole("status").querySelector("span")?.textContent ?? "";

describe("the Ohbox's own seat, over the mail ground", () => {
  it("lists what the ground presents, and its rail entry counts the unread letters off the ground", () => {
    const { mail } = seat();
    expect(rows().map((r) => r.dataset.id)).toEqual(["c", "b", "a"]);
    const rail = screen.getByRole("navigation", { name: "Places" });
    expect(within(rail).getByRole("button", { name: "Ohbox 3" })).toBeTruthy();
    /* A letter read elsewhere: the count is the ground's, with no model of the list asked. */
    act(() => mail.patch("a", { unread: false }));
    expect(within(rail).getByRole("button", { name: "Ohbox 2" })).toBeTruthy();
  });

  it("the rail's count stands where the Ohbox's columns do not: at another place it is still the ground's", () => {
    const mail = fakeMail(THREE, [], {}, ADMITTED);
    const address = fakeAddress("#/history");
    const { host } = fakeHost({
      engine: mail.engine,
      service: "self",
      scope: "acct-1",
      places: {
        ...mailPlaces(),
        history: {
          id: "history",
          body: "history",
          rail: null,
          panes: { kind: "wide", Wide: () => <p>History</p> },
        },
      },
      above: MailGround,
      address,
    });
    render(
      <TextProvider locale="en" messages={MESSAGES} timeZone="Europe/Zurich">
        <Frame host={host} />
      </TextProvider>,
    );
    expect(screen.getByText("History")).toBeTruthy();
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.getByRole("button", { name: "Ohbox 3" })).toBeTruthy();
  });

  it("two columns: a row's press names its letter in the address and asks its text in the press's own task", () => {
    const { mail, address } = seat();
    /* What had been asked of the engine at the moment the address was told: the reading column learns of the letter
       from the address, so an ask it makes itself comes after. */
    const askedBeforeTheAddress: string[][] = [];
    const write = address.write.bind(address);
    address.write = (fragment, how) => {
      askedBeforeTheAddress.push([...mail.bodyAsks]);
      write(fragment, how);
    };
    fireEvent.click(rows()[1]!);
    expect(askedBeforeTheAddress, "the opened letter's text was not asked with the press").toEqual([
      ["b urgent"],
    ]);
    expect(address.read()).toBe("#/ohbox/m/b");
    expect(cursorRow()).toBe("b");
  });

  it("opens a grouped row as a whole thread on desktop and phone", () => {
    const letters = THREE.map((m) => ({ ...m, threadId: "conversation", subject: "Glaze order" }));
    for (const room of ["desktop", "phone"] as const) {
      const { address } = seat({ letters, room });
      expect(rows()).toHaveLength(1);
      fireEvent.click(rows()[0]!);
      expect(address.read()).toBe("#/ohbox/t/c");
      expect(
        within(screen.getByRole("region", { name: "Open message" })).getByRole("group", {
          name: "3 messages, 3 unread",
        }),
      ).toBeTruthy();
      cleanup();
    }
  });

  it("one column: j and k move the cursor row in a list that stays drawn, name no letter and read nothing; Enter stands the letter over the list", async () => {
    const { mail, address } = seat({ room: "phone" });
    press("j");
    expect(cursorRow()).toBe("c");
    press("j");
    expect(cursorRow()).toBe("b");
    press("k");
    expect(cursorRow()).toBe("c");
    await settle();
    expect(address.read(), "a walk named a letter in the address").toBe("#/ohbox");
    expect(sent(mail), "a walk wrote read state").toEqual([]);
    /* No reading column is drawn for a row only walked to: the cursor row's text is asked ahead, as a selection's
       is, so that it is there when the row is entered. */
    expect(mail.bodyAsks, "the cursor row's text was not asked ahead").toEqual([
      "c urgent",
      "b urgent",
      "c urgent",
    ]);
    expect(rows().length).toBe(3);
    press("Enter");
    expect(address.read()).toBe("#/ohbox/m/c");
  });

  it("a letter the address names by itself (a link, Back) has its row brought to the middle of the list; a row's own press moves no list", () => {
    const brought: { id: string | undefined; how: unknown }[] = [];
    const real = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: HTMLElement, how?: unknown) {
      brought.push({ id: this.dataset.id, how });
    };
    try {
      const { address } = seat();
      fireEvent.click(rows()[1]!);
      expect(address.read()).toBe("#/ohbox/m/b");
      expect(brought, "a press on a row moved the list").toEqual([]);
      act(() => address.visit("#/ohbox/m/a"));
      expect(brought, "the linked letter's row was not brought on screen").toEqual([
        { id: "a", how: { block: "center" } },
      ]);
      /* The same letter named again is no second arrival. */
      act(() => address.visit("#/ohbox/m/a"));
      expect(brought).toHaveLength(1);
      /* Back to the letter pressed before is one: another letter was named since. */
      act(() => address.visit("#/ohbox/m/b"));
      expect(brought.map((b) => b.id)).toEqual(["a", "b"]);
    } finally {
      Element.prototype.scrollIntoView = real;
    }
  });

  for (const room of ["desktop", "phone"] as const) {
    it(`${room === "desktop" ? "two columns" : "one column"}: a verb's first press with no cursor places the cursor on the first row, says so and files nothing; the second press files that row`, async () => {
      const { mail, address } = seat({ room });
      expect(cursorRow(), "an untouched list has no cursor row").toBeNull();
      press("e");
      expect(cursorRow(), "the first press did not place the cursor on the first row").toBe("c");
      /* The sentence names the pressed key by its own line of the key sheet. */
      expect(said()).toBe(frameEn.cursor.placed.replace("{label}", searchEn.shortcuts.park));
      /* Where a column stands beside the list the placed row's letter is shown in it, as a selection's is. */
      expect(address.read()).toBe(room === "desktop" ? "#/ohbox/m/c" : "#/ohbox");
      await settle();
      expect(sent(mail), "the first press filed something").toEqual([]);
      press("e");
      await settle();
      expect(sent(mail)).toEqual(["triage_set c set_aside"]);
    });
  }

  it("a first press on a list with no row places nothing and says nothing", async () => {
    seat({ letters: [] });
    press("e");
    await settle();
    expect(screen.queryByText(/First message selected/)).toBeNull();
  });

  it("one column, no letter over the list: the cursor row's verbs are the list's own (e parks, a queues, b books tomorrow at the account's hour), each through the one seam with its sentence", async () => {
    /* The afternoon where the reader is: "tomorrow" is the next day (the small hours have a case of their own). */
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-17T13:00:00.000Z"));
    const { mail } = seat({ room: "phone" });
    press("j");
    press("e");
    await settle();
    expect(sent(mail)).toEqual(["triage_set c set_aside"]);
    expect(screen.getByText("Parked")).toBeTruthy();
    press("a");
    await settle();
    expect(sent(mail).at(-1)).toBe("triage_set c reply_later");
    press("b");
    await settle();
    const booked = mail.mutations.at(-1) as {
      kind: string;
      state: string;
      bubbleUpAt: string;
      messageId: string;
    };
    expect([booked.kind, booked.messageId, booked.state]).toEqual(["triage_set", "c", "bubbled_up"]);
    /* Tomorrow at the account's resurface hour, which no host answered here: 09:00 where the reader is. */
    const when = new Date(booked.bubbleUpAt);
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    const zurich = (d: Date, o: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", ...o }).format(d);
    expect(zurich(when, { hour: "2-digit", minute: "2-digit" })).toBe("09:00");
    expect(zurich(when, { day: "2-digit" })).toBe(zurich(tomorrow, { day: "2-digit" }));
    expect(screen.getByText(/^Resurfaces /)).toBeTruthy();
  });

  it("b in the small hours books the coming morning where the reader is, not the day after: either side of midnight", async () => {
    const zurich = (iso: string) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Zurich",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(iso));
    const bookAt = async (now: string): Promise<string> => {
      vi.setSystemTime(new Date(now));
      const { mail } = seat({ room: "phone" });
      press("j");
      press("b");
      await settle();
      const booked = mail.mutations.at(-1) as { bubbleUpAt: string };
      cleanup();
      return zurich(booked.bubbleUpAt);
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    /* 23:30 on the 17th where the reader is (22:30 by the world's clock): the next day, the 18th. */
    expect(await bookAt("2026-11-17T22:30:00.000Z")).toBe("18, 09:00");
    /* 00:30 on the 18th where the reader is (23:30 on the 17th by the world's clock): the coming morning, the 18th. */
    expect(await bookAt("2026-11-17T23:30:00.000Z")).toBe("18, 09:00");
    /* 10:00 on the 18th: the 19th. */
    expect(await bookAt("2026-11-18T09:00:00.000Z")).toBe("19, 09:00");
  });

  it("one column: Backspace on the cursor row holds its delete for the Undo window, z takes it back and nothing has left; unheld it leaves for Trash when the window ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { mail } = seat({ room: "phone" });
    press("j");
    press("Backspace");
    expect(
      rows().map((r) => r.dataset.id),
      "the deleted row is still listed",
    ).toEqual(["b", "a"]);
    expect(mail.mutations).toEqual([]);
    press("z");
    expect(rows().map((r) => r.dataset.id)).toEqual(["c", "b", "a"]);
    act(() => {
      vi.advanceTimersByTime(UNDO_MS + 2000);
    });
    expect(mail.mutations, "a delete that was taken back left for the server").toEqual([]);
    press("j");
    press("Delete");
    expect(rows().map((r) => r.dataset.id)).toEqual(["c", "a"]);
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS + 2000);
    });
    expect(sent(mail), "the delete that was not taken back never left").toEqual(["message_delete b"]);
  });

  it("a selection's verb is one press through the seam and one sentence: x, j, x, then e parks both", async () => {
    const { mail } = seat({ room: "phone" });
    press("j");
    press("x");
    press("j");
    press("x");
    press("e");
    await settle();
    expect(sent(mail).sort()).toEqual(["triage_set b set_aside", "triage_set c set_aside"]);
    expect(said()).toBe("2 messages parked.");
  });

  it("Mark all read writes the unread letters read and offers a true Undo, which z presses", async () => {
    const { mail } = seat();
    fireEvent.click(screen.getByRole("button", { name: "Mark all 3 unread messages read" }));
    await settle();
    expect(sent(mail)).toEqual(["mark_seen c,b,a read"]);
    expect(said()).toBe("Marked 3 messages read");
    press("z");
    await settle();
    expect(sent(mail).at(-1)).toBe("mark_seen c,b,a unread");
  });
  it("keeps Mark all read Undo available at 6.5 seconds and restores only changed letters", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const [alreadyRead, ...unread] = THREE;
    const { mail } = seat({ letters: [{ ...alreadyRead!, unread: false }, ...unread] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark all 2 unread messages read" }));
    });
    expect(sent(mail)).toEqual(["mark_seen c,b read"]);
    await act(async () => vi.advanceTimersByTimeAsync(6500));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^Undo/ })));
    expect(sent(mail)).toEqual(["mark_seen c,b read", "mark_seen c,b unread"]);
  });

  it("Move on picked rows writes where the sender's mail goes: the letters move at the press, the rule is held for the Undo window, and z takes both back", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { mail } = seat({ room: "phone" });
    press("j");
    press("x");
    press("m");
    fireEvent.click(screen.getByRole("menuitem", { name: /News/ }));
    await act(async () => undefined);
    expect(sent(mail)).toEqual(["move c ohmail/News"]);
    expect(said()).toBe("Mail from 1 sender now goes to News — 1 message moved.");
    press("z");
    await act(async () => undefined);
    expect(sent(mail)).toEqual(["move c ohmail/News", "move c INBOX"]);
    expect(said()).toBe("The mail is back where it was, and no rule was made.");
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS + 3000);
    });
    expect(sent(mail), "a rule that was taken back left for the server").toEqual([
      "move c ohmail/News",
      "move c INBOX",
    ]);
  });

  it("a Move that is not taken back sends the sender's rule when its window closes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { mail } = seat({ room: "phone" });
    press("j");
    press("x");
    press("m");
    fireEvent.click(screen.getByRole("menuitem", { name: /News/ }));
    await act(async () => undefined);
    await act(async () => {
      vi.advanceTimersByTime(UNDO_MS + 3000);
    });
    expect(mail.mutations.map((m) => m.kind)).toEqual(["move", "rule_update"]);
    expect(mail.mutations[1]).toMatchObject({ ruleId: "r1", destination: "ohmail/News" });
  });

  it("the open's measure is abandoned when a letter is let go before its text arrives: a later look at it times no open", async () => {
    resetUiVitalsForTest();
    const owed = (id: string, day: number) => letter(id, at(day, { body: undefined }));
    const { mail, address } = seat({ letters: [owed("a", 10), owed("b", 11)] });
    const painted = () =>
      act(async () => {
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      });
    /* The control: a press whose letter's text arrives while it is open is one open, timed from the press. */
    fireEvent.click(rows()[0]!);
    act(() => mail.patch("b", { body: "The text of b." }));
    await painted();
    expect(takeUiVitals().openCount, "an open that got its text was not timed").toBe(1);
    /* A press on a letter whose text is owed, let go before it arrives. */
    fireEvent.click(rows()[1]!);
    expect(address.read()).toBe("#/ohbox/m/a");
    act(() => address.visit("#/ohbox"));
    act(() => mail.patch("a", { body: "The text of a." }));
    /* Back to it by its address, with no press: nothing is being waited for. */
    act(() => address.visit("#/ohbox/m/a"));
    await painted();
    expect(takeUiVitals().openCount, "a look at the letter was timed from a press that was let go").toBe(0);
  });
});
