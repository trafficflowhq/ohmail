/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OhmailEngine, threadOf, type EngineAdapter } from "@ohmail/client-engine";
import { enableDesktopAttachments } from "../../webapp/app/shell/open-attachment.js";
import { useMessageAttachments } from "../../webapp/app/shell/attachments.js";
import { MessageChromeProvider } from "../../webapp/app/shell/message-chrome.js";
import { MessageFiles } from "../../webapp/app/shell/MessageFiles.js";
import { AttachmentPreview } from "../../webapp/app/components/AttachmentPreview.js";
import { KeymapProvider } from "../../webapp/app/shell/keymap.js";

/**
 * THE DESKTOP OPENS AN ATTACHMENT IN THE PREVIEW THE WEB SHOWS, AND DOWNLOAD SAVES IT.
 *
 * Owner-reported: on the desktop a press on a PDF saved it into Downloads where the web opens its
 * preview. The window armed (`enableDesktopAttachments`), a shell that records every command, the
 * strip as every reading pane renders it (`MessageFiles`) and the overlay as `AppShell` mounts it.
 * A PDF and a picture open the preview; the strip's corner control and the preview's Download save
 * through the shell; a zip and an SVG still save on the press; Esc closes and lets go of what the
 * shell staged. A save from the preview leaves what it shows alone, as the web's download does: the
 * PDF keeps its page and is parsed once, a refused save is said at the press. pdf.js stands in as
 * the web suite's does: it cannot run in jsdom.
 */

const pdfLoads = vi.fn();
/** How many pages the stand-in document has; read when a document is loaded. */
let pdfPages = 1;
/* The real library is spread under the stand-in (`mock-factory-census.test.ts`), and its module
   initialisation reads `DOMMatrix`, which jsdom lacks; nothing here draws with it. */
(globalThis as unknown as { DOMMatrix?: unknown }).DOMMatrix ??= class DOMMatrix {};
vi.mock("pdfjs-dist", async () => {
  const real = await vi.importActual<typeof import("pdfjs-dist")>("pdfjs-dist");
  const page = {
    getViewport: () => ({ width: 600, height: 800 }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  };
  return {
    ...real,
    // A seam, as the window's own module is: the overlay hands it the load.
    seam: true,
    getDocument: () => {
      pdfLoads();
      return { promise: Promise.resolve({ numPages: pdfPages, getPage: async () => page }), destroy: async () => {} };
    },
  };
});

for (const [name, read] of [
  ["text", (fr: FileReader, b: Blob) => fr.readAsText(b)],
  ["arrayBuffer", (fr: FileReader, b: Blob) => fr.readAsArrayBuffer(b)],
] as const) {
  if (typeof (Blob.prototype as unknown as Record<string, unknown>)[name] !== "function") {
    (Blob.prototype as unknown as Record<string, () => Promise<unknown>>)[name] = function (this: Blob) {
      return new Promise((ok, no) => {
        const fr = new FileReader();
        fr.onload = () => ok(fr.result);
        fr.onerror = () => no(fr.error);
        read(fr, this);
      });
    };
  }
}
(HTMLCanvasElement.prototype as unknown as { getContext: () => null }).getContext = () => null;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
const h = React.createElement;

const PDF = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d01";
const PNG = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d02";
const ZIP = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d03";
const SVG = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d04";
const FILES = [
  { id: PDF, filename: "Invoice.pdf", contentType: "application/pdf" },
  { id: PNG, filename: "Photo.png", contentType: "image/png" },
  { id: ZIP, filename: "Archive.zip", contentType: "application/zip" },
  { id: SVG, filename: "Logo.svg", contentType: "image/svg+xml" },
];
/** The shell's handle for one staged file: 32 hex characters, nothing secret. */
const STAGED = "0123456789abcdef".repeat(2);

type Invoked = { command: string; payload?: Record<string, unknown> };
let invoked: Invoked[] = [];
let fetched: string[] = [];
/** What the shell answers `save_attachment` with; a case that holds the save replaces it. */
let saveAnswer: () => Promise<unknown> = () => Promise.resolve(null);
/** What the press said: the toasts `AppShell` speaks for a save. */
let said: Array<{ saved?: number; refused?: [string, number] }> = [];
const shell = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } };

beforeAll(() => {
  enableDesktopAttachments();
});

function engineOverFakeAdapter(): OhmailEngine {
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => FILES.map((f) => ({ ...f, sizeBytes: 2048, inline: false, messageId: "m1" })),
    fetchAttachment: async (id: string) => {
      fetched.push(id);
      return new Blob(["%PDF-1.4"], { type: FILES.find((f) => f.id === id)!.contentType });
    },
  };
  return new OhmailEngine({ adapter });
}

