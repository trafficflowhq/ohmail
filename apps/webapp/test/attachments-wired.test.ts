import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HttpAdapter, MutationRejectedError, OhmailEngine } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { createEngine } from "../app/shell/engine-config.js";
import { createSyncGate, transportOf } from "@ohmail/app-logic/session/sync-scheduler";
/* The `chrome` memo below is located by its DECLARED NAME, never by the hook it is declared
   with — the rule, and the three ways a hook spelling fails, are in the helper. */
import { sliceOfDeclaration } from "./source-anchor.js";

/**
 * ═══ GAP THE PAPERCLIP IS REACHABLE FROM A REAL ACCOUNT ══════════════════════════
 *
 * Two halves of attachments shipped on 2026-08-04 and the wire between them did not: the
 * data path (`AttachmentsService`, the six routes, the engine state machine) and the surface
 * (`AttachmentStrip`). Nothing a person clicked reached a byte, and every suite in the repo
 * was green — because every one of them builds an engine from a BARE adapter.
 *
 * That is the whole subject of this file. The shipped path is not a bare adapter: the live
 * engine's transport is wrapped by `createSyncGate(null).guard(...)` in `engine-config.ts`, and
 * that wrapper is an EXPLICIT OBJECT LITERAL, not a Proxy. A capability the literal does not
 * name does not exist on the engine's adapter — and only on the live path, because the demo
 * engine returns before `guard` is ever called. So:
 *
 *   · a bare `new OhmailEngine({adapter: new HttpAdapter(...)})` can open attachments;
 *   · the engine the product actually builds could not;
 *   · nothing in thousands of tests could tell the difference.
 *
 * `fetchBody` and `searchServer` each survived exactly this, and each of their comments in
 * `sync-scheduler.ts` says so. This is the third. Every assertion below therefore goes
 * through {@link createEngine} — the real construction the shell performs — rather than
 * through an adapter a test made up.
 *
 * ── WHAT EACH GROUP BITES ON ────────────────────────────────────────────────────────────
 *
 *  1. the three forwards exist at all (delete one → red);
 *  2. they are BOUND (`.bind(adapter)` — an unbound forward puts the wrapper object in
 *     `this`, `this.request` is undefined, and every fetch dies inside the engine's catch as
 *     a `failed` item the user reads as a broken mailbox);
 *  3. they are SPREAD, not always-defined (an adapter without the capability must keep not
 *     having it, or the demo claims an archive it has no server for);
 *  4. `res.ok` is branched on BEFORE `.blob()`, so a 413's explanatory JSON is never handed
 *     to somebody as a download named after their PDF;
 *  5. the surface consumes it — the shared Reader renders the strip and no longer toasts (since the switch to the
 *     new shell: the new reader's `Letter.tsx` and `LetterFiles`, the ground's one file door; share reader-1).
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(`${HERE}${p}`, "utf8");

/**
 * Source with its comments removed.
 *
 * Every claim below is about what a file DOES, and this repo's comments quote the code they
 * are about — the note explaining that `message.attachment` was the fixtures-only field
 * contains the string `message.attachment`. Matching raw source would make those assertions
 * fire on prose, and an assertion that fires on the wrong thing is one somebody loosens.
 */
const code = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;

/** Every request the stubbed fetch saw, in order: `"GET /api/messages/m1/attachments"`. */
let calls: string[];
let answer: (url: string, init?: RequestInit) => Response;
const originalFetch = globalThis.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The error envelope every route answers on failure — including the two RAW byte routes. */
function envelope(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message, retryable: false } });
}

function bytes(body: string, type = "application/octet-stream"): Response {
  return new Response(body, { status: 200, headers: { "content-type": type } });
}

