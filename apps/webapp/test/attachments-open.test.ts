/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { OhmailEngine, type EngineAdapter, threadOf } from "@ohmail/client-engine";
import { useMessageAttachments, saveBlob, saveObjectUrl } from "../app/shell/attachments.js";

/**
 * ═══ GAP A PRESS BECOMES A FILE, AND THE BYTES ARE LET GO ═══════════════════════════
 *
 * `attachments-wired.test.ts` proves the LIVE engine can fetch. This proves the last ten
 * centimetres, in a real DOM, because every one of them is invisible to a test that drives
 * the engine directly:
 *
 *  · **The re-render.** Attachment state is in-memory only — nothing is written to the
 *    mirror — so `engine.read().version()` does not move when a fetch completes. A surface
 *    subscribed through `useEngineVersion` would sit on `idle` for ever while the bytes
 *    arrived behind it, and the engine's own suite would be perfectly green. That is this
 *    slice's failure mode one layer up, and it is what the first group here bites on.
 *  · **The release.** A `blob:` URL pins its bytes until it is revoked. Selecting away
 *    without revoking reintroduces, inside the browser, exactly the cost that "ohmail stores
 *    no attachment bytes" exists to avoid.
 *  · **The save.** The engine mints a URL; nothing in it puts a file on a disk.
 *
 * `document.createElement` is not stubbed. The anchor is built, clicked and removed for real,
 * and the assertions read the element the browser was actually handed — a mock of
 * `createElement` would let a wrong `download` attribute pass.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every `<a download>` the code under test clicked: `[href, download]`. */
let clicked: [string, string][];
const realClick = HTMLAnchorElement.prototype.click;
let minted = 0;
let revoked: string[];

function wire(id: string, over: Partial<{ filename: string; contentType: string; sizeBytes: number; inline: boolean }> = {}) {
  return {
    id,
    filename: over.filename ?? `${id}.pdf`,
    contentType: over.contentType ?? "application/pdf",
    sizeBytes: over.sizeBytes ?? 1_000,
    inline: over.inline ?? false,
    messageId: "m1",
  };
}

/** The three optional capabilities, defaulted to a working server. */
function adapterWith(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => [wire("a1")],
    fetchAttachment: async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }),
    fetchAllAttachments: async () => new Blob(["PK\x03\x04"], { type: "application/zip" }),
    ...over,
  };
}

interface Seen {
  items: { id: string; filename: string; state: string }[];
  available: boolean;
  open: (attachmentId: string) => void;
  downloadAll: () => void;
  downloadingAll: boolean;
}

/** The last render's view of the hook — what `MessagePane` would have been handed. */
let seen: Seen;

function Harness({ engine, messageId, onFailed }: {
  engine: OhmailEngine;
  messageId: string | null;
  onFailed: () => void;
}) {
  const att = useMessageAttachments(engine, messageId, { shell: "none", conversationOf: (id: string) => threadOf(engine.read(), id), onDownloadAllFailed: onFailed });
  const id = messageId ?? "m1";
  // `itemsOf` answers with the LIST STATE since gap so "the items" is a question only a
  // `ready` list can answer. Everything else is zero items HERE and a rendered sentence in the
  // strip — which is the whole of that change and is asserted in `attachment-list-state.at6.test.ts`.
  const list = att?.itemsOf(id);
  seen = {
    available: att !== undefined,
    items: (list?.state === "ready" ? list.items : []).map((i) => ({ id: i.id, filename: i.filename, state: i.state })),
    open: (attachmentId: string) => att?.open(id, attachmentId),
    downloadAll: () => att?.downloadAll(id),
    downloadingAll: att?.downloadingAll(id) ?? false,
  };
  return null;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(engine: OhmailEngine, messageId: string | null, onFailed = (): void => {}): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(h(Harness, { engine, messageId, onFailed })));
}

async function rerender(engine: OhmailEngine, messageId: string | null, onFailed = (): void => {}): Promise<void> {
  await act(async () => root!.render(h(Harness, { engine, messageId, onFailed })));
}

