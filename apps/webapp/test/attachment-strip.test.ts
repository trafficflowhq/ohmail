/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AttachmentStrip,
  type AttachmentItem,
  type AttachmentStripProps,
  type AttachmentsView,
} from "../app/components/AttachmentStrip.js";

/**
 * THE ATTACHMENT STRIP, AGAINST THE CONTRACT THE DATA PATH IS BUILT TO.
 *
 * The component is mounted alone, on purpose: its wiring into `MessagePane` belongs to
 * the slice that owns the data path, and these assertions are about the strip's own
 * promises — which states are pressable, what each state SAYS, and the consent gate on
 * the thumbnail. The last one is the assertion that costs the most to lose: `objectUrl`
 * is rendered only when it is `blob:`/`data:` (bytes the app already holds from the
 * user's own mailbox), so a remote URL handed through the prop can never become a
 * network fetch from the reading pane. That is `no-third-party.test.ts`'s posture,
 * asserted at this component's edge.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(props: AttachmentStripProps): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(h(AttachmentStrip, props)));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

function item(over: Partial<AttachmentItem> = {}): AttachmentItem {
  return {
    id: "a1",
    filename: "invoice-march.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2_300_000,
    state: "idle",
    ...over,
  };
}

/**
 * A `ready` LIST of these items.
 *
 * `AttachmentStripProps.items` is the list AND what is known about it, so every
 * assertion below about a rendered tile has to say which list state it is asserting under.
 * The list's own states are asserted in `attachment-list-state.at6.test.ts`.
 */
const ready = (...items: AttachmentItem[]): AttachmentsView => ({ state: "ready", items });

const noop = { onOpen: () => {}, onDownloadAll: () => {}, downloadingAll: false };

