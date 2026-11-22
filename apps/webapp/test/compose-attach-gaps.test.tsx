/** @vitest-environment jsdom */
import type { ComposeAttachment } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import de from "../messages/de.json";
import { ComposeAttach } from "../app/components/ComposeAttach";
import {
  IMAGE_QUALITY_LEVELS,
  IMAGE_QUALITY_RULES,
  IMAGE_QUALITY_STORAGE_KEY,
} from "../app/components/image-quality";
import { enableDesktopDroppedFiles } from "@ohmail/app-logic/write/dropped-files";
import { restartHold } from "@ohmail/app-logic/doors/app-update";
import { KeymapProvider } from "../../../test/support/keymap-provider";
import { storageOwner } from "@ohmail/app-logic/storage/storage-owner";
import { Scoped } from "@ohmail/app/frame";

/*
 * MOVED AS THEY STOOD (share write-1 of the older tests' sorting, 18 November): the cases of
 * `compose-attach-quality.test.tsx` that Write does not hold yet, each a GAP owned by the switch's Write step
 * (`tools/old-tests.tsv`): a pasted picture or file attaches to Write's letter, and a locked letter takes no paste;
 * the Linux desktop's file-manager drop through the shell's held files; an attached file's tile shows its picture
 * and opens the preview. Word for word over today's `ComposeAttach`, as they stood, so the file they came from runs
 * over Write's own files alone. When Write builds one of them, its case is re-pointed here and its row turns KEPT.
 */

/**
 * The scope of the shell the composer is drawn in: the account the case names (its owner marker), else an account of
 * the test's own, as a mounted shell always names one.
 */
const inShell = (node: React.ReactElement): React.ReactElement =>
  h(Scoped, { scope: storageOwner() ?? "acc-attach", children: node });

/* The compose preview's PDF opens through pdf.js, which jsdom cannot run: a load that fails. */
vi.mock("pdfjs-dist", () => ({
  seam: true,
  getDocument: () => ({ promise: Promise.reject(new Error("no pdf.js here")), destroy: async () => {} }),
}));

/**
 * THE SHRINK DIAL, IN THE COMPOSE ATTACH ROW.
 *
 * The level table, the transform and the guard that keeps a grown re-encode are all pinned by
 * `image-quality.test.tsx`; what THIS file pins is the control that puts the dial where the files
 * are picked. It is the SAME stored preference the Settings row edits — one value, two surfaces —
 * so the assertions here are about the surface: the default, the order the options are offered in,
 * the write-through to storage, and the fact that the NEXT pick obeys what the control says.
 *
 * The codec is the same class of model as `image-quality.test.tsx` installs, reduced to what these
 * guards read: a decoder that answers a fixed bitmap and counts, and an encoder that records the
 * quality it was asked for and answers something smaller. The decisions — whether to decode at
 * all, at which quality, and whether the cap still refuses — are the module's own.
 */

// jsdom's Blob has no `text()`; the preview reads a text file with it, as every browser can.
if (typeof (Blob.prototype as { text?: unknown }).text !== "function") {
  (Blob.prototype as unknown as { text: () => Promise<string> }).text = function (this: Blob) {
    return new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error);
      fr.readAsText(this);
    });
  };
}

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIB = 1024 * 1024;
const PHOTO_BYTES = 2_500_000;
const PHOTO2_BYTES = 1_800_000;
const SHRUNK_BYTES = 300_000;

/** The model encoder's output size for one quality — distinct per level, so an assertion can
    read WHICH level produced the bytes a row carries. Always smaller than the fixture, so the
    keep-the-original guard never masks a level assertion here. */
const shrunkSizeFor = (quality: number | undefined): number =>
  SHRUNK_BYTES + Math.round((quality ?? 0) * 1000);

let decodeCount = 0;
/** The byte size of every blob handed to the decoder — the pristine-source pin reads this:
    a re-encode pass must decode the PICKED bytes, never a previous encode's output. */
