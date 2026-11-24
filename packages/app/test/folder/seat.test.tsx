/** @vitest-environment jsdom */
/**
 * A FOLDER'S OWN SEAT, over the tests' door of a mount (`../places/list-seat.tsx`): one of the mailbox's own folders,
 * read in place, what is new over what came before; a folder that leaves the mail server named; and the rail's
 * Folders group (the shelf), drawn by the place off the ground while the account uses folders, and not otherwise.
 */
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { foldersOpenedKey } from "@ohmail/app-logic/storage/persisted-ui";
import {
  resetStorageOwnerForTest,
  setStorageOwner,
  storageOwner,
} from "@ohmail/app-logic/storage/storage-owner";
import frameEn from "../../messages/frame.en.json" with { type: "json" };
import readerEn from "../../messages/reader.en.json" with { type: "json" };
import type { ConsentWire } from "../../src/host/index.js";
import { READER_DOM, scrollerOf } from "../../src/reader/read-dom.js";
import { letter } from "../reader/support/mail.js";
import {
  dwell,
  FOLDERS_ON,
  hitAt,
  layOutLetter,
  listSeat,
  readerTime,
  sent,
  withTheHitSaid,
} from "../places/list-seat.js";

/** A letter of a day of November; a folder by any name the mail server may give one. */
const at = (
  day: number,
  over: Omit<Partial<EngineMessage>, "folder"> & { folder?: string } = {},
): EngineMessage =>
  letter(over.id ?? `d${day}`, {
    date: new Date(Date.UTC(2026, 10, day, 9)).toISOString(),
    arrivedAt: new Date(Date.UTC(2026, 10, day, 9)).toISOString(),
    ...over,
    folder: (over.folder ?? "INBOX") as EngineMessage["folder"],
  });
const folder = (id: string, name: string) => ({ id, name, mailboxId: "mb-1", mailbox: "me@studio.example" });
const MORE = { "folder:f1": folder("f1", "Projects/Clay"), "folder:f2": folder("f2", "Archive") };
/** The account's one mailbox as the mail state reads it, at rest, its Junk named by the mailbox's own word. */
const FACTS = async () => [
  {
    id: "mb-1",
    address: "me@studio.example",
    status: "active",
    errorCode: null,
    disabledReason: null,
    syncBlockedReason: null,
    syncBlockedSince: null,
    lastSyncAt: null,
    junkFolder: "Junk",
  },
];
const WITH_JUNK = { ...MORE, "folder:f3": folder("f3", "Junk") };
/** The account's answer that it uses folders, ten seconds late (the test's clock). */
const LATE_FOLDERS = {
  state: () =>
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            seedConfirmedAt: "2026-01-01T00:00:00.000Z",
            dormancyDays: 30,
            blockRemoteImagesAt: null,
            loadTrackingPixelsAt: null,
            foldersEnabledAt: "2026-01-01T00:00:00.000Z",
          }),
        10_000,
      ),
    ),
} as unknown as ConsentWire;
/* Two letters in Clay, one unread; one in Archive; one in the inbox. */
const LETTERS = [
  at(10, { id: "a", subject: "Old kiln notes", folder: "Projects/Clay", unread: false }),
  at(11, { id: "b", subject: "New glaze", folder: "Projects/Clay", unread: true }),
  at(12, { id: "c", subject: "Tax 2009", folder: "Archive", unread: false }),
  at(13, { id: "d", subject: "Hello", folder: "INBOX" }),
];

const rows = (): HTMLElement[] => screen.queryAllByRole("option");
/** The row the list marks as its cursor's, by the letter it carries. */
const cursorRow = (): string | null =>
  screen.queryAllByRole("option", { selected: true }).map((r) => r.dataset.id ?? null)[0] ?? null;
/**
 * The folder's rows listed, under the test's own clock (`readerTime`): the account's answer that it uses folders
 * arrives by itself, and no timer of the page is waited for.
 */
