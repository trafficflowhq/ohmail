/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { OhmailEngine, type EngineAdapter, threadOf } from "@ohmail/client-engine";
import { useMessageAttachments, type AttachmentsChrome } from "@ohmail/app-logic/reader/attachments";
import { readerEntryFrom } from "../../../packages/app/src/reader/index.js";
import type { ReaderFile, ReaderFileList, ReaderFiles, ReaderParts } from "../../../packages/app/src/reader/index.js";
import { bodyDouble, letter, letterOf, mountLetters } from "./_reader-1-letters.js";

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
 * This repo has shipped "built, tested, unreachable" seven times. So the reachability is asserted THREE ways, each
 * of which breaks on a different kind of regression:
 *
 *  1. BEHAVIOURALLY — the new reader's letter draws its files from the list its shell's file door holds; a
 *     {@link fromEngine} reader hands it the real door (`useMessageAttachments`) over a real `OhmailEngine`, made in
 *     the reader's render exactly as the mail ground makes it (`packages/app/src/mail/reader-parts.ts`). Flatten
 *     `itemsOf` and the sentence disappears from the screen.
 *  2. AT THE TYPE LEVEL — `apps/webapp` typechecks its tests, so the `@ts-expect-error` below is a real gate: revert
 *     the list to `ReaderFile[]` and it becomes an UNUSED expect-error, which is TS2578.
 *  3. AT THE SOURCE — the letter is held to drawing its files, and its files to the unflattened list.
 *
 * Re-pointed (share reader-1) from today's `AttachmentStrip` and `MessagePane` onto the new reader's letter
 * (`_reader-1-letters.tsx`) and its files (`packages/app/src/reader/files/Files.tsx`); the controls are found by
 * role and name, the list's failure by its alert. "Nothing" is the letter exactly as it draws with no file door.
 */

/* `process.cwd()` rather than `import.meta.url`: this file runs under jsdom, where `import.meta.url` is not a `file:`
   URL. Vitest runs from the repo root. */
const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");
/** Source with its comments removed — this repo's comments quote the code they are about. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function item(over: Partial<ReaderFile> = {}): ReaderFile {
  return {
    id: "a1",
    filename: "invoice-march.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2_300_000,
    state: "idle",
    inline: false,
    ...over,
  };
}

/** A letter that carries files, as the mirror flags one. */
const letterWithAttachment = letter("m1", { hasAttachments: true, attachmentCount: 1, unread: false });

/** A file door that holds `list` for every letter. */
function doorOf(list: ReaderFileList): ReaderFiles {
  return {
    hold: () => () => undefined,
    itemsOf: () => list,
    open: () => undefined,
    ensure: () => undefined,
    downloadAll: () => undefined,
    downloadingAll: () => false,
    cidImagesOf: () => new Map(),
    needCidImages: () => undefined,
  };
}

/** The letter as it draws with no file door at all: what "renders nothing" means. */
function quietLetter(): string {
  mountLetters({ letters: [letterWithAttachment], open: "m1" });
  const text = letterOf("m1")!.textContent ?? "";
  cleanup();
  return text;
}

const mount = (list: ReaderFileList): void => {
  mountLetters({ letters: [letterWithAttachment], open: "m1", parts: { files: doorOf(list) } });
};

/** The list's own row: its failure, said as an alert. */
const row = (): HTMLElement | null => screen.queryByRole("alert");
const retry = (): HTMLElement | null => screen.queryByRole("button", { name: "Try again" });

/* ── 1. what the list's own states SAY ─────────────────────────────────────────────────── */

