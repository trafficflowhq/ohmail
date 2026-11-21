/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act as rtlAct, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter } from "@ohmail/client-engine";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import type { SaveRefusal } from "@ohmail/app-logic/reader/attachments";
import { enableDesktopAttachments } from "../../webapp/app/shell/open-attachment.js";
import { letter } from "../../webapp/test/_reader-1-letters.js";
import { en as messages } from "../../../test/support/web-catalogues.js";
import { DesktopFrame } from "../src/DesktopFrame.js";
import { linkSlot } from "../src/link-in.js";

/**
 * THE DESKTOP OPENS AN ATTACHMENT IN THE PREVIEW THE WEB SHOWS, AND DOWNLOAD SAVES IT.
 *
 * DesktopFrame supplies the real reader and its native file wiring over a fixture mirror and a
 * shell that records attachment commands.
 * A PDF and a picture open the preview; the strip's corner control and the preview's Download save
 * through the shell; a zip and an SVG still save on the press; Esc closes and lets go of what the
 * shell staged. A save from the preview leaves what it shows alone, as the web's download does: the
 * PDF keeps its page and is parsed once, a refused save is said at the press. pdf.js stands in as
 * the web suite's does: it cannot run in jsdom.
 */

const pdfLoads = vi.fn();
let pdfPages = 1;
/** The only part jsdom stands in for is the sealed renderer on the other end of the transferred port. */
class PreviewChannel {
  readonly port1 = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    close: () => { this.port1.onmessage = null; },
    postMessage: (data: unknown) => {
      if (typeof data !== "number") pdfLoads(data);
      this.reply({ page: typeof data === "number" ? data : 1, total: pdfPages });
    },
  };
  readonly port2 = { start: () => this.reply("ready") };
  private reply(data: unknown) {
    queueMicrotask(() => this.port1.onmessage?.({ data }));
  }
}

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

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const act = rtlAct as unknown as (cb: () => Promise<void> | void) => Promise<void>;
const h = React.createElement;

type SaveReport = { saved: number } | { refused: [SaveRefusal, number] };
let saveReports: SaveReport[];

vi.mock("@ohmail/app-logic/reader/attachments", async () => {
  const actual = await vi.importActual<typeof import("@ohmail/app-logic/reader/attachments")>("@ohmail/app-logic/reader/attachments");
  const useMessageAttachments: typeof actual.useMessageAttachments = (engine, messageId, opts) =>
    actual.useMessageAttachments(engine, messageId, {
      ...opts,
      onSavedToDownloads: (count) => {
        saveReports.push({ saved: count });
        opts.onSavedToDownloads?.(count);
      },
      onSaveRefused: (reason, count) => {
        saveReports.push({ refused: [reason, count] });
        opts.onSaveRefused?.(reason, count);
      },
    });
  return { ...actual, useMessageAttachments };
});

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
const shell = globalThis as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> } };

beforeAll(() => {
  enableDesktopAttachments();
});

async function engineOverFakeAdapter(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{
    type: "message", op: "create", seq: 1, id: "m1",
    updatedAt: letterWithAttachments.updatedAt, entity: letterWithAttachments,
  }]);
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "1", hasMore: false, serverTime: letterWithAttachments.updatedAt }),
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => FILES.map((f) => ({ ...f, sizeBytes: 2048, inline: false, messageId: "m1" })),
    fetchAttachment: async (id: string) => {
      fetched.push(id);
      return new Blob(["%PDF-1.4"], { type: FILES.find((f) => f.id === id)!.contentType });
    },
  };
  return new OhmailEngine({ adapter, store, storePolicy: { mode: "full" } });
}

/** The letter that carries the four files. */
const letterWithAttachments = letter("m1", { hasAttachments: true, attachmentCount: 4, unread: false });

