/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileLookOf } from "@ohmail/app-logic/reader";
import { useMessageAttachments } from "@ohmail/app-logic/reader/attachments";
import { OhmailEngine, threadOf, type EngineAdapter } from "@ohmail/client-engine";
import { usePdfLook } from "@ohmail/app/host/browser";
import type { ReaderFile, ReaderFiles } from "../../../packages/app/src/reader/ports";
import readerEn from "../../../packages/app/messages/reader.en.json";
import readerDe from "../../../packages/app/messages/reader.de.json";
import { ReaderFilesFixture } from "./fixtures/reader-files";

const originalText = Object.getOwnPropertyDescriptor(Blob.prototype, "text");
const originalArrayBuffer = Object.getOwnPropertyDescriptor(Blob.prototype, "arrayBuffer");

function readBlob(blob: Blob, binary: boolean) {
  return new Promise<string | ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result!);
    reader.onerror = () => reject(reader.error);
    if (binary) reader.readAsArrayBuffer(blob);
    else reader.readAsText(blob);
  });
}

beforeEach(() => {
  const BrowserURL = URL;
  vi.stubGlobal("URL", class extends BrowserURL {
    static createObjectURL = () => "blob:http://localhost/preview-fixture";
    static revokeObjectURL = () => {};
  });
  if (!originalText) Object.defineProperty(Blob.prototype, "text", {
    configurable: true, value(this: Blob) { return readBlob(this, false); },
  });
  if (!originalArrayBuffer) Object.defineProperty(Blob.prototype, "arrayBuffer", {
    configurable: true, value(this: Blob) { return readBlob(this, true); },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (!originalText) Reflect.deleteProperty(Blob.prototype, "text");
  if (!originalArrayBuffer) Reflect.deleteProperty(Blob.prototype, "arrayBuffer");
});

const messageId = "m1";
const look = { usePdf: usePdfLook };

function wire(id: string, over: { filename?: string; contentType?: string; inline?: boolean } = {}) {
  return { id, filename: `${id}.png`, contentType: "image/png", sizeBytes: 1000, inline: false, messageId, ...over };
}

function Reader({ engine }: { engine: OhmailEngine }) {
  const files = useMessageAttachments(engine, null, {
    shell: "none", conversationOf: (id) => threadOf(engine.read(), id), onDownloadAllFailed: () => {},
  });
  return files ? <ReaderFilesFixture files={files} messageId={messageId} look={look} /> : null;
}

function openReader(over: Partial<EngineAdapter> = {}) {
  const engine = new OhmailEngine({
    adapter: {
      sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" }),
      fetchBody: async () => null,
      listAttachments: async () => [wire("a1"), wire("a2"), wire("a3")],
      fetchAttachment: async () => new Blob(["raster fixture"], { type: "image/png" }),
      ...over,
    },
  });
  render(<Reader engine={engine} />);
  return engine;
}

async function preview(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Preview ${name}` }));
  return screen.getByRole("dialog");
}

function press(key: string) {
  fireEvent.keyDown(screen.getByRole("dialog"), { key });
}

function staged(item: Partial<ReaderFile>, locale: "en" | "de" = "en") {
  const open = vi.fn();
  const releasePreviews = vi.fn();
  const files: ReaderFiles = {
    hold: () => () => {},
    itemsOf: () => ({
      state: "ready",
      items: [{ id: "staged", filename: "file.png", mimeType: "image/png",
        sizeBytes: 9, inline: false, state: "ready", ...item }],
    }),
    ensure: vi.fn(),
    open,
    releasePreviews,
    downloadAll: () => {},
    downloadingAll: () => false,
    cidImagesOf: () => new Map(),
    needCidImages: () => {},
  };
  const view = render(<ReaderFilesFixture files={files} messageId={messageId} look={look} locale={locale} />);
  return { ...view, open, releasePreviews };
}

describe("previewKind / isPreviewable — the dispatch that keeps a document from rendering", () => {
  it("renders the four raster images, PDF and text; refuses everything else", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) expect(fileLookOf(mime)).toBe("image");
    expect(fileLookOf("application/pdf")).toBe("pdf");
    expect(fileLookOf("text/plain; charset=utf-8")).toBe("text");
    expect(fileLookOf("text/csv")).toBe("text");
    expect(fileLookOf("image/svg+xml")).toBe("other");
    expect(fileLookOf("application/octet-stream")).toBe("other");
  });
});

describe("an INLINE image opens in the overlay (item 4 — the Webshop PNG)", () => {
  it("clicking a message's only attachment — an inline png — opens the overlay and shows it", async () => {
    const fetchAttachment = vi.fn(async (_id: string) => new Blob(["raster fixture"], { type: "image/png" }));
    openReader({
      listAttachments: async () => [wire("pic", { filename: "pasted.png", inline: true })],
      fetchAttachment,
    });
    await preview("pasted.png");
    const img = await within(screen.getByRole("dialog")).findByRole("img", { name: "pasted.png" });
    expect(img.getAttribute("src")).toContain("blob:");
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });
});

describe("the cost invariant — one connection for the item on screen, never its neighbours", () => {
  const tracked = () => vi.fn(
    async (_id: string) => new Blob(["raster fixture"], { type: "image/png" }),
  );

  it("opens fetching ONLY the active attachment", async () => {
    const fetchAttachment = tracked();
    openReader({ fetchAttachment });
    const dialog = await preview("a1.png");
    await within(dialog).findByRole("img", { name: "a1.png" });
    expect(fetchAttachment.mock.calls.map((args) => args[0])).toEqual(["a1"]);
  });

  it("moving to the next attachment fetches exactly it — two total, never three", async () => {
    const fetchAttachment = tracked();
    openReader({ fetchAttachment });
    await preview("a1.png");
    await within(screen.getByRole("dialog")).findByRole("img", { name: "a1.png" });
    press("ArrowRight");
    await within(screen.getByRole("dialog")).findByRole("img", { name: "a2.png" });
    expect(fetchAttachment.mock.calls.map((args) => args[0])).toEqual(["a1", "a2"]);
  });
});

describe("the type dispatch inside the overlay", () => {
  it("an SVG landed on by ← / → is never fetched — it offers a download", async () => {
    const fetchAttachment = vi.fn(async (_id: string) => new Blob(["raster fixture"], { type: "image/png" }));
    openReader({
      listAttachments: async () => [wire("a1"), wire("s1", { contentType: "image/svg+xml", filename: "x.svg" })],
      fetchAttachment,
    });
    await preview("a1.png");
    press("ArrowRight");
    await act(async () => {});
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("x.svg")).toBeTruthy();
    expect(dialog.getByRole("button", { name: "Download" })).toBeTruthy();
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
    expect(fetchAttachment.mock.calls[0]?.[0]).toBe("a1");
  });

  it("a text part renders as escaped text", async () => {
    openReader({
      listAttachments: async () => [wire("t1", { contentType: "text/plain", filename: "note.txt" })],
      fetchAttachment: async () => new Blob(["hello <b>world</b>"], { type: "text/plain" }),
    });
    const dialog = await preview("note.txt");
    await within(dialog).findByText("hello <b>world</b>");
    const pre = dialog.querySelector("pre")!;
    expect(pre.textContent).toContain("hello <b>world</b>");
    expect(pre.querySelector("b")).toBeNull();
  });
});

describe("the keyboard, through the registry's overlay scope", () => {
  it("Escape closes", async () => {
    openReader();
    await preview("a1.png");
    press("Escape");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("← / → move between attachments and wrap", async () => {
    openReader();
    await preview("a1.png");
    press("ArrowLeft");
    expect(within(screen.getByRole("dialog")).getByText("a3.png")).toBeTruthy();
    press("ArrowRight");
    expect(within(screen.getByRole("dialog")).getByText("a1.png")).toBeTruthy();
  });
});

describe("the desktop's staged preview, from the overlay's side", () => {
  it("a text over the shell's cap says too large and offers the save", () => {
    for (const [locale, words] of [["en", readerEn], ["de", readerDe]] as const) {
      const { unmount, open } = staged({
        filename: "big.log", mimeType: "text/plain", sizeBytes: 40 << 20, previewTooLarge: true,
      }, locale);
      fireEvent.click(screen.getByRole("button", { name: words.attachments.preview.replace("{name}", "big.log") }));
      const dialog = within(screen.getByRole("dialog"));
      const guidance = locale === "en"
        ? "This file is larger than ohmail fetches to show, so download it instead."
        : "Diese Datei ist zu groß für die Vorschau in ohmail. Lade sie stattdessen herunter.";
      expect(dialog.getByText(guidance)).toBeTruthy();
      const heading = dialog.getByRole("status").querySelector(".oh-empty-label")!;
      expect(heading.textContent?.replace(/\.$/, "")).toBe(words.attachmentPreview.tooLargeTitle);
      expect(heading.querySelector(".oh-dot")).not.toBeNull();
      fireEvent.click(dialog.getByRole("button", { name: words.attachmentPreview.download }));
      expect(open.mock.calls).toEqual([[messageId, "staged"]]);
      unmount();
    }

    const { open } = staged({
      filename: "large.png", mimeType: "image/png", sizeBytes: 40 << 20, previewTooLarge: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview large.png" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("This file is larger than ohmail fetches to show, so download it instead.")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "Download" }));
    expect(open.mock.calls).toEqual([[messageId, "staged"]]);
  });

  it("closing the overlay releases what it staged, once", async () => {
    const { unmount, releasePreviews } = staged({ objectUrl: "attachment-preview://localhost/x" });
    const dialog = await preview("file.png");
    expect(within(dialog).getByRole("img", { name: "file.png" }).getAttribute("src"))
      .toBe("attachment-preview://localhost/x");
    expect(releasePreviews).not.toHaveBeenCalled();
    press("Escape");
    expect(releasePreviews.mock.calls).toEqual([[messageId]]);
    unmount();
    expect(releasePreviews.mock.calls).toEqual([[messageId]]);
  });
});

class PdfChannel {
  static latest: PdfChannel | undefined;
  readonly port1 = {
    close: vi.fn(),
    postMessage: vi.fn(),
    onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
  };
  readonly port2 = {};

  constructor() {
    PdfChannel.latest = this;
  }

  async reply(data: unknown) {
    await act(async () => this.port1.onmessage!({ data }));
  }
}

function openPdfs() {
  vi.stubGlobal("MessageChannel", PdfChannel);
  PdfChannel.latest = undefined;
  openReader({
    listAttachments: async () => [
      wire("p1", { contentType: "application/pdf", filename: "first.pdf" }),
      wire("p2", { contentType: "application/pdf", filename: "second.pdf" }),
    ],
    fetchAttachment: async () => new Blob(["%PDF-1.4"], { type: "application/pdf" }),
  });
}

async function connectPdf(name: string) {
  const dialog = within(await preview(name));
  const frame = await dialog.findByTitle(readerEn.attachmentPreview.ariaLabel) as HTMLIFrameElement;
  expect(frame.getAttribute("src")).toBe("/pdf-preview.html");
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  const sent = vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(() => {});
  fireEvent.load(frame);
  const channel = PdfChannel.latest!;
  expect(sent.mock.calls).toEqual([["pdf-preview", "*", [channel.port2]]]);
  await channel.reply("ready");
  await waitFor(() => expect(channel.port1.postMessage).toHaveBeenCalledTimes(1));
  const bytes = channel.port1.postMessage.mock.calls[0]![0] as ArrayBuffer;
  expect(new TextDecoder().decode(bytes)).toBe("%PDF-1.4");
  return { dialog, frame, channel };
}

describe("closing a PDF preview tears the document down without taking the app with it", () => {
  it("THE REGRESSION: the close button does not throw out of the teardown", async () => {
    openPdfs();
    const { dialog, frame, channel } = await connectPdf("first.pdf");
    await channel.reply({ page: 1, total: 1 });
    expect(() => fireEvent.click(dialog.getByRole("button", { name: "Close" }))).not.toThrow();
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(frame.isConnected).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Preview second.pdf" })).toBeTruthy();
  });

  it("Escape takes the same path", async () => {
    openPdfs();
    const { frame, channel } = await connectPdf("first.pdf");
    await channel.reply({ page: 1, total: 1 });
    press("Escape");
    expect(channel.port1.close).toHaveBeenCalledTimes(1);
    expect(frame.isConnected).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Preview second.pdf" })).toBeTruthy();
  });
});

describe("a pdf.js chunk that failed to load", () => {
  it("is asked for again by the next PDF, not refused for the rest of the session", async () => {
    openPdfs();
    const first = await connectPdf("first.pdf");
    await first.channel.reply("failed");
    expect(first.dialog.getByText(readerEn.attachmentPreview.pdfErrorTitle)).toBeTruthy();
    press("Escape");

    const second = await connectPdf("second.pdf");
    expect(second.frame).not.toBe(first.frame);
    expect(second.channel).not.toBe(first.channel);
    await second.channel.reply({ page: 1, total: 1 });
    expect(second.dialog.queryByText(readerEn.attachmentPreview.pdfErrorTitle)).toBeNull();
    expect(second.frame.isConnected).toBe(true);
  });
});