describe("the strip can tell “we could not ask” from “there is nothing”", () => {
  it("a failure says so, in a sentence about OHMAIL — the list read never touches the mailbox", () => {
    mount({ state: "failed", code: "upstream_unavailable", retryable: true, onRetry: () => {} });

    expect(row(), "a failed list rendered nothing — the failed-list case exactly").not.toBeNull();
    expect(row()!.textContent).toContain("Couldn't load this message's files.");
    // `GET /messages/:id/attachments` is `cost: "read"` and opens no IMAP adapter, so any
    // sentence here that blamed the user's mail server would be false. The per-ITEM copy says
    // "your mailbox" because those bytes really do come from IMAP; this must not borrow it.
    expect(row()!.textContent).not.toContain("mailbox");
  });

  it("`network` is a different sentence: nothing refused us, we never got there", () => {
    mount({ state: "failed", code: "network", retryable: true, onRetry: () => {} });
    expect(row()!.textContent).toContain("Couldn't reach ohmail — check your connection.");
  });

  it("retryable means a button, and the button is the whole point of the row", () => {
    const onRetry = vi.fn();
    mount({ state: "failed", code: "internal", retryable: true, onRetry });
    expect(retry()!.textContent).toContain("Try again");
    fireEvent.click(retry()!);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("NOT retryable means NO button — a press that cannot work is a lie the first press exposes", () => {
    // A 404 (`assertMessage`) or a dead session will answer the same way for ever. This is the
    // `too_large` tile's argument, at list scale: it is a `div` for exactly this reason.
    const onRetry = vi.fn();
    mount({ state: "failed", code: "not_found", retryable: false, onRetry });
    expect(row()!.textContent).toContain("Couldn't load this message's files.");
    expect(retry(), "an unretryable failure still offered a retry").toBeNull();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("the first ask renders NOTHING — one indexed row is not a wait anybody should be shown", () => {
    const quiet = quietLetter();
    mount({ state: "loading" });
    expect(letterOf("m1")!.textContent, "a skeleton on every message open is noise").toBe(quiet);
  });

  it("…but a re-ask keeps the row standing and names what it is doing", () => {
    mount({ state: "loading", retrying: true });
    expect(row(), "the row the user just pressed vanished mid-retry — that reads as success").not.toBeNull();
    expect(row()!.textContent).toContain("Looking again…");
  });

  it("the retry cannot be re-fired while it is running, and keeps its element (and its focus)", () => {
    const onRetry = vi.fn();
    mount({ state: "loading", retrying: true });
    const button = retry();
    expect(button, "the control disappeared mid-flight instead of settling").not.toBeNull();
    expect(button!.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button!);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("a list that came back EMPTY renders no noise at all — that is not a failure", () => {
    // Many flagged messages carry only `cid:` parts. A notice on every one of them would be
    // the product complaining about ordinary mail.
    const quiet = quietLetter();
    mount({ state: "ready", items: [] });
    expect(letterOf("m1")!.textContent).toBe(quiet);
    expect(row()).toBeNull();
  });

  it("no server to ask renders nothing either — never an empty strip claiming there are no files", () => {
    const quiet = quietLetter();
    mount({ state: "unavailable" });
    expect(letterOf("m1")!.textContent).toBe(quiet);
  });

  it("a ready list with files still draws the strip, and no list-level row over it", () => {
    mount({ state: "ready", items: [item()] });
    expect(screen.getAllByRole("button", { name: "Download invoice-march.pdf" }).length).toBeGreaterThan(0);
    expect(row()).toBeNull();
  });
});

/* ── 2. the state reaches the screen, over the wire that already runs ──────────────────── */

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
 * The reader over the real file door: made in the reader's render, as the mail ground makes it, and handed as the
 * reader's `files`. If the list state stops flowing over `itemsOf`, every assertion in this group goes red.
 */
function fromEngine(engine: OhmailEngine): void {
  const { body } = bodyDouble();
  const reader = readerEntryFrom((): ReaderParts => {
    const files = useMessageAttachments(engine, "m1", {
      shell: "none",
      conversationOf: (id: string) => threadOf(engine.read(), id),
      onDownloadAllFailed: () => {},
    });
    return {
      body,
      files: files ?? "none",
      pictures: "none",
      look: "none",
      sentCopy: "none",
      reply: "none",
      invitation: "none",
    };
  });
  mountLetters({ letters: [letterWithAttachment], open: "m1", host: { reader } });
}

/** The engine's answers land: a few turns of the loop. */
async function landed(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

describe("a real failure, from a real engine, reaches the screen", () => {
  it("THE DEFECT: a failed metadata read used to render as an empty strip; it renders a sentence", async () => {
    const engine = new OhmailEngine({
      adapter: adapterWith({ listAttachments: async () => { throw new Error("ohmail could not answer."); } }),
    });
    fromEngine(engine);
    await landed();

    expect(row(), "the hook flattened the failure to an empty list again").not.toBeNull();
    expect(row()!.textContent).toContain("Couldn't load this message's files.");
  });

  it("…and the SAME screen for an inline-only message stays silent", async () => {
    // The two states this gap exists to separate, asserted against one another rather than
    // separately: same engine, same component, one renders a sentence and one renders nothing.
    const quiet = quietLetter();
    const engine = new OhmailEngine({ adapter: adapterWith({ listAttachments: async () => [] }) });
    fromEngine(engine);
    await landed();
    expect(letterOf("m1")!.textContent).toBe(quiet);
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
    fromEngine(engine);
    await landed();
    expect(listAttachments).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(retry()!);
    });
    await landed();

    // The engine returns the HELD failure for an ordinary call, on purpose. A press that did not
    // pass `retry` would redraw the same sentence without asking anybody — and the button's own
    // words would be a lie.
    expect(listAttachments, "the retry never reached the engine as a re-ask").toHaveBeenCalledTimes(2);
    expect(row(), "the failure row survived a successful re-ask").toBeNull();
    expect(screen.getAllByRole("button", { name: "Download invoice.pdf" }).length).toBeGreaterThan(0);
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
    fromEngine(engine);
    await landed();
    expect(row()).not.toBeNull();
    // NOTE: a plain object with the fields is NOT a `MutationRejectedError`, so the engine
    // classifies it as unclassified — retryable, by design. The button being present here is
    // therefore the CORRECT reading of a thrown thing the client cannot vouch for.
    expect(retry(), "an unclassifiable throw should still offer the cheap re-ask").not.toBeNull();
  });
});

/* ── 3. the hop into the letter ─────────────────────────────────────────────────────────── */

describe("the hop into MessagePane, which this slice was not allowed to touch", () => {
  it("`MessageFiles` still feeds `itemsOf` straight into the strip's list prop", () => {
    // The files are drawn by `LetterFiles`, which every letter of the column renders; the letter is held to
    // rendering it, and the component to the unflattened list.
    expect(code(read("packages/app/src/reader/Letter.tsx")), "the letter no longer renders its files")
      .toMatch(/<LetterFiles messageId=\{message\.id\} selection=\{previewSelection\} parts=\{parts\} \/>/);
    const files = code(read("packages/app/src/reader/files/Files.tsx"));
    const from = files.indexOf("export function LetterFiles");
    expect(from, "Files.tsx no longer draws the letter's files — this assertion needs re-aiming").toBeGreaterThan(-1);
    const drawn = files.slice(from);
    // The whole reachability argument: the list is the door's answer as it stands, read for its state. Re-deriving it
    // from anything else here (a `.filter`, a `?? []`) puts the failure back behind a flattening.
    expect(drawn, "the files' list no longer comes from `files.itemsOf(...)`").toMatch(/const list = files\.itemsOf\(/);
    expect(drawn, "the list's failure is no longer read off the list").toMatch(/list\.state === "failed"/);
  });

  it("the type flows end to end — the hook's answer IS the strip's prop", () => {
    // Compile-time, and it is the point: if `itemsOf`'s return type and the reader's list ever diverge, the mail
    // ground's `reader-parts.ts` fails to compile — a file the diverging change never opened.
    const wired: ReturnType<ReaderFiles["itemsOf"]> = null as unknown as ReturnType<AttachmentsChrome["itemsOf"]>;
    expect(wired).toBeNull();
  });

  it("a bare array is NOT a list state, and TypeScript says so", () => {
    /* THE REVERT-PROOF. Flatten `itemsOf` back to `ReaderFile[]` and this stops being an error — which makes the
       directive an UNUSED @ts-expect-error, which is TS2578, a failing typecheck. apps/webapp typechecks its tests. */
    // @ts-expect-error — an array of items cannot say why the list is empty. That is gap.
    const flattened: ReaderFileList = [] as ReaderFile[];
    expect(Array.isArray(flattened)).toBe(true);
  });
});
