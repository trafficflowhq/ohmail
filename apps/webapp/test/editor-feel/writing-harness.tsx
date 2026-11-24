import type { Editor as TiptapEditor } from "@tiptap/react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { TextProvider } from "@ohmail/app/text";
import { richEditor } from "@ohmail/app/write/editor";
import { EMPTY_RICH, type RichValue } from "@ohmail/app-logic/writing/rich-text";
import { linkHref, useRenderedLinks } from "@ohmail/letter-body/links";
import { Composer, Sheet } from "@ohmail/ui/mail";
import messages from "../../../../packages/app/messages/write.en.json";
import type { EditorHandle } from "../../../../packages/app/src/write/ports";
import { useMarks } from "../../../../packages/app/src/write/text/Marks";

const Editor = richEditor({ href: linkHref, useRendered: useRenderedLinks });
const height = Number(new URLSearchParams(location.search).get("height") ?? "220");

declare global {
  interface Window {
    __rte: { editor: TiptapEditor | null; value: RichValue; changes: number };
  }
}

window.__rte = {
  get editor() {
    const box = document.querySelector<HTMLElement & { editor?: TiptapEditor }>('[role="textbox"][aria-label="Reply"]');
    return box?.editor ?? null;
  },
  value: EMPTY_RICH,
  changes: 0,
};

function Writing() {
  const [value, setValue] = useState<RichValue>(EMPTY_RICH);
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const marks = useMarks(handle, true);
  return (
    <>
      <section style={{ height, display: "flex", flexDirection: "column" }}>
        <Sheet kind="reading" label="Reading">
          <Composer reply label="Reply" head={null} marks={marks.strip} foot={{ label: messages.write.foot, format: marks.format }}>
            <Editor
              value={value}
              onChange={(next) => {
                window.__rte.value = next;
                window.__rte.changes += 1;
                setValue(next);
              }}
              label="Reply"
              placeholder={messages.write.reply.placeholder}
              editable
              focusAtMount={false}
              onHandle={setHandle}
              onSendKey={() => {}}
              onLeaveKey={() => {}}
            />
          </Composer>
          {marks.card}
        </Sheet>
      </section>
      <output aria-label="Editor value">{JSON.stringify(value)}</output>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TextProvider locale="en" messages={messages} timeZone="UTC">
      <Writing />
    </TextProvider>
  </StrictMode>,
);
