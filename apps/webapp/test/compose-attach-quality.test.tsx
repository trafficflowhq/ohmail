/** @vitest-environment jsdom */
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
import type { ComposeAttachment } from "@ohmail/client-engine";
import { enableDesktopDroppedFiles } from "../app/shell/dropped-files";
import { restartHold } from "@ohmail/app-logic/doors/app-update";
import { KeymapProvider } from "../app/shell/keymap";

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
          // (`InlineReply` passes `[...attachments]`), so nothing downstream may depend on the
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
        children: h(LabWrap, o),
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
        children: o.keys
          ? h(KeymapProvider, null, h(Wrap, { maxTotalBytes: o.maxTotalBytes, disabled: o.disabled, onAttaching: o.onAttaching }))
          : h(Wrap, { maxTotalBytes: o.maxTotalBytes, disabled: o.disabled, onAttaching: o.onAttaching }),
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

describe("the dial is in the row, defaulting to Medium", () => {
  it("renders a labelled select whose resting value is the default level", async () => {
    await mount();
    const select = dial();
    expect(select).not.toBeNull();
    expect(select.value).toBe("medium");
    // The visible label is the accessible name — the same vocabulary as the Settings row.
    const label = host!.querySelector<HTMLLabelElement>(".compose-attach-level")!;
    expect(label.textContent).toContain("Quality");
    expect(label.htmlFor).toBe(select.id);
  });

  /**
   * THE WORDS NAME THE PICTURE, NOT THE EFFORT — which is the whole reason this dial was renamed.
   *
   * It used to read "Shrink pictures / Most, More, Some, Off (original)": every label described
   * what the product was doing, and "High" would have meant the SMALLEST file. The axis is the
   * picture's quality now, ascending, so Low is the smallest file and Original is untouched.
   * Same one-word-per-level catalog entry as the Settings row, so the two surfaces cannot drift
   * into synonyms, and the ORDER is the shared table's with no reversal on either side.
   */
  it("offers the four quality levels ascending, Original last", async () => {
    await mount();
    const options = Array.from(dial().options);
    expect(options.map((o) => o.value)).toEqual(["low", "medium", "high", "original"]);
    expect(options.map((o) => o.value)).toEqual([...IMAGE_QUALITY_LEVELS]);
    expect(options.map((o) => o.textContent)).toEqual(["Low", "Medium", "High", "Original"]);
    // One option per level in the shared table — an added level must surface here.
    expect(options).toHaveLength(IMAGE_QUALITY_LEVELS.length);
  });

  it("shows the STORED level once mounted — the Settings row's writes reach this surface", async () => {
    window.localStorage.setItem(IMAGE_QUALITY_STORAGE_KEY, "high");
    await mount();
    expect(dial().value).toBe("high");
  });

  it("is disabled while the form is", async () => {
    await mount({ disabled: true });
    expect(dial().disabled).toBe(true);
  });

  it("speaks German — same label as the Settings row, Original named", async () => {
    await mount({ locale: "de" });
    const label = host!.querySelector<HTMLLabelElement>(".compose-attach-level")!;
    expect(label.textContent).toContain("Qualität");
    const options = Array.from(dial().options);
    expect(options.map((o) => o.textContent)).toEqual(["Niedrig", "Mittel", "Hoch", "Original"]);
  });
});

