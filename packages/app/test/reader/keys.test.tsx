/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineMutation } from "@ohmail/client-engine";
import type { PaneProps } from "../../src/frame/contract.js";
import { readerEntry } from "../../src/reader/index.js";
import { bodyDouble, letter, mountReader, READER_PLACE } from "./support/mail.js";

/**
 * THE COLUMN'S KEYS while it has the keyboard: `u` presses the read slot, `r` answers. Never from a field, never with
 * a modifier, never with nothing open, never while the column does not have the keys.
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
      fireEvent.keyDown(window, { key: "u" });
    });
    expect(reads(mail.mutations)).toMatchObject([{ messageIds: ["m1"], unread: false }]);
  });

  it("r hands a reply to write, and nothing is sent", () => {
    const { mail, address } = mountReader({ letters: [letter("m1")], open: "m1" });
    act(() => {
      fireEvent.keyDown(window, { key: "r" });
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
    for (const name of ["a field", "a text", "editable"]) {
      const at = screen.getByRole("textbox", { name });
      act(() => {
        fireEvent.keyDown(at, { key: "u" });
        fireEvent.keyDown(at, { key: "r" });
      });
    }
    for (const mod of ["ctrlKey", "metaKey", "altKey"]) {
      act(() => {
        fireEvent.keyDown(window, { key: "u", [mod]: true });
        fireEvent.keyDown(window, { key: "r", [mod]: true });
      });
    }
    expect(mail.mutations).toEqual([]);
    expect(address.read()).toBe("#/ohbox/m/m1");
  });

  it("with nothing open nothing fires", () => {
    const { mail, address } = mountReader({ letters: [letter("m1")], open: null });
    act(() => {
      fireEvent.keyDown(window, { key: "u" });
      fireEvent.keyDown(window, { key: "r" });
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
      reply: "none",
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
      fireEvent.keyDown(window, { key: "u" });
    });
    expect(reads(mail.mutations)).toEqual([]);
  });
});