async function listed(count: number): Promise<void> {
  for (let i = 0; i < 50 && rows().length !== count; i++)
    await act(async () => void vi.advanceTimersByTime(1));
  expect(rows().length).toBe(count);
}
const press = (key: string): void => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
};
const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));
/** The sentence the frame's one report slot says now. */
const said = (): string => screen.queryByRole("status")?.querySelector("span")?.textContent ?? "";
/** The report's Undo, by its name (the key that presses it too is said beside it). */
const UNDO = /^Undo\b/;

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {}, finished: Promise.resolve() }) as unknown as Animation;
  Element.prototype.scrollIntoView ??= () => undefined;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a folder's own seat, over the mail ground", () => {
  it.each(["opens another folder", "loses a letter to a different folder"])(
    "closes a pending row menu without sending a move when the folder %s",
    async (change) => {
      const { mail, address } = listSeat({
        letters: LETTERS,
        more: MORE,
        first: "#/folder/f1",
        consent: FOLDERS_ON,
        mailboxes: FACTS,
      });
      await waitFor(() => expect(rows().map((row) => row.dataset.id)).toEqual(["b", "a"]));
      fireEvent.contextMenu(rows()[1]!);
      const menu = screen.getByRole("menu", { name: "Move" });
      expect(within(menu).getByRole("menuitem", { name: /Archive/ })).toBeTruthy();
      if (change === "opens another folder") {
        act(() => address.visit("#/folder/f2"));
        await waitFor(() => expect(rows().map((row) => row.dataset.id)).toEqual(["c"]));
      } else {
        act(() => mail.add(at(10, { id: "a", subject: "Old kiln notes", folder: "INBOX", unread: false })));
        await waitFor(() => expect(rows().map((row) => row.dataset.id)).toEqual(["b"]));
      }
      const oldMenu = screen.queryByRole("menu", { name: "Move" });
      if (oldMenu !== null) fireEvent.click(within(oldMenu).getByRole("menuitem", { name: /Archive/ }));
      await settle();
      expect(sent(mail)).toEqual([]);
      expect(oldMenu).toBeNull();
      act(() => address.visit("#/folder/f1"));
      expect(screen.queryByRole("menu", { name: "Move" })).toBeNull();
    },
  );

  it("refuses a move press in the same turn its source folder stops being the active route", async () => {
    const { mail, address } = listSeat({
      letters: LETTERS,
      more: MORE,
      first: "#/folder/f1",
      consent: FOLDERS_ON,
      mailboxes: FACTS,
    });
    await waitFor(() => expect(rows().map((row) => row.dataset.id)).toEqual(["b", "a"]));
    fireEvent.contextMenu(rows()[1]!);
    const choice = within(screen.getByRole("menu", { name: "Move" })).getByRole("menuitem", {
      name: /Archive/,
    });
    act(() => {
      address.visit("#/folder/f2");
      choice.click();
    });
    await settle();
    expect(sent(mail)).toEqual([]);
    expect(rows().map((row) => row.dataset.id)).toEqual(["c"]);
  });

  it("lists the folder's letters, what is new over what came before, under the folder's own name", async () => {
    listSeat({ letters: LETTERS, more: MORE, first: "#/folder/f1", consent: FOLDERS_ON });
    await waitFor(() => expect(rows().map((r) => r.dataset.id)).toEqual(["b", "a"]));
    expect(screen.getByRole("heading", { name: "Clay" })).toBeTruthy();
  });

  it("a row opens its letter beside the list: the address stays the folder's", async () => {
    const { address } = listSeat({ letters: LETTERS, more: MORE, first: "#/folder/f1", consent: FOLDERS_ON });
    await waitFor(() => expect(rows().length).toBe(2));
    fireEvent.click(rows()[1]!);
    await settle();
    expect(address.read()).toBe("#/folder/f1/m/a");
  });

  it("a hit opened into a folder as entered: its letter is entered and read by the rule, and the one-shot is taken", async () => {
    const { mail, address } = listSeat({
      letters: LETTERS,
      more: MORE,
      first: "#/search",
      consent: FOLDERS_ON,
      also: (seated) => ({
        search: hitAt({ place: "folder", sub: "f1", open: "b" }),
        folder: withTheHitSaid(seated.folder),
      }),
    });
    /* The account's answer that it uses folders is in: the rail lists them. */
    const rail = screen.getByRole("navigation", { name: "Places" });
    await waitFor(() => expect(within(rail).getByRole("button", { name: "Clay, 1 unread" })).toBeTruthy());
    readerTime();
    fireEvent.click(screen.getByRole("button", { name: "Open the hit" }));
    expect(address.read()).toBe("#/folder/f1/m/b");
    /* The place took the word once its list showed the letter: the frame holds none any more. */
    expect(screen.getByText("the hit: none")).toBeTruthy();
    layOutLetter("b");
    await dwell();
    expect(sent(mail)).toEqual(["mark_seen b read glance"]);
  });

  it("a link to a folder's letter is a preview, and a press enters it once: one read, and no hit to take", async () => {
    readerTime();
    const { mail, address } = listSeat({
      letters: LETTERS,
      more: MORE,
      first: "#/folder/f1/m/b",
      consent: FOLDERS_ON,
      also: (seated) => ({ folder: withTheHitSaid(seated.folder) }),
    });
    await listed(2);
    layOutLetter("b");
    await dwell(3000);
    /* The address alone named it: nothing was entered, nothing read. */
    expect(sent(mail)).toEqual([]);
    fireEvent.click(rows()[0]!);
    expect(address.read()).toBe("#/folder/f1/m/b");
    layOutLetter("b");
    await dwell();
    await dwell(3000);
    expect(sent(mail)).toEqual(["mark_seen b read glance"]);
    expect(screen.getByText("the hit: none")).toBeTruthy();
  });

  it("a row's menu moves its letter into another of the mailbox's folders: one move, its sentence, and nowhere else", async () => {
    const { mail } = listSeat({
      letters: LETTERS,
      more: MORE,
      first: "#/folder/f1",
      consent: FOLDERS_ON,
      mailboxes: FACTS,
    });
    await waitFor(() => expect(rows().length).toBe(2));
    await settle();
    fireEvent.contextMenu(rows()[1]!);
    const menu = screen.getByRole("menu", { name: "Move" });
    /* The folder it is in is not offered. */
    expect(within(menu).queryByRole("menuitem", { name: /Clay/ })).toBeNull();
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Archive/ }));
    });
    expect(sent(mail)).toEqual(["move a Archive"]);
    await waitFor(() => expect(said()).toBe("Moved to Archive"));
    expect(screen.queryByRole("menu", { name: "Move" })).toBeNull();
  });

  it("a move the mail server refuses because the folder is gone says so by its name and offers no Undo: one move sent", async () => {
    const { mail } = listSeat({
      letters: LETTERS,
      more: MORE,
      first: "#/folder/f1",
      consent: FOLDERS_ON,
      mailboxes: FACTS,
      /* The engine rolls the move back with the server's refusal: the mailbox no longer lists the folder. */
      engine: (fake) => ({
        mutate: async (m: EngineMutation) => {
          fake.mutations.push(m);
          return { status: "rolled_back", error: { code: "no_such_folder" } };
        },
      }),
    });
    await waitFor(() => expect(rows().length).toBe(2));
    await settle();
    fireEvent.contextMenu(rows()[1]!);
    const menu = screen.getByRole("menu", { name: "Move" });
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Archive/ }));
    });
    expect(sent(mail)).toEqual(["move a Archive"]);
    await waitFor(() => expect(said()).toBe("“Archive” is no longer on your mail server"));
    expect(within(screen.getByRole("status")).queryByRole("button", { name: UNDO })).toBeNull();
  });

  it("Undo on a move that stood sends the letter back where it was: the move, then the move back", async () => {
    const { mail } = listSeat({
      letters: LETTERS,
      more: MORE,
      first: "#/folder/f1",
      consent: FOLDERS_ON,
      mailboxes: FACTS,
    });
    await waitFor(() => expect(rows().length).toBe(2));
    await settle();
    fireEvent.contextMenu(rows()[1]!);
    const menu = screen.getByRole("menu", { name: "Move" });
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Archive/ }));
    });
    await waitFor(() => expect(said()).toBe("Moved to Archive"));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("status")).getByRole("button", { name: UNDO }));
    });
    expect(sent(mail)).toEqual(["move a Archive", "move a Projects/Clay"]);
  });

  it("while the mail state has not said which folder is the mailbox's Junk, a row's menu offers no folder", async () => {
    listSeat({ letters: LETTERS, more: WITH_JUNK, first: "#/folder/f1", consent: FOLDERS_ON });
    await waitFor(() => expect(rows().length).toBe(2));
    await settle();
    fireEvent.contextMenu(rows()[1]!);
    const menu = screen.getByRole("menu", { name: "Move" });
    expect(within(menu).queryAllByRole("menuitem")).toEqual([]);
  });

  it("once the mail state names the mailbox's Junk, a row's menu offers its other folders and never Junk", async () => {
    listSeat({
      letters: LETTERS,
      more: WITH_JUNK,
      first: "#/folder/f1",
      consent: FOLDERS_ON,
      mailboxes: FACTS,
    });
    await waitFor(() => expect(rows().length).toBe(2));
    await settle();
    fireEvent.contextMenu(rows()[1]!);
    const menu = screen.getByRole("menu", { name: "Move" });
    expect(within(menu).getByRole("menuitem", { name: /Archive/ })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: /Junk/ })).toBeNull();
  });

  it("the rail's Folders group lists the folders with their unread count, and a press opens one", async () => {
    const { address } = listSeat({ letters: LETTERS, more: MORE, first: "#/ohbox", consent: FOLDERS_ON });
    const rail = screen.getByRole("navigation", { name: "Places" });
    await waitFor(() => expect(within(rail).getByRole("button", { name: "Clay, 1 unread" })).toBeTruthy());
    fireEvent.click(within(rail).getByRole("button", { name: "Archive" }));
    expect(address.read()).toBe("#/folder/f2");
  });

  it("while the account does not use folders the rail holds no Folders group and a folder lists nothing", async () => {
    listSeat({ letters: LETTERS, more: MORE, first: "#/folder/f1" });
    await settle();
    const rail = screen.getByRole("navigation", { name: "Places" });
    expect(within(rail).queryByRole("button", { name: /^Folders/ })).toBeNull();
    expect(rows()).toEqual([]);
  });
});

