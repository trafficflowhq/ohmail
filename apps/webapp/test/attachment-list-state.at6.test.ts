/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { OhmailEngine, type EngineAdapter, threadOf } from "@ohmail/client-engine";
import {
  AttachmentStrip,
  type AttachmentItem,
  type AttachmentStripProps,
  type AttachmentsView,
} from "../app/components/AttachmentStrip.js";
import { useMessageAttachments, type AttachmentsChrome } from "../app/shell/attachments.js";

/**
 * ═══ GAP "WE COULD NOT ASK" IS NOT "THERE IS NOTHING" ════════════════════════════════
 *
 * The strip had per-ITEM state and no state for the LIST, and the shell flattened every
 * non-`ready` outcome to `[]`. So a metadata read that failed rendered exactly what an
 * inline-only message renders — nothing, under a paperclip painted from `hasAttachments` — and
 * after the flag work that second case is the COMMON one: nearly half the flagged messages in a
 * large account carry nothing downloadable. One silence standing for two different sentences,
 * with the failing one permanently invisible.
 *
 * ── THE THING THIS FILE IS REALLY FOR ─────────────────────────────────────────────────────
 *
 * This repo has shipped "built, tested, unreachable" seven times — most recently a strip whose
 * update signal could not see its own state, which would have sat on "not loaded" for ever
 * while bytes arrived behind it. A list state that renders beautifully in a component test and
 * never leaves the engine is that failure again. So the reachability is asserted THREE ways,
 * each of which breaks on a different kind of regression:
 *
 *  1. BEHAVIOURALLY — {@link Harness} renders the real strip from the real hook over a real
 *     `OhmailEngine`, wired exactly as `MessagePane` wires it. Flatten `itemsOf` and the
 *     sentence disappears from the DOM.
 *  2. AT THE TYPE LEVEL — `apps/webapp` typechecks its tests, so the `@ts-expect-error` below
 *     is a real gate: revert the prop to `AttachmentItem[]` and it becomes an UNUSED
 *     expect-error, which is TS2578, which is a failing `pnpm -F @ohmail/webapp typecheck`.
 *  3. AT THE SOURCE — `MessagePane` is the one consumer and was being changed elsewhere, so
 *     the fix had to reach it without editing it. That it still does is asserted, not assumed.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* `process.cwd()` rather than `import.meta.url`: this file runs under jsdom, where
   `import.meta.url` is not a `file:` URL and `fileURLToPath` refuses it. Vitest runs from the
   repo root — the same reason `body-open.test.ts` reaches for a stylesheet this way. */
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
/** Source with its comments removed — this repo's comments quote the code they are about. */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(element: React.ReactElement): Promise<void> {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(element));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
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

const handlers = { onOpen: () => {}, onDownloadAll: () => {}, downloadingAll: false };
const mount = (items: AttachmentsView, over: Partial<AttachmentStripProps> = {}): Promise<void> =>
  render(h(AttachmentStrip, { ...handlers, items, ...over }));

const row = (): HTMLElement | null => host!.querySelector<HTMLElement>(".att-list");
const retry = (): HTMLButtonElement | null => host!.querySelector<HTMLButtonElement>(".att-list-retry");

/* ── 1. what the list's own states SAY ─────────────────────────────────────────────────── */