beforeEach(() => {
  clicked = [];
  revoked = [];
  minted = 0;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
    clicked.push([this.href, this.getAttribute("download") ?? ""]);
  };
  // jsdom ships no object-URL implementation at all, so this is the only way the code under
  // test can reach `ready` here — and counting the mints is how the release is measured.
  (globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () =>
    `blob:http://localhost/obj-${++minted}`;
  (globalThis.URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u: string) => {
    revoked.push(u);
  };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  HTMLAnchorElement.prototype.click = realClick;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("the strip updates as the bytes arrive — the re-render `useEngineVersion` cannot see", () => {
  it("selection loads the metadata and the surface SEES the list", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, "m1");

    // The whole point: `loadAttachments` resolved, the engine notified, and the component
    // re-rendered with the result. Subscribing through `engine.read().version()` instead
    // leaves this at `[]` for ever, because attachment state never touches the mirror.
    expect(seen.items).toEqual([{ id: "a1", filename: "a1.pdf", state: "idle" }]);
  });

  it("…and again when a press moves ONE item from idle to ready", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, "m1");
    await act(async () => seen.open("a1"));
    expect(seen.items[0]?.state).toBe("ready");
  });

  it("a message with only inline parts renders an EMPTY strip, not a stale one", async () => {
    // Many flagged messages carry `cid:` parts only. Selecting one after a
    // message that had real files must not leave the previous message's list on screen.
    const engine = new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async (messageId: string) =>
          messageId === "m1" ? [wire("a1")] : [wire("logo", { inline: true })],
      }),
    });
    await mount(engine, "m1");
    expect(seen.items).toHaveLength(1);
    await rerender(engine, "m2");
    expect(seen.items).toEqual([]);
  });
});

describe("the press produces a FILE", () => {
  it("fetches the bytes and hands them to the browser as a download under the real filename", async () => {
    const engine = new OhmailEngine({
      adapter: adapterWith({ listAttachments: async () => [wire("a1", { filename: "invoice-march.pdf" })] }),
    });
    await mount(engine, "m1");
    await act(async () => seen.open("a1"));

    expect(clicked).toHaveLength(1);
    const [href, download] = clicked[0]!;
    // The name is the one the strip shows AND the one a download-all zip entry carries —
    // `toAttachmentItem` matches the server's own `uniqueName` stem so a user reading both
    // sees one file, not two.
    expect(download).toBe("invoice-march.pdf");
    // NEVER a top-level navigation: a `blob:` URL inherits this origin, so opening an
    // `image/svg+xml` attachment in a tab would run sender script as ohmail with the
    // host-only session cookie in scope. `download` makes the browser save, not render.
    expect(href.startsWith("blob:")).toBe(true);
    // And the anchor did not stay in the document.
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });

  it("a SECOND press on a ready tile saves again without a second IMAP connection", async () => {
    const fetchAttachment = vi.fn(async () => new Blob(["%PDF"], { type: "application/pdf" }));
    const engine = new OhmailEngine({ adapter: adapterWith({ fetchAttachment }) });
    await mount(engine, "m1");
    await act(async () => seen.open("a1"));
    await act(async () => seen.open("a1"));

    expect(clicked).toHaveLength(2);
    expect(fetchAttachment, "the ready tile re-fetched — one press, one connection").toHaveBeenCalledTimes(1);
  });

  it("a press on a FAILED tile really does ask again — its own words are “try again”", async () => {
    // The engine refuses an automatic re-ask on purpose (a React effect would loop against a
    // server that already refused, at `cost: "connection"` each time). So the RETRY FLAG has
    // to come from the press, or the tile's copy is a lie the first click exposes.
    let attempt = 0;
    const fetchAttachment = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("your mail server did not answer");
      return new Blob(["%PDF"], { type: "application/pdf" });
    });
    const engine = new OhmailEngine({ adapter: adapterWith({ fetchAttachment }) });
    await mount(engine, "m1");

    await act(async () => seen.open("a1"));
    expect(seen.items[0]?.state).toBe("failed");
    expect(clicked, "a failed fetch still handed the user a file").toHaveLength(0);

    await act(async () => seen.open("a1"));
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    expect(seen.items[0]?.state).toBe("ready");
    expect(clicked).toHaveLength(1);
  });

  it("a `too_large` tile opens nothing and asks for nothing", async () => {
    const fetchAttachment = vi.fn(async () => {
      throw Object.assign(new Error("larger than 32 MB"), { code: "payload_too_large" });
    });
    const engine = new OhmailEngine({ adapter: adapterWith({ fetchAttachment }) });
    await mount(engine, "m1");
    await act(async () => seen.open("a1"));
    expect(seen.items[0]?.state).toBe("too_large");

    await act(async () => seen.open("a1"));
    expect(fetchAttachment, "a permanent refusal was re-asked").toHaveBeenCalledTimes(1);
    expect(clicked).toHaveLength(0);
  });
});

