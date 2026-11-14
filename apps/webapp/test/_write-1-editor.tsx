/**
 * WRITE's EDITOR, MOUNTED AS WRITE MOUNTS IT (share write-1 of the older tests' sorting): the rich editor of
 * `@ohmail/app/write/editor` inside the kit's `Composer`, its marks drawn by Write's own strip (`useMarks`), the
 * link asked in Write's card, the words from Write's catalogue. It hands back the same handles today's editor's
 * cases read (`editor`, `surface`, `buttons`, `button`, the lock, a value from outside), each found the way a
 * person finds it: the text box by its role, the marks by the strip's role and their names.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { Composer } from "@ohmail/ui/mail";
import { TextProvider } from "@ohmail/app/text";
import { richEditor } from "@ohmail/app/write/editor";
import { useMarks } from "../../../packages/app/src/write/text/Marks.js";
import type { EditorHandle } from "../../../packages/app/src/write/ports.js";
import type { RichValue } from "@ohmail/app-logic/writing/rich-text";
import writeEn from "../../../packages/app/messages/write.en.json" with { type: "json" };

export const WRITE_WORDS = writeEn.write;

export interface MountedEditor {
  readonly host: HTMLElement;
  readonly emitted: RichValue[];
  readonly value: RichValue;
  /** The Tiptap editor behind the text box (ProseMirror's view stamps it on its own element). */
  editor(): Editor;
  /** The text box, by its role. */
  surface(): HTMLElement;
  /** The marks of Write's strip, in its drawn order. */
  buttons(): HTMLButtonElement[];
  button(label: string): HTMLButtonElement;
  setEditable(editable: boolean): void;
  setValue(value: RichValue): void;
  /** The keys the editor handed to the screen: Mod+Enter ("send") and an Escape it did not take ("leave"). */
  readonly keys: string[];
  unmount(): void;
}

const ACCEPT = (raw: string): string | null => {
  try {
    const url = new URL(raw);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
};
const RICH = richEditor({ href: ACCEPT, useRendered: () => undefined });

/** Mounts Write's rich editor named `label`, on `initial`. */
export function mountWriteEditor(initial: RichValue, label = "Reply"): MountedEditor {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const emitted: RichValue[] = [];
  const keys: string[] = [];
  let current = initial;
  let lock: (editable: boolean) => void = () => undefined;
  let replace: (value: RichValue) => void = () => undefined;
  const Editor = RICH;
  function Screen() {
    const [value, setValue] = React.useState<RichValue>(initial);
    const [editable, setEditable] = React.useState(true);
    const [held, setHeld] = React.useState<EditorHandle | null>(null);
    current = value;
    lock = setEditable;
    replace = setValue;
    const marks = useMarks(held, editable);
    return (
      <>
        <Composer label="New message" head={null} marks={marks.strip} foot={{ label: WRITE_WORDS.foot, format: marks.format }}>
          <Editor
            value={value}
            onChange={(next) => {
              emitted.push(next);
              setValue(next);
            }}
            label={label}
            placeholder={WRITE_WORDS.placeholder}
            editable={editable}
            focusAtMount={false}
            onSendKey={() => keys.push("send")}
            onLeaveKey={() => keys.push("leave")}
            onHandle={setHeld}
          />
        </Composer>
        {marks.card}
      </>
    );
  }
  const root: Root = createRoot(host);
  act(() => {
    root.render(
      <TextProvider locale="en" messages={{ write: WRITE_WORDS } as never} timeZone="Europe/Zurich">
        <Screen />
      </TextProvider>,
    );
  });
  const surface = (): HTMLElement => {
    const found = [...host.querySelectorAll<HTMLElement>('[role="textbox"]')].filter(
      (el) => el.getAttribute("aria-label") === label,
    );
    if (found.length !== 1) throw new Error(`expected one text box named "${label}", found ${found.length}`);
    return found[0]!;
  };
  const strip = (): HTMLElement | null => host.querySelector<HTMLElement>(`[role="toolbar"][aria-label="${WRITE_WORDS.marks.bar}"]`);
  return {
    host,
    emitted,
    keys,
    get value() {
      return current;
    },
    editor: () => {
      const editor = (surface() as unknown as { editor?: Editor }).editor;
      if (!editor) throw new Error("no Tiptap editor on the text box");
      return editor;
    },
    surface,
    buttons: () => [...(strip()?.querySelectorAll<HTMLButtonElement>("button") ?? [])],
    button: (name: string) => {
      const hit = [...(strip()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
        (b) => b.getAttribute("aria-label") === name,
      );
      if (!hit) throw new Error(`no mark named "${name}" on the strip`);
      return hit;
    },
    setEditable: (editable) => act(() => lock(editable)),
    setValue: (value) => act(() => replace(value)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** Write's link card, by its role and name: the dialog the strip's Link opens (or null). */
export function linkCard(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"]')].find(
      (el) => el.getAttribute("aria-label") === WRITE_WORDS.link.title,
    ) ?? null
  );
}
