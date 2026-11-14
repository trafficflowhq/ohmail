/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { HttpAdapter, OhmailEngine, threadOf } from "@ohmail/client-engine";
import { AttachmentStrip } from "../app/components/AttachmentStrip.js";
import { MessageBody } from "../app/letter-body/MessageBody.js";
import { useMessageAttachments } from "../app/shell/attachments.js";

/**
 * ═══ EVERY PART OF A MESSAGE IS DOWNLOADABLE, WHICHEVER WAY THE BODY DRAWS ═════════════════
 *
 * The strip used to list a `cid:` part only where the body was not painting it — the frameless
 * rendering — on the argument that a framed message listing its own logo names the same picture
 * twice. That rule was reversed (2026-09-19): inline pictures display IN PLACE and every part
 * stays in the Files list and in "Download all", on every rendering. The row explains itself
 * with a quiet "embedded" tag, and the real files come first.
 *
 * The data-loss direction is the half that must never regress: a `cid:`-referenced part is
 * `inline` (mime.ts promotes it), and a list that hides inline parts hides a PDF the html happens
 * to reference — a real file, reachable from nowhere. So the last case drives a non-image inline
 * part through the same wire.
 *
 * ── WHY THIS MOUNTS BOTH COMPONENTS ─────────────────────────────────────────────────────
 *
 * The harness below is `MessagePane`'s own wiring — the strip fed by the shell hook's `itemsOf`
 * with `{ includeInlineParts: true }`, beside the body that renders the same message — so the
 * assertions are about what a reader gets, not about the engine's filter in isolation.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/** `MessagePane`'s wiring of the two components, copied verbatim. */
function Harness({ engine, messageId, text, html }: {
  engine: OhmailEngine;
  messageId: string;
  text: string;
  html: string | null;
}): React.ReactElement {
  const attachments = useMessageAttachments(engine, messageId, { conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
  return h(
    React.Fragment,
    null,
    h(MessageBody, { messageId, text, html }),
    attachments
      ? h(AttachmentStrip, {
          items: attachments.itemsOf(messageId, { includeInlineParts: true }),
          onOpen: () => {},
          onDownloadAll: () => {},
          downloadingAll: false,
        })
      : null,
  );
}

async function render(props: Parameters<typeof Harness>[0]): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(h(Harness, props)); });
  // The list read, the sanitize pass and the byte fetches all land in effects.
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

/** Everything the strip drew, as one string — filenames live in `.att-name`. */
const stripText = (): string =>
  [...host!.querySelectorAll(".att-strip")].map((n) => n.textContent ?? "").join(" ");

const tiles = (): HTMLElement[] => [...host!.querySelectorAll<HTMLElement>(".att-tile")];

/** The filenames in tile order — what the partition promise is about. */
const tileNames = (): string[] =>
  tiles().map((t) => t.querySelector(".att-name")?.textContent ?? "");

/** The tiles wearing the "embedded" tag. */
const marked = (): HTMLElement[] =>
  tiles().filter((t) => t.querySelector(".att-inline") !== null);

/** The "Show original" / "Show as text" flip — a quiet control after the body, which only a
    prose message renders (`.mb-flip`, no longer a button inside the bar). */
const designButton = (): HTMLButtonElement | null =>
  [...host!.querySelectorAll<HTMLButtonElement>(".mb-flip")]
    .find((b) => /original|text/i.test(b.textContent ?? "")) ?? null;

/** A `cid:` picture the sender embedded, and a file they attached. */
const LOGO = {
  id: "a-logo", filename: "signature-logo.png", contentType: "image/png",
  sizeBytes: 24_000, inline: true, messageId: "m1",
};
const INVOICE = {
  id: "a-invoice", filename: "invoice.pdf", contentType: "application/pdf",
  sizeBytes: 2_300_000, inline: false, messageId: "m1",
};

function engineListing(items: Array<Record<string, unknown>>): OhmailEngine {
  const fetchImpl = async (): Promise<Response> =>
    new Response(JSON.stringify({ items }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  return new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "/api", fetch: fetchImpl as never }) });
}

/** What a real client sends for a reply with a picture in it: no canvas anywhere. */
const LETTER =
  `<div dir="ltr"><p>Here's the shot from Friday.</p>` +
  `<img src="cid:${LOGO.id}" width="320" height="240">` +
  `<p>— Sam</p></div>`;
const LETTER_TEXT = "Here's the shot from Friday.\n\n— Sam";

/** A designed newsletter: a declared 600 px canvas, which is the whole rigidity test. */
const NEWSLETTER =
  `<table width="600" cellpadding="0"><tr><td>` +
  `<img src="cid:${LOGO.id}" width="600" height="120">` +
  `<p>This month at the atelier.</p></td></tr></table>`;
const NEWSLETTER_TEXT = "This month at the atelier.";