describe("what the dial says is what the next pick does — and it is remembered PER ACCOUNT", () => {
  /**
   * ══ CMP-F4 — A MOVE IS A REMEMBERED, ACCOUNT-SCOPED CHOICE ═════════════════════════════
   *
   * The dial used to write one account-less key, so a control that looks personal silently
   * rewrote the preference for everyone who signs in on the machine. It now persists — that is
   * the point of a preference — under the ACCOUNT's own key (`imageQualityKeyFor(readOwner())`,
   * the same id the mail mirror is named for), and the account-less key it leaves alone is
   * both the desktop's store and the legacy fallback.
   *
   * Mutation: make the dial's onChange call `writeImageQualityLevel(next)` with no account.
   * Real failure text:
   *   AssertionError: the move was not stored under the account's own key — it either leaked
   *   account-less or was forgotten: expected null to be 'medium'
   */
  it("a move is stored under the ACCOUNT's key and restored on the next mount", async () => {
    document.cookie = "tf_owner=acct-one";
    window.localStorage.setItem(IMAGE_QUALITY_STORAGE_KEY, "low");
    await mount();
    await setLevel("medium");

    expect(
      window.localStorage.getItem(`${IMAGE_QUALITY_STORAGE_KEY}:acct-one`),
      "the move was not stored under the account's own key — it either leaked account-less or "
        + "was forgotten",
    ).toBe("medium");
    expect(
      window.localStorage.getItem(IMAGE_QUALITY_STORAGE_KEY),
      "the account's move overwrote the account-less key every other signer-in reads",
    ).toBe("low");

    // The next compose on this account opens at the remembered level.
    await mount();
    expect(dial().value, "the remembered level did not survive a remount").toBe("medium");
  });

  /** A browser is not a person: the second account's dial is its own. */
  it("a different account keeps its own dial", async () => {
    document.cookie = "tf_owner=acct-one";
    window.localStorage.setItem(IMAGE_QUALITY_STORAGE_KEY, "low");
    await mount();
    await setLevel("medium");

    document.cookie = "tf_owner=acct-two";
    await mount();
    expect(
      dial().value,
      "the second account inherited the first one's compose-dial choice",
    ).toBe("low");
  });

  /**
   * …and the pick obeys the DIAL on screen: the account-less key still says `high`, the
   * account's dial says `medium`, and the bytes follow the dial.
   * Mutation: make `onFiles` read `readImageQualityLevel()` with no account — that answers the
   * account-less `high` and the assertion names medium's quality.
   */
  it("a pick after the move encodes at the DIAL's level, not the account-less key's", async () => {
    document.cookie = "tf_owner=acct-one";
    window.localStorage.setItem(IMAGE_QUALITY_STORAGE_KEY, "low");
    await mount({ maxTotalBytes: 3 * MIB });
    await setLevel("medium");
    await pickFiles([photo()]);
    expect(handed).toHaveLength(1);
    expect(encodeCalls).toHaveLength(1);
    expect(
      encodeCalls[0]!.quality,
      "the pick read the account-less key instead of the dial on screen",
    ).toBe(IMAGE_QUALITY_RULES.medium!.quality);
  });

  /**
   * ══ CMP-F4's OTHER HALF — THE SCOPE IS SAID, NOT DISCOVERED ════════════════════════════
   *
   * A level change RE-ENCODES the pictures already in the list (owner ruling — it used to
   * apply to new picks only, and the note said so). The note states the new scope where the
   * dial moved; what the re-encode actually does is pinned by its own describe below.
   *
   * Mutation: drop the `setScopeNote(true)` call. Real failure text:
   *   AssertionError: the dial moved over an existing attachment and nothing stated the
   *   scope: expected null not to be null
   */
  it("says the scope out loud when the level changes over existing attachments", async () => {
    await mount({ maxTotalBytes: 3 * MIB });
    await pickFiles([photo()]);
    expect(host!.querySelector(".compose-attach-scope"), "the note fired before anything changed")
      .toBeNull();

    await setLevel("high");
    await drain();

    const note = host!.querySelector(".compose-attach-scope");
    expect(
      note,
      "the dial moved over an existing attachment and nothing stated the scope",
    ).not.toBeNull();
    // The sentence must claim what is now TRUE — re-encoding the attached pictures — not the
    // retired "files already attached keep their size".
    expect(note!.textContent).toContain("already attached");
    expect(note!.textContent).not.toMatch(/keep their size/i);
    expect(note!.getAttribute("role")).toBe("status");
  });

  it("stays quiet when the level changes with nothing attached — there is no scope to state", async () => {
    await mount({ maxTotalBytes: 3 * MIB });
    await setLevel("high");
    expect(host!.querySelector(".compose-attach-scope")).toBeNull();
  });

  it("a pick after moving to Medium encodes at Medium's own quality and edge", async () => {
    await mount({ maxTotalBytes: 3 * MIB });
    await setLevel("medium");
    await pickFiles([photo()]);
    expect(handed).toHaveLength(1);
    expect(encodeCalls).toHaveLength(1);
    const rule = IMAGE_QUALITY_RULES.medium!;
    expect(encodeCalls[0]!.quality).toBe(rule.quality);
    // 4000×3000 fitted to the level's longest edge.
    expect(encodeCalls[0]!.canvas).toEqual({ width: rule.maxEdge, height: 1536 });
  });

  it("Original sends the source bytes — no decode, no re-encode, nothing claimed", async () => {
    await mount({ maxTotalBytes: 3 * MIB });
    await setLevel("original");
    await pickFiles([photo()]);
    expect(handed).toHaveLength(1);
    expect(decodeCount).toBe(0);
    expect(encodeCalls).toHaveLength(0);
    // The base64 carries the ORIGINAL size, and the "Pictures shrunk" note stays away.
    expect(Math.floor((handed[0]!.contentBase64.length * 3) / 4)).toBeGreaterThanOrEqual(PHOTO_BYTES);
    expect(host!.querySelector(".compose-attach-shrunk")).toBeNull();
  });

  it("Original is still subject to the cap — skipping the shrink never lifts the ceiling", async () => {
    await mount({ maxTotalBytes: 1 * MIB });
    await setLevel("original");
    await pickFiles([photo()]);
    expect(handed).toHaveLength(0);
    expect(decodeCount).toBe(0);
    const error = host!.querySelector(".compose-attach-error");
    expect(error?.textContent ?? "").toContain("1 MB");
  });

  it("back to High, the same photo shrinks and attaches under the same cap", async () => {
    await mount({ maxTotalBytes: 1 * MIB });
    await setLevel("original");
    await setLevel("low");
    await pickFiles([photo()]);
    expect(handed).toHaveLength(1);
    expect(encodeCalls[0]!.quality).toBe(IMAGE_QUALITY_RULES.low!.quality);
  });
});

