/** @vitest-environment jsdom */
import type { EngineMutation } from "@ohmail/wire";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeyBindings, useKeymap, type BoundKey } from "@ohmail/app-logic/keys";
import type { ListVisit } from "@ohmail/app-logic/reading";
import type { PaneProps, PlaceEntry } from "../../src/frame/contract.js";
import { readerEntry } from "../../src/reader/index.js";
import type { Messages } from "../../src/text/index.js";
import { FRAME_WORDS } from "../support/frame-words.js";
import doorsEn from "../../messages/doors.en.json" with { type: "json" };
import ohboxEn from "../../messages/ohbox.en.json" with { type: "json" };
import readerEn from "../../messages/reader.en.json" with { type: "json" };
import screenerEn from "../../messages/screener.en.json" with { type: "json" };
import sharedEn from "../../messages/shared.en.json" with { type: "json" };
import trashEn from "../../messages/trash.en.json" with { type: "json" };
import { bodyDouble, freshRecord, letter, mountReader, READER_PLACE } from "./support/mail.js";

/**
 * THE COLUMN'S KEYS while it has the keyboard: `u` presses the read slot, `r` answers. Never from a field, never with
 * a modifier, never with nothing open, never while the column does not have the keys. They are declared in the key
 * map's registry, which listens on the document: a key reaches them pressed anywhere in it.
 */

const reads = (mutations: readonly EngineMutation[]) => mutations.filter((m) => m.kind === "mark_seen");

