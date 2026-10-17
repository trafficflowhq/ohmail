/* The renderer-memory cases' page (`attachment-preview-renderer-memory.test.ts`): the desktop's own
 * bridge adapter, a real engine, the overlay's `ensurePreview` — or, as the control, the engine's
 * byte fetch the desktop preview used before — and one load per class of raw answer. The real
 * guard is installed as the Windows build ships it; the test answers `__TAURI_INTERNALS__` the way
 * Tauri does, over `http://ipc.localhost` while the page's policy admits it, by `eval` after not. */
import { BODIES_IDS_MAX, OhmailEngine } from "@ohmail/client-engine";
import { bridgeTransportReading, createEngineAdapter } from "../../src/bridge-fetch.js";
import { installOfflineGuard } from "../../src/offline-guard.js";
import { enableDesktopAttachments } from "../../../webapp/app/shell/open-attachment.js";
import { ensurePreview } from "../../../webapp/app/shell/attachments.js";

installOfflineGuard(globalThis as never, "win32");
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

/** One class of raw answer, through the code the window runs for it; answers what it holds after. */
async function load(kind: "bodies" | "inline" | "calendar" | "snapshot", messageId = ""): Promise<Record<string, unknown>> {
  const adapter = createEngineAdapter();
  if (kind === "bodies") {
    const rows = await adapter.fetchBodies(Array.from({ length: BODIES_IDS_MAX }, (_, i) => `body-${i}`));
    return { rows: rows.length, chars: rows.reduce((n, r) => n + (r.text?.length ?? 0), 0) };
  }
  if (kind === "snapshot") return { changes: (await adapter.snapshot()).changes.length };
  const engine = new OhmailEngine({ adapter });
  if (kind === "calendar") {
    await engine.loadCalendarTexts(messageId);
    return { texts: engine.calendarTextsOf(messageId).size };
  }
  await engine.loadAttachments(messageId);
  const held = engine.attachmentsOf(messageId, { includeInlineParts: true });
  const cids = held.state === "ready" ? held.items.flatMap((i) => (i.contentId ? [i.contentId] : [])) : [];
  await engine.loadInlineImages(messageId, cids);
  return { minted: engine.inlineImagesOf(messageId).size };
}

(window as unknown as { rig: unknown }).rig = { open, load, transport: bridgeTransportReading };
