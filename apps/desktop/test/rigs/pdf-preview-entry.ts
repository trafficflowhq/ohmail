/* The window's PDF preview as `window-pdf-preview.test.ts` drives it in Chromium: the window's own
 * pdf.js module (`src/window-pdfjs.ts`, loading the library and worker the page's server holds),
 * the call `AttachmentPreview` makes, one page drawn to a canvas, its centre pixel read back.
 * `open` brings a PDF through the desktop's real path first: the bridge adapter, a real engine and
 * the overlay's `ensurePreview`, under the guard as Windows ships it. */
import { OhmailEngine } from "@ohmail/client-engine";
import { createEngineAdapter } from "../../src/bridge-fetch.js";
import { installOfflineGuard } from "../../src/offline-guard.js";
import { getDocument } from "../../src/window-pdfjs.js";
import { enableDesktopAttachments } from "../../../webapp/app/shell/open-attachment.js";
import { ensurePreview } from "../../../webapp/app/shell/attachments.js";

installOfflineGuard(globalThis as never, "win32");
enableDesktopAttachments();

async function draw(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const task = getDocument({ data: bytes, disableAutoFetch: true, disableStream: true });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d")!;
    await page.render({ canvas: null, canvasContext: ctx, viewport }).promise;
    const px = [...ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
    return { pages: doc.numPages, px };
  } catch (err) {
    return { error: String((err as Error)?.message ?? err) };
  } finally {
    await task.destroy();
  }
}

/** A PDF the page was handed as base64. */
function render(b64: string): Promise<Record<string, unknown>> {
  return draw(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

/** A PDF the engine fetches over the bridge, as the preview asks for it, then drawn from its Blob. */
async function open(id: string): Promise<Record<string, unknown>> {
  const engine = new OhmailEngine({ adapter: createEngineAdapter() });
  await engine.loadAttachments("m1");
  await ensurePreview(engine, "m1", id);
  const blob = engine.attachmentBlobOf("m1", id);
  if (!blob) return { error: "no bytes in hand" };
  return { size: blob.size, type: blob.type, ...(await draw(new Uint8Array(await blob.arrayBuffer()))) };
}

(window as unknown as { rig: unknown }).rig = {
  render,
  open,
  worker: () => typeof (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker,
};