beforeEach(() => {
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the column's keys", () => {
  it("u presses the read slot", () => {
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
    act(() => {
      fireEvent.keyDown(document.body, { key: "u" });
    });
    expect(reads(mail.mutations)).toMatchObject([{ messageIds: ["m1"], unread: false }]);
  });

  it("r hands a reply to write, and nothing is sent", () => {
    const { mail, address } = mountReader({ letters: [letter("m1")], open: "m1" });
    expect(screen.getByRole("button", { name: "Reply" }).getAttribute("aria-keyshortcuts")).toBe("r");
    act(() => {
      fireEvent.keyDown(document.body, { key: "r" });
    });
    expect(address.read()).toBe("#/compose");
    expect(mail.mutations).toEqual([]);
  });

  it("neither fires from a field, from editable text, or with a modifier", () => {
    const { mail, address } = mountReader({
      letters: [letter("m1")],
      open: "m1",
      children: (
        <>
          <input aria-label="a field" />
          <textarea aria-label="a text" />
          <div aria-label="editable" role="textbox" contentEditable suppressContentEditableWarning />
        </>
      ),
    });
    /* jsdom reports no text a person edits (`isContentEditable`), which the registry reads: the box says it as a
       browser does. */
    Object.defineProperty(screen.getByRole("textbox", { name: "editable" }), "isContentEditable", {
      value: true,
    });
    for (const name of ["a field", "a text", "editable"]) {
      const at = screen.getByRole("textbox", { name });
      act(() => {
        fireEvent.keyDown(at, { key: "u" });
        fireEvent.keyDown(at, { key: "r" });
      });
    }
    for (const mod of ["ctrlKey", "metaKey", "altKey"]) {
      act(() => {
        fireEvent.keyDown(document.body, { key: "u", [mod]: true });
        fireEvent.keyDown(document.body, { key: "r", [mod]: true });
      });
    }
    expect(mail.mutations).toEqual([]);
    expect(address.read()).toBe("#/ohbox/m/m1");
  });

  it("with nothing open nothing fires", () => {
    const { mail, address } = mountReader({ letters: [letter("m1")], open: null });
    act(() => {
      fireEvent.keyDown(document.body, { key: "u" });
      fireEvent.keyDown(document.body, { key: "r" });
    });
    expect(mail.mutations).toEqual([]);
    expect(address.read()).toBe("#/ohbox");
  });

  it("a column that does not have the keys binds none", () => {
    const parts = {
      body: bodyDouble().body,
      files: "none",
      pictures: "none",
      look: "none",
      sentCopy: "none",
      reply: "none",
      invitation: "none",
    } as const;
    const entry = readerEntry(parts);
    /* The list beside it draws a second column, without the keys, on the letter it holds. */
    function List(pane: PaneProps) {
      return <entry.Reading {...pane} route={{ ...pane.route, open: "m1" }} keysHere={false} />;
    }
    const { mail } = mountReader({
      letters: [letter("m1")],
      open: null,
      host: {
        reader: entry,
        places: { ohbox: { ...READER_PLACE, panes: { kind: "columns", List, Reading: "reader" } } },
      },
    });
    expect(screen.getByRole("button", { name: "Mark read" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reply" }).hasAttribute("aria-keyshortcuts")).toBe(false);
    act(() => {
      fireEvent.keyDown(document.body, { key: "u" });
    });
    expect(reads(mail.mutations)).toEqual([]);
  });
});

describe("the column's keys in the key map's registry", () => {
  /** What the registry publishes, read as the key sheet reads it, after every change of a layer. */
  let table: readonly BoundKey[] = [];
  function Table() {
    table = useKeymap().bindings;
    return null;
  }
  const visitOf = (openId: string): ListVisit => ({
    openId,
    unread: false,
    readSet: [],
    act: vi.fn(),
    wiring: { look: "tint", record: freshRecord(), onRead: vi.fn(), onEnter: vi.fn(), onMarkUnread: vi.fn() },
    step: {
      up: { disabled: false, run: vi.fn(), label: "Previous message" },
      down: { disabled: false, run: vi.fn(), label: "Next message" },
    },
  });
  /** A place whose list binds keys of its own, as every list does: `x`, and the walk and read keys where it says. */
  function placeBinding(walk: boolean) {
    function OwnList() {
      const step = { group: "navigate" as const, run: () => undefined };
      useKeyBindings([
        { chord: "x", group: "message", label: "Select the message", run: () => undefined },
        ...(walk
          ? [
              { ...step, chord: "j", label: "Next message" },
              { ...step, chord: "k", label: "Previous message" },
              { chord: "u", group: "message" as const, label: "Mark unread", run: () => undefined },
            ]
          : []),
      ]);
      return <p>the list</p>;
    }
    const panes = { kind: "columns" as const, List: OwnList, Reading: "reader" as const };
    return { ...READER_PLACE, panes };
  }
  const times = (chord: string) => table.filter((b) => b.chord === chord).length;
  const LETTER = ["r", "shift+r", "shift+f", "a", "e", "b", "m", "d", "Backspace", "Delete"];
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      fireEvent.keyDown(document.body, { key, ...init });
    });

  it("where no list handed a visit: the column's own u and the letter's ten verbs, each once beside the list's own", () => {
    const place = placeBinding(false);
    mountReader({
      letters: [letter("m1")],
      open: "m1",
      host: { places: { ohbox: place } },
      children: <Table />,
    });
    expect([...LETTER, "u", "x", "j", "k"].map(times)).toEqual([...LETTER.map(() => 1), 1, 1, 0, 0]);
    const reply = table.find((b) => b.chord === "r");
    expect(reply).toMatchObject({ group: "message", label: "Reply inside the message" });
    expect(table.find((b) => b.chord === "shift+f")).toMatchObject({ label: "Forward the message on" });
    expect(table.find((b) => b.chord === "Backspace")).toMatchObject({ label: "Move it to Trash" });
    const move = table.find((b) => b.chord === "m");
    expect(move, "no list's visit: nothing to move to").toMatchObject({ disabled: true });
  });

  it("where the list handed its visit, j, k and u are the list's: the column binds none of them", () => {
    const visit = visitOf("m1");
    mountReader({
      letters: [letter("m1")],
      open: "m1",
      meeting: { visit, blank: null },
      host: { places: { ohbox: placeBinding(true) } },
      children: <Table />,
    });
    expect(["j", "k", "u", "x"].map(times), "the list's own, each once").toEqual([1, 1, 1, 1]);
    expect(table.find((b) => b.chord === "u")).toMatchObject({ label: "Mark unread" });
    expect(LETTER.map(times), "the letter's verbs, each once").toEqual(LETTER.map(() => 1));
    expect(table.find((b) => b.chord === "m")?.disabled, "the list offers moves").toBeFalsy();
  });

  it("with nothing open the letter's verbs rest for want of a cursor, listed and inert", () => {
    const { mail } = mountReader({ letters: [letter("m1")], open: null, children: <Table /> });
    const resting = LETTER.map((chord) => table.find((b) => b.chord === chord));
    const why = resting.map((b) => [b?.disabled, b?.disabledReason]);
    expect(why).toEqual(LETTER.map(() => [true, "no_cursor"]));
    press("a");
    press("Backspace");
    expect(mail.mutations).toEqual([]);
  });

  it("each of the letter's keys does what its button does, on the list's path", () => {
    const visit = visitOf("m1");
    const cc = [{ address: "pia@example.invalid", name: "Pia" }];
    mountReader({
      letters: [letter("m1", { cc })],
      open: "m1",
      meeting: { visit, blank: null },
      children: <Table />,
    });
    press("a");
    press("e");
    press("F", { shiftKey: true });
    press("R", { shiftKey: true });
    press("Backspace");
    const acted = vi.mocked(visit.act).mock.calls.map(([a]) => a);
    expect(acted).toEqual(["later", "aside", "forward", "reply_all", "delete"]);
    press("m");
    expect(screen.getByRole("menu", { name: "Move" })).toBeTruthy();
    press("m");
    press("d");
    const more = screen.getByRole("menu", { name: "More" });
    expect(within(more).getByRole("menuitem", { name: "Delete" })).toBeTruthy();
  });

  it("b on a letter with no booking books at once, on the list's path, and opens no chooser", () => {
    const visit = visitOf("m1");
    mountReader({ letters: [letter("m1")], open: "m1", meeting: { visit, blank: null } });
    press("b");
    expect(vi.mocked(visit.act).mock.calls.map(([a]) => a)).toEqual(["resurface"]);
    expect(screen.queryByRole("menu", { name: "Resurface" })).toBeNull();
  });

  it("b on a letter with no booking and no list's visit books tomorrow at the hour, through the seam", () => {
    const { mail } = mountReader({ letters: [letter("m1")], open: "m1" });
    press("b");
    const booked = mail.mutations.filter((m) => m.kind === "triage_set");
    expect(booked).toMatchObject([{ messageId: "m1", state: "bubbled_up" }]);
    const when = booked[0]?.kind === "triage_set" ? booked[0].bubbleUpAt : null;
    expect(Number.isNaN(Date.parse(when ?? "")), "the return carries its instant").toBe(false);
    expect(Date.parse(when ?? "") > Date.now(), "and it is ahead").toBe(true);
    expect(screen.queryByRole("menu", { name: "Resurface" })).toBeNull();
  });

  it("b on a booked letter opens the chooser its button opens, and closes it again", () => {
    const visit = visitOf("m1");
    const at = "2026-11-10T09:00:00.000Z";
    const triage = {
      messageId: "m1",
      state: "bubbled_up" as const,
      bubbleUpAt: "2026-12-01T08:00:00.000Z",
      setAt: at,
      updatedAt: at,
    };
    mountReader({ letters: [letter("m1", { triage })], open: "m1", meeting: { visit, blank: null } });
    press("b");
    expect(screen.getByRole("menu", { name: "Resurface" })).toBeTruthy();
    expect(vi.mocked(visit.act), "nothing is booked over the booking").not.toHaveBeenCalled();
    press("b");
    expect(screen.queryByRole("menu", { name: "Resurface" })).toBeNull();
  });

  it("a held key is one press: Backspace's repeat moves nothing more", () => {
    const visit = visitOf("m1");
    mountReader({ letters: [letter("m1")], open: "m1", meeting: { visit, blank: null } });
    press("Backspace");
    press("Backspace", { repeat: true });
    press("d", { repeat: true });
    expect(vi.mocked(visit.act).mock.calls.map(([a]) => a)).toEqual(["delete"]);
  });
});

describe("the column's keys in the key map's registry", () => {
  /** What the registry publishes, read as the key sheet reads it. */
  let table: readonly BoundKey[] = [];
  function Table() {
    table = useKeymap().bindings;
    return null;
  }
  const COLUMN = ["j", "k", "r", "u"];
  const bound = () =>
    table
      .map((b) => b.chord)
      .filter((c) => COLUMN.includes(c) || c === "z")
      .sort();
  const visitOf = (openId: string): ListVisit => ({
    openId,
    unread: false,
    readSet: [],
    act: vi.fn(),
    wiring: { look: "tint", record: freshRecord(), onRead: vi.fn(), onEnter: vi.fn(), onMarkUnread: vi.fn() },
    step: {
      up: { disabled: false, run: vi.fn(), label: "Previous message" },
      down: { disabled: false, run: vi.fn(), label: "Next message" },
    },
  });
  /** The letter's verbs by key: the column binds them while it has the keys, and lists them resting with nothing open. */
  const LETTER_KEYS = ["r", "shift+r", "shift+f", "a", "e", "b", "m", "d", "Backspace", "Delete"];
  /** The list that handed its visit binds its own `j`, `k` and `u`, as every list does: the column binds none of them. */
  function ListsOwnKeys() {
    useKeyBindings([
      { chord: "j", group: "navigate", label: "Next message", run: () => undefined },
      { chord: "k", group: "navigate", label: "Previous message", run: () => undefined },
      { chord: "u", group: "message", label: "Mark unread", run: () => undefined },
    ]);
    return <p>the list</p>;
  }
  const LISTING: PlaceEntry = {
    ...READER_PLACE,
    panes: { kind: "columns", List: ListsOwnKeys, Reading: "reader" },
  };
  /** With nothing open the letter's `r` rests for want of a cursor: listed, never live. */
  const resting = () => table.filter((b) => b.chord === "r");
  /** A place that draws its own, where the room is off. */
  const TODAY: PlaceEntry = {
    id: "news",
    body: "today",
    rail: null,
    panes: { kind: "wide", Wide: () => <p>today</p> },
  };

  it("j, k, u and r stand there, each once, while the column has the keys; with nothing open r rests and none acts", () => {
    /* j, k and u are the list's that handed the visit (the seat's key table: the column binds none of them). */
    const { address } = mountReader({
      letters: [letter("m1")],
      open: "m1",
      meeting: { visit: visitOf("m1"), blank: null },
      host: { places: { ohbox: LISTING } },
      children: <Table />,
    });
    expect(bound()).toEqual([...COLUMN, "z"]);
    expect(table.find((b) => b.chord === "j")).toMatchObject({ group: "navigate", label: "Next message" });
    act(() => address.write("#/ohbox", "push"));
    expect(resting()).toMatchObject([{ disabled: true, disabledReason: "no_cursor" }]);
  });

  it("a column that does not have the keys puts none there", () => {
    const parts = {
      body: bodyDouble().body,
      files: "none",
      pictures: "none",
      look: "none",
      sentCopy: "none",
      reply: "none",
      invitation: "none",
    } as const;
    const entry = readerEntry(parts);
    function List(pane: PaneProps) {
      return <entry.Reading {...pane} route={{ ...pane.route, open: "m1" }} keysHere={false} />;
    }
    mountReader({
      letters: [letter("m1")],
      open: null,
      host: {
        reader: entry,
        places: { ohbox: { ...READER_PLACE, panes: { kind: "columns", List, Reading: "reader" } } },
      },
      children: <Table />,
    });
    expect(screen.getByRole("button", { name: "Mark read" })).toBeTruthy();
    /* The column with nothing open lists the letter's r resting; the one without the keys adds none. */
    expect(bound()).toEqual(["r", "z"]);
    expect(resting()).toMatchObject([{ disabled: true, disabledReason: "no_cursor" }]);
  });

  it("are named in the words a page of the reader holds: over that catalogue, none is missing", () => {
    const said = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      /* What a page that draws the reader hands, as the reader's states page does: the reader's place, the shared
         words, the frame's, and the places whose sentences the room's seam says. No other place's. */
      const words = [FRAME_WORDS.en, sharedEn, ohboxEn, screenerEn, trashEn, doorsEn, readerEn];
      mountReader({
        letters: [letter("m1")],
        open: "m1",
        meeting: { visit: visitOf("m1"), blank: null },
        words: Object.assign({}, ...words) as Messages,
        children: <Table />,
      });
      /* With the list's visit the column binds the letter's verbs (j, k and u are the list's) and the room its z. */
      const named = table.filter((b) => LETTER_KEYS.includes(b.chord) || b.chord === "z");
      expect(named.map((b) => b.chord).sort()).toEqual([...LETTER_KEYS, "z"].sort());
      expect(named.filter((b) => b.label === "")).toEqual([]);
      expect(said.mock.calls.flat().join("\n")).not.toMatch(/MISSING_MESSAGE/);
    } finally {
      said.mockRestore();
    }
  });

  it("z stands there while the room's seam stands, which is the frame's life: the column's keys leave on a walk, z stays", () => {
    const { address } = mountReader({
      letters: [letter("m1")],
      open: "m1",
      host: { places: { ohbox: READER_PLACE, news: TODAY } },
      children: <Table />,
    });
    expect(table.filter((b) => b.chord === "z")).toMatchObject([{ group: "app" }]);
    act(() => address.visit("#/reads"));
    expect(screen.getByText("today")).toBeTruthy();
    /* A host that hands a reader keeps the room's own seam for the frame's life (the mail ground's ruling, S-2). */
    expect(bound()).toEqual(["z"]);
    act(() => address.visit("#/ohbox"));
    expect(bound()).toEqual(["r", "z"]);
    expect(resting()).toMatchObject([{ disabled: true, disabledReason: "no_cursor" }]);
  });
});
