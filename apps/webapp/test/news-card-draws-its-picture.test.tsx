/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

/**
 * A letter filed in News carries a picture in its body (`<img src="cid:…">`) and the part beside it.
 * Opened in News it drew "An inline image:" over a blank box and never fetched the part, while the
 * Ohbox and History drew it (tester round 24). This mounts the shipped shell over the live engine,
 * opens the News card the way a person does, and reads the part fetch and the frame's picture.
 */

const LETTER = "news-letter-f5";
const PART = "a-f5-logo";
/** A 1x1 PNG: the engine draws a picture only from a declared raster image with bytes. */
const PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
), (c) => c.charCodeAt(0));
const HTML = `<p>An inline image:</p><img src="cid:e2e-logo" alt="e2e logo"><p>Regards, quillfen</p>`;
/** The picture as the card must draw it: the part's own object URL, the one this harness mints. */
const DRAWN = "blob:harness/1";

let fetched: string[] = [];

const letter = {
  id: LETTER, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: "PDF and picture", from: { name: "Bea", address: "bea@example.invalid" },
  to: [], cc: [], date: ISO, folder: "ohmail/News", snippet: "An inline image:", unread: true,
  hasAttachments: true, attachmentCount: 1, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
};
const newsRule = {
  id: "rule_bea", kind: "sender", match: "bea@example.invalid", destination: "ohmail/News", priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
};

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
  fetched = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (/\/messages\/[^/?]+\/attachments(?:$|\?)/.test(url)) {
      return json({ items: [{
        id: PART, filename: "logo.png", contentType: "image/png", sizeBytes: PNG.byteLength,
        inline: true, contentId: "e2e-logo", messageId: LETTER,
      }] });
    }
    if (new RegExp(`/messages/${LETTER}/body`).test(url)) {
      return json({ text: "An inline image:\n\nRegards", html: HTML, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
    }
    const bytes = /\/attachments\/([^/?]+)$/.exec(url);
    if (bytes) {
      fetched.push(decodeURIComponent(bytes[1]!));
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    if (/\/search\?/.test(url)) {
      const q = new URL(url, "https://harness.invalid").searchParams.get("q") ?? "";
      const items = /quillfen/i.test(q) ? [letter] : [];
      return json({ items, total: items.length, totalExact: true, ms: 4 });
    }
    return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:harness/1";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});
afterEach(async () => { await teardownShellEnv(); });

/** What the card draws of the letter: the frameless view inline, or the frame's document. */
const drawnOf = (scope: Element): string =>
  (scope.querySelector(".sc-viewer")?.innerHTML ?? "") + (scope.querySelector("iframe")?.getAttribute("srcdoc") ?? "");
/** The pictures the card draws, by their src. */
/** The letter's own pictures in the card (`.msg-img`): the strip's thumbnail shares the part's URL. */
const picturesOf = (scope: Element): string[] =>
  [...scope.querySelectorAll(".sc-viewer img.msg-img")].map((i) => i.getAttribute("src") ?? "");

async function mountWithTheLetter(): Promise<void> {
    answerSyncWith(() => new Response(JSON.stringify({
      changes: {
        creates: [
          { type: "rule", op: "create", id: newsRule.id, seq: 1, updatedAt: ISO, entity: newsRule },
          { type: "message", op: "create", id: LETTER, seq: 2, updatedAt: ISO, entity: letter },
        ],
        updates: [], moves: [], deletes: [],
      },
      cursor: "c2", hasMore: false, serverTime: ISO,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await mountShell([mailbox({ lastSyncAt: ISO, id: "mb_1" })]);
    await tick(30_000);
}
const goHash = async (hash: string): Promise<void> => {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
    await Promise.resolve();
  });
  await tick(1_000);
};
const theCard = (): HTMLElement => {
  const card = document.querySelector<HTMLElement>(`.view-reads .scast[data-sid="${LETTER}"]`);
  expect(card, "News does not show the letter").not.toBeNull();
  return card!;
};
function expectThePicture(card: HTMLElement): void {
  expect(drawnOf(card), "the card never drew the letter's html").toContain("An inline image:");
  expect(fetched, "opening the card never fetched the letter's picture").toEqual([PART]);
  expect(picturesOf(card), "the card does not draw the letter's own picture").toContain(DRAWN);
}

describe("a letter filed in News draws its own picture", () => {
  it("opening the News card fetches the cid part and draws it", async () => {
    await mountWithTheLetter();
    await goHash("#/reads");
    const card = theCard();
    expect(fetched, "a collapsed card fetched a picture nobody opened").toEqual([]);
    await act(async () => { card.querySelector<HTMLButtonElement>(".sc-x")!.click(); });
    await tick(3_000);
    expectThePicture(card);
  }, 60_000);

  it("a Search hit opened into News draws it", async () => {
    await mountWithTheLetter();
    await goHash("#/search");
    const box = document.querySelector<HTMLInputElement>(".view-search .search-box input");
    expect(box, "no search box").not.toBeNull();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      set.call(box, "quillfen");
      box!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick(1_000);
    const hit = document.querySelector<HTMLButtonElement>(`.view-search .hit-w[data-hit="${LETTER}"] button.hit-open`);
    expect(hit, "Search does not list the letter").not.toBeNull();
    await act(async () => { hit!.click(); });
    // The landing opens the card once the stream has scrolled to it (its anchoring budget).
    for (let i = 0; i < 40 && theCard().querySelector(".sc-x")?.getAttribute("aria-expanded") !== "true"; i += 1) await tick(250);
    expect(window.location.hash, "the hit did not open News").toContain("#/reads");
    expect(theCard().querySelector(".sc-files"), "the landed card is not open").not.toBeNull();
    await tick(3_000);
    expectThePicture(theCard());
  }, 60_000);
});