describe("every part of a message is reachable from the strip", () => {
  it("the frameless rendering lists the picture AND the file — logo marked, invoice first", async () => {
    /**
     * The message carries one `cid:` picture and one real file, classifies as prose (no canvas)
     * — the signature-logo shape. Both are listed: the file first and unmarked, the
     * embedded picture after it wearing the tag. The wire order is [LOGO, INVOICE], so the
     * order below is the PARTITION's doing — mutate the files-first split in `itemsOf` and the
     * order assertion goes red.
     */
    await render({ engine: engineListing([LOGO, INVOICE]), messageId: "m1", text: LETTER_TEXT, html: LETTER });

    // The premise: this really is the frameless rendering — no iframe, and the text on screen.
    expect(host!.querySelector("iframe"), "the fixture was drawn in a frame, so it proves nothing").toBeNull();

    expect(tiles()).toHaveLength(2);
    expect(tileNames()[0], "the real file leads the list").toContain("invoice.pdf");
    expect(tileNames()[1]).toContain("signature-logo.png");
    expect(marked(), "exactly the embedded picture wears the tag").toHaveLength(1);
    expect(marked()[0]!.querySelector(".att-name")?.textContent).toContain("signature-logo.png");
  });

  it("the framed rendering lists the picture too — downloadable even where the frame paints it", async () => {
    /**
     * The reversal, stated: the old filter withheld a framed message's inline pictures ("named
     * twice"); the ruling is that every part stays downloadable everywhere, and the tag is what
     * carries the "this is the picture in the message" fact instead of absence.
     */
    await render({
      engine: engineListing([LOGO, INVOICE]), messageId: "m1",
      text: NEWSLETTER_TEXT, html: NEWSLETTER,
    });

    expect(host!.querySelector("iframe"), "the fixture was NOT drawn in a frame, so it proves nothing")
      .not.toBeNull();

    expect(stripText()).toContain("signature-logo.png");
    expect(stripText()).toContain("invoice.pdf");
    expect(tiles()).toHaveLength(2);
    expect(marked()).toHaveLength(1);
  });

  it("'Show original' brings the frame back, and the list does not move", async () => {
    /**
     * The strip is no longer coupled to which rendering is on screen — the press flips the body
     * to the sender's own document and the Files list stays exactly what it was, because what a
     * reader may download is not a function of how the mail is drawn.
     */
    await render({ engine: engineListing([LOGO, INVOICE]), messageId: "m1", text: LETTER_TEXT, html: LETTER });
    expect(stripText()).toContain("signature-logo.png");

    const button = designButton();
    expect(button, "the prose letter offered no way back to the sender's own rendering").not.toBeNull();
    await act(async () => { button!.click(); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });

    expect(host!.querySelector("iframe"), "the press did not bring the frame back").not.toBeNull();
    expect(stripText()).toContain("signature-logo.png");
    expect(stripText()).toContain("invoice.pdf");
    expect(tiles()).toHaveLength(2);
  });

  it("a message with no pictures is unchanged, whichever way it is drawn", async () => {
    /* The common case, and the one a widened list must not disturb: nothing inline, so both
       renderings list exactly the file that was always listed — and no tag anywhere. */
    await render({ engine: engineListing([INVOICE]), messageId: "m1", text: LETTER_TEXT, html: LETTER });
    expect(tiles()).toHaveLength(1);
    expect(stripText()).toContain("invoice.pdf");
    expect(marked()).toHaveLength(0);

    await render({
      engine: engineListing([INVOICE]), messageId: "m1",
      text: NEWSLETTER_TEXT, html: NEWSLETTER,
    });
    expect(tiles()).toHaveLength(1);
    expect(stripText()).toContain("invoice.pdf");
    expect(marked()).toHaveLength(0);
  });

  it("a cid:-referenced NON-IMAGE part stays in the list — the data-loss direction", async () => {
    /**
     * mime.ts promotes any part the html names to `inline`, whatever its type — so a PDF the
     * body references would vanish from a list that admitted only inline PICTURES, which is the
     * exact data loss `isRealFile`'s comment warns about. Every inline part is listed now; the
     * body renders nothing inline for it (the mint refuses non-raster types), so the tile is
     * the ONLY place this file exists.
     */
    const REFERENCED_PDF = {
      id: "a-terms", filename: "terms.pdf", contentType: "application/pdf",
      sizeBytes: 90_000, inline: true, messageId: "m1",
    };
    await render({
      engine: engineListing([LOGO, REFERENCED_PDF, INVOICE]), messageId: "m1",
      text: LETTER_TEXT, html: LETTER,
    });

    expect(stripText()).toContain("terms.pdf");
    expect(stripText()).toContain("signature-logo.png");
    expect(stripText()).toContain("invoice.pdf");
    expect(tiles()).toHaveLength(3);
    // Files first: the unmarked invoice leads; both inline parts follow, each wearing the tag.
    expect(tileNames()[0]).toContain("invoice.pdf");
    expect(marked()).toHaveLength(2);
  });
});