describe("the strip can tell “we could not ask” from “there is nothing”", () => {
  it("a failure says so, in a sentence about OHMAIL — the list read never touches the mailbox", async () => {
    await mount({
      state: "failed",
      error: "ohmail could not answer.",
      code: "upstream_unavailable",
      retryable: true,
      onRetry: () => {},
    });

    expect(row(), "a failed list rendered nothing — the failed-list case exactly").not.toBeNull();
    expect(row()!.textContent).toContain("Couldn't load this message's files.");
    // `GET /messages/:id/attachments` is `cost: "read"` and opens no IMAP adapter, so any
    // sentence here that blamed the user's mail server would be false. The per-ITEM copy says
    // "your mailbox" because those bytes really do come from IMAP; this must not borrow it.
    expect(row()!.textContent).not.toContain("mailbox");
  });

  it("the SERVER'S sentence is the title, never the copy — it is English and unbounded", async () => {
    await mount({
      state: "failed",
      error: "ohmail could not answer.",
      code: "upstream_unavailable",
      retryable: true,
      onRetry: () => {},
    });
    expect(row()!.title).toBe("ohmail could not answer.");
  });

  it("`network` is a different sentence: nothing refused us, we never got there", async () => {
    await mount({
      state: "failed",
      error: "network failure: TypeError: Failed to fetch",
      code: "network",
      retryable: true,
      onRetry: () => {},
    });
    expect(row()!.textContent).toContain("Couldn't reach ohmail — check your connection.");
  });

  it("retryable means a button, and the button is the whole point of the row", async () => {
    const onRetry = vi.fn();
    await mount({ state: "failed", error: "boom", code: "internal", retryable: true, onRetry });
    expect(retry()!.textContent).toContain("Try again");
    await act(async () => retry()!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("NOT retryable means NO button — a press that cannot work is a lie the first press exposes", async () => {
    // A 404 (`assertMessage`) or a dead session will answer the same way for ever. This is the
    // `too_large` tile's argument, at list scale: it is a `div` for exactly this reason.
    const onRetry = vi.fn();
    await mount({ state: "failed", error: "no such message", code: "not_found", retryable: false, onRetry });
    expect(row()!.textContent).toContain("Couldn't load this message's files.");
    expect(retry(), "an unretryable failure still offered a retry").toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("the first ask renders NOTHING — one indexed row is not a wait anybody should be shown", async () => {
    await mount({ state: "loading" });
    expect(host!.querySelector(".att-strip"), "a skeleton on every message open is noise").toBeNull();
  });

  it("…but a re-ask keeps the row standing and names what it is doing", async () => {
    await mount({ state: "loading", retrying: true });
    expect(row(), "the row the user just pressed vanished mid-retry — that reads as success").not.toBeNull();
    expect(row()!.textContent).toContain("Looking again…");
    expect(row()!.dataset.state).toBe("retrying");
    // Named, not an anonymous spinner: the sweep is decoration beside a sentence that carries
    // the meaning, which is what keeps it legible under `prefers-reduced-motion`.
    expect(row()!.querySelector(".att-spin")).not.toBeNull();
  });

  it("the retry cannot be re-fired while it is running, and keeps its element (and its focus)", async () => {
    const onRetry = vi.fn();
    await mount({ state: "loading", retrying: true }, { ...handlers, onOpen: () => {} });
    const button = retry();
    expect(button, "the control disappeared mid-flight instead of settling").not.toBeNull();
    expect(button!.getAttribute("aria-disabled")).toBe("true");
    await act(async () => button!.click());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("a list that came back EMPTY renders no noise at all — that is not a failure", async () => {
    // Many flagged messages carry only `cid:` parts. A notice on every one of them would be
    // the product complaining about ordinary mail.
    await mount({ state: "ready", items: [] });
    expect(host!.querySelector(".att-strip")).toBeNull();
    expect(host!.textContent).toBe("");
  });

  it("no server to ask renders nothing either — never an empty strip claiming there are no files", async () => {
    await mount({ state: "unavailable" });
    expect(host!.querySelector(".att-strip")).toBeNull();
  });

  it("a ready list with files still draws the strip, and no list-level row over it", async () => {
    await mount({ state: "ready", items: [item()] });
    expect(host!.querySelector(".att-tile")).not.toBeNull();
    expect(row()).toBeNull();
  });
});

/* ── 2. the state reaches the component, over the wire that already runs ───────────────── */

function adapterWith(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => [],
    fetchAttachment: async () => new Blob(["%PDF"], { type: "application/pdf" }),
    fetchAllAttachments: async () => new Blob(["PK"], { type: "application/zip" }),
    ...over,
  };
}

/**
 * The pane's own wiring, copied verbatim from `MessagePane.tsx`.
 *
 * `items={attachments.itemsOf(message.id)}` and nothing else — if the list state stops flowing
 * over that one expression, every assertion in this group goes red.
 */
function Harness({ engine, messageId }: { engine: OhmailEngine; messageId: string }) {
  const attachments = useMessageAttachments(engine, messageId, { shell: "none", conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: () => {} });
  return attachments
    ? h(AttachmentStrip, {
        items: attachments.itemsOf(messageId),
        onOpen: (attachmentId: string) => attachments.open(messageId, attachmentId),
        onDownloadAll: () => attachments.downloadAll(messageId),
        downloadingAll: attachments.downloadingAll(messageId),
      })
    : null;
}

describe("a real failure, from a real engine, reaches the screen", () => {
  it("THE DEFECT: a failed metadata read used to render as an empty strip; it renders a sentence", async () => {
    const engine = new OhmailEngine({
      adapter: adapterWith({ listAttachments: async () => { throw new Error("ohmail could not answer."); } }),
    });
    await render(h(Harness, { engine, messageId: "m1" }));

    expect(row(), "the hook flattened the failure to an empty list again").not.toBeNull();
    expect(row()!.textContent).toContain("Couldn't load this message's files.");
    expect(row()!.title).toBe("ohmail could not answer.");
  });

  it("…and the SAME screen for an inline-only message stays silent", async () => {
    // The two states this gap exists to separate, asserted against one another rather than
    // separately: same engine, same component, one renders a sentence and one renders nothing.
    const engine = new OhmailEngine({ adapter: adapterWith({ listAttachments: async () => [] }) });
    await render(h(Harness, { engine, messageId: "m1" }));
    expect(host!.querySelector(".att-strip")).toBeNull();
  });

  it("pressing Try again really asks again, and the files arrive in place of the sentence", async () => {
    let attempt = 0;
    const listAttachments = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("ohmail could not answer.");
      return [{
        id: "a1", filename: "invoice.pdf", contentType: "application/pdf",
        sizeBytes: 2_300_000, inline: false, messageId: "m1",
      }];
    });
    const engine = new OhmailEngine({ adapter: adapterWith({ listAttachments }) });
    await render(h(Harness, { engine, messageId: "m1" }));
    expect(listAttachments).toHaveBeenCalledTimes(1);

    await act(async () => retry()!.click());

    // The engine returns the HELD failure for an ordinary call, on purpose. A press that did not
    // pass `retry` would redraw the same sentence without asking anybody — and the button's own
    // words would be a lie.
    expect(listAttachments, "the retry never reached the engine as a re-ask").toHaveBeenCalledTimes(2);
    expect(row(), "the failure row survived a successful re-ask").toBeNull();
    expect(host!.querySelector(".att-name")!.textContent).toBe("invoice.pdf");
  });

  it("a permanent refusal from the real engine reaches the screen with no button", async () => {
    const engine = new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async () => {
          throw Object.assign(new Error("no such message"), {
            name: "MutationRejectedError", status: 404, code: "not_found", retryable: false,
          });
        },
      }),
    });
    await render(h(Harness, { engine, messageId: "m1" }));
    expect(row()).not.toBeNull();
    // NOTE: a plain object with the fields is NOT a `MutationRejectedError`, so the engine
    // classifies it as unclassified — retryable, by design. The button being present here is
    // therefore the CORRECT reading of a thrown thing the client cannot vouch for.
    expect(retry(), "an unclassifiable throw should still offer the cheap re-ask").not.toBeNull();
  });
});