let decodeSizes: number[] = [];
let encodeCalls: { type: string | undefined; quality: number | undefined; canvas: { width: number; height: number } }[] = [];
/** When set, the model encoder awaits this per call (1-based) — how a test holds a re-encode
    pass open to look at what a send would read mid-pass. */
let encodeHold: ((call: number) => Promise<void>) | null = null;

class ModelOffscreenCanvas {
  constructor(
    public width: number,
    public height: number,
  ) {}

  getContext(id: string): { drawImage: () => void } | null {
    return id === "2d" ? { drawImage: () => {} } : null;
  }

  async convertToBlob(options?: { type?: string; quality?: number }): Promise<Blob> {
    encodeCalls.push({
      type: options?.type,
      quality: options?.quality,
      canvas: { width: this.width, height: this.height },
    });
    if (encodeHold) await encodeHold(encodeCalls.length);
    return new Blob([new Uint8Array(shrunkSizeFor(options?.quality))], { type: options?.type ?? "image/jpeg" });
  }
}

type Mutable = Record<string, unknown>;

beforeEach(() => {
  decodeCount = 0;
  decodeSizes = [];
  encodeCalls = [];
  encodeHold = null;
  (globalThis as Mutable).createImageBitmap = async (blob: Blob): Promise<{
    width: number;
    height: number;
    close: () => void;
  }> => {
    decodeCount += 1;
    decodeSizes.push(blob.size);
    return { width: 4000, height: 3000, close: () => {} };
  };
  (globalThis as Mutable).OffscreenCanvas = ModelOffscreenCanvas;
  window.localStorage.clear();
  // No signed-in account unless a test sets one — the per-account describes plant their own.
  document.cookie = "tf_owner=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
});