describe("navigation", () => {
  it("a row press navigates by entity id and lights the active row", async () => {
    const { address, mail } = listSeat({
      letters: [],
      more: {
        "folder:project-id": folder("project-id", "Projects"),
        "folder:archive-id": folder("archive-id", "Archiv"),
      },
      first: "#/folder/archive-id",
      consent: FOLDERS_ON,
      mailboxes: FACTS,
    });
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    const target = await rail.findByRole("button", { name: "Projects" });
    expect(rail.getByRole("button", { name: "Archiv" }).getAttribute("aria-current")).toBe("page");
    target.focus();
    fireEvent.click(target);
    expect(address.read()).toBe("#/folder/project-id");
    expect(target.getAttribute("aria-current")).toBe("page");
    expect(rail.getByRole("button", { name: "Archiv" }).hasAttribute("aria-current")).toBe(false);
    expect(document.activeElement).toBe(target);
    expect(sent(mail)).toEqual([]);
  });
});

describe("the roll-up count", () => {
  it("a collapsed parent's badge is own + hidden descendants, exactly once; expanded, its own", async () => {
    const more = {
      "folder:project-id": folder("project-id", "Projects"),
      "folder:acme-id": folder("acme-id", "Projects/Acme"),
      "folder:year-id": folder("year-id", "Projects/Acme/2026"),
      "folder:invoice-id": folder("invoice-id", "Invoices"),
    };
    const letters = [
      at(10, { id: "p1", folder: "Projects", unread: true }),
      ...Array.from({ length: 2 }, (_, i) => at(10, { id: `a${i}`, folder: "Projects/Acme", unread: true })),
      ...Array.from({ length: 4 }, (_, i) =>
        at(10, { id: `y${i}`, folder: "Projects/Acme/2026", unread: true }),
      ),
      at(10, { id: "i1", folder: "Invoices", unread: true }),
    ];
    const { address, mail } = listSeat({
      letters,
      more,
      first: "#/ohbox",
      consent: FOLDERS_ON,
      mailboxes: FACTS,
    });
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    fireEvent.click(await rail.findByRole("button", { name: /^All folders/ }));
    const tree = await rail.findByRole("tree", { name: "All folders" });
    const fold = within(tree);
    expect(tree.querySelectorAll(".oh-folderfold-group")).toHaveLength(1);
    expect(tree.querySelector(".oh-folderfold-mailbox")).toBeNull();
    expect(fold.getByRole("button", { name: "Projects, 7 unread" })).toBeTruthy();
    expect(fold.queryByRole("button", { name: /^Acme/ })).toBeNull();
    fireEvent.click(fold.getByRole("button", { name: "Expand Projects" }));
    expect(fold.getByRole("button", { name: "Projects, 1 unread" })).toBeTruthy();
    expect(fold.getByRole("button", { name: "Acme, 6 unread" })).toBeTruthy();
    expect(fold.queryByRole("button", { name: /^2026/ })).toBeNull();
    expect(address.read()).toBe("#/ohbox");
    expect(sent(mail)).toEqual([]);
  });
});

