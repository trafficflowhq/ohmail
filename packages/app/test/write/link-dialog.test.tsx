/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { ComposerMarks } from "@ohmail/ui/mail";
import { TextProvider } from "../../src/text/index.js";
import { richEditor } from "../../src/write/editor/index.js";
import type { EditorHandle } from "../../src/write/ports.js";
import { useMarks } from "../../src/write/text/Marks.js";
import writeEn from "../../messages/write.en.json" with { type: "json" };

const words = writeEn.write;
const Editor = richEditor({ href: (href) => href, useRendered: () => {} });

function Write() {
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const marks = useMarks(handle, true);
  return (
    <>
      {marks.strip && <ComposerMarks {...marks.strip} />}
      <Editor
        value={{ text: "", html: "" }}
        label={words.text}
        placeholder={words.placeholder}
        editable
        focusAtMount={false}
        onChange={() => {}}
        onSendKey={() => {}}
        onLeaveKey={() => {}}
        onHandle={setHandle}
      />
      {marks.card}
    </>
  );
}

afterEach(cleanup);

function mount() {
  render(
    <TextProvider locale="en" messages={writeEn as never} timeZone="Europe/Zurich">
      <Write />
    </TextProvider>,
  );
}

it("announces Link as a dialog opener and reports whether the dialog is open", () => {
  mount();
  const link = screen.getByRole("button", { name: words.marks.link });
  expect(link.hasAttribute("aria-pressed")).toBe(false);
  expect(link.getAttribute("aria-haspopup")).toBe("dialog");
  expect(link.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(link);
  expect(link.getAttribute("aria-expanded")).toBe("true");
  const dialog = screen.getByRole("dialog", { name: words.link.title });
  fireEvent.keyDown(within(dialog).getByRole("textbox", { name: words.link.field }), { key: "Escape" });
  expect(link.getAttribute("aria-expanded")).toBe("false");
});

it("puts the keys in the address field when the editor opens Link", () => {
  mount();
  const editor = screen.getByRole("textbox", { name: words.text });
  editor.focus();
  fireEvent.keyDown(editor, { key: "k", metaKey: true, ctrlKey: true });
  const dialog = screen.getByRole("dialog", { name: words.link.title });
  expect(document.activeElement === within(dialog).getByRole("textbox", { name: words.link.field })).toBe(
    true,
  );
});