describe("AttachmentStrip", () => {
  it("idle says the true thing — the size, and that the bytes are in the mailbox", async () => {
    const onOpen = vi.fn();
    await mount({ ...noop, items: ready(item()), onOpen });
    const tile = host!.querySelector<HTMLButtonElement>(".att-tile")!;
    expect(tile.tagName).toBe("BUTTON");
    expect(tile.dataset.state).toBe("idle");
    expect(tile.textContent).toContain("2.3 MB · in your mailbox");
    /* The extension survives any stem truncation — it is its own element. */
    expect(tile.querySelector(".att-ext")!.textContent).toBe(".pdf");
    expect(tile.querySelector(".att-stem")!.textContent).toBe("invoice-march");
    await act(async () => tile.click());
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("a single attachment gets no inventory and no group verb", async () => {
    await mount({ ...noop, items: ready(item()) });
    expect(host!.querySelector(".att-head")).toBeNull();
    expect(host!.textContent).not.toContain("Download all");
  });

  it("loading names the wait and its source, and the press is inert without losing the element", async () => {
    const onOpen = vi.fn();
    await mount({ ...noop, items: ready(item({ state: "loading" })), onOpen });
    const tile = host!.querySelector<HTMLButtonElement>(".att-tile")!;
    expect(tile.tagName).toBe("BUTTON"); // same element as idle — focus survives the fetch
    expect(tile.getAttribute("aria-busy")).toBe("true");
    expect(tile.textContent).toContain("Fetching from your mailbox…");
    await act(async () => tile.click());
    expect(onOpen).not.toHaveBeenCalled();
    /* The wait's mark is the PRODUCT'S loader and not a ring of this file's own: the strip
       used to draw a rotating border, which under ohmarchy's square radius token read as a
       spinning box. `pathLength` is the primitive's whole construction — it normalises the
       round and the square frame to one dash space so the segment travels the path instead
       of the path turning. */
    const mark = tile.querySelector(".att-spin")!;
    expect(mark.tagName.toLowerCase()).toBe("svg");
    expect(mark.classList.contains("spin")).toBe(true);
    expect(mark.querySelectorAll("rect[pathLength='100']").length).toBe(2);
  });

  it("ready shows an image's own pixels — but only from bytes the app already holds", async () => {
    await mount({
      ...noop,
      items: ready(
        item({ id: "ok", filename: "photo.jpg", mimeType: "image/jpeg", state: "ready", objectUrl: "blob:http://x/1" }),
        item({ id: "smuggled", filename: "pixel.png", mimeType: "image/png", state: "ready", objectUrl: "https://tracker.example/p.png" }),
      ),
    });
    const tiles = host!.querySelectorAll(".att-tile");
    expect(tiles[0]!.querySelector("img")!.getAttribute("src")).toBe("blob:http://x/1");
    /* A remote URL in the prop renders the glyph, never an <img> — the consent gate. */
    expect(tiles[1]!.querySelector("img")).toBeNull();
  });

  it("a retryable failure is the retry, names the side that failed, and says so in words", async () => {
    const onOpen = vi.fn();
    await mount({
      ...noop,
      items: ready(item({ state: "failed", error: "IMAP timed out", code: "mailbox_read_timeout", retryable: true, status: 504 })),
      onOpen,
    });
    const tile = host!.querySelector<HTMLButtonElement>(".att-tile")!;
    expect(tile.textContent).toContain("Your mail server didn't answer — try again");
    expect(tile.title).toBe("Your mail server didn't answer");
    await act(async () => tile.click());
    expect(onOpen).toHaveBeenCalledWith("a1");
  });

  it("too_large is not dressed as openable: not a button, and honest about the fact", async () => {
    await mount({ ...noop, items: ready(item({ sizeBytes: 18_200_000, state: "too_large" })) });
    const tile = host!.querySelector(".att-tile")!;
    expect(tile.tagName).toBe("DIV");
    expect(tile.textContent).toContain("18.2 MB · too large to fetch");
  });

  it("plural grows an inventory line and one group verb", async () => {
    const onDownloadAll = vi.fn();
    await mount({
      ...noop,
      items: ready(item(), item({ id: "a2", filename: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 3_800_000 })),
      onDownloadAll,
    });
    expect(host!.querySelector(".att-sum")!.textContent).toBe("2 attachments · 6.1 MB");
    const all = host!.querySelector<HTMLButtonElement>(".att-all")!;
    expect(all.textContent).toContain("Download all");
    await act(async () => all.click());
    expect(onDownloadAll).toHaveBeenCalledTimes(1);
  });

  it("while downloading all, the verb reports work and cannot be re-fired", async () => {
    const onDownloadAll = vi.fn();
    await mount({
      ...noop,
      items: ready(item(), item({ id: "a2" })),
      onDownloadAll,
      downloadingAll: true,
    });
    const all = host!.querySelector<HTMLButtonElement>(".att-all")!;
    expect(all.textContent).toContain("Fetching…");
    expect(all.getAttribute("aria-disabled")).toBe("true");
    await act(async () => all.click());
    expect(onDownloadAll).not.toHaveBeenCalled();
  });

  it("an unknown binary wears its extension instead of a dressed-up icon", async () => {
    await mount({
      ...noop,
      items: ready(item({ filename: "backup.tar.gz", mimeType: "application/octet-stream" })),
    });
    expect(host!.querySelector(".att-badge")!.textContent).toBe("GZ");
  });

  it("renders nothing at all for zero attachments", async () => {
    await mount({ ...noop, items: ready() });
    expect(host!.querySelector(".att-strip")).toBeNull();
  });
});

/**
 * ═══ A PRESS LOOKS, WHERE LOOKING IS POSSIBLE; SAVING IS THE CORNER ═══════════════════════
 *
 * The two verbs traded places. The tile used to save every type alike, on the argument that
 * saving is what people come to an attachment for — half right, and the wrong half is the
 * expensive one: an attachment is usually opened to be READ once, and a press that put the file
 * in ~/Downloads made the reader find it, open it elsewhere, and then delete it. Where this app
 * can draw the file, drawing it is what the press should do.
 *
 * WHICH FILES MAY BE DRAWN IS NOT THIS COMPONENT'S DECISION, AND DID NOT MOVE. `canPreview` is
 * still asked, because the answer decides whether bytes from a stranger get rendered, and that
 * judgement has one owner (`isPreviewable`, which refuses SVG for being a document that executes
 * script). A strip with no predicate previews nothing and every tile saves — so a surface with
 * no viewer behind it is correct without a special case.
 */
describe("the two verbs", () => {
  const pdf = () => item({ id: "doc", filename: "invoice.pdf", mimeType: "application/pdf" });
  const svg = () => item({ id: "mark", filename: "mark.svg", mimeType: "image/svg+xml" });
  const canPreview = (i: AttachmentItem) => i.mimeType === "application/pdf";

  it("pressing the tile PREVIEWS a file this app can draw", async () => {
    // Mutation: `onClick={() => onOpen(item.id)}` on the tile — the pre-swap wiring. Real
    // failure text:
    //   AssertionError: the tile saved instead of showing the file: expected "spy" to be
    //   called with arguments: [ 'doc' ]
    const onOpen = vi.fn();
    const onPreview = vi.fn();
    await mount({ ...noop, items: ready(pdf()), onOpen, onPreview, canPreview });
    await act(async () => host!.querySelector<HTMLButtonElement>(".att-tile")!.click());
    expect(onPreview, "the tile saved instead of showing the file").toHaveBeenCalledWith("doc");
    expect(onOpen, "the press put a file on the disk as well as on the screen").not.toHaveBeenCalled();
  });

  it("saving is the corner control, and a SIBLING — a button inside a button is not a button", async () => {
    const onOpen = vi.fn();
    const onPreview = vi.fn();
    await mount({ ...noop, items: ready(pdf()), onOpen, onPreview, canPreview });
    const side = host!.querySelector<HTMLButtonElement>(".att-side")!;
    expect(side, "no way to save a file that can be previewed").not.toBeNull();
    expect(side.getAttribute("aria-label")).toBe("Download invoice.pdf");
    // Nested buttons are invalid markup and the browser picks the target for you.
    expect(host!.querySelector(".att-tile .att-side")).toBeNull();
    await act(async () => side.click());
    expect(onOpen).toHaveBeenCalledWith("doc");
    expect(onPreview, "the download also opened the viewer").not.toHaveBeenCalled();
  });

  /**
   * THE SECURITY JUDGEMENT DID NOT MOVE WITH THE GEOMETRY, and this is the test that says so.
   * An SVG is a document that executes script; it is refused a viewer, so its tile falls back to
   * the verb every attachment has — save — and it grows no second control, because a corner
   * Download beside a tile that downloads is one act with two names.
   *
   * Mutation: `const canLook = item.state !== "failed";` (dropping the `onPreview != null`
   * term). Real failure text:
   *   AssertionError: an SVG's press opened a viewer — it is a document that executes script:
   *   expected "spy" to be called with arguments: [ 'mark' ]
   */
  it("a file this app will not render is saved by its press, and has no second control", async () => {
    const onOpen = vi.fn();
    const onPreview = vi.fn();
    await mount({ ...noop, items: ready(pdf(), svg()), onOpen, onPreview, canPreview });
    const items = host!.querySelectorAll(".att-item");
    expect(items).toHaveLength(2);
    expect(items[0]!.querySelector(".att-side"), "a previewable file lost its Download").not.toBeNull();
    expect(
      items[1]!.querySelector(".att-side"),
      "an SVG grew a second control beside a tile that already saves",
    ).toBeNull();

    await act(async () => items[1]!.querySelector<HTMLButtonElement>(".att-tile")!.click());
    expect(onOpen, "an SVG's press did not save it").toHaveBeenCalledWith("mark");
    expect(
      onPreview,
      "an SVG's press opened a viewer — it is a document that executes script",
    ).not.toHaveBeenCalled();
  });

  it("no predicate, no viewer: every tile saves and the strip never guesses", async () => {
    const onOpen = vi.fn();
    await mount({ ...noop, items: ready(pdf()), onOpen });
    expect(host!.querySelector(".att-side")).toBeNull();
    await act(async () => host!.querySelector<HTMLButtonElement>(".att-tile")!.click());
    expect(onOpen).toHaveBeenCalledWith("doc");
  });

  it("nothing to look at yet: too_large and failed carry no second control", async () => {
    await mount({
      ...noop,
      items: ready(
        item({ id: "big", mimeType: "application/pdf", state: "too_large" }),
        item({ id: "bad", mimeType: "application/pdf", state: "failed", error: "IMAP timed out" }),
      ),
      onPreview: () => {},
      canPreview,
    });
    expect(host!.querySelectorAll(".att-side")).toHaveLength(0);
  });

  /**
   * A FAILED TILE IS STILL THE RETRY. Its press goes to `onOpen`, which re-asks and saves —
   * unchanged by the swap, because there are no bytes to preview and an overlay over nothing is
   * not a viewer. The tile's own copy ends "try again", so a press that did not re-ask would make
   * that sentence a lie.
   */
  it("a failed tile's press still re-asks and saves, whatever its type", async () => {
    const onOpen = vi.fn();
    const onPreview = vi.fn();
    await mount({
      ...noop,
      items: ready(item({ id: "bad", mimeType: "application/pdf", state: "failed", error: "IMAP timed out" })),
      onOpen,
      onPreview,
      canPreview,
    });
    await act(async () => host!.querySelector<HTMLButtonElement>(".att-tile")!.click());
    expect(onOpen).toHaveBeenCalledWith("bad");
    expect(onPreview).not.toHaveBeenCalled();
  });

  it("mid-fetch the corner control is inert, and keeps its focus the way the tile does", async () => {
    const onOpen = vi.fn();
    await mount({
      ...noop,
      items: ready(item({ id: "doc", mimeType: "application/pdf", state: "loading" })),
      onOpen,
      onPreview: () => {},
      canPreview,
    });
    const side = host!.querySelector<HTMLButtonElement>(".att-side")!;
    expect(side.getAttribute("aria-disabled")).toBe("true");
    expect(side.hasAttribute("disabled"), "`disabled` drops focus mid-wait").toBe(false);
    await act(async () => side.click());
    expect(onOpen).not.toHaveBeenCalled();
  });
});
