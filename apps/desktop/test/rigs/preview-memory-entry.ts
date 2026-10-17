/* The renderer-memory case's page (`attachment-preview-renderer-memory.test.ts`): the desktop's own
 * bridge adapter, a real engine, and the overlay's `ensurePreview` — or, as the control, the
 * engine's byte fetch the desktop preview used before. The test answers `__TAURI_INTERNALS__` the
 * way Tauri does under this window's CSP (every answer through `eval`, raw bytes as a JSON array). */
import { OhmailEngine } from "@ohmail/client-engine";
import { createEngineAdapter } from "../../src/bridge-fetch.js";
import { enableDesktopAttachments } from "../../../webapp/app/shell/open-attachment.js";
import { ensurePreview } from "../../../webapp/app/shell/attachments.js";

enableDesktopAttachments();

async function open(id: string, how: "preview" | "bytes"): Promise<Record<string, unknown>> {
  const engine = new OhmailEngine({ adapter: createEngineAdapter() });
  await engine.loadAttachments("m1");
  if (how === "preview") await ensurePreview(engine, "m1", id);
  else await engine.openAttachment("m1", id);
  const held = engine.attachmentsOf("m1", { includeInlineParts: true });
  const item = held.state === "ready" ? held.items.find((i) => i.id === id) : undefined;
  if (!item || item.state !== "ready") return { state: item?.state ?? "missing", error: item?.error ?? null };
  if (item.mimeType.startsWith("image/")) {
    const img = document.createElement("img");
    document.body.appendChild(img);
    const loaded = await new Promise<boolean>((resolve) => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = item.objectUrl ?? "";
    });
    return { state: item.state, loaded, width: img.naturalWidth, url: (item.objectUrl ?? "").slice(0, 40) };
  }
  if (item.previewTooLarge) return { state: item.state, tooLarge: true };
  const text = (await engine.attachmentBlobOf("m1", id)?.text()) ?? "";
  const pre = document.createElement("pre");
  pre.textContent = text.slice(0, 512 * 1024);
  document.body.appendChild(pre);
  return { state: item.state, textLength: text.length };
}

(window as unknown as { rig: unknown }).rig = { open };
