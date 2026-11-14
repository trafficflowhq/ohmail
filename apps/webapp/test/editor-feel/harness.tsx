/**
 * THE EDITOR-FEEL HARNESS — the real `RichEditor`, mounted alone in a real browser.
 *
 * The rig drives this page with a REAL keyboard (Playwright `page.keyboard`) on chromium and on
 * webkit, because the two defects it exists for are invisible to jsdom: a caret is a painted thing
 * and a mark boundary is decided while the browser's own editing host inserts the character. The
 * page is the component and nothing else — no shell, no account, no network — mounted as the
 * desktop mounts it (`next-intl` resolved to `use-intl` at build time, over the webapp's catalogue), inside the reply
 * composer's own frame class so the stylesheet that scrolls the surface is the one under test.
 *
 * `window.__rte` hands the rig the editor and the last emitted value; `?frame=` picks the wrapper
 * class (`reply-editor` scrolls the surface itself, `compose-editor` does not), `?height=` its box.
 */
import { StrictMode, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Editor } from "@tiptap/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";
import { RichEditor } from "../../app/shell/RichEditor";
import { EMPTY_RICH, type RichValue } from "@ohmail/app-logic/writing/rich-text";
import "../../app/app.css";

declare global {
  interface Window {
    __rte: { editor: Editor | null; value: RichValue; changes: number };
  }
}

window.__rte = { editor: null, value: EMPTY_RICH, changes: 0 };

const params = new URLSearchParams(location.search);
const frame = params.get("frame") ?? "reply-editor";
const height = Number(params.get("height") ?? "220");

function Harness() {
  const [value, setValue] = useState<RichValue>(EMPTY_RICH);
  const onChange = useCallback((v: RichValue) => {
    window.__rte.value = v;
    window.__rte.changes += 1;
    setValue(v);
  }, []);
  return (
    <NextIntlClientProvider locale="en" messages={messages as never} timeZone="UTC">
      <div className={frame} style={{ height, display: "flex", flexDirection: "column" }}>
        <RichEditor
          value={value}
          onChange={onChange}
          ariaLabel="Reply"
          placeholder="Write a reply"
          editorRef={(e) => { window.__rte.editor = e; }}
        />
      </div>
      <pre id="rte-value" data-testid="rte-value">{JSON.stringify(value)}</pre>
    </NextIntlClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
