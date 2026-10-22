/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

/**
 * A letter's embedded picture and its invitation card are drawn from engine maps that are filled
 * AFTER the part already reads `ready`: the engine mints the picture or decodes the invitation,
 * replaces the map and notifies once. The shell's attachment subscription must re-render on that
 * notify, or the picture and the card wait for an unrelated render (measured on React 19: 1.0 s
 * and 6.3 s late). Each case reads the draw within 100 ms of virtual time of the part's bytes.
 */

const LETTER = "news-letter-maps";
const PICTURE = "a-maps-logo";
const INVITE = "a-maps-invite";
const PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
), (c) => c.charCodeAt(0));
/** The web door draws the picture from the part's object URL — the one this harness mints. */
const DRAWN = "blob:harness/1";
const ICS = [
  "BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Zurich:20260911T160000", "DTEND;TZID=Europe/Zurich:20260911T163000",
  "ORGANIZER;CN=Bea:mailto:bea@example.invalid", "SUMMARY:Kiln check with Bea",
  "END:VEVENT", "END:VCALENDAR",
].join("\r\n");
const HTML = `<p>See you there:</p><img src="cid:maps-logo" alt="logo"><p>Bea</p>`;

/** When each part's bytes left the fake server, by part id, in virtual milliseconds. */
let bytesAt: Record<string, number> = {};
/** The parts this case's letter carries: ONE map each, so the other map cannot redraw the card. */
let parts: "picture" | "invite" = "picture";
const PICTURE_ITEM = { id: PICTURE, filename: "logo.png", contentType: "image/png", sizeBytes: PNG.byteLength,
  inline: true, contentId: "maps-logo", messageId: LETTER };
const INVITE_ITEM = { id: INVITE, filename: "invite.ics", contentType: "text/calendar", sizeBytes: ICS.length,
  inline: false, contentId: null, messageId: LETTER };

/* The picture is read in the Ohbox reader, the invitation on a News card: each surface that draws
   one of the maps today, so each case measures the subscription and not a surface's wiring. */
let inReader = false;
const folderOf = (): string => (parts === "picture" || inReader ? "INBOX" : "ohmail/News");
const letter = () => ({
  id: LETTER, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: "Kiln check", from: { name: "Bea", address: "bea@example.invalid" },
  to: [], cc: [], date: ISO, folder: folderOf(), snippet: "See you there:", unread: true,
  hasAttachments: true, attachmentCount: 1, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
});
const beaRule = () => ({
  id: "rule_bea", kind: "sender", match: "bea@example.invalid", destination: folderOf(), priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
});

beforeEach(() => {
  inReader = false;
  installShellEnv();
  window.localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
  bytesAt = {};
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (/\/messages\/[^/?]+\/attachments(?:$|\?)/.test(url)) {
      return json({ items: [parts === "picture" ? PICTURE_ITEM : INVITE_ITEM] });
    }
    if (new RegExp(`/messages/${LETTER}/body`).test(url)) {
      return json({
        text: "See you there:\n\nBea", html: parts === "picture" ? HTML : "<p>See you there:</p>",
        loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      });
    }
    const bytes = /\/attachments\/([^/?]+)$/.exec(url);
    if (bytes) {
      const id = decodeURIComponent(bytes[1]!);
      bytesAt[id] ??= Date.now();
      return id === INVITE
        /* Served already typed as the engine stores a calendar part, so the bytes stay the
           runtime's own Blob: jsdom's Blob cannot wrap Node's, and has no `text()`. */
        ? new Response(ICS, { status: 200, headers: { "content-type": "application/octet-stream" } })
        : new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:harness/1";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});
afterEach(async () => { await teardownShellEnv(); });

async function mountWithTheLetter(): Promise<void> {
  answerSyncWith(() => new Response(JSON.stringify({
    changes: {
      creates: [
        { type: "rule", op: "create", id: "rule_bea", seq: 1, updatedAt: ISO, entity: beaRule() },
        { type: "message", op: "create", id: LETTER, seq: 2, updatedAt: ISO, entity: letter() },
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
};

async function openTheCard(): Promise<HTMLElement> {
  await mountWithTheLetter();
  await goHash("#/reads");
  await tick(1_000);
  const card = document.querySelector<HTMLElement>(`.view-reads .scast[data-sid="${LETTER}"]`);
  expect(card, "News does not show the letter").not.toBeNull();
  await act(async () => { card!.querySelector<HTMLButtonElement>(".sc-x")!.click(); });
  return card!;
}

/** Virtual milliseconds from the part's bytes to the first frame that shows `drawn`, stepping 10 ms. */
async function msToDraw(part: string, drawn: () => boolean): Promise<number> {
  for (let i = 0; i < 500; i++) {
    if (bytesAt[part] !== undefined && drawn()) return Date.now() - bytesAt[part]!;
    await tick(10);
  }
  return Infinity;
}

describe("a letter's picture and invitation are drawn the moment their bytes land", () => {
  it("the embedded picture, in the reader", async () => {
    parts = "picture";
    await mountWithTheLetter();
    await goHash(`#/ohbox/m/${LETTER}`);
    // The letter's own picture, in the frame or the prose: the strip's thumbnail shares its URL.
    const drawn = (): boolean =>
      [...document.querySelectorAll("iframe")].some((f) => (f.getAttribute("srcdoc") ?? "").includes(DRAWN))
      || [...document.querySelectorAll("img.msg-img")].some((i) => i.getAttribute("src") === DRAWN);
    expect(await msToDraw(PICTURE, drawn), "the picture waited for another render")
      .toBeLessThanOrEqual(100);
  }, 60_000);

  it("the invitation card, in the reader", async () => {
    parts = "invite";
    inReader = true;
    await mountWithTheLetter();
    await goHash(`#/ohbox/m/${LETTER}`);
    const summary = (): string => document.querySelector(".msg-events .ics-card .ics-summary")?.textContent ?? "";
    expect(await msToDraw(INVITE, () => summary() === "Kiln check with Bea"), "the invitation waited for another render")
      .toBeLessThanOrEqual(100);
  }, 60_000);

  it("the invitation card", async () => {
    parts = "invite";
    const card = await openTheCard();
    const summary = (): string => card.querySelector(".ics-card .ics-summary")?.textContent ?? "";
    expect(await msToDraw(INVITE, () => summary() === "Kiln check with Bea"), "the invitation waited for another render")
      .toBeLessThanOrEqual(100);
  }, 60_000);
});
