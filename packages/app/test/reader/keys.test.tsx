/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeymap, type BoundKey } from "@ohmail/app-logic/keys";
import type { ListVisit } from "@ohmail/app-logic/reading";
import type { EngineMutation } from "@ohmail/client-engine";
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
 * a modifier, never with nothing open, never while the column does not have the keys. They are bindings of the key
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
    act(() => {
      fireEvent.keyDown(document.body, { key: "u" });
    });
    expect(reads(mail.mutations)).toEqual([]);
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
  /** A place that draws its own, where the room is off. */
  const TODAY: PlaceEntry = {
    id: "news",
    body: "today",
    rail: null,
    panes: { kind: "wide", Wide: () => <p>today</p> },
  };

  it("j, k, u and r stand there, each once, while the column has the keys; with nothing open they are gone", () => {
    const { address } = mountReader({
      letters: [letter("m1")],
      open: "m1",
      meeting: { visit: visitOf("m1"), blank: null },
      children: <Table />,
    });
    expect(bound()).toEqual([...COLUMN, "z"]);
    expect(table.find((b) => b.chord === "j")).toMatchObject({ group: "navigate", label: "Next message" });
    act(() => address.write("#/ohbox", "push"));
    expect(bound()).toEqual(["z"]);
  });

  it("a column that does not have the keys puts none there", () => {
    const parts = {
      body: bodyDouble().body,
      files: "none",
      pictures: "none",
      look: "none",
      sentCopy: "none",
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
    expect(bound()).toEqual(["z"]);
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
      const named = table.filter((b) => COLUMN.includes(b.chord) || b.chord === "z");
      expect(named.map((b) => b.chord).sort()).toEqual([...COLUMN, "z"]);
      expect(named.filter((b) => b.label === "")).toEqual([]);
      expect(said.mock.calls.flat().join("\n")).not.toMatch(/MISSING_MESSAGE/);
    } finally {
      said.mockRestore();
    }
  });

  it("z stands there while the room's seam stands, and leaves with it", () => {
    const { address } = mountReader({
      letters: [letter("m1")],
      open: "m1",
      host: { places: { ohbox: READER_PLACE, news: TODAY } },
      children: <Table />,
    });
    expect(table.filter((b) => b.chord === "z")).toMatchObject([{ group: "app" }]);
    act(() => address.visit("#/reads"));
    expect(screen.getByText("today")).toBeTruthy();
    expect(bound()).toEqual([]);
    act(() => address.visit("#/ohbox"));
    expect(bound()).toEqual(["z"]);
  });
});