beforeEach(() => {
  calls = [];
  answer = () => json(404, { error: { code: "not_found", message: "no stub for this route" } });
  // Stubbed BEFORE `createEngine`: `HttpAdapter` binds the global at construction time
  // (the "Illegal invocation" note in its constructor), so a later stub would be ignored.
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return Promise.resolve(answer(url, init));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("the live engine can open attachments — the gate forwards all three capabilities", () => {
  it("THE REGRESSION: `createEngine(false, …)` answers `attachmentsAvailable() === true`", () => {
    // The one-line statement of the bug. `attachmentsAvailable()` is
    // `typeof adapter.listAttachments === "function" && typeof adapter.fetchAttachment === "function"`,
    // and the strip renders NOTHING when it is false — so with either forward missing, a paying
    // account opens a message with a paperclip on it and sees no strip at all, silently.
    const engine = createEngine(false, ARMED);
    expect(engine.attachmentsAvailable()).toBe(true);
  });

  it("the transport behind the gate really is the HTTP adapter, so the line above is not about a stub", () => {
    const engine = createEngine(false, ARMED);
    expect(transportOf((engine as unknown as { adapter: unknown }).adapter)).toBeInstanceOf(HttpAdapter);
  });

  it("`listAttachments` reaches `GET /api/messages/:id/attachments` and lands as a READY strip", async () => {
    answer = (url) =>
      url.endsWith("/api/messages/m1/attachments")
        ? json(200, {
            items: [
              { id: "att-1", filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 24_000, inline: false, messageId: "m1" },
              // Withheld by the engine from a caller that asked for FILES: a `cid:` part the HTML
              // body references is a picture, and `loadAttachments` answers the files view. The
              // record keeps it — a surface drawing the frameless rendering asks for it by name.
              { id: "att-2", filename: "logo.png", contentType: "image/png", sizeBytes: 900, inline: true, messageId: "m1" },
            ],
          })
        : json(500, {});

    const engine = createEngine(false, ARMED);
    const outcome = await engine.loadAttachments("m1");

    // NOT `state !== "unavailable"`: `ready` is the assertion. An UNBOUND forward would put the
    // gate wrapper in `this`, `this.request` would be undefined, and the engine's catch would
    // turn the TypeError into `failed` — which a weaker assertion would sail straight past.
    expect(outcome).toEqual({
      state: "ready",
      items: [
        { id: "att-1", filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 24_000, state: "idle", inline: false, contentId: null },
      ],
    });
    expect(calls).toContain("GET /api/messages/m1/attachments");
  });

  it("`fetchAttachment` reaches `GET /api/attachments/:id` and the item becomes READY", async () => {
    answer = (url) => {
      if (url.endsWith("/api/messages/m1/attachments")) {
        return json(200, {
          items: [{ id: "att-1", filename: "photo.png", contentType: "image/png", sizeBytes: 4, inline: false, messageId: "m1" }],
        });
      }
      if (url.endsWith("/api/attachments/att-1")) return bytes("\x89PNG", "image/png");
      return json(500, {});
    };

    const engine = createEngine(false, ARMED);
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "att-1");

    const held = engine.attachmentsOf("m1") as { state: string; items: { state: string; error?: string }[] };
    expect(held.state).toBe("ready");
    // `error` is asserted absent rather than only checking the state, so a failure that
    // happened to leave the item in some other shape reports its own sentence here.
    expect(held.items[0]?.error).toBeUndefined();
    expect(held.items[0]?.state).toBe("ready");
    expect(calls).toContain("GET /api/attachments/att-1");
  });

  it("`fetchAllAttachments` reaches `POST /api/messages/:id/attachments/download-all` and returns a zip", async () => {
    // NOT covered by `attachmentsAvailable()`, which only consults the other two — so this is
    // the forward a mutation could delete with every other test in this file still green.
    answer = (url, init) =>
      url.endsWith("/api/messages/m1/attachments/download-all") && init?.method === "POST"
        ? bytes("PK\x03\x04", "application/zip")
        : json(500, {});

    const engine = createEngine(false, ARMED);
    const zip = await engine.downloadAllAttachments("m1");

    expect(zip, "downloadAllAttachments returned null — the gate dropped fetchAllAttachments").not.toBeNull();
    expect(zip!.size).toBeGreaterThan(0);
    expect(calls).toContain("POST /api/messages/m1/attachments/download-all");
  });

  it("the gate forwards `forwardPartsAnnounced`: the live engine asks GET /api/hello and reads its answer", async () => {
    // Without the pass-through the web never offers a forward's Remove: the bare adapter has it, the gated one not.
    answer = (url) =>
      url.endsWith("/api/hello") ? json(200, { product: "ohmail", features: { forwardParts: true } }) : json(500, {});
    const engine = createEngine(false, ARMED);
    expect(await engine.forwardPartsAnnounced()).toBe(true);
    expect(calls).toContain("GET /api/hello");
    answer = () => json(200, { product: "ohmail", features: {} });
    expect(await createEngine(false, ARMED).forwardPartsAnnounced(), "an older server's /hello read as yes").toBe(false);
  });

  it("the CSRF token rides on the download-all POST, because it is an unsafe method", async () => {
    // The one attachment call that is not a GET. Without `X-CSRF-Token` the API refuses it
    // (§1.3) and "Download all" would fail on every real session while every stub passed.
    let seen: Record<string, string> | null = null;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      seen = init?.headers as Record<string, string>;
      return Promise.resolve(bytes("PK\x03\x04", "application/zip"));
    }) as unknown as typeof fetch;

    const adapter = new HttpAdapter({ baseUrl: "/api", getCookie: (n) => (n === "tf_csrf" ? "token-abc" : null) });
    const engine = new OhmailEngine({ adapter: createSyncGate(null).guard(adapter) });
    await engine.downloadAllAttachments("m1");

    expect(seen).not.toBeNull();
    expect((seen as unknown as Record<string, string>)["x-csrf-token"]).toBe("token-abc");
  });
});

