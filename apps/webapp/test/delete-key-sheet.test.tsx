/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { act, cleanup, screen, within } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import en from "../messages/en.json";
import { useKeyBindings } from "@ohmail/app-logic/keys/keymap";
import { deleteKeyBindings } from "@ohmail/app-logic/press/delete-undo";
import { mountOvers, press } from "../../../packages/app/test/overs/over-world.js";

/**
 * THE `?` SHEET LISTS BACKSPACE AND DELETE AS ONE ROW, moved here from `delete-key.test.tsx` (its other key cases run
 * there, over the frame's registry): the key sheet is an over of the frame (`keySheetOver`), handed by Search's
 * mount. Over the frame's own test world with the sheet handed (`mountOvers`), opened as a person opens it, by `?`.
 */

const message = {
  id: "m1",
  accountId: "a1",
  mailboxId: "mb1",
  threadId: "t1",
  folder: "INBOX",
  subject: "The invoice",
  from: { address: "someone@example.invalid", name: "Someone" },
  to: [],
  date: "2026-09-04T09:00:00.000Z",
  unread: true,
  updatedAt: "2026-09-04T09:00:00.000Z",
} as unknown as EngineMessage;

function Place(): React.ReactNode {
  useKeyBindings(
    deleteKeyBindings({ focused: message, label: en.shortcuts.deleteKey, canDelete: true, run: () => {} }),
    "global",
  );
  return null;
}

afterEach(() => cleanup());

describe("the keys", () => {
  it("the `?` sheet lists it ONCE, with both keycaps", () => {
    Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
    mountOvers(() => <Place />);
    act(() => press("?"));
    const sheet = screen.getByRole("dialog", { name: /Keyboard shortcuts/ });
    const rows = within(sheet).queryAllByText(en.shortcuts.deleteKey).map((label) => label.parentElement!);
    expect(rows).toHaveLength(1);
    expect([...rows[0]!.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["⌫", "⌦"]);
  });
});
