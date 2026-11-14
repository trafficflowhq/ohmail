/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { OhmailEngine, type EngineAdapter, threadOf } from "@ohmail/client-engine";
import { useMessageAttachments } from "../app/shell/attachments.js";
import { desktopFileShell, enableDesktopAttachments, saveRefusalOf, type SaveRefusal } from "../app/shell/open-attachment.js";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * A DOWNLOAD THE SHELL WOULD NOT SAVE IS SAID AT THE PRESS. On a Linux profile whose
 * user-dirs name no Downloads folder the desktop shell refuses the save, and the press saved
 * nothing and said nothing: the refusal reached the console only. Through the real hook, a real
 * engine and the shell's own rejection, the press now answers with the refusal, and never with the
 * shell's words. Mutations watched red: `open`'s refusal arm dropped; `downloadAll` dropping
 * `onRefused`; `saveRefusalOf` answering `not-saved` for every refusal.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/* jsdom's Blob lacks `arrayBuffer`, which the seam reads the bytes with; every desktop webview has it. */
if (typeof (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
  (Blob.prototype as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = function (this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as ArrayBuffer);
      fr.onerror = () => reject(fr.error);
      fr.readAsArrayBuffer(this);
    });
  };
}

const NO_FOLDER = "ohmail: this computer named no Downloads folder";
const host = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, p?: unknown) => Promise<unknown> } };

function adapter(): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    listAttachments: async () => [
      { id: "a1", filename: "notes.txt", contentType: "text/plain", sizeBytes: 5, inline: false, messageId: "m1" },
    ],
    fetchAttachment: async () => new Blob(["notes"], { type: "text/plain" }),
    fetchAllAttachments: async () => new Blob(["PK"], { type: "application/zip" }),
  } as unknown as EngineAdapter;
}

let chrome: ReturnType<typeof useMessageAttachments>;
let said: Array<{ saved?: number; refused?: [SaveRefusal, number] }>;
function Harness({ engine }: { engine: OhmailEngine }) {
  chrome = useMessageAttachments(engine, "m1", { shell: desktopFileShell(), conversationOf: (id: string) => threadOf(engine.read(), id),
    onDownloadAllFailed: () => {},
    onSavedToDownloads: (count) => said.push({ saved: count }),
    onSaveRefused: (why, count) => said.push({ refused: [why, count] }),
  });
  return null;
}

let root: Root | null = null;
async function mount(shellAnswer: () => Promise<unknown>): Promise<void> {
  said = [];
  host.__TAURI_INTERNALS__ = { invoke: async () => shellAnswer() };
  (globalThis.URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:tauri://localhost/x";
  (globalThis.URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  const el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  await act(async () => root!.render(h(Harness, { engine: new OhmailEngine({ adapter: adapter() }) })));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40 && said.length === 0; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

beforeAll(() => enableDesktopAttachments());
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  delete host.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("a Download the desktop shell would not save", () => {
  it("is said at the press, as the one fact: this computer names no Downloads folder", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mount(() => Promise.reject(NO_FOLDER));
    await act(async () => chrome!.open("m1", "a1"));
    await settle();
    expect(said).toEqual([{ refused: ["no-downloads-folder", 1] }]);
  });

  it("…and Download all says it too, for the files it could not save", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await mount(() => Promise.reject(NO_FOLDER));
    await act(async () => chrome!.downloadAll("m1"));
    await settle();
    expect(said).toEqual([{ refused: ["no-downloads-folder", 1] }]);
  });

  it("any other refusal is 'not saved', never the shell's own words", () => {
    expect(saveRefusalOf(NO_FOLDER)).toBe("no-downloads-folder");
    expect(saveRefusalOf(new Error(NO_FOLDER))).toBe("no-downloads-folder");
    expect(saveRefusalOf("ohmail: this file could not be saved (Permission denied (os error 13))")).toBe("not-saved");
  });

  it("the control: a save that lands says Saved, and no refusal", async () => {
    await mount(() => Promise.resolve("/home/me/Downloads/notes.txt"));
    await act(async () => chrome!.open("m1", "a1"));
    await settle();
    expect(said).toEqual([{ saved: 1 }]);
  });

  it("both catalogues carry the sentences, and neither quotes the shell", () => {
    const keys = ["toastSaveNoDownloads", "toastSaveRefused"] as const;
    for (const cat of [en, de] as unknown as Array<{ ohbox: Record<string, string> }>) {
      for (const k of keys) {
        expect(cat.ohbox[k], k).toBeTruthy();
        expect(cat.ohbox[k]).not.toContain("ohmail:");
      }
    }
    expect(en.ohbox.toastSaveNoDownloads).toContain("Downloads folder");
  });
});
