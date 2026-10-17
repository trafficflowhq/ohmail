/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OhmailEngine, threadOf, type EngineAdapter } from "@ohmail/client-engine";
import { useMessageAttachments } from "../../webapp/app/shell/attachments.js";
import { enableDesktopAttachments } from "../../webapp/app/shell/open-attachment.js";
import { AttachmentPreview } from "../../webapp/app/components/AttachmentPreview.js";
import { KeymapProvider } from "../../webapp/app/shell/keymap.js";

/**
 * MORE PICTURES THAN THE SHELL KEEPS, AND BACK TO THE FIRST, AND IT SHOWS. The overlay walks more
 * staged images than the shell keeps, wraps to the first, and the `<img>` must name a URL the shell
 * still serves. The fake shell keeps exactly what `attachment_preview.rs` keeps (PREVIEWS_KEPT,
 * read from the source), so before the window owned the eviction the first picture was a dead URL.
 *
 * Mutation watched: `keepStagedPreview` not evicting → the shell's backstop drops the first → red.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

const SHELL_KEPT = Number(/const PREVIEWS_KEPT: usize = (\d+);/.exec(
  readFileSync(resolve(process.cwd(), "apps/desktop/src-tauri/src/attachment_preview.rs"), "utf8"),
)?.[1]);

/** The shell's table as `attachment_preview.rs` keeps it: FIFO, the oldest out past the cap. */
const served: string[] = [];
let staged = 0;
const stagedFor = new Map<string, number>();
interface Host { __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } }
const host = globalThis as unknown as Host;

beforeEach(() => {
  served.length = 0;
  staged = 0;
  stagedFor.clear();
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command === "stage_attachment_preview") {
        const id = String(payload?.attachmentId);
        stagedFor.set(id, (stagedFor.get(id) ?? 0) + 1);
        const handle = (staged++).toString(16).padStart(32, "0");
        served.push(handle);
        while (served.length > SHELL_KEPT) served.shift();
        return { url: `attachment-preview://localhost/${handle}`, token: handle, size: 9 };
      }
      if (command === "release_attachment_preview") {
        const at = served.indexOf(String(payload?.token));
        if (at >= 0) served.splice(at, 1);
      }
      return null;
    },
  };
});

let root: Root | null = null;
let el: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  el?.remove();
  root = null;
  delete host.__TAURI_INTERNALS__;
});

function Harness({ engine }: { engine: OhmailEngine }) {
  const chrome = useMessageAttachments(engine, "m1", { conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
  const [activeId, setActiveId] = useState("i0");
  const view = chrome?.itemsOf("m1", { includeInlineParts: true });
  const items = view?.state === "ready" ? view.items : [];
  if (!chrome || items.length === 0) return null;
  return h(AttachmentPreview, {
    items, activeId, onActiveIdChange: setActiveId,
    ensure: (aid: string, opts?: { retry?: boolean }) => chrome.ensure("m1", aid, opts),
    blobOf: (aid: string) => chrome.blobOf("m1", aid),
    onDownload: () => {}, onClose: () => {},
  });
}

describe("the desktop preview after more pictures than the shell keeps", () => {
  it("walks them all, wraps to the first, and the first names a URL the shell still serves", async () => {
    enableDesktopAttachments();
    expect(SHELL_KEPT).toBeGreaterThan(0);
    const n = SHELL_KEPT + 1;
    const adapter: EngineAdapter = {
      sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
      listAttachments: async () => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, filename: `${i}.png`, contentType: "image/png", sizeBytes: 9, inline: false, messageId: "m1" })),
      fetchAttachment: async () => { throw new Error("the desktop preview fetched bytes into the window"); },
    };
    const engine = new OhmailEngine({ adapter });
    await engine.loadAttachments("m1");
    el = document.createElement("div");
    document.body.appendChild(el);
    root = createRoot(el);
    await act(async () => root!.render(h(KeymapProvider, null, h(Harness, { engine }))));
    const settle = async () => { for (let i = 0; i < 4; i += 1) await act(async () => {}); };
    await settle();
    for (let i = 0; i < n; i += 1) {
      await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
      await settle();
    }
    const src = el.querySelector("img.ap-img")?.getAttribute("src") ?? "";
    expect(src, "the first picture is not on screen").toMatch(/^attachment-preview:\/\/localhost\/[0-9a-f]{32}$/);
    expect(served, `the first picture names ${src}, which the shell no longer serves`).toContain(src.split("/").pop());
    expect(stagedFor.get("i0"), "the revisit did not stage the first picture again").toBe(2);
  });
});