describe("SPREAD, not always-defined — an adapter without the capability keeps not having it", () => {
  it("the demo engine CAN open attachments now — fixture bytes, and still zero network", async () => {
    // This block used to pin `attachmentsAvailable() === false` for the demo, on the argument
    // that a control over an archive nothing can build is a lie. The premise changed, not the
    // argument: `FixturesAdapter` now SERVES the attachments its fixtures carry content for
    // (the meeting-invite messages, so the demo can show the event card), so the capability
    // claim is true. What must still hold is the "Testing bar" invariant — the demo performs zero requests —
    // and this test's stubbed fetch is the meter: `calls` stays empty across list AND bytes.
    const engine = createEngine(true, ARMED);
    expect(engine.attachmentsAvailable()).toBe(true);
    const held = await engine.loadAttachments("techcheck");
    if (held.state !== "ready") throw new Error(`expected ready, got ${held.state}`);
    expect(held.items).toHaveLength(1);
    expect(held.items[0]!.filename).toBe("invite.ics"); // nameless on the wire → the calendar fallback
    await engine.openAttachment("techcheck", held.items[0]!.id);
    expect(calls, "the demo touched the network").toEqual([]);
  });

  it("a demo attachment with DISPLAY fields only is not listed — a paperclip over a silent strip", async () => {
    // `ready with zero items` and `unavailable` are different answers, and the demo now gives
    // the first: petra's Speaker_Info.pdf fixture has no `content`, so nothing claims bytes
    // nobody holds — the tile that cannot download simply never appears.
    const engine = createEngine(true, ARMED);
    expect(await engine.loadAttachments("petra")).toEqual({ state: "ready", items: [] });
  });

  it("guarding a capability-less adapter does not MANUFACTURE the three methods", () => {
    // The property, stated on the wrapper itself: `in`, not `typeof`, because an
    // always-defined forward of an absent method would be `undefined` under `typeof` too but
    // present as a key — and `satisfies EngineAdapter` would still compile. A bare adapter
    // literal, because `FixturesAdapter` (this test's previous subject) now legitimately
    // carries two of the three.
    const bare = {
      sync: async () => ({ changes: [], cursor: "1", hasMore: false }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
    };
    const guarded = createSyncGate(null).guard(bare as never) as unknown as Record<string, unknown>;
    for (const cap of ["listAttachments", "fetchAttachment", "fetchAllAttachments"]) {
      expect(cap in guarded, `the gate invented ${cap} on an adapter that has none`).toBe(false);
    }
  });

  it("…and the gate forwards the demo's two capabilities without inventing the third", async () => {
    // FixturesAdapter has list + fetch (fixture bytes) and no `fetchAllAttachments` — there is
    // still no archive to build. The gate must forward exactly that shape: spread, bound,
    // nothing manufactured.
    const guarded = createSyncGate(null).guard(new FixturesAdapter()) as unknown as Record<string, unknown>;
    expect("listAttachments" in guarded).toBe(true);
    expect("fetchAttachment" in guarded).toBe(true);
    expect("fetchAllAttachments" in guarded, "the gate invented an archive route").toBe(false);
    const engine = new OhmailEngine({ adapter: createSyncGate(null).guard(new FixturesAdapter()) });
    const held = await engine.loadAttachments("techcheck");
    expect(held.state).toBe("ready");
  });
});

describe("the byte routes answer TWO content types, and `res.ok` is branched on first", () => {
  it("THE 413: the size ceiling's JSON envelope is a rejection, never a Blob", async () => {
    // `GET /attachments/:id` is a `raw` route: octet-stream on 200, the ordinary error
    // envelope on failure. Calling `.blob()` before checking `res.ok` would wrap that JSON in
    // a Blob and the strip would hand the user a "file" named after their PDF containing the
    // sentence explaining why they cannot have it.
    const blobSpy = vi.fn(async () => new Blob(["never"]));
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      fetch: async () => {
        const res = envelope(413, "payload_too_large", "That attachment is larger than 32 MB.");
        Object.defineProperty(res, "blob", { value: blobSpy });
        return res;
      },
    });

    await expect(adapter.fetchAttachment("att-1")).rejects.toBeInstanceOf(MutationRejectedError);
    expect(blobSpy, "the body was read as a Blob before the status was checked").not.toHaveBeenCalled();
  });

  it("…and the rejection carries the server's own CODE, which is what makes `too_large` a state", async () => {
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      fetch: async () => envelope(413, "payload_too_large", "That attachment is larger than 32 MB."),
    });
    const err = await adapter.fetchAttachment("att-1").catch((e: unknown) => e);
    expect((err as MutationRejectedError).code).toBe("payload_too_large");
    // The server's sentence, not "HTTP 413" — it is what the tile's title attribute shows.
    expect((err as Error).message).toContain("32 MB");
  });

  it("the engine turns that code into `too_large`, which is inert rather than retryable", async () => {
    answer = (url) => {
      if (url.endsWith("/api/messages/m1/attachments")) {
        return json(200, {
          items: [{ id: "big", filename: "raw.tiff", contentType: "image/tiff", sizeBytes: 90_000_000, inline: false, messageId: "m1" }],
        });
      }
      return envelope(413, "payload_too_large", "That attachment is larger than 32 MB.");
    };

    const engine = createEngine(false, ARMED);
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "big");

    const held = engine.attachmentsOf("m1") as { items: { state: string; error?: string }[] };
    expect(held.items[0]?.state).toBe("too_large");
    expect(held.items[0]?.error).toContain("32 MB");

    // A refusal at the ceiling cannot become a success by asking again: a second press must
    // not open a second IMAP connection.
    const before = calls.length;
    await engine.openAttachment("m1", "big");
    expect(calls.length).toBe(before);
  });

  it("`download-all` branches the same way — a refusal is `null`, never a zip of JSON", async () => {
    answer = () => envelope(502, "upstream_unavailable", "Your mail server did not answer.");
    const engine = createEngine(false, ARMED);
    expect(await engine.downloadAllAttachments("m1")).toBeNull();
  });
});