/** The reading pane's strip and `AppShell`'s overlay mount, over one engine. */
function Desktop({ engine }: { engine: OhmailEngine }) {
  const attachments = useMessageAttachments(engine, "m1", {
    conversationOf: (id: string) => threadOf(engine.read(), id),
    onDownloadAllFailed: () => {},
    onSavedToDownloads: (count) => said.push({ saved: count }),
    onSaveRefused: (why, count) => said.push({ refused: [why, count] }),
  });
  const [previewFor, setPreviewFor] = useState<{ messageId: string; attachmentId: string } | null>(null);
  const chrome = {
    attachments,
    openAttachmentPreview: (messageId: string, attachmentId: string) => setPreviewFor({ messageId, attachmentId }),
    conversationOf: () => [],
  };
  const overlay = (() => {
    if (!previewFor || !attachments) return null;
    const view = attachments.itemsOf(previewFor.messageId, { includeInlineParts: true });
    const previewItems = view.state === "ready" ? view.items : [];
    if (previewItems.length === 0) return null;
    return h(AttachmentPreview, {
      key: previewFor.messageId,
      items: previewItems,
      activeId: previewFor.attachmentId,
      onActiveIdChange: (id: string) => setPreviewFor({ messageId: previewFor.messageId, attachmentId: id }),
      ensure: (aid: string, opts?: { retry?: boolean }) => attachments.ensure(previewFor.messageId, aid, opts),
      blobOf: (aid: string) => attachments.blobOf(previewFor.messageId, aid),
      onDownload: (aid: string) => attachments.open(previewFor.messageId, aid),
      onClose: () => setPreviewFor(null),
      onRelease: () => attachments.releasePreviews(previewFor.messageId),
    });
  })();
  return h(MessageChromeProvider as never, { value: chrome }, h(MessageFiles, { messageId: "m1" }), overlay);
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  invoked = [];
  fetched = [];
  said = [];
  pdfPages = 1;
  saveAnswer = () => Promise.resolve(null);
  pdfLoads.mockClear();
  shell.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      invoked.push({ command, payload });
      if (command === "stage_attachment_preview") return { url: `attachment-preview://localhost/${STAGED}`, token: STAGED, size: 2048 };
      if (command === "save_attachment") return saveAnswer();
      return null;
    },
  };
  (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => "blob:tauri://localhost/obj";
  (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = () => {};
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  delete shell.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** Until `done` holds or the bound: pdf.js is imported on the first PDF, which takes its time. */
async function until(done: () => boolean, ms = 8_000): Promise<void> {
  for (let waited = 0; waited < ms && !done(); waited += 20) {
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
}

// A loaded runner can take longer than the default 5 s over a mount, a press and a module load.
vi.setConfig({ testTimeout: 15_000 });

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(h(KeymapProvider, null, h(Desktop, { engine: engineOverFakeAdapter() }))));
  await settle();
  expect(host.querySelectorAll("button.att-tile"), "the strip never drew the four files").toHaveLength(4);
}

const tile = (name: string) => host!.querySelector<HTMLButtonElement>(`button.att-tile[title$="${name}"]`);
const corner = (name: string) => host!.querySelector<HTMLButtonElement>(`button.att-side[aria-label="Download ${name}"]`);
const dialog = () => document.querySelector('[role="dialog"]');
const previewDownload = () =>
  [...document.querySelectorAll<HTMLButtonElement>(".ap-head button.ap-btn")].find((b) => b.textContent?.includes("Download")) ?? null;
const saves = () => invoked.filter((i) => i.command === "save_attachment");
const pageLine = () => (document.querySelector(".ap-meta")?.textContent ?? "").match(/\d+ \/ \d+/)?.[0] ?? null;
const nextPage = () => document.querySelector<HTMLButtonElement>('.ap-pager button[aria-label="Next page"]');
const previewSays = () => document.querySelector(".ap-content")?.textContent ?? "";
const canvas = () => document.querySelector("canvas.ap-canvas");

async function press(el: HTMLElement | null): Promise<void> {
  expect(el, "the control is not on screen").not.toBeNull();
  await act(async () => el!.click());
  await settle();
}

/** Hold the next `save_attachment` until the case answers it, as a slow mail server would. */
function holdSave(): { resolve: (value: unknown) => void; reject: (err: unknown) => void } {
  const gate = { resolve: (_value: unknown) => {}, reject: (_err: unknown) => {} };
  saveAnswer = () => new Promise((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
  return gate;
}

/** A three-page PDF open in the preview, turned to its last page. */
async function pdfOnPageThree(): Promise<void> {
  pdfPages = 3;
  await mount();
  await press(tile("Invoice.pdf"));
  await until(() => pageLine() === "1 / 3");
  await press(nextPage());
  await press(nextPage());
  expect(pageLine()).toBe("3 / 3");
}

describe("on the desktop, a PDF opens in the preview the web shows", () => {
  it("a PDF tile press opens the preview over bytes fetched once, and saves nothing", async () => {
    await mount();
    await press(tile("Invoice.pdf"));
    expect(dialog(), "the press saved the PDF instead of opening the preview").not.toBeNull();
    expect(fetched).toEqual([PDF]);
    expect(saves()).toEqual([]);
    expect(invoked.filter((i) => i.command === "stage_attachment_preview"), "a PDF was staged on disk").toEqual([]);
    await until(() => document.querySelector("canvas.ap-canvas") !== null);
    expect(pdfLoads).toHaveBeenCalledTimes(1);
    expect(document.querySelector("canvas.ap-canvas"), "the PDF never reached the canvas").not.toBeNull();
  });

  it("the PDF tile's corner Download saves it through the shell, once, by id and name", async () => {
    await mount();
    await press(corner("Invoice.pdf"));
    expect(saves()).toEqual([{ command: "save_attachment", payload: { attachmentId: PDF, filename: "Invoice.pdf" } }]);
    expect(dialog()).toBeNull();
  });

  it("the PDF preview's own Download saves it through the shell", async () => {
    await mount();
    await press(tile("Invoice.pdf"));
    await press(previewDownload());
    expect(saves()).toEqual([{ command: "save_attachment", payload: { attachmentId: PDF, filename: "Invoice.pdf" } }]);
  });
});

describe("a save from the preview leaves what it shows alone, as the web's download does", () => {
  it("the PDF stays on its page while the shell saves and after: one parse, no wait, Saved", async () => {
    const save = holdSave();
    await pdfOnPageThree();
    await press(previewDownload());
    expect(saves()).toHaveLength(1);
    expect(canvas(), "the save took the PDF off the screen").not.toBeNull();
    expect(previewSays(), "the preview said it was fetching while the shell saved").not.toMatch(/Fetching/);
    expect(previewDownload()!.getAttribute("aria-busy"), "the preview's Download does not say it is saving").toBe("true");
    expect(previewDownload()!.getAttribute("aria-disabled")).toBe("true");
    expect(tile("Invoice.pdf")!.getAttribute("aria-busy"), "the tile does not say it is saving").toBe("true");
    expect(corner("Invoice.pdf")!.getAttribute("aria-disabled"), "the corner Download stayed pressable").toBe("true");
    expect(tile("Invoice.pdf")!.getAttribute("aria-disabled"), "the look at a part on screen went inert").toBeNull();
    await act(async () => save.resolve(null));
    await settle();
    expect(pageLine(), "the save sent the reader back to page 1").toBe("3 / 3");
    expect(pdfLoads, "the save parsed the PDF again").toHaveBeenCalledTimes(1);
    expect(fetched).toEqual([PDF]);
    expect(said).toEqual([{ saved: 1 }]);
    expect(previewDownload()!.getAttribute("aria-busy")).toBeNull();
    expect(tile("Invoice.pdf")!.getAttribute("aria-busy")).toBeNull();
    expect(corner("Invoice.pdf")!.getAttribute("aria-disabled")).toBeNull();
  });

  it("a save the engine refuses keeps the PDF on screen and is said at the press", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const save = holdSave();
    await pdfOnPageThree();
    await press(previewDownload());
    await act(async () => save.reject({ status: 502, code: "upstream_unavailable", message: "The mail server did not answer.", retryable: true }));
    await settle();
    expect(canvas(), "the refusal replaced the PDF").not.toBeNull();
    expect(previewSays()).not.toMatch(/Couldn't fetch/);
    expect(pageLine()).toBe("3 / 3");
    expect(pdfLoads).toHaveBeenCalledTimes(1);
    expect(fetched, "the refusal fetched bytes the window holds again").toEqual([PDF]);
    expect(said).toEqual([{ refused: ["not-saved", 1] }]);
  });

  it("a save the shell refuses keeps the PDF on screen and says why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const save = holdSave();
    await pdfOnPageThree();
    await press(previewDownload());
    await act(async () => save.reject("ohmail: this computer named no Downloads folder"));
    await settle();
    expect(canvas()).not.toBeNull();
    expect(pageLine()).toBe("3 / 3");
    expect(pdfLoads).toHaveBeenCalledTimes(1);
    expect(said).toEqual([{ refused: ["no-downloads-folder", 1] }]);
  });

  it("the picture stays on screen through a save and through a refused one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let save = holdSave();
    await mount();
    await press(tile("Photo.png"));
    await press(previewDownload());
    expect(document.querySelector("img.ap-img"), "the save took the picture off the screen").not.toBeNull();
    await act(async () => save.resolve(null));
    await settle();
    save = holdSave();
    await press(previewDownload());
    await act(async () => save.reject({ status: 404, code: "not_found", message: "gone", retryable: true }));
    await settle();
    expect(document.querySelector("img.ap-img")?.getAttribute("src")).toBe(`attachment-preview://localhost/${STAGED}`);
    expect(invoked.filter((i) => i.command === "stage_attachment_preview"), "the picture was staged again").toHaveLength(1);
    expect(said).toEqual([{ saved: 1 }, { refused: ["not-saved", 1] }]);
  });

  it("control: a second Download while the shell saves is not a second save", async () => {
    const save = holdSave();
    await pdfOnPageThree();
    await press(previewDownload());
    await press(previewDownload());
    await press(corner("Invoice.pdf"));
    expect(saves()).toHaveLength(1);
    await act(async () => save.resolve(null));
    await settle();
    expect(said).toEqual([{ saved: 1 }]);
  });
});

describe("the rest of the desktop's attachment presses, unchanged", () => {
  it("a picture opens the preview from the shell's staged file, and saves nothing", async () => {
    await mount();
    await press(tile("Photo.png"));
    expect(dialog()).not.toBeNull();
    expect(invoked).toEqual([{ command: "stage_attachment_preview", payload: { attachmentId: PNG, mimeType: "image/png" } }]);
    expect(fetched, "a picture's bytes were fetched into the window").toEqual([]);
    expect(document.querySelector("img.ap-img")?.getAttribute("src")).toBe(`attachment-preview://localhost/${STAGED}`);
  });

  it("the preview's own Download saves the picture on screen through the shell", async () => {
    await mount();
    await press(tile("Photo.png"));
    await press(previewDownload());
    expect(saves()).toEqual([{ command: "save_attachment", payload: { attachmentId: PNG, filename: "Photo.png" } }]);
  });

  it("a zip and an SVG save on the press and open no preview", async () => {
    await mount();
    await press(tile("Archive.zip"));
    await press(tile("Logo.svg"));
    expect(dialog()).toBeNull();
    expect(saves().map((s) => s.payload)).toEqual([
      { attachmentId: ZIP, filename: "Archive.zip" },
      { attachmentId: SVG, filename: "Logo.svg" },
    ]);
    expect(fetched).toEqual([]);
  });

  it("Escape closes the preview and lets go of what the shell staged", async () => {
    await mount();
    await press(tile("Photo.png"));
    expect(dialog()).not.toBeNull();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();
    expect(dialog()).toBeNull();
    expect(invoked.filter((i) => i.command === "release_attachment_preview")).toEqual([
      { command: "release_attachment_preview", payload: { token: STAGED } },
    ]);
  });
});

describe("AppShell mounts the overlay this file copies", () => {
  it("with the seam's ensure, blobOf, open as its Download, and the release", () => {
    let shellSource: string;
    try {
      shellSource = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");
    } catch {
      shellSource = readFileSync(resolve(process.cwd(), "../webapp/app/shell/AppShell.tsx"), "utf8");
    }
    const from = shellSource.indexOf("<AttachmentPreview");
    expect(from, "AppShell no longer mounts <AttachmentPreview>").toBeGreaterThan(-1);
    const mountBlock = shellSource.slice(from, shellSource.indexOf("/>", from));
    expect(mountBlock).toMatch(/ensure=\{\(aid, opts\) => attachments\.ensure\(previewFor\.messageId, aid, opts\)\}/);
    expect(mountBlock).toMatch(/blobOf=\{\(aid\) => attachments\.blobOf\(previewFor\.messageId, aid\)\}/);
    expect(mountBlock).toMatch(/onDownload=\{\(aid\) => attachments\.open\(previewFor\.messageId, aid\)\}/);
    expect(mountBlock).toMatch(/onRelease=\{\(\) => attachments\.releasePreviews\(previewFor\.messageId\)\}/);
  });
});