/**
 * ═══ DOWNLOAD ALL IS N FILES, NOT ONE ARCHIVE ════════════════════════════════════════════
 *
 * The press used to fetch the server-assembled zip and save `attachments-<messageId>.zip`. The
 * route is still mounted and `engine.downloadAllAttachments` still calls it; the webapp does not,
 * because a zip is a container the reader now has to deal with — find it, expand it, and then
 * deal with the three PDFs they asked for anyway, inside a folder named after a message id that
 * means nothing to anybody.
 *
 * The archive also hid its own failures: the server skips a part it cannot fetch and names it in
 * an `_errors.txt` INSIDE the zip, so the saved file looked complete. Per file, a part that
 * could not be fetched is a `failed` tile in the strip with the server's own sentence on it.
 */
describe("download-all", () => {
  /**
   * THE SHAPE OF THE ANSWER: one saved file per attachment, under its OWN name.
   *
   * Mutation: restore the zip path (`saveBlob(await engine.downloadAllAttachments(id), …)`).
   * Real failure text:
   *   AssertionError: expected [ 'attachments-m1.zip' ] to deeply equal [ 'one.pdf', 'two.pdf' ]
   */
  it("saves every attachment as its own file, under its own name", async () => {
    const engine = new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async () => [
          wire("a1", { filename: "one.pdf" }),
          wire("a2", { filename: "two.pdf" }),
        ],
      }),
    });
    await mount(engine, "m1");
    await act(async () => seen.downloadAll());
    expect(clicked.map(([, d]) => d)).toEqual(["one.pdf", "two.pdf"]);
  });

  /**
   * THE SAVES ARE ONE SYNCHRONOUS RUN. Browsers treat a burst of programmatic downloads as one
   * act and ask about it once; spacing them across tasks turns one prompt into several, or gets
   * the later ones dropped silently. So every fetch finishes first and then nothing waits.
   *
   * Asserted as "the clicks all landed in the same microtask turn", which is what the property
   * actually is: the counter is read after the first click's turn and must already be complete.
   *
   * Mutation: `await` inside the saving loop (e.g. `for (…) { await Promise.resolve();
   * saveObjectUrl(…) }`). Real failure text:
   *   AssertionError: the downloads were spread across tasks: expected 1 to be 3
   */
  it("clicks every anchor in ONE task, with nothing awaited between them", async () => {
    const engine = new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async () => [wire("a1"), wire("a2"), wire("a3")],
      }),
    });
    await mount(engine, "m1");

    /* THE PROBE, and it is the only thing that can actually see this property. On the FIRST
       click, queue a microtask; whatever the click count is when that microtask runs is the
       number of anchors that were clicked without yielding. A synchronous loop reaches all
       three before any microtask can run; a single `await` between them yields, the microtask
       runs after the first click, and this reads 1. */
    let clickedWithoutYielding = -1;
    let armed = false;
    const spy = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement): void {
      spy.call(this);
      if (armed) return;
      armed = true;
      queueMicrotask(() => { clickedWithoutYielding = clicked.length; });
    };
    try {
      await act(async () => seen.downloadAll());
    } finally {
      HTMLAnchorElement.prototype.click = spy;
    }

    expect(clicked, "not every file was saved").toHaveLength(3);
    expect(clickedWithoutYielding, "the downloads were spread across tasks").toBe(3);
  });

  /**
   * A FILE THE SERVER PERMANENTLY REFUSED IS NOT ASKED FOR, and does not stop the others. The
   * `too_large` state is the ceiling, not a failure, and re-asking it would spend a
   * `cost:"connection"` fetch on an answer that cannot change.
   */
  it("skips a permanently refused file and still saves the rest", async () => {
    const fetched: string[] = [];
    const engine = new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async () => [wire("a1", { filename: "big.pdf" }), wire("a2", { filename: "ok.pdf" })],
        fetchAttachment: async (attachmentId: string) => {
          fetched.push(attachmentId);
          if (attachmentId === "a1") throw Object.assign(new Error("too big"), { code: "payload_too_large" });
          return new Blob(["%PDF-1.7"], { type: "application/pdf" });
        },
      }),
    });
    await mount(engine, "m1");
    // Bring a1 to `too_large` first, the way a reader's own press would.
    await act(async () => seen.open("a1"));
    fetched.length = 0;
    await act(async () => seen.downloadAll());

    expect(clicked.map(([, d]) => d)).toEqual(["ok.pdf"]);
    expect(seen.items.find((i) => i.id === "a1")?.state).toBe("too_large");
    expect(fetched, "a permanent refusal was asked for again").toEqual(["a2"]);
  });

  /**
   * NOTHING SAVED IS REPORTED; A PARTIAL RESULT IS NOT. Every file that could not be fetched is
   * a `failed` tile carrying the server's own sentence — more than a toast could say, and
   * attached to the file it is about. A toast on top of that would be a second, vaguer copy.
   *
   * Mutation: `if (saved.length < wanted.length) onFailed.current();`. Real failure text:
   *   AssertionError: a partial download was reported as a failure as well: expected "spy" to
   *   be called 0 times, but got 1 times
   */
  it("reports only when NOTHING could be saved, and leaves the strip standing", async () => {
    const failed = vi.fn();
    const engine = new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async () => [wire("a1"), wire("a2")],
        fetchAttachment: async () => { throw new Error("upstream"); },
      }),
    });
    await mount(engine, "m1", failed);
    await act(async () => seen.downloadAll());

    expect(clicked, "a file that never arrived was still handed to the user").toHaveLength(0);
    expect(failed, "every file failed and nothing said so").toHaveBeenCalledTimes(1);
    // The list survived: the metadata is still perfectly good, and blanking the strip would drop
    // every object URL in it.
    expect(seen.items.map((i) => i.state)).toEqual(["failed", "failed"]);
  });

  it("a partial result is NOT reported — the failed tile is the report", async () => {
    const failed = vi.fn();
    const engine = new OhmailEngine({
      adapter: adapterWith({
        listAttachments: async () => [wire("a1", { filename: "bad.pdf" }), wire("a2", { filename: "ok.pdf" })],
        fetchAttachment: async (attachmentId: string) => {
          if (attachmentId === "a1") throw new Error("upstream");
          return new Blob(["%PDF-1.7"], { type: "application/pdf" });
        },
      }),
    });
    await mount(engine, "m1", failed);
    await act(async () => seen.downloadAll());

    expect(clicked.map(([, d]) => d)).toEqual(["ok.pdf"]);
    expect(failed, "a partial download was reported as a failure as well").toHaveBeenCalledTimes(0);
    expect(seen.items.find((i) => i.filename === "bad.pdf")?.state).toBe("failed");
  });

  it("the button reports its own work: `downloadingAll` is true while the files are in flight", async () => {
    let release: ((b: Blob) => void) | null = null;
    const engine = new OhmailEngine({
      adapter: adapterWith({
        fetchAttachment: () => new Promise<Blob>((resolve) => { release = resolve; }),
      }),
    });
    await mount(engine, "m1");
    await act(async () => { seen.downloadAll(); });
    expect(seen.downloadingAll, "the group verb never showed it was working").toBe(true);
    await act(async () => { release!(new Blob(["%PDF"], { type: "application/pdf" })); });
    expect(seen.downloadingAll).toBe(false);
  });
});