describe("the surface consumes it — a paperclip is reachable, not merely fetchable", () => {
  /**
   * SOURCE-LEVEL, AND IT IS THE RIGHT LEVEL FOR THIS ONE CLAIM.
   *
   * "The bytes can be fetched" is proven above, behaviourally, through the real engine. What
   * these two assert is different and is the thing that kept failing: that a person can GET
   * to it. `MessagePane` used to gate on `message.attachment` — a field ONLY the fixtures
   * adapter writes (`fixtures-adapter.ts:174`), absent from every wire `MessageDTO` — and
   * answer the press with a toast reading "Downloading attachments isn't wired up yet." So on
   * a live account the control was not merely inert; it was not rendered at all.
   *
   * What the shell then DOES with it — fetch on selection, release on the way out, save the
   * bytes — is asserted behaviourally in `attachments-open.test.ts`, which drives the hook in
   * a real DOM. These two are only the join between the two halves.
   */
  it("`MessagePane` renders the strip, and no longer reads the fixtures-only field", () => {
    /* Re-pointed by path (share reader-1): today's `MessagePane` and `MessageFiles` leave with the switch; the open
       letter is the new reader's `Letter.tsx`, its strip `LetterFiles` (`packages/app/src/reader/files/Files.tsx`),
       which draws the kit's file tiles where today's drew `AttachmentStrip`. */
    const pane = code(read("../../../packages/app/src/reader/Letter.tsx"));
    // RENDERED, not merely imported: an unused import compiles and ships nothing. The strip is
    // `LetterFiles` now, the one component the letter renders it through.
    expect(pane, "the letter does not render <LetterFiles>").toMatch(/<LetterFiles /);
    expect(code(read("../../../packages/app/src/reader/files/Files.tsx")), "LetterFiles does not render the kit's <FileTile>")
      .toMatch(/<FileTile/);
    expect(pane, "the letter still gates the attachment surface on the fixtures-only field")
      .not.toMatch(/message\.attachment/);
    // The DEAD prop is `onAttachment` (singular) — the fixtures-era per-message download callback.
    // Word-boundaried so it names exactly that and not the reply editor's live `onAttachments`
    // (plural) file-list prop, which threads the same pane on purpose (slice R9-3). A bare
    // `/onAttachment/` fired on the wrong identifier, which is the loosening this file's own
    // `code()` note warns about.
    expect(pane, "the dead onAttachment prop is still threaded through the letter")
      .not.toMatch(/\bonAttachment\b/);
  });

  /**
   * THE PRESS SAVES; THE EYE LOOKS — and both are wired at the ONE call site that renders the
   * strip, so neither can be built and left unreachable.
   *
   * Source-level and deliberately so: the strip's own behaviour is asserted in a real DOM by
   * `attachment-strip.test.ts`, which drives `onOpen`, `onPreview` and `canPreview` as props.
   * What no DOM test of that component can see is whether the pane passes them, and passing
   * the WRONG one is exactly the regression: `onOpen` pointed at `openAttachmentPreview` is
   * how a press came to open a viewer instead of saving a file.
   */
  it("`MessageFiles` presses through to the download, and offers the preview separately", () => {
    /* Re-pointed by path (share reader-1) to the new reader's tile (`packages/app/src/reader/files/Files.tsx`):
       the kit's `FileTile` takes the save as its Download (`save`, today's `onOpen`) and the look as its own press
       (`main`, today's eye, `onPreview`) where the shell hands a look (`look`, none on a browser host, where the
       press saves too); `fileLookOf` is today's `isPreviewable`: an SVG is `other`, never looked at. */
    const pane = code(read("../../../packages/app/src/reader/files/Files.tsx"));
    const from = pane.indexOf("<FileTile");
    expect(from, "LetterFiles no longer renders <FileTile> — re-aim this").toBeGreaterThan(-1);
    /* The tile's own close, at its own indent: its `look` (a thumbnail's <img />) closes before it. */
    const indent = pane.slice(pane.lastIndexOf("\n", from) + 1, from);
    const tile = pane.slice(from, pane.indexOf(`\n${indent}/>`, from));
    const save = tile.slice(tile.indexOf("save={{"));
    const main = tile.slice(tile.indexOf("main={{"), tile.indexOf("save={{"));

    expect(save, "a tile press does not reach the download path").toMatch(/onPress: \(\) => files\.open\(/);
    expect(save, "a tile press opens the viewer instead of saving the file")
      .not.toMatch(/\blook\b/);
    expect(main, "nothing on a tile opens the preview any more").toMatch(
      /onPress: \(\) => \(look \? look\(item\.id\) : files\.open\(messageId, item\.id\)\)/,
    );
    // The predicate is what keeps an SVG — a document that executes script — from being
    // offered a render. Dropping it makes every attachment previewable.
    expect(pane, "the strip is not told which files may be rendered").toMatch(
      /const look = fileLookOf\(item\.mimeType\) !== "other" \? preview : null;/,
    );
  });

  it("`AppShell` builds the preview overlay's list WITH inline images, so an inline png opens", () => {
    // Item 4. The overlay must be able to find the id it was opened on. An INLINE image is a real
    // clickable tile in the strip (the shared Reader lists them when the body renders as text), so the
    // overlay's own `itemsOf` has to include them too — otherwise clicking an inline picture finds
    // no matching item and, when the message carries nothing else, opens nothing at all. The strip
    // and the overlay must agree on which attachments exist. Source-level because the empty-list →
    // no-overlay path is exactly the "clicking does nothing" the reader saw.
    const files = sliceOfDeclaration(code(read("../../../packages/app/src/reader/files/Files.tsx")), "LetterFiles");
    expect(files, "the tile list must supply the same inline item to the preview")
      .toMatch(/const list = files\.itemsOf\(messageId, \{ includeInlineParts: true \}\)/);
    expect(files).toMatch(/const items = list\.items;/);
    expect(files).toMatch(/items\.map\(\(item\) =>/);
    expect(files).toMatch(/<LetterPreview[\s\S]*?items=\{items\}/);
  });

  it("`AppShell` supplies the chrome, so BOTH mounts share one list of bytes", () => {
    /* Re-pointed by path (share reader-1): the new shell's ground mounts the one file door above the panes
       (`packages/app/src/mail/ground/DoorsMount.tsx`, over the inputs of `door-inputs.ts`), where today's
       `AppShell` called the hook and handed it in its chrome. */
    const mount = code(read("../../../packages/app/src/mail/ground/DoorsMount.tsx"));
    const shell = mount + code(read("../../../packages/app/src/mail/ground/door-inputs.ts"));
    // The pane is mounted twice while the reader is open. Two independent lists would mean two
    // IMAP connections for one press and a leaked object URL from whichever mount lost.
    expect(shell, "the ground never calls useMessageAttachments — nothing fetches or releases")
      .toMatch(/useMessageAttachments\(/);
    expect(shell, "the download-all failure has no report beside the button that was pressed")
      .toMatch(/onDownloadAllFailed/);
    expect(shell, "the dead onAttachment toast is still wired").not.toMatch(/onAttachment=/);

    // AND IT REACHES THE PANE. Calling the hook is not the same as handing the result over:
    // the record the ground provides (`doors`) must carry the file door, and be the one provided.
    // THE START IS THE DECLARED NAME. `sliceOfDeclaration` throws `anchor not found: doors` if
    // the memo is gone, and a hook rename cannot turn it into a window over the wrong bytes.
    const decl = sliceOfDeclaration(mount, "doors");
    // THE END STAYS NARROW: the OBJECT LITERAL only, stopping at the `})` that closes it,
    // deliberately NOT the whole declaration: the DEPENDENCY ARRAY names `files` too, and
    // dropping the key from the object alone would pass over the wider slice.
    const closes = decl.indexOf("}),");
    expect(closes, "the doors memo's object literal no longer closes there — a "
      + "missed bound would widen this window back over the dependency array")
      .toBeGreaterThan(-1);
    const memo = decl.slice(0, closes);
    expect(memo, "the doors memo does not carry `files` — the reader gets undefined")
      .toMatch(/\bfiles\b/);
    expect(mount, "the ground does not provide the doors it built").toMatch(/<DoorsContext\.Provider value=\{doors\}>/);
  });

  it("`AppShell` keeps a preview open while a pane shows its message, on every surface", () => {
    // A preview belongs to the pane that shows its message (FIX-025). The membership test on the
    // Ohbox thread that stood in the derive-close closed every preview opened outside it (the
    // reader over History, Search, a folder), so the close now has two triggers: the Ohbox
    // selection MOVE, kept here, and the last pane letting the message go, reported by the seam.
    // Behaviour is held in `every-file-is-shown.test.tsx`; this is the join, source-level for
    // the reason every assertion in this group is.
    const reader = code(read("../../../packages/app/src/reader/Reader.tsx"));
    expect(reader, "the route and selected letter identify the preview's selection")
      .toContain('previewSelection={`${route.place}:${openId}`}');
    const letter = code(read("../../../packages/app/src/reader/Letter.tsx"));
    expect(letter, "the preview is mounted under the letter that owns its files")
      .toMatch(/<LetterFiles messageId=\{message\.id\} selection=\{previewSelection\} parts=\{parts\} \/>/);
    const files = code(read("../../../packages/app/src/reader/files/Files.tsx"));
    expect(files, "a changed selection must stop drawing the old preview immediately")
      .toMatch(/const activeId = picked\?\.selection === selection \? picked\?\.id : undefined;/);
    expect(files, "a disappeared attachment cannot keep the preview open")
      .toMatch(/activeId && typeof look === "object" && items\.some\(\(item\) => item\.id === activeId\)/);
    expect(files, "the last pane's unmount releases its hold on the opened letter")
      .toMatch(/useEffect\(\(\) => hold\?\.\(messageId\), \[hold, messageId\]\);/);
    const seam = code(read("../../../packages/app-logic/src/reader/attachments.ts"));
    expect(seam, "the seam no longer reports the last release")
      .toMatch(/holds\.current\.delete\(id\);[\s\S]{0,120}onUnshown\.current\?\.\(id\);/);
  });

  it("the crew's engine refs move at COMMIT, never during render", () => {
    // The standing crew and late completions dereference `engineRef`/`askRef`. A concurrent
    // render can run and be ABANDONED, so a render-time `ref.current = engine` would point
    // live workers at an engine no commit ever produced — or let an abandoned render's
    // completion release state the committed tree still renders (review finding). The refs
    // may be assigned in exactly one place: the publication effect. Source-level because no
    // jsdom test can schedule an abandoned concurrent render deterministically.
    const seam = code(read("../../../packages/app-logic/src/reader/attachments.ts"));
    // LAYOUT-scope (`useCommitEffect` — older-mail.ts's SSR-safe alias), not a passive
    // `useEffect`: passive effects flush after paint, and an already-queued completion running
    // in the commit-to-paint gap read the OLD refs — the round-six finding on the round-five
    // fix. The queue retires in the same synchronous phase so a resuming worker finds nothing
    // stale to take.
    expect(seam, "the layout-scope publication effect is gone").toMatch(
      /useCommitEffect\(\(\) => \{\s*engineRef\.current = engine;\s*askRef\.current = ask;\s*pendingLists\.current = \[\];\s*pendingHolds\.current = \[\];\s*\}, \[engine, ask\]\);/,
    );
    expect(seam, "useCommitEffect no longer resolves to the layout phase in a browser")
      .toMatch(/const useCommitEffect = typeof window === "undefined" \? useEffect : useLayoutEffect;/);
    const assigns = [...seam.matchAll(/(engineRef|askRef)\.current = /g)];
    expect(assigns.length, "a second assignment site — if it is render-time, live workers can be repointed by an abandoned render").toBe(2);
  });

  it("the toast that said it was not wired up is GONE from the copy", () => {
    // A claim is a contract: the sentence was false the moment the wire landed, and the key
    // surviving in `en.json` is how it comes back.
    const copy = read("../messages/en.json");
    // The KEY, so nothing can render it, and the SENTENCE, so it cannot come back under
    // another key. Both are matched exactly rather than as loose substrings: "toastAttachment"
    // as a prefix would also condemn an honest `toastAttachment…` key a later slice adds, and
    // "isn't wired up yet" on its own used to hit `settings.toastTagEditing` — a different
    // feature, which has since been wired and whose key is now held to this same standard by
    // `tags-admin.test.ts`. An assertion that fires on the wrong thing gets loosened by the
    // next person who reads it, so both are still matched exactly.
    expect(copy).not.toContain('"toastAttachment"');
    expect(copy).not.toContain("Downloading attachments isn't wired up yet.");
  });
});

describe("the live engine's staged upload goes only where the page policy lets it", () => {
  const ORIGIN = "https://abcdefghijklmnopqrst.storage.example";
  const GRANT = `${ORIGIN}/storage/v1/object/upload/sign/attachment-staging/acct-1/t1?token=t`;
  const big = {
    kind: "mail_send", mailboxId: "mb", inReplyTo: null, subject: "plans", body: "attached",
    to: [{ name: null, address: "lena@atelier.example" }],
    attachments: [{ filename: "plans.pdf", contentType: "application/pdf", contentBase64: Buffer.alloc(4 << 20, 7).toString("base64") }],
  } as const;
  beforeEach(() => {
    answer = (url, init) => {
      if (url === "/api/drafts" && init?.method === "POST") return json(201, { id: "d1", bcc: [], contentRevision: "r1" });
      if (url === "/api/attachments/staging") return json(201, { id: "t1", uploadUrl: GRANT, uploadMethod: "PUT", uploadHeaders: {} });
      if (url === GRANT) return new Response(null, { status: 200 });
      if (url === "/api/drafts/d1/send") return json(200, { status: "sent", providerMessageId: "<p1@x>" });
      return json(404, { error: { code: "not_found", message: url } });
    };
  });

  it("a build naming no storage origin ends the send `staging_refused`, the row named, nothing PUT or sent", async () => {
    const res = await createEngine(false, ARMED).mutate(big as never);
    expect(res).toMatchObject({ status: "rolled_back", entityId: "d1", error: { code: "staging_refused" } });
    expect(calls.filter((c) => c.startsWith("PUT ") || c.endsWith("/send"))).toEqual([]);
  });

  it("a build naming the grant's origin PUTs the bytes there and sends", async () => {
    const res = await createEngine(false, { ...ARMED, NEXT_PUBLIC_STAGING_ORIGIN: ORIGIN }).mutate(big as never);
    expect(res.status).toBe("confirmed");
    expect(calls).toEqual(expect.arrayContaining([`PUT ${GRANT}`, "POST /api/drafts/d1/send"]));
  });
});