afterEach(async () => {
  delete (globalThis as Mutable).createImageBitmap;
  delete (globalThis as Mutable).OffscreenCanvas;
  window.localStorage.clear();
  document.cookie = "tf_owner=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let handed: ComposeAttachment[] = [];
/** Every list `onChange` ever handed up, in order — what pins "one atomic commit, never torn". */
let handedHistory: ComposeAttachment[][] = [];

const photo = (): File =>
  new File([new Uint8Array(PHOTO_BYTES)], "photo.jpg", { type: "image/jpeg" });
const photo2 = (): File =>
  new File([new Uint8Array(PHOTO2_BYTES)], "photo2.jpg", { type: "image/jpeg" });
const pdf = (): File =>
  new File([new Uint8Array(50_000)], "doc.pdf", { type: "application/pdf" });
/** A photo small enough for its ORIGINAL to fit a 1 MiB cap alone — the whole-list cap pin. */
const PHOTO3_BYTES = 700_000;
const photo3 = (): File =>
  new File([new Uint8Array(PHOTO3_BYTES)], "photo3.jpg", { type: "image/jpeg" });
const bigPdf = (): File =>
  new File([new Uint8Array(500_000)], "big.pdf", { type: "application/pdf" });

/** Exact decoded byte length of one attachment's base64 — padding-aware, so it can equal-match
    the model encoder's per-level sizes. */
const attachmentBytes = (a: ComposeAttachment): number => {
  const s = a.contentBase64;
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return (s.length * 3) / 4 - pad;
};

/**
 * A STATEFUL wrapper, because the real callers are: `AppShell` feeds `onChange` straight back
 * into the `attachments` prop, and the scope-note and duplicate guards below are ABOUT what the
 * component does when the list it is showing is the list it produced. A static `[]` prop would
 * make both green-by-vacancy.
 */
function Wrap(o: { maxTotalBytes?: number; disabled?: boolean; onAttaching?: (files: readonly string[]) => void }) {
  const [atts, setAtts] = React.useState<ComposeAttachment[]>([]);
  // The surface pastes and drops land on — the compose wrap / reply panel in the real callers.
  const zone = React.useRef<HTMLDivElement | null>(null);
  return h(
    "div",
    { className: "zone", ref: zone },
    h(ComposeAttach as never, {
      attachments: atts,
      onChange: (next: ComposeAttachment[]) => {
        handed = next;
        handedHistory.push(next);
        setAtts(next);
      },
      dropZone: zone,
      ...(o.maxTotalBytes === undefined ? {} : { maxTotalBytes: o.maxTotalBytes }),
      ...(o.disabled === undefined ? {} : { disabled: o.disabled }),
      ...(o.onAttaching === undefined ? {} : { onAttaching: o.onAttaching }),
    } as never),
  );
}

/**
 * THE CALLER AS `ComposeView` ACTUALLY IS — a parent whose `onChange` spreads a whole form
 * object around the new list (`onFields({ ...fields, attachments: next })`), owns the list
 * ACROSS the control's unmount, and can move the cap under a running pass. The three review
 * findings about async commits were all about this shape, so the harness reproduces it exactly:
 * the STALE-CLOSURE spread is deliberate and must stay — the component under test is what makes
 * it safe.
 */
let lastForm: { label: string; atts: ComposeAttachment[] } = { label: "untouched", atts: [] };

function LabWrap(o: { initial?: ComposeAttachment[]; maxTotalBytes?: number; capDrop?: number; clone?: boolean }) {
  const [form, setForm] = React.useState<{ label: string; atts: ComposeAttachment[] }>({
    label: "untouched",
    atts: o.initial ?? [],
  });
  const [open, setOpen] = React.useState(true);
  const [cap, setCap] = React.useState(o.maxTotalBytes ?? 8 * MIB);
  lastForm = form;
  const zone = React.useRef<HTMLDivElement | null>(null);
  return h(
    "div",
    { className: "zone", ref: zone },
    h("button", {
      className: "edit-label",
      onClick: () => setForm((f) => ({ ...f, label: "edited" })),
    }),
    h("button", {
      className: "close-compose",
      onClick: () => {
        setOpen(false);
        setForm((f) => ({ ...f, atts: [] }));
      },
    }),
    h("button", { className: "drop-cap", onClick: () => setCap(o.capDrop ?? 500_000) }),
    h("button", { className: "restore-cap", onClick: () => setCap(o.maxTotalBytes ?? 8 * MIB) }),
    open
      ? h(ComposeAttach as never, {
          // `clone` reproduces the reply panel's exact wiring: a fresh array every render
          // (the reply editor passes `[...attachments]`), so nothing downstream may depend on the
          // ARRAY keeping identity — only the rows do.
          attachments: o.clone ? [...form.atts] : form.atts,
          onChange: (next: ComposeAttachment[]) => {
            handed = next;
            handedHistory.push(next);
            setForm({ ...form, atts: next }); // ComposeView's exact shape — see the header
          },
          dropZone: zone,
          maxTotalBytes: cap,
        } as never)
      : null,
  );
}

async function mountLab(o: { initial?: ComposeAttachment[]; maxTotalBytes?: number; capDrop?: number; clone?: boolean } = {}): Promise<void> {
  handed = [];
  handedHistory = [];
  lastForm = { label: "untouched", atts: [] };
  if (root) {
    await act(async () => root!.unmount());
    host?.remove();
    root = null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en",
        messages,
        timeZone: "UTC",
        now: new Date("2026-08-11T09:00:00.000Z"),
        children: inShell(h(LabWrap, o)),
      }),
    );
  });
}

/** A React click on one of the harness's own buttons. */
async function press(selector: string): Promise<void> {
  await act(async () => {
    host!.querySelector<HTMLButtonElement>(selector)!.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
  });
}

/** Start a pick WITHOUT draining — for holding its encode open while something else happens. */
async function startPick(files: File[]): Promise<void> {
  const input = host!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function mount(
  o: { maxTotalBytes?: number; disabled?: boolean; locale?: "en" | "de"; onAttaching?: (files: readonly string[]) => void; keys?: boolean } = {},
): Promise<void> {
  handed = [];
  handedHistory = [];
  if (root) {
    await act(async () => root!.unmount());
    host?.remove();
    root = null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: o.locale ?? "en",
        messages: o.locale === "de" ? de : messages,
        timeZone: "UTC",
        now: new Date("2026-08-11T09:00:00.000Z"),
        children: inShell(o.keys
          ? h(KeymapProvider, null, h(Wrap, { maxTotalBytes: o.maxTotalBytes, disabled: o.disabled, onAttaching: o.onAttaching }))
          : h(Wrap, { maxTotalBytes: o.maxTotalBytes, disabled: o.disabled, onAttaching: o.onAttaching })),
      }),
    );
  });
}