describe("a folder's list, walked by key", () => {
  const folderAt = (first: string, room: "desktop" | "phone" = "desktop") =>
    listSeat({ letters: LETTERS, more: MORE, first, room, consent: FOLDERS_ON });

  it("on arrival no letter stands open: the folder's list stands alone, with no cursor", async () => {
    readerTime();
    const { address } = folderAt("#/folder/f1");
    await listed(2);
    await dwell(3000);
    expect(address.read()).toBe("#/folder/f1");
    expect(cursorRow()).toBeNull();
  });

  it("a letter the address names already is the one that stands: the arrival opens no other", async () => {
    const { address } = folderAt("#/folder/f1/m/a");
    await waitFor(() => expect(rows().length).toBe(2));
    await settle();
    expect(address.read()).toBe("#/folder/f1/m/a");
    expect(cursorRow()).toBe("a");
  });

  it("j, k and the arrows open the next letter and the one before as a landing, which is read once it is rested on", async () => {
    readerTime();
    const { mail, address } = folderAt("#/folder/f1");
    await listed(2);
    /* With no letter open, j comes in at the top. */
    press("j");
    expect(address.read()).toBe("#/folder/f1/m/b");
    press("j");
    expect(address.read()).toBe("#/folder/f1/m/a");
    /* The list ends here: one more step goes nowhere. */
    press("j");
    expect(address.read()).toBe("#/folder/f1/m/a");
    press("ArrowUp");
    expect(address.read()).toBe("#/folder/f1/m/b");
    press("ArrowDown");
    expect(address.read()).toBe("#/folder/f1/m/a");
    press("k");
    expect(address.read()).toBe("#/folder/f1/m/b");
    expect(sent(mail)).toEqual([]);
    /* The cursor rests on the letter the step landed on: it is entered, and the rule reads it. */
    layOutLetter("b");
    await dwell(3000);
    expect(sent(mail)).toEqual(["mark_seen b read glance"]);
  });

  it("a letter read while it stands open keeps its row under what is new; once left it files under what came before", async () => {
    readerTime();
    const older = at(9, { id: "e", subject: "Clay order", folder: "Projects/Clay", unread: true });
    const { mail, address } = listSeat({
      letters: [...LETTERS, older],
      more: MORE,
      first: "#/folder/f1/m/b",
      consent: FOLDERS_ON,
    });
    await listed(3);
    expect(rows().map((r) => r.dataset.id)).toEqual(["b", "e", "a"]);
    fireEvent.click(rows()[0]!);
    layOutLetter("b");
    await dwell();
    await dwell(3000);
    expect(sent(mail)).toEqual(["mark_seen b read glance"]);
    /* The read comes back from the mail server, as a drain brings it. */
    act(() => mail.patch("b", { unread: false }));
    expect(
      rows().map((r) => r.dataset.id),
      "read and still open: b keeps its row",
    ).toEqual(["b", "e", "a"]);
    press("j");
    expect(address.read()).toBe("#/folder/f1/m/e");
    await act(async () => void vi.advanceTimersByTime(1));
    expect(
      rows().map((r) => r.dataset.id),
      "left: b files under what came before",
    ).toEqual(["e", "b", "a"]);
  });

  it("the person scrolls the landed letter with the arrow key in the reading column: it is entered and read", async () => {
    readerTime();
    const { mail, address } = folderAt("#/folder/f1");
    await listed(2);
    press("j");
    expect(address.read()).toBe("#/folder/f1/m/b");
    layOutLetter("b");
    const scroller = scrollerOf(document.querySelector(READER_DOM.stopsRoot!));
    expect(scroller).not.toBeNull();
    act(() => scroller!.focus());
    expect(document.activeElement).toBe(scroller);
    await act(async () => undefined);
    press("ArrowDown");
    /* The arrow scrolled the letter: it did not walk the list. */
    expect(address.read()).toBe("#/folder/f1/m/b");
    await dwell(3000);
    expect(sent(mail)).toEqual(["mark_seen b read glance"]);
  });

  it("a keyboard that stands on a row goes with the cursor; one that stands elsewhere is left where it is", async () => {
    const { address } = folderAt("#/folder/f1/m/b");
    await waitFor(() => expect(rows().length).toBe(2));
    rows()[0]!.focus();
    press("j");
    expect(address.read()).toBe("#/folder/f1/m/a");
    expect(document.activeElement).toBe(rows()[1]);
    /* The keyboard on the rail: the cursor moves, the keyboard stays. */
    const rail = within(screen.getByRole("navigation", { name: "Places" })).getByRole("button", {
      name: "Archive",
    });
    rail.focus();
    fireEvent.keyDown(document.body, { key: "k" });
    expect(address.read()).toBe("#/folder/f1/m/b");
    expect(document.activeElement).toBe(rail);
  });

  it("where one column stands nothing opens on arrival: j and k move the cursor's row alone, and Enter opens it and enters it", async () => {
    readerTime();
    const { mail, address } = folderAt("#/folder/f1", "phone");
    await listed(2);
    await dwell(3000);
    expect(address.read()).toBe("#/folder/f1");
    expect(cursorRow()).toBeNull();
    press("j");
    expect(cursorRow()).toBe("b");
    press("j");
    expect(cursorRow()).toBe("a");
    press("k");
    expect(cursorRow()).toBe("b");
    expect(address.read()).toBe("#/folder/f1");
    press("Enter");
    expect(address.read()).toBe("#/folder/f1/m/b");
    layOutLetter("b");
    await dwell();
    expect(sent(mail)).toEqual(["mark_seen b read glance"]);
  });

  it("a letter's verb pressed with no cursor places it on the first letter and says so, files nothing, and files on the next press", async () => {
    const { mail, address } = folderAt("#/folder/f1");
    await waitFor(() => expect(rows().length).toBe(2));
    expect(cursorRow()).toBeNull();
    press("e");
    expect(address.read()).toBe("#/folder/f1/m/b");
    expect(cursorRow()).toBe("b");
    const sentence = frameEn.cursor.placed.replace("{label}", readerEn.reader.key.park);
    await waitFor(() => expect(said()).toBe(sentence));
    expect(sent(mail)).toEqual([]);
    await act(async () => {
      press("e");
    });
    expect(sent(mail).length).toBe(1);
    expect(sent(mail)[0]).toMatch(/ b( |$)/);
  });
});