describe("the object URLs are let go", () => {
  it("THE LEAK: selecting a different message revokes the bytes the last one held", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, "m1");
    await act(async () => seen.open("a1"));
    expect(minted).toBe(1);
    expect(revoked).toEqual([]);

    await rerender(engine, "m2");
    expect(revoked, "the previous message's blob: URL was never revoked").toHaveLength(1);
  });

  it("…and so does closing the shell", async () => {
    const engine = new OhmailEngine({ adapter: adapterWith() });
    await mount(engine, "m1");
    await act(async () => seen.open("a1"));
    await act(async () => root!.unmount());
    root = null;
    expect(revoked).toHaveLength(1);
  });

  it("`saveBlob` releases the URL it minted, but not before the download can start", async () => {
    vi.useFakeTimers();
    saveBlob(new Blob(["x"]), "file.zip", document);
    expect(clicked).toHaveLength(1);
    // Revoking in the same task cancels a large download in Chrome — silently, and only for
    // the big files this is most used for.
    expect(revoked, "the URL was revoked before the browser could read it").toEqual([]);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(revoked).toHaveLength(1);
  });
});

describe("a client with no attachment service", () => {
  it("gets `undefined`, so no strip is rendered — never an empty one", async () => {
    // An empty strip is a DIFFERENT claim: it says this message has no files. `?demo=1` is
    // fixtures and zero network, and it has no server to ask.
    const bare = adapterWith();
    delete (bare as Partial<EngineAdapter>).listAttachments;
    delete (bare as Partial<EngineAdapter>).fetchAttachment;
    delete (bare as Partial<EngineAdapter>).fetchAllAttachments;

    const engine = new OhmailEngine({ adapter: bare });
    const list = vi.spyOn(engine, "loadAttachments");
    await mount(engine, "m1");

    expect(seen.available).toBe(false);
    expect(list, "a client with no attachment service still issued the metadata read").not.toHaveBeenCalled();
  });
});

describe("saveObjectUrl", () => {
  it("never leaves the anchor in the document, even for a name with quotes in it", () => {
    saveObjectUrl("blob:http://localhost/x", 'we"ird name.pdf', document);
    expect(clicked).toEqual([["blob:http://localhost/x", 'we"ird name.pdf']]);
    expect(document.body.querySelector("a")).toBeNull();
  });
});