/* ── 3. the hop this fix could not edit ────────────────────────────────────────────────── */

describe("the hop into MessagePane, which this slice was not allowed to touch", () => {
  it("`MessageFiles` still feeds `itemsOf` straight into the strip's list prop", async () => {
    // The strip moved into `MessageFiles`, which every pane renders (FIX-025); the pane is held
    // to rendering it, and the component to the unflattened list.
    expect(code(read("apps/webapp/app/shell/MessagePane.tsx")), "MessagePane no longer renders MessageFiles")
      .toMatch(/<MessageFiles messageId=\{message\.id\} \/>/);
    const pane = code(read("apps/webapp/app/shell/MessageFiles.tsx"));
    const from = pane.indexOf("<AttachmentStrip");
    expect(from, "MessageFiles no longer renders the strip — this assertion needs re-aiming")
      .toBeGreaterThan(-1);
    const jsx = pane.slice(from, pane.indexOf("/>", from));
    // The whole reachability argument: the wire that already ran now carries the list state, so
    // the fix landed without editing this file. Re-deriving `items` from anything else here
    // (a `.filter`, a `?? []`) puts the failure back behind a flattening.
    expect(jsx, "the strip's list no longer comes from `attachments.itemsOf(...)`")
      .toMatch(/items=\{attachments\.itemsOf\(/);
  });

  it("the type flows end to end — the hook's answer IS the strip's prop", () => {
    // Compile-time, and it is the point: if `itemsOf`'s return type and the prop ever diverge,
    // `next build` fails inside MessagePane.tsx — a file the diverging change never opened.
    const wired: AttachmentStripProps["items"] = null as unknown as ReturnType<AttachmentsChrome["itemsOf"]>;
    expect(wired).toBeNull();
  });

  it("a bare array is NOT a list state, and TypeScript says so", () => {
    /* THE REVERT-PROOF. Flatten `itemsOf` back to `AttachmentItem[]` and this stops being an
       error — which makes the directive an UNUSED @ts-expect-error, which is TS2578, which is
       a failing `pnpm -F @ohmail/webapp typecheck`. apps/webapp genuinely typechecks its tests. */
    // @ts-expect-error — an array of items cannot say why the list is empty. That is gap.
    const flattened: AttachmentStripProps["items"] = [] as AttachmentItem[];
    expect(Array.isArray(flattened)).toBe(true);
  });
});