beforeEach(() => {
  saveReports = [];
  invoked = [];
  fetched = [];
  pdfPages = 1;
  saveAnswer = () => Promise.resolve(null);
  pdfLoads.mockClear();
  vi.stubGlobal("MessageChannel", PreviewChannel);
  shell.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (["stage_attachment_preview", "release_attachment_preview", "save_attachment"].includes(command))
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
  cleanup();
  window.history.replaceState(null, "", "/");
  delete shell.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  const engine = await engineOverFakeAdapter();
  window.history.replaceState(null, "", "#/ohbox/m/m1");
  const idle = () => undefined;
  render(h(IntlProvider, { locale: "en", messages, timeZone: "UTC",
    children: h(ThemeProvider, {
      children: h(ToastHost, { children: h(DesktopFrame, {
        engine, status: { state: "serving", mode: "local", mailboxId: "mb-1" },
        session: "live", sessionRefused: false, sealFailed: false, paired: false, hostLabel: null,
        freshness: null, account: null, storage: null, mayLinkOut: true, manageOffered: false,
        withdrawManage: idle, rereadAccess: idle, reuseSweeps: [], recheckSweeps: async () => undefined,
        ai: null, setAi: idle, onStatus: idle, openOverlay: idle, takeOver: idle,
        firstRunOpen: false, firstRun: undefined, takesMailLinks: true, scope: "mb-1",
        onUnread: idle, liveBody: async () => ({ kind: "refused", reason: "gone" } as const),
        links: linkSlot(), connection: { read: () => null, subscribe: () => idle },
      }) }),
    }),
  }));
  await settle();
  for (const f of FILES) expect(tile(f.filename), `the letter never drew ${f.filename}`).not.toBeNull();
}

const tile = (name: string): HTMLButtonElement | null => {
  const preview = messages.attachments.preview.replace("{name}", name);
  const download = messages.attachments.download.replace("{name}", name);
  return screen.queryByRole<HTMLButtonElement>("button", { name: preview }) ??
    screen.queryAllByRole<HTMLButtonElement>("button", { name: download })
      .find((control) => within(control).queryByText(name, { exact: true }) !== null) ?? null;
};
const corner = (name: string): HTMLButtonElement | null =>
  screen.queryByRole("button", { name: messages.attachments.download.replace("{name}", name) });
const dialog = () => screen.queryByRole("dialog");
const previewDownload = (): HTMLButtonElement | null =>
  (dialog() === null ? null : within(dialog()!).queryByRole("button", { name: "Download" })) as HTMLButtonElement | null;
const saves = () => invoked.filter((i) => i.command === "save_attachment");
const pageLine = () => (dialog()?.textContent ?? "").match(/\d+ \/ \d+/)?.[0] ?? null;
const nextPage = (): HTMLButtonElement | null =>
  (dialog() === null ? null : within(dialog()!).queryByRole("button", { name: "Next page" })) as HTMLButtonElement | null;
const previewSays = () => dialog()?.textContent ?? "";
const pdfFrame = () => dialog()?.querySelector<HTMLIFrameElement>('iframe[sandbox="allow-scripts"]') ?? null;
const picture = () => dialog()?.querySelector("img") ?? null;
const report = (name: string) => screen.findByRole("status", { name });
const saved = () => report("Saved to Downloads");

async function press(el: HTMLElement | null): Promise<void> {
  expect(el, "the control is not on screen").not.toBeNull();
  await act(async () => el!.click());
  await settle();
  const frame = pdfFrame();
  if (frame && !frame.hasAttribute("data-test-connected")) {
    frame.setAttribute("data-test-connected", "");
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation((...args: unknown[]) => {
      expect(args[0]).toBe("pdf-preview");
      const [channel] = args[2] as [{ start: () => void }];
      channel.start();
    });
    await act(async () => { fireEvent.load(frame); });
    await settle();
  }
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
    await until(() => pdfFrame() !== null);
    expect(pdfLoads).toHaveBeenCalledTimes(1);
    expect(pdfLoads.mock.calls[0]?.[0]?.byteLength).toBe("%PDF-1.4".length);
    expect(pdfFrame(), "the PDF never reached the sealed renderer").not.toBeNull();
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
    expect(pdfFrame(), "the save took the PDF off the screen").not.toBeNull();
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
    expect(await saved()).toBeTruthy();
    expect(saveReports).toEqual([{ saved: 1 }]);
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
    expect(pdfFrame(), "the refusal replaced the PDF").not.toBeNull();
    expect(previewSays()).not.toMatch(/Couldn't fetch/);
    expect(pageLine()).toBe("3 / 3");
    expect(pdfLoads).toHaveBeenCalledTimes(1);
    expect(fetched, "the refusal fetched bytes the window holds again").toEqual([PDF]);
    expect(await report("The file could not be saved.")).toBeTruthy();
    expect(saveReports).toEqual([{ refused: ["not-saved", 1] }]);
  });

  it("a save the shell refuses keeps the PDF on screen and says why", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const save = holdSave();
    await pdfOnPageThree();
    await press(previewDownload());
    await act(async () => save.reject("ohmail: this computer named no Downloads folder"));
    await settle();
    expect(pdfFrame()).not.toBeNull();
    expect(pageLine()).toBe("3 / 3");
    expect(pdfLoads).toHaveBeenCalledTimes(1);
    expect(await report(messages.ohbox.toastSaveNoDownloads)).toBeTruthy();
    expect(saveReports).toEqual([{ refused: ["no-downloads-folder", 1] }]);
  });

  it("the picture stays on screen through a save and through a refused one", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let save = holdSave();
    await mount();
    await press(tile("Photo.png"));
    await press(previewDownload());
    expect(picture(), "the save took the picture off the screen").not.toBeNull();
    await act(async () => save.resolve(null));
    await settle();
    expect(await saved()).toBeTruthy();
    expect(saveReports).toEqual([{ saved: 1 }]);
    save = holdSave();
    await press(previewDownload());
    await act(async () => save.reject({ status: 404, code: "not_found", message: "gone", retryable: true }));
    await settle();
    expect(picture()?.getAttribute("src")).toBe(`attachment-preview://localhost/${STAGED}`);
    expect(invoked.filter((i) => i.command === "stage_attachment_preview"), "the picture was staged again").toHaveLength(1);
    expect(await report("The file could not be saved.")).toBeTruthy();
    expect(saveReports).toEqual([{ saved: 1 }, { refused: ["not-saved", 1] }]);
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
    expect(await saved()).toBeTruthy();
    expect(saveReports).toEqual([{ saved: 1 }]);
  });
});