describe("the same file twice is a skip, not a second indistinguishable row — CMP-F13", () => {
  /**
   * Same name, byte-identical admitted content ⇒ the same attachment; a second row differing
   * in nothing invites deleting the wrong one, or mailing both. The skip is SAID (role=status),
   * because a pick that silently adds nothing reads as a broken picker.
   *
   * Mutation: delete the `next.some(...)` duplicate check in `onFiles`. Real failure text:
   *   AssertionError: the same bytes under the same name attached twice — two rows nothing can
   *   tell apart: expected 2 to be 1
   */
  it("skips byte-identical re-picks and says so", async () => {
    await mount({ maxTotalBytes: 3 * MIB });
    await pickFiles([photo()]);
    expect(handed).toHaveLength(1);

    await pickFiles([photo()]);

    expect(
      handed,
      "the same bytes under the same name attached twice — two rows nothing can tell apart",
    ).toHaveLength(1);
    const note = host!.querySelector(".compose-attach-duplicate");
    expect(note, "the skip was silent — an ignored pick reads as a broken picker").not.toBeNull();
    expect(note!.textContent).toContain("photo.jpg");
    expect(note!.getAttribute("role")).toBe("status");
  });

  /** A re-pick after a dial move is a DUPLICATE now: the move already re-encoded the attached
      row to the new level, so the re-pick produces byte-identical content under the same name —
      the exact thing the skip exists for. (It used to admit both, because a move left the old
      row at its old size and re-picking was the only way to change it. That workaround is
      retired with the rule it worked around.) */
  it("a re-pick after a dial move is byte-identical and skips — the dial already updated the row", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([photo()]);
    expect(handed).toHaveLength(1);

    await setLevel("original");
    await drain();
    // The move restored the attached row to the pristine bytes…
    expect(Math.floor((handed[0]!.contentBase64.length * 3) / 4)).toBeGreaterThanOrEqual(PHOTO_BYTES);

    await pickFiles([photo()]);

    // …so the same file re-picked at Original is the same bytes under the same name: one row.
    expect(handed).toHaveLength(1);
    expect(host!.querySelector(".compose-attach-duplicate")).not.toBeNull();
  });
});

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

  /**
   * A file dropped on the surface used to be the BROWSER's: it navigates away to the file,
   * taking the half-written message off screen. `dragover` must be claimed too — without it
   * the browser never permits the drop.
   *
   * Mutation: delete the `drop`/`dragover` listeners. Real failure text:
   *   AssertionError: the drop was left to the browser — it navigates away to the file:
   *   expected 0 to be 1
   */
  it("a dropped file attaches instead of navigating the page away", async () => {
    await mount({ maxTotalBytes: 3 * MIB });
    const over = fileEvent("dragover", [photo()]);
    await act(async () => { zone().dispatchEvent(over); });
    expect(over.defaultPrevented, "dragover was not claimed, so no drop can ever land").toBe(true);

    const drop = fileEvent("drop", [photo()]);
    await act(async () => { zone().dispatchEvent(drop); });
    for (let i = 0; i < 8; i += 1) {
      await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    }
    expect(
      handed,
      "the drop was left to the browser — it navigates away to the file",
    ).toHaveLength(1);
    expect(drop.defaultPrevented).toBe(true);
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

describe("the dial re-encodes what is already attached — from the pristine source, atomically", () => {
  /**
   * ══ THE OWNER'S RULING: the quality setting applies to the message, not only the next pick ══
   *
   * The dial used to change new picks only, and the note said so. Now a move re-runs the
   * compression over every already-attached compressible picture — FROM ITS RETAINED SOURCE,
   * because a re-encode of the previous encode compounds the loss and a later move to Original
   * could never recover the file.
   *
   * Mutation: make `requalify` feed the CURRENT encode back into `compressImage` instead of the
   * retained source. Real failure text:
   *   AssertionError: the re-encode decoded the previous encode, not the pristine source —
   *   generational quality loss: expected 300820 to be 2500000
   */
  it("a move re-encodes the attached picture from the SOURCE bytes, in one commit", async () => {
    await mount({ maxTotalBytes: 3 * MIB });
    await pickFiles([photo()]);
    expect(attachmentBytes(handed[0]!)).toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.medium!.quality));
    const commitsBefore = handedHistory.length;

    await setLevel("low");
    await drain();

    // The pass decoded the PICKED bytes, never the 300 KB encode it was replacing.
    expect(
      decodeSizes[1],
      "the re-encode decoded the previous encode, not the pristine source — generational quality loss",
    ).toBe(PHOTO_BYTES);
    expect(encodeCalls[1]!.quality).toBe(IMAGE_QUALITY_RULES.low!.quality);
    // The row's bytes and its rendered size line moved to the new level…
    expect(attachmentBytes(handed[0]!)).toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.low!.quality));
    expect(handed[0]!.filename).toBe("photo.jpg");
    // …in exactly ONE commit for the whole pass.
    expect(handedHistory.length, "the re-encode pass committed more than once").toBe(commitsBefore + 1);
  });

  /**
   * Mutation: same feed-the-encode-back mutation as above — Original then "recovers" the 300 KB
   * encode instead of the original file and the size assertion goes red.
   */
  it("a move to Original recovers the exact original bytes, with no decode", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([photo()]);
    expect(decodeCount).toBe(1);

    await setLevel("original");
    await drain();

    expect(
      attachmentBytes(handed[0]!),
      "Original did not recover the pristine file — the source was not retained",
    ).toBe(PHOTO_BYTES);
    // Original never decodes: the pass answered from the retained source identically.
    expect(decodeCount).toBe(1);
  });

  /**
   * Mutation: drop the `contentBase64 === att.contentBase64` identity skip (always replace).
   * Real failure text:
   *   AssertionError: an untouched file came back as a NEW object — a move must pass
   *   non-images through as if it never happened: expected false to be true
   */
  it("non-image files pass through a move untouched — same object, same bytes", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([photo(), pdf()]);
    const pdfBefore = handed.find((a) => a.filename === "doc.pdf")!;
    expect(pdfBefore).toBeTruthy();

    await setLevel("high");
    await drain();

    const pdfAfter = handed.find((a) => a.filename === "doc.pdf")!;
    expect(
      pdfAfter === pdfBefore,
      "an untouched file came back as a NEW object — a move must pass non-images through as if it never happened",
    ).toBe(true);
    // The picture beside it DID move.
    expect(attachmentBytes(handed.find((a) => a.filename === "photo.jpg")!))
      .toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.high!.quality));
  });

  /**
   * A move UP can grow the total past the cap the send enforces. The row keeps its admitted
   * bytes — a dial move must not eject a file the user attached — and the refusal is said with
   * the enforced number.
   *
   * Mutation: drop the `running + r.bytes <= maxTotalBytes` guard in the commit. Real failure
   * text:
   *   AssertionError: the re-encode grew the total past the cap the send will refuse:
   *   expected 2500000 to be 300820
   */
  it("a re-encode that would cross the cap keeps the admitted bytes and says so", async () => {
    await mount({ maxTotalBytes: 1 * MIB });
    await pickFiles([photo()]);
    const before = attachmentBytes(handed[0]!);
    expect(before).toBeLessThan(1 * MIB);

    await setLevel("original"); // the pristine original does not fit under the cap
    await drain();

    expect(
      attachmentBytes(handed[0]!),
      "the re-encode grew the total past the cap the send will refuse",
    ).toBe(before);
    const error = host!.querySelector(".compose-attach-error");
    expect(error, "the kept size was silent — the user watches the dial do nothing").not.toBeNull();
    expect(error!.textContent).toContain("1 MB");
    expect(error!.textContent).toMatch(/kept/i);
  });

  /**
   * ══ THE TORN-MIX PIN — a send mid-pass reads settled encodes, never half a move ══════════
   *
   * The re-encode pass is async and the send button stays live under it. What a send reads is
   * the caller's state, so the guarantee under test is: NO observable list ever mixes levels
   * for the rows one move covers — the pre-move set stands until the whole pass commits at
   * once. The model encoder is held open on the SECOND picture, after the first has already
   * re-encoded, which is exactly the window a per-file commit would tear.
   *
   * Mutation: commit per file inside `requalify`'s encode loop (call `onChange` per
   * replacement). Real failure text:
   *   AssertionError: a send mid-pass would carry a TORN list — one picture at the new level,
   *   one at the old: expected 2 to be 1
   */
  it("a send mid-pass reads the settled pre-move encodes — one atomic commit settles the new ones", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([photo(), photo2()]);
    const preMove = handed;
    const commitsBefore = handedHistory.length;

    // Hold the pass open at the SECOND re-encode (calls 1–2 were the picks, 3–4 are the pass).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    encodeHold = (call) => (call === 4 ? gate : Promise.resolve());

    await setLevel("low");
    await drain(); // the first picture is re-encoded; the second is parked on the gate

    // What a send would read RIGHT NOW: the settled pre-move list, byte for byte.
    expect(
      handedHistory.length - commitsBefore,
      "a send mid-pass would carry a TORN list — one picture at the new level, one at the old",
    ).toBe(0);
    expect(handed).toBe(preMove);

    release();
    await drain();

    // One commit, both pictures at the new level together.
    expect(handedHistory.length - commitsBefore).toBe(1);
    for (const name of ["photo.jpg", "photo2.jpg"]) {
      expect(attachmentBytes(handed.find((a) => a.filename === name)!))
        .toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.low!.quality));
    }
  });

  /**
   * ══ THE SUPERSEDED PASS MUST YIELD — and the dangerous order is OLDER-COMMITS-FIRST ═══════
   *
   * Two dial moves back to back run two passes over the same rows. The older pass, already past
   * its encodes when the newer move lands, would otherwise commit the OLD level after the user
   * chose the new one — and the newer pass, whose replacements are keyed on row identities the
   * older commit just swapped out, then reconciles to a no-op: the list ends at the level the
   * user moved AWAY from, permanently. (The reverse order needs no guard: a stale pass that
   * commits last finds none of its row identities in the list and changes nothing — the
   * commit-time reconciliation is pinned by the mid-pass test above.)
   *
   * No gate here, deliberately: back-to-back moves ARE the natural interleaving under test —
   * the older pass's byte-read parks first and resumes first.
   *
   * Mutation: drop the `gen !== requalifyGen.current` checks in `requalify`. Real failure text:
   *   AssertionError: a superseded pass committed the level the user moved AWAY from:
   *   expected 300920 to be 300720
   */
  it("a newer move supersedes an in-flight pass — the stale level never lands", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([photo()]);
    const commitsBefore = handedHistory.length;

    await setLevel("high");
    await setLevel("low"); // before the first pass's byte-read settles
    await drain();

    expect(
      attachmentBytes(handed[0]!),
      "a superseded pass committed the level the user moved AWAY from",
    ).toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.low!.quality));
    // No observable list — what a send would read — ever carried the superseded level.
    for (const list of handedHistory.slice(commitsBefore)) {
      expect(
        list.map(attachmentBytes),
        "a send in the back-to-back window would have carried the superseded level",
      ).not.toContain(shrunkSizeFor(IMAGE_QUALITY_RULES.high!.quality));
    }
  });
});

