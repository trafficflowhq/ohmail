/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ISO, act, answerConsentWith, answerSyncWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick,
} from "./fixtures/live-walk-shell";

/**
 * on the shipped shell through the real byte path (HttpAdapter over `fetch`). A drop
 * while a letter with an embedded picture opened left the text without its picture for as long as
 * the letter stayed open, while the file card healed. The fake server fails the list or the part
 * ONCE, then answers; the open letter must draw the picture with no reopen. The missing-cid
 * control asks for bytes zero times and keeps its blank box.
 */

const LETTER = "news-letter-heal";
const PICTURE = "a-heal-logo";
const PNG = Uint8Array.from(atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
), (c) => c.charCodeAt(0));
/** The web door draws the picture from the part's object URL — the one this harness mints. */
const DRAWN = "blob:harness/1";
const htmlFor = (cid: string) => `<p>An inline image:</p><img src="cid:${cid}" alt="logo"><p>Bea</p>`;

/** What the fake server does to the next request of each kind: `drop` fails it at the wire once. */
let drop: { list: number; part: number } = { list: 0, part: 0 };
let asked: { list: number; part: number } = { list: 0, part: 0 };
let referenced = "heal-logo";
let folder = "INBOX";
const INVITE = "a-heal-invite";
const ICS = [
  "BEGIN:VCALENDAR", "METHOD:REQUEST", "BEGIN:VEVENT",
  "DTSTART;TZID=Europe/Zurich:20260911T160000", "DTEND;TZID=Europe/Zurich:20260911T163000",
  "ORGANIZER;CN=Bea:mailto:bea@example.invalid", "SUMMARY:Kiln check with Bea",
  "END:VEVENT", "END:VCALENDAR",
].join("\r\n");
const INVITE_ITEM = { id: INVITE, filename: "invite.ics", contentType: "text/calendar", sizeBytes: ICS.length,
  inline: false, contentId: null, messageId: LETTER };
/** The letter's one part: the picture, or (the path beside) a meeting invitation. */
let carries: "picture" | "invite" = "picture";
const PICTURE_ITEM = { id: PICTURE, filename: "logo.png", contentType: "image/png", sizeBytes: PNG.byteLength,
  inline: true, contentId: "heal-logo", messageId: LETTER };

const letter = () => ({
  id: LETTER, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: "A picture", from: { name: "Bea", address: "bea@example.invalid" },
  to: [], cc: [], date: ISO, folder, snippet: "An inline image:", unread: true,
  hasAttachments: true, attachmentCount: 1, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: ISO,
});

const beaRule = () => ({
  id: "rule_bea", kind: "sender", match: "bea@example.invalid", destination: folder, priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
});

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  answerConsentWith({ foldersEnabledAt: ISO });
  drop = { list: 0, part: 0 };
  asked = { list: 0, part: 0 };
  referenced = "heal-logo";
  folder = "INBOX";
  carries = "picture";
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const inner = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (/\/messages\/[^/?]+\/attachments(?:$|\?)/.test(url)) {
      asked.list += 1;
      if (drop.list > 0) { drop.list -= 1; throw new TypeError("Failed to fetch"); }
      return json({ items: [carries === "picture" ? PICTURE_ITEM : INVITE_ITEM] });
    }
    if (new RegExp(`/messages/${LETTER}/body`).test(url)) {
      return json({
        text: "An inline image:\n\nBea", html: htmlFor(referenced),
        loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      });
    }
    if (/\/attachments\/([^/?]+)$/.test(url)) {
      asked.part += 1;
      if (drop.part > 0) { drop.part -= 1; throw new TypeError("Failed to fetch"); }
      if (url.endsWith(INVITE)) return new Response(ICS, { status: 200, headers: { "content-type": "application/octet-stream" } });
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    }
    return (inner as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => "blob:harness/1";
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
});
afterEach(async () => { await teardownShellEnv(); });

/** The letter is opened by pressing its row (the finding's path) or by its URL (a reload, a link). */
async function openTheLetter(by: "row" | "url" | "news" = "row"): Promise<void> {
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
  if (by === "row") {
    const row = document.querySelector<HTMLElement>(`.row[data-id="${LETTER}"]`);
    expect(row, "the Ohbox does not list the letter").not.toBeNull();
    await act(async () => { row!.click(); });
  } else if (by === "news") {
    await act(async () => {
      window.location.hash = "#/reads";
      window.dispatchEvent(new Event("hashchange"));
      await Promise.resolve();
    });
    await tick(1_000);
    const card = document.querySelector<HTMLElement>(`.view-reads .scast[data-sid="${LETTER}"]`);
    expect(card, "News does not show the letter").not.toBeNull();
    await act(async () => { card!.querySelector<HTMLButtonElement>(".sc-x")!.click(); });
  } else {
    await act(async () => {
      window.location.hash = `#/ohbox/m/${LETTER}`;
      window.dispatchEvent(new Event("hashchange"));
      await Promise.resolve();
    });
  }
}

/** The letter's own picture, in the frame or the prose: the strip's thumbnail shares its URL. */
const drawn = (): boolean =>
  [...document.querySelectorAll("iframe")].some((f) => (f.getAttribute("srcdoc") ?? "").includes(DRAWN))
  || [...document.querySelectorAll("img.msg-img")].some((i) => i.getAttribute("src") === DRAWN);

describe("an embedded picture heals after a short drop, with the letter open", () => {
  it("the part's bytes failed at the wire once: drawn once the server answers a drain", async () => {
    drop.part = 1;
    await openTheLetter();
    await tick(45_000);
    expect(drop.part, "the drop never happened").toBe(0);
    expect(drawn(), "the picture stayed missing with the letter open").toBe(true);
    expect(asked.part).toBe(2);
  }, 60_000);

  for (const by of ["row", "url", "news"] as const) {
    it(`the file list failed at the wire once (opened by its ${by}): drawn once the list is asked again`, async () => {
      if (by === "news") folder = "ohmail/News";
      drop.list = 1;
      await openTheLetter(by);
      await tick(45_000);
      expect(drop.list, "the drop never happened").toBe(0);
      expect(drawn(), "the picture stayed missing with the letter open").toBe(true);
      expect(asked.part).toBe(1);
    }, 60_000);
  }

  it("the path beside: a meeting invitation's list dropped once still draws its event card", async () => {
    carries = "invite";
    folder = "ohmail/News";
    drop.list = 1;
    await openTheLetter("news");
    await tick(45_000);
    expect(drop.list, "the drop never happened").toBe(0);
    const summary = document.querySelector(".ics-card .ics-summary")?.textContent ?? "";
    expect(summary, "the invitation stayed a plain tile after the list answered").toBe("Kiln check with Bea");
  }, 60_000);

  it("control: the picture with no drop is drawn on open, with one byte fetch", async () => {
    await openTheLetter();
    await tick(2_000);
    expect(drawn()).toBe(true);
    await tick(45_000);
    expect(asked.part).toBe(1);
  }, 60_000);

  it("control: a cid no part carries stays blank and costs no byte fetch, however long the letter is open", async () => {
    referenced = "nobody-has-this";
    drop.list = 1;
    await openTheLetter();
    await tick(45_000);
    expect(drawn()).toBe(false);
    expect(asked.part).toBe(0);
  }, 60_000);
});