describe("the rest of the desktop's attachment presses, unchanged", () => {
  it("a picture opens the preview from the shell's staged file, and saves nothing", async () => {
    await mount();
    await press(tile("Photo.png"));
    expect(dialog()).not.toBeNull();
    expect(invoked).toEqual([{ command: "stage_attachment_preview", payload: { attachmentId: PNG, mimeType: "image/png" } }]);
    expect(fetched, "a picture's bytes were fetched into the window").toEqual([]);
    expect(picture()?.getAttribute("src")).toBe(`attachment-preview://localhost/${STAGED}`);
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
    const released = () => invoked.filter((i) => i.command === "release_attachment_preview").map((i) => i.payload);
    const pending: Array<(value: unknown) => void> = [];
    const dispatch = shell.__TAURI_INTERNALS__!.invoke;
    shell.__TAURI_INTERNALS__!.invoke = (command, payload) =>
      command === "stage_attachment_preview"
        ? new Promise((resolve) => { pending.push(resolve); })
        : dispatch(command, payload);
    const dismiss = async () => {
      await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
      expect(dialog()).toBeNull();
    };
    const stage = (token: string) => ({ url: `attachment-preview://localhost/${token}`, token, size: 2048 });
    await press(tile("Photo.png"));
    expect(pending).toHaveLength(1);
    await dismiss();
    await act(async () => { pending[0]!(stage("late-first")); });
    expect(released(), "closing before staging settles must release the late file").toContainEqual({ token: "late-first" });

    await press(tile("Photo.png"));
    expect(pending).toHaveLength(2);
    await dismiss();
    await press(tile("Photo.png"));
    expect(pending).toHaveLength(3);
    await act(async () => { pending[1]!(stage("late-second")); });
    expect(released()).toContainEqual({ token: "late-second" });
    expect(dialog()).not.toBeNull();
    expect(picture()).toBeNull();
    await act(async () => { pending[2]!(stage("shown-third")); });
    expect(picture()?.getAttribute("src")).toBe("attachment-preview://localhost/shown-third");
    await dismiss();
    expect(released()).toContainEqual({ token: "shown-third" });
  });
});