describe("a letter's verb key over an empty folder", () => {
  it("places nothing, says nothing, files nothing, and does not take the key", async () => {
    /* Archive without its one letter: the folder stands empty. */
    const { mail, address } = listSeat({
      letters: LETTERS.filter((m) => (m.folder as string) !== "Archive"),
      more: MORE,
      first: "#/folder/f2",
      consent: FOLDERS_ON,
    });
    await settle();
    expect(rows().length, "the folder holds nothing").toBe(0);
    const taken: boolean[] = [];
    for (const key of ["e", "r", "b", "Backspace"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      (document.activeElement ?? document.body).dispatchEvent(event);
      taken.push(event.defaultPrevented);
    }
    await settle();
    expect(taken, "an empty folder took the press").toEqual([false, false, false, false]);
    expect(cursorRow()).toBeNull();
    expect(said()).toBe("");
    expect(sent(mail)).toEqual([]);
    expect(address.read()).toBe("#/folder/f2");
  });
});

describe("a link to a folder's letter before the folder lists it", () => {
  it("reads nothing by itself while the folder has not listed the letter", async () => {
    readerTime();
    const { mail } = listSeat({
      letters: LETTERS,
      more: MORE,
      first: "#/folder/f1/m/b",
      consent: LATE_FOLDERS,
    });
    await act(async () => undefined);
    expect(rows().length, "the folder lists nothing yet").toBe(0);
    const drawn = document.querySelector('[data-conv-id="b"]') !== null;
    expect(drawn, "the reading column draws the linked letter already").toBe(true);
    layOutLetter("b");
    await dwell(3000);
    expect(sent(mail)).toEqual([]);
  });
});

async function openAllFolders(rail: ReturnType<typeof within>) {
  fireEvent.click(await rail.findByRole("button", { name: "All folders" }));
  return rail.findByRole("tree", { name: "All folders" });
}

describe("the pure derivations behind the rows", () => {
  it("an orphaned path renders as a root (IMAP allows children of non-existent mailboxes)", async () => {
    const orphan = { "folder:orphan-id": folder("orphan-id", "Ghost/Child") };
    const scope = "acct-orphan";
    const letters = [at(10, { folder: "Ghost/Child", unread: true })];
    const mount = (more: Record<string, ReturnType<typeof folder>>) =>
      listSeat({ letters, more, first: "#/ohbox", consent: FOLDERS_ON, mailboxes: FACTS, scope });

    const alone = mount(orphan);
    const soleRail = within(screen.getByRole("navigation", { name: "Places" }));
    expect(await soleRail.findByRole("button", { name: "Child, 1 unread" })).toBeTruthy();
    expect(soleRail.queryByRole("button", { name: "Ghost" })).toBeNull();
    expect(alone.address.read()).toBe("#/ohbox");
    cleanup();

    const { address, mail } = mount({
      ...orphan,
      "folder:projects-id": folder("projects-id", "Projects"),
      "folder:acme-id": folder("acme-id", "Projects/Acme"),
    });
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    const fold = within(await openAllFolders(rail));
    const child = fold.getByRole("button", { name: "Child, 1 unread" });
    const row = child.parentElement!;
    expect(row.style.getPropertyValue("--oh-folderfold-depth")).toBe("");
    expect(
      fold
        .getByRole("button", { name: "Projects" })
        .parentElement!.style.getPropertyValue("--oh-folderfold-depth"),
    ).toBe("");
    expect(fold.queryByRole("button", { name: /^(Ghost|Acme)/ })).toBeNull();
    child.focus();
    fireEvent.click(child);
    expect(address.read()).toBe("#/folder/orphan-id");
    expect(child.getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(child);
    expect(localStorage.getItem(foldersOpenedKey(scope))).toBeNull();
    expect([alone.mail, mail].flatMap(sent)).toEqual([]);
  });

  it("visibleFolderRows hides exactly the closed subtrees", async () => {
    const scope = "acct-fold";
    const { address, mail } = listSeat({
      letters: [],
      more: {
        "folder:a-id": folder("a-id", "A"),
        "folder:b-id": folder("b-id", "A/B"),
        "folder:c-id": folder("c-id", "A/B/C"),
        "folder:z-id": folder("z-id", "Z"),
      },
      first: "#/ohbox",
      consent: FOLDERS_ON,
      mailboxes: FACTS,
      scope,
    });
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    const fold = within(await openAllFolders(rail));
    const names = () =>
      fold
        .getAllByRole("button")
        .filter((row) => !row.hasAttribute("aria-expanded"))
        .map((row) => row.textContent);

    expect(names()).toEqual(["A", "Z"]);
    fireEvent.click(fold.getByRole("button", { name: "Expand A" }));
    expect(names()).toEqual(["A", "B", "Z"]);
    expect(fold.getByRole("button", { name: "Collapse A" }).getAttribute("aria-expanded")).toBe("true");
    expect(fold.getByRole("button", { name: "Expand B" }).getAttribute("aria-expanded")).toBe("false");
    expect(
      fold.getByRole("button", { name: "B" }).parentElement!.style.getPropertyValue("--oh-folderfold-depth"),
    ).toBe("1");
    expect(localStorage.getItem(foldersOpenedKey(scope))).toBe(JSON.stringify(["mb-1|A"]));

    fireEvent.click(fold.getByRole("button", { name: "Expand B" }));
    expect(names()).toEqual(["A", "B", "C", "Z"]);
    fireEvent.click(fold.getByRole("button", { name: "Collapse B" }));
    expect(names()).toEqual(["A", "B", "Z"]);
    fireEvent.click(fold.getByRole("button", { name: "Collapse A" }));
    expect(names()).toEqual(["A", "Z"]);
    expect(localStorage.getItem(foldersOpenedKey(scope))).toBe("[]");
    expect(address.read()).toBe("#/ohbox");
    expect(sent(mail)).toEqual([]);
  });
});

describe("mailbox sections", () => {
  it("two mailboxes are sectioned by address; one mailbox wears no label at all", async () => {
    const first = (await FACTS())[0]!;
    const second = { ...first, id: "mb-2", address: ["secondary", "example.invalid"].join("@") };
    const ownFolders = {
      "folder:project-id": folder("project-id", "Projects"),
      "folder:child-id": folder("child-id", "Projects/Child"),
    };
    const otherFolder = {
      id: "archive-id",
      name: "Archiv",
      mailboxId: second.id,
      mailbox: second.address,
    };
    const { address, mail } = listSeat({
      letters: [],
      more: { ...ownFolders, "folder:archive-id": otherFolder },
      first: "#/ohbox",
      consent: FOLDERS_ON,
      mailboxes: async () => [first, second],
    });
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    const groups = await openAllFolders(rail);
    const tree = within(groups);
    const headings = (element: HTMLElement) =>
      [...element.querySelectorAll(".oh-folderfold-mailbox")].map((node) => node.textContent);
    expect(headings(groups)).toEqual([first.address, second.address]);

    fireEvent.click(tree.getByRole("button", { name: "Projects" }));
    expect(address.read()).toBe("#/folder/project-id");
    fireEvent.click(tree.getByRole("button", { name: "Archiv" }));
    expect(address.read()).toBe("#/folder/archive-id");
    expect(tree.getByRole("button", { name: "Archiv" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(rail.getByRole("button", { name: "All folders" }));
    expect(rail.queryByRole("tree", { name: "All folders" })).toBeNull();
    expect(headings(await openAllFolders(rail))).toEqual([first.address, second.address]);
    expect(address.read()).toBe("#/folder/archive-id");
    expect(sent(mail)).toEqual([]);

    cleanup();
    listSeat({
      letters: [],
      more: ownFolders,
      first: "#/ohbox",
      consent: FOLDERS_ON,
      mailboxes: FACTS,
    });
    const oneRail = within(screen.getByRole("navigation", { name: "Places" }));
    const one = await openAllFolders(oneRail);
    expect(one.querySelectorAll(".oh-folderfold-group")).toHaveLength(1);
    expect(one.querySelector(".oh-folderfold-mailbox")).toBeNull();
  });
});

describe("ordering", () => {
  it("siblings sort alphabetically, numeric-aware, case-insensitive", async () => {
    const names = [
      "Steuern 2010",
      "zebra",
      "Steuern 2009",
      "Archiv",
      "Archiv/Child",
      "steuern 2",
      "Steuern 11",
    ];
    const more = Object.fromEntries(
      names.map((name, index) => [`folder:f${index}`, folder(`f${index}`, name)]),
    );
    const { address, mail } = listSeat({
      letters: [],
      more,
      first: "#/ohbox",
      consent: FOLDERS_ON,
      mailboxes: FACTS,
    });
    const rail = within(screen.getByRole("navigation", { name: "Places" }));
    const tree = within(await openAllFolders(rail));
    const siblings = tree.getAllByRole("button").filter((button) => !button.hasAttribute("aria-expanded"));
    expect(siblings.map((button) => button.textContent)).toEqual([
      "Archiv",
      "steuern 2",
      "Steuern 11",
      "Steuern 2009",
      "Steuern 2010",
      "zebra",
    ]);
    expect(address.read()).toBe("#/ohbox");
    expect(sent(mail)).toEqual([]);
  });
});

describe("the rail and the review keep theirs under the scope the shell hands them", () => {
  it("a folder branch opened under A while the storage owner names B is A's", async () => {
    const a = "acc-A1";
    const b = "acc-B2";
    const mailboxId = "mb1";
    const aKey = foldersOpenedKey(a);
    const bKey = foldersOpenedKey(b);
    const aBranch = "mb1|Projects";
    const aValue = JSON.stringify([aBranch]);
    const bValue = JSON.stringify(["mb1|Invoices"]);
    const more = Object.fromEntries(
      ["Projects", "Projects/Acme", "Invoices", "Invoices/Billing"].map((name, index) => {
        const id = `f${index}`;
        return [`folder:${id}`, { ...folder(id, name), mailboxId }];
      }),
    );
    const mountOwner = async (scope: string) => {
      const seated = listSeat({
        letters: [],
        more,
        first: "#/ohbox",
        consent: FOLDERS_ON,
        mailboxes: async () => (await FACTS()).map((fact) => ({ ...fact, id: mailboxId })),
        scope,
      });
      const rail = within(screen.getByRole("navigation", { name: "Places" }));
      const tree = within(await openAllFolders(rail));
      return { ...seated, tree };
    };

    const jar = window.localStorage;
    const stored = jar.getItem.bind(jar);
    jar.setItem(bKey, bValue);
    setStorageOwner(b);
    const reads = vi.spyOn(Storage.prototype, "getItem");
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const removes = vi.spyOn(Storage.prototype, "removeItem");
    const folderWrites = () =>
      writes.mock.calls.filter(([key]) => key.startsWith("ohmail.ui.rail.foldersOpened."));

    try {
      const first = await mountOwner(a);
      expect(storageOwner()).toBe(b);
      expect(first.tree.queryByRole("button", { name: "Billing" })).toBeNull();
      expect(first.tree.queryByRole("button", { name: "Acme" })).toBeNull();
      fireEvent.click(first.tree.getByRole("button", { name: "Expand Projects" }));
      await settle();
      expect(first.tree.getByRole("button", { name: "Acme" })).toBeTruthy();
      expect(first.address.read()).toBe("#/ohbox");
      cleanup();

      const again = await mountOwner(a);
      expect(again.tree.getByRole("button", { name: "Acme" })).toBeTruthy();
      expect(again.tree.queryByRole("button", { name: "Billing" })).toBeNull();
      expect(again.address.read()).toBe("#/ohbox");
      cleanup();

      expect(stored(aKey)).toBe(aValue);
      expect(stored(bKey)).toBe(bValue);
      expect(Object.keys(jar).filter((key) => stored(key)?.includes(aBranch))).toEqual([aKey]);
      expect(reads.mock.calls.some(([key]) => key === aKey)).toBe(true);
      expect(reads.mock.calls.some(([key]) => key === bKey)).toBe(false);
      expect(folderWrites()).toEqual([[aKey, aValue]]);
      expect(removes.mock.calls.some(([key]) => key === bKey)).toBe(false);

      setStorageOwner(a);
      reads.mockClear();
      writes.mockClear();
      removes.mockClear();
      const other = await mountOwner(b);
      expect(storageOwner()).toBe(a);
      expect(other.tree.getByRole("button", { name: "Billing" })).toBeTruthy();
      expect(other.tree.queryByRole("button", { name: "Acme" })).toBeNull();
      expect(other.address.read()).toBe("#/ohbox");
      cleanup();

      expect(reads.mock.calls.some(([key]) => key === bKey)).toBe(true);
      expect(reads.mock.calls.some(([key]) => key === aKey)).toBe(false);
      expect(folderWrites()).toEqual([]);
      expect(removes.mock.calls.some(([key]) => key === aKey)).toBe(false);
      expect(stored(aKey)).toBe(aValue);
      expect(stored(bKey)).toBe(bValue);
      expect([first.mail, again.mail, other.mail].flatMap(sent)).toEqual([]);
    } finally {
      reads.mockRestore();
      writes.mockRestore();
      removes.mockRestore();
      resetStorageOwnerForTest();
    }
  });
});

describe("first level only, and the opened-set", () => {
  it("navigating to a nested folder opens its ancestors", async () => {
    const a = "acct-tree-a";
    const b = "acct-tree-b";
    const aKey = foldersOpenedKey(a);
    const bKey = foldersOpenedKey(b);
    const projects = JSON.stringify(["mb-1|Projects"]);
    const nested = "#/folder/year-id";
    const mount = async (scope: string, first: string) => {
      const seated = listSeat({
        scope,
        first,
        letters: [],
        consent: FOLDERS_ON,
        mailboxes: FACTS,
        more: {
          "folder:projects-id": folder("projects-id", "Projects"),
          "folder:acme-id": folder("acme-id", "Projects/Acme"),
          "folder:year-id": folder("year-id", "Projects/Acme/2026"),
        },
      });
      const rail = within(screen.getByRole("navigation", { name: "Places" }));
      const tree = within(await openAllFolders(rail));
      const names = () =>
        tree
          .getAllByRole("button")
          .filter((row) => !row.hasAttribute("aria-expanded"))
          .map((row) => row.textContent);
      return { ...seated, names, tree };
    };

    localStorage.setItem(bKey, projects);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const branchWrites = () => writes.mock.calls.filter(([key]) => key === aKey || key === bKey);
    try {
      const arrival = await mount(a, nested);
      expect(arrival.names()).toEqual(["Projects", "Acme", "2026"]);
      expect(arrival.tree.getByRole("button", { name: "2026" }).getAttribute("aria-current")).toBe("page");
      expect(branchWrites()).toEqual([]);

      fireEvent.click(arrival.tree.getByRole("button", { name: "Collapse Projects" }));
      await settle();
      expect(arrival.names()).toEqual(["Projects"]);
      expect(arrival.address.read()).toBe(nested);
      fireEvent.click(arrival.tree.getByRole("button", { name: "Expand Projects" }));
      expect(arrival.names()).toEqual(["Projects", "Acme", "2026"]);
      expect(localStorage.getItem(aKey)).toBe(projects);
      fireEvent.click(arrival.tree.getByRole("button", { name: "Collapse Projects" }));
      expect(arrival.names()).toEqual(["Projects"]);
      expect(branchWrites()).toEqual([
        [aKey, "[]"],
        [aKey, projects],
        [aKey, "[]"],
      ]);

      act(() => arrival.address.visit("#/ohbox"));
      expect(arrival.names()).toEqual(["Projects"]);
      act(() => arrival.address.visit(nested));
      expect(arrival.names()).toEqual(["Projects", "Acme", "2026"]);
      expect(branchWrites()).toHaveLength(3);
      cleanup();

      const homeA = await mount(a, "#/ohbox");
      expect(homeA.names()).toEqual(["Projects"]);
      cleanup();
      const homeB = await mount(b, "#/ohbox");
      expect(homeB.names()).toEqual(["Projects", "Acme"]);
      expect(localStorage.getItem(aKey)).toBe("[]");
      expect(localStorage.getItem(bKey)).toBe(projects);
      expect(branchWrites()).toHaveLength(3);
      expect([arrival.mail, homeA.mail, homeB.mail].flatMap(sent)).toEqual([]);
    } finally {
      writes.mockRestore();
    }
  });

  it("a fresh boot renders roots alone; opening a branch reveals its children and persists", async () => {
    const more = {
      "folder:invoices-id": folder("invoices-id", "Invoices"),
      "folder:projects-id": folder("projects-id", "Projects"),
      "folder:acme-id": folder("acme-id", "Projects/Acme"),
      "folder:year-id": folder("year-id", "Projects/Acme/2026"),
    };
    const mountFolderTree = async (scope: string) => {
      const { address, mail } = listSeat({
        letters: [],
        more,
        first: "#/ohbox",
        consent: FOLDERS_ON,
        mailboxes: FACTS,
        scope,
      });
      const rail = within(screen.getByRole("navigation", { name: "Places" }));
      const tree = within(await openAllFolders(rail));
      const names = () =>
        tree
          .getAllByRole("button")
          .filter((row) => !row.hasAttribute("aria-expanded"))
          .map((row) => row.textContent);
      return { address, mail, names, tree };
    };

    const owner = "acct-1";
    const other = "acct-2";
    const retiredKey = "ohmail.ui.rail.foldersOpened";
    window.localStorage.setItem(retiredKey, JSON.stringify(["mb-1|Projects"]));
    setStorageOwner(other);
    try {
      const first = await mountFolderTree(owner);
      expect(first.names()).toEqual(["Invoices", "Projects"]);
      fireEvent.click(first.tree.getByRole("button", { name: "Expand Projects" }));
      expect(first.names()).toEqual(["Invoices", "Projects", "Acme"]);
      expect(first.address.read()).toBe("#/ohbox");
      cleanup();

      const switched = await mountFolderTree(other);
      expect(switched.names()).toEqual(["Invoices", "Projects"]);
      cleanup();

      const again = await mountFolderTree(owner);
      expect(again.names()).toEqual(["Invoices", "Projects", "Acme"]);
      expect(again.tree.queryByRole("button", { name: "2026" })).toBeNull();
      expect(window.localStorage.getItem(foldersOpenedKey(owner))).toBe(JSON.stringify(["mb-1|Projects"]));
      expect(window.localStorage.getItem(foldersOpenedKey(other))).toBeNull();
      expect(window.localStorage.getItem(retiredKey)).toBeNull();
      fireEvent.click(again.tree.getByRole("button", { name: "Acme" }));
      expect(again.address.read()).toBe("#/folder/acme-id");
      expect([first.mail, switched.mail, again.mail].flatMap(sent)).toEqual([]);
    } finally {
      resetStorageOwnerForTest();
    }
  });
});
