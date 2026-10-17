import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE DESKTOP PREVIEW NAMES THE PART AND NEVER FETCHES ITS BYTES INTO THE WINDOW.
 *
 * `ensurePreview` (`webapp/app/shell/attachments.ts`) is what the overlay calls. Armed, it asks the
 * shell to stage the part by id and type, and the engine holds the shell's URL (an image), the
 * capped text, or "too large" — the adapter's byte fetch, which returns through the command channel
 * as a JSON array, is never called. A PDF, which the desktop hands to the system viewer, is not
 * asked for at all. Disarmed (the browser), the overlay fetches as it always did.
 *
 * Mutations watched: `ensurePreview` falling back to `openAttachment` when armed → the first case
 * is red (a byte fetch, no stage); the PDF guard removed → the PDF case is red.
 */

type Invoked = { command: string; payload?: Record<string, unknown> };
let invoked: Invoked[] = [];
let answer: (command: string, payload?: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve(null);

interface Host {
  __TAURI_INTERNALS__?: { invoke: (c: string, p?: Record<string, unknown>) => Promise<unknown> };
}
const host = globalThis as unknown as Host;

beforeEach(() => {
  invoked = [];
  answer = () => Promise.resolve(null);
  host.__TAURI_INTERNALS__ = {
    invoke: (command, payload) => {
      invoked.push({ command, payload });
      return answer(command, payload);
    },
  };
  vi.resetModules();
});

afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

const IMG = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d21";
const TXT = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d22";
const PDF = "0b5e8d3c-1f2a-4c3b-9d8e-7f6a5b4c3d23";
/** The shell's handle for one staged file: 32 hex characters, nothing secret. */
const STAGED = "0123456789abcdef".repeat(2);

async function world(armed: boolean) {
  const mod = await import("../../webapp/app/shell/open-attachment.js");
  if (armed) mod.enableDesktopAttachments();
  const seam = await import("../../webapp/app/shell/attachments.js");
  const { OhmailEngine } = await import("@ohmail/client-engine");
  const fetched: string[] = [];
  const wire = (id: string, contentType: string) => ({ id, filename: `${id}.x`, contentType, sizeBytes: 40 << 20, inline: false, messageId: "m1" });
  const engine = new OhmailEngine({
    adapter: {
      sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
      listAttachments: async () => [wire(IMG, "image/jpeg"), wire(TXT, "text/plain; charset=utf-8"), wire(PDF, "application/pdf")],
      fetchAttachment: async (id: string) => { fetched.push(id); return new Blob(["bytes"]); },
    } as never,
  });
  await engine.loadAttachments("m1");
  const item = (id: string) => {
    const held = engine.attachmentsOf("m1", { includeInlineParts: true });
    return held.state === "ready" ? held.items.find((i) => i.id === id) : undefined;
  };
  return { mod, seam, engine, fetched, item };
}

describe("the desktop preview stages the part by id", () => {
  it("an image is the shell's URL; no byte is fetched into the window; closing releases its token", async () => {
    const { mod, seam, engine, fetched, item } = await world(true);
    answer = async (command) => (command === mod.STAGE_PREVIEW_COMMAND
      ? { url: `attachment-preview://localhost/${STAGED}`, token: STAGED, size: 40 << 20 } : null);
    await seam.ensurePreview(engine, "m1", IMG);
    expect(fetched, "the preview fetched the bytes through the command channel").toEqual([]);
    expect(invoked).toEqual([{ command: "stage_attachment_preview", payload: { attachmentId: IMG, mimeType: "image/jpeg" } }]);
    expect(item(IMG)).toMatchObject({ state: "ready", objectUrl: `attachment-preview://localhost/${STAGED}` });
    expect(engine.attachmentBlobOf("m1", IMG)).toBeUndefined();
    engine.releasePreviews("m1");
    expect(invoked[1]).toEqual({ command: "release_attachment_preview", payload: { token: STAGED } });
    expect(item(IMG)?.state).toBe("idle");
  });

  it("text comes back under the cap as its bytes, and over it as too large", async () => {
    const { seam, engine, fetched, item } = await world(true);
    answer = async () => ({ size: 5, text64: btoa("hello") });
    await seam.ensurePreview(engine, "m1", TXT);
    expect(await engine.attachmentBlobOf("m1", TXT)?.text()).toBe("hello");
    const other = await world(true);
    answer = async () => ({ size: 50 << 20, tooLarge: true });
    await other.seam.ensurePreview(other.engine, "m1", TXT);
    expect(other.item(TXT)).toMatchObject({ state: "ready", previewTooLarge: true });
    expect([...fetched, ...other.fetched]).toEqual([]);
    expect(item(TXT)?.previewTooLarge).toBeUndefined();
  });

  it("a PDF, which this window hands to the system viewer, is not fetched for a preview at all", async () => {
    const { seam, engine, fetched, item } = await world(true);
    await seam.ensurePreview(engine, "m1", PDF);
    expect(invoked).toEqual([]);
    expect(fetched).toEqual([]);
    expect(item(PDF)?.state).toBe("idle");
  });

  it("the shell's refusal of the part lands on the item as the engine's facts", async () => {
    const { seam, engine, item } = await world(true);
    answer = async () => { throw { status: 413, code: "payload_too_large", message: "over 40 MiB", retryable: false }; };
    await seam.ensurePreview(engine, "m1", IMG);
    expect(item(IMG)?.state).toBe("too_large");
  });

  it("a browser tab fetches as it always did, and asks no shell", async () => {
    const { seam, engine, fetched, item } = await world(false);
    await seam.ensurePreview(engine, "m1", IMG);
    expect(invoked).toEqual([]);
    expect(fetched).toEqual([IMG]);
    expect(item(IMG)?.state).toBe("ready");
  });
});