const dial = (): HTMLSelectElement =>
  host!.querySelector<HTMLSelectElement>(".compose-attach-level select")!;

async function setLevel(value: string): Promise<void> {
  const select = dial();
  select.value = value;
  await act(async () => {
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

/** FileReader delivers as a task — same drain as image-quality.test.tsx, same reason. Also what
    settles a dial move's async re-encode pass (which reads bytes the same way). */
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function pickFiles(files: File[]): Promise<void> {
  const input = host!.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await drain();
}

describe("pasted and dropped files are picks — CMP-F8", () => {
  /** A paste/drop event the way jsdom can make one: a plain event carrying a files list. */
  function fileEvent(type: "paste" | "drop" | "dragover", files: File[]): Event {
    const e = new Event(type, { bubbles: true, cancelable: true });
    const carrier = { files, types: files.length ? ["Files"] : [], getData: () => "" };
    Object.defineProperty(e, type === "paste" ? "clipboardData" : "dataTransfer", {
      value: carrier,
    });
    return e;
  }
  const zone = (): HTMLElement => host!.querySelector<HTMLElement>(".zone")!;

  /**
   * The editor takes no images by design, so a pasted picture used to do NOTHING — no
   * attachment, no notice. It is an attach now, through the same admit pipeline as the picker.
   *
   * Mutation: delete the `paste` listener in the dropZone effect. Real failure text:
   *   AssertionError: a pasted picture vanished — no attachment, no notice, nothing: expected
   *   0 to be 1
   */
  it("a pasted picture attaches through the same pipeline", async () => {
    await mount({ maxTotalBytes: 3 * MIB });
    const e = fileEvent("paste", [photo()]);
    await act(async () => { zone().dispatchEvent(e); });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(
      handed,
      "a pasted picture vanished — no attachment, no notice, nothing",
    ).toHaveLength(1);
    expect(e.defaultPrevented, "the paste also fell through to the editor").toBe(true);
    // …and it went through the shrink, exactly like a picked file.
    expect(encodeCalls).toHaveLength(1);
  });

  /** The reported scenario: a screenshot on the clipboard arrives as image/png. The intake
      reads `e.clipboardData.files` and never the type, so a png rides the same admit pipeline —
      pinned apart from the jpeg case because "paste a screenshot" is the reported use. */
  it("a pasted image/png screenshot attaches — the reported scenario", async () => {
    await mount({ maxTotalBytes: 3 * MIB });
    const shot = new File([new Uint8Array(120_000)], "screenshot.png", { type: "image/png" });
    const e = fileEvent("paste", [shot]);
    await act(async () => { zone().dispatchEvent(e); });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(handed, "a pasted screenshot vanished — no attachment, no notice").toHaveLength(1);
    expect(handed[0]!.filename).toBe("screenshot.png");
    expect(e.defaultPrevented, "the paste also fell through to the editor").toBe(true);
  });

  /** A text paste is none of this component's business. */
  it("leaves a file-less paste alone", async () => {
    await mount();
    const e = fileEvent("paste", []);
    await act(async () => { zone().dispatchEvent(e); });
    expect(handed).toHaveLength(0);
    expect(e.defaultPrevented).toBe(false);
  });

  /** Disabled mid-send means disabled for EVERY intake path, not only the picker button. */
  it("takes nothing while disabled", async () => {
    await mount({ disabled: true });
    const e = fileEvent("paste", [photo()]);
    await act(async () => { zone().dispatchEvent(e); });
    for (let i = 0; i < 4; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(handed).toHaveLength(0);
  });
});

describe("a file manager's drop on the Linux desktop attaches its files — CMP-F8", () => {
  /**
   * The shapes WebKitGTK 2.52 gives the page, measured with a GTK4 file-list drag onto a
   * WebKitGTK 4.1 view: a file manager's drop lists `text/uri-list` and `text/html`, withholds the
   * data and carries no File objects, so the zone saw no `Files` and the editor inserted the path.
   * A browser's link lists `text/plain` too, and its data reads. The paths here are synthetic.
   */
  type Shape = { types: string[]; drop: Record<string, string> };
  const WITHHELD: Shape = {
    types: ["text/uri-list", "text/html"],
    drop: { "text/html": '<a style="font-weight: 400;">file:///tmp/drop/notes.txt</a>' },
  };
  const LINK: Shape = {
    types: ["text/plain", "text/html", "text/uri-list"],
    drop: {
      "text/plain": "https://example.org/a",
      "text/uri-list": "https://example.org/a\r\n",
      "text/html": '<a href="https://example.org/a">https://example.org/a</a>',
    },
  };
  const CHIP: Shape = {
    types: ["application/x-ohmail-recipient", "text/plain"],
    drop: { "application/x-ohmail-recipient": '{"entry":"a@example.org","row":"to"}', "text/plain": "a@example.org" },
  };
  /** Every getData reads "" until the drop, as in the browser's protected mode. */
  function dragEvent(type: "dragover" | "drop", shape: Shape): Event {
    const e = new Event(type, { bubbles: true, cancelable: true });
    const getData = (t: string): string => (type === "drop" ? (shape.drop[t] ?? "") : "");
    Object.defineProperty(e, "dataTransfer", { value: { files: [], types: shape.types, getData } });
    return e;
  }
  const zone = (): HTMLElement => host!.querySelector<HTMLElement>(".zone")!;

  const TOKEN = "f".repeat(32);
  const NOTES = new TextEncoder().encode("the notes, from the file manager");
  const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
  const notesTake = () => ({
    drop: TOKEN,
    files: [{ name: "notes.txt", size: NOTES.length, type: "text/plain", state: "ok" }],
  });

  /** The shell, stubbed: every command recorded with its payload, the answers per case. */
  let calls: Array<{ command: string; payload?: Record<string, unknown> }> = [];
  let take: () => Promise<unknown> = async () => null;
  let chunk: (payload: Record<string, unknown>) => Promise<unknown> = async () => ({ bytes64: b64(NOTES), end: true });
  let disarm: (() => void) | null = null;
  beforeEach(() => {
    calls = [];
    take = async () => notesTake();
    chunk = async () => ({ bytes64: b64(NOTES), end: true });
    (globalThis as Mutable).__TAURI_INTERNALS__ = {
      invoke: (command: string, payload?: Record<string, unknown>) => {
        calls.push(payload === undefined ? { command } : { command, payload });
        return command === "dropped_files_take" ? take() : chunk(payload ?? {});
      },
    };
  });
  afterEach(() => {
    disarm?.();
    disarm = null;
    delete (globalThis as Mutable).__TAURI_INTERNALS__;
  });

  /**
   * THE REPORTED BUG: the drop pasted the path. Now the dragover is claimed, the drop is prevented
   * (nothing inserts), and the shell's file lands through the same admit pipeline as a pick.
   *
   * Mutation: drop the withheld branch from the zone's `drop` listener → red (nothing attaches and
   * the drop is left to WebKit's insert).
   */
  it("claims the drag, prevents the drop and attaches the file the shell read", async () => {
    disarm = enableDesktopDroppedFiles();
    await mount({ maxTotalBytes: 3 * MIB });
    const over = dragEvent("dragover", WITHHELD);
    await act(async () => { zone().dispatchEvent(over); });
    expect(over.defaultPrevented, "the drag was not claimed, so a drop on the attach strip never lands").toBe(true);

    const drop = dragEvent("drop", WITHHELD);
    await act(async () => { zone().dispatchEvent(drop); });
    await drain();
    expect(drop.defaultPrevented, "the drop was left to WebKit, which inserts the path").toBe(true);
    expect(handed.map((a) => [a.filename, a.contentType, a.contentBase64])).toEqual([["notes.txt", "text/plain", b64(NOTES)]]);
    expect(calls).toEqual([
      { command: "dropped_files_take" },
      { command: "dropped_file_chunk", payload: { drop: TOKEN, index: 0 } },
    ]);
  });

  /** The lock is the take's from the first moment: a send pressed while the shell answers waits. */
  it("holds the attaching lock and the restart from the drop to the commit", async () => {
    disarm = enableDesktopDroppedFiles();
    const reported: Array<readonly string[]> = [];
    await mount({ maxTotalBytes: 3 * MIB, onAttaching: (files) => reported.push(files) });
    let answerTake!: () => void;
    const taken = new Promise<void>((resolve) => { answerTake = resolve; });
    let answerChunk!: () => void;
    const read = new Promise<void>((resolve) => { answerChunk = resolve; });
    take = async () => { await taken; return notesTake(); };
    chunk = async () => { await read; return { bytes64: b64(NOTES), end: true }; };

    await act(async () => { zone().dispatchEvent(dragEvent("drop", WITHHELD)); });
    expect(reported.at(-1)?.length, "nothing was attaching while the shell was asked").toBe(1);
    expect(restartHold()).toBe("files");

    await act(async () => { answerTake(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(reported.at(-1)).toEqual(["notes.txt"]);
    expect(handed).toHaveLength(0);

    await act(async () => { answerChunk(); });
    await drain();
    expect(handed).toHaveLength(1);
    expect(reported.at(-1)).toEqual([]);
    expect(reported.slice(0, -1).every((files) => files.length > 0), "the lock opened before the commit").toBe(true);
    expect(restartHold()).toBe(null);
  });

  /** A link and a recipient chip are other drags' business: claiming a link's dragover makes
      WebKit navigate to the link instead of inserting it. */
  it("leaves an https link and a recipient chip alone", async () => {
    disarm = enableDesktopDroppedFiles();
    await mount();
    for (const shape of [LINK, CHIP]) {
      const over = dragEvent("dragover", shape);
      const drop = dragEvent("drop", shape);
      await act(async () => { zone().dispatchEvent(over); zone().dispatchEvent(drop); });
      expect([over.defaultPrevented, drop.defaultPrevented], shape.types.join(",")).toEqual([false, false]);
    }
    await drain();
    expect(calls).toEqual([]);
    expect(handed).toHaveLength(0);
  });

  /** The web app and the preview arm nothing: the shape alone never asks a shell. */
  it("asks no shell when the window is not armed", async () => {
    await mount();
    const over = dragEvent("dragover", WITHHELD);
    const drop = dragEvent("drop", WITHHELD);
    await act(async () => { zone().dispatchEvent(over); zone().dispatchEvent(drop); });
    await drain();
    expect([over.defaultPrevented, drop.defaultPrevented]).toEqual([false, false]);
    expect(calls).toEqual([]);
  });

  /** The shell holds nothing (the drop was this page's own drag, or ten seconds went by). */
  it("attaches nothing and inserts nothing when the shell holds no drop", async () => {
    disarm = enableDesktopDroppedFiles();
    await mount();
    take = async () => null;
    const drop = dragEvent("drop", WITHHELD);
    await act(async () => { zone().dispatchEvent(drop); });
    await drain();
    expect(drop.defaultPrevented).toBe(true);
    expect(handed).toHaveLength(0);
    expect(host!.querySelector(".compose-attach-error")).toBeNull();
    expect(calls).toEqual([{ command: "dropped_files_take" }]);
  });

  /** The shell's refusals are the pick's own sentences, and nothing over the cap is read. */
  it("says the pick's own sentences for a file too large or unreadable, reading none of them", async () => {
    disarm = enableDesktopDroppedFiles();
    await mount({ maxTotalBytes: 3 * MIB });
    take = async () => ({
      drop: TOKEN,
      files: [
        { name: "film.mov", size: 45 * MIB, type: "video/quicktime", state: "too_large" },
        { name: "pipe", size: 0, type: "", state: "unreadable" },
        { name: "scan.pdf", size: 4 * MIB, type: "application/pdf", state: "ok" },
      ],
    });
    await act(async () => { zone().dispatchEvent(dragEvent("drop", WITHHELD)); });
    await drain();
    const said = host!.querySelector(".compose-attach-error")?.textContent ?? "";
    expect(said).toContain("Some files were not added — they would have put the total over");
    expect(said).toContain("Some files couldn't be read and were not added.");
    expect(handed).toHaveLength(0);
    expect(calls.map((c) => c.command), "a file the cap refuses was read anyway").toEqual(["dropped_files_take"]);
  });
});

describe("each attached file shows itself, and opens in the preview", () => {
  /** Every URL minted, with the Blob it was minted for, and every one revoked. */
  let minted: Map<string, Blob>;
  let revoked: string[];
  let seq = 0;
  beforeEach(() => {
    minted = new Map();
    revoked = [];
    (URL as unknown as Mutable).createObjectURL = (b: Blob) => {
      const u = `blob:http://localhost/${++seq}`;
      minted.set(u, b);
      return u;
    };
    (URL as unknown as Mutable).revokeObjectURL = (u: string) => { revoked.push(u); };
  });
  afterEach(() => {
    delete (URL as unknown as Mutable).createObjectURL;
    delete (URL as unknown as Mutable).revokeObjectURL;
  });

  const live = (): string[] => [...minted.keys()].filter((u) => !revoked.includes(u));
  const bytesOf = (b: Blob): Promise<Uint8Array> => new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(b);
  });
  const decoded = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const thumbOf = (name: string): HTMLImageElement | null => {
    const row = [...host!.querySelectorAll(".compose-attach-item")].find((li) => li.textContent?.includes(name));
    return row?.querySelector<HTMLImageElement>("img.att-thumb") ?? null;
  };
  const file = (name: string, type: string, text = name): File => new File([text], name, { type });
  const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Attachment preview"]');
  const looks = (): HTMLButtonElement[] => [...host!.querySelectorAll<HTMLButtonElement>(".compose-attach-look")];
  const docKey = async (k: string): Promise<void> => {
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
  };

  it("a picture is drawn from the bytes that will be sent, and again after the dial moves", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([photo()]);
    const first = thumbOf("photo.jpg")!;
    expect(first, "the attached photo shows no picture of itself").not.toBeNull();
    const blob = minted.get(first.getAttribute("src")!)!;
    expect(blob.type).toBe("image/jpeg");
    expect(await bytesOf(blob)).toEqual(decoded(handed[0]!.contentBase64));

    await setLevel("low");
    await drain();
    const second = thumbOf("photo.jpg")!;
    expect(second.getAttribute("src")).not.toBe(first.getAttribute("src"));
    expect(revoked).toEqual([first.getAttribute("src")]);
    expect(await bytesOf(minted.get(second.getAttribute("src")!)!), "the picture is not the encode the send carries")
      .toEqual(decoded(handed[0]!.contentBase64));
  });

  it("only the raster pictures the reader draws get a URL", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([
      file("logo.svg", "image/svg+xml", "<svg/>"),
      file("page.html", "text/html", "<p>hi</p>"),
      pdf(),
      file("notes.txt", "text/plain", "hello"),
    ]);
    expect(handed).toHaveLength(4);
    expect([...minted.keys()], "a file that is not a raster picture was given a URL").toEqual([]);
    expect(host!.querySelectorAll(".compose-attach-item .att-leaf")).toHaveLength(4);
    expect(host!.querySelectorAll(".compose-attach-item img")).toHaveLength(0);
  });

  it("removing a row revokes its URL alone; emptying the list or leaving releases the rest", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([photo(), photo2()]);
    const [one, two] = [thumbOf("photo.jpg")!.getAttribute("src")!, thumbOf("photo2.jpg")!.getAttribute("src")!];
    await act(async () => { host!.querySelector<HTMLButtonElement>(".compose-attach-remove")!.click(); });
    expect(revoked, "removing one row revoked the wrong URL").toEqual([one]);
    expect(live()).toEqual([two]);
    await act(async () => { host!.querySelector<HTMLButtonElement>(".compose-attach-remove")!.click(); });
    expect(live()).toEqual([]);

    await pickFiles([photo()]);
    expect(live()).toHaveLength(1);
    await act(async () => root!.unmount());
    root = null;
    expect(live(), "leaving the form kept a picture pinned").toEqual([]);
  });

  it("pressing a row opens the preview on that file; arrows walk all, Esc and Space close back to the row", async () => {
    await mount({ maxTotalBytes: 8 * MIB, keys: true });
    await pickFiles([photo(), file("plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), photo2()]);
    expect(looks()[1]!.getAttribute("aria-label")).toBe("Preview plan.docx");
    // Opened from the keyboard: focus is on the row, so it comes back to a row.
    await act(async () => { looks()[1]!.focus(); looks()[1]!.click(); });
    expect(dialog(), "pressing the row opened nothing").not.toBeNull();
    expect(dialog()!.querySelector(".ap-meta")!.textContent).toContain("2 of 3");
    expect(dialog()!.querySelector(".ap-card")!.textContent).toBe("No preview");
    expect([...dialog()!.querySelectorAll("button")].some((b) => b.textContent?.includes("Download")), "the compose preview offered a Download").toBe(false);
    await docKey("ArrowRight");
    expect(dialog()!.querySelector(".ap-meta")!.textContent).toContain("3 of 3");
    await docKey("ArrowRight");
    expect(dialog()!.querySelector(".ap-meta")!.textContent).toContain("1 of 3");
    await docKey("ArrowLeft");
    expect(dialog()!.querySelector(".ap-meta")!.textContent).toContain("3 of 3");
    expect(dialog()!.querySelector("img.ap-img")!.getAttribute("src")).toBe(thumbOf("photo2.jpg")!.getAttribute("src"));
    await docKey("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement, "focus did not come back to the row on screen").toBe(looks()[2]);

    await act(async () => { looks()[0]!.click(); });
    const panel = dialog()!;
    await act(async () => { panel.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })); });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(looks()[0]);
    expect(handed).toHaveLength(3);
  });

  it("a file pasted or dropped on the open preview attaches nothing", async () => {
    await mount({ maxTotalBytes: 8 * MIB, keys: true });
    await pickFiles([photo()]);
    await act(async () => { looks()[0]!.click(); });
    const at = dialog()!;
    const carrying = (type: string): Event => {
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(e, type === "paste" ? "clipboardData" : "dataTransfer", {
        value: { files: [photo2()], types: ["Files"], getData: () => "", dropEffect: "copy" },
      });
      return e;
    };
    const over = carrying("dragover");
    const drop = carrying("drop");
    await act(async () => { at.dispatchEvent(carrying("paste")); at.dispatchEvent(over); at.dispatchEvent(drop); });
    await drain();
    expect(handed, "a file landed on the message from under the preview").toHaveLength(1);
    expect(over.defaultPrevented && drop.defaultPrevented, "the browser was left to open the dropped file").toBe(true);
    expect((over as unknown as { dataTransfer: { dropEffect: string } }).dataTransfer.dropEffect).toBe("none");
  });

  it("an image, a PDF and a text are each shown without a frame, an embed, an object or a blob: link", async () => {
    await mount({ maxTotalBytes: 8 * MIB, keys: true });
    await pickFiles([photo(), pdf(), file("notes.txt", "text/plain", "hello <b>there</b>")]);
    await act(async () => { looks()[0]!.click(); });
    const unsafe = () => document.querySelector("iframe, embed, object, a[href^='blob:']");
    expect(dialog()!.querySelector("img.ap-img")).not.toBeNull();
    expect(unsafe()).toBeNull();
    await docKey("ArrowRight");
    await drain();
    expect(dialog()!.querySelector(".ap-card")?.textContent).toBe("Can't show this PDF here");
    expect(unsafe()).toBeNull();
    await docKey("ArrowRight");
    await drain();
    expect(dialog()!.querySelector("pre.ap-text")?.textContent).toBe("hello <b>there</b>");
    expect(unsafe()).toBeNull();
  });
});