describe("the review round — async commits against a live form", () => {
  /**
   * ══ THE CAP IS A WHOLE-LIST PROJECTION, NOT A PREFIX WALK ═════════════════════════════════
   *
   * A grow admitted before the rows behind it were counted committed a list the send refuses:
   * photo (grows to 700 KB, fits a 1 MiB cap ALONE) followed by a 500 KB PDF crosses the cap as
   * a whole. The pin is the committed TOTAL.
   *
   * Mutation: restore the prefix walk (admit while `running + bytes <= cap` in list order,
   * untouched rows counted only as visited). Real failure text:
   *   AssertionError: the re-encode pass committed a total the send will refuse: expected
   *   1200820 to be less than or equal to 1048576
   */
  it("a grow is admitted only if the WHOLE list still fits", async () => {
    await mount({ maxTotalBytes: 1 * MIB });
    await pickFiles([photo3(), bigPdf()]);
    const before = handed.map(attachmentBytes);
    expect(before[0]).toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.medium!.quality));
    expect(before[1]).toBe(500_000);

    await setLevel("original"); // photo3's original (700 KB) fits alone, NOT beside the PDF
    await drain();

    const total = handed.reduce((n, a) => n + attachmentBytes(a), 0);
    expect(total, "the re-encode pass committed a total the send will refuse").toBeLessThanOrEqual(1 * MIB);
    expect(attachmentBytes(handed[0]!), "the photo grew past what the list can carry").toBe(before[0]!);
    expect(host!.querySelector(".compose-attach-error")?.textContent ?? "").toMatch(/kept/i);
  });

  /**
   * ══ SOURCES OUTLIVE THE CONTROL — the list does, so the originals must ════════════════════
   *
   * `AppShell` keeps `fields.attachments` across `ComposeView`'s unmount (navigate away, come
   * back). A source map that died with the mount made every later dial move a silent no-op
   * under a note claiming re-encoding.
   *
   * Mutation: key the sources in a per-mount `useRef(new WeakMap())` again. Real failure text:
   *   AssertionError: after a remount the dial does nothing — the pristine sources died with
   *   the mount: expected 300820 to be 700000
   */
  it("a dial move after unmount/remount still re-encodes — the sources survive with the list", async () => {
    await mountLab({});
    await pickFiles([photo3()]);
    const kept = handed;
    expect(attachmentBytes(kept[0]!)).toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.medium!.quality));

    // The shell's shape: the control unmounts, the list survives, the control remounts over it.
    await mountLab({ initial: kept });
    await setLevel("original");
    await drain();

    expect(
      attachmentBytes(lastForm.atts[0]!),
      "after a remount the dial does nothing — the pristine sources died with the mount",
    ).toBe(PHOTO3_BYTES);
  });

  /**
   * ══ THE COMMIT GOES THROUGH THE LATEST CLOSURE — edits made under the pass survive ════════
   *
   * `ComposeView` spreads the WHOLE form around the new list. An async commit through the
   * closure captured when the pass STARTED wrote the pre-edit form back — a subject typed while
   * encodes ran, silently reverted.
   *
   * Mutation: capture `onChangeRef.current` at the start of `requalify` and commit through the
   * captured value. Real failure text:
   *   AssertionError: the async commit wrote the pre-edit form back: expected 'untouched' to
   *   be 'edited'
   */
  it("a form edit made while the pass runs is not written back by the commit", async () => {
    await mountLab({});
    await pickFiles([photo()]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    encodeHold = (call) => (call === 2 ? gate : Promise.resolve());
    await setLevel("low"); // the pass parks on its encode

    await press(".edit-label"); // the user keeps typing while encodes run
    expect(lastForm.label).toBe("edited");

    release();
    await drain();

    expect(lastForm.label, "the async commit wrote the pre-edit form back").toBe("edited");
    expect(attachmentBytes(lastForm.atts[0]!)).toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.low!.quality));
  });

  /**
   * ══ A DISCARDED COMPOSE STAYS DISCARDED ═══════════════════════════════════════════════════
   *
   * The reply/compose state lives in the SHELL and survives the control's unmount, so a pass
   * completing after a discard could write the thrown-away files straight back into it.
   *
   * Mutation: drop the unmount cleanup that bumps `requalifyGen`. Real failure text:
   *   AssertionError: a discarded compose was repopulated by a stale pass: expected [ …1 item ]
   *   to have a length of 0
   */
  it("a pass still encoding when the compose closes commits nothing", async () => {
    await mountLab({});
    await pickFiles([photo()]);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    encodeHold = (call) => (call === 2 ? gate : Promise.resolve());
    await setLevel("low"); // parked

    await press(".close-compose"); // discard: the control unmounts, the shell clears the list
    expect(lastForm.atts).toHaveLength(0);

    release();
    await drain();

    expect(lastForm.atts, "a discarded compose was repopulated by a stale pass").toHaveLength(0);
  });

  /**
   * ══ INTAKE AND RE-ENCODE COORDINATE — no reverts, one final level ═════════════════════════
   *
   * A paste still encoding when the dial moves used to finish against its stale snapshot: its
   * commit reverted the re-encoded rows, and its own row landed at the level the user had moved
   * off. Now the intake commits against the LATEST list and, when the dial moved under it,
   * kicks one more pass so the whole list lands at the level chosen last.
   *
   * Mutations, one per half:
   *  · build the intake's commit from its closure snapshot again. Real failure text:
   *      AssertionError: the intake's commit reverted the re-encoded row: expected 300820 to
   *      be 300720
   *  · drop the level-moved kick after the intake commit. Real failure text:
   *      AssertionError: the row picked before the move stayed at the level the user moved
   *      off: expected 300820 to be 300720
   */
  it("a pick in flight when the dial moves neither reverts the pass nor keeps the old level", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([photo()]); // photo.jpg @ medium (encode 1)

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    encodeHold = (call) => (call === 2 ? gate : Promise.resolve());
    await startPick([photo2()]); // its encode (2) parks

    await setLevel("low");
    await drain(); // the re-encode pass (encode 3) commits photo.jpg @ low
    const low = shrunkSizeFor(IMAGE_QUALITY_RULES.low!.quality);
    expect(attachmentBytes(handed[0]!)).toBe(low);
    const afterRequalify = handedHistory.length;

    release();
    await drain(); // the intake lands photo2, then the level-moved kick re-encodes it (encode 4)

    for (const list of handedHistory.slice(afterRequalify)) {
      const p1 = list.find((a) => a.filename === "photo.jpg")!;
      expect(attachmentBytes(p1), "the intake's commit reverted the re-encoded row").toBe(low);
    }
    expect(
      attachmentBytes(handed.find((a) => a.filename === "photo2.jpg")!),
      "the row picked before the move stayed at the level the user moved off",
    ).toBe(low);
  });

  /**
   * ══ THE CAP IS READ AT COMMIT TIME — the mailbox can change under the pass ════════════════
   *
   * An inline reply's From can switch to a stingier mailbox while encodes run; bytes admitted
   * against the old ceiling would be refused by the send.
   *
   * Mutation: capture `maxTotalBytesRef.current` at the start of `requalify` and admit against
   * the captured value. Real failure text:
   *   AssertionError: the pass admitted a grow against a cap that is no longer the mailbox's:
   *   expected 300920 to be 300820
   */
  it("a cap lowered while the pass runs governs its commit", async () => {
    await mountLab({ maxTotalBytes: 8 * MIB, capDrop: 300_850 });
    await pickFiles([photo3()]); // sized at medium

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    encodeHold = (call) => (call === 2 ? gate : Promise.resolve());
    await setLevel("high"); // high lands over the DROPPED cap, under the old one

    await press(".drop-cap"); // the From switched to a stingier mailbox mid-pass
    release();
    await drain();

    expect(
      attachmentBytes(lastForm.atts[0]!),
      "the pass admitted a grow against a cap that is no longer the mailbox's",
    ).toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.medium!.quality));
    expect(host!.querySelector(".compose-attach-error")?.textContent ?? "").toMatch(/kept/i);
  });

  /**
   * ══ AN IMPOSSIBLE FILE IS REFUSED BEFORE IT IS ENCODED ════════════════════════════════════
   *
   * `readAsBase64` allocates ~4/3 of the file as a string. A pick that can never fit the cap —
   * a 500 MB video under a 3 MB ceiling — must be turned away on its SIZE, known before the
   * encode, not after the tab has paid for it.
   *
   * Mutation: drop the pre-encode `picture.bytes > capNow` guard (leave the commit-time check).
   * Real failure text:
   *   AssertionError: an impossible file was base64-encoded before being refused: expected 1
   *   to be +0
   */
  it("a file that can never fit is refused without paying for its base64", async () => {
    await mount({ maxTotalBytes: 1 * MIB });
    // Count encodes through the reader the component actually uses.
    let reads = 0;
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function patched(this: FileReader, blob: Blob) {
      reads += 1;
      return original.call(this, blob);
    };
    try {
      await pickFiles([new File([new Uint8Array(2 * MIB)], "huge.bin", { type: "application/octet-stream" })]);
    } finally {
      FileReader.prototype.readAsDataURL = original;
    }
    expect(handed).toHaveLength(0);
    expect(host!.querySelector(".compose-attach-error"), "the refusal was silent").not.toBeNull();
    expect(reads, "an impossible file was base64-encoded before being refused").toBe(0);
  });

  /**
   * ══ NAVIGATION HEALS ON RETURN — the mount-time convergence ═══════════════════════════════
   *
   * An unmount kills an in-flight pass (the discard guard — a component cannot tell navigation
   * from discard), so navigating away mid-move can leave rows at the old level under a dial
   * whose new value persisted. The remount converges them: the source records carry each row's
   * encoded level, so the ask happens exactly when a row is behind.
   *
   * Mutation: empty the convergence effect's body. Real failure text:
   *   AssertionError: navigating away mid-move left old-level bytes under the persisted dial:
   *   expected 300820 to be 300720
   */
  it("rows left behind by a navigation-killed pass converge on the next mount", async () => {
    await mountLab({});
    await pickFiles([photo()]); // encoded at the default (medium)
    const kept = handed;

    // The dial moves, its pass parks on the encode, and the user navigates away: the unmount
    // kills the pass, the CHOICE persisted (storage), the rows kept the old bytes.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    encodeHold = (call) => (call === 2 ? gate : Promise.resolve());
    await setLevel("low");
    await mountLab({ initial: kept }); // unmount + remount over the SAME retained list
    release(); // the dead pass drains and yields on its bumped generation
    encodeHold = null;
    await drain();

    expect(
      attachmentBytes(lastForm.atts[0]!),
      "navigating away mid-move left old-level bytes under the persisted dial",
    ).toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.low!.quality));
  });

  /**
   * ══ A REMOVAL DURING THE KICKED PASS STAYS REMOVED ════════════════════════════════════════
   *
   * The kicked pass's commit base must know whether the ref merely lags the intake's commit or
   * the user truly changed the list. A SHAPE test (ref is the hand-off's prefix) read a tail
   * removal as an un-flushed render and re-added the removed file; the marker is explicit now.
   *
   * Mutation: replace the `pendingFlush.current === over` base test with the prefix shape test.
   * Real failure text:
   *   AssertionError: a file removed during the pass was resurrected by its commit: expected 2
   *   to be 1
   */
  it("a row removed while the kicked pass encodes is not resurrected by its commit", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([photo()]); // row 1 (encode 1)

    let releaseIntake!: () => void;
    const intakeGate = new Promise<void>((resolve) => { releaseIntake = resolve; });
    let releaseKick!: () => void;
    const kickGate = new Promise<void>((resolve) => { releaseKick = resolve; });
    // Call 2: the parked intake of photo2. Call 3: the dial pass over row 1. Call 4: the kicked
    // pass re-encoding photo2 — held open so the removal can land under it.
    encodeHold = (call) => (call === 2 ? intakeGate : call === 4 ? kickGate : Promise.resolve());
    await startPick([photo2()]);
    await setLevel("low");
    await drain(); // row 1 converges (encode 3)

    releaseIntake();
    await drain(); // the intake commits [photo@low, photo2@medium] and kicks; the kick parks (4)
    expect(handed.map((a) => a.filename)).toEqual(["photo.jpg", "photo2.jpg"]);

    // The user removes photo2 while the kicked pass is still encoding it.
    await act(async () => {
      host!.querySelectorAll<HTMLButtonElement>(".compose-attach-remove")[1]!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(handed.map((a) => a.filename)).toEqual(["photo.jpg"]);

    releaseKick();
    encodeHold = null;
    await drain();

    expect(
      handed.length,
      "a file removed during the pass was resurrected by its commit",
    ).toBe(1);
    expect(handed[0]!.filename).toBe("photo.jpg");
  });

  /**
   * ══ A DUPLICATE-SKIPPED BATCH FILE DOES NOT REFUSE THE ONE BEHIND IT ══════════════════════
   *
   * The pre-encode guard judges per-file impossibility only. A running batch pre-total counted
   * files a later dedupe skips — a batch of [already-attached photo, PDF] under a tight cap
   * refused the PDF even though the skipped duplicate freed its room.
   *
   * Mutation: reinstate the running `preTotal` in the pre-encode guard. Real failure text:
   *   AssertionError: a duplicate the commit skips still spent the cap and refused the file
   *   behind it: expected undefined to be 'big.pdf'
   */
  it("a batch whose first file is a duplicate still admits the file behind it", async () => {
    await mount({ maxTotalBytes: 1 * MIB });
    await pickFiles([photo3()]); // ~300 KB at medium
    expect(handed).toHaveLength(1);

    await pickFiles([photo3(), bigPdf()]); // duplicate (skipped) + 500 KB — fits beside 300 KB

    expect(
      handed.find((a) => a.filename === "big.pdf")?.filename,
      "a duplicate the commit skips still spent the cap and refused the file behind it",
    ).toBe("big.pdf");
    expect(host!.querySelector(".compose-attach-duplicate")).not.toBeNull();
  });

  /**
   * ══ THE HAND-OFF CLEARS THROUGH A CALLER THAT CLONES THE PROP ═════════════════════════════
   *
   * The reply panel passes `[...attachments]` — a fresh array every render — so a marker that
   * waited for the exact hand-off array to come back as the prop never cleared, and a removal
   * made while the kicked pass ran was read as an un-flushed render and resurrected (review
   * finding). The rows keep identity through the clone; the elementwise test is the signal.
   *
   * Mutation: clear `pendingFlush` on array identity alone. Real failure text:
   *   AssertionError: a file removed under a cloning caller was resurrected by the kicked pass:
   *   expected [ …(2) ] to have a length of 1
   */
  it("a removal under a caller that clones the prop is not resurrected", async () => {
    await mountLab({ maxTotalBytes: 8 * MIB, clone: true });
    await pickFiles([photo()]);

    let releaseIntake!: () => void;
    const intakeGate = new Promise<void>((resolve) => { releaseIntake = resolve; });
    let releaseKick!: () => void;
    const kickGate = new Promise<void>((resolve) => { releaseKick = resolve; });
    encodeHold = (call) => (call === 2 ? intakeGate : call === 4 ? kickGate : Promise.resolve());
    await startPick([photo2()]);
    await setLevel("low");
    await drain(); // row 1 converges (encode 3)

    releaseIntake();
    await drain(); // the intake commits and kicks; the kick parks on photo2's encode (4)
    expect(lastForm.atts.map((a) => a.filename)).toEqual(["photo.jpg", "photo2.jpg"]);

    await act(async () => {
      host!.querySelectorAll<HTMLButtonElement>(".compose-attach-remove")[1]!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(lastForm.atts.map((a) => a.filename)).toEqual(["photo.jpg"]);

    releaseKick();
    encodeHold = null;
    await drain();

    expect(
      lastForm.atts,
      "a file removed under a cloning caller was resurrected by the kicked pass",
    ).toHaveLength(1);
    expect(lastForm.atts[0]!.filename).toBe("photo.jpg");
  });

  /**
   * ══ A BATCH THE CAP CANNOT TAKE IS NOT ENCODED WHOLESALE ══════════════════════════════════
   *
   * Non-image files skip the compressor, so `readAsBase64` is the whole cost: ten near-cap
   * files would stage hundreds of MB of strings for a commit that admits one. The bound counts
   * the live list plus this pick's ACCEPTED files, so only what could still be admitted is
   * encoded — and the duplicate-skip keeps its room (pinned above).
   *
   * Mutation: drop the aggregate term from the pre-encode bound (per-file impossibility only).
   * Real failure text:
   *   AssertionError: a batch the cap cannot take was base64-encoded wholesale: expected 3 to
   *   be 1
   */
  it("near-cap batch tails are refused before their base64 is paid for", async () => {
    await mount({ maxTotalBytes: 1 * MIB });
    let reads = 0;
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function patched(this: FileReader, blob: Blob) {
      reads += 1;
      return original.call(this, blob);
    };
    try {
      const nearCap = (n: number): File =>
        new File([new Uint8Array(800_000)], `slab-${n}.bin`, { type: "application/octet-stream" });
      await pickFiles([nearCap(1), nearCap(2), nearCap(3)]);
    } finally {
      FileReader.prototype.readAsDataURL = original;
    }
    expect(handed).toHaveLength(1); // the one that fits
    expect(reads, "a batch the cap cannot take was base64-encoded wholesale").toBe(1);
    expect(host!.querySelector(".compose-attach-error")).not.toBeNull();
  });

  /**
   * ══ STAGING IS NOT ADMISSION — a cap lowered mid-batch frees the room its refusals free ═══
   *
   * The pre-encode bound is a memory guard, and a running reservation made it an admission
   * gate: a file staged under the old cap kept charging after the cap dropped below it, turning
   * away a later file the commit would have admitted — so NEITHER landed. The bound now
   * reprojects the staged candidates against the cap and list as they stand at each file.
   *
   * Mutation: restore the running `acceptedPreBytes` reservation. Real failure text:
   *   AssertionError: a staged file the commit will refuse blocked the smaller one that fits:
   *   expected [] to deeply equal [ 'slab-100.bin' ]
   */
  it("a cap lowered mid-batch still admits the file that fits it", async () => {
    await mountLab({ maxTotalBytes: 1 * MIB, capDrop: 500_000 });
    const original = FileReader.prototype.readAsDataURL;
    let readCalls = 0;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    FileReader.prototype.readAsDataURL = function patched(this: FileReader, blob: Blob) {
      readCalls += 1;
      if (readCalls === 1) {
        void readGate.then(() => original.call(this, blob)); // park the FIRST file's encode
        return;
      }
      return original.call(this, blob);
    };
    try {
      const slab = (n: number): File =>
        new File([new Uint8Array(n * 1000)], `slab-${n}.bin`, { type: "application/octet-stream" });
      await startPick([slab(800), slab(100)]); // 800 KB stages under the 1 MiB cap and parks
      await press(".drop-cap"); // the From switches to a 500 KB mailbox mid-batch
      releaseRead();
      await drain();
    } finally {
      FileReader.prototype.readAsDataURL = original;
    }

    expect(
      lastForm.atts.map((a) => a.filename),
      "a staged file the commit will refuse blocked the smaller one that fits",
    ).toEqual(["slab-100.bin"]);
    // The 800 KB file was honestly refused — and said so.
    expect(host!.querySelector(".compose-attach-error")).not.toBeNull();
  });

  /**
   * ══ A CAP DIP MID-BATCH IS A STATED PICK-TIME REFUSAL, NEVER A SILENT OR TORN STATE ═══════
   *
   * A candidate the dipped cap strands is refused THEN — evicted for memory and reported on the
   * error line — exactly as a file picked under that cap would have been. Deliberately NOT
   * reconsidered when the cap restores before the commit: that mechanism was built and reverted
   * (it put awaits back inside the settled commit, and the atomic-commit hazards returned
   * through them). The pin is the honest outcome: the still-staged file lands, the stranded one
   * is refused OUT LOUD, and nothing over-cap or torn ever commits.
   *
   * Mutation: strand silently (splice without setting `refused`). Real failure text:
   *   AssertionError: the stranded file vanished without a word — a silent refusal reads as a
   *   broken picker: expected null not to be null
   */
  it("a cap dip mid-batch refuses the stranded file out loud and keeps the one that fits", async () => {
    await mountLab({ maxTotalBytes: 1 * MIB, capDrop: 500_000 });
    const original = FileReader.prototype.readAsDataURL;
    let readCalls = 0;
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    FileReader.prototype.readAsDataURL = function patched(this: FileReader, blob: Blob) {
      readCalls += 1;
      if (readCalls === 2) {
        void readGate.then(() => original.call(this, blob)); // park the SECOND file's encode
        return;
      }
      return original.call(this, blob);
    };
    try {
      const slab = (n: number): File =>
        new File([new Uint8Array(n * 1000)], `slab-${n}.bin`, { type: "application/octet-stream" });
      await startPick([slab(800), slab(100)]); // 800 stages under 1 MiB; 100 parks mid-read
      await press(".drop-cap"); // the dip strands the 800 KB candidate
      await press(".restore-cap"); // a restore before the commit does not resurrect it
      releaseRead();
      await drain();
    } finally {
      FileReader.prototype.readAsDataURL = original;
    }

    expect(lastForm.atts.map((a) => a.filename)).toEqual(["slab-100.bin"]);
    const error = host!.querySelector(".compose-attach-error");
    expect(
      error,
      "the stranded file vanished without a word — a silent refusal reads as a broken picker",
    ).not.toBeNull();
    // The sentence names the cap the refusal was MADE under — the dipped 500 KB — never the
    // restored 1 MiB, which the refused file would actually have fit (claims are contracts).
    expect(
      error!.textContent,
      "the refusal claims a limit the refused file fits",
    ).toContain("500 KB");
    expect(error!.textContent).not.toContain("1 MB");
  });

  /**
   * ══ AN UNREADABLE FILE IS NOT A SIZE STORY ════════════════════════════════════════════════
   *
   * A file whose read fails (the browser lost access to it) used to render the cap sentence —
   * falsely attributing a read failure to a size limit the file may be far below. It has its
   * own sentence now, with no number to be wrong about.
   *
   * Mutation: fold the read failure back into the cap refusal (`refuseAt(cap)` in the catch).
   * Real failure text:
   *   AssertionError: a read failure was blamed on the size cap: expected 'Some files were not
   *   added — they would ha…' to contain 'read'
   */
  it("a file the browser cannot read gets the read sentence, never the size one", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function patched(this: FileReader) {
      // The browser lost access to the picked file: the read errors.
      setTimeout(() => {
        this.dispatchEvent(new ProgressEvent("error"));
      }, 0);
    } as never;
    try {
      await pickFiles([pdf()]); // far below the cap — size is not the story
    } finally {
      FileReader.prototype.readAsDataURL = original;
    }

    expect(handed).toHaveLength(0);
    const error = host!.querySelector(".compose-attach-error");
    expect(error).not.toBeNull();
    expect(
      error!.textContent,
      "a read failure was blamed on the size cap",
    ).toContain("read");
    expect(error!.textContent).not.toMatch(/MB|KB/);
  });

  /**
   * ══ A MIXED BATCH SAYS BOTH — the cap refusal and the read failure ════════════════════════
   *
   * One sentence standing in for the other left the unreadable file reading as a second size
   * refusal. Both outcomes render, each in its own words.
   *
   * Mutation: make the two sentences exclusive again (`else if`). Real failure text:
   *   AssertionError: the unreadable file was folded into the size refusal: expected 'Some
   *   files were not added — they would ha…' to contain 'read'
   */
  it("a batch with a read failure AND a cap refusal states both", async () => {
    await mount({ maxTotalBytes: 1 * MIB });
    const original = FileReader.prototype.readAsDataURL;
    let readCalls = 0;
    FileReader.prototype.readAsDataURL = function patched(this: FileReader, blob: Blob) {
      readCalls += 1;
      if (readCalls === 1) {
        // The FIRST file's read fails; the rest read normally.
        setTimeout(() => {
          this.dispatchEvent(new ProgressEvent("error"));
        }, 0);
        return;
      }
      return original.call(this, blob);
    };
    try {
      // pdf (50 KB, read fails) + a photo far over the cap once at Original quality.
      await setLevel("original");
      await pickFiles([pdf(), photo()]); // photo at original is over the cap → cap refusal
    } finally {
      FileReader.prototype.readAsDataURL = original;
    }

    expect(handed).toHaveLength(0);
    const error = host!.querySelector(".compose-attach-error");
    expect(error).not.toBeNull();
    expect(
      error!.textContent,
      "the unreadable file was folded into the size refusal",
    ).toContain("read");
    expect(error!.textContent, "the cap refusal went unsaid").toContain("1 MB");
  });

  /**
   * ══ THE COLLAPSE RUNS BEFORE THE CAP PROJECTS ═════════════════════════════════════════════
   *
   * The re-pick race under a tight cap: the list briefly holds [photo@high, photo@medium], the
   * kicked pass targets both at high, and the cap fits the mixed pair but not two highs. A
   * collapse AFTER admission compared a cap-kept medium against a high — different keys, both
   * kept, the same file sent twice. The collapse now runs on the TARGET encodes first, so the
   * twin is dropped before the cap can strand it.
   *
   * Mutation: run the duplicate collapse after cap admission again (or key it on committed
   * bytes). Real failure text:
   *   AssertionError: the cap stranded the twin at its old bytes and both rode the send:
   *   expected 2 to be 1
   */
  it("the re-pick race under a tight cap still ends as ONE row", async () => {
    // a high plus a medium fits under the cap; two highs would not.
    await mount({ maxTotalBytes: 601_800 });
    await pickFiles([photo()]); // row 1 at medium (encode 1)

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    encodeHold = (call) => (call === 2 ? gate : Promise.resolve());
    await startPick([photo()]); // the SAME file; its encode (2) parks at medium

    await setLevel("high");
    await drain(); // row 1 converges to high (encode 3): within the cap

    release();
    encodeHold = null;
    await drain(); // the intake admits the medium twin (mixed pair fits), the kick collapses it

    expect(
      handed.length,
      "the cap stranded the twin at its old bytes and both rode the send",
    ).toBe(1);
    expect(attachmentBytes(handed[0]!)).toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.high!.quality));
  });

  /**
   * ══ CONVERGENCE COLLAPSES THE RE-PICK RACE'S DUPLICATE ════════════════════════════════════
   *
   * Re-pick an attached photo while its row is being re-encoded to another level: the intake's
   * duplicate check compares its old-level bytes against the row's new-level bytes, misses, and
   * admits a second row — which the level kick then converts into an exact duplicate the send
   * would transmit twice.
   *
   * Mutation: drop the dedupe filter in `requalify`'s commit. Real failure text:
   *   AssertionError: the same file rides the message twice after the convergence: expected 2
   *   to be 1
   */
  it("a re-pick racing a level move ends as ONE row, not a byte-identical pair", async () => {
    await mount({ maxTotalBytes: 8 * MIB });
    await pickFiles([photo()]); // row 1 at medium (encode 1)

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    encodeHold = (call) => (call === 2 ? gate : Promise.resolve());
    await startPick([photo()]); // the SAME file again; its encode (2) parks at medium

    await setLevel("low");
    await drain(); // row 1 converges to low (encode 3) while the re-pick is still parked

    release();
    encodeHold = null;
    await drain(); // the intake admits its medium twin, and the kick converges + collapses

    expect(
      handed.length,
      "the same file rides the message twice after the convergence",
    ).toBe(1);
    expect(attachmentBytes(handed[0]!)).toBe(shrunkSizeFor(IMAGE_QUALITY_RULES.low!.quality));
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
